/**
 * nav/blocker 单测（T23.11）：软阻断连击 ⇒ 硬阻断判定；位置变化 / 到达 / 未受理都清零。
 * 判据出处：A.9 结论 12（**硬阻断没有专有行文**——用户定义"walk 中突然停下、连续两次 walk
 * 都无法继续前进"，所以判定是**行为性**的：软阻断连击 + 位置未变）。
 */

import { describe, expect, it } from 'vitest'
import { HARD_STOP_ATTEMPTS, nextBlocker } from '../src/nav/blocker.ts'

describe('nav/blocker 软阻断连击 ⇒ 硬阻断（T23.11）', () => {
  it('同位置连续两次软阻断 ⇒ 硬阻断（阈值 = A.9 结论 12 的"连续两次"）', () => {
    expect(HARD_STOP_ATTEMPTS).toBe(2)
    const first = nextBlocker(undefined, '襄阳', 'soft-stop')
    expect(first).toMatchObject({ attempts: 1, hard: false, at: '襄阳' })
    const second = nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'soft-stop')
    expect(second).toMatchObject({ attempts: 2, hard: true, at: '襄阳' })
    // 第三次仍在同点 ⇒ 仍是硬阻断（计数继续涨，供档案观察）
    expect(nextBlocker({ attempts: 2, at: '襄阳' }, '襄阳', 'soft-stop')).toMatchObject({ attempts: 3, hard: true })
  })

  it('换了位置 ⇒ 连击重新从 1 起（避免把不同地点的两次失败算成一次硬阻断）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '扬州', 'soft-stop')).toMatchObject({ attempts: 1, hard: false, at: '扬州' })
    expect(nextBlocker({ attempts: 3, at: '襄阳' }, undefined, 'soft-stop')).toMatchObject({ attempts: 1, hard: false })
  })

  it('到达 / 未受理 ⇒ 清零（不是阻断：一个成功、一个走错了地方）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'arrived')).toEqual({ attempts: 0, hard: false, at: null })
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'unaccepted')).toEqual({ attempts: 0, hard: false, at: null })
  })

  it('其它收束（incomplete / timeout）⇒ 保持原状（不涨不清，避免误判）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'incomplete')).toMatchObject({ attempts: 1, hard: false, at: '襄阳' })
    expect(nextBlocker(undefined, '襄阳', 'incomplete')).toMatchObject({ attempts: 0, hard: false })
  })
})
