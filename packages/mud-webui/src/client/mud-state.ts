/**
 * dsh-mud-webui — client-side MUD state (client half, core3).
 *
 * 服务器/账号 roster + 每会话连接/接入状态。
 * - 服务器 = 工作区 + host/port（v1 呈现不改）
 * - 账号 = 会话（建账号时自动建会话，sessionId = accountId）
 * - 新增：preset 字段 + admitted 接入状态
 * - 移除：tier/capability、command、captcha、bind、purge（core3 第一期不需要）
 *
 * roster 仍存 localStorage（storage domain 接入是 C3遗留）。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-state
 */

import type { MudRemoteController, MudStatusFrame, MudWorldEntry } from './mud-remote.ts'
import type { MudCredentialInfo, MudCredentialsController } from './mud-credentials.ts'

/** One MUD game account attached to a server, bound to its own DSH session. */
export interface MudUser {
  readonly id: string
  readonly name: string
  readonly passRef: string
  readonly sessionId: string
  /** 建账号时选的 preset id（如 'mud-player' / 'standard'）。 */
  readonly preset: string
}

/** One MUD server (host:port) with its accounts, bound to a workspace directory. */
export interface MudServer {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly cwd: string
  readonly users: readonly MudUser[]
}

/** Connection lifecycle state（T5.1：probing = 探活观测态，仅呈现用，非服务端 conn 值）。 */
export type MudConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'probing'

/** Connection info shown in the sidebar. */
export interface MudConnInfo {
  readonly state: MudConnState
  readonly serverId: string | null
  readonly userId: string | null
  readonly sessionId: string | null
  readonly label: string | null
  readonly error: string | null
}

/** Per-session status (连接 + 接入 + 登录轴 + 探活观测 + 世界窄面). */
export interface SessionStatusRow {
  readonly sessionId: string
  readonly state: string
  readonly admitted: boolean
  readonly loggedIn: 'unknown' | 'inferred' | 'in-game'
  /** 探活观测态（T5.1；缺省 idle——旧服务端或未探测）。 */
  readonly probeState?: 'idle' | 'probing'
  /** 自主战斗总开关（T21.6；缺省 true——旧服务端无此字段）。 */
  readonly combatAuto?: boolean
  readonly world: readonly MudWorldEntry[]
}

/** Full client-visible MUD state snapshot. */
export interface MudServersSnapshot {
  readonly servers: readonly MudServer[]
  readonly active: { readonly serverId: string | null; readonly userId: string | null }
  readonly conn: MudConnInfo
  readonly sessionStatus: Readonly<Record<string, SessionStatusRow>>
  readonly credentialStatus: Readonly<Record<string, MudCredentialInfo>>
}

/** localStorage key for the roster. */
const STORAGE_KEY = 'dsh.mud.servers.v3'

/** Idle connection info. */
export const IDLE_CONN: MudConnInfo = {
  state: 'idle',
  serverId: null,
  userId: null,
  sessionId: null,
  label: null,
  error: null,
}

/** Parse roster from localStorage. */
function parseRoster(value: unknown): {
  servers: MudServer[]
  active: MudServersSnapshot['active']
} | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as { servers?: unknown; active?: unknown }
  if (!Array.isArray(raw.servers)) return null
  const servers: MudServer[] = []
  for (const item of raw.servers) {
    if (typeof item !== 'object' || item === null) return null
    const server = item as { id?: unknown; name?: unknown; host?: unknown; port?: unknown; cwd?: unknown; users?: unknown }
    if (typeof server.id !== 'string' || typeof server.name !== 'string'
      || typeof server.host !== 'string' || typeof server.port !== 'number'
      || !Array.isArray(server.users)) return null
    const users: MudUser[] = []
    for (const user of server.users) {
      if (typeof user !== 'object' || user === null) return null
      const u = user as { id?: unknown; name?: unknown; passRef?: unknown; sessionId?: unknown; preset?: unknown }
      if (typeof u.id !== 'string' || typeof u.name !== 'string') return null
      users.push({
        id: u.id,
        name: u.name,
        passRef: typeof u.passRef === 'string' ? u.passRef : '',
        sessionId: typeof u.sessionId === 'string' ? u.sessionId : '',
        preset: typeof u.preset === 'string' ? u.preset : 'mud-player',
      })
    }
    servers.push({
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port,
      cwd: typeof server.cwd === 'string' ? server.cwd : '',
      users,
    })
  }
  const act = typeof raw.active === 'object' && raw.active !== null
    ? raw.active as { serverId?: unknown; userId?: unknown }
    : undefined
  const active = {
    serverId: act !== undefined && typeof act.serverId === 'string' ? act.serverId : null,
    userId: act !== undefined && typeof act.userId === 'string' ? act.userId : null,
  }
  return { servers, active }
}

function loadRoster(): { servers: MudServer[]; active: MudServersSnapshot['active'] } {
  const empty = { servers: [] as MudServer[], active: { serverId: null, userId: null } }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return empty
    return parseRoster(JSON.parse(raw)) ?? empty
  } catch {
    return empty
  }
}

/** Roster + per-session controller. */
export class MudStateController {
  private state: MudServersSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly remote: MudRemoteController
  private readonly credentials: MudCredentialsController

  constructor(remote: MudRemoteController, credentials: MudCredentialsController) {
    this.remote = remote
    this.credentials = credentials
    const loaded = loadRoster()
    this.state = {
      servers: loaded.servers,
      active: loaded.active,
      conn: IDLE_CONN,
      sessionStatus: {},
      credentialStatus: {},
    }
  }

  getSnapshot(): MudServersSnapshot { return this.state }

  /**
   * 用宿主名册覆盖本地呈现缓存（localStorage 只是缓存，宿主才是事实源）。
   * 页面加载挂载成功后调用一次：刷新/宿主重启后本地残留的「假服务器/死会话」
   * 被服务端真值覆盖，避免对着已不存在的记录做操作。
   * 服务端记录没有 cwd：同 id 服务器保留本地 cwd，新服务器补空串。
   */
  hydrate(
    body: {
      servers: readonly { workspaceId: string; name: string; host: string; port: number }[]
      accounts: readonly { id: string; name: string; passRef: string; serverId: string; preset: string }[]
    },
  ): void {
    const cwdOf = new Map(this.state.servers.map(s => [s.id, s.cwd]))
    const usersOf = new Map<string, MudUser[]>()
    for (const account of body.accounts) {
      const users = usersOf.get(account.serverId) ?? []
      users.push({
        id: account.id, name: account.name, passRef: account.passRef,
        sessionId: account.id, preset: account.preset,
      })
      usersOf.set(account.serverId, users)
    }
    this.set({
      servers: body.servers.map(s => ({
        id: s.workspaceId, name: s.name, host: s.host, port: s.port,
        cwd: cwdOf.get(s.workspaceId) ?? '',
        users: usersOf.get(s.workspaceId) ?? [],
      })),
    })
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(patch: Partial<MudServersSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of [...this.listeners]) fn()
    this.persist()
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        servers: this.state.servers,
        active: this.state.active,
      }))
    } catch { /* storage unavailable */ }
  }

  /**
   * 建档服务器（键 = workspaceId；工作区实体由调用侧经宿主 workspace 面创建）。
   * @param input - 服务器属性与它的 workspaceId。
   * @returns 落地的服务器记录。
   */
  addServer(input: { id: string; name: string; host: string; port: number; cwd: string }): MudServer {
    const name = input.name.trim() || `${input.host}:${input.port}`
    const server: MudServer = {
      id: input.id, name, host: input.host.trim(), port: input.port,
      cwd: input.cwd.trim(), users: [],
    }
    this.set({ servers: [...this.state.servers, server] })
    return server
  }

  removeServer(serverId: string): void {
    const active = this.state.active
    const nextActive = active.serverId === serverId ? { serverId: null, userId: null } : active
    this.set({
      servers: this.state.servers.filter(s => s.id !== serverId),
      ...(nextActive !== active ? { active: nextActive } : {}),
    })
  }

  /**
   * 记入账号（id/sessionId 由宿主 `remote.mud.addAccount` 返回：账号 id = 会话 id）。
   * @param serverId - 所属服务器（= workspaceId）。
   * @param input - 宿主账号身份与属性。
   * @returns 落地的账号记录。
   */
  addUser(
    serverId: string,
    input: { id: string; name: string; passRef: string; preset: string },
  ): MudUser | null {
    const server = this.state.servers.find(s => s.id === serverId)
    if (server === undefined) return null
    const user: MudUser = {
      id: input.id, name: input.name.trim(), passRef: input.passRef,
      sessionId: input.id, preset: input.preset,
    }
    this.set({
      servers: this.state.servers.map(s =>
        s.id === serverId ? { ...s, users: [...s.users, user] } : s),
    })
    return user
  }

  /** 就地更新账号呈现（编辑改名）。 */
  updateUser(serverId: string, userId: string, patch: { name?: string }): void {
    this.set({
      servers: this.state.servers.map(s =>
        s.id === serverId
          ? { ...s, users: s.users.map(u => u.id === userId ? { ...u, ...patch } : u) }
          : s),
    })
  }

  setUserSession(serverId: string, userId: string, sessionId: string): void {
    this.set({
      servers: this.state.servers.map(s =>
        s.id === serverId
          ? { ...s, users: s.users.map(u => u.id === userId ? { ...u, sessionId } : u) }
          : s),
    })
  }

  removeUser(serverId: string, userId: string): void {
    const active = this.state.active
    const nextActive = active.serverId === serverId && active.userId === userId
      ? { serverId: null, userId: null } : active
    this.set({
      servers: this.state.servers.map(s =>
        s.id === serverId ? { ...s, users: s.users.filter(u => u.id !== userId) } : s),
      ...(nextActive !== active ? { active: nextActive } : {}),
    })
  }

  setActive(serverId: string | null, userId: string | null): void {
    const label = serverId !== null && userId !== null ? this.labelOf(serverId, userId) : null
    this.set({
      active: { serverId, userId },
      conn: { ...this.state.conn, serverId, userId, label: label ?? this.state.conn.label },
    })
  }

  setConn(conn: MudConnInfo): void { this.set({ conn }) }

  /** Connect: core3 只需 sessionId（服务器/凭据在宿主侧 roster 查找）。 */
  async connectUser(serverId: string, userId: string): Promise<void> {
    const server = this.state.servers.find(s => s.id === serverId)
    const user = server?.users.find(u => u.id === userId)
    if (server === undefined || user === undefined) return
    if (user.sessionId === '') {
      this.setConn({
        state: 'error', serverId, userId, sessionId: null,
        label: `${server.name} / ${user.name}`, error: '该用户尚未创建会话',
      })
      return
    }
    this.setActive(serverId, userId)
    this.setConn({
      state: 'connecting', serverId, userId, sessionId: user.sessionId,
      label: `${server.name} / ${user.name}`, error: null,
    })
    try {
      await this.remote.connect(user.sessionId)
      await this.refreshStatus(user.sessionId)
    } catch (err) {
      this.setConn({
        ...this.state.conn, state: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** 按会话连接（游戏画面按钮路径）：以 sessionId 找回账号，复用 connectUser。 */
  async connectSession(sessionId: string): Promise<void> {
    const server = this.state.servers.find(s => s.users.some(u => u.sessionId === sessionId))
    const user = server?.users.find(u => u.sessionId === sessionId)
    if (server !== undefined && user !== undefined) await this.connectUser(server.id, user.id)
  }

  /** Disconnect. */
  async disconnect(sessionId?: string): Promise<void> {
    const target = sessionId ?? this.state.conn.sessionId
    try {
      if (target !== null) this.remote.disconnect(target)
    } catch { /* reconcile below */ }
    const active = this.state.active
    this.setConn({
      ...IDLE_CONN,
      serverId: active.serverId, userId: active.userId,
      label: active.serverId !== null && active.userId !== null
        ? this.labelOf(active.serverId, active.userId) : null,
    })
    await this.refreshStatus(target ?? undefined)
  }

  /** 接入：MUD 信息开始进入 agent。 */
  async admit(sessionId: string): Promise<void> {
    try {
      this.remote.admit(sessionId)
      await this.refreshStatus(sessionId)
    } catch { /* best-effort */ }
  }

  /** 停止接入：MUD 信息不再进入 agent。 */
  async stopAdmit(sessionId: string): Promise<void> {
    try {
      this.remote.stop(sessionId)
      await this.refreshStatus(sessionId)
    } catch { /* best-effort */ }
  }

  /** 战斗刹车（T21.6 combatAuto 总开关）：关 = 人打断自主战斗；开 = 恢复（新遭遇照常接管）。 */
  async setCombatAuto(sessionId: string, enabled: boolean): Promise<void> {
    try {
      await this.remote.combatAuto(sessionId, enabled)
      await this.refreshStatus(sessionId)
    } catch { /* best-effort */ }
  }

  async refreshCredentials(): Promise<void> {
    const refs = this.state.servers.flatMap(s => s.users.map(u => u.passRef)).filter(r => r !== '')
    if (refs.length === 0) {
      if (Object.keys(this.state.credentialStatus).length > 0) this.set({ credentialStatus: {} })
      return
    }
    try {
      const credentialStatus = await this.credentials.describe(refs)
      this.set({ credentialStatus })
    } catch { /* decorative */ }
  }

  /** Poll status and reconcile. */
  async refreshStatus(focusSessionId?: string): Promise<void> {
    await this.refreshCredentials()
    try {
      const body = await this.remote.status(focusSessionId)
      this.applyStatusRows(body.sessions, focusSessionId)
    } catch { /* keep previous snapshot */ }
  }

  /** 状态行落账（watchStatus 推帧与 status() 回填共用；focus 缺省用当前会话）。 */
  private applyStatusRows(
    rows: MudStatusFrame['sessions'],
    focusSessionId?: string,
  ): void {
    const sessionStatus: Record<string, SessionStatusRow> = {}
    for (const row of rows) {
      if (row.sessionId === '') continue
      sessionStatus[row.sessionId] = {
        sessionId: row.sessionId, state: row.state, admitted: row.admitted,
        loggedIn: row.loggedIn,
        probeState: row.probeState ?? 'idle',
        combatAuto: row.combatAuto ?? true,
        world: row.world,
      }
    }
    const focus = focusSessionId ?? this.state.conn.sessionId ?? undefined
    const focusRow = focus !== undefined ? sessionStatus[focus] : undefined
    const focusConn = focusRow?.state === 'connected'
      ? (focusRow.probeState === 'probing' ? 'probing' : 'connected')
      : focusRow?.state === 'connecting' ? 'connecting' : 'idle'
    const state: MudConnState = focusConn
    this.set({ sessionStatus, conn: { ...this.state.conn, state, error: null } })
  }

  /**
   * 状态流消费（C5.1）：订阅服务端 watchStatus —— 首帧全量快照，随后状态变化
   * 毫秒级推帧，轮询定时器移除。幂等（重复调用返回同一停止函数）；
   * 断流（宿主重启/网络）静默保持既有快照，操作型 refreshStatus 仍兜底。
   * @returns 停止函数（abort 并清服务端订阅）。
   */
  startStatusWatch(): () => void {
    if (this.statusWatchStop !== null) return this.statusWatchStop
    const controller = new AbortController()
    const stop = (): void => {
      this.statusWatchStop = null
      controller.abort()
    }
    this.statusWatchStop = stop
    void (async () => {
      try {
        for await (const frame of this.remote.watchStatus(controller.signal)) {
          this.applyStatusRows(frame.sessions)
        }
      } catch { /* 断流：保持既有快照（首个状态操作会经 refreshStatus 重同步） */ }
    })()
    return stop
  }

  private statusWatchStop: (() => void) | null = null

  private labelOf(serverId: string, userId: string): string | null {
    const server = this.state.servers.find(s => s.id === serverId)
    const user = server?.users.find(u => u.id === userId)
    return server !== undefined && user !== undefined ? `${server.name} / ${user.name}` : null
  }
}
