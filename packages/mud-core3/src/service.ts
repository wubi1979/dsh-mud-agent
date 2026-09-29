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
 *   - connect(sessionId)：查服务器+解析凭据 → runtime.connect（全过程记日志）
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
import { SessionLog, type LogEntry, type SessionLogOptions } from './log/log-service.ts'
import type { GameScreen, GameViewOptions } from './view/screen.ts'
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
  /** 画面通道参数（C5：scrollback/cols/maxBufferedBytes；缺省取内置缺省）。 */
  readonly view?: GameViewOptions
  /** 会话日志选项（落盘目录等；缺省仅内存）。 */
  readonly log?: SessionLogOptions
}

/** 连接状态快照（remote status 返回面）。 */
export interface SessionStatus {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
}

/** 状态流帧（watchStatus）：全量会话状态快照，变化时整体重推。 */
export interface StatusFrame {
  readonly sessions: readonly SessionStatus[]
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

  /** 登记会话（agent/created 调用；幂等）。创建 Deliverer/SessionLog 并接线到 runtime。 */
  register(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (rt !== undefined) return rt
    rt = new SessionRuntime(sessionId, this.deps.recordLines, this.deps.view)
    this.runtimes.set(sessionId, rt)

    const log = new SessionLog(sessionId, this.deps.log)
    this.logs.set(sessionId, log)
    log.info('runtime', '会话登记（无连接）')

    // 状态迁移 → 广播（C5.1 watchStatus 的推帧源；值变化才触发）
    rt.onStateChange = () => { this.emitStatus() }

    // 网络层日志（telnet 协商/断线/协议异常）→ 会话日志
    rt.onLog = (level, text) => { log.append({ level, channel: 'network', text }) }

    // 投递器：投递结果与缓冲溢出写会话日志（并转发装配层的 onDrop 上报）
    const delivererConfig: DelivererConfig = {
      ...this.deps.delivererConfig,
      onDrop: (id, droppedNow, droppedTotal) => {
        log.warn('deliver', `投递缓冲溢出，丢弃 ${droppedNow} 行（累计 ${droppedTotal}）`)
        this.deps.delivererConfig?.onDrop?.(id, droppedNow, droppedTotal)
      },
      onBatch: (id, lineCount, delivered) => {
        log.info('deliver', delivered
          ? `投递 ${lineCount} 行（agent 已收）`
          : `agent 离线：保留 ${lineCount} 行待补投`)
        this.deps.delivererConfig?.onBatch?.(id, lineCount, delivered)
      },
    }
    if (this.deps.deliver !== undefined) {
      this.deliverers.set(sessionId, new Deliverer(sessionId, this.deps.deliver, delivererConfig))
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
   * 建连 + login（全过程写入会话日志：失败原因不吞）。
   * @param sessionId - 会话 id。
   * @returns 会话 id 与连接状态。
   * @throws 未登记/已销毁/未绑定服务器/未在 roster/凭据解析失败/建连失败。
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
    const credentials = await this.resolveCredentials(account, log)

    const params: ConnectParams = {
      host: server.host,
      port: server.port,
      credentials,
    }
    try {
      await rt.connect(params)
    } catch (error) {
      log?.error('runtime', `连接 ${server.host}:${server.port} 失败：${describeError(error)}`)
      throw error
    }
    log?.info('runtime', `已连接 ${server.host}:${server.port}（login 已发送）`)
    return { sessionId, state: rt.connState }
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
   * 投出保留下来的批次（agent 唤醒时调用；未接入或无缓冲时为空操作）。
   * deliver 回调返回 false 时批次继续保留，等下一次唤醒。
   */
  flushPending(sessionId: string): void {
    const deliverer = this.deliverers.get(sessionId)
    if (deliverer === undefined || deliverer.pendingCount === 0) return
    this.logs.get(sessionId)?.info('deliver', `agent 上线，补投保留批次（${deliverer.pendingCount} 行）`)
    deliverer.flushNow()
  }

  /** 连接状态 + 接入状态。 */
  status(sessionId: string): SessionStatus {
    const rt = this.runtimes.get(sessionId)
    const del = this.deliverers.get(sessionId)
    return {
      sessionId,
      state: rt?.connState ?? 'disconnected',
      admitted: del?.isAdmitted ?? false,
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
