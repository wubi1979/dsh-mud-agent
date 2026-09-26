/**
 * flows/types — 流程契约（impl §3.6）。
 *
 * 形态：`Flow = { id, description, run(ctx) }`，async 函数，`tsc` 即校验；
 * 加流程 = 加文件 + index 数组一行；对模型只暴露 `mud_flow({id})`。
 *
 * **三个出口**（流程只能从这三处结束，impl §3.6）：
 *   1. `{ done: true }` —— 完成；
 *   2. `{ done: false, question, lines }` —— 带问题结束：必须**重放无害**才
 *      允许此出口（fullme 收图重放无害；含不可逆副作用的流程不得走此出口）；
 *   3. `{ reason: 'danger' }` —— 危险中断（§3.3 abortWait 同源，read 以
 *      reason:'danger' 收束时原样上抛）。
 *
 * 其余终态（timeout / failOn / disconnected / signal）**不是出口**：流程直接
 * 抛错，工具层转错误结果（失败不结束回合，模型继续决策）。
 *
 * FlowCtx **没有 ask**（等人只在根会话，子 agent 侧被 DELEGATED_CALLER 禁死）。
 * 纯度纪律：不 import 宿主。
 */

import type { MudLine } from '../../link/ansi.ts'
import type { Holder, Mud } from '../../link/mud.ts'

/** 会话凭据（明文最小暴露面）：只在发送瞬间插值/使用，不进任何模型上下文。 */
export interface FlowCreds {
  name: string
  pass: string
}

/** 流程执行上下文。 */
export interface FlowCtx {
  mud: Mud
  creds: FlowCreds
  /**
   * 行流持有者（'root' | `child:<id>`）——read 竞速机 fail-loud 必需。
   * impl §3.6 基型 `{ mud, creds, answer?, signal }` 之外的必要补充：持有者
   * 身份由调用工具（mud_flow）按注册会话传入，流程自身不感知会话拓扑。
   */
  holder: Holder
  /**
   * 单步兜底超时毫秒（Config → deps.defaultTimeoutMs 注入，§3.5"必须显式
   * 给出或由工具注入缺省"；具体取值待 §6 校准）——流程内各步 read 的
   * timeoutMs 必须取本字段，不设模块常量。
   */
  defaultTimeoutMs: number
  /** 根侧重入时带的决策/人给的值（fullme 验证码等；login 不消费）。 */
  answer?: string
  /** 中止信号（工具侧 exec.signal 转发）。 */
  signal?: AbortSignal
}

/** 流程结果（三出口，见头部）。 */
export type FlowResult =
  | { done: true }
  | { done: false; question: string; lines: MudLine[] }
  | { reason: 'danger' }

/** 标准流程。 */
export interface Flow {
  id: string
  /** 一句说明（进工具拒绝/诊断文本，不进模型上下文）。 */
  description: string
  run(ctx: FlowCtx): Promise<FlowResult>
}

/** 流程异常终态（timeout/failOn/disconnected/signal）：抛给工具层转错误结果。 */
export class FlowError extends Error {}
