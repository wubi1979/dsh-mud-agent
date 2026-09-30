/**
 * preset 行插件 — 官方 preset 通道的工具承载面（doc/PLAN.md「二期详细设计 §1」）。
 *
 * 由 cordis.patch.yml 的 `preset-mud-player` 行 plugins 追加行装载（产物
 * lib/preset.js，plain Node ESM）。与宿主 `@deepseek-ai/dsh-persona` 同层：
 *
 *   - 注册二工具 mud_send / mud_state（preset 作用域一次，mud-player 能力面；
 *     standard 账号无 mud 工具——preset 决定能力面，非缺陷）；
 *   - **不在注册期依赖引擎**：引擎窄面（mudCore3）执行期 ctx.get 解析（可选
 *     服务）；引擎缺席时注册照常、执行给可读拒绝（I9 先例——拒绝理由可读，
 *     不是必然失败的桩）；
 *   - 注册完整性自检在 registerMudTools 内（二工具缺一即 fail-loud）。
 *
 * persona 不在本行（cordis.patch.yml 的 dsh-persona 插件行承担）。
 * @module mud-core3-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

import { registerMudTools, type ToolRegistrar } from './tools.ts'

/** Cordis 插件名（Loader 行标识）。 */
export const name = 'mud-core3-preset'

/** 消费宿主服务：tools（二工具注册）。 */
export const inject = ['tools']

/** preset 行 apply：注册二工具（一次；作用域 = preset 代际）。 */
export function apply(ctx: Context): void {
  const registrar = ctx.tools as unknown as ToolRegistrar
  registerMudTools(registrar, {
    // 执行期解析引擎窄面：缺席返回 null ⇒ 工具执行给可读拒绝（I9）。
    // preset 作用域沿父链可见全局层 provide（core2 已验证模式）。
    core: () => ctx.get('mudCore3') ?? null,
  })
}
