/**
 * nav/graph 单测（T23.10b；用户口径 2026-10-14 两次：**只记录，不查询**）。
 * 口径：**初始为空**；agent 自己按 `walk` 找路，**找到的节点都记录下来**；
 * `walk -c` 方向序列**按拼音并入对应边的 dirs**（独立 paths 数组退役）；
 * 图只做后端知识积累，不回答任何查询。
 * 夹具出处：附录 A.9（荆州府路线表 + `-c` 方向序列）。
 */

import { describe, expect, it } from 'vitest'
import { NavGraph } from '../src/graph.ts'
import type { WalkEdge } from '../src/route.ts'

const JINGZHOU_EDGES: readonly WalkEdge[] = [
  { region: '汉口镇', room: '汉水西岸', pinyin: 'hankou', steps: 14 },
  { region: '荆山', room: '南漳县', pinyin: 'jingshan', steps: 9 },
  { region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15 },
]

describe('nav/graph 记录（T23.10b）', () => {
  it('初始为空（不做预置地图）', () => {
    const g = new NavGraph()
    expect(g.size()).toBe(0)
    expect(g.snapshot()).toEqual({ nodes: [] })
  })

  it('记录路线表 ⇒ 节点 + 边（同键后到覆盖：步数变了取新值）', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', JINGZHOU_EDGES)
    expect(g.size()).toBe(1)
    expect(g.snapshot().nodes[0]?.edges.map(e => e.pinyin)).toContain('xiangyang')
    // 后到覆盖：同 pinyin 步数更新
    g.recordTable('荆州府', [{ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 12 }])
    expect(g.snapshot().nodes[0]?.edges.find(e => e.pinyin === 'xiangyang')?.steps).toBe(12)
  })

  it('`-c` 方向序列按拼音并入对应边的 dirs（后到覆盖；region 缺省 / 无对应边不记）', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', JINGZHOU_EDGES)
    expect(g.recordDirs(undefined, { pinyin: 'xiangyang' }, ['west'])).toBe(false)
    expect(g.recordDirs('信阳', { pinyin: 'xinyang' }, ['west'])).toBe(false) // 无此节点
    expect(g.recordDirs('荆州府', { pinyin: 'xinyang' }, ['west'])).toBe(false) // 节点在、边不在
    expect(g.recordDirs('荆州府', { pinyin: 'xiangyang' }, ['west', 'north'])).toBe(true)
    expect(g.recordDirs('荆州府', { pinyin: 'xiangyang' }, ['west'])).toBe(true) // 后到覆盖
    const e = g.snapshot().nodes[0]?.edges.find(x => x.pinyin === 'xiangyang')
    expect(e).toEqual({ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15, dirs: ['west'] })
    // 未给拼音 ⇒ 按答复前缀（to = 目的区域名）匹配
    expect(g.recordDirs('荆州府', { to: '襄阳' }, ['south'])).toBe(true)
    expect(g.snapshot().nodes[0]?.edges.find(x => x.pinyin === 'xiangyang')?.dirs).toEqual(['south'])
  })

  it('表覆盖不抹 dirs：新边未带 dirs 时保留已学到的方向序列', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', JINGZHOU_EDGES)
    g.recordDirs('荆州府', { pinyin: 'xiangyang' }, ['west'])
    g.recordTable('荆州府', [{ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 12 }])
    const e = g.snapshot().nodes[0]?.edges.find(x => x.pinyin === 'xiangyang')
    expect(e).toEqual({ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 12, dirs: ['west'] })
  })

  it('快照可读（节点 / 边），供后端观测与落盘', () => {
    const g = new NavGraph()
    g.recordTable('荆州府', JINGZHOU_EDGES)
    const snap = g.snapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.region).toBe('荆州府')
    expect(snap.nodes[0]!.edges).toHaveLength(3)
  })

  it('loadSnapshot：新格式恢复（坏数据逐条丢弃），与实时记录同语义', () => {
    const g = new NavGraph()
    const loaded = g.loadSnapshot({
      nodes: [
        { region: '荆州府', edges: [{ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15, direct: true }], updatedAt: 1 },
        { region: '', edges: [], updatedAt: 0 },
        { region: '坏节点', edges: [{ pinyin: '', region: 'x', room: 'y', steps: 1 }], updatedAt: 0 },
      ],
    })
    expect(loaded).toBe(1)
    expect(g.snapshot().nodes[0]?.region).toBe('荆州府')
    expect(g.snapshot().nodes[0]?.edges[0]).toEqual({ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15, direct: true })
  })

  it('loadSnapshot：旧格式读时归一（dest 按 ◇ 折算；旧 paths 的方向序列并入对应边 dirs）', () => {
    const g = new NavGraph()
    const loaded = g.loadSnapshot({
      nodes: [
        { region: '荆州府', edges: [
          { dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 15 },
          { dest: '没有菱形', pinyin: 'nolink', steps: 3 }, // 折算不出 ⇒ 丢弃
        ], updatedAt: 1 },
      ],
      paths: [
        { region: '荆州府', to: '襄阳', directions: ['west', 'north'], updatedAt: 2 },
        { region: '无对应边', to: '襄阳', directions: ['west'], updatedAt: 0 },
      ],
    })
    expect(loaded).toBe(2) // 1 边 + 1 dirs 并入
    const e = g.snapshot().nodes[0]?.edges[0]
    expect(e).toEqual({ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15, dirs: ['west', 'north'] })
  })
})
