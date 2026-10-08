/**
 * nav/graph 单测（T23.10b）：行走知识图的记录与查询。
 * 口径（用户裁定 2026-10-08）：**初始为空**；agent 自己按 `walk` 找路，**找到的节点都记录下来**；
 * 每到一个新地点重新查询（图提供"下一跳建议"，不替 agent 规划全程）。
 * 夹具出处：附录 A.9（荆州府路线表 + `walk -q 襄阳`）。
 */

import { describe, expect, it } from 'vitest'
import { NavGraph } from '../src/nav/graph.ts'
import { parseCrossRegionHint, parseWalkTable } from '../src/nav/route.ts'

const JINGZHOU_TABLE = [
  '┌───荆州府─────────────┬────────────┬─────┐',
  '│目的地                │拼音名称                │步数      │',
  '├───────────────────┼────────────┼─────┤',
  '│汉口镇  ◇ 汉水西岸                   │hankou                  │14        │',
  '│荆山  ◇ 南漳县                       │jingshan                │9         │',
  '│襄阳  ◇ 城中心                       │xiangyang               │15        │',
  '└─────────────────────────────国庆节祝福────┘',
]

describe('nav/graph 记录（T23.10b）', () => {
  it('初始为空 ⇒ 查询无解（不猜）', () => {
    const g = new NavGraph()
    expect(g.size()).toBe(0)
    expect(g.suggest('荆州府', '襄阳')).toBeNull()
  })

  it('记录路线表 ⇒ 节点 + 边（同键后到覆盖：步数变了取新值）', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', parseWalkTable(JINGZHOU_TABLE).edges)
    expect(g.size()).toBe(1)
    expect(g.suggest('荆州府', '襄阳')?.pinyin).toBe('xiangyang')
    // 后到覆盖：同 pinyin 步数更新
    g.recordTable('荆州府', [{ dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 12 }])
    expect(g.suggest('荆州府', '襄阳')?.steps).toBe(12)
  })

  it('记录 `-q` 参考链（大致边）⇒ 无本区域表时也能给"链上第一跳"的名字', () => {
    const g = new NavGraph()
    g.recordHint(parseCrossRegionHint('从这里到襄阳途径扬州、中原、襄阳。')!)
    expect(g.suggest('荆州府', '襄阳')?.pinyin).toBeUndefined() // 无边 ⇒ 无 pinyin 可用
    expect(g.hintFor('襄阳')?.via).toEqual(['扬州', '中原', '襄阳'])
  })

  it('边 + 链合起来 ⇒ 链上第一跳若在本区域表里可达，就能给出可执行 pinyin', () => {
    const g = new NavGraph()
    g.recordHint(parseCrossRegionHint('从这里到武当山途径襄阳、武当山。')!)
    g.recordTable('荆州府', parseWalkTable(JINGZHOU_TABLE).edges)
    expect(g.suggest('荆州府', '武当山')?.pinyin).toBe('xiangyang')
  })

  it('快照可读（节点 / 边 / 链），供状态出口与调试', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', parseWalkTable(JINGZHOU_TABLE).edges)
    const snap = g.snapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.region).toBe('荆州府')
    expect(snap.nodes[0]!.edges).toHaveLength(3)
  })
})
