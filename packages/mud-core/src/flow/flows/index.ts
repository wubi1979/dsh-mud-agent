/**
 * dsh-mud-core — 流程表默认配置汇总 (flows/index)。设计见 `doc/ARCHITECTURE.md` §19。
 *
 * 目录分工（与 `doc/flows/{login,fullme}.md` 对齐；契约/数据/引擎三处分开）：
 *   - `../flow-spec.ts`：契约 —— 声明面类型 + 判据工具 + 注册期校验（**不含任何具体流程**）；
 *   - 本目录：**纯声明数据** —— `login.ts`/`fullme.ts` 各写各的流程表，驱动句 / ok / fail
 *     **只写这里一份**，不在 trigger 里重复；流程状态（arming 集、挂起、打断、排队）
 *     是运行时状态，归 `../flow.ts` 引擎持有；
 *   - `../flow.ts`：引擎 —— FlowRuntime，依赖契约不依赖本目录数据。
 * @module @deepseek-ai/dsh-mud-core/flow/flows
 */

import type { FlowSpec } from '../flow-spec.ts'
import { LOGIN_FLOW } from './login.ts'
import { FULLME_FLOW } from './fullme.ts'

/** 默认流程表（装配期注册进运行时；只读声明）。 */
export const defaultFlows: readonly FlowSpec[] = [LOGIN_FLOW, FULLME_FLOW]

/**
 * 流程声明的全部命令（权限判据用：流程命令属系统流程，不受档位可见性约束）。
 * @param flows 流程表。
 * @returns 命令字符串列表（含占位符原样，如 `fullme {captcha}`）。
 */
export function flowCommands(flows: readonly FlowSpec[]): string[] {
  const out = new Set<string>()
  for (const flow of flows) {
    for (const step of flow.steps) {
      const args = step.action?.args
      if (typeof args?.cmd === 'string') out.add(args.cmd)
      if (Array.isArray(args?.cmds)) {
        for (const cmd of args.cmds) if (typeof cmd === 'string') out.add(cmd)
      }
      for (const cmd of step.onEnter?.direct ?? []) out.add(cmd)
    }
    for (const cmd of flow.onSuccess?.direct ?? []) out.add(cmd)
    for (const cmd of flow.onSuccess?.commands ?? []) out.add(cmd)
  }
  return [...out]
}

// ── re-export（保持 `flow/flows` 单一数据入口；契约本体在 `../flow-spec.ts`） ──

export {
  PRIORITY_NORMAL,
  isLineMatch,
  matchLabel,
  matchKey,
  validateFlows,
  type FlowAction,
  type FlowEnter,
  type FlowMatch,
  type FlowSpec,
  type FlowStep,
} from '../flow-spec.ts'
export { LOGIN_FLOW } from './login.ts'
export { FULLME_FLOW } from './fullme.ts'
export {
  FULLME_COOLDOWN_PATTERN,
  FULLME_OK_TEXT,
  FULLME_REMINDER_TEXT,
  FULLME_STALE_TEXT,
  FULLME_URL_CAPTURE,
  FULLME_URL_PATTERN,
  FULLME_WRONG_TEXT,
} from './fullme.ts'

export default defaultFlows
