/**
 * mud-core3 combat/rules — 战斗规则引擎（T21.2）：条件（档位）→ 动作，纯计算零副作用。
 *
 * 规则形态（PLAN T21 D3/3.3）：
 *   - 条件 = 各维档位集合（state.ts 分档），维间 OR、维内任一档命中；
 *   - 动作分**设置型**（`jiali`：改后续每拍的缺省，需维持/撤销——只在「期望值 ≠
 *     上次已设值」时发）与**占拍型**（回血/吃药/撤离：占用本拍动作槽——条件
 *     **由假转真**才触发，同条件后续状态行不再触发，条件解除后可再触发）；
 *   - **同一拍只发一个动作**：按 priority 升序取首个可发规则，低优先级同拍被
 *     占拍抑制且**不补发**（W2）。
 *
 * 人工种子第一版（阈值 = PLAN 3.3：危险 25%/50% · 吃药 70% · 加力 100%/50%）。
 * 干预命令原文属 A.8.5〔推断〕待实录校准——测试只断言语义 id 与节流行为。
 *
 * 撤离规则（D14）：`halt` + move 需退路数据；构造未注入 `retreatMove` ⇒ 不启用。
 *
 * @module mud-core3/combat/rules
 */

import type { BufferTier, CapTier, CombatTiers, ForceTier, MomentumTier } from './state.ts'

/** 动作类型：setup = 设置型（不占拍语义，按已设值节流）；burst = 占拍型（一拍一槽）。 */
export type ActionKind = 'setup' | 'burst'

/** 干预命令缺省原文（A.8.5〔推断〕待实录校准；替换只动这张表）。 */
export const COMBAT_COMMANDS = {
  halt: 'halt',
  heal: 'yun heal',       // 运气回血〔推断〕
  medicine: 'fu yao',     // 吃药（恢复上限）〔推断〕
  jialiOn: 'jiali max',   // 加力〔推断〕：加力值 N 待实录
  jialiOff: 'jiali 0',
} as const

/** 规则 id（语义稳定面：日志 / 测试 / 危险通道引用）。 */
export type CombatRuleId = 'flee' | 'heal' | 'medicine' | 'jiali-on' | 'jiali-off' | 'perform'

/** 单条规则：条件（档位集合，维间 OR）→ 动作。 */
export interface CombatRule {
  readonly id: CombatRuleId
  /** 升序 = 优先级（同拍先到先得）。 */
  readonly priority: number
  readonly condition: Partial<{
    buffer: readonly BufferTier[]
    cap: readonly CapTier[]
    force: readonly ForceTier[]
    momentum: readonly MomentumTier[]
  }>
  readonly kind: ActionKind
  /** 占拍型 = 逐条直发的命令序列（如 halt+move 两拍）；设置型 = 单命令。 */
  readonly commands: readonly string[]
  /** 设置型底层设置槽（同一设置的开/退规则共用，如 jiali）；缺省 = 规则 id。 */
  readonly setting?: string
  /** 属危险规则集（PLAN 3.5：危险通道直发用；flee/heal）。 */
  readonly danger?: true
  /** 留位不启用（如绝招：等级不够）。 */
  readonly enabled?: boolean
}

/** 条件求值：任一维命中其档位集合即匹配（维间 OR，PLAN 3.3 规则 1「或」；null 维不命中）。 */
function matches(r: CombatRule, t: CombatTiers): boolean {
  const { buffer, cap, force, momentum } = r.condition
  if (buffer !== undefined && t.buffer !== null && buffer.includes(t.buffer)) return true
  if (cap !== undefined && t.cap !== null && cap.includes(t.cap)) return true
  if (force !== undefined && t.force !== null && force.includes(t.force)) return true
  if (momentum !== undefined && momentum.includes(t.momentum)) return true
  return false
}

/**
 * 人工种子规则表（第一版，PLAN 3.3；阈值替换只动这里）：
 *   1 flee   危险档（气血 <25% 或 容量 <50%）→ halt + move   占拍型 ×2（需退路）
 *   2 heal   气血比 <50%                    → 运气回血      占拍型
 *   3 medicine 容量比 <70%                  → 吃药          占拍型
 *   4 jiali-on  内力比 ≥100%                → jiali N       设置型
 *   5 jiali-off 内力比 <50%                 → jiali 0       设置型（回退）
 *   6 perform  气势满 ∧ 有绝招              → perform …     占拍型（留位不启用）
 */
export const SEED_RULES: readonly CombatRule[] = [
  {
    id: 'flee', priority: 1,
    condition: { buffer: ['危险', '濒危'], cap: ['需服药'] },
    kind: 'burst', commands: [], danger: true, enabled: false, // enabled 随 retreatMove 注入打开
  },
  {
    id: 'heal', priority: 2,
    condition: { buffer: ['五成', '危险', '濒危'] },
    kind: 'burst', commands: [COMBAT_COMMANDS.heal], danger: true,
  },
  {
    id: 'medicine', priority: 3,
    condition: { cap: ['受损', '需服药'] },
    kind: 'burst', commands: [COMBAT_COMMANDS.medicine],
  },
  {
    id: 'jiali-on', priority: 4,
    condition: { force: ['充沛'] },
    kind: 'setup', commands: [COMBAT_COMMANDS.jialiOn], setting: 'jiali',
  },
  {
    id: 'jiali-off', priority: 5,
    condition: { force: ['不足'] },
    kind: 'setup', commands: [COMBAT_COMMANDS.jialiOff], setting: 'jiali',
  },
  {
    id: 'perform', priority: 6,
    condition: { momentum: ['已满'] },
    kind: 'burst', commands: [], enabled: false, // 留位：等级不够，绝招未解锁
  },
]

/** 引擎选项。 */
export interface RuleEngineOptions {
  /** 退路 move 命令（如方向 `east`）；注入后启用 flee 规则（D14），缺省不启用。 */
  readonly retreatMove?: string
}

/** 一次派发结果（调用方逐条直发 commands；每拍至多一条）。 */
export interface CombatDispatch {
  readonly ruleId: CombatRuleId
  readonly kind: ActionKind
  readonly commands: readonly string[]
}

/**
 * 规则引擎：每次状态写入调用 evaluate()（同步纯计算）。
 *
 * 节流语义（PLAN 3.2）：
 *   - 占拍型：条件**由假转真**的那次求值才可触发（内部记条件真值集，等价于
 *     跨变驱动 D1——未跨档不发）；被更高优先级占拍抑制后**不补发**；
 *   - 设置型：条件命中即候选，但只在「期望值 ≠ 上次已设值」时发（可跨拍重试）。
 * 两者同槽竞争：priority 升序首个可发者赢，其余让位。
 */
export class CombatRuleEngine {
  private readonly rules: readonly CombatRule[]
  /** 上一求值的条件真值集（占拍型「由假转真」判据）。 */
  private prevMatched = new Set<CombatRuleId>()
  /** 设置型已设值（设置槽 → 上次发的命令；同一槽的开/退规则互见）。 */
  private lastSent = new Map<string, string>()

  constructor(opts: RuleEngineOptions = {}) {
    const withFlee = opts.retreatMove !== undefined
      ? SEED_RULES.map(r => (r.id === 'flee'
          ? { ...r, enabled: true, commands: [COMBAT_COMMANDS.halt, opts.retreatMove!] }
          : r))
      : SEED_RULES
    this.rules = withFlee
  }

  /** 撤离规则是否启用（退路数据已注入；D14 观测面——未注入时控制器告警一条）。 */
  get fleeEnabled(): boolean {
    return this.rules.some(r => r.id === 'flee' && r.enabled !== false)
  }

  /**
   * 求值一次（= 一条状态写入 / 一拍）：返回本拍应发动作，无则 null。
   * 条件求值为同步纯计算；每拍至多派发一条（同一拍只发一个动作）。
   */
  evaluate(t: CombatTiers): CombatDispatch | null {
    const matched = this.rules.filter(r => r.enabled !== false && matches(r, t))
    const newly = new Set(matched.map(r => r.id).filter(id => !this.prevMatched.has(id)))
    this.prevMatched = new Set(matched.map(r => r.id))
    for (const r of matched) {
      if (r.kind === 'burst' && !newly.has(r.id)) continue // 占拍型：非转真拍让位
      const cmd = r.commands[0] ?? ''
      const slot = r.setting ?? r.id
      if (r.kind === 'setup' && this.lastSent.get(slot) === cmd) continue // 已设值
      if (r.kind === 'setup') this.lastSent.set(slot, cmd)
      return { ruleId: r.id, kind: r.kind, commands: r.commands }
    }
    return null
  }

  /** 脱战/断线复位：清条件真值与已设值（新遭遇重新首评）。 */
  reset(): void {
    this.prevMatched.clear()
    this.lastSent.clear()
  }

  /**
   * 危险直发求值（PLAN 3.5/D5，T21.4 pending 保命 / T21.5 危险通道共用）：
   * **绕过节流**——danger:true 且启用的规则中按优先级取首个命中者，不记
   * prevMatched/lastSent（保命优先于节流语义；调用方自行决定重发刻度）。
   */
  evaluateDanger(t: CombatTiers): CombatDispatch | null {
    for (const r of this.rules) {
      if (r.danger !== true || r.enabled === false) continue
      if (!matches(r, t)) continue
      return { ruleId: r.id, kind: r.kind, commands: r.commands }
    }
    return null
  }
}
