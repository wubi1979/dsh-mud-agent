/**
 * dsh-mud-core — **A2 同帧定序**（`doc/PLAN.md` W10.4 第 7 步 / 验收 A2）。
 *
 * 形态 C：窗口只带回**内容**（span 行），本步算哪一类由驱动器在 `judgeStep` 里按
 * **固定类序 retry → fail → 分支 → ok** 对内容走一遍，类内按行序取首（D3）。
 * 同帧（一次结算带回的 span）跨行多类命中按此序**取一**后即 break（判定已换步/收束，
 * 旧 units 作废）—— 本文件直接驱动 `FlowRuntime#noteToolResult('evidence', …)` 钉住：
 *   1. **fail 赢分支与 ok**（即使 fail 行排在 span 末尾）→ 流程失败收束，分支/成功不判；
 *   2. **分支赢 ok**（即使 ok 行排在 span 前部）→ 换步进分支，ok 不判（非入口步只发槽）。
 *
 * 端到端为何不在此测：分帧器逐行提交、触发行是帧的末行（`adjudicator.ts` FrameSplitter
 * #feedLines），行判据同源同编译于关闭触发 —— 跨行多类命中的 span 只能由 GA 关窗或
 * 驱动器复判入口构造，属驱动器属主行为，直接驱动即是最小钉法。
 */

import { describe, expect, it } from 'vitest'
import type { FlowSpec } from '../src/agent/flow/flows/index.ts'
import { FlowRuntime } from '../src/agent/flow/engine.ts'
import type { MudLine } from '../src/network/ansi.ts'

/** 三类判据并存：`start` 声明 fail + ok，`next` 指向有 driver 的 `alt`（分支类）。 */
const ORDER_FLOW: FlowSpec = {
  id: 'order',
  priority: 100,
  entry: 'start',
  timeoutMs: 30_000,
  steps: [
    {
      id: 'start',
      driver: { kind: 'text', includes: ['你开始行动'] },
      action: { tool: 'mud_send', args: { cmd: 'go' } },
      fail: [{ kind: 'text', includes: ['你摔了一跤'], why: '摔跤判据' }],
      ok: [{ kind: 'text', includes: ['你到达目的地'] }],
      settle: { mode: 'stream', fallback: { ms: 5_000 } },
      next: ['alt'],
    },
    {
      id: 'alt',
      driver: { kind: 'text', includes: ['岔路出现'] },
      action: { tool: 'mud_send', args: { cmd: 'turn' } },
      ok: [{ kind: 'ga' }],
      settle: { mode: 'stream', on: { kind: 'ga', count: 1 }, fallback: { ms: 5_000 } },
    },
  ],
}

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

function runtime(flows: readonly FlowSpec[]): { flow: FlowRuntime; logs: string[] } {
  const logs: string[] = []
  const flow = new FlowRuntime({
    flows,
    world: () => ({ flags: {} }) as never,
    log: text => { logs.push(text) },
    patch: () => {},
    direct: () => {},
    notifyFail: () => {},
  })
  return { flow, logs }
}

/** 入口激活到 start 步（awaiting-result；动作已由入口投递出口返回）。 */
function activateStart(flow: FlowRuntime): void {
  const hits = flow.offer([ml('你开始行动。', 0)], false)
  expect(hits).toHaveLength(1)
  expect(flow.state()).toMatchObject({ flowId: 'order', stepId: 'start', phase: 'awaiting-result' })
}

describe('A2 同帧定序 (W10.4 第 7 步: judgeStep 固定类序 retry → fail → 分支 → ok)', () => {
  it('fail 赢分支与 ok（fail 行在 span 末尾仍先判）→ 流程失败收束, 其余类不判', () => {
    const { flow, logs } = runtime([ORDER_FLOW])
    activateStart(flow)

    // 一次结算带回的 span: ok 行在前、分支行居中、fail 行在末尾。
    const hits = flow.noteToolResult('start', 'ok', 'evidence', [
      ml('你到达目的地', 1),
      ml('岔路出现', 2),
      ml('你摔了一跤', 3),
    ])

    // 类序 fail 先 → 未声明 retry → 失败收束（复位只留入口）；hits 为空（失败不产动作）。
    expect(hits).toEqual([])
    expect(flow.state()).toBeNull()
    expect(flow.slot()).toBeNull()
    const joined = logs.join('\n')
    expect(joined).toContain('[流程] order/start 失败：摔跤判据 → 复位（只留入口）')
    // "取一，其余不判"：分支唤醒与成功留痕都不出现。
    expect(joined).not.toContain('命中后继 alt 的进入判据')
    expect(joined).not.toContain('你到达目的地')
    flow.dispose()
  })

  it('分支赢 ok（ok 行在 span 前部仍不判）→ 换步进 alt, 非入口步只发槽', () => {
    const { flow, logs } = runtime([ORDER_FLOW])
    activateStart(flow)

    // 一次结算带回的 span: ok 行在前、分支行在后 —— 类序分支先于 ok。
    const hits = flow.noteToolResult('start', 'ok', 'evidence', [
      ml('你到达目的地', 1),
      ml('岔路出现', 2),
    ])

    // 分支唤醒后换步；alt 非入口步 → 动作走槽（无投递 hit），start 的 ok 判据未判。
    expect(hits).toEqual([])
    expect(flow.state()).toMatchObject({ flowId: 'order', stepId: 'alt', phase: 'awaiting-result' })
    expect(flow.slot()?.render).toMatchObject({ tool: 'mud_send', args: { cmd: 'turn' } })
    const joined = logs.join('\n')
    expect(joined).toContain('命中后继 alt 的进入判据')
    expect(joined).not.toContain('你到达目的地')
    flow.dispose()
  })
})
