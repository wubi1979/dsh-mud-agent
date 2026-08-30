/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mud-core`.
 * @module @deepseek-ai/dsh-mud-core/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mud-core'

/** Cordis companion plugin name. */
export const name = 'mud-core-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the MUD core owns one agent handle and one telnet
 * connection inside its own fiber (disposed by its `ctx.effect` teardown),
 * emits only session-log events, and UI shells consume the provided
 * `ctx.mud` service plus those events. The package holds no cross-plugin
 * mutable state beyond the service it provides.
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
