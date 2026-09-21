/**
 * dsh-mud-core — T1 流程槽 (flow slot), `doc/PLAN.md` §3.4 / W10.4 第 3 步。
 *
 * **一张会话作用域的表, 只放一件事：当前流程实例"处在哪一步、这一步要发什么"**。
 * 它是 T1 渲染下一步 tool-call 的**唯一数据源**（第 5 步起），也是 `callId ↔ 步骤` 的配对
 * 依据（D1：T1 组装时把 callId 写进 `pendingCallId`，工具结果按它配对）。
 *
 * 归属（D10 / I8）：槽表由**会话作用域**持有（`FlowRuntime` 每会话一个实例），
 * T1 adapter 自身保持无状态外壳, **只按 `sessionId` 查表**。会话释放即清槽。
 *
 * 发布纪律（DSH "publish state only at its commit point"）：**只在状态迁移完成时发布**
 * （进入步骤 / 成功 / 失败 / 收束 / 复位），不在中途零散写。
 * @module @deepseek-ai/dsh-mud-core/agent/flow/slot
 */

/** 流程实例的公开槽（`FlowRuntime` 在迁移点发布; T1 只读）。 */
export interface FlowSlot {
  /** 流程 id（如 `login`）。 */
  flowId: string
  /** 当前步骤 id（如 `pass`）。 */
  stepId: string
  /** 相位：等结果 / 等人工 / 等分支（`awaiting-branch` = 本步已成功、在等后继 driver）。 */
  phase: 'awaiting-result' | 'awaiting-human' | 'awaiting-branch'
  /**
   * **本步要发的 tool-call**（`awaiting-result` 时非空；等分支/等人工/空闲时缺省）。
   *
   * 含工具名与**未插值的**参数（`{name}`/`{pass}`/`{captcha}` 由工具在发送瞬间插值，D7.2），
   * 以及本步的收口三件（与 `windowSpecFor` **同一次派生**：关闭触发 / GA 计数 / 兜底时长）。
   */
  render?: {
    tool: string
    args: Record<string, unknown>
    /** 关闭触发（本步判据派生的 any-of 正则；命中即关窗, 不判类）。 */
    closeOn?: RegExp
    /** N-GA 关窗基数（仅本步显式声明 GA 判据时）。 */
    gaCount?: number
    /** 兜底时长（本步声明的步预算）。 */
    timeoutMs?: number
  }
  /** 已渲染但结果未回的 tool-call id（D1 配对用；null = 没有在途调用）。 */
  pendingCallId: string | null
  /** 已重试次数（本步）。 */
  retries: number
  /** 流程实例槽（`capture` 抽出的值 + 内建 `{lastFail}`）。 */
  captureSlots: Readonly<Record<string, string>>
}

/**
 * 会话作用域的槽表（每会话一个实例）。
 *
 * 表只有一格：一张会话里同一时刻至多一个活跃流程实例（I10 单流程互斥）。
 * 因此 `publish` 是**替换语义**（迁移点整格刷新），`clear()` 用于收束/复位/释放。
 */
export class FlowSlotTable {
  private current: FlowSlot | null = null

  /** 当前槽（空闲 = null）。 */
  get(): FlowSlot | null {
    return this.current
  }

  /** 发布新槽（整格替换；调用方保证在迁移点调用）。 */
  publish(slot: FlowSlot): void {
    this.current = slot
  }

  /** 清槽（收束 / 复位 / 断线 / 会话释放）。 */
  clear(): void {
    this.current = null
  }

  /** 写入在途调用 id（D1：T1 组装 tool-call 时登记；结果回来时清）。 */
  setPendingCallId(callId: string | null): void {
    if (this.current === null) return
    this.current = { ...this.current, pendingCallId: callId }
  }
}
