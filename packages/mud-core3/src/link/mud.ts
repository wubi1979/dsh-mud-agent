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
 * 连接代次（epoch）：`connect`/`disconnect` 都自增代次，事件回调只在代次未变时生效。
 * socket 的半开关闭是异步的（`end()` 要等对端 FIN 才真正关闭），旧连接晚到的
 * text/boundary/close 若不加代次判定，会把已经建立的新连接标记成断开。
 *
 * 纯度纪律：本文件不 import 宿主。
 */

import { AnsiStreamParser, type MudLine } from './line.ts'
import { TelnetClient, type GmcpMessage } from './telnet.ts'
import { Keepalive, type KeepaliveOptions, type ProbeState } from './keepalive.ts'

/** 行尾静默刷出延迟：对齐 Mudlet cTelnet::mTimeOut = 300ms 的静默推送。 */
const FLUSH_IDLE_MS = 300

/** 探活参数缺省（T12 D2 刻度：90s 首发 / 9s 重发 / 3 次上限 = 117s 判死）。 */
const DEFAULT_KEEPALIVE: KeepaliveOptions = { startMs: 90_000, retryMs: 9_000, maxAttempts: 3 }

/** Mud 构造选项（探活刻度与 busy 谓词可覆盖；缺省取内置缺省）。 */
export interface MudOptions {
  /** 半开探活参数（Config probeStartMs/probeRetryMs/probeMaxAttempts 注入面）。 */
  keepalive?: KeepaliveOptions
  /** busy 谓词（T12 D4：holderBusy || isInTurn，runtime 合成注入）——为真的探测
   *  tick 跳过（不发 AYT 不耗次数；AYT 应答 GA 会截断在途 read 等待窗）。 */
  isBusy?: () => boolean
}

/** 连接层核心。 */
export class Mud {
  private conn: TelnetClient | null = null
  private readonly parser = new AnsiStreamParser()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** 连接代次：建连/断连自增；旧连接晚到的事件按代次丢弃。 */
  private epoch = 0
  /** 半开探活器（T12 静默伴随自驱）：行/边界观测兼判活 + 取消，判死即硬收尾。 */
  private readonly keepalive: Keepalive

  constructor(options: MudOptions = {}) {
    this.keepalive = new Keepalive({
      // AYT 直写（TelnetClient.sendAyt）；未连接 → false → 判死。
      send: () => {
        const ok = this.conn?.sendAyt() ?? false
        if (ok) this.onLog?.('info', `探活：已发送 AYT（第 ${this.keepalive.attempts} 次）`)
        return ok
      },
      // 判死：走 disconnect 硬收尾（onDisconnect 链 → P4 复位 → T5.2 自动重连）。
      // 判活 link 内部消化（T12 D3，无上报回调）——上层只消费断开事实。
      onDead: (attempts: number) => {
        this.onLog?.('error', `探活判死：${attempts} 次无应答，连接判死走自动重连`)
        this.disconnect()
      },
      // busy 谓词（T12 D4）：busy 的探测 tick 跳过（不发 AYT 不耗次数）。
      ...(options.isBusy === undefined ? {} : { isBusy: options.isBusy }),
    }, options.keepalive ?? DEFAULT_KEEPALIVE)
  }

  /** 记错通道（缓冲超限等；语料可见）。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null
  /** 每行钩子：行流到达即回调（推送式，与谁在等无关）。 */
  onLine: ((line: MudLine) => void) | null = null
  /** 边界钩子（GA/EOR；行尾已先 flush 分发）。 */
  onBoundary: ((kind: 'ga' | 'eor') => void) | null = null
  /** 断线钩子：装配层接此复位世界状态 / 标记断开。 */
  onDisconnect: (() => void) | null = null
  /** GMCP 子协商钩子（三期状态地基：世界状态写入源；payload 已按 JSON 尽力解析）。 */
  onGmcp: ((msg: GmcpMessage) => void) | null = null
  /** 直发观测钩子：send 成功后以命令原文+来源回调。凭据走 sendCredential 不触发。 */
  onSend: ((cmd: string, source: 'agent' | 'user') => void) | null = null

  get connected(): boolean {
    return this.conn?.connected ?? false
  }

  /** 探活观测态（只读透传；不回写 conn 三态）。 */
  get probeState(): ProbeState {
    return this.keepalive.state
  }

  /** 建连（幂等）。重连时复位 parser（行缓冲/样式游标），但 abs 连续递增不归零。 */
  connect(host: string, port: number): void {
    // 探活取消点（T5.1/T12 D7）：手工/自动建连取消在飞探测，防与 AYT 重发/判死
    // 竞速。已连接的幂等建连同样取消（手工动作优先于探测窗口）。
    this.keepalive.cancel()
    if (this.conn?.connected) return
    // 探活静默锚 = 建连时刻（T12 D1）：此后零数据到达也会按窗口推进探测；
    // 建连失败经 close 收尾路径再次取消。首个服务端横幅到达即重置锚。
    this.keepalive.armIdle()
    // 上一次连接可能还在半开/收尾中：作废旧代次并立即销毁，
    // 否则它的 text/close 回调会落到新连接上（把新连接判成断开）。
    this.clearFlushTimer()
    const stale = this.conn
    this.conn = null
    stale?.destroy()
    const epoch = (this.epoch += 1)

    this.parser.reset()
    const conn = new TelnetClient({ host, port })
    this.conn = conn
    conn.on('text', (text: string) => { if (this.epoch === epoch) this.onText(text) })
    conn.on('boundary', (b: { kind: 'ga' | 'eor' }) => {
      if (this.epoch === epoch) this.onBoundaryEvent(b.kind)
    })
    conn.on('gmcp', (msg: GmcpMessage) => {
      if (this.epoch === epoch) this.onGmcp?.(msg)
    })
    conn.on('close', () => {
      if (this.epoch !== epoch) return
      // 连接已终结：清引用并作废代次，后续 disconnect 不会重复收尾。
      this.conn = null
      this.epoch += 1
      this.onClose()
    })
    conn.on('error', (err: Error) => {
      if (this.epoch === epoch) this.onLog?.('error', `连接错误: ${err.message}`)
    })
    conn.on('log', (l: { level: 'info' | 'error', text: string }) => {
      if (this.epoch === epoch) this.onLog?.(l.level, l.text)
    })
    conn.connect()
  }

  /**
   * 断连（幂等）：立即销毁 socket 并同步走完收尾（flush 残留行 → onDisconnect），
   * 不等对端 FIN —— 否则"已断开"的连接仍会继续收数据，且其迟到的 close 会污染后续连接。
   */
  disconnect(): void {
    const conn = this.conn
    // 探活取消点（T5.1）：断连（手工/判死收尾）取消在飞探测。
    this.keepalive.cancel()
    if (conn === null) return
    this.conn = null
    this.epoch += 1
    conn.destroy()
    this.onClose()
  }

  /** 直发：不占行流、不做任何判据。未连接返回 false。成功才触发 onSend（source 区分回显样式）。 */
  send(cmd: string, source: 'agent' | 'user' = 'agent'): boolean {
    const ok = this.conn?.send(cmd) ?? false
    if (ok) this.onSend?.(cmd, source)
    return ok
  }

  /** 凭据专用直发（login 发 name/pass）：行为同 send，但不触发 onSend。 */
  sendCredential(cmd: string): boolean {
    return this.conn?.send(cmd) ?? false
  }

  /** 断开（session/disposed 等装配层生命周期用）：与 disconnect 同一收尾路径。 */
  close(): void {
    this.disconnect()
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
    // 探活观测（T5.1）：GA 是 AYT 应答的主判活路径（应答常不带换行，GA 先到）。
    this.keepalive.observeBoundary()
    this.onBoundary?.(kind)
  }

  private onClose(): void {
    this.clearFlushTimer()
    // socket close（服务端 EOF/对端关闭）也取消在飞探测（判死路径已 cancel，幂等）。
    this.keepalive.cancel()
    // 断流处的提示符/半截行一并刷出分发（不丢行）。
    const tail = this.parser.flush()
    if (tail !== null) this.dispatchBatch([tail])
    this.onDisconnect?.()
  }

  /** 一批行分发：先经探活吞行判定，再逐行回调 onLine。 */
  private dispatchBatch(lines: MudLine[]): void {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === undefined) continue
      // T5.1 吞行判定：命中 AYT 应答判据的行吞掉（不进 pendingLines/画面/
      // 投递/onActivity）；探测中任意行同时判活（observeLine 内处理）。
      if (this.keepalive.observeLine(line.text)) continue
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
