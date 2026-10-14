/**
 * nav/blocker — 行走**阻塞**的**行为性**判定（T23.11；用户口径 2026-10-14）。
 *
 * 口径（取消软/硬阻断说法，只有**阻塞**）：
 *   - **阻塞**：`你因为种种原因停了下来，可以用walk继续进行。`——理论上再发
 *     `walk` 可继续；
 *   - **阻断**：**连续失败没有推进**——同位置阻塞连击 ≥ {@link BLOCK_MANUAL_ATTEMPTS}
 *     ⇒ 记录为阻断，**需要人工干预**（回给 agent 停手，不重试、不自动换路）。
 *
 * 计数是**会话相关**的（"我在这个位置连着没走成"），由调用方落 World `nav.*`
 * （`kind:'nav'`；断线随 §10.4 复位）——本模块只做纯计算。
 *
 * @module mud-nav/blocker
 */

/** 阻断阈值：**连续两次**（用户定义"连续失败没有推进"；无例证不进 Config）。 */
export const BLOCK_MANUAL_ATTEMPTS = 2

/** 上一轮阻塞状态（缺省 = 无记录）。 */
export interface BlockerState {
  readonly attempts: number
  readonly at?: string | null
}

/** 本轮判定结果（调用方据此写 World 与回 agent）。 */
export interface BlockerVerdict {
  /** 连击计数（`blocked` 才累加）。 */
  readonly attempts: number
  /** 是否达到阻断（连击 ≥ 阈值 ⇒ 需要人工干预）。 */
  readonly blocked: boolean
  /** 当前阻塞位置（`null` = 无）。 */
  readonly at: string | null
}

/**
 * 依据本轮行走结果推进阻塞状态。
 *   - `blocked`：同位置 ⇒ 计数 +1；换位置 ⇒ 从 1 起；达到阈值 ⇒ `blocked`
 *   - `arrived` / `unaccepted`：**清零**（一个是推进、一个是没出发，都不算失败）
 *   - 其它（`incomplete` / `atNode` / `undefined`）：**保持原状**（不涨不清，避免误判）
 */
export function nextBlocker(
  prev: BlockerState | undefined,
  at: string | undefined,
  outcome: string | undefined,
): BlockerVerdict {
  const prevAttempts = prev?.attempts ?? 0
  const prevAt = prev?.at ?? null
  if (outcome === 'arrived' || outcome === 'unaccepted') {
    return { attempts: 0, blocked: false, at: null }
  }
  if (outcome !== 'blocked') {
    return { attempts: prevAttempts, blocked: prevAttempts >= BLOCK_MANUAL_ATTEMPTS, at: prevAt }
  }
  const same = prevAt !== null && at !== undefined && prevAt === at
  const attempts = (same ? prevAttempts : 0) + 1
  return { attempts, blocked: attempts >= BLOCK_MANUAL_ATTEMPTS, at: at ?? null }
}
