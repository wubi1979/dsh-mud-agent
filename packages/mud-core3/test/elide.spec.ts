/**
 * elide 测试 — 会话上下文「进程级收口」的纯层判定（T18.1，冻结计划见 doc/PLAN.md 第三节）。
 *
 * 只测判定与数据构造（宿主 append 接线在 T18.2，走实机重放级冒烟）。用例矩阵来自计划：
 *   1. 空表面 / 只有 head / node 0 非 head ⇒ 预期 skip；
 *   2. head + 历史 ⇒ 遮蔽 node1..last（surface 顺序、shadowed 全覆盖）；
 *   3. 幂等：已含本 epoch 标记 ⇒ skip；只含上一 epoch 标记 ⇒ 再遮蔽（旧标记本身也被遮蔽）；
 *   4. 端点按 surface 顺序取，**不假设 seq 单调**（一次替换后 start 数值可大于 end）；
 *   5. 保守 skip：表面含 node 0 以外的 system/message、跨度含未配对 tool/call；
 *   6. 已配对 tool call/result ⇒ 正常遮蔽；
 *   7. skip 与 failure 分流：快照不一致（表面节点不在日志里）⇒ 抛错，不是 skip；
 *   8. 标记形状冻结、正文含 epoch、无凭据面（P6 口径）；
 *   9. 进程 epoch 同进程稳定。
 *
 * 依据：spike 实测（doc/likely/t18-surface-elision-spike.md）+ 官方 reference/subsystems/session
 * （node 0 `system/message` 受保护、端点按 surface 位置而非数值区间）。
 */

import { describe, expect, it } from 'vitest'
import { applyElision, elisionPlan, epochMarker, processEpoch } from '../src/elide.ts'
import type { ElisionEvent, ElisionSession, EpochMarker } from '../src/elide.ts'

// ── 工具 ──────────────────────────────────────────────────────

const SYS = 'system/message'
const USER = 'user/message'
const ASSISTANT = 'assistant/message'
const CALL = 'tool/call'
const RESULT = 'tool/result'

/** 构造一条日志事件（只填本机制关心的三个字段）。 */
function ev(type: string, seq: number, data: unknown = {}): ElisionEvent {
  return { type, seq, data }
}

/** 一次调用配对。 */
function call(seq: number, callId: string): ElisionEvent {
  return ev(CALL, seq, { turn: 1, step: 1, callId, name: 'mud_send', arguments: '{}' })
}

/** 一次工具结果（callId 藏在 message.toolCallId）。 */
function result(seq: number, callId: string): ElisionEvent {
  return ev(RESULT, seq, {
    turn: 1, step: 1,
    message: { id: `msg-${seq}`, role: 'tool', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool' }, toolCallId: callId },
  })
}

/** 标准"有历史"会话：head(0) + 三条历史。 */
function sessionWithHistory(): { nodes: number[]; events: ElisionEvent[] } {
  return {
    nodes: [0, 1, 2, 3],
    events: [
      ev(SYS, 0, { turn: 1, step: 1 }),
      ev(USER, 1, { id: 'u1' }),
      ev(ASSISTANT, 2, { id: 'a1' }),
      ev(USER, 3, { id: 'u2' }),
    ],
  }
}

const EPOCH = '1762300000000-deadbeef'

// ── 用例 ──────────────────────────────────────────────────────

describe('elisionPlan 预期 skip（不阻断回合）', () => {
  it('① 空表面 ⇒ skip empty-surface', () => {
    expect(elisionPlan({ epoch: EPOCH, nodes: [], events: [] }))
      .toEqual({ kind: 'skip', reason: 'empty-surface' })
  })

  it('② 只有 head ⇒ skip no-history', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 })]
    expect(elisionPlan({ epoch: EPOCH, nodes: [0], events }))
      .toEqual({ kind: 'skip', reason: 'no-history' })
  })

  it('③ node 0 不是 system/message ⇒ skip no-head（绝不在 head 之前追加）', () => {
    const events = [ev(USER, 0, { id: 'u1' }), ev(USER, 1, { id: 'u2' })]
    expect(elisionPlan({ epoch: EPOCH, nodes: [0, 1], events }))
      .toEqual({ kind: 'skip', reason: 'no-head' })
  })

  it('④ 已含本 epoch 标记 ⇒ skip already-elided（幂等）', () => {
    const marker = epochMarker(EPOCH)
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, marker)]
    expect(elisionPlan({ epoch: EPOCH, nodes: [0, 1], events }))
      .toEqual({ kind: 'skip', reason: 'already-elided' })
  })

  it('⑤ 表面含 node 0 以外的 system/message ⇒ skip later-system-node（保守）', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, { id: 'u1' }), ev(SYS, 2, { turn: 1, step: 2 })]
    expect(elisionPlan({ epoch: EPOCH, nodes: [0, 1, 2], events }))
      .toEqual({ kind: 'skip', reason: 'later-system-node' })
  })

  it('⑥ 跨度含未配对 tool/call（结果尚未落盘）⇒ skip unpaired-tool-call', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, { id: 'u1' }), call(2, 'c1')]
    expect(elisionPlan({ epoch: EPOCH, nodes: [0, 1, 2], events }))
      .toEqual({ kind: 'skip', reason: 'unpaired-tool-call' })
  })

  it('⑦ 结果存在但不在表面（被更早的替换遮蔽）⇒ skip unpaired-tool-call', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, { id: 'u1' }), call(2, 'c1'), result(3, 'c1')]
    // seq 3 存在但不在当前表面 ⇒ 表面内的 call 无配对结果
    expect(elisionPlan({ epoch: EPOCH, nodes: [0, 1, 2], events }))
      .toEqual({ kind: 'skip', reason: 'unpaired-tool-call' })
  })
})

describe('elisionPlan 遮蔽计划', () => {
  it('⑧ head + 历史 ⇒ 遮蔽 node1..last，shadowed 全覆盖且按 surface 顺序', () => {
    const { nodes, events } = sessionWithHistory()
    const plan = elisionPlan({ epoch: EPOCH, nodes, events })
    expect(plan.kind).toBe('replace')
    if (plan.kind !== 'replace') return
    expect(plan.startSeq).toBe(1)
    expect(plan.endSeq).toBe(3)
    expect(plan.shadowedSeqs).toEqual([1, 2, 3])
    expect(plan.marker).toEqual(epochMarker(EPOCH))
  })

  it('⑨ 只含上一 epoch 标记 ⇒ 再遮蔽，旧标记节点也进被遮蔽集', () => {
    const previous = epochMarker('1762299000000-cafe0123')
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, previous), ev(USER, 2, { id: 'u2' })]
    const plan = elisionPlan({ epoch: EPOCH, nodes: [0, 1, 2], events })
    expect(plan.kind).toBe('replace')
    if (plan.kind !== 'replace') return
    expect(plan.shadowedSeqs).toEqual([1, 2])
  })

  it('⑩ 端点按 surface 顺序取，不假设 seq 单调（start 数值可大于 end）', () => {
    // 上一次替换把高 seq 节点放到了旧范围的位置上：表面 [1(head), 9(替换体), 3(更早追加)]
    const events = [ev(SYS, 1, { turn: 2, step: 1 }), ev(USER, 9, { id: 'u-replacement' }), ev(USER, 3, { id: 'u-old' })]
    const plan = elisionPlan({ epoch: EPOCH, nodes: [1, 9, 3], events })
    expect(plan.kind).toBe('replace')
    if (plan.kind !== 'replace') return
    expect(plan.startSeq).toBe(9)
    expect(plan.endSeq).toBe(3)
    expect(plan.shadowedSeqs).toEqual([9, 3])
  })

  it('⑪ 已配对 tool call/result ⇒ 正常遮蔽并覆盖两个节点', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, { id: 'u1' }), call(2, 'c1'), result(3, 'c1')]
    const plan = elisionPlan({ epoch: EPOCH, nodes: [0, 1, 2, 3], events })
    expect(plan.kind).toBe('replace')
    if (plan.kind !== 'replace') return
    expect(plan.shadowedSeqs).toEqual([1, 2, 3])
  })

  it('⑫ 快照不一致（表面节点不在日志里）⇒ 抛错（failure，不是 skip）', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 }), ev(USER, 1, { id: 'u1' })]
    expect(() => elisionPlan({ epoch: EPOCH, nodes: [0, 1, 99], events }))
      .toThrow(/99/)
  })
})

describe('epoch 与标记', () => {
  it('⑬ 标记形状冻结、正文含 epoch、无凭据面（P6 口径）', () => {
    const marker = epochMarker(EPOCH)
    expect(marker.id).toBe(`mud-epoch-${EPOCH}`)
    expect(marker.role).toBe('user')
    // 独立 source 种类（不冒充人类消息；同 compaction 的 compactCheckpointSource 模式）
    expect(marker.source).toEqual({ kind: 'mud-epoch' })
    expect(marker.content).toHaveLength(1)
    expect(marker.content[0]?.type).toBe('text')
    const text = marker.content[0]?.text ?? ''
    expect(text).toContain(EPOCH)
    for (const forbidden of ['密码', '凭据', 'password', 'passRef', 'credentials']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('⑭ 进程 epoch 同进程稳定，形如「进程启动毫秒-短随机后缀」', () => {
    const first = processEpoch()
    expect(processEpoch()).toBe(first)
    expect(first).toMatch(/^\d{12,14}-[0-9a-f]{8}$/)
  })

  it('⑮ 不同进程段（不同 epoch 字面量）各自生成独立标记 id', () => {
    expect(epochMarker('a-1').id).not.toBe(epochMarker('b-2').id)
  })
})

describe('applyElision 接线适配（append + 后置校验；失败即 failure，由接线层阻断本步）', () => {
  /**
   * 会话窄面假实现：surface 可变，按宿主语义"替换 surface 位置闭区间为新节点"。
   * @param nodes - 初始表面节点。
   * @param events - 日志快照。
   * @param behavior - 注入异常/漂移：append 抛错、忽略 append、保留被遮蔽节点。
   */
  function fakeSession(
    nodes: readonly number[],
    events: readonly ElisionEvent[],
    behavior: { appendThrows?: boolean; ignoreAppend?: boolean; keepShadowed?: boolean } = {},
  ): { face: ElisionSession; appends: { seq: number; startSeq: number; endSeq: number; shadowedSeqs: readonly number[] }[]; surface: () => readonly number[] } {
    let surface: number[] = [...nodes]
    const appends: { seq: number; startSeq: number; endSeq: number; shadowedSeqs: readonly number[] }[] = []
    let nextSeq = Math.max(0, ...nodes, ...events.map(event => event.seq)) + 1
    const face: ElisionSession = {
      get surface() { return { nodes: surface } },
      snapshotEvents: () => events,
      append: (_type, _data: EpochMarker, opts) => {
        if (behavior.appendThrows === true) throw new Error('宿主拒绝：端点不是当前表面节点')
        // 本机制只做 replace：fake 也把 append 视为接线错误（frozen 契约）。
        if (opts.surfaceOp === 'append') throw new Error('本机制不使用尾部追加')
        const seq = nextSeq
        nextSeq += 1
        const { startSeq, endSeq } = opts.surfaceOp
        appends.push({ seq, startSeq, endSeq, shadowedSeqs: opts.sourceEventSeqs ?? [] })
        if (behavior.ignoreAppend !== true) {
          const startIdx = surface.indexOf(startSeq)
          const endIdx = surface.indexOf(endSeq)
          const lo = Math.min(startIdx, endIdx)
          const hi = Math.max(startIdx, endIdx)
          surface = behavior.keepShadowed === true
            ? [...surface, seq]
            : [...surface.slice(0, lo), seq, ...surface.slice(hi + 1)]
        }
        return { seq }
      },
    }
    return { face, appends, surface: () => surface }
  }

  it('⑯ 正常路径：按计划 append 一次 replace，旧节点离开表面', () => {
    const { nodes, events } = sessionWithHistory()
    const { face, appends, surface } = fakeSession(nodes, events)
    const outcome = applyElision(face, EPOCH)
    expect(outcome).toEqual({ kind: 'replaced', seq: 4, shadowedSeqs: [1, 2, 3] })
    expect(appends).toEqual([{ seq: 4, startSeq: 1, endSeq: 3, shadowedSeqs: [1, 2, 3] }])
    expect(surface()).toEqual([0, 4])
  })

  it('⑰ 判定为 skip ⇒ 透传 skip 且不 append', () => {
    const events = [ev(SYS, 0, { turn: 1, step: 1 })]
    const { face, appends } = fakeSession([0], events)
    expect(applyElision(face, EPOCH)).toEqual({ kind: 'skip', reason: 'no-history' })
    expect(appends).toEqual([])
  })

  it('⑱ append 被宿主拒绝 ⇒ failed（不抛穿，交接线层阻断本步）', () => {
    const { nodes, events } = sessionWithHistory()
    const { face, appends } = fakeSession(nodes, events, { appendThrows: true })
    const outcome = applyElision(face, EPOCH)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toContain('宿主拒绝')
    expect(appends).toEqual([])
  })

  it('⑲ 替换体未落在表面（宿主语义漂移）⇒ failed', () => {
    const { nodes, events } = sessionWithHistory()
    const { face } = fakeSession(nodes, events, { ignoreAppend: true })
    const outcome = applyElision(face, EPOCH)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toContain('表面')
  })

  it('⑳ 被遮蔽节点仍留在表面 ⇒ failed', () => {
    const { nodes, events } = sessionWithHistory()
    const { face } = fakeSession(nodes, events, { keepShadowed: true })
    const outcome = applyElision(face, EPOCH)
    expect(outcome.kind).toBe('failed')
  })

  it('㉑ 快照与表面不一致 ⇒ failed（判定抛错被收成 failure，不中断回合）', () => {
    const { events } = sessionWithHistory()
    const { face, appends } = fakeSession([0, 1, 2, 99], events)
    const outcome = applyElision(face, EPOCH)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toContain('99')
    expect(appends).toEqual([])
  })
})
