/**
 * link/mud 回放测试 — 连接、行流分发、断线、静默刷出。
 *
 * 从 mud-core2 test/link/mud.spec.ts 瘦身：去掉 read 竞速机相关用例（Holder /
 * WaitOpts / until / failOn / gaCount / signal / abortWait / 持有者冲突 / OOM
 * 阀门），只保留连接管理 + 行流分发 + GA 边界 + 断线 + send + 静默刷出。
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
      sock?.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
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
  for (let i = 0; i < 100 && !mud.connected; i += 1) {
    await new Promise(r => setTimeout(r, 10))
  }
  expect(mud.connected).toBe(true)
  return { mud, server }
}

const GA_BYTES = Buffer.from([IAC, GA])

describe('连接与行流分发', () => {
  it('onLine 收到逐行分发: 完整行即时到达', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    server.write('欢迎来到北大侠客行\n请输入密码：\n')
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toEqual(['欢迎来到北大侠客行', '请输入密码：'])
    await server.close()
  })

  it('跨块行尾续接: 不加换行不产出, 续块合并为同一行', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    server.write('杀气逼人')
    await new Promise(r => setTimeout(r, 20))
    expect(seen).toEqual([])
    server.write('向你扑来！\r\n')
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toEqual(['杀气逼人向你扑来！'])
    await server.close()
  })

  it('GA 边界: 滞留尾行先分发再触发 onBoundary', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    const boundaries: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    mud.onBoundary = kind => { boundaries.push(kind) }
    server.write('横幅\n在线提示')
    server.write(GA_BYTES)
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toContain('横幅')
    expect(seen).toContain('在线提示')
    expect(boundaries).toEqual(['ga'])
    await server.close()
  })
})

describe('send 与 sendCredential', () => {
  it('onSend 观测钩子: 成功发送才回调命令原文', async () => {
    const { mud, server } = await setup()
    const sent: string[] = []
    mud.onSend = cmd => { sent.push(cmd) }
    mud.send('look')
    await server.waitFor('look')
    expect(sent).toEqual(['look'])
    mud.close()
    const beforeFail = sent.length
    mud.send('quit')
    expect(sent.length).toBe(beforeFail)
  })

  it('sendCredential 凭据直发: 不触发 onSend', async () => {
    const { mud, server } = await setup()
    const sent: string[] = []
    mud.onSend = cmd => { sent.push(cmd) }
    mud.sendCredential('hunter')
    mud.send('look')
    await server.waitFor('look')
    expect(sent).toEqual(['look'])
    await server.close()
  })

  it('send 不占行流: 发送后行流照常到达', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    mud.send('look')
    server.write('你看了看周围。\n')
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toEqual(['你看了看周围。'])
    await server.close()
  })
})

describe('断线', () => {
  it('意外断线: 残留行 flush 后 onDisconnect 触发', async () => {
    const { mud, server } = await setup()
    let disconnected = false
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    mud.onDisconnect = () => { disconnected = true }
    server.write('半行内容')
    server.kill()
    await new Promise(r => setTimeout(r, 100))
    expect(disconnected).toBe(true)
    expect(seen).toContain('半行内容')
    expect(mud.connected).toBe(false)
    await server.close()
  })

  it('手工 disconnect: 幂等, 连接关闭后 connected=false', async () => {
    const { mud, server } = await setup()
    mud.disconnect()
    await new Promise(r => setTimeout(r, 50))
    expect(mud.connected).toBe(false)
    mud.disconnect() // 幂等不抛
    await server.close()
  })
})

describe('行尾静默刷出 (Mudlet posting timer, 300ms)', () => {
  it('无换行提示符片断在静默到期后刷成完整行', async () => {
    const { mud, server } = await setup()
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    server.write('您的英文名字：')
    await new Promise(r => setTimeout(r, 450))
    expect(seen).toContain('您的英文名字：')
    await server.close()
  })
})
