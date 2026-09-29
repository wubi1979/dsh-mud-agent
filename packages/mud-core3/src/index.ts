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
// 宿主事件类型增强（agent/created、session/disposed 等）。
import type {} from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'

import { MudService, sessionNotRegistered } from './service.ts'
import type { SessionRuntime } from './runtime.ts'
import type { SessionLogOptions } from './log/log-service.ts'
import { resolveLogDir, purgeSessionLogs } from './log/log-service.ts'
// Remote 边界类型从非根子路径取（typert 要求，见 src/types.ts）。
import type { AccountRecord, GameFrame, LogEntry, ServerRecord, StatusFrame } from './types.ts'
import type { DelivererConfig } from './deliver.ts'
import type {
  CredentialResolver, ResolvedCredentials, RosterStore,
} from './roster.ts'
import { MemoryRosterStore, openDomainRosterStore, type HostStorageDomain } from './store.ts'
import { bootstrapText } from './bootstrap.ts'
import {
  addAccount as writeAccount, addServer as writeServer, removeAccount as dropAccount,
  removeServer as dropServer, setAdmitted,
} from './accounts.ts'

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
  /** 未投出缓冲上限行数（超出丢最旧）。缺省 500。 */
  deliverMaxPendingLines?: number
  /** 每会话录制缓冲上限行数（未接入期间保留的最近行数）。缺省 2000。 */
  recordLines?: number
  /** 画面通道 scrollback 行数（snapshot 回放深度）。缺省 2000（对齐录制缓冲）。 */
  viewScrollback?: number
  /** 画面通道列数（固定，不做 resize 回传）。缺省 80。 */
  viewCols?: number
  /** 画面通道单 follower 缓冲上限字节（超限显式断流，重连恢复）。缺省 2MB。 */
  viewMaxBufferedBytes?: number
  /** 是否把会话日志落盘（JSONL）。缺省 true。 */
  logFile?: boolean
  /** 会话日志落盘目录。缺省 `<cwd>/mud-logs`。 */
  logDir?: string
  /** 会话日志内存环上限（remote.mud.logs 的可读窗口）。缺省 2000。 */
  logBufferMax?: number
  /** 是否把名册挂到宿主 storage 域（缺省 true；域不可用时自动降级内存并告警）。 */
  rosterStorage?: boolean
  /**
   * 建账号后是否投递一条开场消息（触发一次真实回合，把 blank 会话翻成活跃会话，
   * 会话体与 MUD 日志 tab 才会渲染）。缺省 true；关掉可省一次模型调用。
   */
  bootstrapOnCreate?: boolean
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

/** 唤醒署名：MUD 消息以用户消息到达，署名 'mud' 以区分人工提问。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mud': {
      kind: 'mud'
      plugin: string
    }
  }
}

/** remote 动词的 id 校验（typert wire 类型允许 undefined）。 */
function requireId(id: string | undefined, field: string): string {
  if (id === undefined || id === '') throw new Error(`${field} 必填`)
  return id
}

/** `ctx.provide('mudCore3', ...)` 的服务面（后期工具面的拒绝点即在此解析归属）。 */
export interface MudCore3Service {
  /** 由 agent 解析其会话 runtime；不属于本插件返回 null。 */
  runtimeFor(agent: { id: unknown }): SessionRuntime | null
}

// ── Remote 服务 ─────────────────────────────────────────────────

/** remote.mud 命名空间：名册 CRUD + 连接管理 + 接入闸门 + 日志。 */
export class MudRemoteService extends TypertRemoteService {
  private readonly service: MudService
  private readonly roster: () => RosterStore
  private readonly ready: () => Promise<void>
  private readonly writeDeps: () => Parameters<typeof writeAccount>[0]
  private readonly logDir: () => string | undefined
  private readonly announce: (account: AccountRecord) => void

  /**
   * @param ctx - 插件上下文（typert 注册）。
   * @param service - 多会话服务。
   * @param roster - 当前名册存储读取面。
   * @param ready - 名册落定（storage 域打开完成）的等待。
   * @param writeDeps - 名册写路径依赖（建会话/分配器）。
   * @param logDir - 会话日志落盘目录（删账号时清理；未落盘返回 undefined）。
   * @param announce - 建账号后的开场投递（空实现 = 关闭）。
   */
  constructor(
    ctx: Context,
    service: MudService,
    roster: () => RosterStore,
    ready: () => Promise<void>,
    writeDeps: () => Parameters<typeof writeAccount>[0],
    logDir: () => string | undefined,
    announce: (account: AccountRecord) => void,
  ) {
    super(ctx, 'mudRemote', { namespace: 'mud' })
    this.service = service
    this.roster = roster
    this.ready = ready
    this.writeDeps = writeDeps
    this.logDir = logDir
    this.announce = announce
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
   * 建账号 = 一个动作：写名册 → 建会话（sessionId = 账号 id，绑定 preset）→ 开场投递。
   * 密码由页面经 `credentials.set` 写入宿主凭据域，这里只收引用名。
   * 开场投递让新会话立刻脱离 blank（宿主 `blank` 只由 `turn/start` 翻），会话体与
   * 「MUD 日志」tab 才会渲染；投递失败不影响账号本身。
   */
  @Remote
  async addAccount(input: {
    serverId: string; name: string; passRef: string; preset: string; cwd: string
  } | undefined): Promise<{ account: AccountRecord }> {
    if (input === undefined) throw new Error('account 必填')
    await this.ready()
    const account = await writeAccount(this.writeDeps(), input)
    this.announce(account)
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

  /** 接入：MUD 信息开始进入 agent（名册 admitted 持久化）。 */
  @Remote
  async admit(sessionId: string | undefined): Promise<{ sessionId: string; admitted: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    this.service.admit(id)
    await setAdmitted(this.writeDeps(), id, true)
    return { sessionId: id, admitted: this.service.status(id).admitted }
  }

  /** 停止接入：MUD 信息不再进入 agent（名册 admitted 持久化）。 */
  @Remote
  async stop(sessionId: string | undefined): Promise<{ sessionId: string; admitted: boolean }> {
    const id = requireId(sessionId, 'sessionId')
    this.service.stop(id)
    await setAdmitted(this.writeDeps(), id, false)
    return { sessionId: id, admitted: this.service.status(id).admitted }
  }

  /** 连接状态 + 接入状态。 */
  @Remote
  status(sessionId: string | undefined): {
    state: string; admitted: boolean; sessions: readonly { sessionId: string; state: string; admitted: boolean }[]
  } {
    if (sessionId !== undefined && sessionId !== '') {
      const status = this.service.status(sessionId)
      return { state: status.state, admitted: status.admitted, sessions: this.service.statuses() }
    }
    return { state: 'disconnected', admitted: false, sessions: this.service.statuses() }
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
  async *watchStatus(signal: AbortSignal): AsyncIterable<StatusFrame> {
    yield* this.service.watchStatusStream(signal)
  }
}

// ── 插件主体 ───────────────────────────────────────────────────

/** 宿主插件装配。 */
export function apply(ctx: Context, config: MudCore3Config = {}): void {
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

  // 缓冲溢出上报限流（每会话首次 + 每累计 100 行）
  const dropLogged = new Map<string, number>()

  const delivererConfig: DelivererConfig = {
    ...(config.deliverQuietMs !== undefined ? { quietMs: config.deliverQuietMs } : {}),
    ...(config.deliverMaxWaitMs !== undefined ? { maxWaitMs: config.deliverMaxWaitMs } : {}),
    ...(config.deliverMaxLines !== undefined ? { maxLines: config.deliverMaxLines } : {}),
    ...(config.deliverMaxChars !== undefined ? { maxChars: config.deliverMaxChars } : {}),
    ...(config.deliverMaxPendingLines !== undefined
      ? { maxPendingLines: config.deliverMaxPendingLines } : {}),
    onDrop: (sessionId, droppedNow, droppedTotal) => {
      const logged = dropLogged.get(sessionId) ?? 0
      if (logged !== 0 && droppedTotal - logged < 100) return
      dropLogged.set(sessionId, droppedTotal)
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 投递缓冲溢出，丢弃 ${droppedNow} 行（累计 ${droppedTotal}）`)
    },
  }

  // 投递回调：MUD 行流聚合后以用户消息投递进会话（等同人工提问）。
  // 返回 false = 本次未投出（agent 离线或 followup 抛错），批次保留在缓冲里等唤醒补投。
  const deliver = (sessionId: string, text: string): boolean => {
    const agent = agentMap.get(sessionId)
    if (agent === undefined) return false // 冷会话：批次保留，等 agent/created 时补投
    try {
      const msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'mud', plugin: 'mud-core3' },
      })
      agent.followup(msg)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`mud-core3: 会话 ${sessionId} 投递失败，批次保留待补投: ${String(error)}`)
      return false
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
    ...(config.recordLines !== undefined ? { recordLines: config.recordLines } : {}),
    view: {
      ...(config.viewScrollback !== undefined ? { scrollback: config.viewScrollback } : {}),
      ...(config.viewCols !== undefined ? { cols: config.viewCols } : {}),
      ...(config.viewMaxBufferedBytes !== undefined
        ? { maxBufferedBytes: config.viewMaxBufferedBytes } : {}),
    },
  })

  // 建账号后的开场投递：真发一条用户消息 → 一次真实回合 → `turn/start` → 会话脱离 blank。
  // 不做伪造 turn（会污染日志的回合计数与 replay）；可用 bootstrapOnCreate: false 关闭。
  const announce = (account: AccountRecord): void => {
    if (config.bootstrapOnCreate === false) return
    const agent = agentMap.get(account.id)
    if (agent === undefined) {
      ctx.logger.warn(`mud-core3: 会话 ${account.id} 的 agent 未就绪，跳过开场消息（会话仍为 blank）`)
      return
    }
    const server = store.server(account.serverId)
    const facts = {
      serverName: server?.name ?? account.serverId,
      endpoint: server === undefined ? '未登记' : `${server.host}:${server.port}`,
      accountName: account.name,
      preset: account.preset,
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: bootstrapText(facts) }],
        source: { kind: 'mud', plugin: 'mud-core3' },
      }))
      ctx.logger.info(`mud-core3: 会话 ${account.id} 已投递开场消息（翻出 blank）`)
    } catch (error: unknown) {
      ctx.logger.warn(`mud-core3: 会话 ${account.id} 开场消息投递失败: ${String(error)}`)
    }
  }

  // ── agent/created → 名册判定 → 登记会话 + 记录 agent 句柄 + 补投 ──
  // 归属 = sessionId ∈ accounts（名册判定，不按 preset 排除）。
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.id)
    if (store.account(sessionId) === undefined) return // 不在名册 = 不是我们的会话
    service.register(sessionId)
    // 记录 agent 句柄（投递用；agent 有 followup 方法）
    agentMap.set(sessionId, { followup: msg => agent.followup(msg) })
    // agent 上线：把冷会话期间保留下来的批次投出。
    service.flushPending(sessionId)
  })

  // ── agent/disposed → 移除 agent 句柄（runtime/deliverer 保留）──
  ctx.on('agent/disposed', ({ agent }) => {
    agentMap.delete(String(agent.id))
  })

  // ── session/disposed → 断连 + 拆 runtime + 拆 deliverer + 拆日志 ──
  ctx.on('session/disposed', (session) => {
    const sessionId = String(session.id)
    if (store.account(sessionId) === undefined) return
    service.dispose(sessionId)
    agentMap.delete(sessionId)
    dropLogged.delete(sessionId)
  })

  // ── 归属解析服务（§3.1：后期工具面在此拒绝非本插件会话）────────
  ctx.provide('mudCore3', {
    runtimeFor: (agent: { id: unknown }) => service.get(String(agent.id)),
  } satisfies MudCore3Service)

  // ── Remote 服务注册 ────────────────────────────────────────
  // TypertRemoteService 构造时 super(ctx, serviceKey) 已自动 ctx.provide(serviceKey)，
  // 不需要再手动 provide——重复 provide 会导致 "service already registered" 错误。
  // 构造即注册（super 里 ctx.provide(serviceKey)）；返回值不再使用。
  new MudRemoteService(
    ctx, service, () => store, () => ready, writeDeps, () => logOptions.logDir, announce,
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

  // ── 插件卸载：断连全部 ─────────────────────────────────────
  ctx.effect(() => () => { service.disposeAll() })
}
