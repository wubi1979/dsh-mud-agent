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
import type { SidebarRightTabParamsMap, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MudStateController, type MudUser } from './mud-state.ts'
import { MudRemoteController } from './mud-remote.ts'
import { MudLogController } from './mud-log.ts'
import { MudCredentialsController, mintPassRef } from './mud-credentials.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'
import { MudLogView } from './MudLogView.tsx'
import { MudGameView, gameFollows, gameFollowKey, type MudGameViewInjected } from './MudGameView.tsx'
import { zh } from './locales.ts'

export const inject = ['slots', 'layout', 'workspaces', 'remote', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx: ClientContext): void {
  const mudRemote = new MudRemoteController()
  const credentials = new MudCredentialsController(ctx)
  const mud = new MudStateController(mudRemote, credentials)
  const mudLog = new MudLogController(mudRemote)
  ctx.effect(() => () => { mudLog.dispose() }, 'mud-webui: 日志控制器')

  // typert 客户端挂载（官方 RPC envelope；'remote' 已在 inject 里保证 gateway client 可用）。
  // 挂载成功即与宿主名册对齐一次：localStorage 只是呈现缓存，宿主才是事实源 ——
  // 刷新/宿主重启后的本地残留（假服务器/死会话）在启动时被服务端真值覆盖。
  void mudRemote.mount(ctx).then(() => {
    void Promise.all([mudRemote.servers(), mudRemote.accounts()])
      .then(([roster, accounts]) => {
        mud.hydrate({ servers: roster.servers, accounts: accounts.accounts })
      })
      .catch((error: unknown) => {
        console.warn('[mud] 启动名册同步失败（沿用本地缓存）:', error)
      })
  }).catch((err: unknown) => {
    console.error('[mud] remote mount 失败:', err)
  })

  // ── 右侧栏「游戏画面」tab（只读；core3 mud.follow 流）──────────
  // 文案走内置词典（本包惯例，未接宿主 locale 服务），见 ./locales.ts。
  const GAME_ID = '@deepseek-ai/dsh-mud-webui#mud-game'
  ctx.effect(() => ctx.sidebarRightTabs.register({
    // 页面类型：宿主去重语义是每 pane 一个（跨 pane 仍可多开）；全局单开由
    // 下方守卫保证。guide（右侧栏「开始」页）入口卡片：与文件/终端同一排；
    // 无 params 打开，MudGameView 回退跟随 tab 所在会话（= 当前查看的账号会话）。
    id: GAME_ID, kind: 'mud-game', priority: 'builtin', title: () => zh.title,
    guide: [{
      id: 'mud-game', order: 50,
      title: () => zh.title,
      description: () => zh.guideDesc,
      icon: IconPlayOutlineRegular,
    }],
  }), 'mud-webui: 画面 tab 类型')

  // ── 画面单开守卫 ───────────────────────────────────────────────
  // guide 入口走宿主 openTab（page 语义，每 pane 去重），split 后跨 pane 仍会
  // 多开画面 tab，且新实例会重挂导致工具栏状态重置。这里订阅全局 tab 清单
  // （openTabs 跨会话可观察源），同一会话出现第二个画面 tab 即关掉较新的：
  // 保留最旧实例（记录序即开出序），其 follow 流与工具栏状态不中断。
  ctx.effect(() => {
    let scheduled = false
    const sweep = (): void => {
      const seen = new Set<string>()
      for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
        if (tab.kind !== 'mud-game') continue
        if (!seen.has(tab.sessionId)) seen.add(tab.sessionId)
        else ctx.sidebarRight.closeIn(tab.sessionId, tab.tabId)
      }
    }
    // 失效回调可能在 store 提交中途触发，入微任务避让发布回路；幂等。
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; sweep() })
    }
    schedule()
    return ctx.sidebarRight.openTabs.subscribe(schedule)
  }, 'mud-webui: 画面单开守卫')
  // 关闭 tab：同步 abort follow 流（close 契约是同步的；流退出收尾在 body 卸载路径）
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('mud-game', (sessionId, tab) => {
    gameFollows.get(gameFollowKey(sessionId, tab.id))?.abort()
  }), 'mud-webui: 画面 tab 关闭')
  /** tab 打开时的导航参数（布局持久化携带 params，刷新/重开 tab 自动恢复）。 */
  const gameParams = (sessionId: Parameters<typeof ctx.sidebarRight.tabDomain.occurrence>[0],
    key: string): SidebarRightTabParamsMap['mud-game'] | undefined =>
    ctx.sidebarRight.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation.getSnapshot().params
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: GAME_ID,
      inject: (sessionId): MudGameViewInjected => ({
        remote: mudRemote,
        sessionId: String(sessionId),
        params: key => gameParams(sessionId, key),
        connect: (id) => mud.connectSession(id),
        disconnect: (id) => mud.disconnect(id),
      }),
    }, MudGameView,
  )), 'mud-webui: 画面 body')

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
    admit: (sessionId) => mud.admit(sessionId),
    stopAdmit: (sessionId) => mud.stopAdmit(sessionId),
    refreshStatus: (sessionId) => mud.refreshStatus(sessionId),
    startStatusWatch: () => mud.startStatusWatch(),
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
