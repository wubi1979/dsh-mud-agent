/**
 * dsh-mud-core — 登录流程端到端 (流程表 + T1 动作渲染 + 桥挂起/唤醒)。
 *
 * 覆盖 v0.4.0 的架构 (`doc/ARCHITECTURE.md` §19)：
 *   1. **步骤图**（作者 2026-09-13 精简为 4 步）：`name → [pass, replace]`、
 *      `pass → [replace, success]`、`replace → pass`、`success`（终态，发空命令）；
 *   2. **arming**：进入某步即打开"本步 driver(重试) + 本步 ok/fail + 条件分支后继的进入判据"，
 *      所以"本步结果"与"下一步驱动句"同帧到达也不漏；
 *   3. **投递**：流程动作作为**正常 agent 消息**投出（`source.actions`），T1 只把它渲染成 tool-call；
 *   4. **挂起/唤醒**：工具经官方路径执行 → 桥挂起 → 判据命中/GA 唤醒（GA 必须来自本步自己的命令）；
 *   5. **失败**：命中 fail → 流程失败收束（复位到只留入口）。
 *
 * 测试里由"假 loop"承担官方 loop 的角色：取投递消息里的动作 → 调该工具（桥挂起）→ 喂应答帧 + GA。
 * 需要观测**回合/步骤边界**的结论请用 `tests/loop-sim.ts` + `tests/loop-sim-login.spec.ts`（§13.6）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import defaultPerceptionRules from '../src/perceive/rules.ts'
import { normalizeFlowSpecs } from '../src/agent/flow/flow-spec.ts'
import {
  LOGIN_FLOW, defaultFlows, flowCommands, validateFlows,
} from '../src/agent/flow/flows/index.ts'
import { runWithDeliveryChannel } from '../src/session/mount.ts'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/network/manager.ts'
import type { MudLine } from '../src/network/ansi.ts'

const NAME_PROMPT = '您的英文名字：'
const PASS_PROMPT = '此ID档案已存在，请输入密码：'
const LOGIN_DONE = '目前权限：(player)'
const REPLACE_PROMPT = '您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)'

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 一条投给 agent 的消息（含动作请求）。 */
interface Delivered {
  text: string
  lane?: string
  delivery?: string
  actions: readonly { ruleId: string; tool: { name: string; args: Record<string, unknown> } }[]
}

/** 官方投递消息的最小形状（`ownedGameMessage` 的产物）。 */
interface OwnedMessage {
  content: readonly { type: string; text?: string }[]
  source?: {
    lane?: string
    delivery?: string
    actions?: readonly { ruleId: string; tool: { name: string; args: Record<string, unknown> } }[]
  }
}

/** 投递消息 → 断言用的扁平记录。 */
function toDelivered(message: OwnedMessage): Delivered {
  return {
    text: message.content.find(b => b.type === 'text')?.text ?? '',
    ...(message.source?.lane === undefined ? {} : { lane: message.source.lane }),
    ...(message.source?.delivery === undefined ? {} : { delivery: message.source.delivery }),
    actions: message.source?.actions ?? [],
  }
}

function harness(sessionId: string): {
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
    followup: (message: OwnedMessage) => {
      delivered.push(toDelivered(message))
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
  // 只装 state 规则（登录规则已退役为流程步骤）——验证"规则表里不再有 login:*"。
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: defaultPerceptionRules.filter(r => r.lane === 'state'),
    eventRules: defaultPerceptionRules.filter(r => r.lane !== 'state'),
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

/**
 * 假 loop: 走**官方工具包装器**执行最新一条投递里的动作（真链路: begin/end + 工具结果
 * 回喂流程机 + defer —— 与 runtime-captcha.spec 的 startAction 同一接线）。
 */
async function runLatestAction(h: ReturnType<typeof harness>): Promise<{
  ruleId: string
  pending: Promise<unknown>
}> {
  const message = h.delivered.at(-1)
  if (message === undefined || message.actions.length === 0) throw new Error('没有待执行动作')
  if (message.delivery === undefined) throw new Error('投递消息没有 delivery id')
  const action = message.actions[0]!
  const tool = h.runtime.tools()[action.tool.name]
  if (tool === undefined) throw new Error(`未知工具 ${action.tool.name}`)
  const pending = runWithDeliveryChannel({
    channel: h.runtime,
    callId: `mud-${message.delivery}-0`,
    exec: {
      // 官方 loop: `additionalContexts` 进下一步认领消息 → 测试里等价于"多了一条投递"。
      deferContext: (deferredMessage) => { h.delivered.push(toDelivered(deferredMessage as unknown as OwnedMessage)) },
      concludeTurn: () => {},
    },
    run: async () => await tool.execute({ ...action.tool.args }),
  })
  await vi.advanceTimersByTimeAsync(1)   // 队列写出 → 武装
  return { ruleId: action.ruleId, pending }
}

describe('流程表 (login)', () => {
  it('注册期校验通过; 命令集由流程表派生 (权限判据用, 含空命令)', () => {
    expect(validateFlows(defaultFlows)).toEqual([])
    const commands = flowCommands(defaultFlows)
    expect(commands).toContain('{name}')
    expect(commands).toContain('{pass}')
    expect(commands).toContain('y')
    // 终态步发空命令（登录收尾）；空命令也要进系统流程命令集（工具闸门的登录豁免判据）。
    expect(commands).toContain('')
    expect(commands).not.toContain('look')
  })

  it('规则表里不再有 login:* 事件规则 (登录 = 流程步骤, 不重复声明)', () => {
    const ids = defaultPerceptionRules.map(rule => rule.id)
    expect(ids.filter(id => id.startsWith('login:'))).toEqual([])
  })

  it('声明期错误即报错 (ok/fail 判据互斥; 登录流程自身合法)', () => {
    const broken = [{
      ...LOGIN_FLOW,
      id: 'broken',
      steps: [{
        id: 'x',
        ok: [{ kind: 'ga' as const }],
        fail: [{ kind: 'ga' as const }],
        next: ['nope'],
      }],
    }]
    const errors = validateFlows(broken)
    expect(errors.some(e => e.includes('ok 与 fail 判据重叠'))).toBe(true)
    expect(errors.some(e => e.includes('next 引用了不存在的步骤'))).toBe(true)
  })

  it('四步图: name→pass→[replace|success], replace→success; 终态 success 发空命令', () => {
    expect(LOGIN_FLOW.steps.map(step => step.id)).toEqual(['name', 'pass', 'replace', 'success'])
    const byId = (id: string) => LOGIN_FLOW.steps.find(step => step.id === id)!
    // 作者定案的连接（2026-09-13）：name 只到 pass；pass 分叉 replace/success；replace 只到 success。
    expect(byId('name').next).toEqual(['pass'])
    expect(byId('pass').next).toEqual(['replace', 'success'])
    expect(byId('replace').next).toEqual(['success'])
    // W10.1 新口径（PLAN §3.1）：settle/classify 步级显式 —— 行流窗口 + 按实际耗时 30s 兜底；
    // name/pass 的 fail 分类收束失败路径。
    expect(byId('name').settle).toEqual({ mode: 'stream', fallback: { ms: 30_000 } })
    expect(byId('name').classify).toEqual({ fail: ['需要创建新人物'] })
    expect(byId('pass').settle).toEqual({ mode: 'stream', fallback: { ms: 30_000 } })
    expect(byId('pass').classify?.fail).toHaveLength(3)
    expect(byId('replace').settle).toEqual({ mode: 'stream', fallback: { ms: 30_000 } })
    // **本步结果 = 下一步的新文本**（作者定案）：`name`/`pass`/`replace` 都不写 ok 分类，成功由后继 driver 给出
    // （"请输入密码"→pass；"替换人物"→replace；"目前权限/重新连线"→success）。
    expect(byId('name').ok).toBeUndefined()
    expect(byId('pass').ok).toBeUndefined()
    expect(byId('replace').ok).toBeUndefined()
    // 终态步: 靠"已进入游戏"的成功句进入 → 发空命令 → settle 显式 GA (on ga:1 + 5s 兜底) → `next` 空。
    const success = byId('success')
    expect(success.action).toEqual({ tool: 'mud_send', args: { cmd: '' } })
    expect(success.settle).toEqual({ mode: 'stream', on: { kind: 'ga', count: 1 }, fallback: { ms: 5_000 } })
    expect(success.next).toBeUndefined()
    expect(success.onEnter?.patch).toEqual({ logged_in: true })
    // 失败只留痕不唤醒 T2（用户名/密码是人工给的，T2 补不了）。
    expect(LOGIN_FLOW.failPolicy).toEqual({ notify: 'none' })
  })

  it('规范化映射 (W10.1 过渡桥): settle/classify → legacy 判据, 引擎零改动消费', () => {
    const normalized = normalizeFlowSpecs([LOGIN_FLOW])[0]!
    const byId = (id: string) => normalized.steps.find(step => step.id === id)!
    // 终态步: on ga:1 → ok GA 判据 + boundary 1; fallback 5s → 步级 timeoutMs。
    const success = byId('success')
    expect(success.ok).toEqual([{ kind: 'ga' }])
    expect(success.boundary).toBe(1)
    expect(success.timeoutMs).toBe(5_000)
    // name: classify.fail → fail 行判据 (字符串编译为 RegExp); 无 on ⇒ 不产生 boundary;
    // fallback 30s → timeoutMs (与流程级 timeoutMs 同值, 行为不变)。
    expect(byId('name').fail).toEqual([{ kind: 'regex', patterns: [/需要创建新人物/] }])
    expect(byId('name').boundary).toBeUndefined()
    expect(byId('name').timeoutMs).toBe(30_000)
  })
})

describe('登录流程端到端 (流程表 → T1 动作 → 桥挂起 → 判据唤醒)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('名字 → 密码 → 成功句 → 空命令收尾, 全程走流程', async () => {
    const h = harness('session-flow-login')
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // ① 入口: 服务器打出名字提示 → 流程激活 → 投递动作 (mud_send {name})
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.lane).toBe('t1')
    expect(h.delivered[0]!.actions.map(a => a.ruleId)).toEqual(['flow:login/name'])
    expect(h.delivered[0]!.actions[0]!.tool.args).toEqual({ cmd: '{name}' })
    // 原文带出驱动行 (不是 [系统] 标记)。
    expect(h.delivered[0]!.text).toContain(NAME_PROMPT)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'name' })

    // ② 假 loop 执行动作 → 占位符在发送瞬间插值 → 桥挂起
    const first = await runLatestAction(h)
    expect(h.sent).toContain('tester')

    // ③ 应答帧: 密码提示（同帧、先于 GA）→ name 成功并走 pass 分支 → 投递 {pass}
    h.sink().onLines([ml(PASS_PROMPT, 1)])
    h.sink().onBoundary('ga')
    await first.pending
    vi.advanceTimersByTime(1)
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[1]!.actions.map(a => a.ruleId)).toEqual(['flow:login/pass'])
    expect(h.delivered[1]!.actions[0]!.tool.args).toEqual({ cmd: '{pass}' })
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'pass' })

    // ④ 执行 {pass}; 应答帧里是成功句 → 命中 success 的进入判据 → 置位已登录 + 投递空命令
    const second = await runLatestAction(h)
    expect(h.sent).toContain('secret')
    h.sink().onLines([ml(LOGIN_DONE, 2)])
    h.sink().onBoundary('ga')
    await second.pending
    vi.advanceTimersByTime(1)
    expect(h.runtime.loggedIn).toBe(true)
    expect(h.delivered).toHaveLength(3)
    expect(h.delivered[2]!.actions.map(a => a.ruleId)).toEqual(['flow:login/success'])
    expect(h.delivered[2]!.actions[0]!.tool.args).toEqual({ cmd: '' })
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'success' })

    // ⑤ 执行空命令 (顶开服务端/退出 MXP 检测; 不再发 look) → GA → 终态 → 流程结束
    const third = await runLatestAction(h)
    expect(h.sent.filter(cmd => cmd === '')).toHaveLength(1)
    h.sink().onBoundary('ga')
    await third.pending
    vi.advanceTimersByTime(1)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] login 完成（终态）')
    h.runtime.dispose()
  })

  it('可选分支: 同名在线确认句 → replace 步发 y → 直接等成功句进 success', async () => {
    const h = harness('session-flow-login-replace')
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // 走到 name 步并执行 {name}
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    h.sink().onLines([ml(PASS_PROMPT, 1)])
    h.sink().onBoundary('ga')
    await first.pending
    vi.advanceTimersByTime(1)

    // 执行 {pass} → 应答帧里是"同名在线确认句" → 条件分支 replace 命中（不是 success）
    const second = await runLatestAction(h)
    h.sink().onLines([ml(REPLACE_PROMPT, 2)])
    h.sink().onBoundary('ga')
    await second.pending
    vi.advanceTimersByTime(1)
    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:login/replace'])
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ cmd: 'y' })
    expect(h.runtime.loggedIn).toBe(false)

    // 执行 y → 成功句（重新连线完毕）→ replace 成功 → 进入 success（置位 + 空命令）
    const third = await runLatestAction(h)
    h.sink().onLines([ml('重新连线完毕。', 3)])
    h.sink().onBoundary('ga')
    await third.pending
    vi.advanceTimersByTime(1)
    expect(h.runtime.loggedIn).toBe(true)
    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:login/success'])
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ cmd: '' })

    // 空命令的 GA → 终态
    const fourth = await runLatestAction(h)
    h.sink().onBoundary('ga')
    await fourth.pending
    vi.advanceTimersByTime(1)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] login 完成（终态）')
    h.runtime.dispose()
  })

  it('超时收束: 发完 {name} 却等不到任何提示行 → 本步超时失败, 不静默', async () => {
    const h = harness('session-flow-login-timeout')
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // 入口 → name 步 → 发 {name}
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    expect(h.sent).toContain('tester')

    // 只有 GA（命令被接受），**没有任何后续提示行**（服务器异常）：
    // name 不写 `ok` ⇒ GA 不结算本步（"本步未声明 GA 判据"），流程继续等提示行。
    h.sink().onBoundary('ga')
    await first.pending
    vi.advanceTimersByTime(1)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'name', phase: 'awaiting-result' })
    expect(h.logs.join('\n')).toContain('本步未声明 GA 判据')

    // 本步计时器（30s）到点 → 流程超时失败收束（I4: 没有"静默等下去"）。
    vi.advanceTimersByTime(30_000)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('本步超时 (30000ms)')
    expect(h.logs.join('\n')).toContain('[流程] login/name 失败')
    h.runtime.dispose()
  })

  it('失败路径: 命中 fail 判据 → 流程失败收束 (复位到只留入口)', async () => {
    const h = harness('session-flow-login-fail')
    h.runtime.connect('example.invalid', 8081, { name: 'ghost', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)

    // 应答帧里是"需要创建新人物"(fail) → 流程失败收束
    h.sink().onLines([ml('需要创建新人物，请重新输入名字。', 1)])
    h.sink().onBoundary('ga')
    await first.pending
    vi.advanceTimersByTime(1)

    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] login/name 失败')
    // 复位后只留入口: 同一个名字提示再次出现会重新激活流程。
    h.sink().onLines([ml(NAME_PROMPT, 2)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'login', stepId: 'name' })
    h.runtime.dispose()
  })

  it('GA 归属: 上一条命令的 GA 不会唤醒下一步声明的 GA 判据', async () => {
    const h = harness('session-flow-login-ga')
    h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    // 走到 pass 步
    h.sink().onLines([ml(NAME_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    const first = await runLatestAction(h)
    h.sink().onLines([ml(PASS_PROMPT, 1)])
    h.sink().onBoundary('ga')
    await first.pending
    vi.advanceTimersByTime(1)

    // 成功句 + GA: 进入 success → 投递空命令（success.ok 只认 GA）
    const second = await runLatestAction(h)
    h.sink().onLines([ml(LOGIN_DONE, 2)])
    h.sink().onBoundary('ga')
    await second.pending
    vi.advanceTimersByTime(1)
    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:login/success'])
    // 此刻空命令还没写出 → 该步不应被上一条命令的 GA 结算。W7.2 起归属按 stepId 判定:
    // 工具结果解析出的 stepId 不是当前步 → 点名忽略（日志只含 stepId, 不含命令文本,
    // 密码/用户名不会出现在日志里）。
    expect(h.runtime.diag().flow).toMatchObject({ stepId: 'success' })
    expect(h.logs.join('\n')).toContain('工具结果属于步骤 pass（非当前步 success）: 不作本步结算判据')
    // 同理：name 步发完 {name} 后，它的 GA 在 pass 步到达时也按 stepId 归属挡掉。
    expect(h.logs.join('\n')).toContain('工具结果属于步骤 name（非当前步 pass）: 不作本步结算判据')
    expect(h.logs.join('\n')).not.toContain('secret')
    h.runtime.dispose()
  })
})
