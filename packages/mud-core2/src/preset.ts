/**
 * preset 行插件 — 官方 preset 通道的承载面（P2 修订 v2 D6/D8）。
 *
 * 由 cordis.patch.yml 的 `preset-mud-player` 行 plugins 末行装载（产物
 * lib/preset.js，plain Node ESM）。与宿主 `@deepseek-ai/dsh-persona` 同层：
 *
 *   - 注册三工具（preset 作用域一次，根与子级同见，1.1-4 实测证实）；
 *   - 注册 `mud:persona` section（段名/段序沿用 persona.ts，与宿主
 *     deployment:persona-prefix/suffix 不冲突）；
 *   - **不在注册期依赖引擎**：引擎窄面（mudCore2）执行期 ctx.get 解析
 *     （可选服务）；引擎缺席时注册照常、执行给可读拒绝（v1 同款先例，
 *     mud-core/tests/preset-agent.spec.ts:205-213；I9——拒绝理由可读，
 *     不是必然失败的桩）；
 *   - 注册完整性自检在 registerMudTools 内（三工具缺一即 fail-loud）。
 *
 * 身份纠正（子级 persona 后自认主人）由官方 `subagent:delegation` 运行时
 * 上下文承担（宿主 child-agent.ts 同款），本行不做提示层纠正。
 * @module mud-core2-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

import { registerPersona } from './persona.ts'
import { registerMudTools, type ToolRegistrar } from './tools/tools.ts'

/** Cordis 插件名（Loader 行标识）。 */
export const name = 'mud-core2-preset'

/** 消费宿主服务：tools（三工具注册）、systemPrompt（persona section）。 */
export const inject = ['tools', 'systemPrompt']

/** preset 行 apply：注册三工具 + persona section（一次；作用域 = preset 代际）。 */
export function apply(ctx: Context): void {
  const registrar = ctx.tools as unknown as ToolRegistrar
  registerMudTools(registrar, {
    // 执行期解析引擎窄面（D8）：缺席返回 null ⇒ 工具执行给可读拒绝（I9）。
    core: () => ctx.get('mudCore2') ?? null,
  })
  registerPersona(ctx.systemPrompt)
}
