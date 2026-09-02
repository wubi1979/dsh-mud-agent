/**
 * dsh-mud-core — 感知层 Phase 2 测试: 环形缓冲 (批量缩容) + 颜色触发。
 *
 * 环形缓冲: abs 单调、满时覆盖最旧行、游标读 dropped 语义、快照保序。
 * 颜色触发: fg/bg/真彩条件、与 contains/regex AND、纯颜色模式 (Mudlet 对齐)。
 */

import { describe, expect, it } from 'vitest'
import { PerceptionBuffer } from '../src/perception/perception.ts'
import { Perceptor } from '../src/perception/triggers.ts'
import type { ParsedLine, StyleRun } from '../src/net/ansi.ts'

function parsed(text: string, style: StyleRun[] = [], isPrompt = false): ParsedLine {
  return { text, raw: text, style, time: 0, isPrompt }
}

describe('PerceptionBuffer 环形缓冲', () => {
  it('追加: abs 单调, 顺序保持', () => {
    const buf = new PerceptionBuffer({ maxRows: 5 })
    buf.appendLines([parsed('a'), parsed('b'), parsed('c')])
    expect(buf.entries.map(e => e.row.text)).toEqual(['a', 'b', 'c'])
    expect(buf.entries.map(e => e.abs)).toEqual([0, 1, 2])
    expect(buf.nextAbs).toBe(3)
  })

  it('超上限批量缩容: 保留最新行, 非逐行 splice', () => {
    const buf = new PerceptionBuffer({ maxRows: 3 })
    for (let i = 0; i < 5; i += 1) buf.appendLines([parsed(`l${i}`)])
    expect(buf.entries.map(e => e.abs)).toEqual([2, 3, 4])
    expect(buf.snapshot().map(l => l.text)).toEqual(['l2', 'l3', 'l4'])
    expect(buf.last()?.text).toBe('l4')
  })

  it('游标读: dropped 计数 + 越界游标读空', () => {
    const buf = new PerceptionBuffer({ maxRows: 3 })
    for (let i = 0; i < 5; i += 1) buf.appendLines([parsed(`l${i}`)])
    // 缓冲只剩 base=2; 游标 -1 → dropped=2 (l0,l1 已丢, 相对未消费游标), pending 从 l2 起
    const r = buf.getLinesAfter(-1)
    expect(r.dropped).toBe(2)
    expect(r.pending.map(l => l.text)).toEqual(['l2', 'l3', 'l4'])
    // 游标 3 → 只剩 l4
    expect(buf.getLinesAfter(3).pending.map(l => l.text)).toEqual(['l4'])
    // 游标越过尾 → 空
    expect(buf.getLinesAfter(10).pending).toEqual([])
  })

  it('游标读: maxLines 截断保留最新', () => {
    const buf = new PerceptionBuffer()
    for (let i = 0; i < 5; i += 1) buf.appendLines([parsed(`l${i}`)])
    const r = buf.getLinesAfter(-1, 2)
    expect(r.pending.map(l => l.text)).toEqual(['l3', 'l4'])
    expect(r.dropped).toBe(3)
  })

  it('空缓冲: 全部读空, last=-Infinity 安全', () => {
    const buf = new PerceptionBuffer()
    expect(buf.getLinesAfter(-1)).toEqual({ pending: [], dropped: 0 })
    expect(buf.last()).toBeNull()
    expect(buf.snapshot()).toEqual([])
    expect(buf.entries).toEqual([])
  })

  it('快照/entries 在缩容后仍保序', () => {
    const buf = new PerceptionBuffer({ maxRows: 4 })
    for (let i = 0; i < 7; i += 1) buf.appendLines([parsed(`l${i}`)])
    expect(buf.snapshot().map(l => l.abs)).toEqual([3, 4, 5, 6])
    expect(buf.entries.map(e => e.abs)).toEqual([3, 4, 5, 6])
  })

  it('clear 复位', () => {
    const buf = new PerceptionBuffer({ maxRows: 4 })
    for (let i = 0; i < 6; i += 1) buf.appendLines([parsed(`l${i}`)])
    buf.clear()
    expect(buf.entries).toEqual([])
    expect(buf.nextAbs).toBe(0)
    buf.appendLines([parsed('再起')])
    expect(buf.entries[0]?.row.abs).toBe(0)
  })
})

describe('颜色触发 (style 条件)', () => {
  function buffered(rows: ParsedLine[]): ReturnType<PerceptionBuffer['snapshot']> {
    const buf = new PerceptionBuffer()
    buf.appendLines(rows)
    return buf.snapshot()
  }

  const green = parsed('绿色的字', [{ start: 0, end: 4, fg: 2, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
  const red = parsed('红色的字', [{ start: 0, end: 4, fg: 1, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
  const plain = parsed('无色的字')

  it('纯前景条件: 命中该颜色行, 不命中其它', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'green', eventType: 'p:green', fg: 2 })
    expect(perceptor.match(buffered([green])).map(h => h.id)).toEqual(['green'])
    expect(perceptor.match(buffered([red])).length).toBe(0)
    expect(perceptor.match(buffered([plain])).length).toBe(0)
    expect(perceptor.match(buffered([red, green])).map(h => h.lineNumber)).toEqual([1])
  })

  it('纯颜色条件无需 extract 也命中 (颜色即模式)', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'red-alert', eventType: 'p:red:alert', bg: 1 })
    const redBg = parsed('红底字', [{ start: 0, end: 3, fg: null, bg: 1, fgTrue: null, bgTrue: null, flags: 0 }])
    expect(perceptor.match(buffered([redBg])).map(h => h.id)).toEqual(['red-alert'])
  })

  it('真彩前景条件', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'pink', eventType: 'p:pink', fgTrue: [255, 0, 128] })
    const pink = parsed('粉字', [{ start: 0, end: 2, fg: null, bg: null, fgTrue: [255, 0, 128], bgTrue: null, flags: 0 }])
    expect(perceptor.match(buffered([pink])).length).toBe(1)
  })

  it('颜色 + contains 为 AND (同色必含字面量)', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'green-warn', eventType: 'p:warn', fg: 2, contains: ['警告'] })
    const greenWarn = parsed('绿色警告牌', [{ start: 0, end: 5, fg: 2, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
    expect(perceptor.match(buffered([greenWarn])).map(h => h.id)).toEqual(['green-warn'])
    // 同色但无字面量 → 不命中
    expect(perceptor.match(buffered([green])).length).toBe(0)
    // 含字面量但非目标色 → 不命中
    expect(perceptor.match(buffered([red])).length).toBe(0)
  })

  it('多行规则: 窗口内任一行命中颜色即整体命中', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'multi', eventType: 'p:multi', multiline: true, fg: 2, contains: ['白'] })
    const whiteOnGreen = parsed('白字', [{ start: 0, end: 2, fg: 2, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
    const hit = perceptor.match(buffered([parsed('前'), whiteOnGreen, red]))[0]
    expect(hit?.id).toBe('multi')
    expect(hit?.lineNumber).toBe(1)
  })
})
