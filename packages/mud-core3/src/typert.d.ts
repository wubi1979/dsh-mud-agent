/**
 * Typert 工件占位声明（生成前满足模块解析；gen:typert 分析期 checkDiagnostics 需要）。
 * lib/typert.host.* 生成后文件解析优先于本 ambient 声明，真实类型生效。
 * 保留本文件使 gen-typert 可在干净检出上复现。
 */
declare module 'mud-core3/typert' {
  export const TYPERT: unknown
}
