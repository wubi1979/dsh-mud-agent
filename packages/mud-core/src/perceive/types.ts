/**
 * dsh-mud-core — 感知契约 (perceive/types): 机制层形状 + 策略层投影。
 *
 * 机制层形状 (引擎只认识 `MatcherRule<TAction>` 与 `MatchHit<TAction>`):
 * 引擎做**两段式匹配** (预筛 + 准入提取, 含多行 Mudlet 逐条件状态机) 与命中
 * 产出, 不理解 action 语义。
 *
 *   匹配两段式:
 *     - 预筛 (候选集): 由规则锚定正则的**字面前缀**自动推导 (seed), 只缩候选,
 *       绝不判"不命中"; 无字面前缀的规则全量跑 (规则少, 代价可忽略)。
 *     - 准入+提取: 锚定整行正则 .test (mandatory) → 首个匹配正则的命名捕获组
 *       → map 组装 data (numeric 数值化); extract 逃生舱覆盖。
 *   v6.7: 命中 = 主判据(regex/text/func) ∧ color(声明时) ∧ guard; extract 只做
 *   准入后的程序化提取, 不参与准入。
 *
 * 策略层投影 (`PerceptionRule` = `MatcherRule<ActionSpec>` 超集, 追加 `lane`
 * 通道与 `holdDelivery` 投递原子性声明; `PerceptHit` = `MatchHit<ActionSpec>`):
 *
 *   - `ActionSpec` / `TriggerLane` / `CONTROL_PREFIX` = 策略层的动作/通道语义。
 *
 * 准入语义 (v6.6): 判据 = MatchSpec 三种匹配类型; 命中由 T1 本地模拟适配器
 * (mud-t1) 渲染为与真实 LLM 同构的 assistant 输出; 无事件、无运行时状态机。
 * @module @deepseek-ai/dsh-mud-core/perceive/types
 */

import type { MudLine } from '../network/ansi.ts'

// ── 机制层形状 (匹配引擎契约) ──────────────

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
  captures: { text: string; abs: number; row: MudLine }[]
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

/** 准入判据 (三种匹配类型, 由引擎分派到对应匹配器)。
 *  - regex: 锚定整行正则 (作者书写 `^…$`); multiline 时派生为逐条件状态机。
 *    预筛 seed 由字面前缀自动推导。
 *  - text:  字面子串 (includes 任一命中); includes 本身即预筛。适合高特异性
 *    短语 —— MUD 聊天/帮助文本嵌词误触发风险由规则作者保证 (v6.5 教训)。
 *  - func:  函数谓词 (每行调用, 返回 true 即命中); 无预筛全量跑 (规则总量小,
 *    代价可忽略)。承载正则表达不了的结构判定。 */
export type MatchSpec =
  | { kind: 'regex'; patterns: readonly (string | RegExp)[] }
  | { kind: 'text'; includes: readonly string[] }
  | { kind: 'func'; test: (line: MudLine) => boolean }

/** 命中窗口声明 (单行规则; multiline 状态机的行序列本身就是窗口, 不支持)。
 *  单行命中时装配锚点行前后的**批内**上下文供 extract 复合提取 (房间抓取等):
 *  before/after 均为批内尽力 (跨批不追, 丢弃); 窗口只服务于**提取**, 不改变行流 ——
 *  锚点行与窗口行一律照常进行流 (W10.3: 无折叠、无隐藏行)。 */
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
export interface MatchRecord {
  rows: MudLine[]
  before: MudLine[]
  after: MudLine[]
}

/**
 * **规则加载端口** (引擎只消费这个形状): 策略面 `PerceptionRule` 是其超集投影,
 * `TAction` = 命中动作的泛占位 (策略层传 `ActionSpec` 等)。
 *
 * 准入语义 (v6.6): 判据 = MatchSpec 三种匹配类型 (regex 锚定整行 / text 字面
 * 子串 / func 函数谓词), 分派到对应匹配器; 旧 `regex` 平铺与 `contains` 已废。
 */
export interface MatcherRule<TAction = unknown> {
  id: string
  eventType?: string
  priority?: number
  /** 多行逐条件状态机 (仅 match.kind='regex' 合法)。 */
  multiline?: boolean
  greedy?: boolean
  /** 准入唯一判据 (regex/text/func 三种之一, 必填); color 只作命中后的补充
   *  判定、extract 只作命中后的程序化提取 —— 二者不参与准入 (v6.7)。 */
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
  /** 颜色触发 (命中后的补充判定, 不单独准入): 主判据命中后, 要求行内任一段
   *  run 命中全部已指定通道 (与 match 为 AND; 同词异色区分用)。 */
  fg?: number | null
  bg?: number | null
  fgTrue?: [number, number, number] | null
  bgTrue?: [number, number, number] | null
  guard?: (record: MatchRecord) => boolean
  /** 准入后的程序化提取 (v6.5 逃生舱; 不参与准入): 复合/跨行提取 (房间抓取等
   *  必须跑代码的提取) 使用; 命中后调用, 返回非 null 时覆盖捕获组组装结果。
   *  常规规则禁用。 */
  extract?: (record: MatchRecord) => Record<string, unknown> | null
  /** 命中窗口声明 (仅单行规则; multiline 不支持 — 构造时报错)。 */
  window?: WindowSpec
  /** 命中动作 (泛占位; 引擎原样透传给命中, 语义由策略层定义)。 */
  action?: TAction
}

/** 通用命中结果 (引擎产出; 策略面投影为 `PerceptHit`)。 */
export interface MatchHit<TAction = unknown> {
  id: string
  eventType: string
  /** 锚点行 (单行 = 命中行; multiline = 完成行)。排序/留痕用。 */
  lineNumber: number
  data: Record<string, unknown> | null
  reason?: string
  /** 命中规则携带的动作 (泛占位; 无 action 时缺省)。 */
  action?: TAction
}

// ── 策略层投影 (感知规则与动作语义) ──────────────

/** 动作描述 (规则命中 → 确定性渲染)。 */
export interface ActionSpec {
  /** 渲染给 agent 会话的确定性文本 (自由文本; 模板已由装配方渲染)。 */
  output: string
  /** 可选工具调用: 渲染为一个 tool-call 块, 由 loop 官方工具管道执行。 */
  tool?: { name: string; args: Record<string, unknown> }
  /** 声明应答边界 (命令-应答桥, `doc/ARCHITECTURE.md` §8): 应答文本命中该正则才结算
   *  (判据上收为分帧器武装标记, 跨帧累积)。用于慢命令/多帧应答 (打坐 dz、验证码 fullme 等),
   *  否则动作保持 GA/EOR 主边界结算 (八成缺省)。缺省: 未声明。 */
  until?: { regex: string | RegExp; timeout?: number }
  /**
   * 该动作的参数含**必须由外部补齐**的占位符 (如 `fullme {captcha}` 里的 `captcha`)。
   *
   * 语义: 命中**先挂起**, 不立即渲染 —— 装配方把命中存进"待人工"槽, 等外部值到位
   * (人工在页面输入验证码) 再补进命中队列交给 T1 渲染。用于 fullme 这类"由 T1 回答、
   * 但答案来自人工"的流程 (`doc/ARCHITECTURE.md` §11)。
   */
  awaitExternal?: readonly string[]
  /**
   * **直接执行** (无状态、无需返回的触发): 命中由运行时**自己执行动作**, 不投递给 agent。
   *
   * 语义 = 触发器层的**纯反射**: 动作的工具调用由运行时立即执行 (`mud_send` 入队即走,
   * **不等应答**; `world_patch` 直接落库), 归属 actor `system` —— 不受权限档位可见性
   * 约束 (它不是模型的动作), 但危险命令硬边界照旧 (`ask` 无审批通道 = 拒绝)。
   *
   * **不改变行流**(W10.3): 命中行与应答行照常作为普通行进行流 (→ T2 批次) —— 不折叠、
   * 不消费、不推水位、不开在途窗口; 直发只是"顺带把命令发出去", 不向行流记账。
   *
   * 适用: `save` 提醒 → 发 `save`; 分页提示 → 发翻页命令 —— 都是"照做即可"的反射,
   * 让它们绕开 agent 省一个 T1 回合。不适用: 需要模型判断的动作 (登录分支、fullme 答案)。
   */
  direct?: boolean
  /**
   * **打断档位**（纯数字，越大越强；缺省 = 不参与打断/排队，见 §19.4 与 I14）。
   *
   * 语义: 只在该规则命中、且**有流程实例正在挂起**时起作用 ——
   *   - `interrupts > 流程 priority` ⇒ **打断**：挂起的工具调用当场结算为
   *     `interrupted`（拿到可读原因）、流程复位（只留入口）、流程声明的
   *     `onInterrupt` 直发、本规则的动作照常投递（走官方工具路径）；
   *   - 声明了但档位不够 ⇒ **排队**：动作排队等流程结束（终态/失败）后立即执行；
   *   - 未声明（缺省）⇒ 不打断也不排队：动作照常投递给 T1（`direct` 动作直发，
   *     直发命令在窗口开启期延后到结算后再发 —— 直发延后 gate，I12/§8.3）。
   *
   * 基准档位: `normal = 100`；login = 1000（不可打断）；fullme = 100（战斗/生存类可打断）。
   */
  interrupts?: number
}

/** 规则通道 (v6.1): 状态抓取与 agent 内 T1 渲染的分流属性。
 *  - 'state'  状态/观察类: 预处理层预匹配 → **抽取产物同步 world** (applyPatch),
 *             不进 agent、不进 T1。**独立桶**: 不折叠内容、不消费行、不推水位
 *             (W10.3) —— 命中行照常作为普通行进行流。action 承担「占位描述」角色,
 *             tool.args 可省略。
 *  - 'event'  事件/决策类 (缺省): 进 agent, 由级联 provider T1 渲染 action。 */
export type TriggerLane = 'state' | 'event'

/** 控制消息前缀: host 主动唤醒 (断流/诊断等) 的 user 消息以此开头。
 *  T1 视其为非游戏输出 (渲染收束, 不误判成规则命中); 所有权注入 (lane=t2) 让
 *  T2 借此前缀区分系统提示与游戏文本。 */
export const CONTROL_PREFIX = '[系统] '

/**
 * 感知规则 (配置来源, perceive/rules.ts)。策略面: 机制层 `MatcherRule` 的超集。
 */
export type PerceptionRule = MatcherRule<ActionSpec> & {
  /** 规则通道 (v6.1): 'state' = 预处理层状态抓取入库 (独立桶, 不折叠不消费); 'event' = agent 内 T1 渲染 (缺省)。 */
  lane?: TriggerLane
  /**
   * 投递原子性 (仅对 `multiline` 有意义): 该规则捕获**未完成**时暂缓本窗口投递,
   * 不让"半截事务"落到真实 LLM (否则 LLM 可能对残缺形态自己动手, 随后规则又答一次)。
   * 暂缓的行与"完成/放弃捕获"的那个窗口合并成**一条**消息投出 (有命中 → T1, 否则 T2);
   * 无后续窗口时由 holdTimeoutMs 兜底释放。
   */
  holdDelivery?: boolean
}

/** 感知规则命中结果 (策略面投影: MatchHit 带 ActionSpec 动作)。 */
export type PerceptHit = MatchHit<ActionSpec>

/** 一次规则命中 + 其动作 (适配层渲染输入; 装配方过滤出带 action 的命中)。 */
export interface TriggerAction {
  hit: PerceptHit
  action: ActionSpec
}
