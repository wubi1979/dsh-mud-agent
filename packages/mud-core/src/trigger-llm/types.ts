/**
 * dsh-mud-core — Trigger LLM types (trigger-llm/types).
 *
 * v6.5 触发器模型: 规则 = 锚定整行正则 (准入唯一判据) + 命名捕获组
 * (提取默认通道, map/numeric 声明式组装 data) + action (确定性动作)。
 * extract 保留为逃生舱 (二次颜色等必须跑代码的复杂提取; 常规规则禁用)。
 * 命中由级联 provider (mud-cascade) 的 T1 适配层渲染为与真实 LLM 同构的
 * assistant 输出; 无事件、无运行时状态机。
 *
 * 匹配两段式:
 *   - 预筛 (候选集): 由规则锚定正则的**字面前缀**自动推导 (seed), 只缩候选,
 *     绝不判"不命中"; 无字面前缀的规则全量跑 (规则少, 代价可忽略)。
 *   - 准入+提取: 锚定整行正则 .test (mandatory) → 首个匹配正则的命名捕获组
 *     → map 组装 data (numeric 数值化); extract 逃生舱覆盖。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/types
 */

/** 动作描述 (规则命中 → 确定性渲染)。 */
export interface ActionSpec {
  /** 渲染给 agent 会话的确定性文本 (自由文本; 模板已由装配方渲染)。 */
  output: string
  /** 可选工具调用: 渲染为一个 tool-call 块, 由 loop 官方工具管道执行。 */
  tool?: { name: string; args: Record<string, unknown> }
  /** 防御直连: 不走 agent loop、绕过工具管道直接发给游戏 (仅装配方使用)。 */
  send?: string | readonly string[]
}

/** 规则通道 (v6.1): 预匹配折叠与 agent 内 T1 渲染的分流属性。
 *  - 'state'  状态/观察类: 预处理层预匹配 → 命中行折叠入库 (extract 产物 applyPatch),
 *             不进 agent、不进 T1。action 承担「占位描述」角色, tool.args 可省略。
 *  - 'event'  事件/决策类 (缺省): 进 agent, 由级联 provider T1 渲染 action。 */
export type TriggerLane = 'state' | 'event'

/** 级联瀑布阶段 (v6.3 瀑布数组; 配置容器在 agent-bridge, 每次调用重读, 无热拔插)。
 *  - 'trigger' 确定性触发级: matchLines 命中 → 渲染动作并返回 (内容级去重保留);
 *  - 'model'   显式模型级: 走 llm.prepareCall({provider, model}); prepareCall 拒绝
 *              或首块 finish{error|aborted} 为硬失败 → 交棒下一级; 其余 commit。
 *  enabled: false 时本阶段跳过。数组耗尽后一律落到尾部默认级 (DSH 默认配置)。 */
export type CascadeStage =
  | {
      id: string
      kind: 'trigger'
      lane: 'event'
      /** false → 本阶段跳过。 */
      enabled?: boolean
    }
  | {
      id: string
      kind: 'model'
      provider: string
      model: string
      /** false → 本阶段跳过。 */
      enabled?: boolean
    }

/** 颜色触发条件 (Mudlet 颜色触发对齐): 与 style run 逐段匹配。 */
export interface ColorCond {
  /** 前景 256 色索引; 指定 null 表示"匹配默认前景" (Mudlet scmDefault)。 */
  fg?: number | null
  /** 背景 256 色索引; 指定 null 表示"匹配默认背景" (Mudlet scmDefault)。 */
  bg?: number | null
  /** 真彩前景 (优先级高于 fg)。 */
  fgTrue?: [number, number, number] | null
  /** 真彩背景 (优先级高于 bg)。 */
  bgTrue?: [number, number, number] | null
}

/**
 * 多行触发条件 (Mudlet 对齐): 逐条件顺序状态机, 每个条件匹配**单一行**,
 * 而非把多行拼成一段文本做正则 (Mudlet 的多行是逐条件状态机, 见
 * TTrigger::updateMultistates / TMatchState)。
 */
export type MultiCond =
  | { kind: 'substring'; text: string }
  | { kind: 'regex'; regex: string | RegExp }
  /** 行间间隔: 距上一条件需隔 lines 行 (Mudlet REGEX_LINE_SPACER / lineSpacer)。 */
  | { kind: 'spacer'; lines: number }

/** 多行首条件到末条件默认最大间隔行数。 */
export const MULTI_LINE_DELTA = 100

/** 多行匹配状态机的一个活跃实例 (Mudlet TMatchState 对齐)。 */
export interface MultiMatchState {
  /** 下一个待匹配条件下标 (首条件已在创建时消费)。 */
  next: number
  /** 自状态创建以来的行数 (超 lineDelta 即过期)。 */
  lineCount: number
  /** 当前处于 spacer 条件时已等待的行数。 */
  spacerCount: number
  /** 各条件命中的捕获 (按条件顺序)。 */
  captures: { text: string; abs: number; row: import('../preprocess/ansi.ts').MudLine }[]
}

/**
 * 匹配上下文 (承载运行态, 从规则定义中分离)。
 * 每个 TriggerMatchService 实例维护独立的上下文。
 */
export interface MatchContext {
  /** 多行状态机活跃实例 (按规则 id 管理)。 */
  multiStates: Map<string, MultiMatchState[]>
  /** 各规则已喂入的最大行号 (防重复推进)。 */
  multiLastAbs: Map<string, number>
}

/** 创建空的匹配上下文。 */
export function createMatchContext(): MatchContext {
  return {
    multiStates: new Map(),
    multiLastAbs: new Map(),
  }
}

/** 感知规则命中结果。 */
export interface PerceptHit {
  id: string
  eventType: string
  lineNumber: number
  data: Record<string, unknown> | null
  reason?: string
  /** 命中规则携带的动作 (v6; 无 action 时缺省)。装配方据此渲染确定性动作。 */
  action?: ActionSpec
}

/** 一次规则命中 + 其动作 (适配层渲染输入; 装配方过滤出带 action 的命中)。 */
export interface TriggerAction {
  hit: PerceptHit
  action: ActionSpec
}

/** 感知规则 (配置来源, config/trigger-rules.ts)。
 *  准入语义 (v6.5): 匹配判据唯一收敛于 `regex` (锚定整行 `^…$`, 由作者书写);
 *  `contains` 已废弃 (宽松 includes 在 MUD 聊天/帮助文本中易误触发)。 */
export interface PerceptionRule {
  id: string
  eventType?: string
  priority?: number
  multiline?: boolean
  greedy?: boolean
  /** 准入唯一判据: 正则数组, 命中任一即触发 (作者自写首尾锚定 `^…$`)。
   *  multiline=true 时逐行测试并派生为有序条件。 */
  regex?: readonly (string | RegExp)[]
  /** 捕获组 → world 点分键: 命中后由首个匹配正则的命名捕获组组装 hit.data。
   *  extract 逃生舱优先级更高 (存在即覆盖); map 缺失则 data 为 null。 */
  map?: Record<string, string>
  /** 需数值化的捕获组名 (去千分位逗号 [,，] → Number; 无法解析则保留原串)。 */
  numeric?: readonly string[]
  /** 多行: 有序条件列表 (Mudlet 逐条件状态机对齐)。省略时由 regex 派生
   *  (每个 regex 为一个逐行条件)。仅 multiline=true 时起作用。 */
  patterns?: readonly MultiCond[]
  /** 多行: 首条件到末条件之间允许的最大间隔行数 (Mudlet mConditionLineDelta)。
   *  默认 MULTI_LINE_DELTA。 */
  lineDelta?: number
  /** 颜色触发: 指定后要求行内任一段 run 命中全部已指定通道。与 regex 为 AND。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: { rows: import('../preprocess/ansi.ts').MudLine[] }) => boolean
  /** 逃生舱提取 (v6.5): 仅二次颜色等必须跑代码的复杂提取使用; 命中后调用,
   *  返回非 null 时覆盖捕获组组装结果。常规规则禁用。 */
  extract?: (record: { rows: import('../preprocess/ansi.ts').MudLine[] }) => Record<string, unknown> | null
  /** 命中动作 (v6: 规则携带的确定性动作; 无 action 的命中视同未命中)。 */
  action?: ActionSpec
  /** 规则通道 (v6.1): 'state' = 预处理层预匹配折叠入库; 'event' = agent 内 T1 渲染 (缺省)。 */
  lane?: TriggerLane
}