/**
 * dsh-mud-webui — MUD WebSocket controller (client half).
 *
 * Owns the single `/mud/ws` connection for the whole page: same-origin ws/wss
 * derivation, hello handshake with per-channel resume seqs, exponential backoff
 * reconnect, and frame dispatch to event-style handlers. The channel itself is
 * session-agnostic — every item carries the `sessionId` it belongs to, and this
 * controller keeps **per-session** retention so 游戏/日志 views of one session
 * never show another session's stream (回复用户 = 回复会话 on the wire).
 *
 * Frame contract mirrors mud-core's src/client/wire.ts:
 *   client → server: `{type:'hello', lastGameSeq, lastUiSeq}`
 *   server → client: `{ch:'game', items}` / `{ch:'ui', items}` /
 *                    `{ch:'world', sessionId, world}`
 * @module @deepseek-ai/dsh-mud-webui/client/mud-socket
 */

import type { MudGameItem, MudUiItem } from '@deepseek-ai/dsh-mud-core/shell-wire'

/** Connection lifecycle shown by consumers that care about channel health. */
export type MudSocketStatus = 'connecting' | 'open' | 'closed'

type GameHandler = (items: readonly MudGameItem[]) => void
type UiHandler = (items: readonly MudUiItem[]) => void
type WorldHandler = (sessionId: string, world: unknown) => void
type StatusHandler = (status: MudSocketStatus) => void

/** Reconnect backoff: doubling from 500ms, capped at 8s. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000

/** Retention caps per session (display-layer truncation only). */
const GAME_RETAIN_MAX = 5000
const LOGS_RETAIN_MAX = 500
const DECISIONS_RETAIN_MAX = 200

/** 进程级条目的 sessionId (所有会话视图都显示)。 */
const GLOBAL_SESSION = ''

/** 稳定的 useSyncExternalStore 快照容器 (captcha 替换语义, 全局唯一)。 */
export interface MudCaptchaSnapshot {
  readonly captcha: MudUiItem | null
}

/** Stable view snapshot for useSyncExternalStore consumers (LogView/Rail). */
export interface MudViewSnapshot {
  readonly logs: readonly MudUiItem[]
  readonly decisions: readonly MudUiItem[]
  readonly world: unknown
}

const EMPTY_VIEW: MudViewSnapshot = { logs: [], decisions: [], world: null }

function sessionKeyOf(value: string | undefined): string {
  return value === undefined || value === '' ? GLOBAL_SESSION : value
}

function isMudGameItem(value: unknown): value is MudGameItem {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { seq?: unknown; text?: unknown; time?: unknown }
  return typeof v.seq === 'number' && typeof v.text === 'string' && typeof v.time === 'number'
}

function isMudUiItems(value: unknown): value is MudUiItem[] {
  return Array.isArray(value) && value.every(isMudGameItem)
}

/** Narrow a shape-valid ui item to its kind union (wire data is host-authored). */
function asUiItem(item: MudGameItem): MudUiItem {
  return item as MudUiItem
}

/**
 * One shared WebSocket per page. Data is retained **per session**; consumers
 * ask for the session they render (`getView(sessionId)` / `getGameItems(sessionId)`),
 * while the right-rail summary follows the focus session (the last session that
 * produced a frame).
 */
export class MudSocketController {
  private status: MudSocketStatus = 'connecting'
  private ws: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lastGameSeq = 0
  private lastUiSeq = 0

  // ── 每会话保留视图 (组件重挂载也能渲染本会话历史) ──
  private readonly gameBySession = new Map<string, MudGameItem[]>()
  private readonly logsBySession = new Map<string, MudUiItem[]>()
  private readonly decisionsBySession = new Map<string, MudUiItem[]>()
  private readonly worldBySession = new Map<string, unknown>()
  private readonly viewCache = new Map<string, MudViewSnapshot>()
  private focusSessionId = GLOBAL_SESSION
  private readonly viewListeners = new Set<() => void>()

  // ── 验证码交互 (替换语义): 新 captcha 条目整体替换, 全局唯一不叠开 ──
  private captchaState: MudCaptchaSnapshot = { captcha: null }
  private readonly captchaListeners = new Set<() => void>()

  private readonly gameHandlers = new Set<GameHandler>()
  private readonly uiHandlers = new Set<UiHandler>()
  private readonly worldHandlers = new Set<WorldHandler>()
  private readonly statusHandlers = new Set<StatusHandler>()

  constructor() {
    this.connect()
  }

  /** Current channel health (stable reference between changes). */
  getStatus(): MudSocketStatus {
    return this.status
  }

  /** 最近产出帧的会话 (右栏摘要跟随; 无帧时为空串 = 进程级)。 */
  getFocusSessionId(): string {
    return this.focusSessionId
  }

  /**
   * Stable per-session view snapshot for useSyncExternalStore: the reference
   * changes only when that session's logs/decisions/world change.
   * @param sessionId 目标会话 (缺省 = focus 会话)。
   */
  getView(sessionId?: string): MudViewSnapshot {
    const key = sessionId === undefined ? this.focusSessionId : sessionKeyOf(sessionId)
    return this.viewCache.get(key) ?? EMPTY_VIEW
  }

  /** View subscription for useSyncExternalStore (all sessions notify). */
  subscribeView(listener: () => void): () => void {
    this.viewListeners.add(listener)
    return () => { this.viewListeners.delete(listener) }
  }

  /** 当前验证码交互快照 (null = 无待确认验证码; 引用仅在新事件时更换)。 */
  getCaptcha(): MudCaptchaSnapshot {
    return this.captchaState
  }

  /** Captcha subscription for useSyncExternalStore. */
  subscribeCaptcha(listener: () => void): () => void {
    this.captchaListeners.add(listener)
    return () => { this.captchaListeners.delete(listener) }
  }

  /** 用户确认/中止后清除对话框状态 (不发任何命令 — 发送由组件走 /mud/command)。 */
  clearCaptcha(): void {
    if (this.captchaState.captcha === null) return
    this.captchaState = { captcha: null }
    for (const listener of [...this.captchaListeners]) listener()
  }

  /**
   * Retained game items of one session (进程级条目并入) — a late-mounting
   * surface replays these on mount.
   * @param sessionId 目标会话 (缺省 = focus 会话)。
   */
  getGameItems(sessionId?: string): readonly MudGameItem[] {
    const key = sessionId === undefined ? this.focusSessionId : sessionKeyOf(sessionId)
    const own = this.gameBySession.get(key) ?? []
    if (key === GLOBAL_SESSION) return own
    const global = this.gameBySession.get(GLOBAL_SESSION) ?? []
    // 进程级条目 (连接分隔等) 与自身条目按 seq 归并。
    return [...global, ...own].sort((a, b) => a.seq - b.seq)
  }

  /**
   * 丢弃某会话在本页的全部缓冲 (终端/日志/决策/world + 视图缓存)。
   *
   * 删除用户时调用: 官方会话记录可能仍在列表里 (client `ISessions` 无删除
   * 接口), 若不丢, 重新打开那个会话的视图会显示上一个身份的内容。
   * @param sessionId 目标会话 id (空串忽略)。
   */
  forget(sessionId: string): void {
    const key = sessionKeyOf(sessionId)
    if (key === '') return
    this.gameBySession.delete(key)
    this.logsBySession.delete(key)
    this.decisionsBySession.delete(key)
    this.worldBySession.delete(key)
    this.viewCache.delete(key)
    if (this.focusSessionId === key) this.focusSessionId = GLOBAL_SESSION
    if (this.captchaState.captcha?.sessionId === key) {
      this.captchaState = { captcha: null }
      for (const listener of [...this.captchaListeners]) listener()
    }
    for (const listener of [...this.viewListeners]) listener()
  }

  onGame(handler: GameHandler): () => void {
    this.gameHandlers.add(handler)
    return () => { this.gameHandlers.delete(handler) }
  }

  onUi(handler: UiHandler): () => void {
    this.uiHandlers.add(handler)
    return () => { this.uiHandlers.delete(handler) }
  }

  onWorld(handler: WorldHandler): () => void {
    this.worldHandlers.add(handler)
    return () => { this.worldHandlers.delete(handler) }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => { this.statusHandlers.delete(handler) }
  }

  /** Stop reconnecting and close the socket (plugin teardown). */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try { this.ws?.close() } catch { /* already gone */ }
    this.ws = null
  }

  private connect(): void {
    if (this.disposed || typeof WebSocket === 'undefined') return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mud/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempt = 0
      this.setStatus('open')
      // Resume from the last seqs this page has seen; zeros replay the buffer.
      try {
        ws.send(JSON.stringify({ type: 'hello', lastGameSeq: this.lastGameSeq, lastUiSeq: this.lastUiSeq }))
      } catch { /* close handler schedules the retry */ }
    }
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return
      let msg: unknown
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof msg !== 'object' || msg === null) return
      const frame = msg as { ch?: unknown; items?: unknown; world?: unknown; sessionId?: unknown }
      if (frame.ch === 'game' && Array.isArray(frame.items)) {
        const items = frame.items.filter(isMudGameItem)
        for (const item of items) {
          if (item.seq > this.lastGameSeq) this.lastGameSeq = item.seq
          const key = sessionKeyOf(item.sessionId)
          const retained = this.gameBySession.get(key) ?? []
          retained.push(item)
          if (retained.length > GAME_RETAIN_MAX) retained.splice(0, retained.length - GAME_RETAIN_MAX)
          this.gameBySession.set(key, retained)
          if (key !== GLOBAL_SESSION) this.focusSessionId = key
        }
        for (const handler of [...this.gameHandlers]) handler(items)
        return
      }
      if (frame.ch === 'ui' && isMudUiItems(frame.items)) {
        const items = frame.items.filter(isMudGameItem).map(asUiItem)
        const touched = new Set<string>()
        const captcha = items.filter(item => item.kind === 'captcha')
        for (const item of items) {
          if (item.seq > this.lastUiSeq) this.lastUiSeq = item.seq
          const key = sessionKeyOf(item.sessionId)
          if (item.kind === 'log') {
            const logs = this.logsBySession.get(key) ?? []
            logs.push(item)
            if (logs.length > LOGS_RETAIN_MAX) logs.splice(0, logs.length - LOGS_RETAIN_MAX)
            this.logsBySession.set(key, logs)
          } else if (item.kind === 'decision') {
            const decisions = this.decisionsBySession.get(key) ?? []
            decisions.push(item)
            if (decisions.length > DECISIONS_RETAIN_MAX) decisions.splice(0, decisions.length - DECISIONS_RETAIN_MAX)
            this.decisionsBySession.set(key, decisions)
          }
          touched.add(key)
          if (key !== GLOBAL_SESSION) this.focusSessionId = key
        }
        // captcha: 替换语义 — 取本批最后一条整体覆盖 (页面级对话框)。
        if (captcha.length > 0) {
          this.captchaState = { captcha: captcha[captcha.length - 1] ?? null }
          for (const listener of [...this.captchaListeners]) listener()
        }
        this.rebuildViews(touched)
        for (const handler of [...this.uiHandlers]) handler(items)
        return
      }
      if (frame.ch === 'world') {
        const key = sessionKeyOf(typeof frame.sessionId === 'string' ? frame.sessionId : undefined)
        this.worldBySession.set(key, frame.world)
        if (key !== GLOBAL_SESSION) this.focusSessionId = key
        this.rebuildViews(new Set([key]))
        for (const handler of [...this.worldHandlers]) handler(key, frame.world)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return // a newer socket superseded this one
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => { /* close follows; no double scheduling */ }
  }

  /** 受影响会话的视图快照重建 (未受影响会话引用保持不变)。 */
  private rebuildViews(touched: ReadonlySet<string>): void {
    if (touched.size === 0) return
    for (const key of touched) {
      this.viewCache.set(key, {
        logs: this.logsBySession.get(key) ?? [],
        decisions: this.decisionsBySession.get(key) ?? [],
        world: this.worldBySession.get(key) ?? null,
      })
    }
    for (const listener of [...this.viewListeners]) listener()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return
    this.setStatus('closed')
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(status: MudSocketStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of [...this.statusHandlers]) handler(status)
  }
}
