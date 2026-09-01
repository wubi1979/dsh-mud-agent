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
 *   - `details`   (priority -100, shadows DetailsPanel): decision/status rail.
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
// Type-only: pulls the conversation/layout/session SlotMap merges into the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { MudStateController } from './mud-state.ts'
import { MudSocketController } from './mud-socket.ts'
import { MudSidebar, type MudClientInjected } from './MudSidebar.tsx'
import { GameView } from './GameView.tsx'
import { LogView } from './LogView.tsx'
import { Rail } from './Rail.tsx'
import xtermCss from './xterm.css?inline'

/** 必需服务: slots 注册 + layout/sessions 动作。 */
export const inject = ['slots', 'layout', 'sessions', 'workspaces']

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
 * Client 插件入口: 遮蔽 sidebar 与 details 两个槽, 向原生 conversation 槽
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
        const res = await fetch('/mud/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd }),
        })
        if (!res.ok) return false
        const body = (await res.json()) as { ok?: unknown }
        return body.ok === true
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

  // 右栏 (details): 决策摘要 + 状态 (single slot, priority -100 遮蔽默认 DetailsPanel)。
  // Rail 挂载时 (会话打开) 通过 onRailMounted 确保 details 面板打开。
  ctx.slots.inject('details', () => ctx.slots.register({
    name: 'details',
    priority: -100,
    inject: () => ({
      ...injectFace(),
      onRailMounted: () => {
        const layout = ctx.get('layout')
        if (layout !== undefined) {
          try { layout.openDetails() } catch { /* root 未渲染时忽略 */ }
        }
      },
    }),
  }, Rail))
}
