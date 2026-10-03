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
 *   - workflowEnvFor(sessionId, holder)：流程环境缝（凭据解析 + 持有者独占 + env 注入
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
import type { ReadOpts, ReadResult } from './read.ts'
import type { MudLine } from './link/line.ts'
import { SessionLog, type LogEntry, type SessionLogOptions } from './log/log-service.ts'
import type { GameScreen, GameViewOptions } from './view/screen.ts'
import type { LoggedInState, WorldConfidence, WorldSnapshot } from './world.ts'
import type {
  AccountLookup,
  AccountRecord,
  ConnState,
  CredentialResolver,
  ResolvedCredentials,
  ServerLookup,
} from './roster.ts'

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
  /** 画面通道参数（C5：scrollback/cols/maxBufferedBytes；缺省取内置缺省）。 */
  readonly view?: GameViewOptions
  /** 会话日志选项（落盘目录等；缺省仅内存）。 */
  readonly log?: SessionLogOptions
  /**
   * 接入成功后的回调（T4a：装配层注入 kickoff 任务书投递——admit 开闸门并投
   * 一条状态任务书触发规划；测试断言接线。stop 不触发）。
   */
  readonly onAdmit?: (sessionId: string) => void
}

/** 连接状态快照（remote status 返回面）。三期起含两轴 + 世界状态。 */
export interface SessionStatus {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
  /** 登录轴三态（inferred = 行文推断先行，in-game = GMCP 权威；断线复位 unknown）。 */
  readonly loggedIn: LoggedInState
  /** 世界状态快照（GMCP 写入，断线复位）。 */
  readonly world: WorldSnapshot
}

/** 状态流帧（watchStatus）：全量会话状态快照，变化时整体重推。 */
export interface StatusFrame {
  readonly sessions: readonly SessionStatus[]
}

/** 状态窄面行（Remote 边界形态，§9.5）：SessionStatus 的 JSON 安全投影。 */
export interface StatusRow {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
  /** 登录轴三态（inferred = 行文推断先行，in-game = GMCP 权威；断线复位 unknown）。 */
  readonly loggedIn: LoggedInState
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
  return { sessionId: s.sessionId, state: s.state, admitted: s.admitted, loggedIn: s.loggedIn, world }
}

/** 工具执行上下文（归属解析结果；工具层按它定位发送目标）。 */
export interface ToolContext {
  /** 账号会话 id（= 调用方自身或其祖先中命中的账号）。 */
  readonly sessionId: string
  /** 该账号的运行时。 */
  readonly runtime: SessionRuntime
}

/**
 * 流程执行环境（`workflowEnvFor` 注入的 send/read/state 原语；原 workflow.ts
 * 余留类型，2026-10-02 并入 service——类型与生产者同址）。
 *
 * 与 mud-workflow 的 WorkflowEnv（env.ts）同形，mud-workflow 工具层按窄结构
 * 代位 cast。凭据零泄露的发送/注入两道闸的位置约定随本面保留：
 *   1. 发送侧：sendCredential 直发——不触发 onSend，永不进画面回显与会话日志
 *      （link/mud.ts 的既有闸门）；
 *   2. 注入侧：凭据由 core3 在 workflowEnvFor 时解析后经 creds 交给调用方
 *      （mud-workflow 解释器），不经过模型；
 *   3. 出口侧脱敏（结果行 pass 掩码）在 mud-workflow 解释器统一执行。
 */
export interface WorkflowEnv {
  /** 直发命令（进画面回显 + 会话日志）。 */
  send(cmd: string): boolean
  /** 凭据直发（不回显、不落盘、不进会话日志）。 */
  sendCredential(cmd: string): boolean
  /** 判据驱动读应答（initial 可带 pending 尾部快照，提示符先到不丢）。 */
  read(opts: ReadOpts, initial?: readonly MudLine[]): Promise<ReadResult>
  /** pending 尾部 N 行快照（等待前的"提示符可能已到达"对齐）。 */
  recentLines(n: number): MudLine[]
  /** 会话状态快照（连接/登录/接入/世界）。 */
  state(): SessionStatus
}

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

  /** 状态流订阅者（watchStatus 广播面；多订阅者互不影响）。 */
  private readonly statusListeners = new Set<(frame: StatusFrame) => void>()
  private readonly deps: MudServiceDeps

  constructor(deps: MudServiceDeps) {
    this.deps = deps
  }

  /**
   * 登记会话（agent/created 调用；幂等）。创建 Deliverer/SessionLog 并接线到 runtime。
   * accountName（账号名，roster accounts.name）注入 send 回显前缀；幂等重入时同名不变。
   */
  register(sessionId: string, accountName?: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (rt !== undefined) return rt
    rt = new SessionRuntime(sessionId, this.deps.recordLines, this.deps.view)
    if (accountName !== undefined) rt.accountName = accountName
    this.runtimes.set(sessionId, rt)

    const log = new SessionLog(sessionId, this.deps.log)
    this.logs.set(sessionId, log)
    log.info('runtime', '会话登记（无连接）')

    // 状态迁移 → 广播（C5.1 watchStatus 的推帧源；值变化才触发）
    rt.onStateChange = () => { this.emitStatus() }
    // 登录轴/世界状态变化（GMCP 到达、断线复位）→ 同一广播面
    rt.onWorldChange = () => { this.emitStatus() }

    // 网络层日志（telnet 协商/断线/协议异常）→ 会话日志
    rt.onLog = (level, text) => { log.append({ level, channel: 'network', text }) }

    // 投递器（pull 模型）：源 = runtime 水位线面；投递结果写会话日志。
    const delivererConfig: DelivererConfig = {
      ...this.deps.delivererConfig,
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
   * 流程环境缝（mud-workflow 解释器消费）：凭据解析 + 会话级持有者 + env 原语。
   *
   * 执行序：未登记/未连接可读错 → 凭据解析（失败 fail-loud，与 W9「解析失败
   * 在动作之前」同语义）→ acquireSend(holder)（流程独占 send+read，冲突抛错
   * → 工具层可读拒绝）→ env + creds 注入。release 由调用方 finally 保证执行
   *（mud-workflow tools 的 mud_workflow_run 执行链）。
   * @throws 未登记/未连接/未在 roster/凭据解析失败/持有者冲突。
   */
  async workflowEnvFor(sessionId: string, holder: string): Promise<{
    env: WorkflowEnv
    creds: { name: string; pass: string }
    release(): void
  }> {
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
      throw new Error('另一执行体正在发送命令或等待应答（会话级独占），请稍后重试')
    }
    log?.info('runtime', `流程环境就绪（${holder}）`)
    const env: WorkflowEnv = {
      send: cmd => rt.send(cmd),
      sendCredential: cmd => rt.sendCredential(cmd),
      read: (opts, initial) => rt.read(opts, initial ?? []),
      recentLines: n => rt.recentLines(n),
      state: () => this.status(sessionId),
    }
    return {
      env,
      creds: { name: credentials.name, pass: credentials.pass },
      release: () => {
        rt.releaseSend(holder)
        log?.info('runtime', `流程环境释放（${holder}）`)
      },
    }
  }

  /** 断连。 */
  disconnect(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) return
    this.logs.get(sessionId)?.info('runtime', `手工断连（原状态 ${rt.connState}）`)
    rt.disconnect()
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

  /** turn 结束（宿主 turn/end 事件）：退出抑制并冲刷一次。 */
  turnEnd(sessionId: string): void {
    this.logs.get(sessionId)?.debug('deliver', '回合结束：冲刷 pending')
    this.deliverers.get(sessionId)?.onTurnEnd()
  }

  /** 两轴 + 接入 + 世界状态。 */
  status(sessionId: string): SessionStatus {
    const rt = this.runtimes.get(sessionId)
    const del = this.deliverers.get(sessionId)
    return {
      sessionId,
      state: rt?.connState ?? 'disconnected',
      admitted: del?.isAdmitted ?? false,
      loggedIn: rt?.loggedIn ?? 'unknown',
      world: rt?.world ?? {},
    }
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
    this.logs.get(sessionId)?.info('runtime', '会话销毁：断连 + 拆运行时')
    this.deliverers.get(sessionId)?.dispose()
    this.deliverers.delete(sessionId)
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
