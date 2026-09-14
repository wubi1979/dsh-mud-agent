/**
 * dsh-mud-agent — 触发匹配回归测试 (v6: 触发匹配器迁入 trigger-llm/service):
 *   - 多行匹配状态机 (Mudlet 逐条件模型: 有序条件 / spacer / lineDelta 过期 /
 *     每行只喂一次);
 *   - 正则去 g 标志 (防 lastIndex 跨窗口错位);
 *   - bold→亮色耦合 (Mudlet TBuffer.cpp:1378 对齐)。
 */

import { describe, expect, it } from 'vitest'
import { Perceptor, type PerceptHit, TriggerMatchService } from '../src/trigger-llm/service.ts'
import { createMatchContext, type MatchContext } from '../src/trigger-llm/types.ts'
import { StyleFlag, type ParsedLine, type StyleRun, type MudLine } from '../src/services/network/ansi.ts'

function parsed(text: string, style: StyleRun[] = []): ParsedLine {
  return { text, raw: text, style, time: 0, isPrompt: false }
}

/**
 * 连续缓冲的喂行器 (模拟真实感知: abs 单调, 窗口逐次增大)。
 * 返回当前快照 (含历史行; 状态机用 multiLastAbs 自动去重, 每行只喂一次)。
 */
function makeFeed() {
  let nextAbs = 0
  const history: MudLine[] = []
  return function feed(rows: ParsedLine[]): MudLine[] {
    for (const r of rows) {
      history.push({
        text: r.text,
        raw: r.raw,
        style: r.style,
        abs: nextAbs,
        time: r.time,
        isPrompt: r.isPrompt,
      })
      nextAbs += 1
    }
    return history.slice()
  }
}

describe('多行匹配状态机 (Mudlet 逐条件模型)', () => {
  it('有序条件: 跨多行依次匹配, 命中行 = 满足末条件的行', () => {
    const perceptor = new Perceptor()
    const ctx = createMatchContext()
    perceptor.register({
      id: 'ml', eventType: 'p:ml', multiline: true,
      match: { kind: 'regex', patterns: [] }, // 逐行条件全部来自 patterns (MultiCond)
      patterns: [
        { kind: 'substring', text: 'BEGIN' },
        { kind: 'regex', regex: 'END' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('line1')]), ctx))
    all.push(...perceptor.match(feed([parsed('BEGIN thing')]), ctx))
    all.push(...perceptor.match(feed([parsed('line3')]), ctx))
    all.push(...perceptor.match(feed([parsed('END now')]), ctx))
    all.push(...perceptor.match(feed([parsed('tail')]), ctx))
    const hits = all.filter(h => h.id === 'ml')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(3)
  })

  it('窗口重复回传历史行不会重复播种/重复推进状态 (每行只喂一次)', () => {
    const perceptor = new Perceptor()
    const ctx = createMatchContext()
    perceptor.register({
      id: 'ml2', eventType: 'p:ml2', multiline: true,
      match: { kind: 'regex', patterns: [] },
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const feed = makeFeed()
    let w = feed([parsed('A'), parsed('X')]) // abs 0,1
    perceptor.match(w, ctx) // 播种 A (abs0); X 推进
    // 同样内容再回传 (游标未推进): A/X 已被喂过, 不应再播种/推进。
    const rehits = perceptor.match(w, ctx).filter(h => h.id === 'ml2')
    expect(rehits).toHaveLength(0)
    w = feed([parsed('B')]) // abs 2
    const hits = perceptor.match(w, ctx).filter(h => h.id === 'ml2')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(2) // B 的 abs=2
  })

  it('spacer: 隔 N 行才匹配下一条件', () => {
    const perceptor = new Perceptor()
    const ctx = createMatchContext()
    perceptor.register({
      id: 'ml3', eventType: 'p:ml3', multiline: true,
      match: { kind: 'regex', patterns: [] },
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'spacer', lines: 1 },
        { kind: 'substring', text: 'B' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('A')]), ctx))
    all.push(...perceptor.match(feed([parsed('X')]), ctx)) // X 充当 spacer 的 1 行
    all.push(...perceptor.match(feed([parsed('B')]), ctx))
    const hits = all.filter(h => h.id === 'ml3')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(2)
  })

  it('lineDelta 过期: 间隔超限则不触发', () => {
    const perceptor = new Perceptor()
    const ctx = createMatchContext()
    perceptor.register({
      id: 'ml4', eventType: 'p:ml4', multiline: true, lineDelta: 2,
      match: { kind: 'regex', patterns: [] },
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('A')]), ctx))
    all.push(...perceptor.match(feed([parsed('x1')]), ctx))
    all.push(...perceptor.match(feed([parsed('x2')]), ctx))
    all.push(...perceptor.match(feed([parsed('x3')]), ctx))
    all.push(...perceptor.match(feed([parsed('B')]), ctx))
    // 状态超过 lineDelta=2 后已过期, A 不应当再与 B 触发。
    expect(all.filter(h => h.id === 'ml4')).toHaveLength(0)
  })

  it('regex 派生为有序条件 (patterns 优先)', () => {
    const perceptor = new Perceptor()
    const ctx = createMatchContext()
    perceptor.register({
      id: 'ml5', eventType: 'p:ml5', multiline: true,
      match: { kind: 'regex', patterns: ['出发', '到达'] },
    })
    const feed = makeFeed()
    const all: PerceptHit[] = []
    all.push(...perceptor.match(feed([parsed('出发了')]), ctx))
    all.push(...perceptor.match(feed([parsed('到达!')]), ctx))
    const hits = all.filter(h => h.id === 'ml5')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.lineNumber).toBe(1)
  })
})

describe('正则去 g 标志', () => {
  function buffered(rows: ParsedLine[]): MudLine[] {
    return toRows(rows)
  }

  it('全局正则跨窗口重复匹配不因 lastIndex 错位', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'g1', eventType: 'p:g1', match: { kind: 'regex', patterns: [/foo/g] } })
    expect(perceptor.match(buffered([parsed('foo')]), createMatchContext()).map(h => h.id)).toEqual(['g1'])
    // 同一行再喂一次 — 仍应命中, 不被 lastIndex 卡住。
    expect(perceptor.match(buffered([parsed('foo')]), createMatchContext()).map(h => h.id)).toEqual(['g1'])
  })

  it('regex 列表混合: 快路径仍生效', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'g2', eventType: 'p:g2', match: { kind: 'regex', patterns: [/hello/, /world/g] } })
    expect(perceptor.match(buffered([parsed('hello world')]), createMatchContext()).map(h => h.id)).toEqual(['g2'])
  })
})

describe('bold→亮色耦合 (Mudlet 对齐)', () => {
  function buffered(rows: ParsedLine[]): MudLine[] {
    return toRows(rows)
  }

  it('bold 的暗色前景按亮色变体命中', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'b1', eventType: 'p:b1', match: { kind: 'func', test: () => true }, fg: 15 }) // 亮白
    const boldDark = parsed('亮白字', [{ start: 0, end: 3, fg: 7, bg: null, fgTrue: null, bgTrue: null, flags: StyleFlag.Bold }])
    expect(perceptor.match(buffered([boldDark]), createMatchContext()).map(h => h.id)).toEqual(['b1'])
  })

  it('非 bold 的暗色前景不命中亮色条件', () => {
    const perceptor = new Perceptor()
    perceptor.register({ id: 'b2', eventType: 'p:b2', match: { kind: 'func', test: () => true }, fg: 15 })
    const dark = parsed('暗白字', [{ start: 0, end: 3, fg: 7, bg: null, fgTrue: null, bgTrue: null, flags: 0 }])
    expect(perceptor.match(buffered([dark]), createMatchContext()).length).toBe(0)
  })
})

describe('多行状态持久 (V10: 判类与渲染合流, 无镜像克隆)', () => {
  /** 两条件多行规则 (逐条件消费行)。 */
  const makeService = (): TriggerMatchService => new TriggerMatchService([{
    id: 'ml:persist',
    eventType: 'p:persist',
    multiline: true,
    match: { kind: 'regex', patterns: [] },
    patterns: [
      { kind: 'substring', text: 'OPEN' },
      { kind: 'substring', text: 'DONE' },
    ],
    action: { output: '多行命中' },
  }])

  it('状态跨文本块持久: 捕获在后续块完成 (跨窗口不再丢命中)', () => {
    const svc = makeService()
    const l1 = toRows([parsed('OPEN now')]).map((r, i) => ({ ...r, abs: i }))
    const l2 = toRows([parsed('mid')]).map((r, i) => ({ ...r, abs: 1 + i }))
    const l3 = toRows([parsed('DONE now')]).map((r, i) => ({ ...r, abs: 2 + i }))

    expect(svc.match(l1).map(h => h.id)).not.toContain('ml:persist')
    expect(svc.match(l2).map(h => h.id)).not.toContain('ml:persist')
    // 第三块完成: 状态是第一块播种、第二块推进保留下来的。
    expect(svc.match(l3).some(h => h.id === 'ml:persist')).toBe(true)
  })

  it('resetContext: 清空半截捕获 (断线重建语境的依据)', () => {
    const svc = makeService()
    const l1 = toRows([parsed('OPEN now')]).map((r, i) => ({ ...r, abs: i }))
    const l2 = toRows([parsed('DONE now')]).map((r, i) => ({ ...r, abs: 1 + i }))

    svc.match(l1)
    expect(svc.hasPendingCapture(new Set(['ml:persist']))).toBe(true)
    svc.resetContext()
    expect(svc.hasPendingCapture(new Set(['ml:persist']))).toBe(false)
    // 清空后只喂 DONE: 无播种 → 不命中。
    expect(svc.match(l2).map(h => h.id)).not.toContain('ml:persist')
  })
})

describe('hasPendingCapture — holdDelivery 判据', () => {
  /** 声明 holdDelivery 的两条件规则 (login:replace-confirm 同形)。 */
  const makeService = (): TriggerMatchService => new TriggerMatchService([{
    id: 'hold:confirm',
    eventType: 'p:hold',
    multiline: true,
    holdDelivery: true,
    match: { kind: 'regex', patterns: [] },
    patterns: [
      { kind: 'substring', text: '是否替换' },
      { kind: 'substring', text: '(y/n)' },
    ],
    action: { output: '确认覆盖', tool: { name: 'mud_send', args: { cmd: 'y' } } },
  }])
  const HOLD_IDS = new Set(['hold:confirm'])

  it('半截捕获 (只满足首条件) → 无命中 + hasPendingCapture=true (投递方暂缓)', () => {
    const svc = makeService()
    const partial = toRows([parsed('已有同名用户存在，是否替换人物')]).map((r, i) => ({ ...r, abs: i }))

    expect(svc.match(partial)).toEqual([])
    expect(svc.hasPendingCapture(HOLD_IDS)).toBe(true)
  })

  it('两条件各占一行完成捕获 → 命中 + 无未完成捕获', () => {
    const svc = makeService()
    // 多行状态机逐条件消费行: 两条件 → 两行 (单行同时含两条件只算满足首条件)。
    const complete = toRows([parsed('已有同名用户存在，是否替换人物'), parsed('(y/n)？')])
      .map((r, i) => ({ ...r, abs: i }))

    expect(svc.match(complete).map(h => h.id)).toEqual(['hold:confirm'])
    expect(svc.hasPendingCapture(HOLD_IDS)).toBe(false)
  })

  it('空 id 集 → 恒 false (未声明 holdDelivery 的规则不参与)', () => {
    const svc = makeService()
    const partial = toRows([parsed('已有同名用户存在，是否替换人物')]).map((r, i) => ({ ...r, abs: i }))

    svc.match(partial)
    expect(svc.hasPendingCapture(new Set())).toBe(false)
    expect(svc.pendingCaptureCount()).toBe(1)
  })
})

function toRows(rows: ParsedLine[]): MudLine[] {
  return rows.map((r, i) => ({
    text: r.text,
    raw: r.raw,
    style: r.style,
    abs: i,
    time: r.time,
    isPrompt: r.isPrompt,
  }))
}