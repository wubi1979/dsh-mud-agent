/**
 * dsh-mud-webui — MUD WebSocket controller (client half).
 *
 * Owns the single `/mud/ws` connection for the whole page: same-origin ws/wss
 * derivation, hello handshake with per-channel resume seqs, exponential
 * backoff reconnect, and frame dispatch to event-style handlers. Data flows
 * one way (server → browser); the controller keeps only the last-seen seqs
 * and the latest world snapshot.
 *
 * Frame contract mirrors mud-core's src/client/wire.ts:
 *   client → server: `{type:'hello', lastGameSeq, lastUiSeq}`
 *   server → client: `{ch:'game', items}` / `{ch:'ui', items}` / `{ch:'world', world}`
 * @module @deepseek-ai/dsh-mud-webui/client/mud-socket
 */

import type { MudGameItem, MudUiItem } from '@deepseek-ai/dsh-mud-core/client-wire'

/** Connection lifecycle shown by consumers that care about channel health. */
export type MudSocketStatus = 'connecting' | 'open' | 'closed'

type GameHandler = (items: readonly MudGameItem[]) => void
type UiHandler = (items: readonly MudUiItem[]) => void
type WorldHandler = (world: unknown) => void
type StatusHandler = (status: MudSocketStatus) => void

/** Reconnect backoff: doubling from 500ms, capped at 8s. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000

/** Retention caps per view array (display-layer truncation only). */
const GAME_RETAIN_MAX = 5000
const LOGS_RETAIN_MAX = 500
const DECISIONS_RETAIN_MAX = 200

/** Stable view snapshot for useSyncExternalStore consumers (LogView/Rail). */
export interface MudViewSnapshot {
  readonly logs: readonly MudUiItem[]
  readonly decisions: readonly MudUiItem[]
  readonly world: unknown
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
 * One shared WebSocket per page. Handlers are plain callbacks registered via
 * `onGame`/`onUi`/`onWorld`/`onStatus`; every handler sees frames in arrival
 * order, backfill batches included.
 */
export class MudSocketController {
  private status: MudSocketStatus = 'connecting'
  private ws: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lastGameSeq = 0
  private lastUiSeq = 0
  private latestWorld: unknown = null

  // ── 保留视图 (组件重挂载也能渲染历史; 快照引用仅在内容变化时更换) ──
  private readonly gameRetain: MudGameItem[] = []
  private logs: readonly MudUiItem[] = []
  private decisions: readonly MudUiItem[] = []
  private view: MudViewSnapshot = { logs: this.logs, decisions: this.decisions, world: null }
  private readonly viewListeners = new Set<() => void>()

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

  /** Latest world snapshot received so far (null before the first frame). */
  getWorld(): unknown {
    return this.latestWorld
  }

  /**
   * Stable view snapshot (logs/decisions/world) for useSyncExternalStore:
   * array references change only when new ui/world frames land.
   */
  getView(): MudViewSnapshot {
    return this.view
  }

  /** View subscription for useSyncExternalStore. */
  subscribeView(listener: () => void): () => void {
    this.viewListeners.add(listener)
    return () => { this.viewListeners.delete(listener) }
  }

  /** Retained game items — a late-mounting surface replays these on mount. */
  getGameItems(): readonly MudGameItem[] {
    return this.gameRetain
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
      const frame = msg as { ch?: unknown; items?: unknown; world?: unknown }
      if (frame.ch === 'game' && Array.isArray(frame.items)) {
        const items = frame.items.filter(isMudGameItem)
        for (const item of items) {
          if (item.seq > this.lastGameSeq) this.lastGameSeq = item.seq
        }
        this.gameRetain.push(...items)
        if (this.gameRetain.length > GAME_RETAIN_MAX) {
          this.gameRetain.splice(0, this.gameRetain.length - GAME_RETAIN_MAX)
        }
        for (const handler of [...this.gameHandlers]) handler(items)
        return
      }
      if (frame.ch === 'ui' && isMudUiItems(frame.items)) {
        const items = frame.items.filter(isMudGameItem).map(asUiItem)
        for (const item of items) {
          if (item.seq > this.lastUiSeq) this.lastUiSeq = item.seq
        }
        const logs = items.filter(item => item.kind === 'log')
        const decisions = items.filter(item => item.kind === 'decision')
        if (logs.length > 0) {
          this.logs = [...this.logs, ...logs].slice(-LOGS_RETAIN_MAX)
        }
        if (decisions.length > 0) {
          this.decisions = [...this.decisions, ...decisions].slice(-DECISIONS_RETAIN_MAX)
        }
        if (logs.length > 0 || decisions.length > 0) {
          this.view = { logs: this.logs, decisions: this.decisions, world: this.latestWorld }
          for (const listener of [...this.viewListeners]) listener()
        }
        for (const handler of [...this.uiHandlers]) handler(items)
        return
      }
      if (frame.ch === 'world') {
        this.latestWorld = frame.world
        this.view = { logs: this.logs, decisions: this.decisions, world: this.latestWorld }
        for (const listener of [...this.viewListeners]) listener()
        for (const handler of [...this.worldHandlers]) handler(frame.world)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return // a newer socket superseded this one
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => { /* close follows; no double scheduling */ }
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
