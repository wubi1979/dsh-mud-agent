/**
 * mud-core3 read — ReadMachine：read 竞速机（从 mud-core2 link/mud.ts 拆出独立类）。
 *
 * 工具面（mud_send）的等待引擎：send 后等新行（或裸读带 initial），判据命中即收束，
 * 返回累积行原文。挂载点 = SessionRuntime（行流多消费者模型里的又一个消费者）：
 * 行到达 → ①pending 录制（永远）→ ②read 在途则 machine.onLine → ③投递（水位线拉取）。
 *
 * 判定序（写死，承 v2 §5）：同步关窗序 **failOn > until > gaCount > maxLines**
 * （maxLines 与 gaCount 同属同步关窗、排末位）；quietMs/timeoutMs 是**异步**收束源
 * （计时器到点），与同步判据竞速。danger 不在本层测 —— 调用方（后置意识层）在
 * onLine 钩子里同步判，命中即 abortWait('danger')。
 *
 * until 失配按**关窗者**判（承 v2）：quiet/timeout 收场、或被 **maxLines** 剪断
 * （done 且命中来源为 maxLines）而 until 未命中 —— 都记 error（判据失配要吵，语料
 * 可见）；**GA/EOR 边界关窗（gaCount 命中）不算失配**（缺省 gaCount=1，完成句未到
 * 而边界先到是正常收束）；danger/signal/disconnected/failOn 是外部中断或负面命中，
 * 不吵。
 *
 * 与 v2 的差异（现行语义与判定序见 §5.2）：
 *   - Holder / root-child：砍（持有者归工具层会话级实现，T2b）；
 *   - abortWait + danger：保留 API（本期无调用者，管道就绪）；
 *   - swallow 吞行钩子：保留（空实现，本期无规则层）；
 *   - rest 字段：砍（逐行回调模型下同帧剩余行照常走 runtime 行路径）；
 *   - 自持缓冲：砍（裸读 initial 由调用方从 runtime.pendingLines 取尾部）。
 *
 * 纯度纪律：不 import 宿主；**端口词汇表（收束原因 + 命中帧）单点声明在契约层**
 *（`mud-workflow/contract`，§8.8 A1），本文件 type-only 引用。
 *
 * 命中帧（T15，§5.2）：判据命中时同时给出「哪条判据赢了 + 该条首个命中的捕获组」。
 * 判定与取组用**同一次 `exec` 调用**（不写 test → exec 两段），且调用前重置
 * `lastIndex`（`g`/`y` 是有状态正则，跨评估会污染起点）。流程侧据此直接路由与
 * 填槽，不再在解释器里重测一遍。
 */

import type { IoReadReason, ReadHit } from 'mud-workflow/contract'
import type { MudLine } from './link/line.ts'

/** read 收束原因（词汇表单点声明在契约层 `IoReadReason`；本名保留供本包内部阅读）。 */
export type ReadReason = IoReadReason

/** 同步判据命中：收束原因 + 关窗来源（until 失配判责用）+ 命中帧（判据命中才有）。 */
interface CriterionHit {
  reason: ReadReason
  source: 'failOn' | 'until' | 'gaCount' | 'maxLines'
  hit: ReadHit | undefined
}

/** read 参数。timeoutMs 必须显式给出或由工具注入缺省 —— 绝不无界等待。 */
export interface ReadOpts {
  /** 完成判据：在累积文本（各行 text 以 \n 连接）上测，**可跨批命中**。 */
  until?: RegExp[]
  /** 负面判据：命中即以 failOn 收束（优先于 until）。 */
  failOn?: RegExp[]
  /** GA/EOR 边界计数关窗（undefined = 无 GA 关窗；工具层注入缺省 1）。 */
  gaCount?: number
  /** 行间静默毫秒：最后一次行到达后静默即收（quiet）。 */
  quietMs?: number
  /** 总超时毫秒：**必填**，到点以 timeout 收束。 */
  timeoutMs: number
  /** 行数兜底：累积行数达到即以 done（source=maxLines）收束。 */
  maxLines?: number
  /** 中止信号：abort 即以 signal 收束。 */
  signal?: AbortSignal
}

/**
 * read 结果：累积行 + 收束原因 + 命中判据帧（lines 含 initial 与 abortWait 收编的
 * 触发行）。本类型是**本包实现面**（行是完整 `MudLine`）；对外端口面见契约
 * `IoReadResult`（行窄面 `IoLine`、同名字段 `hit`，结构化可赋值）。
 */
export interface ReadResult {
  lines: MudLine[]
  reason: ReadReason
  /** 命中帧；无判据命中（gaCount/maxLines 关窗、异步收束）时为 undefined。 */
  hit: ReadHit | undefined
}

/** 在途状态。 */
interface ReadState {
  readonly opts: ReadOpts
  acc: MudLine[]
  accText: string
  gaSeen: number
  quietTimer: ReturnType<typeof setTimeout> | null
  readonly timeoutTimer: ReturnType<typeof setTimeout>
  onAbort: (() => void) | null
  resolve: (r: ReadResult) => void
}

/** read 竞速机（独立类，挂 SessionRuntime；并发 start fail-loud）。 */
export class ReadMachine {
  /** 记错通道（until 失配等；语料可见）。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null
  /**
   * 吞行钩子（规则层注入位，本期空实现）：返回 'swallow' 即吞掉该行——不进 acc。
   * 完整吞行语义（不进 pending/不推进水位）随规则层落地（后置）。
   */
  onSwallow: ((line: MudLine) => 'swallow' | void) | null = null

  private state: ReadState | null = null

  /** 是否有在途 read。 */
  get inFlight(): boolean {
    return this.state !== null
  }

  /**
   * 开始一次 read（并发 start fail-loud）。initial = 裸读尾部快照（有 cmd 传空），
   * 立即参与判定（先到先结算——缓冲有行且之后再无数据时也能立即收束）。
   */
  start(opts: ReadOpts, initial: readonly MudLine[] = []): Promise<ReadResult> {
    if (this.state !== null) throw new Error('read 已在途：同一会话同一时刻只允许一个 read（持有者冲突）')
    return new Promise<ReadResult>((resolve) => {
      const acc = [...initial]
      const accText = initial.map(l => l.text).join('\n')
      const state: ReadState = {
        opts,
        acc,
        accText,
        gaSeen: 0,
        quietTimer: null,
        timeoutTimer: setTimeout(() => { this.finish('timeout') }, opts.timeoutMs),
        onAbort: null,
        resolve,
      }
      this.state = state
      if (opts.signal !== undefined) {
        if (opts.signal.aborted) {
          this.finish('signal')
          return
        }
        state.onAbort = () => { this.finish('signal') }
        opts.signal.addEventListener('abort', state.onAbort, { once: true })
      }
      // initial 立即结算；有预取行则武装 quiet（否则"缓冲有行 + 之后再无数据"
      // 时静默计时器永远不存在，只能等 timeout）。
      if (acc.length > 0) this.armQuiet(state)
      const hit = this.evaluate(state)
      if (hit !== null) this.finish(hit.reason, hit.source, hit.hit)
    })
  }

  /** 行到达（runtime 行路径在 read 在途时调用）：累积 + 判定。 */
  onLine(line: MudLine): void {
    const state = this.state
    if (state === null) return
    if (this.onSwallow?.(line) === 'swallow') return
    state.acc.push(line)
    state.accText += `${state.accText ? '\n' : ''}${line.text}`
    this.armQuiet(state)
    const hit = this.evaluate(state)
    if (hit !== null) this.finish(hit.reason, hit.source, hit.hit)
  }

  /** GA/EOR 边界（runtime 边界钩子在 read 在途时调用）。 */
  onBoundary(): void {
    const state = this.state
    if (state === null) return
    state.gaSeen += 1
    const hit = this.evaluate(state)
    if (hit !== null) this.finish(hit.reason, hit.source, hit.hit)
  }

  /** 断线收束（runtime 断线路径调用）。 */
  onDisconnected(): void {
    if (this.state === null) return
    this.finish('disconnected')
  }

  /**
   * 打断在途 read（后置意识层 danger 出口）：触发行由调用方收编进结果
   * （现场随 reason:'danger' 上抛）。
   */
  abortWait(line?: MudLine): void {
    const state = this.state
    if (state === null) return
    if (line !== undefined) {
      state.acc.push(line)
      state.accText += `${state.accText ? '\n' : ''}${line.text}`
    }
    this.finish('danger')
  }

  // ---------------------------------------------------------------------

  /**
   * 声明序找首个命中判据：**单次 `exec`** 同时得到命中（下标）与捕获组；调用前
   * 重置 `lastIndex` —— `g`/`y` 是有状态正则（起点由 `lastIndex` 决定），跨评估
   * 不重置会让"同一判据在窗口变长后时灵时不灵"（§5.2）。
   */
  private matchFirst(by: 'until' | 'failOn', res: readonly RegExp[] | undefined, text: string): ReadHit | null {
    if (res === undefined) return null
    for (let i = 0; i < res.length; i++) {
      const re = res[i]!
      re.lastIndex = 0
      const m = re.exec(text)
      if (m !== null) return { by, index: i, groups: m.slice(1) }
    }
    return null
  }

  /** 同步判定（写死判定序）：failOn > until > gaCount > maxLines。 */
  private evaluate(state: ReadState): CriterionHit | null {
    const { opts, acc, accText } = state
    const failOnHit = this.matchFirst('failOn', opts.failOn, accText)
    if (failOnHit !== null) return { reason: 'failOn', source: 'failOn', hit: failOnHit }
    const untilHit = this.matchFirst('until', opts.until, accText)
    if (untilHit !== null) return { reason: 'done', source: 'until', hit: untilHit }
    if (opts.gaCount !== undefined && state.gaSeen >= opts.gaCount) {
      return { reason: 'done', source: 'gaCount', hit: undefined }
    }
    if (opts.maxLines !== undefined && acc.length >= opts.maxLines) {
      return { reason: 'done', source: 'maxLines', hit: undefined }
    }
    return null
  }

  /** 行间静默计时器（每行重置；quietMs 未声明不武装）。 */
  private armQuiet(state: ReadState): void {
    if (state.opts.quietMs === undefined) return
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    state.quietTimer = setTimeout(() => { this.finish('quiet') }, state.opts.quietMs)
  }

  /** 收束：清计时器/信号监听 → until 失配判责 → resolve（带命中帧）。 */
  private finish(reason: ReadReason, source?: CriterionHit['source'], hit?: ReadHit): void {
    const state = this.state
    if (state === null) return
    this.state = null
    clearTimeout(state.timeoutTimer)
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    if (state.opts.signal !== undefined && state.onAbort !== null) {
      state.opts.signal.removeEventListener('abort', state.onAbort)
    }
    // until 失配判责（承 core2）：until 声明了却没有 until 命中帧，而收场者是
    // quiet/timeout 或被 maxLines 剪断 —— 记 error。gaCount 边界关窗不算失配。
    // 判责由命中帧判定，不再复测正则（顺带消掉有状态正则的第二次调用）。
    if (state.opts.until !== undefined && hit?.by !== 'until'
      && (reason === 'quiet' || reason === 'timeout' || source === 'maxLines')) {
      this.onLog?.('error', `read 判据失配：until 未命中即收束（reason=${reason}）`)
    }
    state.resolve({ lines: state.acc, reason, hit })
  }
}
