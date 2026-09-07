/**
 * dsh-mud-core — trigger-llm 原型 e2e（M2）。
 *
 * 用官方 loop harness（dsh-agent-loop-testkit + dsh-agent-loop）驱动完整 turn，
 * 验证「触发器 = 确定性 LLM adapter」的三个原型：
 *
 *   a) lite 全链路：%%MUD-LITE%% 标记 user/message → agent/pre-step 记 pending
 *      → agent/request 换成 mud-trigger provider → TriggerLlmAdapter.stream()
 *      吐确定性 text + tool_call → loop 官方工具管道执行 mud_send → tool/result。
 *   b) 连续捕获 / 会话隔离：同一 session 一 turn 内逐 step 消费多条 lite，
 *      以及不同 session 互不串扰。
 *   c) 非标记消息不换路由：普通 user 输入走真实 mock adapter。
 *
 * @module dsh-mud-core/tests/trigger-lite
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

import { TriggerRouter } from '../src/trigger-llm/router.ts'
import type { LiteMarker } from '../src/trigger-llm/types.ts'

/** A real (non-lite) streaming adapter for the 'mock' route. */
class MockTextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly texts: string[]
  constructor(texts: string[]) {
    super()
    this.texts = texts
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.texts.shift() ?? 'reply'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Build a lite marker for the given command/tool. */
function liteMessage(over: Partial<LiteMarker> = {}, cmd = 'north'): UserMessage {
  const marker: LiteMarker = {
    kind: 'lite',
    entryId: 'e1',
    groupId: 'g1',
    capturedText: ['上面的这条走廊。'],
    actionTemplate: cmd,
    renderedCmd: `go ${cmd}`,
    toolCalls: [{ name: 'mud_send', args: { cmd } }],
    ...over,
  }
  return createUserMessage({
    content: [{ type: 'text', text: `%%MUD-LITE%%\n${JSON.stringify(marker)}` }],
    source: { kind: 'user' },
  })
}

/** Resolve on the agent's next idle transition. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, message: UserMessage): void {
  agent.followup(message)
}

/** All text content of committed assistant/message events (data.message.content). */
function assistantTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'assistant/message')
    .flatMap(e => e.type === 'assistant/message'
      ? (((e.data as { message: { content?: Array<{ type: string; text?: string }> } }).message.content) ?? [])
      : [])
    .flatMap(b => (b.type === 'text' && b.text !== undefined) ? [b.text] : [])
}

/** (name, argumentsJson) of every tool/call event in the log. */
function toolCalls(agent: Agent): Array<{ name: string; args: string }> {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'tool/call')
    .map(e =>
      e.type === 'tool/call'
        ? { name: (e.data as { name: string }).name, args: (e.data as { arguments: string }).arguments }
        : null)
    .filter((x): x is { name: string; args: string } => x !== null)
}

/** Mount the full loop harness plus a TriggerRouter and a mud_send fixture tool. */
async function harness() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const sent: Array<{ cmd: string }> = []
  ctx.tools.register(defineContentToolFixture({
    name: 'mud_send',
    description: 'send a command to the MUD',
    parameters: { cmd: { type: 'string' } },
    async execute(args: { cmd: string }) {
      sent.push(args)
      return [{ type: 'text', text: `sent: ${args.cmd}` }]
    },
  }))
  const router = new TriggerRouter(ctx)
  return { ctx, router, sent }
}

describe('trigger-llm 原型 (M2)', () => {
  it('a) lite 全链路：标记消息 → mud-trigger 路由 → mud_send 工具 → tool/result', async () => {
    const { ctx, sent } = await harness()
    const agent = await ctx.agentLoop.create(SessionId('lite-full'), {
      provider: 'mock',
      model: 'mock',
    })

    send(agent, liteMessage(undefined, 'north'))
    const idle = waitForIdle(ctx, agent)
    await idle

    // Deterministic ack committed as an assistant message mentioning the cmd.
    expect(assistantTexts(agent).join('\n')).toContain('go north')
    // The official tool pipeline executed mud_send once with the right arg.
    expect(sent).toEqual([{ cmd: 'north' }])
    // tool/call + tool/result both recorded.
    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    expect(toolCalls(agent).map(t => t.name)).toEqual(['mud_send'])
  })

  it('b) 连续捕获：同一 turn 内逐 step 消费多条 lite，工具连续执行', async () => {
    const { ctx, sent } = await harness()
    const agent = await ctx.agentLoop.create(SessionId('lite-chain'), {
      provider: 'mock',
      model: 'mock',
    })

    const cmds = ['login alice secret', 'hp', 'look']
    for (const cmd of cmds) {
      send(agent, liteMessage(
        { entryId: `e-${cmd}`, capturedText: [cmd], actionTemplate: cmd, renderedCmd: cmd },
        cmd,
      ))
    }
    await waitForIdle(ctx, agent)

    expect(sent).toEqual(cmds.map(cmd => ({ cmd })))
  })

  it('b2) 会话隔离：两个 session 的 lite 动作互不串扰', async () => {
    const { ctx, sent } = await harness()
    const agentA = await ctx.agentLoop.create(SessionId('lite-iso-a'), { provider: 'mock', model: 'mock' })
    const agentB = await ctx.agentLoop.create(SessionId('lite-iso-b'), { provider: 'mock', model: 'mock' })

    const idleA = waitForIdle(ctx, agentA)
    const idleB = waitForIdle(ctx, agentB)
    send(agentA, liteMessage({}, 'A-command'))
    send(agentB, liteMessage({}, 'B-command'))
    await Promise.all([idleA, idleB])

    expect(sent).toEqual([{ cmd: 'A-command' }, { cmd: 'B-command' }])
    expect(toolCalls(agentA).map(t => t.args)).toEqual([JSON.stringify({ cmd: 'A-command' })])
    expect(toolCalls(agentB).map(t => t.args)).toEqual([JSON.stringify({ cmd: 'B-command' })])
  })

  it('c) 非标记消息不换路由：普通 user 输入走真实 mock adapter', async () => {
    const { ctx } = await harness()
    const mock = new MockTextAdapter(['好，我在。'])
    ctx.llm.registerAdapter(['mock'], mock)
    const agent = await ctx.agentLoop.create(SessionId('lite-plain'), { provider: 'mock', model: 'mock' })

    send(agent, createUserMessage({
      content: [{ type: 'text', text: '普通玩家消息' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    // The real mock route handled the non-lite message.
    expect(mock.requests).toHaveLength(1)
    const requestText = mock.requests[0]!.messages
      .flatMap(m => (m.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text'))
      .map(b => b.text)
      .join('\n')
    expect(requestText).toContain('普通玩家消息')
    expect(assistantTexts(agent)).toContain('好，我在。')
  })
})
