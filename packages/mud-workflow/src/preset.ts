/**
 * mud-workflow preset 行入口（薄壳）。
 *
 * 宿主 overlay patch 按绝对路径加载本包产物 **lib/preset.js**（本文件），故入口
 * 固定在包根：只做转发，装配逻辑在 host/preset.ts。
 *
 * @module mud-workflow-preset
 */

export { apply, inject, name } from './host/preset.ts'
