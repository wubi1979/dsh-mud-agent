/**
 * mud-core3 deliver — 聚合投递器：MUD 行流 → 用户消息投递进会话。
 *
 * 每个已注册的 SessionRuntime 挂一个 Deliverer 实例：
 *   - 行流到达 → 累积到缓冲（有上限，超出丢最旧）
 *   - 静默窗口（行流静默 N ms）或**最长等待**（连续行流永不静默）到期 → 打包投递
 *   - 一批超过单条上限时**拆成多条**依次投递，不丢弃行
 *
 * 接入闸门：
 *   - admit() → 开始投递；水位 = 当前时刻（积压不回放）
 *   - stop() → 停止投递；在途缓冲不投，后续行照常积累（录制）
 *
 * 冷会话：deliver 回调返回 false 表示 agent 不在线，此时未投出的批次**保留在缓冲**里
 * （受 maxPendingLines 约束），等 agent 唤醒时由 flushNow() 投出。
 *
 * 纯 TS，零宿主依赖。deliver 回调由装配层注入（agent.followup + createUserMessage）。
 */

import type { MudLine } from './link/line.ts'

/** 投递回调（装配层注入）；返回 false = 本次未投出（agent 离线），批次保留。 */
export type DeliverFn = (sessionId: string, text: string) => boolean | void

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
  /** 未投出缓冲上限行数（超出丢最旧；防挂机模式无界增长）。缺省 500 行。 */
  maxPendingLines?: number
  /** 缓冲溢出丢弃回调（观测用；累计值用于限流上报）。 */
  onDrop?: (sessionId: string, droppedNow: number, droppedTotal: number) => void
  /** 每批投递结果回调（观测用；delivered=false 表示批次保留待补投）。 */
  onBatch?: (sessionId: string, lineCount: number, delivered: boolean) => void
}

const DEFAULT_QUIET_MS = 500
const DEFAULT_MAX_WAIT_MS = 3000
const DEFAULT_MAX_LINES = 50
const DEFAULT_MAX_CHARS = 8000
const DEFAULT_MAX_PENDING_LINES = 500
/** 单行本身就超过 maxChars 时的截断标记。 */
const TRUNCATED_SUFFIX = '\n...(截断)'

/**
 * 单会话聚合投递器。
 *
 * 生命周期：admit → 投递 → stop。未 admit 时行流只积累（受上限约束）。
 * dispose 时清除定时器（session/disposed 用）。
 */
export class Deliverer {
  private readonly sessionId: string
  private readonly deliver: DeliverFn
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly maxLines: number
  private readonly maxChars: number
  private readonly maxPendingLines: number
  private readonly onDrop: ((sessionId: string, droppedNow: number, droppedTotal: number) => void) | undefined
  private readonly onBatch: ((sessionId: string, lineCount: number, delivered: boolean) => void) | undefined

  private admitted = false
  private buffer: MudLine[] = []
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  private dropped = 0
  private disposed = false

  constructor(sessionId: string, deliver: DeliverFn, config: DelivererConfig = {}) {
    this.sessionId = sessionId
    this.deliver = deliver
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS
    this.maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.maxLines = config.maxLines ?? DEFAULT_MAX_LINES
    this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
    this.maxPendingLines = config.maxPendingLines ?? DEFAULT_MAX_PENDING_LINES
    this.onDrop = config.onDrop
    this.onBatch = config.onBatch
  }

  /** 是否已接入。 */
  get isAdmitted(): boolean {
    return this.admitted
  }

  /**
   * 接入：开始投递。水位 = 当前缓冲（积压不回放——接入前的行不投）。
   * 实现方式：接入时清空缓冲（已有的积压行不投，后续新行才积累+投递）。
   */
  admit(): void {
    if (this.disposed || this.admitted) return
    this.admitted = true
    // 水位 = 接入时刻：清空积压，后续新行才开始积累。
    this.buffer = []
  }

  /** 停止接入：投递停。在途缓冲如有内容不投（直接丢弃待投缓冲）。 */
  stop(): void {
    if (this.disposed) return
    this.admitted = false
    this.clearTimers()
    this.buffer = []
  }

  /**
   * 行到达（runtime.onLine 接此）。
   * 未接入时只积累（录制），已接入时积累 + 武装静默/最长等待定时器。
   */
  onLine(line: MudLine): void {
    if (this.disposed) return
    this.push(line)
    if (this.admitted) this.armTimers()
  }

  /**
   * 立即尝试投出当前缓冲（agent 唤醒时由装配层调用）。
   * 未接入或缓冲为空时不动；投不出的批次保留在缓冲里。
   */
  flushNow(): void {
    this.flush()
  }

  /** 销毁（session/disposed 用）：清定时器。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    this.buffer = []
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 当前待投递缓冲行数（测试/观测用）。 */
  get pendingCount(): number {
    return this.buffer.length
  }

  /** 因超出缓冲上限被丢弃的累计行数（观测用）。 */
  get droppedLineCount(): number {
    return this.dropped
  }

  // ---------------------------------------------------------------------

  /** 入缓冲并施加上限：超出丢最旧（挂机模式内存有界）。 */
  private push(line: MudLine): void {
    this.buffer.push(line)
    const over = this.buffer.length - this.maxPendingLines
    if (over <= 0) return
    this.buffer.splice(0, over)
    this.dropped += over
    this.onDrop?.(this.sessionId, over, this.dropped)
  }

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

  /** 投出当前缓冲：按上限拆成多条；本次投不出（返回 false）的批次保留待唤醒。 */
  private flush(): void {
    this.clearTimers()
    if (this.disposed || !this.admitted || this.buffer.length === 0) return

    const lines = this.buffer
    let consumed = 0
    for (const chunk of this.batches(lines)) {
      const text = this.render(chunk)
      if (text.trim().length === 0) {
        consumed += chunk.length
        continue
      }
      const delivered = this.deliver(this.sessionId, text) !== false
      this.onBatch?.(this.sessionId, chunk.length, delivered)
      if (!delivered) break
      consumed += chunk.length
    }
    this.buffer = consumed >= lines.length ? [] : lines.slice(consumed)
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
