/**
 * dsh-mud-webui — client-side MUD state (client half).
 *
 * Servers/users roster plus the live connection info. The plugin apply body
 * owns one MudStateController; its observable snapshot is handed to slot
 * components through the inject `hooks` compartment (renders as the
 * `useServers` selector hook) and mutations go through the inject actions —
 * the same "bare observable sources, plain data and callbacks" discipline as
 * the composer-bar hooks compartment.
 *
 * The roster is persisted to localStorage; the connection info is not (the
 * sidebar/center poll /mud/status and reconcile). Game/log/decision/world
 * data flows through the /mud/ws push channel (MudSocketController), not
 * session events.
 * @module @deepseek-ai/dsh-mud-webui/client/mud-state
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** One MUD game account attached to a server, bound to its own DSH session. */
export interface MudUser {
  readonly id: string
  readonly name: string
  readonly pass: string
  /** DSH agent session id for this account (created once, persisted — history resumes across reconnects). */
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
        // Old rosters predate per-user session ids; mint one on migration.
        sessionId: typeof u.sessionId === 'string' && u.sessionId !== '' ? u.sessionId : mintSessionId(server.id, u.id),
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

/** Deterministic per-user DSH session id (stable across reloads, so history resumes). */
function mintSessionId(serverId: string, userId: string): string {
  return `mud-${serverId.slice(0, 8)}-${userId.slice(0, 8)}`
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
 * Roster + connection controller. React-free: components read via the
 * injected `useServers` selector hook and write through the injected actions.
 */
export class MudStateController {
  private state: MudServersSnapshot
  private readonly listeners = new Set<() => void>()

  constructor() {
    const loaded = loadRoster()
    this.state = { servers: loaded.servers, active: loaded.active, conn: IDLE_CONN }
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

  /** Add a user to a server; the user owns a dedicated DSH session (history resumes by sessionId). */
  addUser(serverId: string, input: { name: string; pass: string }): MudUser | null {
    const server = this.state.servers.find(candidate => candidate.id === serverId)
    if (server === undefined) return null
    const id = randomUUID()
    const user: MudUser = {
      id,
      name: input.name.trim(),
      pass: input.pass,
      sessionId: mintSessionId(serverId, id),
    }
    this.set({
      servers: this.state.servers.map(candidate =>
        candidate.id === serverId ? { ...candidate, users: [...candidate.users, user] } : candidate),
    })
    return user
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

  /** Connect to one server with one account; then reconcile via /mud/status. */
  async connectUser(serverId: string, userId: string): Promise<void> {
    const server = this.state.servers.find(candidate => candidate.id === serverId)
    const user = server?.users.find(candidate => candidate.id === userId)
    if (server === undefined || user === undefined) return
    this.setActive(serverId, userId)
    this.setConn({
      state: 'connecting',
      serverId,
      userId,
      sessionId: null,
      label: `${server.name} / ${user.name}`,
      error: null,
    })
    try {
      const res = await fetch('/mud/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: server.host,
          port: server.port,
          name: user.name,
          pass: user.pass,
          sessionId: user.sessionId,
          cwd: server.cwd,
        }),
      })
      if (!res.ok) throw new Error(`connect failed (${res.status})`)
      await this.refreshStatus()
    } catch (err) {
      this.setConn({
        ...this.state.conn,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Disconnect the current connection, then reconcile. */
  async disconnect(): Promise<void> {
    try {
      await fetch('/mud/disconnect', { method: 'POST' })
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
    await this.refreshStatus()
  }

  /** Poll GET /mud/status and reconcile the connection info with the roster. */
  async refreshStatus(): Promise<void> {
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
      }
      const connected = body.connected === true
      const host = typeof body.host === 'string' ? body.host : null
      const port = typeof body.port === 'number' ? body.port : null
      const accountName = typeof body.accountName === 'string' && body.accountName !== ''
        ? body.accountName
        : null
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      const { serverId, userId } = this.reconcile(host, port, accountName)
      this.setConn({
        state: connected ? 'connected'
          : body.state === 'connecting' ? 'connecting'
            : 'idle',
        serverId,
        userId,
        sessionId,
        label: serverId !== null && userId !== null
          ? this.labelOf(serverId, userId)
          : accountName,
        error: null,
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
