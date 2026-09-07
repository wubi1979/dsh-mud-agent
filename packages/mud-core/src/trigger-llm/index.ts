/**
 * dsh-mud-core — Trigger LLM module (trigger-llm).
 *
 * The deterministic half of the v5 architecture: a fake LLM provider
 * (`mud-trigger`) that turns a lite user/message into a short text +
 * tool_call, run entirely through the official agent loop.
 *
 * @module @deepseek-ai/dsh-mud-core/trigger-llm
 */

export { TriggerLlmAdapter } from './adapter.ts'
export { TriggerRouter, MUD_TRIGGER_PROVIDER, LITE_ROUTER_MODEL } from './router.ts'
export { LITE_SENTINEL, parseLiteMarker, toLiteUserMessage, describeMarker } from './marker.ts'
export type { LiteMarker } from './types.ts'