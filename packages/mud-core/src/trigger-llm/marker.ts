/**
 * dsh-mud-core — Lite marker encoding (trigger-llm/marker).
 *
 * The lite marker travels on the user/message content (the official channel
 * the loop reads). The capture system builds a user message whose single text
 * block is prefixed with a sentinel line; the `agent/pre-step` listener parses
 * it back out and records the pending action for the trigger adapter.
 *
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/marker
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { LiteMarker } from './types.ts'

/** Sentinel that marks a user message as a deterministic trigger action. */
export const LITE_SENTINEL = '%%MUD-LITE%%'

/** Build a lite user/message from a marker (single text block + sentinel). */
export function toLiteUserMessage(marker: LiteMarker): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `${LITE_SENTINEL}\n${JSON.stringify(marker)}` }],
    source: { kind: 'user' },
  })
}

/**
 * Parse a lite marker out of a user message content (or null if none).
 * The marker is the JSON placed after the sentinel line.
 */
export function parseLiteMarker(message: UserMessage): LiteMarker | null {
  for (const block of message.content) {
    if (block.type !== 'text') continue
    const text = (block as { text?: string }).text ?? ''
    if (!text.startsWith(LITE_SENTINEL)) continue
    const json = text.slice(LITE_SENTINEL.length).trim()
    try {
      const parsed = JSON.parse(json) as Partial<LiteMarker>
      if (
        parsed.kind === 'lite' &&
        typeof parsed.entryId === 'string' &&
        typeof parsed.groupId === 'string' &&
        Array.isArray(parsed.capturedText) &&
        typeof parsed.actionTemplate === 'string' &&
        typeof parsed.renderedCmd === 'string'
      ) {
        return parsed as LiteMarker
      }
    } catch {
      /* not a valid marker */
    }
  }
  return null
}

/** Human-readable display of a marker (used in decision rail / logs). */
export function describeMarker(marker: LiteMarker): string {
  const preview = marker.capturedText.slice(-3).join(' | ').slice(0, 120)
  return `[触发 #${marker.entryId}/${marker.groupId}] ${marker.renderedCmd}${preview ? ` ← ${preview}` : ''}`
}
