/**
 * nav/route 单测（T23.10b）：跨区分段的纯层解析——路径表行 + `-q` 参考链 + 下一跳挑选。
 * 判据出处：附录 A.9（荆州府路线表 + `walk -q 襄阳` 实答）；口径 = "`-q` 只有参考意义"。
 */

import { describe, expect, it } from 'vitest'
import {
  expandShortPath, parseCrossRegionHint, parseDirectionPath, parseWalkTable, pickNextHop,
} from '../src/nav/route.ts'

/** A.9 荆州府路线表（实录，含表头与边框行）。 */
const JINGZHOU_TABLE = [
  '┌───荆州府─────────────┬────────────┬─────┐',
  '│目的地                │拼音名称                │步数      │',
  '├───────────────────┼────────────┼─────┤',
  '│汉口镇  ◇ 汉水西岸                   │hankou                  │14        │',
  '│鸡鸣渡  ◇ 鸡鸣渡西                   │jiming                  │7         │',
  '│荆山  ◇ 南漳县                       │jingshan                │9         │',
  '│襄阳  ◇ 城中心                       │xiangyang               │15        │',
  '│岳阳  ◇ 陵矶                         │yueyang                 │11        │',
  '└─────────────────────────────国庆节祝福────┘',
]

describe('nav/route 路径表解析（A.9 路线表）', () => {
  it('区域名取自块开行；表行 ⇒ {dest, pinyin, steps}；表头与边框跳过', () => {
    const t = parseWalkTable(JINGZHOU_TABLE)
    expect(t.region).toBe('荆州府')
    expect(t.edges).toHaveLength(5)
    expect(t.edges[0]).toEqual({ dest: '汉口镇  ◇ 汉水西岸', pinyin: 'hankou', steps: 14 })
    expect(t.edges[3]).toEqual({ dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 15 })
  })

  it('非路线表（无拼音名列表头）⇒ 空表，不误吃其它表格', () => {
    expect(parseWalkTable(['┌───北大侠客行───┐', '│气血 313 / 313 │', '└────┘']).edges).toEqual([])
    expect(parseWalkTable([]).region).toBeUndefined()
  })
})

describe('nav/route 跨区参考链（A.9 `walk -q` 实答）', () => {
  it('`从这里到X途径A、B、X。` ⇒ {to, via}（末位即目标）', () => {
    expect(parseCrossRegionHint('从这里到襄阳途径扬州、中原、襄阳。'))
      .toEqual({ to: '襄阳', via: ['扬州', '中原', '襄阳'] })
  })

  it('不成句 ⇒ null（不猜）', () => {
    expect(parseCrossRegionHint('这里到襄阳')).toBeNull()
    expect(parseCrossRegionHint('')).toBeNull()
  })
})

describe('nav/route 下一跳挑选（参考链 × 本区域表）', () => {
  const table = parseWalkTable(JINGZHOU_TABLE)

  it('链中第一个可达元素即为下一跳（扬州/中原不可达 ⇒ 落到襄阳）', () => {
    const hint = parseCrossRegionHint('从这里到襄阳途径扬州、中原、襄阳。')!
    expect(pickNextHop(table, hint)).toEqual({ dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 15 })
  })

  it('目标本身可达 ⇒ 直达（不必看链）', () => {
    const hint = parseCrossRegionHint('从这里到汉口途径中原、汉口。')!
    expect(pickNextHop(table, hint)?.pinyin).toBe('hankou')
  })

  it('链中无可达元素 ⇒ null（回给 agent，不硬走）', () => {
    const hint = parseCrossRegionHint('从这里到武当山途径甲城、乙城、武当山。')!
    expect(pickNextHop(table, hint)).toBeNull()
  })
})

describe('nav/route `-c <拼音名>` 方向序列（A.9 结论 11）', () => {
  it('长版本 ⇒ 完整方向序列；短版本原文保留', () => {
    const p = parseDirectionPath([
      '信阳 长版本：west,west,west,west,northwest,west,west,west,west,west',
      '     短版本：#4 w,nw,#5 w',
    ])
    expect(p).toEqual({
      to: '信阳',
      directions: ['west', 'west', 'west', 'west', 'northwest', 'west', 'west', 'west', 'west', 'west'],
      short: '#4 w,nw,#5 w',
    })
  })

  it('短版本展开：#N 重复计数 + 方向缩写 + 未知名原样（不猜）', () => {
    // 与长版本交叉校验：4×west + northwest + 5×west = 长版本那 10 步
    expect(expandShortPath('#4 w,nw,#5 w')).toEqual([
      'west', 'west', 'west', 'west', 'northwest', 'west', 'west', 'west', 'west', 'west',
    ])
    expect(expandShortPath('wu,nu,eu,enter,do_push door')).toEqual([
      'westup', 'northup', 'eastup', 'enter', 'do_push door',
    ])
    expect(expandShortPath('?x')).toEqual(['?x'])
  })

  it('只有短版本 ⇒ 展开成方向序列；都没有 ⇒ null（不猜）', () => {
    expect(parseDirectionPath(['短版本：#2 w'])?.directions).toEqual(['west', 'west'])
    expect(parseDirectionPath(['你到达了荆州府。'])).toBeNull()
  })
})
