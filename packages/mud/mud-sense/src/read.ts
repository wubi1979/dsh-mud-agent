/**
 * mud-core3 read — ReadMachine：读窗机（从 mud-core2 link/mud.ts 拆出独立类）。
 *
 * 工具面（mud_send）与流程缝的等待引擎：send 后等新行（或裸读带 initial），
 * 判据命中即收束，返回累积行原文。挂载点 = SessionRuntime（行流多消费者模型里
 * 的又一个消费者）：行到达 → ①pending 录制（永远）→ ②read 在途则
 * machine.onLine → ③投递（水位线拉取）。
 *
 * **三形态（T26.6 终态，DEC-3；race/静默计时器 2026-10-12 退役）**：
 *   - `'criteria'`：槽收窗（判定序 **fail 槽 > ok 槽**，同帧 fail 收束防误判），
 *     GA 不武装（受理帧 GA 正是要忽略的）；判据失配（timeout/maxLines 收场）记 error；
 *   - `'ga'`：GA/EOR 计数收窗（`gaCount ?? 1`，可等第 N 个）；**分类槽可选——
 *     声明即断言**：关窗时扫窗分类，无一命中 ⇒ 合成 fail 帧（`by:'ga'` 无
 *     outcome——「收窗成功，分支未知」，DP 裁定 8）；未声明分类槽 ⇒ 无帧；
 *   - `'quiet'`：**固定采样窗**——唯一计时器 `timeoutMs`，行只累积**不重置**；
 *     到点关窗按行数合成帧：有行 ⇒ ok（`reason:'quiet'`）、零行 ⇒ fail
 *     （`reason:'timeout'`，等同 timeout）；reason 不参与路由（消费侧只看 kind）；
 *   - `closeOn` 缺省 = **裸读**（无 cmd 的读，不是「某条命令的收窗」）：按
 *     `quietMs + maxLines + timeout` 收窗（§8.7 现口径——quietMs 保留为裸读
 *     参数，不在命令判据词汇中）。
 *
 * maxLines 各形态通用兜底（如实报告 `by:'maxLines'`，不冒充完成）。
 * danger 不在本层测——调用方（后置意识层）在 onLine 钩子里同步判，命中即
 * abortWait('danger')。
 *
 * 命中帧（T15/§3.3）：判据命中时同时给出「哪条判据赢了 + 该条首个命中的捕获组」。
 * 判定与取组用**同一次 `exec` 调用**（不写 test → exec 两段），且调用前重置
 * `lastIndex`（`g`/`y` 是有状态正则，跨评估会污染起点）。流程侧据此直接路由与
 * 填槽，不再在解释器里重测一遍。
 *
 * 纯度纪律：不 import 宿主；**端口词汇表（收束原因 + 命中帧）单点声明在契约层**
 *（`mud-workflow/contract`，§8.8 A1），本文件 type-only 引用。
 */

import type { ClosureKind, IoReadReason, OutcomeKind, ReadHit } from 'mud-workflow/contract'
import type { MudLine } from 'mud-link/line'

/** read 收束原因（词汇表单点声明在契约层 `IoReadReason`；本名保留供本包内部阅读）。 */
export type ReadReason = IoReadReason

/** 同步判据命中：收束原因 + 关窗来源（criteria 失配判责用）+ 命中帧。 */
interface CriterionHit {
  reason: ReadReason
  source: 'criteria' | 'ga' | 'maxLines'
  hit: ReadHit | undefined
}

/** 结局槽（与装配器 CompiledSlot 同形——读窗机只认正则数组 + 并行名表）。 */
export interface ReadSlot {
  readonly name: string
  readonly kind: OutcomeKind
  readonly res: readonly RegExp[]
}

/**
 * read 参数。`timeoutMs` 必须显式给出或由缝/工具注入缺省——绝不无界等待。
 * `closeOn` 三值（显式单值）；缺省 = 裸读（quietMs/maxLines/timeout 收窗）。
 */
export interface ReadOpts {
  /** 收窗形态（T26.6 三值；缺省 = 裸读）。 */
  closeOn?: ClosureKind
  /** 结局槽表（criteria = 收窗判据；ga = 收束分类；quiet 不用）。 */
  slots?: readonly ReadSlot[]
  /** GA/EOR 边界计数关窗（仅 ga 形态；缺省 1）。 */
  gaCount?: number
  /** 行间静默毫秒（**仅裸读**：最后一次行到达后静默即收；命令判据面不用）。 */
  quietMs?: number
  /** 总超时毫秒：**必填**，到点以 timeout 收束（quiet 形态 = 采样窗长）。 */
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
  /** 命中帧；quiet 形态总有合成帧；criteria 失配 / ga 未到 / 裸读异步收束无帧。 */
  hit: ReadHit | undefined
}

/** 平行名表单元：判据命中时给结局槽名与槽内 pattern 下标。 */
interface CriteriaMeta {
  readonly name: string
  readonly kind: OutcomeKind
  readonly patIdx: number
}

/** 判据派生产（start 时一次算好）：槽表 → fail/ok 两组正则数组 + 并行名表。 */
interface DerivedCriteria {
  readonly failRes: readonly RegExp[]
  readonly failMeta: readonly CriteriaMeta[]
  readonly okRes: readonly RegExp[]
  readonly okMeta: readonly CriteriaMeta[]
  /** 槽表全量（ga 的收束分类用）。 */
  readonly slots: readonly ReadSlot[]
}

/**
 * 判据派生（三形态分档）：
 *   - `'criteria'`：fail 槽 → failRes、ok 槽 → okRes（判定序 fail 先）；
 *   - `'ga'`：槽不参与收窗判定（收束时分类），数组为空；
 *   - `'quiet'` / 裸读：无判据，数组为空。
 */
function deriveCriteria(opts: ReadOpts): DerivedCriteria {
  const failRes: RegExp[] = []
  const failMeta: CriteriaMeta[] = []
  const okRes: RegExp[] = []
  const okMeta: CriteriaMeta[] = []
  if (opts.closeOn === 'criteria') {
    for (const slot of opts.slots ?? []) {
      const target = slot.kind === 'fail'
        ? { res: failRes, meta: failMeta }
        : { res: okRes, meta: okMeta }
      slot.res.forEach((re, patIdx) => {
        target.res.push(re)
        target.meta.push({ name: slot.name, kind: slot.kind, patIdx })
      })
    }
  }
  return { failRes, failMeta, okRes, okMeta, slots: opts.slots ?? [] }
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

/** 读窗机（独立类，挂 SessionRuntime；并发 start fail-loud）。 */
export class ReadMachine {
  /** 记错通道（criteria 失配等；语料可见）。 */
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
      // initial 立即结算；裸读有预取行则武装 quiet（否则"缓冲有行 + 之后再无
      // 数据"时静默计时器永远不存在，只能等 timeout）。
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
   * 命中帧（§3.3）：`by:'criteria'` + 槽名 + kind + 槽内 pattern 下标。
   */
  private matchFirst(res: readonly RegExp[], meta: readonly CriteriaMeta[], text: string): ReadHit | null {
    for (let i = 0; i < res.length; i++) {
      const re = res[i]!
      re.lastIndex = 0
      const m = re.exec(text)
      if (m === null) continue
      const metaI = meta[i]!
      return { by: 'criteria', index: metaI.patIdx, groups: m.slice(1), outcome: metaI.name, kind: metaI.kind }
    }
    return null
  }

  /**
   * ga 关窗分类（DP 裁定 1/8）：扫窗文本（fail 槽先于 ok 槽 = 判定序，槽内按
   * pattern 序）——命中即给结局帧；**声明了分类槽而无一命中 = 断言失败** ⇒
   * 合成 fail 帧（`by:'ga'` 无 outcome——「收窗成功，分支未知」）；未声明
   * 分类槽 ⇒ undefined（关窗即 next）。
   */
  private classifyGa(state: ReadState): ReadHit | undefined {
    for (const slot of state.derived.slots) {
      for (let i = 0; i < slot.res.length; i++) {
        const re = slot.res[i]!
        re.lastIndex = 0
        const m = re.exec(state.accText)
        if (m !== null) {
          return { by: 'ga', index: i, groups: m.slice(1), outcome: slot.name, kind: slot.kind }
        }
      }
    }
    if (state.derived.slots.length > 0) {
      return { by: 'ga', index: -1, groups: [], kind: 'fail' }
    }
    return undefined
  }

  /**
   * 同步判定：判定序 **fail 槽 > ok 槽（criteria）> GA 计数（ga）> maxLines**
   *（写死）。quiet / 裸读无同步收窗者（quiet 的窗由 timeoutTimer 关；裸读的
   * quietMs 见 armQuiet）。
   */
  private evaluate(state: ReadState): CriterionHit | null {
    const { opts, derived, acc, accText } = state
    if (opts.closeOn === 'criteria') {
      const failHit = this.matchFirst(derived.failRes, derived.failMeta, accText)
      if (failHit !== null) return { reason: 'done', source: 'criteria', hit: failHit }
      const okHit = this.matchFirst(derived.okRes, derived.okMeta, accText)
      if (okHit !== null) return { reason: 'done', source: 'criteria', hit: okHit }
    }
    if (opts.closeOn === 'ga' && state.gaSeen >= (opts.gaCount ?? 1)) {
      return { reason: 'done', source: 'ga', hit: this.classifyGa(state) }
    }
    if (opts.maxLines !== undefined && acc.length >= opts.maxLines) {
      return {
        reason: 'done',
        source: 'maxLines',
        hit: opts.closeOn === 'ga' ? this.classifyGa(state) : undefined,
      }
    }
    return null
  }

  /** 行间静默计时器（**仅裸读**：closeOn 缺省且 quietMs 声明才武装；每行重置）。 */
  private armQuiet(state: ReadState): void {
    if (state.opts.closeOn !== undefined) return // 命令判据面无静默计时（race/quietMs 退役）
    if (state.opts.quietMs === undefined) return
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    state.quietTimer = setTimeout(() => { this.onQuiet() }, state.opts.quietMs)
  }

  /** 静默到点（裸读收束；无命中帧）。 */
  private onQuiet(): void {
    this.finish('quiet')
  }

  /** 收束：清计时器/信号监听 → quiet 合成帧 / criteria 失配记错 → resolve。 */
  private finish(reason: ReadReason, source?: CriterionHit['source'], hit?: ReadHit): void {
    const state = this.state
    if (state === null) return
    this.state = null
    clearTimeout(state.timeoutTimer)
    if (state.quietTimer !== null) clearTimeout(state.quietTimer)
    if (state.opts.signal !== undefined && state.onAbort !== null) {
      state.opts.signal.removeEventListener('abort', state.onAbort)
    }
    // quiet 形态合成帧（§3.2，DEC-3 终态）：采样窗到点/剪断时按**行数**定 kind
    //——reason 不参与路由（消费侧只看 kind）：有行 ⇒ ok（reason:'quiet'）、
    // 零行 ⇒ fail（reason:'timeout'，等同 timeout）。异常收束（signal/
    // disconnected/danger）不合成（等待未达成）。
    if (state.opts.closeOn === 'quiet' && (reason === 'timeout' || source === 'maxLines')) {
      const kind = state.acc.length > 0 ? ('ok' as const) : ('fail' as const)
      const synth: ReadHit = {
        by: source === 'maxLines' ? 'maxLines' : 'quiet',
        index: -1,
        groups: [],
        kind,
      }
      state.resolve({
        lines: state.acc,
        reason: source === 'maxLines' ? 'done' : (state.acc.length > 0 ? 'quiet' : 'timeout'),
        hit: synth,
      })
      return
    }
    // criteria 失配记错（承 core2 纪律，T26.6 收窄至 criteria）：判据声明了却
    // 没有命中，收场者是 timeout / maxLines 剪断 —— 记 error（判据失配要吵，
    // 语料可见）；GA 关窗（ga 形态）不算失配；fail 槽命中是命中不是失配。
    if (state.opts.closeOn === 'criteria'
      && (state.derived.failRes.length > 0 || state.derived.okRes.length > 0)
      && (reason === 'timeout' || source === 'maxLines')) {
      this.onLog?.('error', `read 判据失配：criteria 槽未命中即收束（reason=${reason}）`)
    }
    state.resolve({ lines: state.acc, reason, hit })
  }
}
