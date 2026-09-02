/**
 * dsh-mud-core — 触发服务 (Triggers), host half. (`ctx.mud.trigger`)
 *
 * 底层触发服务: 接收感知协调器产出的标准行 (MudLine), 确定性匹配 (字面量/
 * 正则/颜色/Mudlet 对齐), 命中后**包装为 MudEvent 发布到事件总线**, 供
 * 状态捕获 (state) / 规则引擎 (rules) / 流程引擎 (flow) / agent 路由消费。
 *
 * 注册模型:
 *   - 启动时静态注册 (内置登录/战斗/房间触发, 见 config/trigger-rules.ts);
 *   - 运行中动态 register / unregister / unregisterByOwner (技能/插件可
 *     动态增删触发), 且不依赖感知层实现 — 感知只做协调与文本标准化。
 *
 * 本模块把原 perception.ts 的 Perceptor (匹配器) 迁出, perception.ts 只保留
 * 行缓冲与文本标准化 (协调器)。
 * @module @deepseek-ai/dsh-mud-core/triggers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MudLine, StyleRun } from './ansi.ts'
import { StyleFlag } from './ansi.ts'
import { makePerceptEvent, type MudPerceptEvent } from './events.ts'

/** 颜色触发条件 (Mudlet 颜色触发对齐): 与 style run 逐段匹配。 */
export interface ColorCond {
  /** 前景 256 色索引; 指定 null 表示"匹配默认前景" (Mudlet scmDefault)。 */
  fg?: number | null
  /** 背景 256 色索引; 指定 null 表示"匹配默认背景" (Mudlet scmDefault)。 */
  bg?: number | null
  /** 真彩前景 (优先级高于 fg)。 */
  fgTrue?: [number, number, number] | null
  /** 真彩背景 (优先级高于 bg)。 */
  bgTrue?: [number, number, number] | null
}

/**
 * 多行触发条件 (Mudlet 对齐): 逐条件顺序状态机, 每个条件匹配**单一行**,
 * 而非把多行拼成一段文本做正则 (Mudlet 的多行是逐条件状态机, 见
 * TTrigger::updateMultistates / TMatchState)。
 */
export type MultiCond =
  | { kind: 'substring'; text: string }
  | { kind: 'regex'; regex: string | RegExp }
  /** 行间间隔: 距上一条件需隔 lines 行 (Mudlet REGEX_LINE_SPACER / lineSpacer)。 */
  | { kind: 'spacer'; lines: number }

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

/** 感知规则命中结果。 */
export interface PerceptHit {
  id: string
  eventType: string
  lineNumber: number
  data: Record<string, unknown> | null
  reason?: string
}

/** 感知规则 (配置来源, config/trigger-rules.ts)。 */
export interface PerceptionRule {
  id: string
  eventType?: string
  priority?: number
  multiline?: boolean
  greedy?: boolean
  contains?: readonly string[]
  regex?: readonly (string | RegExp)[]
  /** 多行: 有序条件列表 (Mudlet 逐条件状态机对齐)。省略时由 contains+regex 派生。
   *  仅 multiline=true 时起作用。 */
  patterns?: readonly MultiCond[]
  /** 多行: 首条件到末条件之间允许的最大间隔行数 (Mudlet mConditionLineDelta)。
   *  默认 MULTI_LINE_DELTA。 */
  lineDelta?: number
  /** 颜色触发: 指定后要求行内任一段 run 命中全部已指定通道。与 contains/regex 为 AND。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: { rows: MudLine[] }) => boolean
  extract?: (record: { rows: MudLine[] }) => Record<string, unknown> | null
}

/** 多行首条件到末条件默认最大间隔行数。 */
export const MULTI_LINE_DELTA = 100

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
    return {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      data: rule.extract ? rule.extract(record) : null,
    }
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
    return {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      reason: 'multiline',
      data: rule.extract ? rule.extract({ rows }) : null,
    }
  }
}

/** 触发服务构造参数。 */
export interface TriggerServiceOptions {
  /** 事件总线 (cordis ctx)。 */
  bus: Pick<Context, 'events'>
  /** 事件发布开关 (0 = 仅匹配不发总线, 供内部/测试)。 */
  publish?: boolean
}

/**
 * 触发服务 (`ctx.mud.trigger`): 包一层 Perceptor, 命中 → MudEvent → 总线。
 * perception 协调器直接调用 feed() 喂行, 不感知匹配细节。
 */
export class TriggerService {
  private readonly perceptor = new Perceptor()
  private readonly bus: Pick<Context, 'events'>
  private readonly publishEnabled: boolean

  constructor({ bus, publish = true }: TriggerServiceOptions) {
    this.bus = bus
    this.publishEnabled = publish
  }

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

  /** 纯匹配: 返回命中 (不做去重/发布; 由协调器先过滤再 publish)。 */
  match(lines: readonly MudLine[]): PerceptHit[] {
    return this.perceptor.match(lines as MudLine[])
  }

  /**
   * 发布一个命中到事件总线 (包装为 MudEvent)。
   * 发布开关关闭 (publish=false) 时仅构造事件不广播 (内部/测试用)。
   * @returns 构造出的感知事件。
   */
  publish(hit: PerceptHit): MudPerceptEvent {
    const e = makePerceptEvent(hit.eventType, hit.data, hit.lineNumber)
    if (this.publishEnabled) this.bus.events.emit('mud/percept', e)
    return e
  }

  /** 现有触发规则快照 (调试/状态展示)。 */
  getRules(): { id: string; eventType: string }[] {
    return this.perceptor.getRules().map(r => ({ id: r.id, eventType: r.eventType }))
  }
}