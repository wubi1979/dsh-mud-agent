/**
 * dsh-mud-core — 感知策略类型 (perceive/types): 策略面对匹配契约的投影。
 *
 * 匹配契约 (`services/matcher/types`) 是机制层 (引擎只认识 `MatcherRule<TAction>`
 * 与 `MatchHit<TAction>`); 本模块定义**策略层**语义:
 *
 *   - `PerceptionRule` = `MatcherRule<ActionSpec>` 超集 (追加 `lane` 通道与
 *     `holdDelivery` 投递原子性声明);
 *   - `PerceptHit` = `MatchHit<ActionSpec>` (命中动作即策略动作);
 *   - `ActionSpec` / `TriggerLane` / `CONTROL_PREFIX` = 策略层的动作/通道语义。
 *
 * 准入语义 (v6.6): 判据 = MatchSpec 三种匹配类型; 命中由 T1 本地模拟适配器
 * (mud-t1) 渲染为与真实 LLM 同构的 assistant 输出; 无事件、无运行时状态机。
 * @module @deepseek-ai/dsh-mud-core/perceive/types
 */

import type { MatchHit, MatcherRule } from '../services/matcher/types.ts'

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
   * 语义 = "类似 state 桶": 命中行**折叠**(不进 agent), 动作的工具调用由运行时立即执行
   * (`mud_send` 入队即走, **不等应答**; `world_patch` 直接落库), 归属 actor `system`
   * —— 不受权限档位可见性约束 (它不是模型的动作), 但危险命令硬边界照旧
   * (`ask` 无审批通道 = 拒绝)。
   *
   * 适用: `save` 提醒 → 发 `save`; 分页提示 → 发翻页命令 —— 都是"照做即可"的反射,
   * 让它们绕开 agent 既省一个 T1 回合, 也避免"帧内命中等不到回合而被丢掉"
   * (`doc/ARCHITECTURE.md` §7/§18.12)。不适用: 需要模型判断的动作 (登录分支、fullme 答案)。
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

/** 规则通道 (v6.1): 预匹配折叠与 agent 内 T1 渲染的分流属性。
 *  - 'state'  状态/观察类: 预处理层预匹配 → 命中行折叠入库 (extract 产物 applyPatch),
 *             不进 agent、不进 T1。action 承担「占位描述」角色, tool.args 可省略。
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
  /** 规则通道 (v6.1): 'state' = 预处理层预匹配折叠入库; 'event' = agent 内 T1 渲染 (缺省)。 */
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