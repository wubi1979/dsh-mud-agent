/**
 * contract — 契约层出口（A1）。
 *
 * 流程领域的**单点契约**：词汇表 + 静态保存门 + IO/引擎缝端口 + 持久化域声明。
 * 依赖方向：引擎侧（core3）与机制侧（core/host）都依赖本层；本层不依赖任何
 * 一侧（零 cordis、零宿主、零 I/O）。作为子路径导出 `mud-workflow/contract`。
 *
 * @module mud-workflow/contract
 */

export * from './schema.ts'
export * from './ports.ts'
export * from './domain.ts'
