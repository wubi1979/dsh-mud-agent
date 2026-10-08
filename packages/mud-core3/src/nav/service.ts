/**
 * nav/service — `mudNav` 服务面（T23.10b，用户裁定 2026-10-08：**现在就 provide**）。
 *
 * 职责边界：
 *   - **记录**：把每次 `walk` 家族读到的行文并入知识图（本区域路径表 ⇒ 边；`walk -q` ⇒ 参考链）；
 *     "现在查询是空，agent 自己按 walk 找路，找到了的 `walk` 节点都要记录"；
 *   - **查询**：给定当前区域与目标 ⇒ **下一跳建议**（拼音名）；无解 ⇒ `null`（不猜）；
 *   - **不持有分段进度**（"没有状态"）：每到一个新地点由 agent 重新查询，会话状态仍在 World（§10.3）。
 *
 * 图是**全局知识**（区域属于游戏世界，不按账号隔离）⇒ 本服务是**插件级单例**，
 * 由 `index.ts` `ctx.provide('mudNav', …)`；**重启即空**（持久化留后置，需要时挂存储域）。
 *
 * 纯层（零宿主 import）：只依赖 `nav/{route,graph}`。
 *
 * @module mud-core3/nav/service
 */

import { NavGraph, type NavGraphSnapshot } from './graph.ts'
import type { NavStore } from './json-store.ts'
import { parseCrossRegionHint, parseWalkTable, type CrossRegionHint, type WalkEdge } from './route.ts'

/** 一次记录的结果（观测用）。 */
export interface NavRecordResult {
  /** 本次写入/更新的边数。 */
  readonly edges: number
  /** 是否记录到参考链。 */
  readonly hint: boolean
}

/** `mudNav` 服务面（工具/流程/引擎内部共用；不含宿主类型）。 */
export interface MudNavFace {
  /** 记录一段行走行文（路径表 / 参考链），区域缺省时用表开行的区域名。 */
  record(input: { region?: string; lines: readonly string[] }): NavRecordResult
  /** 下一跳建议（无解 ⇒ `null`）。 */
  suggest(from: string | undefined, to: string): WalkEdge | null
  /** 已记录知识快照（状态出口 / 调试）。 */
  snapshot(): NavGraphSnapshot
  /** 解析行文里的参考链（`-q` 答复），供工具面回给 agent。 */
  hintOf(lines: readonly string[]): CrossRegionHint | null
}

/** 行走知识服务（插件级单例）。 */
export class NavService implements MudNavFace {
  private readonly graph = new NavGraph()
  private readonly store: NavStore | null

  /**
   * @param store 持久化端口（T23.10b：JSON 文件；缺省 = 纯内存）——构造时**加载**，
   *              每次记录后**落盘**（用户裁定"先 json，后期再优化"）。fail-soft 在端口内。
   */
  constructor(store: NavStore | null = null) {
    this.store = store
    this.graph.loadSnapshot(store?.load() ?? null)
  }

  record(input: { region?: string; lines: readonly string[] }): NavRecordResult {
    const table = parseWalkTable(input.lines)
    const region = input.region ?? table.region
    const edges = this.graph.recordTable(region, table.edges)
    const hint = this.hintOf(input.lines)
    if (hint !== null) this.graph.recordHint(hint)
    // 有增量才落盘（行走一次最多一次写；知识量小，先不做防抖——"后期再优化"）。
    if (edges > 0 || hint !== null) this.store?.save(this.graph.snapshot())
    return { edges, hint: hint !== null }
  }

  suggest(from: string | undefined, to: string): WalkEdge | null {
    return this.graph.suggest(from, to)
  }

  snapshot(): NavGraphSnapshot {
    return this.graph.snapshot()
  }

  hintOf(lines: readonly string[]): CrossRegionHint | null {
    for (const text of lines) {
      const hint = parseCrossRegionHint(text)
      if (hint !== null) return hint
    }
    return null
  }
}
