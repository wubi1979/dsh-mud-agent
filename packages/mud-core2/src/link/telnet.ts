/**
 * mud-core2 link/telnet — telnet 协议层（存在层）。
 *
 * 沿用 mud-core 实录验证过的实现（Node `net` + `zlib`），只做协议解码：
 *   - RFC 854 协商: ECHO / SGA / NAWS / TTYPE / CHARSET / BINARY
 *   - GMCP (201)、MSSP (70)、MSP (90)、MCCP2 (86)
 *   - 双向 UTF-8; GA(249)/EOR(239) → 显式 boundary 事件（协议边界唯一出口）
 *
 * 与 mud-core 版的分工差异：**行/ANSI 解析不在本层** —— 本层只产出解码后的
 * 文本块（'text' 事件）与边界事件，AnsiStreamParser 由 Mud（mud.ts）持有，
 * GA/EOR 到达时由 Mud 先 flushLine 再消费边界（顺序在本层保证：先 text 后
 * boundary）。
 *
 * MCCP2 模型（解压器置于原始 telnet 解码器之前，仅由压缩标记激活）：
 *   - 标记 `IAC SB COMPRESS2 IAC SE` 之前一切字节都按普通字符进原始解码器；
 *   - 见标记即启动解压器，此后每个字节先送解压器，输出再交还原始解码器；
 *   - 优先按 zlib 解压，首个数据块失败时自动回退为裸 deflate（pkuxkx）；
 *   - 解压段损坏（对齐 Mudlet ctelnet.cpp）：关闭压缩、发 `IAC DONT COMPRESS2`、
 *     未消费尾部按明文重放 —— 连接继续可用。
 *
 * 协议加固（对齐 Mudlet MAX_TELNET_SUBNEGOTIATION_LENGTH）：子协商载荷超上限
 * 进丢弃模式 —— 内存有界、丢弃到下一个 IAC SE 后自愈。
 *
 * 事件: 'connect' | 'close' | 'error' | 'log' ({level,text}) |
 *        'text' (解码后的文本块) | 'boundary' ({kind: 'ga'|'eor'}) |
 *        'gmcp' ({package, payload}) | 'mssp' (pairs)
 *
 * 纯度纪律：本文件不 import 宿主；node 内建模块（net/zlib）不属宿主依赖。
 */

import { EventEmitter } from 'node:events'
import net from 'node:net'
import zlib from 'node:zlib'
import { stripAnsi } from './ansi.ts'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const GA = 249
const EOR = 239 // RFC 885 End of Record 命令字节（视同 GA 的提交边界）
const SE = 240

const OPT = {
  BINARY: 0,
  ECHO: 1,
  SGA: 3,
  TTYPE: 24,
  /** RFC 885 End of Record 选项（协商出 EOR 提交标志）。 */
  EOR: 25,
  NAWS: 31,
  CHARSET: 42,
  MSSP: 70,
  COMPRESS2: 86,
  MSP: 90,
  GMCP: 201,
} as const

/** Options we answer WILL with DO (accept server side), and DO with WILL (we send). */
const ACCEPT = new Set<number>([
  OPT.BINARY, OPT.ECHO, OPT.SGA, OPT.NAWS, OPT.TTYPE,
  OPT.CHARSET, OPT.MSSP, OPT.COMPRESS2, OPT.MSP, OPT.GMCP,
  OPT.EOR, // 服务器 WILL EOR → DO（低成本，pkuxkx 未用，通用 MUD 兼容）
])

/** 子协商载荷长度上限（对齐 Mudlet MAX_TELNET_SUBNEGOTIATION_LENGTH）。 */
const MAX_SUB_NEG_LENGTH = 64 * 1024

function escapeIac(bytes: Buffer): Buffer {
  if (!bytes.includes(IAC)) return bytes
  const out: number[] = []
  for (const b of bytes) {
    out.push(b)
    if (b === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}

/** GMCP 消息载荷。 */
export interface GmcpMessage {
  package: string
  payload: unknown
}

/** TelnetClient 构造参数。 */
export interface TelnetClientOptions {
  host: string
  port: number
  term?: string
  cols?: number
  rows?: number
}

/** Telnet + GMCP/MCCP2 客户端（协议层：字节 → 文本块 + 边界事件）。 */
export class TelnetClient extends EventEmitter {
  readonly host: string
  readonly port: number
  private readonly term: string
  private readonly cols: number
  private readonly rows: number

  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0) // telnet parser buffer
  private mccp2 = false // compression active
  private inflate: zlib.Inflate | zlib.InflateRaw | null = null
  private inflateReady = false // format decided (raw fallback trigger)
  private inflateBuffered: Buffer | null = null
  /** 子协商超限丢弃模式：丢弃到下一个 IAC SE 后恢复，内存有界。 */
  private discardingSubneg = false
  /** 已写入解压器但尚未产生输出的字节（错误恢复时明文重放；有界 4KB）。 */
  private mccp2Tail: Buffer | null = null
  /**
   * 主文本流解码器：流式调用，跨包持有未完的多字节序列。
   */
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  /**
   * 子协商专用解码器：与主解码器严格分离。GMCP/CHARSET 载荷若复用主
   * 解码器，其非流式 decode 会把主文本流中未收完的半个多字节字符强制
   * 冲刷成 U+FFFD 并重置状态 —— 正文尾字节按新起点解码即产出错位乱码。
   */
  private readonly subDecoder = new TextDecoder('utf-8', { fatal: false })

  constructor(options: TelnetClientOptions) {
    super()
    this.host = options.host
    this.port = options.port
    this.term = options.term ?? 'XTERM-256COLOR'
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.readyState === 'open'
  }

  connect(): this {
    if (this.socket) return this
    const socket = net.createConnection({ host: this.host, port: this.port })
    this.socket = socket
    socket.setNoDelay(true)
    socket.on('connect', () => {
      this.log('info', `已连接 ${this.host}:${this.port}`)
      this.sendSb(OPT.NAWS, [this.cols >> 8, this.cols & 0xff, this.rows >> 8, this.rows & 0xff])
      // 主动请求 EOR 提交标志（对齐 Mudlet DO EOR 协商）—— 覆盖"服务器不先
      // WILL"的通配终端（WILL EOR 已由 ACCEPT 集合应答）。
      this.writeCommand(DO, OPT.EOR)
      this.emit('connect')
    })
    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk))
    socket.on('error', (err: Error) => {
      this.log('error', `连接错误: ${err.message}`)
      this.emit('error', err)
    })
    socket.on('close', () => {
      this.cleanup()
      this.log('info', '连接已关闭')
      this.emit('close')
    })
    return this
  }

  close(): void {
    if (this.socket) this.socket.end()
  }

  /** Send one MUD command (line terminated, UTF-8, IAC-escaped). */
  send(text: string): boolean {
    if (!this.connected) return false
    this.socket?.write(Buffer.concat([
      escapeIac(Buffer.from(String(text), 'utf8')),
      Buffer.from('\r\n', 'ascii'),
    ]))
    return true
  }

  // ---------------------------------------------------------------------
  // Inbound path
  // ---------------------------------------------------------------------

  private onSocketData(chunk: Buffer): void {
    if (this.mccp2 && this.inflate) {
      // After the marker: EVERYTHING goes to the decompressor, no matter how
      // blocks or packets are divided.
      this.feedCompressed(chunk)
      return
    }
    // Before the marker: everything goes to the original decoder as plain
    // characters — negotiation, CHARSET, GMCP, text all handled here.
    this.parseFeed(chunk)
  }

  private parseFeed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.processBuffer()
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      // 丢弃模式: 只找下一个 IAC SE, 找到即恢复; 期间字节全部丢弃。
      if (this.discardingSubneg) {
        this.consumeDiscarding()
        continue
      }
      const idx = this.buffer.indexOf(IAC)
      if (idx === -1) {
        this.appendText(this.buffer)
        this.buffer = Buffer.alloc(0)
        break
      }
      if (idx > 0) {
        this.appendText(this.buffer.subarray(0, idx))
        this.buffer = this.buffer.subarray(idx)
      }
      if (this.buffer.length < 2) break
      const cmd = this.buffer[1]
      if (cmd === IAC) {
        this.appendText(Buffer.from([IAC]))
        this.buffer = this.buffer.subarray(2)
        continue
      }
      if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
        if (this.buffer.length < 3) break
        this.handleCommand(cmd, this.buffer[2] ?? 0)
        this.buffer = this.buffer.subarray(3)
        continue
      }
      if (cmd === SB) {
        const end = this.findSubnegEnd(2)
        if (end === -2) {
          // 子协商超限: 置丢弃模式, 丢弃至下一个 IAC SE 后恢复。
          // 期间文本不可见但内存有界、可自愈, 不无界吞后续文本。
          this.discardingSubneg = true
          this.log('info', '子协商超限, 丢弃至下一个 IAC SE')
          this.buffer = this.buffer.subarray(2) // 丢弃 SB + 选项字节
          this.consumeDiscarding()
          continue
        }
        if (end === -1) break
        const payload = this.buffer.subarray(2, end)
        this.buffer = this.buffer.subarray(end + 2)
        const option = payload[0] ?? 0
        this.handleSubnegotiation(payload)
        // ONLY when the COMPRESS2 marker just activated compression: whatever
        // remains in THIS chunk after the SE is compressed data, not telnet.
        if (this.mccp2 && this.inflate && option === OPT.COMPRESS2 && this.buffer.length > 0) {
          const rest = this.buffer
          this.buffer = Buffer.alloc(0)
          this.feedCompressed(rest)
        }
        continue
      }
      if (cmd === GA || cmd === EOR) {
        // 边界标志: GA(249) / EOR(239) = "一段完整文字已发送完毕"。pkuxkx
        // 每条命令回复末尾 1 个 GA、登录提示后亦有（2026-09-10 探针抓包）。
        // 协议边界唯一出口：先发滞留文本块（行流侧先 flushLine 再消费边界），
        // 再发显式 boundary 事件。
        this.buffer = this.buffer.subarray(2)
        this.emit('boundary', { kind: cmd === GA ? 'ga' : 'eor' })
        continue
      }
      // NOP / stray SE — skip two bytes.
      this.buffer = this.buffer.subarray(2)
    }
  }

  /** Locate IAC SE from `start`, honoring escaped IAC (IAC IAC) inside.
   *  - 正常返回 SE 位置; -1 = 未找到（等待更多数据）; -2 = 子协商超限。 */
  private findSubnegEnd(start: number): number {
    let i = start
    while (i < this.buffer.length - 1) {
      if (this.buffer[i] === IAC) {
        if (this.buffer[i + 1] === SE) return i
        i += 2
      } else {
        i += 1
      }
      if (i - start >= MAX_SUB_NEG_LENGTH) return -2
    }
    return -1
  }

  /** 子协商超限丢弃: 消费到下一个 IAC SE（honor IAC IAC）; 本块无 SE 则
   *  整块丢弃, 待下一块继续 — 内存有界。 */
  private consumeDiscarding(): void {
    for (let i = 0; i < this.buffer.length - 1; i += 1) {
      if (this.buffer[i] !== IAC) continue
      if (this.buffer[i + 1] === SE) {
        this.buffer = this.buffer.subarray(i + 2)
        this.discardingSubneg = false
        return
      }
      i += 1 // IAC IAC 转义: 吃掉第二个
    }
    this.buffer = Buffer.alloc(0)
  }

  private appendText(buf: Buffer): void {
    const text = this.decoder.decode(buf, { stream: true })
    if (!text) return
    this.emit('text', text)
  }

  // ---------------------------------------------------------------------
  // Negotiation
  // ---------------------------------------------------------------------

  private handleCommand(cmd: number, option: number): void {
    if (cmd === WILL) {
      if (ACCEPT.has(option)) {
        this.writeCommand(DO, option)
        if (option === OPT.COMPRESS2) this.log('info', 'MCCP2 协商：服务器请求压缩，已接受')
        if (option === OPT.GMCP) this.log('info', 'GMCP 协商：已接受')
      } else {
        this.writeCommand(DONT, option)
      }
      return
    }
    if (cmd === WONT) {
      if (option === OPT.ECHO) this.log('info', '服务器关闭回显（可能正在输入密码）')
      return
    }
    if (cmd === DO) {
      if (ACCEPT.has(option)) {
        this.writeCommand(WILL, option)
        if (option === OPT.NAWS) {
          this.sendSb(OPT.NAWS, [this.cols >> 8, this.cols & 0xff, this.rows >> 8, this.rows & 0xff])
        }
      } else {
        this.writeCommand(WONT, option)
      }
      return
    }
    // DONT: nothing to do.
  }

  private handleSubnegotiation(payload: Buffer): void {
    if (payload.length === 0) return
    const option = payload[0] ?? 0
    const data = payload.subarray(1)

    if (option === OPT.TTYPE) {
      if (data.length >= 1 && data[0] === 0x01 /* SEND */) {
        this.sendSb(OPT.TTYPE, [0x00 /* IS */, ...Buffer.from(this.term, 'ascii')])
      }
      return
    }
    if (option === OPT.CHARSET) {
      this.handleCharset(data)
      return
    }
    if (option === OPT.GMCP) {
      const text = stripAnsi(this.subDecoder.decode(data))
      const space = text.indexOf(' ')
      const pkg = space === -1 ? text : text.slice(0, space)
      const rest = space === -1 ? '' : text.slice(space + 1)
      let parsed: unknown = rest
      if (rest !== '') {
        try {
          parsed = JSON.parse(rest) as unknown
        } catch {
          parsed = rest
        }
      }
      this.emit('gmcp', { package: pkg, payload: parsed } satisfies GmcpMessage)
      return
    }
    if (option === OPT.MSSP) {
      // MSSP 线序: VAR(1) <key> VAL(2) <value> VAR(1) <key> VAL(2) <value> ...
      // VAR 后的字符段是键、VAL 后的是值；键值对在下一个 VAR 或结尾时收口。
      const pairs: Record<string, string> = {}
      let key = ''
      let val = ''
      let isKey = true
      for (const b of data) {
        if (b === 0x01 /* VAR */) {
          if (key !== '') pairs[key] = val
          key = ''
          val = ''
          isKey = true
          continue
        }
        if (b === 0x02 /* VAL */) {
          isKey = false
          continue
        }
        if (isKey) key += String.fromCharCode(b)
        else val += String.fromCharCode(b)
      }
      if (key !== '') pairs[key] = val
      this.emit('mssp', pairs)
      return
    }
    if (option === OPT.COMPRESS2) {
      this.startMccp2()
      return
    }
    // MSP (audio) and anything else: accepted, ignored.
  }

  private handleCharset(data: Buffer): void {
    // CHARSET subnegotiation: 1=REQUEST, 2=ACCEPTED, 3=REJECTED; then names.
    if (data.length === 0 || data[0] !== 0x01) return
    const names = this.subDecoder
      .decode(data.subarray(1))
      .split(/[ ,;]/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
    const picked = names.find(n => /^utf-?8$/i.test(n)) ?? names[0]
    if (picked) {
      this.log('info', `CHARSET 协商：接受 ${picked}`)
      this.sendSb(OPT.CHARSET, [0x02 /* ACCEPTED */, ...Buffer.from(picked, 'ascii')])
    }
  }

  // ---------------------------------------------------------------------
  // MCCP2
  // ---------------------------------------------------------------------

  private startMccp2(): void {
    this.mccp2 = true
    this.inflateReady = false
    this.inflateBuffered = null
    this.inflate = this.makeInflate(false) // try zlib-wrapped first (RFC 1950)
    this.log('info', 'MCCP2 压缩流已激活')
  }

  /**
   * One decompressor PER block (restarted at each marker). The MCCP2 spec says
   * zlib, but pkuxkx/FluffOS sends RAW deflate (RFC 1951): if the zlib attempt
   * fails before any output, replay the buffered bytes into a raw inflater.
   * On a block error AFTER the format is decided（对齐 Mudlet）: 关闭压缩
   * (mccp2=false, inflate=null)、发 `IAC DONT COMPRESS2`、把未消费尾部按明文
   * 重放 — 最多显示乱码, 连接继续可用, 不再自损坏点起永久静默。
   */
  private makeInflate(raw: boolean): zlib.Inflate | zlib.InflateRaw {
    const inf = raw ? zlib.createInflateRaw() : zlib.createInflate()
    inf.on('data', (out: Buffer) => {
      this.inflateReady = true
      this.inflateBuffered = null
      this.mccp2Tail = null // 已产出输出 → 尾部已消费
      this.parseFeed(out)
    })
    inf.on('error', (err: Error) => {
      if (!this.inflateReady && !raw) {
        const replay = this.inflateBuffered
        this.inflateBuffered = null
        this.log('info', `MCCP2 检测到 raw deflate 流（${err.message}），已切换`)
        this.inflate = this.makeInflate(true)
        if (replay) this.inflate.write(replay)
        return
      }
      // 段损坏（格式已定 / raw 也失败）→ 关压 + DONT + 明文重放尾部。
      const tail = this.mccp2Tail
      this.log('error', `MCCP2 段解压失败（${err.message}）→ 关闭压缩, 明文重放尾部`)
      this.mccp2 = false
      this.inflate = null
      this.inflateReady = false
      this.inflateBuffered = null
      this.mccp2Tail = null
      this.writeCommand(DONT, OPT.COMPRESS2)
      if (tail && tail.length > 0) this.parseFeed(tail)
    })
    return inf
  }

  /** Feed compressed bytes to the current block's decompressor. */
  private feedCompressed(chunk: Buffer): void {
    if (!this.inflateReady) {
      this.inflateBuffered = this.inflateBuffered
        ? Buffer.concat([this.inflateBuffered, chunk])
        : chunk
    }
    // 记录"已写入但尚未产生输出"的尾部（错误恢复时明文重放；有界 4KB）。
    this.mccp2Tail = this.mccp2Tail
      ? Buffer.concat([this.mccp2Tail, chunk]).subarray(-4096)
      : chunk.length > 4096 ? chunk.subarray(-4096) : chunk
    this.inflate?.write(chunk)
  }

  // ---------------------------------------------------------------------
  // Outbound helpers
  // ---------------------------------------------------------------------

  private writeCommand(cmd: number, option: number): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(Buffer.from([IAC, cmd, option]))
    }
  }

  private sendSb(option: number, data: readonly number[]): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(Buffer.concat([
        Buffer.from([IAC, SB, option]),
        Buffer.from(data),
        Buffer.from([IAC, SE]),
      ]))
    }
  }

  private log(level: 'info' | 'error', text: string): void {
    this.emit('log', { level, text })
  }

  private cleanup(): void {
    this.socket = null
    this.mccp2 = false
    this.inflate = null
    this.buffer = Buffer.alloc(0)
    this.inflateBuffered = null
    this.mccp2Tail = null
    this.discardingSubneg = false
  }
}
