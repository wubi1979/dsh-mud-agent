/**
 * dsh-mud-core — 看门狗表规则测试 (`doc/ARCHITECTURE.md` §11)。
 *
 * 看门狗的**起停是声明式的**：`active()` 是启动条件（假即停表），`timeoutMs()` 是窗口，
 * `fire()` 是触发行为。本文件把这张"规则"固定下来 —— 之前这些条件散落在各事件处理里，
 * 实测连踩两次（登录完成不布防断流 / 断线后仍空转），所以规则要有测试兜着。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchdogTable, type WatchdogSpec } from '../src/session/watchdogs.ts'

/** 可切换的假条件 + 记录触发。 */
function makeSpec(overrides: Partial<WatchdogSpec> & { id: string }): {
  spec: WatchdogSpec
  state: { active: boolean; windowMs: number; fires: number; guard: boolean }
} {
  const state = { active: true, windowMs: 1_000, fires: 0, guard: true }
  const spec: WatchdogSpec = {
    id: overrides.id,
    active: overrides.active ?? (() => state.active),
    timeoutMs: overrides.timeoutMs ?? (() => state.windowMs),
    repeat: overrides.repeat ?? true,
    fire: overrides.fire ?? (() => { state.fires += 1 }),
    ...(overrides.guard === undefined ? { guard: () => state.guard } : { guard: overrides.guard }),
  }
  return { spec, state }
}

describe('WatchdogTable 起停规则', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('启动条件为真 → 布防; 越过窗口 → 触发', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    expect(table.armed()).toEqual(['a'])
    vi.advanceTimersByTime(999)
    expect(state.fires).toBe(0)
    vi.advanceTimersByTime(1)
    expect(state.fires).toBe(1)
  })

  it('reevaluate 幂等: 条件未变时反复调用不重置窗口', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    vi.advanceTimersByTime(600)
    table.reevaluate()          // 状态变化点被多次调用 (例如每个文本块折叠后)
    table.reevaluate()
    vi.advanceTimersByTime(400) // 距首次布防恰好 1000ms
    expect(state.fires).toBe(1)
  })

  it('活动 (touch) 重置窗口: 断流窗口从最后一次活动重新计时', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    vi.advanceTimersByTime(900)
    table.touch()               // 收到游戏输出
    vi.advanceTimersByTime(900)
    expect(state.fires).toBe(0) // 否则早在 1000ms 就触发了
    vi.advanceTimersByTime(100)
    expect(state.fires).toBe(1)
  })

  it('启动条件转假 → 停表, 且越过原窗口也不触发 (断线即停)', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    state.active = false        // 例如断线 / 登录态翻转
    table.reevaluate()
    expect(table.armed()).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(state.fires).toBe(0)

    // 条件再次为真 → 重新布防 (不是永久失效)。
    state.active = true
    table.reevaluate()
    vi.advanceTimersByTime(1_000)
    expect(state.fires).toBe(1)
  })

  it('repeat=false → 一次性: 触发后不再续期, 直到条件变化重新布防', () => {
    const { spec, state } = makeSpec({ id: 'once', repeat: false })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    vi.advanceTimersByTime(1_000)
    expect(state.fires).toBe(1)
    expect(table.armed()).toEqual([])
    vi.advanceTimersByTime(5_000)
    expect(state.fires).toBe(1)

    table.reevaluate()          // 条件未变也不布防? —— 表语义: active 且无表 → 布防
    vi.advanceTimersByTime(1_000)
    expect(state.fires).toBe(2)
  })

  it('触发前的 guard 为假 → 不触发也不续期 (条件在等待期间已变化)', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    state.guard = false
    vi.advanceTimersByTime(1_000)
    expect(state.fires).toBe(0)
    expect(table.armed()).toEqual([])

    state.guard = true
    table.reevaluate()
    vi.advanceTimersByTime(1_000)
    expect(state.fires).toBe(1)
  })

  it('窗口时长每次布防时求值 (部署改配置即生效)', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    state.windowMs = 500
    table.reevaluate()
    vi.advanceTimersByTime(500)
    expect(state.fires).toBe(1)
  })

  it('触发计数与 resetCounts (连接重建时清零)', () => {
    const counts: number[] = []
    const { spec } = makeSpec({
      id: 'a',
      timeoutMs: () => 100,
      fire: (handle) => { counts.push(handle.fires) },
    })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    vi.advanceTimersByTime(300)
    expect(counts).toEqual([1, 2, 3])
    table.resetCounts()
    vi.advanceTimersByTime(100)
    expect(counts).toEqual([1, 2, 3, 1])
  })

  it('条件抛异常按"不活跃"处理 (坏条件不得误唤醒)', () => {
    const spec: WatchdogSpec = {
      id: 'boom',
      active: () => { throw new Error('bad condition') },
      timeoutMs: () => 100,
      repeat: true,
      fire: () => { throw new Error('must not fire') },
    }
    const table = new WatchdogTable([spec])

    table.reevaluate()
    table.touch()
    expect(table.armed()).toEqual([])
    vi.advanceTimersByTime(1_000)
  })

  it('dispose → 全部停表, 之后调用是空操作 (已布防的到点也不触发)', () => {
    const { spec, state } = makeSpec({ id: 'a' })
    const table = new WatchdogTable([spec])

    table.reevaluate()
    table.dispose()
    expect(table.armed()).toEqual([])
    vi.advanceTimersByTime(5_000)
    expect(state.fires).toBe(0)

    table.reevaluate()
    table.touch()
    vi.advanceTimersByTime(5_000)
    expect(state.fires).toBe(0)
  })

  it('留痕: 布防与停表都记一行 (诊断看门狗为何没醒)', () => {
    const logs: string[] = []
    const { spec, state } = makeSpec({ id: 'dead-air' })
    const table = new WatchdogTable([spec], text => logs.push(text))

    table.reevaluate()
    state.active = false
    table.reevaluate()

    expect(logs[0]).toContain('dead-air 布防 1000ms')
    expect(logs[1]).toContain('dead-air 停表')
  })
})
