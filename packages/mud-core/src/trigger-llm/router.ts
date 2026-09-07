/**
 * dsh-mud-core — Trigger LLM route / pending-action registry (trigger-llm).
 *
 * The router owns the state that bridges the lite marker on a user/message to
 * the deterministic adapter output:
 *
 *   perception (capture)  → agent.send(lite user/message, 'next-turn')
 *   → loop proposes step  → `agent/pre-step` listener reads the messages,
 *                           parses the lite marker, records a pending action
 *                           (keyed by the agent's session id)
 *   → `agent/request`     → swaps config to { provider:'mud-trigger',
 *                           model:'lite-router-v0' } for that step
 *   → TriggerLlmAdapter.stream() → consumes the pending action → emits
 *                           deterministic text + tool_call chunks
 *   → loop executes the tool via the official tool pipeline → tool/result
 *
 * All state flows through official waterfall seams (pre-step / request) and
 * the adapter's stream(); nothing bypasses the loop.
 *
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/router
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { TriggerLlmAdapter } from './adapter.ts'
import {
  describeMarker, parseLiteMarker, toLiteUserMessage, LITE_SENTINEL,
} from './marker.ts'
import type { LiteMarker } from './types.ts'
export type { LiteMarker }

/** Provider route the trigger adapter registers, and swap target. */
export const MUD_TRIGGER_PROVIDER = 'mud-trigger'
/** Model id for the deterministic lite router. */
export const LITE_ROUTER_MODEL = 'lite-router-v0'

/**
 * Trigger LLM router. Registers:
 *   - the `mud-trigger` provider with a TriggerLlmAdapter,
 *   - an `agent/pre-step` listener that recognizes lite user/messages,
 *   - an `agent/request` listener that routes lite steps to mud-trigger.
 *
 * The adapter only produces deterministic output when a lite marker is
 * pending for that session; all other steps route to the real LLM untouched.
 */
export class TriggerRouter {
  private readonly ctx: Context
  private readonly adapter: TriggerLlmAdapter
  /** Pending lite action per session id (single active action per session). */
  private readonly pending = new Map<string, LiteMarker>()
  private readonly disposePreStep: () => void
  private readonly disposeRequest: () => void

  constructor(ctx: Context) {
    this.ctx = ctx
    this.adapter = new TriggerLlmAdapter((sessionId) => {
      const sessionKey = typeof sessionId === 'string' ? sessionId : ''
      const marker = this.pending.get(sessionKey) ?? null
      if (marker) this.pending.delete(sessionKey) // consume exactly once
      return marker
    })

    // Register the deterministic provider with the harness LLM runtime.
    ctx.llm.registerAdapter([MUD_TRIGGER_PROVIDER], this.adapter)

    // pre-step: recognize a lite user message and stash the pending action so
    // the adapter can render it without branching on real LLM input.
    this.disposePreStep = ctx.on('agent/pre-step', async (
      { agent, messages },
      next,
    ): Promise<PreStepDecision> => {
      const marker = messages.map(parseLiteMarker).find((m): m is NonNullable<typeof m> => m !== null) ?? null
      if (marker) {
        const sessionKey = agent.session.id
        this.pending.set(sessionKey, marker)
        this.ctx.logger.info(`[触发] ${describeMarker(marker)}`)
      }
      return next()
    })

    // request: route a step whose session has a pending lite action to the
    // deterministic provider. The adapter consumes the pending action during
    // stream(); real-model steps are untouched.
    this.disposeRequest = ctx.on('agent/request', async (
      { agent },
      next,
    ): Promise<LlmCallConfig> => {
      const cfg = await next()
      if (this.pending.has(agent.session.id)) {
        return { ...cfg, provider: MUD_TRIGGER_PROVIDER, model: LITE_ROUTER_MODEL }
      }
      return cfg
    })
  }

  dispose(): void {
    this.disposePreStep()
    this.disposeRequest()
    this.pending.clear()
  }

  /**
   * Build a lite user/message carrying the given capture, to send via
   * agent.send(..., 'next-turn'). The marker travels in the message content
   * (official channel); pre-step parses it out.
   */
  makeLiteMessage(marker: LiteMarker): UserMessage {
    return toLiteUserMessage(marker)
  }
}

export { LITE_SENTINEL }