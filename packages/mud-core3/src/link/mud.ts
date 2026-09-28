/**
 * mud-core3 link/mud — 连接层核心：连接、行流分发。
 *
 * 从 mud-core2 link/mud.ts 瘦身而来：去掉 read 竞速机（Holder / WaitOpts /
 * ReadResult / read / abortWait / 有界缓冲 / 判定序），只保留连接管理与行流
 * 分发。竞速机是工具面（mud_send / mud_state）的依赖，第一期无工具面故不需要。
 *
 * 职责：
 *   - socket → telnet.decode → line.write → 逐行 onLine（推送式）；
 *   - GA/EOR 由 telnet 提取为边界事件，到达时先 flushLine 再消费边界；
 *   - send 不占行流（反射/直发共用，不阻塞）；
 *   - 断线 = socket close：flush 残留行 → onDisconnect 钩子上抛；
 *   - 重连（再次 connect）：parser.reset（行缓冲/样式游标复位）。
 *
 * 纯度纪律：本文件不 import 宿主。
 */

import { AnsiStreamParser, type MudLine } from './line.ts'
import { TelnetClient } from './telnet.ts'

/** 行尾静默刷出延迟：对齐 Mudlet cTelnet::mTimeOut = 300ms 的静默推送。 */
const FLUSH_IDLE_MS = 300

/** 连接层核心。 */
export class Mud {
  private conn: TelnetClient | null = null
  private readonly parser = new AnsiStreamParser()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  /** 记错通道（缓冲超限等；语料可见）。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null
  /** 每行钩子：行流到达即回调（推送式，与谁在等无关）。 */
  onLine: ((line: MudLine) => void) | null = null
  /** 边界钩子（GA/EOR；行尾已先 flush 分发）。 */
  onBoundary: ((kind: 'ga' | 'eor') => void) | null = null
  /** 断线钩子：装配层接此复位世界状态 / 标记断开。 */
  onDisconnect: (() => void) | null = null
  /** 直发观测钩子：send 成功后以命令原文回调。凭据走 sendCredential 不触发。 */
  onSend: ((cmd: string) => void) | null = null

  get connected(): boolean {
    return this.conn?.connected ?? false
  }

  /** 建连（幂等）。重连时复位 parser（行缓冲/样式游标），但 abs 连续递增不归零。 */
  connect(host: string, port: number): void {
    if (this.conn?.connected) return
    this.parser.reset()
    const conn = new TelnetClient({ host, port })
    this.conn = conn
    conn.on('text', (text: string) => this.onText(text))
    conn.on('boundary', (b: { kind: 'ga' | 'eor' }) => this.onBoundaryEvent(b.kind))
    conn.on('close', () => this.onClose())
    conn.on('error', (err: Error) => this.onLog?.('error', `连接错误: ${err.message}`))
    conn.on('log', (l: { level: 'info' | 'error', text: string }) => this.onLog?.(l.level, l.text))
    conn.connect()
  }

  /** 断连（幂等）：走 socket 关闭 → 'close' 事件 → onClose 钩子链。 */
  disconnect(): void {
    this.conn?.close()
  }

  /** 直发：不占行流、不做任何判据。未连接返回 false。成功才触发 onSend。 */
  send(cmd: string): boolean {
    const ok = this.conn?.send(cmd) ?? false
    if (ok) this.onSend?.(cmd)
    return ok
  }

  /** 凭据专用直发（login 发 name/pass）：行为同 send，但不触发 onSend。 */
  sendCredential(cmd: string): boolean {
    return this.conn?.send(cmd) ?? false
  }

  /** 断开（session/disposed 等装配层生命周期用）。 */
  close(): void {
    this.conn?.close()
  }

  // ---------------------------------------------------------------------
  // 行流路径
  // ---------------------------------------------------------------------

  private onText(text: string): void {
    const lines = this.parser.write(text)
    this.dispatchBatch(lines)
    this.scheduleFlush()
  }

  private onBoundaryEvent(kind: 'ga' | 'eor'): void {
    // GA/EOR 是提交边界：滞留的无换行尾行先刷出分发，再消费边界。
    this.clearFlushTimer()
    const tail = this.parser.flushLine()
    if (tail !== null) this.dispatchBatch([tail])
    this.onBoundary?.(kind)
  }

  private onClose(): void {
    this.clearFlushTimer()
    // 断流处的提示符/半截行一并刷出分发（不丢行）。
    const tail = this.parser.flush()
    if (tail !== null) this.dispatchBatch([tail])
    this.onDisconnect?.()
  }

  /** 一批行分发：每行直接回调 onLine。 */
  private dispatchBatch(lines: MudLine[]): void {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === undefined) continue
      this.onLine?.(line)
    }
  }

  /** 行尾静默刷出（对齐 Mudlet posting timer）：完整行即时分发，只滞留
   *  无换行的尾片断，静默到期强制刷成完整行。 */
  private scheduleFlush(): void {
    if (!this.parser.pending) {
      this.clearFlushTimer()
      return
    }
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const tail = this.parser.flushLine()
      if (tail !== null) this.dispatchBatch([tail])
    }, FLUSH_IDLE_MS)
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
}
