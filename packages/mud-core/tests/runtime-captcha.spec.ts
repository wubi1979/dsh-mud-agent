/**
 * dsh-mud-core — fullme 流程端到端 (`doc/ARCHITECTURE.md` §11 + §19)。
 *
 * fullme 从"三条规则"升级为**五步流程**（作者 2026-09-13 逐条审定）：
 *
 *   ```
 *   request  driver=服务端提醒  action=mud_send fullme   fail="刚刚用过"（时长动态）  next=[stale,prompt]
 *   stale    driver=上一轮未完成提示  action=mud_send ['fullme 1']×3   fail=GA（放弃上一轮 → 本轮作废）
 *   prompt   driver=robot.php 地址  capture={captchaUrl}  action=mud_captcha   ok/fail=**工具结果**
 *   answer   无 driver（由 prompt 顺序兜底进入）  awaitExternal=['captcha']
 *            timeoutMs=180_000（**本步总预算**：等人工 + 答错重来 + 收结果）
 *            action=mud_send ['halt','fullme {captcha}']  retry={attempts:3, action=mud_captcha}
 *   success  action=mud_send hpbrief   ok=[GA]（next 空 = 终态）
 *   ```
 *
 * 本文件测**运行时接线**（真链路，不是建模）：动作渲染 → 官方工具包装器
 * （`runWithDeliveryChannel`）→ 桥/工具 → 流程判定。
 *   - `tool` 判据：工具结果（取图成功/失败）经 call-id 解析喂回**当前步**；
 *   - 人工环节：`awaitExternal` 的动作**先挂起不投递**，`exitHumanWait` → `flow.resumeHuman()`
 *     后才投出（`{captcha}` 在**发送瞬间**插值）；
 *   - 答错重试：**原步内自环**（重新取图 + 弹窗带失败原文 + 重新挂起），**不重置 3 分钟预算**；
 *   - 三种收场（取图失败 / 答错 3 次 / 预算耗尽）都收束为流程失败，下一轮先撞 `stale`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import defaultPerceptionRules from '../src/perceive/rules.ts'
import {
  defaultFlows, FULLME_OK_TEXT, FULLME_REMINDER_TEXT, FULLME_STALE_TEXT, FULLME_WRONG_TEXT,
} from '../src/runtime/flow/flows/index.ts'
import { runWithDeliveryChannel } from '../src/agents/mount.ts'
import { MudSessionRuntime } from '../src/runtime/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/runtime/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/services/network/manager.ts'
import type { MudLine } from '../src/services/network/ansi.ts'

const CAPTCHA_URL = 'http://fullme.pkuxkx.net/robot.php?filename=1699999999'
const CAPTCHA_IMG = 'http://fullme.pkuxkx.net/b2evo_captcha_tmp/a.jpg'
const COOLDOWN = '你刚刚用过这个命令不久，还要 3 分 20 秒才能再用。'

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 一次投递（含动作请求与投递 id）。 */
interface Delivered {
  text: string
  lane?: string
  delivery?: string
  actions: readonly { ruleId: string; tool: { name: string; args: Record<string, unknown> } }[]
}

/** 推给页面的验证码（`sink.captcha`）。 */
interface CaptchaPush {
  imageUrl: string
  robotUrl: string
  note?: string
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
  captchas: CaptchaPush[]
  logs: string[]
} {
  const sent: string[] = []
  const delivered: Delivered[] = []
  const captchas: CaptchaPush[] = []
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
    followup: (message: OwnedMessage) => { delivered.push(toDelivered(message)) },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    captcha: (_id, push) => { captchas.push(push) },
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: (_id, text) => { logs.push(text) },
    debug: (_id, channel, text) => { logs.push(`[${channel}] ${text}`) },
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
    flows: defaultFlows,
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    // fullme 是流程；规则表里 `fullme:*` 三条已退役（这里仍装其余规则，保持真实装配）。
    stateRules: defaultPerceptionRules.filter(r => r.lane === 'state'),
    eventRules: defaultPerceptionRules.filter(r => r.lane !== 'state'),
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sent,
    delivered,
    captchas,
    logs,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

/** 验证码页面（`resolveCaptchaImage` 抓 robot.php → 取 <img src>）；返回 fetch 桩。 */
function stubCaptchaPage(html = `<html><body><img src="${CAPTCHA_IMG}"></body></html>`) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 走**官方工具包装器**执行最新一条投递里的动作（真链路：begin/end + 工具结果回喂 + defer）。
 *
 * 返回的 `pending` 在桥结算（GA/边界）后才 resolve —— 与官方 loop 一致：工具调用阻塞在
 * 等游戏应答上，测试负责喂应答行再 await。
 */
async function startAction(h: ReturnType<typeof harness>, index = 0): Promise<{
  ruleId: string
  callId: string
  /** 活的状态对象（工具结束后才更新：`deferred` / `concluded`）。 */
  state: { deferred: number; concluded: boolean }
  pending: Promise<{ ok: boolean; note: string }>
}> {
  const message = h.delivered.at(-1)
  if (message === undefined || message.actions.length === 0) throw new Error('没有待执行动作')
  const action = message.actions[index]
  if (action === undefined) throw new Error(`投递里没有第 ${index} 个动作`)
  const tool = h.runtime.tools()[action.tool.name]
  if (tool === undefined) throw new Error(`未知工具 ${action.tool.name}`)
  const flags = { deferred: 0, concluded: false }
  const callId = `mud-${String(message.delivery)}-${index}`
  const pending = runWithDeliveryChannel({
    channel: h.runtime,
    callId,
    exec: {
      deferContext: (deferredMessage) => {
        // 官方 loop：`additionalContexts` 进 `next-step` inbox → 成为下一步认领的消息
        // （T1 据此渲染下一个动作）。测试里等价于"多了一条投递"。
        flags.deferred += 1
        h.delivered.push(toDelivered(deferredMessage as OwnedMessage))
      },
      concludeTurn: () => { flags.concluded = true },
    },
    run: async () => await tool.execute({ ...action.tool.args }),
  })
  // 队列按 commandIntervalMs 写出 → 桥武装（官方 loop 里这段是"工具执行中"）。
  await vi.advanceTimersByTimeAsync(1)
  return { ruleId: action.ruleId, callId, state: flags, pending }
}

/** 建一个**已登录**连接（fullme 的入口条件 = logged_in；login 流程不再 arm）。 */
async function loggedIn(sessionId: string) {
  const h = harness(sessionId)
  h.runtime.connect('example.invalid', 8081, { name: 'tester', pass: 'secret' })
  h.sink().onConnect()
  await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
  await vi.advanceTimersByTimeAsync(10)
  h.sent.length = 0
  h.delivered.length = 0
  h.captchas.length = 0
  h.logs.length = 0
  return h
}

/** 服务端提醒行 → 流程激活 → 投出 `mud_send fullme`。 */
async function toRequest(h: ReturnType<typeof harness>) {
  h.sink().onLines([ml(FULLME_REMINDER_TEXT, 0)])
  h.sink().onBoundary('ga')
  await vi.advanceTimersByTimeAsync(1)
  return startAction(h)
}

/** 走到 `prompt` 步（地址在 `fullme` 的应答帧里）并执行 `mud_captcha`。 */
async function toPrompt(
  h: ReturnType<typeof harness>,
  request: Awaited<ReturnType<typeof startAction>>,
  abs = 1,
) {
  h.sink().onLines([ml(CAPTCHA_URL, abs)])
  h.sink().onBoundary('ga')
  await request.pending
  await vi.advanceTimersByTimeAsync(1)
  return startAction(h)
}

/** 人工回填 + 执行答案动作（**逐条命令**的真实应答：`halt` 的 GA → `fullme <码>` 的结果）。 */
async function answerWith(
  h: ReturnType<typeof harness>,
  code: string,
  reply: 'ok' | 'wrong',
  abs: number,
) {
  expect(h.runtime.sendCommand(`fullme ${code}`)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  const action = await startAction(h)
  // 序列逐条写出：先 `halt`（等它的 GA），再 `fullme <码>`。
  expect(h.sent).toContain('halt')
  h.sink().onBoundary('ga')                       // 序列第 1 条 (`halt`) 的 GA
  await vi.advanceTimersByTimeAsync(1)
  expect(h.sent).toContain(`fullme ${code}`)
  h.sink().onLines([ml(reply === 'wrong' ? FULLME_WRONG_TEXT : FULLME_OK_TEXT, abs)])
  h.sink().onBoundary('ga')                       // 序列第 2 条 (`fullme <码>`) 的结算
  await action.pending
  await vi.advanceTimersByTimeAsync(1)
  return action
}

describe('fullme 流程 (提醒行 → fullme → 取图 → 人工回码 → 成功)', () => {
  beforeEach(() => { vi.useFakeTimers(); stubCaptchaPage() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('全链: 提醒 → 发 fullme → 地址 → mud_captcha 取图推弹窗 → 人工回码 → 成功句 → hpbrief 收尾', async () => {
    const h = await loggedIn('session-fullme-happy')

    // ① 入口提醒 → 流程激活 → 投递 fullme 动作（原文 = 提醒行；T1 通道）。
    const request = await toRequest(h)
    expect(request.ruleId).toBe('flow:fullme/request')
    expect(h.delivered.at(-1)!.lane).toBe('t1')
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ cmd: 'fullme' })
    expect(h.delivered.at(-1)!.text).toContain(FULLME_REMINDER_TEXT)
    expect(h.runtime.diag().flow).toMatchObject({ flowId: 'fullme', stepId: 'request' })

    // ② 命令写出（T1 通道，不设 direct）。
    expect(h.sent).toContain('fullme')

    // ③ 地址在应答帧里 → 进 prompt 步（capture 存槽）→ 投递 mud_captcha。
    const prompt = await toPrompt(h, request)
    expect(prompt.ruleId).toBe('flow:fullme/prompt')
    // 地址槽已抽出并**投递前**插好值；`{lastFail}` 本轮为空 → 空串（不是字面占位符）。
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ url: CAPTCHA_URL, note: '' })
    expect(h.runtime.diag().flow?.slots).toEqual({ captchaUrl: CAPTCHA_URL })

    // ④ 取图（工具结果 = 判据）：弹窗拿到图片地址 + robot 地址，本轮没有失败文案。
    const captchaCall = await prompt.pending
    expect(captchaCall.ok).toBe(true)
    // 取图这一步**不**收束回合（下一步 answer 还要等人工），而是把后续动作 defer 进下一步。
    expect(prompt.state.concluded).toBe(false)
    expect(h.captchas).toEqual([{ imageUrl: CAPTCHA_IMG, robotUrl: CAPTCHA_URL }])
    await vi.advanceTimersByTimeAsync(1)

    // ⑤ 取图成功 → 顺序兜底进 answer → 动作**挂起**（不投递）+ 进人工环节。
    expect(h.runtime.humanWait).toBe(true)
    expect(h.delivered).toHaveLength(2)                   // 没有第三次投递
    expect(h.runtime.diag().flow).toMatchObject({ stepId: 'answer', phase: 'awaiting-human' })

    // ⑥ 人工回码 → resumeHuman → 投出答案动作（`{captcha}` 仍是占位符）。
    expect(h.runtime.sendCommand('fullme 1234')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const answer = await startAction(h)
    expect(answer.ruleId).toBe('flow:fullme/answer')
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ cmds: ['halt', 'fullme {captcha}'] })
    expect(h.runtime.humanWait).toBe(false)

    // ⑦ 命令序列逐条写出：人工值只在发送那一刻出现。
    expect(h.sent).toContain('halt')
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toContain('fullme 1234')

    // ⑧ 成功句 → answer 成功 → 顺序兜底进 success（hpbrief）→ 终态。
    h.sink().onLines([ml(FULLME_OK_TEXT, 2)])
    h.sink().onBoundary('ga')
    await answer.pending
    await vi.advanceTimersByTimeAsync(1)
    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:fullme/success'])
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ cmd: 'hpbrief' })

    const finish = await startAction(h)
    expect(h.sent).toContain('hpbrief')
    h.sink().onBoundary('ga')
    await finish.pending
    await vi.advanceTimersByTimeAsync(1)
    // 终态步的 GA 让流程空闲 → 这最后一条动作收束回合（§19.6.2 判据 B）。
    expect(finish.state.concluded).toBe(true)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] fullme 完成（终态）')
    h.runtime.dispose()
  })

  it('上一轮未完成: stale 步**三连发 fullme 1** 放弃, GA 即本轮作废收束', async () => {
    const h = await loggedIn('session-fullme-stale')
    const request = await toRequest(h)

    h.sink().onLines([ml(FULLME_STALE_TEXT, 1)])
    h.sink().onBoundary('ga')
    await request.pending
    await vi.advanceTimersByTimeAsync(1)

    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:fullme/stale'])
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({
      cmds: ['fullme 1', 'fullme 1', 'fullme 1'],
    })
    const stale = await startAction(h)
    // 三连发在一个动作里逐条写出（必须三连才真放弃）：每条的 GA 放行下一条。
    expect(h.sent).toContain('fullme 1')
    for (let i = 0; i < 2; i += 1) {
      h.sink().onBoundary('ga')
      await vi.advanceTimersByTimeAsync(1)
    }
    h.sink().onBoundary('ga')
    await stale.pending
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent.filter(cmd => cmd === 'fullme 1')).toHaveLength(3)

    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('放弃上一轮（三连 fullme 1）→ 本轮作废')
    h.runtime.dispose()
  })

  it('"刚刚用过"句 → 本轮中止（fail，无兜底）', async () => {
    const h = await loggedIn('session-fullme-cooldown')
    const request = await toRequest(h)

    h.sink().onLines([ml(COOLDOWN, 1)])
    h.sink().onBoundary('ga')
    await request.pending
    await vi.advanceTimersByTimeAsync(1)

    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] fullme/request 失败')
    h.runtime.dispose()
  })

  it('取图失败 → 工具结果判 error → 本轮失败（不让人对着坏图干等）', async () => {
    const h = await loggedIn('session-fullme-image-fail')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0),
    })))

    const request = await toRequest(h)
    const prompt = await toPrompt(h, request)
    const result = await prompt.pending
    expect(result.ok).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(h.runtime.humanWait).toBe(false)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('[流程] fullme/prompt 失败')
    h.runtime.dispose()
  })

  it('答错一次 → 原步内自环: 重新取图 + 弹窗带失败原文 + 重新等人工，重试计数可见', async () => {
    const h = await loggedIn('session-fullme-retry')
    const request = await toRequest(h)
    const prompt = await toPrompt(h, request)
    await prompt.pending
    await vi.advanceTimersByTimeAsync(1)

    // 第一次答错（错码与 `fullme 1` 等价，不占额外一次尝试）
    await answerWith(h, '1111', 'wrong', 2)

    // 重试动作 = 重新取图（同一个 robot 地址，页面自动刷新出新图），弹窗带失败原文。
    const retry = await startAction(h)
    expect(retry.ruleId).toBe('flow:fullme/answer')
    expect(h.delivered.at(-1)!.actions[0]!.tool.args).toEqual({ url: CAPTCHA_URL, note: FULLME_WRONG_TEXT })
    const retried = await retry.pending
    expect(retried.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.captchas).toHaveLength(2)
    expect(h.captchas[1]).toEqual({ imageUrl: CAPTCHA_IMG, robotUrl: CAPTCHA_URL, note: FULLME_WRONG_TEXT })
    // 仍然是同一步、仍在等人工；旧验证码已作废。
    expect(h.runtime.diag().flow).toMatchObject({ stepId: 'answer', phase: 'awaiting-human', retries: 1 })
    expect(h.logs.join('\n')).toContain('[流程] fullme/answer 重试 2/3')

    // 第二次答对 → 成功句 → 终态（success 步由顺序兜底进入）
    await answerWith(h, '2222', 'ok', 3)
    expect(h.delivered.at(-1)!.actions.map(a => a.ruleId)).toEqual(['flow:fullme/success'])
    h.runtime.dispose()
  })

  it('答错 3 次 → 重试次数用尽 → 本轮失败收束（错码与 fullme 1 等价，下一轮不进 stale）', async () => {
    const h = await loggedIn('session-fullme-retry-exhausted')
    const request = await toRequest(h)
    const prompt = await toPrompt(h, request)
    await prompt.pending
    await vi.advanceTimersByTimeAsync(1)

    // 第 1、2 次答错 → 各触发一次重试（重试动作 = 重新取图）
    for (const [index, code] of ['1111', '2222'].entries()) {
      await answerWith(h, code, 'wrong', 2 + index)
      const retry = await startAction(h)
      await retry.pending
      await vi.advanceTimersByTimeAsync(1)
    }
    // 第 3 次答错 → 次数用尽（`attempts:3` = 总尝试次数，含首次）
    await answerWith(h, '3333', 'wrong', 4)

    expect(h.runtime.diag().flow).toBeNull()
    expect(h.logs.join('\n')).toContain('重试次数用尽')
    h.runtime.dispose()
  })

  it('3 分钟预算是**一步总计**: 等人工期间计时不停，到点即本轮失败并退出人工环节', async () => {
    const h = await loggedIn('session-fullme-budget')
    const request = await toRequest(h)
    const prompt = await toPrompt(h, request)
    await prompt.pending
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runtime.humanWait).toBe(true)

    // 用过一半预算 + 答错一次重来：预算**不重置**（还剩 ~90s）。
    await vi.advanceTimersByTimeAsync(90_000)
    await answerWith(h, '1111', 'wrong', 2)
    const retry = await startAction(h)
    await retry.pending
    await vi.advanceTimersByTimeAsync(1)
    expect(h.runtime.humanWait).toBe(true)

    // 再过 90s（合计 180s）→ 本步预算耗尽 → 流程失败收束 + 人工环节退出。
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.runtime.diag().flow).toBeNull()
    expect(h.runtime.humanWait).toBe(false)
    expect(h.logs.join('\n')).toContain('人工未在 180000ms 内提交')
    h.runtime.dispose()
  })
})
