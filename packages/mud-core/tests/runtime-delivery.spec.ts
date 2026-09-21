/**
 * dsh-mud-core — 投递/回看水位测试 (`doc/ARCHITECTURE.md` §5/§8)。
 *
 * 实测踩过的两类"session 里出现重复信息":
 *   1. `mud_state`/`mud_recall` 把**从连接开始**的全部输出又倒了一遍 —— 回看缓冲没有
 *      交付水位, 已经随 T1 反射消息 / T2 批次 / 工具应答帧进过 session 的行被重复给出;
 *   2. 帧首机制把"在途请求期间到达的行"同时留在本帧与下一帧 —— `look` 的应答里混进
 *      上一次 look / MXP 检测的旧行。
 * 这里把不变量固定在 runtime 层: 行只交付一次。
 *
 * W10.2 R2 (2026-09): 交付水位废除, `mud_recall` 改**历史查询** (PLAN 3.7) —
 * 已投递/已消费的行同样可查 (2000 行上限), 重连时回看缓冲随连接作废。
 * 下面的用例按 R2 语义书写 (旧"回看只给未交付行"用例已随交付水位一起废除)。
 *
 * W10.3 (2026-09): 折叠机制整体删除 —— 状态抓取与 `direct` 反射都**不改行流**。
 * 末节固定行流守恒 (A9): 投递拼接 == 完整入站行流, 无隐藏行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/network/manager.ts'
import type { MudLine } from '../src/network/ansi.ts'
import type { PerceptionRule } from '../src/perceive/types.ts'

/** 构造一行 (abs 单调; 与 AnsiStreamParser 的分配一致)。 */
function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 假传输 + 记录 agent 收到的投递文本。 */
function harness(sessionId: string, options: {
  t2DeliverIntervalMs?: number
  /** 一条带动作的 event 规则（用于验证"T1 动作投递不受 T2 限流影响"）。 */
  rule?: boolean
  /** 一条 state 抓取规则 (行流守恒用例: 抓取行也必须照常投出)。 */
  stateRule?: boolean
  /** 一条 `direct` 反射规则 (行流守恒用例: 反射命中行也必须照常投出)。 */
  directRule?: boolean
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
    loginExitCommands: [],
    ...(options.t2DeliverIntervalMs === undefined ? {} : { t2DeliverIntervalMs: options.t2DeliverIntervalMs }),
  }
  const eventRules: PerceptionRule[] = []
  if (options.rule === true) {
    eventRules.push({
      id: 'test:action',
      match: { kind: 'text' as const, includes: ['需要动作'] },
      action: { output: '测试动作', tool: { name: 'mud_send', args: { cmd: 'look' } } },
    })
  }
  if (options.directRule === true) {
    eventRules.push({
      id: 'test:direct',
      match: { kind: 'text' as const, includes: ['请保存档案'] },
      action: { output: '保存', tool: { name: 'mud_send', args: { cmd: 'save' } }, direct: true },
    })
  }
  const stateRules: PerceptionRule[] = options.stateRule === true
    ? [{
      id: 'test:state',
      lane: 'state',
      match: { kind: 'regex' as const, patterns: [/^【 气血 】 (?<cur>\d+)\/(?<max>\d+)$/] },
      map: { cur: 'char.hp', max: 'char.maxhp' },
    }]
    : []
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules,
    eventRules,
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

describe('回看历史查询 (W10.2 R2): 已投递/已消费行同样可查', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('T2 批次交付后, recall 仍可查这批行 (交付不影响历史); 新行同进历史', () => {
    // W10.2 R2: 交付水位废除, recall 改历史查询 (PLAN 3.7) — 已投递行不再被过滤。
    const h = harness('session-recall', { t2DeliverIntervalMs: 5_000 })
    h.runtime.connect()
    h.sink().onConnect()

    h.sink().onLines([ml('欢迎使用北大侠客行', 0), ml('这里明显的出口是 south。', 1)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('欢迎使用北大侠客行')

    // 已投递 → 历史仍可查 (R2: recall 覆盖面较旧交付水位只增不减)。
    expect(h.runtime.recall(60)).toEqual(['欢迎使用北大侠客行', '这里明显的出口是 south。'])

    // 新行未交付 (T2 限流压住) → 同样进历史。
    h.sink().onLines([ml('你捡起一把长剑。', 2)])
    h.sink().onBoundary('ga')
    expect(h.delivered).toHaveLength(1)
    expect(h.runtime.recall(60)).toEqual(['欢迎使用北大侠客行', '这里明显的出口是 south。', '你捡起一把长剑。'])

    // 限流窗口过后交付 → 交付只影响投递节奏, 历史不变。
    vi.advanceTimersByTime(5_000)
    expect(h.delivered).toHaveLength(2)
    expect(h.runtime.recall(60)).toEqual(['欢迎使用北大侠客行', '这里明显的出口是 south。', '你捡起一把长剑。'])
    h.runtime.dispose()
  })

  it('重连复位: 回看缓冲随连接作废 (旧连接历史不可查, 新连接行重新积累)', () => {
    const h = harness('session-recall-reconnect', { t2DeliverIntervalMs: 5_000 })
    h.runtime.connect()
    h.sink().onConnect()
    h.sink().onLines([ml('第一连接的行', 0)])
    h.sink().onBoundary('ga')
    expect(h.runtime.recall(10)).toEqual(['第一连接的行'])

    h.sink().onClose()
    h.sink().onConnect()
    // 重连复位 (resetForReconnect): abs 从 0 重来, 回看缓冲一起清空 —— 旧连接
    // 历史与新连接行号空间冲突, 不可查 (新连接行重新积累)。
    expect(h.runtime.recall(10)).toEqual([])
    h.sink().onLines([ml('第二连接的第一行', 0)])
    h.sink().onBoundary('ga')
    expect(h.runtime.recall(10)).toEqual(['第二连接的第一行'])
    h.runtime.dispose()
  })
})

describe('帧内容: 只进本帧, 不漏进下一帧', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('命令应答帧的行进 tool result (声明 on ga:1 后 GA 关窗)', async () => {
    const h = harness('session-frame')
    h.runtime.connect()
    h.sink().onConnect()

    // 声明才计 GA（PLAN §D3）：要 GA 关窗就得显式声明；未声明的窗口 GA 不关窗。
    const settle = { mode: 'stream', on: { kind: 'ga', count: 1 } } as const
    const pending = h.runtime.tools().mud_send!.execute({ cmd: 'look', settle })
    await vi.advanceTimersByTimeAsync(1)          // 队列写出 → armed
    expect(h.sent).toContain('look')
    h.sink().onLines([ml('北大街 -', 3), ml('这里明显的出口是 south。', 4)])
    h.sink().onBoundary('ga')
    const reply = await pending
    expect(reply.note).toContain('北大街')

    // 下一条命令的帧里只有它自己的应答。
    const pending2 = h.runtime.tools().mud_send!.execute({ cmd: 'inventory', settle })
    await vi.advanceTimersByTimeAsync(1)
    h.sink().onLines([ml('你身上带着:', 5)])
    h.sink().onBoundary('ga')
    const reply2 = await pending2
    expect(reply2.note).toBe('你身上带着:')
    h.runtime.dispose()
  })

  it('未声明收口的 T2 裸调用: GA 不关窗, 只由 fallback 兜底收口 (到期带回内容)', async () => {
    const h = harness('session-frame-nodeclared')
    h.runtime.connect()
    h.sink().onConnect()

    const pending = h.runtime.tools().mud_send!.execute({ cmd: 'look' })
    await vi.advanceTimersByTimeAsync(1)
    h.sink().onLines([ml('北大街 -', 3)])
    h.sink().onBoundary('ga')
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)                    // GA 不关窗（声明才计 GA）
    await vi.advanceTimersByTimeAsync(3_001)       // 缺省 fallback 3000ms 到期
    const r = await pending
    expect(r).toMatchObject({ settled: 'timeout', ok: false })
    // PLAN §D4 定案 A: 兜底到期**带回已累积内容** —— T2 裸调用仍拿得到回显。
    expect(r.note).toContain('北大街')
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

/**
 * **行流守恒** (A9 / W10.3): 无折叠、无移交、无隐藏行 ——
 * `① 命中行 + ② span + ③ T2 批次 + ④ 带原文投递 == 完整入站行流`。
 *
 * 本用例固定其中最容易退化的一条: 站① 状态抓取与站② `direct` 反射**只有副作用**
 * (同步 world / 顺带发命令), 它们命中的行照样原样落入下游投递。
 */
describe('行流守恒 (W10.3 无折叠: 抓取行与反射行都照常进行流)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('状态抓取行 + direct 命中行全部原样投出 (投递拼接 == 完整入站行流)', () => {
    const h = harness('session-conserve', { stateRule: true, directRule: true })
    h.runtime.connect()
    h.sink().onConnect()

    const stream = ['第一行', '【 气血 】 100/200', '请保存档案', '最后一行']
    h.sink().onLines(stream.map((t, i) => ml(t, i)))
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)

    expect(h.sent).toContain('save')             // direct 反射照常发命令
    expect(h.delivered).toHaveLength(1)
    // 无反引号/前缀包装: 批次正文即原行按序拼接 (含被抓取与被反射的两行)。
    expect(h.delivered[0]).toBe(stream.join('\n'))
    expect(h.runtime.recall(10)).toEqual(stream)
    h.runtime.dispose()
  })
})
