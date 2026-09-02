/**
 * dsh-mud-core — Telnet 客户端 (Node `net` + `zlib`)。
 *
 * 协议面与 Python 项目的 MUDTelnetClient (telnetlib3) 对齐:
 *   - RFC 854 协商: ECHO / SGA / NAWS / TTYPE / CHARSET / BINARY
 *   - GMCP (201)、MSSP (70)、MSP (90)、MCCP2 (86)
 *   - 双向 UTF-8; ANSI 剥离; 完整逻辑行即时刷出
 *
 * MCCP2 模型 (解压器置于原始 telnet 解码器之前, 仅由压缩标记激活):
 *   - 原始解码器 (parseFeed/processBuffer) 永远只收到未压缩数据 —
 *     协议字节与游戏文本一视同仁;
 *   - 在标记 `IAC SB COMPRESS2 IAC SE` 出现之前, 一切字节都作为普通字符
 *     直接进入原始解码器;
 *   - 一旦见到该标记即启动解压器, 此后的每个字节先送解压器, 其输出再交还
 *     原始解码器;
 *   - 优先按 zlib 解压, 首个数据块失败时自动回退为裸 deflate (pkuxkx);
 *   - 解压出错则丢弃该数据流并记录日志。
 *
 * 事件: 'connect' | 'close' | 'error' | 'log' ({level,text}) |
 *        'text' (原始文本) | 'parsed' (ParsedLine[]) | 'gmcp' ({package, payload}) |
 *        'mssp' (pairs)
 * @module @deepseek-ai/dsh-mud-core/telnet
 */

import { EventEmitter } from 'node:events'
import net from 'node:net'
import zlib from 'node:zlib'
import { AnsiStreamParser, stripAnsi } from './ansi.ts'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const GA = 249
const SE = 240

const OPT = {
  BINARY: 0,
  ECHO: 1,
  SGA: 3,
  TTYPE: 24,
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
])

function escapeIac(bytes: Buffer): Buffer {
  if (!bytes.includes(IAC)) return bytes
  const out: number[] = []
  for (const b of bytes) {
    out.push(b)
    if (b === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}

/** TelnetClient 事件载荷。 */
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
  encoding?: string
  /** diagnostic hook: raw socket bytes before processing */
  onRawData?: (chunk: Buffer) => void
}

/** Telnet + GMCP/MCCP2 客户端。 */
export class TelnetClient extends EventEmitter {
  readonly host: string
  readonly port: number
  private readonly term: string
  private readonly cols: number
  private readonly rows: number
  private readonly onRawData: ((chunk: Buffer) => void) | undefined

  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0) // telnet parser buffer
  private mccp2 = false // compression active
  private inflate: zlib.Inflate | zlib.InflateRaw | null = null
  private inflateReady = false // format decided (raw fallback trigger)
  private inflateBuffered: Buffer | null = null
  /**
   * 流式行/ANSI 解析器: 只产出完整逻辑行, 跨块的行尾与半截转义序列缓存在
   * 内部 —— 保证感知层绝对行号稳定、规则匹配不被 TCP 块边界切碎。见 ansi.ts。
   */
  private readonly ansi = new AnsiStreamParser()
  /** 行尾静默定时器: 无换行的提示符行/片断在静默到期后刷出 (对齐 Mudlet posting timer)。 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** 行尾静默刷出延迟: 对齐 Mudlet cTelnet::mTimeOut = 300ms 的静默推送。 */
  private static readonly FLUSH_IDLE_MS = 300
  /** 主文本流解码器: 流式调用 (appendText), 跨包持有未完的多字节序列。 */
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  /**
   * 子协商专用解码器: 与主解码器严格分离。GMCP/CHARSET 载荷若复用主
   * 解码器, 其非流式 decode 会把主文本流中未收完的半个多字节字符强制
   * 冲刷成 U+FFFD 并重置状态 — 正文尾字节按新起点解码即产出错位乱码。
   */
  private readonly subDecoder = new TextDecoder('utf-8', { fatal: false })

  constructor(options: TelnetClientOptions) {
    super()
    this.host = options.host
    this.port = options.port
    this.term = options.term ?? 'XTERM-256COLOR'
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.onRawData = options.onRawData
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
      this.emit('connect')
    })
    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk))
    socket.on('error', (err: Error) => {
      this.log('error', `连接错误: ${err.message}`)
      this.emit('error', err)
    })
    socket.on('close', () => {
      // 连接收尾: 把未换行的行尾一并刷出 (断流处的提示符/半截行)。
      const tail = this.ansi.flush()
      if (tail !== null) this.emit('parsed', [tail])
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
    if (this.onRawData) {
      try { this.onRawData(chunk) } catch { /* diagnostic hook must not break the stream */ }
    }
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
      if (cmd === GA) {
        // pkuxkx 的提交标志: GA 表示"一段完整文字已发送完毕" (登录期不发送,
        // 一定是欢迎进入+上线地点房间描述+系统信息都显示完了才发一个)。作为
        // 提交边界: 立即把滞留的"无换行行尾"刷成完整行, 不必等 300ms 静默。
        const tail = this.ansi.flush()
        if (tail !== null) this.emit('parsed', [tail])
        this.emit('ga')
      }
      // NOP / GA / EOR / stray SE — skip two bytes.
      this.buffer = this.buffer.subarray(2)
    }
  }

  /** Locate IAC SE from `start`, honoring escaped IAC (IAC IAC) inside. */
  private findSubnegEnd(start: number): number {
    let i = start
    while (i < this.buffer.length - 1) {
      if (this.buffer[i] === IAC) {
        if (this.buffer[i + 1] === SE) return i
        i += 2
      } else {
        i += 1
      }
    }
    return -1
  }

  private appendText(buf: Buffer): void {
    const text = this.decoder.decode(buf, { stream: true })
    if (!text) return
    // 'text': RAW decoded text with ANSI escape sequences and control chars
    // preserved — the display channel (xterm) renders this verbatim.
    this.emit('text', text)
    // 'parsed': complete logical lines (text/raw/style views, abs 由行缓冲分配) —
    // the perception/agent feeds consume this. Partial line tails and half-cut
    // escape sequences stay buffered inside this.ansi until a newline or flush.
    const lines = this.ansi.write(text)
    if (lines.length > 0) {
      this.emit('parsed', lines)
    }
    // Mudlet 行尾静默推送模型 (对齐 cTelnet::slot_timerPosting / mTimeOut=300):
    // 完整行即时刷出, 只滞留"无换行的尾片断" (提示符等), 每收到新数据都重置
    // 300ms 静默计时, 静默到期后强制把片断刷成完整行 —— 否则横幅 + 登录提示
    // 同块到达时提示行会一直滞留到连接关闭, 感知/登录流程看不到它。
    this.scheduleFlush()
  }

  /** Flush a stalled no-newline tail as a complete (prompt) line (Mudlet posting timer)。 */
  private scheduleFlush(): void {
    if (!this.ansi.pending) {
      this.clearFlushTimer()
      return
    }
    // 每块数据重置静默计时: 片断在"最后一次到达后 300ms"刷出。
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const tail = this.ansi.flush()
      if (tail !== null) this.emit('parsed', [tail])
    }, TelnetClient.FLUSH_IDLE_MS)
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
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
    if (cmd === DONT) {
      return
    }
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
      const pairs: Record<string, string> = {}
      let key = ''
      let val = ''
      let isKey = true
      for (const b of data) {
        if (b === 0x01) { isKey = false; continue }
        if (b === 0x02) { pairs[key] = val; key = ''; val = ''; isKey = true; continue }
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
   * On a block error the block's tail is dropped; the NEXT marker restarts a
   * fresh block, so the stream recovers on its own.
   */
  private makeInflate(raw: boolean): zlib.Inflate | zlib.InflateRaw {
    const inf = raw ? zlib.createInflateRaw() : zlib.createInflate()
    inf.on('data', (out: Buffer) => {
      this.inflateReady = true
      this.inflateBuffered = null
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
      this.log('error', `MCCP2 段解压失败（${err.message}），本块尾部已丢弃`)
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
    this.clearFlushTimer()
    this.socket = null
    this.mccp2 = false
    this.inflate = null
    this.buffer = Buffer.alloc(0)
    this.inflateBuffered = null
    this.ansi.reset()
  }
}
