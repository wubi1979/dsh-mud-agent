/**
 * mud-core3 — 宿主插件入口（cordis 插件）。
 *
 * C3/C4 宿主接线：把纯 TS 层（service/runtime/roster/store/accounts/deliver/log）接到
 * 宿主事件、remote 通道、持久化与凭据域。
 *
 * 职责：
 *   - 名册（服务器/账号）落宿主 storage 域（不可用时降级内存，日志点名）
 *   - remote.mud.* 动词：servers/accounts CRUD、connect/disconnect、admit/stop、status、logs
 *   - agent/created → 名册判定 → service.register + 记录 agent 句柄 + 补投保留批次
 *   - agent/disposed → 移除 agent 句柄
 *   - session/disposed → service.dispose（断连 + 拆 runtime + 拆 deliverer + 拆日志）
 *   - llm/stream 瀑布终审：未接入账号会话的模型调用拦成空 stop 流（llm-gate.ts）
 *   - 投递回调：deliver(sessionId, text) → agent.followup(createUserMessage(...))
 *   - ctx.provide('mudCore3', { runtimeFor })；插件卸载 → service.disposeAll
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包构建产物 lib/index.js。
 *
 * @module mud-core3
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 宿主事件类型增强（agent/created、session/disposed、llm/stream 等）。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'

import {
  MudService, sessionNotRegistered, statusRowOf,
  DEFAULT_CAPTCHA_TIMEOUT_MS,
  type CaptchaFrame, type StatusRow,
} from './service.ts'
import type { SessionRuntime } from './runtime.ts'
import type { MudCore3Handle } from './tools.ts'
import { MAX_TIMEOUT_MS } from './tools.ts'
// 流程实体（数据归 core3；mud-workflow 是纯架构）。type-only：词汇表类型引用
// 走契约子路径（A1 契约层单点）。
import type { WorkflowRecord } from 'mud-workflow/contract'
import { login } from './flows/login.ts'
import { fullme } from './flows/fullme.ts'
import type { SessionLogOptions } from './log/log-service.ts'
import { resolveLogDir, purgeSessionLogs } from './log/log-service.ts'
// Remote 边界类型从非根子路径取（typert 要求，见 src/types.ts）。
import type { AccountRecord, GameFrame, LogEntry, ServerRecord } from './types.ts'
import type { DelivererConfig } from './deliver.ts'
import type { ClassifyRuleSpec } from './classify.ts'
import type {
  CredentialResolver, ResolvedCredentials, RosterStore,
} from './roster.ts'
import { MemoryRosterStore, openDomainRosterStore, type HostStorageDomain } from './store.ts'
import { Wake, DEFAULT_TASK_BRIEF, fillTaskBrief } from './wake.ts'
import { shouldVeto, vetoStopStream } from './llm-gate.ts'
import {
  addAccount as writeAccount, addServer as writeServer, removeAccount as dropAccount,
  removeServer as dropServer, setAdmitted, renameAccount, setCombatAuto as writeCombatAuto,
} from './accounts.ts'
// T18.2：会话上下文的进程级收口（表面遮蔽）。判定/适配在纯层 elide.ts，这里只做归属与阻断接线。
import { applyElision, processEpoch } from './elide.ts'
import type { ElisionSession } from './elide.ts'
import { DEFAULT_STAMINA_FLOOR_PCT } from './nav/stamina.ts'
import { NavService } from './nav/service.ts'
import { createJsonNavStore } from './nav/json-store.ts'

/** 插件名。 */
export const name = 'mud-core3'

/** 必需服务：typert 注册表（remote 命名空间注册）。 */
export const inject = ['typert']

/** 插件配置。 */
export interface MudCore3Config {
  /**
   * 凭据解析器覆盖（缺省接宿主 `ctx.get('credentials').resolve`）。
   * 只给测试/特殊部署用；常规则留空走宿主凭据域。
   */
  resolveCreds?: CredentialResolver
  /** 投递静默窗口毫秒。缺省 500ms。 */
  deliverQuietMs?: number
  /** 批次最长等待毫秒：行流持续不静默时也在此上限内投出。缺省 3000ms。 */
  deliverMaxWaitMs?: number
  /** 单条投递最大行数（超出拆成多条）。缺省 50。 */
  deliverMaxLines?: number
  /** 单条投递最大字符数（超出拆成多条）。缺省 8000。 */
  deliverMaxChars?: number
  /** 每会话录制缓冲上限行数（未接入期间保留的最近行数）。缺省 2000。 */
  recordLines?: number
  /** 画面通道 scrollback 行数（snapshot 回放深度）。缺省 2000（对齐录制缓冲）。 */
  viewScrollback?: number
  /** 画面通道列数（固定，不做 resize 回传）。缺省 120（§5.3）。 */
  viewCols?: number
  /** 画面通道单 follower 缓冲上限字节（超限显式断流，重连恢复）。缺省 2MB。 */
  viewMaxBufferedBytes?: number
  /** 副屏行环上限（按有标行条数计，超限丢最旧；C5.2）。缺省 1000。 */
  viewSubCap?: number
  /**
   * 行分类规则清单（C5.2，声明序取首个命中；缺省内置 chat 频道锚定规则——
   * 语料校准 2026-10-03）。正则字符串声明，非法正则启动即拒装。
   */
  classifyRules?: ClassifyRuleSpec[]
  /**
   * 投递白名单（C5.2 剔除策略放行面）：缺省有标行一律不投（聊天/他人动作不进
   * agent——安全前提）；列出放行的 kind（如 ['chat']）。
   */
  deliverAllowKinds?: string[]
  /** 是否把会话日志落盘（JSONL）。缺省 true。 */
  logFile?: boolean
  /** 会话日志落盘目录。缺省 `<cwd>/mud-logs`。 */
  logDir?: string
  /** 会话日志内存环上限（remote.mud.logs 的可读窗口）。缺省 2000。 */
  logBufferMax?: number
  /** 是否把名册挂到宿主 storage 域（缺省 true；域不可用时自动降级内存并告警）。 */
  rosterStorage?: boolean
  /**
   * 任务书模板（admit/静默唤醒两触发点共用；状态驱动——根醒来
   * 读状态自行规划，不写指令序列）。占位符 {{serverName}}/{{endpoint}}/{{account}}/
   * {{conn}}/{{loggedIn}} 在投递时以实时状态填充；缺省取 DEFAULT_TASK_BRIEF。
   */
  taskBrief?: string
  /** 静默唤醒时长毫秒（正整数；行到达即重置，到期且守卫全过才投任务书）。缺省 120_000。 */
  silenceMs?: number
  /**
   * 半开探活静默首发延迟毫秒（T12 静默伴随自驱，正整数；自最后数据到达起
   * 计时）。缺省 90_000。
   */
  probeStartMs?: number
  /** 半开探活无应答重发间隔毫秒（T12，正整数；启动期 fail-loud 校验）。缺省 9_000。 */
  probeRetryMs?: number
  /** 半开探活总次数上限（T12，正整数；判死刻度 = probeStartMs + 次数 × probeRetryMs）。缺省 3。 */
  probeMaxAttempts?: number
  /** 意外断线自动重连尝试次数上限（T5.2，正整数；到限次保持断开等人工）。缺省 5。 */
  reconnectMaxAttempts?: number
  /** 自动重连尝试固定间隔毫秒（T5.2，正整数）。缺省 30_000。 */
  reconnectIntervalMs?: number
  /** mud_send 缺省总超时毫秒（工具参数缺省，钳制 ≤ 60000）。缺省 15000。 */
  sendTimeoutMs?: number
  /** mud_send 裸读尾部/兜底行数。缺省 50。 */
  sendMaxLines?: number
  /**
   * 精力闸比值（T23.10 D16，用户裁定 2026-10-08）：精力 / 最大精力低于此值**不发 walk**
   * （战斗规则收加力共用同一键）。须为 (0,1] 的比值，fail-loud。缺省 0.2。
   */
  staminaFloorPct?: number
  /**
   * 验证码挂起预算毫秒（T13 D4/B4：**独立预算**，不受 MAX_TIMEOUT_MS/silenceMs
   * 校验约束；fail-loud 正整数）。缺省 180_000 = URL 有效期 3 分钟。
   */
  captchaTimeoutMs?: number
}

/** 宿主 credentials 服务的最小结构化面（core3 不依赖 dsh-credentials：只需 resolve）。 */
interface HostCredentialService {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** 宿主 sessionController 的最小结构化面（core3 不依赖 dsh-api-session-controller）。 */
interface HostSessionController {
  create(request: { sessionId: string; cwd?: string; agentPreset: string }): Promise<unknown>
}

/**
 * 从 ctx 取宿主凭据服务；面不存在/形状不符返回 undefined。
 * @param ctx - 插件上下文。
 * @returns 可用的凭据服务，或 undefined。
 */
function hostCredentials(ctx: Context): HostCredentialService | undefined {
  const candidate: unknown = ctx.get('credentials')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const resolve = (candidate as { resolve?: unknown }).resolve
  if (typeof resolve !== 'function') return undefined
  // 形状已按 resolve 方法校验；其余成员本插件不使用。
  return candidate as HostCredentialService
}

/**
 * 从 ctx 取宿主会话控制器；面不存在/形状不符返回 undefined。
 * @param ctx - 插件上下文。
 * @returns 可用的会话控制器，或 undefined。
 */
function hostSessionController(ctx: Context): HostSessionController | undefined {
  const candidate: unknown = ctx.get('sessionController')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const create = (candidate as { create?: unknown }).create
  if (typeof create !== 'function') return undefined
  return candidate as HostSessionController
}

/**
 * 从 ctx 取宿主 storage 域；面不存在/形状不符返回 undefined。
 * @param ctx - 插件上下文。
 * @returns 可用的 storage 域，或 undefined。
 */
function hostStorageDomain(ctx: Context): HostStorageDomain | undefined {
  const candidate: unknown = ctx.get('storageDomain')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const open = (candidate as { open?: unknown }).open
  if (typeof open !== 'function') return undefined
  return candidate as HostStorageDomain
}

/**
 * 宿主会话面的窄结构（`ctx.get('agents').get(id).session`）：T18 遮蔽用 `ElisionSession`，
 * 归属上溯读 `header.parentSession`。
 */
type HostSessionFace = ElisionSession & { readonly header?: { readonly parentSession?: string } }

/**
 * 宿主 live agent 注册表的最小结构面（`ctx.get('agents')`）。
 * `AgentRegistry.get` 的形参是品牌化 `SessionId`，其定义在传递包 `@deepseek-ai/dsh-session`
 * 内（pnpm 严格链接下不可直连 import）⇒ 只保留本条读法（§15.2）。
 */
interface AgentsLive {
  get(id: string): { session?: HostSessionFace } | undefined
}

/** 唤醒署名：MUD 消息以用户消息到达，署名 'mud' 以区分人工提问。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mud': {
      kind: 'mud'
      plugin: string
    }
    /**
     * 唤醒/任务书署名（T4a，core2 同款声明合并自扩）：kickoff 与静默唤醒的
     * 主动投递与 MUD 行批次（'mud'）署名区分——非用户、来自本插件的唤醒。
     */
    'mud-wake': {
      kind: 'mud-wake'
      plugin: string
    }
    /**
     * 进程起点标记署名（T18）：冷启动后首次 model step 前遮蔽上一进程上下文的替换体。
     * 独立种类 = 不冒充人类消息（标题生成/会话活动等按 kind 区分来源者可排除它）。
     */
    'mud-epoch': {
      kind: 'mud-epoch'
      plugin: string
    }
  }
}

// ── 任务书面（T4a）─────────────────────────────────────────────
// 模板常量/填充在纯层 wake.ts（接线层 Config.taskBrief 缺省引用它）。

/** remote 动词的 id 校验（typert wire 类型允许 undefined）。 */
function requireId(id: string | undefined, field: string): string {
  if (id === undefined || id === '') throw new Error(`${field} 必填`)
  return id
}

/**
 * `ctx.provide('mudCore3', ...)` 的服务面：工具面引擎窄面（MudCore3Handle）
 * + runtimeFor（预留拒绝点）。
 */
export interface MudCore3Service extends MudCore3Handle {
  /** 由 agent 解析其会话 runtime；不属于本插件返回 null。 */
  runtimeFor(agent: { id: unknown }): SessionRuntime | null
  /** 流程实体（locked login 等；mud-workflow 注册表启动期挂载，fail-loud 校验）。 */
  readonly builtinFlows: readonly WorkflowRecord[]
}

// ── Remote 服务 ─────────────────────────────────────────────────

/** remote.mud 命名空间：名册 CRUD + 连接管理 + 接入闸门 + 日志。 */
export class MudRemoteService extends TypertRemoteService {
  private readonly service: MudService
  private readonly roster: () => RosterStore
  private readonly ready: () => Promise<void>
  private readonly writeDeps: () => Parameters<typeof writeAccount>[0]
  private readonly logDir: () => string | undefined

  /**
   * @param ctx - 插件上下文（typert 注册）。
   * @param service - 多会话服务。
   * @param roster - 当前名册存储读取面。
   * @param ready - 名册落定（storage 域打开完成）的等待。
   * @param writeDeps - 名册写路径依赖（建会话/分配器）。
   * @param logDir - 会话日志落盘目录（删账号时清理；未落盘返回 undefined）。
   */
  constructor(
    ctx: Context,
    service: MudService,
    roster: () => RosterStore,
    ready: () => Promise<void>,
    writeDeps: () => Parameters<typeof writeAccount>[0],
    logDir: () => string | undefined,
  ) {
    super(ctx, 'mudRemote', { namespace: 'mud' })
    this.service = service
    this.roster = roster
    this.ready = ready
    this.writeDeps = writeDeps
    this.logDir = logDir
  }

  // ── 名册：服务器 ─────────────────────────────────────────────

  /** 服务器名册（键 = workspaceId）。 */
  @Remote
  async servers(): Promise<{ servers: readonly ServerRecord[] }> {
    await this.ready()
    return { servers: this.roster().servers() }
  }

  /** 建服务器（工作区实体由调用侧创建；此处只记 host/port/name）。 */
  @Remote
  async addServer(record: ServerRecord | undefined): Promise<{ server: ServerRecord }> {
    if (record === undefined) throw new Error('server 必填')
    await this.ready()
    return { server: await writeServer(this.writeDeps(), record) }
  }

  /** 删服务器（该服务器下仍有账号时拒绝）。 */
  @Remote
  async removeServer(workspaceId: string | undefined): Promise<{ workspaceId: string; removed: boolean }> {
    const id = requireId(workspaceId, 'workspaceId')
    await this.ready()
    await dropServer(this.writeDeps(), id)
    return { workspaceId: id, removed: true }
  }

  // ── 名册：账号 ───────────────────────────────────────────────

  /** 账号名册（键 = accountId = sessionId；passRef 是引用名，不是密文）。 */
  @Remote
  async accounts(): Promise<{ accounts: readonly AccountRecord[] }> {
    await this.ready()
    return { accounts: this.roster().accounts() }
  }

  /**
   * 建账号 = 纯登记（2026-10-02 裁定）：写名册 → 建会话（sessionId = 账号 id，
   * 绑定 preset），**不投任务书**——会话保持 blank、agent 零行动（LLM 调用面闸门
   * fail-closed 兜底）。任务书唯一点火点 = 接入（onAdmit → kickoff）。
   * 密码由页面经 `credentials.set` 写入宿主凭据域，这里只收引用名。
   */
  @Remote
  async addAccount(input: {
    serverId: string; name: string; passRef: string; preset: string; cwd: string
  } | undefined): Promise<{ account: AccountRecord }> {
    if (input === undefined) throw new Error('account 必填')
    await this.ready()
    const account = await writeAccount(this.writeDeps(), input)
    return { account }
  }

  /**
   * 改账号：当前只支持改名（preset 建会话时绑定装配，不可改；密码由页面
   * `credentials.set` 按原引用名覆盖，不动名册）。改名同步 runtime 回显前缀。
   */
  @Remote
  async updateAccount(
    sessionId: string | undefined,
    input: { name: string } | undefined,
  ): Promise<{ account: AccountRecord }> {
    const id = requireId(sessionId, 'sessionId')
    if (input === undefined || input.name === undefined) throw new Error('name 必填')
    await this.ready()
    const account = await renameAccount(this.writeDeps(), id, input.name)
    const rt = this.service.get(id)
    if (rt !== null) rt.accountName = account.name
    return { account }
  }

  /**
   * 删账号：清名册 + 清该账号的日志文件。
   * 会话本身的销毁由宿主侧负责（插件拿不到 agent 的 dispose 能力）。
   */
  @Remote
  async removeAccount(sessionId: string | undefined): Promise<{ sessionId: string; removed: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    await this.ready()
    const removed = await dropAccount(this.writeDeps(), id)
    purgeSessionLogs(this.logDir(), id)
    return { sessionId: id, removed }
  }

  // ── 连接与闸门 ───────────────────────────────────────────────

  /** 建连 + login。 */
  @Remote
  async connect(sessionId: string | undefined): Promise<{ sessionId: string; state: string }> {
    const id = requireId(sessionId, 'sessionId')
    const result = await this.service.connect(id)
    return { sessionId: result.sessionId, state: result.state }
  }

  /** 断连（幂等；未登记的会话保持静默，返回可读状态）。 */
  @Remote
  disconnect(sessionId: string | undefined): { sessionId: string; state: string } {
    const id = requireId(sessionId, 'sessionId')
    this.service.disconnect(id)
    return { sessionId: id, state: this.service.status(id).state }
  }

  /**
   * 接入：MUD 信息开始进入 agent（名册 admitted 持久化）。
   * 开闸门并投状态任务书走 service 的 onAdmit 回调（两动作合一——根开
   * 回合读状态自行规划；保持 admit 的纯闸门语义，投递只是旁路）。
   * 名册 admitted 仅作**最近状态记录**：宿主重启恢复**不回读**（Deliverer
   * 恒 fresh 未接入）——重启后历史会话一律冷启动，人工点接入再点火
   * （2026-10-02 裁定：冷启动不自动，同 T5 自动重连纪律）。
   */
  @Remote
  async admit(sessionId: string | undefined): Promise<{ sessionId: string; admitted: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    this.service.admit(id)
    await setAdmitted(this.writeDeps(), id, true)
    return { sessionId: id, admitted: this.service.status(id).admitted }
  }

  /** 停止接入：MUD 信息不再进入 agent（名册 admitted 持久化，同上：恢复不回读）。 */
  @Remote
  async stop(sessionId: string | undefined): Promise<{ sessionId: string; admitted: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    this.service.stop(id)
    await setAdmitted(this.writeDeps(), id, false)
    return { sessionId: id, admitted: this.service.status(id).admitted }
  }

  /**
   * 战斗刹车（T21.6 combatAuto 总开关）：关闭 = 人打断——立即释放当前遭遇并挂起
   * （不接管、不开窗、危险通道也不动作）；恢复 = 新遭遇照常接管（不追补当前场）。
   * 名册持久化（重启保留人的意愿）。
   */
  @Remote
  async combatAuto(
    sessionId: string | undefined,
    enabled: boolean | undefined,
  ): Promise<{ sessionId: string; combatAuto: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    if (enabled === undefined) throw new Error('enabled 必填')
    this.service.setCombatAuto(id, enabled)
    await writeCombatAuto(this.writeDeps(), id, enabled)
    return { sessionId: id, combatAuto: enabled }
  }

  /** 连接状态 + 接入状态。 */
  @Remote
  status(sessionId: string | undefined): {
    state: string; admitted: boolean; sessions: readonly StatusRow[]
  } {
    if (sessionId !== undefined && sessionId !== '') {
      const status = this.service.status(sessionId)
      return { state: status.state, admitted: status.admitted, sessions: this.service.statuses().map(statusRowOf) }
    }
    return { state: 'disconnected', admitted: false, sessions: this.service.statuses().map(statusRowOf) }
  }

  /**
   * 会话日志（内存环条目 + 落盘目录）。
   * 原始行流只落盘、不进环；环里是运行/网络/投递/闸门事件（连接失败原因在这里）。
   */
  @Remote
  logs(sessionId: string | undefined): {
    sessionId: string; entries: readonly LogEntry[]; fileTarget: string | null
  } {
    const id = requireId(sessionId, 'sessionId')
    const view = this.service.logOf(id)
    if (view === null) throw sessionNotRegistered(id)
    return { sessionId: view.sessionId, entries: view.entries, fileTarget: view.fileTarget }
  }

  // ── 画面通道（C5：只读视图；对齐 v1 流动词形态）────────────────

  /**
   * 游戏画面流（stream 动词，v1 game/ui/world 同型）。
   *
   * 首帧 snapshot（无头屏整屏序列化，含 scrollback 历史）→ 有序 output/state。
   * **纯扇出、无输入路径**：不收客户端任何数据；tab 关闭（abort）即摘除
   * follower，连接/投递不受影响。慢 follower 超限显式失败，重连恢复。
   * 画面是 MUD→人的显示面，不经 admit 闸门（未接入 = 录制模式照样可看）。
   */
  @Remote({ mode: 'stream' })
  async *follow(
    sessionId: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<GameFrame> {
    const id = requireId(sessionId, 'sessionId')
    const screen = this.service.screenOf(id)
    if (screen === null) throw sessionNotRegistered(id)
    yield* screen.attach(signal)
  }

  // ── 状态推送（C5.1：轮询 → 事件流）────────────────────────────

  /**
   * 会话状态流（stream 动词，follow 同型）：首帧全量快照（statuses() 语义），
   * 之后仅在状态变化时推帧 —— 页面全局状态面，一次订阅覆盖全部已登记会话。
   * abort（tab 关闭/页面刷新）即清服务端订阅；status() 单次动词保留做初始回填。
   */
  @Remote({ mode: 'stream' })
  async *watchStatus(signal: AbortSignal): AsyncIterable<{ sessions: readonly StatusRow[] }> {
    // 边界窄面（T11 收尾）：loggedIn 直传（字符串字面量），world 经 statusRowOf
    // 扁平化 + 值字符串化（WorldEntry.value 的 unknown 不过 Remote 边界）。
    for await (const frame of this.service.watchStatusStream(signal)) {
      yield { sessions: frame.sessions.map(statusRowOf) }
    }
  }

  // ── 验证码通道（T13 D7：独立流动词 + 三输入动词）──────────────────

  /**
   * 验证码流（stream 动词，watchStatus 同型）：首帧全量挂起快照（页面刷新/
   * 重连/重开恢复弹窗——等待态必须可从流恢复，否则流程白等预算），条目变化
   * （挂起/刷新换图/收束摘除）时整体重推。全局独立订阅，与画面 tab 开关无关
   * （D7：不加 follow 帧 kind 的缘由）。
   */
  @Remote({ mode: 'stream' })
  async *watchCaptcha(signal: AbortSignal): AsyncIterable<CaptchaFrame> {
    yield* this.service.watchCaptchaStream(signal)
  }

  /** 提交人工码值（resolve 挂起；`fullme {captcha}` 由流程动作统一发送）。 */
  @Remote
  async captchaAnswer(sessionId: string | undefined, value: string | undefined): Promise<{ sessionId: string }> {
    const id = requireId(sessionId, 'sessionId')
    if (value === undefined || value.trim() === '') throw new Error('value 必填（验证码值）')
    await this.service.captchaAnswer(id, value)
    return { sessionId: id }
  }

  /** 中止（专用 aborted 出口收束——流程结果 agent 可读）。 */
  @Remote
  async captchaAbort(sessionId: string | undefined): Promise<{ sessionId: string }> {
    const id = requireId(sessionId, 'sessionId')
    await this.service.captchaAbort(id)
    return { sessionId: id }
  }

  /** 刷新：重抓同 URL 页出新图（每轮挂起限 1 次；挂起 Promise 不动、计时不重置）。 */
  @Remote
  async captchaRefresh(sessionId: string | undefined): Promise<{ sessionId: string; image: string }> {
    const id = requireId(sessionId, 'sessionId')
    const image = await this.service.captchaRefresh(id)
    return { sessionId: id, image: image.image }
  }
}

// ── 插件主体 ───────────────────────────────────────────────────

/** 宿主插件装配。 */
export function apply(ctx: Context, config: MudCore3Config = {}): void {
  // ── 启动期 fail-loud 校验（T5.3：非法配置拒装，不静默钳制）────────
  const positiveInt = (value: number | undefined, key: string): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`mud-core3 配置 ${key} 必须为正整数，got ${String(value)}`)
    }
  }
  const silenceMs = config.silenceMs ?? 120_000
  positiveInt(config.silenceMs, 'silenceMs')
  positiveInt(config.probeStartMs, 'probeStartMs')
  positiveInt(config.probeRetryMs, 'probeRetryMs')
  positiveInt(config.probeMaxAttempts, 'probeMaxAttempts')
  positiveInt(config.reconnectMaxAttempts, 'reconnectMaxAttempts')
  positiveInt(config.reconnectIntervalMs, 'reconnectIntervalMs')
  // 精力闸比值（T23.10 D16）：(0,1] 的比值，fail-loud（0 会闸死一切、>1 无意义）。
  if (config.staminaFloorPct !== undefined
    && (!(config.staminaFloorPct > 0) || config.staminaFloorPct > 1)) {
    throw new Error(`mud-core3 配置 staminaFloorPct 必须为 (0,1] 的比值，got ${String(config.staminaFloorPct)}`)
  }
  // 验证码挂起预算（T13 D4/B4）：独立预算，只查正整数——不并入 MAX_TIMEOUT_MS/
  // silenceMs 校验（挂起等人工与投递/探活预算分立，两预算先后串行不竞争）。
  positiveInt(config.captchaTimeoutMs, 'captchaTimeoutMs')
  // 探测窗口收束纪律（T12 D6）：探测窗口整体落在静默窗口内——判死刻度
  // probeStartMs + probeMaxAttempts × probeRetryMs ≤ silenceMs（缺省 117 ≤ 120，
  // 唤醒到期点前留 3s 收束），防静默配小后探测溢出到唤醒点之后。
  const probeStartMs = config.probeStartMs ?? 90_000
  const probeRetryMs = config.probeRetryMs ?? 9_000
  const probeMaxAttempts = config.probeMaxAttempts ?? 3
  const probeDeadline = probeStartMs + probeMaxAttempts * probeRetryMs
  if (probeDeadline > silenceMs) {
    throw new Error(
      `mud-core3 配置探测窗口（probeStartMs ${probeStartMs} + probeMaxAttempts ${probeMaxAttempts}`
      + ` × probeRetryMs ${probeRetryMs} = ${probeDeadline}ms）超过静默期（silenceMs ${silenceMs}ms）：`
      + '判死刻度必须落在唤醒到期点之前',
    )
  }
  // 纪律升级（PLAN T5 第 2 章）：在途超时 ≤ 静默期——工具在途 read 的 timeoutMs
  // 上限 MAX_TIMEOUT_MS 必须小于静默期，否则在途 read 未收束静默永不到期（探活饿死）。
  if (MAX_TIMEOUT_MS >= silenceMs) {
    throw new Error(`mud-core3 配置 silenceMs（${silenceMs}ms）必须大于 MAX_TIMEOUT_MS（${MAX_TIMEOUT_MS}ms）：在途超时不得超过静默期`)
  }
  // 凭据解析：缺省走宿主 credentials 域（页面 credentials.set 写入，connect 时实时解析）。
  // 明文只进登录发送，不进 roster/日志/上下文。
  const resolveCreds: CredentialResolver = config.resolveCreds ?? (async (account) => {
    const credentials = hostCredentials(ctx)
    if (credentials === undefined) {
      throw new Error('宿主 credentials 服务不可用：无法解析凭据（页面是否已加载凭据域？）')
    }
    const resolved = await credentials.resolve(account.passRef)
    if (resolved === undefined || resolved.value === '') {
      throw new Error(`凭据 ${account.passRef} 未找到：请在页面重新填写密码（引用已失效或从未写入）`)
    }
    return { name: account.name, pass: resolved.value } satisfies ResolvedCredentials
  })

  // 会话日志：warn/error 同时镜像到宿主日志（控制台可排查），文件按天 + 会话落盘。
  const logOptions: SessionLogOptions = {
    ...(config.logFile === false
      ? {}
      : { logDir: resolveLogDir(config.logDir, join(process.cwd(), 'mud-logs')) }),
    ...(config.logBufferMax !== undefined ? { bufferMax: config.logBufferMax } : {}),
    onEntry: (sessionId, entry) => {
      if (entry.level === 'error') {
        ctx.logger.error(`mud-core3[${sessionId}] ${entry.channel}: ${entry.text}`)
      } else if (entry.level === 'warn') {
        ctx.logger.warn(`mud-core3[${sessionId}] ${entry.channel}: ${entry.text}`)
      }
    },
  }

  // ── 名册：宿主 storage 域 + 内存降级（双态）──────────────────
  // 时序真相（排查实录）：storage-domain 的 provide 发生在其异步装配之后，
  // 同步 ctx.get('storageDomain') 在插件 apply 期拿到的是 undefined —— 宿主里
  // workspace/schedule 等消费者都用 inject 声明依赖让 cordis 等待就绪。
  // 本插件把 storageDomain 视为可选依赖：RPC 不等域，内存名册先行（ready 立即
  // open）；域就绪（inject 回调）后挂上域存储并把内存已有记录迁入 —— 档位齐全：
  // 测试 mock（同步 provide）立即挂域，rosterStorage: false 纯内存，宿主缺失域
  // 则长期内存运行（重启丢名册，warn 点名）。
  let store: RosterStore = new MemoryRosterStore()
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((resolve) => { readyResolve = resolve })
  let domainAttached = false
  const attachDomain = (domain: HostStorageDomain): void => {
    if (domainAttached) return
    domainAttached = true
    void openDomainRosterStore(domain).then(async (opened) => {
      if (opened === null) {
        ctx.logger.warn('mud-core3: storage 域打开失败，名册退回内存（重启丢服务器/账号）')
        return
      }
      // 挂域前的记录（内存先行期写入的）迁入域存储，切换不丢数据。
      for (const record of store.servers()) await opened.putServer(record)
      for (const record of store.accounts()) await opened.putAccount(record)
      store = opened
      ctx.logger.info(`mud-core3: 名册已挂 storage 域（servers=${store.servers().length}，accounts=${store.accounts().length}）`)
    })
  }
  if (config.rosterStorage === false) {
    readyResolve()
  } else {
    const immediate = hostStorageDomain(ctx)
    if (immediate !== undefined) {
      attachDomain(immediate)
      readyResolve()
    } else {
      ctx.logger.warn('mud-core3: storage 域尚未就绪，名册暂以内存运行（域就绪后自动挂载）')
      ctx.inject(['storageDomain'], (injected: Context) => {
        const domain = hostStorageDomain(injected)
        if (domain !== undefined) attachDomain(domain)
      })
      readyResolve()
    }
  }

  // 名册写路径依赖：建会话走宿主 sessionController（sessionId = 账号 id，绑定 preset）。
  const writeDeps = (): Parameters<typeof writeAccount>[0] => ({
    store,
    createSession: async (request) => {
      const controller = hostSessionController(ctx)
      if (controller === undefined) throw new Error('宿主 sessionController 服务不可用：无法建会话')
      await controller.create({
        sessionId: request.sessionId,
        ...(request.cwd.trim() === '' ? {} : { cwd: request.cwd }),
        agentPreset: request.agentPreset,
      })
    },
  })

  // agent 句柄表（投递用：sessionId → live agent）
  const agentMap = new Map<string, { followup: (msg: ReturnType<typeof createUserMessage>) => void }>()

  const delivererConfig: DelivererConfig = {
    ...(config.deliverQuietMs !== undefined ? { quietMs: config.deliverQuietMs } : {}),
    ...(config.deliverMaxWaitMs !== undefined ? { maxWaitMs: config.deliverMaxWaitMs } : {}),
    ...(config.deliverMaxLines !== undefined ? { maxLines: config.deliverMaxLines } : {}),
    ...(config.deliverMaxChars !== undefined ? { maxChars: config.deliverMaxChars } : {}),
    // C5.2 剔除策略放行面：缺省空 = 有标行一律不投（聊天/他人动作不进 agent）。
    ...(config.deliverAllowKinds !== undefined ? { allowKinds: config.deliverAllowKinds } : {}),
  }

  // 官方 live agent 注册表窄结构（AgentRegistry.get；归属父链上溯用，见 parentLookup）。
  // 取用走 ctx.get（**可选服务，不写进 inject**）：apply 期提供方 fiber 未必已 ACTIVE
  // （与 storageDomain 同一课，§14.3）⇒ 延到调用期解析；缺席/未就绪 ⇒ 上溯终止（§2.3）。
  // 反面教训：写成 ctx.agents 会因未声明 inject 直接抛 "cannot get property ... without inject"，
  // 整个 apply 失败 ⇒ remote.mud 全动词 404。
  const agentsLive = (): AgentsLive | undefined => ctx.get('agents') as unknown as AgentsLive | undefined

  // 投递回调：MUD 行流聚合后以用户消息投递进会话（等同人工提问）。
  // 返回 true = 已投出（followup 排队语义：回合中调用也合法，等下一回合消费）；
  // 返回 false / 失败原因字符串 = 未投出，该批水位不推进（行仍在 pending），
  // 等 agent 唤醒时由 flushPending 补投。失败原因经 deliverer.onBatch 进会话日志。
  const deliver = (sessionId: string, text: string): boolean | string => {
    const agent = agentMap.get(sessionId)
    if (agent === undefined) {
      // 冷会话：批次保留，等 agent/created 时补投。原因字符串区分句柄缺失。
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 投递时 agent 句柄缺失，批次保留待补投`)
      return false
    }
    try {
      const msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'mud', plugin: 'mud-core3' },
      })
      agent.followup(msg)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 投递失败，批次保留待补投: ${String(error)}`)
      return `followup 抛错：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const service = new MudService({
    serverLookup: sessionId => {
      const acc = store.account(sessionId)
      return acc ? store.server(acc.serverId) : undefined
    },
    accountLookup: sessionId => store.account(sessionId),
    resolveCreds,
    deliver,
    delivererConfig,
    log: logOptions,
    // T12 半开探活刻度（静默伴随自驱：90s 首发 / 9s 重发 / 3 次上限 = 117s 判死；
    // 启动期 fail-loud 校验见 apply 顶部 D6）。
    keepalive: {
      startMs: probeStartMs,
      retryMs: probeRetryMs,
      maxAttempts: probeMaxAttempts,
    },
    // T5.2 自动重连刻度（缺省 5 次 / 30s 间隔；到限次保持断开等人工）。
    reconnect: {
      maxAttempts: config.reconnectMaxAttempts ?? 5,
      intervalMs: config.reconnectIntervalMs ?? 30_000,
    },
    // T13 验证码挂起预算（独立预算，缺省 180s = URL 有效期；正整数校验见 apply 顶部）。
    captchaTimeoutMs: config.captchaTimeoutMs ?? DEFAULT_CAPTCHA_TIMEOUT_MS,
    ...(config.recordLines !== undefined ? { recordLines: config.recordLines } : {}),
    // 父会话查找 = 官方 live 注册表实时读（2026-10-01 裁定：不自建归属状态）。
    // durable session lineage（session.header.parentSession，subagent/workflow 派发
    // 都写入）经 ctx.get('agents')（AgentRegistry，agent id ≡ session id）按 id 查
    // live agent 读 header；祖先不 live（已 dispose）或注册表缺席 → undefined →
    // 上溯终止，与官方 authorizeLineage「要求 parent live」语义一致（窄结构见 AgentsLive）。
    parentLookup: sessionId => agentsLive()?.get(sessionId)?.session?.header?.parentSession,
    // T4a：admit 开闸门并投状态任务书（kickoff 定义见下；调用发生在 admit 时）。
    onAdmit: sessionId => kickoff(sessionId),
    view: {
      ...(config.viewScrollback !== undefined ? { scrollback: config.viewScrollback } : {}),
      ...(config.viewCols !== undefined ? { cols: config.viewCols } : {}),
      ...(config.viewMaxBufferedBytes !== undefined
        ? { maxBufferedBytes: config.viewMaxBufferedBytes } : {}),
      // C5.2 副屏行环上限（有标行条数）。
      ...(config.viewSubCap !== undefined ? { subCap: config.viewSubCap } : {}),
    },
    // C5.2 行分类规则清单（缺省内置 chat 频道锚定规则）。
    ...(config.classifyRules !== undefined ? { classifyRules: config.classifyRules } : {}),
  })

  // ── 任务书投递面（kickoff）────────────────────────────────────
  // admit（开闸门点火）/静默唤醒两触发点共用：正文 = 服务器/账号事实 + 两轴
  // 实时状态 + 目标（状态驱动，模板 Config.taskBrief ?? 缺省）。署名 'mud-wake'
  // （与 MUD 行批次 'mud' 区分）；真发一条用户消息 → 一次真实回合 → `turn/start`
  // → 会话脱离 blank。建账号不再触发（2026-10-02 裁定：纯登记，blank 保持）；
  // 未接入时本调用触发的模型步被 llm/stream 闸门拦成空回合（agent 零行动）。
  const kickoff = (sessionId: string): void => {
    const agent = agentMap.get(sessionId)
    if (agent === undefined) {
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 的 agent 未就绪，跳过任务书投递（会话仍为 blank）`)
      return
    }
    const account = store.account(sessionId)
    if (account === undefined) return // 不在名册 = 不是我们的会话
    const server = store.server(account.serverId)
    const status = service.status(sessionId)
    const text = fillTaskBrief(config.taskBrief ?? DEFAULT_TASK_BRIEF, {
      serverName: server?.name ?? account.serverId,
      endpoint: server === undefined ? '未登记' : `${server.host}:${server.port}`,
      account: account.name,
      conn: status.state,
      loggedIn: status.loggedIn,
    })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'mud-wake', plugin: 'mud-core3' },
      }))
      ctx.logger.info(`mud-core3: 会话 ${sessionId} 已投递任务书（conn=${status.state}，loggedIn=${status.loggedIn}）`)
    } catch (error: unknown) {
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 任务书投递失败: ${String(error)}`)
    }
  }

  // ── 静默唤醒器（T4a，每会话一实例）────────────────────────────
  // 行到达 re-arm（runtime.onActivity）+ 到期守卫（传输面：非回合中 + 持有者
  // 空闲，任一不满足只 re-arm；闸门面：已接入才 fire）；命中 → kickoff 投状态
  // 任务书。探活不在此（T12 D5：link 层自驱静默伴随探测，判死经断线→自动
  // 重连链告知）。不做子 agent 守卫（V7 纪律：委派结果走 subagent 工具
  // 返回值，插件不查子级）。
  const wakes = new Map<string, Wake>()

  // ── agent/created → 名册判定 → 恢复时点遮蔽 + 登记会话 + 记录 agent 句柄 + 补投 ──
  // 归属 = sessionId ∈ accounts（名册判定，不按 preset 排除）。
  const elisionDone = new Set<string>()
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.id)
    const account = store.account(sessionId)
    if (account === undefined) return // 不在名册 = 不是我们的会话
    const rt = service.register(sessionId, account.name)
    // 恢复时点遮蔽（T18，方案 B 定稿 2026-10-08）：created 时点表面 = 上一进程恢复的全部
    // 历史，遮蔽对象无需推断——register（日志器就绪）之后一次性遮蔽，再补投（kickoff /
    // 行批次都发生在遮蔽之后，结构上不可能被吞——修掉 pre-step 逐步判定下「首步空表面
    // skip、第二步误吞任务书」的缺陷）。spike 实证（spike/created-mask-probe.mjs）：created
    // 缝 append 被宿主接受、同步完成于 create() 返回前；重放不 corrupt；遮蔽跨进程持久。
    // announce 每会话每进程至多一次，进程中途 resume 重建的 agent 也经此缝 ⇒ 内存集合保证
    // 「每进程首见才遮」。失败只记 error（fail-open：created 缝无 step 可 reject，取舍见 §11.2）。
    const session = (agent as { readonly session?: HostSessionFace }).session
    if (session !== undefined && !elisionDone.has(sessionId)) {
      elisionDone.add(sessionId)
      const outcome = applyElision(session, processEpoch())
      if (outcome.kind === 'replaced') {
        service.appendRuntimeLog(sessionId, 'info', `上下文收口：已遮蔽上一进程上下文（起点标记 seq=${outcome.seq}，遮蔽 ${outcome.shadowedSeqs.length} 个表面节点）`)
      } else if (outcome.kind === 'failed') {
        service.appendRuntimeLog(sessionId, 'error', `上下文收口：遮蔽失败，既有历史保留在模型上下文（${outcome.reason}）`)
      } else {
        service.appendRuntimeLog(sessionId, 'info', `上下文收口：跳过（原因：${outcome.reason}）`)
      }
    }
    // 战斗开关初始化（T21.6）：名册持久偏好（缺省/缺字段 = true）应用到控制器。
    service.setCombatAuto(sessionId, account.combatAuto !== false)
    // 记录 agent 句柄（投递用；agent 有 followup 方法）
    agentMap.set(sessionId, { followup: msg => agent.followup(msg) })
    // 静默唤醒器（每会话一实例）：行到达 re-arm + 到期守卫，命中投任务书。
    // 探活已下沉 link 层自驱静默伴随探测（T12 D5）——到期点零探测依赖，
    // 三守卫全过直接 fire。
    if (!wakes.has(sessionId)) {
      const wake = new Wake({
        guards: {
          admitted: () => service.getDeliverer(sessionId)?.isAdmitted ?? false,
          notInTurn: () => !(service.getDeliverer(sessionId)?.isInTurn ?? false),
          holderIdle: () => !(service.get(sessionId)?.holderBusy ?? false),
        },
        fire: () => kickoff(sessionId),
      }, { silenceMs: config.silenceMs ?? 120_000 })
      rt.onActivity = () => wake.arm()
      wakes.set(sessionId, wake)
    }
    // agent 上线：把冷会话期间保留下来的批次投出。
    service.flushPending(sessionId)
    return undefined // 官方监听器契约：undefined | Promise<undefined>
  })

  // ── agent/disposed → 移除 agent 句柄（runtime/deliverer 保留）──
  ctx.on('agent/disposed', ({ agent }) => {
    agentMap.delete(String(agent.id))
    return undefined
  })

  // ── session/disposed → 断连 + 拆 runtime + 拆 deliverer + 拆日志 ──
  ctx.on('session/disposed', (session) => {
    const sessionId = String(session.id)
    if (store.account(sessionId) === undefined) return
    wakes.get(sessionId)?.dispose()
    wakes.delete(sessionId)
    service.dispose(sessionId)
    agentMap.delete(sessionId)
    return undefined
  })

  // ── turn/start、turn/end → 投递抑制/冲刷（pull 模型，§4.3）──
  // 回合内行只进 pending（录制），turn/end 一次冲刷——防行流打断回合节奏。
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (store.account(sessionId) === undefined) return
    if (event.type === 'turn/start') service.turnStart(sessionId)
    else if (event.type === 'turn/end') service.turnEnd(sessionId)
    return undefined
  }, { global: true })

  // ── LLM 调用面闸门（llm/stream 瀑布终审，2026-10-02）──────────
  // 接入语义规格的保险面：未接入账号会话的任何模型调用一律拦成空 stop 流
  // （0 token、回合自然收束，判定见纯层 llm-gate.ts）。建账号纯登记后首次
  // kickoff 因此成为空回合（agent 零行动）；停止接入后进行中回合在下一步
  // 调用处空步收束（不打断在飞工具）。与投递面闸门 + 静默唤醒三守卫构成
  // 三重防线；非本插件会话直接 next() 放行。注册在本插件 fiber，卸载自拆。
  ctx.on('llm/stream', (options, next) => {
    const veto = shouldVeto(options, {
      isManaged: id => store.account(id) !== undefined,
      isAdmitted: id => service.getDeliverer(id)?.isAdmitted ?? false,
    })
    if (!veto) return next()
    ctx.logger.info(`mud-core3: 未接入会话 ${String(options.sessionId)} 的模型调用被闸门拦截（空 stop 收束）`)
    return vetoStopStream()
  })

  // ── 行走知识服务（T23.10b）：插件级单例（知识图全局）──
  // 记录 agent 走出来的 walk 节点（路径表 ⇒ 边、`-q` ⇒ 参考链）并回答下一跳建议；
  // 由工具面经 `ctx.get('mudNav')` 取用（§8.7、§15.2）。
  // 持久化（用户裁定 2026-10-08）：**JSON 文件**，落点与会话日志同目录；读坏即空图（fail-soft）。
  // 未落盘（`logDir` 未配置）⇒ 纯内存（不另找目录乱写）。
  const navFile = logOptions.logDir === undefined ? null : join(logOptions.logDir, 'nav-graph.json')
  const navService = new NavService(navFile === null ? null : createJsonNavStore(
    navFile,
    message => ctx.logger.warn(`mud-core3: ${message}`),
  ))
  ctx.provide('mudNav', navService)

  // ── 引擎窄面（工具面，T2b）：归属解析 / 建连 / 状态快照 / 缺省参数 ──
  const toolDefaults = {
    sendTimeoutMs: config.sendTimeoutMs ?? 15000,
    sendMaxLines: config.sendMaxLines ?? 50,
    staminaFloorPct: config.staminaFloorPct ?? DEFAULT_STAMINA_FLOOR_PCT,
  }
  ctx.provide('mudCore3', {
    runtimeFor: (agent: { id: unknown }) => service.get(String(agent.id)),
    toolContextFor: (agent) => service.toolContextFor(String(agent?.id ?? '')),
    connect: async (sessionId: string) => {
      const r = await service.connect(sessionId)
      return { state: r.state }
    },
    workflowIoFor: (sessionId: string, holder: string) => service.workflowIoFor(sessionId, holder),
    stateOf: (sessionId: string) => {
      const status = service.status(sessionId)
      const rt = service.get(sessionId)
      return {
        connState: status.state,
        loggedIn: status.loggedIn,
        admitted: status.admitted,
        world: status.world,
        recording: rt?.pendingLineCount ?? 0,
        dropped: rt?.droppedLineCount ?? 0,
      }
    },
    defaults: toolDefaults,
    // 流程实体（数据归 core3，2026-10-01 裁定）：mud-workflow 注册表启动期挂载。
    // fullme（T13）：captcha 词汇表 T13.1 已落地，registerBuiltins fail-loud 可过（B6）。
    builtinFlows: [login, fullme],
  } satisfies MudCore3Service)

  // ── Remote 服务注册 ────────────────────────────────────────
  // TypertRemoteService 构造时 super(ctx, serviceKey) 已自动 ctx.provide(serviceKey)，
  // 不需要再手动 provide——重复 provide 会导致 "service already registered" 错误。
  // 构造即注册（super 里 ctx.provide(serviceKey)）；返回值不再使用。
  new MudRemoteService(
    ctx, service, () => store, () => ready, writeDeps, () => logOptions.logDir,
  )

  // typert 工件注册（先 try-import，typert 注册表不可用时跳过）。
  const typert = (ctx as unknown as { typert?: { register: (c: unknown) => () => void } }).typert
  if (typert !== undefined) {
    void import('mud-core3/typert').then(({ TYPERT }) => {
      const dispose = typert.register(TYPERT)
      ctx.effect(() => () => dispose(), 'mud-core3: typert')
    }).catch(() => {
      ctx.logger.info('mud-core3: typert 工件未注册（先跑 gen:typert）')
    })
  }

  // ── 插件卸载：断连全部 + 拆唤醒器 ───────────────────────────
  ctx.effect(() => () => {
    for (const wake of wakes.values()) wake.dispose()
    wakes.clear()
    service.disposeAll()
  })
}
