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

import type { ClosureKind, IoReadReason, OutcomeKind, OutcomeName, ReadHit } from 'mud-workflow/contract'
import type { MudLine } from './link/line.ts'

/** read 收束原因（词汇表单点声明在契约层 `IoReadReason`；本名保留供本包内部阅读）。 */
export type ReadReason = IoReadReason

/** 同步判据命中：收束原因 + 关窗来源（until 失配判责用）+ 命中帧（判据命中才有）。 */
interface CriterionHit {
  reason: ReadReason
  source: 'failOn' | 'until' | 'gaCount' | 'maxLines' | 'silence'
  hit: ReadHit | undefined
}

/** 结局槽（T26；与装配器 CompiledSlot 同形——读窗机只认正则数组 + 并行名表）。 */
export interface ReadSlot {
  readonly name: OutcomeName
  readonly kind: OutcomeKind
  readonly res: readonly RegExp[]
}

/**
 * read 参数。timeoutMs 必须显式给出或由工具注入缺省 —— 绝不无界等待。
 *
 * T26 形态分档（§3.2）：`closeOn` 给出时按四值配方判定——
 *   - `'criteria'` / `'race'`：**槽收窗**（fail 槽先于 ok 槽 = 判定序
 *     failOn > until），GA 不武装；`'race'` 另与静默（quietMs）竞速；
 *   - `'ga'` / `'quiet'`：**槽仅分类**（GA / 静默是唯一收窗者，收束时扫窗文本
 *     分类出 outcome；`'ga'` 的 GA 计数 = `gaCount ?? 1`）；此时 `until` /
 *     `failOn` / `gaCount`（非 'ga'）不参与判定；
 * `closeOn` 缺省 = 现役遗留语义（判据即收窗、GA 按 gaCount、失配判责照旧）。
 */
export interface ReadOpts {
  /** 完成判据（遗留形态）：在累积文本（各行 text 以 \n 连接）上测，**可跨批命中**。 */
  until?: readonly RegExp[]
  /** 负面判据（遗留形态）：命中即以 failOn 收束（优先于 until）。 */
  failOn?: readonly RegExp[]
  /** 收窗形态（T26）：给出时判据由 `slots` 派生，`until`/`failOn` 不参与判定。 */
  closeOn?: ClosureKind
  /** 结局槽表（T26；fail 槽在前 = 判定序）。 */
  slots?: readonly ReadSlot[]
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

/** 平行名表单元：判据命中时给结局槽名（遗留判据无名 ⇒ 缺省）与槽内 pattern 下标。 */
interface CriteriaMeta {
  readonly name?: OutcomeName
  readonly patIdx: number
}

/** 判据派生产（start 时一次算好）：槽表 → fail/until 两组正则数组 + 并行名表。 */
interface DerivedCriteria {
  readonly failRes: readonly RegExp[]
  readonly failMeta: readonly CriteriaMeta[]
  readonly untilRes: readonly RegExp[]
  readonly untilMeta: readonly CriteriaMeta[]
  /** 槽表全量（ga/quiet 的收束分类用；criteria/race 的判据已派生进上四项）。 */
  readonly slots: readonly ReadSlot[]
}

/**
 * 判据派生（T26 形态分档，§3.2）：
 *   - 遗留（closeOn 缺省）：until/failOn 原样（无名表）；
 *   - `'criteria'` / `'race'`：fail 槽 → failOn、ok 槽（非空）→ until（槽已按
 *     fail 在前排序，此处保序摊平）；
 *   - `'ga'` / `'quiet'`：槽不参与收窗判定（收束时分类），数组保持为空——
 *     判据进了 until/fail 就会在行到达时收窗，GA/静默分类机制被短路。
 */
function deriveCriteria(opts: ReadOpts): DerivedCriteria {
  if (opts.closeOn === undefined) {
    const failOn = opts.failOn ?? []
    const until = opts.until ?? []
    return {
      failRes: failOn,
      failMeta: failOn.map((_, i) => ({ patIdx: i })),
      untilRes: until,
      untilMeta: until.map((_, i) => ({ patIdx: i })),
      slots: [],
    }
  }
  const failRes: RegExp[] = []
  const failMeta: CriteriaMeta[] = []
  const untilRes: RegExp[] = []
  const untilMeta: CriteriaMeta[] = []
  if (opts.closeOn === 'criteria' || opts.closeOn === 'race') {
    for (const slot of opts.slots ?? []) {
      const target = slot.kind === 'fail'
        ? { res: failRes, meta: failMeta }
        : { res: untilRes, meta: untilMeta }
      slot.res.forEach((re, patIdx) => {
        target.res.push(re)
        target.meta.push({ name: slot.name, patIdx })
      })
    }
  }
  return { failRes, failMeta, untilRes, untilMeta, slots: opts.slots ?? [] }
}

/** 在途状态。 */
interface ReadState {
  readonly opts: ReadOpts
  readonly derived: DerivedCriteria
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
        derived: deriveCriteria(opts),
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
   *
   * 命中帧（§3.3）：槽判据命中带 `outcome`（槽名）+ `kind`，`index` = 槽内
   * pattern 下标；遗留判据（无名表）`index` = 数组下标、不带 outcome。
   */
  private matchFirst(by: 'until' | 'failOn', res: readonly RegExp[], meta: readonly CriteriaMeta[], text: string): ReadHit | null {
    for (let i = 0; i < res.length; i++) {
      const re = res[i]!
      re.lastIndex = 0
      const m = re.exec(text)
      if (m === null) continue
      const groups = m.slice(1)
      const metaI = meta[i]!
      return metaI.name !== undefined
        ? { by, index: metaI.patIdx, groups, outcome: metaI.name, kind: by === 'failOn' ? 'fail' : 'ok' }
        : { by, index: i, groups }
    }
    return null
  }

  /**
   * 收束分类（'ga' 边界 / 'silence' 静默收束时扫窗文本）：fail 槽先于 ok 槽
   *（判定序），槽内按 pattern 序——命中即给结局帧；全不命中 = 无分类（'ga'
   * 收窗无结局；静默收窗再退推定槽，见 onQuiet）。
   */
  private classify(state: ReadState, by: 'ga' | 'silence'): ReadHit | undefined {
    for (const slot of state.derived.slots) {
      for (let i = 0; i < slot.res.length; i++) {
        const re = slot.res[i]!
        re.lastIndex = 0
        const m = re.exec(state.accText)
        if (m !== null) {
          return { by, index: i, groups: m.slice(1), outcome: slot.name, kind: slot.kind }
        }
      }
    }
    return undefined
  }

  /** 推定槽帧（静默收束无分类命中时；`patterns: []` 的槽由静默机制填，DEC-5）。 */
  private presumedSlot(state: ReadState): ReadHit | undefined {
    const slot = state.derived.slots.find(s => s.res.length === 0)
    return slot !== undefined
      ? { by: 'silence', index: -1, groups: [], outcome: slot.name, kind: slot.kind }
      : undefined
  }

  /**
   * 同步判定：判定序 **failOn > until > gaCount > maxLines**（写死）。
   * 形态分档（§3.2）：`'criteria'`/`'race'` 槽收窗、GA 不武装；`'ga'` GA 收窗
   *（`gaCount ?? 1`）且槽仅分类（收束时 classify）；`'quiet'` 无同步收窗者
   *（静默是唯一收窗者，见 onQuiet）；遗留（closeOn 缺省）照旧。
   */
  private evaluate(state: ReadState): CriterionHit | null {
    const { opts, derived, acc, accText } = state
    const failOnHit = this.matchFirst('failOn', derived.failRes, derived.failMeta, accText)
    if (failOnHit !== null) return { reason: 'failOn', source: 'failOn', hit: failOnHit }
    const untilHit = this.matchFirst('until', derived.untilRes, derived.untilMeta, accText)
    if (untilHit !== null) return { reason: 'done', source: 'until', hit: untilHit }
    if (opts.closeOn === 'ga') {
      if (state.gaSeen >= (opts.gaCount ?? 1)) {
        return { reason: 'done', source: 'gaCount', hit: this.classify(state, 'ga') }
      }
    } else if (opts.closeOn === undefined && opts.gaCount !== undefined && state.gaSeen >= opts.gaCount) {
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
    state.quietTimer = setTimeout(() => { this.onQuiet(state) }, state.opts.quietMs)
  }

  /**
   * 静默到点（T26.4）：`'race'` / `'quiet'` 下静默是**合法收束者**——以
   * `by: 'silence'` 命中帧上报（分类 → 推定槽 → 裸 silence 帧三级回退），消费侧
   * 据此走**正常出口**；其它形态/遗留语义照旧（quiet 收束、无命中帧）。
   */
  private onQuiet(state: ReadState): void {
    const closeOn = state.opts.closeOn
    if (closeOn === 'race' || closeOn === 'quiet') {
      const hit = this.classify(state, 'silence')
        ?? this.presumedSlot(state)
        ?? { by: 'silence' as const, index: -1, groups: [] as readonly (string | undefined)[] }
      this.finish('quiet', 'silence', hit)
      return
    }
    this.finish('quiet')
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
    // quiet/timeout 或被 maxLines 剪断 —— 记 error。分档（§3.2）：
    //   - 遗留（closeOn 缺省）：quiet/timeout/maxLines 三种收场都判（现役口径）；
    //   - `'criteria'` / `'race'`：timeout/maxLines 判；静默（'race'）是**合法
    //     收束者**（推定完成）不判；gaCount 关窗不算失配（同现役）；
    //   - `'ga'` / `'quiet'`：槽不收窗 ⇒ 无 until 声明 ⇒ 天然不判。
    const criteriaMiss = state.derived.untilRes.length > 0 && hit?.by !== 'until'
    const missError = criteriaMiss && (state.opts.closeOn === undefined
      ? reason === 'quiet' || reason === 'timeout' || source === 'maxLines'
      : reason === 'timeout' || source === 'maxLines')
    if (missError) {
      this.onLog?.('error', `read 判据失配：until 未命中即收束（reason=${reason}）`)
    }
    state.resolve({ lines: state.acc, reason, hit })
  }
}
