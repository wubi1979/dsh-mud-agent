/**
 * dsh-mud-map — 定位模块 (Localizer): 多假设追踪 (MHT).
 *
 * 维护候选位置集合, 持续收敛至唯一解。移动后对每个候选取对应方向的邻居,
 * 形成新候选集, 再逐级剪枝。
 *
 * 剪枝机制 (按成本递增):
 *   1. GMCP.short 匹配      每次移动      零成本 (房间名 + 出口集)
 *   2. 出口集匹配           GMCP.dir 比对  低成本
 *   3. 二级路径签名          候选集 > 1     中成本 (图内预计算)
 *   4. 语义指纹匹配          候选集仍 > 1   高成本 (需 look, 由调用方触发)
 *   5. 先验坐标约束          全部失败       软约束降权
 *
 * 收敛判定: 候选集大小 === 1, 或唯一候选置信度 > 阈值。
 *
 * 本层不依赖事件总线, 由调用方喂入移动输出与房间出口。
 *
 * @module @deepseek-ai/dsh-mud-map/localizer
 */

import type { MHTState, CandidatePosition } from './types.ts'

/** 收敛置信度阈值. */
const RESOLVE_CONFIDENCE = 0.9

/** 出口集比对接口 (比对函数由调用方注入, 解耦几何层). */
export interface ExitResolver {
  /** 给定节点 ID, 返回其已知出口方向集合 (数组). 未知节点返回 undefined. */
  exitsOf(nodeId: string): string[] | undefined
  /** 给定节点 ID, 返回其已知邻居方向→目标ID 映射 (用于移动推进). */
  neighborOf(nodeId: string, dir: string): string | undefined
  /** 可选: 给定节点 ID, 返回其房间短名 (GMCP.short 语义); 未知返回 undefined.
   *  提供后启用第 1 级 GMCP.short 名字匹配. */
  nameOf?(nodeId: string): string | undefined
}

/**
 * MHT 定位器.
 */
export class Localizer {
  private readonly state: MHTState = {
    candidates: new Map(),
    resolved: false,
    lastResolved: null,
  }
  private readonly resolver: ExitResolver

  constructor(resolver: ExitResolver) {
    this.resolver = resolver
  }

  /** 初始化候选集 (如登录后经人工确认当前位置). */
  init(subMapId: string, nodeId: string): void {
    this.state.candidates.clear()
    this.setCandidate(subMapId, nodeId, 1.0, [])
    this.recomputeResolved()
  }

  /**
   * 移动成功后推进一步候选集, 并用 GMCP 房间名/出口集剪枝.
   * @param dir 本次移动方向
   * @param gmcpName GMCP 返回的新房间短名
   * @param gmcpExits GMCP 返回的新房间出口方向列表
   */
  onMove(dir: string, gmcpName: string, gmcpExits: string[]): void {
    if (this.state.candidates.size === 1 && this.state.resolved) {
      // 已收敛: 直接推进唯一候选.
      const only = this.state.candidates.values().next().value as CandidatePosition | undefined
      if (!only) return
      const next = this.advance(only, dir)
      if (next) {
        next.path.push(dir)
        next.confidence = this.score(next, gmcpName, gmcpExits)
        this.state.candidates.clear()
        this.setCandidate(next.subMapId, next.nodeId, next.confidence, next.path)
      }
      this.recomputeResolved()
      return
    }
    // 多候选: 逐候选推进 + 用 GMCP 信息剪枝.
    const nextCandidates = new Map<string, CandidatePosition>()
    for (const cand of this.state.candidates.values()) {
      const advanced = this.advance(cand, dir)
      if (!advanced) continue
      // 第 1 级: GMCP.short 名字硬剪枝 (节点名已知且与新房间短名明确不符则淘汰).
      const advName = this.resolver.nameOf?.(advanced.nodeId)
      if (advName && gmcpName && advName.trim() !== gmcpName.trim()) continue
      // 房间名 / 出口集硬剪枝: GMCP 信息不符则淘汰.
      if (this.resolver.exitsOf(advanced.nodeId) !== undefined) {
        const known = this.resolver.exitsOf(advanced.nodeId)!
        if (!sameSet(known, gmcpExits)) continue
      }
      advanced.confidence = this.score(advanced, gmcpName, gmcpExits)
      nextCandidates.set(this.key(advanced.subMapId, advanced.nodeId), advanced)
    }
    this.state.candidates = nextCandidates
    this.recomputeResolved()
  }

  /** 当前定位状态快照. */
  position(): {
    resolved: boolean
    subMap: string | null
    nodeId: string | null
    candidates: number
  } {
    const r = this.state.lastResolved
    return {
      resolved: this.state.resolved,
      subMap: r?.subMapId ?? null,
      nodeId: r?.nodeId ?? null,
      candidates: this.state.candidates.size,
    }
  }

  /** 候选集条目 (供 UI/调试). */
  candidates(): CandidatePosition[] {
    return [...this.state.candidates.values()]
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 沿方向推进单个候选 (沿已知边; 无对应出口则失败). */
  private advance(cand: CandidatePosition, dir: string): CandidatePosition | null {
    const nextId = this.resolver.neighborOf(cand.nodeId, dir)
    if (nextId === undefined) return null
    return { subMapId: cand.subMapId, nodeId: nextId, confidence: cand.confidence, path: [...cand.path] }
  }

  /** 计算候选与 GMCP 观测的匹配分 (0~1). */
  private score(cand: CandidatePosition, gmcpName: string, gmcpExits: string[]): number {
    let score = cand.confidence * 0.8
    const known = this.resolver.exitsOf(cand.nodeId)
    if (known && sameSet(known, gmcpExits)) score += 0.2
    // 第 1 级 GMCP.short 名字信号: 名一致加分, 名冲突降权.
    const name = this.resolver.nameOf?.(cand.nodeId)
    if (name && gmcpName) {
      if (name.trim() === gmcpName.trim()) score += 0.2
      else score -= 0.3
    }
    return clamp01(score)
  }

  private setCandidate(subMapId: string, nodeId: string, confidence: number, path: string[]): void {
    this.state.candidates.set(this.key(subMapId, nodeId), { subMapId, nodeId, confidence, path })
  }

  private recomputeResolved(): void {
    if (this.state.candidates.size !== 1) {
      this.state.resolved = false
      return
    }
    const only = [...this.state.candidates.values()][0]
    if (only && only.confidence >= RESOLVE_CONFIDENCE) {
      this.state.resolved = true
      this.state.lastResolved = { subMapId: only.subMapId, nodeId: only.nodeId }
    } else {
      this.state.resolved = false
    }
  }

  private key(subMapId: string, nodeId: string): string {
    return `${subMapId}:${nodeId}`
  }
}

/** 两个方向集合是否相同 (无序). */
function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

/** 限定 0~1. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
