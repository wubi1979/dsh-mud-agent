/**
 * observe/meter 测试 — 计数护栏（impl §3.8 两个量 + §4 断言面）。
 *
 * 覆盖：两量计数口径（step/start / assistant/message+attempt）、漂移（重试/
 * 失败）、request/header fail-loud（禁用于计数）、未知事件忽略、场景复位、
 * assertWithin 越界（含实测值）。
 */

import { describe, expect, it } from 'vitest'
import { Meter, MeterBreachError } from '../../src/observe/meter.ts'

describe('两个量计数口径 (impl §3.8, design4 §8)', () => {
  it('决策点 = step/start 数；实际调用 = message + attempt；漂移 = 调用数 − 决策点数', () => {
    const m = new Meter()
    m.forward('step/start')
    m.forward('step/start')
    m.forward('assistant/message')
    m.forward('assistant/message')
    m.forward('assistant/message')
    m.forward('assistant/attempt')

    const s = m.snapshot()
    expect(s.decisionPoints).toBe(2)
    expect(s.actualCalls).toBe(4) // message 3 + attempt 1
    expect(s.drift).toBe(2) // 重试/失败 = 4 − 2（§8 口径：一步可含多次请求）
  })

  it('反例锁定：1 步 1 次重试 ⇒ drift=1（两流之差口径会得 0）', () => {
    const m = new Meter()
    m.forward('step/start')
    // 宿主语义（session/types.ts + agent.ts）：message = 提交了表面消息的尝试
    // （正常结束；含 interrupted 的取消）；attempt = 未提交表面消息的尝试
    // （error / aborted 且无内容）。
    m.forward('assistant/attempt') // 第一次尝试：未提交表面消息（失败重试）
    m.forward('assistant/message') // 重试尝试：提交了表面消息（成功）
    expect(m.snapshot()).toEqual({ decisionPoints: 1, actualCalls: 2, drift: 1 })
  })

  it('request/header → fail-loud（禁用于计数，impl §3.8）', () => {
    const m = new Meter()
    expect(() => m.forward('request/header')).toThrow(/禁用于计数/)
    expect(m.snapshot().actualCalls).toBe(0)
  })

  it('计数族白名单外的成员 fail-loud（拼写错静默忽略 = 护栏恒绿空跑）', () => {
    const m = new Meter()
    expect(() => m.forward('step/end')).toThrow(/未知 step 族事件/)
    expect(() => m.forward('Step/start')).toThrow(/未知 step 族事件/)
    expect(() => m.forward('assistant/attempts')).toThrow(/未知 assistant 族事件/)
  })

  it('两族之外的事件类型忽略（tool/call、agent/created 等不进账不拦）', () => {
    const m = new Meter()
    m.forward('tool/call')
    m.forward('agent/created')
    expect(m.snapshot()).toEqual({ decisionPoints: 0, actualCalls: 0, drift: 0 })
  })

  it('reset() 场景复位（验收逐场景跑）', () => {
    const m = new Meter()
    m.forward('step/start')
    m.forward('assistant/message')
    m.reset()
    expect(m.snapshot()).toEqual({ decisionPoints: 0, actualCalls: 0, drift: 0 })
  })
})

describe('assertWithin 断言面 (impl §4 每场景护栏)', () => {
  it('界内不抛；越界抛 MeterBreachError 且含实测值', () => {
    const m = new Meter()
    for (let i = 0; i < 3; i++) m.forward('step/start')
    for (let i = 0; i < 5; i++) m.forward('assistant/message')
    for (let i = 0; i < 5; i++) m.forward('assistant/attempt')

    expect(() => m.assertWithin({ maxDecisionPoints: 3, maxActualCalls: 10 })).not.toThrow()

    // 同步抛错形态（assertWithin 非 async）：
    let caught: Error | null = null
    try {
      m.assertWithin({ maxDecisionPoints: 2 })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(MeterBreachError)
    expect(caught?.message).toContain('3') // 实测决策点数

    caught = null
    try {
      m.assertWithin({ maxActualCalls: 9 })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(MeterBreachError)
    expect(caught?.message).toContain('实际调用数 10')
  })

  it('缺省维度不设限（只断言给定的量）', () => {
    const m = new Meter()
    m.forward('step/start')
    expect(() => m.assertWithin({})).not.toThrow()
    expect(() => m.assertWithin({ maxActualCalls: 0 })).not.toThrow() // 未计数维度不限
  })

  it('minDecisionPoints 下界：漏转发 step/start（决策点=0）时护栏不再恒绿', () => {
    const m = new Meter()
    m.forward('assistant/message') // 只有调用、零决策点 = 装配漏转发的典型形态
    let caught: Error | null = null
    try {
      m.assertWithin({ minDecisionPoints: 1 })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(MeterBreachError)
    expect(caught?.message).toContain('漏转发')
  })
})
