/**
 * mud-core3 elide —— 会话上下文的**进程级收口**：表面遮蔽（surfaceOp replace）的纯层判定（T18.1）。
 *
 * 解决的问题：`sessionId = accountId` 随名册持久，宿主冷启动按 id 恢复会话 ⇒ 上一进程的上下文
 * （行批次 / 任务书 / 委派收尾）成为过期断言污染新连接。运行时世界状态已是进程级（§4 断线硬收尾），
 * 本模块处理的是**模型可见上下文**：在本进程**首次看见该会话（agent/created 登记时点）**时，
 * 把恢复表面的全部既有节点一次性替换为一条**进程起点标记**。
 *
 * **遮蔽时机 = 恢复时点（agent/created 缝，2026-10-08 spike 定稿）**：created 时点表面恰好就是
 * 上一进程恢复的历史集合，**遮蔽对象不需要推断**——直接对当前表面做一次 replace 即可；本进程
 * 后续投递（kickoff 任务书 / 补投批次）都发生在遮蔽**之后**，结构上不可能被吞（修掉「新账号
 * kickoff 误吞」缺陷：pre-step 逐步判定下，首步空表面 skip、第二步把任务书连同本轮上下文误杀）。
 * spike 实证（探针 `spike/created-mask-probe.mjs`，2026-10-08）：created 缝 append 被宿主接受、同步完成于
 * `create()` 返回前、重放不 corrupt、遮蔽跨进程持久、每进程一次语义天然成立。
 *
 * 宿主侧语义（实证见 `doc/likely/t18-surface-elision-spike.md`，官方面见 reference/subsystems/session）：
 *   - `Session.surface.nodes` = 当前 model-visible 表面节点序，**node 0 是受保护的 `system/message` head**；
 *     折叠拒绝任何覆盖 node 0 的替换；在 head 就位前追加 message 会让日志在下一进程重放被判 corrupt；
 *   - `Session.append('user/message', data, { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs })`
 *     把该闭区间替换成新节点；端点是**表面位置**（surface 顺序），**不是数值区间**——一次替换后
 *     新节点（高 seq）可能落在旧范围的位置上，因此 `startSeq` 可以大于 `endSeq`；
 *   - `sourceEventSeqs` 必须是"完整、非空"的被遮蔽节点集合。
 *
 * 纯度纪律：本模块零宿主依赖（只依赖 node 内建），只做判定与数据构造；真正的 `append` 在 index.ts 接线。
 * 「每进程一次」由接线层的会话集合守卫（created 每进程每会话至多 announce 一次 + 内存集合）承担，
 * 纯层保留 `already-elided` 幂等检查作为双保险。设计归属：§11.2。
 */

import { randomUUID } from 'node:crypto'

/** 表面 head 的事件类型（node 0 必须是它）。 */
const HEAD_TYPE = 'system/message'
/** 起点标记的消息 id 前缀（epoch 内嵌其后，用于同进程幂等判定）。 */
const MARKER_ID_PREFIX = 'mud-epoch-'

/** 日志事件的最小结构面（`session.snapshotEvents()` 的结构子集）。 */
export interface ElisionEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** 进程起点标记的消息数据（宿主 `user/message` 的 `UserMessage` 形）。 */
export interface EpochMarker {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  /**
   * 独立消息来源种类（同 compaction 的 `compactCheckpointSource` 模式）：**不冒充人类消息**——
   * 宿主 `validateSessionEventData` 不校验 source kind（merge-extensible，消费方对未知 kind 放行），
   * 而标题生成/会话活动等消费者按 kind 区分来源时可排除本标记。
   */
  readonly source: { readonly kind: 'mud-epoch' }
}

/** 预期跳过（**不阻断回合**）的原因；与"失败"（抛错）严格分流。 */
export type ElisionSkipReason =
  /** 表面为空（新会话，head 尚未就位）。 */
  | 'empty-surface'
  /** node 0 不是 `system/message`（head 未就位或已被破坏）——绝不在 head 之前追加。 */
  | 'no-head'
  /** 除 node 0 与"尾节点是 system/message"外没有可遮蔽的历史。 */
  | 'no-history'
  /** 日志里已含本 epoch 的起点标记（同进程幂等）。 */
  | 'already-elided'
  /**
   * 日志里存在**未解析**的 `tool/call`（其结果尚未落盘）：此时遮蔽会把该 call 一起遮掉，
   * 而它的结果将来落盘就会成为悬挂的 `tool/result`。`tool/call` 是 **log-only**（不是 surface
   * 事件，官方 `SurfaceEventType` 不含它）⇒ 配对判定必须看**日志**，不能看表面节点。
   */
  | 'unresolved-tool-call'

/** 遮蔽判定结果：`skip`（预期，放行登记）或 `replace`（执行一次遮蔽）。 */
export type ElisionPlan =
  | { readonly kind: 'skip'; readonly reason: ElisionSkipReason }
  | {
    readonly kind: 'replace'
    /** 被替换范围的首个表面节点 seq（surface 顺序；数值上可能大于 `endSeq`）。 */
    readonly startSeq: number
    /** 被替换范围的末个表面节点 seq（surface 顺序）。 */
    readonly endSeq: number
    /** 全部被遮蔽的表面节点 seq（surface 顺序；`sourceEventSeqs` 用它）。 */
    readonly shadowedSeqs: readonly number[]
    /** 替换体的消息数据。 */
    readonly marker: EpochMarker
  }

/** 判定输入。 */
export interface ElisionInput {
  /** 本进程 epoch（`processEpoch()`）。 */
  readonly epoch: string
  /** 当前表面节点 seq（`session.surface.nodes`，surface 顺序）。 */
  readonly nodes: readonly number[]
  /** 本会话日志快照（`session.snapshotEvents()`）。 */
  readonly events: readonly ElisionEvent[]
}

/** 会话的窄读写面（宿主 `Session` 的结构子集；接线层用 `ctx.get('agents')` 取值）。 */
export interface ElisionSession {
  /** 当前 model-visible 表面（只读）。 */
  readonly surface: { readonly nodes: readonly number[] }
  /** 只读日志快照。 */
  snapshotEvents(): readonly ElisionEvent[]
  /** 追加一条 message 事件（替换体只会用 `user/message`）。 */
  append(
    type: 'user/message',
    data: EpochMarker,
    opts: {
      readonly surfaceOp: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
      readonly sourceEventSeqs?: readonly number[]
    },
  ): { readonly seq: number }
}

/** 接线层要的结论：跳过（放行登记）/ 已遮蔽 / 失败（**接线层记 error 日志**）。 */
export type ElisionOutcome =
  | { readonly kind: 'skip'; readonly reason: ElisionSkipReason }
  | { readonly kind: 'replaced'; readonly seq: number; readonly shadowedSeqs: readonly number[] }
  | { readonly kind: 'failed'; readonly reason: string }

/** 本进程 epoch：`<进程启动毫秒>-<短随机后缀>`（同进程稳定，跨重启必然不同）。 */
const EPOCH = `${String(Math.round(Date.now() - process.uptime() * 1000))}-${randomUUID().slice(0, 8)}`

/**
 * 取本进程 epoch（进程级常量，模块加载时确定）。
 * @returns 形如 `1762300000000-deadbeef` 的稳定字符串。
 */
export function processEpoch(): string {
  return EPOCH
}

/**
 * 构造进程起点标记（**model-facing**：正文只写"上一次进程的历史已失效"与运行标识，不含任何凭据）。
 * @param epoch - 本进程 epoch。
 * @returns 可直接作为 `user/message` 数据 append 的消息对象。
 */
export function epochMarker(epoch: string): EpochMarker {
  return {
    id: `${MARKER_ID_PREFIX}${epoch}`,
    role: 'user',
    content: [{ type: 'text', text: `本次运行起点（运行标识 ${epoch}）：上一次进程的历史已失效，请勿据此判断现状。` }],
    source: { kind: 'mud-epoch' },
  }
}

/**
 * 判定本登记时点是否需要遮蔽，并给出替换计划（纯函数；宿主调用由接线层执行）。
 *
 * 遮蔽范围 = **surface 顺序**的 `node 1 … 末节点`，但**尾节点若是 `system/message` 则保留它**
 * （loop 的"最新系统节点"是有效提示词载体，保留它可避免与提示词规范化抢位；中段的后续
 * system 节点是普通历史，与 compaction 同样处理、随历史一起遮蔽）。
 *
 * 预期跳过（`skip`）绝不视为失败：新会话、无 head、无可遮蔽历史、本 epoch 已遮蔽、
 * 日志含未解析 `tool/call`，都照常放行登记。**快照与表面不一致**属失败，直接抛错
 * （接线层据此记 error 日志，见 §11.2）。
 *
 * @param input - epoch、表面节点序、日志快照。
 * @returns `skip`（含原因）或 `replace`（含端点、被遮蔽集与替换体）。
 * @throws 表面节点在日志快照里不存在时（快照与表面不一致）。
 */
export function elisionPlan(input: ElisionInput): ElisionPlan {
  const { epoch, nodes, events } = input
  if (nodes.length === 0) return { kind: 'skip', reason: 'empty-surface' }

  const bySeq = new Map(events.map(event => [event.seq, event]))
  const surface = nodes.map(seq => {
    const event = bySeq.get(seq)
    if (event === undefined) throw new Error(`会话表面节点 ${seq} 不在日志快照里（快照与表面不一致）`)
    return { seq, event }
  })

  const head = surface[0]
  if (head === undefined || head.event.type !== HEAD_TYPE) return { kind: 'skip', reason: 'no-head' }

  const lastIdx = surface.length - 1
  const endIdx = surface[lastIdx]?.event.type === HEAD_TYPE ? lastIdx - 1 : lastIdx
  if (endIdx < 1) return { kind: 'skip', reason: 'no-history' }
  if (events.some(event => stringField(event.data, 'id') === `${MARKER_ID_PREFIX}${epoch}`)) {
    return { kind: 'skip', reason: 'already-elided' }
  }
  if (!toolCallsResolved(events)) return { kind: 'skip', reason: 'unresolved-tool-call' }

  const start = surface[1]
  const last = surface[endIdx]
  /* v8 ignore next -- endIdx >= 1 已保证两个端点存在 */
  if (start === undefined || last === undefined) return { kind: 'skip', reason: 'no-history' }
  return {
    kind: 'replace',
    startSeq: start.seq,
    endSeq: last.seq,
    shadowedSeqs: surface.slice(1, endIdx + 1).map(node => node.seq),
    marker: epochMarker(epoch),
  }
}

/**
 * 执行一次遮蔽（接线层调用）：判定 → append → **后置校验**。
 *
 * 失败（判定抛错 / append 被拒 / 遮蔽后表面与预期不符）一律收成 `failed` 并附可读原因，
 * **不向调用方抛错**——接线层据此记 error 日志（created 缝无 step 可 reject，接受 fail-open：
 * 既有历史保留在模型上下文一次；与 pre-step 方案的 fail-closed 取舍见 §11.2）。
 * 后置校验刻意不苛求表面长度（容忍同一步内其它生产者的追加），只要求：替换体在表面、
 * 且全部被遮蔽节点已不在表面。
 *
 * @param session - 会话窄面（宿主 `Session` 的结构子集）。
 * @param epoch - 本进程 epoch。
 * @returns 跳过 / 已遮蔽 / 失败。
 */
export function applyElision(session: ElisionSession, epoch: string): ElisionOutcome {
  let plan: ElisionPlan
  try {
    plan = elisionPlan({ epoch, nodes: session.surface.nodes, events: session.snapshotEvents() })
  } catch (error: unknown) {
    return { kind: 'failed', reason: describe(error) }
  }
  if (plan.kind === 'skip') return plan

  let appended: { readonly seq: number }
  try {
    appended = session.append('user/message', plan.marker, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowedSeqs,
    })
  } catch (error: unknown) {
    return { kind: 'failed', reason: describe(error) }
  }

  const after = session.surface.nodes
  if (!after.includes(appended.seq) || plan.shadowedSeqs.some(seq => after.includes(seq))) {
    return {
      kind: 'failed',
      reason: `遮蔽后表面与预期不符（替换体 seq=${appended.seq}，表面=[${after.join(',')}]）`,
    }
  }
  return { kind: 'replaced', seq: appended.seq, shadowedSeqs: plan.shadowedSeqs }
}

/**
 * 把任意抛出物收成可读原因。
 * @param error - 抛出物。
 * @returns 错误消息或字符串化结果。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一次工具配对的读法。 */
type ToolPair = { readonly kind: 'call' | 'result'; readonly callId: string }
/**
 * 把工具事件读成配对键；非工具事件返回 undefined，工具事件但 callId 不可读返回 'malformed'。
 * @param event - 日志事件。
 * @returns 配对键、'malformed' 或 undefined。
 */
function toolPairOf(event: ElisionEvent): ToolPair | 'malformed' | undefined {
  if (event.type === 'tool/call') {
    const callId = stringField(event.data, 'callId')
    return callId === undefined ? 'malformed' : { kind: 'call', callId }
  }
  if (event.type === 'tool/result') {
    const callId = stringField(objectField(event.data, 'message'), 'toolCallId')
    return callId === undefined ? 'malformed' : { kind: 'result', callId }
  }
  return undefined
}

/**
 * 日志里的工具调用是否全部已解析（每个 `tool/call` 都有配对 `tool/result`，反之亦然）。
 *
 * 只看**日志**：`tool/call` 是 log-only（不是 surface 事件），而 `tool/result` 是 surface 事件
 * ⇒ 任何"在表面节点里找配对"的写法都会把正常会话误判为未配对（真实会话诊断教训，见 CHANGELOG v0.0.47）。
 * callId 不可读的工具事件按"未解析"处理（保守跳过）。
 *
 * @param events - 会话日志快照（全量）。
 * @returns 全部解析为 true；任一方向缺失或 callId 不可读为 false。
 */
function toolCallsResolved(events: readonly ElisionEvent[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const event of events) {
    const pair = toolPairOf(event)
    if (pair === undefined) continue
    if (pair === 'malformed') return false
    if (pair.kind === 'call') calls.add(pair.callId)
    else results.add(pair.callId)
  }
  for (const callId of calls) if (!results.has(callId)) return false
  for (const callId of results) if (!calls.has(callId)) return false
  return true
}

/**
 * 读一个可为对象的值的字符串字段。
 * @param value - 任意值。
 * @param field - 字段名。
 * @returns 字符串字段值，或 undefined。
 */
function stringField(value: unknown, field: string): string | undefined {
  const record = objectField(value, undefined)
  if (record === undefined) return undefined
  const raw = record[field]
  return typeof raw === 'string' ? raw : undefined
}

/**
 * 读对象字段（`field` 省略时把 `value` 本身当对象读）。
 * @param value - 任意值。
 * @param field - 字段名；undefined 表示直接读 `value`。
 * @returns 记录，或 undefined。
 */
function objectField(value: unknown, field: string | undefined): Record<string, unknown> | undefined {
  const target = field === undefined
    ? value
    : (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : undefined)
  return typeof target === 'object' && target !== null ? target as Record<string, unknown> : undefined
}
