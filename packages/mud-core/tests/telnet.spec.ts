/**
 * dsh-mud-core TelnetClient 集成测试 — 无换行提示符行的静默刷出。
 *
 * 漏洞回归: pkuxkx 的横幅与登录提示 (无换行) 常在同一 TCP 块到达, 若只在
 * "本块无完整行" 分支安排静默刷出, 提示行会滞留到连接关闭才可见, 登录流程
 * 感知不到提示并超时。本测试断言提示行在连接保持期间即被刷出为 parsed 行。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { TelnetClient } from '../src/network/telnet.ts'

describe('TelnetClient 行尾静默刷出', () => {
  it('横幅 + 无换行的登录提示在同一块到达: 连接保持期间即刷出为 parsed 行', async () => {
    const banner = '北 大 侠 客 行 欢迎你\n\n您的英文名字（要注册新人物请输入new。）：'
    const server = net.createServer((socket) => {
      socket.write(banner)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const parsedTexts: string[] = []
    client.on('parsed', (lines: { text: string }[]) => {
      for (const line of lines) parsedTexts.push(line.text)
    })
    client.connect()

    // 等待提示行被刷出 (FLUSH_IDLE_MS=400ms 内), 期间连接保持打开。
    const deadline = setTimeout(() => { /* timeout, assertions below will fail */ }, 5000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (parsedTexts.includes('您的英文名字（要注册新人物请输入new。）：')) {
          clearInterval(probe)
          clearTimeout(deadline)
          resolve()
        }
      }, 25)
    })

    expect(parsedTexts).toContain('您的英文名字（要注册新人物请输入new。）：')
    client.close()
    server.close()
  })
})

const IAC = 255
const GA = 249
const EOR = 239
const SE = 240
const SB = 250
const DONT = 254

describe('TelnetClient GA 提交标志', () => {
  it('GA 到达: 无换行行尾被立即刷出为 parsed 行 (不等 300ms 静默)', async () => {
    const server = net.createServer((socket) => {
      // 一段完整文字都以换行结束; 末尾无换行的部分 + IAC GA 表明"一段文字已发送完毕"。
      const text = '欢迎进入\n上线地点房间描述\n系统信息\n在线提示'
      socket.write(Buffer.from(text, 'utf8'))
      socket.write(Buffer.from([IAC, GA]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const parsedTexts: string[] = []
    client.on('parsed', (lines: { text: string }[]) => {
      for (const line of lines) parsedTexts.push(line.text)
    })
    client.connect()

    const t0 = Date.now()
    const deadline = setTimeout(() => { /* timeout, assertions below will fail */ }, 2000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (parsedTexts.includes('在线提示')) {
          clearInterval(probe)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })
    const elapsed = Date.now() - t0

    expect(parsedTexts).toContain('在线提示')
    // GA 是提交边界, 应在 300ms 静默到期前就刷出。
    expect(elapsed).toBeLessThan(250)
    client.close()
    server.close()
  })

  it('GA 到达: 抛显式 boundary 事件 (R4, 命令-应答桥结算依据)', async () => {
    const server = net.createServer((socket) => {
      socket.write('在线提示')
      socket.write(Buffer.from([IAC, GA]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const boundaries: string[] = []
    client.on('boundary', (e: { kind: string }) => boundaries.push(e.kind))
    client.connect()

    const deadline = setTimeout(() => { /* timeout, assertions below will fail */ }, 2000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (boundaries.includes('ga')) {
          clearInterval(probe)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })

    expect(boundaries).toEqual(['ga'])
    client.close()
    server.close()
  })
})

describe('TelnetClient EOR 提交标志 (R4)', () => {
  it('EOR 到达: 与 GA 等价 — 无换行行尾立即刷出 + 抛 boundary 事件', async () => {
    const server = net.createServer((socket) => {
      socket.write('提示行无换行')
      socket.write(Buffer.from([IAC, EOR]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const parsedTexts: string[] = []
    const boundaries: string[] = []
    client.on('parsed', (lines: { text: string }[]) => {
      for (const line of lines) parsedTexts.push(line.text)
    })
    client.on('boundary', (e: { kind: string }) => boundaries.push(e.kind))
    client.connect()

    const t0 = Date.now()
    const deadline = setTimeout(() => { /* timeout, assertions below will fail */ }, 2000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (parsedTexts.includes('提示行无换行')) {
          clearInterval(probe)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })
    const elapsed = Date.now() - t0

    expect(parsedTexts).toContain('提示行无换行')
    // EOR 视同 GA: 静默到期前刷出。
    expect(elapsed).toBeLessThan(250)
    expect(boundaries).toEqual(['eor'])
    client.close()
    server.close()
  })
})

describe('TelnetClient 子协商超限丢弃 (R2)', () => {
  it('SB 载荷超过上限: 丢弃至下一个 IAC SE, 之后文本恢复可见', async () => {
    // 70KB 无 SE 的子协商 → 触发丢弃模式 (上限 64KB); 随后 IAC SE 恢复,
    // 后续文本 hello 必须可见。
    const oversized = Buffer.alloc(70 * 1024, 0x78) // 'x'
    const server = net.createServer((socket) => {
      socket.write(Buffer.concat([
        Buffer.from([IAC, SB, 42 /* CHARSET */]),
        oversized,
        Buffer.from([IAC, SE]),
        Buffer.from('恢复可见hello', 'utf8'),
      ]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const parsedTexts: string[] = []
    const logs: string[] = []
    client.on('parsed', (lines: { text: string }[]) => {
      for (const line of lines) parsedTexts.push(line.text)
    })
    client.on('log', (e: { level: string; text: string }) => logs.push(e.text))
    client.connect()

    const deadline = setTimeout(() => { /* timeout, assertions below will fail */ }, 2000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (parsedTexts.includes('恢复可见hello')) {
          clearInterval(probe)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })

    expect(parsedTexts).toContain('恢复可见hello')
    expect(logs.some(t => t.includes('子协商超限'))).toBe(true)
    client.close()
    server.close()
  })
})

describe('TelnetClient MCCP2 损坏恢复 (R3)', () => {
  it('压缩段损坏: 发 DONT COMPRESS2 + 关闭压缩, 后续明文照常解析', async () => {
    let serverSock: net.Socket | null = null
    const received: Buffer[] = []
    const server = net.createServer((socket) => {
      serverSock = socket
      socket.on('data', (chunk) => { received.push(chunk) })
      // 1. 激活 MCCP2 标记
      socket.write(Buffer.from([IAC, SB, 86 /* COMPRESS2 */, IAC, SE]))
      // 2. 损坏的压缩块 (0xff 填充: deflate BTYPE=3 保留值 → 必错; zlib 头亦无效)
      socket.write(Buffer.alloc(64, 0xff))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new TelnetClient({ host: '127.0.0.1', port })
    const texts: string[] = []
    client.on('text', (text: string) => texts.push(text))
    client.connect()

    // 等服务器收到 DONT COMPRESS2 (R3: 告知服务器停止压缩)。
    const deadline1 = setTimeout(() => { /* timeout, assertions below will fail */ }, 3000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        const found = received.some(b =>
          b.length >= 3 && b[0] === IAC && b[1] === DONT && b[2] === 86)
        if (found) {
          clearInterval(probe)
          clearTimeout(deadline1)
          resolve()
        }
      }, 10)
    })
    expect(received.some(b =>
      b.length >= 3 && b[0] === IAC && b[1] === DONT && b[2] === 86)).toBe(true)

    // 关压后: 服务器明文发送 → 客户端按普通文本解析 (R3 恢复路径, 连接继续可用)。
    serverSock?.write(Buffer.from('plain-recovered', 'utf8'))
    const deadline2 = setTimeout(() => { /* timeout, assertions below will fail */ }, 3000)
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (texts.join('').includes('plain-recovered')) {
          clearInterval(probe)
          clearTimeout(deadline2)
          resolve()
        }
      }, 10)
    })
    expect(texts.join('')).toContain('plain-recovered')
    client.close()
    server.close()
  })
})