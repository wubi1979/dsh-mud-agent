/**
 * dsh-mud-core — 注入队列 (agent 输入侧), host half.
 *
 * 统一 MudLine 主导线: agent 注入不再自持一份 raw 文本累积 (旧 batchText),
 * 而是以感知缓冲 (PerceptionBuffer, MudLine 存储) 为唯一真相, 按 abs 水位线
 * 拉取未注入行、批量合并后注入 —— 解析一次顺带去 ANSI (agent 用 text 列),
 * 与触发匹配同一条管线, 无重复解析、无行号错位。
 *
 * 边界 (对齐旧 batch 语义):
 *   提示符行 (isPrompt) → 立即整批注入;
 *   累计字符超 INJECT_MAX_CHARS → 立即整批注入;
 *   静默 (无新行) → host 空闲定时器强制注入 (INJECT_IDLE_MS)。
 *
 * 消费语义: drain() 把水位后的行"拉进"内部队列 (水位推进), 因此空白行/纯
 * 转义行被消费但不上注入面; 边界命中时整批取出, 队列清空。
 * @module @deepseek-ai/dsh-mud-core/inject
 */

import { isPromptRow, type PerceptionBuffer } from './perception.ts'

/** 静默到期的注入间隔 (无新行时行尾/提示符整体刷出)。 */
export const INJECT_IDLE_MS = 800
/** 单批累计字符上限 (超限即整批注入, 对齐旧 batchText 2000 上限)。 */
export const INJECT_MAX_CHARS = 2000

/**
 * 注入队列: 感知缓冲 (MudLine) 的第二个消费者 (第一个是 StateTracker/感知)。
 * 只读 + 水位, 不影响感知游标; 唯一持有注入侧状态。
 */
export class LineInjector {
  private cursor = -1
  private queue: string[] = []
  private chars = 0

  constructor(private readonly buffer: PerceptionBuffer) {}

  /** 队列里是否还有未注入文本。 */
  get pending(): boolean {
    return this.queue.length > 0
  }

  /** 当前累计待注入字符数。 */
  get pendingChars(): number {
    return this.chars
  }

  reset(): void {
    this.cursor = -1
    this.queue = []
    this.chars = 0
  }

  /**
   * 新行到达: 拉取水位后的行并入队。
   * @returns 命中边界 (提示符 / 字数上限) 时整批注入文本, 否则 null (待静默定时器)。
   */
  drain(): string | null {
    if (this.buffer.nextAbs <= this.cursor + 1) return null
    const { pending } = this.buffer.getLinesAfter(this.cursor, null)
    for (const line of pending) {
      this.cursor = line.abs
      const t = line.text.trim()
      if (t !== '') {
        this.queue.push(t)
        this.chars += t.length
      }
      if (line.isPrompt || isPromptRow(line) || this.chars >= INJECT_MAX_CHARS) {
        return this.takeAll()
      }
    }
    return null
  }

  /** 静默/超时强制注入 (空闲定时器, 或 host 主动边界)。 */
  force(): string | null {
    if (this.queue.length === 0) return null
    return this.takeAll()
  }

  /** 当前队列全文 (trim 后按行拼接; 供 login 超时上下文等)。 */
  text(): string {
    return this.queue.join('\n')
  }

  private takeAll(): string {
    const text = this.queue.join('\n')
    this.queue = []
    this.chars = 0
    return text
  }
}
