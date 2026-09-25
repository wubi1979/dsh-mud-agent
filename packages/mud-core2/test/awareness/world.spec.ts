/**
 * awareness/world 单测 — 工作记忆（分区 + 置信度分档 + 来源追溯）。
 *
 * 覆盖：种子抓取器（HP/内力/房间/战斗态）、置信度分档（measured/inferred）、
 * 来源行号与时间、后到覆盖旧值、inCombat 锚点（危险唤醒去重 latch 用）、
 * snapshot 只含值、set 直写（非行文来源）、reset 全量复位。
 */

import { describe, expect, it } from 'vitest'
import type { MudLine } from '../../src/link/ansi.ts'
import { World } from '../../src/awareness/world.ts'

let seq = 0
function mkLine(text: string, isPrompt = false): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt }
}

describe('reduce 抓取（实录格式刻度）', () => {
  it('气血行 → vitals.hp/maxHp（measured，实录【…】形态）', () => {
    const w = new World()
    w.reduce(mkLine('【气血】156/300'))
    expect(w.get('vitals', 'hp')?.value).toBe(156)
    expect(w.get('vitals', 'hp')?.confidence).toBe('measured')
    expect(w.get('vitals', 'maxHp')?.value).toBe(300)
  })

  it('千分位逗号容忍：半角 , 与全角 ，均数值化', () => {
    const w = new World()
    w.reduce(mkLine('【气血】1,560/3，000'))
    expect(w.get('vitals', 'hp')?.value).toBe(1560)
    expect(w.get('vitals', 'maxHp')?.value).toBe(3000)
  })

  it('内力行 → vitals.neili/maxNeili（同形态推定）', () => {
    const w = new World()
    w.reduce(mkLine('【内力】50/120'))
    expect(w.get('vitals', 'neili')?.value).toBe(50)
    expect(w.get('vitals', 'maxNeili')?.value).toBe(120)
  })

  it('精力行 → vitals.jingli/maxJingli（同形态推定）', () => {
    const w = new World()
    w.reduce(mkLine('【精力】 80 / 100 '))
    expect(w.get('vitals', 'jingli')?.value).toBe(80)
    expect(w.get('vitals', 'maxJingli')?.value).toBe(100)
  })

  it('【房间】行 → location.room（measured）', () => {
    const w = new World()
    w.reduce(mkLine('【扬州城 - 打铁铺】'))
    expect(w.get('location', 'room')?.value).toBe('【扬州城 - 打铁铺】')
  })

  it('属性行不误写房间名：标签在 ATTR_LABELS 内排除', () => {
    const w = new World()
    w.reduce(mkLine('【气血】156/300'))
    w.reduce(mkLine('【经验】'))
    expect(w.get('location', 'room')).toBeNull()
    expect(w.get('vitals', 'hp')?.value).toBe(156)
  })

  it('遭攻击行 → combat.inCombat=true（inferred）；战斗结束行解除', () => {
    const w = new World()
    expect(w.inCombat).toBeNull() // 未判定
    w.reduce(mkLine('不知哪里杀出一人向你袭来！'))
    expect(w.inCombat).toBe(true)
    expect(w.get('combat', 'inCombat')?.confidence).toBe('inferred')
    w.reduce(mkLine('战斗结束了。'))
    expect(w.inCombat).toBe(false)
  })

  it('主动开战帧也置战斗态（实录刻度：你大喝一声/扑了上来），latch 锚点双向覆盖', () => {
    const w = new World()
    w.reduce(mkLine('你大喝一声，向对手扑了上去。'))
    expect(w.inCombat).toBe(true)
    w.reduce(mkLine('你战胜了。'))
    expect(w.inCombat).toBe(false)
  })

  it('来源可追溯：字段记录命中行的 abs/time；后到覆盖旧值', () => {
    const w = new World()
    w.reduce(mkLine('【气血】100/100'))
    const first = w.get('vitals', 'hp')
    w.reduce(mkLine('【气血】80/100'))
    const second = w.get('vitals', 'hp')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.abs).toBeGreaterThan(first!.abs)
    expect(second!.time).toBeGreaterThan(first!.time)
    expect(second!.value).toBe(80)
  })

  it('无关行不写任何字段', () => {
    const w = new World()
    w.reduce(mkLine('师父说道：你去茶室吧。'))
    expect(w.get('vitals', 'hp')).toBeNull()
    expect(w.inCombat).toBeNull()
  })
})

describe('快照与直写', () => {
  it('snapshot 只含值（分区 → 字段 → 值）', () => {
    const w = new World()
    w.reduce(mkLine('【气血】156/300'))
    w.reduce(mkLine('【扬州城】'))
    const snap = w.snapshot()
    expect(snap.vitals).toEqual({ hp: 156, maxHp: 300 })
    expect(snap.location).toEqual({ room: '【扬州城】' })
    expect(snap.combat).toEqual({})
  })

  it('set 直写非行文来源（登录标志；无行来源 abs=-1）', () => {
    const w = new World()
    w.set('session', 'loggedIn', true, 'measured')
    const f = w.get('session', 'loggedIn')
    expect(f?.value).toBe(true)
    expect(f?.abs).toBe(-1)
  })

  it('reset 全量复位（重连用：世界作废待重建）', () => {
    const w = new World()
    w.reduce(mkLine('【气血】156/300'))
    w.reduce(mkLine('向你袭来'))
    w.reset()
    expect(w.get('vitals', 'hp')).toBeNull()
    expect(w.inCombat).toBeNull()
    expect(w.snapshot().vitals).toEqual({})
  })
})
