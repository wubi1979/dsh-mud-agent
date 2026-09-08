/**
 * dsh-mud-core 级联 provider (mud-cascade) 测试 — T1 确定性渲染 / T2 转发 / 去重。
 *
 * 验证四类目标:
 *   1. T1 命中渲染: 文本块 + tool-call 块与真实 LLM 同构, finish 'tool-calls'/'stop';
 *   2. 内容级去重: 同一尾部文本在工具循环中重复提取时不再重复渲染;
 *   3. T2 转发: 未命中且 realAllowed → forward; mimic 关闭 → 直接 forward;
 *      未命中且 !realAllowed → 空 finish(stop), 不产生模型调用;
 *   4. 集成: TriggerService 规则携带 action → 命中经 matchLines 产出 TriggerAction。
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TriggerLlmAdapter, TriggerService } from '../src/trigger-llm/index.ts'
import type { TriggerLlmAdapterHooks } from '../src/trigger-llm/adapter.ts'
import type { TriggerAction } from '../src/trigger-llm/types.ts'

/** 构造一个 user 文本消息 (标准游戏输出导入形态)。 */
function userMsg(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 将适配器输出流收集为 chunk 列表。 */
async function collect(adapter: TriggerLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks
}

function makeOptions(messages: unknown): GenerateOptions {
  return {
    provider: 'mud-cascade',
    model: 'cascade-v1',
    messages,
  } as unknown as GenerateOptions
}

/** 简化: 直接给 messages 数组。 */
function opts(messages: unknown): GenerateOptions {
  return makeOptions(messages)
}

/** 渲染命中列表 (装配方形态: 过滤带 action 的命中)。 */
function toActions(matches: readonly TriggerAction[]): TriggerAction[] {
  return [...matches]
}

describe('T1 确定性渲染', () => {
  it('命中(输出+工具) → 文本块 + tool-call 块, finish tool-calls', async () => {
    const trigger = new TriggerService()
    trigger.register({
      id: 'combat:start', eventType: 'p:combat:start',
      regex: [/杀气逼人/],
      action: {
        output: '战斗开始',
        tool: { name: 'world_patch', args: { patch: { in_combat: true } } },
      },
    })
    let rendered: { hitId: string } | null = null
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => toActions(trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! }))),
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { throw new Error('不应转发') },
      onRender: (e) => { rendered = { hitId: e.hit.id } },
    })

    const chunks = await collect(adapter, opts([userMsg('杀气逼人向你扑来！')]))

    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['战斗开始'])
    const toolBlocks = chunks.filter(c => c.type === 'block-end' && (c as { block: { type?: string } }).block?.type === 'tool-call')
    expect(toolBlocks).toHaveLength(1)
    const last = chunks[chunks.length - 1]
    expect(last?.type).toBe('finish')
    expect((last as { reason: { kind: string } }).reason.kind).toBe('tool-calls')
    expect(rendered?.hitId).toBe('combat:start')
  })

  it('命中(纯输出) → 仅文本块, finish stop', async () => {
    const trigger = new TriggerService()
    trigger.register({
      id: 'save:prompt', eventType: 'p:save:prompt',
      regex: [/你当前的存盘/],
      action: { output: '正在保存...' },
    })
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! })),
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { throw new Error('不应转发') },
    })

    const chunks = await collect(adapter, opts([userMsg('你当前的存盘时间为...')]))
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['正在保存...'])
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('多规则命中 → 顺行序渲染全部动作 (工具 id 唯一)', async () => {
    const trigger = new TriggerService()
    trigger.register({ id: 'a1', eventType: 'p:a', regex: [/甲/], action: { output: '动作A' } })
    trigger.register({ id: 'b2', eventType: 'p:b', regex: [/乙/], action: { output: '动作B' } })
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! })),
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { throw new Error('不应转发') },
    })

    const chunks = await collect(adapter, opts([userMsg('甲行\n乙行')]))
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['动作A', '动作B'])
  })
})

describe('内容级去重', () => {
  it('同一尾部文本在循环内重复提取 → 第二次空 finish(stop), 不重复渲染', async () => {
    const trigger = new TriggerService()
    trigger.register({ id: 'x', eventType: 'p:x', regex: [/命中/], action: { output: '已处理' } })
    let calls = 0
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => {
        calls += 1
        return trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! }))
      },
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { throw new Error('不应转发') },
    })

    const first = await collect(adapter, opts([userMsg('剑法命中要害')]))
    expect(calls).toBe(1)
    // 同一文本另一轮 (模拟工具循环复用尾部文本): 去重层拦截, 不再次调用 matchLines。
    const second = await collect(adapter, opts([userMsg('剑法命中要害')]))
    expect(calls).toBe(1)
    expect(second.every(c => c.type === 'finish')).toBe(true)
    expect((second[0] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('不同文本 → 正常重新匹配', async () => {
    const trigger = new TriggerService()
    trigger.register({ id: 'x', eventType: 'p:x', regex: [/要害/], action: { output: '已处理' } })
    let calls = 0
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => {
        calls += 1
        return trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! }))
      },
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    })

    await collect(adapter, opts([userMsg('剑法命中要害')]))
    await collect(adapter, opts([userMsg('你眼前一黑')]))
    expect(calls).toBe(2)
  })
})

describe('T2 转发 (真实 LLM)', () => {
  it('未命中且 realAllowed → forward 被调用且收到原 options', async () => {
    const trigger = new TriggerService()
    trigger.register({ id: 'n', eventType: 'p:n', regex: [/绝不匹配此文本/], action: { output: 'x' } })
    let forwarded: GenerateOptions | null = null
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! })),
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* (o) { forwarded = o; yield { type: 'finish', reason: { kind: 'stop' } } },
    })

    const chunks = await collect(adapter, opts([userMsg('你不是武馆弟子')]))
    expect(forwarded).not.toBeNull()
    expect((forwarded as GenerateOptions).messages.length).toBe(1)
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('mimic 关闭 → T1 完全跳过, 直接 forward', async () => {
    let matched = false
    const adapter = new TriggerLlmAdapter({
      matchLines: () => { matched = true; return [] },
      mimicEnabled: () => false,
      realAllowed: () => true,
      forward: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    })

    await collect(adapter, opts([userMsg('随便什么文本')]))
    expect(matched).toBe(false)
  })

  it('未命中且 !realAllowed → 空 finish(stop), 不调用 forward', async () => {
    let forwarded = false
    const adapter = new TriggerLlmAdapter({
      matchLines: () => [],
      mimicEnabled: () => true,
      realAllowed: () => false,
      forward: async function* () { forwarded = true; yield { type: 'finish', reason: { kind: 'stop' } } },
    })

    const chunks = await collect(adapter, opts([userMsg('普通文本')]))
    expect(forwarded).toBe(false)
    expect(chunks.every(c => c.type === 'finish')).toBe(true)
  })
})

describe('文本提取 (latestUserText)', () => {
  it('跳过 tool-result 消息, 取最近 user 文本', async () => {
    // tool-result 消息 source.kind === 'tool' 应被跳过。
    const toolResult = {
      content: [{ type: 'tool-result', toolCallId: 't1', name: 'look', isError: false, output: '{}' }],
      role: 'user',
      source: { kind: 'tool' },
    }
    const trigger = new TriggerService()
    trigger.register({ id: 'r', eventType: 'p:r', regex: [/场景/], action: { output: '场景已感知' } })
    const adapter = new TriggerLlmAdapter({
      matchLines: (text) => trigger.matchText(text).filter(h => h.action).map(h => ({ hit: h, action: h.action! })),
      mimicEnabled: () => true,
      realAllowed: () => true,
      forward: async function* () { throw new Error('不应转发') },
    })

    const chunks = await collect(adapter, opts([toolResult, userMsg('这里是场景描述')]))
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['场景已感知'])
  })
})