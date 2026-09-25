/**
 * mud-core2 link/mud — 存在层核心：连接、行流分发、持有者、read 竞速机。
 *
 * 职责（impl §3.1/§3.2）：
 *   - socket → telnet.decode → ansi.write → 逐行 onLine（推送式，不新建循环）；
 *   - GA/EOR 由 telnet 提取为边界事件（协议边界唯一出口），到达时先 flushLine
 *     再消费边界；
 *   - **行分发顺序**：每行先意识层（onLine 永远执行，与谁在等无关，含缓冲态
 *     到达的行），再归 wait —— 意识层永远看得见行流，"永续供给"的实现；
 *     onLine 返回 'swallow' 即吞触发行（不进 acc/缓冲，反射"吞触发行、留结果"；
 *     语料与日志始终保留全部行，由接线层在钩子内自记）；
 *   - **send 不占行流**：反射永不被持有者阻塞；
 *   - **持有者是会话级的**（单 MUD 连接唯一）：并发 read fail loud（不做队列）
 *     —— 根与子级都持有全套工具，并发读会各拿半截行；
 *   - **read 必须响应 signal 并自带 timeoutMs**：唯一的**释放阀门** —— 工具不
 *     响应中止，子级就永远无法到达 quiescence，占着激活槽不放；
 *   - 有界缓冲（512 行 / 64KB，超限丢最旧记错）—— OOM 阀门；
 *   - 断线 = socket close：在途 read 以 'disconnected' 收束、持有者释放、
 *     onDisconnect 钩子上抛（危险 latch 醒根、登录标志复位由装配层接线）；
 *   - 重连（再次 connect）：行缓冲/样式游标复位（parser.reset），**abs 连续
 *     递增不归零**（行号空间是 Mud 生命周期的，跨重连不复用，避免行号碰撞）。
 *
 * 判定序（写死，impl §3.2）：同步关窗序 **failOn > until > gaCount > maxLines**
 * （maxLines 与 gaCount 同属同步关窗、排末位）；quietMs/timeoutMs 是**异步**
 * 收束源（计时器到点），与同步判据竞速。danger 不在本层测 —— 意识层在
 * onLine 钩子里同步判（与意识层同一份 danger.ts），命中即 abortWait('danger')。
 * 声明了 until 却未见完成句收场 → 记 error（判据失配要吵，语料可见）。
 * 失配按**关窗者**判（impl §3.2）：quiet/timeout 收场、或被 **maxLines** 剪断
 * （done 且命中来源为 maxLines）而 until 未命中 —— 都算失配；**GA/EOR 边界
 * 关窗（gaCount 命中）不算失配**（mud_flow({id}) 缺省 gaCount=1，完成句未到
 * 而边界先到是正常收束，不是判据写错）；danger/signal/disconnected/failOn
 * 是外部中断或负面命中，不吵。
 *
 * rest 同帧移交：判据命中那一刻，同帧尚未分发的剩余行不经 wait 累积，移交回
 * 缓冲（下一次 read 先消费）并随 ReadResult.rest 返回。
 *
 * 禁令：不解释语义、不做危险判断（判据在 awareness/danger）、竞速机不持有
 * 业务状态（不记世界、不做唤醒决策）。
 *
 * 纯度纪律：本文件不 import 宿主。
 */

import { AnsiStreamParser, type MudLine } from './ansi.ts'
import { TelnetClient } from './telnet.ts'

/** 行流持有者身份（fail-loud 用；会话级唯一，单 MUD 连接至多一个）。 */
export type Holder = 'root' | `child:${string}`

/** read 收束原因（impl §3.1 ReadResult）。 */
export type ReadReason =
  | 'done'          // until / gaCount / maxLines 判据满足
  | 'failOn'        // 负面判据命中
  | 'timeout'       // 总超时
  | 'quiet'         // 行间静默到期
  | 'signal'        // exec.signal 中止（释放阀门）
  | 'disconnected'  // 连接关闭
  | 'danger'        // 意识层危险中断（abortWait）

/** 同步判据命中：收束原因 + 关窗来源（until 失配判责用，见 finish）。 */
interface CriterionHit {
  reason: ReadReason
  source: 'failOn' | 'until' | 'gaCount' | 'maxLines'
}

/** read 竞速参数。timeoutMs 必须显式给出或由工具注入缺省 —— 绝不无界等待。 */
export interface WaitOpts {
  /** 持有者身份（'root' 或 `child:<id>`）。 */
  holder: Holder
  /** 完成判据：在累积文本（各行 text 以 \n 连接）上测，**可跨批命中**。 */
  until?: RegExp[]
  /** 负面判据：命中即以 failOn 收束（优先于 until）。 */
  failOn?: RegExp[]
  /** GA/EOR 边界计数关窗（缺省 1 = 一段完整文字）。 */
  gaCount?: number
  /** 行间静默毫秒：最后一次行到达后静默即收（quiet）。 */
  quietMs?: number
  /** 总超时毫秒：**必填**（工具层注入缺省），到点以 timeout 收束。 */
  timeoutMs: number
  /** 行数兜底：累积行数达到即以 done 收束。 */
  maxLines?: number
  /** 中止信号（工具侧 exec.signal）：abort 即以 signal 收束并释放持有者。 */
  signal?: AbortSignal
}

/** read 结果。rest = 判据命中那一刻同帧尚未分发的剩余行（同帧移交：已并回
 *  缓冲，下一次 read 会先消费；字段同时返回供调用方即时取用）。 */
export interface ReadResult {
  lines: MudLine[]
  reason: ReadReason
  rest?: MudLine[]
}

/** 有界缓冲上限（impl §3.1：512 行 / 64KB，超限丢最旧记错）。 */
const MAX_BUFFER_LINES = 512
const MAX_BUFFER_BYTES = 64 * 1024

/** 行尾静默刷出延迟：对齐 Mudlet cTelnet::mTimeOut = 300ms 的静默推送。 */
const FLUSH_IDLE_MS = 300

/** 竞速中的等待状态（会话级唯一）。 */
interface WaitState {
  opts: WaitOpts
  acc: MudLine[]
  /** acc 各行 text 以 \n 连接（判据可跨批命中）。 */
  accText: string
  gaSeen: number
  quietTimer: ReturnType<typeof setTimeout> | null
  timeoutTimer: ReturnType<typeof setTimeout>
  onAbort: (() => void) | null
  resolve: (r: ReadResult) => void
}

/** 存在层核心。 */
export class Mud {
  private conn: TelnetClient | null = null
  private readonly parser = new AnsiStreamParser()
  /** 无持有者时到达的行（有界）；read 开始时先被消费（先到的行先结算）。 */
  private buffer: MudLine[] = []
  private bufferBytes = 0
  private reading: WaitState | null = null
  private holder: Holder | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** 记错通道（缓冲超限、until 失配要吵，语料可见）。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null
  /**
   * 每行钩子：装配时注入 awareness.observe（永续，与谁在等无关；缓冲态到达的
   * 行同样经过本钩子，read 预取不重复分发）。返回 'swallow' = 吞触发行（反射
   * 出口，impl §3.3）：该行不进 acc/缓冲/模型面，反射命令由钩子内自行直发，
   * 语料与日志由钩子内自记。返回 void = 照常归档。
   */
  onLine: ((line: MudLine) => 'swallow' | void) | null = null
  /** 边界钩子（GA/EOR；行尾已先 flush 分发）。 */
  onBoundary: ((kind: 'ga' | 'eor') => void) | null = null
  /** 断线钩子：经危险 latch 醒根、登录标志复位由装配层接线。 */
  onDisconnect: (() => void) | null = null

  get connected(): boolean {
    return this.conn?.connected ?? false
  }

  /** 当前持有者（工具层 fail-loud 检查用）。 */
  get currentHolder(): Holder | null {
    return this.holder
  }

  /** 建连（幂等）。显式入口；隐式重连策略（§6 待实测）由装配层决定何时调。
   *  重连复用 parser（abs 连续递增，跨重连行号不复用），但行缓冲/样式游标
   *  必须复位 —— 上一连接的半截行与样式游标不得污染新连接首行。 */
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

  /** 直发：反射/流程共用；不占行流、不做任何判据。未连接返回 false。 */
  send(cmd: string): boolean {
    return this.conn?.send(cmd) ?? false
  }

  /** 断开（session/disposed 等装配层生命周期用）。 */
  close(): void {
    this.conn?.close()
  }

  /**
   * 行等待竞速机（impl §3.2）。
   * 1. 持有者检查：已有持有者 → 抛错（fail-loud，不做队列）；
   * 2. 先消费 buffer（本次 send 之前的到达行先结算）；
   * 3. 建竞速状态，已消费行立即参与判定；
   * 4. 判定序写死（同步关窗）：failOn > until > gaCount > maxLines —— maxLines
   *    与 gaCount 同属同步关窗、maxLines 排末位；quietMs/timeoutMs 是**异步**
   *    收束源（计时器到点），与同步判据竞速；danger 走 onLine/abortWait 同步出口；
   * 5. 收束 → ReadResult{lines, reason, rest?}；持有者置空。
   */
  read(opts: WaitOpts): Promise<ReadResult> {
    if (this.reading !== null) {
      throw new Error(
        `行流持有者冲突：${String(this.holder)} 正在等待，${opts.holder} 不得并发 read（fail-loud，不做队列）`,
      )
    }
    if (!this.connected) {
      return Promise.resolve({ lines: [], reason: 'disconnected' })
    }
    // 先消费 buffer：本次 send 之前到达的行先结算。
    const initial = this.buffer
    this.buffer = []
    this.bufferBytes = 0
    return new Promise<ReadResult>((resolve) => {
      const state: WaitState = {
        opts,
        acc: initial,
        accText: initial.map(l => l.text).join('\n'),
        gaSeen: 0,
        quietTimer: null,
        timeoutTimer: setTimeout(() => {
          this.finish('timeout')
        }, opts.timeoutMs),
        onAbort: null,
        resolve,
      }
      this.reading = state
      this.holder = opts.holder
      if (opts.signal) {
        const signal = opts.signal
        if (signal.aborted) {
          this.finish('signal')
          return
        }
        const onAbort = () => this.finish('signal')
        state.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // 已消费的缓冲行可能立即满足判据；有预取行则武装 quiet（否则"缓冲有行
      // + 之后再无数据"时静默计时器永远不存在，只能等 timeout）。
      const hit = this.evaluateFull(state)
      if (hit !== null) {
        this.finish(hit.reason, undefined, hit.source)
        return
      }
      if (initial.length > 0) this.resetQuiet(state)
    })
  }

  /** 中断在途 read（意识层 danger 出口；impl §3.3 reading?.abort('danger')）。
   *  触发危险的那一行由 abort 收编进结果（现场随 reason:'danger' 上抛）。 */
  abortWait(line?: MudLine): void {
    if (this.reading === null) return
    if (line) {
      this.reading.acc.push(line)
      this.reading.accText += `${this.reading.accText ? '\n' : ''}${line.text}`
    }
    this.finish('danger')
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
    // GA/EOR 是提交边界：滞留的无换行尾行（提示符行属于帧内容）先刷出分发，
    // 再消费边界 —— 顺序即"行先于边界"。边界钩子恒定上抛（协议边界唯一出口，
    // 即便该边界恰好收束了在途 read）。
    this.clearFlushTimer()
    const tail = this.parser.flushLine()
    this.dispatchBatch(tail === null ? [] : [tail])
    const state = this.reading
    if (state !== null) {
      state.gaSeen += 1
      const hit = this.evaluateFull(state)
      if (hit !== null) this.finish(hit.reason, undefined, hit.source)
    }
    this.onBoundary?.(kind)
  }

  private onClose(): void {
    this.clearFlushTimer()
    // 断流处的提示符/半截行一并刷出分发（不丢行）。
    const tail = this.parser.flush()
    this.dispatchBatch(tail === null ? [] : [tail])
    if (this.reading !== null) this.finish('disconnected')
    this.onDisconnect?.()
  }

  /** 一批行分发。每行先意识层（onLine，返回 'swallow' 即吞触发行；也可能
   *  abortWait 收编触发行），再归 wait；判据命中后同帧剩余行作为 rest 移交
   *  （不经 wait 累积）。 */
  private dispatchBatch(lines: MudLine[]): void {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === undefined) continue
      const before = this.reading
      const verdict = this.onLine?.(line) // 意识层：观察 + 反射 + 危险出口
      if (verdict === 'swallow') continue // 吞触发行：不进 acc/缓冲/模型面
      if (this.reading !== before) continue // abortWait：触发行已由 abort 收编
      const state = this.reading
      if (state === null) {
        this.pushBuffer(line)
        continue
      }
      state.acc.push(line)
      state.accText += `${state.accText ? '\n' : ''}${line.text}`
      this.resetQuiet(state)
      const hit = this.evaluateFull(state)
      if (hit !== null) {
        this.finish(hit.reason, lines.slice(i + 1), hit.source)
        return
      }
    }
  }

  /** 判定序（写死）：failOn > until > gaCount，之后才轮到 **末位的 maxLines**
   *  （行数兜底不得抢在边界关窗之前剪断）。返回命中（收束原因 + 关窗来源）或
   *  null。danger 在 onLine 钩子同步测（abortWait）；quiet/timeout/signal/
   *  disconnected 是异步收束源。 */
  private evaluateFull(state: WaitState): CriterionHit | null {
    if (state.opts.failOn?.some(re => re.test(state.accText))) return { reason: 'failOn', source: 'failOn' }
    if (state.opts.until?.some(re => re.test(state.accText))) return { reason: 'done', source: 'until' }
    if (state.gaSeen >= (state.opts.gaCount ?? 1)) return { reason: 'done', source: 'gaCount' }
    if (state.opts.maxLines !== undefined && state.acc.length >= state.opts.maxLines) {
      return { reason: 'done', source: 'maxLines' }
    }
    return null
  }

  /** 收束：清计时器/信号监听、释放持有者、until 失配记错、rest 并回缓冲、resolve。
   *  @param doneSource 同步判据的关窗来源（evaluateFull 命中时传入）；异步收束
   *  （quiet/timeout/signal/disconnected/danger）不传。 */
  private finish(reason: ReadReason, restLines?: MudLine[], doneSource?: CriterionHit['source']): void {
    const state = this.reading
    if (state === null) return
    this.reading = null
    this.holder = null
    clearTimeout(state.timeoutTimer)
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    if (state.onAbort !== null) state.opts.signal?.removeEventListener('abort', state.onAbort)
    // until 失配记错（impl §3.2 判据失配要吵）：按**关窗者**判——quiet/timeout
    // 收场、或被 maxLines 剪断（done 且来源 maxLines）而 until 未命中。GA/EOR
    // 边界关窗（gaCount 命中）是正常收束，不算失配；danger/signal/disconnected/
    // failOn 是外部中断或负面命中，也不吵。
    const until = state.opts.until
    if (until !== undefined && until.length > 0) {
      const untilMet = until.some(re => re.test(state.accText))
      const abandoned
        = reason === 'quiet'
          || reason === 'timeout'
          || (reason === 'done' && doneSource === 'maxLines')
      if (!untilMet && abandoned) {
        this.onLog?.('error', `until 判据失配：以 ${reason} 收场，累积 ${state.acc.length} 行未见完成句（要吵，语料可见）`)
      }
    }
    let rest: MudLine[] | undefined
    if (restLines !== undefined && restLines.length > 0) {
      // rest 同帧移交：按到达序**追加**回缓冲尾部（在途 read 期间缓冲为空，
      // 下一次 read 自然先消费 rest）。不得前插 —— 前插会让"丢最旧"的 OOM
      // 淘汰（buffer.shift）先丢刚移交的新行、保留更旧内容，语义颠倒。
      this.buffer = [...this.buffer, ...restLines]
      this.bufferBytes += restLines.reduce((n, l) => n + l.text.length, 0)
      this.enforceBufferBound()
      rest = restLines
    }
    const result: ReadResult = rest !== undefined ? { lines: state.acc, reason, rest } : { lines: state.acc, reason }
    state.resolve(result)
  }

  private resetQuiet(state: WaitState): void {
    if (state.opts.quietMs === undefined) return
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    state.quietTimer = setTimeout(() => {
      if (this.reading === state) this.finish('quiet')
    }, state.opts.quietMs)
  }

  // ---------------------------------------------------------------------
  // 有界缓冲与行尾静默刷出
  // ---------------------------------------------------------------------

  private pushBuffer(line: MudLine): void {
    this.buffer.push(line)
    this.bufferBytes += line.text.length
    this.enforceBufferBound()
  }

  /** OOM 阀门：512 行 / 64KB，超限丢最旧并记错。 */
  private enforceBufferBound(): void {
    while (this.buffer.length > MAX_BUFFER_LINES || this.bufferBytes > MAX_BUFFER_BYTES) {
      const dropped = this.buffer.shift()
      if (dropped === undefined) break
      this.bufferBytes -= dropped.text.length
      this.onLog?.('error', `行缓冲超限（${MAX_BUFFER_LINES} 行 / ${MAX_BUFFER_BYTES} 字节），丢弃最旧行：${dropped.text.slice(0, 40)}`)
    }
  }

  /** 行尾静默刷出（对齐 Mudlet posting timer）：完整行即时分发，只滞留
   *  "无换行的尾片断"（提示符等），静默到期强制刷成完整行。 */
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
