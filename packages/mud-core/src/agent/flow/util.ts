/**
 * dsh-mud-core — 流程纯辅助函数 (agent/flow/util)。
 *
 * 从 `flow.ts` 尾部拆出 (v0.9.3 W8, 纯文件级重组): 步骤进入判据提取、
 * 命令列表解析、占位符插值、文本预览 —— 均为**纯函数** (无 I/O、无运行时
 * 状态), 供 `engine.ts` 的 FlowRuntime 消费。
 * @module @deepseek-ai/dsh-mud-core/agent/flow/util
 */

import { isLineMatch, type FlowMatch, type FlowStep } from './flow-spec.ts'

/** 取一个步骤的"进入判据"（driver；判定节点用 ok/fail 里的行判据）；无 = 顺序步。 */
export function entryMatch(step: FlowStep): FlowMatch | null {
  if (step.driver !== undefined) return step.driver
  if (step.action === undefined) {
    const own = [...(step.ok ?? []), ...(step.fail ?? [])].find(isLineMatch)
    if (own !== undefined) return own
  }
  return null
}

/** 步骤声明的命令列表（`cmd` 单体 / `cmds` 序列）。 */
export function commandsOf(args: Record<string, unknown>): string[] {
  const single = typeof args.cmd === 'string' ? [args.cmd] : []
  const series = Array.isArray(args.cmds) ? args.cmds.filter((c): c is string => typeof c === 'string') : []
  return [...single, ...series]
}

/** 占位符插值（`{name}`/`{pass}`/`{captcha}` → 实际值；未提供的原样保留）。 */
export function interpolate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) => values[key] ?? whole)
}

/** 文本预览（日志用）。 */
export function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 40 ? `${one.slice(0, 40)}…` : one
}
