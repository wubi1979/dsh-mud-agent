/**
 * dsh-mud-map — 熔断与围栏 (Fence).
 *
 * 触发条件: 候选集发散度 > 阈值 且 已走步数 > 最小步数。
 *
 * 熔断行为:
 *   1. 冻结当前区域为围栏区
 *   2. 原路返回至最近确认节点
 *   3. 生成修正日志
 *   4. 路径规划屏蔽围栏区
 *
 * 围栏解锁: 人工修正后重新纳入自动流程。
 *
 * @module @deepseek-ai/dsh-mud-map/fence
 */

import type { FenceRegion, CandidatePosition } from './types.ts'

/** 候选集发散阈值: 候选数超过此值视为发散. */
const FANOUT_THRESHOLD = 8
/** 最小探测步数: 低于此不熔断. */
const MIN_STEPS = 3

/**
 * 围栏管理器.
 *
 * 当前为骨架实现: 熔断判定与返回策略待实现。
 */
export class FenceManager {
  private readonly fences: FenceRegion[] = []

  /**
   * 判定是否应熔断当前候选集 (骨架返回 false).
   * @param candidates 当前候选集
   * @param stepCount 已走步数
   */
  shouldFence(candidates: Map<string, CandidatePosition>, stepCount: number): boolean {
    if (candidates.size > FANOUT_THRESHOLD && stepCount >= MIN_STEPS) return true
    return false
  }

  /** 触发熔断, 记录一个围栏区域 (骨架仅记录空区域). */
  triggerFence(subMapId: string, reason: string): FenceRegion {
    const fence: FenceRegion = {
      id: `fence:${subMapId}:${Date.now()}`,
      subMapId,
      nodeIds: [],
      reason,
      createdAt: Date.now(),
      unlocked: false,
    }
    this.fences.push(fence)
    return fence
  }

  /** 解锁一个围栏区域. */
  unlockFence(id: string): void {
    const fence = this.fences.find((f) => f.id === id)
    if (fence) fence.unlocked = true
  }

  /** 围栏列表. */
  allFences(): FenceRegion[] {
    return this.fences
  }
}
