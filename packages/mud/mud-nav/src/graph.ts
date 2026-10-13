/**
 * nav/graph — 行走知识图（T23.10b）：**把 agent 走出来的 `walk` 节点记下来**。
 *
 * 口径（用户裁定 2026-10-08）：
 *   - **初始为空**（"现在查询是空"）——不做预置地图，agent 自己按 `walk` 找路；
 *   - **找到的都记录**：每次读到本区域路径表（边 = 目的地 / 拼音名 / 步数）或 `walk -q`
 *     参考链（大致边 = `to` + `via` 区域名链）都并入本图；
 *   - **每到一个新地点重新查询** ⇒ 本图只回答"**下一跳建议**"（`suggest(from, to)`），
 *     不替 agent 规划全程，也**不保存分段进度**（"没有状态"）；
 *   - 图是**全局知识**（区域属于游戏世界，不属于某个会话）⇒ 服务面为插件级单例；
 *     会话相关的事实（当前区域 / 出发点就绪）仍在 World（§10.3），不在这里。
 *
 * 合并规则：同 `region + pinyin` **后到覆盖**（步数/目的地可能被官方调整）；
 * 参考链按 `to` 去重后到覆盖。**无解就返回 `null`**——不猜、不硬走。
 *
 * 纯层，零宿主依赖；持久化（进程重启后仍留）留后置（需要时挂存储域）。
 *
 * @module mud-core3/nav/graph
 */

import type { CrossRegionHint, WalkEdge } from './route.ts'
import { destMatches } from './route.ts'

/** 一个区域节点（边按记录顺序）。 */
export interface NavNodeSnapshot {
  readonly region: string
  readonly edges: readonly WalkEdge[]
  readonly updatedAt: number
}

/** 图快照（状态出口 / 调试）。 */
export interface NavGraphSnapshot {
  readonly nodes: readonly NavNodeSnapshot[]
  readonly hints: readonly CrossRegionHint[]
}

/** 行走知识图（内存；插件级单例由 `nav/service.ts` 持有）。 */
export class NavGraph {
  private readonly nodes = new Map<string, Map<string, WalkEdge>>()
  private readonly updatedAt = new Map<string, number>()
  private readonly hints = new Map<string, CrossRegionHint>()

  /** 区域数（"图里已知几个地方"）。 */
  size(): number {
    return this.nodes.size
  }

  /**
   * 记录本区域路径表：`region + pinyin` 为键，**后到覆盖**。
   * @returns 实际写入/更新的边数（`region` 缺省 ⇒ 0，不猜归属）
   */
  recordTable(region: string | undefined, edges: readonly WalkEdge[], now: number = Date.now()): number {
    if (region === undefined || region === '') return 0
    let bucket = this.nodes.get(region)
    if (bucket === undefined) {
      bucket = new Map()
      this.nodes.set(region, bucket)
    }
    let written = 0
    for (const e of edges) {
      if (e.pinyin === '') continue
      bucket.set(e.pinyin, e)
      written += 1
    }
    if (written > 0) this.updatedAt.set(region, now)
    return written
  }

  /** 记录 `-q` 参考链（按 `to` 去重，后到覆盖）。@returns 是否新记录 */
  recordHint(hint: CrossRegionHint): boolean {
    const isNew = !this.hints.has(hint.to)
    this.hints.set(hint.to, hint)
    return isNew
  }

  /** 取某目标的参考链（没有 ⇒ `null`）。 */
  hintFor(to: string): CrossRegionHint | null {
    return this.hints.get(to) ?? null
  }

  /**
   * **下一跳建议**：`from` 的可执行边（拼音名）。
   *   ① `from` 的直接边匹配 `to` ⇒ 直达；
   *   ② 否则取 `to` 的参考链，沿 `via` 在 `from` 的边里找**第一个匹配**（链只有参考意义，
   *      但能告诉我们在当前区域先往哪走）；
   *   ③ 都没有 ⇒ `null`。
   */
  suggest(from: string | undefined, to: string): WalkEdge | null {
    if (from === undefined || from === '') return null
    const edges = this.edgesOf(from)
    if (edges.length === 0) return null
    const direct = edges.find(e => destMatches(e.dest, to))
    if (direct !== undefined) return direct
    const hint = this.hintFor(to)
    if (hint === null) return null
    for (const name of hint.via) {
      const hit = edges.find(e => destMatches(e.dest, name))
      if (hit !== undefined) return hit
    }
    return null
  }

  /** 某区域已记录的边（副本数组）。 */
  edgesOf(region: string): WalkEdge[] {
    const bucket = this.nodes.get(region)
    return bucket === undefined ? [] : [...bucket.values()]
  }

  /** 快照（节点按区域插入序，边按记录序）。 */
  snapshot(): NavGraphSnapshot {
    const nodes: NavNodeSnapshot[] = []
    for (const [region, edges] of this.nodes) {
      nodes.push({ region, edges: [...edges.values()], updatedAt: this.updatedAt.get(region) ?? 0 })
    }
    return { nodes, hints: [...this.hints.values()] }
  }

  /**
   * 从快照恢复（持久化加载，T23.10b）：**后到覆盖**语义与实时记录一致
   * （同区域合并、同 pinyin/同 to 覆盖）；坏数据逐条丢弃，不整体报废。
   */
  loadSnapshot(snap: NavGraphSnapshot | null | undefined): number {
    if (snap === null || snap === undefined) return 0
    let loaded = 0
    for (const node of snap.nodes ?? []) {
      if (typeof node?.region !== 'string' || node.region === '') continue
      if (!Array.isArray(node.edges)) continue
      const edges = node.edges.filter(
        (e): e is WalkEdge => typeof e?.pinyin === 'string' && e.pinyin !== ''
          && typeof e.dest === 'string' && typeof e.steps === 'number',
      )
      const written = this.recordTable(node.region, edges, typeof node.updatedAt === 'number' ? node.updatedAt : Date.now())
      loaded += written
    }
    for (const hint of snap.hints ?? []) {
      if (typeof hint?.to !== 'string' || hint.to === '' || !Array.isArray(hint.via)) continue
      this.recordHint({ to: hint.to, via: hint.via.filter((x): x is string => typeof x === 'string') })
    }
    return loaded
  }
}
