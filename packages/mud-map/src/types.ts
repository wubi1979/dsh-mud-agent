/**
 * dsh-mud-map — 导航子包核心类型定义 (Types).
 *
 * 三层数据模型:
 *   - 先验层 (PriorLayer): 人工 ASCII 图解析产物, 提供空间约束与初始化种子
 *   - 几何层 (GeometryLayer): GMCP.Move 驱动的实际房间图构建
 *   - 语义层 (SemanticLayer): look 命令解析产物, 用于混淆房间消歧
 *
 * 核心概念:
 *   - 子图 (SubMap): 一个城市/地区的房间拓扑, 对应一张 ASCII 图文件
 *   - 子图边界: 两子图之间的重叠区域标记, 非实体房间
 *   - NODE 房间: 子图中心的实体房间, 支持 node walk 跨子图传送
 *   - 出口: 房间与房间之间的方向连接
 *
 * @module @deepseek-ai/dsh-mud-map/types
 */

// 实现 core 声明的结构契约 (最小定位/导航能力子集); 本接口为其超集。
import type { MudMapCapability } from '@deepseek-ai/dsh-mud-core/extensions'

// ── 子图 (SubMap) ──────────────────────────────────────────────────────────

/** 子图 — 一个城市/地区的完整拓扑. */
export interface SubMap {
  /** 子图 ID (如 'yangzhou', 'xinyang'). */
  id: string
  /** 显示名 (如 '扬州', '信阳'). */
  name: string
  /** 子图内节点 (key = 节点 ID). */
  nodes: Map<string, SubMapNode>
  /** 该子图的边界标记列表 (非房间, 仅路由用). */
  boundaries: SubMapBoundary[]
  /** 该子图的 NODE 房间 (支持 node walk 的实体房间). */
  nodeRooms: NodeRoom[]
}

/** 子图边界 — 两子图之间的重叠标记. */
export interface SubMapBoundary {
  /** 目标子图 ID. */
  targetSubMap: string
  /** 游戏 node walk 的目标 ID (如 'yz_xiny'). */
  gameNodeId: string
}

/** NODE 房间 — 子图中心的实体房间. */
export interface NodeRoom {
  /** 子图内节点 ID. */
  nodeId: string
  /** 房间名 (与 SubMapNode.id 对应). */
  name: string
  /** 游戏 node walk 目标 ID. */
  gameId: string
}

/** 子图内节点. */
export interface SubMapNode {
  /** 唯一 ID (格式: subMapId:localId). */
  id: string
  /** 房间名 (GMCP.short 或解析结果). */
  name: string
  /** 关联的 NPC 编号. */
  npcIds: number[]
  /** 出口 (方向 → 目标节点 ID). */
  exits: Map<string, string>
  /** 身份是否已确认. */
  confirmed: boolean
  /** 数据来源. */
  source: 'gmcp' | 'ascii' | 'node' | 'merged'
}

/** 有向边. */
export interface Edge {
  /** 起点节点 ID. */
  from: string
  /** 方向. */
  dir: string
  /** 终点节点 ID. */
  to: string
  /** 是否已确认. */
  confirmed: boolean
}

// ── 先验层 (PriorLayer) ────────────────────────────────────────────────────

/** 先验子图 — 一个 ASCII 图文件的解析结果. */
export interface PriorSubMap {
  /** 子图 ID. */
  id: string
  /** 显示名. */
  name: string
  /** 先验节点列表. */
  nodes: PriorNode[]
  /** 边界标记列表. */
  boundaries: SubMapBoundary[]
  /** NODE 房间列表. */
  nodeRooms: Array<{ name: string; gameId: string }>
}

/** 先验节点 — ASCII 图解析产物. */
export interface PriorNode {
  /** 解析生成的节点 ID. */
  id: string
  /** 房间名 (从 ASCII 图文本提取). */
  name: string
  /** 房间关联的 NPC 编号. */
  npcIds: number[]
  /** ASCII 图列坐标. */
  x: number
  /** ASCII 图行坐标. */
  y: number
  /** 连接列表. */
  connections: PriorConnection[]
}

/** 先验连接. */
export interface PriorConnection {
  /** 方向. */
  dir: string
  /** 目标房间名. */
  targetName: string
  /** 是否双向. */
  bidirectional: boolean
}

// ── 语义层 (SemanticLayer) ─────────────────────────────────────────────────

/** 房间解析结果 — look 命令输出结构化. */
export interface RoomParsed {
  /** 房间名. */
  name: string
  /** 区域名. */
  area: string
  /** 房间描述 (前 50 字). */
  description: string
  /** 出口方向列表. */
  exits: string[]
  /** NPC 列表. */
  npcs: string[]
  /** 物品列表. */
  items: string[]
  /** 玩家列表. */
  players: string[]
}

/** 语义指纹 — 消歧用. */
export interface SemanticFingerprint {
  /** 房间节点 ID. */
  roomId: string
  /** 房间描述摘要. */
  description: string
  /** NPC 名列表. */
  npcs: string[]
  /** 物品列表. */
  items: string[]
  /** 区域名. */
  area: string
}

// ── MHT 定位 (Localizer) ──────────────────────────────────────────────────

/** 候选位置. */
export interface CandidatePosition {
  /** 子图 ID. */
  subMapId: string
  /** 节点 ID. */
  nodeId: string
  /** 置信度 (0~1). */
  confidence: number
  /** 从起点到此处的方向序列. */
  path: string[]
}

/** MHT 状态. */
export interface MHTState {
  /** 候选集 (key = subMapId:nodeId). */
  candidates: Map<string, CandidatePosition>
  /** 是否已收敛 (候选集大小 === 1). */
  resolved: boolean
  /** 最后确认的位置. */
  lastResolved: { subMapId: string; nodeId: string } | null
}

// ── 围栏 (Fence) ──────────────────────────────────────────────────────────

/** 围栏区域 — 被标记为不可自动导航的区域. */
export interface FenceRegion {
  /** 围栏 ID. */
  id: string
  /** 所属子图 ID. */
  subMapId: string
  /** 涉及的节点 ID 列表. */
  nodeIds: string[]
  /** 触发原因. */
  reason: string
  /** 创建时间 (Epoch-ms). */
  createdAt: number
  /** 是否已解锁. */
  unlocked: boolean
}

// ── 人工交互 (Human) ───────────────────────────────────────────────────────

/** 人工交互请求. */
export interface HumanInteraction {
  /** 交互类型. */
  type: 'confirm' | 'select' | 'fix'
  /** 弹窗标题. */
  title: string
  /** 描述文本. */
  description: string
  /** 选项列表 (select 类型). */
  options?: Array<{ label: string; value: unknown }>
  /** 回调函数. */
  callback: (answer: unknown) => void
}

// ── 持久化 (Store) ─────────────────────────────────────────────────────────

/** 地图快照 — 持久化单元. */
export interface MapSnapshot {
  /** 所有子图. */
  subMaps: SubMap[]
  /** 所有边. */
  edges: Edge[]
  /** 语义指纹库. */
  semantics: SemanticFingerprint[]
  /** 围栏列表. */
  fences: FenceRegion[]
  /** 数据版本号. */
  version: number
}

/** 地图存储接口. */
export interface MapStore {
  /** 加载快照. */
  load(): Promise<MapSnapshot>
  /** 保存快照. */
  save(snapshot: MapSnapshot): Promise<void>
}

// ── 服务接口 (Service) ────────────────────────────────────────────────────

/** 导航服务公开接口 (ctx.mud.map)。core 契约 MudMapCapability 的超集实现:
 *  定位/导航 (position/move/movePath/setAnchor/parseLook) + 图数据与运维
 *  (rooms/edges/importPrior/fixNode/fences/export/import/requestHuman)。 */
export interface MudMapService extends MudMapCapability {
  /** 当前定位状态. */
  position(): {
    resolved: boolean
    subMap: string | null
    nodeId: string | null
    candidates: number
  }
  /** 当前子图的所有房间. */
  rooms(): SubMapNode[]
  /** 当前子图的所有边. */
  edges(): Edge[]
  /** 导入先验子图. */
  importPrior(subMap: PriorSubMap): void
  /** 手动修正节点. */
  fixNode(id: string, patch: Partial<SubMapNode>): void
  /** 围栏列表. */
  fences(): FenceRegion[]
  /** 导出快照. */
  export(): MapSnapshot
  /** 导入快照 (恢复). */
  import(snapshot: MapSnapshot): void
  /** 请求人工交互. */
  requestHuman(interaction: HumanInteraction): Promise<unknown>
  /** 主动移动 (探索记录). */
  move(dir: string): boolean
  /** 执行一段路径. */
  movePath(dirs: string[]): boolean
  /** 初始对齐锚点. */
  setAnchor(subMapId: string, nodeId: string): boolean
  /** 解析 look 输出并记录指纹. */
  parseLook(roomId: string, text: string): RoomParsed
}

// ── 事件定义 ───────────────────────────────────────────────────────────────

/** 导航子系统内部事件. */
export interface NavEvents {
  /** 移动事件. */
  'nav:moved': {
    from: string
    dir: string
    to: string
    success: boolean
  }
  /** 进入房间事件. */
  'nav:room-entered': {
    subMapId: string
    name: string
    exits: string[]
  }
  /** 语义数据事件. */
  'nav:semantic': {
    roomId: string
    fingerprint: SemanticFingerprint
  }
  /** 定位更新事件. */
  'nav:position-update': {
    candidates: string[]
    resolved: boolean
  }
  /** 定位收敛事件. */
  'nav:position-resolved': {
    subMapId: string
    nodeId: string
  }
  /** 熔断触发事件. */
  'nav:fence-hit': {
    subMapId: string
    region: string
    reason: string
  }
}

// ── box-drawing 字符映射 ──────────────────────────────────────────────────

/** 字符连接类型. */
export type CharType = 'h' | 'v' | 'd' | 'corner' | 'arrow' | 'node' | 'boundary'

/** 单字符连接映射 (可配置, 后期手工调整). */
export interface CharMapEntry {
  /** 连接类型: h=横向, v=纵向, d=斜向, corner=拐角, arrow=单向箭头, node=NODE标记, boundary=边界标记. */
  type: CharType
  /** 斜向时的方向 (如 'sw', 'nw'). */
  dir?: string
}

/** 默认 box-drawing 字符映射. */
export const DEFAULT_CHAR_MAP: Record<string, CharMapEntry> = {
  '─': { type: 'h' },
  '═': { type: 'h' },
  '│': { type: 'v' },
  '╲': { type: 'd', dir: 'sw' },
  '╱': { type: 'd', dir: 'nw' },
  '╮': { type: 'corner' },
  '╭': { type: 'corner' },
  '╯': { type: 'corner' },
  '╰': { type: 'corner' },
  '＞': { type: 'arrow' },
  '⊕': { type: 'node' },
  '∧': { type: 'd', dir: 'north' },
  '∨': { type: 'd', dir: 'south' },
}
