/**
 * dsh-mud-webui — WebUI client half.
 *
 * Replaces part of the native web chrome with the MUD launcher surface:
 *   - `sidebar`   (priority -100, shadows SidebarRoot): server/user wizard
 *     tree — 添加服务器 dialog, per-server ➕ add-user dialog, per-user ⋯
 *     delete menu, connection status foot.
 *   - `conversation.view` entries (mud-game / mud-log): the game window and
 *     the decision log as native session-header tabs. The conversation slot
 *     itself is NOT shadowed — once a user's session is open (点击用户), the
 *     native header renders 聊天/游戏/日志 tabs and the selected view fills
 *     the center. Terminal/log/decision/world data flows through the shared
 *     /mud/ws WebSocket channel, filtered per session.
 *   - a right-Sidebar tab type (`kind: 'mud'`, a page type): the decision
 *     summary + connection-status rail.
 *
 * Official-path contract (用户即会话):
 *   - **创建用户 = 创建会话**: creating a user calls the official
 *     `ctx.sessions.create()` and stores the id it returns; the page never
 *     mints session ids.
 *   - **切换用户 = 切换会话**: clicking a user calls `ctx.sessions.open(id)`
 *     (the native session switch), so the host side follows the session, not a
 *     page-local selection.
 *   - **回复用户 = 回复会话**: every host call carries `sessionId`
 *     (POST /mud/bind, /mud/connect, /mud/disconnect, /mud/command, /mud/logs,
 *     GET /mud/status), and the sidebar keeps one state row per session.
 *
 * Roster (accounts + their session ids) and per-session connection state live in
 * the MudStateController. Connect/disconnect is driven from the sidebar user-row
 * ⋯ menu (the session body does not render while blank) and mirrored by the game
 * page toolbar once its tab is visible. No placeholder prompt is ever sent: the
 * first game batch delivered after connecting opens a turn and flips `blank`.
 * @module @deepseek-ai/dsh-mud-webui/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the conversation/layout/renderer/session/sidebar-right SlotMap merges into the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MudStateController, IDLE_CONN, type MudUser } from './mud-state.ts'
import { MudSocketController } from './mud-socket.ts'
import { MudRemoteController } from './mud-remote.ts'
import { MudCredentialsController, mintPassRef } from './mud-credentials.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'
import { GameView } from './GameView.tsx'
import { LogView } from './LogView.tsx'
import { Rail } from './Rail.tsx'
import xtermCss from './xterm.css?inline'

/** 必需服务: slots 注册 + layout/sessions 动作 + 右栏 tab 注册表/控制器 + remote (typert 客户端, mount 前必须已加载)。 */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'sidebarRightTabs', 'sidebarRight', 'remote']

/** 注入 xterm 基础样式 (bundle 内联 CSS 文本, 插件生命周期内一次性)。 */
function ensureXtermCss(): void {
  if (typeof document === 'undefined' || document.getElementById('mud-xterm-css')) return
  const tag = document.createElement('style')
  tag.id = 'mud-xterm-css'
  tag.textContent = [
    xtermCss,
    // 隐藏 mud 视图 (游戏/日志) 下的聊天宽度拖拽条: 作用域由视图根元素上的
    // [data-mud-no-width] 决定 (任意 mud 激活即生效), 聊天/轨迹等原生视图
    // 不受影响。不依赖 [data-conversation-composer-overlay] —— 那会顺带把
    // 输入座改成绝对定位、覆盖到终端/日志底部。
    '[data-phase]:has([data-conversation-scroll] [data-mud-no-width]) [data-width-handle]{display:none}',
  ].join('\n')
  document.head.appendChild(tag)
}

/**
 * 打开右栏 mud rail, 且不抢占列的首次展开。
 *
 * 列第一次展开时, 若 pane 仍为空, harness 的 settle 规则会按默认页 seed
 * 它 ("fresh surface shows only what it opened"); 而 openTab 总是先把列
 * 展开、再把目标页放进 pane —— 若 mud 是被放进 pane 的第一个 tab, 默认页
 * 就永远不会 seed。因此这里先决定 harness 的默认页 (与 defaultSeed
 * 同规则: 恰一个 guide 条目 → 该 kind; 否则 guide 本体), 先把默认页一并
 * 放入 pane, 再打开 mud —— 两者在同一 pane 并存 (页面唯一性按 kind 区分,
 * 互不合并), mud 为激活 tab。任何一步失败都不阻塞 mud rail 本身。
 * @param ctx - client root context。
 * @returns 是否成功打开 mud rail。
 */
function openMudRail(ctx: ClientContext): boolean {
  try {
    const guide = ctx.sidebarRightTabs.guide()
    const first = guide.length === 1 ? guide[0]!.kind : 'guide'
    try { ctx.sidebarRight.openTab(first) } catch { /* 默认页侧失败不阻塞 mud rail */ }
    ctx.sidebarRight.openTab('mud')
    return true
  } catch {
    return false
  }
}

/**
 * Client 插件入口: 遮蔽 sidebar, 注册一个 right-Sidebar 页面 tab 类型 (mud:
 * 决策/状态 rail, additive, 不遮蔽原右栏 tabs), 向原生 conversation 槽
 * 注册 游戏/日志 两个 view 条目 (会话头 tab 由槽条目自动生成)。服务器/用户
 * 清单与每会话连接状态由 MudStateController 统一持有, 经 inject hooks 舱
 * (useServers) 与 actions 供各组件读写。终端/日志/决策/world 数据全部来自
 * 共享的 /mud/ws 推送通道 (MudSocketController), 按 sessionId 过滤。
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ensureXtermCss()

  // RPC 面 (官方 typert 客户端): mount 后接入流消费。失败退避重试 (覆盖 connection/
  // typert 服务晚就绪的暂态时序); 重试穷尽后把真实原因写到侧栏状态行 (conn.error),
  // 不用开控制台也能看到为什么"尚未挂载"。
  const mudRemote = new MudRemoteController()
  // 凭据引用面 (官方 `remote.credentials`): 明文只经它单向写入 host, 名单只存引用名。
  const credentials = new MudCredentialsController(ctx)
  // Roster + per-session connection controller: one observable source shared by
  // every registration through the inject hooks compartment.
  const mud = new MudStateController(mudRemote, credentials)
  // One shared MUD stream consumer per page: game/log/decision/world push.
  const mudSocket = new MudSocketController()
  const MOUNT_CONN_LABEL = 'MUD RPC'
  const mountWithRetry = (attempt = 0): void => {
    void mudRemote.mount(ctx).then(namespace => {
      // 挂载成功复位此前显示的挂载错误 (按 label 标记识别, 不碰正常连接状态)。
      if (mud.getSnapshot().conn.label === MOUNT_CONN_LABEL) mud.setConn(IDLE_CONN)
      mudSocket.start(namespace)
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[mud] remote mount 失败:', err)
      if (attempt >= 3) {
        mud.setConn({
          state: 'error',
          serverId: null,
          userId: null,
          sessionId: null,
          label: MOUNT_CONN_LABEL,
          error: `remote 挂载失败: ${message}`,
        })
        return
      }
      setTimeout(() => mountWithRetry(attempt + 1), 2000 * 2 ** attempt)
    })
  }
  mountWithRetry()

  /**
   * 声明"该官方会话是 MUD 账号会话" (host 据此装配工具/提示/选路)。
   * **必须先于会话内首个模型请求完成** — 否则该回合会落到真实 LLM;
   * 调用方 await 本 promise 后再 open。
   */
  const bindSession = (sessionId: string): Promise<void> => {
    if (sessionId === '') return Promise.resolve()
    return mudRemote.bind(sessionId).catch(() => { /* best-effort: connect 时仍会声明 */ })
  }

  /**
   * 打开一个已登记的会话。
   *
   * **不发送任何占位 prompt**: `blank` 由该会话的**第一个 `turn/start`** 翻转
   * (`session-controller/src/list.ts`), 而连接后第一批发出的游戏输出经
   * `agent.followup` 自然开启回合 —— 真实信息自己翻页, 不需要伪造 user 消息。
   * 连接入口在左栏用户行的 ⋯ 菜单 (会话体渲染之前就可用)。
   */
  const openSession = (sid: SessionId): void => {
    const sessions = ctx.get('sessions') as ISessions | undefined
    if (sessions === undefined) return
    const listed = (): boolean => sessions.list.getSnapshot().ids.includes(sid)
    if (listed()) {
      sessions.open(sid)
      return
    }
    // 旧用户 (roster 里的 id 尚未在本机列表登记): 拉权威列表, 仍不在则按该 id
    // 走官方 create 补登记 (host 侧同 id 复用既有会话)。
    void sessions.refresh().then(() => {
      if (listed()) {
        sessions.open(sid)
        return undefined
      }
      return sessions.create({ sessionId: sid }).then(() => { sessions.open(sid) })
    }).catch(() => { /* best-effort */ })
  }

  /**
   * 共建一个用户的会话: 没有 sessionId 时走官方 `sessions.create()` (由 host
   * 分配 id 并返回 — 页面不自铸身份), 登记进 roster, 声明 MUD 绑定, 然后打开。
   * 不发送任何占位消息 (见 `openSession`)。
   */
  const ensureAndOpenUserSession = (serverId: string, userId: string): void => {
    const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
    const user = server?.users.find(candidate => candidate.id === userId)
    if (server === undefined || user === undefined) return
    // 打开右栏 mud tab (幂等; 先并入默认页, 避免抢占列的首次展开)。
    try { openMudRail(ctx) } catch { /* registry 未就绪或当前无面板 */ }
    const sessions = ctx.get('sessions') as ISessions | undefined
    if (sessions === undefined) return
    if (user.sessionId !== '') {
      // 先声明绑定再打开: host 侧 agent 装配 (工具/提示/选路) 先于该会话的首个
      // 模型请求 (连接后第一批游戏输出) 生效。
      void bindSession(user.sessionId).then(() => {
        openSession(user.sessionId as SessionId)
      })
      return
    }
    // 用户尚无会话: 官方创建 (不带 sessionId → host 分配并返回)。
    void sessions.create({ ...(server.cwd !== '' ? { cwd: server.cwd } : {}) })
      .then(async (created) => {
        const sessionId = String(created)
        mud.setUserSession(serverId, userId, sessionId)
        await bindSession(sessionId)
        openSession(sessionId as SessionId)
      })
      .catch((err: unknown) => {
        mud.setConn({
          ...mud.getSnapshot().conn,
          state: 'error',
          serverId,
          userId,
          sessionId: null,
          label: `${server.name} / ${user.name}`,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  /**
   * Host 侧注销一个会话 (删除用户/服务器时调用): 释放运行时与连接, 删除该
   * 会话的全部日志文件, 清空 host 缓冲。失败不阻塞页面 — 名单行已经删掉,
   * 残留清理是尽力而为。
   */
  const purgeSessionOnHost = (sessionId: string): void => {
    if (sessionId === '') return
    void mudRemote.purge(sessionId).catch(() => { /* best-effort */ })
  }

  /**
   * 归档该用户配套的官方会话 (删除用户时调用)。
   *
   * 官方没有"删除会话", 但有**归档**: `IWorkspaces.archiveSession` 把会话加入
   * registry 全局归档集 —— 从所有分组/搜索界面隐藏, 会话文件与 workspace 记账
   * 槽位保留 (官方语义见 `api/workspace-controller/src/client/service.ts`),
   * 归档当前会话时 harness 自己会把选择清成新会话视图 (ui-workspace 的
   * `clearArchivedCurrent`)。因此删用户后该会话不会再出现在界面上。
   * 归档要求会话存在 (live 或持久化里), 名单里可能是失效 id → 失败只记不抛。
   */
  const archiveSessionOnHost = (sessionId: string): void => {
    if (sessionId === '') return
    const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
    void workspaces?.archiveSession(sessionId as SessionId).catch((err: unknown) => {
      // 归档失败只影响"界面隐藏"这一步 (运行痕迹已由 /mud/purge 清掉), 不阻塞
      // 页面流程; 但**不能静默** —— 归档失败时 tab 不会翻成 blank, 得能查。
      console.warn(`[mud] 会话归档失败 (${sessionId}):`, err)
    })
  }

  /** 删除用户/服务器的共同回收: 归档官方会话 + 注销插件侧运行痕迹。 */
  const recycleSession = (sessionId: string): void => {
    mudSocket.forget(sessionId)
    archiveSessionOnHost(sessionId)
    purgeSessionOnHost(sessionId)
  }

  /** 一组用户里非空的凭据引用名 (回收时用)。 */
  const passRefsOf = (users: readonly MudUser[]): string[] =>
    users.map(user => user.passRef).filter(ref => ref !== '')

  /**
   * best-effort 回收一个凭据引用 (删用户 / 删服务器 / 名单未落时回滚)。
   *
   * 引用名带随机后缀 (见 `mintPassRef`), 所以删掉的只会是本条名单行自己写的那个 ——
   * 部署手写的 `account.passRef` 不可能撞上。失败不阻塞页面流程 (名单行已经删了),
   * 但**不能静默**: 留下的是 `.credentials.yaml` 里的孤儿条目, 得能查。
   * @param ref 待回收的引用名。
   * @returns 完成即 resolve 的 promise (调用点普遍 void 掉)。
   */
  const releasePassRef = (ref: string): Promise<void> =>
    credentials.unset(ref).catch((err: unknown) => {
      console.warn(`[mud] 凭据引用回收失败 (${ref}):`, err)
    })

  /** Shared inject face: the hook sources plus the action surface. */
  const injectFace = (): MudClientInjected => ({
    hooks: {
      servers: mud,
    },
    mudSocket,
    remote: mudRemote,
    addServer: (input) => {
      mud.addServer(input)
      // 建立服务器即绑定工作空间: 注册 cwd 为 DSH workspace (幂等, 失败忽略)。
      if (input.cwd.trim() !== '') {
        const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
        void workspaces?.create({ path: input.cwd.trim() }).catch(() => { /* exists or unavailable */ })
      }
    },
    removeServer: (serverId) => {
      // 删服务器 = 回收它名下全部用户会话 (与 removeUser 同一条理由) + 回收凭据引用。
      const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
      const sessionIds = server?.users.map(user => user.sessionId).filter(id => id !== '') ?? []
      mud.removeServer(serverId)
      for (const sessionId of sessionIds) recycleSession(sessionId)
      for (const ref of passRefsOf(server?.users ?? [])) void releasePassRef(ref)
    },
    addUser: async (serverId, input) => {
      const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
      if (server === undefined) throw new Error('服务器已不存在, 请重新打开该服务器')
      // 顺序即契约: 先把明文写进 host 凭据存储, 成功后才落名单行 —— 凭据被拒
      // (或被只读源遮蔽) 时不留下一行指向不存在凭据的账号。弹窗 await 这次调用,
      // 失败会把 host 的原话显示出来并保持打开。
      const passRef = mintPassRef(server.users.map(user => user.passRef), input.name)
      await credentials.set(passRef, input.pass)
      const user = mud.addUser(serverId, { name: input.name, passRef })
      if (user === null) {
        // 名单侧没落 (服务器中途没了): 回滚刚写下的引用, 别留孤儿。
        void releasePassRef(passRef)
        throw new Error('服务器已不存在, 请重新打开该服务器')
      }
      void mud.refreshCredentials()
      // 创建用户 = 创建会话: 走官方新建会话流程 (id 由 host 返回并登记),
      // 再声明 MUD 绑定 + 打开会话。不发占位消息 — 连接后第一批游戏输出
      // 自然开回合并翻 blank (见 openSession)。
      ensureAndOpenUserSession(serverId, user.id)
    },
    removeUser: (serverId, userId) => {
      // 删除用户 = 归档会话 + 注销插件痕迹 (用户即会话): 先取出该用户的官方
      // sessionId, 用它在 host 侧释放运行时/连接、删除该会话的全部日志文件
      // (否则同名重建或按旧 id 补登记的用户会把上一个身份的日志读回来), 并把
      // 配套的官方会话**归档** (官方界面从此不再显示它); 再丢弃本页该会话的
      // 缓冲, 最后删名单行。
      const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
      const user = server?.users.find(candidate => candidate.id === userId)
      const sessionId = user?.sessionId ?? ''
      mud.removeUser(serverId, userId)
      if (user !== undefined) {
        for (const ref of passRefsOf([user])) void releasePassRef(ref)
      }
      void mud.refreshCredentials()
      recycleSession(sessionId)
    },
    // 共建: 委托给上面的 ensureAndOpenUserSession (官方 create + 绑定 + 打开)。
    ensureAndOpenUserSession: (serverId, userId) => {
      ensureAndOpenUserSession(serverId, userId)
    },
    connectUser: (serverId, userId) => mud.connectUser(serverId, userId),
    disconnect: (sessionId) => mud.disconnect(sessionId),
    refreshStatus: (sessionId) => mud.refreshStatus(sessionId),
    setTier: (sessionId, tier) => mud.setTier(sessionId, tier),
    // 点击用户: 选中该用户 + 打开其专属会话视图 (官方 sessions.open = 切换会话);
    // 连接动作在用户行的 ⋯ 菜单 (会话体渲染之前就可用)。
    openUserSession: (serverId, userId) => {
      mud.setActive(serverId, userId)
      ensureAndOpenUserSession(serverId, userId)
    },
    sendCommand: async (cmd, sessionId) => {
      try {
        return await mudRemote.command(cmd, undefined, sessionId)
      } catch {
        return false
      }
    },
    refreshCaptcha: async (imageUrl, sessionId) => {
      try {
        return await mudRemote.captchaRefresh(imageUrl, sessionId)
      } catch {
        return null
      }
    },
    abortCaptcha: async (sessionId) => {
      try {
        return await mudRemote.captchaAbort(sessionId)
      } catch {
        return false
      }
    },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })

  // 左侧栏: 服务器/用户向导 (遮蔽 SidebarRoot)。
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    priority: -100,
    inject: injectFace,
  }, MudSidebar))

  // 中央区: 不遮蔽 conversation 槽 — 注册 游戏/日志 两个 view 条目,
  // 原生会话头按槽条目自动生成 tab (聊天/游戏/日志), 会话体按激活 id
  // 渲染对应条目。数据来自共享的 /mud/ws 推送通道 (mud-socket 视图快照)。
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mud-game',
    order: 10,
    label: () => '游戏',
    inject: injectFace,
  }, GameView))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mud-log',
    order: 20,
    label: () => '日志',
    inject: injectFace,
  }, LogView))

  // 右栏: 决策摘要 + 状态 rail, 作为 additively 的 right-Sidebar 页面 tab
  // 类型 (kind = mud) 挂载, 不遮蔽 rightbar.session。官方两阶段注册 (见
  // ui-sidebar-documentpreview): 类型注册进 ctx.sidebarRightTabs, body 注册进
  // keyed 座 sidebar.right.pane.tab (key = 定义的 id)。与原右栏原生 tabs 并存,
  // mud tab 激活时才渲染 (ensureAndOpenUserSession 里 openTab('mud') 打开)。
  const MUD_RAIL_ID = '@deepseek-ai/dsh-mud-webui'
  const MUD_RAIL_KIND = 'mud'
  const mudRailDefinition = (): SidebarRightTabDefinition => ({
    id: MUD_RAIL_ID,
    kind: MUD_RAIL_KIND,
    // 页面类型 (省略 patterns) 按 kind 打开, 无资源地址。
    title: () => '决策/状态',
  })
  // Type 注册遵循官方模式: 用 ctx.effect 延后注册, 避免在 registry 引导期间
  // 直接注册导致启动阻塞; effect 清理时自动卸载。
  ctx.effect(() => ctx.sidebarRightTabs.register(mudRailDefinition()), 'dsh-mud-webui: mud tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: MUD_RAIL_ID,
    inject: injectFace,
  }, Rail))

  // 自动挂载兜底: 持久化会话选择 (dsh.sessions.current) 在启动时自动恢复,
  // 中部窗体会打开历史会话而无需点击用户 —— 订阅 list.current, 会话一成为
  // 当前就 openTab('mud')。启动初期 rightbar 面板/registry 可能尚未就绪,
  // openTab 抛错则退避重试 (带清理); 点击用户路径由 ensureAndOpenUserSession
  // 即时触发, 双触发幂等; 会话 removed 时 current 被 blanked (byId 无该行)
  // 则跳过, 当前无会话时不调度 (避免空转)。
  ctx.effect(() => {
    const sessions = ctx.get('sessions') as ISessions | undefined
    if (sessions === undefined) return () => { /* 服务未就绪 */ }
    let watched: SessionId | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const openMud = (): void => {
      // 同步快路径: 面板就绪则立即打开 (先并入默认页, 再开 mud rail);
      // 失败进入退避重试链。
      if (openMudRail(ctx)) { timer = undefined; return }
      if (timer !== undefined) return
      attempts = 0
      const tryOpen = (): void => {
        attempts += 1
        if (openMudRail(ctx)) { timer = undefined; return }
        if (attempts < 20) timer = setTimeout(tryOpen, 800)
        else timer = undefined
      }
      tryOpen()
    }
    const initial = sessions.list.getSnapshot()
    if (initial.current !== undefined && initial.byId[initial.current] !== undefined) {
      watched = initial.current
      openMud()
      // 恢复的历史会话若属于某个 MUD 用户, 同样先声明绑定 (装配先于模型请求)。
      const bound = mud.userOfSession(String(initial.current))
      if (bound !== null) void bindSession(String(initial.current))
    }
    const unsubscribe = sessions.list.subscribe(() => {
      const snapshot = sessions.list.getSnapshot()
      const current = snapshot.current
      if (current === undefined || current === watched || snapshot.byId[current] === undefined) return
      watched = current
      openMud()
      const bound = mud.userOfSession(String(current))
      if (bound !== null) void bindSession(String(current))
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, 'dsh-mud-webui: follow session current')
}
