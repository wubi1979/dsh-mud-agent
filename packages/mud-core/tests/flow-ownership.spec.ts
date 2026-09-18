/**
 * dsh-mud-core — **结算归属（W7.2）**：单步的命令-应答配对移交在途窗口
 * （`doc/PLAN.md` §4；取代旧桥的"按命令比对"归属）。
 *
 * 旧模型：桥结算时报告"被关掉的命令"，流程与放行过的命令集做交集 —— 一条 GA 归属
 * 哪个命令要靠比对推断。W7.2 把配对**结构性前移**：每步的命令在**各自的在途窗口**内
 * 结算（官方工具顺序执行 ⇒ 同时至多一个窗口），窗口结果按 `stepId` 回到
 * `noteToolResult` —— "别的命令的结算串掉本步"在结构上不可能发生，本文件钉住这一机制：
 *
 *   - `windowSpecFor(cmd)`：只有**本步声明的命令**（插值后）才拿到判据覆盖 —— 归属
 *     即注册路径，别的命令根本进不了本步的窗口；
 *   - `noteToolResult(stepId, …)`：stepId 不匹配（上一步的迟到结果等）→ 忽略并留痕。
 */

import { describe, expect, it } from 'vitest'
import type { FlowSpec } from '../src/runtime/flow/flows/index.ts'
import { FlowRuntime } from '../src/runtime/flow/flow.ts'
import type { MudLine } from '../src/services/network/ansi.ts'

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

function runtime(logs: string[] = []): FlowRuntime {
  return new FlowRuntime({
    flows: [TEST_FLOW],
    world: () => ({ flags: {} }) as never,
    log: text => { logs.push(text) },
    patch: () => {},
    direct: () => {},
    notifyFail: () => {},
  })
}

/** 激活流程并停在 `start`（等待工具结果推进）。 */
function armed(runtime: FlowRuntime): void {
  runtime.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
  expect(runtime.state()).toMatchObject({ flowId: 'test', stepId: 'start', phase: 'awaiting-result' })
}

describe('结算归属 (W7.2: 配对移交在途窗口)', () => {
  it('本步的命令 → windowSpecFor 返回判据覆盖 (gaOutcome ok)', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    // ok:[{kind:'ga'}] → 关窗结局 ok; 无行判据、无 boundary/timeout 覆盖。
    expect(flow.windowSpecFor('dazuo 10')).toEqual({ gaOutcome: 'ok' })
    flow.dispose()
  })

  it('**别的命令** → windowSpecFor 返回 null (归属即注册路径, 结构上排除串结算)', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    expect(flow.windowSpecFor('lian sword')).toBeNull()
    // 拒绝不消费归属: 本步命令仍然有效。
    expect(flow.windowSpecFor('dazuo 10')).toEqual({ gaOutcome: 'ok' })
    flow.dispose()
  })

  it('序列动作: 一次注册的多条命令逐条比对, 任一条属于本步即拿到判据', () => {
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
    const flow = new FlowRuntime({
      flows: [seriesFlow],
      world: () => ({ flags: {} }) as never,
      log: () => {},
      patch: () => {},
      direct: () => {},
      notifyFail: () => {},
    })
    flow.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
    expect(flow.windowSpecFor('halt')).toEqual({ gaOutcome: 'ok' })
    expect(flow.windowSpecFor('dazuo 10')).toEqual({ gaOutcome: 'ok' })
    // 序列整体比对: 同长度逐条一致才算本步的窗口。
    expect(flow.windowSpecFor(['halt', 'dazuo 10'])).toEqual({ gaOutcome: 'ok' })
    expect(flow.windowSpecFor(['halt', 'lian sword'])).toBeNull()
    flow.dispose()
  })

  it('GA 关窗 (settled=ga, outcome ok) → 推进到后继 done; 同窗口不会二次结算', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    const hits = flow.noteToolResult('start', 'ok', 'ga')
    expect(flow.state()).toMatchObject({ flowId: 'test', stepId: 'done' })
    expect(hits).toEqual([])
    // 上一步窗口的结局不会结算新进入的步骤 (done 在等自己的 driver 句)。
    flow.noteToolResult('start', 'ok', 'ga')
    expect(flow.state()).toMatchObject({ flowId: 'test', stepId: 'done' })
    flow.dispose()
  })

  it('stepId 不匹配的迟到结果 → 忽略并留痕 (不推进任何步骤)', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)

    expect(flow.noteToolResult('other-step', 'ok', 'ga')).toEqual([])
    expect(flow.state()).toMatchObject({ flowId: 'test', stepId: 'start', phase: 'awaiting-result' })
    flow.dispose()
  })

  it('非 awaiting-result 阶段 (分支等待) → windowSpecFor 返回 null', () => {
    const logs: string[] = []
    const flow = runtime(logs)
    armed(flow)
    flow.noteToolResult('start', 'ok', 'ga')
    expect(flow.state()).toMatchObject({ flowId: 'test', stepId: 'done' })

    // done 在等 driver 句, 没有命令在途 → 任何命令都拿不到判据。
    expect(flow.windowSpecFor('dazuo 10')).toBeNull()
    flow.dispose()
  })

  it('无活动流程 → noteToolResult 忽略, windowSpecFor 返回 null', () => {
    const idle = runtime([])
    expect(idle.noteToolResult('start', 'ok', 'ga')).toEqual([])
    expect(idle.windowSpecFor('dazuo 10')).toBeNull()
    expect(idle.state()).toBeNull()
    idle.dispose()
  })

  it('插值: 期望命令按流程槽插值后比对 ({captcha} 由注册方传值)', () => {
    const captchaFlow: FlowSpec = {
      ...TEST_FLOW,
      steps: [
        {
          id: 'start',
          driver: { kind: 'text', includes: ['你盘膝坐下'] },
          action: { tool: 'mud_send', args: { cmd: 'fullme {captcha}' } },
          ok: [{ kind: 'ga' }],
          next: ['done'],
        },
        { id: 'done', driver: { kind: 'text', includes: ['你站了起来'] } },
      ],
    }
    const flow = new FlowRuntime({
      flows: [captchaFlow],
      world: () => ({ flags: {} }) as never,
      log: () => {},
      patch: () => {},
      direct: () => {},
      notifyFail: () => {},
    })
    flow.offer([ml('你盘膝坐下，开始打坐。', 0)], false)
    // 插值后一致 → 本步的窗口; 占位符未填 (原样) 或值不对 → null。
    expect(flow.windowSpecFor('fullme 1234', { captcha: '1234' })).toEqual({ gaOutcome: 'ok' })
    expect(flow.windowSpecFor('fullme {captcha}', { captcha: '1234' })).toBeNull()
    expect(flow.windowSpecFor('fullme 9999', { captcha: '1234' })).toBeNull()
    flow.dispose()
  })
})
