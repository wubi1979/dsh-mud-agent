/**
 * dsh-mud-core — 注入录制器 (Transcript), host half.
 *
 * agent 注入侧的"30 秒历史录像"。与感知缓冲 (PerceptionBuffer) 共用 MudLine 清洁行,
 * 但展示为"折叠"视图: 系统已决策 (规则/流程) 的行/区间被折叠为事件条目, agent 不再
 * 重复分析; 未触发文本原样保留。折叠只作用于注入视图, 感知缓冲原始行进不改 (可经
 * 行号 (abs) 回溯原文)。
 *
 * 结构:
 *   - 时间窗口: 只保留最近 WINDOW_MS (30s) 的内容 (行带时间戳), 与断流 (DEAD_AIR_MS)
 *     对齐; 文本断流时由 host 主动注入整窗。
 *   - 折叠: 单行触发 → 替换该行; 多行多步骤 (登录) → 折叠起始/结束行区间为一个条目。
 *   - 渲染: "什么事触发了什么动作、结果如何 + 正常游戏文本" 的综合体。
 *
 * 注入边界 (继承原 LineInjector 语义): 提示符行 / 累计字符超限 / 静默空闲定时器。
 * @module @deepseek-ai/dsh-mud-core/transcript
 */

import { isPromptRow, type MudLine, type PerceptionBuffer } from './perception.ts'

/** 静默到期的注入间隔 (无新行时行尾/提示符整体刷出)。 */
export const INJECT_IDLE_MS = 800
/** 30s 时间窗口 (对齐断流 DEAD_AIR_MS)。 */
export const TRANSCRIPT_WINDOW_MS = 30_000
/** 单批累计字符上限 (超限即整批注入)。 */
export const TRANSCRIPT_MAX_CHARS = 2000
/** 最小注入行阈值: 30s 内行数不足此值时补足到此值 (防时间空洞挤占有用行)。 */
export const TRANSCRIPT_MIN_LINES = 200

/** 一个渲染单元: 未触发行 或 折叠条目。 */
export type TranscriptUnit =
  | { kind: 'line'; abs: number; text: string; time: number }
  | { kind: 'fold'; startAbs: number; endAbs: number; text: string; time: number }

/** 折叠条目输入: 触发事件 + 执行结果。 */
export interface FoldInput {
  /** 事件类型 (如 p:login:prompt)。 */
  eventType: string
  /** 折叠区间的起始/结束绝对行号 (含闭区间)。 */
  startAbs: number
  endAbs: number
  /** 事件说明文本 (替换原行)。 */
  text: string
  /** 事件时间 (ms)。 */
  time: number
}

/** 录制器渲染选项。 */
export interface TranscriptRenderOptions {
  /** 时间窗口 (默认 30s)。 */
  windowMs?: number
  /** 最小注入行阈值: 窗口内行数不足时补足到此值。 */
  minLines?: number
  /** 单批累计字符上限。 */
  maxChars?: number
}

/**
 * 注入录制器: 30s 时间窗 + 折叠视图。作为注入侧的第三个消费者
 * (感知缓冲只写, 不持有注入水位), 唯一持有渲染状态。
 *
 * 时间窗裁剪规则: 丢超窗的最旧行, 但**保留至少 minLines 行** — 若窗口内行数
 * 不足阈值 (时间空洞把 30s 挤成最后 1s 的几行), 则保留到阈值行数为止, 防挤占。
 */
export class Transcript {
  private readonly buffer: PerceptionBuffer
  private readonly windowMs: number
  private readonly minLines: number
  private readonly maxChars: number
  private cursor = -1
  private units: TranscriptUnit[] = []

  constructor(
    buffer: PerceptionBuffer,
    { windowMs = TRANSCRIPT_WINDOW_MS, minLines = TRANSCRIPT_MIN_LINES, maxChars = TRANSCRIPT_MAX_CHARS }: TranscriptRenderOptions = {},
  ) {
    this.buffer = buffer
    this.windowMs = windowMs
    this.minLines = minLines
    this.maxChars = maxChars
  }

  /** 队列里是否还有未注入文本。 */
  get pending(): boolean {
    return this.renderText() !== ''
  }

  /** 当前待注入字符数。 */
  get pendingChars(): number {
    return this.renderText().length
  }

  reset(): void {
    this.cursor = -1
    this.units = []
  }

  /** 折叠一行或一个区间 (用折叠条目替换对应原行)。 */
  fold(input: FoldInput): void {
    // 丢弃已被此折叠覆盖的旧行单元; 同区间重复折叠 (多步骤) 也合并其上界
    this.units = this.units.filter((u) => u.kind !== 'line' || u.abs < input.startAbs || u.abs > input.endAbs)
    this.units.push({ kind: 'fold', startAbs: input.startAbs, endAbs: input.endAbs, text: input.text, time: input.time })
    this.sortUnits()
  }

  /**
   * 拉取水位后的行 + 折叠, 命中边界 (提示符 / 字数上限) 时整批注入文本。
   * @returns 命中边界时折叠渲染文本, 否则 null (待静默定时器)。
   */
  drain(): string | null {
    if (this.buffer.nextAbs <= this.cursor + 1) return null
    const { pending } = this.buffer.getLinesAfter(this.cursor, null)
    for (const line of pending) {
      this.cursor = line.abs
      this.addLine(line)
      const t = line.text.trim()
      if (t !== '' && this.renderText().length >= this.maxChars) {
        return this.takeAll()
      }
      if (line.isPrompt || isPromptRow(line)) {
        return this.takeAll()
      }
    }
    return null
  }

  /** 静默/超时强制注入。 */
  force(): string | null {
    if (!this.pending) return null
    return this.takeAll()
  }

  /** 当前队列全文 (折叠渲染; 供登录超时上下文等)。 */
  text(): string {
    return this.renderText()
  }

  /** 供 debug/测试: 当前渲染单元 (按行序)。 */
  unitsDebug(): TranscriptUnit[] {
    return this.units.slice()
  }

  /** 新增一行清洁行 (从感知缓冲拉取)。 */
  private addLine(line: MudLine): void {
    this.units.push({ kind: 'line', abs: line.abs, text: line.text.trim(), time: line.time })
  }

  /**
   * 时间窗裁剪: 保留**所有窗口内行 + 最近 minLines 行** (二者取并)。
   * 也就是说 — 30s 内行够时就只留窗口内行 (丢最旧); 窗口内行不足 minLines
   * (时间空洞把 30s 挤成最后 1s 的几行) 时补足到阈值行数, 不挤占有用行。
   */
  private prune(now: number): void {
    const cutoff = now - this.windowMs
    const keep = new Set<TranscriptUnit>()
    // 最近 minLines 行无条件保留
    const recent = [...this.units].sort((a, b) => b.time - a.time).slice(0, this.minLines)
    for (const u of recent) keep.add(u)
    // 窗口内行全部保留
    for (const u of this.units) if (u.time >= cutoff) keep.add(u)
    const kept = this.units.filter((u) => keep.has(u))
    this.units = kept.sort((a, b) => this.posAbs(a) - this.posAbs(b))
  }

  /**
   * 渲染当前窗口为注入文本 (按行序, 折叠覆盖的区间不再重复输出)。
   */
  private renderText(): string {
    return this.sortUnits()
      .map((u) => u.text)
      .filter((t) => t !== '' )
      .join('\n')
  }

  /** 单元的行位置 (line 用 abs, fold 用 startAbs)。 */
  private posAbs(u: TranscriptUnit): number {
    return u.kind === 'line' ? u.abs : u.startAbs
  }

  /** 按行序稳定排序并裁剪时间窗 (折叠以 startAbs 定位, 行以 abs 定位)。 */
  private sortUnits(): TranscriptUnit[] {
    this.prune(Date.now())
    const lines = this.units.filter((u): u is Extract<TranscriptUnit, { kind: 'line' }> => u.kind === 'line' && u.text !== '')
    const folds = this.units.filter((u): u is Extract<TranscriptUnit, { kind: 'fold' }> => u.kind === 'fold' && u.text !== '')
    const out: TranscriptUnit[] = []
    let li = 0
    let fi = 0
    while (li < lines.length || fi < folds.length) {
      const l = lines[li] as Extract<TranscriptUnit, { kind: 'line' }> | undefined
      const f = folds[fi] as Extract<TranscriptUnit, { kind: 'fold' }> | undefined
      if (l && f) {
        if (l.abs <= f.startAbs) { out.push(l); li += 1 }
        else { out.push(f); fi += 1 }
      } else if (l) { out.push(l); li += 1 }
      else if (f) { out.push(f); fi += 1 }
      else { break }
    }
    return out
  }

  private takeAll(): string {
    const text = this.renderText()
    this.units = []
    return text
  }
}