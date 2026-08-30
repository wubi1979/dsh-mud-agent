/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mud-webui`.
 * @module @deepseek-ai/dsh-mud-webui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mud-webui'

/** Cordis companion plugin name. */
export const name = 'mud-webui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the WebUI shell is a browser-only plugin. It owns the
 * roster/connection controller (MudStateController) and the /mud/ws socket
 * controller (MudSocketController) inside its own client apply fiber, disposed
 * by that fiber's teardown, and registers slots and conversation-view
 * definitions whose disposal is the slot/registry contract. The package holds
 * no cross-plugin mutable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
