/**
 * dsh-mud-core — 决策层 (Decision), host half.
 *
 * 只保留**轻量处理器** (确定性规则引擎)。重型处理器 (LLM 决策) 由 DSH
 * agent 承担 — 不自造 LLM 决策引擎, 不解析 LLM 结构化意图。
 *
 * 决策路由:
 *   事件 → RuleEngine.match (when 条件匹配扁平 WorldModel)
 *     → 命中 → 宿主执行规则动作 (工具调用)
 *     → 未命中 / action:{action:"llm"} → 交给 DSH agent
 *
 * 规则形态:
 *   { id, priority, match: { event?, when? }, action: { action:"tool"|"llm",
 *     tool?, cmd? }, after? }
 *   cmd 支持 {name}/{pass} 模板 (登录, 宿主从 config.account 渲染)。
 * @module @deepseek-ai/dsh-mud-core/decision
 */

/** 规则动作: 工具调用 (确定性短路) 或声明式交给 agent。 */
export type RuleAction =
  | { action: 'tool'; tool: string; cmd?: string }
  | { action: 'llm' }
  | { action: 'no_action' }

/** 一条决策规则 (配置来源, config/rules-decision.ts)。 */
export interface DecisionRule {
  id: string
  priority?: number
  match?: { event?: string; when?: Record<string, unknown> }
  /** 顶层 when 优先, 兼容 match.when。 */
  when?: Record<string, unknown> | null
  action?: RuleAction
  /** 命中副作用: 写入 WorldModel 的字段 (防重复等)。 */
  after?: Record<string, unknown> | null
  /** 规则归属的流程能力 (agent 的 skill 知识)。 */
  skill?: string | null
  description?: string
}

/** 归一化后的内部规则。 */
interface NormalizedRule extends Required<Pick<DecisionRule, 'id' | 'priority' | 'match' | 'after' | 'skill' | 'description'>> {
  when: Record<string, unknown> | null
  action: RuleAction
}

interface MatchInput {
  eventType?: string | null
  state?: Record<string, unknown> | null
}

/** 决策规则引擎 (轻量处理器)。 */
export class RuleEngine {
  private readonly rules: NormalizedRule[] = []
  private readonly stateProvider: (() => Record<string, unknown>) | null

  constructor({ stateProvider = null }: { stateProvider?: (() => Record<string, unknown>) | null } = {}) {
    this.stateProvider = stateProvider
  }

  register(rule: DecisionRule): NormalizedRule {
    const norm: NormalizedRule = {
      id: rule.id,
      priority: rule.priority ?? 10,
      match: rule.match ?? {},
      when: rule.when ?? rule.match?.when ?? null,
      action: rule.action ?? { action: 'no_action' },
      after: rule.after ?? null,
      skill: rule.skill ?? null,
      description: rule.description ?? '',
    }
    let i = 0
    while (i < this.rules.length && (this.rules[i]?.priority ?? 0) >= norm.priority) i += 1
    this.rules.splice(i, 0, norm)
    return norm
  }

  /**
   * 匹配: 返回命中规则或 null。
   * match.event 可带 * 通配 (如 "p:combat:*" 匹配 p:combat:start/end);
   * when 条件 (顶层或 match.when) 对扁平 WorldModel 求值。
   * @param input 事件类型与状态。
   * @returns 命中规则, 无命中返回 null。
   */

  match({ eventType = null, state = null }: MatchInput = {}): NormalizedRule | null {
    const st = state ?? (this.stateProvider ? this.stateProvider() : {})
    for (const rule of this.rules) {
      const m = rule.match ?? {}
      if (m.event) {
        const want = m.event
        const hit = want === eventType
          || (want.endsWith('*') && eventType !== null && eventType.startsWith(want.slice(0, -1)))
        if (!hit) continue
      } else if (eventType !== null) {
        continue // 规则未声明 event → 空闲/状态驱动, 事件驱动不命中
      }
      if (rule.when && !matchWhen(rule.when, st)) continue
      return rule
    }
    return null
  }

  getRules(): NormalizedRule[] {
    return this.rules.slice()
  }

  eventPatterns(): string[] {
    const out = new Set<string>()
    for (const rule of this.rules) {
      if (rule.match?.event) out.add(rule.match.event)
    }
    return [...out]
  }
}

/** when 条件操作符对象。 */
export type WhenOperator = Partial<{
  eq: unknown
  ne: unknown
  gt: number
  gte: number
  lt: number
  lte: number
  in: readonly unknown[]
  truthy: boolean
  falsy: boolean
}>

/**
 * when 条件求值: { "flags.logged_in": false, "char.hp": {gt: 50} } 等。
 * @param when 条件表。
 * @param state 扁平世界状态。
 * @returns 全部条件满足。
 */
export function matchWhen(when: Record<string, unknown>, state: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(when)) {
    const got = state[key]
    if (typeof want === 'object' && want !== null && !Array.isArray(want)) {
      for (const [op, target] of Object.entries(want as WhenOperator)) {
        if (op === 'eq' && got !== target) return false
        if (op === 'ne' && got === target) return false
        if (op === 'gt' && !(got !== undefined && got !== null && (got as number) > (target as number))) return false
        if (op === 'gte' && !(got !== undefined && got !== null && (got as number) >= (target as number))) return false
        if (op === 'lt' && !(got !== undefined && got !== null && (got as number) < (target as number))) return false
        if (op === 'lte' && !(got !== undefined && got !== null && (got as number) <= (target as number))) return false
        if (op === 'in' && !(Array.isArray(target) && target.includes(got))) return false
        if (op === 'truthy' && !got) return false
        if (op === 'falsy' && got) return false
      }
    } else if (got !== want) {
      return false
    }
  }
  return true
}

/** 扁平 WorldModel → 紧凑摘要 (TUI 状态显示 / 调试)。 */
export function summarizeState(flat: Record<string, unknown> | null | undefined): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(flat ?? {})) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    parts.push(Array.isArray(v) ? `${k}=[${v.join(',')}]` : `${k}=${String(v)}`)
  }
  return parts.join('; ') || '(空)'
}
