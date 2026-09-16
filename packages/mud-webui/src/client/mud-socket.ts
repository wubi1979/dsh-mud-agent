/**
 * dsh-mud-webui — MUD stream consumption + per-session view retention (client half).
 *
 * 传输面已迁移官方 typert 流 (host 侧 `@Remote({mode:'stream'})`, 客户端经
 * `ctx.remote.mud.game/ui/world` 的 AsyncIterable 消费, 官方 gateway mux +
 * RemoteStream 监督承担连接与断线重连)。本类只保留**视图职责**:
 *   - 三条流循环 (start 后各起一条, 意外结束退避重开并携带 lastSeq 游标);
 *   - **每会话**保留 (游戏/日志/决策/world), 组件重挂载也能渲染本会话历史;
 *   - captcha 替换语义快照 + useSyncExternalStore 视图快照。
 * 通道本身与会话无关 — 每个条目自带 `sessionId`, 回复用户 = 回复会话。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-socket
 */

import type { MudGameItem, MudUiItem } from '@deepseek-ai/dsh-mud-core/remote-types'
import type { MudNamespace } from './mud-remote.ts'

/** Connection lifecycle shown by consumers that care about channel health. */
export type MudSocketStatus = 'connecting' | 'open' | 'closed'

type GameHandler = (items: readonly MudGameItem[]) => void
type UiHandler = (items: readonly MudUiItem[]) => void
type WorldHandler = (sessionId: string, world: unknown) => void
type StatusHandler = (status: MudSocketStatus) => void

/** Stream retry backoff: doubling from 500ms, capped at 8s (官方监督之外的形态兜底). */
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

/** Narrow a shape-valid ui item to its kind union (wire data is host-authored). */
function asUiItem(item: MudGameItem): MudUiItem {
  return item as MudUiItem
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * One page's MUD stream consumer. Data is retained **per session**; consumers
 * ask for the session they render (`getView(sessionId)` / `getGameItems(sessionId)`),
 * while the right-rail summary follows the focus session (the last session that
 * produced an item). `start()` 前流未接入 (RPC mount 完成后调用), 视图为空。
 */
export class MudSocketController {
  private status: MudSocketStatus = 'connecting'
  private disposed = false
  private abort: AbortController | null = null
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

  /** 用户确认/中止后清除对话框状态 (不发任何命令 — 发送由组件走 mud remote)。 */
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

  /**
   * 接入官方 typert 流 (RPC mount 完成后调用一次): game/ui/world 三条消费循环,
   * 各自 until disposed。官方 RemoteStream 监督负责连接与断线重连; 这里只在
   * 流迭代意外结束时退避重开 (携带 lastSeq 游标续读, 缺口按 seq 契约合法)。
   */
  start(mud: MudNamespace): void {
    if (this.disposed || this.abort !== null) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    void this.consume('game', attempt => this.consumeGame(mud, attempt, signal))
    void this.consume('ui', attempt => this.consumeUi(mud, attempt, signal))
    void this.consume('world', attempt => this.consumeWorld(mud, attempt, signal))
  }

  /** Stop stream consumption (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.abort?.abort()
    this.abort = null
    this.setStatus('closed')
  }

  private async consume(
    label: 'game' | 'ui' | 'world',
    iteration: (attempt: number) => Promise<void>,
  ): Promise<void> {
    let attempt = 0
    while (!this.disposed) {
      try {
        await iteration(attempt)
        attempt = 0
      } catch { /* aborted → exit; transport hiccup → retry */ }
      if (this.disposed) break
      this.setStatus('closed')
      await delay(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt), this.abort!.signal)
      attempt += 1
    }
    void label
  }

  private async consumeGame(mud: MudNamespace, attempt: number, signal: AbortSignal): Promise<void> {
    this.setStatus('open')
    const since = attempt === 0 && this.lastGameSeq === 0 ? undefined : this.lastGameSeq
    for await (const items of await mud.game(since, signal)) this.ingestGame(items)
  }

  private async consumeUi(mud: MudNamespace, attempt: number, signal: AbortSignal): Promise<void> {
    this.setStatus('open')
    const since = attempt === 0 && this.lastUiSeq === 0 ? undefined : this.lastUiSeq
    for await (const items of await mud.ui(since, signal)) this.ingestUi(items)
  }

  private async consumeWorld(mud: MudNamespace, _attempt: number, signal: AbortSignal): Promise<void> {
    this.setStatus('open')
    for await (const event of await mud.world(signal)) this.ingestWorld(event)
  }

  /** 游戏批次归集 (seq 游标 + 每会话保留 + handlers)。 */
  private ingestGame(items: readonly MudGameItem[]): void {
    const valid = items.filter(isMudGameItem)
    for (const item of valid) {
      if (item.seq > this.lastGameSeq) this.lastGameSeq = item.seq
      const key = sessionKeyOf(item.sessionId)
      const retained = this.gameBySession.get(key) ?? []
      retained.push(item)
      if (retained.length > GAME_RETAIN_MAX) retained.splice(0, retained.length - GAME_RETAIN_MAX)
      this.gameBySession.set(key, retained)
      if (key !== GLOBAL_SESSION) this.focusSessionId = key
    }
    for (const handler of [...this.gameHandlers]) handler(valid)
  }

  /** UI 批次归集 (日志/决策保留 + captcha 替换 + 视图快照重建)。 */
  private ingestUi(items: readonly MudUiItem[]): void {
    const valid = (Array.isArray(items) ? items : []).filter(isMudGameItem).map(asUiItem)
    const touched = new Set<string>()
    const captcha = valid.filter(item => item.kind === 'captcha')
    for (const item of valid) {
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
    for (const handler of [...this.uiHandlers]) handler(valid)
  }

  /** 世界快照落座 (替换语义, 无历史)。 */
  private ingestWorld(event: { sessionId?: string; world: unknown }): void {
    const key = sessionKeyOf(event.sessionId)
    this.worldBySession.set(key, event.world)
    if (key !== GLOBAL_SESSION) this.focusSessionId = key
    this.rebuildViews(new Set([key]))
    for (const handler of [...this.worldHandlers]) handler(key, event.world)
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

  private setStatus(status: MudSocketStatus): void {
    if (this.status === status) return
    this.status = status
    for (const handler of [...this.statusHandlers]) handler(status)
  }
}
