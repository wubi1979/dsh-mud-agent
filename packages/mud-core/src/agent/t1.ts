/**
 * dsh-mud-core — TriggerLlmAdapter (agent/t1). T1 本地模拟 LLM = **动作渲染器**.
 *
 * T1 是注册进官方 llm 注册表的一个"本地模拟模型" (provider = `mud-t1`)。v0.4.0 起它是
 * **无状态**的（`doc/ARCHITECTURE.md` §7 契约）：
 *
 *   - 输入 = 本步**认领到的投递消息**里自带的**动作请求**（`source.actions`，
 *     由规则/流程声明；与 T2 拿到的消息同形 —— 契约检验 I15）；
 *   - 输出 = 对应的 `tool-call` 块（与真实 LLM 同构）→ 官方 `tools/pre-execute` 闸门 →
 *     官方工具管道。动作参数原样渲染（`{name}`/`{pass}`/`{captcha}` 由工具执行层插值）。
 *   - 没有动作请求 → `finish stop`（回合自然收束；失败路径就是"运行时不投递动作"）；
 *   - **不查运行时**：不再有 turnRef / 命中队列 / 游标。"这条动作是否已执行过"用
 *     **确定性 call-id**（`mud-<delivery>-<index>`）判断：会话里已有该 id 的 tool-result
 *     就是已执行 → 收束（避免工具结果回来后又渲染一次同一个动作）。
 *
 * 契约检验（I15）：本文件不得依赖只有 T1 能理解的私有字段；`source.actions` 是模型可见的
 * 声明（T2 读到同样能自行决定）。
 * @module @deepseek-ai/dsh-mud-core/agent/t1
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { FlowSlot } from './flow/slot.ts'

/** 一条动作请求（与 `deliver/lane` 的 `OwnedAction` 同形；用字面量避免循环依赖）。 */
export interface RenderedAction {
  /** 来源：规则 id 或 `flow:<flowId>/<stepId>`。 */
  ruleId?: string
  /** 渲染文本（output 文本块）。 */
  output?: string
  /** 要调用的工具与参数。 */
  tool?: { name: string; args?: Record<string, unknown> }
}

/** 装配方注入的 T1 钩子。 */
export interface TriggerLlmAdapterHooks {
  /** 诊断/留痕日志。 */
  onLog?: (text: string) => void
  /**
   * **读流程槽**（形态 C 第 5 步；可选）：按会话 id 取当前流程实例的公开槽。
   *
   * T1 只按 `sessionId` 查表（D10 / I8：槽表归会话作用域，adapter 自身保持无状态）。
   * 缺省 = 不接线 ⇒ 退回"只渲染投递里的动作"的旧行为（测试夹具用）。
   */
  slotOf?: (sessionId: string) => FlowSlot | null
  /** **登记已渲染**：把本次渲染的 callId 写进槽（D1 配对；随下一次迁移点自动复位）。 */
  markRendered?: (sessionId: string, callId: string) => void
}

/** 本插件投递消息的来源标记 (与 deliver/lane 的 MessageSourceMap 同字面量)。 */
const MUD_OWNED_KIND = 'mud-owned'

/** 一个请求所归属的投递。 */
type TurnContext =
  | { kind: 'actions'; lane: string; actions: readonly RenderedAction[]; delivery: string; index: number }
  | { kind: 'foreign-lane'; lane: string }
  | { kind: 'none'; why: string }

/**
 * 从请求消息**尾部反扫**最近一条本插件投递的消息, 取出其中的动作请求。
 *
 * `index` = 该投递消息在 messages 里的下标 —— 它产出的工具结果**只可能出现在它之后**
 * （助手工具调用 + 工具结果都是后置的），`alreadyAnswered` 据此把历史扫描下界锚定在
 * 这里，长会话下 T1 渲染不再全量扫历史。
 * @param messages 请求消息序列。
 * @returns 上下文: 有动作可渲染 / 选路异常 / 不可渲染的原因。
 */
function turnContext(messages: readonly Message[] | undefined): TurnContext {
  const list = messages
  if (!list || list.length === 0) return { kind: 'none', why: '无消息' }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m === undefined || m.role !== 'user') continue
    const source = m.source
    if (source.kind !== MUD_OWNED_KIND) continue
    // lane 先行: t2 批次本不该被路由到本 provider (走到这里是选路异常)。
    if (source.lane !== 't1') return { kind: 'foreign-lane', lane: String(source.lane) }
    const actions = source.actions
    if (actions === undefined || actions.length === 0) {
      return { kind: 'none', why: '本步投递不带动作请求' }
    }
    return {
      kind: 'actions',
      lane: source.lane,
      actions,
      delivery: source.delivery ?? 'd0',
      index: i,
    }
  }
  return { kind: 'none', why: '无本插件投递' }
}

/** 从消息文本里提取首段文本 (仅用于诊断)。 */
function preview(m: Message | undefined): string {
  if (m === undefined) return ''
  for (const block of m.content) {
    if (block.type === 'text') return block.text.slice(0, 40)
  }
  return ''
}

/** 确定性 call-id（`mud-<delivery>-<index>`）。 */
function actionId(delivery: string, index: number): ToolCallId {
  const slug = delivery.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32)
  return `mud-${slug}-${index}` as unknown as ToolCallId
}

/** 槽渲染的确定性 call-id 片段（`flow-<flowId>-<stepId>-<retries>`；与投递式 id 区分开）。 */
function flowCallSlug(flowId: string, stepId: string, retries: number): string {
  const clean = (text: string): string => text.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24)
  return `flow-${clean(flowId)}-${clean(stepId)}-${retries}`
}

/**
 * 会话里是否已有该 call-id 的工具结果（= 这条动作已执行过）。
 *
 * **只扫投递消息之后的消息**：call-id 由本投递渲染产生，助手工具调用与工具结果都出现在
 * 投递消息之后，从不早于它 —— 扫描下界锚定在后，长会话每次 T1 渲染的代价从
 * O(会话长度) 降为 O(投递之后那段尾段)。行为与全量扫一致（结果不会早于投递消息）。
 * @param messages 请求消息序列。
 * @param id 确定性 call-id（`mud-<delivery>-<index>`）。
 * @param afterIndex 目标投递消息在 messages 里的下标（该投递的结果只可能出现在它之后）。
 */
function alreadyAnswered(
  messages: readonly Message[] | undefined,
  id: ToolCallId,
  afterIndex: number,
): boolean {
  if (!messages) return false
  for (let i = messages.length - 1; i > afterIndex; i -= 1) {
    const message = messages[i]
    if (message === undefined) continue
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.toolCallId === id) return true
    }
  }
  return false
}

function toolArgsJson(args: Record<string, unknown> | undefined): string {
  const obj = args && typeof args === 'object' ? { ...args } : {}
  return JSON.stringify(obj)
}

/** T1 本地模拟适配器 (官方 LlmAdapter; 无状态动作渲染器)。 */
export class TriggerLlmAdapter extends LlmAdapter {
  constructor(private readonly hooks: TriggerLlmAdapterHooks = {}) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options?.signal?.aborted) return
    const context = turnContext(options?.messages)
    if (context.kind === 'foreign-lane') {
      // 只有 lane=t1 才会被路由到本 provider; 走到这里说明选路异常。
      this.hooks.onLog?.(`[t1] 收到 lane=${context.lane} 的请求 (选路异常) → 收束回合`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // 只渲染"尚未执行"的动作：它的工具结果若已在会话里，说明这一步已经跑完。
    let pending: { action: RenderedAction; index: number; id: ToolCallId }[] = []
    if (context.kind === 'actions') {
      const { actions, delivery, index: at } = context
      pending = actions
        .map((action, index) => ({ action, index, id: actionId(delivery, index) }))
        .filter(entry => !alreadyAnswered(options?.messages, entry.id, at))
    }
    if (pending.length === 0) {
      // **形态 C 续步（W10.4 第 5 步）**：本步没有认领到（或已渲染完）投递动作 —— 流程步的
      // 下一步由 **T1 按槽自己渲染**（不再有逐步投递消息）。规则动作回合与入口回合仍走上面的
      // `source.actions` 通路（那条优先，规则动作因此不会被槽顶掉）。
      const fromSlot = this.slotCall(options)
      if (fromSlot !== null) {
        this.hooks.onLog?.(`[t1] 按流程槽渲染下一步 (${fromSlot.label})`)
        if (fromSlot.sessionId !== null) this.hooks.markRendered?.(fromSlot.sessionId, fromSlot.id)
        yield* this.renderActions([{ action: fromSlot.action, index: 0, id: fromSlot.id }])
        return
      }
      const tail = options?.messages?.at(-1)
      const why = context.kind === 'none' ? context.why : '本次投递的动作都已执行'
      this.hooks.onLog?.(`[t1] 本步无动作可渲染 (${why}) → 收束 (尾部: ${preview(tail)})`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const deliveryLabel = context.kind === 'actions' ? context.delivery : '?'
    this.hooks.onLog?.(`[t1] 渲染 ${pending.length} 条动作 (delivery=${deliveryLabel})`)
    yield* this.renderActions(pending)
  }

  /**
   * **按流程槽取下一步 tool-call**（形态 C 第 5 步）。
   *
   * 条件（缺一不可）：接线了 `slotOf`；请求带 `sessionId`；槽在 `awaiting-result` 且**本步已
   * 发布可渲染的调用**；且**尚未渲染过**（`pendingCallId === null` —— 渲染后由 `markRendered`
   * 写入，随下一次迁移点自动复位，故不会重复渲染同一步）。
   *
   * 参数**原样透传**（`{name}`/`{pass}`/`{captcha}` 由工具在发送瞬间插值，D7.2）；收口三件
   * **不在这里下发** —— 流程步的收口由壳侧的 `windowSpecFor` 在注册窗口时给出（单一来源，
   * 与槽内 `render` 同一次派生）。
   * @param options 本次请求（取 `sessionId`）。
   * @returns 渲染项（callId + 动作 + 显示标签）；不该由槽渲染 = null。
   */
  private slotCall(options: GenerateOptions): {
    id: ToolCallId
    action: RenderedAction
    label: string
    sessionId: string | null
  } | null {
    const read = this.hooks.slotOf
    const sessionId = options?.sessionId
    if (read === undefined || typeof sessionId !== 'string' || sessionId === '') return null
    const slot = read(sessionId)
    if (slot === null || slot.phase !== 'awaiting-result' || slot.render === undefined) return null
    if (slot.pendingCallId !== null) return null   // 已渲染、结果未回 → 等结果
    const label = `flow:${slot.flowId}/${slot.stepId}`
    return {
      // 确定性 call-id：同一 (流程, 步骤, 重试轮次) 恒等 —— 与投递式 call-id 区分开。
      id: `mud-${flowCallSlug(slot.flowId, slot.stepId, slot.retries)}` as unknown as ToolCallId,
      action: {
        ruleId: label,
        // **不发 output 文本块**：流程步是"把命令发出去"，tool-call 本身就是全部内容；
        // 合成的说明文本只会变成助手消息里的噪声（A4：助手/工具交替，无注入）。
        tool: { name: slot.render.tool, args: slot.render.args },
      },
      label,
      sessionId,
    }
  }

  /** 渲染动作：每条先 output 文本块，后 tool-call 块（与真实 LLM 同构）。 */
  private async *renderActions(
    entries: readonly { action: RenderedAction; index: number; id: ToolCallId }[],
  ): AsyncIterable<StreamChunk> {
    let index = 0
    let hasTool = false
    for (const entry of entries) {
      const output = entry.action.output
      if (typeof output === 'string' && output.length > 0) {
        const i = index++
        yield { type: 'block-start', index: i, blockType: 'text' }
        yield { type: 'text-delta', index: i, text: output }
        yield { type: 'block-end', index: i, block: { type: 'text', text: output } as ContentBlock }
      }
      const tool = entry.action.tool
      if (tool && typeof tool.name === 'string' && tool.name.length > 0) {
        hasTool = true
        const i = index++
        const argumentsJson = toolArgsJson(tool.args)
        yield { type: 'block-start', index: i, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: i, id: entry.id, name: tool.name, argumentsDelta: argumentsJson }
        yield {
          type: 'block-end',
          index: i,
          block: {
            type: 'tool-call',
            id: entry.id,
            name: tool.name,
            arguments: argumentsJson,
          } as ContentBlock,
        }
      }
    }
    yield { type: 'finish', reason: { kind: hasTool ? 'tool-calls' : 'stop' } }
  }
}