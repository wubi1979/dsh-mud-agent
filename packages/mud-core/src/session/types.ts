/**
 * dsh-mud-core — 会话运行时类型与纯函数 (session/types).
 *
 * 从 `MudSessionRuntime` 抽出的**声明面**: 配置 / sink / 决策记录 / 状态 /
 * 投递动作请求的纯变换 (actionOf / fillSlots / parseDeliveryCallId) 与运行时
 * 常量。本模块无运行态, 供会话运行时与装配方 (index.ts) 共用。
 * @module @deepseek-ai/dsh-mud-core/session/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActivityEntry } from '../agent/tools-build.ts'
import type { DangerousRule } from '../agent/commands.ts'
import type { OwnedAction } from '../deliver/lane.ts'
import type { MudUiItem, MudWorldSnapshot } from '../shell/remote-types.ts'
import type { FlowState } from '../flow/flow-types.ts'
import type { FlowSpec } from '../flow/flow-spec.ts'
import type { WindowDiag } from '../agent/inflight.ts'

/** 一条待投递的动作请求 (与投递消息 `source.actions` 同形; §7)。 */
export type ActionRequest = OwnedAction

/** UI 条目输入 (host 补 seq/sessionId)。 */
export type MudUiItemInput = Omit<MudUiItem, 'seq' | 'sessionId'>

/**
 * 命令归属 (§10 的 actor 模型): `agent` = 模型/规则工具调用, `user` = 页面手打,
 * `system` = **登录流程**发出的命令 (凭据回显、退出 MXP 检测) —— 不受权限档位约束。
 */
export type CommandActor = 'agent' | 'user' | 'system'

/**
 * 登录流程的**收尾命令**（v0.4.0 起退役）：MXP 探测的"顶一下"与 `look` 现在是流程
 * `login` 的步骤（`mxp` 条件分支 + `look` 顺序步），不再由运行时发固定序列。
 * @deprecated 由 `flow/flows` 的 `LOGIN_FLOW` 声明取代（`doc/ARCHITECTURE.md` §11/§19）。
 */
export const DEFAULT_LOGIN_EXIT_COMMANDS: readonly string[] = []

/**
 * 引擎命中 → 待投递的动作请求 (`doc/ARCHITECTURE.md` §7)。
 * @param ruleId 来源规则 id。
 * @param action 规则声明的动作。
 * @returns 投递消息 `source.actions` 里的一项。
 */
export function actionOf(ruleId: string, action: { output: string; tool?: { name: string; args?: Record<string, unknown> } }): ActionRequest {
  return {
    ruleId,
    output: action.output,
    tool: { name: action.tool?.name ?? '', args: action.tool?.args ?? {} },
  }
}

/**
 * 用流程实例槽替换动作参数里的 `{槽名}`（`{captcha}` 等外部值仍留到发送瞬间插值）。
 *
 * `names` 是**声明的**槽名集合：未填的槽替换成空串（否则首次投递会把 `{lastFail}`
 * 字面发给工具）；不在集合里的占位符原样保留（外部值/凭据）。
 */
export function fillSlots(
  action: ActionRequest,
  slots: Readonly<Record<string, string>>,
  names: readonly string[],
): ActionRequest {
  if (names.length === 0) return action
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value
      for (const key of names) out = out.split(`{${key}}`).join(slots[key] ?? '')
      return out
    }
    if (Array.isArray(value)) return value.map(fill)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fill(v)]))
    }
    return value
  }
  return { ...action, tool: { name: action.tool.name, args: fill(action.tool.args) as Record<string, unknown> } }
}

/** 空的系统流程命令集 (直接执行动作不走登录流程判据; `loginFlow: false` 下不会被读)。 */
export const EMPTY_COMMANDS: ReadonlySet<string> = new Set<string>()

/**
 * 解析本插件的确定性 call-id（`mud-<delivery>-<index>`；§7 生成规则）。
 *
 * `delivery` 是槽位 id（形如 `d7`，字符集安全所以 slug === id）；T2 自己发起的工具调用用的是
 * provider 生成的 id（如 `call_abc`）→ 解析失败 ⇒ **永不可收束回合**（判据 B 的结构性保证）。
 * @param callId 工具调用 id。
 * @returns 解析结果；非本插件的 id 返回 null。
 */
export function parseDeliveryCallId(callId: string): { delivery: string; index: number } | null {
  const match = /^mud-(.+)-(\d+)$/.exec(callId)
  if (match === null) return null
  const delivery = match[1]
  const index = Number(match[2])
  if (delivery === undefined || !Number.isSafeInteger(index)) return null
  return { delivery, index }
}

/** 运行时投递到宿主的决策记录 (WebUI 决策栏 + 审计)。 */
export interface MudDecisionRecord {
  actor: 'rule' | 'router' | 'agent' | 'flow'
  ruleId?: string
  eventType?: string
  flow?: string
  action: string
  result?: string
  text: string
}

/**
 * 宿主接线: 运行时向宿主投递输出/日志, 并**只读**解析该会话的 live agent。
 * 实现方 (index.ts) 负责全局 seq、缓冲、WS 广播、落盘与 harness 审计。
 */
export interface MudRuntimeSink {
  /**
   * 官方路径解析: 该会话当前 live agent。由宿主用 `ctx.agents.get(sessionId)`
   * 实现 (已从注册表移除的 agent 返回 undefined)。
   */
  agentOf(sessionId: string): Agent | undefined
  /**
   * 可选: **确保**该会话的 agent 已解析 (官方 `sessionController.resolveAgent`
   * 路径 — 惰性创建/恢复; 已 live 则立即返回)。连接建立时用于"空回合翻 blank":
   * 新会话在首条用户消息前 agent 不存在, 必须经官方路径补一次解析。
   * @param sessionId 官方会话 id。
   * @returns 解析到的 live agent; 官方控制器不可用/解析失败 = undefined
   *   (调用方回落观察窗冲刷路径, 不自行创建 agent)。
   */
  resolveAgent?(sessionId: string): Promise<Agent | undefined>
  /**
   * 可选: 该会话是否**无内容** (官方 blank 判定同源: attached `session.seq === 0`,
   * 事件流为空)。用于"空回合翻 blank"的触发条件 —— 只有新建无内容会话才需要
   * 空回合; 已有历史的会话 blank 已翻 (官方回到历史会话自动渲染), 再发纯属
   * 多余的 finish stop 回合。查不到会话/实现缺失 = false (保守不发)。
   * @param sessionId 官方会话 id。
   * @returns 会话事件流是否为空。
   */
  sessionEmpty?(sessionId: string): boolean
  /**
   * 可选: 该会话的 agent **装配**是否就绪 (preset 模式下 = 官方 composition 已是
   * `mud-player`)。缺省视为就绪。
   *
   * 为什么需要它: preset 装配是异步的 (`agentPresets.select`), 而 agent 在
   * `agent/created` 时就已存在。若在这个窗口里投递, 第一批输出会跑在**旧组装**
   * (default preset) 上 —— 既没有 MUD 工具, 又让会话产出内容而使 preset 永久锁定
   * (官方只允许空白会话切换)。因此"agent 存在"不等于"可以投递"。
   * @param sessionId 官方会话 id。
   * @returns 装配是否就绪。
   */
  agentReady?(sessionId: string): boolean
  /**
   * 可选: 把**已解析好的验证码图片**推给宿主（`mud_captcha` 工具调用它）。
   *
   * 边界：解析（出站围栏 + 抓 `robot.php` + 取 `<img src>` + 归一绝对地址）在工具里做
   * （`network/captcha.ts`），宿主只负责"变成页面上的验证码对话框"。宿主需要
   * `robotUrl` 才能实现"刷新图片"（同一个 `robot.php` 页面每次抓都是新图）。
   * @param sessionId 来源会话。
   * @param push 图片地址 + 触发它的页面地址 + 可选的失败反馈文案（上一轮答错原文）。
   */
  captcha?(sessionId: string, push: {
    imageUrl: string
    robotUrl: string
    note?: string
  }): void
  /** 终端输出 (原始文本, 含 ANSI)。 */
  pushGame(sessionId: string, text: string): void
  /** UI 流条目 (日志/决策/验证码)。 */
  pushUi(sessionId: string, item: MudUiItemInput): void
  /** world 快照 (替换语义)。 */
  pushWorld(sessionId: string, world: MudWorldSnapshot): void
  /** 运行日志 (harness 审计 + 落盘 + WS 日志 tab)。 */
  log(sessionId: string, text: string): void
  /** 感知/网络调试日志。 */
  debug(sessionId: string, channel: 'network' | 'perception' | 'send' | 'runtime', text: string): void
  /** 决策记录。 */
  decision(sessionId: string, record: MudDecisionRecord): void
}

/** 运行时配置 (plugin config 的会话无关子集 + 服务器默认值)。 */
export interface MudRuntimeConfig {
  /**
   * agent 接入模式 (§19):
   * - `off`  = 暂停接入: 输出直推终端, 不投递、不唤醒;
   * - `t1`   = 仅 T1: 只有规则/流程驱动的确定性动作走 agent 管道, 其余行仅进终端;
   * - `t2`   = 仅 T2: 全部行进入 LLM 批次投递, T1 暂存动作丢弃留痕;
   * - `full` = 完整接入 (T1 + T2)。
   */
  agentMode: 'off' | 't1' | 't2' | 'full'
  /** 命令最小间隔 (节流)。 */
  commandIntervalMs: number
  /** 未声明请求超时。 */
  bridgeTimeoutMs: number
  /** 声明 (until) 请求超时。 */
  bridgeDeclaredTimeoutMs: number
  /** 网络装配粒度毫秒 (v0.6.0: 静默窗降级为分帧器装配阀 autoFlushMs, 非消费边界 §8.7)。 */
  bridgeSilenceMs: number
  /** 登录整体预算。 */
  loginTimeoutMs: number
  /** 断流阈值: 该时长无感知事件 → 唤醒 agent 主动决策 (仅已登录且已连接)。 */
  deadAirMs: number
  /** holdDelivery 暂缓投递的兜底释放时长 (捕获未完成且无新窗口时, 以 T2 投出)。 */
  holdTimeoutMs: number
  /** agent 系统提示区段文本 (persona/技能目录/命令参考)。 */
  persona: string
  /** 技能目录文本提供者 (每次 assembly 求值 — 技能变化即时生效)。 */
  skillsText: () => string
  commands: string
  /** 默认服务器 (connect 未给 host/port 时)。 */
  defaultHost: string
  defaultPort: number
  /** 危险命令策略表 (工具层硬边界; 默认取 `DEFAULT_DANGEROUS_COMMANDS`)。 */
  dangerous?: readonly DangerousRule[]
  /** 活动表 (§8; 缺省 `DEFAULT_ACTIVITY_TABLE`; 部署可整体覆盖)。 */
  activityTable?: readonly ActivityEntry[]
  /** 相邻两次 agent 工具调用的最小间隔毫秒 (0 = 不限速; 由 §10 闸门执行)。 */
  toolCallIntervalMs: number
  /**
   * **T2 投递最小间隔毫秒**（0 = 不限流；缺省取 `DEFAULT_T2_DELIVER_INTERVAL_MS`）。
   *
   * 限的是"给真实模型喂输入的节奏"（每次 T2 行动都要先收到一条投递），顺带把多个小批次
   * 合并成一个大批次。**只压 T2 批次**：T1 动作投递、帧内动作投递、控制消息都不受它影响。
   */
  t2DeliverIntervalMs?: number
  /**
   * 流程表 (`doc/ARCHITECTURE.md` §19; 缺省 `defaultFlows`)。
   * 只读声明 —— 每会话的流程实例状态在 `FlowRuntime` 里 (arming/挂起/打断/排队)。
   */
  flows?: readonly FlowSpec[]
}

/** 帧行数上限 (超限即提交 valve 帧, 不等下一标记, §8.6)。 */
export const MAX_SETTLE_LINES = 256

/** 事务窗口**注入**裁剪 (唯一裁剪职责: 只影响 T2 可见文本; 见 `doc/ARCHITECTURE.md` §5)。 */
export const MAX_INJECT_TAIL_LINES = 64
export const MAX_INJECT_TAIL_CHARS = 8_000

/** 无 agent 时待决行上限 (超限丢最旧并记日志; 等官方 agent/created 冲刷)。 */
export const MAX_PARKED_LINES = 512

/**
 * **T2 投递最小间隔的部署缺省**（毫秒；`Config.t2DeliverIntervalMs` 覆盖，0 = 不限流）。
 *
 * 实测：登录后 T2 接管，1 秒一条命令地刷查询（look/hp/score/skills）。`toolCallIntervalMs`
 * 压的是"每次调用"，压不住"被喂得太勤"；这一层直接把 T2 的**投递**节奏压住，天然把多个
 * 小批次合并成大批次。T1 通道完全不受影响。
 */
export const DEFAULT_T2_DELIVER_INTERVAL_MS = 2_000

/** 一次连接的会话状态 (status()/diag() 消费)。 */
export interface MudSessionStatus {
  sessionId: string
  connected: boolean
  state: 'idle' | 'connecting' | 'connected'
  host: string
  port: number
  accountName: string | null
}

/** 单会话诊断 (`MudSessionRuntime.diag()`; 不变量 I9 的观测面; host face 经 `MudDiag` 转发)。 */
export interface MudSessionDiag {
  sessionId: string
  connectionId: string | null
  connected: boolean
  /** 待决行数 (未投递; 正常应在 0 附近)。 */
  pending: number
  /** 待投递动作数 (规则命中 / 流程步动作; v0.4.0 取代命中队列)。 */
  actionsPending: number
  /** 活跃流程状态 (null = 空闲; §19: arming/挂起/打断/排队)。 */
  flow: FlowState | null
  /** 在途窗口表诊断 (W7.2 §2.9 取代旧桥活动表: 在途窗口/排队/人工等待/结局计数)。 */
  windows: WindowDiag
  /** 是否正在等**人工**验证码 (fullme): 等待期间投递与看门狗都暂停。 */
  awaitingHuman: boolean
  /** recall 缓冲行数。 */
  recall: number
  /** 该会话当前是否有官方 live agent (只读观测)。 */
  agent: boolean
  lastError: string | null
  /** 缺陷计数 (不变量 I9; 非零都应在日志里有对应 error 行)。 */
  counters: { hitsDropped: number; carryDropped: number; holdReleases: number }
}