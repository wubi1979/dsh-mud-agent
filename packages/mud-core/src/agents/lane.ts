/**
 * dsh-mud-core — MUD agent 集成 (host half, **选路侧**)。
 *
 * 本模块做两件事, 全部走 dsh 官方扩展点:
 *
 *   1. **T1 provider** (`ctx.llm.registerAdapter`): `mud-t1` 本地模拟模型, 把
 *      L1 行级感知的**命中队列**渲染成确定性工具调用 (hit 渲染器, 不做文本反查);
 *   2. **所有权消息与每 agent 选路**: 投递消息携带 `kind='mud-owned'` + `lane` +
 *      `sessionId` + `turnRef` (`MessageSourceMap` 声明合并), 选路 (`agent/request`
 *      waterfall, 注册在 **agent 自己的 ctx** 上) 只对"已绑定 MUD 会话"的 agent 生效,
 *      其余 agent **原样 `next()` 放行**, 不劫持进程内其他会话的模型路由。
 *
 * 人设注入 / 提示区段 / 工具挂载与投递通道接线见 `mount.ts`。
 * @module @deepseek-ai/dsh-mud-core/lane
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
 * T1 拦截的配置变换: 换 provider/model, 并**剥离继承的 `reasoningEffort`**。
 *
 * 官方 per-session 模型选择可能带着 `reasoningEffort` (如 deepseek 的 "high"),
 * 而它是 **adapter-owned** 的参数 —— 本地模拟 provider 不支持, 原样传递会被
 * llm 层拒绝: `provider "mud-t1" model "t1-local" does not support reasoning
 * effort "high"`。官方换模型时同样丢弃继承的 effort (见 harness
 * `core/agent/src/model-selection.ts`), 这里沿用同一惯用法。
 * @param config 官方瀑布给出的调用配置。
 * @returns 指向 `mud-t1` 的配置 (无 `reasoningEffort`)。
 */
export function toT1Config(config: LlmCallConfig): LlmCallConfig {
  const { reasoningEffort: _inherited, ...withoutInheritedEffort } = config
  return { ...withoutInheritedEffort, provider: T1_PROVIDER, model: T1_MODEL }
}

/**
 * 一次请求的选路决定 (纯函数; 便于单测)。
 *
 * **为什么要记忆"真实模型"**: 官方侧会把一次请求**实际生效**的 provider/model
 * 记成会话的模型选择。于是我们第一次把某回合拦成 `mud-t1` 之后, 后续请求
 * `next()` 就已经是 `mud-t1/t1-local` 了 —— 非 T1 回合会**打到本地模拟 provider**
 * (真实 LLM 永远不再参与; 表现: 断流唤醒投出的批次被 T1 适配器按"选路异常"收束)。
 * 因此这里记住最近一次非 T1 占位的配置, 并在非 T1 回合把它还原回去。
 *
 * 只在"官方给回的 provider 就是我们的占位"时还原: 用户手动换模型后 `next()` 给的是
 * 新模型, 照原样放行并更新记忆, 不会覆盖用户选择。
 * @param lane 本回合的 lane (`t1` = 规则动作, `t2`/undefined = 基线)。
 * @param config 官方瀑布给出的调用配置 (`next()` 的结果)。
 * @param memory 该 agent 上一次观测到的真实模型配置。
 * @returns 生效配置、更新后的记忆、以及是否发生了污染/还原 (供日志)。
 */
export function resolveLaneConfig(
  lane: OwnedLane | undefined,
  config: LlmCallConfig,
  memory: LlmCallConfig | null,
): { config: LlmCallConfig; memory: LlmCallConfig | null; restored: boolean; polluted: boolean } {
  if (lane === 't1') {
    // 占位配置不值得记 (否则会把占位当成真实模型)。
    const nextMemory = config.provider === T1_PROVIDER ? memory : config
    return { config: toT1Config(config), memory: nextMemory, restored: false, polluted: false }
  }
  if (config.provider !== T1_PROVIDER) {
    return { config, memory: config, restored: false, polluted: false }
  }
  if (memory === null) return { config, memory, restored: false, polluted: true }
  return { config: memory, memory, restored: true, polluted: true }
}

/**
 * 在**该 agent 自己的 ctx** 上注册 MUD 选路 (官方扩展点, 两个事件配合):
 *
 * 框架: **T2 是基线, T1 是唯一干预点**。
 *   - 投递前拦截: 装配方 (runtime) 在 `followup` 之前判类, 命中带 action 的
 *     event 规则 → 消息带 `lane=t1`, 未命中 → `lane=t2`;
 *   - `agent/pre-step` (waterfall, payload 带本步认领的 `messages`): 记下**本回合**
 *     的 lane (认领消息里第一条 `mud-owned` 的 lane)。lane 随消息走, 所以队列里
 *     排在后面的 T2 控制消息不会改写前面 T1 批次的选路; 同一回合的后续步
 *     (工具续步) 沿用该 lane。
 *   - `agent/request` (waterfall, prepend): **lane=t1 → 换成 `mud-t1`**;
 *     lane=t2 / 无 lane → 原样返回 —— 即"不介入", 由会话自身模型选择决定
 *     (缺省就是真实 LLM)。插件因此永远不需要写会话/全局模型状态。
 *
 * prepend 的原因: Cordis waterfall 里**先注册者最后拍板**。官方 per-session 模型
 * 选择 (`installModelSelection`, setup 期注册 → 早于本插件在 `agent/created`
 * 的装配) 会对每个请求写回会话选择的 provider/model; 不抢到最外层, 本插件选出的
 * `mud-t1` 会被它覆盖回真实 LLM (T1 静默失效, 表现为每 2s 一次 `agent/request`
 * 的重试/续步而无任何 `[t1]` 输出)。
 * @param agent 目标 agent (由官方创建/恢复)。
 * @param opts 判据。
 * @returns 释放函数 (同时随 agent 作用域自动释放)。
 */
export function installOwnedLaneRouting(agent: Agent, opts: OwnedLaneRoutingOptions): () => void {
  const sessionId = String(agent.id)
  /** 本回合的 lane (由该回合认领的消息决定; 回合切换且无 MUD 投递时清空)。 */
  let turnLane: { turn: number; lane: OwnedLane } | null = null
  /** 会话真实模型的最近观测值 (非 T1 占位; 见 resolveLaneConfig 的说明)。 */
  let realConfig: LlmCallConfig | null = null
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
  const offRequest = agent.ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const config = await next()
    if (payload.agent !== agent) return config
    if (!opts.isMudSession(sessionId)) return config
    const lane = turnLane !== null && turnLane.turn === payload.turn ? turnLane.lane : undefined
    // 观测: next() 之后的 provider 即"会话自身模型选择想用的路线"; 末尾是本插件实际返回。
    const decision = resolveLaneConfig(lane, config, realConfig)
    realConfig = decision.memory
    const intercept = lane === 't1'
    const outcome = intercept
      ? `拦截为 T1 (${T1_PROVIDER})`
      : decision.restored
        ? `还原真实模型 (${decision.config.provider}/${decision.config.model})`
        : '不介入 (T2 基线)'
    opts.log?.(
      `[路由] 请求 turn=${payload.turn} step=${payload.step} lane=${lane ?? '无'} ` +
      `next=${config.provider}/${config.model}` +
      `${config.reasoningEffort === undefined ? '' : ` (effort=${String(config.reasoningEffort)})`} → ${outcome}`,
    )
    if (decision.polluted) {
      opts.log?.(decision.restored
        ? `[路由] 会话模型被上次 T1 拦截 (${T1_PROVIDER}/${T1_MODEL}) → 本回合还原为 ${decision.config.provider}/${decision.config.model}`
        : `[路由] 会话模型为 T1 占位且本会话从未观测到真实模型 → 本回合无法还原, 请求将打到 ${T1_PROVIDER}`)
    }
    return decision.config
  }, { prepend: true })
  return () => { offPreStep(); offRequest() }
}