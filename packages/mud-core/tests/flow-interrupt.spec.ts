/**
 * dsh-mud-core — 打断与排队的运行时接线（`doc/ARCHITECTURE.md` §19.4 / 不变量 I14）。
 *
 * 规则声明 `interrupts`（纯数字，越大越强）后，**只在有流程实例挂起时**参与：
 *   - `interrupts > flow.priority` ⇒ **打断**：挂起的工具调用当场结算为 `interrupted`
 *     （可读原因、不悬挂、不静默）、流程复位（只留入口）、`onInterrupt` 直发、
 *     本规则动作照常投递（走官方工具路径）；
 *   - 档位不够 ⇒ **排队**：动作等流程结束（终态/失败/打断）后立即执行；
 *   - 未声明 ⇒ 不打断也不排队（照常投递）。
 *
 * 基准：`normal = 100`；login = 1000（**不可打断**）；fullme = 100（可被战斗类打断）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LOGIN_FLOW, PRIORITY_NORMAL, type FlowSpec } from '../src/config/flows.ts'
import type { PerceptionRule } from '../src/trigger-llm/types.ts'
import { MudSessionRuntime, type MudRuntimeConfig, type MudRuntimeSink } from '../src/runtime/session-runtime.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/runtime/connection.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

const NAME_PROMPT = '您的英文名字：'

/**
 * 一条练功类流程（priority = normal = 100；可被战斗打断）。
 *
 * 命令故意**不用 `dazuo`/`dz`**：那两个在活动表里（声明 `until` 完成句 → GA 不结算），
 * 与本用例要验证的"GA 结算 / 打断结算"不是一回事。
 */
const PRACTICE_FLOW: FlowSpec = {
  id: 'practice',
  priority: PRIORITY_NORMAL,
  entry: 'start',
  timeoutMs: 30_000,
  steps: [
    {
      id: 'start',
      driver: { kind: 'text', includes: ['你开始练习剑法。'] },
      action: { tool: 'mud_send', args: { cmd: 'lian sword' } },
      ok: [{ kind: 'ga' }],
      onInterrupt: ['halt'],
      // 两步流程: `start` 成功（GA）后进入"等收功句"的判定节点（流程仍活跃），
      // 这样"排队动作要等流程真的结束才出队"才可验证。
      next: ['done'],
    },
    {
      id: 'done',
      driver: { kind: 'text', includes: ['你练完了一趟剑法。'] },
      // 判定节点（无 action）：进入判据命中即成功；无后继 = 终态。
    },
  ],
}

/** 战斗类规则（档位 200 > 100 ⇒ 可打断练功；但 < 1000 ⇒ 打不断登录）。 */
const COMBAT_RULE: PerceptionRule = {
  id: 'test:combat',
  eventType: 'p:test:combat',
  match: { kind: 'text', includes: ['一个流氓拦住了你的去路'] },
  action: {
    output: '战斗: 一个流氓拦住了你',
    tool: { name: 'mud_send', args: { cmd: 'kill liumang' } },
    interrupts: 200,
  },
}

/** 档位不够的规则（50 < 100 ⇒ 只能排队）。 */
const MINOR_RULE: PerceptionRule = {
  id: 'test:minor',
  eventType: 'p:test:minor',
  match: { kind: 'text', includes: ['远处传来一声吆喝'] },
  action: {
    output: '杂事: 远处一声吆喝',
    tool: { name: 'mud_send', args: { cmd: 'listen' } },
    interrupts: 50,
  },
}

/** 未声明 interrupts 的规则（不打断也不排队）。 */
const PLAIN_RULE: PerceptionRule = {
  id: 'test:plain',
  eventType: 'p:test:plain',
  match: { kind: 'text', includes: ['天空飘过一片云'] },
  action: { output: '天气: 云', tool: { name: 'mud_send', args: { cmd: 'look sky' } } },
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

interface Delivered {
  text: string
  lane?: string
  actions: readonly { ruleId: string; tool: { name: string; args: Record<string, unknown> } }[]
}

function harness(sessionId: string, options: {
  flows: readonly FlowSpec[]
  rules: readonly PerceptionRule[]
  withAccount?: boolean
}): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
  sent: string[]
  delivered: Delivered[]
  logs: string[]
} {
  const sent: string[] = []
  const delivered: Delivered[] = []
  const logs: string[] = []
  let captured: MudConnectionSink | null = null
  const connection = {
    id: 'conn-1',
    state: 'connected',
    client: { send: (text: string) => { sent.push(text); return true } },
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
      source?: { lane?: string; actions?: readonly { ruleId: string; tool: { name: string; args: Record<string, unknown> } }[] }
    }) => {
      delivered.push({
        text: message.content.find(b => b.type === 'text')?.text ?? '',
        ...(message.source?.lane === undefined ? {} : { lane: message.source.lane }),
        actions: message.source?.actions ?? [],
      })
    },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    captcha: () => {},
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: (_id, text) => { logs.push(text) },
    debug: () => {},
    decision: () => {},
  }
  const config: MudRuntimeConfig = {
    agentEnabled: true,
    commandIntervalMs: 0,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: 3_600_000,
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
    flows: options.flows,
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: options.rules,
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sent,
    delivered,
    logs,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

/** 假 loop: 执行最新一条投递里的动作（官方工具路径 → 桥挂起）。 */
async function runLatestAction(h: ReturnType<typeof harness>): Promise<{ ruleId: string; pending: Promise<{ ok: boolean; settled?: string; note: string }> }> {
  const message = h.delivered.at(-1)
  if (message === undefined || message.actions.length === 0) throw new Error('没有待执行动作')
  const action = message.actions[0]!
  const tool = h.runtime.tools()[action.tool.name]
  if (tool === undefined) throw new Error(`未知工具 ${action.tool.name}`)
  const pending = Promise.resolve(tool.execute({ ...action.tool.args })) as Promise<{ ok: boolean; settled?: string; note: string }>
  await vi.advanceTimersByTimeAsync(1)
  return { ruleId: action.ruleId, pending }
}

describe('打断与排队 (§19.4)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 起一个练功流程并挂起（在途命令已写出）。 */
  async function suspendedPractice(sessionId: string, rules: readonly PerceptionRule[]) {
    const h = harness(sessionId, { flows: [PRACTICE_FLOW], rules })
    h.runtime.connect()
    h.sink().onConnect()
    vi.advanceTimersByTime(10)
    h.sink().onLines([ml('你开始练习剑法。', 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    expect(first.ruleId).toBe('flow:practice/start')
    expect(h.sent).toContain('lian sword')
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'practice', stepId: 'start' })
    return { h, first }
  }

  it('分支阶段也计时: 步成功后后继 driver 永不到达 → 等待后继判据超时 (不静默)', async () => {
    const { h, first } = await suspendedPractice('session-branch-timeout', [])

    // start 的 ok:[GA] 命中 → 本步成功 → 进入 awaiting-branch 等 done 的驱动句。
    h.sink().onBoundary('ga')
    await first.pending
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'practice', stepId: 'start', phase: 'awaiting-branch' })

    // 分支阶段计时器到点（窗口 = 该步 timeoutMs ?? 流程 timeoutMs）→ 超时失败收束。
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('等待后继判据超时')
    h.runtime.dispose()
  })

  it('档位够 → 打断: 挂起结算为 interrupted + 流程复位 + onInterrupt 直发 + 事件动作投递', async () => {
    const { h, first } = await suspendedPractice('session-interrupt', [COMBAT_RULE])

    h.sink().onLines([ml('一个流氓拦住了你的去路', 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)

    // ① 挂起的工具调用当场结算为 interrupted (不悬挂、不静默)。
    const reply = await first.pending
    expect(reply.ok).toBe(false)
    expect(reply.settled).toBe('interrupted')
    expect(reply.note).toContain('流程打断')
    // ② 流程复位 (只留入口)。
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('practice 被 test:combat 打断')
    // ③ onInterrupt 直发 (halt)。
    expect(h.sent).toContain('halt')
    // ④ 打断事件的动作照常投递 (T1)。
    const combat = h.delivered.filter(msg => msg.actions.some(a => a.ruleId === 'test:combat'))
    expect(combat).toHaveLength(1)
    expect(combat[0]!.actions[0]!.tool).toEqual({ name: 'mud_send', args: { cmd: 'kill liumang' } })
    h.runtime.dispose()
  })

  it('档位不够 → 排队: 当时不投递, 流程结束后立即出队投递', async () => {
    const { h, first } = await suspendedPractice('session-queue', [MINOR_RULE])

    h.sink().onLines([ml('远处传来一声吆喝', 1)])
    await vi.advanceTimersByTimeAsync(1)

    // 排队: 不打断 (工具仍挂起)、不投递 (本批只有待决行, 没有 T1 动作消息)。
    expect(h.delivered.some(msg => msg.actions.some(a => a.ruleId === 'test:minor'))).toBe(false)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'practice', stepId: 'start' })
    expect(h.logs.join('\n')).toContain('无打断权 → 排队')
    let settled = false
    void first.pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)

    // 流程自己的 GA 到达 → start 步成功 → 进入"等收功句"的分支阶段（流程仍活跃）：
    // 排队动作**仍然不出队**（流程还没结束）。
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'practice', stepId: 'start', phase: 'awaiting-branch' })
    expect(h.delivered.some(msg => msg.actions.some(a => a.ruleId === 'test:minor'))).toBe(false)
    expect((await first.pending).ok).toBe(true)

    // 收功句到达 → done 判定节点 → 终态 → 排队动作此刻才出队投递。
    h.sink().onLines([ml('你练完了一趟剑法。', 2)])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runtime.diag().flow).toBeNull()
    const minor = h.delivered.filter(msg => msg.actions.some(a => a.ruleId === 'test:minor'))
    expect(minor).toHaveLength(1)
    expect(minor[0]!.actions[0]!.tool).toEqual({ name: 'mud_send', args: { cmd: 'listen' } })
    h.runtime.dispose()
  })

  it('未声明 interrupts → 不打断也不排队 (照常投递)', async () => {
    const { h } = await suspendedPractice('session-plain', [PLAIN_RULE])

    h.sink().onLines([ml('天空飘过一片云', 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)

    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'practice' })     // 流程没被打断
    const plain = h.delivered.filter(msg => msg.actions.some(a => a.ruleId === 'test:plain'))
    expect(plain).toHaveLength(1)                                           // 动作照常投递
    expect(h.logs.join('\n')).not.toContain('排队')
    h.runtime.dispose()
  })

  it('空闲时 rules 的 interrupts 不生效 (无流程 → 正常投递)', async () => {
    const h = harness('session-idle', { flows: [PRACTICE_FLOW], rules: [COMBAT_RULE] })
    h.runtime.connect()
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    h.sink().onLines([ml('一个流氓拦住了你的去路', 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)

    const combat = h.delivered.filter(msg => msg.actions.some(a => a.ruleId === 'test:combat'))
    expect(combat).toHaveLength(1)
    expect(h.sent).not.toContain('halt')
    h.runtime.dispose()
  })

  it('login = 1000: 战斗类打断了登录 → 只能排队 (用户定案: login 不可打断)', async () => {
    const h = harness('session-login-shield', {
      flows: [LOGIN_FLOW, PRACTICE_FLOW],
      rules: [COMBAT_RULE],
    })
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // 登录流程激活并挂起在 name 步 (命令已写出)。
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    expect(first.ruleId).toBe('flow:login/name')
    expect(h.sent).toContain('tester')

    // 战斗事件到达: 200 < 1000 → 打断失败 → 排队。
    h.sink().onLines([ml('一个流氓拦住了你的去路', 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'name' })
    expect(h.delivered.some(msg => msg.actions.some(a => a.ruleId === 'test:combat'))).toBe(false)
    expect(h.logs.join('\n')).toContain('无打断权 → 排队')
    h.runtime.dispose()
  })

  it('被打断的序列命令不再发剩下几条 (半截序列不发出)', async () => {
    const seriesFlow: FlowSpec = {
      id: 'practice',
      priority: PRIORITY_NORMAL,
      entry: 'start',
      timeoutMs: 30_000,
      steps: [{
        id: 'start',
        driver: { kind: 'text', includes: ['你开始练习剑法。'] },
        action: { tool: 'mud_send', args: { cmds: ['lian sword', 'look'] } },
        ok: [{ kind: 'ga' }],
        onInterrupt: ['halt'],
      }],
    }
    const h = harness('session-series', { flows: [seriesFlow], rules: [COMBAT_RULE] })
    h.runtime.connect()
    h.sink().onConnect()
    vi.advanceTimersByTime(10)
    h.sink().onLines([ml('你开始练习剑法。', 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    expect(h.sent).toContain('lian sword')

    // 第一条命令在途时被打断 → 第二条 (`look`) 不再发出。
    h.sink().onLines([ml('一个流氓拦住了你的去路', 1)])
    vi.advanceTimersByTime(1)
    const reply = await first.pending
    expect(reply.settled).toBe('interrupted')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).not.toContain('look')
    h.runtime.dispose()
  })

  it('流程超时失败收束时, 排队动作也会出队投递 (计时器路径)', async () => {
    const { h, first } = await suspendedPractice('session-queue-timeout', [MINOR_RULE])

    h.sink().onLines([ml('远处传来一声吆喝', 1)])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.delivered.some(msg => msg.actions.some(a => a.ruleId === 'test:minor'))).toBe(false)

    // 流程自己的 30s 计时器到点 (等待本步结果) → 失败收束 → 排队动作出队。
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('本步超时')
    const minor = h.delivered.filter(msg => msg.actions.some(a => a.ruleId === 'test:minor'))
    expect(minor).toHaveLength(1)
    void first.pending
    h.runtime.dispose()
  })
})
