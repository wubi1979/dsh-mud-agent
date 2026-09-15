/**
 * dsh-mud-core — 命令-应答桥 (CommandResponseController), host half. 会话层.
 *
 * 命令-应答桥 (`doc/architecture/07-08-t1-bridge.md` §8.3; v0.6.0 事务表瘦身版) 的核心实现:
 * 把 "mud 工具调用 → 应答" 建模为一次 **带结算边界的请求**:
 *   - sendAndAwait(cmd, opts) → Promise<MudReply>: 工具调用同步挂起, 游戏应答
 *     到达 (GA/EOR 主边界 / until 声明判据 / 超时放弃) 后结算为 MudReply;
 *   - **响应 = 事务窗口期间提交的所有帧的并集** (§8.3): 行由宿主从**分帧器提交的帧**
 *     喂入 (`feedLines`); 桥不再自造边界 —— 静默/超时不是边界 (v0.6.0 删除), 未声明
 *     判据的请求在下一个 GA 帧结算 (八成缺省), 等待超限即放弃 (§8.4, resolve
 *     `{ok:false, settled:'timeout'}`, 帧不动、判据标记保持武装);
 *   - 一步一帧: 同一时刻至多一个**已武装** (armed = 真实写 socket 后) 的请求
 *     在等待结算; 后续请求驻留 pending, 前一个结算后才发送 (工具循环串行 +
 *     pump 双保险)。
 *     **本桥只服务我们自己命令的应答帧**; 规则判定与投递归 L1/L2
 *     (`perceive/engine.ts` 与 `runtime/session/session.ts`), 两者通过"原始行同源、
 *     责任分离"解耦 —— 桥不持有行集表, T1 也不按文本反查行对象。
 *
 * 计时语义 (§8.4): 唯一的计时器是**放弃** —— 未声明 10s / 声明 120s (可逐请求覆盖);
 * **连续 3 次放弃** → promise reject (工具 throw → DSH 失败终态), 任意非超时结算即复位。
 *
 * 接线 (宿主):
 *   - options.send: 实际入队 (宿主接 CommandQueue; 队列 onSend = 真实写 socket
 *     后调 controller.confirmSent(replyId));
 *   - feedLines: **分帧器提交的帧行** (事务窗口 = 帧并集; until 判据已上收分帧器
 *     武装标记, 命中经 `settleUntilFromSplitter` 回桥结算);
 *   - boundaryReceived: GA/EOR 帧 (§8.1 主边界): armed 请求即刻结算;
 *   - close: 断线 → 在途/排队请求全部 reject (回合 error 语义); `close()` 为**终止**语义,
 *     重连后宿主须调 `reset()` 重开控制器;
 *   - sendFailed: 宿主真实写 socket 失败/异常时回执 → 在途 sending 请求 settle error
 *     (工具 throw → 回合 error); pump 另设发送守卫: 超窗未 confirmSent 武装 → 同样 error;
 *
 * 结算出口 (§8.3/§8.4): 声明判据命中 → until (十成); 未声明 → GA/EOR 帧 (八成缺省);
 * 等待超限 → timeout (放弃)。`close()`/`signal`/发送失败语义沿用旧桥
 * (abort/error/interrupted 不变)。
 * @module @deepseek-ai/dsh-mud-core/runtime/session/bridge
 */

import type { MudLine } from '../../services/network/ansi.ts'
import { textOfLines } from '../../services/network/ansi.ts'

/** 帧边界种类 (telnet 'boundary' 事件)。 */
export type BoundaryKind = 'ga' | 'eor'

/** 结算方式: 边界 (ga/eor) / 声明 (until) / 超时放弃 (timeout, §8.4) /
 *  中止 (abort, signal) / 流程打断 (interrupted) / 连接错误 (error, 断线)。 */
export type ReplySettle = BoundaryKind | 'until' | 'timeout' | 'abort' | 'interrupted' | 'error'

/** 一次命令-应答的结算结果 (工具 execute 的返回值形状; 规则续步判定入参)。 */
export interface MudReply {
  /** 是否成功结算 (ga/eor/until 为 true; timeout/abort/interrupted/error 为 false)。 */
  ok: boolean
  /** 实际发出的命令 (串行数列时为 '命令序列')。 */
  cmd: string
  /** 完整应答文本 (事务窗口内提交帧的并集; 渲染给 agent)。 */
  text: string
  /** 纯应答行 (MudLine[], 行号/style 保真 — T1 规则续步判定的唯一来源)。 */
  lines: MudLine[]
  /** 结算方式。 */
  settled: ReplySettle
}

/** 声明边界 (until): 仅当文本命中该正则才结算 (判据上收分帧器武装标记, 跨帧累积)。 */
export interface ReplyUntil {
  regex: string | RegExp
  /** 声明请求的超时 (缺省 DECLARED_TIMEOUT_MS)。 */
  timeout?: number
}

/** 请求选项。 */
export interface ReplyOptions {
  /** 声明边界: 声明后由分帧器武装判据命中结算 (GA 帧不再结算本请求, 跨帧累积)。 */
  until?: ReplyUntil
  /** 请求级超时 (未声明 10s / 声明 120s 的覆盖值; 到点 = 放弃, §8.4)。 */
  timeout?: number
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
  /**
   * v0.6.0 S3c: until 武装标记 → 分帧器注册。宿主收到后调 splitter.arm({id, pattern, once:true})。
   * 分帧器逐行测行, 命中即提交 armed 帧 → 宿主 onFrameCommitted 调 settleUntilFromSplitter。
   */
  onUntilArm?: (markerId: string, pattern: string | RegExp) => void
  /** v0.6.0 S3c: 任何结算都注销 until 分帧器标记 (timeout/abort/error 后不能留脏标记)。 */
  onUntilDisarm?: (markerId: string) => void
}

/** v0.6.0 §8.4: timeout 放弃语义文本 (放弃 = 未等到权威边界, 内容将随帧到达)。 */
export const ABANDON_TEXT = '[应答超时，边界未命中，请决策]'
/** 中止文本。 */
export const ABORT_TEXT = '（已中止）'
/** 流程打断的缺省原因 (工具结果文本; `interruptInFlight` 用)。 */
export const INTERRUPT_TEXT = '（流程被打断：本步已作废，请按新情况决策）'

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
  abortListener: (() => void) | null
  /** v0.6.0 S3c: until 武装标记 id (分帧器对账用)。仅声明 until 时有值。 */
  markerId?: string
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
    Pick<CommandResponseControllerOptions, 'send' | 'defaultTimeoutMs' | 'declaredTimeoutMs' | 'consecutiveTimeoutLimit'>
  > & {
    onBoundary?: (kind: BoundaryKind) => void
    onLog?: (text: string) => void
    onSettle?: (kind: ReplySettle, text: string, cmds: readonly string[]) => void
    canSend?: (cmd: string) => boolean
    onUntilArm?: (markerId: string, pattern: string | RegExp) => void
    onUntilDisarm?: (markerId: string) => void
  }

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
      consecutiveTimeoutLimit: options.consecutiveTimeoutLimit ?? 3,
      ...(options.onBoundary !== undefined ? { onBoundary: options.onBoundary } : {}),
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
      ...(options.onSettle !== undefined ? { onSettle: options.onSettle } : {}),
      ...(options.canSend !== undefined ? { canSend: options.canSend } : {}),
      ...(options.onUntilArm !== undefined ? { onUntilArm: options.onUntilArm } : {}),
      ...(options.onUntilDisarm !== undefined ? { onUntilDisarm: options.onUntilDisarm } : {}),
    }
  }

  // ── 宿主接口 ───────────────────────────────────────────

  /**
   * 挂起等待应答: 注册请求 → pump 发送 (宿主队列节流) → 真实写 socket 后
   * 宿主调 confirmSent 武装 → 应答到达结算 → resolve MudReply。
   * @param cmd 单体命令或命令序列 (序列 = 同一次应答的一个帧)。
   * @param opts 结算选项 (until/timeout/signal)。
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
      abortListener: null,
    }
    // v0.6.0 S3c: until 声明 → 分配 markerId (分帧器对账用)。
    if (opts.until) reply.markerId = `tx-${reply.id}`
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
    // v0.6.0 S3c: 声明 until → 武装分帧器标记 (宿主 splitter.arm)。
    if (reply.markerId !== undefined && reply.opts.until) {
      this.opts.onUntilArm?.(reply.markerId, reply.opts.until.regex)
    }
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
   * 喂入一帧的行 (§8.3 响应 = 事务窗口期间提交帧的并集): 宿主把**分帧器提交的帧**
   * 原样喂入, 在途请求 (sending/armed) 就地累积 —— 桥不自造边界、不持有标记。
   * 无主帧 (无在途请求) 不在此登记 —— 投递由 L2 消费链负责 (§8.2 站⑤)。
   * @param lines 本帧的行。
   */
  feedLines(lines: MudLine[]): void {
    if (lines.length === 0 || this.disposed) return
    const reply = this.live
    if (!reply || (reply.state !== 'armed' && reply.state !== 'sending')) return
    // `sending` = 已调用 sendAndAwait 但还没真实写出 (队列节流窗口): 窗口期间提交的帧
    // 同样属于本事务 (§8.3 响应 = 窗口并集)。
    reply.lines = [...reply.lines, ...lines]
    reply.text = textOfLines(reply.lines)
    // until 判定归分帧器武装标记 (§8.5) — 桥只累积行, 不判边界。
  }

  /**
   * GA/EOR 帧 (§8.1 主边界, 八成): 未声明判据的 armed 请求即刻结算。
   * 声明判据 (until) 的请求**不**在此结算 —— 判据命中即结算 (十成), 跨帧累积
   * 由分帧器武装标记负责 (§8.3/§8.5)。无主边界转发 `onBoundary` (装配方据此结算投递)。
   */
  boundaryReceived(kind: BoundaryKind): void {
    const reply = this.live
    if (reply && reply.state === 'armed') {
      if (reply.markerId !== undefined) return
      this.settle(reply, kind)
      return
    }
    this.opts.onBoundary?.(kind)
  }

  /**
   * v0.6.0 S3c: 分帧器 armed marker 命中 → 按 markerId 结算 until。
   * 宿主 session 在 onFrameCommitted(armed) 时调此方法。
   * 仅当 live armed 且 markerId 匹配时 settle('until')。
   */
  settleUntilFromSplitter(markerId: string): void {
    const reply = this.live
    if (!reply || reply.state !== 'armed') return
    if (reply.markerId !== markerId) return
    this.settle(reply, 'until')
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
    // v0.6.0 S3c: 任何结算都注销 until 分帧器标记 (timeout/abort/error 后不能留脏标记)。
    if (reply.markerId !== undefined) {
      this.opts.onUntilDisarm?.(reply.markerId)
    }
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
        this.notifySettle('timeout', ABANDON_TEXT, reply.cmds)
        this.pump()
        return
      }
      // v0.6.0 §8.4: timeout = 放弃, 帧不动、标记保持武装。回放只进诊断日志。
      reply.resolve({ ok: false, cmd: reply.cmd, text: ABANDON_TEXT, lines: [], settled: kind })
      this.notifySettle('timeout', ABANDON_TEXT, reply.cmds)
      this.pump()
      return
    }

    this.consecutiveTimeouts = 0
    let text: string
    let ok: boolean
    switch (kind) {
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

  /** 武装后的计时 (§8.4): 唯一的计时器是放弃 —— 超时即 resolve 放弃, 帧不动。 */
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
  }

  private clearTimers(reply: PendingReply): void {
    if (reply.timeoutTimer) { clearTimeout(reply.timeoutTimer); reply.timeoutTimer = null }
  }
}