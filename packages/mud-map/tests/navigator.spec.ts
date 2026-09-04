/**
 * dsh-mud-map — 导航规划 (Navigator) 单元测试.
 *
 * 覆盖: 子图内 BFS 寻路、无路径/同节点边界。
 *
 * @module @deepseek-ai/dsh-mud-map/tests/navigator
 */

import { describe, it, expect } from 'vitest'
import { Navigator } from '../src/navigator.ts'
import type { GraphQuery } from '../src/navigator.ts'
import type { SubMap } from '../src/types.ts'

/** 构造一条线图: A -north-> B -east-> C -north-> D. */
function buildSubMap(): SubMap {
  const exits: Record<string, Record<string, string>> = {
    A: { north: 'B' },
    B: { south: 'A', east: 'C' },
    C: { west: 'B', north: 'D' },
    D: { south: 'C' },
  }
  const ids = ['A', 'B', 'C', 'D']
  const nodes = new Map(ids.map((id) => [id, {
    id, name: id, npcIds: [], exits: new Map(Object.entries(exits[id] ?? {})), confirmed: true, source: 'ascii',
  } as const]))
  const sm: SubMap = {
    id: 'sm',
    name: 'line',
    nodes,
    boundaries: [],
    nodeRooms: [],
  }
  return sm
}

function makeGraph(): GraphQuery {
  const sm = buildSubMap()
  return {
    subMapOf: (nodeId: string) => (sm.nodes.has(nodeId) ? sm : undefined),
    neighbor: (nodeId: string, dir: string) => sm.nodes.get(nodeId)?.exits.get(dir),
    nodeRooms: () => [],
  }
}

describe('Navigator.bfsWithinSubMap', () => {
  it('同节点返回空路径', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.bfsWithinSubMap('sm', 'A', 'A')).toEqual([])
  })

  it('A → D 返回最短方向序列', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.bfsWithinSubMap('sm', 'A', 'D')).toEqual(['north', 'east', 'north'])
  })

  it('不可达返回空', () => {
    const nav = new Navigator(makeGraph())
    // 构造不可达: 不存在的终点.
    expect(nav.bfsWithinSubMap('sm', 'A', 'ZZZ')).toEqual([])
  })
})

describe('Navigator.plan', () => {
  it('同子图按房间名找目标并返回路径', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.plan('A', 'D')).toEqual(['north', 'east', 'north'])
  })

  it('目标子图同于当前: 也走子图内 BFS', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.plan('A', 'C', 'sm')).toEqual(['north', 'east'])
  })

  it('未知起点返回空', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.plan('X', 'D')).toEqual([])
  })

  it('起终点相同返回空', () => {
    const nav = new Navigator(makeGraph())
    expect(nav.plan('A', 'A')).toEqual([])
  })
})
