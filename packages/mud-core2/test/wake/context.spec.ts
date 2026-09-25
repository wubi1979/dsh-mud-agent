/**
 * wake/context 单测 — 唤醒正文组装（impl §3.4）。
 *
 * 覆盖：世界摘要字段清单判据（入选字段与理由、缺字段跳过、jingli 防孤儿）、
 * HP 缓降越界事实（阈值标注）、静默/危险正文形态（事实短消息，不写指令）、
 * 空世界兜底。
 */

import { describe, expect, it } from 'vitest'
import type { MudLine } from '../../src/link/ansi.ts'
import { matchDanger } from '../../src/awareness/danger.ts'
import { World } from '../../src/awareness/world.ts'
import { HP_LOW_RATIO, dangerText, silenceText, worldSummary } from '../../src/wake/context.ts'

let seq = 0
function mkLine(text: string): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt: false }
}

function worldWith(apply: (w: World) => void): World {
  const w = new World()
  apply(w)
  return w
}

describe('worldSummary 字段清单判据', () => {
  it('HP 行渲染比例；低于阈值标注越界事实', () => {
    const w = worldWith(w => w.reduce(mkLine('【气血】156/3000')))
    const s = worldSummary(w)
    expect(s).toContain('HP 156/3000（5%')
    expect(s).toContain(`低于 ${Math.round(HP_LOW_RATIO * 100)}% 警戒`)
  })

  it('HP 充足不标注警戒；内力/位置照常入选', () => {
    const w = new World()
    w.reduce(mkLine('【气血】1560/3000'))
    w.reduce(mkLine('【内力】1200/1500'))
    w.reduce(mkLine('【茶室】'))
    const s = worldSummary(w)
    expect(s).toContain('HP 1560/3000（52%）')
    expect(s).not.toContain('警戒')
    expect(s).toContain('内力 1200/1500')
    expect(s).toContain('位置 【茶室】')
  })

  it('登录态（装配层直写）与饥饿/口渴/金钱（待增补字段）出现即报告', () => {
    const w = worldWith(w => {
      w.set('session', 'loggedIn', true, 'measured')
      w.set('vitals', 'hunger', 3, 'measured')
      w.set('vitals', 'thirst', '口渴', 'measured')
      w.set('session', 'money', '一两银子', 'measured')
    })
    const s = worldSummary(w)
    expect(s).toContain('登录：是')
    expect(s).toContain('饥饿 3')
    expect(s).toContain('口渴 口渴')
    expect(s).toContain('金钱 一两银子')
  })

  it('防孤儿字段：jingli 被 world 抓取但不进摘要', () => {
    const w = worldWith(w => w.reduce(mkLine('【精力】100/200')))
    const s = worldSummary(w)
    expect(w.get('vitals', 'jingli')?.value).toBe(100)
    expect(s).not.toContain('精力')
  })

  it('缺字段跳过不补默认值；空世界兜底', () => {
    expect(worldSummary(new World())).toBe('世界摘要：（暂无已测得的世界字段）')
    const w = worldWith(w => w.reduce(mkLine('【内力】100/200')))
    expect(worldSummary(w)).not.toContain('HP')
  })
})

describe('唤醒正文形态（事实，不是指令）', () => {
  it('静默正文：原因带静默时长与"没有在途命令"事实 + 世界摘要', () => {
    const w = worldWith(w => w.reduce(mkLine('【气血】1560/3000')))
    const s = silenceText(w, 120_000)
    expect(s).toContain('静默环顾：MUD 行流已 120s 无新行，且当前没有在途命令。')
    expect(s).toContain('世界摘要：')
    expect(s).toContain('HP 1560/3000')
    expect(s).not.toContain('请')
  })

  it('危险正文：why + 触发行原文 + 世界摘要，不写指令', () => {
    const w = worldWith(w => {
      w.reduce(mkLine('【气血】540/3000'))
      w.reduce(mkLine('【茶室】'))
    })
    const hit = matchDanger(mkLine('不知哪里杀出一人向你袭来！'))
    expect(hit).not.toBeNull()
    const s = dangerText(hit!, w)
    expect(s).toContain('危险：遭攻击。')
    expect(s).toContain('触发行：不知哪里杀出一人向你袭来！')
    expect(s).toContain('HP 540/3000（18%')
    expect(s).toContain('位置 【茶室】')
    expect(s).not.toContain('快逃')
  })

  it('危险正文在空世界上也能组装（缺字段跳过）', () => {
    const hit = matchDanger(mkLine('你已经死了。'))
    expect(hit).not.toBeNull()
    const s = dangerText(hit!, new World())
    expect(s).toContain('危险：角色死亡。')
    expect(s).toContain('（暂无已测得的世界字段）')
  })
})
