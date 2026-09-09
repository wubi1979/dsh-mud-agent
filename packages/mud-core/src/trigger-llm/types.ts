/**
 * dsh-mud-core — Trigger LLM types (trigger-llm/types).
 *
 * v6.5 触发器模型: 规则 = 锚定整行正则 (准入唯一判据) + 命名捕获组
 * (提取默认通道, map/numeric 声明式组装 data) + action (确定性动作)。
 * extract 保留为逃生舱 (二次颜色等必须跑代码的复杂提取; 常规规则禁用)。
 * 命中由 T1 本地模拟适配器 (mud-t1) 渲染为与真实 LLM 同构的 assistant
 * 输出; 无事件、无运行时状态机。
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
}

/** 规则通道 (v6.1): 预匹配折叠与 agent 内 T1 渲染的分流属性。
 *  - 'state'  状态/观察类: 预处理层预匹配 → 命中行折叠入库 (extract 产物 applyPatch),
 *             不进 agent、不进 T1。action 承担「占位描述」角色, tool.args 可省略。
 *  - 'event'  事件/决策类 (缺省): 进 agent, 由级联 provider T1 渲染 action。 */
export type TriggerLane = 'state' | 'event'

/** 控制消息前缀: host 主动唤醒 (断流/诊断等) 的 user 消息以此开头。
 *  T1 视其为非游戏输出 (NO_ANSWER 交 T2); T2 借此前缀区分系统提示与游戏文本。 */
export const CONTROL_PREFIX = '[系统] '

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

/** 准入判据 (三种匹配类型, 由 service 分派到对应匹配器)。
 *  - regex: 锚定整行正则 (作者书写 `^…$`); multiline 时派生为逐条件状态机。
 *    预筛 seed 由字面前缀自动推导。
 *  - text:  字面子串 (includes 任一命中); includes 本身即预筛。适合高特异性
 *    短语 —— MUD 聊天/帮助文本嵌词误触发风险由规则作者保证 (v6.5 教训)。
 *  - func:  函数谓词 (每行调用, 返回 true 即命中); 无预筛全量跑 (规则总量小,
 *    代价可忽略)。承载正则表达不了的结构判定。 */
export type MatchSpec =
  | { kind: 'regex'; patterns: readonly (string | RegExp)[] }
  | { kind: 'text'; includes: readonly string[] }
  | { kind: 'func'; test: (line: import('../preprocess/ansi.ts').MudLine) => boolean }

/** 命中窗口声明 (单行规则; multiline 状态机的行序列本身就是窗口, 不支持)。
 *  单行命中时装配锚点行前后的**批内**上下文供 extract 复合提取 (房间抓取等):
 *  before/after 均为批内尽力 (跨批不追, 丢弃); 折叠移除只针对锚点行,
 *  窗口行照常进 agent (结构化提取与 agent 自理解两份信息并存)。 */
export interface WindowSpec {
  /** 锚点行之前最多回看的行数 (本批内)。 */
  before: number
  /** 锚点行之后最多前看的行数 (本批内, 批尾即止)。 */
  after: number
}

/** 命中记录 (guard/extract 的入参)。
 *  单行命中 rows=[锚点行]; multiline 命中 rows=条件命中行序列;
 *  声明 window 的单行规则额外装配 before/after (批内切片, 升序, 不含锚点行;
 *  未声明或切片为空时为空数组)。 */
export interface PerceptRecord {
  rows: import('../preprocess/ansi.ts').MudLine[]
  before: import('../preprocess/ansi.ts').MudLine[]
  after: import('../preprocess/ansi.ts').MudLine[]
}

/** 感知规则命中结果。 */
export interface PerceptHit {
  id: string
  eventType: string
  /** 锚点行 (单行 = 命中行; multiline = 完成行)。排序/留痕用。 */
  lineNumber: number
  /** 需折叠移除的行 (abs)。v6.6 折叠语义:
   *  - multiline: 全部被捕获的条件行 (行序列即窗口, 整段折叠);
   *  - 单行 regex/text: 仅锚点行 (声明 window 的窗口行不折叠, 照常进 agent);
   *  - 单行 func: 不折叠 (空数组) — 房间抓取类复合提取, 全部行进 agent。
   *  装配方按此集过滤, 未声明的命中 (event 桶) 不使用。 */
  foldLines: number[]
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
 *  准入语义 (v6.6): 判据 = MatchSpec 三种匹配类型 (regex 锚定整行 / text 字面
 *  子串 / func 函数谓词), 分派到对应匹配器; 旧 `regex` 平铺与 `contains` 已废。 */
export interface PerceptionRule {
  id: string
  eventType?: string
  priority?: number
  /** 多行逐条件状态机 (仅 match.kind='regex' 合法)。 */
  multiline?: boolean
  greedy?: boolean
  /** 准入判据 (三种匹配类型之一, 必填)。 */
  match: MatchSpec
  /** 捕获组 → world 点分键: 命中后由首个匹配正则的命名捕获组组装 hit.data
   *  (仅 kind='regex' 有捕获组)。extract 逃生舱优先级更高 (存在即覆盖);
   *  map 缺失则 data 为 null。 */
  map?: Record<string, string>
  /** 需数值化的捕获组名 (去千分位逗号 [,，] → Number; 无法解析则保留原串)。 */
  numeric?: readonly string[]
  /** 多行: 有序条件列表 (Mudlet 逐条件状态机对齐)。省略时由 regex 派生
   *  (每个 regex 为一个逐行条件)。仅 multiline=true 时起作用。 */
  patterns?: readonly MultiCond[]
  /** 多行: 首条件到末条件之间允许的最大间隔行数 (Mudlet mConditionLineDelta)。
   *  默认 MULTI_LINE_DELTA。 */
  lineDelta?: number
  /** 颜色触发: 指定后要求行内任一段 run 命中全部已指定通道。与 match 为 AND。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: PerceptRecord) => boolean
  /** 逃生舱提取 (v6.5): 复合/跨行提取 (房间抓取等必须跑代码的提取) 使用;
   *  命中后调用, 返回非 null 时覆盖捕获组组装结果。常规规则禁用。 */
  extract?: (record: PerceptRecord) => Record<string, unknown> | null
  /** 命中窗口声明 (仅单行规则; multiline 不支持 — 构造时报错)。 */
  window?: WindowSpec
  /** 命中动作 (v6: 规则携带的确定性动作; 无 action 的命中视同未命中)。 */
  action?: ActionSpec
  /** 规则通道 (v6.1): 'state' = 预处理层预匹配折叠入库; 'event' = agent 内 T1 渲染 (缺省)。 */
  lane?: TriggerLane
}