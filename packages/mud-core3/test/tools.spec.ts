/**
 * tools 测试 — 工具面（T2b）：拒绝序 + 持有者 + 归属父链上溯 + 端到端。
 *
 * 分两层：
 *   - 纯单元（stub runtime / stub handle）：deny 全段扫描、拒绝序、listen 编译、
 *     timeout 钳制、裸读/有 cmd 的缺省判据与 initial、持有者冲突；
 *   - 集成（真实 TCP + 真实 MudService + parentLookup）：mud_connect 幂等不重连、
 *     mud_send 端到端、并发 send 可读拒绝不劈半、mud_state 合并快照、
 *     子会话经父链解析到账号 runtime。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  registerMudTools, denyMatch, commandTokens, compileListen,
  CORE_ABSENT_ERROR, NOT_BOUND_ERROR, NOT_CONNECTED_ERROR, HOLDER_BUSY_ERROR,
  MAX_TIMEOUT_MS,
  type MudToolDefinition, type ToolRegistrar, type MudCore3Handle,
} from '../src/tools.ts'
import type { SessionRuntime } from '../src/runtime.ts'
import type { ReadOpts, ReadResult } from '../src/read.ts'
import { MudService } from '../src/service.ts'
import type {
  AccountRecord, ResolvedCredentials, ServerRecord,
} from '../src/roster.ts'
import type { MudLine } from '../src/link/line.ts'

// ── 纯单元：禁发表 / listen 编译 ─────────────────────────────────────

describe('denyMatch 全段扫描（§12.3 最小集）', () => {
  it('suicide 命中（大小写不敏感）', () => {
    expect(denyMatch('suicide')).toBe('suicide')
    expect(denyMatch('SUICIDE')).toBe('suicide')
    expect(denyMatch('  suicide  ')).toBe('suicide')
  })

  it('全段扫描：组合命令中任一 token 命中即拒（堵 look;suicide 绕过洞）', () => {
    expect(denyMatch('look;suicide')).toBe('suicide')
    expect(denyMatch('look ; suicide')).toBe('suicide')
    expect(denyMatch('save\nsuicide')).toBe('suicide')
  })

  it('最小集：quit/drop/passwd 等放行（不设拦截）', () => {
    expect(denyMatch('quit')).toBeNull()
    expect(denyMatch('drop all')).toBeNull()
    expect(denyMatch('passwd')).toBeNull()
    expect(denyMatch('look')).toBeNull()
  })

  it('commandTokens：按空白/分号切分，过滤空段', () => {
    expect(commandTokens('look;  get all')).toEqual(['look', 'get', 'all'])
    expect(commandTokens('')).toEqual([])
  })
})

describe('compileListen', () => {
  it('全空 = 空对象（调用方按有/无 cmd 填缺省判据）', () => {
    expect(compileListen(undefined)).toEqual({})
    expect(compileListen({})).toEqual({})
  })

  it('字符串正则编译为 RegExp；非法正则 throw 可读错', () => {
    const out = compileListen({ until: ['你好'], gaCount: 2 })
    expect(out.until).toHaveLength(1)
    expect(out.until![0]!.test('你好呀')).toBe(true)
    expect(out.gaCount).toBe(2)
    expect(() => compileListen({ until: ['([bad'] })).toThrow(/listen\.until 正则非法/)
  })
})

// ── 纯单元：mud_send 执行序（stub runtime + stub handle）─────────────

/** 可编程 stub runtime（只实现工具消费的面）。 */
function stubRuntime(overrides: Partial<Record<string, unknown>> = {}): SessionRuntime {
  return {
    connState: 'connected',
    acquireSend: () => true,
    releaseSend: () => {},
    send: () => true,
    recentLines: () => [],
    read: async () => ({ lines: [], reason: 'quiet' }),
    ...overrides,
  } as unknown as SessionRuntime
}

interface CapturedRead { opts: ReadOpts; initial: readonly MudLine[] }

/**
 * 组装：注册三工具 + 可编程 handle。
 * runtimeOverrides 未给 read 时，自动接入 read 捕获（captured.opts/initial）。
 */
function setup(handleOverrides: Partial<MudCore3Handle> = {}, runtimeOverrides: Partial<Record<string, unknown>> = {}) {
  const captured: CapturedRead = { opts: {} as ReadOpts, initial: [] }
  const rt = stubRuntime({
    ...(Object.prototype.hasOwnProperty.call(runtimeOverrides, 'read')
      ? {}
      : {
          read: async (opts: ReadOpts, initial: readonly MudLine[]) => {
            captured.opts = opts
            captured.initial = initial
            return { lines: [...initial], reason: 'quiet' } satisfies ReadResult
          },
        }),
    ...runtimeOverrides,
  })
  const handle: MudCore3Handle = {
    toolContextFor: () => ({ sessionId: 'acc-1', runtime: rt }),
    connect: async () => ({ state: 'connected' }),
    workflowIoFor: async () => { throw new Error('测试未预期调用 workflowIoFor') },
    stateOf: () => ({
      connState: 'connected', loggedIn: 'unknown', admitted: false, world: {}, recording: 0, dropped: 0,
    }),
    defaults: { sendTimeoutMs: 15000, sendMaxLines: 50 },
    ...handleOverrides,
  }
  const defs = new Map<string, MudToolDefinition>()
  const registrar: ToolRegistrar = {
    register: def => {
      defs.set(def.name, def)
      return () => {}
    },
  }
  registerMudTools(registrar, { core: () => handle })
  const call = (name: string, args: unknown, agentId = 'acc-1') =>
    defs.get(name)!.execute(args, { signal: new AbortController().signal, agent: { id: agentId } })
  const readCapture = (): CapturedRead => captured
  return { defs, call, readCapture, rt }
}

describe('mud_send 拒绝序（stub）', () => {
  it('注册完整性：三工具全部过 registrar', () => {
    const { defs } = setup()
    expect([...defs.keys()].sort()).toEqual(['mud_connect', 'mud_send', 'mud_state'])
  })

  it('引擎缺席：三工具都给可读拒绝（注册照常）', async () => {
    const defs = new Map<string, MudToolDefinition>()
    registerMudTools({ register: def => { defs.set(def.name, def); return () => {} } }, { core: () => null })
    for (const name of ['mud_connect', 'mud_send', 'mud_state']) {
      const r = await defs.get(name)!.execute({}, { signal: new AbortController().signal, agent: { id: 'x' } })
      expect(r).toEqual({ ok: false, error: CORE_ABSENT_ERROR })
    }
  })

  it('归属 null：可读拒绝「未绑定 MUD 账号」', async () => {
    const { call } = setup({ toolContextFor: () => null })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({ ok: false, error: NOT_BOUND_ERROR })
    await expect(call('mud_state', {})).resolves.toEqual({ ok: false, error: NOT_BOUND_ERROR })
  })

  it('禁发表先于连接闸门：未连接时发 suicide 也拒禁词而非未连接', async () => {
    const { call } = setup({}, { connState: 'disconnected' })
    await expect(call('mud_send', { cmd: 'suicide' })).resolves.toMatchObject({
      ok: false, error: /危险命令（suicide）被禁/,
    })
  })

  it('全段扫描进工具：look;suicide 拒绝带命中词', async () => {
    const { call } = setup()
    await expect(call('mud_send', { cmd: 'look;suicide' })).resolves.toMatchObject({
      ok: false, error: /（suicide）/,
    })
  })

  it('未连接：可读拒绝（最小集命令 quit 放行 deny 后命中连接闸门）', async () => {
    const { call } = setup({}, { connState: 'disconnected' })
    await expect(call('mud_send', { cmd: 'quit' })).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
    await expect(call('mud_send', {})).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
  })

  it('timeoutMs 非正整数拒绝；超上限钳制到 MAX_TIMEOUT_MS', async () => {
    const { call, readCapture } = setup()
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 0 })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_send', { cmd: 'look', timeoutMs: -5 })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1.5 })).resolves.toMatchObject({ ok: false })
    await call('mud_send', { cmd: 'look', timeoutMs: 999_999 })
    expect(readCapture().opts.timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it('持有者冲突：acquireSend 失败 → 可读拒绝，不 send 不 read', async () => {
    const sent: string[] = []
    const { call } = setup({}, {
      acquireSend: () => false,
      send: (cmd: string) => { sent.push(cmd); return true },
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({ ok: false, error: HOLDER_BUSY_ERROR })
    expect(sent).toEqual([])
  })

  it('send 失败（连接已断）：可读拒绝并释放持有者', async () => {
    let released = false
    const { call } = setup({}, {
      send: () => false,
      releaseSend: () => { released = true },
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toMatchObject({ ok: false, error: /发送失败/ })
    expect(released).toBe(true)
  })

  it('非法 listen 正则：可读拒绝', async () => {
    const { call } = setup()
    await expect(call('mud_send', { cmd: 'look', listen: { until: ['([bad'] } }))
      .resolves.toMatchObject({ ok: false, error: /正则非法/ })
  })
})

describe('mud_send 判据与 initial（stub）', () => {
  it('有 cmd：send 后 read，initial 为空，缺省判据 gaCount:1 + maxLines 兜底', async () => {
    const sent: string[] = []
    const { call, readCapture } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    const r = await call('mud_send', { cmd: 'look' })
    expect(r).toMatchObject({ ok: true, reason: 'quiet' })
    expect(sent).toEqual(['look'])
    expect(readCapture().initial).toEqual([])
    expect(readCapture().opts.gaCount).toBe(1)
    expect(readCapture().opts.maxLines).toBe(50)
    expect(readCapture().opts.timeoutMs).toBe(15000)
  })

  it('裸读：不 send，initial = recentLines(sendMaxLines)，缺省判据 maxLines + quietMs:300', async () => {
    const sent: string[] = []
    const snapshot: MudLine[] = [
      { text: '旧行1', raw: '旧行1', style: [], abs: 1, time: 0, isPrompt: false, kind: null },
      { text: '旧行2', raw: '旧行2', style: [], abs: 2, time: 0, isPrompt: false, kind: null },
    ]
    const { call, readCapture } = setup({}, {
      send: (cmd: string) => { sent.push(cmd); return true },
      recentLines: (n: number) => (n === 50 ? snapshot : []),
    })
    await call('mud_send', {})
    expect(sent).toEqual([])
    expect(readCapture().initial).toEqual(snapshot)
    expect(readCapture().opts.maxLines).toBe(50)
    expect(readCapture().opts.quietMs).toBe(300)
    expect(readCapture().opts.gaCount).toBeUndefined()
  })

  it('模型显式 listen 整体覆盖缺省判据', async () => {
    const { call, readCapture } = setup()
    await call('mud_send', { cmd: 'look', listen: { until: [' done'], quietMs: 25 } })
    expect(readCapture().opts.until).toHaveLength(1)
    expect(readCapture().opts.quietMs).toBe(25)
    expect(readCapture().opts.gaCount).toBeUndefined()
  })

  it('read 返回行原文（MudLine.text 映射）；结束后释放持有者', async () => {
    let released = false
    const { call } = setup({}, {
      releaseSend: () => { released = true },
      read: async () => ({
        lines: [
          { text: '应答行', raw: '', style: [], abs: 9, time: 0, isPrompt: false, kind: null },
        ],
        reason: 'done',
      }),
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({
      ok: true, reason: 'done', lines: ['应答行'],
    })
    expect(released).toBe(true)
  })
})

// ── 集成：真实 TCP + 真实 MudService + parentLookup ──────────────────

interface MockServer {
  port: number
  close(): Promise<void>
  /** 收到的所有数据。 */
  received: string[]
  /** 已建立的连接数（幂等断言用）。 */
  connections: () => number
  /** 向所有活跃连接写行 + GA。 */
  writeLines(lines: string[]): void
}

async function startMockServer(): Promise<MockServer> {
  const received: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('data', (d: Buffer) => {
      received.push(d.toString('utf8'))
      // 收到任何命令 → 回两行应答 + GA
      s.write('你看到这里的东西\n')
      s.write('这里的出口是显然的\n')
      s.write(Buffer.from([255, 249])) // IAC GA
    })
    s.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    connections: () => sockets.size,
    writeLines(lines: string[]) {
      for (const s of sockets) {
        for (const l of lines) s.write(`${l}\n`)
        s.write(Buffer.from([255, 249]))
      }
    },
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

/** 集成装配：MudService + 父链表 + 引擎窄面（镜像 index.ts provide 面）。 */
async function setupIntegration() {
  const server = await startMockServer()
  const servers = new Map<string, ServerRecord>([
    ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
  ])
  const accounts = new Map<string, AccountRecord>([
    ['acc-1', { id: 'acc-1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
  ])
  const creds = new Map<string, ResolvedCredentials>([
    ['c1', { name: 'u1', pass: 'p1' }],
  ])
  const parents = new Map<string, string>([['sub-1', 'acc-1']])
  const service = new MudService({
    serverLookup: id => {
      const acc = accounts.get(id)
      return acc ? servers.get(acc.serverId) : undefined
    },
    accountLookup: id => accounts.get(id),
    resolveCreds: async account => {
      const c = creds.get(account.passRef)
      if (c === undefined) throw new Error(`凭据 ${account.passRef} 解析失败`)
      return c
    },
    parentLookup: id => parents.get(id),
  })
  service.register('acc-1')

  // 引擎窄面（镜像 index.ts provide 面）
  const handle: MudCore3Handle = {
    toolContextFor: agent => service.toolContextFor(String(agent?.id ?? '')),
    connect: async sessionId => {
      const r = await service.connect(sessionId)
      return { state: r.state }
    },
    workflowIoFor: (sessionId, holder) => service.workflowIoFor(sessionId, holder),
    stateOf: sessionId => {
      const s = service.status(sessionId)
      const rt = service.get(sessionId)
      return {
        connState: s.state, loggedIn: s.loggedIn, admitted: s.admitted, world: s.world,
        recording: rt?.pendingLineCount ?? 0, dropped: rt?.droppedLineCount ?? 0,
      }
    },
    defaults: { sendTimeoutMs: 15000, sendMaxLines: 50 },
  }
  const defs = new Map<string, MudToolDefinition>()
  registerMudTools({ register: def => { defs.set(def.name, def); return () => {} } }, { core: () => handle })
  const call = (name: string, args: unknown, agentId?: string) =>
    defs.get(name)!.execute(args, {
      signal: new AbortController().signal,
      ...(agentId !== undefined ? { agent: { id: agentId } } : {}),
    })
  return { server, service, call, handle }
}

describe('工具面集成（真实 TCP）', () => {
  it('mud_connect：建连成功；幂等重连不建第二条连接', async () => {
    const { server, call } = await setupIntegration()
    await expect(call('mud_connect', {}, 'acc-1')).resolves.toEqual({ ok: true, state: 'connected' })
    expect(server.connections()).toBe(1)

    await expect(call('mud_connect', {}, 'acc-1')).resolves.toEqual({ ok: true, state: 'connected' })
    // 等 socket 集合稳定
    await new Promise(r => setTimeout(r, 100))
    expect(server.connections()).toBe(1)

    await server.close()
  })

  it('mud_send：发命令收应答原文（端到端）', async () => {
    const { server, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 3000 }, 'acc-1')).resolves.toMatchObject({
      ok: true,
      lines: ['你看到这里的东西', '这里的出口是显然的'],
    })
    expect(server.received.join('')).toContain('look')
    await server.close()
  })

  it('并发 send：第二个执行体可读拒绝（不劈半），第一个完整收束', async () => {
    const { server, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')

    // 执行体 A：until 永不命中 + 短超时（占住持有者直到超时）
    const first = call('mud_send', {
      cmd: 'longwait', listen: { until: ['永不会出现'] }, timeoutMs: 400,
    }, 'acc-1')
    // 执行体 B（子会话，holder = sub-1 ≠ acc-1）：立即尝试 → 撞持有者
    await new Promise(r => setTimeout(r, 50))
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1000 }, 'sub-1'))
      .resolves.toEqual({ ok: false, error: HOLDER_BUSY_ERROR })

    // A 完整收束（应答不劈半：B 未中途读走行）
    await expect(first).resolves.toMatchObject({ ok: true })
    // A 释放后 B 可再发
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1000 }, 'sub-1')).resolves.toMatchObject({ ok: true })
    await server.close()
  })

  it('归属父链上溯：根命中自身；子会话沿父链解析到账号 runtime；无关会话拒', async () => {
    const { server, handle, service, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')

    // 根命中自身
    expect(handle.toolContextFor({ id: 'acc-1' })?.sessionId).toBe('acc-1')
    // 子会话（root 直接派发）沿父链命中
    expect(handle.toolContextFor({ id: 'sub-1' })?.sessionId).toBe('acc-1')
    // 子会话 mud_send 端到端（应答作为调用方的工具结果）
    await expect(call('mud_send', { cmd: 'who', timeoutMs: 3000 }, 'sub-1')).resolves.toMatchObject({ ok: true })
    // 无关会话 → null
    expect(handle.toolContextFor({ id: 'stranger' })).toBeNull()
    // 环不悬挂：parentLookup 成环时上溯护栏返回 null
    const cyclic = new MudService({
      serverLookup: () => undefined,
      accountLookup: () => undefined,
      resolveCreds: async () => ({ name: 'x', pass: 'y' }),
      parentLookup: id => (id === 'a' ? 'b' : 'a'),
    })
    cyclic.register('a')
    expect(cyclic.toolContextFor('a')).toBeNull()

    await server.close()
    void service
  })

  it('mud_state：未连接也可读（插件状态 + world 合并），连接后翻转', async () => {
    const { server, call } = await setupIntegration()
    // 未连接：mud_send 拒，mud_state 可读
    await expect(call('mud_send', { cmd: 'look' }, 'acc-1')).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
    const before = await call('mud_state', {}, 'acc-1') as { ok: boolean; state: Record<string, unknown> }
    expect(before.ok).toBe(true)
    expect(before.state.connState).toBe('disconnected')

    await call('mud_connect', {}, 'acc-1')
    const after = await call('mud_state', {}, 'acc-1') as { ok: boolean; state: Record<string, unknown> }
    expect(after.state.connState).toBe('connected')
    await server.close()
  })
})
