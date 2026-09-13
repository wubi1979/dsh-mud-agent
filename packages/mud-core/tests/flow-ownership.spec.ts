/**
 * dsh-mud-core — **桥结算归属：按命令比对**（`doc/ARCHITECTURE.md` §19.3）。
 *
 * 归属判据从"布尔标记（本步有命令在途）"升级为"按命令比对"：
 * 桥在结算时报告**被这次结算关掉的命令**（`onSettle(kind, text, cmds)`），流程用它与本步
 * **放行过的命令集合**（`allowBridgeRequest` / `noteOwnCommandWritten` 记录）做交集判定。
 *
 * 为什么：一个步骤可以发多条命令（序列动作，如 fullme 的 `['halt','fullme {captcha}']`）。
 * 布尔标记只能回答"本步有命令在途"，分不清"这条 GA 是哪条命令的" → 别的命令的 GA 会
 * 串结算本步。本用例直接驱动 `FlowRuntime` 钉住这条规则。
 */

import { describe, expect, it } from 'vitest'
import type { FlowSpec } from '../src/config/flows.ts'
import { FlowRuntime } from '../src/runtime/flow-runtime.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

/** 一个两步流程：`start` 发 `dazuo`（ok:[GA]），`done` 靠收功句进入（终态）。 */
const TEST_FLOW: FlowSpec = {
  id: 'test',
  priority: 100,
  entry: 'start',
  timeoutMs: 30_000,
  steps: [
    {
      id: 'start',
      driver: { kind: 'text', includes: ['你盘膝坐下'] },
      action: { tool: 'mud_send', args: { cmd: 'dazuo 10' } },
      ok: [{ kind: 'ga' }],
      next: ['done'],
    },
    { id: 'done', driver: { kind: 'text', includes: ['你站了起来'] } },
  ],
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function runtime(logs: string[] = [], mask?: (text: string) => string): FlowRuntime {
  return new FlowRuntime({
    flows: [TEST_FLOW],
    world: () => ({ flags: {} }) as never,
    log: text => { logs.push(text) },
    patch: () => {},
    direct: () => {},
    notifyFail: () => {},
    ...(mask === undefined ? {} : { mask }),
  })
}

/** 激活流程并停在 `start`（命令已放行，等待结算）。 */
function armed(runtime: FlowRuntime): void {
  runtime.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
  expect(runtime.state()).toMatchObject({ flowId: 'test', stepId: 'start', phase: 'awaiting-result' })
  expect(runtime.allowBridgeRequest('dazuo 10')).toBe(true)
}

describe('桥结算归属 (按命令比对)', () => {
  it('本步放行过的命令 → 结算生效（GA 判据命中 → 进入后继分支）', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    const hits = flow.noteSettle('ga', '', ['dazuo 10'])
    expect(flow.state()).toMatchObject({ flowId: 'test', stepId: 'start', phase: 'awaiting-branch' })
    expect(hits).toEqual([])
    // 分支阶段等 done 的驱动句；再来一次同命令的 GA 已被消费 → 不再结算。
    expect(flow.noteSettle('ga', '', ['dazuo 10'])).toEqual([])
    flow.dispose()
  })

  it('**别的命令**的结算 → 拒绝并点名（不上一条命令的 GA 结算本步）', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    expect(flow.noteSettle('ga', '', ['lian sword'])).toEqual([])
    expect(flow.state()).toMatchObject({ stepId: 'start', phase: 'awaiting-result' })
    expect(logs.join('\n')).toContain('不是本步命令的结算: "lian sword"')
    // 本步自己的命令仍然有效（拒绝不消费归属）。
    expect(flow.noteSettle('ga', '', ['dazuo 10'])).toEqual([])
    expect(flow.state()).toMatchObject({ phase: 'awaiting-branch' })
    flow.dispose()
  })

  it('序列：一次请求里的多条命令，任一条属于本步即算本步的结算', () => {
    const seriesFlow: FlowSpec = {
      ...TEST_FLOW,
      steps: [
        {
          id: 'start',
          driver: { kind: 'text', includes: ['你盘膝坐下'] },
          action: { tool: 'mud_send', args: { cmds: ['halt', 'dazuo 10'] } },
          ok: [{ kind: 'ga' }],
          next: ['done'],
        },
        { id: 'done', driver: { kind: 'text', includes: ['你站了起来'] } },
      ],
    }
    const logs: string[] = []
    const flow = new FlowRuntime({
      flows: [seriesFlow],
      world: () => ({ flags: {} }) as never,
      log: text => { logs.push(text) },
      patch: () => {},
      direct: () => {},
      notifyFail: () => {},
    })
    flow.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
    expect(flow.allowBridgeRequest('halt')).toBe(true)
    expect(flow.allowBridgeRequest('dazuo 10')).toBe(true)

    // 桥报告"这次结算关掉的是这两条"（一次请求两命令的形态）。
    expect(flow.noteSettle('ga', '', ['halt', 'dazuo 10'])).toEqual([])
    expect(flow.state()).toMatchObject({ stepId: 'start', phase: 'awaiting-branch' })
    flow.dispose()
  })

  it('缺省 cmds（旧调用）→ 退化为"本步放行过命令"（兼容）', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    expect(flow.noteSettle('ga')).toEqual([])
    expect(flow.state()).toMatchObject({ phase: 'awaiting-branch' })

    // 未放行任何命令的步（没有 active 流程时）→ 任何结算都不结算流程。
    const idle = runtime([])
    expect(idle.noteSettle('ga', '', ['whatever'])).toEqual([])
    expect(idle.state()).toBeNull()
    idle.dispose()
    flow.dispose()
  })

  it('日志里的命令文本先过 mask（密码/验证码不落日志）', () => {
    const logs: string[] = []
    // 模拟运行时的脱敏接线：把密码替换成 ***。
    const flow = runtime(logs, text => text.split('Xiunyu123').join('***'))
    armed(flow)

    expect(flow.noteSettle('ga', '', ['Xiunyu123'])).toEqual([])
    const out = logs.join('\n')
    expect(out).toContain('不是本步命令的结算: "***"')
    expect(out).not.toContain('Xiunyu123')
    flow.dispose()
  })
})
