/**
 * dsh-mud-map — 语义层 (look 解析) 单元测试.
 *
 * 覆盖: 出口行锚点、标题提取、方向识别、NPC 列表扫描。
 *
 * @module @deepseek-ai/dsh-mud-map/tests/semantic
 */

import { describe, it, expect } from 'vitest'
import { SemanticLayer } from '../src/semantic.ts'

describe('SemanticLayer.parseLook', () => {
  it('解析标题/出口/描述/NPC', () => {
    const look = [
      '扬州 - 中心广场',
      '这里是扬州的中心广场, 人来人往。',
      '',
      '出口: north south east west。',
      '> 卖粥的老奶奶(lao nainai)',
      '> 江湖散人',
      '  一把青锋剑(qingfeng jian)',
    ].join('\n')

    const parsed = new SemanticLayer().parseLook(look)
    expect(parsed.area).toBe('扬州')
    expect(parsed.name).toBe('中心广场')
    expect(parsed.exits).toContain('north')
    expect(parsed.exits).toContain('west')
    expect(parsed.npcs.length).toBeGreaterThan(0)
  })

  it('无出口行返回空结构', () => {
    const parsed = new SemanticLayer().parseLook('没有出口的文本')
    expect(parsed.exits).toEqual([])
    expect(parsed.name).toBe('')
  })

  it('exitsSignature 为稳定指纹', () => {
    expect(SemanticLayer.exitsSignature(['south', 'north'])).toBe('north,south')
    expect(SemanticLayer.exitsSignature(['north', 'south'])).toBe('north,south')
  })
})

describe('SemanticLayer — 指纹记录', () => {
  it('parseAndRecord 记录返回值, getFingerprint 可读', () => {
    const sem = new SemanticLayer()
    const look = ['客栈', '一处安静的客栈。', '', '出口: north。', '> 店小二(shop keeper)'].join('\n')
    const parsed = sem.parseAndRecord('room:1', look)
    expect(parsed.exits).toContain('north')
    const fp = sem.getFingerprint('room:1')
    expect(fp?.npcs.some((n) => n.includes('店小二'))).toBe(true)
  })
})
