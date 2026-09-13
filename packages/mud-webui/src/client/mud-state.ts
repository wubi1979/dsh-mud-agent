/**
 * dsh-mud-webui — client-side MUD state (client half).
 *
 * Servers/users roster plus per-session connection state. Creating a user
 * creates **an official DSH session** (`ctx.sessions.create()` returns the id);
 * the roster stores that id, so the page never mints identities of its own.
 * Clicking a user switches to that session (`ctx.sessions.open`) — 用户即会话.
 *
 * The roster is persisted to localStorage; connection state is not (the sidebar
 * and center poll /mud/status and reconcile). Game/log/decision/world data flows
 * through the /mud/ws push channel (MudSocketController), and every frame item
 * carries the sessionId it belongs to.
 * @module @deepseek-ai/dsh-mud-webui/client/mud-state
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** One MUD game account attached to a server, bound to its own DSH session. */
export interface MudUser {
  readonly id: string
  readonly name: string
  readonly pass: string
  /**
   * Official DSH session id for this account (`sessions.create()` result).
   * Empty while creation is in flight or after a failure — such a user cannot
   * connect until a session exists.
   */
  readonly sessionId: string
}

/** One MUD server (host:port) with its accounts, bound to a workspace directory. */
export interface MudServer {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  /** Workspace directory bound to this server (session history groups under it). */
  readonly cwd: string
  readonly users: readonly MudUser[]
}

/** Connection lifecycle state, mirrored from GET /mud/status polling. */
export type MudConnState = 'idle' | 'connecting' | 'connected' | 'error'

/** MUD permission tier (mirrors the host's `observe`/`operate`/`full`; §10). */
export type MudTier = 'observe' | 'operate' | 'full'

/** Tier names in picker order (label + one-line meaning). */
export const MUD_TIER_CHOICES: readonly { readonly tier: MudTier; readonly label: string }[] = [
  { tier: 'observe', label: '只读 (只看不发)' },
  { tier: 'operate', label: '读写 (移动/命令)' },
  { tier: 'full', label: '完全 (+外围能力)' },
]

/** Connection info shown in the sidebar foot and center header. */
export interface MudConnInfo {
  readonly state: MudConnState
  /** Roster identity of the connect target (null when unreconciled). */
  readonly serverId: string | null
  readonly userId: string | null
  /** Agent session id the host reports (opened automatically when listed). */
  readonly sessionId: string | null
  /** Display label of the current connection. */
  readonly label: string | null
  /** Last error message (state 'error'). */
  readonly error: string | null
}

/** Full client-visible MUD state snapshot (stable reference between changes). */
export interface MudServersSnapshot {
  readonly servers: readonly MudServer[]
  /** The roster identity the last connect gesture targeted. */
  readonly active: { readonly serverId: string | null; readonly userId: string | null }
  readonly conn: MudConnInfo
  /** sessionId → connection state (every bound session; drives per-row dots). */
  readonly sessionState: Readonly<Record<string, MudConnState>>
  /** sessionId → permission tier (host-authoritative; absent = 未声明/未轮询到). */
  readonly sessionTier: Readonly<Record<string, MudTier>>
}

/** localStorage key for the roster (servers + active target only). */
const STORAGE_KEY = 'dsh.mud.servers.v1'

/** Idle connection info (default). */
const IDLE_CONN: MudConnInfo = {
  state: 'idle',
  serverId: null,
  userId: null,
  sessionId: null,
  label: null,
  error: null,
}

/** Minimal structural validation for a parsed roster (mis-shaped storage resets). */
function parseRoster(value: unknown): { servers: MudServer[]; active: MudServersSnapshot['active'] } | null {
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
      const u = user as { id?: unknown; name?: unknown; pass?: unknown; sessionId?: unknown }
      if (typeof u.id !== 'string' || typeof u.name !== 'string' || typeof u.pass !== 'string') return null
      users.push({
        id: u.id,
        name: u.name,
        pass: u.pass,
        // Rosters written before the official-create path carry a locally
        // minted id; keep it (it is still a valid explicit session id).
        sessionId: typeof u.sessionId === 'string' ? u.sessionId : '',
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

/** Load the persisted roster; falls back to empty on any parse failure. */
function loadRoster(): { servers: MudServer[]; active: MudServersSnapshot['active'] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { servers: [], active: { serverId: null, userId: null } }
    return parseRoster(JSON.parse(raw)) ?? { servers: [], active: { serverId: null, userId: null } }
  } catch {
    return { servers: [], active: { serverId: null, userId: null } }
  }
}

/**
 * Roster + per-session connection controller. React-free: components read via
 * the injected `useServers` selector hook and write through the injected actions.
 */
export class MudStateController {
  private state: MudServersSnapshot
  private readonly listeners = new Set<() => void>()

  constructor() {
    const loaded = loadRoster()
    this.state = {
      servers: loaded.servers,
      active: loaded.active,
      conn: IDLE_CONN,
      sessionState: {},
      sessionTier: {},
    }
  }

  /** Stable snapshot reference for useSyncExternalStore semantics. */
  getSnapshot(): MudServersSnapshot {
    return this.state
  }

  /** Subscribe to snapshot changes; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Replace the state with a patched copy and notify. */
  private set(patch: Partial<MudServersSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of [...this.listeners]) fn()
    this.persist()
  }

  /** Persist only the roster part (connection info is transient). */
  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        servers: this.state.servers,
        active: this.state.active,
      }))
    } catch { /* storage unavailable: in-memory only */ }
  }

  /** Add a server; the display name falls back to host:port when blank. */
  addServer(input: { name: string; host: string; port: number; cwd: string }): void {
    const name = input.name.trim() || `${input.host}:${input.port}`
    const server: MudServer = {
      id: randomUUID(),
      name,
      host: input.host.trim(),
      port: input.port,
      cwd: input.cwd.trim(),
      users: [],
    }
    this.set({ servers: [...this.state.servers, server] })
  }

  /** Remove a server (and its users); clears the active target when it pointed there. */
  removeServer(serverId: string): void {
    const active = this.state.active
    const nextActive = active.serverId === serverId
      ? { serverId: null, userId: null }
      : active
    this.set({
      servers: this.state.servers.filter(server => server.id !== serverId),
      ...(nextActive !== active ? { active: nextActive } : {}),
    })
  }

  /**
   * Add a user to a server. The session id starts empty: the caller creates the
   * official session and then calls {@link setUserSession} with its id.
   * @returns the new roster entry (or null when the server is unknown).
   */
  addUser(serverId: string, input: { name: string; pass: string }): MudUser | null {
    const server = this.state.servers.find(candidate => candidate.id === serverId)
    if (server === undefined) return null
    const user: MudUser = {
      id: randomUUID(),
      name: input.name.trim(),
      pass: input.pass,
      sessionId: '',
    }
    this.set({
      servers: this.state.servers.map(candidate =>
        candidate.id === serverId ? { ...candidate, users: [...candidate.users, user] } : candidate),
    })
    return user
  }

  /** Record the official session id created for one user (用户 = 会话). */
  setUserSession(serverId: string, userId: string, sessionId: string): void {
    this.set({
      servers: this.state.servers.map(server =>
        server.id === serverId
          ? {
            ...server,
            users: server.users.map(user => (user.id === userId ? { ...user, sessionId } : user)),
          }
          : server),
    })
  }

  /** Find the roster user bound to one official session id. */
  userOfSession(sessionId: string): { server: MudServer; user: MudUser } | null {
    for (const server of this.state.servers) {
      const user = server.users.find(candidate => candidate.sessionId === sessionId)
      if (user !== undefined) return { server, user }
    }
    return null
  }

  /** Remove a user; clears the active target when it pointed there. */
  removeUser(serverId: string, userId: string): void {
    const active = this.state.active
    const nextActive = active.serverId === serverId && active.userId === userId
      ? { serverId: null, userId: null }
      : active
    this.set({
      servers: this.state.servers.map(server =>
        server.id === serverId ? { ...server, users: server.users.filter(user => user.id !== userId) } : server),
      ...(nextActive !== active ? { active: nextActive } : {}),
    })
  }

  /** Remember the roster identity of the intended connect target (mirrored into the conn info). */
  setActive(serverId: string | null, userId: string | null): void {
    const label = serverId !== null && userId !== null ? this.labelOf(serverId, userId) : null
    this.set({
      active: { serverId, userId },
      conn: {
        ...this.state.conn,
        serverId,
        userId,
        label: label ?? this.state.conn.label,
      },
    })
  }

  /** Replace the connection info. */
  setConn(conn: MudConnInfo): void {
    this.set({ conn })
  }

  /** Connect one server with one account: declare the MUD binding, then open the socket. */
  async connectUser(serverId: string, userId: string): Promise<void> {
    const server = this.state.servers.find(candidate => candidate.id === serverId)
    const user = server?.users.find(candidate => candidate.id === userId)
    if (server === undefined || user === undefined) return
    if (user.sessionId === '') {
      this.setConn({
        state: 'error',
        serverId,
        userId,
        sessionId: null,
        label: `${server.name} / ${user.name}`,
        error: '该用户尚未创建会话, 请重新添加用户',
      })
      return
    }
    this.setActive(serverId, userId)
    this.setConn({
      state: 'connecting',
      serverId,
      userId,
      sessionId: user.sessionId,
      label: `${server.name} / ${user.name}`,
      error: null,
    })
    try {
      // 声明 MUD 绑定 (工具/提示/选路装配到该官方会话的 agent), 再开连接。
      await fetch('/mud/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: user.sessionId }),
      })
      const res = await fetch('/mud/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: server.host,
          port: server.port,
          name: user.name,
          pass: user.pass,
          sessionId: user.sessionId,
        }),
      })
      if (!res.ok) throw new Error(`connect failed (${res.status})`)
      await this.refreshStatus(user.sessionId)
    } catch (err) {
      this.setConn({
        ...this.state.conn,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Disconnect one session (defaults to the active target), then reconcile. */
  async disconnect(sessionId?: string): Promise<void> {
    const target = sessionId ?? this.state.conn.sessionId
    try {
      await fetch('/mud/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target === null || target === undefined ? {} : { sessionId: target }),
      })
    } catch { /* the reconcile below settles the visible state */ }
    // 断开不销毁会话: 保留连接目标, 游戏页仍可一键重连。
    const active = this.state.active
    this.setConn({
      ...IDLE_CONN,
      serverId: active.serverId,
      userId: active.userId,
      label: active.serverId !== null && active.userId !== null
        ? this.labelOf(active.serverId, active.userId)
        : null,
    })
    await this.refreshStatus(target ?? undefined)
  }

  /**
   * 切换某会话的权限档位 (用户行 ⋯ 菜单)。
   *
   * 乐观更新本地镜像 + POST `/mud/capability`; host 是权威 —— 返回值以响应为准,
   * 下一次 `/mud/status` 轮询再对齐。失败不抛出 (页面只显示旧档位)。
   * @param sessionId 官方会话 id。
   * @param tier 目标档位。
   * @returns 是否被 host 接受。
   */
  async setTier(sessionId: string, tier: MudTier): Promise<boolean> {
    if (sessionId === '') return false
    this.set({ sessionTier: { ...this.state.sessionTier, [sessionId]: tier } })
    try {
      const res = await fetch('/mud/capability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, tier }),
      })
      if (!res.ok) return false
      const body = (await res.json()) as { tier?: unknown }
      const applied = body.tier
      if (applied === 'observe' || applied === 'operate' || applied === 'full') {
        this.set({ sessionTier: { ...this.state.sessionTier, [sessionId]: applied } })
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Poll GET /mud/status and reconcile the connection info with the roster.
   * @param focusSessionId session whose status fills `conn` (缺省 = active target)。
   */
  async refreshStatus(focusSessionId?: string): Promise<void> {
    try {
      const res = await fetch('/mud/status')
      if (!res.ok) return
      const body = (await res.json()) as {
        connected?: unknown
        state?: unknown
        host?: unknown
        port?: unknown
        accountName?: unknown
        sessionId?: unknown
        sessions?: unknown
      }
      const sessionState: Record<string, MudConnState> = {}
      const sessionTier: Record<string, MudTier> = {}
      if (Array.isArray(body.sessions)) {
        for (const entry of body.sessions) {
          if (typeof entry !== 'object' || entry === null) continue
          const row = entry as { sessionId?: unknown; connected?: unknown; state?: unknown; tier?: unknown }
          if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
          sessionState[row.sessionId] = row.connected === true
            ? 'connected'
            : row.state === 'connecting' ? 'connecting' : 'idle'
          if (row.tier === 'observe' || row.tier === 'operate' || row.tier === 'full') {
            sessionTier[row.sessionId] = row.tier
          }
        }
      }
      const focus = focusSessionId ?? (typeof body.sessionId === 'string' ? body.sessionId : undefined)
      const row = focus === undefined ? null : {
        connected: sessionState[focus] === 'connected',
        state: sessionState[focus] ?? 'idle',
        host: typeof body.host === 'string' ? body.host : null,
        port: typeof body.port === 'number' ? body.port : null,
        accountName: typeof body.accountName === 'string' && body.accountName !== '' ? body.accountName : null,
      }
      const connected = row === null ? body.connected === true : row.connected
      const state: MudConnState = connected
        ? 'connected'
        : (row === null ? body.state : row.state) === 'connecting' ? 'connecting' : 'idle'
      const host = row?.host ?? (typeof body.host === 'string' ? body.host : null)
      const port = row?.port ?? (typeof body.port === 'number' ? body.port : null)
      const accountName = row?.accountName
        ?? (typeof body.accountName === 'string' && body.accountName !== '' ? body.accountName : null)
      const { serverId, userId } = this.reconcile(host, port, accountName)
      this.set({
        sessionState,
        sessionTier,
        conn: {
          state,
          serverId,
          userId,
          sessionId: focus ?? (typeof body.sessionId === 'string' ? body.sessionId : null),
          label: serverId !== null && userId !== null
            ? this.labelOf(serverId, userId)
            : accountName,
          error: null,
        },
      })
    } catch { /* transient poll failure: keep the previous snapshot */ }
  }

  /** Resolve the roster identity behind a status report (host/port then account name). */
  private reconcile(host: string | null, port: number | null, accountName: string | null): {
    serverId: string | null
    userId: string | null
  } {
    const active = this.state.active
    const activeServer = active.serverId === null
      ? undefined
      : this.state.servers.find(server => server.id === active.serverId)
    if (activeServer !== undefined && active.userId !== null
      && (host === null || activeServer.host === host)
      && (port === null || activeServer.port === port)) {
      return { serverId: activeServer.id, userId: active.userId }
    }
    if (host !== null && port !== null) {
      const server = this.state.servers.find(candidate => candidate.host === host && candidate.port === port)
      if (server !== undefined) {
        const user = accountName === null
          ? undefined
          : server.users.find(candidate => candidate.name === accountName)
        return { serverId: server.id, userId: user?.id ?? null }
      }
    }
    if (accountName !== null) {
      for (const server of this.state.servers) {
        const user = server.users.find(candidate => candidate.name === accountName)
        if (user !== undefined) return { serverId: server.id, userId: user.id }
      }
    }
    return { serverId: null, userId: null }
  }

  /** Display label for one roster identity. */
  private labelOf(serverId: string, userId: string): string | null {
    const server = this.state.servers.find(candidate => candidate.id === serverId)
    const user = server?.users.find(candidate => candidate.id === userId)
    return server !== undefined && user !== undefined ? `${server.name} / ${user.name}` : null
  }
}
