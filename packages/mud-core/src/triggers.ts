/**
 * dsh-mud-core — 触发服务 (Triggers), host half. (`ctx.mud.trigger`)
 *
 * 底层触发服务: 接收感知协调器产出的标准行 (MudLine), 确定性匹配 (字面量/
 * 正则/颜色/Mudlet 对齐), 命中后**包装为 MudEvent 发布到事件总线**, 供
 * 状态捕获 (state) / 规则引擎 (rules) / 流程引擎 (flow) / agent 路由消费。
 *
 * 注册模型:
 *   - 启动时静态注册 (内置登录/战斗/房间触发, 见 config/rules.ts);
 *   - 运行中动态 register / unregister / unregisterByOwner (技能/插件可
 *     动态增删触发), 且不依赖感知层实现 — 感知只做协调与文本标准化。
 *
 * 本模块把原 perception.ts 的 Perceptor (匹配器) 迁出, perception.ts 只保留
 * 行缓冲与文本标准化 (协调器)。
 * @module @deepseek-ai/dsh-mud-core/triggers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MudLine, StyleRun } from './ansi.ts'
import { makePerceptEvent, type MudPerceptEvent } from './events.ts'

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

/** 归一化触发规则。 */
interface NormalizedTriggerRule {
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

  private matchMultiline(rule: NormalizedTriggerRule, lines: MudLine[]): PerceptHit | null {
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