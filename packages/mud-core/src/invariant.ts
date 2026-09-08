/**
 * `@deepseek-ai/dsh-mud-core` 的包级 invariant 伴生注册插件 (companion)。
 * @module @deepseek-ai/dsh-mud-core/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mud-core'

/** Cordis 伴生插件名。 */
export const name = 'mud-core-invariant'
/** 伴生插件保留包所有权前必需的服务。 */
export const inject = ['invariants']

/**
 * 无运行时 invariant: mud-core 在自身 fiber 内持有单个 agent handle 与单个
 * telnet 连接 (由 `ctx.effect` teardown 释放), 只发布会话日志事件, UI 外壳
 * 消费提供的 `ctx.mud` 服务与该等事件。除提供的服务外, 本包不持有跨插件
 * 可变状态。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant 伴生插件。
 * @param ctx - 携带 invariant 服务的 Cordis 上下文。
 * @returns 装配成功后返回的注册释放器。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
