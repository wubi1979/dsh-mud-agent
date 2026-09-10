/**
 * dsh-mud-core — TriggerLlmAdapter (trigger-llm/adapter). T1 本地模拟 LLM。
 *
 * T1 是注册进官方 llm 注册表的一个"本地模拟模型" (provider = T1_PROVIDER):
 * 只回答有限问题 (规则命中的游戏输出)。判定输入 = **当前请求自身**的尾部
 * user 文本 (从 options.messages 提取, 不依赖任何旁路行缓存):
 *   - 尾部是 tool-result (T1-owned 回合的续步) → 经 resolveLines 还原应答
 *     纯行 (命令-应答桥注册表) → matchLines 续步判定: 命中 → 渲染 action
 *     (工具链推进); 未命中 → finish stop (自然收束回合);
 *   - 尾部是游戏输出文本 → 经 resolveLines 找回该批行对象 (行号/style 保真,
 *     多行状态机跨批连续) → matchLines 匹配 → 渲染 action;
 *   - 其余 (未命中 / 控制消息 / 无注册行) → finish stop — **不再 NO_ANSWER
 *     交棒**: 谁接该批输出由装配方在 feed 判类时以所有权元数据决定 (T1 主
 *     反射 / T2 推理), 本层无级联编排。
 *
 * 控制消息 (CONTROL_PREFIX 前缀, 如 "[系统] 断流唤醒") 由装配方路由到 T2
 * (所有权 lane=t2); T1 即便偶遇也仅收束, 不产生任何模型调用。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { MudLine } from '../preprocess/ansi.ts'
import type { ActionSpec, PerceptHit, PerceptionRule, TriggerAction } from './types.ts'
import { CONTROL_PREFIX } from './types.ts'

/** 装配方注入的 T1 钩子。 */
export interface TriggerLlmAdapterHooks {
  /** 尾部 user 文本 → 该批游戏输出行对象 (内容寻址; miss → null, 如控制消息)。 */
  resolveLines: (text: string) => MudLine[] | null
  /** 命中匹配: 输入本步游戏输出行对象 → 带 action 的命中列表 (顺行序)。 */
  matchLines: (lines: MudLine[]) => readonly TriggerAction[]
  /** 诊断/留痕日志 (无答案、续步收束等)。 */
  onLog?: (text: string) => void
  /** 命中通知 (每次渲染前; 装配方在此写留痕)。 */
  onRender?: (entry: { action: ActionSpec; hit: PerceptHit; rule: PerceptionRule | null }) => void
}

/** 尾部输入判定结果。 */
type TailInput =
  | { kind: 'text'; text: string }
  | { kind: 'tool-tail'; text: string }
  | { kind: 'none' }

/** 提取一条消息的渲染文本 (含 tool-result 嵌套块)。 */
function messageText(m: Message): string {
  const chunks: string[] = []
  for (const block of m.content) {
    if (block.type === 'text') chunks.push(block.text)
    else if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') chunks.push(inner.text)
      }
    }
  }
  return chunks.join('\n')
}

/** 从尾部扫描: 首个 (自尾向前) role=user 消息决定形态 —
 *  source.kind 'tool' → tool-result 续步 (带应答文本); 'user' → 文本输入。 */
function tailInput(messages: readonly Message[] | undefined): TailInput {
  const list = messages
  if (!list || list.length === 0) return { kind: 'none' }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || m.role !== 'user') continue
    const text = messageText(m)
    if (m.source.kind === 'tool') return { kind: 'tool-tail', text }
    return text === '' ? { kind: 'none' } : { kind: 'text', text }
  }
  return { kind: 'none' }
}

function renderActionId(hit: PerceptHit, n: number): ToolCallId {
  const slug = hit.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24)
  return `mud-trigger-${slug}-${Date.now().toString(36)}${n.toString(36)}` as unknown as ToolCallId
}

function toolArgsJson(args: Record<string, unknown> | undefined): string {
  const obj = args && typeof args === 'object' ? { ...args } : {}
  return JSON.stringify(obj)
}

/** T1 本地模拟适配器 (官方 LlmAdapter; 幂等渲染, 无内部状态)。 */
export class TriggerLlmAdapter extends LlmAdapter {
  constructor(private readonly hooks: TriggerLlmAdapterHooks) {
    super()
    if (this.hooks === null || typeof this.hooks !== 'object') {
      throw new Error('TriggerLlmAdapter: resolveLines/matchLines hooks are required')
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options?.signal?.aborted) return
    const tail = tailInput(options?.messages)

    // T1-owned 回合的续步 (工具已执行): 经命令-应答桥注册表还原应答纯行,
    // 续步判定 — 命中 = 工具链继续推进; 未命中 = 回合自然收束。
    if (tail.kind === 'tool-tail') {
      const lines = tail.text !== '' ? this.hooks.resolveLines(tail.text) : null
      const actions = lines ? this.hooks.matchLines(lines) : []
      if (lines === null || actions.length === 0) {
        this.hooks.onLog?.(`[t1] tool-result 续步无命中 → 收束回合 (${tail.text.length} 字符)`)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      this.hooks.onLog?.(`[t1] tool-result 续步命中 ${actions.length} 条 → 渲染动作`)
      yield* this.renderActions(actions)
      return
    }

    // 游戏输出文本 (T1 主 / 观察窗注入): 还原行对象 → 匹配。
    const lines = tail.kind === 'text' && !tail.text.startsWith(CONTROL_PREFIX)
      ? this.hooks.resolveLines(tail.text)
      : null
    const actions = lines ? this.hooks.matchLines(lines) : []
    if (lines === null || actions.length === 0) {
      const why = tail.kind !== 'text'
        ? '无尾部文本'
        : tail.text.startsWith(CONTROL_PREFIX)
          ? '控制消息'
          : lines === null ? '无注册行' : '规则未命中'
      // 路由所有权已由装配方在 feed 判类时决定 — 本层不再交棒, 仅收束回合。
      this.hooks.onLog?.(`[t1] 无应答 (${why}) → 收束回合 (所有权已定, 不再交棒)`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    yield* this.renderActions(actions)
  }

  /** 渲染全部动作 (顺行序): 每条 action 先 output 文本块, 后 tool-call 块。
   *  tool args 原样渲染 (含 {name}/{pass} 等占位符) — 占位符的插值责任
   *  在工具执行层 (mud_send), 渲染层绝不落明文。 */
  private async *renderActions(actions: readonly TriggerAction[]): AsyncIterable<StreamChunk> {
    let index = 0
    let hasTool = false
    for (const entry of actions) {
      this.hooks.onRender?.({
        action: entry.action,
        hit: entry.hit,
        rule: null,
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
