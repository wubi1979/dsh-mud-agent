/**
 * dsh-mud-map — 先验层 (PriorParser) 单元测试.
 *
 * 覆盖: ASCII 图解析 → PriorSubMap (房间提取/坐标/连接/边界/NODE).
 *
 * @module @deepseek-ai/dsh-mud-map/tests/prior-parser
 */

import { describe, it, expect } from 'vitest'
import { PriorParser } from '../src/prior-parser.ts'

const parser = new PriorParser()

describe('PriorParser — 房间提取', () => {
  it('解析房间名与 NPC 编号 (末尾连续数字)', () => {
    const ascii = [
      '  北门27',
      '  天宁寺74',
    ].join('\n')
    const sm = parser.parse('yangzhou', '扬州', ascii)
    expect(sm.nodes).toHaveLength(2)
    const north = sm.nodes.find((n) => n.name === '北门')
    const temple = sm.nodes.find((n) => n.name === '天宁寺')
    expect(north).toBeDefined()
    expect(temple).toBeDefined()
    expect(north!.npcIds).toEqual([27])
    expect(temple!.npcIds).toEqual([74])
  })

  it('记录坐标 (x=段起始列, y=行号)', () => {
    const ascii = [
      '  北门27 中心',
    ].join('\n')
    const sm = parser.parse('s', '测试', ascii)
    const north = sm.nodes.find((n) => n.name === '北门')
    expect(north).toBeDefined()
    expect(north!.x).toBe(2)
    expect(north!.y).toBe(0)
  })
})

describe('PriorParser — 连接提取', () => {
  it('垂直连接 (│) 建立双向 north/south', () => {
    const ascii = [
      '    小广场',
      '      │',
      '    北门',
    ].join('\n')
    const sm = parser.parse('s', '测试', ascii)
    const plaza = sm.nodes.find((n) => n.name === '小广场')!
    const north = sm.nodes.find((n) => n.name === '北门')!
    expect(plaza).toBeDefined()
    expect(north).toBeDefined()
    // 小广场 south → 北门 (双向).
    const conn = plaza.connections.find((c) => c.dir === 'south')
    expect(conn).toBeDefined()
    expect(conn!.targetName).toBe('北门')
    expect(conn!.bidirectional).toBe(true)
    // 北门 north → 小广场.
    const rev = north.connections.find((c) => c.dir === 'north')
    expect(rev).toBeDefined()
    expect(rev!.targetName).toBe('小广场')
  })

  it('水平连接 (─) 跨自块后建立 east/west', () => {
    const ascii = [
      '  北门27 ─ 天宁寺74',
    ].join('\n')
    const sm = parser.parse('s', '测试', ascii)
    const north = sm.nodes.find((n) => n.name === '北门')!
    const temple = sm.nodes.find((n) => n.name === '天宁寺')!
    const east = north.connections.find((c) => c.dir === 'east')
    expect(east).toBeDefined()
    expect(east!.targetName).toBe('天宁寺')
    const west = temple.connections.find((c) => c.dir === 'west')
    expect(west).toBeDefined()
    expect(west!.targetName).toBe('北门')
  })

  it('对角线连接 (╲) 建立东南/西北', () => {
    const ascii = [
      '  甲',
      '  ╲',
      '   乙',
    ].join('\n')
    const sm = parser.parse('s', '测试', ascii)
    const a = sm.nodes.find((n) => n.name === '甲')!
    const b = sm.nodes.find((n) => n.name === '乙')!
    expect(a.connections.some((c) => c.dir === 'southwest' && c.targetName === '乙')).toBe(true)
    expect(b.connections.some((c) => c.dir === 'northeast' && c.targetName === '甲')).toBe(true)
  })
})

describe('PriorParser — 边界与 NODE', () => {
  it('解析 [名称] 边界标记', () => {
    const ascii = [
      '旁边 [信阳]',
      '  北门',
    ].join('\n')
    const sm = parser.parse('yangzhou', '扬州', ascii)
    const bd = sm.boundaries.find((b) => b.targetSubMap === '信阳')
    expect(bd).toBeDefined()
  })

  it('⊕ 标记的房间进 nodeRooms', () => {
    const ascii = [
      '  小广场 ⊕',
    ].join('\n')
    const sm = parser.parse('s', '测试', ascii)
    const nr = sm.nodeRooms.find((n) => n.name === '小广场')
    expect(nr).toBeDefined()
  })
})

describe('PriorParser — 端到端', () => {
  it('多房间 + 多连接 + NODE 完整解析', () => {
    const ascii = [
      '  小广场 ⊕',
      '    │',
      '  北门 ─ 天宁寺',
    ].join('\n')
    const sm = parser.parse('yangzhou', '扬州', ascii)
    expect(sm.nodes).toHaveLength(3)
    // 小广场为 NODE.
    expect(sm.nodeRooms.map((n) => n.name)).toContain('小广场')
    // 北门双向连接.
    const north = sm.nodes.find((n) => n.name === '北门')!
    const dirs = north.connections.map((c) => c.dir).sort()
    expect(dirs).toEqual(['east', 'north'])
  })
})
