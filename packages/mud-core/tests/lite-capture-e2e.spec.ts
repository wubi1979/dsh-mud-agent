/**
 * dsh-mud-core — M4 集成: 感知捕获 → lite 发送 → 触发器 LLM → 官方工具管道。
 *
 * 用官方 loop harness 驱动「完整战斗反射链」:
 *
 *   MudPercept(p:combat:start) → LiteCapture.sendLite → agent.cancel(keepInbox) 抢占
 *     → agent.send(lite marker) → TriggerRouter(pre-step 记 pending + request 换
 *     mud-trigger) → TriggerLlmAdapter.stream() → 官方工具管道执行 mud_send halt。
 *
 * 验证:
 *   a) combat:start 捕获后抢占当前回合, 并经 lite 链执行 mud_send halt;
 *   b) combat:end 捕获走普通 next-turn, 执行 mud_send look (不抢占);
 *   c) 未登录守卫: guard=false 时捕获不发送, 工具不执行。
 *
 * @module dsh-mud-core/tests/lite-capture-e2e
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

import { TriggerRouter } from '../src/trigger-llm/router.ts'
import { LiteCapture, type LiteActionDef } from '../src/perception/lite-capture.ts'

/** 挂起适配器: 不产出任何块, 等待请求信号被 abort (模拟进行中的慢回合)。 */
class HangAdapter extends LlmAdapter {
  /** stream 被调用时触发 (测试测"已进入运行中回合")。 */
  onStreamStarted?: () => void
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onStreamStarted?.()
    if (options.signal?.aborted) return
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}

function combatActions(loggedIn: boolean): { actions: Record<string, LiteActionDef>; guard: () => boolean } {
  return {
    actions: {
      'p:combat:start': {
        label: '战斗开始 → 立即 halt',
        toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }],
        interrupt: true,
      },
      'p:combat:end': {
        label: '战斗结束 → look 刷新',
        toolCalls: [{ name: 'mud_send', args: { cmd: 'look' } }],
        interrupt: false,
      },
    },
    guard: () => loggedIn,
  }
}

/** All tool/call names committed in the session log. */
function toolNames(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'tool/call')
    .map(e => (e.data as { name: string }).name)
}

/** Poll until `pred` is truthy or timeout (ms). */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

function assistantTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(e => e.type === 'assistant/message')
    .flatMap(e => (e.data as { message: { content?: Array<{ type: string; text?: string }> } }).message.content ?? [])
    .flatMap(b => (b.type === 'text' && b.text !== undefined) ? [b.text] : [])
}

/** Full harness: loop + TriggerRouter + mud_send fixture + LiteCapture wired to a caller-bound agent. */
async function harness(loggedIn = true) {
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
  const { actions, guard } = combatActions(loggedIn)

  const cancels: string[] = []
  // 当前绑定的 loop agent (由测试 bindAgent 注入); null = 未绑定, sendLite 跳过。
  let bound: Agent | null = null
  const capture = new LiteCapture({
    bus: ctx,
    actions,
    guard,
    // 镜像 index.ts 的 sendLite 装配: 抢占 → cancel(keepInbox) + send lite。
    sendLite(marker) {
      if (bound === null) return
      if (capture.requiresInterrupt(marker.groupId)) {
        cancels.push(marker.groupId)
        bound.cancel({ kind: 'user' }, { keepInbox: true })
      }
      bound.send(router.makeLiteMessage(marker), 'next-turn', true)
    },
  })

  const bindAgent = (a: Agent) => { bound = a }

  return { ctx, router, capture, sent, cancels, bindAgent }
}

describe('M4 集成: 感知捕获 → lite → 官方工具管道', () => {
  it('a) combat:start → 抢占 (cancel keepInbox) + lite 链执行 mud_send halt', async () => {
    const h = await harness(true)
    // 挂起适配器作真实路由, 制造"运行中的回合", 让抢占 (cancel+keepInbox latch) 有真实运行态。
    const hang = new HangAdapter()
    h.ctx.llm.registerAdapter(['hang'], hang)
    const agent = await h.ctx.agentLoop.create(SessionId('m4-combat-start'), { provider: 'hang', model: 'hang' })
    h.bindAgent(agent)

    // 发起普通 user 消息 → 进入挂起的运行中回合。
    const entered = new Promise<void>((resolve) => { hang.onStreamStarted = () => resolve() })
    agent.send(createUserMessage({
      content: [{ type: 'text', text: '分析当前局面' }],
      source: { kind: 'user' },
    }), 'next-turn', true)
    await entered // 确认已进入运行中回合

    // 战斗中 → 触发感知事件 → LiteCapture → 抢占 (cancel keepInbox) + send lite。
    // cancel+keepInbox 使该 lite 在 abort 收敛后 latch 重放, 走 mud-trigger 执行 halt。
    h.ctx.events.emit('mud/percept', { type: 'p:combat:start', data: { line: '你感到杀气扑面而来。' }, line: 1, ts: Date.now() })

    await waitFor(() => h.sent.some(s => s.cmd === 'halt'))

    expect(h.cancels).toEqual(['p:combat:start'])
    expect(h.sent).toContainEqual({ cmd: 'halt' })
    expect(toolNames(agent)).toContain('mud_send')
    expect(assistantTexts(agent).join('\n')).toContain('战斗开始 → 立即 halt')
    h.capture.dispose()
  })

  it('b) combat:end → 普通 next-turn, 不抢占, 执行 look', async () => {
    const h = await harness(true)
    const agent = await h.ctx.agentLoop.create(SessionId('m4-combat-end'), { provider: 'mock', model: 'mock' })
    h.bindAgent(agent)

    h.ctx.events.emit('mud/percept', { type: 'p:combat:end', data: { line: '战斗结束。' }, line: 1, ts: Date.now() })
    await waitFor(() => h.sent.some(s => s.cmd === 'look'), 2000)

    expect(h.cancels).toEqual([]) // 非抢占
    expect(h.sent).toContainEqual({ cmd: 'look' })
    h.capture.dispose()
  })

  it('c) 未登录守卫: 捕获不发送, 工具不执行', async () => {
    const h = await harness(false)
    const agent = await h.ctx.agentLoop.create(SessionId('m4-guard'), { provider: 'mock', model: 'mock' })
    h.bindAgent(agent)

    h.ctx.events.emit('mud/percept', { type: 'p:combat:start', data: { line: '杀气。' }, line: 1, ts: Date.now() })
    await new Promise(r => setTimeout(r, 100))

    expect(h.cancels).toEqual([])
    expect(h.sent).toEqual([])
    expect(h.capture.captures).toBe(0)
    h.capture.dispose()
  })
})
