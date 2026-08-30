/**
 * dsh-mud-core — /mud/ws hub contract tests.
 *
 * A real node:http server dispatches upgrade requests into the hub's
 * registered route (the same shape webServer provides); real `ws` clients
 * exercise the hello/backfill protocol, live broadcasts, and the trust fence.
 */

import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MudWebSocketHub, type MudGameItem, type MudUiItem } from '../src/ws.ts'

interface Harness {
  url: string
  hub: MudWebSocketHub
}

/** The route shape webServer.registerUpgrade hands to plugins. */
interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

async function startHarness(options?: {
  trustedHosts?: readonly string[]
  backfill?: (lastGameSeq: number, lastUiSeq: number) => {
    game: readonly MudGameItem[]
    ui: readonly MudUiItem[]
  }
}): Promise<Harness> {
  const routes = new Map<string, WebUpgradeRoute['handler']>()
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    routes.get(path)?.(req, socket as unknown as Duplex, head)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const hub = new MudWebSocketHub({
    registerUpgrade: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    ...(options?.trustedHosts !== undefined && { trustedHosts: options.trustedHosts }),
    backfill: options?.backfill ?? (() => ({ game: [] as readonly MudGameItem[], ui: [] as readonly MudUiItem[] })),
  })
  return {
    url: `ws://127.0.0.1:${String(port)}/mud/ws`,
    hub,
  }
}

/** Await until one socket receives `count` JSON frames; returns them parsed. */
function receive(ws: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const acc: unknown[] = []
    const onMessage = (raw: Buffer): void => {
      acc.push(JSON.parse(String(raw)) as unknown)
      if (acc.length >= count) {
        cleanup()
        resolve(acc)
      }
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const cleanup = (): void => {
      ws.off('message', onMessage)
      ws.off('error', onError)
    }
    ws.on('message', onMessage)
    ws.on('error', onError)
  })
}

/** Resolve once the socket opens; rejects on close/error-before-open. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('closed before open')) }
    const onError = (err: Error): void => { cleanup(); reject(err) }
    const cleanup = (): void => {
      ws.off('open', onOpen)
      ws.off('close', onClose)
      ws.off('error', onError)
    }
    ws.once('open', onOpen)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

describe('MudWebSocketHub', () => {
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (closers.length > 0) {
      const closer = closers.pop()
      if (closer !== undefined) await closer()
    }
  })

  function track(hub: MudWebSocketHub, ...sockets: WebSocket[]): void {
    closers.push(async () => {
      hub.dispose()
      for (const ws of sockets) ws.terminate()
    })
  }

  it('replies to hello with buffered game and ui items in order', async () => {
    const h = await startHarness({
      backfill: () => ({
        game: [{ seq: 1, text: 'room', time: 1 }, { seq: 2, text: 'look', time: 2 }],
        ui: [{ seq: 5, kind: 'log', text: '[SYS] up', time: 3 }],
      }),
    })
    const ws = new WebSocket(h.url)
    track(h.hub, ws)
    const frames = receive(ws, 2)
    await opened(ws)
    ws.send(JSON.stringify({ type: 'hello', lastGameSeq: 0, lastUiSeq: 0 }))
    expect(await frames).toEqual([
      { ch: 'game', items: [{ seq: 1, text: 'room', time: 1 }, { seq: 2, text: 'look', time: 2 }] },
      { ch: 'ui', items: [{ seq: 5, kind: 'log', text: '[SYS] up', time: 3 }] },
    ])
  }, 10_000)

  it('broadcasts live game/ui/world frames to every open client', async () => {
    const h = await startHarness()
    const wsA = new WebSocket(h.url)
    const wsB = new WebSocket(h.url)
    track(h.hub, wsA, wsB)
    // Collectors attach BEFORE broadcasting so no frame races the listeners.
    const framesA = receive(wsA, 3)
    const framesB = receive(wsB, 3)
    await Promise.all([opened(wsA), opened(wsB)])
    h.hub.broadcastGame([{ seq: 9, text: '\x1b[94mvicrly@agent>look\x1b[0m', time: 1 }])
    h.hub.broadcastUi([{ seq: 10, kind: 'decision', actor: 'rule', action: '启动 login 流程', text: '[规则] hit', time: 2 }])
    h.hub.broadcastWorld({ char: {}, room: { name: '广场' }, combat: {}, flags: {} })
    const expected: unknown[] = [
      { ch: 'game', items: [{ seq: 9, text: '\x1b[94mvicrly@agent>look\x1b[0m', time: 1 }] },
      { ch: 'ui', items: [{ seq: 10, kind: 'decision', actor: 'rule', action: '启动 login 流程', text: '[规则] hit', time: 2 }] },
      { ch: 'world', world: { char: {}, room: { name: '广场' }, combat: {}, flags: {} } },
    ]
    expect(await framesA).toEqual(expected)
    expect(await framesB).toEqual(expected)
  }, 10_000)

  it('pushGame/pushUi 同 tick 合并为一条帧', async () => {
    const h = await startHarness()
    const ws = new WebSocket(h.url)
    track(h.hub, ws)
    const frames = receive(ws, 2)
    await opened(ws)
    // 同一 tick 内多次 push → 刷出时合并为单条 game 帧 + 单条 ui 帧
    h.hub.pushGame([{ seq: 1, text: 'a', time: 1 }])
    h.hub.pushGame([{ seq: 2, text: 'b', time: 2 }])
    h.hub.pushUi([{ seq: 3, kind: 'log', text: 'x', time: 3 }])
    expect(await frames).toEqual([
      { ch: 'game', items: [{ seq: 1, text: 'a', time: 1 }, { seq: 2, text: 'b', time: 2 }] },
      { ch: 'ui', items: [{ seq: 3, kind: 'log', text: 'x', time: 3 }] },
    ])
  }, 10_000)

  it('destroys upgrades whose Host is neither loopback nor trusted', async () => {
    const h = await startHarness()
    const ws = new WebSocket(h.url, { headers: { host: 'evil.example.com' } })
    closers.push(async () => { ws.terminate() })
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => { resolve('opened') })
      ws.once('error', () => { resolve('error') })
      ws.once('close', () => { resolve('closed') })
    })
    expect(outcome).not.toBe('opened')
  }, 10_000)

  it('accepts upgrades whose Host matches a trustedHosts entry', async () => {
    const h = await startHarness({ trustedHosts: ['192.168.1.10'] })
    const ws = new WebSocket(h.url, { headers: { host: '192.168.1.10:12345' } })
    track(h.hub, ws)
    await expect(opened(ws)).resolves.toBeUndefined()
  }, 10_000)

  it('rejects cross-site upgrades even with an ok Host', async () => {
    const h = await startHarness()
    const ws = new WebSocket(h.url, {
      headers: { host: new URL(h.url).host, origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
    })
    closers.push(async () => { ws.terminate() })
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => { resolve('opened') })
      ws.once('error', () => { resolve('error') })
      ws.once('close', () => { resolve('closed') })
    })
    expect(outcome).not.toBe('opened')
  }, 10_000)
})
