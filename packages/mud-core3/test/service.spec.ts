/**
 * service + runtime 测试 — 两会话隔离 + 生命周期 + connect/disconnect。
 *
 * 用本地 mock telnet 服务器验证：
 *   - 两会话各自连接不同的 mock 服务器，互不串线
 *   - connect 只建连（盲发退役：不发 name/pass/空行；登录归 mud_workflow_run login）
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
import { stripIac } from './helpers.ts'

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
    // 收到即剥离 IAC（客户端建连的协商字节不算数据，盲发断言才干净）
    s.on('data', (d: Buffer) => received.push(stripIac(d)))
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
    resolveCreds: async (account: AccountRecord) => {
      const c = creds.get(account.passRef)
      if (c === undefined) throw new Error(`凭据 ${account.passRef} 解析失败`)
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

    // 等一段时间确认无数据到达（connect 只建连，盲发已退役）
    await new Promise(r => setTimeout(r, 100))

    // 盲发退役：connect 后服务端不收到任何凭据/数据
    expect(server1.received.join('')).toBe('')
    expect(server2.received.join('')).toBe('')

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

/** SessionStatus 测试构造（缺省补零值）。 */
function makeStatus(over: Partial<{
  sessionId: string
  state: 'disconnected' | 'connecting' | 'connected'
  admitted: boolean
  loggedIn: 'unknown' | 'in-game'
  world: Record<string, Record<string, { value: unknown; confidence: 'measured' | 'inferred'; source: { kind: 'gmcp' | 'system'; time: number } }>>
}> = {}): Parameters<typeof import('../src/service.ts')['statusRowOf']>[0] {
  return {
    sessionId: 's-1',
    state: 'connected',
    admitted: true,
    loggedIn: 'unknown',
    world: {},
    ...over,
  }
}

describe('statusRowOf 窄面（T11：SessionStatus → Remote 边界形态）', () => {
  it('扁平化：world 分区条目逐条展开，confidence/source 透传', async () => {
    const { statusRowOf } = await import('../src/service.ts')
    const s = makeStatus({
      world: {
        gmcp: {
          'room.info': { value: { name: '扬州城', area: 'sh' }, confidence: 'measured', source: { kind: 'gmcp', time: 111 } },
          'combat.fight': { value: false, confidence: 'measured', source: { kind: 'gmcp', time: 222 } },
        },
        session: { note: { value: 'x', confidence: 'inferred', source: { kind: 'system', time: 333 } } },
      },
    })
    const row = statusRowOf(s)
    expect(row.world).toEqual([
      { zone: 'gmcp', key: 'room.info', v: '{"name":"扬州城","area":"sh"}', c: 'measured', sk: 'gmcp', st: 111 },
      { zone: 'gmcp', key: 'combat.fight', v: 'false', c: 'measured', sk: 'gmcp', st: 222 },
      { zone: 'session', key: 'note', v: 'x', c: 'inferred', sk: 'system', st: 333 },
    ])
    // 其余轴透传
    expect(row).toMatchObject({ sessionId: s.sessionId, state: s.state, admitted: s.admitted, loggedIn: s.loggedIn })
  })

  it('序列化分型：字符串原样 / 数字布尔 String() / null 值 → "null"；空 world → 空数组', async () => {
    const { statusRowOf } = await import('../src/service.ts')
    const s = makeStatus({
      world: {
        gmcp: {
          a: { value: 'raw', confidence: 'measured', source: { kind: 'gmcp', time: 1 } },
          b: { value: 42, confidence: 'measured', source: { kind: 'gmcp', time: 2 } },
          c: { value: null, confidence: 'measured', source: { kind: 'gmcp', time: 3 } },
        },
      },
    })
    const row = statusRowOf(s)
    expect(row.world.map(e => e.v)).toEqual(['raw', '42', 'null'])
    expect(statusRowOf(makeStatus({ world: {} })).world).toEqual([])
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

  it('凭据解析失败 workflowEnvFor 抛错（connect 只建连，不再解析凭据）', async () => {
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
    await service.connect('a1') // 只建连，凭据解析已随盲发退役移出 connect
    await expect(service.workflowEnvFor('a1', 'workflow:login')).rejects.toThrow('凭据')
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

    // 录制缓冲尾部快照（拉取源语义：行不物理消费，投递按水位线拉取）
    const lines = rt!.recentLines(50)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.text.includes('欢迎'))).toBe(true)
    expect(rt!.seenAbs()).toBeGreaterThanOrEqual(lines.at(-1)!.abs - 1)

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

describe('MudService 接入闸门错误面', () => {
  /** 已装配投递器的服务（admit/stop 需要 deliverer 存在）。 */
  function serviceWithDeliverer(): MudService {
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'w1', preset: 'mud-player', admitted: false }],
    ])
    return new MudService({
      ...makeDeps(new Map(), accounts, new Map()),
      deliver: () => true,
      delivererConfig: { quietMs: 10 },
    })
  }

  it('未登记会话 admit/stop 抛错（不谎报接入成功）', () => {
    const service = serviceWithDeliverer()
    expect(() => service.admit('nope')).toThrow('未登记')
    expect(() => service.stop('nope')).toThrow('未登记')
  })

  it('登记后 admit/stop 反映真实接入状态', () => {
    const service = serviceWithDeliverer()
    service.register('a1')
    expect(service.status('a1').admitted).toBe(false)
    service.admit('a1')
    expect(service.status('a1').admitted).toBe(true)
    service.stop('a1')
    expect(service.status('a1').admitted).toBe(false)
  })

  it('onAdmit：admit 成功即触发一次（kickoff 任务书接线），stop 不触发', () => {
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'w1', preset: 'mud-player', admitted: false }],
    ])
    const kicked: string[] = []
    const service = new MudService({
      ...makeDeps(new Map(), accounts, new Map()),
      deliver: () => true,
      onAdmit: id => { kicked.push(id) },
    })
    service.register('a1')
    service.admit('a1')
    expect(kicked).toEqual(['a1'])
    service.stop('a1')
    expect(kicked).toEqual(['a1'])
    // 未登记 admit 抛错时不应触发（fail-loud 先于回调）。
    expect(() => service.admit('nope')).toThrow('未登记')
    expect(kicked).toEqual(['a1'])
  })

  it('flushPending：未登记会话是空操作，已登记会话不抛错', () => {
    const service = serviceWithDeliverer()
    expect(() => service.flushPending('nope')).not.toThrow()
    service.register('a1')
    expect(() => service.flushPending('a1')).not.toThrow()
  })
})

describe('MudService watchStatus 状态流', () => {
  /** 已装配投递器的服务（admit/stop 可用）。 */
  function seededService(): MudService {
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'w1', preset: 'mud-player', admitted: false }],
    ])
    return new MudService({
      ...makeDeps(new Map(), accounts, new Map()),
      deliver: () => true,
      delivererConfig: { quietMs: 10 },
    })
  }

  it('首帧快照；登记/admit/stop/dispose 各推一帧；abort 后流结束', async () => {
    const service = seededService()
    const controller = new AbortController()
    const iter = service.watchStatusStream(controller.signal)[Symbol.asyncIterator]()

    // 首帧：订阅即得全量快照（此刻尚无会话 → 空面）
    const first = await iter.next()
    expect(first.done).toBeFalsy()
    expect(first.value.sessions).toEqual([])

    service.register('a1')
    const registered = await iter.next()
    expect(registered.value.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['a1'])
    expect(registered.value.sessions[0]!.state).toBe('disconnected')

    service.admit('a1')
    const admitted = await iter.next()
    expect(admitted.value.sessions[0]!.admitted).toBe(true)

    service.stop('a1')
    const stopped = await iter.next()
    expect(stopped.value.sessions[0]!.admitted).toBe(false)

    service.dispose('a1')
    const disposed = await iter.next()
    expect(disposed.value.sessions).toEqual([])

    controller.abort()
    const after = await iter.next()
    expect(after.done).toBe(true)
  })

  it('connect/disconnect 经 runtime 状态迁移推帧', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['w1', { workspaceId: 'w1', name: 'S1', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([
      ['a1', { id: 'a1', name: 'u1', passRef: 'c1', serverId: 'w1', preset: 'mud-player', admitted: false }],
    ])
    const creds = new Map<string, ResolvedCredentials>([['c1', { name: 'u1', pass: 'p1' }]])
    const service = new MudService(makeDeps(servers, accounts, creds))
    service.register('a1')

    const controller = new AbortController()
    const iter = service.watchStatusStream(controller.signal)[Symbol.asyncIterator]()
    await iter.next() // 首帧快照（a1 disconnected）

    await service.connect('a1')
    // 消费 connecting 帧，直到看到 connected
    for (;;) {
      const f = await iter.next()
      if (f.done) throw new Error('流意外结束')
      const row = f.value.sessions.find(s => s.sessionId === 'a1')
      if (row?.state === 'connected') break
    }

    service.disconnect('a1')
    const f2 = await iter.next()
    const row2 = f2.value?.sessions.find((s: { sessionId: string }) => s.sessionId === 'a1')
    expect(row2?.state).toBe('disconnected')

    controller.abort()
    await server.close()
  })

  it('多订阅者互不影响：注销一个，另一个继续收帧', () => {
    const service = seededService()
    const framesA: number[] = []
    const framesB: number[] = []
    const unsubscribeA = service.subscribeStatus(() => { framesA.push(1) })
    service.subscribeStatus(() => { framesB.push(1) })

    service.register('a1')
    expect(framesA.length).toBeGreaterThan(0)
    expect(framesB.length).toBe(framesA.length)

    unsubscribeA()
    service.admit('a1')
    expect(framesA.length).toBe(framesB.length - 1) // A 已注销不再收
    expect(framesB.length).toBeGreaterThan(0)

    service.disposeAll()
  })
})

describe('MudService 连接失败可诊断', () => {
  const account = (over: Partial<AccountRecord> = {}): AccountRecord => ({
    id: 'a1', name: 'u1', passRef: 'MUD_REF', serverId: 'ws-1', preset: 'mud-player', admitted: false, ...over,
  })

  it('未登记会话：logOf 返回 null（没有日志就没有可读窗口）', () => {
    const service = new MudService(makeDeps(new Map(), new Map(), new Map()))
    expect(service.logOf('nope')).toBeNull()
  })

  it('未绑定服务器：错误写进日志且带原因', async () => {
    const accounts = new Map<string, AccountRecord>([['a1', account({ serverId: 'ws-missing' })]])
    const service = new MudService({ ...makeDeps(new Map(), accounts, new Map()), log: { bufferMax: 50 } })
    service.register('a1')

    await expect(service.connect('a1')).rejects.toThrow('未绑定服务器')
    const entries = service.logOf('a1')!.entries
    expect(entries.some(e => e.level === 'error' && e.text.includes('未绑定服务器'))).toBe(true)
  })

  it('凭据解析失败：错误面与日志都带引用名（workflowEnvFor 路径）', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([['a1', account({ passRef: 'MUD_MISSING' })]])
    const service = new MudService({ ...makeDeps(servers, accounts, new Map()), log: { bufferMax: 50 } })
    service.register('a1')
    await service.connect('a1') // 只建连；凭据解析归 workflowEnvFor

    await expect(service.workflowEnvFor('a1', 'workflow:login')).rejects.toThrow('MUD_MISSING')
    const entries = service.logOf('a1')!.entries
    expect(entries.some(e => e.level === 'error' && e.text.includes('MUD_MISSING'))).toBe(true)
    await server.close()
  })

  it('端口不可达：日志记下 host:port 与失败原因', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([['a1', account()]])
    const creds = new Map<string, ResolvedCredentials>([['MUD_REF', { name: 'u1', pass: 'p1' }]])
    await server.close() // 关掉服务端：该端口不再监听

    const service = new MudService({ ...makeDeps(servers, accounts, creds), log: { bufferMax: 50 } })
    service.register('a1')
    await expect(service.connect('a1')).rejects.toThrow('失败')

    const text = service.logOf('a1')!.entries.map(e => e.text).join('\n')
    expect(text).toContain(`127.0.0.1:${server.port}`)
    expect(text).toContain('失败')
  })

  it('成功连接：日志含 host:port 与「connect 只建连」，凭据明文不进日志', async () => {
    const server = await startMockServer()
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port: server.port }],
    ])
    const accounts = new Map<string, AccountRecord>([['a1', account()]])
    const creds = new Map<string, ResolvedCredentials>([['MUD_REF', { name: 'u1', pass: 'secret-pw' }]])
    const service = new MudService({ ...makeDeps(servers, accounts, creds), log: { bufferMax: 50 } })
    service.register('a1')

    await service.connect('a1')
    const text = service.logOf('a1')!.entries.map(e => e.text).join('\n')
    expect(text).toContain(`127.0.0.1:${server.port}`)
    expect(text).toContain('只建连')
    expect(text).not.toContain('secret-pw') // 明文不进日志（凭据解析已移出 connect）

    await service.disposeAll()
    await server.close()
  })
})
