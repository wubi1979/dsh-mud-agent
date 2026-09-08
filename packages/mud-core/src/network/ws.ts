/**
 * dsh-mud-core — MUD UI WebSocket hub (host half).
 *
 * 自有推送通道 (对齐 dsh-web-shell 的 /api/shell 模式):
 *   - `registerUpgrade('/mud/ws')` + noServer WebSocketServer;
 *   - 信任围栏: 与 `/api` 同语义的 loopback/trustedHosts/Origin 判定
 *     (本地精简实现, 不依赖框架内部导出);
 *   - 帧协议 (JSON 文本帧, 类型见 ./client/wire.ts):
 *       client → server: `{type:'hello', lastGameSeq?, lastUiSeq?}`
 *       server → client: `{ch:'game', items}` / `{ch:'ui', items}` /
 *                        `{ch:'world', world}`
 *   - 连接建立收到 hello 后按 seq 回填缓冲条目, 之后实时广播;
 *   - 常用路径 pushGame/pushUi: 条目入队, 同一次事件循环 tick 合并为一条帧
 *     (突发多块文本不再逐块发帧 — 前端渲染与接收同帧批量落盘);
 *   - ping/pong 心跳清理死连接; teardown 关闭全部客户端并注销路由。
 * @module @deepseek-ai/dsh-mud-core/ws
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { MudGameItem, MudUiItem, MudWorldSnapshot } from '../client/wire.ts'

export type { MudGameItem, MudUiItem, MudWorldSnapshot } from '../client/wire.ts'

/** MudWebSocketHub 构造依赖。 */
export interface MudWebSocketHubOptions {
  /** webServer.registerUpgrade 的直接转发。 */
  registerUpgrade: (route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }) => () => void
  /** 非 loopback 可信 authority (webRuntime.trustedHosts); 缺省空表 = 仅 loopback。 */
  trustedHosts?: readonly string[]
  /** 按 seq 回填缓冲 (hello 时调用一次)。 */
  backfill: (lastGameSeq: number, lastUiSeq: number) => {
    game: readonly MudGameItem[]
    ui: readonly MudUiItem[]
  }
  onError?: (err: unknown) => void
}

/** 心跳间隔: 超时无 pong 判定死连接。 */
const HEARTBEAT_MS = 30_000

// ── 信任围栏 (语义对齐 client/connection 的 api-request-trust) ──

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Browser-safe loopback classification: localhost, ::1, or any 127/8 literal. */
function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return name === 'localhost' || name === '::1' || name.endsWith('.localhost')
    || (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
}

/** Whether the request Host authority matches one trustedHosts entry. */
function matchesTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // Port-less entry matches the hostname on any port; explicit port is exact.
    return entryUrl.port === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Whether one WebSocket upgrade request may pass. Host fence first (the one
 * header DNS rebinding cannot forge), then cross-site/origin markers.
 */
function isTrustedSocketRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !matchesTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Owns the `/mud/ws` upgrade route, the connected-client set, the heartbeat,
 * and frame broadcasting. One hub serves every browser tab; state lives in
 * the host-side buffers the `backfill` callback reads from.
 */
export class MudWebSocketHub {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly clients = new Set<WebSocket>()
  private readonly ponged = new Set<WebSocket>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private disposeRoute: (() => void) | null = null
  // ── 帧合并队列: push 入队, 每次事件循环 tick 整体刷出一条帧 ──
  private gamePending: MudGameItem[] = []
  private uiPending: MudUiItem[] = []
  private flushScheduled = false

  constructor(private readonly options: MudWebSocketHubOptions) {
    this.disposeRoute = options.registerUpgrade({
      path: '/mud/ws',
      handler: (req, socket, head) => {
        if (!isTrustedSocketRequest(req, options.trustedHosts ?? [])) {
          socket.destroy()
          return
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req)
        })
      },
    })
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws)
      this.ponged.add(ws)
      ws.on('pong', () => { this.ponged.add(ws) })
      ws.on('error', (err: Error) => { options.onError?.(err) })
      ws.on('message', (raw: Buffer) => { this.onMessage(ws, raw) })
      ws.on('close', () => {
        this.clients.delete(ws)
        this.ponged.delete(ws)
      })
    })
    this.heartbeatTimer = setInterval(() => { this.beat() }, HEARTBEAT_MS)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  /** Broadcast one frame to every open client. */
  broadcast(frame: Record<string, unknown>): void {
    if (this.clients.size === 0) return
    let data: string
    try {
      data = JSON.stringify(frame)
    } catch {
      return
    }
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      try { ws.send(data) } catch { /* socket loss wins over delivery */ }
    }
  }

  /** Broadcast one game batch. */
  broadcastGame(items: readonly MudGameItem[]): void {
    if (items.length > 0) this.broadcast({ ch: 'game', items: [...items] })
  }

  /** Broadcast one UI batch (logs/decisions). */
  broadcastUi(items: readonly MudUiItem[]): void {
    if (items.length > 0) this.broadcast({ ch: 'ui', items: [...items] })
  }

  /**
   * 合并推送 (常用路径): 入队, 同一次事件循环 tick 的所有条目合并为一条帧。
   * 突发多块文本 (TCP 分包) 不再逐块发帧 —— 前端渲染与接收同帧批量落盘。
   */
  pushGame(items: readonly MudGameItem[]): void {
    if (items.length === 0) return
    for (const item of items) this.gamePending.push(item)
    this.scheduleFlush()
  }

  /** 合并推送 UI 流 (日志/决策), 同 tick 合并为一条帧。 */
  pushUi(items: readonly MudUiItem[]): void {
    if (items.length === 0) return
    for (const item of items) this.uiPending.push(item)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      const game = this.gamePending
      const ui = this.uiPending
      this.gamePending = []
      this.uiPending = []
      if (game.length > 0) this.broadcastGame(game)
      if (ui.length > 0) this.broadcastUi(ui)
    })
  }

  /** Broadcast a world snapshot (replacement semantics — no history). */
  broadcastWorld(world: MudWorldSnapshot): void {
    this.broadcast({ ch: 'world', world })
  }

  /** Terminate every client, close the server, and unregister the route. */
  dispose(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    for (const ws of this.clients) {
      try { ws.terminate() } catch { /* already gone */ }
    }
    this.clients.clear()
    this.ponged.clear()
    try { this.wss.close() } catch { /* ignore double close */ }
    this.disposeRoute?.()
    this.disposeRoute = null
  }

  /** Ping all clients; a socket missed since the last beat is dead. */
  private beat(): void {
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (!this.ponged.has(ws)) {
        try { ws.terminate() } catch { /* ignore */ }
        this.clients.delete(ws)
        continue
      }
      this.ponged.delete(ws)
      try { ws.ping() } catch { /* ignore */ }
    }
  }

  /** Hello protocol: replay buffered items after the client's last seqs. */
  private onMessage(ws: WebSocket, raw: Buffer): void {
    let msg: unknown
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as { type?: unknown; lastGameSeq?: unknown; lastUiSeq?: unknown }
    if (m.type !== 'hello') return
    const lastGameSeq = typeof m.lastGameSeq === 'number' && Number.isFinite(m.lastGameSeq) ? m.lastGameSeq : 0
    const lastUiSeq = typeof m.lastUiSeq === 'number' && Number.isFinite(m.lastUiSeq) ? m.lastUiSeq : 0
    const { game, ui } = this.options.backfill(lastGameSeq, lastUiSeq)
    this.send(ws, { ch: 'game', items: game })
    this.send(ws, { ch: 'ui', items: ui })
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify(frame)) } catch { /* ignore */ }
  }
}
