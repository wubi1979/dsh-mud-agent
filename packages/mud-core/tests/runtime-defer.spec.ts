/**
 * dsh-mud-core — **投递通道：官方 `deferContext` / `concludeTurn`**（`doc/ARCHITECTURE.md` §19.6.2）。
 *
 * 两条判据 + B3 的落点都在这里：
 *   - **判据 A**：投递瞬间有工具在途 ⇒ 进 defer 槽（随该结果进下一步）；否则官方 `followup`。
 *   - **B3（2026-09-21 定案，取代旧判据 B）**：回合收束的判据由**流程驱动器**在
 *     `noteToolResult` 上给出（"本结果让流程收束了"）；包装器只转达 `exec.concludeTurn()`。
 *     旧判据 B（"本调用是投递最后一条动作 + 流程空闲"的投递尺寸推断）**已删除**。
 *     T2 自己发起的调用 id 不匹配本插件的确定性 call-id（`mud-<delivery>-<index>`）⇒ 永不收束。
 *   - 投递账本（流程判据解析依据）的驱逐策略 → 直测 `DeliveryChannel`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FlowSpec } from '../src/agent/flow/flows/index.ts'
import type { PerceptionRule } from '../src/perceive/types.ts'
import { DeliveryChannel } from '../src/deliver/delivery-channel.ts'
import { runWithDeliveryChannel } from '../src/session/mount.ts'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/network/manager.ts'
import type { MudLine } from '../src/network/ansi.ts'

/** 一条带动作的 event 规则（产生 T1 动作投递）。 */
const ACTION_RULE: PerceptionRule = {
  id: 'test:action',
  match: { kind: 'text', includes: ['需要动作'] },
  action: { output: '测试动作', tool: { name: 'mud_send', args: { cmd: 'look' } } },
}

/** 单步探针流程（`开始` 进入 → `结束` 命中 ok → 终态）。 */
const PROBE_FLOW: FlowSpec = {
  id: 'probe',
  priority: 100,
  entry: 'only',
  timeoutMs: 30_000,
  steps: [{
    id: 'only',
    driver: { kind: 'text', includes: ['开始'] },
    action: { tool: 'mud_send', args: { cmd: 'probe' } },
    ok: [{ kind: 'text', includes: ['结束'] }],
  }],
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function harness(sessionId: string, options: { flow?: boolean } = {}): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
  delivered: string[]
  /** 投递里的动作（B3 测试要真执行本步动作才有窗口/工具结果）。 */
  actions: { callId: string; tool: { name: string; args: Record<string, unknown> } }[]
} {
  const delivered: string[] = []
  const actions: { callId: string; tool: { name: string; args: Record<string, unknown> } }[] = []
  let captured: MudConnectionSink | null = null
  const connection = {
    id: 'conn-1',
    state: 'connected',
    client: { send: () => true },
  }
  const connections = {
    open: (_t: unknown, sink: MudConnectionSink) => { captured = sink; return connection },
    get: () => connection,
    close: () => {},
    list: () => [connection],
    closeAll: () => {},
  } as unknown as MudConnectionManager
  const agent = {
    id: sessionId,
    status: 'idle',
    inbox: { nextTurn: [] },
    followup: (message: {
      content: readonly { type: string; text?: string }[]
      source?: {
        delivery?: string
        actions?: readonly { tool: { name: string; args?: Record<string, unknown> } }[]
      }
    }) => {
      delivered.push(message.content.find(b => b.type === 'text')?.text ?? '')
      const delivery = message.source?.delivery ?? 'd0'
      ;(message.source?.actions ?? []).forEach((action, index) => {
        actions.push({ callId: `mud-${delivery}-${index}`, tool: { name: action.tool.name, args: action.tool.args ?? {} } })
      })
    },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    pushGame: () => {}, pushUi: () => {}, pushWorld: () => {},
    log: () => {}, debug: () => {}, decision: () => {},
  }
  const config: MudRuntimeConfig = {
    agentMode: 'full',
    commandIntervalMs: 0,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: 60_000,
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
    ...(options.flow === true ? { flows: [PROBE_FLOW] } : {}),
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: [ACTION_RULE],
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    delivered,
    actions,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

describe('投递通道 (判据 A: 工具在途 ⇒ defer)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('工具在途 → 投递进 defer 槽, 不走 followup; 离开后取走', () => {
    const h = harness('session-defer')
    h.runtime.connect()
    h.sink().onConnect()

    h.runtime.beginToolCall()
    h.sink().onLines([ml('需要动作的行', 0)])
    h.sink().onBoundary('ga')
    // 没有走 followup（消息在槽里）。
    expect(h.delivered).toEqual([])
    const deferred = h.runtime.takeDeferredDeliveries()
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.content.find(b => b.type === 'text')?.text).toContain('需要动作的行')
    expect(deferred[0]!.source).toMatchObject({ kind: 'mud-owned', lane: 't1' })

    // 槽已取空。
    expect(h.runtime.takeDeferredDeliveries()).toEqual([])
    h.runtime.endToolCall()
    h.runtime.dispose()
  })

  it('没有工具在途 → 照旧走 followup (自己开一个回合)', () => {
    const h = harness('session-followup')
    h.runtime.connect()
    h.sink().onConnect()

    h.sink().onLines([ml('需要动作的行', 0)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('需要动作的行')
    expect(h.runtime.takeDeferredDeliveries()).toEqual([])
    h.runtime.dispose()
  })
})

describe('收束判据 (B3: 终态由流程驱动器给, 包装器转达)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('非流程动作 / T2 自己的 call-id ⇒ 永不收束', () => {
    const h = harness('session-conclude')
    h.runtime.connect()
    h.sink().onConnect()

    // 规则动作（ruleId = `test:action`，不是 `flow:*`）：驱动器无事可判 ⇒ 不收束。
    h.sink().onLines([ml('需要动作的行', 0)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.runtime.noteToolResult('mud-d1-0', 'ok')).toBe(false)
    // T2 自己发起的调用 id 不是本插件确定性 call-id ⇒ 永不收束（R1/R3 面不变）。
    expect(h.runtime.noteToolResult('call_abc123', 'ok')).toBe(false)
    h.runtime.dispose()
  })

  it('流程步走到终态 ⇒ 驱动器判收束, 包装器转达 concludeTurn 恰一次', async () => {
    const h = harness('session-conclude-flow', { flow: true })
    h.runtime.connect()
    h.sink().onConnect()

    // 入口命中 → 进入 probe/only → 投递本步动作。
    h.sink().onLines([ml('开始', 0)])
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'probe', stepId: 'only' })
    const action = h.actions.at(-1)
    expect(action).toBeDefined()

    let concluded = 0
    const pending = runWithDeliveryChannel({
      channel: h.runtime,
      callId: action!.callId,
      exec: { deferContext: () => {}, concludeTurn: () => { concluded += 1 } },
      run: async () => await h.runtime.tools()[action!.tool.name]!.execute({ ...action!.tool.args }),
    })
    vi.advanceTimersByTime(1)          // 命令写出 → confirmSent 武装
    // 结果行命中窗口关闭触发 → 驱动器复判 → ok（无后继 = 终态）→ 收束。
    h.sink().onLines([ml('结束', 1)])
    h.sink().onBoundary('ga')
    await pending
    expect(h.runtime.diag().flow).toBeNull()
    expect(concluded).toBe(1)
    h.runtime.dispose()
  })
})

/**
 * **投递账本**（流程判据解析依据 + 驱逐策略）—— 直测 `DeliveryChannel`：
 * B3 删掉判据 B 之后，账本不再参与"回合收束"推断，只剩"工具结果 → 流程步骤"的解析
 * 与自身有界性两件事，故不再经运行时观测。
 */
describe('投递账本 (rule 解析 + 按完成驱逐 + 安全上限)', () => {
  it('actionRule 按 index 对齐; 结果收齐 → 下一次记账驱逐它', () => {
    const channel = new DeliveryChannel({ debug: () => {} })
    channel.rememberDelivery('d1', [{ ruleId: 'flow:probe/only' }])
    expect(channel.actionRule('d1', 0)).toBe('flow:probe/only')
    expect(channel.actionRule('d1', 1)).toBeUndefined()
    expect(channel.actionRule('d9', 0)).toBeUndefined()

    // 结果未回 ⇒ 在途投递保留（慢结果不丢解析依据）。
    for (let i = 2; i <= 5; i += 1) channel.rememberDelivery(`d${i}`, [{ ruleId: 'flow:probe/only' }])
    expect(channel.actionRule('d1', 0)).toBe('flow:probe/only')

    // d1 结果收齐 → 下一次记账（d6）把它逐出。
    channel.recordResult('d1')
    channel.rememberDelivery('d6', [{ ruleId: 'flow:probe/only' }])
    expect(channel.actionRule('d1', 0)).toBeUndefined()
    expect(channel.actionRule('d6', 0)).toBe('flow:probe/only')
  })

  it('安全上限 32: 在途超限时仍从最旧开始丢, 最新的保留', () => {
    const channel = new DeliveryChannel({ debug: () => {} })
    for (let i = 1; i <= 40; i += 1) channel.rememberDelivery(`d${i}`, [{ ruleId: 'r' }])
    // d1..d40 → 上限 32 ⇒ 仅保留 d9..d40。
    expect(channel.actionRule('d8', 0)).toBeUndefined()
    expect(channel.actionRule('d9', 0)).toBe('r')
    expect(channel.actionRule('d40', 0)).toBe('r')
  })
})
