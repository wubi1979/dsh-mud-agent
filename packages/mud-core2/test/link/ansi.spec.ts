/**
 * link/ansi 回放测试 — 分行 / 跨块终止符（S1/S2）/ 颜色 / 序列缓冲上限。
 *
 * 语料沿自 mud-core 实录验证过的测试集（语料是数据，直接复用）：
 * 跨块行尾续接、CRLF 落两块、flushLine 后补发行尾、abs 单调、64KB 序列上限。
 */

import { describe, expect, it } from 'vitest'
import { AnsiStreamParser, stripAnsi, isPromptText, MAX_SEQUENCE_BUF } from '../../src/link/ansi.ts'

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

  it('跨块行尾续接: 不加换行不产出, 续块合并为同一行 (实录: 杀气逼人/向你扑来)', () => {
    const p = new AnsiStreamParser()
    expect(p.write('杀气逼人')).toEqual([])
    expect(p.pending).toBe(true)
    const lines = p.write('向你扑来！\r\n')
    expect(lines.length).toBe(1)
    expect(lines[0]?.text).toBe('杀气逼人向你扑来！')
  })
})

describe('跨块终止符 (S1/S2)', () => {
  it('S1: \\r 落块尾 + \\n 落块头 ⇒ 不产空行, abs 连续', () => {
    const p = new AnsiStreamParser()
    expect(p.write('你好\r').map(l => [l.abs, l.text])).toEqual([[0, '你好']])
    expect(p.write('\n世界\r\n').map(l => [l.abs, l.text])).toEqual([[1, '世界']])
  })

  it('S1: \\r 落块尾 + 下一块直接是文本', () => {
    const p = new AnsiStreamParser()
    expect(p.write('a\r').map(l => l.text)).toEqual(['a'])
    expect(p.write('b\r\n').map(l => l.text)).toEqual(['b'])
  })

  it('S1: 真正的空行跨块仍然保留 (a\\r\\n | \\r\\nb)', () => {
    const p = new AnsiStreamParser()
    expect(p.write('a\r\n').map(l => l.text)).toEqual(['a'])
    expect(p.write('\r\nb').map(l => l.text)).toEqual([''])
    expect(p.flush()?.text).toBe('b')
  })

  it('S1: \\r\\r 是两个终止符 ⇒ 恰好一个空行 (不吞也不多)', () => {
    const p = new AnsiStreamParser()
    expect(p.write('a\r').map(l => l.text)).toEqual(['a'])
    expect(p.write('\r\nb').map(l => l.text)).toEqual([''])
  })

  it('S2: flushLine 刷出的行, 随后补发的 \\r\\n 不再产出空行', () => {
    const p = new AnsiStreamParser()
    expect(p.write('提示符>')).toEqual([])
    expect(p.flushLine()?.text).toBe('提示符>')
    expect(p.write('\r\n')).toEqual([])
    expect(p.write('下一行\r\n').map(l => [l.abs, l.text])).toEqual([[1, '下一行']])
  })

  it('S2: 裸 \\n 与直接跟文本都正确处理', () => {
    const bare = new AnsiStreamParser()
    bare.write('提示符>')
    bare.flushLine()
    expect(bare.write('\n')).toEqual([])

    const text = new AnsiStreamParser()
    text.write('提示符>')
    text.flushLine()
    expect(text.write('结尾\r\n').map(l => l.text)).toEqual(['结尾'])
  })

  it('S2: 空刷 (无可刷内容) 不得吃掉服务器真发的空白行', () => {
    const p = new AnsiStreamParser()
    expect(p.write('a\r\n').map(l => l.text)).toEqual(['a'])
    expect(p.flushLine()).toBeNull()
    expect(p.write('\r\n').map(l => l.text)).toEqual([''])
  })
})

describe('颜色解析 (style run)', () => {
  it('16 色: 前景色 run 坐标对齐 text', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b[31m红\x1b[0m白\n')
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

  it('同色重新设置合并为一段 (移植)', () => {
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

describe('abs 行号空间 (连接级单调)', () => {
  it('reset / 空 flush 不复位 absSeq (GA 空刷不归零)', () => {
    const p = new AnsiStreamParser()
    const [first] = p.write('甲\n')
    expect(first?.abs).toBe(0)
    p.reset()
    const [second] = p.write('乙\n')
    expect(second?.abs).toBe(1)
    expect(p.flush()).toBeNull()
    const [third] = p.write('丙\n')
    expect(third?.abs).toBe(2)
  })

  it('有滞留片断的 flush 提交行后 abs 续接 (移植)', () => {
    const p = new AnsiStreamParser()
    p.write('甲\n')
    p.write('提示符')
    const tail = p.flush()
    expect(tail?.text).toBe('提示符')
    expect(tail?.abs).toBe(1)
    const [next] = p.write('乙\n')
    expect(next?.abs).toBe(2)
  })
})

describe('OSC / 转义', () => {
  it('OSC BEL 终止不进入 text', () => {
    const p = new AnsiStreamParser()
    const [line] = p.write('\x1b]0;我的标题\x07内容\n')
    expect(line?.text).toBe('内容')
  })

  it('OSC 以 ST (ESC\\) 终止 (移植)', () => {
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

describe('转义序列缓冲上限 (64KB, 内存有界)', () => {
  it('超长未终止 CSI: 缓冲有界, 终止符到达后文本恢复可见', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b[' + '1'.repeat(MAX_SEQUENCE_BUF + 512))
    const probe = p as unknown as { csiBuf: string, raw: string[] }
    expect(probe.csiBuf.length).toBeLessThanOrEqual(MAX_SEQUENCE_BUF)
    expect(probe.raw.join('').length).toBeLessThanOrEqual(MAX_SEQUENCE_BUF + 16)
    const lines = p.write('m欢迎光临\r\n')
    expect(lines.map(l => l.text)).toEqual(['欢迎光临'])
  })

  it('超长未终止 OSC: oscBuf 有界, BEL 终止后恢复可见', () => {
    const p = new AnsiStreamParser()
    p.write('\x1b]' + '0'.repeat(MAX_SEQUENCE_BUF + 512))
    const probe = p as unknown as { oscBuf: string, raw: string[] }
    expect(probe.oscBuf.length).toBeLessThanOrEqual(MAX_SEQUENCE_BUF)
    const lines = p.write('\x07恢复可见\r\n')
    expect(lines.map(l => l.text)).toEqual(['恢复可见'])
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
  })
})
