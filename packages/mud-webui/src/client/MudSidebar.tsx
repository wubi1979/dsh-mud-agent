/**
 * dsh-mud-webui — sidebar replacement (client half, core3).
 *
 * 服务器/账号向导树（v1 呈现不改），新增：
 * - 用户行 ⋯ 菜单加「接入/停止接入」
 * - 添加用户弹窗加 preset 选择
 * 移除（core3 第一期不需要）：
 * - 权限档位（tier/capability）
 * - command/captcha
 * - mudSocket/GameView/LogView/Rail
 * @module @deepseek-ai/dsh-mud-webui/client/MudSidebar
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconEllipsisOutlineRegular, IconGlobeOutlineRegular, IconPanelLeftOutlineRegular, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, IconUserOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  MudConnInfo, MudConnState, MudServer, MudServersSnapshot, MudUser,
  SessionStatusRow,
} from './mud-state.ts'
import type { MudCredentialInfo } from './mud-credentials.ts'
import type { MudLogSnapshot } from './mud-log.ts'
import type { MudRemoteController } from './mud-remote.ts'
import { ServerDialog, UserDialog } from './MudDialogs.tsx'
import css from './MudSidebar.module.css'

/** Business face injected into the sidebar and the MUD log view. */
export interface MudClientInjected {
  hooks: {
    servers: HostObservable<MudServersSnapshot>
    /** 会话日志快照（mud-log 视图用；经 useMudLog 绑定）。 */
    mudLog: HostObservable<MudLogSnapshot>
  }
  remote: MudRemoteController
  /** 日志视图跟随某会话（null = 停止轮询）；身份稳定。 */
  watchLog: (sessionId: string | null) => void
  /** 立即刷新日志快照；身份稳定。 */
  refreshLog: () => void
  addServer: (input: { name: string; host: string; port: number; cwd: string }) => void
  removeServer: (serverId: string) => void
  addUser: (serverId: string, input: { name: string; pass: string; preset: string }) => Promise<void>
  removeUser: (serverId: string, userId: string) => void
  admit: (sessionId: string) => Promise<void>
  /** 停止接入：MUD 信息不再进入 agent。 */
  stopAdmit: (sessionId: string) => Promise<void>
  refreshStatus: (sessionId?: string) => Promise<void>
  /** 订阅服务端 watchStatus 状态流（C5.1：首帧快照 + 变化推帧）；返回停止函数。 */
  startStatusWatch: () => () => void
  openUserSession: (serverId: string, userId: string) => void
  toggleSidebar: () => void
}

export type MudSidebarProps = PropsRuntime<'sidebar'> & InjectFace<MudClientInjected>

function rowState(conn: MudConnInfo, sessionStatus: Readonly<Record<string, SessionStatusRow>>, user: MudUser): MudConnState {
  if (user.sessionId !== '') {
    const row = sessionStatus[user.sessionId]
    if (row !== undefined && row.state === 'connected') return 'connected'
    if (row !== undefined && row.state === 'connecting') return 'connecting'
  }
  return conn.userId === user.id ? conn.state : 'idle'
}

function dotClass(state: MudConnState): string {
  switch (state) {
    case 'connecting': return css.stateConnecting ?? css.stateIdle ?? ''
    case 'connected': return css.stateConnected ?? css.stateIdle ?? ''
    case 'error': return css.stateError ?? css.stateIdle ?? ''
    default: return css.stateIdle ?? ''
  }
}

function connText(conn: MudConnInfo): string {
  switch (conn.state) {
    case 'connected': return `已连接: ${conn.label ?? ''}`
    case 'connecting': return '连接中…'
    case 'error': return conn.error ?? '连接失败'
    default: return '未连接'
  }
}

function credBadge(passRef: string, status: MudCredentialInfo | undefined): { text: string; className: string } | null {
  if (passRef === '') return { text: '无密码', className: css.credMissing ?? '' }
  if (status === undefined) return null
  if (!status.configured) return { text: '凭据未配置', className: css.credMissing ?? '' }
  if (!status.writable) return { text: `只读 (${status.source ?? 'env'})`, className: css.credReadonly ?? '' }
  return { text: '凭据已配置', className: css.credOk ?? '' }
}

/** 接入状态徽标。 */
function admitBadge(sessionStatus: Readonly<Record<string, SessionStatusRow>>, sessionId: string): string | null {
  const row = sessionStatus[sessionId]
  if (row === undefined) return null
  return row.admitted ? '已接入' : null
}

export function MudSidebar({
  collapsed, useServers,
  addServer, removeServer, addUser, removeUser,
  admit, stopAdmit, refreshStatus, startStatusWatch,
  openUserSession, toggleSidebar,
}: MudSidebarProps) {
  const { servers, conn, sessionStatus, credentialStatus } = useServers(s => s)
  const [serverDialogOpen, setServerDialogOpen] = useState(false)
  const [userDialogTarget, setUserDialogTarget] = useState<MudServer | null>(null)
  const [serverMenuFor, setServerMenuFor] = useState<MudServer | null>(null)
  const [userMenuFor, setUserMenuFor] = useState<{ serverId: string; userId: string } | null>(null)

  useEffect(() => {
    void refreshStatus()
    // C5.1：状态经 watchStatus 流推送（首帧快照 + 变化推帧），轮询定时器移除。
    return startStatusWatch()
  }, [refreshStatus, startStatusWatch])

  return (
    <div className={clsx(css.root, collapsed && css.collapsed)}>
      <div className={clsx(css.logoRow, !collapsed && css.wideOnly)}>
        {collapsed ? (
          /* 收缩 rail：原生同款单切换钮 — 常驻 globe 标记，hover 换 panel 展开图标。 */
          <Tooltip label="展开侧栏" delayMs={500}>
            <button type="button" className={clsx(css.brand, css.railBrand)} aria-label="展开侧栏" onClick={() => { toggleSidebar() }}>
              <span className={css.brandMark}><IconGlobeOutlineRegular size={18} /></span>
              <span className={css.railHoverIcon}><IconPanelLeftOutlineRegular size={18} /></span>
            </button>
          </Tooltip>
        ) : (
          <button type="button" className={css.brand} aria-label="MUD 玩家控制台" onClick={() => { toggleSidebar() }}>
            <span className={css.brandMark}><IconGlobeOutlineRegular size={16} /></span>
            <span className={css.brandText}>
              <span className={css.brandName}>MUD 玩家</span>
              <span className={css.brandSub}>服务器 / 账号</span>
            </span>
          </button>
        )}
        {/* 收起侧栏：仅展开态渲染（原生展开态同款 panel 图标）。 */}
        {!collapsed && (
          <Tooltip label="收起侧栏" delayMs={500}>
            <button type="button" className={css.iconButton} aria-label="收起侧栏" onClick={() => { toggleSidebar() }}>
              <IconPanelLeftOutlineRegular size={16} />
            </button>
          </Tooltip>
        )}
      </div>

      {!collapsed && (
        <button type="button" className={css.addServer} onClick={() => { setServerDialogOpen(true) }}>
          <IconPlusOutlineRegular size={14} />
          <span className={css.addServerLabel}>添加服务器</span>
        </button>
      )}

      {!collapsed && (
        <div className={css.listArea}>
          <span className={css.sectionLabel}>服务器</span>
          {servers.length === 0 && (
            <div className={css.empty}>尚无服务器<br />点击上方「添加服务器」开始</div>
          )}
          {servers.map(server => (
            <div key={server.id} className={css.serverGroup}>
              <div className={css.serverRow}>
                <span className={css.serverIcon}><IconGlobeOutlineRegular size={14} /></span>
                <span className={css.serverBody}>
                  <span className={css.serverName}>{server.name}</span>
                  <span className={css.serverMeta}>{server.host}:{server.port}</span>
                </span>
                <div className={css.rowActions}>
                  <Tooltip label="添加账号" delayMs={500}>
                    <button type="button" className={clsx(css.iconButton, css.smallIcon)}
                      aria-label={`添加账号 — ${server.name}`}
                      onClick={() => { setUserDialogTarget(server) }}
                    >
                      <IconPlusOutlineRegular size={14} />
                    </button>
                  </Tooltip>
                  <Menu
                    open={serverMenuFor?.id === server.id}
                    onClose={() => { setServerMenuFor(null) }}
                    anchor={(
                      <button type="button" className={clsx(css.iconButton, css.smallIcon)}
                        aria-label={`服务器选项 — ${server.name}`}
                        onClick={() => { setServerMenuFor(serverMenuFor?.id === server.id ? null : server) }}
                      >
                        <IconEllipsisOutlineRegular size={14} />
                      </button>
                    )}
                    items={[{ id: 'delete-server', label: '删除服务器' }]}
                    onSelect={(id) => { if (id === 'delete-server') removeServer(server.id); setServerMenuFor(null) }}
                    portal align="start"
                  />
                </div>
              </div>
              {server.users.map((user) => {
                const state = rowState(conn, sessionStatus, user)
                const badge = credBadge(user.passRef, credentialStatus[user.passRef])
                const admitted = admitBadge(sessionStatus, user.sessionId)
                const isAdmitted = sessionStatus[user.sessionId]?.admitted === true
                return (
                  <div
                    key={user.id}
                    className={css.userRow}
                    role="button"
                    tabIndex={0}
                    aria-label={`打开会话 — ${server.name} / ${user.name}`}
                    onClick={() => { openUserSession(server.id, user.id) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUserSession(server.id, user.id) }
                    }}
                  >
                    <span className={css.userIcon}><IconUserOutlineRegular size={13} /></span>
                    <span className={css.userName}>{user.name}</span>
                    {badge !== null && <span className={clsx(css.credBadge, badge.className)}>{badge.text}</span>}
                    {admitted !== null && <span className={clsx(css.credBadge, css.credOk ?? '')}>{admitted}</span>}
                    <span className={clsx(css.stateDot, dotClass(state))} aria-hidden="true" />
                    <Menu
                      open={userMenuFor?.serverId === server.id && userMenuFor?.userId === user.id}
                      onClose={() => { setUserMenuFor(null) }}
                      anchor={(
                        <button type="button" className={clsx(css.iconButton, css.smallIcon)}
                          aria-label={`账号选项 — ${user.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setUserMenuFor(
                              userMenuFor?.serverId === server.id && userMenuFor?.userId === user.id
                                ? null : { serverId: server.id, userId: user.id },
                            )
                          }}
                        >
                          <IconEllipsisOutlineRegular size={14} />
                        </button>
                      )}
                      items={[
                        // 接入/停止接入
                        isAdmitted
                          ? { id: 'stop-admit', label: '停止接入' }
                          : { id: 'admit', label: '接入' },
                        { id: 'delete-user', label: '删除账号' },
                      ]}
                      onSelect={(id) => {
                        if (id === 'delete-user') removeUser(server.id, user.id)
                        if (id === 'admit' && user.sessionId !== '') void admit(user.sessionId)
                        if (id === 'stop-admit' && user.sessionId !== '') void stopAdmit(user.sessionId)
                        setUserMenuFor(null)
                      }}
                      portal align="start"
                    />
                  </div>
                )
              })}
              {server.users.length === 0 && (
                <div className={css.userRow}>
                  <span style={{ flex: 1, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', paddingLeft: 22 }}>
                    暂无账号 — 点击 ➕ 添加
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {collapsed && (
        <div className={css.railControls}>
          {/* 展开由顶部品牌切换钮承担（原生 rail 语义），rail 里只留业务动作。 */}
          <Tooltip label="添加服务器" delayMs={500}>
            <button type="button" className={clsx(css.iconButton, css.railToggle)}
              aria-label="添加服务器" onClick={() => { setServerDialogOpen(true) }}
            >
              <IconPlusOutlineRegular size={18} />
            </button>
          </Tooltip>
          <span className={clsx(css.stateDot, dotClass(conn.state))} aria-hidden="true" />
        </div>
      )}

      {!collapsed && (
        <div className={css.footArea}>
          <div className={css.connLine}>
            <span className={clsx(css.stateDot, dotClass(conn.state))} aria-hidden="true" />
            <span className={clsx(css.connLabel, conn.state === 'error' && css.connError)}>{connText(conn)}</span>
            <Tooltip label="刷新状态" delayMs={500}>
              <button type="button" className={clsx(css.iconButton, css.smallIcon)}
                aria-label="刷新状态" onClick={() => { void refreshStatus() }}
              >
                <IconRefreshOutlineRegular size={13} />
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
          if (userDialogTarget === null) return Promise.resolve()
          return addUser(userDialogTarget.id, input)
        }}
      />
    </div>
  )
}
