/**
 * dsh-mud-core — 命令-应答桥 (CommandResponseController), host half. 网络层.
 *
 * REFACTOR-V7 机制 A (GA 主边界 + 声明边界 + 静默兜底) 的核心实现: 把
 * "mud 工具调用 → 应答" 建模为一次 **带结算边界的请求**:
 *   - sendAndAwait(cmd, opts) → Promise<MudReply>: 工具调用同步挂起, 游戏应答
 *     到达 (声明边界 / GA / EOR / 静默窗 / 超时) 后结算为 MudReply;
 *   - 一步一帧: 同一时刻至多一个**已武装** (armed = 真实写 socket 后) 的请求
 *     在等待结算; 后续请求驻留 pending, 前一个结算后才发送 (工具循环串行 +
 *     pump 双保险);
 *   - 统一行集表 (注册表): 帧/观察行按**纯文本**登记 (内容寻址, 有界 FIFO);
 *     工具结果文本 (含结算标记) 经 resolveLines 还原纯行 — T1 规则以保真
 *     MudLine 续步判定, 标记不破坏注册表查找。
 *
 * 计时语义 (审阅注意点 #1): **静默窗 = 最后一行到达后静默 N 秒** (默认 2s),
 * 非"武装后 N 秒"; 声明 until 的请求禁用静默窗 (慢应答由声明超时兜底)。
 * 超时兜底: 未声明 10s (可逐请求覆盖) / 声明 120s; **连续 3 次超时**
 * → promise reject (工具 throw → DSH 失败终态), 任意非超时结算即复位。
 *
 * 接线 (宿主):
 *   - options.send: 实际入队 (宿主接 CommandQueue; 队列 onSend = 真实写 socket
 *     后调 controller.confirmSent(replyId, head) — head = 静默收集窗未结算行,
 *     并入帧首, 见审阅注意点 #3 的帧连续语义);
 *   - feedLines: 每批完整逻辑行 (宿主预处理后喂入; armed 帧归当前请求, 其余
 *     转发 onObservation 供观察窗结算 — 宿主须在 controller.inFlight() 期间
 *     推迟观察窗结算, 否则行会被头部合并与观察注入双重消费);
 *   - boundaryReceived: 帧边界 (GA/EOR); armed 且未声明 until → 即刻结算;
 *     声明 until → 仅作帧切分继续累积 (跨帧匹配); 无主边界 → 丢弃 (转发
 *     onBoundary 供观察窗作为自然结算点);
 *   - close: 断线 → 在途/排队请求全部 reject (回合 error 语义)。
 *
 * 结算分层的优先级 (机制 A): until (声明边界) > GA/EOR (主边界) >
 * 静默窗 (主边界兜底) > 超时 (最兜底)。
 * @module @deepseek-ai/dsh-mud-core/network/response
 */

import type { MudLine } from '../preprocess/ansi.ts'
import { textOfLines } from '../preprocess/index.ts'

/** 帧边界种类 (telnet 'boundary' 事件)。 */
export type BoundaryKind = 'ga' | 'eor'

/** 结算方式: 边界 (ga/eor) / 声明 (until) / 静默 (silent) / 超时 (timeout) /
 *  中止 (abort, signal) / 连接错误 (error, 断线)。 */
export type ReplySettle = BoundaryKind | 'until' | 'silent' | 'timeout' | 'abort' | 'error'

/** 一次命令-应答的结算结果 (工具 execute 的返回值形状; 规则续步判定入参)。 */
export interface MudReply {
  /** 是否成功结算 (ga/eor/until/silent 为 true; timeout/abort/error 为 false)。 */
  ok: boolean
  /** 实际发出的命令 (串行数列时为 '命令序列')。 */
  cmd: string
  /** 完整应答文本: 纯帧文本 + 结算标记 (timeout/silent 追加; 渲染给 agent)。 */
  text: string
  /** 纯应答行 (MudLine[], 行号/style 保真 — T1 规则续步判定的唯一来源)。 */
  lines: MudLine[]
  /** 结算方式。 */
  settled: ReplySettle
}

/** 声明边界 (until): 仅当文本命中该正则才结算 (跨帧累积; 静默窗禁用)。 */
export interface ReplyUntil {
  regex: string | RegExp
  /** 声明请求的超时 (缺省 DECLARED_TIMEOUT_MS)。 */
  timeout?: number
}

/** 请求选项。 */
export interface ReplyOptions {
  /** 声明边界: 声明后 GA/EOR 不再结算, 文本命中正则即结算。 */
  until?: ReplyUntil
  /** 请求级超时 (未声明 10s / 声明 120s 的覆盖值)。 */
  timeout?: number
  /** 静默窗毫秒 (未声明 until 时生效; 缺省 DEFAULT_SILENCE_MS; 逐行到达重置)。 */
  silence?: number
  /** 中止信号: 触发后优雅结算 (settled='abort'), 不留悬挂 promise。 */
  signal?: AbortSignal
}

/** 控制器宿主接线。 */
export interface CommandResponseControllerOptions {
  /** 实际发送: 宿主接 CommandQueue (meta.replyId 穿透到队列 onSend)。 */
  send: (cmd: string, meta: { replyId?: string; priority?: 'halt' | 'high' | 'normal' | 'low' }) => void
  /** 无主观察行回调 (观察窗结算; 宿主需在 inFlight() 期间推迟结算)。 */
  onObservation?: (lines: MudLine[]) => void
  /** 无主边界回调 (观察窗自然结算点)。 */
  onBoundary?: (kind: BoundaryKind) => void
  /** 日志。 */
  onLog?: (text: string) => void
  /** 未声明请求超时 (缺省 10s)。 */
  defaultTimeoutMs?: number
  /** 声明请求超时 (缺省 120s)。 */
  declaredTimeoutMs?: number
  /** 静默窗 (缺省 2s)。 */
  defaultSilenceMs?: number
  /** 连续超时上限 (缺省 3; 达到即 reject → DSH 失败终态)。 */
  consecutiveTimeoutLimit?: number
}

/** 超时标记 (追加在 text 末尾; agent 可见, 注册表查找忽略)。 */
export const TIMEOUT_MARKER = '\n[应答超时，边界未命中，请决策]'
/** 静默结算标记 (追加在 text 末尾; agent 可见, 注册表查找忽略)。 */
export const SILENT_MARKER = '\n[静默结算（边界未命中）]'
/** 中止文本。 */
export const ABORT_TEXT = '（已中止）'

/** 应答行集表上限 (有界 FIFO; 与旧行注册表同量级)。 */
const LINE_STORE_MAX = 64

/** 单次应答的运行时状态。 */
interface PendingReply {
  id: string
  /** 展示用命令 (单体 = 命令; 序列 = '命令序列')。 */
  cmd: string
  /** 实际命令列表 (序列逐条同 replyId 穿透到队列)。 */
  cmds: string[]
  opts: ReplyOptions
  /** 已累积的纯行 (MudLine 保真; head 头部合并后回填)。 */
  lines: MudLine[]
  /** 已累积的纯文本 (lines 的 textOfLines 缓存)。 */
  text: string
  state: 'registered' | 'sending' | 'armed' | 'settled'
  resolve: (r: MudReply) => void
  reject: (e: Error) => void
  timeoutTimer: ReturnType<typeof setTimeout> | null
  silenceTimer: ReturnType<typeof setTimeout> | null
  abortListener: (() => void) | null
}

/** 从结算标记包裹的文本还原纯文本 (标记剥离)。 */
export function stripMarkers(text: string): string {
  return String(text)
    .split(TIMEOUT_MARKER).join('')
    .split(SILENT_MARKER).join('')
    .split(ABORT_TEXT).join('')
    .trim()
}

/**
 * 命令-应答控制器。非网络协程: 一个控制器服务**一条游戏连接** (重连后
 * 须调用 clear() — 旧连接的行对象 abs 已随 parser 实例归零作废)。
 */
export class CommandResponseController {
  private readonly opts: Required<
    Pick<CommandResponseControllerOptions, 'send' | 'defaultTimeoutMs' | 'declaredTimeoutMs' | 'defaultSilenceMs' | 'consecutiveTimeoutLimit'>
  > & {
    onObservation?: (lines: MudLine[]) => void
    onBoundary?: (kind: BoundaryKind) => void
    onLog?: (text: string) => void
  }

  /** 统一行集表 (内容寻址: 键 = 纯帧/观察文本 trim; 值 = MudLine[])。 */
  private readonly store = new Map<string, MudLine[]>()

  /** 已注册但未发送的请求 (FIFO)。 */
  private pending: PendingReply[] = []
  /** 当前已武装/发送中的请求 (一步一帧, 单一)。 */
  private live: PendingReply | null = null
  /** 连续超时计数 (成功结算即复位; 达上限 → reject)。 */
  private consecutiveTimeouts = 0
  private replySeq = 0
  private disposed = false

  constructor(options: CommandResponseControllerOptions) {
    this.opts = {
      send: options.send,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
      declaredTimeoutMs: options.declaredTimeoutMs ?? 120_000,
      defaultSilenceMs: options.defaultSilenceMs ?? 2_000,
      consecutiveTimeoutLimit: options.consecutiveTimeoutLimit ?? 3,
      ...(options.onObservation !== undefined ? { onObservation: options.onObservation } : {}),
      ...(options.onBoundary !== undefined ? { onBoundary: options.onBoundary } : {}),
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    }
  }

  // ── 宿主接口 ───────────────────────────────────────────

  /**
   * 挂起等待应答: 注册请求 → pump 发送 (宿主队列节流) → 真实写 socket 后
   * 宿主调 confirmSent 武装 → 应答到达结算 → resolve MudReply。
   * @param cmd 单体命令或命令序列 (序列 = 同一次应答的一个帧)。
   * @param opts 结算选项 (until/timeout/silence/signal)。
   */
  sendAndAwait(cmd: string | string[], opts: ReplyOptions = {}): Promise<MudReply> {
    const list = Array.isArray(cmd) ? cmd : [cmd]
    const joined = list.join('\n')
    if (list.length === 0 || list.every(c => String(c).trim() === '')) {
      return Promise.resolve({ ok: false, cmd: '', text: '空命令', lines: [], settled: 'error' })
    }
    if (this.disposed) {
      return Promise.reject(new Error('控制器已关闭, 命令未发送'))
    }
    // 信号已预先中止: 不发命令, 优雅结算。
    if (opts.signal?.aborted) {
      return Promise.resolve({ ok: false, cmd: joined, text: ABORT_TEXT, lines: [], settled: 'abort' })
    }
    const reply: PendingReply = {
      id: `r${++this.replySeq}`,
      cmd: list.length === 1 ? String(list[0]) : '命令序列',
      cmds: list.map(c => String(c)),
      opts,
      lines: [],
      text: '',
      state: 'registered',
      resolve: () => {},
      reject: () => {},
      timeoutTimer: null,
      silenceTimer: null,
      abortListener: null,
    }
    const promise = new Promise<MudReply>((resolve, reject) => {
      reply.resolve = resolve
      reply.reject = reject
    })
    this.pending.push(reply)
    // 中止随时生效 (注册/发送中/武装后): 优雅结算, 不留悬挂 promise。
    // key = 监听器引用, settle 时移除; 每请求恰挂一次。
    if (opts.signal && !opts.signal.aborted) {
      const listener = () => this.settle(reply, 'abort')
      opts.signal.addEventListener('abort', listener, { once: true })
      reply.abortListener = listener
    }
    this.pump()
    return promise
  }

  /**
   * 事实武装: 宿主在**真实写 socket 后**调用 (队列 onSend 里)。
   * @param replyId sendAndAwait 时穿透的 meta.replyId (幂等: 序列多命令同 id)。
   * @param head 静默收集窗未结算行 (武装前到达的行; 并入帧首, 保持帧连续)。
   */
  confirmSent(replyId: string | undefined, head?: MudLine[]): void {
    const reply = this.live
    if (!reply || reply.state !== 'sending' || reply.id !== replyId) return
    if (head && head.length > 0) {
      reply.lines = [...head, ...reply.lines]
      reply.text = textOfLines(reply.lines)
      this.record(head)
    }
    reply.state = 'armed'
    this.armTimers(reply)
  }

  /**
   * 喂入一批完整逻辑行 (宿主 telnet 'parsed' 批次粒度)。
   * 折叠分界 (REFACTOR-V7 六): `lines` = 原始行 (折叠过滤之前的全量) —
   *   边界匹配 (until 目标行可能是 state 折叠行, 如 hp 的 气血 行) 与
   *   帧内容 (工具调用主动索取的应答) 一律在原始行上; `foldedRemains`
   *   = state 折叠后的剩余行 — 无主且未武装时转观察窗 (状态已进 world,
   *   不吵 agent)。armed 帧 → 归当前请求 (原始行) 并检测结算; 其余 →
   *   登记 foldedRemains (缺省=lines) 并转发 onObservation。
   */
  feedLines(lines: MudLine[], foldedRemains?: MudLine[]): void {
    if (lines.length === 0 || this.disposed) return
    const reply = this.live
    if (reply && reply.state === 'armed') {
      reply.lines = [...reply.lines, ...lines]
      reply.text = textOfLines(reply.lines)
      this.record(lines)
      this.resetSilence(reply)
      // 声明边界: 文本命中即结算 (跨帧累积)。
      if (reply.opts.until && this.testUntil(reply.opts.until.regex, reply.text)) {
        this.settle(reply, 'until')
      }
      return
    }
    // 无主 (或尚未武装): 观察窗 — 折叠后的剩余行 (未提供则原行)。
    const obs = foldedRemains ?? lines
    this.record(obs)
    this.opts.onObservation?.(obs)
  }

  /**
   * 帧边界 (telnet 'boundary' {kind}): 未声明 until 的 armed 请求即刻结算;
   * 声明 until 仅作帧切分继续累积; 无主边界丢弃 (转发 onBoundary)。
   */
  boundaryReceived(kind: BoundaryKind): void {
    const reply = this.live
    if (reply && reply.state === 'armed') {
      if (reply.opts.until) {
        // 声明边界为主: 至此帧尾测试一次 (便于"整行尾"语义), 未命中继续累积。
        if (this.testUntil(reply.opts.until.regex, reply.text)) this.settle(reply, 'until')
        return
      }
      this.settle(reply, kind)
      return
    }
    this.opts.onBoundary?.(kind)
  }

  /** 断线: 在途/排队请求全部 reject (error), 停止接受新请求。 */
  close(): void {
    this.disposed = true
    const live = this.live
    if (live && live.state !== 'settled') {
      this.settle(live, 'error')
    }
    for (const next of this.pending) {
      this.settle(next, 'error')
    }
    this.pending = []
    this.live = null
  }

  /** 重连清理: 旧连接行对象 abs 已随 parser 实例归零, 行集表作废。 */
  clear(): void {
    this.store.clear()
  }

  /** 是否存在未结算的在途/排队请求 (宿主据此推迟观察窗结算)。 */
  inFlight(): boolean {
    return (this.live !== null && this.live.state !== 'settled') || this.pending.length > 0
  }

  /**
   * 解析工具结果文本 → 纯行 (注册表还原; 标记剥离 + 精确匹配 +
   * 最长前缀/空白折叠容错)。规则续步判定 (adapter) 与诊断用。
   */
  resolveLines(note: string): MudLine[] | null {
    const key = stripMarkers(note)
    if (key === '') return null
    if (this.store.size === 0) return null
    const collapsed = key.replace(/\s+/g, '')
    const exact = this.store.get(key)
    if (exact) return exact
    let best: { k: string; lines: MudLine[] } | null = null
    for (const [k, lines] of this.store) {
      if (k.replace(/\s+/g, '') === collapsed) {
        best = { k, lines }
        break
      }
      if (collapsed.startsWith(k.replace(/\s+/g, '')) || k.replace(/\s+/g, '').startsWith(collapsed)) {
        if (!best || k.length > best.k.length) best = { k, lines }
      }
    }
    return best ? best.lines : null
  }

  /** 免等待发送 (手动 WebUI 命令; 不入应答机制, 直入队列)。 */
  sendFireForget(cmd: string, meta: { priority?: 'halt' | 'high' | 'normal' | 'low' } = {}): void {
    const trimmed = String(cmd).trim()
    if (trimmed === '' || this.disposed) return
    this.opts.send(trimmed, meta)
  }

  /** 诊断: 队列深度 / 在途请求。 */
  stats(): { pending: number; live: string | null; consecutiveTimeouts: number; store: number } {
    return {
      pending: this.pending.length,
      live: this.live && this.live.state !== 'settled' ? this.live.id : null,
      consecutiveTimeouts: this.consecutiveTimeouts,
      store: this.store.size,
    }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** 一步一帧: 无在途请求时把队头送出 (宿主队列节流, 写后 confirmSent)。 */
  private pump(): void {
    if (this.disposed) return
    if (this.live && this.live.state !== 'settled') return
    const next = this.pending.shift()
    if (!next) {
      this.live = null
      return
    }
    this.live = next
    next.state = 'sending'
    try {
      this.sendCommands(next)
    } catch (err) {
      this.opts.onLog?.(`[应答] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
      this.settle(next, 'error')
    }
  }

  /** 发送该请求的全部命令 (单体一条; 序列逐条同 replyId 穿透到队列)。 */
  private sendCommands(reply: PendingReply): void {
    for (const c of reply.cmds) {
      this.opts.send(c, { replyId: reply.id })
    }
  }

  /** 注册表登记 (有界 FIFO; 键 = 纯文本 trim)。 */
  private record(lines: MudLine[]): void {
    const text = textOfLines(lines).trim()
    if (text === '' || lines.length === 0) return
    this.store.delete(text)
    this.store.set(text, lines)
    if (this.store.size > LINE_STORE_MAX) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
  }

  /** 结算 (唯一出口: resolve/reject 恰一次; 之后的 feed/boundary 归无主)。 */
  private settle(reply: PendingReply, kind: ReplySettle): void {
    if (reply.state === 'settled') return
    reply.state = 'settled'
    this.clearTimers(reply)
    if (reply.abortListener) {
      reply.opts.signal?.removeEventListener('abort', reply.abortListener)
      reply.abortListener = null
    }
    // 已结算项同步退出队列 (中止/断线可能发生在发送前): 防 pump 重发。
    const idx = this.pending.indexOf(reply)
    if (idx !== -1) this.pending.splice(idx, 1)
    if (this.live === reply) this.live = null
    // 纯帧文本落表 (不含标记) — 工具结果经 resolveLines 还原。
    if (reply.lines.length > 0) this.record(reply.lines)

    if (kind === 'error') {
      reply.reject(new Error(`应答未结算 (连接已断开): ${reply.cmd}`))
      this.pump()
      return
    }
    if (kind === 'timeout') {
      this.consecutiveTimeouts += 1
      const limit = this.opts.consecutiveTimeoutLimit
      if (this.consecutiveTimeouts >= limit) {
        this.consecutiveTimeouts = 0
        reply.reject(new Error(`连续 ${limit} 次应答超时 (边界未命中), 回合失败终止`))
        this.pump()
        return
      }
      const text = reply.text + TIMEOUT_MARKER
      reply.resolve({ ok: false, cmd: reply.cmd, text, lines: reply.lines, settled: kind })
      this.pump()
      return
    }

    this.consecutiveTimeouts = 0
    let text: string
    let ok: boolean
    switch (kind) {
      case 'silent':
        text = reply.text + SILENT_MARKER
        ok = true
        break
      case 'abort':
        text = ABORT_TEXT
        ok = false
        break
      default: // 'ga' | 'eor' | 'until'
        text = reply.text
        ok = true
        break
    }
    reply.resolve({ ok, cmd: reply.cmd, text, lines: reply.lines, settled: kind })
    this.pump()
  }

  /** 武装后的计时: 超时必启; 静默窗仅在未声明 until 时启用。 */
  private armTimers(reply: PendingReply): void {
    // 超时定时器 (绝对): 未声明 10s / 声明 120s, 请求级 opts.timeout 覆盖。
    const declared = reply.opts.until !== undefined
    const timeoutMs = reply.opts.timeout ?? (
      declared ? this.opts.declaredTimeoutMs : this.opts.defaultTimeoutMs
    )
    reply.timeoutTimer = setTimeout(() => {
      if (reply.state === 'armed') this.settle(reply, 'timeout')
    }, timeoutMs)
    // 静默窗: 最后一行到达后静默 N 秒 (逐行重置); 声明 until 禁用。
    if (!declared) {
      this.resetSilence(reply)
    }
  }

  /** 重置静默窗 (每次 armed 帧喂行时调用)。 */
  private resetSilence(reply: PendingReply): void {
    if (reply.state !== 'armed') return
    if (reply.silenceTimer) clearTimeout(reply.silenceTimer)
    const silenceMs = reply.opts.silence ?? this.opts.defaultSilenceMs
    reply.silenceTimer = setTimeout(() => {
      if (reply.state === 'armed') this.settle(reply, 'silent')
    }, silenceMs)
  }

  private clearTimers(reply: PendingReply): void {
    if (reply.timeoutTimer) { clearTimeout(reply.timeoutTimer); reply.timeoutTimer = null }
    if (reply.silenceTimer) { clearTimeout(reply.silenceTimer); reply.silenceTimer = null }
  }

  /** 声明边界正则测试 (字符串编译为 RegExp; 非法正则视为永不命中)。 */
  private testUntil(pattern: string | RegExp, text: string): boolean {
    try {
      const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
      return re.test(text)
    } catch {
      this.opts.onLog?.(`[应答] until 正则非法, 忽略: ${String(pattern)}`)
      return false
    }
  }
}