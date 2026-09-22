/**
 * dsh-mud-core — 表驱动"每条规则命中必被适配" (不变量 I4 / `doc/ARCHITECTURE.md` §13.2)。
 *
 * 目的不是再测一遍匹配器, 而是**锁住规则表与渲染链的一致性**: 规则表里新增一条
 * 规则, 若没人给它样本、或它的命中在 T1 渲染链上产不出动作, 这里就红。
 *
 * 每个规则一条 canonical 样本, 走真实链路:
 *   `PerceptionEngine.feed(样本)` (L1) → 命中 → `TriggerLlmAdapter` (L4)
 * 断言:
 *   - state 规则: 样本进 `stateHits` (落库路径存在);
 *   - event 规则: 样本进 `hits` 且带动作; 声明了 `action.tool` 的, 渲染出的
 *     tool-call 名字与参数与规则声明**逐字一致** (含 `{name}`/`{pass}` 占位符
 *     原样下发 — 插值责任在发送通道);
 *   - 样本表必须覆盖规则表 (新增规则未配样本 → 失败)。
 *
 * 样本是"规则意图的可读事实" (取自抓包实证或规则注释里的形态), 因此随规则改动
 * 一起改; 不放进生产规则对象, 避免把测试钩子塞进配置数据。
 */

import { describe, expect, it } from 'vitest'
import { createDefaultPerceptionRules } from '../src/perceive/rules.ts'
import { PerceptionEngine, splitPerceptionRules, type EngineHit } from '../src/perceive/engine.ts'
import type { MudLine } from '../src/network/ansi.ts'
import { ownedGameMessage } from '../src/deliver/lane.ts'
import { TriggerLlmAdapter } from '../src/agent/t1.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 每条规则的 canonical 样本 (行序列; 单行规则给一行)。 */
const SAMPLES: Record<string, readonly string[]> = {
  // ── state (状态抓取 → world; 独立桶, 不改行流) ──
  'state:hp': ['【 气血 】 100/200'],
  'state:exp': ['经验：1234'],
  'state:look': [
    '客栈 -',
    '     ┌─┐',
    '     │ │',
    '这里是客栈，来往的客人都在这里歇脚。',
    '',
    '这里明显的出口是 north 和 south。',
    '店小二(dian xiao er)',
  ],
  // ── event (T1 渲染) ──
  // fullme 已流程化 (`FULLME_FLOW`): 提醒句/地址/成功句/答错句都是流程步的判据,
  // 不再是规则 —— 样本随之移到 `tests/flow-fullme.spec.ts` 与 `tests/runtime-captcha.spec.ts`。
  'combat:start': ['野狗扑了上来，张嘴就咬。'],
  'combat:end': ['战斗结束。'],
  death: ['你死了。'],
  'save:prompt': ['建议经常使用save命令保存档案，避免造成意外损失。'],
  'pager:continue': ['== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)'],
}

/** MudLine 构造 (abs 单调)。 */
function linesOf(texts: readonly string[]): MudLine[] {
  return texts.map((text, i) => ({ text, raw: text, style: [], abs: i, time: 0, isPrompt: false }))
}

/** 只喂一条规则 (样本间互不干扰), 返回命中结果。 */
function feedOne(ruleId: string): {
  hits: readonly EngineHit[]
  directHits: readonly EngineHit[]
  stateIds: readonly string[]
  allIds: readonly string[]
} {
  const rule = createDefaultPerceptionRules().find(r => r.id === ruleId)
  if (rule === undefined) throw new Error(`样本引用了不存在的规则: ${ruleId}`)
  const isState = rule.lane === 'state'
  const engine = new PerceptionEngine({
    stateRules: isState ? [rule] : [],
    eventRules: isState ? [] : [rule],
    holdRuleIds: new Set<string>(),
  })
  const result = engine.feed(linesOf(SAMPLES[ruleId] as readonly string[]))
  return {
    hits: result.hits,
    directHits: result.directHits,
    stateIds: result.stateHits.map(h => h.id),
    allIds: result.allHits.map(h => h.id),
  }
}

/**
 * 每条规则的样本**只喂一次** (结果缓存, 纯为省时间)。
 *
 * 历史原因: `pager:continue` 的 guard 曾是**模块级**节流 (1s 内不重复翻页), 同一份样本
 * 在多个断言里各喂一次, 第二次必然不命中 —— 那是节流的行为, 不是规则的缺陷。
 * v0.11.2 起规则表按会话构造 (§1 I8), 每次 `feedOne` 拿到的都是全新的 guard 状态,
 * 该约束已消失; 缓存保留只为省时间。
 */
const feedCache = new Map<string, ReturnType<typeof feedOne>>()

function sampleHits(ruleId: string): ReturnType<typeof feedOne> {
  let cached = feedCache.get(ruleId)
  if (cached === undefined) {
    cached = feedOne(ruleId)
    feedCache.set(ruleId, cached)
  }
  return cached
}

/**
 * 把命中喂进真实 T1 适配器（v0.4.0 契约：投递消息自带动作请求），返回渲染出的 tool-call。
 * @param hits 规则命中（取其 action 作为动作请求）。
 * @returns 首个 tool-call 的 `{name, args}`；无则 null。
 */
async function renderFirstToolCall(hits: readonly EngineHit[]): Promise<{ name: string; args: string } | null> {
  const adapter = new TriggerLlmAdapter()
  const actions = hits
    .filter(hit => hit.action.tool !== undefined)
    .map(hit => ({
      ruleId: hit.ruleId,
      output: hit.action.output,
      tool: { name: hit.action.tool?.name ?? '', args: hit.action.tool?.args ?? {} },
    }))
  const options = {
    provider: 'mud-t1',
    model: 't1-local',
    sessionId: 's1',
    messages: [ownedGameMessage('样本', 't1', 's1', { actions, delivery: 'd1' })],
  } as unknown as GenerateOptions
  let call: { name: string; args: string } | null = null
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'tool-call-delta') call = { name: chunk.name, args: chunk.argumentsDelta }
  }
  return call
}

const ruleIds = createDefaultPerceptionRules().map(r => r.id)
const eventRules = createDefaultPerceptionRules().filter(r => r.lane !== 'state')

describe('规则表 × T1 渲染链 (每条命中必被适配)', () => {
  it('每条规则都有 canonical 样本 (新增规则必须补样本)', () => {
    expect([...ruleIds].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('state 规则: 样本进 stateHits (落库路径存在)', () => {
    const failures: string[] = []
    for (const rule of createDefaultPerceptionRules().filter(r => r.lane === 'state')) {
      const { stateIds } = sampleHits(rule.id)
      if (!stateIds.includes(rule.id)) failures.push(rule.id)
    }
    expect(failures).toEqual([])
  })

  it('event 规则: 样本进 hits (direct 动作进 directHits) 且带动作 (否则命中等于没发生)', () => {
    const failures: string[] = []
    for (const rule of eventRules) {
      const { hits, directHits } = sampleHits(rule.id)
      const direct = rule.action?.direct === true
      // `direct` 动作不进 T1 渲染队列, 由运行时直接执行 —— 它落在 directHits 里。
      const pool = direct ? directHits : hits
      const hit = pool.find(h => h.ruleId === rule.id)
      if (hit === undefined) failures.push(`${rule.id}: 未命中 (${direct ? 'directHits' : 'hits'})`)
      else if (hit.action?.output === undefined) failures.push(`${rule.id}: 命中无动作`)
    }
    expect(failures).toEqual([])
  })

  it('event 规则: T1 渲染的 tool-call 名字+参数与声明逐字一致 (direct 动作只固定工具声明)', async () => {
    const failures: string[] = []
    for (const rule of eventRules) {
      const tool = rule.action?.tool
      if (tool === undefined) continue
      const { hits, directHits } = sampleHits(rule.id)
      if (rule.action?.direct === true) {
        // 直接执行: 运行时替规则执行工具, 不经过 T1 渲染 —— 断言的两件事是"进了 directHits"
        // 与"没有同时进 T1 队列"(否则会被渲染两次)。
        if (!directHits.some(h => h.ruleId === rule.id)) failures.push(`${rule.id}: direct 动作未进 directHits`)
        if (hits.some(h => h.ruleId === rule.id)) failures.push(`${rule.id}: direct 动作不该进 T1 渲染队列`)
        continue
      }
      const call = await renderFirstToolCall(hits.filter(h => h.ruleId === rule.id))
      if (call === null) {
        failures.push(`${rule.id}: 未渲染 tool-call`)
        continue
      }
      if (call.name !== tool.name) failures.push(`${rule.id}: 工具名 ${call.name} ≠ ${tool.name}`)
      const expected = JSON.stringify(tool.args ?? {})
      if (call.args !== expected) failures.push(`${rule.id}: 参数 ${call.args} ≠ ${expected}`)
    }
    expect(failures).toEqual([])
  })

  it('样本互不串味: 每条 event 规则的样本不命中别的 event 规则 (样本表可信)', () => {
    const unexpected: string[] = []
    for (const rule of eventRules) {
      const { allIds } = sampleHits(rule.id)
      for (const id of allIds) {
        if (id !== rule.id) unexpected.push(`${rule.id} 的样本同时命中了 ${id}`)
      }
    }
    expect(unexpected).toEqual([])
  })
})

/**
 * 规则表**按会话构造**（v0.11.2，§1 I8「禁止模块级可变单例状态」）。
 *
 * 规则里的 `guard` 闭包带运行态：`pager:continue` 用它做 1s 翻页节流。模块级共享同一份
 * 规则表时，该时间戳被**所有会话**共用 —— 会话 A 翻页后，会话 B 在 1s 内的翻页会被静默
 * 压掉（多会话部署下的真实缺陷，本仓测试也一直在为它写规避）。工厂化后每份规则表各有
 * 自己的时间戳：同一份表内仍然节流，跨表互不影响。
 */
describe('规则表按会话构造 (§1 I8: guard 运行态不跨会话)', () => {
  /** 用"一份全新规则表"建一个引擎并喂分页行, 返回 direct 命中。 */
  function flipOnce(): string[] {
    const engine = new PerceptionEngine(splitPerceptionRules(createDefaultPerceptionRules()))
    return engine.feed(linesOf(['== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)']))
      .directHits.map(hit => hit.ruleId)
  }

  it('两个会话各自翻页: 第二份规则表不被第一份的 1s 节流压住', () => {
    expect(flipOnce()).toEqual(['pager:continue'])
    // 旧实现（模块级共享时间戳）在这里返回 [] —— 会话 B 被会话 A 压住。
    expect(flipOnce()).toEqual(['pager:continue'])
  })

  it('同一份规则表内仍然节流 (节流语义本身不变)', () => {
    const engine = new PerceptionEngine(splitPerceptionRules(createDefaultPerceptionRules()))
    const pager = '== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)'
    expect(engine.feed(linesOf([pager])).directHits.map(h => h.ruleId)).toEqual(['pager:continue'])
    expect(engine.feed(linesOf([pager])).directHits).toEqual([])
  })
})
