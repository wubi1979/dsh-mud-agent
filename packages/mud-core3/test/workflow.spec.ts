/**
 * workflowIoFor 契约测试（mud-workflow 解释器消费的 core3 服务缝）：
 *   - 未登记/未连接/未在 roster/凭据解析失败/持有者冲突 → 可读错；
 *   - 成功路径：env 原语可用（send 直达服务端 / state 快照）+ creds 注入；
 *   - release 释放持有者（释放后其他 holder 可再取）；日志零泄露（pass 不入日志）。
 *
 * login 流程 E2E 已随流程面平移至 mud-workflow（test/login.spec.ts）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { MudService } from '../src/service.ts'
import type { AccountRecord, ServerRecord } from '../src/roster.ts'
import { stripIac } from './helpers.ts'

const NAME = 'hero'
const PASS = 'SECRET-PW'
const CREDS = new Map([['c1', { name: NAME, pass: PASS }]])

/** 最简 mock 服务端：只录收到的行（IAC 已剥离），不应答（本文件不测 read 语义）。 */
async function startMockServer(): Promise<{
  port: number
  received: string[]
  close(): Promise<void>
}> {
  const received: string[] = []
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.on('error', () => {})
    sock.on('data', (d: Buffer) => {
      for (const line of stripIac(d).split(/\r?\n/)) {
        if (line.trim() !== '') received.push(line)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    received,
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

/** 组装已登记 + 已连接的 service（凭据表可覆盖）。 */
async function setup(creds: Map<string, { name: string; pass: string }> = CREDS) {
  const server = await startMockServer()
  const servers = new Map<string, ServerRecord>([
    ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port: server.port }],
  ])
  const accounts = new Map<string, AccountRecord>([
    ['a1', { id: 'a1', name: NAME, passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
  ])
  const service = new MudService({
    serverLookup: id => servers.get(accounts.get(id)?.serverId ?? ''),
    accountLookup: id => accounts.get(id),
    resolveCreds: async account => {
      const c = creds.get(account.passRef)
      if (c === undefined) throw new Error(`凭据 ${account.passRef} 解析失败`)
      return c
    },
    log: { bufferMax: 50 },
  })
  service.register('a1')
  await service.connect('a1')
  return { server, service }
}

describe('workflowIoFor 契约', () => {
  it('未登记：可读错（宿主不认识该会话）', async () => {
    const { service, server } = await setup()
    await expect(service.workflowIoFor('ghost', 'workflow:login'))
      .rejects.toThrow('未登记')
    await service.disposeAll()
    await server.close()
  })

  it('未连接：可读错（指引 mud_connect）', async () => {
    const { service, server } = await setup()
    service.register('a2')
    await expect(service.workflowIoFor('a2', 'workflow:login'))
      .rejects.toThrow('未连接')
    await service.disposeAll()
    await server.close()
  })

  it('凭据解析失败：错误带引用名；日志带引用名且 pass 明文零泄露', async () => {
    const { service, server } = await setup(new Map()) // 空：c1 解析必失败
    await expect(service.workflowIoFor('a1', 'workflow:login'))
      .rejects.toThrow('凭据')
    const logText = service.logOf('a1')!.entries.map(e => e.text).join('\n')
    expect(logText).toContain('c1')
    expect(logText).not.toContain(PASS)
    await service.disposeAll()
    await server.close()
  })

  it('持有者冲突：流程独占期间再取可读错；release 后可再取', async () => {
    const { service, server } = await setup()
    const first = await service.workflowIoFor('a1', 'workflow:login')
    await expect(service.workflowIoFor('a1', 'mud_send'))
      .rejects.toThrow('会话级独占')
    first.release()
    // release 后其他 holder 可再取；同 holder 重入放行由 runtime 语义保证
    const second = await service.workflowIoFor('a1', 'mud_send')
    expect(second.creds.pass).toBe(PASS)
    second.release()
    await service.disposeAll()
    await server.close()
  })

  it('成功路径：creds 注入；io.send 直达服务端；io.state 快照；日志零泄露', async () => {
    const { service, server } = await setup()
    const handle = await service.workflowIoFor('a1', 'workflow:login')
    expect(handle.creds).toEqual({ name: NAME, pass: PASS })
    expect(handle.io.state().state).toBe('connected')
    expect(handle.io.send('look')).toBe(true)
    await new Promise(r => setTimeout(r, 50)) // socket 写 → 服务端落地
    expect(server.received).toEqual(['look'])
    handle.release()
    // 日志零泄露：就绪/释放行均无 pass 明文
    const logText = service.logOf('a1')!.entries.map(e => e.text).join('\n')
    expect(logText).toContain('流程 IO 就绪')
    expect(logText).toContain('流程 IO 释放')
    expect(logText).not.toContain(PASS)
    await service.disposeAll()
    await server.close()
  })

  it('T14 ⑫ io.recentLines 水位过滤回归：已消费行不重入后续读窗 initial 快照', async () => {
    // 回显服务端：每收一行回 `echo <行>`（read 语义在 runtime/read.spec，本例只测缝面过滤）
    const echo = net.createServer((sock) => {
      sock.on('error', () => {})
      sock.on('data', (d: Buffer) => {
        for (const line of stripIac(d).split(/\r?\n/)) {
          if (line.trim() !== '') sock.write(`echo ${line.trim()}\n`)
        }
      })
    })
    await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve))
    const port = (echo.address() as AddressInfo).port
    const servers = new Map<string, ServerRecord>([
      ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port }],
    ])
    const service = new MudService({
      serverLookup: () => servers.get('ws-1')!,
      accountLookup: () => ({ id: 'a1', name: NAME, passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }),
      resolveCreds: async () => ({ name: NAME, pass: PASS }),
      log: { bufferMax: 50 },
    })
    service.register('a1')
    await service.connect('a1')
    try {
      const handle = await service.workflowIoFor('a1', 'workflow:login')
      handle.io.send('ping')
      const r1 = await handle.io.read({ until: [/^echo ping$/], timeoutMs: 2000 })
      expect(r1.reason).toBe('done')
      // 首窗已消费 echo ping（水位推进）——后续读窗的 initial 快照不得重灌该行；
      // T13 期「URL 抽取豁免」若在，这里会重见已消费行（豁免已随 T14 槽化删除）。
      const r2 = await handle.io.read({ gaCount: 1, timeoutMs: 300 }, handle.io.recentLines(100))
      expect(r2.lines.map(l => l.text)).not.toContain('echo ping')
      handle.release()
    } finally {
      await service.disposeAll()
      await new Promise<void>(resolve => echo.close(() => resolve()))
    }
  })
})
