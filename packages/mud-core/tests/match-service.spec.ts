/**
 * dsh-mud-core 匹配服务 (TriggerMatchService) 双桶测试 — v6.2/v6.5。
 *
 * 验证:
 *   - state/event 两个实例独立 (规则集不串、多行上下文不串);
 *   - v6.5: 锚定整行正则准入, 命名捕获组 + map/numeric 组装 data, extract 逃生舱。
 */

import { describe, expect, it } from 'vitest'
import { TriggerMatchService } from '../src/trigger-llm/service.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

function toLines(rows: string[]): MudLine[] {
  return rows.map((t, i) => ({
    text: t, raw: t, style: [], abs: i, time: Date.now(), isPrompt: false,
  }))
}

/** 单调 abs 喂行器 (模拟 AnsiStreamParser: 跨调用 abs 递增)。 */
function makeFeed() {
  let abs = 0
  return (rows: string[]): MudLine[] => rows.map(t => ({
    text: t, raw: t, style: [], abs: abs++, time: Date.now(), isPrompt: false,
  }))
}

describe('TriggerMatchService 双桶 (state / event)', () => {
  it('独立实例规则集不串: state 规则不影响 event 匹配', () => {
    const state = new TriggerMatchService([
      { id: 'state:hp', eventType: 'p:hp', regex: [/气血/], extract: () => ({ 'char.hp': 1 }) },
    ], 'state')
    const event = new TriggerMatchService([
      { id: 'combat:start', eventType: 'p:combat:start', regex: [/向你扑来/] },
    ], 'event')

    const stateHits = state.match(toLines(['【 气血 】 100 / 100']))
    expect(stateHits.map(h => h.id)).toEqual(['state:hp'])
    expect(stateHits[0]?.data).toEqual({ 'char.hp': 1 })

    // event 实例看不到 state 规则。
    expect(event.match(toLines(['【 气血 】 100 / 100']))).toHaveLength(0)
  })

  it('多行上下文独立: 两个实例各自维护 multiStates (不互相推进)', () => {
    const mkRule = (id: string) => ({
      id, eventType: id, multiline: true,
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const a = new TriggerMatchService([mkRule('ml-a')])
    const b = new TriggerMatchService([mkRule('ml-b')])
    const feedA = makeFeed()
    const feedB = makeFeed()

    // 只给 A 播种第一条件 "A"; B 从未见过 "A"。
    a.match(feedA(['A']))

    // B 直接喂 "B" (第二条件): 不应因 A 的状态而命中。
    expect(b.match(feedB(['B']))).toHaveLength(0)

    // A 喂 "B" 完成自己的规则 (状态在 A 实例内, 独立推进)。
    const aHit = a.match(feedA(['B']))
    expect(aHit.map(h => h.id)).toEqual(['ml-a'])
  })

  it('resetContext: 清空多行状态机', () => {
    const service = new TriggerMatchService([{
      id: 'ml', eventType: 'ml', multiline: true,
      patterns: [{ kind: 'substring', text: 'A' }, { kind: 'substring', text: 'B' }],
    }])
    const feed = makeFeed()
    service.match(feed(['A']))
    service.resetContext()
    // 状态已清: 只喂 B 不再命中。
    expect(service.match(feed(['B']))).toHaveLength(0)
  })
})

describe('v6.5 锚定整行 + 捕获组提取', () => {
  it('锚定首尾: 整行相等命中; 聊天嵌词/首尾多字不命中', () => {
    const s = new TriggerMatchService([{
      id: 'login:name', eventType: 'p:login:name',
      regex: [/^您的英文名字（要注册新人物请输入new。）：$/],
    }])
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：']))).toHaveLength(1)
    // 聊天/帮助文本中嵌入该词 → 首尾任一不满足 → 不触发。
    expect(s.match(toLines(['张三说你得去注册处填你的英文名字。']))).toHaveLength(0)
    expect(s.match(toLines(['help 提到 注册新人物请输入new 相关内容。']))).toHaveLength(0)
    // 整行以提示开头但后面还有字 → $ 锚定拒绝。
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：请稍候。']))).toHaveLength(0)
  })

  it('纯字面量无锚正则: 子串命中原样保持 (作者后续自行加锚)', () => {
    const s = new TriggerMatchService([{ id: 'r', eventType: 'p:r', regex: [/命中/] }])
    expect(s.match(toLines(['剑法命中要害！']))).toHaveLength(1)
  })

  it('命名捕获组 + map/numeric 组装 data (千分位去逗号)', () => {
    const s = new TriggerMatchService([{
      id: 'state:hp', lane: 'state', eventType: 'p:hp',
      regex: [/^【\s*气血\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
      map: { cur: 'char.hp', max: 'char.maxhp' },
      numeric: ['cur', 'max'],
    }])
    const hits = s.match(toLines(['【 气血 】  12,345 / 12,345']))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.data).toEqual({ 'char.hp': 12345, 'char.maxhp': 12345 })
  })

  it('extract 逃生舱覆盖捕获组 (二次颜色等复杂提取)', () => {
    const s = new TriggerMatchService([{
      id: 'x', eventType: 'p:x', regex: [/^特殊行$/],
      extract: () => ({ mode: 'escape' }),
    }])
    expect(s.match(toLines(['特殊行']))[0]?.data).toEqual({ mode: 'escape' })
  })

  it('无 map 的 event 命中 data 为 null (纯 action)', () => {
    const s = new TriggerMatchService([{
      id: 'combat:start', eventType: 'p:combat:start', regex: [/^[^]*向你扑来[^]*$/],
      action: { output: '战斗开始' },
    }])
    const hit = s.match(toLines(['怪物向你扑来！']))[0]
    expect(hit?.data).toBeNull()
    expect(hit?.action?.output).toBe('战斗开始')
  })

  it('multiline 捕获组合并: 各条件命名组 → map', () => {
    const s = new TriggerMatchService([{
      id: 'ml', eventType: 'ml', multiline: true,
      regex: [/^A(?<x>\d+)$/, /^B(?<y>\d+)$/],
      map: { x: 'a', y: 'b' },
    }])
    const feed = makeFeed()
    s.match(feed(['A1']))
    const hits = s.match(feed(['B2']))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.data).toEqual({ a: '1', b: '2' })
  })

  it('预筛超集不变式: seed 命中而正则不命中 → 不触发; 正则可能命中的行必过 seed', () => {
    const s = new TriggerMatchService([{
      id: 'login:name', eventType: 'p:login:name',
      regex: [/^您的英文名字（要注册新人物请输入new。）：$/],
    }])
    // seed (前缀) 命中但 $ 不满足 → 预筛放行、二级拒绝。
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：X']))).toHaveLength(0)
    // seed 不命中的行绝不可能命中锚定正则 → 预筛选跳。
    expect(s.match(toLines(['完全不相关的聊天。']))).toHaveLength(0)
  })
})