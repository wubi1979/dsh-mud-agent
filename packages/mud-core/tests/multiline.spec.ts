/**
 * dsh-mud-agent — 触发匹配回归测试:
 *   - 多行匹配状态机 (Mudlet 逐条件模型: 有序条件 / spacer / lineDelta 过期 /
 *     每行只喂一次);
 *   - 正则去 g 标志 (防 lastIndex 跨窗口错位);
 *   - bold→亮色耦合 (Mudlet TBuffer.cpp:1378 对齐)。
 */

import { describe, expect, it } from 'vitest'
import { Perceptor, type PerceptHit } from '../src/perception/triggers.ts'
import { StyleFlag, type ParsedLine, type StyleRun } from '../src/net/ansi.ts'
import { PerceptionBuffer, type MudLine } from '../src/perception/perception.ts'

function parsed(text: string, style: StyleRun[] = []): ParsedLine {
  return { text, raw: text, style, time: 0, isPrompt: false }
}

/**
 * 连续缓冲的喂行器 (模拟真实感知: abs 单调, 窗口逐次增大)。
 * 返回当前快照 (含历史行; 状态机用 multiLastAbs 自动去重, 每行只喂一次)。
 */
function makeFeed() {
  const buf = new PerceptionBuffer()
  return function feed(rows: ParsedLine[]): MudLine[] {
    buf.appendLines(rows)
    return buf.snapshot()
  }
}

describe('多行匹配状态机 (Mudlet 逐条件模型)', () => {
  it('有序条件: 跨多行依次匹配, 命中行 = 满足末条件的行', () => {
    const perceptor = new Perceptor()
    perceptor.register({
      id: 'ml', eventType: 'p:ml', multiline: true,
      patterns: [
        { kind: 'substring', text: 'BEGIN' },
        { kind: 'regex', regex: 'END' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('line1')])))
    all.push(...perceptor.match(feed([parsed('BEGIN thing')])))
    all.push(...perceptor.match(feed([parsed('line3')])))
    all.push(...perceptor.match(feed([parsed('END now')])))
    all.push(...perceptor.match(feed([parsed('tail')])))
    const hits = all.filter(h => h.id === 'ml')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(3)
  })

  it('窗口重复回传历史行不会重复播种/重复推进状态 (每行只喂一次)', () => {
    const perceptor = new Perceptor()
    perceptor.register({
      id: 'ml2', eventType: 'p:ml2', multiline: true,
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const buf = new PerceptionBuffer()
    buf.appendLines([parsed('A'), parsed('X')]) // abs 0,1
    let w = buf.snapshot()
    perceptor.match(w) // 播种 A (abs0); X 推进
    // 同样内容再回传 (游标未推进): A/X 已被喂过, 不应再播种/推进。
    const rehits = perceptor.match(w).filter(h => h.id === 'ml2')
    expect(rehits).toHaveLength(0)
    buf.appendLines([parsed('B')])              // abs 2
    w = buf.snapshot()
    const hits = perceptor.match(w).filter(h => h.id === 'ml2')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(2) // B 的 abs=2
  })

  it('spacer: 隔 N 行才匹配下一条件', () => {
    const perceptor = new Perceptor()
    perceptor.register({
      id: 'ml3', eventType: 'p:ml3', multiline: true,
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'spacer', lines: 1 },
        { kind: 'substring', text: 'B' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('A')])))
    all.push(...perceptor.match(feed([parsed('X')]))) // X 充当 spacer 的 1 行
    all.push(...perceptor.match(feed([parsed('B')])))
    const hits = all.filter(h => h.id === 'ml3')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(2)
  })

  it('lineDelta 过期: 间隔超限则不触发', () => {
    const perceptor = new Perceptor()
    perceptor.register({
      id: 'ml4', eventType: 'p:ml4', multiline: true, lineDelta: 2,
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('A')])))
    all.push(...perceptor.match(feed([parsed('x1')])))
    all.push(...perceptor.match(feed([parsed('x2')])))
    all.push(...perceptor.match(feed([parsed('x3')])))
    all.push(...perceptor.match(feed([parsed('B')])))
    // 状态超过 lineDelta=2 后已过期, A 不应当再与 B 触发。
    expect(all.filter(h => h.id === 'ml4')).toHaveLength(0)
  })

  it('contains+regex 派生为有序条件 (contains 在前)', () => {
    const perceptor = new Perceptor()
    perceptor.register({
      id: 'ml5', eventType: 'p:ml5', multiline: true,
      contains: ['出发'],
      regex: ['到达'],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('出发了')])))
    all.push(...perceptor.match(feed([parsed('到达!')])))
    const hits = all.filter(h => h.id === 'ml5')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(1)
  })
})

describe('正则去 g 标志', () => {
  function buffered(rows: ParsedLine[]): MudLine[] {
    const buf = new PerceptionBuffer()
    buf.appendLines(rows)
    return buf.snapshot()
  }

  it('全局正则跨窗口重复匹配不因 lastIndex 错位', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'g1', eventType: 'p:g1', regex: [/foo/g] })
    expect(perceptor.match(buffered([parsed('foo')])).map(h => h.id)).toEqual(['g1'])
    // 同一行再喂一次 — 仍应命中, 不被 lastIndex 卡住。
    expect(perceptor.match(buffered([parsed('foo')])).map(h => h.id)).toEqual(['g1'])
  })

  it('contains+regex 混合: 快路径仍生效', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'g2', eventType: 'p:g2', contains: ['hello'], regex: [/world/g] })
    expect(perceptor.match(buffered([parsed('hello world')])).map(h => h.id)).toEqual(['g2'])
  })
})

describe('bold→亮色耦合 (Mudlet 对齐)', () => {
  function buffered(rows: ParsedLine[]): MudLine[] {
    const buf = new PerceptionBuffer()
    buf.appendLines(rows)
    return buf.snapshot()
  }

  it('bold 的暗色前景按亮色变体命中', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'b1', eventType: 'p:b1', fg: 15 }) // 亮白
    const boldDark = parsed('亮白字', [{ start: 0, end: 3, fg: 7, bg: null, fgTrue: null, bgTrue: null, flags: StyleFlag.Bold }])
    expect(perceptor.match(buffered([boldDark])).map(h => h.id)).toEqual(['b1'])
  })

  it('非 bold 的暗色前景不命中亮色条件', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'b2', eventType: 'p:b2', fg: 15 })
    const dark = parsed('暗白字', [{ start: 0, end: 3, fg: 7, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
    expect(perceptor.match(buffered([dark])).length).toBe(0)
  })
})
