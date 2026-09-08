/**
 * dsh-mud-core — 预处理层薄入口 (preprocess), host half.
 *
 * 单路径装配的文本入口:
 *   - ansi.ts 全量符号 (流式 ANSI 解析 / 剥离 / 提示符启发);
 *   - textOfLines: 解析行集 → 提交给 agent 的整批文本 (纯文本视图, 保留行序与空行)。
 *
 * v6: 感知缓冲/协调器已移除。每批完整逻辑行直接在此装配为整批文本, 由宿主
 * 提交 agent —— agent 内部级联 provider (mud-cascade) 完成触发匹配 (T1)
 * 与真实 LLM 转发 (T2)。
 * @module @deepseek-ai/dsh-mud-core/preprocess
 */

export * from './ansi.ts'
import type { ParsedLine } from './ansi.ts'

/** 解析行集 → 整批文本 (agent 提交面; 无 ANSI, 保留空行与顺序)。 */
export function textOfLines(lines: readonly ParsedLine[]): string {
  return lines.map(l => l.text).join('\n')
}