/**
 * dsh-mud-core — TriggerLlmAdapter (trigger-llm/adapter). T1 本地模拟 LLM。
 *
 * T1 是注册进官方 llm 注册表的一个"本地模拟模型" (provider = T1_PROVIDER):
 * 只回答有限问题 (规则命中的游戏输出)。判定输入 = **当前请求自身**的尾部
 * user 文本 (从 options.messages 提取, 不依赖任何旁路行缓存):
 *   - 尾部是 tool-result (T1-owned 回合的续步) → 安静收束 (finish stop),
 *     不产生模型调用也不交棒 — T1 独立完成整个 turn;
 *   - 尾部是游戏输出文本 → 经 resolveLines 找回该批行对象 (行号/style 保真,
 *     多行状态机跨批连续) → matchLines 匹配 → 渲染 action (output 文本 +
 *     tool-call 块, 与真实 LLM 响应同构);
 *   - 其余 (未命中 / 控制消息 / 无注册行) → finish{error, NO_ANSWER}:
 *     由装配方在 agent/request-error 瀑布返回 retry 并把路由改写为 T2 —
 *     官方机制自然切换, 本层不做任何级联编排。
 *
 * 控制消息 (CONTROL_PREFIX 前缀, 如 "[系统] 断流唤醒") 不属于游戏输出,
 * 一律 NO_ANSWER 交 T2。
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

/** T1 无答案失败码: agent/request-error 装配方据此识别 "T1 不应答 → 切 T2"。 */
export const T1_NO_ANSWER_CODE = 'MUD_T1_NO_ANSWER'

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
  | { kind: 'tool-tail' }
  | { kind: 'none' }

/** 从尾部扫描: 首个 (自尾向前) role=user 消息决定形态 —
 *  source.kind 'tool' → tool-result 续步; 'user' → 文本输入。 */
function tailInput(messages: readonly Message[] | undefined): TailInput {
  const list = messages
  if (!list || list.length === 0) return { kind: 'none' }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || m.role !== 'user') continue
    if (m.source.kind === 'tool') return { kind: 'tool-tail' }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('\n')
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

    // T1-owned 回合的续步 (本回合 T1 的 tool-calls 已执行): 安静收束回合。
    // 游戏对命令的响应会作为新回合再次进入 T1 — 无需任何模型介入。
    if (tail.kind === 'tool-tail') {
      this.hooks.onLog?.('[t1] tool-result 续步 → 安静收束回合')
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // 控制消息 / 无注册行 / 未命中 → NO_ANSWER (装配方据此切 T2)。
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
      this.hooks.onLog?.(`[t1] 无应答 (${why}, ${tail.kind === 'text' ? `${tail.text.length} 字符` : '0 字符'}) → NO_ANSWER`)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `T1 无应答 (${why})`, code: T1_NO_ANSWER_CODE },
        },
      }
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
