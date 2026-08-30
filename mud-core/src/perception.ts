/**
 * dsh-mud-core — 感知层 (Perception), host half.
 *
 * 流式游标模型 (对齐 Python 项目 SmartBuffer/StateTracker):
 *
 *   数据到达 (流式解析器产出的完整行) ──► PerceptionBuffer (标准行对象存储, 单调 abs)
 *                                          │
 *                                          ▼ 每次 appendLines 后触发 onData
 *                                    StateTracker (消费者, 本地游标)
 *                                          │  getLinesAfter(cursor) 取待匹配集
 *                                          ▼
 *                                    Perceptor.match(pending)  → 单行规则逐行 /
 *                                          多行规则对窗口整体匹配
 *                                          │ 命中 → 处理 (WorldModel + 事件)
 *                                          ▼ 游标推进到末命中行
 *                               未命中的尾行保留 → 下次数据到达继续匹配
 *
 * 行来源: telnet 的流式 ANSI 解析器 (ansi.ts) 只产出"完整逻辑行", 跨 TCP 块
 * 被截断的行尾/转义序列由解析器内部续接 —— 绝对行号稳定, 多行规则不再被
 * 块边界切碎。本层消费统一的 MudLine (text/raw/style/abs/time/isPrompt),
 * 感知规则匹配使用 text 列, 颜色触发使用 style 列 (fg/bg/fgTrue/bgTrue 条件)。
 *
 * 存储: PerceptionBuffer 为固定容量环形缓冲 (量满覆盖最旧行, 批量缩容) ——
 * 感知是状态流, 历史超窗即让位; abs 单调分配不受缩容影响, 消费游标语义稳定。
 * @module @deepseek-ai/dsh-mud-core/perception
 */

import type { WorldModel } from './world.ts'
import { applyPatch } from './world.ts'
import type { MudLine, ParsedLine, StyleRun } from './ansi.ts'

export const MAX_BUFFER_ROWS = 1000
export const MAX_PENDING_LINES = 200

export type { MudLine, ParsedLine, StyleRun }

/** 颜色触发条件 (Mudlet 颜色触发对齐): 与 style run 逐段匹配。 */
export interface ColorCond {
  /** 前景 256 色索引; 指定 null 表示"匹配默认前景"。 */
  fg?: number | null
  /** 背景 256 色索引; 指定 null 表示"匹配默认背景"。 */
  bg?: number | null
  /** 真彩前景 (优先级高于 fg)。 */
  fgTrue?: [number, number, number] | null
  /** 真彩背景 (优先级高于 bg)。 */
  bgTrue?: [number, number, number] | null
}

function rgbEq(a: [number, number, number] | null | undefined,
  b: [number, number, number] | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined
    && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** 任一段 run 命中全部已指定通道即算命中 (行对象携带 style run 列表)。 */
export function styleMatchesColor(rows: readonly { style: readonly StyleRun[] }[], cond: ColorCond): boolean {
  if (rows.length === 0) return false
  return rows.some(row => row.style.some(r =>
    (cond.fg === undefined || r.fg === cond.fg)
    && (cond.bg === undefined || r.bg === cond.bg)
    && (cond.fgTrue === undefined || rgbEq(r.fgTrue, cond.fgTrue))
    && (cond.bgTrue === undefined || rgbEq(r.bgTrue, cond.bgTrue)),
  ))
}

/** prompt 启发: 默认裸 > / ＞ 行; 可经 promptRe 自定义。 */
export function isPromptRow(row: { text: string }, promptRe: RegExp | null = null): boolean {
  const text = (row.text ?? '').trim()
  if (promptRe) return promptRe.test(text)
  return text === '>' || text === '＞' || /^[>＞]\s*$/.test(text)
}

/**
 * 标准行存储 (环形缓冲): 完整逻辑行按单调绝对行号 (abs) 存储。
 * 只追加 (解析器顺序产出), 不持有消费状态 —— 消费游标归消费者 (StateTracker /
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

/** 感知规则命中结果。 */
export interface PerceptHit {
  id: string
  eventType: string
  lineNumber: number
  data: Record<string, unknown> | null
  reason?: string
}

/** 感知规则 (配置来源, config/rules.ts)。 */
export interface PerceptionRule {
  id: string
  eventType?: string
  priority?: number
  multiline?: boolean
  greedy?: boolean
  contains?: readonly string[]
  regex?: readonly (string | RegExp)[]
  /** 颜色触发: 指定后要求行内任一段 run 命中全部已指定通道。与 contains/regex 为 AND。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: { rows: MudLine[] }) => boolean
  extract?: (record: { rows: MudLine[] }) => Record<string, unknown> | null
}

/** 归一化感知规则。 */
interface NormalizedPerceptionRule {
  id: string
  eventType: string
  priority: number
  multiline: boolean
  greedy: boolean
  contains: string[]
  regex: RegExp[]
  color: ColorCond | null
  guard: ((record: { rows: MudLine[] }) => boolean) | null
  extract: ((record: { rows: MudLine[] }) => Record<string, unknown> | null) | null
}

/**
 * 感知器 (Perceptor): 确定性规则匹配器, 对齐 Python Matcher。
 * match(lines) 一次跑完窗口内全部规则, 返回按行号排序的结果。
 */
export class Perceptor {
  private rules: NormalizedPerceptionRule[] = []
  private readonly keywordIndex = new Map<string, string[]>() // 字面量首字符 → rule id 列表
  private readonly owners = new Map<string, string>() // rule id → owner

  register(rule: PerceptionRule, owner = ''): NormalizedPerceptionRule {
    const multiline = !!rule.multiline
    const color: ColorCond | null =
      rule.fg !== undefined || rule.bg !== undefined
      || rule.fgTrue !== undefined || rule.bgTrue !== undefined
        ? {
          ...(rule.fg !== undefined ? { fg: rule.fg } : {}),
          ...(rule.bg !== undefined ? { bg: rule.bg } : {}),
          ...(rule.fgTrue !== undefined ? { fgTrue: rule.fgTrue } : {}),
          ...(rule.bgTrue !== undefined ? { bgTrue: rule.bgTrue } : {}),
        }
        : null
    const norm: NormalizedPerceptionRule = {
      id: rule.id,
      eventType: rule.eventType || rule.id,
      priority: rule.priority ?? 10,
      multiline,
      greedy: !!rule.greedy,
      contains: (rule.contains ?? []).map(String),
      regex: (rule.regex ?? []).map(r =>
        typeof r === 'string' ? new RegExp(r, multiline ? 'm' : '') : r,
      ),
      color,
      guard: rule.guard ?? null,
      extract: rule.extract ?? null,
    }
    // 同 id 覆盖: 先清旧索引
    this.unregister(norm.id)
    let i = 0
    while (i < this.rules.length && (this.rules[i]?.priority ?? 0) >= norm.priority) i += 1
    this.rules.splice(i, 0, norm)
    for (const lit of norm.contains) {
      const key = lit.slice(0, 1)
      if (!key) continue
      const list = this.keywordIndex.get(key) ?? []
      list.push(norm.id)
      this.keywordIndex.set(key, list)
    }
    if (owner) this.owners.set(norm.id, owner)
    return norm
  }

  /** 注销一条规则 (同 id 覆盖时也调用)。 */
  unregister(ruleId: string): void {
    const idx = this.rules.findIndex(r => r.id === ruleId)
    if (idx >= 0) this.rules.splice(idx, 1)
    this.owners.delete(ruleId)
    for (const [key, list] of this.keywordIndex) {
      const i = list.indexOf(ruleId)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.keywordIndex.delete(key)
    }
  }

  /** 按 owner 批量注销。 */
  unregisterByOwner(owner: string): number {
    const ids: string[] = []
    for (const [ruleId, ow] of this.owners) {
      if (ow === owner) ids.push(ruleId)
    }
    for (const id of ids) this.unregister(id)
    return ids.length
  }

  /** 关键词快路径: 待匹配集里出现过哪些字面量首字符 → 候选规则 id 集。 */
  private candidates(lines: MudLine[]): Set<string> {
    const out = new Set<string>()
    for (const line of lines) {
      for (const ch of line.text) {
        const list = this.keywordIndex.get(ch)
        if (list) for (const id of list) out.add(id)
      }
    }
    return out
  }

  /** 窗口匹配: 返回 [{ id, eventType, lineNumber, data }] 按 lineNumber 排序。 */
  match(lines: MudLine[]): PerceptHit[] {
    if (!lines || lines.length === 0) return []
    const results: PerceptHit[] = []
    const candidates = this.candidates(lines)
    for (const rule of this.rules) {
      if (rule.contains.length > 0 && !candidates.has(rule.id)) continue
      if (rule.multiline) {
        const r = this.matchMultiline(rule, lines)
        if (r) results.push(r)
      } else {
        for (const line of lines) {
          const r = this.matchLine(rule, line)
          if (r) results.push(r)
        }
      }
    }
    results.sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0))
    return results
  }

  private ruleHit(rule: NormalizedPerceptionRule, record: { rows: MudLine[] }): boolean {
    if (rule.color !== null && !styleMatchesColor(record.rows, rule.color)) return false
    if (rule.guard && !rule.guard(record)) return false
    const text = record.rows.map(r => r.text).join('\n')
    const hasPattern = rule.contains.length > 0 || rule.regex.length > 0
    if (rule.contains.length > 0) {
      for (const lit of rule.contains) {
        if (text.includes(lit)) return true
      }
    }
    if (rule.regex.length > 0) {
      for (const re of rule.regex) {
        if (re.test(text)) return true
      }
    }
    // 无文本模式: 纯颜色条件本身就是模式 (颜色触发); 否则退化为 extract 触发。
    if (!hasPattern) return rule.color !== null || !!rule.extract
    return false
  }

  private matchLine(rule: NormalizedPerceptionRule, line: MudLine): PerceptHit | null {
    const record = { rows: [line] }
    if (!this.ruleHit(rule, record)) return null
    return {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      data: rule.extract ? rule.extract(record) : null,
    }
  }

  private matchMultiline(rule: NormalizedPerceptionRule, lines: MudLine[]): PerceptHit | null {
    if (rule.color !== null && !styleMatchesColor(lines, rule.color)) return null
    const text = lines.map(l => l.text).join('\n')
    const hasPattern = rule.contains.length > 0 || rule.regex.length > 0
    if (rule.guard && !rule.guard({ rows: lines })) return null
    let ok = false
    let matchIndex = -1
    if (rule.contains.length > 0) {
      for (const lit of rule.contains) {
        const idx = text.indexOf(lit)
        if (idx >= 0) {
          ok = true
          matchIndex = idx
          break
        }
      }
    }
    if (!ok && rule.regex.length > 0) {
      for (const re of rule.regex) {
        const m = re.exec(text)
        if (m) {
          ok = true
          matchIndex = m.index
          break
        }
      }
    }
    if (!ok && !hasPattern && (rule.color !== null || rule.extract)) {
      ok = true
      matchIndex = 0
    }
    if (!ok) return null
    // 定位匹配起点所在行 (跨行匹配命中行号 = 起点行)
    let lineNumber = lines[lines.length - 1]?.abs ?? 0
    let consumed = 0
    for (const line of lines) {
      if (matchIndex <= consumed + line.text.length) {
        lineNumber = line.abs
        break
      }
      consumed += line.text.length + 1
    }
    return {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber,
      data: rule.extract ? rule.extract({ rows: lines }) : null,
    }
  }
}

/** StateTracker 构造参数。 */
export interface StateTrackerOptions {
  world: WorldModel
  buffer: PerceptionBuffer
  perceptor: Perceptor
  promptRe?: RegExp | null
  maxPending?: number
  emit?: (hit: PerceptHit, patch: Record<string, unknown>) => void
}

/**
 * 状态追踪器 (消费者): 持本地消费游标, 数据到达即驱动匹配。
 * onData() 每次 upsert 后由 host 调用:
 *   1. 取待匹配集 (游标后全部行, 有界);
 *   2. perceptor.match → 处理命中 (WorldModel + 事件);
 *   3. 游标推进到末命中行; prompt 行强制消费;
 *   4. dropped → 游标推进越过。
 */
export class StateTracker {
  readonly world: WorldModel
  private readonly buffer: PerceptionBuffer
  private readonly perceptor: Perceptor
  private readonly promptRe: RegExp | null
  private readonly maxPending: number
  private readonly emit: ((hit: PerceptHit, patch: Record<string, unknown>) => void) | null
  private cursor = -1
  private readonly published = new Set<string>() // 已发布事件 (rule:lineNumber) 去重

  constructor(options: StateTrackerOptions) {
    this.world = options.world
    this.buffer = options.buffer
    this.perceptor = options.perceptor
    this.promptRe = options.promptRe ?? null
    this.maxPending = options.maxPending ?? MAX_PENDING_LINES
    this.emit = options.emit ?? null
  }

  reset(): void {
    this.cursor = -1
    this.published.clear()
  }

  /** 数据到达: 取窗口 → 匹配 → 处理 → 推进游标。 */
  onData(): void {
    const { pending, dropped } = this.buffer.getLinesAfter(this.cursor, this.maxPending)
    if (dropped > 0 && pending.length > 0) {
      // 被裁剪的行不可再匹配: 游标推进到返回首行之前
      this.cursor = (pending[0]?.abs ?? 0) - 1
    }
    if (pending.length === 0) return
    const results = this.perceptor.match(pending)
    let advance = this.cursor
    for (const hit of results) {
      const key = `${hit.id}:${hit.lineNumber}`
      if (this.published.has(key)) continue
      this.published.add(key)
      hit.reason = 'line'
      this.apply(hit)
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

  /** host 显式边界 (GMCP Room.Info 等): 强制消费窗口到最新。 */
  boundary(reason = 'room'): void {
    void reason
    const last = this.buffer.last()
    if (last) this.cursor = Math.max(this.cursor, last.abs)
  }

  /** 命中 → WorldModel 合并 + 事件。 */
  apply(hit: PerceptHit): void {
    const patch: Record<string, unknown> = {}
    switch (hit.eventType) {
      // 登录提示 (常驻感知, p: 前缀)
      case 'p:login:prompt':
        patch.awaiting = true
        patch.logged_in = false
        break
      case 'p:login:pass':
        patch.awaiting = true
        break
      case 'p:login:done':
        patch.awaiting = false
        patch.logged_in = true
        patch.initialized = true
        break
      case 'p:login:replace':
        patch.awaiting = true
        break
      case 'p:login:failed':
        patch.awaiting = false
        patch.logged_in = false
        break
      // 语义感知事件 (战斗/死亡, p: 前缀)
      case 'p:combat:start':
        patch.in_combat = true
        break
      case 'p:combat:end':
        patch.in_combat = false
        break
      case 'p:death':
        patch.dead = true
        patch.in_combat = false
        break
      default:
        break
    }
    if (Object.keys(patch).length > 0) applyPatch(this.world, patch)
    if (this.emit) this.emit(hit, patch)
  }
}
