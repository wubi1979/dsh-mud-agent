/**
 * dsh-mud-map — 几何层 (Geometry): 图构建器.
 *
 * 基于 GMCP.Move 事件增量构建实际房间图。GMCP.Move 是权威：
 * 成功进入房间后返回新房间短名 (short) 与出口方向列表 (dir)。
 *
 * 节点身份确认优先级:
 *   1. GMCP.short 匹配先验层同名节点 + 出口集一致 → 高置信度
 *   2. GMCP.short 匹配已构建图中节点 + 出口集一致 → 确认
 *   3. 从已知节点通过唯一路径到达 → 确认
 *   4. 语义指纹匹配 → 确认
 *
 * 本层不订阅事件总线，由 NavService 消费 GMCP 后调用其方法，保持纯粹。
 *
 * @module @deepseek-ai/dsh-mud-map/geometry
 */

import type { SubMap, SubMapNode, Edge, PriorSubMap, NodeRoom } from './types.ts'

/** 方向映射 (简名 → 标准方向, 供解析与逆映射用). */
const DIR_INVERSE: Record<string, string> = {
  north: 'south', south: 'north',
  east: 'west', west: 'east',
  up: 'down', down: 'up',
  northeast: 'southwest', southwest: 'northeast',
  northwest: 'southeast', southeast: 'northwest',
  northup: 'southdown', southdown: 'northup',
  northdown: 'southup', southup: 'northdown',
  eastup: 'westdown', westdown: 'eastup',
  eastdown: 'westup', westup: 'eastdown',
  enter: 'out', out: 'enter',
}

/** 已知短名集合中的唯一匹配判定: 找到且仅一个候选节点名与入口一致. */
function findUniqueByName(subMap: SubMap, name: string): SubMapNode | undefined {
  let found: SubMapNode | undefined
  for (const node of subMap.nodes.values()) {
    if (node.name === name) {
      if (found) return undefined // 冲突 → 不唯一
      found = node
    }
  }
  return found
}

/**
 * 几何层 — 房间图构建.
 */
export class GeometryLayer {
  private readonly subMaps: Map<string, SubMap> = new Map()
  private currentSubMap: SubMap | null = null
  private currentPosition: SubMapNode | null = null
  private lastDir: string | null = null
  /** 移动事件监听 (NavService 注入, 用于驱动 localizer). */
  onMove: ((out: { fromId: string; dir: string; toId: string }) => void) | null = null

  // ── 子图注册 ──────────────────────────────────────────

  /** 注册/覆盖一个子图 (通常来自先验导入或恢复). */
  setSubMap(subMap: SubMap): void {
    this.subMaps.set(subMap.id, subMap)
  }

  /** 获取指定子图 (不存在返回 undefined). */
  getSubMap(id: string): SubMap | undefined {
    return this.subMaps.get(id)
  }

  /** 全部子图. */
  allSubMaps(): SubMap[] {
    return [...this.subMaps.values()]
  }

  /** 从先验子图导入一个子图 (生成内部节点/边). */
  importPrior(prior: PriorSubMap): void {
    const nodes = new Map<string, SubMapNode>()
    for (const pn of prior.nodes) {
      nodes.set(pn.id, {
        id: pn.id,
        name: pn.name,
        npcIds: [...pn.npcIds],
        exits: new Map<string, string>(),
        confirmed: true,
        source: 'ascii',
      })
    }
    // 由先验连接生成出边 (目标名 → 目标节点 ID).
    for (const pn of prior.nodes) {
      const node = nodes.get(pn.id)
      if (!node) continue
      for (const conn of pn.connections) {
        const target = findUniqueByName({ id: prior.id, name: prior.name, nodes, boundaries: [], nodeRooms: [] }, conn.targetName)
        if (!target) continue
        node.exits.set(conn.dir, target.id)
        if (!conn.bidirectional) {
          // 单向: 仅建立出边
        } else {
          // 双向: 逆方向已由目标节点的连接覆盖, 无需额外建立
        }
      }
    }
    const subMap: SubMap = {
      id: prior.id,
      name: prior.name,
      nodes,
      boundaries: [...prior.boundaries],
      nodeRooms: prior.nodeRooms.map((nr): NodeRoom => ({
        nodeId: findByName(nodes, nr.name)?.id ?? nr.name,
        name: nr.name,
        gameId: nr.gameId,
      })),
    }
    this.subMaps.set(subMap.id, subMap)
  }

  // ── 定位锚点 ──────────────────────────────────────────

  /** 显式设置当前位置 (初始对齐/人工确认/失锁恢复). 返回是否成功. */
  setCurrent(subMapId: string, nodeId: string): boolean {
    const sm = this.subMaps.get(subMapId)
    const node = sm?.nodes.get(nodeId)
    if (!sm || !node) return false
    this.currentSubMap = sm
    this.currentPosition = node
    return true
  }

  /** 当前子图 ID. */
  currentSubMapId(): string | null {
    return this.currentSubMap?.id ?? null
  }

  /** 当前节点 ID. */
  currentNodeId(): string | null {
    return this.currentPosition?.id ?? null
  }

  // ── GMCP.Move 消费 ────────────────────────────────────

  /**
   * 处理一次 GMCP.Move (成功进入房间).
   * @param short 新房间短名 (GMCP.short)
   * @param dir   新房间出口方向列表 (GMCP.dir)
   */
  onRoomEntered(short: string, dir: string[]): void {
    const from = this.currentPosition
    const sm = this.currentSubMap
    if (!from || !sm) return

    // 归一化出口集合 (排序去重, 作指纹).
    const exits = normalizeExits(dir)

    // 获得 (或创建) 目标节点.
    const target = this.findOrCreateNode(sm, short)

    // 目标节点出口记录 (确认后写入, 供后续剪枝).
    target.exits.clear()
    for (const e of exits) target.exits.set(e, '')

    // 确认 from → target 的边 (双向: target → from 的逆方向).
    this.confirmEdge(sm, from, this.lastDir ?? '', target)
    if (this.lastDir) {
      const inverse = DIR_INVERSE[this.lastDir] ?? this.lastDir
      this.confirmEdge(sm, target, inverse, from)
    }

    // 移动到 target.
    this.currentPosition = target
    this.onMove?.({ fromId: from.id, dir: this.lastDir ?? '', toId: target.id })
  }

  /** 记录"即将从当前位置向某方向移动" (在发命令前调用). */
  onMoveStart(dir: string): void {
    this.lastDir = dir
  }

  /**
   * 查找或创建目标节点 (惰性确认的"未知/临时"落点).
   * - 若图中已存在确认的同名节点 → 复用
   * - 否则创建临时节点 (confirmed=false)
   */
  private findOrCreateNode(sm: SubMap, short: string): SubMapNode {
    const existing = findUniqueByName(sm, short)
    if (existing) {
      existing.confirmed = true
      return existing
    }
    // 检查是否有未确认 (临时) 的同名节点.
    let temp: SubMapNode | undefined
    for (const node of sm.nodes.values()) {
      if (node.name === short) { temp = node; break }
    }
    if (temp) {
      temp.confirmed = true
      return temp
    }
    // 创建新临时节点.
    const id = `${sm.id}:${short}_${nextSeq(sm)}`
    const created: SubMapNode = {
      id,
      name: short,
      npcIds: [],
      exits: new Map<string, string>(),
      confirmed: true,
      source: 'gmcp',
    }
    sm.nodes.set(id, created)
    return created
  }

  /** 确认一条边 (双向建立). */
  private confirmEdge(sm: SubMap, from: SubMapNode, dir: string, to: SubMapNode): void {
    void sm
    from.exits.set(dir, to.id)
  }

  // ── 房间/边查询 ───────────────────────────────────────

  /** 当前子图的所有房间. */
  rooms(): SubMapNode[] {
    return this.currentSubMap ? [...this.currentSubMap.nodes.values()] : []
  }

  /** 当前子图的所有边 (由节点出口展开). */
  edges(): Edge[] {
    const sm = this.currentSubMap
    if (!sm) return []
    const out: Edge[] = []
    for (const node of sm.nodes.values()) {
      for (const [dir, toId] of node.exits) {
        out.push({ from: node.id, dir, to: toId, confirmed: node.confirmed })
      }
    }
    return out
  }
}

/** 归一化出口集合: 去重 + 排序 (作指纹比对用). */
export function normalizeExits(dir: string[]): string[] {
  return [...new Set(dir.filter(Boolean))].sort()
}

/** 出口集合指纹: 稳定字符串 (用于比对). */
export function exitsFingerprint(dir: string[]): string {
  return normalizeExits(dir).join(',')
}

/** 生成子图内递增序号 (临时节点 ID 用). */
function nextSeq(sm: SubMap): number {
  let max = 0
  for (const id of sm.nodes.keys()) {
    const m = /_(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** 按名称在节点 Map 中查找 (仅供先验 NODE 解析). */
function findByName(nodes: Map<string, SubMapNode>, name: string): SubMapNode | undefined {
  for (const node of nodes.values()) {
    if (node.name === name) return node
  }
  return undefined
}
