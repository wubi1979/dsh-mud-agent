/**
 * preset 行插件 — 工具面承载（§8.2，T2b）。
 *
 * 由 cordis.patch.yml 的 `preset-mud-player` 行 plugins 末行装载（产物
 * lib/preset.js，plain Node ESM）。与宿主 `@deepseek-ai/dsh-persona` 同层：
 *
 *   - 注册四工具（preset 作用域一次，根与子级同见）；
 *   - **不在注册期依赖引擎**：引擎窄面（mudCore3）执行期 ctx.get 解析
 *     （可选服务）；引擎缺席时注册照常、执行给可读拒绝（I9）；
 *   - 注册完整性自检在 registerMudTools 内（四工具缺一即 fail-loud）。
 *
 * preset 语义：工具只挂在 mud-player。选 standard preset 的账号没有 mud
 * 工具（preset 决定能力面）——agent 只能接消息嘴炮，这是用户选择，非缺陷。
 * @module mud-core3-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

import { registerMudTools, type MudCore3Handle, type MudToolDefinition, type ToolRegistrar } from './tools.ts'
import type { MudNavFace } from './nav/service.ts'

/** 编译期一致性断言基元：`T` 不是 `true` 即编译错误。 */
type AssertTrue<T extends true> = T

/**
 * 宿主协议漂移断言（T17）：钉住两处曾真实漂移过、又被接线层 `as unknown` 吃掉的
 * 成员——`isConcurrencySafe` 必须是**谓词函数**、`render` 必须返回**可变**数组
 * （宿主 `ContentBlock[]`）。漂移在此 `tsc` 红。
 */
export type ConcurrencySafeIsPredicate = AssertTrue<
  MudToolDefinition['isConcurrencySafe'] extends ((args: unknown) => boolean) | undefined ? true : false
>
export type RenderReturnsMutableBlocks = AssertTrue<
  ReturnType<MudToolDefinition['output']['render']> extends { type: 'text'; text: string }[] ? true : false
>

/** Cordis 插件名（Loader 行标识）。 */
export const name = 'mud-core3-preset'

/** 消费宿主服务：tools（四工具注册）。 */
export const inject = ['tools']

/** preset 行 apply：注册四工具（一次；作用域 = preset 代际）。 */
export function apply(ctx: Context): void {
  const registrar = ctx.tools as unknown as ToolRegistrar
  registerMudTools(registrar, {
    // 执行期解析引擎窄面：缺席返回 null ⇒ 工具执行给可读拒绝（I9）。
    core: () => (ctx.get('mudCore3') ?? null) as MudCore3Handle | null,
    // `mudNav`（T23.10b）：插件级单例（行走知识图）；缺席 ⇒ 不记录、不给建议。
    nav: () => (ctx.get('mudNav') ?? null) as MudNavFace | null,
  })
}
