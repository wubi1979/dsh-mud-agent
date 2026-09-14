/**
 * dsh-mud-core — 命令-应答桥 (CommandResponseController), host half. 网络层.
 *
 * 命令-应答桥 (`doc/ARCHITECTURE.md` §8; GA 主边界 + 声明边界 + 静默兜底) 的核心实现: 把
 * "mud 工具调用 → 应答" 建模为一次 **带结算边界的请求**:
 *   - sendAndAwait(cmd, opts) → Promise<MudReply>: 工具调用同步挂起, 游戏应答
 *     到达 (声明边界 / GA / EOR / 静默窗 / 超时) 后结算为 MudReply;
 *   - 一步一帧: 同一时刻至多一个**已武装** (armed = 真实写 socket 后) 的请求
 *     在等待结算; 后续请求驻留 pending, 前一个结算后才发送 (工具循环串行 +
 *     pump 双保险)。
 *     **本桥只服务我们自己命令的应答帧**; 规则判定与投递归 L1/L2
 *     (`perception/engine.ts` 与 `session-runtime.ts`), 两者通过"原始行同源、
 *     责任分离"解耦 —— 桥不再持有行集表, T1 也不按文本反查行对象。
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
 *   - feedLines: 每个文本块的行 (armed 帧归当前请求; 无主行不在此登记 —— 投递由
 *     L2 结算点负责, 见 `doc/ARCHITECTURE.md` §5);
 *   - boundaryReceived: 帧边界 (GA/EOR); armed 且未声明 until → 即刻结算;
 *     声明 until → 仅作帧切分继续累积 (跨帧匹配); 无主边界 → 转发 `onBoundary`
 *     (装配方据此做投递结算);
 *   - close: 断线 → 在途/排队请求全部 reject (回合 error 语义); `close()` 为**终止**语义,
 *     重连后宿主须调 `reset()` 重开控制器;
 *   - sendFailed: 宿主真实写 socket 失败/异常时回执 → 在途 sending 请求 settle error
 *     (工具 throw → 回合 error); pump 另设发送守卫: 超窗未 confirmSent 武装 → 同样 error;
 *
 * 结算分层的优先级 (`doc/ARCHITECTURE.md` §8): until (声明边界) > GA/EOR (主边界) >
 * 静默窗 (主边界兜底) > 超时 (最兜底)。
 * @module @deepseek-ai/dsh-mud-core/network/response
 */

import type { MudLine } from '../services/network/ansi.ts'
import { textOfLines } from '../preprocess/index.ts'

/** 帧边界种类 (telnet 'boundary' 事件)。 */
export type BoundaryKind = 'ga' | 'eor'

/** 结算方式: 边界 (ga/eor) / 声明 (until) / 静默 (silent) / 超时 (timeout) /
 *  中止 (abort, signal) / 流程打断 (interrupted) / 连接错误 (error, 断线)。 */
export type ReplySettle = BoundaryKind | 'until' | 'silent' | 'timeout' | 'abort' | 'interrupted' | 'error'

/** 一次命令-应答的结算结果 (工具 execute 的返回值形状; 规则续步判定入参)。 */
export interface MudReply {
  /** 是否成功结算 (ga/eor/until/silent 为 true; timeout/abort/interrupted/error 为 false)。 */
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
  /** 无主边界回调 (装订方作为投递结算点)。 */
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
  /**
   * 结算通知 (v0.4.0; 流程判定用): 每次应答结算时回调 `(kind, text, cmds)`。
   *
   * `cmds` = **被这次结算关掉的那条请求的命令列表**（结算归属判据）：流程把它与本步声明的命令
   * 做同一套插值比对，从而精确回答"这条 GA 是不是我这一步的"。比"本步有命令在途"这种布尔
   * 标记强：一个步骤发多条命令时，别的命令的 GA 不会被误算作本步的结算。
   */
  onSettle?: (kind: ReplySettle, text: string, cmds: readonly string[]) => void
  /**
   * 挂起期闸门 (I12): `canSend(cmd)` 返回 false 时**拒绝**新的应答请求。
   * 流程挂起期间只放行"该步声明的那条命令"（结算归属判据）。
   */
  canSend?: (cmd: string) => boolean
}

/** 超时标记 (追加在 text 末尾; agent 可见, 注册表查找忽略)。 */
export const TIMEOUT_MARKER = '\n[应答超时，边界未命中，请决策]'
/** 静默结算标记 (追加在 text 末尾; agent 可见, 注册表查找忽略)。 */
export const SILENT_MARKER = '\n[静默结算（边界未命中）]'
/** 中止文本。 */
export const ABORT_TEXT = '（已中止）'
/** 流程打断的缺省原因 (工具结果文本; `interruptInFlight` 用)。 */
export const INTERRUPT_TEXT = '（流程被打断：本步已作废，请按新情况决策）'

/** 帧行数上限 (P3-5: 抓包 dz 56 批/57 行; 声明 until 帧同量级累积,
 *  无上限会导致文本无限膨胀)。超限强制 timeout 结算。 */
const MAX_FRAME_LINES = 256

/** R2-11: 孤儿 GA 计数过期窗口 — 非 GA 结算 (silent/timeout/abort/until) 后
 *  遗留 GA 只应吞"紧随其后"的一帧边界; 超过该窗 (GA 实测延迟 1–602ms,
 *  静默窗 2s) 仍累积的孤儿视为已无后续, 强制过期, 防止吞掉未来真实 GA。 */
const ORPHAN_EXPIRE_MS = 3_000

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

/**
 * 命令-应答控制器。非网络协程: 一个控制器服务**一条游戏连接** (重连后
 * 须调用 `reset()` — 旧连接的行对象已随 parser 实例作废)。
 *
 * 行集表已随 V10 行级化删除: T1 的渲染依据是感知引擎的**命中队列**
 * (`doc/ARCHITECTURE.md` §4/§7), 不再按文本反查行对象。
 */
export class CommandResponseController {
  private readonly opts: Required<
    Pick<CommandResponseControllerOptions, 'send' | 'defaultTimeoutMs' | 'declaredTimeoutMs' | 'defaultSilenceMs' | 'consecutiveTimeoutLimit'>
  > & {
    onBoundary?: (kind: BoundaryKind) => void
    onLog?: (text: string) => void
    onSettle?: (kind: ReplySettle, text: string, cmds: readonly string[]) => void
    canSend?: (cmd: string) => boolean
  }

  /** 已注册但未发送的请求 (FIFO)。 */
  private pending: PendingReply[] = []
  /** 当前已武装/发送中的请求 (一步一帧, 单一)。 */
  private live: PendingReply | null = null
  /** 连续超时计数 (成功结算即复位; 达上限 → reject)。 */
  private consecutiveTimeouts = 0
  /** P3-2/R2-11: 迟到 GA 计数 — 非 GA 路径结算 (silent/timeout/abort/until) 后,
   *  遗留的 GA 不应提前结算下一帧 (abort 路径实证问题); orphanBoundaryAt 记录
   *  最近一次递增时间, 消费时超窗 (ORPHAN_EXPIRE_MS) 即过期清零。 */
  private orphanBoundaries = 0
  private orphanBoundaryAt = 0
  private replySeq = 0
  private disposed = false

  constructor(options: CommandResponseControllerOptions) {
    this.opts = {
      send: options.send,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
      declaredTimeoutMs: options.declaredTimeoutMs ?? 120_000,
      defaultSilenceMs: options.defaultSilenceMs ?? 2_000,
      consecutiveTimeoutLimit: options.consecutiveTimeoutLimit ?? 3,
      ...(options.onBoundary !== undefined ? { onBoundary: options.onBoundary } : {}),
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
      ...(options.onSettle !== undefined ? { onSettle: options.onSettle } : {}),
      ...(options.canSend !== undefined ? { canSend: options.canSend } : {}),
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
    // 空命令是**合法的 MUD 指令**（登录收尾"顶"一下、翻页、退出 MXP 检测都是发空行；
    // 作者 2026-09-13 定案：其他客户端也允许）。**只在"一条命令都没有"时拒绝**。
    if (list.length === 0) {
      return Promise.resolve({ ok: false, cmd: '', text: '空命令', lines: [], settled: 'error' })
    }
    if (this.disposed) {
      return Promise.reject(new Error('控制器已关闭, 命令未发送'))
    }
    // 信号已预先中止: 不发命令, 优雅结算。
    if (opts.signal?.aborted) {
      return Promise.resolve({ ok: false, cmd: joined, text: ABORT_TEXT, lines: [], settled: 'abort' })
    }
    // 挂起期闸门 (I12): 流程挂起期间拒绝第二条应答请求 (拒绝 = 不发送, 直接失败)。
    if (this.opts.canSend !== undefined && !this.opts.canSend(joined)) {
      return Promise.resolve({
        ok: false,
        cmd: joined,
        text: '流程挂起期间不允许第二条应答请求 (已拒绝)',
        lines: [],
        settled: 'error',
      })
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
   */
  confirmSent(replyId: string | undefined): void {
    const reply = this.live
    if (!reply || reply.state !== 'sending' || reply.id !== replyId) return
    reply.state = 'armed'
    this.armTimers(reply)
  }

  /**
   * 发送失败回执 (P0-2): 宿主在真实写 socket 失败 / 抛异常 / 超时未确认武装时调用,
   * 在途 `sending` 请求 settle 成 error → 工具 reject → 回合 error 终态; pump 恢复。
   * 幂等: 仅匹配 live 且 state==='sending' 的同 id 请求。
   */
  sendFailed(replyId: string | undefined, reason: string): void {
    const reply = this.live
    if (!reply || reply.state !== 'sending' || reply.id !== replyId) return
    this.opts.onLog?.(`[应答] ${reason}`)
    this.settle(reply, 'error', reason)
  }

  /**
   * 喂入一个文本块的行 (宿主 telnet 'parsed' 粒度; 术语见 `doc/ARCHITECTURE.md` §2)。
   * `lines` = 原始行 (state 折叠之前的全量): 边界匹配 (until 目标行可能是
   * state 折叠行, 如 hp 的 气血 行) 与帧内容 (工具调用主动索取的应答) 一律
   * 在原始行上。无主行不再在此登记 —— 投递由 L2 结算点负责
   * (`doc/ARCHITECTURE.md` §5), 桥只服务**我们自己命令**的应答帧。
   * @param lines 本文本块的行。
   */
  feedLines(lines: MudLine[]): void {
    if (lines.length === 0 || this.disposed) return
    const reply = this.live
    if (!reply || (reply.state !== 'armed' && reply.state !== 'sending')) return
    // `sending` = 已调用 sendAndAwait 但还没真实写出 (队列节流窗口): 这里的行同样属于
    // 本帧 —— 由**控制器自己**累积, 宿主不需要另存一份"帧首"再并回来 (那样同一批行会
    // 同时留在本帧与下一帧: 实测 look 的应答文本里混进了上一次 look/MXP 的旧行)。
    reply.lines = [...reply.lines, ...lines]
    reply.text = textOfLines(reply.lines)
    if (reply.state !== 'armed') return
    this.resetSilence(reply)
    // 声明边界: 任一既有行命中即结算 (跨帧累积; 逐行语义, 锚定整行正则)。
    // R2-5: until 判定必须先于行数上限 — 长列表命令完成句排在 256 行之后时,
    // 若先判上限会把"完成句即将到达"误判为边界未命中 (强制 timeout)。
    if (reply.opts.until && this.testUntil(reply.opts.until.regex, reply.lines)) {
      this.settle(reply, 'until')
      return
    }
    // P3-5: 帧行数超限强制 timeout 结算 (防 dz 渐进推送等无 GA/prompt 场景无限累积)。
    if (reply.lines.length >= MAX_FRAME_LINES) {
      this.opts.onLog?.(`[应答] 帧行数超限 (${reply.lines.length} >= ${MAX_FRAME_LINES}), 强制 timeout 结算`)
      this.settle(reply, 'timeout')
    }
  }

  /**
   * 帧边界 (telnet 'boundary' {kind}): 未声明 until 的 armed 请求即刻结算;
   * 声明 until 仅作帧切分继续累积; 无主边界丢弃 (转发 onBoundary)。
   */
  boundaryReceived(kind: BoundaryKind): void {
    const reply = this.live
    if (reply && reply.state === 'armed') {
      if (reply.opts.until) {
        // 声明边界为主: 至此帧尾测一次既有行 (便于"整行尾"语义), 未命中继续累积。
        if (this.testUntil(reply.opts.until.regex, reply.lines)) this.settle(reply, 'until')
        return
      }
      // P3-2/R2-11: 非 GA 结算 (silent/timeout/abort/until) 后迟到 GA 丢弃 —
      // 不提前结算下一帧; 计数带过期窗 (只增、只在边界到达时减会吞掉未来真实 GA,
      // 且可能链式放大 — 本命令若本就没有 GA, 计数器会永久驻留)。
      if (this.orphanBoundaries > 0) {
        if (Date.now() - this.orphanBoundaryAt > ORPHAN_EXPIRE_MS) {
          this.orphanBoundaries = 0
        } else {
          this.orphanBoundaries -= 1
          this.opts.onLog?.(`[应答] 迟到 GA 丢弃 (P3-2 orphan, 剩余 ${this.orphanBoundaries})`)
          return
        }
      }
      this.settle(reply, kind)
      return
    }
    this.opts.onBoundary?.(kind)
  }

  /** 断线: 在途/排队请求全部 reject (error), 停止接受新请求 (终止语义)。 */
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
    this.orphanBoundaries = 0
  }

  /** 重连复位 (P0-1): `close()` 为终止语义 (disposed 永真), 宿主每次 `connect` 事件
   *  须调 `reset()` 重开控制器: 清 disposed/live/pending/连续超时。
   *  断线遗留请求本已在 close 期 reject; 此处双保险 (防御非 close 路径的残留)。 */
  reset(): void {
    this.disposed = true
    const live = this.live
    if (live && live.state !== 'settled') this.settle(live, 'error')
    for (const next of this.pending) this.settle(next, 'error')
    this.pending = []
    this.live = null
    this.consecutiveTimeouts = 0
    this.orphanBoundaries = 0
    this.disposed = false
  }

  /** 是否存在未结算的在途/排队请求 (诊断/投递判据)。 */
  inFlight(): boolean {
    return (this.live !== null && this.live.state !== 'settled') || this.pending.length > 0
  }

  /**
   * **流程打断**(§19.4): 在途与排队的应答请求当场结算为 `interrupted` —— 挂起的工具调用
   * 拿到 `{ok:false, settled:'interrupted'}` 与可读原因（不悬挂、不静默，I4）。
   *
   * 与 `close()`/`reset()` 的区别: 桥**继续可用**（打断后投递的新命令照常走），只作废
   * 当前这一批请求。调用方（流程运行时）负责在此之前/之后复位流程。
   * @param reason 可读原因（进工具结果文本）。
   * @returns 被结算的请求数。
   */
  interruptInFlight(reason: string = INTERRUPT_TEXT): number {
    let count = 0
    const live = this.live
    if (live && live.state !== 'settled') {
      this.settle(live, 'interrupted', reason)
      count += 1
    }
    for (const next of this.pending) {
      if (next.state === 'settled') continue
      this.settle(next, 'interrupted', reason)
      count += 1
    }
    this.pending = this.pending.filter(next => next.state !== 'settled')
    return count
  }

  /** 免等待发送 (手动 WebUI 命令; 不入应答机制, 直入队列)。 */
  sendFireForget(cmd: string, meta: { priority?: 'halt' | 'high' | 'normal' | 'low' } = {}): void {
    const trimmed = String(cmd).trim()
    if (trimmed === '' || this.disposed) return
    this.opts.send(trimmed, meta)
  }

  /** 诊断: 队列深度 / 在途请求。 */
  stats(): { pending: number; live: string | null; consecutiveTimeouts: number } {
    return {
      pending: this.pending.length,
      live: this.live && this.live.state !== 'settled' ? this.live.id : null,
      consecutiveTimeouts: this.consecutiveTimeouts,
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
      this.settle(next, 'error', `命令发送异常: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // 发送守卫 (P0-2): 宿主 confirmSent 后才武装计时。若真实写 socket 失败/异常而不
    // 回执 confirmSent/sendFailed, sending 永不结算 → 整桥死锁 (inFlight 恒 true、
    // pending 永不 pump)。按请求超时窗兜底 settle error → 工具 throw → 回合 error。
    next.timeoutTimer = setTimeout(() => {
      if (next.state === 'sending') {
        this.opts.onLog?.(`[应答] 发送后 ${next.opts.timeout ?? this.opts.defaultTimeoutMs}ms 未确认武装, 视为发送失败: ${next.cmd}`)
        this.settle(next, 'error', `命令已入队但发送后未确认武装 (${next.cmd})`)
      }
    }, next.opts.timeout ?? this.opts.defaultTimeoutMs)
  }

  /** 发送该请求的全部命令 (单体一条; 序列逐条同 replyId 穿透到队列)。 */
  private sendCommands(reply: PendingReply): void {
    for (const c of reply.cmds) {
      this.opts.send(c, { replyId: reply.id })
    }
  }

  /** 结算 (唯一出口: resolve/reject 恰一次; 之后的 feed/boundary 归无主)。
   *  `errorMessage` 覆盖缺省文案 (kind='error': 发送失败/未确认武装等非断线场景;
   *  kind='interrupted': 流程打断的可读原因)。 */
  private settle(reply: PendingReply, kind: ReplySettle, errorMessage?: string): void {
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
    // 纯帧文本随 MudReply.lines 返回给工具层 (T1 不再按文本反查行对象)。
    if (kind === 'error') {
      reply.reject(new Error(errorMessage ?? `应答未结算 (连接已断开): ${reply.cmd}`))
      this.notifySettle('error', reply.text, reply.cmds)
      this.pump()
      return
    }
    if (kind === 'timeout') {
      this.consecutiveTimeouts += 1
      const limit = this.opts.consecutiveTimeoutLimit
      if (this.consecutiveTimeouts >= limit) {
        this.consecutiveTimeouts = 0
        reply.reject(new Error(`连续 ${limit} 次应答超时 (边界未命中), 回合失败终止`))
        this.notifySettle('timeout', reply.text, reply.cmds)
        this.pump()
        return
      }
      const text = reply.text + TIMEOUT_MARKER
      reply.resolve({ ok: false, cmd: reply.cmd, text, lines: reply.lines, settled: kind })
      // P3-2: timeout 为非 GA 路径 — 遗留 GA 不结算下一帧 (R2-11: 带过期窗)。
      this.orphanBoundaries += 1
      this.orphanBoundaryAt = Date.now()
      this.notifySettle('timeout', text, reply.cmds)
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
      case 'interrupted':
        // 流程打断 (§19.4): 原因由调用方给（工具结果里可读），缺省用 INTERRUPT_TEXT。
        text = errorMessage ?? INTERRUPT_TEXT
        ok = false
        break
      default: // 'ga' | 'eor' | 'until'
        text = reply.text
        ok = true
        break
    }
    // P3-2/R2-11: 非 GA 路径 (silent/abort/interrupted/timeout/until) 遗留 GA 不结算下一帧;
    // timeout 已提前返回; error 为断线 (无后续 GA); ga/eor 为正常路径, 不计。
    if (kind !== 'ga' && kind !== 'eor') {
      this.orphanBoundaries += 1
      this.orphanBoundaryAt = Date.now()
    }
    reply.resolve({ ok, cmd: reply.cmd, text, lines: reply.lines, settled: kind })
    // 流程判定通知 (v0.4.0): 结算种类 + 帧文本 + **被这次结算关掉的命令** (§19.3 归属判据)。
    this.notifySettle(kind, text, reply.cmds)
    this.pump()
  }

  /** 结算通知 (流程判定; 回调异常不影响桥)。 */
  private notifySettle(kind: ReplySettle, text: string, cmds: readonly string[]): void {
    if (this.opts.onSettle === undefined) return
    try {
      this.opts.onSettle(kind, text, cmds)
    } catch (err) {
      this.opts.onLog?.(`[应答] onSettle 回调异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 武装后的计时: 超时必启; 静默窗仅在未声明 until 时启用。 */
  private armTimers(reply: PendingReply): void {
    // R2-4: 先清掉 pump 阶段设置的**发送守卫**定时器 (sending 兜底; 最长存活
    // 120s, 闭包持 reply)。此前直接覆盖 timeoutTimer 引用使旧守卫泄漏 —
    // settle 的 clearTimers 只清最新引用, teardown/测试退出被拖住。
    this.clearTimers(reply)
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

  /** 声明边界正则测试 (P1-2: 锚定整行正则须**逐行测** — 多行累积文本上对整串无
   *  /m 的 test 使 ^…$ 恒 false, 声明边界只能挂到声明超时)。字符串编译为
   *  RegExp; 非法正则视为永不命中。 */
  private testUntil(pattern: string | RegExp, lines: readonly MudLine[]): boolean {
    try {
      const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern
      for (const line of lines) {
        re.lastIndex = 0
        if (re.test(line.text)) return true
      }
      return false
    } catch {
      this.opts.onLog?.(`[应答] until 正则非法, 忽略: ${String(pattern)}`)
      return false
    }
  }
}