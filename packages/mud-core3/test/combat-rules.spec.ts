/**
 * combat/rules 测试 — T21.2 规则形态 + 人工种子 + 节流（W2，PLAN T21 3.2/3.3）：
 *   - 设置型（jiali）：只在「期望值 ≠ 上次已设值」时发，不依赖跨变；
 *   - 占拍型（回血/吃药/撤离）：条件由假转真才触发（跨变驱动，未跨档不发）；
 *   - 同拍只有一个动作：高优先级命中后，低优先级同拍被占拍抑制且不补发；
 *   - 撤离规则（D14）：缺退路不启用；有退路 = halt + move 两命令；
 *   - 绝招规则留位不启用（本角色等级不够）。
 */

import { describe, expect, it } from 'vitest'
import { CombatRuleEngine, SEED_RULES, COMBAT_COMMANDS } from '../src/combat/rules.ts'
import { computeTiers } from '../src/combat/state.ts'
import type { CombatVitals } from '../src/combat/state.ts'

/** A.8 实录拍（hpbrief L1+L2 拼合；内力全程 325/325 = 100%）。 */
const BEAT_99: CombatVitals = { 气血: 281, 最大气血: 283, 气血上限: 313, 内力: 325, 最大内力: 325 }
const BEAT_73: CombatVitals = { 气血: 187, 最大气血: 253, 气血上限: 313, 内力: 325, 最大内力: 325 }
const BEAT_DEATH: CombatVitals = { 气血: -1, 最大气血: 193, 气血上限: 313, 内力: 325, 最大内力: 325 }

describe('设置型（jiali：期望值 ≠ 上次已设值才发）', () => {
  it('内力比 100%（实录恒充沛）→ 首评发 jiali；此后同条件不重复', () => {
    const e = new CombatRuleEngine()
    const first = e.evaluate(computeTiers(BEAT_99))
    expect(first?.ruleId).toBe('jiali-on')
    expect(first?.kind).toBe('setup')
    expect(first?.commands).toEqual([COMBAT_COMMANDS.jialiOn])
    // 未跨档的后续拍：期望值 == 上次已设值 ⇒ 不发
    expect(e.evaluate(computeTiers(BEAT_99))).toBeNull()
    expect(e.evaluate(computeTiers(BEAT_73))).toBeNull()
  })

  it('内力比 <50% → jiali 0（回退）；回升 ≥100% → 再设 jiali', () => {
    const e = new CombatRuleEngine()
    e.evaluate(computeTiers(BEAT_99))
    const off = e.evaluate(computeTiers({ ...BEAT_99, 内力: 100, 最大内力: 325 })) // 30.8%
    expect(off?.ruleId).toBe('jiali-off')
    expect(off?.commands).toEqual([COMBAT_COMMANDS.jialiOff])
    const on = e.evaluate(computeTiers(BEAT_99))
    expect(on?.ruleId).toBe('jiali-on')
  })
})

describe('占拍型（跨变驱动：条件由假转真才触发）', () => {
  it('W2 主序列（A.8 回放）：73% 未跨档不发 → 73%→13% 跨变发回血；同拍容量 61% 命中吃药被占拍抑制', () => {
    const e = new CombatRuleEngine()
    e.evaluate(computeTiers(BEAT_99)) // jiali-on（首设）
    // 气血 73%：仍健康档，未跨变 ⇒ 无动作（吃药也不补发）
    expect(e.evaluate(computeTiers(BEAT_73))).toBeNull()
    // 死亡拍：气血 13%（健康→危险，回血条件转真）＋ 容量 61.7%（完整→受损，吃药条件转真）
    // 同拍两个占拍条件转真 ⇒ 只有高优先级回血占用动作槽，吃药被抑制
    const d = e.evaluate(computeTiers(BEAT_DEATH))
    expect(d?.ruleId).toBe('heal')
    expect(d?.kind).toBe('burst')
    expect(d?.commands).toEqual([COMBAT_COMMANDS.heal])
    // 后续拍同条件不再触发（不补发吃药，不重复回血）
    expect(e.evaluate(computeTiers(BEAT_DEATH))).toBeNull()
  })

  it('条件解除后再转真可再次触发（回血→回满→再掉血）', () => {
    const e = new CombatRuleEngine()
    e.evaluate(computeTiers(BEAT_99))                              // jiali-on 首设
    expect(e.evaluate(computeTiers(BEAT_DEATH))?.ruleId).toBe('heal')
    expect(e.evaluate(computeTiers(BEAT_99))).toBeNull()           // 条件解除（jiali 已设不回发）
    expect(e.evaluate(computeTiers(BEAT_DEATH))?.ruleId).toBe('heal') // 再转真 ⇒ 再触发
  })

  it('缺口数据（null 维）不误触发：只有气势时不发任何动作', () => {
    const e = new CombatRuleEngine()
    expect(e.evaluate(computeTiers({ 气势: 100 }))).toBeNull()
  })
})

describe('撤离规则（D14：退路前提）', () => {
  it('缺退路 ⇒ 不启用（危险档也不发 halt+move），其余规则照常', () => {
    const e = new CombatRuleEngine()
    const d = e.evaluate(computeTiers(BEAT_DEATH))
    expect(d?.ruleId).toBe('heal') // 跳过 flee，落到优先级 2
  })

  it('有退路 ⇒ flee 最高优先：halt + move 两命令；jiali 已设不重复', () => {
    const e = new CombatRuleEngine({ retreatMove: 'east' })
    e.evaluate(computeTiers(BEAT_99)) // jiali-on
    const d = e.evaluate(computeTiers(BEAT_DEATH))
    expect(d?.ruleId).toBe('flee')
    expect(d?.commands).toEqual([COMBAT_COMMANDS.halt, 'east'])
  })
})

describe('种子表形态与留位', () => {
  it('绝招规则留位不启用（等级不够）：气势满也不发 perform', () => {
    expect(SEED_RULES.find(r => r.id === 'perform')?.enabled).toBe(false)
    const e = new CombatRuleEngine()
    e.evaluate(computeTiers(BEAT_99))
    expect(e.evaluate(computeTiers({ ...BEAT_99, 气势: 100 }))).toBeNull()
  })

  it('危险规则集标记：flee/heal 属危险集（T21.5 危险通道直发用），其余不属', () => {
    const danger = SEED_RULES.filter(r => r.danger).map(r => r.id)
    expect(danger).toEqual(['flee', 'heal'])
  })

  it('reset：清空已设值与条件真值（重新首评 jiali）', () => {
    const e = new CombatRuleEngine()
    e.evaluate(computeTiers(BEAT_99))
    expect(e.evaluate(computeTiers(BEAT_99))).toBeNull()
    e.reset()
    expect(e.evaluate(computeTiers(BEAT_99))?.ruleId).toBe('jiali-on')
  })
})
