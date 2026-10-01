/**
 * read 测试 — ReadMachine 判定序/异步收束/失配记错/swallow + runtime 集成（水位线）。
 *
 * 单测（§3.3 设计）：
 *   1. 判定序（写死）：failOn > until > gaCount > maxLines；
 *   2. 异步收束源各一例：quiet / timeout / signal / disconnected / danger；
 *   3. until 失配（quiet/timeout/maxLines 收场）记 error；gaCount 关窗不算失配；
 *   4. initial 立即命中（先到先结算）；
 *   5. 并发 start fail-loud；
 *   6. swallow 钩子：返回 'swallow' 的行不进 acc。
 *
 * 集成（真实 TCP）：
 *   - read 端到端（until 命中返回原文）；
 *   - 未连接 read 直接 disconnected 收束；
 *   - GA 边界关窗（gaCount）；
 *   - 断线中断在途 read；
 *   - 水位线：read 消费的行不再被投递（readAbs 推进），失败批次重试不丢行。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { ReadMachine } from '../src/read.ts'
import { SessionRuntime } from '../src/runtime.ts'
import { Deliverer } from '../src/deliver.ts'
import type { AddressInfo } from 'node:net'
import type { MudLine } from '../src/link/line.ts'

// ── 工具 ──────────────────────────────────────────────────────

function line(text: string, abs = 0): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 起 TCP server：连接后写 welcome 横幅，onData 可编程回写。 */
async function startServer(onData: (data: string, socket: net.Socket) => void): Promise<{
  port: number
  close(): Promise<void>
  broadcast(text: string): void
  sendGa(socketTag?: number): void
}> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.write('欢迎来到测试服务器\n')
    s.on('data', d => onData(d.toString(), s))
    s.on('error', () => {})
    s.on('close', () => { sockets.delete(s) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    broadcast: (text: string) => { for (const s of sockets) s.write(text) },
    sendGa: () => { for (const s of sockets) s.write(Buffer.from([0xff, 0xf9])) },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// ── ReadMachine 单测 ──────────────────────────────────────────

describe('ReadMachine 判定序', () => {
  it('failOn 优先于 until（两者同帧命中时 failOn 收束）', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/完成/], failOn: [/爆炸/], timeoutMs: 500 })
    m.onLine(line('爆炸且完成'))
    const r = await p
    expect(r.reason).toBe('failOn')
    expect(r.lines.map(l => l.text)).toEqual(['爆炸且完成'])
  })

  it('until 优先于 gaCount（同帧 until 命中即收，不等边界）', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/完成/], gaCount: 3, timeoutMs: 500 })
    m.onLine(line('完成'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(1)
  })

  it('gaCount 优先于 maxLines（边界先到即收，行数未满）', async () => {
    const m = new ReadMachine()
    const p = m.start({ gaCount: 1, maxLines: 10, timeoutMs: 500 })
    m.onLine(line('a'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(1)
  })

  it('maxLines 剪断：行数达到即 done 收束', async () => {
    const m = new ReadMachine()
    const p = m.start({ maxLines: 2, timeoutMs: 500 })
    m.onLine(line('a'))
    m.onLine(line('b'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['a', 'b'])
  })

  it('until 可跨批命中（累积文本上测）', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/第一.*第二/s], timeoutMs: 500 })
    m.onLine(line('这是第一'))
    m.onLine(line('行，第二在下一行'))
    const r = await p
    expect(r.reason).toBe('done')
  })
})

describe('ReadMachine 异步收束源', () => {
  it('quiet：行后静默到期收束', async () => {
    const m = new ReadMachine()
    const r = await m.start({ quietMs: 50, timeoutMs: 2000 }, [line('预取')])
    expect(r.reason).toBe('quiet')
  })

  it('timeout：总超时收束', async () => {
    const m = new ReadMachine()
    const r = await m.start({ timeoutMs: 60 })
    expect(r.reason).toBe('timeout')
  })

  it('signal：中止即收束（不吞行）', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    const p = m.start({ timeoutMs: 5000, signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.reason).toBe('signal')
  })

  it('signal 已 abort：start 立即收束', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    ac.abort()
    const r = await m.start({ timeoutMs: 5000, signal: ac.signal })
    expect(r.reason).toBe('signal')
  })

  it('disconnected：断线收束（在途 read 被中断）', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    m.onDisconnected()
    const r = await p
    expect(r.reason).toBe('disconnected')
  })

  it('danger：abortWait 收束，触发行收编进结果', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    m.abortWait(line('拦路者出现'))
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['拦路者出现'])
  })
})

describe('ReadMachine 失配记错', () => {
  it('until 未命中而 quiet 收场 → 记 error', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    await m.start({ until: [/完成/], quietMs: 40, timeoutMs: 2000 }, [line('无关行')])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('until')
  })

  it('gaCount 边界关窗不算失配（不记 error）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/完成/], gaCount: 1, timeoutMs: 2000 })
    m.onLine(line('普通行'))
    m.onBoundary()
    await p
    expect(errors).toEqual([])
  })

  it('until 命中收场不记 error', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/完成/], timeoutMs: 2000 })
    m.onLine(line('完成'))
    await p
    expect(errors).toEqual([])
  })
})

describe('ReadMachine 生命周期', () => {
  it('initial 立即命中（先到先结算，不等新行）', async () => {
    const m = new ReadMachine()
    const r = await m.start({ until: [/欢迎/], timeoutMs: 2000 }, [line('欢迎光临')])
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['欢迎光临'])
  })

  it('并发 start fail-loud', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    expect(() => m.start({ timeoutMs: 5000 })).toThrow('在途')
    m.onDisconnected()
    await p
  })

  it('swallow 钩子：返回 swallow 的行不进 acc', async () => {
    const m = new ReadMachine()
    m.onSwallow = l => (l.text.includes('噪声') ? 'swallow' : undefined)
    const p = m.start({ maxLines: 2, timeoutMs: 2000 })
    m.onLine(line('噪声行'))
    m.onLine(line('实词1'))
    m.onLine(line('实词2'))
    const r = await p
    expect(r.lines.map(l => l.text)).toEqual(['实词1', '实词2'])
  })

  it('收束后可再次 start（状态复位）', async () => {
    const m = new ReadMachine()
    const r1 = await m.start({ maxLines: 1, timeoutMs: 60 })
    expect(r1.reason).toBe('timeout')
    const r2 = await m.start({ maxLines: 1, timeoutMs: 2000 }, [line('x')])
    expect(r2.reason).toBe('done')
  })
})

// ── runtime 集成（真实 TCP + 水位线）──────────────────────────

describe('SessionRuntime.read（集成）', () => {
  it('read 端到端：send 后等应答，until 命中返回原文', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('look')) s.write('你看到一座小屋\n')
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50)) // 欢迎横幅到达

    const p = rt.read({ until: [/小屋/], timeoutMs: 2000 })
    rt.send('look')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('你看到一座小屋')
    // readAbs 已推进到应答尾行
    expect(rt.seenAbs()).toBeGreaterThanOrEqual(r.lines.at(-1)!.abs)
    rt.dispose()
    await server.close()
  })

  it('未连接 read：直接 disconnected 收束（不启动等待）', async () => {
    const rt = new SessionRuntime('s1')
    const r = await rt.read({ timeoutMs: 2000 })
    expect(r.reason).toBe('disconnected')
    expect(r.lines).toEqual([])
  })

  it('GA 边界关窗：gaCount=1 命中即收', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('hp')) {
        s.write('气血 100/100\n')
        s.write(Buffer.from([0xff, 0xf9])) // IAC GA
      }
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50))

    const p = rt.read({ gaCount: 1, timeoutMs: 2000 })
    rt.send('hp')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('气血 100/100')
    rt.dispose()
    await server.close()
  })

  it('断线中断在途 read（reason: disconnected）', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })

    const p = rt.read({ until: [/永不出现/], timeoutMs: 5000 })
    rt.disconnect()
    const r = await p
    expect(r.reason).toBe('disconnected')
    // 断线水位复位
    expect(rt.seenAbs()).toBe(-1)
    expect(rt.pendingLineCount).toBe(0)
    rt.dispose()
    await server.close()
  })

  it('并发 read fail-loud（同一 runtime 同一时刻只允许一个 read）', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    const p = rt.read({ timeoutMs: 5000 })
    await expect(rt.read({ timeoutMs: 5000 })).rejects.toThrow('在途')
    rt.disconnect()
    await p
    rt.dispose()
    await server.close()
  })

  it('水位线：read 消费过的行不再被投递（seen 推进），投递只拉 seen 之后', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50)) // 欢迎横幅（3 行左右）入 pending

    // 接入 + 投递器（deliver 收集；onLine 接线镜像 service.register）
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, rt, { quietMs: 20 })
    rt.onLine = l => { d.onLine(l) }
    d.admit() // 水位 = 接入时刻（欢迎横幅不回放）

    // 裸读：取尾部（欢迎横幅）——读过即已见，不再投递
    const initial = rt.recentLines(10)
    expect(initial.length).toBeGreaterThan(0)
    const r = await rt.read({ quietMs: 30, timeoutMs: 2000 }, initial)
    expect(r.reason).toBe('quiet')
    expect(rt.seenAbs()).toBeGreaterThanOrEqual(initial.at(-1)!.abs)

    // 新行到达 → 投递只拉 seen 之后（不含已裸读的横幅）
    server.broadcast('新到的一行\n')
    await new Promise(x => setTimeout(x, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('新到的一行')
    expect(d.pendingCount).toBe(0)
    rt.dispose()
    await server.close()
  })

  it('投递与 read 互补不重复：未 read 的行走投递，read 过的不重复投', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('look')) s.write('房间描述\n')
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50))

    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, rt, { quietMs: 20 })
    d.admit()

    // read 消费 look 应答
    const p = rt.read({ until: [/房间描述/], timeoutMs: 2000 })
    rt.send('look')
    const r = await p
    expect(r.reason).toBe('done')

    // turn/end 冲刷：应答行已 read（seen 推进），不重复投递
    d.onTurnEnd()
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(0)
    rt.dispose()
    await server.close()
  })
})
