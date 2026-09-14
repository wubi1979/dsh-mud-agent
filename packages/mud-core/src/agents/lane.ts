/**
 * dsh-mud-core — MUD agent 集成 (host half, **选路侧**)。
 *
 * 本模块做两件事, 全部走 dsh 官方扩展点:
 *
 *   1. **T1 provider** (`ctx.llm.registerAdapter`): `mud-t1` 本地模拟模型, 把
 *      L1 行级感知的**命中队列**渲染成确定性工具调用 (hit 渲染器, 不做文本反查);
 *   2. **所有权消息与每 agent 选路**: 投递消息携带 `kind='mud-owned'` + `lane` +
 *      `sessionId` (`MessageSourceMap` 声明合并), 选路走官方
 *      `installModelSelection` 的 `ModelSelectionRef.current` —— pre-step 写入,
 *      官方 system-prompt/assemble → agent/request 链自动完成路由 (T2 基线,
 *      T1 唯一干预点, doc/ARCHITECTURE.md §6)。
 *
 * 人设注入 / 提示区段 / 工具挂载与投递通道接线见 `mount.ts`。
 * @module @deepseek-ai/dsh-mud-core/agents/lane
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { TriggerLlmAdapter } from './t1.ts'

/** T1 provider 标识 (本地模拟模型注册名)。 */
export const T1_PROVIDER = 'mud-t1' as const
/** T1 模型标识 (仅路由判别用; T1 无真实模型)。 */
export const T1_MODEL = 't1-local' as const

/** 所有权 lane: t1 = T1 动作渲染, t2 = 真实 LLM 推理。 */
export type OwnedLane = 't1' | 't2'

/**
 * 一条**动作请求**：规则/流程声明的确定性动作（`{tool, args}`）+ 来源标识。
 *
 * 它随投递消息一起走（`source.actions`），T1 只是把它渲染成 tool-call —— **不是 T1 私有
 * 通道**：同一条消息给 T2，T2 读原文自行决定，动作请求只是可用信息（`doc/ARCHITECTURE.md`
 * §7 契约检验 I15）。
 */
export interface OwnedAction {
  /** 来源：规则 id 或 `flow:<flowId>/<stepId>`。 */
  ruleId: string
  /** 渲染文本（T1 的 output 文本块；留痕/转录用）。 */
  output: string
  /** 要调用的工具与参数（占位符 `{name}`/`{pass}`/`{captcha}` 在发送瞬间插值）。 */
  tool: { name: string; args: Record<string, unknown> }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** MUD 会话投递的游戏输出/控制消息 (含所有权 lane、来源会话与动作请求)。 */
    'mud-owned': {
      kind: 'mud-owned'
      lane: OwnedLane
      sessionId: string
      /**
       * 本次投递的动作请求（T1 据此渲染；批次消息不带）。空/缺省 = 本步没有动作可渲染。
       */
      actions?: readonly OwnedAction[]
      /**
       * 本次投递的**投递 id**（每会话单调递增）：T1 用它生成确定性 call-id
       * (`mud-<delivery>-<index>`)，从而无状态地判断"这条动作是否已经执行过"
       * （会话里已有该 id 的 tool-result ⇒ 已执行）。
       */
      delivery?: string
    }
  }
}

/**
 * 带所有权元数据的投递消息 (投递进某会话; 选路读 lane, T1 读 actions)。
 * @param text 模型可见文本 (T1 动作消息带原文; 批次已按预算裁剪)。
 * @param lane `t1` 动作渲染 / `t2` 批次。
 * @param sessionId 来源会话。
 * @param opts 可选：动作请求与投递 id (批次省略)。
 */
export function ownedGameMessage(
  text: string,
  lane: OwnedLane,
  sessionId: string,
  opts: { actions?: readonly OwnedAction[]; delivery?: string } = {},
) {
  return createUserMessage({
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: 'mud-owned',
      lane,
      sessionId,
      ...(opts.actions === undefined || opts.actions.length === 0 ? {} : { actions: opts.actions }),
      ...(opts.delivery === undefined ? {} : { delivery: opts.delivery }),
    },
  })
}

/**
 * 读一条消息携带的所有权 lane (非 MUD 投递 → undefined)。
 * lane **随消息走**: 选路由"本回合认领到哪条消息"决定, 不存在会话级
 * "最近一次 lane" 旁路状态 (那会让排队在后面的 T2 控制消息改写前面 T1 批次的选路)。
 * @param message 请求/认领批次中的一条消息。
 * @returns 该消息的 lane, 或 undefined。
 */
export function ownedLaneOf(message: Message): OwnedLane | undefined {
  const source = message.source
  return source.kind === 'mud-owned' ? source.lane : undefined
}

/** T1 provider 注册结果 (释放句柄)。 */
export interface TriggerProvider {
  /** 释放 provider 注册 (插件卸载)。 */
  dispose: () => void
}

/**
 * 注册 T1 provider (`mud-t1`): 一个**无状态动作渲染器**。
 *
 * 渲染依据是投递消息自带的动作请求（`source.actions`），不再回查运行时状态
 * （不变量 I15；`doc/ARCHITECTURE.md` §7）。
 * @param ctx 宿主上下文 (提供 `ctx.llm`)。
 * @param opts 日志钩子。
 * @returns provider 释放句柄。
 */
export function registerTriggerProvider(ctx: Context, opts: {
  log?: (text: string) => void
} = {}): TriggerProvider {
  const adapter = new TriggerLlmAdapter({
    ...(opts.log === undefined ? {} : { onLog: opts.log }),
  })
  const disposeAdapter = ctx.llm.registerAdapter([T1_PROVIDER], adapter)
  return { dispose: () => { disposeAdapter() } }
}

/** 每 agent 选路参数。 */
export interface OwnedLaneRoutingOptions {
  /** 宿主上下文 (用于访问 sessionController 拿 ModelSelectionRef)。 */
  ctx: Context
  /** 该会话是否是已绑定的 MUD 会话 (false = 完全不介入)。 */
  isMudSession: (sessionId: string) => boolean
  log?: (text: string) => void
  /**
   * 本回合 lane 变化的广播（可选）：每次 `agent/pre-step` 后回报"该回合的 lane"。
   *
   * 消费方是**限速闸**（`installMudToolGate` 的 `currentLane`）：**T1 通道的动作免限速**，
   * 只有 T2（真实模型）发起的调用才受 `toolCallIntervalMs` 约束 —— T1 是系统流程
   * （规则动作 / 流程步），不该被"给模型限速"的闸压住。
   */
  onLane?: (lane: OwnedLane | undefined) => void
}

/**
 * ModelSelectionRef 的最简形状 (与 @deepseek-ai/dsh-agent 兼容)。
 *
 * 我们只需要 `current` getter/setter —— setter 写入 picked, getter 在 picked
 * 存在时直接返回 picked, 不会从 requestHeader 回读 (这正是我们要的: 阻断污染链)。
 */
interface ModelSelectionRef {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

/**
 * 通过 sessionController 内部的 ApiSessionAgentController 拿到某 agent 的
 * ModelSelectionRef。类型断言绕过 private —— 运行时可访问, 编译期需要类型层面穿越。
 */
function trySelectionRef(ctx: Context, agent: Agent): ModelSelectionRef | null {
  const sc = ctx.get('sessionController')
  if (sc === undefined) return null
  const controller = (sc as unknown as { agents?: { selectionFor: (agent: Agent) => ModelSelectionRef } }).agents
  if (controller === undefined) return null
  try {
    return controller.selectionFor(agent)
  } catch {
    return null
  }
}

/**
 * 在**该 agent 自己的 ctx** 上注册 MUD 选路 (官方扩展点, 单事件):
 *
 * 框架: **T2 是基线, T1 是唯一干预点** (doc/ARCHITECTURE.md §6):
 *   - 投递前拦截: 装配方 (runtime) 在 `followup` 之前判类, 命中带 action 的
 *     event 规则 → 消息带 `lane=t1`, 未命中 → `lane=t2`;
 *   - `agent/pre-step` (waterfall, 在 system-prompt/assemble 之后): 记下
 *     **本回合**的 lane, 并通过官方 `ModelSelectionRef.current` 预先写入
 *     下回合要用的 provider/model —— 官方 installModelSelection 会在 assemble
 *     阶段快照 current, agent/request 阶段自动覆盖, 整个路由链由官方完成,
 *     插件不再拦截 agent/request。
 *
 * 为什么不再拦截 agent/request: installModelSelection 会无条件用 selection.assembled
 * 覆盖 provider/model, 我们只需要在 pre-step 里设好 selection.current (setter
 * 写入 picked), 就能保证 current getter 不会从 requestHeader 回读 T1 占位,
 * 彻底消除旧方案需要的记忆/还原/污染防御逻辑。
 *
 * 降级: 如果 sessionController 不可用 → 本函数只记录 lane, 不写 selection.current,
 *       运行时走 T2 基线 (所有请求用真实模型, 无 T1 拦截 —— 退化但安全)。
 * @param agent 目标 agent (由官方创建/恢复)。
 * @param opts 判据 (含 ctx)。
 * @returns 释放函数 (同时随 agent 作用域自动释放)。
 */
export function installOwnedLaneRouting(agent: Agent, opts: OwnedLaneRoutingOptions): () => void {
  const sessionId = String(agent.id)
  /** 本回合的 lane (由该回合认领的消息决定; 回合切换且无 MUD 投递时清空)。 */
  let turnLane: { turn: number; lane: OwnedLane } | null = null
  /** 会话真实模型 (从 requestHeader 读; 首次为 null 时走默认模型)。 */
  let realModel: ModelSelection | null = null
  /** 官方 ModelSelectionRef (pre-step 时获取一次, 后续复用)。 */
  let selectionRef: ModelSelectionRef | null = null

  const offPreStep = agent.ctx.on('agent/pre-step', (payload, next) => {
    if (payload.agent === agent) {
      const lanes = payload.messages.map(ownedLaneOf)
      const claimed = lanes.find(lane => lane !== undefined)
      if (claimed !== undefined) turnLane = { turn: payload.turn, lane: claimed }
      else if (turnLane !== null && turnLane.turn !== payload.turn) turnLane = null
      // 把"本回合的 lane"广播出去: 限速闸据此判定"T1 通道免限速"(§10 限速口径)。
      opts.onLane?.(turnLane !== null && turnLane.turn === payload.turn ? turnLane.lane : undefined)
      // 观测: 本步认领了什么 (mud-owned 无 = 本回合不是 MUD 投递 → 走会话自身模型)。
      opts.log?.(
        `[路由] step 认领 turn=${payload.turn} step=${payload.step} 消息=${lanes.length} mud-owned=${claimed ?? '无'}`,
      )

      // ── 官方 ModelSelectionRef 路径 ──
      // 懒获取 (首次 pre-step 时 sessionController 应该已就绪)。
      if (selectionRef === null) selectionRef = trySelectionRef(opts.ctx, agent)
      if (selectionRef !== null) {
        // 保存真实模型: 从 requestHeader 读 (跳过 T1 占位)。
        const header = agent.session.requestHeader()
        if (header !== undefined && header.config.provider !== T1_PROVIDER) {
          const { provider, model, reasoningEffort } = header.config
          realModel = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
        } else if (realModel === null) {
          // 首次无 requestHeader: 从 agentOptions 读。
          realModel = { provider: agent.options.provider ?? '', model: agent.options.model ?? '' }
        }

        // 写入下回合要用的 selection.current (installModelSelection 会在 assemble 快照它)。
        const pendingLane = turnLane !== null && turnLane.turn === payload.turn ? turnLane.lane : undefined
        const pendingSelection: ModelSelection = pendingLane === 't1'
          ? { provider: T1_PROVIDER, model: T1_MODEL }  // 不带 reasoningEffort → 官方自动剥离继承的 effort
          : realModel ?? { provider: '', model: '' }
        if (pendingSelection.provider !== '' && pendingSelection.model !== '') {
          selectionRef.current = pendingSelection
          opts.log?.(
            `[路由] 写入 selection.current → ${pendingSelection.provider}/${pendingSelection.model}` +
            (pendingLane === 't1' ? ' (T1)' : pendingLane === undefined ? ' (T2 基线)' : ''),
          )
        }
      } else if (opts.isMudSession(sessionId)) {
        opts.log?.('[路由] sessionController 不可用, 无法写入 selection.current — 本会话走 T2 基线')
      }
    }
    return next()
  })
  return () => { offPreStep() }
}
