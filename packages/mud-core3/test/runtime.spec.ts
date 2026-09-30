/**
 * runtime 测试 — 连接生命周期边界与录制缓冲：
 *   - 建连失败立即失败（不被 login 超时掩盖）、失败不残留 socket
 *   - 连接中再次 connect 抛错（不并发建两条连接）
 *   - 重连后旧连接迟到的 close 不改新连接状态
 *   - dispose 后不能再 connect
 *   - 录制缓冲有上限（丢最旧）
 *
 * 二期工具面（PLAN 测试面，真实 TCP server 端到端）：
 *   1. send + read：server 回行 + GA → 收束返回原文
 *   2. 有 cmd：积压不进 acc、应答是新行
 *   3. 裸读：历史行立即返回 + quiet 窗口收尾巴
 *   4. 断线中断在途 read（reason: 'disconnected'）
 *   5. 水位线：read 消费的行 turn/end 不重复投递（delivered/readAbs 推进）
 *   6. turn/end 冲刷：turn 内积累的行一次投出（一个批次，不重复）
 *   7. 投递失败重试：失败批次不推进 delivered，下次 flushOnce 从失败点重试不丢行
 *
 * 回归背景：手工 disconnect 旧实现只是半开关闭（socket.end），要等对端 FIN 才真正关闭，
 * 旧连接迟到的 close 会把已经建立的新连接打回 disconnected，会话状态与实际连接不一致。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { SessionRuntime } from '../src/runtime.ts'
import { Deliverer, type LineSource } from '../src/deliver.ts'

const CREDS = { name: 'u', pass: 'p' }
/** telnet IAC GA（go-ahead）：一段完整文字的边界标记。 */
const GA = Buffer.from([255, 249])

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

/** 轮询等待条件成立（TCP 异步到达的确定性等待）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 静默服务器：connect 后不发任何行，留 socket 句柄供测试按需手写响应。 */
async function startQuietServer(): Promise<{
  port: number
  sock(): net.Socket | null
  close(): Promise<void>
}> {
  let sock: net.Socket | null = null
  const server = net.createServer((s) => {
    sock = s
    s.resume()
    s.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    sock: () => sock,
    close() {
      sock?.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

/** 手工装配 pull 型投递器（等价 service.register 的水位线源接线）；批次文本可观测。 */
function wireDeliverer(rt: SessionRuntime, deliverResult: () => boolean = () => true): {
  deliverer: Deliverer
  batches: string[]
} {
  const source: LineSource = {
    seen: () => rt.seenAbs,
    end: () => rt.pendingEndAbs,
    take: after => rt.takeLinesAfter(after),
    commit: abs => rt.commitDelivered(abs),
  }
  const batches: string[] = []
  const deliverer = new Deliverer(rt.sessionId, (_id, text) => {
    batches.push(text)
    return deliverResult()
  }, { quietMs: 10, source })
  rt.onLine = line => { deliverer.onLine(line) }
  return { deliverer, batches }
}

describe('SessionRuntime 建连失败', () => {
  it('对端拒绝：立即失败，不等满 login 超时，且不残留 socket', async () => {
    const port = await closedPort()
    const rt = new SessionRuntime('s1')
    const started = Date.now()
    await expect(rt.connect({ host: '127.0.0.1', port, credentials: CREDS }, 5000))
      .rejects.toThrow('失败')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rt.connState).toBe('disconnected')
    expect(rt.connected).toBe(false)
    rt.dispose()
  })

  it('连接中再次 connect：抛错而不是并发建两条连接', async () => {
    const server = await startSlowClosingServer(0)
    const rt = new SessionRuntime('s1')
    const first = rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
    const second = rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
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

    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
    expect(rt.connState).toBe('connected')

    rt.disconnect()
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
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
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
    rt.dispose()
    await expect(rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS }))
      .rejects.toThrow('已销毁')
    await server.close()
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
    await rt.connect({ host: '127.0.0.1', port, credentials: CREDS })
    for (let i = 0; i < 50 && rt.pendingLineCount < 3; i += 1) {
      await new Promise(r => setTimeout(r, 20))
    }

    expect(rt.pendingLineCount).toBe(3)
    expect(rt.droppedLineCount).toBe(2)
    expect(rt.takeLinesAfter(-1).map(l => l.text)).toEqual(['c', 'd', 'e'])
    rt.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

describe('SessionRuntime read 竞速（真实 TCP）', () => {
  it('1. send + read：server 回行 + GA → 收束返回原文', async () => {
    const server = net.createServer((s) => {
      s.resume()
      s.on('data', (d: Buffer) => {
        if (d.toString('utf8').includes('look')) {
          s.write('你看到一间小屋。\r\n')
          s.write(GA)
        }
      })
      s.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const rt = new SessionRuntime('r1')
    await rt.connect({ host: '127.0.0.1', port, credentials: CREDS })
    // 工具层有 cmd 会显式注入 gaCount:1；这里模拟同款注入（读层不做缺省关窗）
    const r = await rt.read({ cmd: 'look', gaCount: 1, timeoutMs: 2000 })

    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['你看到一间小屋。'])

    rt.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('2. 有 cmd：积压不进 acc、应答是新行（录制照常积累）', async () => {
    const server = net.createServer((s) => {
      s.resume()
      s.write('积压行甲\n')
      s.write(GA)
      s.on('data', (d: Buffer) => {
        if (d.toString('utf8').includes('look')) {
          s.write('应答行乙\r\n')
          s.write(GA)
        }
      })
      s.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const rt = new SessionRuntime('r2')
    await rt.connect({ host: '127.0.0.1', port, credentials: CREDS })
    await waitFor(() => rt.pendingLineCount >= 1)

    const r = await rt.read({ cmd: 'look', gaCount: 1, timeoutMs: 2000 })
    expect(r.reason).toBe('done')
    // acc 只收 send 之后的新行（initial 空）：积压行不进 read 结果
    expect(r.lines.map(l => l.text)).toEqual(['应答行乙'])
    // 录制不受 read 影响：积压 + 应答都在 pending
    expect(rt.takeLinesAfter(-1).map(l => l.text)).toEqual(['积压行甲', '应答行乙'])

    rt.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('3. 裸读：历史行立即返回 + quiet 窗口收尾巴', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r3')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
    server.sock()?.write('历史一行\n历史二行\n')
    await waitFor(() => rt.pendingLineCount >= 2)

    const p = rt.read({ timeoutMs: 5000, quietMs: 150 }) // 裸读：无 cmd
    await sleep(50)
    server.sock()?.write('尾巴行\n') // 无 GA：让 quiet 收尾（gaCount 不命中）
    const r = await p

    expect(r.reason).toBe('quiet')
    // initial 快照（历史行）+ 在途新行（尾巴）都在结果里
    expect(r.lines.map(l => l.text)).toEqual(['历史一行', '历史二行', '尾巴行'])
    // 裸读推进 readAbs：读过的行标记已见
    expect(rt.seenAbs).toBe(r.lines[r.lines.length - 1]!.abs)

    rt.dispose()
    await server.close()
  })

  it('3b. 裸读 + GA 到达：未声明 gaCount 不提前关窗（声明才计 GA）', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r3b')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })
    server.sock()?.write('历史一行\n历史二行\n')
    await waitFor(() => rt.pendingLineCount >= 2)

    const p = rt.read({ timeoutMs: 5000, quietMs: 150 }) // 裸读：无 cmd，不声明 gaCount
    await sleep(50)
    server.sock()?.write('尾巴行\n')
    server.sock()?.write(GA) // GA 到达：裸读不声明 gaCount → 不关窗，仍由 quiet 收束
    const r = await p

    expect(r.reason).toBe('quiet')
    expect(r.lines.map(l => l.text)).toEqual(['历史一行', '历史二行', '尾巴行'])

    rt.dispose()
    await server.close()
  })

  it('4. 断线中断在途 read（reason: disconnected）', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r4')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })

    // 等一条永不来的行：gaCount 拉高、无 quiet，只能等断线/超时
    const p = rt.read({ timeoutMs: 8000, gaCount: 5 })
    await sleep(50)
    server.sock()?.end() // 对端关闭 → close 事件链
    const r = await p

    expect(r.reason).toBe('disconnected')
    expect(rt.connState).toBe('disconnected')

    await server.close()
  })
})

describe('SessionRuntime 水位线 × 投递（pull 模型端到端）', () => {
  it('5. read 消费的行 turn/end 不重复投递（delivered/readAbs 推进）', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r5')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })

    const { deliverer, batches } = wireDeliverer(rt)
    deliverer.admit()
    deliverer.onTurnStart() // turn 抑制：行只进 pending，不投

    const p = rt.read({ timeoutMs: 3000, quietMs: 100 }) // 裸读
    await sleep(30)
    server.sock()?.write('行甲\n')
    const r = await p
    expect(r.reason).toBe('quiet')
    expect(r.lines.map(l => l.text)).toEqual(['行甲'])

    deliverer.onTurnEnd() // 冲刷：行已被 read 消费（readAbs 推进），不重复投
    expect(batches).toEqual([])
    expect(rt.seenAbs).toBe(r.lines[r.lines.length - 1]!.abs)

    rt.dispose()
    await server.close()
  })

  it('6. turn/end 冲刷：turn 内积累的行一次投出（一个批次，不重复）', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r6')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })

    const { deliverer, batches } = wireDeliverer(rt)
    deliverer.admit()
    deliverer.onTurnStart()

    server.sock()?.write('行一\n行二\n行三\n')
    await waitFor(() => rt.pendingLineCount >= 3)

    deliverer.onTurnEnd() // 回合内积累的行统一投出
    expect(batches).toEqual(['行一\n行二\n行三'])
    expect(rt.seenAbs).toBe(rt.pendingEndAbs)

    deliverer.onTurnEnd() // 再冲刷：无新行，不重复
    expect(batches).toHaveLength(1)

    rt.dispose()
    await server.close()
  })

  it('7. 投递失败重试：失败批次不推进 delivered，下次 flushOnce 从失败点重试不丢行', async () => {
    const server = await startQuietServer()
    const rt = new SessionRuntime('r7')
    await rt.connect({ host: '127.0.0.1', port: server.port, credentials: CREDS })

    let allow = false
    const { deliverer, batches } = wireDeliverer(rt, () => allow)
    deliverer.admit()
    deliverer.onTurnStart()

    server.sock()?.write('行甲\n行乙\n')
    await waitFor(() => rt.pendingLineCount >= 2)

    deliverer.onTurnEnd() // agent 离线：批次留在录制缓冲
    expect(batches).toHaveLength(1)
    expect(rt.seenAbs).toBe(-1) // 失败批次不推进 delivered

    allow = true
    deliverer.flushOnce() // 下次从失败点重试：两行都在
    expect(batches).toHaveLength(2)
    expect(batches[1]).toBe('行甲\n行乙')
    expect(rt.seenAbs).toBe(rt.pendingEndAbs)

    rt.dispose()
    await server.close()
  })
})
