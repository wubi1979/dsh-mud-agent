/**
 * dsh-mud-webui — WebUI client half (core3).
 *
 * C4 接线替换：呈现不改（服务器/账号树形导航），后端从 v1 mud-core 换到 core3。
 * - sidebar：服务器/账号向导（遮蔽 SidebarRoot）
 * - 移除：game/log conversation views、rail、socket（core3 第一期不需要）
 * - 移除：bind/purge/command/captcha/tier（core3 remote 只有 5 个方法）
 * - 新增：preset 选择 + admit/stop 接入开关
 *
 * @module @deepseek-ai/dsh-mud-webui/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MudStateController, type MudUser } from './mud-state.ts'
import { MudRemoteController } from './mud-remote.ts'
import { MudCredentialsController, mintPassRef } from './mud-credentials.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'

export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'remote', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  const mudRemote = new MudRemoteController()
  const credentials = new MudCredentialsController(ctx)
  const mud = new MudStateController(mudRemote, credentials)

  // typert 客户端挂载（官方 RPC envelope；'remote' 已在 inject 里保证 gateway client 可用）
  void mudRemote.mount(ctx).catch((err: unknown) => {
    console.error('[mud] remote mount 失败:', err)
  })

  /**
   * 建账号 = 建会话：走官方 sessions.create（id 由 host 分配），登记进 roster。
   * 0.1.7 起 sessions.open 移除，打开会话 = uiWorkspace 导航；preset 用
   * remote.agentPresets.select 在 blank 会话上选（create 不再收 agentPreset）。
   */
  const ensureAndOpenUserSession = (serverId: string, userId: string): void => {
    const server = mud.getSnapshot().servers.find(s => s.id === serverId)
    const user = server?.users.find(u => u.id === userId)
    if (server === undefined || user === undefined) return
    const sessions = ctx.get('sessions') as ISessions | undefined
    if (sessions === undefined) return
    const open = (id: string): void => {
      const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace | undefined
      if (uiWorkspace !== undefined) uiWorkspace.openSession(id as SessionId)
    }
    if (user.sessionId !== '') {
      open(user.sessionId)
      return
    }
    // 用户尚无会话：官方创建（带 cwd），随后在 blank 会话上选 preset
    void sessions.create({
      ...(server.cwd !== '' ? { cwd: server.cwd } : {}),
    }).then(async (created) => {
      const sessionId = String(created)
      if (user.preset !== '') {
        const remote = (ctx as unknown as { remote?: { agentPresets?: { select: (sessionId: string, preset: string) => Promise<unknown> } } }).remote
        try { await remote?.agentPresets?.select(sessionId, user.preset) } catch { /* preset 不可选不阻塞开屏 */ }
      }
      mud.setUserSession(serverId, userId, sessionId)
      open(sessionId)
    }).catch((err: unknown) => {
      mud.setConn({
        ...mud.getSnapshot().conn,
        state: 'error', serverId, userId, sessionId: null,
        label: `${server.name} / ${user.name}`,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  const releasePassRef = (ref: string): Promise<void> =>
    credentials.unset(ref).catch(() => { /* best-effort */ })

  const passRefsOf = (users: readonly MudUser[]): string[] =>
    users.map(u => u.passRef).filter(r => r !== '')

  const injectFace = (): MudClientInjected => ({
    hooks: { servers: mud },
    remote: mudRemote,
    addServer: (input) => {
      mud.addServer(input)
      if (input.cwd.trim() !== '') {
        const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
        void workspaces?.create({ path: input.cwd.trim() }).catch(() => { /* exists */ })
      }
    },
    removeServer: (serverId) => {
      mud.removeServer(serverId)
    },
    addUser: async (serverId, input) => {
      const server = mud.getSnapshot().servers.find(s => s.id === serverId)
      if (server === undefined) throw new Error('服务器已不存在')
      const passRef = mintPassRef(server.users.map(u => u.passRef), input.name)
      await credentials.set(passRef, input.pass)
      const user = mud.addUser(serverId, { name: input.name, passRef, preset: input.preset })
      if (user === null) {
        void releasePassRef(passRef)
        throw new Error('服务器已不存在')
      }
      void mud.refreshCredentials()
      ensureAndOpenUserSession(serverId, user.id)
    },
    removeUser: (serverId, userId) => {
      const server = mud.getSnapshot().servers.find(s => s.id === serverId)
      const user = server?.users.find(u => u.id === userId)
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
    openUserSession: (serverId, userId) => {
      mud.setActive(serverId, userId)
      ensureAndOpenUserSession(serverId, userId)
    },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })

  // 左侧栏：服务器/账号向导（遮蔽 SidebarRoot）
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: injectFace,
  }, MudSidebar))
}
