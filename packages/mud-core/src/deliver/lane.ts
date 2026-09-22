/**
 * dsh-mud-core — MUD agent 集成 (host half, **选路侧**)。
 *
 * 本模块做两件事, 全部走 dsh 官方扩展点:
 *
 *   1. **T1 provider** (`ctx.llm.registerAdapter`): `mud-t1` 本地模拟模型, 把
 *      L1 行级感知的**命中队列**渲染成确定性工具调用 (hit 渲染器, 不做文本反查);
 *   2. **所有权消息与每 agent 选路**: 投递消息携带 `kind='mud-owned'` + `lane` +
 *      `sessionId` (`MessageSourceMap` 声明合并), 选路在 `agent/request` 上拦截
 *      (T2 基线, T1 唯一干预点, doc/ARCHITECTURE.md §6)。
 *
 * 选路机制 (v0.9 W7.3 回归 doc §6 声明的设计; v0.6.x 曾改为 ModelSelectionRef
 * 预写方案, 未登记 CHANGELOG —— 本版一并补登记并删除该方案):
 *
 *   - `agent/pre-step` (agent 作用域): 记录**本回合**的 lane —— 取该回合认领消息里
 *     第一条 `mud-owned` 的 lane; 同一回合的后续步 (工具续步) 沿用。lane 读数经
 *     `onLane` 广播给限速闸 (T1 通道免限速, §10 限速口径)。
 *   - `agent/request` (agent 作用域 + **`{ prepend: true }`**, waterfall 先注册者
 *     最后拍板): `lane=t1` → 拦截为 `{provider:'mud-t1', model:'t1-local'}`;
 *     其余 (`t2` / 无 lane) → 官方链拍板**原样放行** (T2 基线, I3)。
 *
 * 为什么必须 prepend: 官方 per-session 模型选择 (`installModelSelection`, setup 期
 * 注册, 早于本插件) 会无条件写回会话模型; Cordis waterfall 中先注册者最后拍板,
 * 不抢最外层则 T1 被覆盖回真实 LLM (历史上表现为每 2s 一次 `agent/request` 而无任何
 * `[t1]` 输出)。
 *
 * 会话模型污染的防御 (doc §6, 实测 bug): 官方侧会把一次请求**实际生效**的
 * provider/model 记成会话的模型选择。于是首次把某回合拦成 `mud-t1` 之后, 同一回合
 * 的下一步 `next()` 就已是 `mud-t1/t1-local`, 非 T1 回合也会打到本地模拟 provider
 * (症状: 断流唤醒投出的批次被 T1 适配器按"选路异常"收束, 真实 LLM 永不参与)。
 * 因此选路里维护一份"会话真实模型"记忆 (`resolveLaneConfig` 的 `realModel`, 最近
 * 一次流经选路的非占位配置), 并在**非 T1 回合收到 T1 占位时还原**它; 还原分支
 * spread 请求配置, 只覆写 provider/model/reasoningEffort, 保留 temperature 等其余
 * 字段。用户手动换模型后 `next()` 给的是新模型 → 照原样放行并更新记忆, 不覆盖用户
 * 选择。纯判定集中在 `resolveLaneConfig` (可单测), 每次还原都留痕。
 *
 * 人设注入 / 提示区段 / 工具挂载与投递通道接线见 `mount.ts`。
 * @module @deepseek-ai/dsh-mud-core/deliver/lane
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TriggerLlmAdapter } from '../agent/t1.ts'
import type { FlowSlot } from '../agent/flow/slot.ts'

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
function ownedLaneOf(message: Message): OwnedLane | undefined {
  const source = message.source
  return source.kind === 'mud-owned' ? source.lane : undefined
}

/** T1 provider 注册结果 (释放句柄)。 */
export interface TriggerProvider {
  /** 释放 provider 注册 (插件卸载)。 */
  dispose: () => void
}

/**
 * 注册 T1 provider (`mud-t1`): 一个**外壳无状态**的动作渲染器 (状态在会话作用域的流程槽里)。
 *
 * 渲染来源两路（§7 v0.11.0）：投递消息自带的动作请求（`source.actions`）优先；无动作可渲染时
 * 按 `sessionId` 读**流程槽**渲染流程续步 —— adapter 不持有状态（不变量 I15）。
 * @param ctx 宿主上下文 (提供 `ctx.llm`)。
 * @param opts 日志钩子。
 * @returns provider 释放句柄。
 */
export function registerTriggerProvider(ctx: Context, opts: {
  log?: (text: string) => void
  /**
   * **读流程槽**（形态 C 第 5 步）：按会话 id 取当前流程实例的公开槽 —— T1 据此渲染流程步的
   * 下一步 tool-call（续步没有投递消息）。槽表归**会话作用域**（D10 / I8），adapter 只查表。
   */
  slotOf?: (sessionId: string) => FlowSlot | null
  /** **登记已渲染**：T1 渲染后把 callId 写进槽（D1 配对）。 */
  markRendered?: (sessionId: string, callId: string) => void
} = {}): TriggerProvider {
  const adapter = new TriggerLlmAdapter({
    ...(opts.log === undefined ? {} : { onLog: opts.log }),
    ...(opts.slotOf === undefined ? {} : { slotOf: opts.slotOf }),
    ...(opts.markRendered === undefined ? {} : { markRendered: opts.markRendered }),
  })
  const disposeAdapter = ctx.llm.registerAdapter([T1_PROVIDER], adapter)
  return { dispose: () => { disposeAdapter() } }
}

/** 会话真实模型记忆 (最近一次流经选路的非占位配置; 占位还原的数据源)。 */
export type RealModelMemo = Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort'>

/** `resolveLaneConfig` 的入参。 */
export interface LaneConfigInput {
  /** 本回合认领的 lane (undefined = 非 MUD 投递回合 / 无认领消息)。 */
  lane: OwnedLane | undefined
  /** 官方链拍板的请求配置 (waterfall `next()` 的返回)。 */
  requested: LlmCallConfig
  /** 真实模型记忆 (null = 尚无)。 */
  realModel: RealModelMemo | null
}

/** `resolveLaneConfig` 的出参。 */
export interface LaneConfigOutput {
  /** 最终请求配置。 */
  config: LlmCallConfig
  /** 更新后的真实模型记忆 (无新事实 = 原值透传)。 */
  realModel: RealModelMemo | null
  /** 本次是否发生了占位还原 (留痕用)。 */
  restored: boolean
}

/** 从请求配置提取记忆事实: 非 T1 占位且 provider/model 非空才有效 (否则 = null 不更新)。 */
function realModelOf(config: LlmCallConfig): RealModelMemo | null {
  if (config.provider === T1_PROVIDER || config.provider === '' || config.model === '') return null
  const { provider, model, reasoningEffort } = config
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * 选路判定**纯函数** (doc §6; 表驱动可单测)。框架: **T2 是基线, T1 是唯一干预点** (I3)。
 *
 * - `lane=t1` → 拦截为 `{provider:'mud-t1', model:'t1-local'}` (不带 reasoningEffort);
 *   若官方链拍板的仍是真实配置 (首个 T1 请求时官方尚未把会话模型记成 mud-t1), 顺手入
 *   记忆 —— 供后续 T2 回合还原。
 * - `lane=t2` / 无 lane → 官方链拍板**原样放行** (用户手动换模型不被覆盖), 并入记忆。
 * - 非 T1 回合收到 T1 占位 (会话模型污染) → 还原记忆里的真实模型; spread 请求配置,
 *   只覆写 provider/model/reasoningEffort, 保留 temperature/maxTokens/stop。
 * - 无记忆可还原 (会话尚未跑过任何非占位请求) → 保守放行占位, 下一次真实配置流经时
 *   重建记忆。
 */
export function resolveLaneConfig(input: LaneConfigInput): LaneConfigOutput {
  if (input.lane === 't1') {
    return {
      config: { provider: T1_PROVIDER, model: T1_MODEL },
      realModel: realModelOf(input.requested) ?? input.realModel,
      restored: false,
    }
  }
  if (input.requested.provider !== T1_PROVIDER) {
    return {
      config: input.requested,
      realModel: realModelOf(input.requested) ?? input.realModel,
      restored: false,
    }
  }
  if (input.realModel !== null) {
    const memo = input.realModel
    return {
      config: {
        ...input.requested,
        provider: memo.provider,
        model: memo.model,
        ...(memo.reasoningEffort === undefined ? {} : { reasoningEffort: memo.reasoningEffort }),
      },
      realModel: input.realModel,
      restored: true,
    }
  }
  return { config: input.requested, realModel: input.realModel, restored: false }
}

/** 每 agent 选路参数。 */
export interface OwnedLaneRoutingOptions {
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
 * 在**该 agent 自己的 ctx** 上注册 MUD 选路 (官方扩展点, 双事件):
 *
 * - `agent/pre-step`: 记录**本回合**的 lane (认领消息的第一条 mud-owned; 工具续步
 *   沿用), 并经 `onLane` 广播给限速闸;
 * - `agent/request` (**`{ prepend: true }`** — 先注册者最后拍板): lane=t1 拦截为
 *   T1 占位, 其余放行 + 维护真实模型记忆 (污染还原, 见模块注释)。
 *
 * 纯判定在 `resolveLaneConfig`; 本函数只做状态接线 (turnLane / realModel 两个
 * 会话内可变量) 与留痕。
 * @param agent 目标 agent (由官方创建/恢复)。
 * @param opts 日志与 lane 广播钩子。
 * @returns 释放函数 (同时随 agent 作用域自动释放)。
 */
export function installOwnedLaneRouting(agent: Agent, opts: OwnedLaneRoutingOptions): () => void {
  /** 本回合的 lane (由该回合认领的消息决定; 回合切换且无 MUD 投递时清空)。 */
  let turnLane: { turn: number; lane: OwnedLane } | null = null
  /** 会话真实模型记忆 (最近一次流经选路的非占位配置; 占位还原的数据源)。 */
  let realModel: RealModelMemo | null = null

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
    }
    return next()
  })

  const offRequest = agent.ctx.on('agent/request', async (payload, next) => {
    if (payload.agent !== agent) return next()
    const lane = turnLane !== null && turnLane.turn === payload.turn ? turnLane.lane : undefined
    const requested = await next()
    const result = resolveLaneConfig({ lane, requested, realModel })
    realModel = result.realModel
    if (result.restored) {
      opts.log?.(`[路由] 非 T1 回合收到 T1 占位, 还原真实模型 ${result.config.provider}/${result.config.model}`)
    }
    if (lane === 't1') {
      opts.log?.(`[路由] T1 通道 → ${T1_PROVIDER}/${T1_MODEL} (turn=${payload.turn} step=${payload.step})`)
    }
    return result.config
  }, { prepend: true })

  return () => { offPreStep(); offRequest() }
}
