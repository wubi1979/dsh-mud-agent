/**
 * world 测试 — 三期 T1 状态地基：
 *   - World：后到覆盖 / 分区快照 / clear 复位
 *   - 两轴接线：GMCP 到达 → loggedIn='in-game' + world 写入（不依赖行文匹配）
 *   - 登录轴三态：声明判据命中 → inferred 先行，GMCP 加固 in-game（不降级），断线复位
 *   - 断线：两轴同时反转（conn → disconnected + loggedIn → unknown）+ world 清空
 *   - 两会话 world 隔离
 *   - service.status / watchStatus 携带两轴 + world，GMCP 变化推帧
 *
 * GMCP 用真实 TCP server 发原始子协商字节驱动（IAC SB 201 <payload> IAC SE）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { SessionRuntime } from '../src/runtime.ts'
import { World } from '../src/world.ts'
import { MudService } from '../src/service.ts'

/** 构造 GMCP 子协商字节：IAC SB GMCP <pkg SP payload> IAC SE。 */
function gmcpBytes(pkg: string, payload?: string): Buffer {
  const body = Buffer.from(payload === undefined ? pkg : `${pkg} ${payload}`, 'utf8')
  return Buffer.concat([Buffer.from([0xff, 0xfa, 201]), body, Buffer.from([0xff, 0xf0])])
}

/** 接受连接并立即发送 GMCP 的服务端（socket 收集供后续定向发送）。 */
async function startGmcpServer(autoPkg?: string, payload?: string): Promise<{
  port: number
  sockets: net.Socket[]
  close(): Promise<void>
}> {
  const sockets: net.Socket[] = []
  const server = net.createServer((s) => {
    sockets.push(s)
    s.resume()
    if (autoPkg !== undefined) s.write(gmcpBytes(autoPkg, payload))
    s.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    sockets,
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

async function connectRuntime(rt: SessionRuntime, port: number): Promise<void> {
  await rt.connect({ host: '127.0.0.1', port })
}

describe('World 状态组织', () => {
  it('同 zone+key 后到覆盖：value/置信度/来源整体替换，首次写入返回 false', () => {
    const w = new World()
    expect(w.set('vitals', 'hp', 100, 'measured', { kind: 'gmcp', time: 1 })).toBe(false)
    expect(w.set('vitals', 'hp', 90, 'measured', { kind: 'gmcp', time: 2 })).toBe(true)
    const entry = w.get('vitals', 'hp')
    expect(entry?.value).toBe(90)
    expect(entry?.source.time).toBe(2)
  })

  it('snapshot 只含已写分区，且是防御性拷贝', () => {
    const w = new World()
    w.set('vitals', 'hp', 100)
    w.set('location', 'room', '武庙')
    const snap = w.snapshot()
    expect(Object.keys(snap).sort()).toEqual(['location', 'vitals'])
    expect(snap.vitals?.hp?.value).toBe(100)
    // 改快照不影响内部
    ;(snap.vitals as Record<string, unknown>).hp = undefined
    expect(w.get('vitals', 'hp')?.value).toBe(100)
  })

  it('clear 整体清空（断线复位路径）', () => {
    const w = new World()
    w.set('vitals', 'hp', 100)
    w.clear()
    expect(w.snapshot()).toEqual({})
    expect(w.get('vitals', 'hp')).toBeUndefined()
  })
})

describe('两轴接线（runtime，真实 TCP）', () => {
  it('GMCP 到达 → loggedIn=in-game + world 写入（measured/gmcp 来源）', async () => {
    const server = await startGmcpServer('Core.Login', '{"id":1}')
    const rt = new SessionRuntime('s1')
    expect(rt.loggedIn).toBe('unknown')
    await connectRuntime(rt, server.port)
    for (let i = 0; i < 50 && rt.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('in-game')
    const entry = rt.world.gmcp?.['Core.Login']
    expect(entry?.value).toEqual({ id: 1 })
    expect(entry?.confidence).toBe('measured')
    expect(entry?.source.kind).toBe('gmcp')
    rt.dispose()
    await server.close()
  })

  it('断线同时反转两轴：conn=disconnected + loggedIn 复位 unknown + world 清空', async () => {
    const server = await startGmcpServer('Core.Login', '{"id":1}')
    const rt = new SessionRuntime('s1')
    await connectRuntime(rt, server.port)
    for (let i = 0; i < 50 && rt.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('in-game')

    rt.disconnect()
    expect(rt.connState).toBe('disconnected')
    expect(rt.loggedIn).toBe('unknown')
    expect(rt.world).toEqual({})
    rt.dispose()
    await server.close()
  })

  it('两会话 world 隔离：GMCP 只写到达的那个会话', async () => {
    const server = await startGmcpServer()
    const rt1 = new SessionRuntime('s1')
    const rt2 = new SessionRuntime('s2')
    await connectRuntime(rt1, server.port)
    await connectRuntime(rt2, server.port)

    server.sockets[0]!.write(gmcpBytes('Status.Vitals', '{"hp":100}'))
    for (let i = 0; i < 50 && rt1.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt1.loggedIn).toBe('in-game')
    expect(rt1.world.gmcp?.['Status.Vitals']?.value).toEqual({ hp: 100 })
    expect(rt2.loggedIn).toBe('unknown')
    expect(rt2.world).toEqual({})
    rt1.dispose()
    rt2.dispose()
    await server.close()
  })

  it('onWorldChange 在 GMCP 到达与断线复位时各触发一次', async () => {
    const server = await startGmcpServer()
    const rt = new SessionRuntime('s1')
    let changes = 0
    rt.onWorldChange = () => { changes += 1 }
    await connectRuntime(rt, server.port)
    server.sockets[0]!.write(gmcpBytes('Core.Login'))
    for (let i = 0; i < 50 && rt.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    const afterGmcp = changes
    expect(afterGmcp).toBeGreaterThanOrEqual(1)
    rt.disconnect()
    expect(changes).toBe(afterGmcp + 1)
    rt.dispose()
    await server.close()
  })
})

describe('登录轴三态（声明判据先行，GMCP 加固）', () => {
  it('声明判据命中（已连接）→ inferred；GMCP 到达 → 加固 in-game', async () => {
    const server = await startGmcpServer()
    const rt = new SessionRuntime('s1')
    await connectRuntime(rt, server.port)
    expect(rt.loggedIn).toBe('unknown')

    // 判据行文（与 login.ts 成功判据同源；注意「欢迎来到」与建连横幅撞车不可用）
    server.sockets[0]!.write('目前权限：(player)\r\n')
    for (let i = 0; i < 50 && rt.loggedIn !== 'inferred'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('inferred')

    // GMCP 到达加固
    server.sockets[0]!.write(gmcpBytes('Status.Vitals', '{"hp":100}'))
    for (let i = 0; i < 50 && rt.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('in-game')
    rt.dispose()
    await server.close()
  })

  it('in-game 后判据行文不降级；断线复位 unknown', async () => {
    const server = await startGmcpServer()
    const rt = new SessionRuntime('s1')
    await connectRuntime(rt, server.port)
    server.sockets[0]!.write(gmcpBytes('Core.Login'))
    for (let i = 0; i < 50 && rt.loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('in-game')

    server.sockets[0]!.write('重新连线完毕\r\n')
    await new Promise(r => setTimeout(r, 100))
    expect(rt.loggedIn).toBe('in-game')

    rt.disconnect()
    expect(rt.loggedIn).toBe('unknown')
    rt.dispose()
    await server.close()
  })

  it('inferred 后断线同样复位 unknown', async () => {
    const server = await startGmcpServer()
    const rt = new SessionRuntime('s1')
    await connectRuntime(rt, server.port)
    server.sockets[0]!.write('目前权限：(player)\r\n')
    for (let i = 0; i < 50 && rt.loggedIn !== 'inferred'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(rt.loggedIn).toBe('inferred')

    rt.disconnect()
    expect(rt.loggedIn).toBe('unknown')
    rt.dispose()
    await server.close()
  })
})

describe('service 状态面（两轴 + world）', () => {
  it('status 携带 loggedIn/world；GMCP 变化经 watchStatus 推帧', async () => {
    const server = await startGmcpServer()
    const service = new MudService({
      serverLookup: () => ({ workspaceId: 'w1', name: 'srv', host: '127.0.0.1', port: server.port }),
      accountLookup: () => ({ id: 's1', name: 'u', passRef: '', serverId: 'w1', preset: 'mud-player', admitted: false }),
      resolveCreds: async () => ({ name: 'u', pass: 'p' }),
    })

    // 未登记会话：两轴缺省
    expect(service.status('nope').loggedIn).toBe('unknown')
    expect(service.status('nope').world).toEqual({})

    const frames: string[] = []
    const unsubscribe = service.subscribeStatus(f => { frames.push(JSON.stringify(f.sessions.find(s => s.sessionId === 's1'))) })
    service.register('s1')
    await service.connect('s1')
    expect(service.status('s1').state).toBe('connected')
    expect(service.status('s1').loggedIn).toBe('unknown')

    server.sockets[0]!.write(gmcpBytes('Status.Vitals', '{"hp":100}'))
    for (let i = 0; i < 100 && service.status('s1').loggedIn !== 'in-game'; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }
    const st = service.status('s1')
    expect(st.loggedIn).toBe('in-game')
    expect(st.world.gmcp?.['Status.Vitals']?.value).toEqual({ hp: 100 })

    // 推帧包含两轴 + world（GMCP 到达触发过广播）
    await new Promise(r => setTimeout(r, 50))
    unsubscribe()
    expect(frames.some(f => f !== null && f.includes('"loggedIn":"in-game"'))).toBe(true)

    service.disposeAll()
    await server.close()
  })
})
