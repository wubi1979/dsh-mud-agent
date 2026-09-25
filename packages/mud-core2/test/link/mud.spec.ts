/**
 * link/mud 回放测试 — read 竞速机（impl §4 语料回放四条 + 释放阀门 + 持有者）。
 *
 * 四条先红后绿：完成句跨批 / 危险中断 read / rest 同帧移交 / until 失配记错。
 * 另覆盖：先到的行先结算、GA 边界计数、signal/timeout 释放阀门、持有者冲突
 * fail-loud、断线 disconnected、有界缓冲 OOM 阀门、send 不占行流。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Mud } from '../../src/link/mud.ts'

const IAC = 255
const GA = 249

interface TestServer {
  port: number
  write(data: string | Buffer): void
  kill(): void
  close(): Promise<void>
  waitFor(target: string): Promise<Buffer>
}

async function startServer(): Promise<TestServer> {
  let sock: net.Socket | null = null
  const chunks: Buffer[] = []
  const server = net.createServer((s) => {
    sock = s
    s.on('data', (d: Buffer) => chunks.push(d))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    write(data) {
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      if (sock !== null) sock.write(payload)
      else server.once('connection', s => s.write(payload))
    },
    kill() { sock?.destroy() },
    close() {
      sock?.destroy() // 先断客户端连接，否则 server.close 等待既有连接结束会挂起
      return new Promise(resolve => server.close(() => resolve()))
    },
    /** 轮询等待对端收到含 target 的字节（连接首字节是协商序列，需跳过）。 */
    waitFor(target: string): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const t0 = Date.now()
        const probe = setInterval(() => {
          const all = Buffer.concat(chunks)
          if (all.includes(Buffer.from(target, 'binary'))) {
            clearInterval(probe)
            resolve(all)
          } else if (Date.now() - t0 > 2000) {
            clearInterval(probe)
            reject(new Error(`对端 2s 内未收到目标字节: ${target}; 实收 ${all.length} 字节`))
          }
        }, 10)
      })
    },
  }
}

async function setup(): Promise<{ mud: Mud, server: TestServer }> {
  const server = await startServer()
  const mud = new Mud()
  mud.connect('127.0.0.1', server.port)
  for (let i = 0; i < 100 && !mud.connected; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  expect(mud.connected).toBe(true)
  return { mud, server }
}

const GA_BYTES = Buffer.from([IAC, GA])

describe('语料回放四条 (impl §4)', () => {
  it('完成句跨批: until 在累积文本上测, 跨两个 TCP 块命中', async () => {
    const { mud, server } = await setup()
    const p = mud.read({ holder: 'root', until: [/去茶室/], timeoutMs: 2000 })
    server.write('师父说道：\n')
    await new Promise(r => setTimeout(r, 20))
    server.write('你去茶室吧。\r\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['师父说道：', '你去茶室吧。'])
    await server.close()
  })

  it('危险中断 read: 意识层 onLine 钩子同步 abortWait, 触发行收编进结果', async () => {
    const { mud, server } = await setup()
    mud.onLine = (line) => {
      // 模拟 awareness.observe 的 danger 出口（与意识层同一份判据的同步测）
      if (line.text.includes('向你袭来')) mud.abortWait(line)
    }
    const p = mud.read({ holder: 'root', until: [/永远不会出现/], timeoutMs: 5000 })
    server.write('你大喝一声。\n')
    await new Promise(r => setTimeout(r, 20))
    server.write('不知哪里杀出一人向你袭来！\r\n')
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['你大喝一声。', '不知哪里杀出一人向你袭来！'])
    await server.close()
  })

  it('rest 同帧移交: 判据命中那一刻同帧剩余行移交, 下次 read 先消费', async () => {
    const { mud, server } = await setup()
    const p = mud.read({ holder: 'root', until: [/完成句/], timeoutMs: 2000 })
    server.write('第一行\n完成句\n后续甲\n后续乙\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['第一行', '完成句'])
    expect(r.rest?.map(l => l.text)).toEqual(['后续甲', '后续乙'])
    // 下一次 read 先消费移交行（先到的行先结算）。
    const p2 = mud.read({ holder: 'root', maxLines: 2, timeoutMs: 2000 })
    const r2 = await p2
    expect(r2.reason).toBe('done')
    expect(r2.lines.map(l => l.text)).toEqual(['后续甲', '后续乙'])
    await server.close()
  })

  it('until 失配记错: 声明了 until 却以 quiet 收场 → 记 error (语料可见)', async () => {
    const { mud, server } = await setup()
    const errors: string[] = []
    mud.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = mud.read({ holder: 'root', until: [/不会出现/], quietMs: 40, timeoutMs: 3000 })
    server.write('一些无关内容\r\n')
    const r = await p
    expect(r.reason).toBe('quiet')
    expect(errors.some(e => e.includes('until 判据失配'))).toBe(true)
    await server.close()
  })
})

describe('read 竞速机', () => {
  it('先到的行先结算: read 前到达的行先消费 (本次 send 之前的到达行)', async () => {
    const { mud, server } = await setup()
    server.write('欢迎来到北大侠客行\n请输入密码：')
    await new Promise(r => setTimeout(r, 50)) // 行到达且无持有者 → 进缓冲
    const p = mud.read({ holder: 'root', until: [/密码/], timeoutMs: 2000 })
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('欢迎来到北大侠客行')
    await server.close()
  })

  it('GA 边界: 滞留尾行先分发再计数 (行先于边界), gaCount=1 缺省关窗', async () => {
    const { mud, server } = await setup()
    const boundaries: string[] = []
    mud.onBoundary = kind => boundaries.push(kind)
    const p = mud.read({ holder: 'root', timeoutMs: 2000 })
    server.write('横幅\n在线提示')
    server.write(GA_BYTES)
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('在线提示')
    expect(boundaries).toEqual(['ga'])
    await server.close()
  })

  it('gaCount=2: 两个边界才关窗 (N-GA 计数)', async () => {
    const { mud, server } = await setup()
    const p = mud.read({ holder: 'root', gaCount: 2, timeoutMs: 2000 })
    server.write('第一段')
    server.write(GA_BYTES)
    await new Promise(r => setTimeout(r, 20))
    server.write('第二段')
    server.write(GA_BYTES)
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['第一段', '第二段'])
    await server.close()
  })

  it('failOn 优先于 until (判定序写死)', async () => {
    const { mud, server } = await setup()
    const p = mud.read({ holder: 'root', until: [/成功/], failOn: [/失败/], timeoutMs: 2000 })
    server.write('操作失败\r\n')
    const r = await p
    expect(r.reason).toBe('failOn')
    await server.close()
  })

  it('maxLines 行数兜底: 达到即 done, 同帧剩余行移交 rest', async () => {
    const { mud, server } = await setup()
    const p = mud.read({ holder: 'root', maxLines: 3, timeoutMs: 2000 })
    server.write('1\n2\n3\n4\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(3)
    expect(r.rest?.map(l => l.text)).toEqual(['4'])
    await server.close()
  })

  it('maxLines 末位: failOn 优先于行数兜底 (判定序写死, maxLines 不得抢剪)', async () => {
    const { mud, server } = await setup()
    // 一行即满 maxLines=1, 但该行同时命中 failOn —— 判定序 failOn > maxLines,
    // 收束原因必须是 failOn 而非 maxLines 剪断的 done。
    const p = mud.read({ holder: 'root', maxLines: 1, failOn: [/失败/], timeoutMs: 2000 })
    server.write('操作失败\r\n')
    const r = await p
    expect(r.reason).toBe('failOn')
    await server.close()
  })

  it('maxLines 剪断的 done 且 until 未命中 → 记错 (剪断 ≠ 完成语命中)', async () => {
    const { mud, server } = await setup()
    const errors: string[] = []
    mud.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    // 被 maxLines=2 剪断收 done, until 从未命中 —— 必须吵 (评审②: 剪断绕过记错的回归)。
    const p = mud.read({ holder: 'root', until: [/不会出现/], maxLines: 2, timeoutMs: 3000 })
    server.write('甲\n乙\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(2)
    expect(errors.some(e => e.includes('until 判据失配'))).toBe(true)
    await server.close()
  })

  it('GA 关窗不算失配: until 未命中但由边界关窗 → 不记错 (缺省 gaCount=1 常态)', async () => {
    const { mud, server } = await setup()
    const errors: string[] = []
    mud.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    // 完成句还没来、GA 先到是正常收束 (mud_flow({id}) 缺省 gaCount=1), 不是判据写错。
    const p = mud.read({ holder: 'root', until: [/不会出现/], timeoutMs: 3000 })
    server.write('一段完整文字')
    server.write(GA_BYTES)
    const r = await p
    expect(r.reason).toBe('done')
    expect(errors).toEqual([])
    await server.close()
  })

  it('swallow: onLine 返回 swallow 的行不进 acc/缓冲 (反射吞触发行)', async () => {
    const { mud, server } = await setup()
    mud.onLine = (line) => {
      if (line.text.includes('吞我')) return 'swallow' // 反射出口: 触发行不留痕于模型面
      return undefined
    }
    const p = mud.read({ holder: 'root', maxLines: 1, timeoutMs: 2000 })
    server.write('吞我\n留下的行\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['留下的行'])
    await server.close()
  })

  it('swallow 行也不进缓冲: read 结束后再次 read 不得看到被吞的行', async () => {
    const { mud, server } = await setup()
    mud.onLine = (line) => (line.text.includes('吞我') ? 'swallow' : undefined)
    // 无持有者时到达 → 吞掉的行不得进缓冲。
    server.write('吞我\n缓冲行\n')
    await new Promise(r => setTimeout(r, 50))
    const r = await mud.read({ holder: 'root', maxLines: 1, timeoutMs: 2000 })
    expect(r.lines.map(l => l.text)).toEqual(['缓冲行'])
    await server.close()
  })

  it('signal 中止: exec.signal 触发即以 signal 收束并释放持有者 (释放阀门)', async () => {
    const { mud, server } = await setup()
    const ac = new AbortController()
    const p = mud.read({ holder: 'child:c1', timeoutMs: 5000, signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.reason).toBe('signal')
    expect(mud.currentHolder).toBeNull()
    // 释放后可再次 read（槽被释放）。
    const p2 = mud.read({ holder: 'child:c1', timeoutMs: 30 })
    expect((await p2).reason).toBe('timeout')
    await server.close()
  })

  it('timeout 到点收束 (绝不无界等待)', async () => {
    const { mud, server } = await setup()
    const r = await mud.read({ holder: 'root', timeoutMs: 40 })
    expect(r.reason).toBe('timeout')
    expect(mud.currentHolder).toBeNull()
    await server.close()
  })

  it('持有者冲突: 并发 read 抛错 (fail-loud, 不做队列)', async () => {
    const { mud, server } = await setup()
    const ac = new AbortController()
    void mud.read({ holder: 'root', timeoutMs: 5000, signal: ac.signal })
    expect(() => mud.read({ holder: 'child:c1', timeoutMs: 1000 }))
      .toThrow(/持有者冲突/)
    ac.abort()
    await server.close()
  })

  it('断线: 在途 read 以 disconnected 收束, 持有者释放', async () => {
    const { mud, server } = await setup()
    let disconnected = false
    mud.onDisconnect = () => { disconnected = true }
    const p = mud.read({ holder: 'root', until: [/不会出现/], timeoutMs: 5000 })
    server.kill()
    const r = await p
    expect(r.reason).toBe('disconnected')
    expect(disconnected).toBe(true)
    expect(mud.currentHolder).toBeNull()
    // 未连接时 read 立即 disconnected (不挂起)。
    expect(mud.connected).toBe(false)
    expect((await mud.read({ holder: 'root', timeoutMs: 1000 })).reason).toBe('disconnected')
    await server.close()
  })

  it('有界缓冲 OOM 阀门: 512 行上限, 超限丢最旧记错', async () => {
    const { mud, server } = await setup()
    const errors: string[] = []
    mud.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    // 条件等待替代固定 sleep：轮询到末行经 onLine 到达，600 行才保证全部进缓冲
    // （固定 80ms 在慢机/分块到达时会假红：读提前 timeout、行数不足）。
    let lastSeen = 0
    mud.onLine = (l) => {
      const m = /^第(\d+)行$/.exec(l.text)
      if (m) lastSeen = Number(m[1])
      return undefined
    }
    server.write(Array.from({ length: 600 }, (_, i) => `第${i + 1}行\n`).join(''))
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const probe = setInterval(() => {
        if (lastSeen >= 600) { clearInterval(probe); resolve() }
        else if (Date.now() - t0 > 5000) { clearInterval(probe); reject(new Error('600 行未在 5s 内到齐')) }
      }, 10)
    })
    const r = await mud.read({ holder: 'root', timeoutMs: 50 })
    expect(r.reason).toBe('timeout')
    expect(r.lines).toHaveLength(512)
    expect(r.lines[0]?.text).toBe('第89行') // 丢最旧: 前 88 行被挤掉
    expect(errors.some(e => e.includes('行缓冲超限'))).toBe(true)
    await server.close()
  })

  it('send 不占行流: read 在途时直发照常到达对端', async () => {
    const { mud, server } = await setup()
    const ac = new AbortController()
    void mud.read({ holder: 'root', timeoutMs: 5000, signal: ac.signal })
    expect(mud.send('halt')).toBe(true)
    const received = await server.waitFor('halt\r\n')
    expect(received.toString()).toContain('halt\r\n')
    ac.abort()
    await server.close()
  })
})

describe('行尾静默刷出 (Mudlet posting timer, 300ms)', () => {
  it('无换行提示符片断在静默到期后刷成完整行', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    mud.onLine = (l) => { seen.push(l.text) }
    server.write('您的英文名字：')
    await new Promise(r => setTimeout(r, 450))
    expect(seen).toContain('您的英文名字：')
    await server.close()
  })
})
