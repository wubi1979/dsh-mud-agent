/**
 * mud-core3 read — 行流等待竞速机（ReadMachine）。
 *
 * 从 core2 link/mud.ts 的 read 竞速机拆出（二期工具面，doc/PLAN.md「二期详细设计 §3」）。
 * core2 里它与连接/缓冲/持有者耦合在 Mud 类内；core3 改造为独立类，挂在
 * SessionRuntime 上，作为行流的又一个消费者：
 *   行到达 → pending 录制（永远）→ readMachine.onLine（在途时 acc + 判定）→ 投递。
 *
 * 移植保（判定序写死）：
 *   - 同步关窗序 **failOn > until > gaCount > maxLines**（maxLines 与 gaCount 同属
 *     同步关窗、排末位——行数兜底不得抢在边界关窗之前剪断）；
 *   - **gaCount 显式声明才判定**（缺省不关窗）：有 cmd 由工具层显式注入 gaCount:1
 *     （等一段完整文字）；裸读不传，则 GA/EOR 到达不构成关窗——裸读判据只有
 *     maxLines + quietMs（用户裁决：裸读是「读尾部近况」不是「等一段应答」）；
 *   - 异步收束源 quiet / timeout / signal / disconnected 与同步判据竞速；
 *     danger 走 onSwallow 钩子内同步 abortWait 出口；
 *   - until 失配记错（按**关窗者**判：quiet/timeout 收场、或被 maxLines 剪断而
 *     until 未命中要吵；GA/EOR 边界关窗不算失配；danger/signal/disconnected/
 *     failOn 是外部中断或负面命中，也不吵）；
 *   - abortWait + danger 收束原因（意识层后置接线的打断出口；用户裁定：拦路/
 *     叫杀是真实例证，本期无调用者、管道就绪）；
 *   - 吞行钩子（返回 'swallow' 的行不进 acc；调用方据此也不推进水位——规则动作
 *     吞行留摘要，本二期空实现）。
 *
 * 移植砍/改（core3 无 root/child、无意识层、缓冲归 runtime）：
 *   - Holder / root-child 持有者判定：**砍**（单会话单 agent；并发 start fail-loud 兜底）；
 *   - 有界缓冲：**砍**（复用 runtime.pendingLines 录制缓冲；initial 由调用方传入——
 *     有 cmd 传空，裸读传 pending 尾部快照）；
 *   - rest 同帧移交：**砍**（逐行回调模型下，判据命中后同帧剩余行照常走行流路径
 *     进 pending + 推进水位，等价 rest 并回缓冲）；
 *   - onExchange 观测：**砍**（后置）。
 *
 * 禁令（承 core2）：不解释语义、不做危险判断（判据在调用方）、竞速机不持有
 * 业务状态。
 *
 * 纯度纪律：本文件不 import 宿主（只 import MudLine 类型）。
 */

import type { MudLine } from './link/line.ts'

/** read 收束原因。 */
export type ReadReason =
  | 'done'          // until / gaCount / maxLines 判据满足
  | 'failOn'        // 负面判据命中
  | 'timeout'       // 总超时
  | 'quiet'         // 行间静默到期
  | 'signal'        // 中止信号（释放阀门）
  | 'disconnected'  // 连接关闭
  | 'danger'        // 危险打断（abortWait）

/** read 竞速参数。timeoutMs 必填（工具层注入缺省）——绝不无界等待。 */
export interface ReadOpts {
  /** 完成判据：在累积文本（各行 text 以 \n 连接）上测，可跨批命中。 */
  until?: RegExp[]
  /** 负面判据：命中即以 failOn 收束（判序第一；agent 驱动的打断机制）。 */
  failOn?: RegExp[]
  /**
   * GA/EOR 边界计数关窗——**显式声明才判定**（缺省不关窗）：有 cmd 调用方传 1
   * （一段完整文字）；裸读不传，GA 到达只计数不关窗（裸读判据 = maxLines +
   * quietMs，见 §5）。
   */
  gaCount?: number
  /** 行间静默毫秒：最后一次行到达后静默即收（quiet）。 */
  quietMs?: number
  /** 总超时毫秒：必填，到点以 timeout 收束。 */
  timeoutMs: number
  /** 行数兜底：累积行数达到即以 done 收束（判定序末位）。 */
  maxLines?: number
  /** 中止信号：abort 即以 signal 收束并释放。 */
  signal?: AbortSignal
}

/** read 结果。core3 无 rest 字段（判据命中后同帧剩余行照常走行流路径）。 */
export interface ReadResult {
  lines: MudLine[]
  reason: ReadReason
}

/** 同步判据命中：收束原因 + 关窗来源（until 失配判责用）。 */
interface CriterionHit {
  reason: ReadReason
  source: 'failOn' | 'until' | 'gaCount' | 'maxLines'
}

/** 竞速中的等待状态（会话级唯一；并发 start fail-loud）。 */
interface WaitState {
  opts: ReadOpts
  acc: MudLine[]
  /** acc 各行 text 以 \n 连接（判据可跨批命中）。 */
  accText: string
  gaSeen: number
  quietTimer: ReturnType<typeof setTimeout> | null
  timeoutTimer: ReturnType<typeof setTimeout>
  onAbort: (() => void) | null
  resolve: (r: ReadResult) => void
}

/** 行流等待竞速机（会话级唯一实例，挂 SessionRuntime）。 */
export class ReadMachine {
  /** 记错通道（until 失配要吵，语料可见）。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null
  /**
   * 吞行判定钩子（反射/规则层注入；本期空缺，管道就绪）：每行进 acc 前（以及
   * 调用方归档前）回调，返回 'swallow' 即吞掉该行——不进 acc，调用方据此也不进
   * pending/投递（规则动作吞行留摘要，见 PLAN「二期详细设计 §4」水位线语义总表）。
   * 钩子内也可同步 abortWait(line) 打断在途 read（触发行由 abortWait 收编进现场）。
   */
  onSwallow: ((line: MudLine) => 'swallow' | void) | null = null

  private reading: WaitState | null = null

  /** 是否有在途 read。 */
  get inFlight(): boolean {
    return this.reading !== null
  }

  /**
   * 开始一次 read 竞速（并发 start fail-loud，不做队列）。
   * @param opts - 竞速参数（timeoutMs 必填）。
   * @param initial - 开始时已有的行（有 cmd = 空；裸读 = pending 尾部快照）。
   *   立即参与判定（先到先结算，可立即命中收束）。
   */
  start(opts: ReadOpts, initial: readonly MudLine[] = []): Promise<ReadResult> {
    if (this.reading !== null) {
      throw new Error('read 竞速冲突：已有在途 read（fail-loud，不做队列）')
    }
    return new Promise<ReadResult>((resolve) => {
      const acc = [...initial]
      const state: WaitState = {
        opts,
        acc,
        accText: acc.map(l => l.text).join('\n'),
        gaSeen: 0,
        quietTimer: null,
        timeoutTimer: setTimeout(() => { this.finish('timeout') }, opts.timeoutMs),
        onAbort: null,
        resolve,
      }
      this.reading = state
      if (opts.signal) {
        const signal = opts.signal
        if (signal.aborted) {
          this.finish('signal')
          return
        }
        const onAbort = (): void => { this.finish('signal') }
        state.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // 已有行可能立即满足判据；有 initial 行则武装 quiet（否则"有积压行 +
      // 之后再无数据"时静默计时器永远不存在，只能等 timeout）。
      const hit = this.evaluate(state)
      if (hit !== null) {
        this.finish(hit.reason, hit.source)
        return
      }
      if (acc.length > 0) this.resetQuiet(state)
    })
  }

  /**
   * 行到达（runtime 行路径调用；**每行都调**——吞行判定永续，与谁在等无关；
   * 非在途且不吞时为空操作，行照常进 pending 录制）。
   * @returns 'swallow' = 该行被吞（调用方据此跳过 pending/画面/投递归档）。
   */
  onLine(line: MudLine): 'swallow' | void {
    const verdict = this.onSwallow?.(line)
    if (verdict === 'swallow') return 'swallow'
    const state = this.reading
    if (state === null) return
    // 钩子内可能已同步 abortWait（触发行已由 abort 收编进结果），不得重复进 acc。
    if (this.reading === null) return
    state.acc.push(line)
    state.accText += `${state.accText ? '\n' : ''}${line.text}`
    this.resetQuiet(state)
    const hit = this.evaluate(state)
    if (hit !== null) this.finish(hit.reason, hit.source)
  }

  /** GA/EOR 边界（mud.onBoundary 直挂；行尾已先经 onLine 分发——行先于边界）。 */
  onBoundary(): void {
    const state = this.reading
    if (state === null) return
    state.gaSeen += 1
    const hit = this.evaluate(state)
    if (hit !== null) this.finish(hit.reason, hit.source)
  }

  /** 断线收束（runtime 的 onDisconnect 链）：在途 read 以 disconnected 收束。 */
  onDisconnected(): void {
    if (this.reading !== null) this.finish('disconnected')
  }

  /**
   * 打断在途 read（意识层 danger 出口，本期无调用者、管道就绪）；无在途时空操作。
   * 触发行由调用方收编进结果（现场随 reason:'danger' 上抛）。
   */
  abortWait(line?: MudLine): void {
    const state = this.reading
    if (state === null) return
    if (line !== undefined) {
      state.acc.push(line)
      state.accText += `${state.accText ? '\n' : ''}${line.text}`
    }
    this.finish('danger')
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /** 判定序（写死）：failOn > until > gaCount > maxLines。quiet/timeout/signal/
   *  disconnected/danger 是外部收束源，不在本表。gaCount **显式声明才判定**（缺省
   *  不关窗——裸读判据只有 maxLines + quiet，GA 到达不构成关窗）。 */
  private evaluate(state: WaitState): CriterionHit | null {
    if (state.opts.failOn?.some(re => re.test(state.accText))) return { reason: 'failOn', source: 'failOn' }
    if (state.opts.until?.some(re => re.test(state.accText))) return { reason: 'done', source: 'until' }
    if (state.opts.gaCount !== undefined && state.gaSeen >= state.opts.gaCount) {
      return { reason: 'done', source: 'gaCount' }
    }
    if (state.opts.maxLines !== undefined && state.acc.length >= state.opts.maxLines) {
      return { reason: 'done', source: 'maxLines' }
    }
    return null
  }

  /** 收束：清计时器/信号监听、until 失配记错（按关窗者判）、resolve。 */
  private finish(reason: ReadReason, doneSource?: CriterionHit['source']): void {
    const state = this.reading
    if (state === null) return
    this.reading = null
    clearTimeout(state.timeoutTimer)
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    if (state.onAbort !== null) state.opts.signal?.removeEventListener('abort', state.onAbort)
    // until 失配记错（判据失配要吵，语料可见）：按**关窗者**判——quiet/timeout
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
        this.onLog?.('error', `until 判据失配：以 ${reason} 收场，累积 ${state.acc.length} 行未见完成句（语料可见）`)
      }
    }
    state.resolve({ lines: state.acc, reason })
  }

  /** 行间静默：每行重置；initial 有行时在 start 里先行武装。 */
  private resetQuiet(state: WaitState): void {
    if (state.opts.quietMs === undefined) return
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    state.quietTimer = setTimeout(() => {
      if (this.reading === state) this.finish('quiet')
    }, state.opts.quietMs)
  }
}
