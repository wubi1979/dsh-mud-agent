/**
 * nav/route 单测（T23.10b；用户口径 2026-10-14）：行走行文的纯层解析——
 * 路径表行（`◇` 拆区域/房间 + `◇` 分隔段颜色 ⇒ 可直达性）+ `-c <拼音名>` 方向
 * 序列（`walk -q` 已退役）。判据出处：附录 A.9 + 实录（2026-10-14：着色段 =
 * ` ◇ `，红 `[31m` / 绿 `[1;32m`；区域名黄、房间白不进判据）。
 */

import { describe, expect, it } from 'vitest'
import { expandShortPath, parseDirectionPath, parseWalkTable, walkLine, type WalkLine } from '../src/route.ts'

/** A.9 荆州府路线表（实录，含表头与边框行；无颜色 ⇒ 不记 direct）。 */
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
].map(walkLine)

/** 实录 2026-10-14：着色段 = ` ◇ ` 分隔段（含两侧空格）；◇ 本身必着色。 */
function withDiamond(text: string, diaFg: number | null): WalkLine {
  const fg = new Array<number | null>(text.length).fill(null)
  if (diaFg !== null) {
    const at = text.indexOf('◇')
    for (let i = Math.max(0, at - 1); i <= Math.min(text.length - 1, at + 1); i += 1) fg[i] = diaFg
  }
  return { text, fg }
}

/** 实录底色：区域名黄(3)（`[1;33m`）、房间白(7)（`[2;37;0m`）——验证它们不进判据。 */
function withCellColors(text: string, diaFg: number | null): WalkLine {
  const line = withDiamond(text, diaFg)
  const fg = [...(line.fg ?? [])]
  const at = text.indexOf('◇')
  const rowEnd = text.indexOf('│', at)
  for (let i = 1; i < at - 1; i += 1) fg[i] = 3
  for (let i = at + 2; i < rowEnd; i += 1) fg[i] = 7
  return { text, fg }
}

describe('nav/route 路径表解析（A.9 路线表；出现表格 = 处于 walk 节点）', () => {
  it('区域名取自块开行；`◇` 拆目的地 ⇒ {region, room, pinyin, steps}（无色不记 direct）', () => {
    const t = parseWalkTable(JINGZHOU_TABLE)
    expect(t.region).toBe('荆州府')
    expect(t.edges).toHaveLength(5)
    expect(t.edges[0]).toEqual({ region: '汉口镇', room: '汉水西岸', pinyin: 'hankou', steps: 14 })
    expect(t.edges[3]).toEqual({ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15 })
  })

  it('`◇` 分隔段颜色 ⇒ direct：红(1/9) = 不可直达、绿(2/10) = 可直达、其它色不猜（实录校准）', () => {
    const t = parseWalkTable([
      walkLine('┌───扬州─────────────┬────────────┬─────┐'),
      withCellColors('│信阳  ◇ 小广场                       │xinyang                │10        │', 2),
      withCellColors('│汉口镇  ◇ 市集                       │hankou                 │11        │', 10),
      withCellColors('│徐州  ◇ 戏马台                       │xuzhou                 │14        │', 1),
      withCellColors('│镇江  ◇ 扬子津                       │zhenjiang              │8         │', 9),
      withCellColors('│濠州府  ◇ 广场                       │haozhou                │11        │', 3), // ◇ 涂黄 = 不猜
      walkLine('└───────────────────────────────┘'),
    ])
    const by = (p: string) => t.edges.find(e => e.pinyin === p)
    expect(by('xinyang')).toMatchObject({ region: '信阳', room: '小广场', direct: true })
    expect(by('hankou')).toMatchObject({ direct: true })
    expect(by('xuzhou')).toMatchObject({ region: '徐州', room: '戏马台', direct: false })
    expect(by('zhenjiang')).toMatchObject({ direct: false })
    expect(by('haozhou')).toEqual({ region: '濠州府', room: '广场', pinyin: 'haozhou', steps: 11 }) // 黄/白不进判据
  })

  it('颜色只认 `◇` 本位：cell 其它部分着色（区域黄/房间白/拼音红）不串判据', () => {
    const text = '│信阳  ◇ 小广场                       │xinyang                │10        │'
    const fg = new Array<number | null>(text.length).fill(null)
    // 区域名黄（实录 [1;33m）、房间白（[2;37;0m）、拼音 cell 红——◇ 本身无色 ⇒ 不记 direct
    const at = text.indexOf('◇')
    for (let i = 1; i < at - 1; i += 1) fg[i] = 3
    for (let i = at + 2; i < text.indexOf('│', at); i += 1) fg[i] = 7
    const py = text.indexOf('xinyang')
    fg.fill(1, py, py + 7)
    const t = parseWalkTable([
      walkLine('┌───扬州────┬────────┬────┐'),
      { text, fg },
      walkLine('└────────────┘'),
    ])
    expect(t.edges[0]).toEqual({ region: '信阳', room: '小广场', pinyin: 'xinyang', steps: 10 })
  })

  it('无 `◇` 的目的地行不猜、丢弃；非路线表 ⇒ 空表，不误吃其它表格', () => {
    expect(parseWalkTable([
      '┌───扬州────┬────────┬────┐',
      '│中央广场                             │plaza                  │3         │',
      '└────────────┘',
    ].map(walkLine)).edges).toEqual([])
    expect(parseWalkTable(['┌───北大侠客行───┐', '│气血 313 / 313 │', '└────┘'].map(walkLine)).edges).toEqual([])
    expect(parseWalkTable([]).region).toBeUndefined()
  })
})

describe('nav/route `-c <拼音名>` 方向序列（A.9 结论 11）', () => {
  it('长版本 ⇒ 完整方向序列；短版本原文保留', () => {
    const p = parseDirectionPath([
      '信阳 长版本：west,west,west,west,northwest,west,west,west,west,west',
      '     短版本：#4 w,nw,#5 w',
    ].map(walkLine))
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
    expect(parseDirectionPath(['短版本：#2 w'].map(walkLine))?.directions).toEqual(['west', 'west'])
    expect(parseDirectionPath(['你到达了荆州府。'].map(walkLine))).toBeNull()
  })
})
