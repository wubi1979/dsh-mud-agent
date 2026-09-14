/**
 * dsh-mud-core — L1 行级感知引擎 + L2 单流切分 (V10 W1/W2)。
 *
 * 覆盖 `doc/ARCHITECTURE.md` §4/§5 的核心契约:
 *   - 行级判定与文本块/截断无关 (I7); 多行状态在引擎内跨块持久;
 *   - 每会话一实例 (I8): 两个引擎的运行态互不影响;
 *   - 消费边界 = 最后一次带动作命中的锚点;
 *   - 单流切分不变量 (I5): 反射段 + 遗留段 == 原序列, 且历次投递拼接 == 完整流。
 */

import { describe, expect, it } from 'vitest'
import { PerceptionEngine } from '../src/perceive/engine.ts'
import { splitDelivery } from '../src/perceive/split.ts'
import type { MudLine } from '../src/services/network/ansi.ts'
import type { PerceptionRule } from '../src/trigger-llm/types.ts'

/** MudLine 构造 (abs 单调)。 */
function line(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: 0, isPrompt: false }
}

/** 单行正则规则 (命中即带动作)。 */
function rule(id: string, pattern: RegExp, output = id): PerceptionRule {
  return {
    id,
    eventType: `p:${id}`,
    match: { kind: 'regex', patterns: [pattern] },
    action: { output, tool: { name: 'mud_send', args: { cmd: id } } },
  }
}

/** 两条件多行规则。 */
function multiRule(id: string): PerceptionRule {
  return {
    id,
    eventType: `p:${id}`,
    multiline: true,
    match: { kind: 'regex', patterns: [] },
    patterns: [
      { kind: 'substring', text: 'OPEN' },
      { kind: 'substring', text: 'DONE' },
    ],
    action: { output: id },
  }
}

const NO_HOLD: ReadonlySet<string> = new Set<string>()

describe('PerceptionEngine (L1)', () => {
  it('命中带动作 → 入队并给出消费边界 (最后一次命中的锚点)', () => {
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [rule('a', /^甲$/), rule('b', /^乙$/)],
      holdRuleIds: NO_HOLD,
    })

    const result = engine.feed([line('甲', 0), line('无关', 1), line('乙', 2)])

    expect(result.hits.map(h => h.ruleId)).toEqual(['a', 'b'])
    expect(result.consumeTo).toBe(2)
    expect(result.holding).toBe(false)
  })

  it('无命中 → consumeTo = -1, hits 为空', () => {
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [rule('a', /^甲$/)],
      holdRuleIds: NO_HOLD,
    })

    const result = engine.feed([line('无关', 0)])
    expect(result.hits).toEqual([])
    expect(result.consumeTo).toBe(-1)
  })

  it('无动作命中不入队 (不构成消费边界)', () => {
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [{
        id: 'info',
        eventType: 'p:info',
        match: { kind: 'regex', patterns: [/^信息$/] },
        // 无 action
      }],
      holdRuleIds: NO_HOLD,
    })

    const result = engine.feed([line('信息', 0)])
    expect(result.allHits.map(h => h.id)).toEqual(['info'])
    expect(result.hits).toEqual([])
    expect(result.consumeTo).toBe(-1)
  })

  it('state 桶折叠: 折叠行 abs 上报, 且事件规则仍能看到原始行 (命中不因折叠丢失)', () => {
    const engine = new PerceptionEngine({
      stateRules: [{
        id: 'state:hp',
        lane: 'state',
        // 命名捕获组 → map 组装 data (位置捕获组不产生 data)。
        match: { kind: 'regex', patterns: [/^气血 (?<hp>\d+)\/(?<maxhp>\d+)$/] },
        map: { hp: 'hp.cur', maxhp: 'hp.max' },
      }],
      eventRules: [rule('low-hp', /^气血 (\d+)\/(\d+)$/, '气血告急')],
      holdRuleIds: NO_HOLD,
    })

    const result = engine.feed([line('气血 10/100', 0)])

    expect([...result.foldedAbs]).toEqual([0])
    expect(result.stateHits.map(h => h.id)).toEqual(['state:hp'])
    expect(result.stateHits[0]?.data).toEqual({ 'hp.cur': '10', 'hp.max': '100' })
    // 同一行既被折叠, 又能触发事件规则 (L1 按原始行判定)。
    expect(result.hits.map(h => h.ruleId)).toEqual(['low-hp'])
    expect(result.consumeTo).toBe(0)
  })

  it('直接执行动作 (direct): 命中进 directHits 并折叠锚点行, 不进渲染队列也不设消费边界', () => {
    const direct: PerceptionRule = {
      id: 'save:prompt',
      eventType: 'p:save',
      match: { kind: 'regex', patterns: [/^请保存档案$/] },
      action: { output: '保存', tool: { name: 'mud_send', args: { cmd: 'save' } }, direct: true },
    }
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [direct, rule('other', /^请保存档案$/, '别的')],
      holdRuleIds: NO_HOLD,
    })

    const result = engine.feed([line('请保存档案', 0)])

    // 直接执行: 动作由运行时执行 → 命中只在 directHits 里, 且锚点行折叠 (不进 agent)。
    expect(result.directHits.map(h => h.ruleId)).toEqual(['save:prompt'])
    expect([...result.foldedAbs]).toEqual([0])
    expect(result.hits.map(h => h.ruleId)).toEqual(['other'])
    // 折叠行不参与单流切分 → 只有非 direct 命中构成消费边界。
    expect(result.consumeTo).toBe(0)
    expect(result.allHits.map(h => h.id)).toEqual(['save:prompt', 'other'])
  })

  it('多行状态跨文本块持久: 捕获在后续块完成', () => {
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [multiRule('ml')],
      holdRuleIds: NO_HOLD,
    })

    expect(engine.feed([line('OPEN now', 0)]).hits).toEqual([])
    expect(engine.feed([line('mid', 1)]).hits).toEqual([])
    const done = engine.feed([line('DONE now', 2)])
    expect(done.hits.map(h => h.ruleId)).toEqual(['ml'])
    expect(done.consumeTo).toBe(2)
  })

  it('holdDelivery: 半截捕获 → holding=true; 完成块 → 命中且 holding=false', () => {
    const holdRule: PerceptionRule = {
      id: 'hold',
      eventType: 'p:hold',
      multiline: true,
      holdDelivery: true,
      match: { kind: 'regex', patterns: [] },
      patterns: [
        { kind: 'substring', text: '是否替换' },
        { kind: 'substring', text: '(y/n)' },
      ],
      action: { output: '确认' },
    }
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [holdRule],
      holdRuleIds: new Set(['hold']),
    })

    const partial = engine.feed([line('已有同名用户存在，是否替换人物', 0)])
    expect(partial.hits).toEqual([])
    expect(partial.holding).toBe(true)

    const complete = engine.feed([line('(y/n)？', 1)])
    expect(complete.hits.map(h => h.ruleId)).toEqual(['hold'])
    expect(complete.holding).toBe(false)
  })

  it('每会话一实例: 两个引擎的多行运行态互不影响 (I8)', () => {
    const mk = (): PerceptionEngine => new PerceptionEngine({
      stateRules: [],
      eventRules: [multiRule('ml')],
      holdRuleIds: NO_HOLD,
    })
    const a = mk()
    const b = mk()

    a.feed([line('OPEN', 0)])
    // b 未喂 OPEN: 只喂 DONE 不应命中 (状态未跨实例共享)。
    expect(b.feed([line('DONE', 0)]).hits).toEqual([])
    expect(a.feed([line('DONE', 1)]).hits.map(h => h.ruleId)).toEqual(['ml'])
  })

  it('reset: 清空多行捕获 (断线重建语境的依据)', () => {
    const engine = new PerceptionEngine({
      stateRules: [],
      eventRules: [multiRule('ml')],
      holdRuleIds: NO_HOLD,
    })

    engine.feed([line('OPEN', 0)])
    engine.reset()
    expect(engine.feed([line('DONE', 1)]).hits).toEqual([])
  })
})

describe('splitDelivery (L2 单流切分)', () => {
  it('有命中: 消费段与遗留段按消费边界切分', () => {
    const pending = [line('一', 0), line('二', 1), line('三', 2), line('四', 3)]
    const { reflex, carry } = splitDelivery(pending, 1)
    expect(reflex.map(l => l.text)).toEqual(['一', '二'])
    expect(carry.map(l => l.text)).toEqual(['三', '四'])
  })

  it('无命中 (consumeTo=-1): 全部进遗留段, 反射段为空', () => {
    const pending = [line('一', 0), line('二', 1)]
    const { reflex, carry } = splitDelivery(pending, -1)
    expect(reflex).toEqual([])
    expect(carry.map(l => l.text)).toEqual(['一', '二'])
  })

  it('不变量 (I5): 多块多轮投递, 拼接所有投递体 == 完整入站流 (不重不漏、顺序不变)', () => {
    // 模拟运行时: 每块行进待决; 结算时按 consumeTo 切分; 有命中则投反射段, 否则投整段。
    let pending: MudLine[] = []
    let consumeTo = -1
    const delivered: string[] = []
    const all: string[] = []

    const settle = (hasHits: boolean): void => {
      if (pending.length === 0) return
      const { reflex, carry } = splitDelivery(pending, consumeTo)
      if (hasHits && reflex.length > 0) {
        delivered.push(...reflex.map(l => l.text))
        pending = carry
        consumeTo = -1
        return
      }
      delivered.push(...pending.map(l => l.text))
      pending = []
      consumeTo = -1
    }

    /** 一块文本: 若无主则进待决; 返回本块是否有命中。 */
    const block = (texts: string[], hitAnchorAbs: number): boolean => {
      const base = all.length
      const rows = texts.map((t, i) => line(t, base + i))
      all.push(...texts)
      pending.push(...rows)
      if (hitAnchorAbs >= 0) {
        consumeTo = Math.max(consumeTo, hitAnchorAbs)
        return true
      }
      return false
    }

    // 块 1: 5 行, 命中第 3 行 (abs=2) → 反射 0..2, 遗留 3..4
    settle(block(['a0', 'a1', 'a2', 'a3', 'a4'], 2))
    // 块 2: 3 行 (abs 5..7), 无命中 → 遗留 3..4 + 5..7 一起作为批次投出
    settle(block(['b0', 'b1', 'b2'], -1))
    // 块 3: 2 行 (abs 8..9), 命中第 2 行 (abs=9) → 反射 8..9
    settle(block(['c0', 'c1'], 9))
    // 块 4: 1 行 (abs 10), 无命中 → 作为批次
    settle(block(['d0'], -1))

    expect(delivered).toEqual(all)
    expect(pending).toEqual([])
  })
})
