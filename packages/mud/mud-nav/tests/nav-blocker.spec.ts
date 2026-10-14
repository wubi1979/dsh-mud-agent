/**
 * nav/blocker 单测（T23.11；用户口径 2026-10-14）：阻塞连击 ⇒ 阻断判定；
 * 位置变化 / 到达 / 不在出发点都清零。**取消软/硬说法**——阻塞可再发 walk 继续；
 * 连续失败没有推进（同位置连击 ≥ 2）⇒ 记录为阻断，需人工干预。
 */

import { describe, expect, it } from 'vitest'
import { BLOCK_MANUAL_ATTEMPTS, nextBlocker } from '../src/blocker.ts'

describe('nav/blocker 阻塞连击 ⇒ 阻断（T23.11）', () => {
  it('同位置连续两次阻塞 ⇒ 阻断（阈值 = "连续失败没有推进"）', () => {
    expect(BLOCK_MANUAL_ATTEMPTS).toBe(2)
    const first = nextBlocker(undefined, '襄阳', 'blocked')
    expect(first).toMatchObject({ attempts: 1, blocked: false, at: '襄阳' })
    const second = nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'blocked')
    expect(second).toMatchObject({ attempts: 2, blocked: true, at: '襄阳' })
    // 第三次仍在同点 ⇒ 仍是阻断（计数继续涨，供档案观察）
    expect(nextBlocker({ attempts: 2, at: '襄阳' }, '襄阳', 'blocked')).toMatchObject({ attempts: 3, blocked: true })
  })

  it('换了位置 ⇒ 连击重新从 1 起（避免把不同地点的两次失败算成一次阻断）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '扬州', 'blocked')).toMatchObject({ attempts: 1, blocked: false, at: '扬州' })
    expect(nextBlocker({ attempts: 3, at: '襄阳' }, undefined, 'blocked')).toMatchObject({ attempts: 1, blocked: false })
  })

  it('到达 / 不在出发点 ⇒ 清零（一个有推进、一个没出发，都不是阻塞）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'arrived')).toEqual({ attempts: 0, blocked: false, at: null })
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'unaccepted')).toEqual({ attempts: 0, blocked: false, at: null })
  })

  it('其它收束（incomplete / atNode）⇒ 保持原状（不涨不清，避免误判）', () => {
    expect(nextBlocker({ attempts: 1, at: '襄阳' }, '襄阳', 'incomplete')).toMatchObject({ attempts: 1, blocked: false, at: '襄阳' })
    expect(nextBlocker(undefined, '襄阳', 'incomplete')).toMatchObject({ attempts: 0, blocked: false })
    expect(nextBlocker({ attempts: 2, at: '襄阳' }, '襄阳', 'atNode')).toMatchObject({ attempts: 2, blocked: true })
  })
})
