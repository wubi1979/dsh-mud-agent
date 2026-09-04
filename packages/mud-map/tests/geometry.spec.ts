/**
 * dsh-mud-map — 几何层单元测试.
 *
 * 覆盖: GMCP.Move 图构建、from→to 边确认、导出归一化、先验导入。
 *
 * @module @deepseek-ai/dsh-mud-map/tests/geometry
 */

import { describe, it, expect } from 'vitest'
import { GeometryLayer, normalizeExits, exitsFingerprint } from '../src/geometry.ts'
import type { PriorSubMap } from '../src/types.ts'

describe('normalizeExits / exitsFingerprint', () => {
  it('去重并排序, 忽略空值', () => {
    expect(normalizeExits(['north', 'south', 'north', '', 'east'])).toEqual(['east', 'north', 'south'])
    expect(exitsFingerprint(['south', 'north'])).toBe('north,south')
    expect(exitsFingerprint(['north', 'south'])).toBe('north,south')
  })

  it('空集归一化为空串', () => {
    expect(exitsFingerprint([])).toBe('')
  })
})

describe('GeometryLayer — 图构建', () => {
  it('注册子图 + 设置锚点后, GMCP 移动建立房间与双向边', () => {
    const geo = new GeometryLayer()
    geo.setSubMap({ id: 'sm', name: '测试子图', nodes: new Map(), boundaries: [], nodeRooms: [] })
    // 先建立一个初始房间作为锚点.
    geo.getSubMap('sm')!.nodes.set('sm:A', {
      id: 'sm:A', name: '入口', npcIds: [], exits: new Map(), confirmed: true, source: 'ascii',
    })
    geo.setCurrent('sm', 'sm:A')

    // 从 入口 向北移动进入 '北门' (出口: north,east).
    geo.onMoveStart('north')
    geo.onRoomEntered('北门', ['north', 'east'])

    const subMap = geo.getSubMap('sm')!
    expect(geo.currentNodeId()).toMatch(/sm:北门_/)
    const fromId = geo.onMove?.name // noop
    void fromId

    // 入口 → 北门 (north) 边.
    const entry = subMap.nodes.get('sm:A')!
    expect(entry.exits.get('north')).toMatch(/sm:北门_/)
    // 北门 → 入口 (south) 逆边.
    const northId = geo.currentNodeId()!
    const north = subMap.nodes.get(northId)!
    expect(north.exits.get('south')).toBe('sm:A')
  })

  it('onMove 回调携带 from/dir/to', () => {
    const geo = new GeometryLayer()
    geo.setSubMap({ id: 'sm', name: 's', nodes: new Map(), boundaries: [], nodeRooms: [] })
    geo.getSubMap('sm')!.nodes.set('sm:A', {
      id: 'sm:A', name: 'A', npcIds: [], exits: new Map(), confirmed: true, source: 'ascii',
    })
    geo.setCurrent('sm', 'sm:A')
    let captured: { fromId: string; dir: string; toId: string } | null = null
    geo.onMove = (out) => { captured = out }

    geo.onMoveStart('east')
    geo.onRoomEntered('B', ['west'])
    expect(captured?.fromId).toBe('sm:A')
    expect(captured?.dir).toBe('east')
    expect(captured?.toId).toMatch(/sm:B_/)
  })

  it('同名房间复用节点, 且出口边双向确认', () => {
    const geo = new GeometryLayer()
    geo.setSubMap({ id: 'sm', name: 's', nodes: new Map(), boundaries: [], nodeRooms: [] })
    geo.getSubMap('sm')!.nodes.set('sm:A', {
      id: 'sm:A', name: 'A', npcIds: [], exits: new Map(), confirmed: true, source: 'ascii',
    })
    geo.setCurrent('sm', 'sm:A')
    // A --east--> B; 再从 B --west--> A 回来.
    geo.onMoveStart('east')
    geo.onRoomEntered('B', ['west'])
    const bId = geo.currentNodeId()!
    geo.onMoveStart('west')
    geo.onRoomEntered('A', ['east'])

    const subMap = geo.getSubMap('sm')!
    // B 应只有 1 个节点 (复用).
    const bNodes = [...subMap.nodes.values()].filter((n) => n.name === 'B')
    expect(bNodes).toHaveLength(1)
    // 现在应回到 A.
    expect(geo.currentNodeId()).toBe('sm:A')
    expect(subMap.nodes.get(bId)!.exits.get('west')).toBe('sm:A')
  })
})

describe('GeometryLayer — 先验导入', () => {
  it('importPrior 生成节点/边/NODE', () => {
    const prior: PriorSubMap = {
      id: 'yuan',
      name: '扬州',
      nodes: [
        { id: 'r1', name: '中心', npcIds: [27], x: 5, y: 5, connections: [
          { dir: 'north', targetName: '北门', bidirectional: true },
        ] },
        { id: 'r2', name: '北门', npcIds: [], x: 5, y: 3, connections: [
          { dir: 'south', targetName: '中心', bidirectional: true },
        ] },
      ],
      boundaries: [{ targetSubMap: 'xin', gameNodeId: 'yz_xin' }],
      nodeRooms: [{ name: '中心', gameId: 'yz_center' }],
    }

    const geo = new GeometryLayer()
    geo.importPrior(prior)

    const sm = geo.getSubMap('yuan')!
    expect(sm.nodes.size).toBe(2)
    // 双向连接: 中心 → 北门 (north) 且 北门 → 中心 (south).
    const center = sm.nodes.get('r1')!
    const north = sm.nodes.get('r2')!
    expect(center.exits.get('north')).toBe('r2')
    expect(north.exits.get('south')).toBe('r1')
    // NODE 映射.
    expect(sm.nodeRooms[0]?.nodeId).toBe('r1')
    expect(sm.nodeRooms[0]?.gameId).toBe('yz_center')
    // NPC 编号保留.
    expect(center.npcIds).toEqual([27])
  })
})
