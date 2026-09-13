/**
 * dsh-mud-core — 投递/回看水位测试 (`doc/ARCHITECTURE.md` §5/§8)。
 *
 * 实测踩过的两类"session 里出现重复信息":
 *   1. `mud_state`/`mud_recall` 把**从连接开始**的全部输出又倒了一遍 —— 回看缓冲没有
 *      交付水位, 已经随 T1 反射消息 / T2 批次 / 工具应答帧进过 session 的行被重复给出;
 *   2. 帧首机制把"在途请求期间到达的行"同时留在本帧与下一帧 —— `look` 的应答里混进
 *      上一次 look / MXP 检测的旧行。
 * 这里把两条不变量固定在 runtime 层: 行只交付一次; 回看只给未交付的行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MudSessionRuntime, type MudRuntimeConfig, type MudRuntimeSink } from '../src/runtime/session-runtime.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/runtime/connection.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

/** 构造一行 (abs 单调; 与 AnsiStreamParser 的分配一致)。 */
function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 假传输 + 记录 agent 收到的投递文本。 */
function harness(sessionId: string, options: {
  t2DeliverIntervalMs?: number
  /** 一条带动作的 event 规则（用于验证"T1 动作投递不受 T2 限流影响"）。 */
  rule?: boolean
} = {}): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
  sent: string[]
  delivered: string[]
} {
  const sent: string[] = []
  const delivered: string[] = []
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
    followup: (message: { content: readonly { type: string; text?: string }[] }) => {
      delivered.push(message.content.find(b => b.type === 'text')?.text ?? '')
    },
  } as unknown as Agent
  const sink: MudRuntimeSink = {
    agentOf: id => (id === sessionId ? agent : undefined),
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: () => {},
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
    deadAirMs: 60_000,
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
    loginExitCommands: [],
    ...(options.t2DeliverIntervalMs === undefined ? {} : { t2DeliverIntervalMs: options.t2DeliverIntervalMs }),
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: options.rule === true
      ? [{
        id: 'test:action',
        match: { kind: 'text' as const, includes: ['需要动作'] },
        action: { output: '测试动作', tool: { name: 'mud_send', args: { cmd: 'look' } } },
      }]
      : [],
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sent,
    delivered,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

describe('回看水位: 只给尚未交付的行', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('T2 批次交付后, recall 不再重复给出这批行; 新行仍可见', () => {
    const h = harness('session-recall')
    h.runtime.connect()
    h.sink().onConnect()

    h.sink().onLines([ml('欢迎使用北大侠客行', 0), ml('这里明显的出口是 south。', 1)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('欢迎使用北大侠客行')

    // 已交付 → 回看为空 (不再把连接至今的全部输出倒一遍)。
    expect(h.runtime.recall(60)).toEqual([])

    // 未交付的新行 → 只回看这些。
    h.sink().onLines([ml('你捡起一把长剑。', 2)])
    expect(h.runtime.recall(60)).toEqual(['你捡起一把长剑。'])

    h.sink().onBoundary('ga')
    expect(h.runtime.recall(60)).toEqual([])
    h.runtime.dispose()
  })

  it('重连后 abs 从 0 重来: 水位与回看缓冲一起复位 (否则永远为空)', () => {
    const h = harness('session-recall-reconnect')
    h.runtime.connect()
    h.sink().onConnect()
    h.sink().onLines([ml('第一连接的行', 0)])
    h.sink().onBoundary('ga')
    expect(h.runtime.recall(10)).toEqual([])

    h.sink().onClose()
    h.sink().onConnect()
    h.sink().onLines([ml('第二连接的第一行', 0)])
    expect(h.runtime.recall(10)).toEqual(['第二连接的第一行'])
    h.runtime.dispose()
  })
})

describe('帧内容: 只进本帧, 不漏进下一帧', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('命令应答帧的行进 tool result, 且不再出现在后续回看里', async () => {
    const h = harness('session-frame')
    h.runtime.connect()
    h.sink().onConnect()

    const pending = h.runtime.tools().mud_send!.execute({ cmd: 'look' })
    await vi.advanceTimersByTimeAsync(1)          // 队列写出 → armed
    expect(h.sent).toContain('look')
    h.sink().onLines([ml('北大街 -', 3), ml('这里明显的出口是 south。', 4)])
    h.sink().onBoundary('ga')
    const reply = await pending
    expect(reply.note).toContain('北大街')
    // 帧行已作为 tool result 进过模型 → 回看不再重复给出。
    expect(h.runtime.recall(10)).toEqual([])

    // 下一条命令的帧里只有它自己的应答。
    const pending2 = h.runtime.tools().mud_send!.execute({ cmd: 'inventory' })
    await vi.advanceTimersByTimeAsync(1)
    h.sink().onLines([ml('你身上带着:', 5)])
    h.sink().onBoundary('ga')
    const reply2 = await pending2
    expect(reply2.note).toBe('你身上带着:')
    h.runtime.dispose()
  })
})

/**
 * **T2 投递限流**（作者定案 2026-09-13；§5/§11）。
 *
 * 实测：登录后 T2 接管，1 秒一条地刷查询（look/hp/score/skills）。`toolCallIntervalMs` 压的是
 * "每次工具调用"，压不住"被喂得太勤"；这一层直接压 T2 的**投递**节奏，并天然把多个小批次
 * 合并成大批次。**只压 T2 批次**：T1 动作投递不受影响。
 */
describe('T2 投递限流: 间隔内的批次留待决, 到期合并投出', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('间隔内不投 T2 批次; T1 动作照常投; 到期后合并投出', () => {
    const h = harness('session-t2-throttle', { t2DeliverIntervalMs: 2_000, rule: true })
    h.runtime.connect()
    h.sink().onConnect()

    // 第一批 (T2 批次): 首次不限流。
    h.sink().onLines([ml('第一段输出', 0)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('第一段输出')

    // 间隔内的 **T1 动作投递** 照常走 (不受 T2 限流影响)。
    vi.advanceTimersByTime(500)
    h.sink().onLines([ml('需要动作的行', 1)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[1]).toContain('需要动作的行')

    // 间隔内的 **T2 批次** 不投: 行留待决。
    vi.advanceTimersByTime(100)
    h.sink().onLines([ml('第二段输出', 2)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(2)

    // 距上次 T2 投递满 2s → 第二批投出 (含被压住的那段)。
    vi.advanceTimersByTime(2_000)
    expect(h.delivered).toHaveLength(3)
    expect(h.delivered[2]).toContain('第二段输出')
    h.runtime.dispose()
  })
})
