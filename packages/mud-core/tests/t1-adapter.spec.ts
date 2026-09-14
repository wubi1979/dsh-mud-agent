/**
 * dsh-mud-core — TriggerLlmAdapter (T1) 契约测试 (`doc/ARCHITECTURE.md` §7)。
 *
 * v0.4.0 起 T1 是**无状态动作渲染器**：
 *   1. 输入 = 本步投递消息自带的**动作请求**（`source.actions`）→ 逐条渲染 tool-call；
 *   2. 无动作请求 / 无本插件投递 → `finish stop`（回合自然收束）；
 *   3. lane≠t1 被路由到本 provider = 选路异常 → `finish stop` + 日志；
 *   4. **"是否已执行"用确定性 call-id 判断**（`mud-<delivery>-<index>`）：会话里已有该 id 的
 *      tool-result ⇒ 已跑过 → 不再渲染（工具结果回来后 loop 会再调一次的常态）；
 *   5. 不做文本反查、不查运行时（契约检验 I15）。
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ownedGameMessage } from '../src/agent/agent-bridge.ts'
import type { OwnedAction } from '../src/agent/agent-bridge.ts'
import { TriggerLlmAdapter } from '../src/trigger-llm/index.ts'

/** 动作请求 (契约同形; output 可省 = 纯工具动作)。 */
type RenderedAction = Omit<OwnedAction, 'output'> & { output?: string }

/** 收集一次 stream。 */
async function collect(
  adapter: TriggerLlmAdapter,
  messages: readonly Message[] | undefined,
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const options = {
    provider: 'mud-t1',
    model: 't1-local',
    sessionId: 's1',
    messages,
    ...(signal === undefined ? {} : { signal }),
  } as unknown as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks
}

/** 投递消息 (lane=t1 + 动作请求 + 投递号)。 */
function delivered(
  actions: readonly RenderedAction[] | undefined,
  delivery = 'd1',
  text = '游戏输出',
): Message {
  return ownedGameMessage(text, 't1', 's1', {
    ...(actions === undefined ? {} : { actions: actions as readonly OwnedAction[] }),
    delivery,
  })
}

/** 一条工具结果 (带 call-id)。 */
function result(callId: string): Message {
  return createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: '你已经在游戏中了。' }] })
}

const SEND_NAME: RenderedAction[] = [
  { ruleId: 'flow:login/name', output: '登录提示: 输入英文名字', tool: { name: 'mud_send', args: { cmd: '{name}' } } },
]

describe('TriggerLlmAdapter — T1 动作渲染器', () => {
  it('动作请求 → output 文本块 + tool-call 块 + finish{tool-calls}, call-id 确定性', async () => {
    const chunks = await collect(new TriggerLlmAdapter(), [delivered(SEND_NAME, 't7')])

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '登录提示: 输入英文名字' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '登录提示: 输入英文名字' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'mud-t7-0', name: 'mud_send', argumentsDelta: '{"cmd":"{name}"}' },
      expect.objectContaining({ type: 'block-end', block: expect.objectContaining({ type: 'tool-call', name: 'mud_send' }) }),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('多动作 → 按序渲染, call-id = mud-<delivery>-<index> (占位符原样下发)', async () => {
    const chunks = await collect(new TriggerLlmAdapter(), [
      delivered([
        { ruleId: 'a', tool: { name: 'mud_send', args: { cmd: 'halt' } } },
        { ruleId: 'b', tool: { name: 'mud_send', args: { cmd: 'fullme {captcha}' } } },
      ], 'd9'),
    ])
    const calls = chunks.filter(c => c.type === 'tool-call-delta')
    expect(calls.map(c => c.id)).toEqual(['mud-d9-0', 'mud-d9-1'])
    expect(calls.map(c => c.type === 'tool-call-delta' ? c.argumentsDelta : ''))
      .toEqual(['{"cmd":"halt"}', '{"cmd":"fullme {captcha}"}'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('无动作请求 / 无消息 → finish{stop} (回合自然收束)', async () => {
    expect(await collect(new TriggerLlmAdapter(), [delivered(undefined)]))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(await collect(new TriggerLlmAdapter(), [delivered([])]))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(await collect(new TriggerLlmAdapter(), []))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('无本插件投递 (人类消息) → finish{stop} + 日志', async () => {
    const logs: string[] = []
    const adapter = new TriggerLlmAdapter({ onLog: t => logs.push(t) })
    const human = createUserMessage({ content: [{ type: 'text', text: '人类输入' }], source: { kind: 'user' } })

    expect(await collect(adapter, [human])).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(logs.join('\n')).toContain('无动作可渲染')
  })

  it('lane≠t1 被路由到 T1 → finish{stop} + 选路异常日志', async () => {
    const logs: string[] = []
    const adapter = new TriggerLlmAdapter({ onLog: t => logs.push(t) })

    expect(await collect(adapter, [ownedGameMessage('批次文本', 't2', 's1')]))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(logs.join('\n')).toContain('选路异常')
  })

  it('动作已执行过 (会话里已有该 call-id 的 tool-result) → 不重复渲染', async () => {
    // 第一次: 渲染
    expect((await collect(new TriggerLlmAdapter(), [delivered(SEND_NAME, 't7')]))
      .filter(c => c.type === 'tool-call-delta')).toHaveLength(1)
    // 工具结果回来后 loop 再调一次 (同一条投递消息还在历史里) → 收束
    expect(await collect(new TriggerLlmAdapter(), [delivered(SEND_NAME, 't7'), result('mud-t7-0')]))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('同一投递多条动作, 部分已有结果 → 只渲染未执行的那部分', async () => {
    const chunks = await collect(new TriggerLlmAdapter(), [
      delivered([
        { ruleId: 'a', tool: { name: 'mud_send', args: { cmd: 'a' } } },
        { ruleId: 'b', tool: { name: 'mud_send', args: { cmd: 'b' } } },
      ], 'd10'),
      result('mud-d10-0'),
    ])
    const calls = chunks.filter(c => c.type === 'tool-call-delta')
    expect(calls.map(c => c.id)).toEqual(['mud-d10-1'])
    expect(calls[0]!.type === 'tool-call-delta' ? calls[0]!.argumentsDelta : '').toBe('{"cmd":"b"}')
  })

  it('长历史: 投递埋在大量旧消息之后、结果隔着多条消息才到 → 仍判定已执行 (扫描下界=投递下标)', async () => {
    const noise: Message[] = Array.from({ length: 60 }, (_, k) =>
      createUserMessage({ content: [{ type: 'text', text: `旧文本 ${k}` }], source: { kind: 'user' } }))
    expect(await collect(new TriggerLlmAdapter(), [
      ...noise,
      delivered(SEND_NAME, 't99'),
      createUserMessage({ content: [{ type: 'text', text: '跟进输入' }], source: { kind: 'user' } }),
      result('mud-t99-0'),
    ])).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('长历史: 结果未回 → 不误判已执行, 照常渲染动作 (不越过投递下标往前扫)', async () => {
    const noise: Message[] = Array.from({ length: 60 }, (_, k) =>
      createUserMessage({ content: [{ type: 'text', text: `旧文本 ${k}` }], source: { kind: 'user' } }))
    const chunks = await collect(new TriggerLlmAdapter(), [
      ...noise,
      delivered(SEND_NAME, 't100'),
      createUserMessage({ content: [{ type: 'text', text: '跟进输入' }], source: { kind: 'user' } }),
    ])
    const calls = chunks.filter(c => c.type === 'tool-call-delta')
    expect(calls.map(c => c.id)).toEqual(['mud-t100-0'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('中止信号已 abort → 不产出任何 chunk', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await collect(new TriggerLlmAdapter(), [delivered(SEND_NAME)], controller.signal)).toEqual([])
  })
})
