/**
 * dsh-mud-core 流式 ANSI / 行解析器测试 — 分行 / 跨块续接 / 颜色 / OSC / flush。
 *
 * 验证三类目标:
 *   1. 分行正确性: \n / \r\n / 裸 \r; 空行保留; 跨 TCP 块的行尾续接 (行号稳定)。
 *   2. 颜色捕获: 16 色 / 256 色 / 真彩 → style run 坐标对齐 text。
 *   3. 解析器集成: PerceptionBuffer/Perceptor 在跨块场景下不产生碎行、abs 单调。
 */

import { describe, expect, it } from 'vitest'
import { AnsiStreamParser, stripAnsi, isPromptText } from '../src/ansi.ts'
import { PerceptionBuffer, Perceptor, StateTracker } from '../src/perception.ts'
import { createWorld, flattenWorld } from '../src/world.ts'

describe('分行', () => {
  it('按 \\n 拆分, 保留空行', () => {
    const p = new AnsiStreamParser()
    const lines = p.write('a\n\nb\n')
    expect(lines.map(l => l.text)).toEqual(['a', '', 'b'])
  })

  it('\\r\\n 与裸 \\r 都作为行分隔', () => {
    const p = new AnsiStreamParser()
    expect(p.write('a\r\nb').map(l => l.text)).toEqual(['a'])
    expect(p.flush()?.text).toBe('b')
  })

  it('raw 视图保留 ANSI 且不含行末换行', () => {
    const p = new AnsiStreamParser()
    const lines = p.write('\x1b[31m红\x1b[0m\n')
    expect(lines[0]?.raw).toBe('\x1b[31m红\x1b[0m')
    expect(lines[0]?.text).toBe('红')
  })

  it('text 视图剔除控制字符 (保留 \\t)', () => {
    const p = new AnsiStreamParser()
    const lines = p.write('a\x07b\tc\x7f\n')
    expect(lines[0]?.text).toBe('ab\tc')
  })

  it('跨块行尾续接: 不加换行不产出, 续块合并为同一行', () => {
    const p = new AnsiStreamParser()
    expect(p.write('杀气逼人')).toEqual([])
    expect(p.pending).toBe(true)
    const lines = p.write('向你扑来！\r\n')
    expect(lines.length).toBe(1)
    const line = lines[0]
    if (!line) throw new Error('missing line')
    expect(line.text).toBe('杀气逼人向你扑来！')
  })
})

describe('颜色解析 (style run)', () => {
  it('16 色: 前景色 run 坐标对齐 text', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[31m红\x1b[0m白\n')
    expect(line).toBeDefined()
    expect(line?.text).toBe('红白')
    expect(line?.style).toEqual([
      { start: 0, end: 1, fg: 1, bg: null, fgTrue: null, bgTrue: null, flags: 0 },
    ])
  })

  it('背景色 + 粗体 + 下划线组合', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[1;4;44m粗下蓝底\n\x1b[0m')
    expect(line?.style[0]).toMatchObject({ start: 0, end: 4, bg: 4, flags: 1 | 8 })
  })

  it('256 色: 38;5;n / 48;5;n', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[38;5;196;48;5;0m火\n')
    expect(line?.style[0]).toMatchObject({ fg: 196, bg: 0, flags: 0 })
  })

  it('真彩: 38;2;r;g;b', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[38;2;255;0;128m真\n')
    expect(line?.style[0]).toMatchObject({ fg: null, fgTrue: [255, 0, 128] })
  })

  it('样式游标跨行保持 (ANSI 语义)', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b[31m红\n')
    const [next] = p.write('续\n')
    expect(next?.style[0]).toMatchObject({ start: 0, end: 1, fg: 1 })
  })

  it('同色重新设置合并为一段', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[31mA\x1b[31mB\x1b[0mC\n')
    expect(line?.style).toEqual([
      { start: 0, end: 2, fg: 1, bg: null, fgTrue: null, bgTrue: null, flags: 0 },
    ])
  })
})

describe('跨块截断续接', () => {
  it('CSI 被块截断: 参数续接到下一块再解码', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b[3')
    expect(p.pending).toBe(true)
    const lines = p.write('1m蓝\n')
    expect(lines.length).toBe(1)
    expect(lines[0]?.text).toBe('蓝')
    expect(lines[0]?.style[0]).toMatchObject({ fg: 1 })
    expect(lines[0]?.raw).toBe('\x1b[31m蓝')
  })

  it('OSC 被块截断: 续块内以 BEL 终止', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b]0;title')
    const lines = p.write(' part\x07你好\n')
    expect(lines.length).toBe(1)
    expect(lines[0]?.text).toBe('你好')
  })

  it('ESC 单独落块尾, 下一块正常续接', () => {
    const p = new AnsiStreamParser()
    p.write('a\x1b')
    expect(p.pending).toBe(true)
    const lines = p.write('[32mb\n')
    expect(lines[0]?.text).toBe('ab')
    expect(lines[0]?.style[0]).toMatchObject({ fg: 2 })
  })
})

describe('OSC / 转义', () => {
  it('OSC BEL 终止不进入 text', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b]0;我的标题\x07内容\n')
    expect(line?.text).toBe('内容')
  })

  it('OSC 以 ST (ESC\\) 终止', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b]0;title\x1b\\内容\n')
    expect(line?.text).toBe('内容')
  })

  it('光标控制等非 SGR CSI 被忽略', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[?25l\x1b[2J\x1b[0m内容\n')
    expect(line?.text).toBe('内容')
  })

  it('stripAnsi 一次性整串剥离', () => {
    expect(stripAnsi('a\x1b[31mb\x1b[0mc')).toBe('abc')
    expect(stripAnsi('a\x1b]0;x\x07c')).toBe('ac')
  })
})

describe('flush / prompt', () => {
  it('无换行的行尾在 flush 时刷出', () => {
    const p = new AnsiStreamParser()
    p.write('半行')
    const tail = p.flush()
    expect(tail?.text).toBe('半行')
    expect(p.pending).toBe(false)
  })

  it('提示符尾行标记 isPrompt', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b[31m>\x1b[0m')
    const tail = p.flush()
    expect(tail?.text).toBe('>')
    expect(tail?.isPrompt).toBe(true)
  })

  it('纯残留转义无内容时不产出行', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b[31m')
    expect(p.flush()).toBeNull()
  })

  it('isPromptText 启发', () => {
    expect(isPromptText('>')).toBe(true)
    expect(isPromptText('＞')).toBe(true)
    expect(isPromptText('hello')).toBe(false)
  })
})

describe('与感知层集成 (行号稳定)', () => {
  it('跨块续接的完整行只有一个 abs', () => {
    const buf = new PerceptionBuffer()
    const p = new AnsiStreamParser()
    buf.appendLines(p.write('杀气逼人'))
    buf.appendLines(p.write('向你扑来！\r\n'))
    expect(buf.entries.length).toBe(1)
    expect(buf.entries[0]?.row.text).toBe('杀气逼人向你扑来！')
    expect(buf.entries[0]?.row.abs).toBe(0)
    expect(buf.nextAbs).toBe(1)
  })

  it('多行规则可横跨 TCP 块命中 (不再被切碎)', () => {
    const buf = new PerceptionBuffer()
    const p = new AnsiStreamParser()
    buf.appendLines(p.write('你大喝一声'))
    buf.appendLines(p.write('。\n'))
    const perceptor = new Perceptor()
    perceptor.register({ id: 'combat:start', eventType: 'p:combat:start', contains: ['大喝一声'] })
    const hit = perceptor.match(buf.snapshot())[0]
    expect(hit?.id).toBe('combat:start')
    expect(hit?.lineNumber).toBe(0)
  })

  it('颜色触发数据就绪: style 携带颜色供 Phase 2 匹配', () => {
    const buf = new PerceptionBuffer()
    const p = new AnsiStreamParser()
    buf.appendLines(p.write('\x1b[32m绿色的字\x1b[0m\n'))
    const row = buf.entries[0]?.row
    if (!row) throw new Error('missing row')
    expect(row.text).toBe('绿色的字')
    expect(row.style).toEqual([
      { start: 0, end: 4, fg: 2, bg: null, fgTrue: null, bgTrue: null, flags: 0 },
    ])
  })

  it('world 状态经感知管线照常更新', () => {
    const world = createWorld()
    const buf = new PerceptionBuffer()
    const perceptor = new Perceptor()
    perceptor.register({ id: 'login:done', eventType: 'p:login:done', regex: [/欢迎/] })
    const applied: Array<Record<string, unknown>> = []
    const tracker = new StateTracker({
      world,
      buffer: buf,
      perceptor,
      emit: (_hit, patch) => { if (Object.keys(patch).length > 0) applied.push(patch) },
    })
    const p = new AnsiStreamParser()
    buf.appendLines(p.write('欢迎来到北大侠客行！\n'))
    tracker.onData()
    expect(flattenWorld(world)['flags.logged_in']).toBe(true)
    expect(applied.length).toBe(1)
  })
})

describe('性能冒烟', () => {
  it('5000 行带颜色解析: 完整产出且 text 无残留序列', () => {
    const p = new AnsiStreamParser()
    const chunk = Array.from(
      { length: 5000 },
      (_, i) => `\x1b[1;32m第${i + 1}行\x1b[0m文字内容\n`,
    ).join('')
    const lines = p.write(chunk)
    expect(lines.length).toBe(5000)
    expect(lines.every(l => !l.text.includes('\x1b'))).toBe(true)
    expect(lines.every(l => l.raw.includes('\x1b'))).toBe(true)
  })
})
