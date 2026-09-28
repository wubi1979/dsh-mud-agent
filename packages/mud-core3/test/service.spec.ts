/**
 * service + runtime 测试 — 两会话隔离 + 生命周期 + connect/disconnect。
 *
 * 用本地 mock telnet 服务器验证：
 *   - 两会话各自连接不同的 mock 服务器，互不串线
 *   - connect 建连 + login（发 name/pass）
 *   - disconnect 断连
 *   - dispose（session/disposed 模拟）断连 + 拆 runtime
 *   - 未登记会话 connect 抛错
 *   - 未绑定服务器 connect 抛错
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { MudService } from '../src/service.ts'
import type {
  AccountRecord, ServerRecord, ResolvedCredentials,
} from '../src/roster.ts'

// ── mock telnet 服务器 ────────────────────────────────────────────

interface MockServer {
  port: number
  close(): Promise<void>
  /** 收到的所有数据（按连接区分）。 */
  received: string[]
}

async function startMockServer(): Promise<MockServer> {
  const received: string[] = []
  let sock: net.Socket | null = null
  const server = net.createServer((s) => {
    sock = s
    s.on('data', (d: Buffer) => received.push(d.toString('utf8')))
    // 发送欢迎横幅 + GA（让客户端连上后有行可读）
    s.write('欢迎来到北大侠客行\n')
    s.write(Buffer.from([255, 249])) // IAC GA
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    received,
    close() {
      sock?.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

// ── 内存 roster + 凭据 ─────────────────────────────────────────────

function makeDeps(servers: Map<string, ServerRecord>, accounts: Map<string, AccountRecord>, creds: Map<string, ResolvedCredentials>) {
  return {
    serverLookup: (sessionId: string) => {
      const acc = accounts.get(sessionId)
      return acc ? servers.get(acc.serverId) : undefined
    },
    accountLookup: (sessionId: string) => accounts.get(sessionId),
    resolveCreds: async (passRef: string) => {
      const c = creds.get(passRef)
      if (c === undefined) throw new Error(`凭据 ${passRef} 解析失败`)
      return c
    },
  }
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('MudService 两会话隔离', () => {
  it('两会话各连各的服务器，互不串线', async () => {
    const server1 = await startMockServer()
    const server2 = await startMockServer()

    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: '北大侠客行', host: '127.0.0.1', port: server1.port }],
      ['ws-2', { workspaceId: 'ws-2', name: '另一个MUD', host: '127.0.0.1', port: server2.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['acc-1', { id: 'acc-1', name: 'hero', passRef: 'cred-1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
      ['acc-2', { id: 'acc-2', name: 'mage', passRef: 'cred-2', serverId: 'ws-2', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['cred-1', { name: 'hero', pass: 'pass1' }],
      ['cred-2', { name: 'mage', pass: 'pass2' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('acc-1')
    service.register('acc-2')

    // 两会话同时 connect
    const [r1, r2] = await Promise.all([
      service.connect('acc-1'),
      service.connect('acc-2'),
    ])

    expect(r1.state).toBe('connected')
    expect(r2.state).toBe('connected')
    expect(service.size).toBe(2)

    // 等数据到达 mock server（sendCredential 是同步 write，但 server 端 data 事件异步）
    await new Promise(r => setTimeout(r, 100))

    // 各自收到自己的 login 凭据
    expect(server1.received.join('')).toContain('hero')
    expect(server1.received.join('')).toContain('pass1')
    expect(server2.received.join('')).toContain('mage')
    expect(server2.received.join('')).toContain('pass2')

    // 不串线：server1 没收到 mage
    expect(server1.received.join('')).not.toContain('mage')
    expect(server2.received.join('')).not.toContain('hero')

    await service.disposeAll()
    await server1.close()
    await server2.close()
  })

  it('状态隔离：disconnect 一个不影响另一个', async () => {
    const server1 = await startMockServer()
    const server2 = await startMockServer()

    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server1.port }],
      ['ws-2', { workspaceId: 'ws-2', name: 'S2', host: '127.0.0.1', port: server2.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
      ['a2', { id: 'a2', name: 'u2', passRef: 'c2', serverId: 'ws-2', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
      ['c2', { name: 'u2', pass: 'p2' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    service.register('a2')
    await service.connect('a1')
    await service.connect('a2')

    expect(service.status('a1').state).toBe('connected')
    expect(service.status('a2').state).toBe('connected')

    // 断 a1，a2 不受影响
    service.disconnect('a1')
    expect(service.status('a1').state).toBe('disconnected')
    expect(service.status('a2').state).toBe('connected')

    await service.disposeAll()
    await server1.close()
    await server2.close()
  })
})

describe('MudService 生命周期', () => {
  it('dispose（session/disposed 模拟）：断连 + 拆 runtime', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    await service.connect('a1')
    expect(service.status('a1').state).toBe('connected')

    // 模拟 session/disposed
    service.dispose('a1')
    expect(service.status('a1').state).toBe('disconnected')
    expect(service.size).toBe(0)
    expect(service.get('a1')).toBeNull()

    await server.close()
  })

  it('disposeAll：全部断连 + 清空', async () => {
    const s1 = await startMockServer()
    const s2 = await startMockServer()

    const servers = new Map<string, ServerRecord>([
      ['w1', { workspaceId: 'w1', name: 'S1', host: '127.0.0.1', port: s1.port }],
      ['w2', { workspaceId: 'w2', name: 'S2', host: '127.0.0.1', port: s2.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'w1', preset: 'mud-player', admitted: false }],
      ['a2', { id: 'a2', name: 'u2', passRef: 'c2', serverId: 'w2', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
      ['c2', { name: 'u2', pass: 'p2' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    service.register('a2')
    await service.connect('a1')
    await service.connect('a2')

    service.disposeAll()
    expect(service.size).toBe(0)
    expect(service.status('a1').state).toBe('disconnected')
    expect(service.status('a2').state).toBe('disconnected')

    await s1.close()
    await s2.close()
  })
})

describe('MudService 错误路径', () => {
  it('未登记会话 connect 抛错', async () => {
    const service = new MudService(makeDeps(new Map(), new Map(), new Map()))
    await expect(service.connect('unknown')).rejects.toThrow('未登记')
  })

  it('未绑定服务器 connect 抛错', async () => {
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-x', preset: 'mud-player', admitted: false }],
    ])
    const service = new MudService(makeDeps(new Map(), accounts, new Map()))
    service.register('a1')
    await expect(service.connect('a1')).rejects.toThrow('未绑定服务器')
  })

  it('凭据解析失败 connect 抛错', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'bad-cred', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>() // 空：bad-cred 解析必失败

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    await expect(service.connect('a1')).rejects.toThrow('凭据')
    await server.close()
  })

  it('connect 幂等：已连接再 connect 不重连', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    await service.connect('a1')
    const receivedAfterFirst = server.received.length

    // 再次 connect（幂等，不应重连/重发 login）
    await service.connect('a1')
    expect(server.received.length).toBe(receivedAfterFirst)

    await service.disposeAll()
    await server.close()
  })
})

describe('SessionRuntime 行流积累', () => {
  it('connect 后行流到达即积累到 pendingLines', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    await service.connect('a1')

    // 等待欢迎横幅到达
    await new Promise(r => setTimeout(r, 200))

    const rt = service.get('a1')
    expect(rt).not.toBeNull()
    expect(rt!.pendingLineCount).toBeGreaterThan(0)

    const lines = rt!.consumePendingLines()
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.text.includes('欢迎'))).toBe(true)
    expect(rt!.pendingLineCount).toBe(0) // 消费后清空

    await service.disposeAll()
    await server.close()
  })

  it('断线后 onDisconnect 触发 + 状态变 disconnected', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([
      ['c1', { name: 'u1', pass: 'p1' }],
    ])

    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')
    await service.connect('a1')
    expect(service.status('a1').state).toBe('connected')

    // 模拟意外断线：服务器关闭连接
    let disconnected = false
    service.get('a1')!.onDisconnect = () => { disconnected = true }
    await server.close() // 关服务器 → 客户端收到 close

    await new Promise(r => setTimeout(r, 200))
    expect(disconnected).toBe(true)
    expect(service.status('a1').state).toBe('disconnected')

    await service.disposeAll()
  })
})
