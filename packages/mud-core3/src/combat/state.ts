/**
 * mud-core3 combat/state — 战斗分档与边沿（T21.1）：纯计算，零依赖、零副作用。
 *
 * 职责（PLAN T21 第 3.2 节，D1/D2）：
 *   1. 比值：气血比（当前/生效上限）、容量比（生效上限/基准上限）、内力比（当前/最大，
 *      上限 200%，A.7 结论 4）——百分比由本模块算，不往 World 塞派生键（§10.3）；
 *   2. 分档：一律按百分比（伤情描述语只是描述、不作阈值依据，A.8.4 用户裁定），
 *      阈值 = 种子规则边界（PLAN T21 3.3：50% / 25% / 70% / 50% / 100%）；
 *   3. 边沿检测：状态写入 → 重算档位 → 与上一档快照比较，**只有跨变才产出边沿**
 *      （战斗由「状态出现」驱动，不是每拍决策）。快照基线 = 常态档（健康/完整/充沛/
 *      未满）——首拍即重伤（如中途入战）也产出边沿，危险抢占不漏首击。
 *
 * 数据源 = tracker 写入的 `vitals.*` / `combat.气势`（hpbrief 与气势行，A.8.3）。
 * 缺数据的维返回 null（不猜）；`combat.敌档`/`敌人数` 原样透传（阶梯待实录，不档位化）。
 *
 * @module mud-core3/combat/state
 */

/** 战斗状态输入（World 的 vitals/combat 相关键快照；缺省 = 该维不可测）。 */
export interface CombatVitals {
  readonly 气血?: number
  readonly 最大气血?: number
  readonly 气血上限?: number
  readonly 内力?: number
  readonly 最大内力?: number
  readonly 气势?: number
}

/** 分母缺失或 0 → null（不猜）。 */
function ratio(num: number | undefined, den: number | undefined): number | null {
  if (num === undefined || den === undefined || den === 0) return null
  return num / den
}

/** 气血比 = 气血 / 最大气血（缓冲：低了立刻危险，A.8.2 结论 5）。 */
export function bufferRatio(v: CombatVitals): number | null {
  return ratio(v.气血, v.最大气血)
}

/** 容量比 = 最大气血 / 气血上限（容量：低了持续作战能力差，必须提前撤，A.8.2 结论 5）。 */
export function capRatio(v: CombatVitals): number | null {
  return ratio(v.最大气血, v.气血上限)
}

/** 内力比 = 内力 / 最大内力（上限 200%，A.7 结论 4）。 */
export function forceRatio(v: CombatVitals): number | null {
  return ratio(v.内力, v.最大内力)
}

// ── 分档（阈值 = 种子规则边界，PLAN T21 3.3）────────────────────────

/** 缓冲档（气血比）：危险规则集触发于 <25%（撤离）/ <50%（运气回血）。 */
export type BufferTier = '健康' | '五成' | '危险' | '濒危'
/** 容量档（容量比）：<70% 吃药（恢复上限）、<50% 属危险档（撤离前提之一）。 */
export type CapTier = '完整' | '受损' | '需服药'
/** 内力档（内力比）：≥100% 加力、<50% 回退（种子规则 4/5）。 */
export type ForceTier = '充沛' | '够用' | '不足'
/** 气势档：≥100% 已满（绝招时机；满值刻度〔推断〕待实录，A.8.5）。 */
export type MomentumTier = '未满' | '已满'

/** 全维档位（null = 该维缺数据，不参与边沿）。 */
export interface CombatTiers {
  readonly buffer: BufferTier | null
  readonly cap: CapTier | null
  readonly force: ForceTier | null
  readonly momentum: MomentumTier
}

export function bufferTier(r: number | null): BufferTier | null {
  if (r === null) return null
  if (r <= 0) return '濒危' // 气血 <= 0 不是死亡判据（实测 -1 仍继续，A.8.4）
  if (r < 0.25) return '危险'
  if (r < 0.5) return '五成'
  return '健康'
}

export function capTier(r: number | null): CapTier | null {
  if (r === null) return null
  if (r < 0.5) return '需服药'
  if (r < 0.7) return '受损'
  return '完整'
}

export function forceTier(r: number | null): ForceTier | null {
  if (r === null) return null
  if (r < 0.5) return '不足'
  if (r < 1) return '够用'
  return '充沛'
}

export function momentumTier(气势: number | undefined): MomentumTier {
  return 气势 !== undefined && 气势 >= 100 ? '已满' : '未满'
}

/** 比值 + 分档一次算全（每条状态行调用一次）。 */
export function computeTiers(v: CombatVitals): CombatTiers {
  return {
    buffer: bufferTier(bufferRatio(v)),
    cap: capTier(capRatio(v)),
    force: forceTier(forceRatio(v)),
    momentum: momentumTier(v.气势),
  }
}

// ── 边沿检测（D1：跨变才匹配规则）──────────────────────────────────

export type TierKey = 'buffer' | 'cap' | 'force' | 'momentum'
export type AnyTier = BufferTier | CapTier | ForceTier | MomentumTier

/** 一次跨变：key 维从 from 档跨到 to 档。 */
export interface CombatEdge {
  readonly key: TierKey
  readonly from: AnyTier
  readonly to: AnyTier
}

/** 常态档基线（战斗外的通常状态；首拍即异常也据此产出边沿）。 */
const DEFAULT_TIERS: Record<TierKey, AnyTier> = { buffer: '健康', cap: '完整', force: '充沛', momentum: '未满' }

/**
 * 上一档快照 + 边沿检测。update() 逐维比较：
 *   - 该维 null（缺数据）→ 跳过，不产出边沿、基线不动；
 *   - 与基线同档 → 无边沿（未跨档不发，W1）；
 *   - 跨变 → 产出一条边沿并推进基线。reset()（脱战/断线）回常态基线。
 */
export class CombatEdgeDetector {
  private last: Record<TierKey, AnyTier> = DEFAULT_TIERS

  update(next: CombatTiers): CombatEdge[] {
    const edges: CombatEdge[] = []
    const merged: Record<TierKey, AnyTier> = { ...this.last }
    for (const k of ['buffer', 'cap', 'force', 'momentum'] as const) {
      const to = next[k]
      if (to === null) continue
      const from = this.last[k]
      if (to !== from) edges.push({ key: k, from, to })
      merged[k] = to
    }
    this.last = merged
    return edges
  }

  /** 脱战/断线复位：回常态基线。 */
  reset(): void {
    this.last = DEFAULT_TIERS
  }
}
