/**
 * combat/state 测试 — T21.1 纯层：比值 / 分档 / 上一档快照 / 边沿检测（PLAN 第 3.2 节）。
 *
 * 判据与数值出处 = 附录 A.8（2026-10-06 战斗实录）：
 *   - 气血三元组 313/283/281（→ 99%/90%）、死亡拍 313/193/-1（→ 13%/61%）
 *   - 内力 325/325（= 100%）；分档阈值 = PLAN 3.3 种子规则边界（50%/25%/70%/50%/100%）
 *   - 伤情描述语不作阈值依据（A.8.4 用户裁定）——本模块只吃 hpbrief 数值
 */

import { describe, expect, it } from 'vitest'
import { bufferRatio, capRatio, forceRatio, computeTiers, CombatEdgeDetector } from '../src/combat/state.ts'
import type { CombatVitals } from '../src/combat/state.ts'

/** A.8 实录两拍（hpbrief L1+L2 拼合）。 */
const BEAT_99: CombatVitals = { 气血: 281, 最大气血: 283, 气血上限: 313, 内力: 325, 最大内力: 325 }
const BEAT_DEATH: CombatVitals = { 气血: -1, 最大气血: 193, 气血上限: 313, 内力: 325, 最大内力: 325 }

describe('比值（D2：百分比由模块算，不进 World）', () => {
  it('实录值对上：气血比 281/283、容量比 283/313、内力比 325/325 = 1', () => {
    expect(bufferRatio(BEAT_99)).toBeCloseTo(281 / 283, 12)
    expect(capRatio(BEAT_99)).toBeCloseTo(283 / 313, 12)
    expect(forceRatio(BEAT_99)).toBe(1)
  })

  it('内力比可达 200%（A.7 结论 4：648/324）', () => {
    expect(forceRatio({ 内力: 648, 最大内力: 324 })).toBeCloseTo(2, 12)
  })

  it('分母缺失或 0 → null（不猜）', () => {
    expect(bufferRatio({ 气血: 100 })).toBeNull()
    expect(bufferRatio({ 气血: 100, 最大气血: 0 })).toBeNull()
    expect(capRatio({ 最大气血: 283 })).toBeNull()
    expect(forceRatio({ 内力: 325, 最大内力: 0 })).toBeNull()
  })
})

describe('分档（PLAN 3.2：种子阈值 = 规则边界）', () => {
  it('气血比（缓冲档）：健康 ≥50% / 五成 ≥25% / 危险 >0 / 濒危 ≤0（-1 不是死亡，A.8.4）', () => {
    expect(computeTiers({ 气血: 281, 最大气血: 283 }).buffer).toBe('健康')   // 99%
    expect(computeTiers({ 气血: 157, 最大气血: 313 }).buffer).toBe('健康')   // 50.2%
    expect(computeTiers({ 气血: 156, 最大气血: 313 }).buffer).toBe('五成')   // 49.8%
    expect(computeTiers({ 气血: 79, 最大气血: 313 }).buffer).toBe('五成')    // 25.2%
    expect(computeTiers({ 气血: 78, 最大气血: 313 }).buffer).toBe('危险')    // 24.9%
    expect(computeTiers({ 气血: 31, 最大气血: 313 }).buffer).toBe('危险')    // 9.9%
    expect(computeTiers(BEAT_DEATH).buffer).toBe('濒危')                     // -1/193
  })

  it('容量比：完整 ≥70% / 受损 ≥50% / 需服药 <50%（死亡拍 193/313=61.7% → 受损）', () => {
    expect(computeTiers({ 最大气血: 313, 气血上限: 313 }).cap).toBe('完整')  // 100%
    expect(computeTiers({ 最大气血: 220, 气血上限: 313 }).cap).toBe('完整')  // 70.3%
    expect(computeTiers({ 最大气血: 219, 气血上限: 313 }).cap).toBe('受损')  // 69.9%
    expect(computeTiers(BEAT_DEATH).cap).toBe('受损')                        // 61.7%
    expect(computeTiers({ 最大气血: 157, 气血上限: 313 }).cap).toBe('受损')  // 50.2%
    expect(computeTiers({ 最大气血: 156, 气血上限: 313 }).cap).toBe('需服药')// 49.8%
  })

  it('内力比：充沛 ≥100% / 够用 ≥50% / 不足 <50%（A.8：全程 325/325 恒充沛）', () => {
    expect(computeTiers({ 内力: 325, 最大内力: 325 }).force).toBe('充沛')
    expect(computeTiers({ 内力: 648, 最大内力: 324 }).force).toBe('充沛')    // 200%
    expect(computeTiers({ 内力: 162, 最大内力: 324 }).force).toBe('够用')    // 恰 50%
    expect(computeTiers({ 内力: 161, 最大内力: 324 }).force).toBe('不足')    // 49.7%
  })

  it('气势：≥100 已满；缺行（未累积）→ 未满', () => {
    expect(computeTiers({ 气势: 4 }).momentum).toBe('未满')
    expect(computeTiers({ 气势: 99 }).momentum).toBe('未满')
    expect(computeTiers({ 气势: 100 }).momentum).toBe('已满')
    expect(computeTiers({}).momentum).toBe('未满')
  })

  it('缺数据 → 该维 null（不猜）；气势恒有缺省', () => {
    const t = computeTiers({ 气血: 100 })
    expect(t.buffer).toBeNull()
    expect(t.cap).toBeNull()
    expect(t.force).toBeNull()
    expect(t.momentum).toBe('未满')
  })
})

describe('边沿检测（D1：跨变才匹配；基线 = 常态档）', () => {
  it('健康拍（实录 99%）与基线同档 ⇒ 零边沿', () => {
    const d = new CombatEdgeDetector()
    expect(d.update(computeTiers(BEAT_99))).toEqual([])
  })

  it('实录跨变：气血比 73% → 13% 一次跨两档 ⇒ 单条边沿 健康→危险（W2 前半）', () => {
    const d = new CombatEdgeDetector()
    d.update(computeTiers({ 气血: 229, 最大气血: 313, 气血上限: 313 })) // 73% → 健康
    const edges = d.update(computeTiers({ 气血: 41, 最大气血: 313, 气血上限: 313 })) // 13%
    expect(edges).toEqual([{ key: 'buffer', from: '健康', to: '危险' }])
  })

  it('首拍即危险（基线常态档）⇒ 也产出边沿（危险抢占不漏首击重伤）', () => {
    const d = new CombatEdgeDetector()
    const edges = d.update(computeTiers(BEAT_DEATH))
    expect(edges).toContainEqual({ key: 'buffer', from: '健康', to: '濒危' })
    expect(edges).toContainEqual({ key: 'cap', from: '完整', to: '受损' })
  })

  it('未跨档不发（W1）：同档多次 update 零边沿；多键同时跨变 ⇒ 多条边沿', () => {
    const d = new CombatEdgeDetector()
    d.update(computeTiers(BEAT_99))
    expect(d.update(computeTiers({ ...BEAT_99, 气血: 270 }))).toEqual([]) // 95%，仍健康
    const edges = d.update(computeTiers({ 气血: 20, 最大气血: 200, 气血上限: 313, 内力: 100, 最大内力: 325 }))
    expect(edges).toEqual([
      { key: 'buffer', from: '健康', to: '危险' },      // 20%
      { key: 'cap', from: '完整', to: '受损' },         // 63.9%
      { key: 'force', from: '充沛', to: '不足' },       // 30.8%
    ])
  })

  it('null 维跳过（不产出边沿、不动基线）；reset 回常态基线', () => {
    const d = new CombatEdgeDetector()
    d.update(computeTiers(BEAT_99))
    expect(d.update(computeTiers({ 气势: 100 }))).toEqual([{ key: 'momentum', from: '未满', to: '已满' }])
    d.update(computeTiers({ 气血: 20, 最大气血: 100 })) // cap null：跳过，基线保持 完整
    d.reset()
    expect(d.update(computeTiers(BEAT_99))).toEqual([])
  })
})
