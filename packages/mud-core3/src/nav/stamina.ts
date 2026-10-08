/**
 * nav/stamina — 行走精力闸（T23.10，D16）：游戏里"精力不足以行动"会拒命令，
 * 且频繁动用有惩罚，故**行走前先看精力占比**（`vitals.精力 / 最大精力`）。
 *
 * 口径（A.9 结论 7 + 用户裁定 2026-10-08）：
 *   - 判据是**百分比**，不是绝对值；`精力` 可为 `最大精力` 的 **200%**（A.7.1 结论 4），
 *     所以占比可能 > 1，闸门只看下界；
 *   - 阈值 = 用户裁定 **20%**，与 T21 战斗规则（收加力）**共用同一个 Config 键**
 *     `staminaFloorPct`（§15 配置表）；
 *   - **未知即放行**：`vitals` 还没写入（未发过 `hpbrief`/`hp`）时不能因为"不知道"而卡死
 *     导航——放行并把可用性交回调用方（工具面不额外标注）。
 *
 * 纯层，零宿主依赖。
 *
 * @module mud-core3/nav/stamina
 */

/** 精力闸缺省阈值（20%，用户裁定；Config 键 `staminaFloorPct` 可覆盖）。 */
export const DEFAULT_STAMINA_FLOOR_PCT = 0.2

/** 精力读取键（tacker 写入 `vitals` 分区，§10.3）。 */
export const STAMINA_ZONE = 'vitals'
export const STAMINA_CUR_KEY = '精力'
export const STAMINA_MAX_KEY = '最大精力'

/**
 * 精力占比（`cur / max`）。
 * 未知或非法（非有限数、`max <= 0`）⇒ `null`——"不知道"与"不足"是两件事。
 */
export function staminaRatio(cur: unknown, max: unknown): number | null {
  if (typeof cur !== 'number' || typeof max !== 'number') return null
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null
  return cur / max
}

/**
 * 是否低于闸门：`true` 低于、`false` 不低于、`null` 未知（调用方按"放行"处理）。
 * 缺省阈值 = {@link DEFAULT_STAMINA_FLOOR_PCT}。
 */
export function belowStaminaFloor(
  cur: unknown,
  max: unknown,
  floor: number = DEFAULT_STAMINA_FLOOR_PCT,
): boolean | null {
  const ratio = staminaRatio(cur, max)
  return ratio === null ? null : ratio < floor
}
