/**
 * nav/service — `mudNav` 服务面（T23.10b；用户口径 2026-10-14：**只提供记录服务**）。
 *
 * 职责边界：
 *   - **记录**：把每次 `walk` 家族读到的行文并入知识图（本区域路径表 ⇒ 边；
 *     `walk -c` 方向序列**按拼音并入对应边的 `dirs`**）；"现在查询是空，agent
 *     自己按 walk 找路，找到了的 `walk` 节点都要记录"；
 *   - **不回答**：下一跳建议 / 查询面已整体退役——服务**完全不进入 agent**，
 *     只在后端挂载，行走知识供后续服务取用（`snapshot` 仅后端观测 / 落盘）；
 *   - **不持有分段进度**（"没有状态"）：会话状态仍在 World（§10.3）。
 *
 * 图是**全局知识**（区域属于游戏世界，不按账号隔离）⇒ 本服务是**插件级单例**，
 * 由 `index.ts` `ctx.provide('mudNav', …)`。
 *
 * 纯层（零宿主 import）：只依赖 `nav/{route,graph}`。
 *
 * @module mud-nav/service
 */

import { NavGraph, type NavGraphSnapshot } from './graph.ts'
import { parseDirectionPath, parseWalkTable, type WalkLine } from './route.ts'

/** 一次记录的结果（观测用）。 */
export interface NavRecordResult {
  /** 本次写入/更新的边数。 */
  readonly edges: number
  /** 是否把 `walk -c` 方向序列并入了对应边的 `dirs`。 */
  readonly dirs: boolean
}

/** 知识图存储端口（服务只认端口；换实现不影响服务——文件 / 测试 stub 同面）。 */
export interface NavStore {
  /** 读取快照；无/坏 ⇒ `null`（fail-soft，不抛）。 */
  load(): NavGraphSnapshot | null
  /** 写入快照（fail-soft，不抛）。 */
  save(snapshot: NavGraphSnapshot): void
}

/** `mudNav` 服务面（后端口；不含宿主类型）。 */
export interface MudNavFace {
  /**
   * 记录一段行走行文（路径表 / `-c` 方向序列），区域缺省时用表开行的区域名。
   * `pinyin` = `walk -c <拼音名>` 的查询参数（方向序列按它匹配边的 `dirs`）。
   */
  record(input: { region?: string; lines: readonly WalkLine[]; pinyin?: string }): NavRecordResult
  /** 已记录知识快照（后端观测 / 落盘；不对 agent 回答）。 */
  snapshot(): NavGraphSnapshot
}

/** 行走知识服务（插件级单例；只记录，不回答）。 */
export class NavService implements MudNavFace {
  private readonly graph = new NavGraph()
  private readonly store: NavStore | null

  /**
   * @param store 持久化端口（项目内文件 / 测试 stub；缺省 = 纯内存）——构造时**加载**，
   *              每次记录后**写回**。fail-soft 在端口内。
   */
  constructor(store: NavStore | null = null) {
    this.store = store
    this.graph.loadSnapshot(store?.load() ?? null)
  }

  record(input: { region?: string; lines: readonly WalkLine[]; pinyin?: string }): NavRecordResult {
    const table = parseWalkTable(input.lines)
    const region = input.region ?? table.region
    const edges = this.graph.recordTable(region, table.edges)
    const parsed = parseDirectionPath(input.lines)
    const dirs = parsed !== null
      && this.graph.recordDirs(region, { ...(input.pinyin !== undefined ? { pinyin: input.pinyin } : {}), to: parsed.to }, parsed.directions)
    // 有增量才落盘（行走一次最多一次写；知识量小，先不做防抖——"后期再优化"）。
    if (edges > 0 || dirs) this.store?.save(this.graph.snapshot())
    return { edges, dirs }
  }

  snapshot(): NavGraphSnapshot {
    return this.graph.snapshot()
  }
}
