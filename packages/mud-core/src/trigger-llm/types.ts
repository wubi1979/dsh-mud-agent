/**
 * dsh-mud-core — Trigger LLM types (trigger-llm).
 *
 * Types shared between the TriggerLlmAdapter, agent/request router, and
 * perception capture system.
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/types
 */

/**
 * Lite marker attached to user/message events by the perception capture
 * system. When the agent/request waterfall sees this marker, it swaps
 * the LLM config to mud-trigger → TriggerLlmAdapter.
 */
export interface LiteMarker {
  /** Always 'lite' — distinguishes from regular user messages. */
  kind: 'lite'
  /** The entry id that produced this message. */
  entryId: string
  /** The group id owning this entry. */
  groupId: string
  /** Captured text lines from the game output. */
  capturedText: string[]
  /** The command template to send (e.g. 'login {name} {pass}'). */
  actionTemplate: string
  /** Rendered command (after template substitution). */
  renderedCmd: string
  /**
   * Tool call(s) to execute after the deterministic acknowledgement.
   * The adapter emits these as tool-call blocks; the loop runs them through
   * the official tool pipeline.
   */
  toolCalls: Array<{
    name: string
    args: Record<string, unknown>
  }>
}