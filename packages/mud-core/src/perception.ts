/**
 * dsh-mud-core — 感知层 (Perception), host half. 协调器 + 原始文本标准化。
 *
 * 职责边界 (对齐拆分):
 *   - **文本标准化**: consumption telnet 产出的完整逻辑行 (ParsedLine) → 标准行
 *     (MudLine) 环形缓冲, 去 ANSI 供下游读取; prompt 行识别。
 *   - **协调器 (PerceptionDriver)**: 持消费游标, 数据到达即把未匹配窗口喂给
 *     触发服务 (ctx.mud.trigger), 命中过滤去重后发布到事件总线; 随后处理注入
 *     侧的水位推进由 transcript.ts 独立负责。
 *   - **不含匹配与状态**: 触发匹配 (Perceptor) 迁往 triggers.ts, 人物状态捕获
 *     + GMCP 世界映射迁往 state.ts。本层不写世界、不发决策。
 *
 * 行来源: telnet 的流式 ANSI 解析器 (ansi.ts) 只产出"完整逻辑行", 跨 TCP 块
 * 被截断的行尾/转义序列由解析器内部续接 —— 绝对行号稳定, 多行规则不再被块
 * 边界切碎。感知规则匹配 (contains/regex/color) 见 triggers.ts。
 *
 * 存储: PerceptionBuffer 为固定容量环形缓冲 (量满覆盖最旧行, 批量缩容) ——
 * 感知是状态流, 历史超窗即让位; abs 单调分配不受缩容影响, 消费游标语义稳定。
 * @module @deepseek-ai/dsh-mud-core/perception
 */

import type { MudLine, ParsedLine, StyleRun } from './ansi.ts'
import type { TriggerService, PerceptHit } from './triggers.ts'

export const MAX_BUFFER_ROWS = 2000
export const MAX_PENDING_LINES = 200

export type { MudLine, ParsedLine, StyleRun }

/** prompt 启发: 默认裸 > / ＞ 行; 可经 promptRe 自定义。 */
export function isPromptRow(row: { text: string }, promptRe: RegExp | null = null): boolean {
  const text = (row.text ?? '').trim()
  if (promptRe) return promptRe.test(text)
  return text === '>' || text === '＞' || /^[>＞]\s*$/.test(text)
}

/**
 * 标准行存储 (环形缓冲): 完整逻辑行按单调绝对行号 (abs) 存储。
 * 只追加 (解析器顺序产出), 不持有消费状态 —— 消费游标归消费者 (PerceptionDriver /
 * 注入水位线)。固定容量预分配槽位, 满时新行直接覆盖首部最旧行 (批量缩容,
 * 对齐 Mudlet shrinkBuffer: 一次批删头部, 非逐行 splice/shift)。
 */
export class PerceptionBuffer {
  readonly maxRows: number
  /** 下一个待分配的绝对行号 (单调递增; 断言不清零的位移不受缩容影响)。 */
  nextAbs = 0
  private readonly slots: (MudLine | undefined)[]
  private start = 0
  private len = 0

  constructor({ maxRows = MAX_BUFFER_ROWS }: { maxRows?: number } = {}) {
    this.maxRows = maxRows
    this.slots = new Array<MudLine | undefined>(maxRows)
  }

  clear(): void {
    this.slots.fill(undefined)
    this.start = 0
    this.len = 0
    this.nextAbs = 0
  }

  /** 逻辑下标 → 物理槽位。 */
  private slotAt(i: number): MudLine | undefined {
    return this.slots[(this.start + i) % this.maxRows]
  }

  /** 追加一批完整行 (解析器产出) 并分配单调 abs; 返回追加行数。 */
  appendLines(lines: readonly ParsedLine[]): number {
    for (const p of lines) {
      const row: MudLine = {
        text: p.text,
        raw: p.raw,
        style: p.style,
        abs: this.nextAbs,
        time: p.time,
        isPrompt: p.isPrompt,
      }
      const at = (this.start + this.len) % this.maxRows
      this.slots[at] = row
      this.nextAbs += 1
      if (this.len < this.maxRows) {
        this.len += 1
      } else {
        // 满: 覆盖最旧行 = 批量缩容 (O(1), 无数组平移)。
        this.start = (this.start + 1) % this.maxRows
      }
    }
    return lines.length
  }

  /** 最新一行 (空缓冲返回 null)。 */
  last(): MudLine | null {
    if (this.len === 0) return null
    return this.slotAt(this.len - 1) ?? null
  }

  /**
   * 游标读: 返回 (pending, dropped)。
   * @param cursor 已消费的最大绝对行号。
   * @param maxLines 上限 (超限保留最新行)。
   * @returns 待匹配行与跳过的行数。
   */
  getLinesAfter(cursor: number, maxLines: number | null = null): { pending: MudLine[]; dropped: number } {
    if (this.len === 0) return { pending: [], dropped: 0 }
    const base = this.slotAt(0)?.abs ?? 0
    const dropped = cursor < base - 1 ? base - 1 - cursor : 0
    let from = Math.max(cursor - base + 1, 0)
    if (from >= this.len) return { pending: [], dropped }
    let count = this.len - from
    let droppedCap = 0
    if (maxLines !== null && count > maxLines) {
      droppedCap = count - maxLines
      from += droppedCap
      count = maxLines
    }
    const pending: MudLine[] = new Array(count)
    for (let k = 0; k < count; k += 1) {
      const row = this.slotAt(from + k)
      if (row !== undefined) pending[k] = row
    }
    return { pending, dropped: dropped + droppedCap }
  }

  /** 逻辑顺序快照 (全部行, 保序)。 */
  snapshot(): MudLine[] {
    const out: MudLine[] = new Array(this.len)
    for (let i = 0; i < this.len; i += 1) {
      const row = this.slotAt(i)
      if (row !== undefined) out[i] = row
    }
    return out
  }

  /** 逻辑顺序条目视图 (兼容旧 { abs, row } 形态; 全部行保序)。 */
  get entries(): { abs: number; row: MudLine }[] {
    const out: { abs: number; row: MudLine }[] = new Array(this.len)
    for (let i = 0; i < this.len; i += 1) {
      const row = this.slotAt(i)
      if (row !== undefined) out[i] = { abs: row.abs, row }
    }
    return out
  }
}

/** PerceptionDriver 构造参数。 */
export interface PerceptionDriverOptions {
  buffer: PerceptionBuffer
  trigger: TriggerService
  promptRe?: RegExp | null
  maxPending?: number
  /** 每发布一个中继事件的钩子 (测试断言/调试)。 */
  publishHook?: (hit: PerceptHit) => void
}

/** 供外部总计已发布事件的钩子 (可选; 主要用于测试断言)。 */
type PublishHook = (hit: PerceptHit) => void

/**
 * 感知协调器 (消费者/驱动): 持本地消费游标, 数据到达即驱动管线。
 * onData() 每次 upsert 后由 host 调用:
 *   1. 取待匹配集 (游标后全部行, 有界);
 *   2. trigger.match → 过滤已发布去重 → trigger.publish (发总线);
 *   3. 游标推进到末命中行; prompt 行强制消费 (切分回合, 防窗口滞留);
 *   4. dropped → 游标推进越过。
 * 世界同步与决策由总线消费者 (state/rules/flow/agent) 各自订阅完成。
 */
export class PerceptionDriver {
  readonly buffer: PerceptionBuffer
  private readonly trigger: TriggerService
  private readonly promptRe: RegExp | null
  private readonly maxPending: number
  private cursor = -1
  private readonly published = new Set<string>() // 已发布事件 (ruleId:lineNumber) 去重
  private readonly publishHook: PublishHook | null

  constructor(options: PerceptionDriverOptions) {
    this.buffer = options.buffer
    this.trigger = options.trigger
    this.promptRe = options.promptRe ?? null
    this.maxPending = options.maxPending ?? MAX_PENDING_LINES
    this.publishHook = options.publishHook ?? null
  }

  reset(): void {
    this.cursor = -1
    this.published.clear()
  }

  /** 数据到达: 取窗口 → 匹配 → 去重 → 发布 → 推进游标。 */
  onData(): void {
    const { pending, dropped } = this.buffer.getLinesAfter(this.cursor, this.maxPending)
    if (dropped > 0 && pending.length > 0) {
      // 被裁剪的行不可再匹配: 游标推进到返回首行之前
      this.cursor = (pending[0]?.abs ?? 0) - 1
    }
    if (pending.length === 0) return
    const hits = this.trigger.match(pending)
    let advance = this.cursor
    for (const hit of hits) {
      const key = `${hit.id}:${hit.lineNumber}`
      if (this.published.has(key)) continue
      this.published.add(key)
      hit.reason = 'line'
      this.trigger.publish(hit)
      this.publishHook?.(hit)
      if (hit.lineNumber > advance) advance = hit.lineNumber
    }
    // prompt 行是强制消费点: 游标推进到该行 (切分回合, 防窗口滞留)
    for (const line of pending) {
      if (line.isPrompt || isPromptRow(line, this.promptRe)) {
        if (line.abs > advance) advance = line.abs
        break
      }
    }
    this.cursor = advance
  }

  /** 显式边界 (GMCP Room.Info 等): 强制消费窗口到最新。 */
  boundary(reason = 'room'): void {
    void reason
    const last = this.buffer.last()
    if (last) this.cursor = Math.max(this.cursor, last.abs)
  }
}