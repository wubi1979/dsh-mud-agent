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
import { TelnetClient } from '../src/telnet.ts'

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
})