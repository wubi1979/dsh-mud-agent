/**
 * dsh-mud-core — Trigger LLM types (trigger-llm/types).
 *
 * v6 触发器模型: 规则 = 捕获文本 (字面量/正则/颜色/guard/extract, 语义不变)
 * + action (确定性动作)。命中由级联 provider (mud-cascade) 的 T1 适配层
 * 渲染为与真实 LLM 同构的 assistant 输出; 无事件、无运行时状态机。
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

/** 感知规则 (配置来源, config/trigger-rules.ts)。 */
export interface PerceptionRule {
  id: string
  eventType?: string
  priority?: number
  multiline?: boolean
  greedy?: boolean
  contains?: readonly string[]
  regex?: readonly (string | RegExp)[]
  /** 多行: 有序条件列表 (Mudlet 逐条件状态机对齐)。省略时由 contains+regex 派生。
   *  仅 multiline=true 时起作用。 */
  patterns?: readonly MultiCond[]
  /** 多行: 首条件到末条件之间允许的最大间隔行数 (Mudlet mConditionLineDelta)。
   *  默认 MULTI_LINE_DELTA。 */
  lineDelta?: number
  /** 颜色触发: 指定后要求行内任一段 run 命中全部已指定通道。与 contains/regex 为 AND。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: { rows: import('../preprocess/ansi.ts').MudLine[] }) => boolean
  extract?: (record: { rows: import('../preprocess/ansi.ts').MudLine[] }) => Record<string, unknown> | null
  /** 命中动作 (v6: 规则携带的确定性动作; 无 action 的命中视同未命中)。 */
  action?: ActionSpec
  /** 规则通道 (v6.1): 'state' = 预处理层预匹配折叠入库; 'event' = agent 内 T1 渲染 (缺省)。 */
  lane?: TriggerLane
}