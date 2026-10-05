/**
 * host/preset — preset 行插件：流程工具承载（mud-workflow）。
 *
 * 由 cordis.patch.yml 的 `preset-mud-player` 行 plugins 装载（产物
 * lib/preset.js，plain Node ESM）。与 core3 preset 行同层：
 *
 *   - 注册五工具（run + 管理四工具；preset 作用域一次，根与子级同见）；
 *   - **注册期不依赖引擎**：mudWorkflow（本包引擎）与 mudCore3（引擎缝）
 *     执行期 ctx.get 解析（可选服务）；缺席时注册照常、执行给可读拒绝（I9）；
 *   - 注册完整性自检在 registerMudWorkflowTools 内（五工具缺一即 fail-loud）。
 *
 * preset 语义：工具只挂在 mud-player（选 standard preset 的账号没有 mud
 * 工具——preset 决定能力面，同 core3）。
 * @module mud-workflow-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

import {
  registerMudWorkflowTools,
  type MudToolDefinition, type MudWorkflowEngine, type ToolRegistrar,
} from './tools.ts'
import type { WorkflowIoSeam } from '../contract/index.ts'

/** 编译期一致性断言基元：`T` 不是 `true` 即编译错误。 */
type AssertTrue<T extends true> = T

/**
 * 宿主协议漂移断言（T17）：钉住两处曾真实漂移过、又被接线层 `as unknown` 吃掉的
 * 成员——`isConcurrencySafe` 必须是**谓词函数**（写 boolean 只因宿主 fail-closed
 * 恰好得到"独占"），`render` 必须返回**可变**数组（宿主 `ContentBlock[]`）。
 * 漂移在此 `tsc` 红；纯层保持零宿主 import，接线层是唯一允许认识宿主的地方。
 */
export type ConcurrencySafeIsPredicate = AssertTrue<
  MudToolDefinition['isConcurrencySafe'] extends ((args: unknown) => boolean) | undefined ? true : false
>
export type RenderReturnsMutableBlocks = AssertTrue<
  ReturnType<MudToolDefinition['output']['render']> extends { type: 'text'; text: string }[] ? true : false
>

/** Cordis 插件名（Loader 行标识）。 */
export const name = 'mud-workflow-preset'

/** 消费宿主服务：tools（五工具注册）。 */
export const inject = ['tools']

/** preset 行 apply：注册五工具（一次；作用域 = preset 代际）。 */
export function apply(ctx: Context): void {
  const registrar = ctx.tools as unknown as ToolRegistrar
  registerMudWorkflowTools(registrar, {
    // 执行期解析流程引擎窄面：缺席返回 null ⇒ 工具执行给可读拒绝（I9）。
    engine: () => (ctx.get('mudWorkflow') ?? null) as MudWorkflowEngine | null,
    // 执行期解析 core3 引擎缝（契约端口 WorkflowIoSeam）：缺席返回 null ⇒ run
    // 可读拒绝（管理工具不受影响）。
    core: () => (ctx.get('mudCore3') ?? null) as WorkflowIoSeam | null,
  })
}
