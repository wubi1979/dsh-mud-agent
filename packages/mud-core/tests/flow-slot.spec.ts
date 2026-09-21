/**
 * dsh-mud-core — **T1 流程槽**（`doc/PLAN.md` §3.4 / W10.4 第 3 步）。
 *
 * 槽是**会话作用域**的一张表（每 `FlowRuntime` 一格），只放一件事：当前流程实例"处在哪一步、
 * 这一步要发什么"。第 5 步起 T1 按它渲染下一步 tool-call（不再依赖逐步投递），因此本文件钉住
 * 三件事：
 *   1. **发布点**：进入步骤 / 成功 / 终态收束 / 复位 —— 迁移点整格刷新；
 *   2. **渲染三件**：`render` 带**未插值**的参数 + 与 `windowSpecFor` **同一次派生**的收口三件
 *      （关闭触发 / GA 计数 / 兜底时长）⇒ "T1 渲染的 tool-call"与"窗口注册"不可能分歧；
 *   3. **相位**：`awaiting-result` 才有 `render`；`awaiting-branch`（本步已成功、在等后继
 *      driver）与空闲（收束/复位）都不带。
 */

import { describe, expect, it } from 'vitest'
import type { FlowSpec } from '../src/agent/flow/flows/index.ts'
import { FlowRuntime } from '../src/agent/flow/engine.ts'
import type { MudLine } from '../src/network/ansi.ts'

/** 单步探针流程：`开始` 进入（发 `probe`）→ `结束` 命中 ok → 无后继 = 终态。 */
const PROBE_FLOW: FlowSpec = {
  id: 'probe',
  priority: 100,
  entry: 'only',
  timeoutMs: 30_000,
  steps: [{
    id: 'only',
    driver: { kind: 'text', includes: ['开始'] },
    action: { tool: 'mud_send', args: { cmd: 'probe' } },
    ok: [{ kind: 'text', includes: ['结束'] }],
    settle: { mode: 'stream', fallback: { ms: 5_000 } },
  }],
}

/** 两步流程：`start` 发 `dz`（GA 判据）→ `done`（无动作，靠收功句进入 = 终态）。 */
const BRANCH_FLOW: FlowSpec = {
  id: 'branch',
  priority: 100,
  entry: 'start',
  timeoutMs: 30_000,
  steps: [
    {
      id: 'start',
      driver: { kind: 'text', includes: ['你盘膝坐下'] },
      action: { tool: 'mud_send', args: { cmds: ['halt', 'dz 10'] } },
      settle: { mode: 'stream', on: { kind: 'ga', count: 2 }, fallback: { ms: 5_000 } },
      next: ['done'],
    },
    { id: 'done', driver: { kind: 'text', includes: ['你站了起来'] } },
  ],
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function runtime(flows: readonly FlowSpec[]): FlowRuntime {
  return new FlowRuntime({
    flows,
    world: () => ({ flags: {} }) as never,
    log: () => {},
    patch: () => {},
    direct: () => {},
    notifyFail: () => {},
  })
}

describe('T1 流程槽 (W10.4 第 3 步: 会话作用域 + 迁移点发布)', () => {
  it('空闲 → 槽为空; 入口命中 → 槽含 flowId/stepId/相位与**本步要发的 tool-call**', () => {
    const flow = runtime([PROBE_FLOW])
    expect(flow.slot()).toBeNull()

    flow.offer([ml('开始', 0)], false)

    const slot = flow.slot()
    expect(slot).toMatchObject({
      flowId: 'probe',
      stepId: 'only',
      phase: 'awaiting-result',
      pendingCallId: null,
      retries: 0,
      captureSlots: {},
    })
    // render = 工具名 + **未插值**参数（`{name}`/`{pass}` 由工具发送瞬间插值）+ 收口三件。
    expect(slot?.render?.tool).toBe('mud_send')
    expect(slot?.render?.args).toEqual({ cmd: 'probe' })
    expect(slot?.render?.timeoutMs).toBe(5_000)
    // 关闭触发由本步判据派生（ok:[结束] + 无后继）—— 命中收功句, 不命中噪声。
    expect(slot?.render?.closeOn).toBeInstanceOf(RegExp)
    expect(slot?.render?.closeOn?.test('你结束了打坐。')).toBe(true)
    expect(slot?.render?.closeOn?.test('无关行')).toBe(false)
    expect(slot?.render?.gaCount).toBeUndefined()

    flow.dispose()
  })

  it('渲染三件与 windowSpecFor **同源**: 槽里的 closeOn/gaCount/timeoutMs 与窗口覆盖逐字段一致', () => {
    const flow = runtime([BRANCH_FLOW])
    flow.offer([ml('你盘膝坐下，开始打坐。', 0)], false)

    const slot = flow.slot()
    const spec = flow.windowSpecFor(['halt', 'dz 10'])
    expect(slot?.render?.gaCount).toBe(spec?.gaCount)          // 显式 on ga:2
    expect(slot?.render?.timeoutMs).toBe(spec?.timeoutMs)
    expect(slot?.render?.closeOn?.source).toBe(spec?.closeOn?.source)  // 后继 driver 派生
    expect(slot?.render?.args).toEqual({ cmds: ['halt', 'dz 10'] })

    flow.dispose()
  })

  it('成功但等分支 → 相位转 awaiting-branch 且**不带 render**（本步没有要发的命令）', () => {
    const flow = runtime([BRANCH_FLOW])
    flow.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
    flow.noteToolResult('start', 'ok', 'ga', [ml('halt', 1), ml('dz 10', 2)])

    const slot = flow.slot()
    expect(slot).toMatchObject({ flowId: 'branch', stepId: 'start', phase: 'awaiting-branch' })
    expect(slot?.render).toBeUndefined()
    flow.dispose()
  })

  it('callId ↔ 步骤配对（D1）: 登记在途调用 → stepIdForCall 认出; 换步即作废', () => {
    const flow = runtime([PROBE_FLOW])
    flow.offer([ml('开始', 0)], false)
    expect(flow.stepIdForCall('mud-flow-probe-only-0')).toBeNull()   // 未登记

    flow.setPendingCallId('mud-flow-probe-only-0')
    expect(flow.stepIdForCall('mud-flow-probe-only-0')).toBe('only')
    expect(flow.stepIdForCall('mud-别的')).toBeNull()

    // 迁移点（换步/收束）自动复位在途调用 —— T1 因此不会重复渲染同一步。
    flow.noteToolResult('only', 'ok', 'evidence', [ml('结束', 1)])
    expect(flow.stepIdForCall('mud-flow-probe-only-0')).toBeNull()
    flow.dispose()
  })

  it('终态收束 → 槽清空; 复位（失败）同样清空', () => {    const flow = runtime([PROBE_FLOW])
    flow.offer([ml('开始', 0)], false)
    expect(flow.slot()).not.toBeNull()

    flow.noteToolResult('only', 'ok', 'evidence', [ml('结束', 1)])
    expect(flow.state()).toBeNull()
    expect(flow.slot()).toBeNull()

    // 复位路径: 再次激活后断线 → reset → 槽清空。
    flow.offer([ml('开始', 2)], false)
    expect(flow.slot()).not.toBeNull()
    flow.noteDisconnect()
    expect(flow.slot()).toBeNull()
    flow.dispose()
  })
})
