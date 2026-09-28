/**
 * mud-core3 deliver — 聚合投递器：MUD 行流 → 用户消息投递进会话。
 *
 * 每个已接入的 SessionRuntime 挂一个 Deliverer 实例：
 *   - 行流到达 → 累积到缓冲
 *   - 静默窗口（行流静默 N ms）→ 打包成一条文本 → 调 deliver(text) 投递
 *   - 投递后清空缓冲（水位 = 投递时刻）
 *
 * 接入闸门：
 *   - admit() → 开始投递；水位 = 当前时刻（积压不回放）
 *   - stop() → 停止投递；在途回合自然跑完，后续零投递；行流照常积累
 *
 * 纯 TS，零宿主依赖。deliver 回调由装配层注入（agent.followup + createUserMessage）。
 */

import type { MudLine } from './link/line.ts'

/** 投递回调（装配层注入：text → agent.followup(createUserMessage(...))）。 */
export type DeliverFn = (sessionId: string, text: string) => void

/** 投递器配置。 */
export interface DelivererConfig {
  /** 静默窗口毫秒：行流静默 N ms 后打包投递。缺省 500ms。 */
  quietMs?: number
  /** 单条投递最大行数（防超长消息）。缺省 50 行。 */
  maxLines?: number
  /** 单条投递最大字符数（截断护栏）。缺省 8000 字符。 */
  maxChars?: number
}

const DEFAULT_QUIET_MS = 500
const DEFAULT_MAX_LINES = 50
const DEFAULT_MAX_CHARS = 8000

/**
 * 单会话聚合投递器。
 *
 * 生命周期：admit → 投递 → stop。未 admit 时行流只积累不投递。
 * dispose 时清除定时器（session/disposed 用）。
 */
export class Deliverer {
  private readonly sessionId: string
  private readonly deliver: DeliverFn
  private readonly quietMs: number
  private readonly maxLines: number
  private readonly maxChars: number

  private admitted = false
  private buffer: MudLine[] = []
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(sessionId: string, deliver: DeliverFn, config: DelivererConfig = {}) {
    this.sessionId = sessionId
    this.deliver = deliver
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS
    this.maxLines = config.maxLines ?? DEFAULT_MAX_LINES
    this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
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
    this.clearTimer()
    this.buffer = []
  }

  /**
   * 行到达（runtime.onLine 接此）。
   * 未接入时只积累（录制），已接入时积累 + 武装静默定时器。
   */
  onLine(line: MudLine): void {
    if (this.disposed) return
    this.buffer.push(line)
    if (this.admitted) this.armQuiet()
  }

  /** 销毁（session/disposed 用）：清定时器。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.buffer = []
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 当前待投递缓冲行数（测试/观测用）。 */
  get pendingCount(): number {
    return this.buffer.length
  }

  // ---------------------------------------------------------------------

  private armQuiet(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null
      this.flush()
    }, this.quietMs)
  }

  private flush(): void {
    if (!this.admitted || this.disposed || this.buffer.length === 0) return
    const lines = this.buffer
    this.buffer = []

    // 截断护栏：限制行数和字符数
    const trimmed = lines.slice(0, this.maxLines)
    let text = trimmed.map(l => l.text).join('\n')
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars) + '\n...(截断)'
    }

    if (text.trim().length > 0) {
      this.deliver(this.sessionId, text)
    }
  }

  private clearTimer(): void {
    if (this.quietTimer !== null) {
      clearTimeout(this.quietTimer)
      this.quietTimer = null
    }
  }
}
