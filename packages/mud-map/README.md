# @deepseek-ai/dsh-mud-map — MUD 导航子包

pkuxkx MUD 无反馈环境下的地图构建、定位与导航系统。

## 问题定义

在 pkuxkx MUD 中，agent 只能通过发送方向命令移动，成功后通过 GMCP.Move 获得新房间短名（`short`）和出口方向列表（`dir`）。**不存在协议层的位置坐标、房间 ID 或拓扑关系**。存在故意设计的同名同出口混淆房间，增加定位难度。

本子包需实现：解析人工 ASCII 图构建先验数据、增量构建实际房间图、实时定位、分片路径规划与执行。

## 核心概念

| 概念 | 定义 | 示例 |
|------|------|------|
| 子图 (SubMap) | 一个城市/地区的房间拓扑，对应一张 ASCII 图文件 | 扬州、信阳 |
| 子图边界 | 两子图之间的重叠区域标记，表示「可通往目标子图」，非实体房间 | `[信阳]`、`[中原]` |
| NODE 节点 | 子图中心的实体房间，支持 `node walk <id>` 跨子图传送 | 扬州中央广场、信阳小广场 |
| 出口 | 房间与房间之间的方向连接（GMCP.dir 中的方向） | north、south、east |
| 跨子图移动 | 到达本子图 NODE → `node walk <target_id>` → 到达目标子图 NODE | node walk yz_xiny |

**边界规则**：
- 子图之间只有边界，边界可重叠（A 子图标 `[B]`，B 子图标 `[A]`）
- 一个子图可有多个边界标记
- 边界标记不是房间，不参与 MHT 定位

## 三层数据架构

```
先验层 ─── ASCII 图解析 ──→ PriorSubMap
                                │
几何层 ←── GMCP.Move ──────→ SubMapNode / Edge
    │                            │
    └──→ MHT 定位 ←── 语义层 ←──┘
              │
              ↓
         navigator
```

| 层 | 数据源 | 内容 | 用途 |
|----|--------|------|------|
| 先验层 | 人工 ASCII 图解析 | 子图拓扑 + 边界 + NODE | 空间约束、初始化种子、跨图路由 |
| 几何层 | GMCP.Move | 房间节点 + 有向边 | 实际拓扑、子图内寻路、定位锚点 |
| 语义层 | look 解析 | 描述/NPC/物品/区域 | 混淆房间区分、MHT 消歧 |

## 模块划分

```
packages/mud-map/src/
  index.ts              # 模块入口
  types.ts              # 数据结构 + 事件类型定义
  store.ts              # MapStore 接口 + JsonMapStore
  prior-parser.ts       # ASCII 图解析器 (含 CHAR_MAP)
  geometry.ts           # 几何层: 图构建 + GMCP.Move 消费
  semantic.ts           # 语义层: look 解析 + 指纹提取
  localizer.ts          # MHT 定位模块
  navigator.ts          # 分片寻路
  fence.ts              # 熔断与围栏
  human.ts              # 人工交互
```

## 模块职责

### 先验层 — ASCII 图解析器 (PriorParser)

将人工提供的 ASCII 图文件解析为 `PriorSubMap`。

**box-drawing 字符映射**：使用可配置的 `DEFAULT_CHAR_MAP`（单字符映射），后期由人工手工调整。

```typescript
const DEFAULT_CHAR_MAP: Record<string, CharMapEntry> = {
  '─': { type: 'h' },   // 横向
  '│': { type: 'v' },   // 纵向
  '╲': { type: 'd', dir: 'sw' },
  '╱': { type: 'd', dir: 'nw' },
  '＞': { type: 'arrow' },  // 单向
  '⊕': { type: 'node' },   // NODE 标记
  // ...
}
```

**解析流程**：
1. 行扫描：识别 CHAR_MAP 中的字符构建连接矩阵
2. 房间提取：扫描非空白、非连接符文本块（房间名 = 末尾数字前的部分，NPC ID = 末尾连续数字）
3. 边提取：根据连接符确定方向和目标
4. 节点分类：`[名称]` 标记 → 子图边界（非房间）；`⊕` 标记 → NODE 房间
5. 坐标：文本位置 → (x, y)

**房间名提取规则**：`北门27` → name=`北门`, npcIds=[27]；`天宁寺74` → name=`天宁寺`, npcIds=[74]；无数字 → name=全文, npcIds=[]。

### 几何层 — 图构建器 (GeometryLayer)

基于 GMCP.Move 事件增量构建实际房间图。

```typescript
// 两步调用 (NavService 消费 GMCP 后依次调用):
onMoveStart(dir: string)                    // 记录即将移动的方向 (在发命令前)
onRoomEntered(short: string, dir: string[]) // 进入新房间后: short=GMCP.short, dir=GMCP.dir
```

**节点身份确认优先级**：
1. GMCP.short 匹配先验层同名节点 + 出口集一致 → 高置信度
2. GMCP.short 匹配已构建图中节点 + 出口集一致 → 确认
3. 从已知节点通过唯一路径到达 → 确认
4. 语义指纹匹配 → 确认

### 语义层 — 房间解析 (SemanticLayer)

解析 look 命令输出，提取结构化房间特征。纯被动解析器 (不负责触发), 由 NavService 或外部调用方在适当时机调用。

**调用时机** (由外部决定，非本层职责):
- GMCP.Move 进入新房间且该房间名存在多个候选
- MHT 候选集 > 1
- 人工请求刷新
- 定期刷新（NPC/物品可能变化）

**解析策略 — 出口行锚点法**：找到出口行（匹配 `出口`/`exits` 关键词）作为锚点，向上扫描房间名+描述，向下扫描 NPC/物品列表。

### 定位模块 — 多假设追踪 (Localizer)

维护候选位置集合，持续收敛至唯一解。

**剪枝机制**（按成本递增）：

| 级别 | 方法 | 触发 | 成本 |
|------|------|------|------|
| 1 | GMCP.short 匹配 | 每次移动 | 零 (软信号: 名一致加分, 名冲突降权; 多候选时硬剪枝) |
| 2 | 出口集匹配 | GMCP.dir 比对候选出口 | 低 |
| 3 | 二级路径签名 | 候选集 > 1，图内预计算比对 | 中 |
| 4 | 语义指纹 | 候选集仍 > 1，look 提取 | 高 |
| 5 | 先验坐标 | 全部失败，软约束降权 | 软 |

**2 级路径签名**：不做网络操作。当图中某节点的 2 步邻居均已确认身份时，从图中预计算并缓存签名（2 步内可达的房间名 + 出口集序列）。MHT 消歧时直接比对。

**收敛判定**：候选集大小 === 1，或唯一候选置信度 > 阈值。

### 导航规划 (Navigator)

分片寻路：

```
plan(fromNodeId, target, targetSubMap?):
  1. 目标在当前子图 → 子图内 BFS → 逐步执行
  2. 目标在其他子图 →
     a. 查找路由: 当前子图边界 → [中间子图]* → 目标子图
     b. 每段: BFS 到 NODE → node walk → 到达下一子图
     c. 最后一段: BFS 到目标房间
```

**路径代价**：`1 + ambiguity_penalty + fence_penalty`

导航作为新工具 `mud_navigate` 供 agent 调用。

### 熔断与围栏 (FenceManager)

**触发条件**：候选集发散度（> 阈值）且已走步数（> 最小步数）。

**熔断行为**：冻结区域 → 原路返回 → 生成修正日志 → 路径规划屏蔽。

**解锁**：人工修正后重新纳入自动流程。

### 人工交互 (HumanInteractionManager)

处理算法不可解区域：图位吻合、歧义消解、数据修正、围栏解锁。

**弹窗形式**：WebUI modal dialog（参考 dsh 全局配置窗口样式）。TUI 降级为终端交互。

```typescript
interface HumanInteraction {
  type: 'confirm' | 'select' | 'fix'
  title: string
  description: string
  options?: Array<{ label: string; value: unknown }>
  callback: (answer: unknown) => void
}
```

**初始对齐流程**：
```
agent 登录 → MHT 为空
→ 弹窗: "请确认当前位置" [NODE 列表]
→ 人工选择: "信阳小广场"
→ MHT 初始化: 唯一候选 = xinyang:small_plaza
→ 后续自动定位
```

## 持久化

`MapStore` 接口定义持久化契约，当前为 JSON 文件实现（`JsonMapStore`），后续可切换 SQLite。

```typescript
interface MapStore {
  load(): Promise<MapSnapshot>
  save(snapshot: MapSnapshot): Promise<void>
}
```

## 服务接口

通过 `ctx.mud.map` 子服务暴露（见 `MudMapService`）。其中定位与导航核心能力
由 core 定义的结构契约 `MudMapCapability`（`@deepseek-ai/dsh-mud-core/extensions`）
约束, `MudMapService extends MudMapCapability` 为其超集实现。

**最小契约 (`MudMapCapability`, core 自治)**:

```typescript
interface MudMapCapability {
  position(): { resolved, subMap, nodeId, candidates }
  move(dir: string): boolean
  movePath(dirs: string[]): boolean
  setAnchor(subMapId: string, nodeId: string): boolean
  parseLook(roomId: string, text: string): { name, exits }
}
```

**完整服务 (`MudMapService extends MudMapCapability`)**:

```typescript
interface MudMapService extends MudMapCapability {
  rooms(): SubMapNode[]
  edges(): Edge[]
  importPrior(subMap: PriorSubMap): void
  fixNode(id: string, patch: Partial<SubMapNode>): void
  fences(): FenceRegion[]
  export(): MapSnapshot
  import(snapshot: MapSnapshot): void
  requestHuman(interaction: HumanInteraction): Promise<unknown>
}
```

## 构建流程

```
阶段 1: 离线准备
  人工提供子图 ASCII 文件 → prior-parser 解析 → PriorSubMap → JSON 文件

阶段 2: 人工辅助对齐
  agent 登录 → MHT 空 → 弹窗选择当前位置 NODE → MHT 初始化

阶段 3: 子图填充
  agent 探索 → GMCP.Move 构建几何层 → look 构建语义层 → 先验层交叉验证
  → 混淆 → 语义消歧 / 围栏 → 熔断回退 + 人工修正

阶段 4: 分片导航
  mud_navigate(target) → 同子图 BFS / 跨子图 NODE + node walk → 每步检查 MHT 收敛
```

## 当前状态

各模块实现程度不一：
- **完整实现**: `geometry` / `semantic` / `store` / `nav-service` / `localizer`（第 1、2 级剪枝 + 名字信号）
- **部分实现**: `navigator`（仅子图内 BFS, 跨子图路由待实现）、`fence`（判定可用, 熔断行为/路径屏蔽待实现）
- **骨架实现**: `human`（弹窗渲染待接入）
- **进行中 (未可用)**: `prior-parser` — 见下节「ASCII 解析器 — 当前状态」
- `ctx.mud.map` 服务经 `registerMap(nav.service)` 已接线可用（最小契约 `MudMapCapability` 全量满足）

### ASCII 解析器 — 当前状态

`prior-parser.ts` 处于**进行中、未完成、不可用**状态，**不得当作已完成使用**。

当前已落盘的实现（未经确认正确性）：
- 字符网格构建 + 归属矩阵
- 房间提取（name / 末尾数字拆 npcIds / 坐标锚点）
- 8 方向**直线几何追踪**连接 + 双向合并
- `[名称]` 边界标记扫描、`⊕` NODE 识别（判断待修）

已知问题（**必须修复后方可使用**）：
- 连接算法按「锚点 8 方向几何直线追踪」实现，**未遵循各 box-drawing 符号的真实语义**（`─ │ ╲ ╱ ╮ ╭ ╯ ╰ ＞ ⊕ ∧ ∨` 的连接形态/方向/与房间关系）。即便几何假设下的自洽测试有 5/8 通过，解析结果仍可能错误。
- 待人工逐符号确认后，重构字符识别与连接算法。
- 当前 8 个测试中 3 个失败（对角线方向断言、NODE 判断过严、端到端依赖前者），未修复不视为完成。

**此实现已暂停**：设计与实现中对 ASCII 各符号的意义理解有偏差，需先由设计者解释每个符号的实际含义，再据此修正解析器。在执行许可并修订之前，本解析器保持标记为「未完成」。

下一步按阶段实施：
- Phase 1: 探索记录器（图构建 + 基础 MHT + 持久化）—— **完成**
- Phase 2: 先验层解析（ASCII 解析器）—— **进行中（已暂停，待符号语义确认）**
- Phase 3: 定位与导航（完整剪枝 + 分片寻路 + mud_navigate）
- Phase 4: 熔断与人工交互
