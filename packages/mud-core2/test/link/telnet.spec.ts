/**
 * link/telnet 回放测试 — 协议层：边界事件 / 文本解码 / 子协商超限自愈 / 发送转义。
 *
 * 语料沿自 mud-core 实录（2026-09-10 探针抓包 + pkuxkx 语料）：横幅 + 无换行
 * 登录提示、GA 提交标志、子协商洪水。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { TelnetClient } from '../../src/link/telnet.ts'

const IAC = 255
const DONT = 254
const GA = 249
const EOR = 239
const SB = 250
const SE = 240

/** 无 socket 单元驱动：注入假 socket 捕获出站字节，onSocketData 直接喂入站字节。 */
function unitClient(): {
  client: TelnetClient
  feed: (bytes: Array<number> | Buffer) => void
  outbound: () => Buffer
} {
  const sent: Buffer[] = []
  const client = new TelnetClient({ host: '127.0.0.1', port: 1 })
  ;(client as unknown as { socket: unknown }).socket = {
    write: (b: Buffer) => sent.push(b),
    destroyed: false,
  }
  return {
    client,
    feed: (bytes) => {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      ;(client as unknown as { onSocketData: (b: Buffer) => void }).onSocketData(buf)
    },
    outbound: () => Buffer.concat(sent),
  }
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('TelnetClient 边界事件', () => {
  it('GA 到达: 抛显式 boundary 事件 (协议边界唯一出口)', async () => {
    const server = net.createServer((socket) => {
      socket.write('在线提示')
      socket.write(Buffer.from([IAC, GA]))
    })
    const port = await listen(server)
    const client = new TelnetClient({ host: '127.0.0.1', port })
    const boundaries: string[] = []
    const texts: string[] = []
    client.on('boundary', (b: { kind: string }) => boundaries.push(b.kind))
    client.on('text', (t: string) => texts.push(t))
    client.connect()
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (boundaries.length > 0) { clearInterval(probe); resolve() }
      }, 10)
    })
    expect(boundaries).toEqual(['ga'])
    expect(texts.join('')).toBe('在线提示')
    client.close()
    server.close()
  })

  it('EOR 到达: 同样抛 boundary 事件, kind=eor', async () => {
    const server = net.createServer((socket) => {
      socket.write('帧内容')
      socket.write(Buffer.from([IAC, EOR]))
    })
    const port = await listen(server)
    const client = new TelnetClient({ host: '127.0.0.1', port })
    const boundaries: string[] = []
    client.on('boundary', (b: { kind: string }) => boundaries.push(b.kind))
    client.connect()
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (boundaries.length > 0) { clearInterval(probe); resolve() }
      }, 10)
    })
    expect(boundaries).toEqual(['eor'])
    client.close()
    server.close()
  })

  it('文本与边界顺序: text 事件先于 boundary 事件 (行先于边界)', async () => {
    const server = net.createServer((socket) => {
      socket.write('横幅\n在线提示')
      socket.write(Buffer.from([IAC, GA]))
    })
    const port = await listen(server)
    const client = new TelnetClient({ host: '127.0.0.1', port })
    const seq: string[] = []
    client.on('text', (t: string) => seq.push(`text:${t}`))
    client.on('boundary', () => seq.push('boundary'))
    client.connect()
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (seq.includes('boundary')) { clearInterval(probe); resolve() }
      }, 10)
    })
    expect(seq.indexOf('text:横幅\n在线提示')).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('boundary')).toBe(seq.length - 1)
    client.close()
    server.close()
  })
})

describe('TelnetClient 协议加固', () => {
  it('子协商超限: 丢弃到 IAC SE 后自愈, 后续文本照常解码', async () => {
    const server = net.createServer((socket) => {
      // 超限子协商（无 SE）+ 洪水 + 合法 SE 结尾 + 恢复后的正常文本
      socket.write(Buffer.from([IAC, SB, 201]))
      socket.write(Buffer.alloc(70 * 1024, 0x41))
      socket.write(Buffer.from([IAC, SE]))
      socket.write('恢复正常\r\n')
    })
    const port = await listen(server)
    const client = new TelnetClient({ host: '127.0.0.1', port })
    const texts: string[] = []
    client.on('text', (t: string) => texts.push(t))
    client.connect()
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (texts.join('').includes('恢复正常')) { clearInterval(probe); resolve() }
      }, 10)
    })
    expect(texts.join('')).not.toContain('A'.repeat(1024))
    client.close()
    server.close()
  })
})

describe('TelnetClient 发送', () => {
  it('命令发送: 行终止 + IAC 转义 (对端收到原样字节)', async () => {
    const received: Buffer[] = []
    const server = net.createServer((socket) => {
      socket.on('data', (d: Buffer) => received.push(d))
    })
    const port = await listen(server)
    const client = new TelnetClient({ host: '127.0.0.1', port })
    client.connect()
    await new Promise<void>(resolve => server.on('connection', () => resolve()))
    // 等客户端 socket 建立完成
    for (let i = 0; i < 50 && !client.connected; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(client.send('look')).toBe(true)
    expect(client.send('say 你好')).toBe(true) // UTF-8 透传（字符串 API 天然无法注入裸 IAC）
    // 轮询等待两条命令字节（连接首字节是协商序列）
    const all = await new Promise<Buffer>((resolve, reject) => {
      const t0 = Date.now()
      const probe = setInterval(() => {
        const buf = Buffer.concat(received)
        if (buf.includes(Buffer.from('look\r\n', 'ascii')) && buf.includes(Buffer.from('say 你好\r\n', 'utf8'))) {
          clearInterval(probe)
          resolve(buf)
        } else if (Date.now() - t0 > 2000) {
          clearInterval(probe)
          reject(new Error(`对端 2s 内未收全命令字节; 实收 ${buf.length} 字节`))
        }
      }, 10)
    })
    // 连接首字节是协商序列（NAWS/DO EOR/WILL...），命令按子串查找
    const lookAt = all.indexOf(Buffer.from('look\r\n', 'ascii'))
    expect(lookAt).toBeGreaterThanOrEqual(0)
    expect(all.indexOf(Buffer.from('say 你好\r\n', 'utf8'))).toBeGreaterThan(lookAt)
    client.close()
    server.close()
  })
})

describe('TelnetClient 子协商四协议', () => {
  it('TTYPE SEND: 回 IS + 终端类型 (IAC SB 24 0 <term> IAC SE)', () => {
    const { feed, outbound } = unitClient()
    feed([IAC, SB, 24 /* TTYPE */, 0x01 /* SEND */, IAC, SE])
    const reply = outbound()
    const expected = Buffer.concat([
      Buffer.from([IAC, SB, 24, 0x00 /* IS */]),
      Buffer.from('XTERM-256COLOR', 'ascii'),
      Buffer.from([IAC, SE]),
    ])
    expect(reply.includes(expected)).toBe(true)
  })

  it('CHARSET REQUEST: 选 utf-8 并回 ACCEPTED (IAC SB 42 2 <name> IAC SE)', () => {
    const { feed, outbound } = unitClient()
    // 请求列出多个候选, 客户端只应选 utf-8。
    const payload = Buffer.concat([
      Buffer.from([0x01 /* REQUEST */]),
      Buffer.from('GBK;UTF-8;BIG5', 'ascii'),
    ])
    feed(Buffer.concat([
      Buffer.from([IAC, SB, 42 /* CHARSET */]),
      payload,
      Buffer.from([IAC, SE]),
    ]))
    const reply = outbound()
    const expected = Buffer.concat([
      Buffer.from([IAC, SB, 42, 0x02 /* ACCEPTED */]),
      Buffer.from('UTF-8', 'ascii'),
      Buffer.from([IAC, SE]),
    ])
    expect(reply.includes(expected)).toBe(true)
    expect(reply.includes(Buffer.from('GBK', 'ascii'))).toBe(false)
  })

  it('GMCP: 包名 + JSON 载荷解析为 gmcp 事件', () => {
    const { client, feed } = unitClient()
    const messages: Array<{ package: string, payload: unknown }> = []
    client.on('gmcp', (m: { package: string, payload: unknown }) => messages.push(m))
    const payload = Buffer.from('Core.Hello {"name":"pkuxkx"}', 'utf8')
    feed(Buffer.concat([
      Buffer.from([IAC, SB, 201 /* GMCP */]),
      payload,
      Buffer.from([IAC, SE]),
    ]))
    expect(messages).toEqual([{ package: 'Core.Hello', payload: { name: 'pkuxkx' } }])
  })

  it('GMCP: 非 JSON 载荷保留为字符串; 无载荷为空串', () => {
    const { client, feed } = unitClient()
    const messages: Array<{ package: string, payload: unknown }> = []
    client.on('gmcp', (m: { package: string, payload: unknown }) => messages.push(m))
    feed(Buffer.concat([
      Buffer.from([IAC, SB, 201]),
      Buffer.from('Char.Login {bad json', 'utf8'),
      Buffer.from([IAC, SE]),
    ]))
    feed(Buffer.concat([
      Buffer.from([IAC, SB, 201]),
      Buffer.from('Core.Ping', 'utf8'),
      Buffer.from([IAC, SE]),
    ]))
    expect(messages[0]).toEqual({ package: 'Char.Login', payload: '{bad json' })
    expect(messages[1]).toEqual({ package: 'Core.Ping', payload: '' })
  })

  it('MSSP: VAR/VAL 键值对解析为 mssp 事件', () => {
    const { client, feed } = unitClient()
    const received: Array<Record<string, string>> = []
    client.on('mssp', (pairs: Record<string, string>) => received.push(pairs))
    // MSSP_VAR(1) NAME MSSP_VAL(2) PKUXKX MSSP_VAR(1) PORT MSSP_VAL(2) 23
    feed(Buffer.concat([
      Buffer.from([IAC, SB, 70 /* MSSP */]),
      Buffer.from([0x01]), Buffer.from('NAME', 'ascii'), Buffer.from([0x02]), Buffer.from('PKUXKX', 'ascii'),
      Buffer.from([0x01]), Buffer.from('PORT', 'ascii'), Buffer.from([0x02]), Buffer.from('23', 'ascii'),
      Buffer.from([IAC, SE]),
    ]))
    expect(received).toEqual([{ NAME: 'PKUXKX', PORT: '23' }])
  })
})

describe('TelnetClient MCCP2 (单元驱动)', () => {
  async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('waitFor 超时')
      await new Promise(r => setTimeout(r, 10))
    }
  }

  it('压缩段损坏: 发 DONT COMPRESS2 + 关闭压缩, 后续明文照常解析 (R3, 移植)', async () => {
    const { client, feed, outbound } = unitClient()
    const texts: string[] = []
    client.on('text', (t: string) => texts.push(t))
    // 1. 激活 MCCP2 标记
    feed([IAC, SB, 86 /* COMPRESS2 */, IAC, SE])
    // 2. 损坏的压缩块 (0xff 填充: zlib 头无效 → 回退 raw 也必错 BTYPE=3 保留值)
    feed(Buffer.alloc(64, 0xff))
    // 3. 断言出站含 IAC DONT COMPRESS2 (R3: 告知服务器停止压缩)
    await waitFor(() => outbound().includes(Buffer.from([IAC, DONT, 86])))
    expect(outbound().includes(Buffer.from([IAC, DONT, 86]))).toBe(true)
    // 4. 关压后明文照常解析 (R3 恢复路径, 连接继续可用)
    feed(Buffer.from('plain-recovered', 'utf8'))
    expect(texts.join('')).toContain('plain-recovered')
  })

  it('zlib 头失败回退裸 deflate (pkuxkx): raw deflate 内容解出', async () => {
    const { client, feed } = unitClient()
    const texts: string[] = []
    client.on('text', (t: string) => texts.push(t))
    feed([IAC, SB, 86, IAC, SE])
    // 直接喂裸 deflate 流：其首字节按 zlib 头解读时 CMF.CM ≠ 8 → zlib 必错
    // → 回退 raw deflate 重放同一串字节 → 原样解出。
    feed(zlib.deflateRawSync('MCCP2-RAW-FALLBACK-OK'))
    await waitFor(() => texts.join('').includes('MCCP2-RAW-FALLBACK-OK'))
    expect(texts.join('')).toContain('MCCP2-RAW-FALLBACK-OK')
  })
})
