/**
 * dsh-mud-map — 导航规划 (Navigator): 分片寻路.
 *
 * 分片寻路:
 *   plan(fromNodeId, target, targetSubMap?):
 *     1. 目标在当前子图 → 子图内 BFS → 返回方向序列
 *     2. 目标在其他子图 →
 *        a. 查找边界路由: 当前子图 → [中间子图]* → 目标子图
 *        b. 每段: BFS 到 NODE → node walk
 *
 * BFS 寻路工作在几何层子图的有向边上。
 *
 * @module @deepseek-ai/dsh-mud-map/navigator
 */

import type { SubMap } from './types.ts'

/** 图查询接口 (由 NavService 注入, 解耦 Navigator 与 Geometry). */
export interface GraphQuery {
  /** 按全局节点 ID 找到所属子图. */
  subMapOf(nodeId: string): SubMap | undefined
  /** 给定节点 ID 与方向, 返回目标节点 ID (无则 undefined). */
  neighbor(nodeId: string, dir: string): string | undefined
  /** 子图内 NODE 房间列表 (跨子图路由用). */
  nodeRooms(subMapId: string): Array<{ nodeId: string; gameId: string }>
}

/**
 * 导航器.
 */
export class Navigator {
  private readonly graph: GraphQuery

  constructor(graph: GraphQuery) {
    this.graph = graph
  }

  /**
   * 在指定子图内从起点寻路到终点, 返回方向序列.
   * @param subMapId 子图 ID
   * @param fromId   起点节点 ID
   * @param toId     终点节点 ID
   */
  bfsWithinSubMap(_subMapId: string, fromId: string, toId: string): string[] {
    if (fromId === toId) return []
    // BFS: 记录前驱节点 ID + 到达方向.
    const queue: string[] = [fromId]
    const prevDir = new Map<string, string>()
    const prevNode = new Map<string, string>()
    const visited = new Set<string>([fromId])

    while (queue.length > 0) {
      const current = queue.shift()!
      const subMap = this.graph.subMapOf(current)
      const node = subMap?.nodes.get(current)
      if (!node) continue
      for (const [dir, nextId] of node.exits) {
        if (visited.has(nextId)) continue
        visited.add(nextId)
        prevDir.set(nextId, dir)
        prevNode.set(nextId, current)
        if (nextId === toId) {
          // 回溯方向序列.
          return reconstruct(toId, prevDir, prevNode, fromId)
        }
        queue.push(nextId)
      }
    }
    return []
  }

  /**
   * 规划从指定节点到目标房间的完整路径 (骨架: 当前仅子图内 BFS, 跨子图待实现).
   * @param fromNodeId 起点节点 ID
   * @param target 目标房间名
   * @param targetSubMap 目标子图 ID (省略则当前子图)
   */
  plan(fromNodeId: string, target: string, targetSubMap?: string): string[] {
    const fromSubId = this.graph.subMapOf(fromNodeId)?.id
    if (!fromSubId) return []
    const destSubId = targetSubMap ?? fromSubId
    if (destSubId === fromSubId) {
      // 同子图: 找目标节点并 BFS.
      const subMap = this.graph.subMapOf(fromNodeId)!
      const toId = this.findNodeByName(subMap, target)
      if (!toId) return []
      return this.bfsWithinSubMap(fromSubId, fromNodeId, toId)
    }
    // 跨子图 (Phase 3): 经边界路由 + node walk. 当前返回空.
    return []
  }

  /** 在子图中按房间名找节点 ID (同名取首个). */
  private findNodeByName(subMap: SubMap, name: string): string | undefined {
    for (const node of subMap.nodes.values()) {
      if (node.name === name) return node.id
    }
    return undefined
  }
}

/** 从终点回溯 BFS 前驱, 还原方向序列 (从起点到终点). */
function reconstruct(
  toId: string,
  prevDir: Map<string, string>,
  prevNode: Map<string, string>,
  fromId: string,
): string[] {
  const dirs: string[] = []
  let cur = toId
  while (cur !== fromId) {
    const dir = prevDir.get(cur)
    const prev = prevNode.get(cur)
    if (dir === undefined || prev === undefined) break
    dirs.unshift(dir)
    cur = prev
  }
  return dirs
}
