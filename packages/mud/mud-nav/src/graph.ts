/**
 * nav/graph — 行走知识图：**把 agent 走出来的 `walk` 节点记下来**（只记录，不查询——
 * 用户口径 2026-10-14：nav 只提供记录服务，完全不进入 agent）。
 *
 * 口径：
 *   - **初始为空**——不做预置地图，agent 自己按 `walk` 找路；
 *   - **找到的都记录**：本区域路径表（边 = 目的区域 ◇ 目的房间 / 拼音名 / 步数 /
 *     行颜色可直达性）并入本图；`walk -c <拼音名>` 的方向序列**按拼音并入对应边的
 *     `dirs`**（用户口径 2026-10-14：dirs 字段存行进路径；独立 paths 数组退役）；
 *   - **不持有分段进度**（"没有状态"）：会话状态仍在 World（§10.3），本图只是
 *     后端积累的行走知识（供后续服务取用，不对 agent 回答）。
 *
 * 合并规则：同 `region + pinyin` **后到覆盖**（步数/目的地/颜色可能被官方调整），
 * 但已有 `dirs` 在新边未带时**保留**（方向序列是 `-c` 单独学来的，不吃表覆盖）；
 * `dirs` 同键**后到覆盖**。
 *
 * 纯层，零宿主依赖；持久化由 `service.ts` 的 `NavStore` 端口承担（文件实现见 `store.ts`）。
 *
 * @module mud-nav/graph
 */

import type { WalkEdge } from './route.ts'

/** 一个区域节点（边按记录顺序）。 */
export interface NavNodeSnapshot {
  readonly region: string
  readonly edges: readonly WalkEdge[]
  readonly updatedAt: number
}

/** 图快照（后端观测 / 落盘）。 */
export interface NavGraphSnapshot {
  readonly nodes: readonly NavNodeSnapshot[]
}

/** 行走知识图（内存；插件级单例由 `nav/service.ts` 持有）。 */
export class NavGraph {
  private readonly nodes = new Map<string, Map<string, WalkEdge>>()
  private readonly updatedAt = new Map<string, number>()

  /** 区域数（"图里已知几个地方"）。 */
  size(): number {
    return this.nodes.size
  }

  /**
   * 记录本区域路径表：`region + pinyin` 为键，**后到覆盖**；新边未带 `dirs`
   * 时保留旧边的 `dirs`（方向序列是 `-c` 学来的，不吃表覆盖）。
   * @returns 实际写入/更新的边数（`region` 缺省 ⇒ 0，不猜归属）
   */
  recordTable(region: string | undefined, edges: readonly WalkEdge[], now: number = Date.now()): number {
    if (region === undefined || region === '') return 0
    const valid = edges.filter(e => e.pinyin !== '' && e.region !== '' && e.room !== '')
    if (valid.length === 0) return 0 // 全坏边/空表不立节点（loadSnapshot 坏数据逐条丢弃的兜底）
    let bucket = this.nodes.get(region)
    if (bucket === undefined) {
      bucket = new Map()
      this.nodes.set(region, bucket)
    }
    for (const e of valid) {
      const prev = bucket.get(e.pinyin)
      bucket.set(e.pinyin, prev !== undefined && e.dirs === undefined && prev.dirs !== undefined
        ? { ...e, dirs: prev.dirs }
        : e)
    }
    this.updatedAt.set(region, now)
    return valid.length
  }

  /**
   * 把 `walk -c` 答复的方向序列并入本区域对应边的 `dirs`（**后到覆盖**）：
   * 优先按 `pinyin`（查询参数，唯一 id）匹配；不中再按 `to`（答复前缀 = 目的
   * 区域名）匹配。都找不到对应边 ⇒ false（不猜、不立节点）。
   */
  recordDirs(
    region: string | undefined,
    target: { pinyin?: string; to?: string },
    dirs: readonly string[],
    now: number = Date.now(),
  ): boolean {
    if (region === undefined || region === '' || dirs.length === 0) return false
    const bucket = this.nodes.get(region)
    if (bucket === undefined) return false
    const pinyin = target.pinyin ?? ''
    let key = pinyin !== '' && bucket.has(pinyin) ? pinyin : ''
    if (key === '') key = [...bucket.values()].find(e => e.region === target.to)?.pinyin ?? ''
    if (key === '') return false
    const prev = bucket.get(key)!
    bucket.set(key, { ...prev, dirs: [...dirs] })
    this.updatedAt.set(region, now)
    return true
  }

  /** 快照（节点按区域插入序、边按记录序）。 */
  snapshot(): NavGraphSnapshot {
    const nodes: NavNodeSnapshot[] = []
    for (const [region, edges] of this.nodes) {
      nodes.push({ region, edges: [...edges.values()], updatedAt: this.updatedAt.get(region) ?? 0 })
    }
    return { nodes }
  }

  /**
   * 从快照恢复（持久化加载）：**后到覆盖**语义与实时记录一致；**读时归一**——
   * 旧格式（`dest: "区域  ◇ 房间"` + 独立 `paths`）就地折算成新格式（无颜色信息
   * 不记 direct），坏数据逐条丢弃，不整体报废。
   * @returns 实际恢复的条数（边 + dirs 并入）
   */
  loadSnapshot(snap: {
    nodes?: readonly { region?: unknown; edges?: readonly unknown[]; updatedAt?: unknown }[]
    paths?: readonly { region?: unknown; to?: unknown; directions?: unknown; updatedAt?: unknown }[]
  } | null | undefined): number {
    if (snap === null || snap === undefined) return 0
    let loaded = 0
    for (const node of snap.nodes ?? []) {
      if (typeof node?.region !== 'string' || node.region === '') continue
      if (!Array.isArray(node.edges)) continue
      const edges: WalkEdge[] = []
      for (const raw of node.edges) {
        const e = raw as { region?: unknown; room?: unknown; dest?: unknown; pinyin?: unknown; steps?: unknown; direct?: unknown; dirs?: unknown }
        // 新格式 {region, room,…}；旧格式 {dest:"区域  ◇ 房间",…} 就地折算。
        let region: string | undefined = typeof e.region === 'string' ? e.region.trim() : undefined
        let room: string | undefined = typeof e.room === 'string' ? e.room.trim() : undefined
        if ((region === undefined || room === undefined) && typeof e.dest === 'string') {
          const at = e.dest.search(/\s*◇\s*/)
          if (at > 0) {
            region = region ?? e.dest.slice(0, at).trim()
            room = room ?? e.dest.slice(at).replace(/\s*◇\s*/, '').trim()
          }
        }
        if (region === undefined || region === '' || room === undefined || room === '') continue
        if (typeof e.pinyin !== 'string' || e.pinyin === '' || typeof e.steps !== 'number') continue
        const direct = typeof e.direct === 'boolean' ? e.direct : undefined
        const dirs = Array.isArray(e.dirs) ? e.dirs.filter((x): x is string => typeof x === 'string' && x !== '') : []
        edges.push({
          region,
          room,
          pinyin: e.pinyin,
          steps: e.steps,
          ...(direct !== undefined ? { direct } : {}),
          ...(dirs.length > 0 ? { dirs } : {}),
        })
      }
      loaded += this.recordTable(node.region, edges, typeof node.updatedAt === 'number' ? node.updatedAt : Date.now())
    }
    // 旧格式 paths：方向序列并入同区域对应边（按 to = 目的区域名匹配）；无对应边丢弃。
    for (const p of snap.paths ?? []) {
      if (typeof p?.region !== 'string' || p.region === '' || typeof p?.to !== 'string' || p.to === '') continue
      if (!Array.isArray(p.directions)) continue
      const dirs = p.directions.filter((x): x is string => typeof x === 'string' && x !== '')
      if (dirs.length === 0) continue
      if (this.recordDirs(p.region, { to: p.to }, dirs, typeof p.updatedAt === 'number' ? p.updatedAt : Date.now())) loaded += 1
    }
    return loaded
  }
}
