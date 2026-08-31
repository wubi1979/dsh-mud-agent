/**
 * dsh-mud-core 世界状态同步测试 — GMCP 包解析 / 感知 patch 合并 / 快照 / 置信度。
 */

import { describe, expect, it } from 'vitest'
import {
  applyExtract, applyGmcp, applyPatch, createWorld, flattenWorld, setWorldField,
  worldSnapshot, writeField,
} from '../src/world.ts'

describe('GMCP 包解析', () => {
  it('Char.Vitals → char 分组, 数值归一化', () => {
    const w = createWorld()
    const changes = applyGmcp(w, 'Char.Vitals', { hp: '100', maxhp: '120', name: '张三' })
    expect(changes).toContain('char.hp')
    expect(w.char.hp).toBe(100)
    expect(w.char.maxhp).toBe(120)
    expect(w.char.name).toBe('张三')
    expect('name' in w.flags).toBe(false)
  })

  it('Room.Info → room 分组 + exits 数组化', () => {
    const w = createWorld()
    applyGmcp(w, 'Room.Info', { name: '客栈大厅', exits: ['north', 'west', 'south'] })
    expect(w.room.name).toBe('客栈大厅')
    expect(w.room.exits).toEqual(['north', 'west', 'south'])
    expect('exitsText' in w.room).toBe(false)

    const w2 = createWorld()
    applyGmcp(w2, 'Unknown.Pkg', 'raw-string')
    expect(w2.raw.length).toBe(1)
    expect(w2.raw[0]?.pkg).toBe('Unknown.Pkg')
  })

  it('GMCP.Move → room.name + room.exits (数组/对象载荷)', () => {
    const w = createWorld()
    const changes = applyGmcp(w, 'GMCP.Move', [{ result: 'true', dir: ['west', 'up'], short: '客店' }])
    expect(changes).toContain('room.name')
    expect(w.room.name).toBe('客店')
    expect(w.room.exits).toEqual(['west', 'up'])
    expect('result' in w.room).toBe(false)

    const w2 = createWorld()
    applyGmcp(w2, 'GMCP.Move', { result: 'true', dir: ['south'], short: '北大街' })
    expect(w2.room.name).toBe('北大街')
  })

  it('GMCP.System → 登录成功 / 数组包裹通用解包', () => {
    const w = createWorld()
    const changes = applyGmcp(w, 'GMCP.System', [{ site: '' }])
    expect(changes).toContain('flags.logged_in')
    expect(w.flags.logged_in).toBe(true)
    expect(w.flags.awaiting).toBe(false)

    const w2 = createWorld()
    applyGmcp(w2, 'GMCP.System', [{ site: '扬州-客店' }])
    expect(w2.room.area).toBe('扬州-客店')
    expect(w2.flags.logged_in).toBe(true)

    const w3 = createWorld()
    applyGmcp(w3, 'GMCP.Multi', [{ a: 1 }, { b: 2 }])
    expect(w3.raw.length).toBe(1)

    const w4 = createWorld()
    applyGmcp(w4, 'Char.Vitals', [{ hp: '100', maxhp: '120' }])
    expect(w4.char.hp).toBe(100)
  })
})

describe('感知 patch 与写入', () => {
  it('patch → flags/combat', () => {
    const w = createWorld()
    const changes = applyPatch(w, { logged_in: false, awaiting: true, in_combat: true })
    expect(changes).toContain('flags.logged_in')
    expect(w.flags.logged_in).toBe(false)
    expect(w.flags.awaiting).toBe(true)
    expect(w.combat.in_combat).toBe(true)
  })

  it('点分键 → 对应分组 (规则 after 副作用)', () => {
    const w = createWorld()
    const changes = applyPatch(w, { 'flags.sent_name': true, 'flags.sent_pass': true })
    expect(changes).toEqual(['flags.sent_name', 'flags.sent_pass'])
    expect(w.flags.sent_name).toBe(true)
    expect(w.flags.sent_pass).toBe(true)
    expect('flags.sent_name' in w.flags).toBe(false)
    expect(flattenWorld(w)['flags.sent_name']).toBe(true)
  })

  it('setWorldField + 独立快照', () => {
    const w = createWorld()
    setWorldField(w, 'flags', 'logged_in', true)
    expect(w.flags.logged_in).toBe(true)
    const snap = worldSnapshot(w)
    expect(snap.flags).toEqual({ logged_in: true })
    snap.flags.logged_in = false
    expect(w.flags.logged_in).toBe(true)
  })

  it('flattenWorld 扁平键', () => {
    const w = createWorld()
    applyGmcp(w, 'Char.Vitals', { hp: 100 })
    applyPatch(w, { logged_in: true, in_combat: false })
    const flat = flattenWorld(w)
    expect(flat['char.hp']).toBe(100)
    expect(flat['flags.logged_in']).toBe(true)
    expect(flat['combat.in_combat']).toBe(false)
  })
})

describe('置信度裁决', () => {
  it('GMCP (1.0) 权威优先, 低置信度不覆盖', () => {
    const w = createWorld()
    applyGmcp(w, 'Char.Vitals', { hp: 100 })
    const changes = applyExtract(w, 'char', { hp: 50 }, 'test-extract')
    expect(w.char.hp).toBe(100)
    expect(changes.length).toBe(0)

    applyExtract(w, 'char', { food: 80 }, 'test-extract')
    expect(w.char.food).toBe(80)

    applyGmcp(w, 'Char.Vitals', { hp: 90 })
    expect(w.char.hp).toBe(90)
  })

  it('writeField 同值同置信度不重复写', () => {
    const w = createWorld()
    expect(writeField(w, 'flags', 'x', 1, 0.7)).toBe(true)
    expect(writeField(w, 'flags', 'x', 1, 0.7)).toBe(false)
    expect(writeField(w, 'flags', 'x', 2, 0.7)).toBe(true)
  })
})
