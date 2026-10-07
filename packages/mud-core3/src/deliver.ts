/**
 * mud-core3 deliver — 聚合投递器（pull 模型，§5.4）。
 *
 * **单一真相 = runtime.pendingLines**（环形录制缓冲）：投递器不再自持缓冲，
 * 投递 = 从源按水位线拉取 —— `takeAfter(seen)` 取已见线之后的行，拆条投出，
 * 成功后 `markDelivered` 只推进到成功投出的批次。失败批次停留 pending，
 * 下次 flush 从失败点自然重试 —— 不丢行。readAbs（工具读水位）由 runtime
 * 的 read() 推进；已见线 seen = max(deliveredAbs, readAbs)，结构消除重复投递。
 *
 * 投递时机（§4.3）：
 *   A. turn 期间（turn/start → turn/end）：抑制模式——不武装定时器，行只进 pending；
 *   B. turn/end：flush 一次（onTurnEnd）；
 *   C. 空闲模式（agent 不在 turn）：quiet/maxWait 定时器到期即 flush；
 *   D. 失败退避：瞬时失败（原因字符串，如宿主 append 重入保护）按 quietMs 起步
 *      倍增到 maxWaitMs 封顶自动重试——行流安静时也能自愈，成功即复位；
 *      句柄缺失（false）不重试（恢复路径 = agent/created 补投 + 静默唤醒）。
 *
 * 接入闸门：
 *   - admit() → 开始投递；delivered 水位 = 当前末端行号（积压不回放）；
 *   - stop() → 停止投递（未接入零拉取、零积累、零丢弃日志——录制归 runtime 环）。
 *
 * 冷会话：deliver 回调返回 false / 失败原因字符串表示未投出，该批不推进水位（行仍在
 * pending），等 agent 唤醒时由 flushNow() 补投；失败原因经 onBatch 进会话日志。
 *
 * 纯 TS，零宿主依赖。deliver 回调与 DeliverySource 由装配层注入。
 */

import type { MudLine } from './link/line.ts'

/**
 * 投递回调（装配层注入）。
 * 返回 true / undefined = 已投出；返回 false = 未投出（无原因，按 agent 不在线处理）；
 * 返回字符串 = 未投出 + 失败原因（写进会话日志，诊断用）。未投出的批次不推进水位。
 */
export type DeliverFn = (sessionId: string, text: string) => boolean | string | void

/**
 * 投递源（runtime 水位线注入面）：Deliverer 经此拉取待投行、推进投递水位。
 * pending 环、readAbs、断线复位全部归 runtime（单一真相）。
 */
export interface DeliverySource {
  /** 当前已见线 seen = max(deliveredAbs, readAbs)。 */
  seenAbs(): number
  /** 取已见线之后的待投行（快照；行仍在 pending 环里，不物理消费）。 */
  linesAfter(seen: number): MudLine[]
  /** 末端行号（尚无行时 -1）—— admit 水位 = 接入时刻用。 */
  lastAbs(): number
  /** 推进投递水位（只推进到成功投出的批次）。 */
  markDelivered(abs: number): void
}

/** 投递器配置。 */
export interface DelivererConfig {
  /** 静默窗口毫秒：行流静默 N ms 后打包投递（空闲模式）。缺省 500ms。 */
  quietMs?: number
  /** 批次最长等待毫秒：行流持续不静默时也在此上限内投出。缺省 3000ms。 */
  maxWaitMs?: number
  /** 单条投递最大行数（超出拆成多条）。缺省 50 行。 */
  maxLines?: number
  /** 单条投递最大字符数（超出拆成多条）。缺省 8000 字符。 */
  maxChars?: number
  /**
   * 投递白名单（C5.2 剔除策略的放行面）：缺省有标行（line.kind ≠ null）一律
   * 不投（聊天/他人动作不进 agent——安全前提）；白名单列出的 kind 放行。
   * 有标行视为**已见**（水位越过），只是不进投递文本。
   */
  allowKinds?: string[]
  /** 每批投递结果回调（观测用；delivered=false 表示该批未投出、水位不推进，reason = 失败原因）。 */
  onBatch?: (sessionId: string, lineCount: number, delivered: boolean, reason?: string) => void
  /**
   * 投递压制谓词（T21.4 交战接管注入）：返回 true 时 flush 零拉取——接管期
   * 战斗原文不进 agent（行已被长读窗消费并推进 readAbs，释放后不回放）。
   */
  suppress?: () => boolean
}

const DEFAULT_QUIET_MS = 500
const DEFAULT_MAX_WAIT_MS = 3000
const DEFAULT_MAX_LINES = 50
const DEFAULT_MAX_CHARS = 8000
/** 单行本身就超过 maxChars 时的截断标记。 */
const TRUNCATED_SUFFIX = '\n...(截断)'

/**
 * 单会话聚合投递器（pull 模型）。
 *
 * 生命周期：admit → 投递 → stop。未 admit 时零拉取（录制归 runtime）。
 * dispose 时清除定时器（session/disposed 用）。
 */
export class Deliverer {
  private readonly sessionId: string
  private readonly deliver: DeliverFn
  private readonly source: DeliverySource
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly maxLines: number
  private readonly maxChars: number
  /** 投递白名单（kind 集合；缺省空 = 有标行一律不投）。 */
  private readonly allowSet: ReadonlySet<string>
  private readonly onBatch:
    | ((sessionId: string, lineCount: number, delivered: boolean, reason?: string) => void)
    | undefined
  /** 投递压制谓词（T21.4 交战接管注入；缺省恒不压制）。 */
  private readonly suppress: () => boolean

  private admitted = false
  /** turn 抑制模式（turn/start → turn/end 之间不武装定时器）。 */
  private turnMode = false
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  /** 失败退避当前延迟（0 = 无退避态；失败时 quietMs 起步倍增，成功即复位）。 */
  private retryDelay = 0
  private disposed = false

  constructor(
    sessionId: string,
    deliver: DeliverFn,
    source: DeliverySource,
    config: DelivererConfig = {},
  ) {
    this.sessionId = sessionId
    this.deliver = deliver
    this.source = source
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.maxLines = config.maxLines ?? DEFAULT_MAX_LINES
    this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
    this.allowSet = new Set(config.allowKinds ?? [])
    this.onBatch = config.onBatch
    this.suppress = config.suppress ?? (() => false)
  }

  /** 是否已接入。 */
  get isAdmitted(): boolean {
    return this.admitted
  }

  /** 是否回合中（turn/start → turn/end 之间；静默唤醒守卫用）。 */
  get isInTurn(): boolean {
    return this.turnMode
  }

  /**
   * 接入：开始投递。delivered 水位 = 当前末端行号（积压不回放——接入前的行不投，
   * 之后新行才拉取投递）。
   */
  admit(): void {
    if (this.disposed || this.admitted) return
    this.admitted = true
    this.source.markDelivered(this.source.lastAbs())
  }

  /** 停止接入：投递停（零拉取）。 */
  stop(): void {
    if (this.disposed) return
    this.admitted = false
    this.clearTimers()
  }

  /**
   * 行到达（runtime.onLine 接此）：仅已接入且非 turn 模式时武装静默/最长等待
   * 定时器。**零缓冲**——行已进 runtime.pending（录制），这里只剩调度。
   */
  onLine(_line: MudLine): void {
    if (this.disposed || !this.admitted || this.turnMode) return
    this.armTimers()
  }

  /** turn 开始（宿主 turn/start 事件）：抑制定时器（回合内行只进 pending）。 */
  onTurnStart(): void {
    if (this.disposed) return
    this.turnMode = true
    this.clearTimers()
  }

  /** turn 结束（宿主 turn/end 事件）：退出抑制并冲刷一次（未投行一次投出）。 */
  onTurnEnd(): void {
    if (this.disposed) return
    this.turnMode = false
    this.flush()
  }

  /**
   * 立即拉取投出（agent 上线补投 / turn/end / 管理触发共用）。
   * 未接入或已见线之后无新行时不动。
   */
  flushNow(): void {
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

  /** 当前待投行数（已见线之后；测试/观测用）。 */
  get pendingCount(): number {
    return this.admitted ? this.source.linesAfter(this.source.seenAbs()).length : 0
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

  /** 拉取投出：按上限拆成多条；未投出（返回 false）的批次不推进水位（下次重试）。 */
  private flush(): void {
    this.clearTimers()
    if (this.disposed || !this.admitted) return
    if (this.suppress()) return // 交战接管期：零拉取（战斗原文由长读窗消费，D4）
    const seen = this.source.seenAbs()
    const lines = this.source.linesAfter(seen)
    if (lines.length === 0) return

    // C5.2 剔除策略：有标行（白名单外）不进投递文本，但视为已见——水位随成功
    // 批次越过它们。全段无可投行时水位直接越过本段（剔除恒定，避免永挂重扫）。
    const deliverable = lines.filter(l => l.kind === null || this.allowSet.has(l.kind))
    if (deliverable.length === 0) {
      const tail = lines.at(-1)
      if (tail !== undefined) this.source.markDelivered(tail.abs)
      return
    }

    let consumed = 0
    let maxAbs = seen
    for (const chunk of this.batches(deliverable)) {
      const text = this.render(chunk)
      const chunkTail = chunk[chunk.length - 1]
      const chunkAbs = chunkTail === undefined ? seen : chunkTail.abs
      if (text.trim().length === 0) {
        // 纯空白行不投（无信息量），但已见——水位越过。
        consumed += chunk.length
        maxAbs = chunkAbs
        continue
      }
      const result = this.tryDeliver(text)
      const delivered = result === true || result === undefined
      this.onBatch?.(this.sessionId, chunk.length, delivered, typeof result === 'string' ? result : result === false ? 'agent 不在线（句柄缺失）' : undefined)
      if (!delivered) {
        // 瞬时失败（有原因）→ 退避重试自愈；句柄缺失（false）→ 等既有恢复路径。
        if (typeof result === 'string') this.armRetry()
        break
      }
      consumed += chunk.length
      maxAbs = chunkAbs
    }
    // delivered 只推进到成功投出的批次（失败批停留 pending，下次自然重试）。
    if (consumed > 0) {
      this.retryDelay = 0
      this.source.markDelivered(maxAbs)
    }
  }

  /** 失败退避：quietMs 起步倍增到 maxWaitMs 封顶（复用 quietTimer 槽；flush 入口会清）。 */
  private armRetry(): void {
    this.retryDelay = this.retryDelay === 0 ? this.quietMs : Math.min(this.retryDelay * 2, this.maxWaitMs)
    this.clearTimers()
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      this.flush()
    }, this.retryDelay)
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

  /**
   * 单批投递（异常收编）：deliver 回调抛错不逃逸 flush（定时器路径无兜底），
   * 收编为失败原因字符串（进会话日志，诊断用）。
   */
  private tryDeliver(text: string): boolean | string | void {
    try {
      return this.deliver(this.sessionId, text)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return `followup 抛错：${message}`
    }
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
