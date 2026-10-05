/**
 * mud-workflow — 宿主加载入口（薄壳）。
 *
 * 宿主 overlay patch 按绝对路径加载本包产物 **lib/index.js**（本文件），故入口
 * 文件固定在包根：这里只做转发，不放逻辑。
 *
 * A1 分层（详见各层出口）：
 *   - `mud-workflow/contract`：契约层（词汇表 + 保存门 + IO/缝端口 + 域声明）；
 *   - `mud-workflow/core`：内核层（解释器 + 注册表；零 cordis、零宿主、零 I/O）；
 *   - `./host/*`：宿主适配层（插件装配 + preset 行 + 工具面）。
 *
 * 根出口保留历史消费者的引用面（core3 与测试按顶层 `mud-workflow` 引用契约
 * 类型/解释器）；新代码应显式按子路径引用，让依赖层次一目了然。
 *
 * @module mud-workflow
 */

// 宿主插件面（cordis plugin：name / inject / apply）。
export { apply, inject, name } from './host/plugin.ts'
export type { MudWorkflowConfig, MudWorkflowService } from './host/plugin.ts'

// 契约层出口（词汇表类型 + 端口 + 域声明 + 保存门）。
export * from './contract/index.ts'
// 内核层出口（解释器 + 注册表）。
export * from './core/index.ts'
