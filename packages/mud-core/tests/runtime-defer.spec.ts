/**
 * dsh-mud-core — **投递通道：官方 `deferContext` / `concludeTurn`**（`doc/ARCHITECTURE.md` §19.6.2）。
 *
 * 三条判据的落点都在这里：
 *   - **判据 A**：投递瞬间有工具在途 ⇒ 进 defer 槽（随该结果进下一步）；否则官方 `followup`。
 *   - **判据 B**：`shouldConcludeTurn(callId)` —— 本次调用是**某投递的最后一条动作**、且没有
 *     待投递、且**流程机空闲** ⇒ 可以收束回合。T2 自己发起的调用 id 不匹配本插件的确定性
 *     call-id（`mud-<delivery>-<index>`）⇒ **永不可收束**。
 *   - **判据 C**：失败/超时什么都不做（包装器只在 `result.ok` 时收束；见 `attachMudTools`）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FlowSpec } from '../src/runtime/flow/flows.ts'
import type { PerceptionRule } from '../src/perceive/types.ts'
import { MudSessionRuntime } from '../src/runtime/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/runtime/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/services/network/manager.ts'
import type { MudLine } from '../src/services/network/ansi.ts'

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
} {
  const delivered: string[] = []
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
    followup: (message: { content: readonly { type: string; text?: string }[] }) => {
      delivered.push(message.content.find(b => b.type === 'text')?.text ?? '')
    },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    pushGame: () => {}, pushUi: () => {}, pushWorld: () => {},
    log: () => {}, debug: () => {}, decision: () => {},
  }
  const config: MudRuntimeConfig = {
    agentEnabled: true,
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

describe('收束判据 (判据 B: 最后一条动作 + 流程空闲)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('本投递最后一条 + 流程空闲 → 可收束; 其它情形一律不可', () => {
    const h = harness('session-conclude')
    h.runtime.connect()
    h.sink().onConnect()

    // 产生一条投递 d1（1 动作）。
    h.sink().onLines([ml('需要动作的行', 0)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)

    expect(h.runtime.shouldConcludeTurn('mud-d1-0')).toBe(true)     // 最后一条 + 流程空闲
    expect(h.runtime.shouldConcludeTurn('mud-d1-1')).toBe(false)    // 不是最后一条
    expect(h.runtime.shouldConcludeTurn('mud-d9-0')).toBe(false)    // 未知投递
    expect(h.runtime.shouldConcludeTurn('call_abc123')).toBe(false) // T2 自己的调用 id ⇒ 永不收束
    h.runtime.dispose()
  })

  it('流程活跃期间不收束 (收束权归流程自己的计时器)', () => {
    const h = harness('session-conclude-flow', { flow: true })
    h.runtime.connect()
    h.sink().onConnect()

    // 先激活探针流程。
    h.sink().onLines([ml('开始', 0)])
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'probe' })

    // 流程活跃期间产生的动作投递 → 即使它是"本投递最后一条"，也不收束。
    h.sink().onLines([ml('需要动作的行', 1)])
    h.sink().onBoundary('ga')
    expect(h.runtime.shouldConcludeTurn('mud-d1-0')).toBe(false)
    h.runtime.dispose()
  })

  it('慢结果: 5 条在途投递各 1 动作、结果未回 → 最旧的在途投递不被提前驱逐', () => {
    const h = harness('session-retain')
    h.runtime.connect()
    h.sink().onConnect()

    for (let round = 0; round < 5; round += 1) {
      h.sink().onLines([ml('需要动作的行', round)])
      h.sink().onBoundary('ga')
    }
    expect(h.delivered).toHaveLength(5)

    // 旧实现"只留最近 4 条"：d1 会被驱逐 → shouldConcludeTurn('mud-d1-0') 永远 false（收不了束）。
    // 现在按完成驱逐：d1..d5 全部仍在途, 账目全部保留。
    expect(h.runtime.shouldConcludeTurn('mud-d1-0')).toBe(true)
    expect(h.runtime.shouldConcludeTurn('mud-d5-0')).toBe(true)
    h.runtime.dispose()
  })

  it('结果收齐 → 下一次新投递把它逐出账目 (按完成驱逐)', () => {
    const h = harness('session-prune')
    h.runtime.connect()
    h.sink().onConnect()

    h.sink().onLines([ml('需要动作的行', 0)])
    h.sink().onBoundary('ga')                  // d1（1 动作）
    h.runtime.noteToolResult('mud-d1-0', true) // d1 结果已回 → 完成
    h.sink().onLines([ml('需要动作的行', 1)])
    h.sink().onBoundary('ga')                  // d2 进入 → 逐出已完成的 d1
    expect(h.runtime.shouldConcludeTurn('mud-d1-0')).toBe(false) // 已逐出
    expect(h.runtime.shouldConcludeTurn('mud-d2-0')).toBe(true)
    h.runtime.dispose()
  })

  it('安全上限: 在途投递超 32 条时仍从最旧开始丢, 最新的保留', () => {
    const h = harness('session-cap')
    h.runtime.connect()
    h.sink().onConnect()

    for (let round = 0; round < 40; round += 1) {
      h.sink().onLines([ml('需要动作的行', round)])
      h.sink().onBoundary('ga')
    }
    expect(h.delivered).toHaveLength(40)
    // 0..40 → d1..d40；安全上限 32 ⇒ 仅保留 d9..d40。
    expect(h.runtime.shouldConcludeTurn('mud-d8-0')).toBe(false)
    expect(h.runtime.shouldConcludeTurn('mud-d9-0')).toBe(true)
    expect(h.runtime.shouldConcludeTurn('mud-d40-0')).toBe(true)
    h.runtime.dispose()
  })
})
