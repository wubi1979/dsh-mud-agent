/**
 * mud-core3 deliver — 聚合投递器（pull 模型）：MUD 行流 → 用户消息投递进会话。
 *
 * 二期改造（doc/PLAN.md「二期详细设计 §4/§12」）：**单一真相源 = runtime.pendingLines**
 * （录制环形缓冲），投递器**不再自持缓冲**——投递 = 从水位线之后拉取（take）。
 * 两条水位线（行号空间 = MudLine.abs，单调递增）：
 *   deliveredAbs —— 投递推进：已投递给 agent 的最远行号（只推进到成功投出的批次）
 *   readAbs      —— 工具读推进：最近一次 read 返回结果的最大行号
 *   已见线 seen = max(deliveredAbs, readAbs) ← agent 已经见过的行边界
 *
 * 投递时机：
 *   A. turn 期间（turn/start → turn/end）：抑制模式——不武装定时器，行只进
 *      pending 积累，turn/end 统一冲刷；
 *   B. turn/end：flush 一次——从 pending 取 abs > seen 的行，按 maxLines/maxChars
 *      拆条投出 → delivered 只推进到成功投出的批次（失败批次不推进、行仍在
 *      pending，下次从失败点自然重试——不丢行）；
 *   C. 空闲模式（agent 不在 turn）：quiet/maxWait 定时器到期即 flush。
 *
 * 接入闸门：
 *   - admit() → 开始投递；水位 = 接入时刻（delivered 推进到 pending 末端，积压不回放）
 *   - stop() → 停止投递；pending 照常积累（录制），不投
 *   - 未接入：不 take、不武装定时器、零积累零丢弃（闸门在源头）
 *
 * 冷启动补投：agent/created → flushOnce（从 seen 拉取一次，触发首个回合）。
 *
 * 纯 TS，零宿主依赖。deliver 回调与水位线源由装配层注入。
 */

import type { MudLine } from './link/line.ts'

/** 投递回调（装配层注入）；返回 false = 本次未投出（agent 离线），批次保留重试。 */
export type DeliverFn = (sessionId: string, text: string) => boolean | void

/**
 * 水位线源（runtime 侧实现）：pending 是单一真相，投递从已见线之后拉取。
 * delivered/readAbs 的真相都在 runtime，投递器只经此窄面读写。
 */
export interface LineSource {
  /** 当前已见线 = max(deliveredAbs, readAbs)。 */
  seen(): number
  /** pending 末端行号（admit 水位 = 接入时刻用；空 pending = -1）。 */
  end(): number
  /** 取 abs > seen 的行（不推进水位——delivered 只推进到成功投出的批次）。 */
  take(seen: number): MudLine[]
  /** 投出成功后推进 deliveredAbs（单调 max）。 */
  commit(abs: number): void
}

/** 投递器配置。 */
export interface DelivererConfig {
  /** 静默窗口毫秒：行流静默 N ms 后打包投递。缺省 500ms。 */
  quietMs?: number
  /** 批次最长等待毫秒：行流持续不静默时也在此上限内投出。缺省 3000ms。 */
  maxWaitMs?: number
  /** 单条投递最大行数（超出拆成多条）。缺省 50 行。 */
  maxLines?: number
  /** 单条投递最大字符数（超出拆成多条）。缺省 8000 字符。 */
  maxChars?: number
  /** 水位线源（pull 模型必填）：从 runtime.pendingLines 按水位线拉取。 */
  source: LineSource
  /** 每批投递结果回调（观测用；delivered=false 表示批次保留待重试）。 */
  onBatch?: (sessionId: string, lineCount: number, delivered: boolean) => void
}

const DEFAULT_QUIET_MS = 500
const DEFAULT_MAX_WAIT_MS = 3000
const DEFAULT_MAX_LINES = 50
const DEFAULT_MAX_CHARS = 8000
/** 单行本身就超过 maxChars 时的截断标记。 */
const TRUNCATED_SUFFIX = '\n...(截断)'

/**
 * 单会话聚合投递器（pull 模型，无自持缓冲）。
 *
 * 生命周期：admit → 投递 → stop。未 admit 时零拉取（录制由 runtime 负责）。
 * dispose 时清除定时器（session/disposed 用）。
 */
export class Deliverer {
  private readonly sessionId: string
  private readonly deliver: DeliverFn
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly maxLines: number
  private readonly maxChars: number
  private readonly source: LineSource
  private readonly onBatch: ((sessionId: string, lineCount: number, delivered: boolean) => void) | undefined

  private admitted = false
  /** turn 抑制模式（turn/start → turn/end）：行只进 pending，不武装定时器。 */
  private suppressed = false
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(sessionId: string, deliver: DeliverFn, config: DelivererConfig) {
    this.sessionId = sessionId
    this.deliver = deliver
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.maxLines = config.maxLines ?? DEFAULT_MAX_LINES
    this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
    this.source = config.source
    this.onBatch = config.onBatch
  }

  /** 是否已接入。 */
  get isAdmitted(): boolean {
    return this.admitted
  }

  /** 是否处于 turn 抑制模式。 */
  get isSuppressed(): boolean {
    return this.suppressed
  }

  /**
   * 接入：开始投递。水位 = 接入时刻：delivered 推进到 pending 末端（积压不回放）。
   */
  admit(): void {
    if (this.disposed || this.admitted) return
    this.admitted = true
    this.source.commit(this.source.end())
  }

  /** 停止接入：投递停。pending 照常积累（录制），不投。 */
  stop(): void {
    if (this.disposed) return
    this.admitted = false
    this.clearTimers()
  }

  /**
   * 行到达（runtime.onLine 接此）：pull 模型下行已由 runtime 录制进 pending，
   * 这里只在「已接入 + 空闲模式」武装静默/最长等待定时器（turn 模式抑制）。
   */
  onLine(_line: MudLine): void {
    if (this.disposed || !this.admitted || this.suppressed) return
    this.armTimers()
  }

  /** turn 开始（宿主 session/event 接线）：抑制模式——清定时器，行只积累。 */
  onTurnStart(): void {
    if (this.disposed) return
    this.suppressed = true
    this.clearTimers()
  }

  /** turn 结束（宿主 session/event 接线）：冲刷一次——回合内积累的行统一投出。 */
  onTurnEnd(): void {
    if (this.disposed) return
    this.suppressed = false
    this.flush()
  }

  /**
   * 立即从已见线之后拉取投出一次（agent/created 冷启动补投）。
   * 未接入或无未见行时为空操作；投不出的批次留在 pending（下次重试）。
   */
  flushOnce(): void {
    this.flush()
  }

  /** 销毁（session/disposed 用）：清定时器。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  // ---------------------------------------------------------------------

  /** 静默窗口按行重置；最长等待只在批次首行武装（不随之重置）。 */
  private armTimers(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      this.flush()
    }, this.quietMs)
    if (this.waitTimer === null) {
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null
        this.flush()
      }, this.maxWaitMs)
    }
  }

  /** 从水位线之后拉取并投出：按上限拆成多条；失败批次不推进 delivered（重试）。 */
  private flush(): void {
    this.clearTimers()
    if (this.disposed || !this.admitted) return
    const lines = this.source.take(this.source.seen())
    if (lines.length === 0) return
    for (const chunk of this.batches(lines)) {
      const text = this.render(chunk)
      const lastAbs = chunk[chunk.length - 1]?.abs ?? -1
      if (text.trim().length === 0) {
        // 空白批：无需投递，但要推进水位（否则空白行会楔住后续投递）。
        this.source.commit(lastAbs)
        continue
      }
      const delivered = this.deliver(this.sessionId, text) !== false
      this.onBatch?.(this.sessionId, chunk.length, delivered)
      if (!delivered) break
      this.source.commit(lastAbs)
    }
  }

  /**
   * 按单条上限切批：行数 ≤ maxLines 且拼接字符数 ≤ maxChars。
   * 单行自身超限时独占一批，由 render 截断。
   */
  private batches(lines: readonly MudLine[]): MudLine[][] {
    const out: MudLine[][] = []
    let current: MudLine[] = []
    let chars = 0
    for (const line of lines) {
      const size = line.text.length + 1
      if (current.length > 0 && (current.length >= this.maxLines || chars + size > this.maxChars)) {
        out.push(current)
        current = []
        chars = 0
      }
      current.push(line)
      chars += size
    }
    if (current.length > 0) out.push(current)
    return out
  }

  /** 一批行渲染为投递文本；仅当单行自身超限时截断（行数拆批已保证其余不超限）。 */
  private render(chunk: readonly MudLine[]): string {
    const text = chunk.map(l => l.text).join('\n')
    return text.length > this.maxChars ? text.slice(0, this.maxChars) + TRUNCATED_SUFFIX : text
  }

  private clearTimers(): void {
    if (this.quietTimer !== null) {
      clearTimeout(this.quietTimer)
      this.quietTimer = null
    }
    if (this.waitTimer !== null) {
      clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
  }
}
