/**
 * wake/wake 单测 — 唤醒器（impl §3.4）。
 *
 * 覆盖：静默到期唤醒（行流空闲 → followup 静默正文）、在途持有者守卫
 * （busy → 只重新武装不唤醒、恢复空闲后再次到期照常唤醒）、每行重新武装
 * （armSilence 推迟到点）、危险唤醒（steer 事实正文）、dispose 停表、
 * V7 纪律（不写子 agent 守卫——idle 只反映行流持有者，由注入方决定）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MudLine } from '../../src/link/ansi.ts'
import { matchDanger } from '../../src/awareness/danger.ts'
import { World } from '../../src/awareness/world.ts'
import { Wake } from '../../src/wake/wake.ts'

let seq = 0
function mkLine(text: string): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt: false }
}

const SILENCE_MS = 1000

interface FakeDeps {
  world: World
  followups: string[]
  steers: string[]
  busy: boolean
}

function fakeDeps(world = new World()): FakeDeps {
  return { world, followups: [], steers: [], busy: false }
}

function makeWake(deps: FakeDeps): Wake {
  return new Wake(
    {
      world: deps.world,
      followup: text => deps.followups.push(text),
      steer: text => deps.steers.push(text),
      idle: () => !deps.busy,
    },
    { silenceMs: SILENCE_MS },
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('静默唤醒（followup 源）', () => {
  it('到期且行流空闲 → followup 静默正文（单次，不重复唤醒）', () => {
    const deps = fakeDeps()
    const wake = makeWake(deps)
    wake.armSilence()
    vi.advanceTimersByTime(SILENCE_MS)
    expect(deps.followups).toHaveLength(1)
    expect(deps.followups[0]).toContain('静默环顾')
    vi.advanceTimersByTime(SILENCE_MS * 10)
    expect(deps.followups).toHaveLength(1) // 到期即停表，无行则不再触发
  })

  it('到期时手里有活（在途 read）→ 只重新武装不唤醒；恢复空闲后再次到期照常唤醒', () => {
    const deps = fakeDeps()
    deps.busy = true
    const wake = makeWake(deps)
    wake.armSilence()

    vi.advanceTimersByTime(SILENCE_MS)
    expect(deps.followups).toHaveLength(0) // busy：不唤醒

    vi.advanceTimersByTime(SILENCE_MS) // 重新武装后仍在 busy 期
    expect(deps.followups).toHaveLength(0)

    deps.busy = false
    vi.advanceTimersByTime(SILENCE_MS) // read 收束后的持续静默：唤醒
    expect(deps.followups).toHaveLength(1)
    expect(deps.followups[0]).toContain('静默环顾')
  })

  it('每行重新武装：armSilence 把到点不断推后（静默计时按最后一批行起算）', () => {
    const deps = fakeDeps()
    const wake = makeWake(deps)
    wake.armSilence()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(SILENCE_MS - 100) // 不足静默时长，新行到达
      wake.armSilence()
    }
    vi.advanceTimersByTime(100)
    expect(deps.followups).toHaveLength(0) // 前 5 次都被推后，未到期
    vi.advanceTimersByTime(SILENCE_MS)
    expect(deps.followups).toHaveLength(1)
  })

  it('dispose 停表：不再唤醒', () => {
    const deps = fakeDeps()
    const wake = makeWake(deps)
    wake.armSilence()
    wake.dispose()
    vi.advanceTimersByTime(SILENCE_MS * 10)
    expect(deps.followups).toHaveLength(0)
  })
})

describe('危险唤醒（steer 源）', () => {
  it('onDanger 接线：事实正文经 steer 上抛（why + 触发行），不动 followup', () => {
    const deps = fakeDeps()
    const wake = makeWake(deps)
    const hit = matchDanger(mkLine('对手向你袭来！'))
    expect(hit).not.toBeNull()
    wake.steerDanger(hit!)
    expect(deps.steers).toHaveLength(1)
    expect(deps.steers[0]).toContain('危险：遭攻击。')
    expect(deps.steers[0]).toContain('触发行：对手向你袭来！')
    expect(deps.followups).toHaveLength(0)
  })

  it('去重归 observe（latch 挂 world.inCombat 边沿）：wake 层不自建去重，同 why 可重复上抛', () => {
    const deps = fakeDeps()
    const wake = makeWake(deps)
    wake.steerDanger(matchDanger(mkLine('哎呀，你已经死了！'))!)
    wake.steerDanger(matchDanger(mkLine('你死了。'))!)
    expect(deps.steers).toHaveLength(2) // 死亡类无 latch，每次命中都执行
  })
})
