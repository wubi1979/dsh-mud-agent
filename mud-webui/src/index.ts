/**
 * dsh-mud-webui — host (Node) half.
 *
 * The MUD player engine runs in `@deepseek-ai/dsh-mud-core`; this package adds
 * only the browser WebUI shell (sidebar wizard, game/log conversation tabs,
 * and the decision/status details rail), all fed by the shared `/mud/ws` push
 * channel that mud-core exposes. The host half therefore registers nothing: the
 * browser half is discovered through this package's `dsh.client` declaration
 * and contributes the conversation.view entries, the sidebar shadow, and the
 * details rail. @module @deepseek-ai/dsh-mud-webui
 */

import type { Context } from '@deepseek-ai/cordis'

/** Required services (none — the host half is a discovery stub). */
export const inject: readonly string[] = []

/**
 * Host-facing apply: a no-op specifically because every MUD service this shell
 * reads (roster REST routes, /mud/ws, connection lifecycle, and the ctx.mud
 * engine) is provided by the mud-core plugin this shell accompanies.
 * @param ctx - Host root context (unused by the no-op host half).
 */
export function apply(_ctx: Context): void {
  // The webui shell is browser-side only; the host engine and its routes live
  // in @deepseek-ai/dsh-mud-core.
}
