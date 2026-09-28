/**
 * dsh-mud-webui — WebUI client half (core3)。
 *
 * 接线（设计 §3.5：呈现不变、接线替换）：
 * - sidebar：服务器/账号向导（遮蔽 SidebarRoot）
 * - conversation.view：`mud-log` 会话头 tab（连接/投递/闸门诊断面）
 * - **名册落宿主**：服务器/账号经 `remote.mud.addServer/addAccount` 登记（宿主 storage 域持久），
 *   页面 localStorage 只作呈现缓存
 * - **建账号 = 一个动作（宿主侧）**：页面写凭据 → `addAccount` 在宿主写名册 + 建会话
 *   （sessionId = 账号 id，绑定 preset）；页面不再自己 `sessions.create`
 *
 * @module @deepseek-ai/dsh-mud-webui/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MudStateController, type MudUser } from './mud-state.ts'
import { MudRemoteController } from './mud-remote.ts'
import { MudLogController } from './mud-log.ts'
import { MudCredentialsController, mintPassRef } from './mud-credentials.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'
import { MudLogView } from './MudLogView.tsx'

export const inject = ['slots', 'layout', 'workspaces', 'remote', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  const mudRemote = new MudRemoteController()
  const credentials = new MudCredentialsController(ctx)
  const mud = new MudStateController(mudRemote, credentials)
  const mudLog = new MudLogController(mudRemote)
  ctx.effect(() => () => { mudLog.dispose() }, 'mud-webui: 日志控制器')

  // typert 客户端挂载（官方 RPC envelope；'remote' 已在 inject 里保证 gateway client 可用）
  void mudRemote.mount(ctx).catch((err: unknown) => {
    console.error('[mud] remote mount 失败:', err)
  })

  /** 打开某账号的会话（会话由宿主在 addAccount 时建好）。 */
  const openUserSession = (serverId: string, userId: string): void => {
    const server = mud.getSnapshot().servers.find(s => s.id === serverId)
    const user = server?.users.find(u => u.id === userId)
    if (server === undefined || user === undefined) return
    mud.setActive(serverId, userId)
    if (user.sessionId === '') return
    const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace | undefined
    uiWorkspace?.openSession(user.sessionId as SessionId)
  }

  /** 把失败写进侧栏状态行（连接/名册错误都要看得见）。 */
  const reportError = (serverId: string | null, userId: string | null, error: unknown): void => {
    mud.setConn({
      ...mud.getSnapshot().conn,
      state: 'error',
      serverId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const releasePassRef = (ref: string): Promise<void> =>
    credentials.unset(ref).catch(() => { /* best-effort */ })

  const passRefsOf = (users: readonly MudUser[]): string[] =>
    users.map(u => u.passRef).filter(r => r !== '')

  const injectFace = (): MudClientInjected => ({
    hooks: { servers: mud, mudLog },
    remote: mudRemote,
    watchLog: mudLog.watchLog,
    refreshLog: mudLog.refreshLog,
    addServer: (input) => {
      const cwd = input.cwd.trim()
      const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
      // 服务器 = 工作区 + 字段：先建（或复用）工作区，再以它的 id 作名册键。
      const register = (workspaceId: string): void => {
        const record = {
          workspaceId, name: input.name.trim() || `${input.host}:${input.port}`,
          host: input.host.trim(), port: input.port,
        }
        mud.addServer({ id: workspaceId, name: record.name, host: record.host, port: record.port, cwd })
        void mudRemote.addServer(record).catch((error: unknown) => { reportError(null, null, error) })
      }
      if (workspaces === undefined || cwd === '') {
        // 没有工作区面或未填目录：用本地生成的键登记（宿主名册同样持久）。
        register(crypto.randomUUID())
        return
      }
      void workspaces.create({ path: cwd }).then((workspace) => {
        register(String(workspace.workspaceId))
      }).catch((error: unknown) => { reportError(null, null, error) })
    },
    removeServer: (serverId) => {
      void mudRemote.removeServer(serverId)
        .catch((error: unknown) => { reportError(serverId, null, error) })
        .finally(() => { mud.removeServer(serverId) })
    },
    addUser: async (serverId, input) => {
      const server = mud.getSnapshot().servers.find(s => s.id === serverId)
      if (server === undefined) throw new Error('服务器已不存在')
      const passRef = mintPassRef(server.users.map(u => u.passRef), input.name)
      await credentials.set(passRef, input.pass)
      try {
        // 宿主机建账号 = 写名册 + 建会话（sessionId = 账号 id，绑定 preset）
        const { account } = await mudRemote.addAccount({
          serverId, name: input.name, passRef, preset: input.preset, cwd: server.cwd,
        })
        const user = mud.addUser(serverId, {
          id: account.id, name: account.name, passRef: account.passRef, preset: account.preset,
        })
        if (user === null) throw new Error('服务器已不存在')
        void mud.refreshCredentials()
        openUserSession(serverId, user.id)
      } catch (error) {
        await releasePassRef(passRef) // 建账号失败不留下孤儿凭据
        throw error
      }
    },
    removeUser: (serverId, userId) => {
      const server = mud.getSnapshot().servers.find(s => s.id === serverId)
      const user = server?.users.find(u => u.id === userId)
      if (user !== undefined && user.sessionId !== '') {
        void mudRemote.removeAccount(user.sessionId)
          .catch((error: unknown) => { reportError(serverId, userId, error) })
      }
      mud.removeUser(serverId, userId)
      if (user !== undefined) {
        for (const ref of passRefsOf([user])) void releasePassRef(ref)
      }
      void mud.refreshCredentials()
    },
    connectUser: (serverId, userId) => mud.connectUser(serverId, userId),
    disconnect: (sessionId) => mud.disconnect(sessionId),
    admit: (sessionId) => mud.admit(sessionId),
    stopAdmit: (sessionId) => mud.stopAdmit(sessionId),
    refreshStatus: (sessionId) => mud.refreshStatus(sessionId),
    openUserSession,
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })

  // 左侧栏：服务器/账号向导（遮蔽 SidebarRoot）
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: injectFace,
  }, MudSidebar))

  // 会话头 tab：MUD 日志（连接/投递/闸门的诊断面；日志控制器按当前会话拉取）
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mud-log',
    order: 10,
    label: () => 'MUD 日志',
    inject: injectFace,
  }, MudLogView))
}
