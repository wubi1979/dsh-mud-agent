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
 *     /mud/ws WebSocket channel, not session events.
 *  *   - a right-Sidebar tab type (`kind: 'mud'`, a page type): the decision
 *     summary + connection-status rail. Mounted additively (type in
 *     `ctx.sidebarRightTabs`, body in keyed `sidebar.right.pane.tab`), so the
 *     native side tabs/panes keep working — mud tab opens via
 *     `sidebarRight.openTab('mud')` when a user session opens.
 *
 * Each user owns a dedicated DSH session: creating a user calls
 * POST /mud/prepare (host creates/resumes the agent session and injects the
 * initial message, without a telnet connection). Clicking a user selects it
 * and opens that session; the connect/disconnect buttons live in the game
 * view (the game page drives the connection, the sidebar never does).
 *
 * Roster + connection state lives in the MudStateController (apply-owned);
 * the same controller is exposed to every registration through the inject
 * `hooks` compartment (`useServers`) and its actions. The connection
 * lifecycle talks to the host routes POST /mud/connect, POST /mud/disconnect,
 * POST /mud/prepare, GET /mud/status — all provided by @deepseek-ai/dsh-mud-core.
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
import { MudStateController } from './mud-state.ts'
import { MudSocketController } from './mud-socket.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'
import { GameView } from './GameView.tsx'
import { LogView } from './LogView.tsx'
import { Rail } from './Rail.tsx'
import xtermCss from './xterm.css?inline'

/** 必需服务: slots 注册 + layout/sessions 动作 + 右栏 tab 注册表/控制器。 */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'sidebarRightTabs', 'sidebarRight']

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
 * 就永远不会 seed (对右栏首个使用的会话, 用户会看到只有 mud 决策/状态而
 * 缺少默认的 files 页)。因此这里先决定 harness 的默认页 (与 defaultSeed
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
 * 清单与连接状态由 MudStateController 统一持有, 经 inject hooks 舱
 * (useServers) 与 actions 供各组件读写。终端/日志/决策/world 数据全部来自
 * 共享的 /mud/ws 推送通道 (MudSocketController), 不经 session 事件流。
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ensureXtermCss()

  // Roster + connection controller: one observable source shared by every
  // registration through the inject hooks compartment (one handle, one
  // apply fiber — slot scope differences never matter because this is not a
  // store seat, just a bare observable).
  const mud = new MudStateController()
  // One shared /mud/ws channel per page: game/log/decision/world push frames.
  const mudSocket = new MudSocketController()

  // 共建一个用户的会话: 幂等 create 登记进浏览器端 ctx.sessions 列表,
  // open 打开, 并用一个静默占位 prompt 触发官方 engaged → blank:false,
  // 让原生会话头渲染 游戏/日志 tab。占位文本无游戏意图, 避免 agent 误操作。
  const ensureAndOpenUserSession = (serverId: string, userId: string, shouldEngage: boolean): void => {
    const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
    const user = server?.users.find(candidate => candidate.id === userId)
    if (server === undefined || user === undefined) return
    // 打开右栏 mud tab (页面类型按 kind 打开, 面板随同展开): 幂等, 会话
    // 激活路径上每次请求都重开, 换会话时跟随; 先并入默认页, 避免抢占列的
    // 首次展开导致默认 files 页永不 seed。注册就绪前/当前面板不可用时忽略。
    try { openMudRail(ctx) } catch { /* registry 未就绪或当前无面板 */ }
    const sessions = ctx.get('sessions') as ISessions | undefined
    if (sessions === undefined) return
    const sid = user.sessionId as SessionId
    const engage = (face: {
      prompt: (content: Array<{ type: 'text'; text: string }>, mode: 'queue' | 'steer') => Promise<unknown>
      getSnapshot?: () => { blank?: boolean }
    } | undefined) => {
      if (!shouldEngage || face === undefined) return
      // 幂等: 仅当会话仍为 blank 才补一次占位 prompt (避免每次点击重复跑
      // agent LLM 回合)。失败忽略 (会话可能已 engaged 或 host 正忙碌)。
      if (face.getSnapshot?.().blank === false) return
      void face.prompt([{ type: 'text', text: 'MUD 游戏尚未登录，无需做出任何动作和回答，等待后续问题' }], 'queue').catch(() => { /* best-effort */ })
    }
    const listed = () => sessions.list.getSnapshot().ids.includes(sid)
    const openIfListed = () => {
      if (!listed()) return
      sessions.open(sid)
      engage(sessions.binding(sid)?.session as never)
    }
    try {
      openIfListed()
    } catch (err) {
      mud.setConn({
        ...mud.getSnapshot().conn,
        state: 'error',
        serverId,
        userId,
        sessionId: sid,
        label: `${server.name} / ${user.name}`,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // 旧用户 (修复前创建) 从未在列表 → 幂等 create 补登记, 成功后 open+engage。
    if (!listed()) {
      void sessions.create({ sessionId: sid, ...(server.cwd !== '' ? { cwd: server.cwd } : {}) })
        .then(() => {
          sessions.open(sid)
          engage(sessions.binding(sid)?.session as never)
        })
        .catch(() => {
          // 会话可能已存在于 host (旧用户): 拉权威列表补登记, 再 open+engage。
          void sessions.refresh().then(() => {
            if (!listed()) return
            sessions.open(sid)
            engage(sessions.binding(sid)?.session as never)
          }).catch(() => { /* best-effort */ })
        })
    }
  }

  /** Shared inject face: the hook sources plus the action surface. */
  const injectFace = (): MudClientInjected => ({
    hooks: {
      servers: mud,
    },
    mudSocket,
    addServer: (input) => {
      mud.addServer(input)
      // 建立服务器即绑定工作空间: 注册 cwd 为 DSH workspace (幂等, 失败忽略)。
      if (input.cwd.trim() !== '') {
        const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
        void workspaces?.create({ path: input.cwd.trim() }).catch(() => { /* exists or unavailable */ })
      }
    },
    removeServer: (serverId) => { mud.removeServer(serverId) },
    addUser: (serverId, input) => {
      const user = mud.addUser(serverId, input)
      if (user === null) return
      // 创建用户 = 创建会话 (用户=会话): 走官方新建会话流程, 把该用户的
      // 专属会话 (唯一 sessionId) 登记进浏览器端 ctx.sessions 列表并打开,
      // 再发一个静默占位 prompt 触发 engaged → blank:false, 让原生会话头
      // 渲染 游戏/日志 tab。host 侧 /mud/prepare 物化 agent (同一 sessionId)。
      const server = mud.getSnapshot().servers.find(candidate => candidate.id === serverId)
      const cwd = server?.cwd ?? ''
      fetch('/mud/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: user.sessionId, cwd }),
      }).catch(() => { /* best-effort: 连接时 host 仍会确保会话 */ })
      ensureAndOpenUserSession(serverId, user.id, true)
    },
    removeUser: (serverId, userId) => { mud.removeUser(serverId, userId) },
    // 共建: 委托给上面的 ensureAndOpenUserSession (幂等 create + open +
    // 静默占位 engage, 让原生会话头渲染 游戏/日志 tab)。
    ensureAndOpenUserSession: (serverId, userId, shouldEngage) => {
      ensureAndOpenUserSession(serverId, userId, shouldEngage)
    },
    connectUser: (serverId, userId) => mud.connectUser(serverId, userId),
    disconnect: () => mud.disconnect(),
    refreshStatus: () => mud.refreshStatus(),
    // 点击用户: 选中该用户 + 打开其专属会话视图, 并 (幂等) engage 会话,
    // 确保原生会话头渲染 游戏/日志 tab。
    openUserSession: (serverId, userId) => {
      mud.setActive(serverId, userId)
      ensureAndOpenUserSession(serverId, userId, true)
    },
    sendCommand: async (cmd) => {
      try {
        // 命令序列格式 [halt,fullme text] → 发送 cmds 数组; 否则单命令。
        const seqMatch = /^\[(.+)\]$/.exec(cmd)
        let body: Record<string, unknown>
        if (seqMatch !== null && seqMatch[1] !== undefined) {
          body = { cmds: seqMatch[1].split(',').map(c => c.trim()).filter(c => c !== '') }
        } else {
          body = { cmd }
        }
        const res = await fetch('/mud/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) return false
        const resBody = (await res.json()) as { ok?: unknown }
        return resBody.ok === true
      } catch {
        return false
      }
    },
    refreshCaptcha: async (imageUrl): Promise<string | null> => {
      try {
        const res = await fetch('/mud/captcha/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ imageUrl }),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { ok?: unknown; url?: unknown }
        return body.ok === true && typeof body.url === 'string' ? body.url : null
      } catch {
        return null
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
    }
    const unsubscribe = sessions.list.subscribe(() => {
      const snapshot = sessions.list.getSnapshot()
      const current = snapshot.current
      if (current === undefined || current === watched || snapshot.byId[current] === undefined) return
      watched = current
      openMud()
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, 'dsh-mud-webui: follow session current')
}
