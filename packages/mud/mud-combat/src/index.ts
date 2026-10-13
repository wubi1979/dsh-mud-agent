/**
 * mud-combat — 战斗特性 Provider（T28 拆包，整域迁入）：状态分档 · 规则引擎 ·
 * 危险判定 · 战报 · 监听窗控制器。依赖 mud-sense（tracker 正则/world 状态/read 类型）
 * 与 mud-link（MudLine type-only）；对 mud 引擎零依赖（D9 矩阵）。
 */
export * from './state.ts'
export * from './rules.ts'
export * from './danger.ts'
export * from './report.ts'
export * from './controller.ts'
