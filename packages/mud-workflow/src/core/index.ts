/**
 * core — 内核层出口（A1）。
 *
 * 流程机制内核：解释器（执行语义）+ 注册表（分层、保存门、存储双态）。
 * 只依赖契约层，零 cordis、零宿主、零 I/O ⇒ 可脱离宿主复用（离线校验 /
 * 语料回放 / CLI / CI 静态检查）。作为子路径导出 `mud-workflow/core`。
 *
 * @module mud-workflow/core
 */

export { MAX_TRANSITIONS, PASS_MASK, runFlow } from './interpreter.ts'
export { WorkflowRegistry, type SaveInput } from './registry.ts'
