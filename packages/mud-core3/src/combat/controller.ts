/** T28.3 薄壳（A1 兼容期纪律）：实现迁入 packages/mud/mud-combat（src/controller.ts），本文件仅 re-export。
 * 迁移期 core3 深路径 import（'./combat/controller.ts'）经此转发，同一模块实例、无副本。T28.5 随 mud-core3 删除。 */
export * from 'mud-combat/controller'
