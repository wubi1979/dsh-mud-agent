/**
 * wake + 任务书面测试（T4a）。
 *
 * 契约：
 *   - 静默到期且守卫全过 → fire 一次；守卫分两层（T5.1）：传输面（非回合中/
 *     持有者空闲）到期即判，闸门面（已接入）完成唤醒时复查；
 *   - 任一传输面守卫不满足 → 不 fire 只 re-arm（守卫修复后下一轮到期命中）；
 *   - 行到达 arm() 重算即重置（行流持续到达永不到期）；
 *   - dispose 停表且不再复活；silenceMs 非正整数 fail-loud；
 *   - fillTaskBrief 全量替换占位符；缺省模板 = 两轴状态 + 目标（状态驱动，
 *     不写指令序列）。
 * 注：runtime.onActivity → wake.arm 的装配接线在 index.ts（宿主层），纯 TS 层
 * 以本文件的 Wake 单测 + runtime 的行路径既有用例覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Wake, DEFAULT_TASK_BRIEF, fillTaskBrief,
  goalBriefText, goalRoundSource, shouldKickoffOnGoalChange,
} from '../src/wake.ts'
import type { GoalView } from '@deepseek-ai/dsh-goal'

// ── Wake 静默唤醒器 ───────────────────────────────────────────────

describe('Wake 静默唤醒器', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 构造带可变守卫状态的唤醒器（缺省 = 三守卫全过）。 */
  function makeWake(overrides?: Partial<{ admitted: boolean; inTurn: boolean; holderBusy: boolean }>) {
    const state = { admitted: true, inTurn: false, holderBusy: false, ...overrides }
    let fired = 0
    const wake = new Wake({
      guards: {
        admitted: () => state.admitted,
        notInTurn: () => !state.inTurn,
        holderIdle: () => !state.holderBusy,
      },
      fire: () => { fired += 1 },
    }, { silenceMs: 120_000 })
    return { wake, state, fired: () => fired }
  }

  it('三守卫全过 → 静默到期 fire 一次（fire 后不自动重复）', () => {
    const { wake, fired } = makeWake()
    wake.arm()
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(1)
    vi.advanceTimersByTime(300_000)
    expect(fired()).toBe(1) // 无行到达不再武装，不重复唤醒
  })

  it('未接入不唤醒，只 re-arm（接入后下一轮到期命中）', () => {
    const { wake, state, fired } = makeWake({ admitted: false })
    wake.arm()
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(0)
    state.admitted = true
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(1)
  })

  it('回合中不唤醒，只 re-arm（turn 结束后下一轮到期命中）', () => {
    const { wake, state, fired } = makeWake({ inTurn: true })
    wake.arm()
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(0)
    state.inTurn = false
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(1)
  })

  it('持有者在途不唤醒，只 re-arm（收束后下一轮到期命中）', () => {
    const { wake, state, fired } = makeWake({ holderBusy: true })
    wake.arm()
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(0)
    state.holderBusy = false
    vi.advanceTimersByTime(120_000)
    expect(fired()).toBe(1)
  })

  it('行到达重置静默（arm 重算即重置）', () => {
    const { wake, fired } = makeWake()
    wake.arm()
    vi.advanceTimersByTime(60_000)
    wake.arm() // 新行到达：静默重新倒数
    vi.advanceTimersByTime(60_000)
    expect(fired()).toBe(0) // 距上次 arm 仅 60s，不到期
    vi.advanceTimersByTime(60_000)
    expect(fired()).toBe(1)
  })

  it('dispose 停表；之后 arm 不复活', () => {
    const { wake, fired } = makeWake()
    wake.arm()
    wake.dispose()
    vi.advanceTimersByTime(300_000)
    expect(fired()).toBe(0)
    wake.arm() // 已销毁：武装是空操作
    vi.advanceTimersByTime(300_000)
    expect(fired()).toBe(0)
  })

  it('silenceMs 非正整数 fail-loud', () => {
    expect(() => new Wake({ guards: { admitted: () => true, notInTurn: () => true, holderIdle: () => true }, fire: () => {} }, { silenceMs: 0 })).toThrow(TypeError)
    expect(() => new Wake({ guards: { admitted: () => true, notInTurn: () => true, holderIdle: () => true }, fire: () => {} }, { silenceMs: -1 })).toThrow(TypeError)
    expect(() => new Wake({ guards: { admitted: () => true, notInTurn: () => true, holderIdle: () => true }, fire: () => {} }, { silenceMs: 1.5 })).toThrow(TypeError)
  })
})

// ── 任务书面（fillTaskBrief + 缺省模板）──────────────────────────

describe('任务书面', () => {
  it('fillTaskBrief 全量替换六个占位符（含 T24 goal）', () => {
    const text = fillTaskBrief(DEFAULT_TASK_BRIEF, {
      serverName: '北大侠客行', endpoint: 'mud.example.org:4000', account: 'hero',
      conn: 'connected', loggedIn: 'in-game', goal: '把太极拳练到 30 级',
    })
    expect(text).not.toContain('{{')
    expect(text).toContain('北大侠客行')
    expect(text).toContain('mud.example.org:4000')
    expect(text).toContain('hero')
    expect(text).toContain('connected')
    expect(text).toContain('in-game')
    expect(text).toContain('当前优先目标：把太极拳练到 30 级')
  })

  it('缺省模板 = 两轴状态 + 目标 + 优先目标行（状态驱动，不写指令序列）', () => {
    expect(DEFAULT_TASK_BRIEF).toContain('{{serverName}}')
    expect(DEFAULT_TASK_BRIEF).toContain('{{endpoint}}')
    expect(DEFAULT_TASK_BRIEF).toContain('{{account}}')
    expect(DEFAULT_TASK_BRIEF).toContain('{{conn}}')
    expect(DEFAULT_TASK_BRIEF).toContain('{{loggedIn}}')
    expect(DEFAULT_TASK_BRIEF).toContain('{{goal}}')
    expect(DEFAULT_TASK_BRIEF).toContain('目标')
    expect(DEFAULT_TASK_BRIEF).toContain('当前优先目标')
    // bootstrap 时代文案退役：不再要求"确认就绪/不要调用工具"。
    expect(DEFAULT_TASK_BRIEF).not.toContain('不要调用')
    expect(DEFAULT_TASK_BRIEF).not.toContain('确认')
  })

  it('自定义模板覆盖生效；未知占位符原样保留（便于自查拼写）', () => {
    const text = fillTaskBrief('自定义 {{account}} {{unknown}}', {
      serverName: 's', endpoint: 'e', account: 'hero', conn: 'c', loggedIn: 'l', goal: '无',
    })
    expect(text).toBe('自定义 hero {{unknown}}')
  })
})

// ── goal 节选与源分派（T24，纯层；宿主服务读取在 index.ts）────────

describe('goal 节选与源分派（T24）', () => {
  /** 构造 goal 视图（字段覆盖；缺省 active；brand 字段经双重断言绕过）。 */
  function makeGoal(overrides?: Partial<GoalView>): GoalView {
    return {
      id: 'goal-1', revision: 3, objective: '把太极拳练到 30 级', phase: 'active',
      roundsStarted: 0, maxGoalRounds: 256, createdAt: 1, updatedAt: 2, activation: 'disarmed',
      ...overrides,
    } as unknown as GoalView
  }

  it('goalBriefText：无 goal / paused / complete / clear 后 ⇒ 「无」', () => {
    expect(goalBriefText(undefined)).toBe('无')
    expect(goalBriefText(makeGoal({ phase: 'paused' }))).toBe('无')
    expect(goalBriefText(makeGoal({ phase: 'complete' }))).toBe('无')
  })

  it('goalBriefText：active ⇒ objective 原文；blocked ⇒ objective + 阻塞说明', () => {
    expect(goalBriefText(makeGoal())).toBe('把太极拳练到 30 级')
    expect(goalBriefText(makeGoal({
      phase: 'blocked',
      blockedReason: { code: 'model-reported', message: '潜能不足且无可用任务' },
    }))).toBe('把太极拳练到 30 级（被阻塞：潜能不足且无可用任务）')
    // blocked 但缺 reason（回放保证必在，防御性）：退纯 objective
    expect(goalBriefText(makeGoal({ phase: 'blocked' }))).toBe('把太极拳练到 30 级')
  })

  it('goalRoundSource：active/blocked ⇒ goal 源（三元组与视图精确匹配）', () => {
    expect(goalRoundSource(makeGoal())).toEqual({
      kind: 'goal', goalId: 'goal-1', revision: 3, round: 0,
    })
    expect(goalRoundSource(makeGoal({
      phase: 'blocked', revision: 7, roundsStarted: 0,
      blockedReason: { code: 'model-reported', message: 'x' },
    }))).toEqual({ kind: 'goal', goalId: 'goal-1', revision: 7, round: 0 })
  })

  it('goalRoundSource：无 goal / paused / complete ⇒ undefined（源回 mud-wake）', () => {
    expect(goalRoundSource(undefined)).toBeUndefined()
    expect(goalRoundSource(makeGoal({ phase: 'paused' }))).toBeUndefined()
    expect(goalRoundSource(makeGoal({ phase: 'complete' }))).toBeUndefined()
  })

  it('shouldKickoffOnGoalChange：create/edit/resume 触发，pause/complete/clear/block 不触发', () => {
    expect(shouldKickoffOnGoalChange('create')).toBe(true)
    expect(shouldKickoffOnGoalChange('edit')).toBe(true)
    expect(shouldKickoffOnGoalChange('resume')).toBe(true)
    expect(shouldKickoffOnGoalChange('pause')).toBe(false)
    expect(shouldKickoffOnGoalChange('complete')).toBe(false)
    expect(shouldKickoffOnGoalChange('clear')).toBe(false)
    expect(shouldKickoffOnGoalChange('block')).toBe(false)
  })
})
