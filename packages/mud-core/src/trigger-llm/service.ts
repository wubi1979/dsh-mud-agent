/**
 * dsh-mud-core — 触发服务 (TriggerService) + 匹配器 (Perceptor), host half.
 *
 * v6 单路径下触发服务的职责收窄为纯匹配:
 *   - Perceptor: 确定性规则匹配器 (字面量/正则/颜色/多行状态机), 语义与
 *     Mudlet / Python Matcher 对齐 (自原 perception/triggers.ts 迁入, 无变化);
 *   - TriggerService (`ctx.mud.trigger`): 包一层 Perceptor, 注册管理 +
 *     matchText (整批 agent 文本入口: 拆临时行 → 只匹配未消费的新行)。
 *
 * 事件总线 (mud/percept) 与 publish 已随事件机制移除; 文本语义统一走
 * agent (级联 provider T1 在此匹配, 命中动作渲染进 agent 响应)。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/service
 */

import type { MudLine, StyleRun } from '../preprocess/ansi.ts'
import { StyleFlag, isPromptText } from '../preprocess/ansi.ts'
import type { ColorCond, MultiCond, PerceptionRule, PerceptHit, ActionSpec } from './types.ts'
import { MULTI_LINE_DELTA } from './types.ts'

function rgbEq(a: [number, number, number] | null | undefined,
  b: [number, number, number] | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined
    && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** 任一段 run 命中全部已指定通道即算命中 (行对象携带 style run 列表)。
 *  对齐 Mudlet: bold 与非默认前景耦合 → 暗色索引 (0-7) 在 bold 时按亮色 (8-15)
 *  变体等价 (TBuffer.cpp:1378), 故 cond.fg 命中 run.fg 或 bold 的亮色变体均算。 */
export function styleMatchesColor(rows: readonly { style: readonly StyleRun[] }[], cond: ColorCond): boolean {
  if (rows.length === 0) return false
  return rows.some(row => row.style.some(r => {
    const fg = r.fg
    const fgEff = fg !== null && (r.flags & StyleFlag.Bold) !== 0 && fg < 8 ? fg + 8 : fg
    const bg = r.bg
    const bgEff = bg !== null && (r.flags & StyleFlag.Bold) !== 0 && bg < 8 ? bg + 8 : bg
    return (cond.fg === undefined || fgEff === cond.fg)
      && (cond.bg === undefined || bgEff === cond.bg)
      && (cond.fgTrue === undefined || rgbEq(r.fgTrue, cond.fgTrue))
      && (cond.bgTrue === undefined || rgbEq(r.bgTrue, cond.bgTrue))
  }))
}

/** 归一化触发规则。 */
interface NormalizedTriggerRule {
  id: string
  eventType: string
  priority: number
  multiline: boolean
  greedy: boolean
  contains: string[]
  regex: RegExp[]
  /** 多行: 有序条件 (multiline=true 时使用)。派生自 patterns 或 contains+regex。 */
  multiConds: MultiCond[]
  /** 多行: 首末条件最大间隔行数。 */
  lineDelta: number
  /** 多行运行态: 活跃的跨行状态机 (逐行 feed, 跨 match 调用保持)。 */
  multiStates: MultiMatchState[]
  /** 多行运行态: 已喂入状态机的最大行号 (窗口重复回传时防重复推进)。 */
  multiLastAbs: number
  color: ColorCond | null
  guard: ((record: { rows: MudLine[] }) => boolean) | null
  extract: ((record: { rows: MudLine[] }) => Record<string, unknown> | null) | null
  /** 命中动作 (v6: 规则携带; 装配方据此渲染)。 */
  action: ActionSpec | null
}

/** 多行匹配状态机的一个活跃实例 (Mudlet TMatchState 对齐)。 */
interface MultiMatchState {
  /** 下一个待匹配条件下标 (首条件已在创建时消费)。 */
  next: number
  /** 自状态创建以来的行数 (超 lineDelta 即过期)。 */
  lineCount: number
  /** 当前处于 spacer 条件时已等待的行数。 */
  spacerCount: number
  /** 各条件命中的捕获 (按条件顺序)。 */
  captures: { text: string; abs: number; row: MudLine }[]
}

/** 构造去 g 标志的正则 (防 lastIndex 跨行错位; Mudlet 无全局串联语义)。 */
function makeRegex(source: string, multiline: boolean): RegExp {
  return new RegExp(source, multiline ? 'm' : '')
}

function stripG(re: RegExp): RegExp {
  if (!re.global && !re.sticky) return re
  const flags = re.flags.replace(/[gy]/g, '')
  return new RegExp(re.source, flags)
}

/** 推导多行有序条件 (patterns 优先, 否则 contains 在前 + regex 在后)。 */
function buildMultiConds(rule: PerceptionRule, multiline: boolean): MultiCond[] {
  if (rule.patterns && rule.patterns.length > 0) {
    return rule.patterns.map(p => {
      if (p.kind === 'spacer') return { kind: 'spacer', lines: Math.max(1, p.lines || 1) } satisfies MultiCond
      if (p.kind === 'regex') {
        const re = typeof p.regex === 'string' ? makeRegex(p.regex, multiline) : stripG(p.regex)
        return { kind: 'regex', regex: re } satisfies MultiCond
      }
      return { kind: 'substring', text: String(p.text ?? '') } satisfies MultiCond
    })
  }
  const out: MultiCond[] = []
  for (const lit of rule.contains ?? []) out.push({ kind: 'substring', text: String(lit) })
  for (const r of rule.regex ?? []) {
    const re = typeof r === 'string' ? makeRegex(r, multiline) : stripG(r)
    out.push({ kind: 'regex', regex: re })
  }
  return out
}

/**
 * 触发器匹配器 (Perceptor): 确定性规则匹配器, 对齐 Python Matcher。
 * match(lines) 一次跑完窗口内全部规则, 返回按行号排序的结果。
 */
export class Perceptor {
  private rules: NormalizedTriggerRule[] = []
  private readonly keywordIndex = new Map<string, string[]>() // 字面量首字符 → rule id 列表
  private readonly owners = new Map<string, string>() // rule id → owner

  register(rule: PerceptionRule, owner = ''): NormalizedTriggerRule {
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
    const norm: NormalizedTriggerRule = {
      id: rule.id,
      eventType: rule.eventType || rule.id,
      priority: rule.priority ?? 10,
      multiline,
      greedy: !!rule.greedy,
      contains: (rule.contains ?? []).map(String),
      regex: (rule.regex ?? []).map(r =>
        typeof r === 'string' ? makeRegex(r, multiline) : stripG(r),
      ),
      multiConds: buildMultiConds(rule, multiline),
      lineDelta: rule.lineDelta ?? MULTI_LINE_DELTA,
      multiStates: [],
      multiLastAbs: -1,
      color,
      guard: rule.guard ?? null,
      extract: rule.extract ?? null,
      action: rule.action ?? null,
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

  /** 窗口匹配: 返回 [{ id, eventType, lineNumber, data }] 按 lineNumber 排序。
   *  非多行逐行匹配 (快路径); 多行走逐行状态机 (跨调用保持, 见 feedMultiline)。 */
  match(lines: MudLine[]): PerceptHit[] {
    if (!lines || lines.length === 0) return []
    const results: PerceptHit[] = []
    const candidates = this.candidates(lines)
    for (const rule of this.rules) {
      if (rule.multiline) {
        // 多行: 每个新到行逐行喂状态机 (Mudlet 逐条件模型)。不走候选快路径 —
        // 首条件可能是正则/间隔, 且状态必须看到每一行 (计行/过期)。
        for (const line of lines) {
          const r = this.feedMultiline(rule, line)
          if (r) results.push(r)
        }
      } else {
        if (rule.contains.length > 0 && !candidates.has(rule.id)) continue
        for (const line of lines) {
          const r = this.matchLine(rule, line)
          if (r) results.push(r)
        }
      }
    }
    results.sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0))
    return results
  }

  /** 已注册规则快照 (按优先级序; 调试/状态展示)。 */
  getRules(): NormalizedTriggerRule[] {
    return this.rules.slice()
  }

  private ruleHit(rule: NormalizedTriggerRule, record: { rows: MudLine[] }): boolean {
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
        re.lastIndex = 0
        if (re.test(text)) return true
      }
    }
    // 无文本模式: 纯颜色条件本身就是模式 (颜色触发); 否则退化为 extract 触发。
    if (!hasPattern) return rule.color !== null || !!rule.extract
    return false
  }

  private matchLine(rule: NormalizedTriggerRule, line: MudLine): PerceptHit | null {
    const record = { rows: [line] }
    if (!this.ruleHit(rule, record)) return null
    const hit: PerceptHit = {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      data: rule.extract ? rule.extract(record) : null,
    }
    if (rule.action) hit.action = rule.action
    return hit
  }

  /** 单条件与一行文本的匹配 (正则测试会复位 lastIndex)。 */
  private condMatch(cond: MultiCond, line: MudLine): boolean {
    if (cond.kind === 'substring') return line.text.includes(cond.text)
    if (cond.kind === 'regex') {
      const re = typeof cond.regex === 'string' ? makeRegex(cond.regex, false) : cond.regex
      re.lastIndex = 0
      return re.test(line.text)
    }
    return false // spacer 由 stepMulti 计行, 不在此匹配
  }

  /**
   * 用一行推进状态机的期望条件 (Mudlet TMatchState / updateMultistates 对齐):
   * 每个状态每行最多推进一个条件位置 — 遇 spacer 计行, 遇 pattern 命中则消费该
   * 条件并记录捕获。返回是否已满足全部条件。
   */
  private stepMulti(rule: NormalizedTriggerRule, st: MultiMatchState, line: MudLine): boolean {
    if (st.next >= rule.multiConds.length) return true
    const cond = rule.multiConds[st.next]
    if (cond === undefined) return true
    if (cond.kind === 'spacer') {
      st.spacerCount += 1
      if (st.spacerCount >= cond.lines) {
        st.spacerCount = 0
        st.next += 1
      }
    } else if (this.condMatch(cond, line)) {
      st.next += 1
      st.captures.push({ text: line.text, abs: line.abs, row: line })
    }
    return st.next >= rule.multiConds.length
  }

  /**
   * 多行状态机: 每个"新到行"驱动规则的所有活跃状态, 并可播种新状态。
   * 用 multiLastAbs 保证每行只喂一次 (窗口会重复回传历史行)。
   * 全部条件满足 → 返回命中; 否则 null。
   */
  private feedMultiline(rule: NormalizedTriggerRule, line: MudLine): PerceptHit | null {
    if (line.abs <= rule.multiLastAbs) return null
    rule.multiLastAbs = line.abs
    const conds = rule.multiConds
    if (conds.length === 0) return null
    const completed: MultiMatchState[] = []
    const kept: MultiMatchState[] = []
    const step = (st: MultiMatchState): void => {
      st.lineCount += 1
      if (this.stepMulti(rule, st, line)) completed.push(st)
      else if (st.lineCount <= rule.lineDelta) kept.push(st)
    }
    for (const st of rule.multiStates) step(st)
    const first = conds[0]
    if (first !== undefined && first.kind !== 'spacer' && this.condMatch(first, line)) {
      const seed: MultiMatchState = {
        next: 1,
        lineCount: 0,
        spacerCount: 0,
        captures: [{ text: line.text, abs: line.abs, row: line }],
      }
      if (seed.next >= conds.length) completed.push(seed)
      else kept.push(seed)
    }
    rule.multiStates = kept
    if (completed.length === 0) return null
    // 取最后完成的状态 (最晚触发的有效序列) 构造命中。
    const st = completed[completed.length - 1]
    if (st === undefined) return null
    const rows = st.captures.map(c => c.row)
    if (rule.color !== null && !styleMatchesColor(rows, rule.color)) return null
    if (rule.guard && !rule.guard({ rows })) return null
    const hit: PerceptHit = {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      reason: 'multiline',
      data: rule.extract ? rule.extract({ rows }) : null,
    }
    if (rule.action) hit.action = rule.action
    return hit
  }
}

/**
 * 触发服务 (`ctx.mud.trigger`): 包一层 Perceptor。注册管理 + 纯匹配。
 * 无事件总线: 命中由装配方 (agent-bridge 级联 provider) 直接消费。
 */
export class TriggerService {
  private readonly perceptor = new Perceptor()
  /** 临时行单调 abs 分配器 (matchText 文本入口专用; 行号从 0 递增)。 */
  private textLineCounter = 0

  /** 注册一个触发规则; owner 用于批量注销。 */
  register(rule: PerceptionRule, owner = ''): void {
    this.perceptor.register(rule, owner)
  }

  /** 注销一个触发规则。 */
  unregister(ruleId: string): void {
    this.perceptor.unregister(ruleId)
  }

  /** 按 owner 批量注销 (返回注销条数)。 */
  unregisterByOwner(owner: string): number {
    return this.perceptor.unregisterByOwner(owner)
  }

  /** 当前注册的触发规则数。 */
  get size(): number {
    return this.perceptor.getRules().length
  }

  /** 现有触发规则快照 (调试/状态展示)。 */
  getRules(): { id: string; eventType: string }[] {
    return this.perceptor.getRules().map(r => ({ id: r.id, eventType: r.eventType }))
  }

  /**
   * 整批文本入口 (级联 provider T1 使用): 拆临时行 (单调 abs, 无样式) →
   * 匹配全部行 → 返回按行号排序的命中。
   *
   * 同一批文本重复调用会重复命中 — 去重由 adapter 层 (内容级) 负责,
   * TriggerService 本身是无状态纯匹配器。
   *
   * 注意: 临时行不含 style, 颜色触发条件 (fg/bg/fgTrue/bgTrue) 在纯文本
   * 输入下不满足, 颜色规则不会误命中。
   */
  matchText(text: string): PerceptHit[] {
    const cleaned = String(text ?? '')
    if (cleaned === '') return []
    const parts = cleaned.split(/\r?\n/)
    const rows: MudLine[] = parts.map((t, i) => ({
      text: t,
      raw: t,
      style: [],
      abs: this.textLineCounter + i,
      time: Date.now(),
      isPrompt: isPromptText(t),
    }))
    this.textLineCounter += parts.length
    return this.perceptor.match(rows)
  }

  /** 重置文本入口游标 (主要用于测试隔离)。 */
  resetTextCursor(): void {
    this.textLineCounter = 0
  }
}