/**
 * dsh-mud-core — 会话运行时看门狗测试 (`doc/ARCHITECTURE.md` §11)。
 *
 * 第一个 runtime 级测试 (§13.4 脚手架的第一步): 用假连接管理器 + 假 sink + 假计时器
 * 驱动真实 `MudSessionRuntime`, 覆盖**实测踩过的静默 bug**:
 *
 *   登录完成不是感知事件 —— `login:done` 那条文本块到达时 `logged_in` 还是 false,
 *   置位发生在随后的 `world_patch` 工具调用里。断流计时若只在感知事件里布防, 登录后
 *   服务器不再说话, 就再没有任何事件来补一次布防: 会话从此静默 (实测 2 分钟无反应)。
 *   修法是"世界模型变化后重评估看门狗" (`noteWorldChange`)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FlowSpec } from '../src/agent/flow/flows/index.ts'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionSink, MudConnectionManager } from '../src/network/manager.ts'
import type { MudDecisionRecord } from '../src/session/types.ts'
import type { MudLine } from '../src/network/ansi.ts'
import { runWithDeliveryChannel } from '../src/session/mount.ts'

/** 单步探针流程：`开始` 进入（发一条命令）→ `结束` 命中 `ok` → 无后继 = 终态。 */
const PROBE_FLOW: FlowSpec = {
  id: 'probe',
  priority: 100,
  entry: 'only',
  timeoutMs: 30_000,
  steps: [
    {
      id: 'only',
      driver: { kind: 'text', includes: ['开始'] },
      action: { tool: 'mud_send', args: { cmd: 'probe' } },
      ok: [{ kind: 'text', includes: ['结束'] }],
    },
  ],
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 记录 agent 收到的投递 (followup)。 */
interface FakeAgent {
  agent: Agent
  messages: { text: string; lane: string }[]
  /** 投递里的动作请求（形态 C：本步判据随窗口走，测试要真执行本步动作才有窗口）。 */
  actions: { callId: string; tool: { name: string; args: Record<string, unknown> } }[]
}

function makeAgent(sessionId: string): FakeAgent {
  const messages: { text: string; lane: string }[] = []
  const actions: { callId: string; tool: { name: string; args: Record<string, unknown> } }[] = []
  const agent = {
    id: sessionId,
    status: 'idle',
    inbox: { nextTurn: [] },
    followup: (message: {
      content: readonly { type: string; text?: string }[]
      source: {
        lane?: string
        delivery?: string
        actions?: readonly { tool: { name: string; args?: Record<string, unknown> } }[]
      }
    }) => {
      const text = message.content.find(block => block.type === 'text')?.text ?? ''
      messages.push({ text, lane: String(message.source.lane) })
      const delivery = message.source.delivery ?? 'd0'
      ;(message.source.actions ?? []).forEach((action, index) => {
        actions.push({ callId: `mud-${delivery}-${index}`, tool: { name: action.tool.name, args: action.tool.args ?? {} } })
      })
    },
  } as unknown as Agent
  return { agent, messages, actions }
}

/** 假连接管理器: 只回答 id/状态, 不开 socket; 同时把 sink 交出来 (测试要喂行)。 */
function makeConnections(captured: { sink?: MudConnectionSink }): MudConnectionManager {
  return {
    open: (_target: unknown, sink: MudConnectionSink) => { captured.sink = sink; return { id: 'conn-1' } },
    get: () => undefined,
    close: () => {},
    list: () => [],
    closeAll: () => {},
  } as unknown as MudConnectionManager
}

function makeRuntime(options: {
  sessionId: string
  agent: Agent
  deadAirMs: number
  decisions: MudDecisionRecord[]
  flows?: readonly FlowSpec[]
  captured?: { sink?: MudConnectionSink }
}): MudSessionRuntime {
  const sink: MudRuntimeSink = {
    agentOf: (sessionId) => (sessionId === options.sessionId ? options.agent : undefined),
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: () => {},
    debug: () => {},
    decision: (_sessionId, record) => { options.decisions.push(record) },
  }
  const config: MudRuntimeConfig = {
    agentMode: 'full',
    commandIntervalMs: 400,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: options.deadAirMs,
    holdTimeoutMs: 3_000,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
    ...(options.flows === undefined ? {} : { flows: options.flows }),
  }
  return new MudSessionRuntime(options.sessionId, config, sink, makeConnections(options.captured ?? {}), {
    stateRules: [],
    eventRules: [],
    holdRuleIds: new Set(),
  })
}

describe('MudSessionRuntime 看门狗 (世界变化 → 重评估)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('登录完成 (world_patch 翻转 logged_in) 后断流计时会布防并唤醒 agent', async () => {
    const sessionId = 'session-watchdog'
    const { agent, messages } = makeAgent(sessionId)
    const decisions: MudDecisionRecord[] = []
    const runtime = makeRuntime({ sessionId, agent, deadAirMs: 1_000, decisions })

    runtime.connect()
    // 登录完成的真实路径: login:done 规则渲染出的 world_patch 工具调用。
    const patched = await runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    expect(patched).toMatchObject({ ok: true })

    // 断流窗内无唤醒。
    vi.advanceTimersByTime(999)
    expect(messages).toEqual([])

    // 越过阈值 → 程序唤醒 (lane=t2 的控制消息; 决策栏记 `断流 Ns`)。
    vi.advanceTimersByTime(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.lane).toBe('t2')
    expect(messages[0]!.text).toContain('无游戏事件')
    expect(decisions.some(d => d.text.includes('断流 1s'))).toBe(true)
    runtime.dispose()
  })

  it('未登录时不布防断流 (登录看门狗负责那一段)', () => {
    const sessionId = 'session-not-logged-in'
    const { agent, messages } = makeAgent(sessionId)
    const runtime = makeRuntime({ sessionId, agent, deadAirMs: 1_000, decisions: [] })

    runtime.connect()
    vi.advanceTimersByTime(10_000)

    expect(messages.filter(m => m.text.includes('断流'))).toEqual([])
    runtime.dispose()
  })

  it('登录完成会清掉登录看门狗 (不再刷"登录卡住")', async () => {
    const sessionId = 'session-login-watchdog'
    const { agent, messages } = makeAgent(sessionId)
    const runtime = makeRuntime({ sessionId, agent, deadAirMs: 60_000, decisions: [] })

    runtime.connect()
    await runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    // 登录看门狗预算 (20s) 过去后不应再出现"登录卡住"。
    vi.advanceTimersByTime(25_000)

    expect(messages.filter(m => m.text.includes('登录卡住'))).toEqual([])
    runtime.dispose()
  })

  it('未连接时不布防断流 (没有局面可决策)', () => {
    const sessionId = 'session-offline'
    const { agent, messages } = makeAgent(sessionId)
    const runtime = makeRuntime({ sessionId, agent, deadAirMs: 1_000, decisions: [] })

    // 不 connect: 直接置位登录态 (模拟断线后残留状态)。
    void runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    vi.advanceTimersByTime(10_000)

    expect(messages).toEqual([])
    runtime.dispose()
  })

  /**
   * 作者定案 (2026-09-13)：布防判据从"`logged_in` 置真"改成"`logged_in` ∧ **无活跃流程**"。
   *
   * 两个目的：① `logged_in` 可能被 GMCP 提前置真（pkuxkx 的登录成功通知），而 login 流程
   * 还没收尾 —— 不该那时就打表；② 流程可能等很久才有结果（人工/慢命令），流程期间唤醒
   * 职责归流程自己的计时器，看门狗不得抢答。
   */
  it('活跃流程期间不布防断流; 流程收束后才布防', async () => {
    const sessionId = 'session-flow-deadair'
    const { agent, messages, actions } = makeAgent(sessionId)
    const captured: { sink?: MudConnectionSink } = {}
    const runtime = makeRuntime({
      sessionId, agent, deadAirMs: 1_000, decisions: [], flows: [PROBE_FLOW], captured,
    })
    const deadAir = (): number => messages.filter(m => m.text.includes('无游戏事件')).length

    runtime.connect()
    await runtime.tools().world_patch!.execute({ patch: { logged_in: true } })

    // 基线：空闲（无活跃流程）→ 布防并按窗口唤醒一次。
    vi.advanceTimersByTime(1_000)
    expect(deadAir()).toBe(1)

    // 流程激活 → **停表**：越过窗口也不唤醒。
    captured.sink!.onLines([ml('开始', 0)])
    expect(runtime.diag().flow).toMatchObject({ flowId: 'probe' })
    vi.advanceTimersByTime(5_000)
    expect(deadAir()).toBe(1)

    // 流程收束（本步命令的结果行命中 ok、无后继 = 终态）→ 重新布防 → 窗口到点再唤醒。
    // **形态 C**：本步判据随窗口走，故先按官方包装器执行本步动作（真发命令、武装窗口），
    // 再喂结果行 —— 结果行命中窗口的关闭触发 → 驱动器复判 → ok → 终态。
    const action = actions.at(-1)
    expect(action).toBeDefined()
    const pending = runWithDeliveryChannel({
      channel: runtime,
      callId: action!.callId,
      exec: { deferContext: () => {}, concludeTurn: () => {} },
      run: async () => await runtime.tools()[action!.tool.name]!.execute({ ...action!.tool.args }),
    })
    vi.advanceTimersByTime(1)          // 命令队列写出 → confirmSent 武装
    captured.sink!.onLines([ml('结束', 1)])
    captured.sink!.onBoundary('ga')
    await pending
    vi.advanceTimersByTime(1)
    expect(runtime.diag().flow).toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(deadAir()).toBeGreaterThan(1)
    runtime.dispose()
  })
})
