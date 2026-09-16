/**
 * dsh-mud-core — GlobalBuffers 契约测试 (shell/global-buffers).
 *
 * 覆盖三个传输无关的不变式: seq 全局单调 + 超限丢最旧、
 * backfill 游标失效回绕全量、purgeSession 按会话过滤。
 * (原 ws.spec.ts 覆盖的 hello/广播/信任围栏随自建 hub 删除 —
 * 传输面已迁移官方 typert 网关, 由上游测试保障。)
 */

import { describe, expect, it } from 'vitest'
import { GlobalBuffers } from '../src/shell/global-buffers.ts'

describe('GlobalBuffers', () => {
  it('game/ui 各持独立单调 seq, 同 tick 追加保序', () => {
    const buffers = new GlobalBuffers()
    buffers.pushGame('s1', 'a')
    buffers.pushGame('s1', 'b')
    buffers.pushUi('s1', { kind: 'log', text: 'x', time: 1 })
    const backfill = buffers.backfill(0, 0)
    expect(backfill.game.map(item => item.seq)).toEqual([1, 2])
    expect(backfill.ui.map(item => item.seq)).toEqual([1])
  })

  it('超上限丢最旧 (game 侧)', () => {
    const buffers = new GlobalBuffers()
    // GAME_BUFFER_MAX = 2000: 推 2002 条, 最旧两条应被驱逐。
    for (let i = 1; i <= 2002; i += 1) buffers.pushGame('s1', `t${String(i)}`)
    const backfill = buffers.backfill(0, 0)
    expect(backfill.game).toHaveLength(2000)
    expect(backfill.game[0]?.text).toBe('t3')
    // 回放尾号仍是全局 seq (跳号合法)。
    expect(backfill.game.every(item => item.seq >= 3)).toBe(true)
  })

  it('backfill 游标大于当前尾号时回绕全量 (seq 失效保护)', () => {
    const buffers = new GlobalBuffers()
    buffers.pushGame('s1', 'a')
    buffers.pushUi('s1', { kind: 'log', text: 'x', time: 1 })
    // 客户端游标来自上一个进程生命周期 (大于当前尾号) → 回绕全量。
    const backfill = buffers.backfill(999, 999)
    expect(backfill.game).toHaveLength(1)
    expect(backfill.ui).toHaveLength(1)
  })

  it('purgeSession 只清目标会话条目', () => {
    const buffers = new GlobalBuffers()
    buffers.pushGame('s1', 'keep-other')
    buffers.pushGame('s2', 'drop-me')
    buffers.pushGame('', 'global-entry')
    buffers.pushUi('s2', { kind: 'decision', actor: 'rule', text: '[规则] hit', time: 2 })
    buffers.purgeSession('s2')
    const backfill = buffers.backfill(0, 0)
    expect(backfill.game.map(item => item.sessionId)).toEqual(['s1', ''])
    expect(backfill.ui).toHaveLength(0)
  })

  it('readGame 只回游戏条目且尾号独立于回放窗口', () => {
    const buffers = new GlobalBuffers()
    buffers.pushGame('s1', 'a')
    buffers.pushGame('s1', 'b')
    const page = buffers.readGame(1)
    expect(page.items.map(item => item.text)).toEqual(['b'])
    expect(page.tailSeq).toBe(2)
  })
})
