/**
 * nav/blocker — 行走阻断的**行为性**判定与档案（T23.11）。
 *
 * 实测口径（A.9 结论 12，用户定义）：
 *   - **软阻断**：`你因为种种原因停了下来，可以用walk继续进行。`（无参 `walk` 可继续）；
 *   - **硬阻断**：**walk 中突然停下、连续两次 `walk` 都无法继续前进**——**没有专有行文**，
 *     所以判定是行为性的：**同位置软阻断连击 ≥ {@link HARD_STOP_ATTEMPTS}**；
 *   - 处置沿 D19：**回给 agent 并停手**（不重试、不自动换路），把位置/次数/时间记档，
 *     "通过手段"逐步积累（字段留位，待实录）。
 *
 * 计数是**会话相关**的（"我在这个区域连着没走成"），由调用方落 World `nav.*`
 * （`kind:'nav'`；断线随 §10.4 复位）——本模块只做纯计算。
 *
 * @module mud-core3/nav/blocker
 */

/** 硬阻断阈值：**连续两次**（A.9 结论 12 的用户定义；无例证不进 Config）。 */
export const HARD_STOP_ATTEMPTS = 2

/** 上一轮阻断状态（缺省 = 无记录）。 */
export interface BlockerState {
  readonly attempts: number
  readonly at?: string | null
}

/** 本轮判定结果（调用方据此写 World 与回 agent）。 */
export interface BlockerVerdict {
  /** 连击计数（`soft-stop` 才累加）。 */
  readonly attempts: number
  /** 是否达到硬阻断。 */
  readonly hard: boolean
  /** 当前阻断位置（`null` = 无）。 */
  readonly at: string | null
}

/**
 * 依据本轮行走结果推进阻断状态。
 *   - `soft-stop`：同位置 ⇒ 计数 +1；换位置 ⇒ 从 1 起；达到阈值 ⇒ `hard`
 *   - `arrived` / `unaccepted`：**清零**（一个是成功、一个是走错地方，都不是阻断）
 *   - 其它（`incomplete` / `timeout` / `undefined`）：**保持原状**（不涨不清，避免误判）
 */
export function nextBlocker(
  prev: BlockerState | undefined,
  at: string | undefined,
  outcome: string | undefined,
): BlockerVerdict {
  const prevAttempts = prev?.attempts ?? 0
  const prevAt = prev?.at ?? null
  if (outcome === 'arrived' || outcome === 'unaccepted') {
    return { attempts: 0, hard: false, at: null }
  }
  if (outcome !== 'soft-stop') {
    return { attempts: prevAttempts, hard: prevAttempts >= HARD_STOP_ATTEMPTS, at: prevAt }
  }
  const same = prevAt !== null && at !== undefined && prevAt === at
  const attempts = (same ? prevAttempts : 0) + 1
  return { attempts, hard: attempts >= HARD_STOP_ATTEMPTS, at: at ?? null }
}
