/**
 * dsh-mud-core — 直接执行类动作测试 (`ActionSpec.direct`, `doc/ARCHITECTURE.md` §7)。
 *
 * 用户定案: `save` 这类触发**无状态、无需返回**, 与 state 桶同类 —— 命中不投给 agent,
 * 运行时直接按规则声明的动作执行 (命令入队即走)。这样既省一个 T1 回合, 也不再有
 * "帧内命中等不到反射回合而被丢掉"的问题 (§18.12)。
 *
 * 本文件固定三条契约:
 *   1. 命中行**折叠** (模型看不到提醒行), 命令**立即入队**;
 *   2. 不产生任何投递给 agent 的消息 (反射/批次都没有);
 *   3. 危险命令硬边界照旧生效 (直接执行不是"绕过安全"), 人工环节期间不执行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import defaultPerceptionRules from '../src/perceive/rules.ts'
import { MudSessionRuntime, type MudRuntimeConfig, type MudRuntimeSink } from '../src/runtime/session-runtime.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/services/network/manager.ts'
import type { MudLine } from '../src/services/network/ansi.ts'
import type { PerceptionRule } from '../src/perceive/types.ts'

const SAVE_PROMPT = '建议经常使用save命令保存档案，避免造成意外损失。'
const PAGER_PROMPT = '== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)'
const CAPTCHA_URL = 'http://fullme.pkuxkx.net/robot.php?filename=1699999999'
/** 直接执行用例: save/分页 (direct)。 */
const DIRECT_RULES = defaultPerceptionRules.filter(
  rule => rule.id === 'save:prompt' || rule.id === 'pager:continue',
)
/**
 * 人工环节样本规则（`awaitExternal`）：fullme 已流程化（`FULLME_FLOW`），规则表里不再有
 * "等人工"的规则 —— 这里自建一条最小规则，只用来验证"等人工期间不执行直接动作"。
 */
const HUMAN_RULE: PerceptionRule = {
  id: 'test:human',
  eventType: 'p:test:human',
  priority: 40,
  match: { kind: 'regex', patterns: [/^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/] },
  action: {
    output: '测试: 等人工输入',
    tool: { name: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
    awaitExternal: ['captcha'],
  },
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function harness(sessionId: string, extraRules: readonly PerceptionRule[] = []): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
  sent: string[]
  delivered: string[]
  decisions: string[]
  logs: string[]
} {
  const sent: string[] = []
  const delivered: string[] = []
  const decisions: string[] = []
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
    followup: (message: { content: readonly { type: string; text?: string }[] }) => {
      delivered.push(message.content.find(b => b.type === 'text')?.text ?? '')
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
    decision: (_id, record) => { decisions.push(`${record.actor}/${record.eventType ?? ''}/${record.action}`) },
  }
  const config: MudRuntimeConfig = {
    agentEnabled: true,
    commandIntervalMs: 0,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: 3_600_000,     // 只测直接执行: 把断流唤醒推开
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
    loginExitCommands: [],
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: [...DIRECT_RULES, ...extraRules],
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sent,
    delivered,
    decisions,
    logs,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

/** 建一个已登录连接 (直接执行要求已连接; 登录态让节拍/看门狗保持安静)。 */
async function connected(sessionId: string, extraRules: readonly PerceptionRule[] = []) {
  const h = harness(sessionId, extraRules)
  h.runtime.connect()
  h.sink().onConnect()
  await h.runtime.tools().world_patch!.execute({ patch: { logged_in: true } })
  vi.advanceTimersByTime(10)          // loginExitCommands (空行 + look) 出队
  h.sent.length = 0
  h.delivered.length = 0
  h.decisions.length = 0
  return h
}

describe('直接执行类动作 (无状态、无需返回的触发)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('save 提醒 → 直接入队 save; 提醒行折叠 (不投递给 agent)', async () => {
    const h = await connected('session-direct-save')

    h.sink().onLines([ml(SAVE_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)

    expect(h.sent).toContain('save')            // 命令直接发出
    expect(h.delivered).toEqual([])             // 命中不投给 agent
    expect(h.decisions).toContain('rule/direct-exec/直接执行')
    // 折叠: 提醒行不进回看缓冲的"未投递"部分 (交付水位已前移)。
    expect(h.runtime.recall(10)).toEqual([])
    h.runtime.dispose()
  })

  it('分页提示 → 直接发翻页命令; 1s 内重复提示不重复翻页 (guard 节流)', async () => {
    const h = await connected('session-direct-pager')

    h.sink().onLines([ml(PAGER_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    expect(h.sent).toEqual([' '])               // 一个空格 = 翻下一页

    h.sink().onLines([ml(PAGER_PROMPT, 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(1)
    // 节流内的第二次提示**不再是命中** (guard 拒绝): 不重复翻页, 该行照常作为 T2 文本
    // 投给模型 (由模型自己决定是否再翻)。
    expect(h.sent).toEqual([' '])
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toContain('未完继续')
    h.runtime.dispose()
  })

  it('人工环节 (等验证码) 期间不执行直接动作', async () => {
    const h = await connected('session-direct-human', [HUMAN_RULE])

    h.sink().onLines([ml(CAPTCHA_URL, 0)])
    h.sink().onBoundary('ga')
    expect(h.runtime.humanWait).toBe(true)

    h.sink().onLines([ml(SAVE_PROMPT, 1)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(10)

    expect(h.sent).not.toContain('save')
    expect(h.delivered).toEqual([])
    h.runtime.dispose()
  })

  it('未连接时不执行 (没有可执行的目标)', () => {
    const h = harness('session-direct-offline')
    h.runtime.connect()
    h.runtime.disconnect()
    h.sink().onLines([ml(SAVE_PROMPT, 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(10)
    expect(h.sent).not.toContain('save')
    h.runtime.dispose()
  })

  it('危险命令硬边界在直接执行里照样生效 (直接执行 ≠ 绕过安全)', () => {
    // 一条把硬禁用命令声明成 `direct` 的规则: 判定必须拒绝 (deny), 且不发出。
    const rogue: PerceptionRule = {
      id: 'rogue:direct',
      eventType: 'p:rogue',
      match: { kind: 'regex', patterns: [/^请删除人物$/] },
      action: { output: '删号', tool: { name: 'mud_send', args: { cmd: 'suicide -f' } }, direct: true },
    }
    const h = harness('session-direct-danger', [rogue])
    h.runtime.connect()
    h.sink().onConnect()
    vi.advanceTimersByTime(10)

    h.sink().onLines([ml('请删除人物', 0)])
    h.sink().onBoundary('ga')
    vi.advanceTimersByTime(10)

    expect(h.sent).not.toContain('suicide -f')
    expect(h.logs.join('\n')).toContain('直接执行被拒')
    h.runtime.dispose()
  })
})
