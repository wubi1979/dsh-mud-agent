/**
 * dsh-mud-core — 服务扩展契约 (Map Capability), host face.
 *
 * 定义 `ctx.mud.map` 的结构契约 `MudMapCapability`。这是**最小、全自治**的
 * 能力子集: 由 core 单方面声明, 用自治类型, **不依赖**下游插件 (对齐官方
 * web.registerXxx 的宿主注册缝模式), 语义上描述「core 需要地图服务提供的
 * 定位与导航能力」, 而非完整地图服务的内部实现细节。
 *
 * 数据流 (对称, 各司其职):
 *   - core → map: 原始行 (GMCP.Move 原始数据 / look 原文, 如 `parseLook`
 *     的 text 入参); 另有 `ctx.mud.sendCommand` 供 map 发命令。
 *   - map  → core: 行动序列 (`move`/`movePath`) + 定位状态 (`position`/
 *     `setAnchor`)。
 *
 * 其余能力 (先验图导入、建图、边/语义/围栏、快照导出/导入、人工交互等)
 * **不抽象进本契约** — 属地图服务内部/运维, 由专用插件 @deepseek-ai/dsh-mud-map
 * 的完整 `MudMapService` 提供, 需要者直接依赖该包。后续若有真实消费需求,
 * 再在契约上增量扩展 (core 自治重述所需结构, 不反向依赖下游)。
 *
 * @module @deepseek-ai/dsh-mud-core/extensions
 */

/** 定位状态视图 (契约自治类型). */
export interface MudMapPosition {
  /** 是否已收敛定位. */
  resolved: boolean
  /** 子图 ID (未定位 null). */
  subMap: string | null
  /** 节点 ID (未定位 null). */
  nodeId: string | null
  /** 候选数 (>1 表示歧义). */
  candidates: number
}

/** look 解析最小结果视图 (契约自治类型; 实现方返回更具体超集, 协变兼容). */
export interface MudMapLookResult {
  /** 房间名. */
  name: string
  /** 出口方向列表. */
  exits: string[]
}

/**
 * 地图服务结构契约 (ctx.mud.map 的类型)。core 用自治类型声明定位与导航所需
 * 的最小能力; mud-map 的 `MudMapService` 为此超集实现。契约可扩展, 后续
 * 新增能力不影响本包编译, 由实现方补齐即可。
 */
export interface MudMapCapability {
  /** 当前定位状态 (core 了解现状). */
  position(): MudMapPosition
  /** 向指定方向走一步 (探索/导航执行); 返回是否成功入队. */
  move(dir: string): boolean
  /** 沿一段方向序列行走; 任一步失败即返回 false. */
  movePath(dirs: string[]): boolean
  /** 初始/人工对齐定位锚点. */
  setAnchor(subMapId: string, nodeId: string): boolean
  /** 将 look 原文交给地图服务解析并记录语义 (core → map 的原始行输入). */
  parseLook(roomId: string, text: string): MudMapLookResult
}
