/**
 * dsh-mud-webui — sidebar replacement (client half).
 *
 * Occupies the layout `sidebar` slot at priority -100 (shadows SidebarRoot):
 * a server/user wizard tree instead of the workspace browser. Structure
 * mirrors the native shell — brand row, primary action button, scrolling
 * roster region, connection foot — and both the wide column and the 56px
 * collapsed rail are handled (owner `{ collapsed, width }`).
 *
 * Per-server rows carry a ➕ add-user control and a ⋯ delete menu; per-user
 * rows carry a ⋯ delete menu and open their session view on click. Connection
 * state is polled from GET /mud/status (2.5s) and reconciled by the
 * MudStateController; connecting/disconnecting is driven by the game page
 * buttons, never by the sidebar.
 * @module @deepseek-ai/dsh-mud-webui/client/MudSidebar
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconEllipsisOutline16, IconGlobeOutline14, IconPanelLeftOutline16, IconPlusOutline16,
  IconRefreshOutline16, IconUserOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  MudConnInfo, MudConnState, MudServer, MudServersSnapshot,
} from './mud-state.ts'
import type { MudSocketController } from './mud-socket.ts'
import { ServerDialog, UserDialog } from './MudDialogs.tsx'
import css from './MudSidebar.module.css'

/** Business face injected into the sidebar (and center) registrations. */
export interface MudClientInjected {
  /** Roster observable bound to the `useServers` selector hook. */
  hooks: {
    servers: HostObservable<MudServersSnapshot>
  }
  /** Shared /mud/ws push-channel controller (game/log/decision/world frames). */
  mudSocket: MudSocketController
  addServer: (input: { name: string; host: string; port: number; cwd: string }) => void
  removeServer: (serverId: string) => void
  addUser: (serverId: string, input: { name: string; pass: string }) => void
  removeUser: (serverId: string, userId: string) => void
  connectUser: (serverId: string, userId: string) => Promise<void>
  disconnect: () => Promise<void>
  refreshStatus: () => Promise<void>
  /** Select a user and open its dedicated session view (the game page drives the connection). */
  openUserSession: (serverId: string, userId: string) => void
  /** Send one game command straight to the game (bypasses the agent). */
  sendCommand: (cmd: string) => Promise<boolean>
  toggleSidebar: () => void
}

/** Full composed sidebar props: runtime owner share + injected face. */
export type MudSidebarProps =
  PropsRuntime<'sidebar'>
  & InjectFace<MudClientInjected>

/** Connection-state class for one roster row (only the active target lights up). */
function rowState(conn: MudConnInfo, userId: string): MudConnState {
  return conn.userId === userId ? conn.state : 'idle'
}

/** Dot class for a connection state (indexed access is optional under noUncheckedIndexedAccess). */
function dotClass(state: MudConnState): string {
  switch (state) {
    case 'connecting': return css.stateConnecting ?? css.stateIdle ?? ''
    case 'connected': return css.stateConnected ?? css.stateIdle ?? ''
    case 'error': return css.stateError ?? css.stateIdle ?? ''
    default: return css.stateIdle ?? ''
  }
}

/** Foot text for the current connection (shared with the center header). */
export function connText(conn: MudConnInfo): string {
  switch (conn.state) {
    case 'connected': return `已连接: ${conn.label ?? ''}`
    case 'connecting': return '连接中…'
    case 'error': return conn.error ?? '连接失败'
    default: return '未连接'
  }
}

/**
 * Render the MUD sidebar column.
 * @param props - composed slot props (owner share + injected actions/hooks).
 * @returns the sidebar element tree.
 */
export function MudSidebar({
  collapsed,
  useServers,
  addServer,
  removeServer,
  addUser,
  removeUser,
  refreshStatus,
  openUserSession,
  toggleSidebar,
}: MudSidebarProps) {
  const { servers, conn } = useServers(s => s)
  const [serverDialogOpen, setServerDialogOpen] = useState(false)
  const [userDialogTarget, setUserDialogTarget] = useState<MudServer | null>(null)
  const [serverMenuFor, setServerMenuFor] = useState<MudServer | null>(null)
  const [userMenuFor, setUserMenuFor] = useState<{ serverId: string; userId: string } | null>(null)

  // Poll the host connection status so the foot/rows reflect the live state.
  useEffect(() => {
    void refreshStatus()
    const timer = window.setInterval(() => { void refreshStatus() }, 2500)
    return () => { window.clearInterval(timer) }
  }, [refreshStatus])

  return (
    <div className={clsx(css.root, collapsed && css.collapsed)}>
      {/* Wide brand row; the collapsed rail keeps only the expand toggle. */}
      <div className={clsx(css.logoRow, !collapsed && css.wideOnly)}>
        <button type="button" className={css.brand} aria-label="MUD 玩家控制台" onClick={() => { toggleSidebar() }}>
          <span className={css.brandMark}><IconGlobeOutline14 size={16} /></span>
          <span className={css.brandText}>
            <span className={css.brandName}>MUD 玩家</span>
            <span className={css.brandSub}>服务器 / 用户</span>
          </span>
        </button>
      </div>

      {!collapsed && (
        <button
          type="button"
          className={css.addServer}
          onClick={() => { setServerDialogOpen(true) }}
        >
          <IconPlusOutline16 size={14} />
          <span className={css.addServerLabel}>添加服务器</span>
        </button>
      )}

      {/* Wide roster region. */}
      {!collapsed && (
        <div className={css.listArea}>
          <span className={css.sectionLabel}>服务器</span>
          {servers.length === 0 && (
            <div className={css.empty}>
              尚无服务器
              <br />
              点击上方「添加服务器」开始
            </div>
          )}
          {servers.map(server => (
            <div key={server.id} className={css.serverGroup}>
              <div className={css.serverRow}>
                <span className={css.serverIcon}><IconGlobeOutline14 size={14} /></span>
                <span className={css.serverBody}>
                  <span className={css.serverName}>{server.name}</span>
                  <span className={css.serverMeta}>{server.host}:{server.port}</span>
                </span>
                <div className={css.rowActions}>
                  <Tooltip label="添加用户" delayMs={500}>
                    <button
                      type="button"
                      className={clsx(css.iconButton, css.smallIcon)}
                      aria-label={`添加用户 — ${server.name}`}
                      onClick={() => { setUserDialogTarget(server) }}
                    >
                      <IconPlusOutline16 size={14} />
                    </button>
                  </Tooltip>
                  <Menu
                    open={serverMenuFor?.id === server.id}
                    onClose={() => { setServerMenuFor(null) }}
                    anchor={(
                      <button
                        type="button"
                        className={clsx(css.iconButton, css.smallIcon)}
                        aria-label={`服务器选项 — ${server.name}`}
                        onClick={() => { setServerMenuFor(serverMenuFor?.id === server.id ? null : server) }}
                      >
                        <IconEllipsisOutline16 size={14} />
                      </button>
                    )}
                    items={[{ id: 'delete-server', label: '删除服务器' }]}
                    onSelect={(id) => {
                      if (id === 'delete-server') removeServer(server.id)
                      setServerMenuFor(null)
                    }}
                    portal
                    align="start"
                  />
                </div>
              </div>
              {server.users.map((user) => {
                const state = rowState(conn, user.id)
                return (
                  <div
                    key={user.id}
                    className={css.userRow}
                    role="button"
                    tabIndex={0}
                    aria-label={`打开会话 — ${server.name} / ${user.name}`}
                    onClick={() => { openUserSession(server.id, user.id) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openUserSession(server.id, user.id)
                      }
                    }}
                  >
                    <span className={css.userIcon}><IconUserOutline16 size={13} /></span>
                    <span className={css.userName}>{user.name}</span>
                    <span className={clsx(css.stateDot, dotClass(state))} aria-hidden="true" />
                    <Menu
                      open={userMenuFor?.serverId === server.id && userMenuFor?.userId === user.id}
                      onClose={() => { setUserMenuFor(null) }}
                      anchor={(
                        <button
                          type="button"
                          className={clsx(css.iconButton, css.smallIcon)}
                          aria-label={`用户选项 — ${user.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setUserMenuFor(
                              userMenuFor?.serverId === server.id && userMenuFor?.userId === user.id
                                ? null
                                : { serverId: server.id, userId: user.id },
                            )
                          }}
                        >
                          <IconEllipsisOutline16 size={14} />
                        </button>
                      )}
                      items={[{ id: 'delete-user', label: '删除用户' }]}
                      onSelect={(id) => {
                        if (id === 'delete-user') removeUser(server.id, user.id)
                        setUserMenuFor(null)
                      }}
                      portal
                      align="start"
                    />
                  </div>
                )
              })}
              {server.users.length === 0 && (
                <div className={css.userRow}>
                  <span style={{ flex: 1, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', paddingLeft: 22 }}>
                    暂无用户 — 点击 ➕ 添加
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Collapsed rail: toggle + add-server icon. */}
      {collapsed && (
        <div className={css.railControls}>
          <Tooltip label="展开侧栏" delayMs={500}>
            <button
              type="button"
              className={clsx(css.iconButton, css.railToggle)}
              aria-label="展开侧栏"
              onClick={() => { toggleSidebar() }}
            >
              <IconPanelLeftOutline16 size={18} />
            </button>
          </Tooltip>
          <Tooltip label="添加服务器" delayMs={500}>
            <button
              type="button"
              className={clsx(css.iconButton, css.railToggle)}
              aria-label="添加服务器"
              onClick={() => { setServerDialogOpen(true) }}
            >
              <IconPlusOutline16 size={18} />
            </button>
          </Tooltip>
          <span className={clsx(css.stateDot, dotClass(conn.state))} aria-hidden="true" />
        </div>
      )}

      {/* Connection foot (wide). */}
      {!collapsed && (
        <div className={css.footArea}>
          <div className={css.connLine}>
            <span className={clsx(css.stateDot, dotClass(conn.state))} aria-hidden="true" />
            <span className={clsx(css.connLabel, conn.state === 'error' && css.connError)}>{connText(conn)}</span>
            <Tooltip label="刷新状态" delayMs={500}>
              <button
                type="button"
                className={clsx(css.iconButton, css.smallIcon)}
                aria-label="刷新状态"
                onClick={() => { void refreshStatus() }}
              >
                <IconRefreshOutline16 size={13} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      <ServerDialog
        open={serverDialogOpen}
        onClose={() => { setServerDialogOpen(false) }}
        onAdd={(input) => { addServer(input) }}
      />
      <UserDialog
        open={userDialogTarget !== null}
        serverName={userDialogTarget?.name ?? ''}
        onClose={() => { setUserDialogTarget(null) }}
        onAdd={(input) => {
          if (userDialogTarget !== null) addUser(userDialogTarget.id, input)
        }}
      />
    </div>
  )
}
