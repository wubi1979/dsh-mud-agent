/**
 * dsh-mud-core — 注入队列 (LineInjector) 测试。
 *
 * 统一 MudLine 主导线: 注入以感知缓冲 (PerceptionBuffer) 为唯一真相, 按 abs
 * 水位线拉取未注入行, 批量合并; 提示符/字数/静默三重边界。
 */

import { describe, expect, it } from 'vitest'
import { PerceptionBuffer } from '../src/perception.ts'
import { LineInjector, INJECT_MAX_CHARS } from '../src/inject.ts'
import type { ParsedLine } from '../src/ansi.ts'

function line(text: string, isPrompt = false): ParsedLine {
  return { text, raw: text, style: [], time: 0, isPrompt }
}

describe('LineInjector', () => {
  it('无边界时批量累积, 不入 agent', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('房间描述'), line('这里有出口：北')])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBeNull()
    expect(inj.pending).toBe(true)
    expect(inj.pendingChars).toBe('房间描述这里有出口：北'.length)
  })

  it('提示符行触发整批注入 (含提示符本身, 精确断言)', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('房间描述'), line('>', true)])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBe('房间描述\n>')
    expect(inj.pending).toBe(false)
    expect(inj.pendingChars).toBe(0)
  })

  it('队列在提示符后清空, 续行在下批', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('a'), line('>'), /* 裸 > 走 isPromptRow */ line('b')])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBe('a\n>')
    // 第二批 只剩 b
    expect(inj.drain()).toBeNull()
    expect(inj.pending).toBe(true)
    expect(inj.text()).toBe('b')
    expect(inj.force()).toBe('b')
  })

  it('空白行被水位消费但不上注入面', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line(''), line('   '), line('ab')])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBeNull()
    expect(inj.pendingChars).toBe(2)
    expect(inj.text()).toBe('ab')
  })

  it('累计字符超上限即整批注入', () => {
    const buf = new PerceptionBuffer()
    const filler = 'x'.repeat(700)
    buf.appendLines([line(filler), line(filler), line(filler)]) // 2100 chars
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBe(`${filler}\n${filler}\n${filler}`)
    expect(inj.pending).toBe(false)
  })

  it('不超限且无提示符: 不注入, 静默待 force', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('x'.repeat(100))])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBeNull()
    expect(inj.force()).toBe('x'.repeat(100))
    expect(inj.pending).toBe(false)
    expect(inj.force()).toBeNull()
  })

  it('水位不重复拉取 (同一批只入队一次)', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('a'), line('b')])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBeNull()
    expect(inj.pendingChars).toBe(2)
    // 再次 drain (无新行): 不重复入队
    expect(inj.drain()).toBeNull()
    expect(inj.pendingChars).toBe(2)
    expect(inj.text()).toBe('a\nb')
  })

  it('环形缓冲缩容不影响注入水位语义', () => {
    const buf = new PerceptionBuffer({ maxRows: 5 })
    const inj = new LineInjector(buf)
    for (let i = 0; i < 5; i += 1) buf.appendLines([line(`l${i}`)])
    expect(inj.drain()).toBeNull() // 全部入队 (无 prompt), 无边界
    expect(inj.text()).toBe(['l0', 'l1', 'l2', 'l3', 'l4'].join('\n'))
    // 缩容覆盖后再注入一批: 水位已越过旧行, 只处理新行
    for (let i = 5; i < 8; i += 1) buf.appendLines([line(`l${i}`)])
    expect(inj.drain()).toBeNull()
    expect(inj.text()).toBe('l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7')
    expect(inj.force()).toBe('l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7')
  })

  it('reset 清空队列与水位 (可重新拉取同批)', () => {
    const buf = new PerceptionBuffer()
    buf.appendLines([line('a')])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBeNull()
    expect(inj.pending).toBe(true)
    inj.reset()
    expect(inj.pending).toBe(false)
    expect(inj.pendingChars).toBe(0)
    // reset 后水位归零: 同批行可再次拉取 (不因旧水位跳过)
    buf.appendLines([line('b')])
    expect(inj.drain()).toBeNull() // 累积 a+b (无边界)
    expect(inj.text()).toBe('a\nb')
    expect(inj.force()).toBe('a\nb')
  })

  it('INJECT_MAX_CHARS 阈值边界精确', () => {
    const buf = new PerceptionBuffer()
    const one = 'y'.repeat(INJECT_MAX_CHARS)
    buf.appendLines([line(one)])
    const inj = new LineInjector(buf)
    expect(inj.drain()).toBe(one) // 恰为上限 → 触发
  })
})
