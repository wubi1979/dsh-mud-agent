/**
 * dsh-mud-core — **login 流程在官方 loop 模拟器下的回合/步骤账目**（`doc/ARCHITECTURE.md` §19.6）。
 *
 * 目的：量清楚形态 C 第 5 步③（删非入口投递 + T1 按槽渲染）后，login 在官方 loop 语义下的
 * 形状 —— 一个流程占几个回合、每步花几次模型请求、空认领里哪些是有效续步。
 * 结论写进 §19.6 / PLAN W10.4 第 5 步。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import defaultPerceptionRules from '../src/perceive/rules.ts'
import type { PerceptionRule } from '../src/perceive/types.ts'
import { defaultFlows, PRIORITY_NORMAL, type FlowSpec } from '../src/agent/flow/flows/index.ts'
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

function harness(
  sessionId: string,
  earlyStop: SimEarlyStop = 'conclude-turn',
  options: { flows?: readonly FlowSpec[]; eventRules?: readonly PerceptionRule[] } = {},
): {
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
    flows: options.flows ?? defaultFlows,
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
    eventRules: options.eventRules ?? defaultPerceptionRules.filter(rule => rule.lane !== 'state'),
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

  it('真行为 (槽渲染 + conclude): 1 回合 / 3 步 / 零投递 / 零空步', async () => {
    const h = await runLogin('sim-login-defer')

    // §19.6.2 + 第 5 步③落地后的账目：整条 login 落在**一个回合**内；只有入口步投递，
    // pass/success 靠 T1 按槽渲染（claimless 但有 tool-call = 有效续步，不是浪费）。
    expect(h.sim.stats).toMatchObject({
      turns: 1,            // 整条 login = 一个回合
      steps: 3,            // name / pass / success 各一步
      modelCalls: 3,
      emptySteps: 2,       // = claimlessSteps + idleSteps（D5 拆分）
      claimlessSteps: 2,   // pass / success：claim=0 但槽渲出 tool-call（有效续步）
      idleSteps: 0,        // 收束空步 = 0（B3 收束；A vs B 裁决看这里）
      t1Calls: 3,
      t2Calls: 0,          // 流程期间绝不落到 T2（真实 LLM）
      toolCalls: 3,
      deferred: 0,         // 非入口步不 push hit ⇒ 无 deferContext 投递（③ 删非入口投递）
      concludedTurns: 1,   // success 的空命令 GA 落地后流程收束 → 该结果 concludeTurn（判据 B）
    })
    // 只有入口步有投递（claim=1）；续步 claim=0 但 lane 仍为 t1（T1 按槽渲）。
    expect(h.sim.trace.filter(e => e.event === 'step/start').map(e => e.detail)).toEqual([
      'claim=1 lane=t1', 'claim=0 lane=t1', 'claim=0 lane=t1',
    ])
    h.runtime.dispose()
  })

  /**
   * **W10.4 账目之一：删掉判据 B 的代价**（PLAN §D5 删除面 / §6.4）。
   *
   * 判据 B（`shouldConcludeTurn` + 投递尺寸记账）在新模型下没有存在理由 —— T1 持状态，
   * 不需要"由运行时观测流程是否空闲来替 T1 收束回合"。
   *
   * **实测结论（第 5 步③后）**：删掉判据 B 后，流程末步的工具结果不标记 `concludesTurn`，
   * 非入口步又不投递 ⇒ `next-step` 为空、`turnEnds` 仍为 null ⇒ 回合**不会结束**，而是再走
   * 一个 `claim=0` 的步：这一步没有任何新输入，T1 无可渲染动作才收束 —— 即 **idleSteps=1**。
   *
   * 即：**1 回合 / 4 步 / 4 请求 / 1 空步**（conclude 路径：3 步 / 0 空步）。
   * §D5 写的"T1 无动作即 `finish stop` 自然收束"实际就是这一空步 —— 它是 T1 本地确定性
   * 请求，但按 §19.6.1 规矩必须记账（回合数不变、T2 不介入）。
   */
  it('删判据 B 的代价 (实测): 1 回合 / 4 步 / 4 请求 / 1 空步 (idle)', async () => {
    const h = await runLogin('sim-login-no-conclude', 'none')

    expect(h.sim.stats).toMatchObject({
      turns: 1,            // 仍是一个回合（无 T2 介入、无 followup）
      steps: 4,            // name / pass / success + 末步"无动作收束"
      modelCalls: 4,
      t1Calls: 4,
      t2Calls: 0,
      toolCalls: 3,        // 工具调用仍是 3 次（末步不产生工具调用）
      emptySteps: 3,       // = claimless(2, 有效续步) + idle(1, 收束空步)
      claimlessSteps: 2,   // pass / success 槽渲染
      idleSteps: 1,        // 末步 claim=0 且无 tool-call —— **删判据 B 换来的空步**
      deferred: 0,         // 非入口步零投递
      concludedTurns: 0,   // 判据 B 已删除：没有任何工具结果标记 concludesTurn
    })
    expect(h.sim.trace.filter(e => e.event === 'step/start').map(e => e.detail)).toEqual([
      'claim=1 lane=t1', 'claim=0 lane=t1', 'claim=0 lane=t1', 'claim=0 lane=t1',
    ])
    // 末步 = 空认领 → T1 无可渲染动作 → 收束（删判据 B 换来的那一空步）。
    expect(h.sim.trace.find(e => e.turn === 1 && e.step === 4 && e.event === 'request'))
      .toMatchObject({ detail: 'T1 → 收束' })
    h.runtime.dispose()
  })
})

describe('官方 loop 模拟器: 打断的回合/步骤账目（§6.4 / D5 followup 代价）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 练功流程（同 `flow-interrupt.spec` 的 PRACTICE_FLOW：单步 + GA 结算，可被战斗打断）。 */
  const PRACTICE_FLOW: FlowSpec = {
    id: 'practice',
    priority: PRIORITY_NORMAL,
    entry: 'start',
    timeoutMs: 30_000,
    steps: [{
      id: 'start',
      driver: { kind: 'text', includes: ['你开始练习剑法。'] },
      action: { tool: 'mud_send', args: { cmd: 'lian sword' } },
      ok: [{ kind: 'ga' }],
      onInterrupt: ['halt'],
    }],
  }

  /** 战斗类规则（档位 200 > 100 ⇒ 可打断练功）。 */
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

  /**
   * **打断账目（第 6 步接线后实测）**：练功在途时战斗事件到达 → 在途结算 `interrupted`、
   * 流程复位、combat 动作**持有**（D5，不再 defer 进同回合）→ 回合 1 收束 → 静止点
   * `onAgentIdle()` → `flushInterruptFollowups` 以 followup 开**新回合**投递 → T1 渲染
   * combat 动作执行（回合 2）。
   *
   * 代价 = **+1 回合 / +2 步（工具步 + 收束空步）/+2 次 T1 请求**，全程无 T2、零 defer。
   */
  it('打断 → followup 新回合: 2 回合 / 4 步 / 4 请求 / 全 T1 / 零 defer', async () => {
    const h = harness('sim-interrupt', 'conclude-turn', {
      flows: [PRACTICE_FLOW],
      eventRules: [COMBAT_RULE],
    })
    h.runtime.connect()
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // ① 练功入口句 → 流程激活 → 投递入口动作 → 回合 1 → T1 渲 mud_send {lian sword}。
    h.sink().onLines([ml('你开始练习剑法。', 0)])
    h.sink().onBoundary('ga')
    await until(() => h.sent.includes('lian sword'), 'lian sword 写出')

    // ② 打断句 → 在途结算 interrupted → 流程复位 + onInterrupt 直发 (halt) →
    //    combat 动作持有 (D5)。驱动器随后排空 → 静止点 → followup 新回合 → 回合 2
    //    里 T1 渲染 combat 动作并执行。
    h.sink().onLines([ml('一个流氓拦住了你的去路', 1)])
    h.sink().onBoundary('ga')
    expect(h.logs.join('\n')).toContain('practice 被 test:combat 打断')
    // halt 走命令队列节流（queue.send），推进假计时器后才写出。
    await until(() => h.sent.includes('halt'), 'halt 写出 (onInterrupt 直发)')
    await until(() => h.sent.includes('kill liumang'), 'kill liumang 写出 (followup 新回合)')

    // ③ combat 的 mud_send 无声明判据 → hold 兜底 3s 结算 → 回合 2 收束空步。
    await vi.advanceTimersByTimeAsync(3001)
    await h.sim.whenIdle()

    // 证据: 紧凑轨迹。
    // eslint-disable-next-line no-console
    console.log('\n[sim] 打断轨迹:\n' + h.sim.report() + '\n[sim] 统计: ' + JSON.stringify(h.sim.stats))
    expect(h.sim.stats).toMatchObject({
      turns: 2,            // 流程回合 (1) + combat followup 回合 (2)
      steps: 4,            // 每回合: 1 工具步 + 1 收束空步
      modelCalls: 4,
      t1Calls: 4,
      t2Calls: 0,          // 打断路径全程 T1，真实 LLM 不介入
      toolCalls: 2,        // lian sword + kill liumang
      emptySteps: 2,
      claimlessSteps: 0,   // 两回合都是入口投递起手 (claim=1)，无槽渲染续步
      idleSteps: 2,        // 两回合各 1 个收束空步
      deferred: 0,         // 打断动作不再 defer（D5 的本意）
      concludedTurns: 0,   // 流程被复位（非终态收束），没有结果触发 concludeTurn
    })
    // 回合起手都是 claim=1（投递）；回合内第二步都是 claim=0 收束。
    expect(h.sim.trace.filter(e => e.event === 'step/start').map(e => e.detail)).toEqual([
      'claim=1 lane=t1', 'claim=0 lane=t1', 'claim=1 lane=t1', 'claim=0 lane=t1',
    ])
    h.runtime.dispose()
  })
})