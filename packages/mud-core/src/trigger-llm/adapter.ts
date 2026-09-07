/**
 * dsh-mud-core — TriggerLlmAdapter (trigger-llm/adapter).
 *
 * A deterministic `LlmAdapter` that never consults a real model. When a lite
 * marker is pending for the calling session (recorded by the agent/pre-step
 * listener), `stream()` emits one short text block followed by the action's
 * tool_call. The loop then executes that tool through the official tool
 * pipeline and writes a correlated tool/result — the same flow a real
 * assistant message would take.
 *
 * The adapter extends the harness `LlmAdapter`; the only required method is
 * `stream(options)`. All other defaults (providerInfo, resolveModel,
 * prepareCall, …) are inherited.
 *
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/adapter
 */

import {
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, StreamChunk, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { LiteMarker } from './types.ts'

/**
 * Deterministic LLM adapter for the mud-trigger provider route.
 * `consume` returns and clears the pending lite marker for one session
 * (exactly-once per stream).
 */
export class TriggerLlmAdapter extends LlmAdapter {
  private readonly consume: (sessionId: string) => LiteMarker | null

  constructor(consume: (sessionId: string) => LiteMarker | null) {
    super()
    this.consume = consume
  }

  /** The only required method. Emits deterministic short text + tool_call. */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Honor cancellation: abort as soon as the caller signals.
    if (options.signal?.aborted) return

    const sessionKey = typeof options.sessionId === 'string' ? options.sessionId : ''
    const marker = this.consume(sessionKey)
    if (marker === null) {
      // No action to render (defensive — the router only routes lite steps
      // here): emit an empty successful completion.
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const text = `[触发] ${describeForModel(marker)}${finishLabel(marker)}`

    // Text block.
    const textIndex = 0
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    yield { type: 'text-delta', index: textIndex, text }
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }

    // Tool-call block, when the marker carries one.
    const toolIndex = 1
    const toolCall = marker.toolCalls[0]
    if (toolCall) {
      const id = `mud-lite-${marker.entryId}-${Date.now().toString(36)}` as ToolCallId
      const name = toolCall.name
      const argsJson = argsToJson(toolCall.args)
      yield { type: 'block-start', index: toolIndex, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: toolIndex, id, name, argumentsDelta: argsJson }
      yield {
        type: 'block-end',
        index: toolIndex,
        block: { type: 'tool-call', id, name, arguments: argsJson } as ContentBlock,
      }
    }

    // Deterministic zero-token usage then the finish reason the loop keys on.
    yield { type: 'finish', reason: toolCall !== null ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
}

/** Serialize tool args to the JSON string the block-end expects. */
function argsToJson(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {})
}

/** Short model-facing line rendering a triggered action. */
function describeForModel(marker: LiteMarker): string {
  const preview = marker.capturedText.slice(-1)[0]?.slice(0, 80) ?? ''
  return `${marker.renderedCmd}${preview ? ` (捕获: ${preview})` : ''}`
}

/** Deterministic human/agent readout of the action list. */
function finishLabel(marker: LiteMarker): string {
  const calls = marker.toolCalls.map(c => c.name).join(',')
  return calls !== '' ? ` — 调用: ${calls}` : ''
}

export type { GenerateOptions }