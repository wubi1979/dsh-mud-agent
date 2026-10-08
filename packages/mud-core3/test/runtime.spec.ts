/**
 * runtime 测试 — 连接生命周期边界与录制缓冲：
 *   - 建连失败立即失败（不被 login 超时掩盖）、失败不残留 socket
 *   - 连接中再次 connect 抛错（不并发建两条连接）
 *   - 重连后旧连接迟到的 close 不改新连接状态
 *   - dispose 后不能再 connect
 *   - 录制缓冲有上限（丢最旧）
 *
 * 回归背景：手工 disconnect 旧实现只是半开关闭（socket.end），要等对端 FIN 才真正关闭，
 * 旧连接迟到的 close 会把已经建立的新连接打回 disconnected，会话状态与实际连接不一致。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { SessionRuntime } from '../src/runtime.ts'
import { stripIac } from './helpers.ts'

/** 允许半开、可延迟回 FIN 的服务端（模拟慢对端/远距离链路）。 */
async function startSlowClosingServer(finDelayMs: number): Promise<{
  port: number
  sockets: net.Socket[]
  close(): Promise<void>
}> {
  const sockets: net.Socket[] = []
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.push(s)
    s.resume()
    s.on('end', () => { setTimeout(() => s.end(), finDelayMs) })
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

/** 取一个已经关闭的空闲端口（用于连接被拒的用例）。 */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

describe('SessionRuntime 建连失败', () => {
  it('对端拒绝：立即失败，不等满 login 超时，且不残留 socket', async () => {
    const port = await closedPort()
    const rt = new SessionRuntime('s1')
    const started = Date.now()
    await expect(rt.connect({ host: '127.0.0.1', port }, 5000))
      .rejects.toThrow('失败')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rt.connState).toBe('disconnected')
    expect(rt.connected).toBe(false)
    rt.dispose()
  })

  it('连接中再次 connect：抛错而不是并发建两条连接', async () => {
    const server = await startSlowClosingServer(0)
    const rt = new SessionRuntime('s1')
    const first = rt.connect({ host: '127.0.0.1', port: server.port })
    const second = rt.connect({ host: '127.0.0.1', port: server.port })
    await expect(second).rejects.toThrow('正在连接')
    await first
    expect(rt.connState).toBe('connected')
    rt.dispose()
    await server.close()
  })
})

describe('SessionRuntime 重连隔离', () => {
  it('慢关闭对端下手工重连：旧连接迟到的 close 不把新连接打回 disconnected', async () => {
    const server = await startSlowClosingServer(400)
    const rt = new SessionRuntime('s1')

    await rt.connect({ host: '127.0.0.1', port: server.port })
    expect(rt.connState).toBe('connected')

    rt.disconnect()
    await rt.connect({ host: '127.0.0.1', port: server.port })
    expect(rt.connState).toBe('connected')
    expect(server.sockets).toHaveLength(2)

    // 旧连接的 FIN 在这段时间内落地（旧实现在此被翻成 disconnected）
    await new Promise(r => setTimeout(r, 700))
    expect(rt.connState).toBe('connected')
    expect(rt.connected).toBe(true)

    rt.dispose()
    await server.close()
  })

  it('dispose 后不能再 connect', async () => {
    const server = await startSlowClosingServer(0)
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    rt.dispose()
    await expect(rt.connect({ host: '127.0.0.1', port: server.port }))
      .rejects.toThrow('已销毁')
    await server.close()
  })
})

describe('SessionRuntime 盲发退役（T3）', () => {
  it('connect 只建连：服务端不收到任何数据，等待登录脚本', async () => {
    const chunks: Buffer[] = []
    const server = net.createServer((s) => {
      s.resume()
      s.on('data', (d: Buffer) => chunks.push(d))
      s.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port })
    // 建连后观察一段时间：盲发已退役，connect 不得发 name/pass/空行
    //（客户端协商字节不算数据——剥离 IAC 后应为空）
    await new Promise(r => setTimeout(r, 300))
    expect(rt.connState).toBe('connected')
    expect(stripIac(Buffer.concat(chunks))).toBe('')

    // sendCredential 仍可发（登录脚本通路）
    expect(rt.sendCredential('hero')).toBe(true)
    await new Promise(r => setTimeout(r, 100))
    expect(stripIac(Buffer.concat(chunks))).toContain('hero')

    rt.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

describe('SessionRuntime 录制缓冲', () => {
  it('未接入期间缓冲有上限：超出丢最旧，内存不无界增长', async () => {
    const server = net.createServer((s) => {
      s.resume()
      s.write('a\nb\nc\nd\ne\n')
      s.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const rt = new SessionRuntime('s1', 3)
    await rt.connect({ host: '127.0.0.1', port })
    for (let i = 0; i < 50 && rt.pendingLineCount < 3; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }

    expect(rt.pendingLineCount).toBe(3)
    expect(rt.droppedLineCount).toBe(2)
    // 环形淘汰后尾部快照 = 最近 3 行（裸读 initial 同源）
    expect(rt.recentLines(10).map(l => l.text)).toEqual(['c', 'd', 'e'])
    rt.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

// ── 持有者互锁（T23.7 W11）：被战斗抢占后，walk 的 finally 不得释放别人的持有 ──

describe('行流持有者与危险抢占的互锁（T23.7）', () => {
  it('walk 在途被 stealSend 后收束，其 finally releaseSend 是 no-op（战斗持有不被误释放）', () => {
    const rt = new SessionRuntime('walk-1')
    // ① 工具（如 mud_walk）拿到持有
    expect(rt.acquireSend('tool')).toBe(true)
    expect(rt.sendHolderId).toBe('tool')
    // ② 危险通道抢占（T21 D5）
    rt.stealSend('combat')
    expect(rt.sendHolderId).toBe('combat')
    // ③ 在途 read 已因 abortWait 以 reason:'danger' 收束 ⇒ 工具的 finally 照常释放"自己"
    rt.releaseSend('tool')
    expect(rt.sendHolderId).toBe('combat') // 关键：战斗的持有仍在（不劈半、无残留）
    // ④ 战斗收尾释放自己 ⇒ 空闲
    rt.releaseSend('combat')
    expect(rt.sendHolderId).toBeNull()
    // 旁证：同 holder 重入成功（同执行体串行调用不自我冲突）
    expect(rt.acquireSend('tool')).toBe(true)
    expect(rt.acquireSend('other')).toBe(false)
    rt.dispose()
  })
})
