/**
 * dsh-mud-core — TriggerLlmAdapter (trigger-llm/adapter). 级联 provider T1 适配层。
 *
 * 确定性模拟层 (T1): 从请求 messages 尾部 user 文本提取本步游戏输出,
 * 经注入的 matchLines 匹配规则 → 渲染 action (output 文本 + tool-call 块),
 * 与真实 LLM 响应同构 (assistant/message 与 tool/call 由 loop 官方管道统一装配)。
 *
 * 分支:
 *   - 命中 → 渲染全部动作 (逐条 output 文本 + tool-call, 多工具 finish 'tool-calls');
 *   - 未命中且 realAllowed → 转发真实 LLM (T2: 经注入 forward 重建 options);
 *   - 未命中且 !realAllowed (如登录期) → 空 finish(stop), 不产生模型调用。
 *
 * 本层不感知游戏/world; mimic 开关、实时命中 (matchLines)、转发 (forward) 均由
 * 装配方 (agent-bridge 级联注册) 注入。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/adapter
 */

import {
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ActionSpec, PerceptHit, PerceptionRule, TriggerAction } from './types.ts'

/** 装配方注入的 T1 行为钩子。 */
export interface TriggerLlmAdapterHooks {
  /** 命中匹配: 输入本步游戏输出文本 → 带 action 的命中列表 (顺行序)。 */
  matchLines: (text: string) => readonly TriggerAction[]
  /** mimic 开关: false 时 T1 完全跳过 (直接转发 / 空响应)。 */
  mimicEnabled: () => boolean
  /** 未命中时可否转发真实 LLM (登录期等返回 false)。 */
  realAllowed: () => boolean
  /** 转发真实 LLM (T2): 装配方需重建 options (真实 provider/model) 再走调用。 */
  forward: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** 命中通知 (每次渲染前; 装配方可在此写留痕)。 */
  onRender?: (entry: { action: ActionSpec; hit: PerceptHit; rule: PerceptionRule | null }) => void
}

/** 从尾部最近的 user 文本消息提取纯文本内容 (排除 tool-result 等 source)。 */
function latestUserText(messages: readonly Message[] | undefined): string {
  const list = messages
  if (!list) return ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || m.role !== 'user') continue
    // tool-result 消息通常 source.kind === 'tool'; 仅取用户/插件来源的游戏文本。
    if (m.source.kind === 'tool') continue
    const parts: string[] = []
    for (const block of m.content) {
      if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

function renderActionId(hit: PerceptHit, n: number): ToolCallId {
  const slug = hit.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24)
  return `mud-trigger-${slug}-${Date.now().toString(36)}${n.toString(36)}` as unknown as ToolCallId
}

/** switch 用宽松 destructure (field 顺序无关)。 */
function toolArgsJson(args: Record<string, unknown> | undefined): string {
  const obj = args && typeof args === 'object' ? { ...args } : {}
  return JSON.stringify(obj)
}

/** T1 适配层 (作为注册适配器被 loop 调用, 幂等渲染)。 */
export class TriggerLlmAdapter extends LlmAdapter {
  /** 上一次命中时的文本快照 (内容级去重: 同一 agent loop 步骤内重复尾部文本不再触发)。 */
  private lastMatchedText = ''

  constructor(private readonly hooks: TriggerLlmAdapterHooks) {
    super()
    if (this.hooks === null || typeof this.hooks !== 'object') {
      throw new Error('TriggerLlmAdapter: matching/forward hooks are required')
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options?.signal?.aborted) return
    if (!this.hooks.mimicEnabled()) {
      yield* this.hooks.forward(options)
      return
    }
    const text = latestUserText(options.messages)
    // 内容级去重: 同一尾部文本在工具循环中被重复提取时, 不重复匹配。
    if (text === this.lastMatchedText) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const actions = text.length > 0 ? this.hooks.matchLines(text) : []
    if (actions.length > 0) {
      this.lastMatchedText = text
      yield* this.renderActions(actions)
      return
    }
    if (!this.hooks.realAllowed()) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.hooks.forward(options)
  }

  /** 渲染全部动作 (顺行序): 每条 action 先 output 文本块, 后 tool-call 块。 */
  private async *renderActions(actions: readonly TriggerAction[]): AsyncIterable<StreamChunk> {
    let index = 0
    let hasTool = false
    for (const entry of actions) {
      this.hooks.onRender?.({
        action: entry.action,
        hit: entry.hit,
        rule: null, // 装配方如需规则上下文可在 matchLines 中附加到 TriggerAction
      })
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
        const id = renderActionId(entry.hit, i)
        const argumentsJson = toolArgsJson(tool.args)
        yield { type: 'block-start', index: i, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: i, id, name: tool.name, argumentsDelta: argumentsJson }
        yield {
          type: 'block-end',
          index: i,
          block: {
            type: 'tool-call',
            id,
            name: tool.name,
            arguments: argumentsJson,
          } as ContentBlock,
        }
      }
    }
    yield { type: 'finish', reason: { kind: hasTool ? 'tool-calls' : 'stop' } }
  }
}