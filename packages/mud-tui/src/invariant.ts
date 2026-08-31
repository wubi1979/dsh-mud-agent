/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mud-tui`.
 * @module @deepseek-ai/dsh-mud-tui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mud-tui'

/** Cordis companion plugin name. */
export const name = 'mud-tui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the TUI owns one alternate-screen renderer inside its
 * plugin fiber (disposed by its `ctx.effect` teardown), consumes only the
 * provided `ctx.mud` service and session-log events, and registers no loader
 * rows or cross-plugin mutable state.
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
