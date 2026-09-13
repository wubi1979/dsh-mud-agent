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
 * 无运行时 invariant: mud-core 在自身 fiber 内持有会话运行时表
 * (MudSessionRuntime: 每会话一个连接绑定、命令-应答桥与观察窗) 与会话无关的
 * 连接注册表 (MudConnectionManager), 二者均由 `ctx.effect` teardown 释放;
 * agent 生命周期归 dsh 官方 (本包只读 `ctx.agents.get` 投递, 不创建/不 dispose)。
 * UI 外壳消费提供的 `ctx.mud` 服务与 `/mud/ws` 推送帧。除提供的服务外, 本包
 * 不持有跨插件可变状态。
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
