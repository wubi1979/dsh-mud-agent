/**
 * mud-core3 service — 多会话管理：registry + connect/disconnect/status + admit/stop。
 *
 * 纯 TS，零宿主依赖。宿主接线层（index.ts）注入：
 *   - serverLookup: sessionId → ServerRecord
 *   - accountLookup: sessionId → AccountRecord
 *   - resolveCreds: AccountRecord → { name, pass }（宿主 credentials 解析）
 *   - deliver: (sessionId, text) => boolean | void — 投递回调（agent.followup + createUserMessage）
 *   - logDir: 会话日志落盘目录（缺省不落盘）
 * 测试注入内存实现。
 *
 * 职责：
 *   - 维护 Map<sessionId, SessionRuntime>
 *   - register(sessionId)：登记会话 + 创建 Deliverer + 创建 SessionLog
 *   - connect(sessionId)：查服务器 → runtime.connect（只建连，盲发已退役）
 *   - workflowIoFor(sessionId, holder)：流程 IO 缝（凭据解析 + 持有者独占 + io 注入
 *     + release；流程本体在 mud-workflow 子包，core3 只供原语）
 *   - disconnect(sessionId)：runtime.disconnect
 *   - admit(sessionId)：接入闸门开（投递通道开）
 *   - stop(sessionId)：停止接入（投递停）
 *   - flushPending(sessionId)：agent 唤醒时投出保留下来的批次
 *   - status(sessionId)：连接状态 + 接入状态
 *   - logs(sessionId)：会话日志（内存 + 当日文件）
 *   - dispose(sessionId)：断连 + 拆 runtime + 拆 deliverer + 拆日志
 *   - disposeAll()：插件卸载用
 */

import { SessionRuntime, type ConnectParams } from './runtime.ts'
import { Deliverer, type DeliverFn, type DelivererConfig } from './deliver.ts'
import { Classifier, type ClassifyRuleSpec } from './classify.ts'
import type { KeepaliveOptions, ProbeState } from './link/keepalive.ts'
import type { MudLine } from './link/line.ts'
import { SessionLog, type LogEntry, type LogLevel, type SessionLogOptions } from './log/log-service.ts'
import type { GameScreen, GameViewOptions } from './view/screen.ts'
import type { LoggedInState, WorldConfidence, WorldSnapshot } from './world.ts'
import { CombatController, type CombatWindowOptions } from './combat/controller.ts'
import { CombatEdgeDetector } from './combat/state.ts'
import { CombatRuleEngine } from './combat/rules.ts'
import { CombatReporter } from './combat/report.ts'
import type {
  AccountLookup,
  AccountRecord,
  ConnState,
  CredentialResolver,
  ResolvedCredentials,
  ServerLookup,
} from './roster.ts'
// 验证码链路（T13）：恢复帧词汇表类型来自 mud-workflow 契约层（A1 单点声明）；
// 取图纯层（D3 fetch 注入）。
import type { CaptchaResume, WorkflowIO, WorkflowIoHandle } from 'mud-workflow/contract'
import { fetchCaptchaImage, type CaptchaFetch } from './captcha.ts'

/** 服务依赖（宿主/测试注入）。 */
export interface MudServiceDeps {
  readonly serverLookup: ServerLookup
  readonly accountLookup: AccountLookup
  readonly resolveCreds: CredentialResolver
  /** 投递回调：MUD 行流聚合后以用户消息投递进会话（agent.followup）。 */
  readonly deliver?: DeliverFn
  /** 投递器配置（静默窗口等）。 */
  readonly delivererConfig?: DelivererConfig
  /** 每会话录制缓冲上限行数（缺省 2000）。 */
  readonly recordLines?: number
  /**
   * 父会话查找（durable session lineage：session.header.parentSession；归属父链
   * 上溯用）。调用方应传官方 live 注册表查询（如 ctx.agents.get(id) 的 header
   * 读法，见 index.ts）——祖先必须 live，与宿主 authorizeLineage 语义一致；
   * 不 live 的祖先按无父处理（上溯终止）。缺省恒无父——工具归属只命中会话自身。
   */
  readonly parentLookup?: (sessionId: string) => string | undefined
  /** 画面通道参数（C5：scrollback/cols/maxBufferedBytes/subCap；缺省取内置缺省）。 */
  readonly view?: GameViewOptions
  /**
   * 行分类规则清单（C5.2）：缺省取 classify.DEFAULT_CLASSIFY_RULES（chat 频道锚定，
   * 语料校准 2026-10-03）。部署可覆盖（Config 正则清单，构造期编译，非法 fail-loud）。
   */
  readonly classifyRules?: readonly ClassifyRuleSpec[]
  /** 半开探活参数（T12：Config probeStartMs/probeRetryMs/probeMaxAttempts；缺省 90s/9s/3 次）。 */
  readonly keepalive?: KeepaliveOptions
  /** 自动重连参数（T5.2 D5：缺省 5 次 / 30s 间隔；到限次保持断开等人工）。 */
  readonly reconnect?: ReconnectOptions
  /** 会话日志选项（落盘目录等；缺省仅内存）。 */
  readonly log?: SessionLogOptions
  /**
   * 验证码挂起预算毫秒（T13 D4/B4：**独立预算**，不受 MAX_TIMEOUT_MS/silenceMs
   * 校验约束；缺省 180_000 = URL 有效期 3 分钟；fail-loud 正整数）。
   */
  readonly captchaTimeoutMs?: number
  /** 验证码取图 fetch（T13 D3 注入面；缺省全局 fetch，测试注入假实现）。 */
  readonly captchaFetch?: CaptchaFetch
  /**
   * 接入成功后的回调（T4a：装配层注入 kickoff 任务书投递——admit 开闸门并投
   * 一条状态任务书触发规划；测试断言接线。stop 不触发）。
   */
  readonly onAdmit?: (sessionId: string) => void
  /** 战斗系统参数（T21：退路 move 命令 + 长读窗刻度；缺省 = 撤离规则不启用、内置刻度）。 */
  readonly combat?: CombatServiceOptions
}

/** 战斗系统参数（T21，service 注入面）。 */
export interface CombatServiceOptions {
  /** 退路 move 命令（D14 退路数据；缺省不注入 ⇒ 撤离规则不启用并告警）。 */
  readonly retreatMove?: string
  /** 长读窗与重试刻度覆盖（quiet/timeout/maxLines/silentMax/pendingRetryMs）。 */
  readonly window?: CombatWindowOptions
}

/** 自动重连参数（T5.2 D5；Config reconnectMaxAttempts/reconnectIntervalMs 注入面）。 */
export interface ReconnectOptions {
  /** 意外断线的自动重连尝试次数上限。 */
  maxAttempts: number
  /** 重连尝试固定间隔毫秒。 */
  intervalMs: number
}

/** 重连缺省刻度（D5：限次放弃）。 */
const DEFAULT_RECONNECT: ReconnectOptions = { maxAttempts: 5, intervalMs: 30_000 }

/** 连接状态快照（remote status 返回面）。三期起含两轴 + 世界状态；T5.1 加探活观测面。 */
export interface SessionStatus {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
  /** 登录轴三态（inferred = 行文推断先行，in-game = GMCP 权威；断线复位 unknown）。 */
  readonly loggedIn: LoggedInState
  /** 探活观测态（T5.1：idle | probing；不回写 conn 三态）。 */
  readonly probeState: ProbeState
  /** 自主战斗总开关（T21.6 combatAuto；未登记会话缺省 true）。 */
  readonly combatAuto: boolean
  /** 世界状态快照（GMCP 写入，断线复位）。 */
  readonly world: WorldSnapshot
}

/** 状态流帧（watchStatus）：全量会话状态快照，变化时整体重推。 */
export interface StatusFrame {
  readonly sessions: readonly SessionStatus[]
}

/** 验证码挂起行（watchCaptcha 快照面；JSON 安全，Remote 边界形态）。 */
export interface CaptchaRow {
  readonly sessionId: string
  /** 账号名（弹窗标注来源，D7）。 */
  readonly account: string
  /** robot.php 页地址（MUD 行捕获）。 */
  readonly url: string
  /** 当前图（data URL；captchaRefresh 原地更新）。 */
  readonly image: string
}

/** 验证码流帧（watchCaptcha）：全量挂起快照，变化时整体重推（行摘除 = 清除帧）。 */
export interface CaptchaFrame {
  readonly pending: readonly CaptchaRow[]
}

/**
 * 验证码等待条目（等待注册表；单会话单槽——并发冲突可读拒，I10 精神）。
 * run 级缓存 = 环境闭包持有的条目引用：同 URL 沿用（答错重入不重抓），
 * refresh 原地更新 image（重入与推帧读到新图），条目收束后引用仍留作缓存。
 */
interface CaptchaEntry {
  readonly sessionId: string
  readonly account: string
  readonly url: string
  image: string
  /** 本轮挂起是否已用过刷新配额（D7：每轮挂起限 1 次——同 URL 共 4 次刷新机会）。 */
  refetched: boolean
  /** 取图在途（重复点击忽略）。 */
  refetching: boolean
  /** 收束（幂等）：清计时器 + 摘条目 + 推清除帧 + resolve 挂起 Promise。 */
  readonly finish: (r: CaptchaResume) => void
}

/** 验证码挂起预算缺省（D4：180s = URL 有效期 3 分钟）。 */
export const DEFAULT_CAPTCHA_TIMEOUT_MS = 180_000

/** 状态窄面行（Remote 边界形态，§9.5）：SessionStatus 的 JSON 安全投影。 */
export interface StatusRow {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
  /** 登录轴三态（inferred = 行文推断先行，in-game = GMCP 权威；断线复位 unknown）。 */
  readonly loggedIn: LoggedInState
  /** 探活观测态（T5.1：idle | probing；不回写 conn 三态）。 */
  readonly probeState: ProbeState
  /** 自主战斗总开关（T21.6 combatAuto；战斗刹车呈现用）。 */
  readonly combatAuto: boolean
  /** 世界状态扁平窄面：条目值 JSON 字符串化（`unknown` 不过 Remote 边界）。 */
  readonly world: readonly {
    zone: string
    key: string
    /** 原值序列化：对象 JSON.stringify，原始值 String()。 */
    v: string
    c: WorldConfidence
    /** 来源 kind（gmcp/system）与写入时刻。 */
    sk: string
    st: number
  }[]
}

/** SessionStatus → StatusRow（status()/watchStatus() 两动词共用；T11 窄面）。 */
export function statusRowOf(s: SessionStatus): StatusRow {
  const world: {
    zone: string
    key: string
    v: string
    c: WorldConfidence
    sk: string
    st: number
  }[] = []
  for (const [zone, entries] of Object.entries(s.world)) {
    for (const [key, entry] of Object.entries(entries)) {
      world.push({
        zone, key,
        v: typeof entry.value === 'string' ? entry.value
          : typeof entry.value === 'number' || typeof entry.value === 'boolean' ? String(entry.value)
          : JSON.stringify(entry.value) ?? 'null',
        c: entry.confidence,
        sk: entry.source.kind,
        st: entry.source.time,
      })
    }
  }
  return { sessionId: s.sessionId, state: s.state, admitted: s.admitted, loggedIn: s.loggedIn, probeState: s.probeState, combatAuto: s.combatAuto, world }
}

/** 工具执行上下文（归属解析结果；工具层按它定位发送目标）。 */
export interface ToolContext {
  /** 账号会话 id（= 调用方自身或其祖先中命中的账号）。 */
  readonly sessionId: string
  /** 该账号的运行时。 */
  readonly runtime: SessionRuntime
}

/**
 * 流程 IO 面（`workflowIoFor` 注入的 send/read/state 原语）。
 *
 * **端口类型单点定义在契约层**（mud-workflow `contract/ports.ts` 的
 * `WorkflowIO<L>`，A1 契约化）：core3 不再自留一份同形接口——本文件按
 * `WorkflowIO<MudLine>` 实例化（行载体参数 = 本包完整行记录，`read(initial)`
 * 原样回环无需 cast），实现处即得编译期校验；缝的一致性由
 * `MudCore3Handle extends WorkflowIoSeam<MudLine>` 断言（tools.ts）。
 *
 * 凭据零泄露的发送/注入两道闸的位置约定随本面保留：
 *   1. 发送侧：sendCredential 直发——不触发 onSend，永不进画面回显与会话日志
 *      （link/mud.ts 的既有闸门）；
 *   2. 注入侧：凭据由 core3 在 workflowIoFor 时解析后经 creds 交给调用方
 *      （mud-workflow 解释器），不经过模型；
 *   3. 出口侧脱敏（结果行 pass 掩码）在 mud-workflow 内核统一执行。
 */

/** 连接结果。 */
export interface ConnectResult {
  readonly sessionId: string
  readonly state: ConnState
}

/** 会话日志视图（remote.mud.logs 返回面）。 */
export interface SessionLogView {
  readonly sessionId: string
  /** 内存环条目（运行/网络/投递/闸门事件；原始行流不入环）。 */
  readonly entries: readonly LogEntry[]
  /** 落盘目录（null = 未配置落盘）。 */
  readonly fileTarget: string | null
}

/** 错误 → 单行可读文本（带 cause）；用于会话日志与 remote 错误面。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined
      ? `${error.name}: ${error.message}`
      : `${error.name}: ${error.message}（cause: ${String(cause)}）`
  }
  return String(error)
}

/**
 * 「会话不存在」的统一错误面（connect/admit/stop/logs/follow 共用）：
 * 宿主重启丢内存态或页面残留旧会话时，错误必须指路，不能只报一个裸 id。
 * 文案保留「未登记」子串（测试与既有调用方按子串匹配）。
 */
export function sessionNotRegistered(sessionId: string): Error {
  return new Error(
    `会话 ${sessionId} 未登记（宿主不认识该会话：可能宿主重启过或页面残留旧会话），请刷新页面后重连或重建账号`,
  )
}

/** 多会话管理服务。 */
export class MudService {
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly deliverers = new Map<string, Deliverer>()
  private readonly logs = new Map<string, SessionLog>()
  private readonly combatControllers = new Map<string, CombatController>()

  /** 状态流订阅者（watchStatus 广播面；多订阅者互不影响）。 */
  private readonly statusListeners = new Set<(frame: StatusFrame) => void>()
  /** 验证码等待注册表（sessionId → 条目；单会话单槽——并发冲突可读拒）。 */
  private readonly captchaWaits = new Map<string, CaptchaEntry>()
  /** 验证码流订阅者（watchCaptcha 广播面；多订阅者互不影响）。 */
  private readonly captchaListeners = new Set<(frame: CaptchaFrame) => void>()
  /** 验证码挂起预算（构造期 fail-loud 校验后落定）。 */
  private readonly captchaTimeoutMs: number
  /** 重连打断令牌（P1，按会话单调递增）：手工 connect/disconnect 与 dispose 递增，
   *  重连循环每步校验——不匹配立即退出，防 timer fire 与手工动作并发双连。 */
  private readonly reconnectTokens = new Map<string, number>()
  /** 在飞重连循环（按会话）：循环入口禁止重入——循环自身失败不再开第二轮。 */
  private readonly reconnecting = new Set<string>()
  private readonly deps: MudServiceDeps

  constructor(deps: MudServiceDeps) {
    this.deps = deps
    // 验证码挂起预算（T13 D4/B4）：独立预算，fail-loud 正整数（不并入
    // MAX_TIMEOUT_MS/silenceMs 校验）。
    const captchaTimeoutMs = deps.captchaTimeoutMs ?? DEFAULT_CAPTCHA_TIMEOUT_MS
    if (!Number.isSafeInteger(captchaTimeoutMs) || captchaTimeoutMs <= 0) {
      throw new Error(`mud-core3 配置 captchaTimeoutMs 必须为正整数，got ${String(captchaTimeoutMs)}`)
    }
    this.captchaTimeoutMs = captchaTimeoutMs
  }

  /**
   * 登记会话（agent/created 调用；幂等）。创建 Deliverer/SessionLog 并接线到 runtime。
   * accountName（账号名，roster accounts.name）注入 send 回显前缀；幂等重入时同名不变。
   */
  register(sessionId: string, accountName?: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (rt !== undefined) return rt
    // C5.2：分类器单点注入（规则清单 Config 可覆盖；缺省内置 chat 频道锚定规则）。
    const classifier = this.deps.classifyRules === undefined
      ? undefined
      : new Classifier(this.deps.classifyRules)
    rt = new SessionRuntime(
      sessionId, this.deps.recordLines, this.deps.view, classifier, this.deps.keepalive,
      // busy 谓词（T12 D4）：持有者在途 ∪ 回合中——link 层探测 tick 为真时跳过。
      // deliverer 在下方创建，闭包按调用期实时读，无创建时序耦合。
      () => (rt?.holderBusy ?? false) || (this.deliverers.get(sessionId)?.isInTurn ?? false),
    )
    if (accountName !== undefined) rt.accountName = accountName
    this.runtimes.set(sessionId, rt)

    const log = new SessionLog(sessionId, this.deps.log)
    this.logs.set(sessionId, log)
    log.info('runtime', '会话登记（无连接）')

    // 战斗控制器（T21.4）：每会话一个，未接入也运转（D9：不看 admit 闸门）。
    // World 计数经 writeCombatWorld（kind='combat'）；日志走 runtime 通道。
    const combat = new CombatController({
      io: rt,
      world: { get: (z, k) => rt.worldEntry(z, k), delete: (z, k) => rt.deleteWorld(z, k) },
      engine: new CombatRuleEngine(this.deps.combat?.retreatMove === undefined
        ? {}
        : { retreatMove: this.deps.combat.retreatMove }),
      detector: new CombatEdgeDetector(),
      reporter: new CombatReporter({
        write: (key, value) => { rt.writeCombatWorld(key, value) },
        log: text => { log.info('runtime', text) },
      }),
      window: this.deps.combat?.window,
    })
    this.combatControllers.set(sessionId, combat)

    // 行路径最前（T21.5 判定点①文本类）：威胁行文命中即进入危险态并接管。
    rt.onEarlyLine = line => { combat.onThreatLine(line) }
    // 状态迁移 → 广播（C5.1 watchStatus 的推帧源；值变化才触发）；
    // 断线迁移（T5.2 D4）→ 自动重连闸门判定（D4：hasConnected && !manualDisconnected）；
    // 断线（B1①）→ 验证码挂起 closed 收束（结构化，不 reject——挂起期断线靠此收束，
    // 探测不救：D8 busy 抑制）；断线 → 战斗控制器释放 + interrupted 记账（T21 W10）。
    rt.onStateChange = (state) => {
      this.emitStatus()
      if (state === 'disconnected') {
        combat.onDisconnected()
        this.resolveCaptcha(sessionId, { kind: 'closed' })
        this.scheduleAutoReconnect(sessionId, rt)
      }
    }
    // 登录轴/世界状态变化（GMCP 到达、断线复位、tracker 状态写入）→ 战斗控制器
    //（状态驱动 D1）→ 同一广播面
    rt.onWorldChange = () => {
      combat.onWorldChange()
      this.emitStatus()
    }

    // 网络层日志（telnet 协商/断线/协议异常）→ 会话日志
    rt.onLog = (level, text) => { log.append({ level, channel: 'network', text }) }

    // 投递器（pull 模型）：源 = runtime 水位线面；投递结果写会话日志。
    const delivererConfig: DelivererConfig = {
      ...this.deps.delivererConfig,
      // 交战接管期零投递（T21 D4）：战斗原文由长读窗消费并推进 readAbs，不回放。
      suppress: () => combat.suppressDelivery,
      onBatch: (id, lineCount, delivered, reason) => {
        log.info('deliver', delivered
          ? `投递 ${lineCount} 行（agent 已收）`
          : `投递未达：${lineCount} 行未投出（水位不推进，待补投）${reason === undefined ? '' : `——${reason}`}`)
        this.deps.delivererConfig?.onBatch?.(id, lineCount, delivered)
      },
    }
    if (this.deps.deliver !== undefined) {
      this.deliverers.set(sessionId, new Deliverer(sessionId, this.deps.deliver, rt, delivererConfig))
    }

    // 行流：原始行落盘（file-only，不占内存环）→ 投递器
    rt.onLine = line => {
      log.stream(line.text)
      this.deliverers.get(sessionId)?.onLine(line)
    }

    // 新会话进入状态面：广播登记
    this.emitStatus()
    return rt
  }

  /** 取运行时（工具/投递用；不存在返回 null）。 */
  get(sessionId: string): SessionRuntime | null {
    return this.runtimes.get(sessionId) ?? null
  }

  /**
   * 工具执行上下文（归属解析，PLAN 三期「归属解析」）：从调用方会话沿父链上溯
   * 查名册，命中账号会话即用它的 runtime。根调用命中自身；直接子会话（根用
   * subagent 派发）上溯即命中。未绑定 = null（工具层给可读拒绝）。
   * 环深护栏 32 层：宿主数据异常（parentSession 成环）时不死循环。
   */
  toolContextFor(sessionId: string): ToolContext | null {
    let s: string | undefined = sessionId
    for (let depth = 0; s !== undefined && depth < 32; depth += 1) {
      if (this.deps.accountLookup(s) !== undefined) {
        const rt = this.runtimes.get(s)
        if (rt !== undefined) return { sessionId: s, runtime: rt }
      }
      s = this.deps.parentLookup?.(s)
    }
    return null
  }

  /** 取会话画面通道（remote.mud.follow 用；未登记返回 null，动词侧抛错）。 */
  screenOf(sessionId: string): GameScreen | null {
    return this.runtimes.get(sessionId)?.view ?? null
  }

  /** 取投递器（测试/观测用）。 */
  getDeliverer(sessionId: string): Deliverer | null {
    return this.deliverers.get(sessionId) ?? null
  }

  /** 取战斗控制器（测试/T21.6 总开关接线用；未登记返回 null）。 */
  combatOf(sessionId: string): CombatController | null {
    return this.combatControllers.get(sessionId) ?? null
  }

  /**
   * 写一条**会话日志**（接线层用；会话未登记时静默）——`runtime` 通道，前端「MUD 日志」tab
   * 与落盘文件读的都是它（§13.1/§13.2）。`warn`/`error` 由 SessionLog 自动镜像宿主 logger。
   * @param sessionId - 会话 id。
   * @param level - 日志级别。
   * @param text - 正文（可读、点名事实）。
   */
  appendRuntimeLog(sessionId: string, level: LogLevel, text: string): void {
    this.logs.get(sessionId)?.[level]('runtime', text)
  }

  /**
   * 取已装配的投递器；未登记/未装配时抛错（与 connect 的错误面一致）。
   * @param sessionId - 会话 id。
   * @returns 该会话的投递器。
   */
  private requireDeliverer(sessionId: string): Deliverer {
    if (!this.runtimes.has(sessionId)) throw sessionNotRegistered(sessionId)
    const deliverer = this.deliverers.get(sessionId)
    if (deliverer === undefined) throw new Error(`会话 ${sessionId} 未装配投递器`)
    return deliverer
  }

  /**
   * 建连（**只建连不登录**——三期盲发退役，登录由登录脚本要点执行；记日志）。
   * @param sessionId - 会话 id。
   * @returns 会话 id 与连接状态。
   * @throws 未登记/已销毁/未绑定服务器/未在 roster/建连失败。
   */
  async connect(sessionId: string): Promise<ConnectResult> {
    const log = this.logs.get(sessionId)
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) throw sessionNotRegistered(sessionId)
    if (rt.isDisposed) throw new Error(`会话 ${sessionId} 已销毁：请刷新页面后重建账号`)

    const server = this.deps.serverLookup(sessionId)
    if (server === undefined) {
      log?.error('runtime', '连接失败：会话未绑定服务器（roster.servers 缺少该 workspaceId）')
      throw new Error(`会话 ${sessionId} 未绑定服务器`)
    }

    const account = this.deps.accountLookup(sessionId)
    if (account === undefined) {
      log?.error('runtime', '连接失败：会话未在 roster（accounts 里没有该 sessionId）')
      throw new Error(`会话 ${sessionId} 未在 roster`)
    }

    log?.info('runtime', `连接 ${server.host}:${server.port}（账号 ${account.name}，preset ${account.preset}）`)
    const params: ConnectParams = { host: server.host, port: server.port }
    // P1：手工建连先打断在飞重连循环（token 递增），在途 attempt 失效、不双连。
    this.interruptReconnect(sessionId)
    try {
      await rt.connect(params)
    } catch (error) {
      log?.error('runtime', `连接 ${server.host}:${server.port} 失败：${describeError(error)}`)
      throw error
    }
    log?.info('runtime', `已连接 ${server.host}:${server.port}（登录由流程面执行）`)
    return { sessionId, state: rt.connState }
  }

  /**
   * 流程 IO 缝（mud-workflow 内核消费）：凭据解析 + 会话级持有者 + IO 原语。
   *
   * 端口类型 = 契约层 `WorkflowIoHandle<MudLine>`（A1 单点声明）；本实现因此
   * 在编译期被断言为契约的实现（`MudCore3Handle extends WorkflowIoSeam<MudLine>`）。
   *
   * 执行序：未登记/未连接可读错 → 凭据解析（失败 fail-loud，与 W9「解析失败
   * 在动作之前」同语义）→ acquireSend(holder)（流程独占 send+read，冲突抛错
   * → 工具层可读拒绝）→ io + creds 注入。release 由调用方 finally 保证执行
   *（mud-workflow host/tools 的 mud_workflow_run 执行链）。
   * @throws 未登记/未连接/未在 roster/凭据解析失败/持有者冲突。
   */
  async workflowIoFor(sessionId: string, holder: string): Promise<WorkflowIoHandle<MudLine>> {
    const log = this.logs.get(sessionId)
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) throw sessionNotRegistered(sessionId)
    if (!rt.connected) {
      throw new Error('未连接：流程执行需要已建立的连接，可先调用 mud_connect 建连')
    }
    const account = this.deps.accountLookup(sessionId)
    if (account === undefined) throw new Error(`会话 ${sessionId} 未在 roster`)
    const credentials = await this.resolveCredentials(account, log)

    if (!rt.acquireSend(holder)) {
      throw new Error(rt.sendHolderId === 'combat'
        ? '交战中：行流由战斗系统持有（自主战斗进行中），agent 工具/流程暂不可用'
        : '另一执行体正在发送命令或等待应答（会话级独占），请稍后重试')
    }
    log?.info('runtime', `流程 IO 就绪（${holder}）`)

    // 验证码 run 级窄缓存（T14 D7：URL 由流程捕获槽传入，**image 复用职责保留**）：
    // 同 URL（答错重入——同轮 fullme 无重发引子，服务端 URL 不变）沿用缓存图
    // 不重抓；refresh 原地更新 image 随条目走；新 URL（新一轮 fullme）新抓新周期。
    // run 结束随闭包丢弃（run 级语义）。
    let cachedEntry: { url: string; image: string } | null = null
    // T14 D8：URL 参数化——闭包自取（extractCaptchaUrl + recentLines 扫描 +
    // undefined 兜底报错）删除；URL 缺失的报错点前移到 urlwait 结构化 timeout
    //（流程 captures 提取空值护栏）。
    const awaitCaptcha = async (url: string): Promise<CaptchaResume> => {
      // 单槽先判（并发第二个等待可读拒，I10 精神）。
      if (this.captchaWaits.has(sessionId)) {
        throw new Error('该会话已有验证码等待在挂起（单会话单槽），不能重复等待')
      }
      let image: string
      if (cachedEntry !== null && cachedEntry.url === url) {
        image = cachedEntry.image
      } else {
        image = await fetchCaptchaImage(url, this.deps.captchaFetch ?? fetch)
        cachedEntry = { url, image }
      }
      let settled = false
      let settle!: (r: CaptchaResume) => void
      const promise = new Promise<CaptchaResume>(res => { settle = res })
      const timer = setTimeout(() => finish({ kind: 'closed' }), this.captchaTimeoutMs)
      const finish = (r: CaptchaResume): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.captchaWaits.delete(sessionId)
        this.emitCaptcha() // 清除帧（行从快照消失）
        settle(r)
      }
      const entry: CaptchaEntry = {
        sessionId,
        account: account.name,
        url,
        image,
        refetched: false,
        refetching: false,
        finish,
      }
      cachedEntry = entry // refresh 原地更新 image → 缓存随条目走
      this.captchaWaits.set(sessionId, entry)
      this.emitCaptcha() // 挂起帧
      return promise
    }

    // 实现按契约端口实例化：行载体 = MudLine（read(initial) 原样回环），
    // 契约面只承诺 text（窄面），两侧都不需要 cast。
    const io: WorkflowIO<MudLine> = {
      send: cmd => rt.send(cmd),
      sendCredential: cmd => rt.sendCredential(cmd),
      // recentLines 只回未读行（abs > readAbs 水位过滤）：pending 环不物理消费，
      // 已被前序收束窗消费的应答行（如答错句残行）不得重入后续读窗——否则答错
      // 重入时 judge 的 initial 快照会立即再命中旧答错句。（T14.2：原「URL 抽取
      // 豁免」只为 awaitCaptcha 闭包自取存在，URL 槽化后随之删除——过滤代码零改动。）
      read: (opts, initial) => rt.read(opts, initial ?? []),
      recentLines: n => rt.recentLines(n).filter(l => l.abs > rt.readWatermark()),
      awaitCaptcha,
      state: () => this.status(sessionId),
    }
    return {
      io,
      creds: { name: credentials.name, pass: credentials.pass },
      release: () => {
        rt.releaseSend(holder)
        log?.info('runtime', `流程 IO 释放（${holder}）`)
      },
      // 取消挂起（B1③：宿主取消回合时 host/tools 层接 exec.signal abort 调之）——
      // 验证码挂起 closed 收束（无挂起时空操作）；收束后流程走 timeout 出口，
      // release 由调用方 finally 保证。
      cancel: () => { this.resolveCaptcha(sessionId, { kind: 'closed' }) },
    }
  }

  /** 断连。 */
  disconnect(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) return
    // P1：手工断连先打断在飞重连循环（token 递增）；D4 标记②在 runtime.disconnect 置位。
    this.interruptReconnect(sessionId)
    this.logs.get(sessionId)?.info('runtime', `手工断连（原状态 ${rt.connState}）`)
    rt.disconnect()
  }

  // ── 自动重连（T5.2 D4/D5）────────────────────────────────────────

  /**
   * 打断在飞重连（P1）：递增 token 使循环在下一步校验点退出，并清在飞标记。
   * 手工 connect / disconnect / dispose 三入口调用。
   */
  private interruptReconnect(sessionId: string): void {
    this.reconnectTokens.set(sessionId, (this.reconnectTokens.get(sessionId) ?? 0) + 1)
    this.reconnecting.delete(sessionId)
  }

  /**
   * 自动重连闸门（D4）：曾 connected 且非手工断开、runtime 未销毁 → 启动重连循环。
   * 循环入口禁止重入（循环自身失败产生的 disconnected 不再开第二轮）。
   * 冷启动（新 runtime 无 hasConnected）设计保证不进入。
   */
  private scheduleAutoReconnect(sessionId: string, rt: SessionRuntime): void {
    if (this.reconnecting.has(sessionId)) return
    if (rt.isDisposed || !rt.hasConnected || rt.manualDisconnected) return
    void this.runReconnectLoop(sessionId, rt)
  }

  /**
   * 重连循环（D5：限次 + 固定间隔）。每步开始前与每个 await 返回后都校验
   * 「token 未变且 runtime 未销毁」，不满足立即退出、不发起新 attempt。
   * 重连成功只连不登（D6），显式 arm 一次静默计时（C3 pulseActivity）。
   */
  private async runReconnectLoop(sessionId: string, rt: SessionRuntime): Promise<void> {
    const log = this.logs.get(sessionId)
    const token = (this.reconnectTokens.get(sessionId) ?? 0) + 1
    this.reconnectTokens.set(sessionId, token)
    this.reconnecting.add(sessionId)
    const maxAttempts = this.deps.reconnect?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts
    const intervalMs = this.deps.reconnect?.intervalMs ?? DEFAULT_RECONNECT.intervalMs
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this.reconnectTokens.get(sessionId) !== token || rt.isDisposed) return
        const server = this.deps.serverLookup(sessionId)
        if (server === undefined) {
          log?.error('runtime', '自动重连终止：会话未绑定服务器')
          return
        }
        log?.info('runtime', `自动重连第 ${attempt}/${maxAttempts} 次 → ${server.host}:${server.port}`)
        try {
          await rt.connect({ host: server.host, port: server.port })
        } catch (error) {
          // await 返回后校验：手工动作/销毁已打断（token 变）→ 立即退出。
          if (this.reconnectTokens.get(sessionId) !== token || rt.isDisposed) return
          log?.error('runtime', `自动重连第 ${attempt} 次失败：${describeError(error)}`)
          if (attempt >= maxAttempts) {
            log?.error('runtime', `自动重连已达上限（${maxAttempts} 次），保持断开等人工`)
            return
          }
          await new Promise(r => setTimeout(r, intervalMs))
          continue
        }
        // await 返回后校验（P1）：成功也得确认未被手工动作/销毁打断。
        if (this.reconnectTokens.get(sessionId) !== token || rt.isDisposed) return
        // 成功：计数随循环退出自然复位；C3 显式 arm 一次静默计时（提示符静默期
        // 「到期 → 探活 → 判活 → 唤醒」链路照常推进）。
        log?.info('runtime', '自动重连成功（只连不登，登录由 agent 规划）')
        rt.pulseActivity()
        return
      }
    } finally {
      // 仅当 token 未被替换时清在飞标记（token 已变 = 手工动作已接管并清理）。
      if (this.reconnectTokens.get(sessionId) === token) {
        this.reconnecting.delete(sessionId)
      }
    }
  }

  /**
   * 接入：MUD 信息开始进入 agent（投递通道开；水位 = 当前时刻）。
   * @throws 会话未登记（或未装配投递器）时抛错——不谎报接入成功。
   */
  admit(sessionId: string): void {
    this.requireDeliverer(sessionId).admit()
    this.logs.get(sessionId)?.info('gate', '接入：MUD 信息开始进入 agent')
    this.emitStatus()
    // T4a：开闸门并投状态任务书（装配层注入 kickoff；保持纯闸门语义，投递是旁路）。
    this.deps.onAdmit?.(sessionId)
  }

  /**
   * 停止接入：MUD 信息不再进入 agent（投递停；行流照常积累）。
   * @throws 会话未登记（或未装配投递器）时抛错。
   */
  stop(sessionId: string): void {
    this.requireDeliverer(sessionId).stop()
    this.logs.get(sessionId)?.info('gate', '停止接入：后续 MUD 行不再进入 agent（行流照常落盘）')
    this.emitStatus()
  }

  /**
   * 投出保留下来的批次（agent 唤醒时调用；未接入或已见线之后无新行时空操作）。
   * deliver 回调返回 false 时批次不推进水位，等下一次唤醒。
   */
  flushPending(sessionId: string): void {
    const deliverer = this.deliverers.get(sessionId)
    if (deliverer === undefined || deliverer.pendingCount === 0) return
    this.logs.get(sessionId)?.info('deliver', `agent 上线，补投未投行（${deliverer.pendingCount} 行）`)
    deliverer.flushNow()
  }

  /** turn 开始（宿主 turn/start 事件）：投递抑制（行只进 pending，回合末冲刷）。 */
  turnStart(sessionId: string): void {
    this.logs.get(sessionId)?.debug('deliver', '回合开始：行进 pending，投递抑制定时器清零')
    this.deliverers.get(sessionId)?.onTurnStart()
  }

  /**
   * turn 结束（宿主 turn/end 事件）：退出抑制并冲刷一次。
   *
   * **必须推迟一个微任务**：本方法由 `session/event`（turn/end）观察者触发，而宿主 `Session.append`
   * 在整个 append 发布期（含观察者回调；`appending` 标志同步覆盖、`finally` 才清）禁止重入追加
   * （`session append cannot reenter while another append is being published`）。回合末冲刷会经
   * `deliver → agent.followup` 追加 `user/message` ⇒ 同步冲刷必被护栏拒绝（实测：投递报错、该批行延后
   * 一个回合才补投）。微任务在发布期结束之后执行，投递语义（§7.2 回合末冲刷）不变。
   */
  turnEnd(sessionId: string): void {
    this.logs.get(sessionId)?.debug('deliver', '回合结束：冲刷 pending')
    const deliverer = this.deliverers.get(sessionId)
    if (deliverer === undefined) return
    queueMicrotask(() => { deliverer.onTurnEnd() })
  }

  /** 两轴 + 接入 + 探活观测 + 战斗开关 + 世界状态。 */
  status(sessionId: string): SessionStatus {
    const rt = this.runtimes.get(sessionId)
    const del = this.deliverers.get(sessionId)
    return {
      sessionId,
      state: rt?.connState ?? 'disconnected',
      admitted: del?.isAdmitted ?? false,
      loggedIn: rt?.loggedIn ?? 'unknown',
      probeState: rt?.probeState ?? 'idle',
      combatAuto: this.combatControllers.get(sessionId)?.combatAuto ?? true,
      world: rt?.world ?? {},
    }
  }

  /**
   * 战斗刹车（T21.6 combatAuto 总开关）：关闭 = 人打断——立即释放当前遭遇并挂起
   * （不接管、不开窗、危险通道也不动作）；恢复 = 新遭遇照常接管，不追补当前场。
   * @throws 会话未登记时抛错。
   */
  setCombatAuto(sessionId: string, on: boolean): void {
    const combat = this.combatControllers.get(sessionId)
    if (combat === undefined) throw new Error(`会话 ${sessionId} 未登记`)
    combat.setCombatAuto(on)
    this.emitStatus()
  }

  /** 全部会话状态（管理面用）。 */
  statuses(): readonly SessionStatus[] {
    return [...this.runtimes.keys()].map(id => this.status(id))
  }

  /**
   * 订阅状态变化（C5.1 watchStatus 的广播源）：任何状态面变更点回调全量快照。
   * @returns 注销函数（多订阅者互不影响）。
   */
  subscribeStatus(listener: (frame: StatusFrame) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** 广播当前全量状态（fire-and-forget；单订阅者异常不拖累其他订阅者）。 */
  private emitStatus(): void {
    if (this.statusListeners.size === 0) return
    const frame: StatusFrame = { sessions: this.statuses() }
    for (const listener of [...this.statusListeners]) {
      try { listener(frame) } catch { /* 订阅者异常不拖累广播 */ }
    }
  }

  /**
   * 状态流（watchStatus 动词的流实现）：首帧全量快照，随后仅在状态变化时推帧
   * （无变化零流量）。signal abort / 迭代器 return（客户端断开）即清订阅。
   */
  async *watchStatusStream(signal: AbortSignal): AsyncIterable<StatusFrame> {
    const queue: StatusFrame[] = []
    let wake: (() => void) | null = null
    const pulse = (): void => {
      if (wake !== null) { wake(); wake = null }
    }
    const unsubscribe = this.subscribeStatus(frame => {
      queue.push(frame)
      pulse()
    })
    const onAbort = (): void => { pulse() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      queue.push({ sessions: this.statuses() })
      while (!signal.aborted) {
        const frame = queue.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }

  // ── 验证码通道（T13 D7：独立流动词 + 三输入动词）──────────────────

  /**
   * 验证码流（watchCaptcha 的流实现）：首帧全量挂起快照（页面刷新/重连/
   * 重开恢复弹窗），条目变化（挂起/刷新换图/收束）时整体重推——行摘除即清除帧。
   * signal abort / 迭代器 return 即清订阅。沿 watchStatusStream 同型。
   */
  async *watchCaptchaStream(signal: AbortSignal): AsyncIterable<CaptchaFrame> {
    const queue: CaptchaFrame[] = []
    let wake: (() => void) | null = null
    const pulse = (): void => {
      if (wake !== null) { wake(); wake = null }
    }
    const unsubscribe = this.subscribeCaptcha(frame => {
      queue.push(frame)
      pulse()
    })
    const onAbort = (): void => { pulse() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      queue.push(this.captchaSnapshot())
      while (!signal.aborted) {
        const frame = queue.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }

  /** 订阅验证码流（首帧补推由 watchCaptchaStream 负责；多订阅者互不影响）。 */
  subscribeCaptcha(listener: (frame: CaptchaFrame) => void): () => void {
    this.captchaListeners.add(listener)
    return () => { this.captchaListeners.delete(listener) }
  }

  /** 当前挂起快照（watchCaptcha 首帧与广播共用）。 */
  private captchaSnapshot(): CaptchaFrame {
    const pending: CaptchaRow[] = []
    for (const entry of this.captchaWaits.values()) {
      pending.push({ sessionId: entry.sessionId, account: entry.account, url: entry.url, image: entry.image })
    }
    return { pending }
  }

  /** 广播当前挂起快照（fire-and-forget；单订阅者异常不拖累其他订阅者）。 */
  private emitCaptcha(): void {
    if (this.captchaListeners.size === 0) return
    const frame = this.captchaSnapshot()
    for (const listener of [...this.captchaListeners]) {
      try { listener(frame) } catch { /* 订阅者异常不拖累广播 */ }
    }
  }

  /** 取挂起条目（无挂起 → 可读错——三输入动词共用的错误面）。 */
  private requireCaptchaEntry(sessionId: string): CaptchaEntry {
    const entry = this.captchaWaits.get(sessionId)
    if (entry === undefined) {
      throw new Error(`会话 ${sessionId} 当前没有挂起的验证码等待`)
    }
    return entry
  }

  /** 收束挂起（幂等；无挂起空操作）——断线/销毁/取消回合三退出路径共用。 */
  private resolveCaptcha(sessionId: string, r: CaptchaResume): void {
    this.captchaWaits.get(sessionId)?.finish(r)
  }

  /**
   * 提交人工码值（captchaAnswer）：只 resolve 挂起，`fullme {captcha}` 由流程
   * 动作统一声明发送（D5：人工只提供值）。
   */
  async captchaAnswer(sessionId: string, value: string): Promise<void> {
    this.requireCaptchaEntry(sessionId).finish({ kind: 'answer', value: value.trim() })
  }

  /** 中止（captchaAbort）：专用 aborted 出口收束（D4：人工中止是常规路径）。 */
  async captchaAbort(sessionId: string): Promise<void> {
    this.requireCaptchaEntry(sessionId).finish({ kind: 'aborted' })
  }

  /**
   * 刷新（captchaRefresh）：重抓同 URL 页（页面自动刷新出新图）→ 条目原地更新
   * → 推新帧；挂起 Promise 不动、计时不重置。每轮挂起限 1 次（D7：同 URL 共
   * 4 次刷新机会、第 5 次页面失效）；取图在途的重复点击忽略。
   */
  async captchaRefresh(sessionId: string): Promise<{ image: string }> {
    const entry = this.requireCaptchaEntry(sessionId)
    if (entry.refetched) {
      throw new Error('本轮刷新配额已用完（每个验证码限刷新 1 次）')
    }
    if (entry.refetching) return { image: entry.image }
    entry.refetching = true
    try {
      entry.image = await fetchCaptchaImage(entry.url, this.deps.captchaFetch ?? fetch)
      entry.refetched = true
      this.emitCaptcha()
      return { image: entry.image }
    } finally {
      entry.refetching = false
    }
  }

  /**
   * 读会话日志（内存环条目 + 落盘目标）。
   * 原始行流只落盘不进环（见 SessionLog.stream），所以环里是运行/网络/投递/闸门事件。
   * @param sessionId - 会话 id。
   * @param since - 只返回 seq 大于该值的条目（前端增量拉取）。
   * @returns 日志视图；会话未登记时返回 null。
   */
  logOf(sessionId: string, since = 0): SessionLogView | null {
    const log = this.logs.get(sessionId)
    if (log === undefined) return null
    return { sessionId, entries: log.entries(since), fileTarget: log.fileTarget }
  }

  /** 销毁会话（session/disposed 调用）：断连 + 拆 runtime + 拆 deliverer + 拆日志。 */
  dispose(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) return
    // B1②：销毁先收束验证码挂起（closed——结构化收束防未捕获 rejection）。
    this.resolveCaptcha(sessionId, { kind: 'closed' })
    // P1：销毁打断在飞重连与探测（否则计时器会把已拆会话拖回来，或对已销毁
    // runtime 调 connect 抛错）；rt.dispose → disconnect 也取消在飞探测。
    this.interruptReconnect(sessionId)
    this.logs.get(sessionId)?.info('runtime', '会话销毁：断连 + 拆运行时')
    this.deliverers.get(sessionId)?.dispose()
    this.deliverers.delete(sessionId)
    this.combatControllers.delete(sessionId)
    rt.dispose()
    this.runtimes.delete(sessionId)
    this.logs.delete(sessionId)
    // 会话离开状态面：广播销毁
    this.emitStatus()
  }

  /** 销毁全部（插件卸载用）。 */
  disposeAll(): void {
    for (const id of [...this.runtimes.keys()]) this.dispose(id)
  }

  /** 当前会话数（测试/观测用）。 */
  get size(): number {
    return this.runtimes.size
  }

  /** 凭据解析（失败写日志并把原文抛给调用侧——错误面不吞）。 */
  private async resolveCredentials(
    account: AccountRecord,
    log: SessionLog | undefined,
  ): Promise<ResolvedCredentials> {
    try {
      const resolved = await this.deps.resolveCreds(account)
      log?.info('runtime', `凭据已解析（passRef=${account.passRef}；值不回显）`)
      return resolved
    } catch (error) {
      log?.error('runtime', `凭据解析失败（passRef=${account.passRef}）：${describeError(error)}`)
      throw error
    }
  }
}
