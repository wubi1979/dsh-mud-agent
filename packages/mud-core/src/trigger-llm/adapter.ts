/**
 * dsh-mud-core — TriggerLlmAdapter (trigger-llm/adapter). mud-cascade 阶段行走器。
 *
 * 单路径级联 provider (v6.3 瀑布数组) 的适配层: 按装配方注入的 stages 逐级行走,
 * 每调用重读 stages() (配置修改下次调用即生效, 无热拔插)。
 *   - 'trigger' 级 (T1): 确定性渲染。matchLines 命中 → 渲染 action (output 文本 +
 *      tool-call 块, 与真实 LLM 响应同构) 并返回 (内容级去重 lastMatchedText 保留);
 *   - 'model' 级:    显式 provider/model。prepareCall 拒绝 (未注册/NO_ADAPTER 等)
 *     或首块为 finish{error|aborted} (硬失败) → 关迭代器交棒下一级;
 *     其余首块 (含空 stop) commit 转发整流 (截断为当前级输出);
 *   - 尾部默认级:    数组耗尽后一律落到 DSH 默认配置 (agentDefaultModel), 即
 *     「默认瀑布 = DSH 默认配置」。无选择 → 空 finish(stop)。
 *
 * v6.2: 输入为 MudLine[] (abs 行号/style 由 AnsiStreamParser 分配);
 * replaceTailUserText 重建尾部最后一个文本承载 user 消息 (保留 tool-result 历史)。
 * 本层不感知游戏/world; 行对象 (getRecentLines)、匹配 (matchLines)、
 * 瀑布 (stages)、LLM 调用 (llm)、默认级选择 (defaultSelection) 均由装配方注入。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/adapter
 */

import {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmRuntime,
  Message,
  StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { MudLine } from '../preprocess/ansi.ts'
import type { CascadeStage, ActionSpec, PerceptHit, PerceptionRule, TriggerAction } from './types.ts'

/** 装配方注入的阶段行走钩子。 */
export interface TriggerLlmAdapterHooks {
  /** 命中匹配: 输入本步游戏输出行对象 → 带 action 的命中列表 (顺行序)。 */
  matchLines: (lines: MudLine[]) => readonly TriggerAction[]
  /** 获取最近推送的行对象 (供匹配与尾部文本重建)。 */
  getRecentLines: () => MudLine[]
  /** 瀑布数组 (每次调用重读; enabled:false 的阶段跳过)。 */
  stages: () => readonly CascadeStage[]
  /** LLM 句柄: model 级与尾部默认级经 prepareCall 走真实调用。 */
  llm: LlmRuntime
  /** 尾部默认级: DSH 默认模型选择 (agentDefaultModel.currentSelection()); null = 未配置。 */
  defaultSelection: () => { provider: string; model: string } | null
  /** 诊断/留痕日志 (交棒、无默认选择等)。 */
  onLog?: (text: string) => void
  /** 命中通知 (每次渲染前; 装配方可在此写留痕)。 */
  onRender?: (entry: { action: ActionSpec; hit: PerceptHit; rule: PerceptionRule | null }) => void
  /** 工具参数解析 (渲染前): 规则 args 可携带 {name}/{pass} 等会话凭据占位符;
   *  装配方按 sessionId 解析为实际值 (缺省不解析, 原样下发)。 */
  resolveToolArgs?: (args: Record<string, unknown>, sessionId: string | undefined) => Record<string, unknown>
}

/** 从尾部最近的 user 文本消息提取纯文本内容 (排除 tool-result 等 source)。 */
function renderActionId(hit: PerceptHit, n: number): ToolCallId {
  const slug = hit.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24)
  return `mud-trigger-${slug}-${Date.now().toString(36)}${n.toString(36)}` as unknown as ToolCallId
}

function toolArgsJson(args: Record<string, unknown> | undefined): string {
  const obj = args && typeof args === 'object' ? { ...args } : {}
  return JSON.stringify(obj)
}

/** 将 MudLine[] 拼接为纯文本 (用于内容级去重和转发)。 */
function linesToText(lines: MudLine[]): string {
  return lines.map(l => l.text).join('\n')
}

/** 把尾部最后一个"文本承载" user 消息 (非 tool-result) 替换为重建文本。
 *  返回新数组; 找不到则返回 undefined。tool-result 消息 (source.kind === 'tool') 保留。 */
function replaceTailUserText(messages: readonly Message[] | undefined, text: string): Message[] | undefined {
  const list = messages
  if (!list) return list as Message[] | undefined
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || m.role !== 'user' || m.source.kind === 'tool') continue
    if (!m.content.some(b => b.type === 'text')) continue
    const copy = list.slice()
    copy[i] = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }) as Message
    return copy
  }
  return list as Message[] | undefined
}

/** T1 适配层 (作为注册适配器被 loop 调用, 幂等渲染)。 */
export class TriggerLlmAdapter extends LlmAdapter {
  /** 上一次命中时的文本快照 (内容级去重)。 */
  private lastMatchedText = ''

  constructor(private readonly hooks: TriggerLlmAdapterHooks) {
    super()
    if (this.hooks === null || typeof this.hooks !== 'object') {
      throw new Error('TriggerLlmAdapter: matching/stages hooks are required')
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options?.signal?.aborted) return
    const stages = this.hooks.stages().filter(s => s.enabled !== false)
    const sessionId = options.sessionId

    for (const stage of stages) {
      if (stage.kind === 'trigger') {
        const lines = this.hooks.getRecentLines()
        const text = linesToText(lines)

        // 内容级去重: 同文本再次到达 (工具循环复用尾部) → 已渲染过, 空 stop。
        if (text === this.lastMatchedText) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (lines.length === 0) continue // 无行 → 不匹配, 交下一级

        const actions = this.hooks.matchLines(lines)
        if (actions.length === 0) continue // 未命中 → 交下一级
        this.lastMatchedText = text
        yield* this.renderActions(actions, sessionId)
        return
      }
      // model 级: 成功提交 → 截断为当前级输出并返回; 硬失败 → 交棒下一级。
      const gen = this.tryModelStage(stage, options)
      for (;;) {
        const r = await gen.next()
        if (r.done) {
          if (r.value === 'commit') return
          break // 'handoff' → 下一级
        }
        yield r.value
      }
      continue
    }

    // 尾部默认级 (DSH 默认配置)。
    yield* this.runDefaultStage(options)
  }

  /** 显式模型级: prepareCall 拒绝或首块 error/aborted → 'handoff'; 否则提交整流。
   *  首块为空流 (无 finish) → 视为空 stop 提交, 防悬挂。 */
  private async *tryModelStage(
    stage: Extract<CascadeStage, { kind: 'model' }>,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk, 'commit' | 'handoff'> {
    let prepared
    try {
      prepared = await this.hooks.llm.prepareCall({ provider: stage.provider, model: stage.model }, options?.signal)
    } catch {
      this.hooks.onLog?.(`[cascade] ${stage.id} prepareCall 拒绝 → 交棒下一级`)
      return 'handoff'
    }
    const built = this.buildModelOptions(options)
    const iter = prepared.stream(built)[Symbol.asyncIterator]()
    const first = await iter.next()
    if (first.done) {
      await this.closeIterator(iter)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return 'commit'
    }
    const chunk = first.value
    if (this.isHardFail(chunk)) {
      await this.closeIterator(iter)
      this.hooks.onLog?.(`[cascade] ${stage.id} 硬失败 (${chunk.reason.kind}) → 交棒下一级`)
      return 'handoff'
    }
    yield chunk
    for (;;) {
      const r = await iter.next()
      if (r.done) {
        await this.closeIterator(iter)
        return 'commit'
      }
      yield r.value
    }
  }

  /** 尾部默认级: DSH 默认模型 (agentDefaultModel)。与旧 T2 一致 — 不捕获
   *  prepareCall/stream 错误 (交由 loop 呈现失败); 无选择 → 空 finish(stop)。 */
  private async *runDefaultStage(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const selection = this.hooks.defaultSelection()
    if (!selection) {
      this.hooks.onLog?.('[cascade] 尾部默认级: 无 agentDefaultModel 选择 → 空 stop')
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const built = this.buildModelOptions(options)
    const prepared = await this.hooks.llm.prepareCall({ provider: selection.provider, model: selection.model }, options?.signal)
    yield* prepared.stream(built)
  }

  /** 重建尾部文本: 用最近行拼接文本替换最后一个文本承载 user 消息。
   *  无行 (空拼接) → 原样返回 (保留消息原文, 不做覆盖面重建)。 */
  private buildModelOptions(options: GenerateOptions): GenerateOptions {
    const text = linesToText(this.hooks.getRecentLines())
    if (!text) return options
    const rebuilt = replaceTailUserText(options.messages, text)
    return rebuilt ? { ...options, messages: rebuilt } : options
  }

  /** 渲染全部动作 (顺行序): 每条 action 先 output 文本块, 后 tool-call 块。
   *  tool.args 经 hooks.resolveToolArgs 解析 (会话凭据插值), 缺省原样下发。 */
  private async *renderActions(actions: readonly TriggerAction[], sessionId: string | undefined): AsyncIterable<StreamChunk> {
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
        const args = this.hooks.resolveToolArgs
          ? this.hooks.resolveToolArgs(tool.args ?? {}, sessionId)
          : (tool.args ?? {})
        const argumentsJson = toolArgsJson(args)
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

  /** 释放一个已提交迭代器 (硬失败/空流时关闭底层管道)。 */
  private async closeIterator(iter: AsyncIterator<StreamChunk>): Promise<void> {
    if (typeof iter.return !== 'function') return
    try { await iter.return() } catch { /* ignore */ }
  }

  /** 硬失败判定: 首块 finish 且 reason 为 error / aborted (交棒触发条件)。 */
  private isHardFail(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'finish' }> & { reason: { kind: 'error' | 'aborted' } } {
    return chunk.type === 'finish'
      && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
  }
}