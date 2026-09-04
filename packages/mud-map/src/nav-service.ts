/**
 * dsh-mud-map — 导航服务聚合 (NavService): 插件主体.
 *
 * 聚合各子模块 (几何/定位/语义/导航/围栏/人工交互/持久化), 订阅 `mud/gmcp`
 * 事件消费 GMCP.Move 构建图, 并提供 `ctx.mud.map` 子服务。
 *
 * 移动入口: 调用方 (agent 工具 / 外部脚本) 经 `map.move(dir)` 发起移动 —
 * NavService 记录方向、调 `ctx.mud.sendCommand` 下发, 收到 GMCP.Move 结果后
 * 建边并推进定位。被动模式 (仅收到 GMCP.Move 而无本地 lastDir, 如 agent 用
 * mud_move 移动) 只重定位当前节点、不建边, 避免错误拓扑。
 *
 * @module @deepseek-ai/dsh-mud-map/nav-service
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  MudMapService, MapSnapshot, PriorSubMap, SubMapNode,
  HumanInteraction, RoomParsed, SemanticFingerprint,
} from './types.ts'
import { GeometryLayer } from './geometry.ts'
import { Localizer } from './localizer.ts'
import { SemanticLayer } from './semantic.ts'
import { Navigator } from './navigator.ts'
import { FenceManager } from './fence.ts'
import { HumanInteractionManager } from './human.ts'
import { JsonMapStore } from './store.ts'
import type { MapStore } from './types.ts'

/** NavService 构造参数. */
export interface NavServiceOptions {
  /** 存储实现 (缺省 JsonMapStore, 由宿主提供文件路径). */
  store?: MapStore
  /** 命令下发 (接 ctx.mud.sendCommand). */
  sendCommand: (cmd: string) => boolean
  /** 人工交互弹窗适配器 (缺省返回默认值). */
  requestHuman?: (interaction: HumanInteraction) => Promise<unknown>
}

/** 解码 GMCP.Move 载荷 (pkuxkx: 单元素数组 {result, dir, short}). */
function decodeMove(payload: unknown): { result: string; dir: string[]; short: string } | null {
  const data = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const r = data as Record<string, unknown>
  if (typeof r.result !== 'string') return null
  return {
    result: r.result,
    dir: Array.isArray(r.dir) ? r.dir.map(String) : [],
    short: typeof r.short === 'string' ? r.short : '',
  }
}

/**
 * 导航服务: cordis 插件主体 + ctx.mud.map 提供方.
 */
export class NavService {
  readonly geometry: GeometryLayer
  readonly semantic: SemanticLayer
  readonly localizer: Localizer
  readonly navigator: Navigator
  readonly fence: FenceManager
  readonly human: HumanInteractionManager

  private readonly store: MapStore
  private readonly sendCommand: (cmd: string) => boolean
  private readonly requestHuman: (interaction: HumanInteraction) => Promise<unknown>

  constructor(options: NavServiceOptions) {
    this.sendCommand = options.sendCommand
    this.store = options.store ?? new JsonMapStore('mud-map.json')
    this.requestHuman = options.requestHuman ?? (() => Promise.resolve(undefined))
    this.human = new HumanInteractionManager()

    this.geometry = new GeometryLayer()
    this.semantic = new SemanticLayer()

    // 定位器依赖几何层的图查询.
    this.localizer = new Localizer({
      exitsOf: (nodeId) => {
        const subId = this.geometry.currentSubMapId()
        const node = this.geometry.getSubMap(subId ?? '')?.nodes.get(nodeId)
        if (!node) return undefined
        return [...node.exits.keys()]
      },
      neighborOf: (nodeId, dir) => {
        const subId = this.geometry.currentSubMapId()
        return this.geometry.getSubMap(subId ?? '')?.nodes.get(nodeId)?.exits.get(dir)
      },
      nameOf: (nodeId) => {
        const subId = this.geometry.currentSubMapId()
        return this.geometry.getSubMap(subId ?? '')?.nodes.get(nodeId)?.name
      },
    })

    this.navigator = new Navigator({
      subMapOf: (nodeId) => {
        // 通过遍历子图定位节点所属 (nodeId 形如 subMapId:local).
        const idx = nodeId.indexOf(':')
        const subId = idx > 0 ? nodeId.slice(0, idx) : ''
        return this.geometry.getSubMap(subId)
      },
      neighbor: (nodeId, dir) => {
        const idx = nodeId.indexOf(':')
        const subId = idx > 0 ? nodeId.slice(0, idx) : ''
        return this.geometry.getSubMap(subId)?.nodes.get(nodeId)?.exits.get(dir)
      },
      nodeRooms: (subMapId) =>
        this.geometry.getSubMap(subMapId)?.nodeRooms.map((nr) => ({ nodeId: nr.nodeId, gameId: nr.gameId })) ?? [],
    })

    this.fence = new FenceManager()
  }

  // ── 生命周期 ──────────────────────────────────────────

  /** 启动: 订阅 GMCP 事件 + 恢复持久化图. */
  async start(ctx: Context): Promise<void> {
    ctx.events.on('mud/gmcp', (e: { name: string; data: unknown }) => {
      this.onGmcp(e.name, e.data)
    })

    try {
      const snap = await this.store.load()
      if (snap && snap.subMaps.length > 0) {
        for (const sm of snap.subMaps) this.geometry.setSubMap(sm)
      }
    } catch (err) {
      // 恢复失败不阻断启动.
      void err
    }
  }

  /** 停机: 落盘当前图 (best-effort). */
  async dispose(): Promise<void> {
    try {
      await this.store.save(this.geometrySnapshot())
    } catch (err) {
      void err
    }
  }

  // ── GMCP 消费 ─────────────────────────────────────────

  /** 处理一条 GMCP 事件. */
  onGmcp(name: string, payload: unknown): void {
    if (name === 'Move') {
      const move = decodeMove(payload)
      if (move && move.result === 'true') {
        this.geometry.onRoomEntered(move.short, move.dir)
        // 移动后推进定位 (GMCP 剪枝).
        const lastDir = this.lastMoveDir
        if (lastDir) this.localizer.onMove(lastDir, move.short, move.dir)
      }
      return
    }
    // 其余 GMCP (Char.* / Room.Info / System) 暂不消费 — 可扩展.
  }

  /** 记录最近一次主动移动方向 (发命令前设置). */
  private lastMoveDir: string | null = null

  // ── ctx.mud.map 服务 (MudMapService) ──────────────────

  /** 服务接口. */
  readonly service: MudMapService = {
    position: () => this.localizer.position(),
    rooms: () => this.geometry.rooms(),
    edges: () => this.geometry.edges(),
    importPrior: (subMap: PriorSubMap) => {
      this.geometry.importPrior(subMap)
      void this.persist()
    },
    fixNode: (id: string, patch: Partial<SubMapNode>) => this.fixNode(id, patch),
    fences: () => this.fence.allFences(),
    export: () => this.geometrySnapshot(),
    import: (snapshot: MapSnapshot) => {
      for (const sm of snapshot.subMaps) this.geometry.setSubMap(sm)
      void this.persist()
    },
    requestHuman: (interaction: HumanInteraction) => this.requestHuman(interaction),
    move: (dir: string) => this.move(dir),
    movePath: (dirs: string[]) => this.movePath(dirs),
    setAnchor: (subMapId: string, nodeId: string) => this.setAnchor(subMapId, nodeId),
    parseLook: (roomId: string, text: string) => this.parseLook(roomId, text),
  }

  /** 手动修正节点 (更新几何层节点字段, 涉及出口需通过 fixExits). */
  private fixNode(id: string, patch: Partial<SubMapNode>): void {
    const subId = id.slice(0, id.indexOf(':') > 0 ? id.indexOf(':') : 0)
    const node = this.geometry.getSubMap(subId)?.nodes.get(id)
    if (!node) return
    if (patch.name !== undefined) node.name = patch.name
    if (patch.npcIds !== undefined) node.npcIds = [...patch.npcIds]
    if (patch.confirmed !== undefined) node.confirmed = patch.confirmed
    if (patch.source !== undefined) node.source = patch.source
    if (patch.id !== undefined) node.id = patch.id
    if (patch.exits !== undefined) node.exits = new Map(patch.exits)
    void this.persist()
  }

  // ── 主动移动 (探索记录器入口) ─────────────────────────

  /**
   * 主动移动: 记录方向 → 下发命令. 供探索/导航执行调用.
   * @param dir 标准方向 (north/south/...)
   */
  move(dir: string): boolean {
    this.lastMoveDir = dir
    this.geometry.onMoveStart(dir)
    return this.sendCommand(dir)
  }

  /** 执行一段路径 (方向序列), 每步下发. */
  movePath(dirs: string[]): boolean {
    for (const d of dirs) {
      if (!this.move(d)) return false
    }
    return true
  }

  /**
   * 初始对齐: 人工确认当前位置后初始化定位.
   * @param subMapId 子图 ID
   * @param nodeId 节点 ID
   */
  setAnchor(subMapId: string, nodeId: string): boolean {
    if (!this.geometry.setCurrent(subMapId, nodeId)) return false
    this.localizer.init(subMapId, nodeId)
    void this.persist()
    return true
  }

  /** 解析 look 输出并记录语义指纹 (供歧义消解). */
  parseLook(roomId: string, text: string): RoomParsed {
    return this.semantic.parseAndRecord(roomId, text)
  }

  // ── 持久化助手 ────────────────────────────────────────

  /** 生成几何层快照 (subMaps 序列化安全: Map → 已有 store 处理). */
  private geometrySnapshot(): MapSnapshot {
    return {
      subMaps: this.geometry.allSubMaps(),
      edges: this.geometry.edges(),
      semantics: this.semantic.allFingerprints(),
      fences: this.fence.allFences(),
      version: 1,
    }
  }

  /** 落盘 (best-effort). */
  private persist(): void {
    void this.store.save(this.geometrySnapshot()).catch(() => {})
  }
}

// 保留类型再导出 (index.ts 统一 re-export)
export type { SemanticFingerprint }
