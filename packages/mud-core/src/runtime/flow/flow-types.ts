/**
 * dsh-mud-core — 流程类型 (runtime/flow/flow-types), `doc/ARCHITECTURE.md` §19。
 *
 * 从 `FlowRuntime` 抽出的**声明面**: 流程命中 / 结算种类 / 实例状态 / 打断协议 /
 * 构造参数。本模块无运行态, 供流程引擎与会话运行时共用。
 * @module @deepseek-ai/dsh-mud-core/runtime/flow/flow-types
 */

import type { WorldModel } from '../../shared/world.ts'
import type { FlowMatch, FlowSpec } from './flows.ts'

/** 流程发出的动作（交给运行时的投递层；字段与规则命中对齐）。 */
export interface FlowActionHit {
  /** `flow:<flowId>/<stepId>`。 */
  ruleId: string
  /** 渲染文本（T1 的 output 文本块；留痕/转录用）。 */
  output: string
  tool: { name: string; args: Record<string, unknown> }
  /** 触发本动作的行（原文；帧内到达时用于动作投递的文本）。 */
  text: string
  /** 触发行的 abs（非帧路径下与 consumeTo 对齐）。 */
  anchorAbs: number
  /** 本动作是否来自命令应答帧（帧行不进待决缓冲 → 需要动作投递）。 */
  framed: boolean
  /** 本动作是否等人工（`awaitExternal`）。 */
  awaitExternal?: readonly string[]
}

/** 桥结算结果（`CommandResponseController` 的结算种类）。 */
export type FlowSettleKind = 'ga' | 'eor' | 'until' | 'timeout' | 'abort' | 'interrupted' | 'error'

/** 一条已布防的判据。 */
export interface ArmedMatch {
  /** `entry` / `driver` / `ok` / `fail`。 */
  role: 'entry' | 'driver' | 'ok' | 'fail'
  match: FlowMatch
  /** `entry`: 目标流程 id；`driver`(条件分支): 目标步骤 id。 */
  target?: string
  /** 声明顺序（同类多命中取首）。 */
  order: number
  /** 唯一标签（匹配器规则 id；日志用）。 */
  label: string
}

/** 流程实例的对外状态（`diag()` 消费）。 */
export interface FlowState {
  flowId: string
  stepId: string
  armed: string[]
  phase: 'awaiting-result' | 'awaiting-human' | 'awaiting-branch'
  deadline: number
  pendingActions: number
  pendingEntry: number
  /** 已重试次数（本步；`attempts` 见流程表）。 */
  retries: number
  /** 流程实例槽（`capture` 抽出的值 + 内建 `{lastFail}`）。 */
  slots: Record<string, string>
}

/** 打断请求（由运行时在规则命中时提交）。 */
export interface InterruptRequest {
  ruleId: string
  /** 规则的打断档位（数字；越大越强）。 */
  interrupts: number
  text: string
  /** 规则声明的动作（无工具 = 只渲染文本）。 */
  action: { output: string; tool?: { name: string; args?: Record<string, unknown> } }
  anchorAbs: number
  framed: boolean
}

/** 打断结果。 */
export type InterruptOutcome =
  | { kind: 'none' }
  | { kind: 'interrupted'; onInterrupt: readonly string[] }
  | { kind: 'queued' }

/** 流程运行时构造参数。 */
export interface FlowRuntimeOptions {
  flows: readonly FlowSpec[]
  /** 读当前 world（`when` 前置条件）。 */
  world: () => WorldModel
  /** 留痕（会话日志）。 */
  log: (text: string) => void
  /** 决策栏记录。 */
  decision?: (record: {
    actor: 'flow' | 'rule'
    ruleId?: string
    eventType?: string
    flow?: string
    action: string
    result?: string
    text: string
  }) => void
  /** 落 world（`onEnter.patch`；由运行时接线到 applyPatch）。 */
  patch: (patch: Record<string, unknown>) => void
  /** 直发命令（`onEnter.direct` / `onSuccess`；actor system，不入桥）。 */
  direct: (cmd: string) => void
  /**
   * 清空外部占位符的值（可选）：重试时本步 `awaitExternal` 声明的槽必须作废，
   * 否则会把**上一轮的旧值**（如已失效的验证码）直接重发出去。
   */
  clearExternal?: (keys: readonly string[]) => void
  /** 流程失败/超时时唤醒 T2 一次（`failPolicy.notify='t2'`）。 */
  notifyFail: (context: string) => void
  /**
   * 日志脱敏（可选）：凡是**要写进日志的命令文本**都先过它 —— 凭据与人工回填的外部值
   * （密码、验证码）不得落日志。缺省原样输出（测试可控）。
   */
  mask?: (text: string) => string
  /**
   * §8.5 武装集同步（可选）：布防变化时回调当前全部**行判据**（regex/text; ga/func
   * 不在内）。宿主把它们登记为分帧器武装标记 —— 命中 → 帧立即提交 → 消费链运行 →
   * 唤醒/打断当场发生（§19 的 arming 集与分帧器标记表是同一张表）。
   */
  onArmSync?: (markers: readonly { id: string; pattern: RegExp }[]) => void
  /**
   * **流程实例状态变化**（进入某步 / 收束 / 失败 / 复位；可选）。
   *
   * 运行时接它去重评估看门狗：`dead-air` 的启动条件含"无活跃流程"，所以流程的
   * 起停就是看门狗的起停时点（活跃流程期间不布防；流程结束才布防）。
   */
  onTransition?: () => void
}