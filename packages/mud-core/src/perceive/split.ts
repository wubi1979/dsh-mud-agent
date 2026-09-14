/**
 * dsh-mud-core — 单流切分 (L2), host half. 纯函数, 无状态。
 *
 * `doc/ARCHITECTURE.md` §5: 同一批待决行按**消费边界**切成两段 ——
 *   - 原文段 (**原文投递** 的消息体, 标识符沿用 `reflex`): 已被确定性规则消费的行 (`abs <= consumeTo`) → 投给 T1;
 *   - 遗留段 (carry): 消费边界之后的行 → 留到下一次投递 (可与下一块合并成一条消息)。
 *
 * 不变量 (I5): 一次投递只取走它该取走的那部分, 且两段之并 = 原序列、顺序不变。
 * 因此"把历次投递的消息体按序拼接"必然等于完整入站行流 (可测)。
 * @module @deepseek-ai/dsh-mud-core/perceive/split
 */

import type { MudLine } from '../services/network/ansi.ts'

/** 一次切分的结果。 */
export interface DeliverySplit {
  /** 已消费段 (投给 T1 的原文投递消息体)。 */
  reflex: MudLine[]
  /** 未消费段 (遗留到下一次投递)。 */
  carry: MudLine[]
}

/**
 * 按消费边界切分待决行。
 * @param pending 待决行 (按 abs 升序; 含上一次遗留段)。
 * @param consumeTo 消费边界 (最后一次带动作命中的锚点 abs; -1 = 无命中)。
 * @returns 原文段与遗留段 (两段之并 = pending, 顺序不变)。
 */
export function splitDelivery(pending: readonly MudLine[], consumeTo: number): DeliverySplit {
  const reflex: MudLine[] = []
  const carry: MudLine[] = []
  for (const line of pending) {
    (line.abs <= consumeTo ? reflex : carry).push(line)
  }
  return { reflex, carry }
}
