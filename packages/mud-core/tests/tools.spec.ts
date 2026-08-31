/**
 * dsh-mud-core 工具集测试 — 语义工具 (mud_move/mud_look/mud_status) + 兜底 mud_send。
 *
 * 工具 = 校验点: 非法参数在工具层拒绝 (不发命令), 合法参数转成游戏命令。
 */

import { describe, expect, it } from 'vitest'
import { buildMudTools, MOVE_ALIASES, MOVE_DIRS, STATUS_CMDS, type MudTools } from '../src/tools.ts'

function makeTools(): { tools: MudTools; sent: string[]; logs: string[] } {
  const sent: string[] = []
  const logs: string[] = []
  const tools = buildMudTools({ send: c => sent.push(c), log: t => logs.push(t) })
  return { tools, sent, logs }
}

describe('mud_move 方向校验', () => {
  it('全名/别名/大写 → 规范命令, 非法拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_move!.execute({ direction: 'north' })).toEqual({ ok: true, note: '向 north 移动', cmd: 'north' })
    expect(tools.mud_move!.execute({ direction: 'n' })).toEqual({ ok: true, note: '向 north 移动', cmd: 'north' })
    expect(tools.mud_move!.execute({ direction: 'NE' })).toEqual({ ok: true, note: '向 northeast 移动', cmd: 'northeast' })
    expect(tools.mud_move!.execute({ direction: 'up' })).toEqual({ ok: true, note: '向 up 移动', cmd: 'up' })
    expect(tools.mud_move!.execute({ direction: 'enter' })).toEqual({ ok: true, note: '向 enter 移动', cmd: 'enter' })
    expect(sent).toEqual(['north', 'north', 'northeast', 'up', 'enter'])
    expect(tools.mud_move!.execute({ direction: 'xyz' }).ok).toBe(false)
    expect(tools.mud_move!.execute({ direction: '' }).ok).toBe(false)
    expect(sent.length).toBe(5)
  })
})

describe('mud_look target 校验', () => {
  it('无 target = 房间; 有 target = look <target>; 分号拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_look!.execute({})).toEqual({ ok: true, note: 'look', cmd: 'look' })
    expect(tools.mud_look!.execute({ target: 'paizi' })).toEqual({ ok: true, note: 'look paizi', cmd: 'look paizi' })
    expect(tools.mud_look!.execute({ target: 'ren qunyu' })).toEqual({ ok: true, note: 'look ren qunyu', cmd: 'look ren qunyu' })
    expect(sent).toEqual(['look', 'look paizi', 'look ren qunyu'])
    expect(tools.mud_look!.execute({ target: 'paizi;quit' }).ok).toBe(false)
    expect(sent.length).toBe(3)
  })
})

describe('mud_status what 枚举校验', () => {
  it('what → 命令, 非法拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_status!.execute({ what: 'hp' })).toEqual({ ok: true, note: 'hp', cmd: 'hp' })
    expect(tools.mud_status!.execute({ what: 'inventory' })).toEqual({ ok: true, note: 'i', cmd: 'i' })
    expect(tools.mud_status!.execute({ what: 'SCORE' })).toEqual({ ok: true, note: 'score', cmd: 'score' })
    expect(tools.mud_status!.execute({ what: 'xyz' }).ok).toBe(false)
    expect(tools.mud_status!.execute({ what: '' }).ok).toBe(false)
    expect(sent).toEqual(['hp', 'i', 'score'])
  })
})

describe('mud_send 兜底', () => {
  it('非空命令通过, 空白拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_send!.execute({ cmd: 'ask zhang about 拜师' }))
      .toEqual({ ok: true, note: 'ask zhang about 拜师', cmd: 'ask zhang about 拜师' })
    expect(tools.mud_send!.execute({ cmd: '  ' }).ok).toBe(false)
    expect(tools.mud_send!.execute({ cmd: '' }).ok).toBe(false)
    expect(sent).toEqual(['ask zhang about 拜师'])
  })
})

describe('工具常量完备', () => {
  it('别名都在全名表内, 状态都有映射', () => {
    for (const alias of Object.keys(MOVE_ALIASES)) {
      expect(MOVE_DIRS).toContain(MOVE_ALIASES[alias]!)
    }
    for (const what of Object.keys(STATUS_CMDS)) {
      expect(STATUS_CMDS[what]).toBeTruthy()
    }
  })
})
