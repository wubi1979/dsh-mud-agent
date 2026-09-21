/**
 * dsh-mud-core — **T1 按流程槽渲染**（形态 C 第 5 步 / `doc/PLAN.md` §3.4、§3.8）。
 *
 * 流程步的**续步没有投递消息**（claim=0，DSH 原生形状）：T1 必须自己按槽渲染下一步 tool-call。
 * 本文件钉住四条判定：
 *   1. 投递里**有动作**（规则动作 / 入口回合）⇒ **投递优先**（槽不得顶掉规则动作）；
 *   2. 投递里没有可渲染动作 + 槽有 `render` + 未渲染过 ⇒ **按槽渲染**，并登记 callId；
 *   3. 同一槽**已渲染、结果未回**（`pendingCallId` 非空）⇒ 收束（不重复渲染同一步）；
 *   4. 槽在等分支（`awaiting-branch`，无 `render`）/ 未接线 ⇒ 收束（旧行为不变）。
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { TriggerLlmAdapter } from '../src/agent/t1.ts'
import type { FlowSlot } from '../src/agent/flow/slot.ts'

/** 一条 mud-owned 投递消息（带动作 = 规则动作 / 入口回合）。 */
function owned(actions?: readonly { tool: { name: string; args?: Record<string, unknown> } }[]): Message {
  return createUserMessage({
    content: [{ type: 'text', text: '游戏输出原文' }],
    source: { kind: 'mud-owned', lane: 't1', sessionId: 's1', ...(actions === undefined ? {} : { actions }) },
  }) as unknown as Message
}

function slot(over?: Partial<FlowSlot>): FlowSlot {
  return {
    flowId: 'login',
    stepId: 'pass',
    phase: 'awaiting-result',
    render: { tool: 'mud_send', args: { cmd: '{pass}' }, closeOn: /^此ID档案已存在/, timeoutMs: 30_000 },
    pendingCallId: null,
    retries: 0,
    captureSlots: {},
    ...over,
  }
}

/** 跑一次 T1 请求，收集产出的块与登记过的 callId。 */
async function run(options: {
  messages: readonly Message[]
  slot: FlowSlot | null
  wired?: boolean
}): Promise<{ blocks: { type: string; name?: string; arguments?: string; id?: string }[]; rendered: string[] }> {
  const rendered: string[] = []
  const adapter = new TriggerLlmAdapter({
    ...(options.wired === false ? {} : {
      slotOf: () => options.slot,
      markRendered: (_sessionId: string, callId: string) => { rendered.push(callId) },
    }),
  })
  const blocks: { type: string; name?: string; arguments?: string; id?: string }[] = []
  const generate = {
    provider: 'mud-t1',
    model: 't1-local',
    sessionId: 's1',
    messages: [...options.messages],
  } as unknown as GenerateOptions
  for await (const chunk of adapter.stream(generate)) {
    if (chunk.type !== 'block-end') continue
    const block = chunk.block as { type: string; name?: string; arguments?: string; id?: string }
    blocks.push({ type: block.type, ...(block.name === undefined ? {} : { name: block.name }), ...(block.arguments === undefined ? {} : { arguments: block.arguments }), ...(block.id === undefined ? {} : { id: String(block.id) }) })
  }
  return { blocks, rendered }
}

describe('T1 按流程槽渲染 (W10.4 第 5 步)', () => {
  it('投递有动作 ⇒ **投递优先**（槽不顶掉规则动作）', async () => {
    const { blocks, rendered } = await run({
      messages: [owned([{ tool: { name: 'mud_send', args: { cmd: 'look' } } }])],
      slot: slot(),
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('tool-call')
    expect(blocks[0]?.arguments).toBe(JSON.stringify({ cmd: 'look' }))
    expect(rendered).toEqual([])   // 未走槽通路
  })

  it('投递无动作 + 槽有 render ⇒ **按槽渲染下一步**，并登记 callId（D1 配对）', async () => {
    const { blocks, rendered } = await run({ messages: [owned()], slot: slot() })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool-call', name: 'mud_send', arguments: JSON.stringify({ cmd: '{pass}' }) })
    // 参数**原样透传**（占位符由工具发送瞬间插值）。
    expect(rendered).toEqual(['mud-flow-login-pass-0'])
  })

  it('同一槽已渲染、结果未回（pendingCallId 非空）⇒ 收束（不重复渲染）', async () => {
    const { blocks, rendered } = await run({
      messages: [owned()],
      slot: slot({ pendingCallId: 'mud-flow-login-pass-0' }),
    })
    expect(blocks).toEqual([])
    expect(rendered).toEqual([])
  })

  it('槽在等分支（无 render）/ 未接线槽读口 ⇒ 收束（旧行为不变）', async () => {
    const branching = await run({ messages: [owned()], slot: slot({ phase: 'awaiting-branch', render: undefined }) })
    expect(branching.blocks).toEqual([])

    const unwired = await run({ messages: [owned()], slot: slot(), wired: false })
    expect(unwired.blocks).toEqual([])
  })
})
