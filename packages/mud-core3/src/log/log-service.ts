/** T28.4 薄壳（A1 兼容期纪律）：实现迁入 packages/mud/mud（src/log.ts，log/log-service 扁平化），本文件仅 re-export。
 * 迁移期 core3 深路径 import（'./log/log-service.ts'）经此转发，同一模块实例、无副本。T28.5 随 mud-core3 删除。 */
export * from 'mud/log'
