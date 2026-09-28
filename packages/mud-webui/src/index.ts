/**
 * dsh-mud-webui — host (Node) half.
 *
 * The MUD player engine runs in `mud-core3`; this package adds only the browser
 * WebUI shell (server/account wizard sidebar), driven by the `remote.mud` RPC
 * verbs through the generated `mud-core3/remote` artifact. The host half
 * therefore registers nothing: the browser half is discovered through this
 * package's `dsh.client` declaration and contributes the sidebar shadow.
 * @module @deepseek-ai/dsh-mud-webui
 */

import type { Context } from '@deepseek-ai/cordis'

/** Required services (none — the host half is a discovery stub). */
export const inject: readonly string[] = []

/**
 * Host-facing apply: a no-op specifically because every MUD service this shell
 * reads (server/account roster, credentials, connection lifecycle) is provided
 * by the `mud-core3` plugin's `remote.mud` namespace.
 * @param ctx - Host root context (unused by the no-op host half).
 */
export function apply(_ctx: Context): void {
  // The webui shell is browser-side only; the host engine and its remote verbs live in mud-core3.
}
