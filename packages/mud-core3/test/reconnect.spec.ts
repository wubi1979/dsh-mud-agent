/**
 * 自动重连测试（T5.2，D4/D5/P1）。
 *
 * 验收断言（PLAN 第 5 章 T5.2 行）：
 *   ① 意外断开（socket close / 探活判死）且 gate 满足 → 自动重连到成功；
 *      未接入（admitted=false）同样重连；重连成功 pulseActivity（C3）；
 *   ② 连续 maxAttempts 次失败 → 放弃保持 disconnected，且不再开第二轮（禁止重入）；
 *   ③ 手工 disconnect → 不重连（manualDisconnected）；
 *   ④ 冷启动（新 runtime 无 hasConnected）不自动（getter 断言，设计保证）；
 *   ⑤ 重连循环期手工 disconnect 经 reconnectToken 打断：不再尝试、不双连；
 *      dispose 同理取消在飞重连；
 *   ⑦ 重连成功后不重复投递旧行（abs 连续 + 水位 -1，C4）；
 *   ⑧ 多会话互不串扰。
 *
 * 真 socket 手法承 mud.spec.ts / service.spec.ts（node:net 测试服务器）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { MudService } from '../src/service.ts'
import type { AccountRecord, ServerRecord } from '../src/roster.ts'

// ── 可控测试服务器 ────────────────────────────────────────────────

interface TestServer {
  port: number
  /** 累计接受的连接数（含被杀的）。 */
  readonly connCount: number
  /** 「接受即杀」模式开关（重连尝试次次失败的构造）。 */
  setKillMode(on: boolean): void
  /** 立即销毁全部现役连接（模拟意外断开/服务端 EOF）。 */
  killAll(): void
  /** 向全部现役连接写文本行。 */
  write(text: string): void
  close(): Promise<void>
}

async function startServer(): Promise<TestServer> {
  const sockets = new Set<net.Socket>()
  let killOnConnect = false
  let connCount = 0
  const server = net.createServer((s) => {
    connCount += 1
    sockets.add(s)
    s.on('error', () => {})
    if (killOnConnect) {
      s.destroy()
      return
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    get connCount() { return connCount },
    setKillMode(on) { killOnConnect = on },
    killAll() { for (const s of sockets) s.destroy() },
    write(text) { for (const s of sockets) { if (!s.destroyed) s.write(text) } },
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

// ── service 装配（内存 roster；重连刻度压缩到测试量级）────────────

const ACCOUNT: AccountRecord = {
  id: 'acc-1', name: 'hero', passRef: 'cred-1', serverId: 'ws-1', preset: 'mud-player', admitted: false,
}

function makeDeps(server: TestServer) {
  return {
    serverLookup: (): ServerRecord | undefined =>
      ({ workspaceId: 'ws-1', name: '测试MUD', host: '127.0.0.1', port: server.port }),
    accountLookup: (id: string) => (id === 'acc-1' ? ACCOUNT : undefined),
    resolveCreds: async () => ({ name: 'hero', pass: 'pass' }),
  }
}

interface SetupOptions {
  reconnect?: { maxAttempts: number, intervalMs: number }
  keepalive?: { startMs: number, retryMs: number, maxAttempts: number }
  deliver?: (sessionId: string, text: string) => boolean | string | false | void
}

async function setup(opts: SetupOptions = {}): Promise<{
  server: TestServer
  service: MudService
  rt: ReturnType<MudService['register']>
}> {
  const server = await startServer()
  const service = new MudService({
    ...makeDeps(server),
    reconnect: opts.reconnect ?? { maxAttempts: 3, intervalMs: 50 },
    ...(opts.keepalive !== undefined ? { keepalive: opts.keepalive } : {}),
    ...(opts.deliver !== undefined ? { deliver: opts.deliver } : {}),
    delivererConfig: { quietMs: 20, maxWaitMs: 100 },
  })
  const rt = service.register('acc-1', 'hero')
  return { server, service, rt }
}

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil 超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

function logTexts(service: MudService, sessionId: string): string[] {
  return (service.logOf(sessionId)?.entries ?? []).map(e => e.text)
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('自动重连（T5.2）', () => {
  it('①意外断开（socket close）→ 自动重连成功；未接入同样重连；重连成功 pulseActivity（C3）', async () => {
    const { server, service, rt } = await setup()
    // 服务器不推任何行 ⇒ onActivity 只可能来自重连成功的 pulseActivity
    let pulses = 0
    rt.onActivity = () => { pulses += 1 }
    await service.connect('acc-1')
    expect(rt.connState).toBe('connected')
    expect(rt.hasConnected).toBe(true)
    expect(rt.manualDisconnected).toBe(false)
    expect(service.status('acc-1').admitted).toBe(false) // 未接入

    server.killAll() // 意外断开（服务端侧销毁）
    await waitUntil(() => rt.connState === 'connected' && server.connCount >= 2)
    expect(server.connCount).toBe(2)
    expect(pulses).toBe(1) // C3：重连成功显式 arm 一次静默计时
    await server.close()
  })

  it('①探活判死 → 同一自动重连路径（日志含判死与重连记录）', async () => {
    const { server, service, rt } = await setup({ keepalive: { startMs: 30, retryMs: 30, maxAttempts: 2 } })
    await service.connect('acc-1')
    // 自驱探活（T12）：服务端不回应 AYT——30ms 首发 + 30ms 重发 + 30ms 判死
    await waitUntil(() => rt.connState === 'connected' && server.connCount >= 2)
    const texts = logTexts(service, 'acc-1').join('\n')
    expect(texts).toContain('探活判死')
    expect(texts).toContain('自动重连第 1/3 次')
    expect(texts).toContain('自动重连成功')
    await server.close()
  })

  it('②连续 maxAttempts 次失败 → 放弃保持 disconnected；不再开第二轮（禁止重入）', async () => {
    const { server, service, rt } = await setup({ reconnect: { maxAttempts: 2, intervalMs: 40 } })
    await service.connect('acc-1')
    server.setKillMode(true) // 之后每次连接接受即杀
    server.killAll()
    await waitUntil(() => logTexts(service, 'acc-1').some(t => t.includes('已达上限')))
    // 放弃后等待 ≥ 2×interval：不得再有任何尝试（连接数稳定 = 1 初连 + 2 次尝试）
    await new Promise(r => setTimeout(r, 200))
    expect(rt.connState).toBe('disconnected')
    expect(server.connCount).toBe(3)
    await server.close()
  })

  it('③手工 disconnect → 不重连（manualDisconnected 置位）', async () => {
    const { server, service, rt } = await setup()
    await service.connect('acc-1')
    service.disconnect('acc-1')
    await new Promise(r => setTimeout(r, 200))
    expect(rt.connState).toBe('disconnected')
    expect(rt.manualDisconnected).toBe(true)
    expect(server.connCount).toBe(1) // 无重连尝试
    await server.close()
  })

  it('④冷启动（新 runtime 无 hasConnected）设计保证不自动重连', async () => {
    const { service, rt } = await setup()
    const fresh = service.register('acc-2', 'mage')
    expect(fresh.hasConnected).toBe(false) // 闸门必 false ⇒ 钩子不会启动循环
    expect(service.status('acc-2').state).toBe('disconnected')
    expect(rt.isDisposed).toBe(false)
  })

  it('⑤重连循环期手工 disconnect 打断：不再尝试、不双连（P1）', async () => {
    const { server, service, rt } = await setup({ reconnect: { maxAttempts: 5, intervalMs: 150 } })
    await service.connect('acc-1')
    server.setKillMode(true)
    server.killAll()
    await waitUntil(() => server.connCount >= 2) // 第 1 次尝试已发起并失败
    service.disconnect('acc-1') // 打断（此刻循环应在重试间隔 sleep 中）
    const before = server.connCount
    await new Promise(r => setTimeout(r, 500)) // > 2×interval
    expect(server.connCount).toBe(before) // 不再有任何尝试
    expect(rt.connState).toBe('disconnected')
    expect(rt.manualDisconnected).toBe(true)
    await server.close()
  })

  it('⑤dispose 取消在飞重连循环', async () => {
    const { server, service, rt } = await setup({ reconnect: { maxAttempts: 5, intervalMs: 150 } })
    await service.connect('acc-1')
    server.setKillMode(true)
    server.killAll()
    await waitUntil(() => server.connCount >= 2)
    service.dispose('acc-1')
    const before = server.connCount
    await new Promise(r => setTimeout(r, 400))
    expect(server.connCount).toBe(before)
    expect(rt.isDisposed).toBe(true)
    await server.close()
  })

  it('⑦重连成功后不重复投递旧行（C4：abs 连续 + 水位已复位）', async () => {
    const delivered: string[] = []
    const { server, service, rt } = await setup({
      deliver: (_id, text) => { delivered.push(text); return true },
    })
    await service.connect('acc-1')
    service.admit('acc-1')
    server.write('旧行\n')
    await waitUntil(() => delivered.some(t => t.includes('旧行')))
    server.killAll()
    await waitUntil(() => rt.connState === 'connected' && server.connCount >= 2)
    server.write('新行\n')
    await waitUntil(() => delivered.some(t => t.includes('新行')))
    await new Promise(r => setTimeout(r, 200)) // 等潜在重复投递窗口
    expect(delivered.filter(t => t.includes('旧行'))).toHaveLength(1)
    expect(delivered.filter(t => t.includes('新行'))).toHaveLength(1)
    await server.close()
  })

  it('⑧多会话互不串扰：acc-1 手工断连不重连，acc-2 意外断开自动重连', async () => {
    const server1 = await startServer()
    const server2 = await startServer()
    const accounts = new Map<string, AccountRecord>([
      ['acc-1', ACCOUNT],
      ['acc-2', { id: 'acc-2', name: 'mage', passRef: 'cred-1', serverId: 'acc-2', preset: 'mud-player', admitted: false }],
    ])
    const service = new MudService({
      serverLookup: (id: string) => {
        const acc = accounts.get(id)
        const port = id === 'acc-1' ? server1.port : server2.port
        return acc
          ? { workspaceId: acc.serverId, name: id, host: '127.0.0.1', port }
          : undefined
      },
      accountLookup: id => accounts.get(id),
      resolveCreds: async () => ({ name: 'hero', pass: 'pass' }),
      reconnect: { maxAttempts: 3, intervalMs: 50 },
    })
    const rt1 = service.register('acc-1', 'hero')
    const rt2 = service.register('acc-2', 'hero')
    await service.connect('acc-1')
    await service.connect('acc-2')
    service.disconnect('acc-1') // 手工：不重连
    server2.killAll() // 意外：自动重连
    await waitUntil(() => rt2.connState === 'connected' && server2.connCount >= 2)
    await new Promise(r => setTimeout(r, 150))
    expect(rt1.connState).toBe('disconnected')
    expect(server1.connCount).toBe(1)
    expect(rt2.connState).toBe('connected')
    expect(server2.connCount).toBe(2)
    await Promise.all([server1.close(), server2.close()])
  })
})
