/**
 * dsh-mud-core — fullme 流程测试 (`doc/ARCHITECTURE.md` §11)。
 *
 * fullme 与 login 同源: 入口 = **匹配服务端提醒行** (规则表声明), 动作由 T1 渲染;
 * 区别是 `{captcha}` 这个值只能由人工提供, 且等待期间要:
 *   - **暂停全部投递** (模型看不到验证码提示, 不会自己去答);
 *   - **停掉看门狗** (人工环节不允许自主决策);
 *   - **无限等待** (无超时), 人工回填或断线重连才退出。
 *
 * v0.4.0 起投递契约变了 (无 turnRef): 动作请求随投递消息走 (`source.actions` + `delivery`),
 * 帧内命中走**独立投递** (`deliverStandalone`) 不等下一批。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import defaultPerceptionRules from '../src/config/trigger-rules.ts'
import { MudSessionRuntime, type MudRuntimeConfig, type MudRuntimeSink } from '../src/runtime/session-runtime.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/runtime/connection.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

const CAPTCHA_URL = 'http://fullme.pkuxkx.net/robot.php?filename=1699999999'
const FULLME_DONE = '你突然感到精神一振，浑身似乎又充满了力量！'
/** 服务端提醒原文 (用户 2026-09-12) —— 入口判据就是这句里的字面子串。 */
const FULLME_REMINDER = '5M后长时间不使用fullme，会被系统判定为机器人。'
const FULLME_RULES = defaultPerceptionRules.filter(rule => rule.id === 'fullme:prompt')
/** fullme 全流程用例: 入口规则 + 提示规则 (应答帧内地址) 都要在场。 */
const FULLME_BEAT_RULES = defaultPerceptionRules.filter(rule => rule.id.startsWith('fullme:'))

/** 一条投给 agent 的消息 (只记断言需要的字段)。 */
interface Captured {
  text: string
  lane?: string
  delivery?: string
  actions?: readonly { ruleId: string; output: string; tool: { name: string; args: Record<string, unknown> } }[]
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function harness(sessionId: string, options: {
  rules?: typeof FULLME_RULES
  deadAirMs?: number
} = {}): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
  sent: string[]
  delivered: Captured[]
  captcha: string[]
  decisions: string[]
} {
  const sent: string[] = []
  const delivered: Captured[] = []
  const captcha: string[] = []
  const decisions: string[] = []
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
      source?: {
        lane?: string
        delivery?: string
        actions?: readonly { ruleId: string; output: string; tool: { name: string; args: Record<string, unknown> } }[]
      }
    }) => {
      delivered.push({
        text: message.content.find(b => b.type === 'text')?.text ?? '',
        ...(message.source?.lane === undefined ? {} : { lane: message.source.lane }),
        ...(message.source?.delivery === undefined ? {} : { delivery: message.source.delivery }),
        ...(message.source?.actions === undefined ? {} : { actions: message.source.actions }),
      })
    },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    captcha: (_id, url) => { captcha.push(url) },
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: () => {},
    debug: () => {},
    decision: (_sessionId, record) => {
      decisions.push(`${record.actor}/${record.ruleId ?? record.eventType ?? ''}/${record.action}`)
    },
  }
  const config: MudRuntimeConfig = {
    agentEnabled: true,
    commandIntervalMs: 0,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: options.deadAirMs ?? 1_000,
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: options.rules ?? FULLME_RULES,
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sent,
    delivered,
    captcha,
    decisions,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

describe('fullme: 人工环节', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('命中提示 → 交人工 + 暂停投递 + 停看门狗 (不投递也不唤醒)', async () => {
    const h = harness('session-captcha')
    h.runtime.connect()
    h.sink().onConnect()
    await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    vi.advanceTimersByTime(10)

    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(10)

    // 命中的地址交给宿主取图; 进入人工环节。
    expect(h.captcha).toEqual([CAPTCHA_URL])
    expect(h.runtime.humanWait).toBe(true)
    // 暂停投递: 提示行没有作为消息进 session。
    expect(h.delivered).toEqual([])
    // 停看门狗: 越过错流窗也没有唤醒。
    vi.advanceTimersByTime(5_000)
    expect(h.delivered).toEqual([])
    h.runtime.dispose()
  })

  it('人工回填 → T1 投出 halt + fullme <码>, 投递与看门狗恢复', async () => {
    const h = harness('session-captcha-answer')
    h.runtime.connect()
    h.sink().onConnect()
    await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    vi.advanceTimersByTime(10)
    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(10)
    expect(h.runtime.humanWait).toBe(true)

    // 页面发来的 `fullme <码>` 不被直接发出, 而是作为外部值回填 (由 T1 渲染后发)。
    expect(h.runtime.sendCommand('fullme 1234', 'user')).toBe(true)
    expect(h.sent).not.toContain('fullme 1234')      // 人工那条还没有直接发
    expect(h.runtime.humanWait).toBe(false)
    // 挂起的动作交给 T1 → 动作投递 (原文 = 验证码提示行)。
    const t1 = h.delivered.filter(msg => msg.lane === 't1')
    expect(t1).toHaveLength(1)
    expect(t1[0]!.text).toContain(CAPTCHA_URL)
    expect(t1[0]!.actions!.map(a => a.ruleId)).toEqual(['fullme:prompt'])
    expect(t1[0]!.actions![0]!.tool).toEqual({ name: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } })
    expect(t1[0]!.delivery).toBeTruthy()

    // 看门狗恢复: 断流窗过去后有唤醒。
    vi.advanceTimersByTime(1_100)
    expect(h.delivered.length).toBeGreaterThan(1)
    h.runtime.dispose()
  })

  it('空验证码不恢复 (继续等人工); 断线重连作废人工环节', () => {
    const h = harness('session-captcha-empty')
    h.runtime.connect()
    h.sink().onConnect()
    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')
    expect(h.runtime.humanWait).toBe(true)

    h.runtime.sendCommand('fullme', 'user')
    expect(h.runtime.humanWait).toBe(true)          // 没有码 → 继续等

    h.sink().onClose()
    h.sink().onConnect()
    expect(h.runtime.humanWait).toBe(false)
    h.runtime.dispose()
  })

  it('人工环节中人工命令以外的命令照常发出 (不吞命令)', () => {
    const h = harness('session-captcha-other')
    h.runtime.connect()
    h.sink().onConnect()
    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')

    h.runtime.sendCommand('look', 'user')
    vi.advanceTimersByTime(10)
    expect(h.sent).toContain('look')
    expect(h.runtime.humanWait).toBe(true)          // 仍等人工
    h.runtime.dispose()
  })
})

/**
 * fullme 入口 = **匹配服务端那一行** (人物经验值到 5M 之后长时间不使用 fullme 会被系统判定为
 * 机器人, 服务端届时提醒) → 命中 → 规则声明 `direct: true` ⇒ **运行时直接发** `fullme`
 * (无状态、无需返回的动作不占回合)。
 * 之后地址在应答帧里到达 → 交人工 → 人工回填后 T1 发 `halt` + `fullme <码>` (§11)。
 */
describe('fullme 流程 (提醒行 → fullme → 人工)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 建一个已登录会话; deadAir 推到天边, 免得断流唤醒混进断言。 */
  async function loggedIn(sessionId: string) {
    const h = harness(sessionId, { rules: FULLME_BEAT_RULES, deadAirMs: 3_600_000 })
    h.runtime.connect()
    h.sink().onConnect()
    await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    vi.advanceTimersByTime(10)
    h.delivered.length = 0
    return h
  }

  it('服务端提醒行 → 直接发出 fullme (声明 direct 的动作不占回合)', async () => {
    const h = await loggedIn('session-fullme-reminder')

    h.sink().onLines([ml(FULLME_REMINDER, 0)])
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)

    expect(h.sent).toContain('fullme')             // 动作已发出
    expect(h.delivered).toEqual([])                // 不需要模型参与: 不投递
    expect(h.decisions.some(d => d.includes('fullme:request'))).toBe(true)
    h.runtime.dispose()
  })

  it('判据是实录那一串: 实录句命中, 普通提到 fullme 的行不命中', async () => {
    const h = await loggedIn('session-fullme-strict')

    const casual = [
      '帮助: fullme 命令用于验证你不是机器人。',
      '玩家张三对大家说: 我刚用 fullme 了。',
      '新闻: 服务器调整了 fullme 的判定规则。',
    ]
    h.sink().onLines(casual.map((text, i) => ml(text, i)))
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).not.toContain('fullme')
    expect(h.delivered.some(msg => msg.lane === 't1')).toBe(false)

    h.sink().onLines([ml(FULLME_REMINDER, 3)])
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toContain('fullme')
    h.runtime.dispose()
  })

  /**
   * 实录形态 (`doc/ARCHITECTURE.md` §11): 我们发 `fullme` → **robot.php 地址在它应答帧里**
   * 到达 → 交人工 → 人工回填后 T1 发 `halt` + `fullme <码>`。帧行不进待决缓冲, 所以回填后
   * 必须**独立投递** (否则该动作永远等不到投递机会, 答案永远发不出去)。
   */
  it('地址在应答帧内到达 → 挂起待人工 → 人工回填后 T1 发 halt + fullme <码>', async () => {
    const h = await loggedIn('session-beat-frame')

    // 规则声明的 `mud_send fullme` 走同一条命令/应答桥 (这里直接调工具, 桥同源)。
    const pending = h.runtime.tools().mud_send!.execute({ cmd: 'fullme' })
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toContain('fullme')

    // 应答帧: GA 前到达地址行 → 挂起待人工 (不当成 T1 续步去发空码)。
    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')
    const reply = await pending
    expect(reply.note).toContain('robot.php')
    expect(h.captcha).toEqual([CAPTCHA_URL])
    expect(h.runtime.humanWait).toBe(true)
    expect(h.delivered).toEqual([])                 // 帧内命中被挂起, 没有投给 T1

    // 人工回填 → T1 投出 halt + fullme <码> (帧路径: 无行可带 → 独立投递)。
    expect(h.runtime.sendCommand('fullme 8888', 'user')).toBe(true)
    expect(h.runtime.humanWait).toBe(false)
    const t1 = h.delivered.filter(msg => msg.lane === 't1')
    expect(t1).toHaveLength(1)
    expect(t1[0]!.actions!.map(a => a.ruleId)).toEqual(['fullme:prompt'])
    expect(t1[0]!.actions![0]!.tool).toEqual({ name: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } })

    // T1 的 tool-call 由官方工具管道执行 (同一工具): 先中断当前动作, 再发答案。
    const answer = h.runtime.tools().mud_send!.execute({ cmds: ['halt', 'fullme {captcha}'] })
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toContain('halt')
    h.sink().onLines([ml('你停止了一切动作。', 1)])
    h.sink().onBoundary('ga')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toContain('fullme 8888')         // 人工值只在发送瞬间插值

    // 答案的应答帧里是成功句 → 帧内命中 → 独立投递 (T1 渲染 world_patch)。
    h.sink().onLines([ml(FULLME_DONE, 2)])
    h.sink().onBoundary('ga')
    await answer
    await vi.advanceTimersByTimeAsync(1)
    const done = h.delivered.filter(msg => msg.actions?.some(a => a.ruleId === 'fullme:done'))
    expect(done).toHaveLength(1)
    expect(done[0]!.actions![0]!.tool).toEqual({ name: 'world_patch', args: { patch: { fullme_ok: true } } })
    h.runtime.dispose()
  })

  /**
   * 帧内命中的归属 (v0.4.0): 帧行不进待决缓冲 → 命中**立即独立投递**, 不等下一批、
   * 也不担心被后面的 T2 批次挤掉 (旧实现要靠"下一次反射投递搭车")。
   */
  it('帧内命中 (无待决行) → 立即独立投递, 不被后续 T2 批次影响', async () => {
    const h = harness('session-frame-wait', { rules: FULLME_BEAT_RULES })
    h.runtime.connect()
    h.sink().onConnect()
    await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
    vi.advanceTimersByTime(10)
    h.delivered.length = 0

    const pending = h.runtime.tools().mud_send!.execute({ cmd: 'look' })
    await vi.advanceTimersByTimeAsync(1)
    h.sink().onLines([ml(FULLME_DONE, 0)])
    h.sink().onBoundary('ga')
    await pending

    // 帧内命中: 独立投递, 原文 = 命中行。
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.lane).toBe('t1')
    expect(h.delivered[0]!.text).toContain(FULLME_DONE)
    expect(h.delivered[0]!.actions!.map(a => a.ruleId)).toEqual(['fullme:done'])

    // 之后一批无命中的 T2 输出不会影响已投出的动作消息。
    h.sink().onLines([ml('你看到一只小猫从墙头跑过去了。', 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[1]!.lane).toBe('t2')
    h.runtime.dispose()
  })
})
