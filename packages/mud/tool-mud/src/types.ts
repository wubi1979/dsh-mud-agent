/** tool-mud — Remote 边界类型（非根子路径导出，T28.5 迁入（原引擎包职责））。
 *
 * 符号本体在 `mud/types`（引擎公共类型聚合）；这里只做转发，让 webui 等消费方
 * 统一从组合根（`tool-mud/types`）取型，不承载运行时代码。
 */
export * from 'mud/types'
