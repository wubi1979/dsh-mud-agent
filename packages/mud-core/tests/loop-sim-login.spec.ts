/**
 * dsh-mud-core — **login 流程在官方 loop 模拟器下的回合/步骤账目**（`doc/ARCHITECTURE.md` §19.6）。
 *
 * 目的：量清楚"现行 T1 投递（`agent.followup`）"在官方 loop 语义下到底是什么形状 ——
 * 一个流程占几个回合、每步花几次模型请求、有没有"空续步"。结论写进 §19.6。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import defaultPerceptionRules from '../src/perceive/rules.ts'
import { defaultFlows } from '../src/agent/flow/flows/index.ts'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/network/manager.ts'
import type { MudLine } from '../src/network/ansi.ts'
import { LoopSim, until, type SimEarlyStop } from './loop-sim.ts'

const NAME_PROMPT = '您的英文名字：'
const PASS_PROMPT = '此ID档案已存在，请输入密码：'
const LOGIN_DONE = '目前权限：(player)'

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function harness(sessionId: string, earlyStop: SimEarlyStop = 'conclude-turn'): {
  runtime: MudSessionRuntime
  sim: LoopSim
  sink: () => MudConnectionSink
  sent: string[]
  logs: string[]
} {
  const sent: string[] = []
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
  const config: MudRuntimeConfig = {
    agentMode: 'full',
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
    flows: defaultFlows,
  }
  // 先建运行时（需要 sink），再建模拟器（需要运行时），最后回填 agentOf。
  let sim: LoopSim | null = null
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId && sim !== null ? sim.facade() : undefined),
    captcha: () => {},
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: (_id, text) => { logs.push(text) },
    debug: () => {},
    decision: () => {},
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: defaultPerceptionRules.filter(rule => rule.lane === 'state'),
    eventRules: defaultPerceptionRules.filter(rule => rule.lane !== 'state'),
    holdRuleIds: new Set(),
  })
  sim = new LoopSim(sessionId, runtime, text => { logs.push(text) }, { earlyStop })
  return {
    runtime,
    sim,
    sent,
    logs,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

describe('官方 loop 模拟器: login 流程的回合/步骤账目', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 跑完整条 login 流程（同一条驱动/喂食交错路径）；返回观测。 */
  async function runLogin(sessionId: string, earlyStop: SimEarlyStop = 'conclude-turn') {
    const h = harness(sessionId, earlyStop)
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // ① 名字提示 → 流程激活 → 投递动作 → 驱动器起来 → T1 渲染 mud_send {name}
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    await until(() => h.sent.includes('tester'), 'name 命令写出')

    // ② 密码提示（应答帧）→ name 成功 → 投递 {pass} → 工具结果 → ……
    h.sink().onLines([ml(PASS_PROMPT, 1)])
    h.sink().onBoundary('ga')
    await until(() => h.sent.includes('secret'), 'pass 命令写出')

    // ③ 成功句到达 → success 步（终态）：投递**空命令**（登录收尾，不再发 look）
    h.sink().onLines([ml(LOGIN_DONE, 2)])
    h.sink().onBoundary('ga')
    await until(() => h.sent.filter(cmd => cmd === '').length >= 1, '空命令写出')

    // ④ 空命令的 GA → 终态 → 流程结束
    h.sink().onBoundary('ga')
    await h.sim.whenIdle()
    expect(h.logs.join('\n')).toContain('[流程] login 完成（终态）')
    // 证据: 紧凑轨迹（回合/步骤边界一目了然）。
    // eslint-disable-next-line no-console
    console.log('\n[sim] 轨迹:\n' + h.sim.report() + '\n[sim] 统计: ' + JSON.stringify(h.sim.stats))
    return h
  }

  it('真行为 (defer + conclude): 1 个回合 / 3 次模型请求', async () => {
    const h = await runLogin('sim-login-defer')

    // §19.6.2 落地后的账目：整条 login 落在**一个回合**内，每步一次模型请求，没有空续步。
    expect(h.sim.stats).toMatchObject({
      turns: 1,          // 整条 login = 一个回合
      steps: 3,          // name / pass / success 各一步（下一步随结果进同一回合）
      modelCalls: 3,
      emptySteps: 0,
      t1Calls: 3,
      t2Calls: 0,        // 流程期间绝不落到 T2（真实 LLM）
      toolCalls: 3,
      deferred: 2,       // name→pass、pass→success 两次下一步动作随结果走（判据 A）
      concludedTurns: 1, // success 的空命令 GA 落地后流程收束 → 该结果 concludeTurn（判据 B）
    })
    // 每步都拿到新投递（没有 claim=0 的空续步）。
    expect(h.sim.trace.filter(e => e.event === 'step/start').map(e => e.detail)).toEqual([
      'claim=1 lane=t1', 'claim=1 lane=t1', 'claim=1 lane=t1',
    ])
    h.runtime.dispose()
  })

  /**
   * **W10.4 账目之一：删掉判据 B 的代价**（PLAN §D5 删除面 / §6.4）。
   *
   * 判据 B（`shouldConcludeTurn` + 投递尺寸记账）在新模型下没有存在理由 —— T1 持状态，
   * 不需要"由运行时观测流程是否空闲来替 T1 收束回合"。
   *
   * **实测结论（与 §D5 的预期不同，是本次账目的发现）**：删掉判据 B 后，流程末步的工具结果
   * 不再标记 `concludesTurn`，而工具结果**不进 `next-step`**（官方只在 `deferContext` 时
   * 往 `next-step` 追加）⇒ 末步之后 `next-step` 为空、`turnEnds` 仍为 null ⇒ 回合**不会结束**，
   * 而是**再走一个 `claim=0` 的步**（空续步）：这一步没有任何新输入，只因 T1 无可渲染动作才收束。
   *
   * 即：**1 回合 / 4 步 / 4 请求 / 1 空续步**（现行：3 步 / 3 请求 / 0 空续步）。
   * §D5 写的"T1 无动作即 `finish stop` 自然收束"实际就是这一空步 —— 它是 T1 本地确定性请求，
   * 但按 §19.6.1 规矩必须记账（回合数不变、T2 不介入）。
   */
  it('删判据 B 的代价 (实测): 1 回合 / 4 步 / 4 请求 / 1 空续步', async () => {
    const h = await runLogin('sim-login-no-conclude', 'none')

    expect(h.sim.stats).toMatchObject({
      turns: 1,          // 仍是一个回合（无 T2 介入、无 followup）
      steps: 4,          // name / pass / success + 末步"无动作收束"
      modelCalls: 4,
      t1Calls: 4,
      t2Calls: 0,
      toolCalls: 3,      // 工具调用仍是 3 次（末步不产生工具调用）
      emptySteps: 1,     // 末步 claim=0 —— **空续步**（本账目的发现）
      deferred: 2,
      concludedTurns: 0, // 判据 B 已删除：没有任何工具结果标记 concludesTurn
    })
    expect(h.sim.trace.filter(e => e.event === 'step/start').map(e => e.detail)).toEqual([
      'claim=1 lane=t1', 'claim=1 lane=t1', 'claim=1 lane=t1', 'claim=0 lane=t1',
    ])
    // 末步 = 空认领 → T1 无可渲染动作 → 收束（这就是删判据 B 换来的那一空步）。
    expect(h.sim.trace.find(e => e.turn === 1 && e.step === 4 && e.event === 'request'))
      .toMatchObject({ detail: 'T1 → 收束' })
    h.runtime.dispose()
  })
})