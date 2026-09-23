/**
 * dsh-mud-core — 在途窗口表 (InflightWindowTable), host half. 会话层。
 *
 * 命令-应答桥 (CommandResponseController) 的 W7.2 后继 (§17 W7.2 "桥 → 在途窗口";
 * 设计见 §8.3): 把 "发命令工具调用 → 应答" 建模为一次 **在途窗口** ——
 *
 * ```
 *   tool.execute(cmd)
 *     → register(spec) 注册窗口 { closeOn?, gaCount?, timeoutMs? }
 *     → await 结算 (裁决器在行流中匹配/计数; signal 取消则立即返回 abort)
 *     → 返回 WindowResult (窗口行 / 关闭方式 / 放弃原因)
 * ```
 *
 * **形态 C（2026-09-21 定案）：本表是纯收口器, 不解释内容**。三触发 —— **关闭触发命中**
 * (`closeOn`, 返回 `settled:'evidence'`)、**N-GA 数到齐**(仅显式声明时, 返回 `'ga'`/`'eor'`)、
 * **`fallback` 到期**(恒在, `'timeout'`) —— 走同一个 `settle()`, 每个窗口必有结局 (I4 无静默)。
 * 三者中前两者**同形不同名**：都只表示"窗口因证据关闭", **都不携带分类**; 窗口带回 `lines`
 * 后由**流程驱动器**在推进点复判（"这行算哪一类"是流程表的事, 不是窗口的事）。
 *
 * N-GA 边界 (§2.2, 2026-09-21 定案): **只有显式声明 `on:{kind:'ga',count:N}` 的窗口**才在
 * 第 N 个 GA/EOR 后关窗 —— **声明才计 GA 数**; 未声明窗口对 GA/EOR 完全不敏感, 只由
 * `closeOn` / `fallback` / 打断 / 断线收口。旧"`gaCount` 缺省 = 命令条数"的隐式早关**已废除**。
 *
 * 直发延后 (§2.8): 在途窗口开启 ⇒ 直发命令队列延后 (queue gate, `onGate(true)`);
 * 窗口自身命令 `noGate:true` 豁免, halt 优先级豁免 —— GA 计数从此不被直发应答污染。
 *
 * 关闭触发武装 (win- 标记): confirmSent 武装后注册**唯一**一个一次性标记 `win-<n>:close`
 * (经裁决器 armWindowMarker 以 immediate:false 武装 —— **无回看** (A2): 开放帧里命令发出前
 * 已缓冲的行不回测, 武装后到达的行才命中)。命中帧由裁决器站③路由回 `settleCriteria`。
 * 任何结算都注销该标记 (不留脏标记)。
 *
 * span (W10.2 A2/A3): confirmSent 时点记录行流水位 (spanStartAbs) —— 结算时 span = 吸收行中
 * abs > spanStartAbs 的部分 (首个/末个行 abs 进 `WindowResult.span`), evidence/GA 结算的
 * text/lines 只取 span 行 (命令发出前的缓冲行不属于本步应答), capture 抽取只扫 span 行。
 *
 * 计时语义 (沿用旧桥 §8.4): 唯一的计时器是**放弃** —— 未声明 10s / 声明 120s
 * (spec.timeoutMs 覆盖); **连续 3 次放弃** → promise reject (工具 throw → DSH 失败
 * 终态), 任意非超时结算即复位。另有发送守卫 (defaultTimeoutMs 内未确认武装 → error,
 * 防 sending 死锁)。
 *
 * 与旧桥的差异 (机制替换, 外壳语义不变):
 *   - 事务帧标记 (tx-*) 消失: 判据归属即 win- 标记, 不再需要帧配对;
 *   - 挂起期请求闸门 (canSend/I12 旧口径) 删除: 单在途保证被官方缺省独占调度取代 (§8.3/I11);
 *   - 队列级直发延后取代帧配对防污染 (§8.3 直发延后 gate / I12);
 *   - 活动表改为 `diag()` (§8.3): 实时可见"哪个窗口在等什么、等了多久" + 结局计数。
 * @module @deepseek-ai/dsh-mud-core/agent/inflight
 */

import type { MudLine } from '../network/ansi.ts'
import { textOfLines } from '../network/ansi.ts'

/** 帧边界种类 (telnet 'boundary' 事件)。 */
export type BoundaryKind = 'ga' | 'eor'

/** 结算方式: 边界 (ga/eor) / **关闭触发命中 (evidence, 形态 C)** / 超时放弃 (timeout) /
 *  中止 (abort, signal) / 流程打断 (interrupted) / 连接错误 (error, 断线)。
 *
 *  `'evidence'` 与 `'ga'`/`'eor'` **同形不同名**（形态 C 定案，2026-09-21）：三者都只表示
 *  "窗口因证据关闭"、都**不携带分类**；名字不同只为诊断与失败可见性（R4）能区分
 *  "触发正则命中"与"N 个 GA 到齐"。 */
export type ReplySettle = BoundaryKind | 'evidence' | 'timeout' | 'abort' | 'interrupted' | 'error'

/** 工具侧窗口声明 (buildMudTools registerWindow 的入参)。**形态 C：只有收口, 没有分类/抽取**。 */
export interface WindowRequest {
  /** 命令或命令序列 (序列 = 同一窗口, 每命令至少 1 个 GA; 空串是合法命令)。 */
  cmd: string | readonly string[]
  /**
   * **关闭触发**（形态 C，2026-09-21）：命中即关窗（`settled:'evidence'`），**不携带分类**。
   *
   * 三触发之一 —— 另两个是 `gaCount`（显式声明时）与 `timeoutMs`（恒在）。流程步的触发由
   * **驱动器从本步判据派生**（`union(classify ∪ 直接后继 driver)`），T2 可自填。
   */
  closeOn?: RegExp
  /** N-GA 边界 (仅显式声明时计 GA；未声明 = GA/EOR 不构成本窗口边界)。 */
  gaCount?: number
  /** 放弃计时 (缺省链: 此值 > defaultTimeoutMs)。 */
  timeoutMs?: number
  /** 诊断标签 (缺省 = 命令展示形; 通常传工具名)。 */
  label?: string
  /** 中止信号: 触发后优雅结算 (settled='abort'), 不留悬挂 promise。 */
  signal?: AbortSignal
}

/** 注册规格 (壳装配后调用 register 的入参): WindowRequest + 流程表覆盖。 */
export interface WindowSpec {
  /** 实际命令列表 (壳已把 WindowRequest.cmd 归一为数组)。 */
  cmds: readonly string[]
  /** 关闭触发 (形态 C; 命中即关窗, 不判类)。 */
  closeOn?: RegExp
  /** N-GA 边界 (仅显式声明时计 GA; 缺省 = 不关窗)。 */
  gaCount?: number
  /** 放弃计时 (缺省链见 WindowRequest)。 */
  timeoutMs?: number
  /** 诊断标签。 */
  label?: string
  /** 中止信号。 */
  signal?: AbortSignal
}

/** 一次在途窗口的结算结果 (工具 execute 的返回值形状)。**形态 C：只带内容, 不携带分类**。 */
export interface WindowResult {
  /** 是否因证据关闭（触发命中 / N-GA 到齐）；到期/中止/打断/断线为 false。 */
  ok: boolean
  /** 实际发出的命令展示形 (序列 = '命令序列')。 */
  cmd: string
  /** 窗口内累积文本（`timeout` 也带回，见 §8.4 定案 A）。 */
  text: string
  /** 纯应答行 (MudLine[], 行号/style 保真 —— **驱动器复判判据的唯一输入**)。 */
  lines: MudLine[]
  /** 结算方式（`evidence`/`ga`/`eor` 三者同形不同名：都只表示"窗口因证据关闭"）。 */
  settled: ReplySettle
  /** 窗口 span (A3): span 内首个/末个吸收行的 abs (无吸收行 = 缺省不带)。 */
  span?: { fromAbs: number; toAbs: number }
}

/** 在途窗口表诊断 (§2.9; 替换旧桥活动表, 进 /mud/diag)。 */
export interface WindowDiag {
  /** 当前在途窗口 (无 = null)。 */
  open: {
    /** 诊断标签 (工具名)。 */
    tool: string
    /** 关闭触发 ("触发" = 有; 未声明 = null)。 */
    trigger: string | null
    /** N-GA 边界与已见 GA 数 (未声明 GA 关窗基数 = null)。 */
    gaCount: number | null
    gaSeen: number
    /** 已等待时长。 */
    elapsedMs: number
    /** 窗口状态 (registered/sending/armed)。 */
    status: 'registered' | 'sending' | 'armed'
  } | null
  /** 排队等待的窗口数 (官方顺序执行下恒 0; 防御性保留)。 */
  pending: number
  /** 人工等待 (ask-human 挂起; 仅诊断, 不参与 gate/hasOpen)。 */
  human: { label: string; elapsedMs: number } | null
  /** 结局计数 (I4: 每个窗口必有结局)。 */
  counters: { ok: number; fail: number; timeout: number; error: number; interrupted: number; abort: number }
}

/** 在途窗口表宿主接线。 */
export interface InflightWindowDeps {
  /** 实际发送: 宿主接 CommandQueue (meta.replyId/noGate 穿透到队列 onSend)。 */
  send: (cmd: string, meta: { replyId?: string; noGate?: boolean; priority?: 'halt' | 'high' | 'normal' | 'low' }) => void
  /** win- 武装标记注册 (confirmSent 武装后; 宿主转裁决器 splitter.arm once:true)。 */
  onArm: (markerId: string, pattern: string | RegExp) => void
  /** win- 标记注销 (任何结算都注销, 不留脏标记)。 */
  onDisarm: (markerId: string) => void
  /** 直发延后 gate (§2.8): true = 窗口开启 (压住非豁免直发), false = 结算放行。 */
  onGate: (active: boolean) => void
  /** 定向丢弃队列残余 (§19.4 打断): 窗口结算为 `interrupted` 时, 按 replyId 移除
   *  宿主命令队列里该窗口尚未发出的序列命令 (打断后剩余命令不得照发)。 */
  onDropQueued?: (replyId: string) => void
  /** 日志。 */
  onLog?: (text: string) => void
  /** 未声明判据的窗口超时 (缺省 10s; 兼发送守卫窗)。 */
  defaultTimeoutMs?: number
  /** 声明判据的窗口超时 (缺省 120s)。 */
  declaredTimeoutMs?: number
  /** 连续超时上限 (缺省 3; 达到即 reject → DSH 失败终态)。 */
  consecutiveTimeoutLimit?: number
  /** 行流水位 (裁决器缓冲半区已见的最新行 abs; confirmSent 记 spanStartAbs 用)。
   *  缺省 () => -1 = 全部行入 span (单测夹具兼容)。 */
  absWatermark?: () => number
}

/**
 * 兜底到期（`settled='timeout'`）的语义（PLAN §D4 定案 A，2026-09-21）：
 * **带回已累积内容**（span 行进结果的 `lines`/`text`）—— 状态仍是 `timeout`（不属于
 * ok/fail），但调用者（尤其 T2 裸调用）能"自读批内容决策"。原先"放弃即不带内容"会让
 * T2 的任意命令拿不到回显，与 §D3 的 T2 口径冲突。
 */
/** 中止文本。 */
export const ABORT_TEXT = '（已中止）'
/** 流程打断的缺省原因 (工具结果文本; `interrupt` 用)。 */
export const INTERRUPT_TEXT = '（流程被打断：本步已作废，请按新情况决策）'

/** win- 武装标记 id 解析: `win-<n>:(ok|fail|branch:<branchId>|close)` → [n, 类, 分支 id]
 *  (非 win 标记 = null)。branch 判据 id 不得含 `:` (工具层编译时校验)。 */
export function parseWindowMarkerId(
  markerId: string,
): { n: number; kind: 'ok' | 'fail' | 'branch' | 'close'; branchId?: string } | null {
  const m = /^win-(\d+):(ok|fail|close|branch:([^:]+))$/.exec(markerId)
  if (m === null) return null
  if (m[2] === 'ok' || m[2] === 'fail' || m[2] === 'close') return { n: Number(m[1]), kind: m[2] }
  if (m[3] === undefined) return null
  return { n: Number(m[1]), kind: 'branch', branchId: m[3] }
}

/**
 * 单个窗口的运行时状态。 */
interface WindowEntry {
  id: string
  /** 诊断标签 (工具名)。 */
  label: string
  /** 展示用命令 (单体 = 命令; 序列 = '命令序列')。 */
  cmd: string
  /** 实际命令列表 (序列逐条同 replyId 穿透到队列)。 */
  cmds: string[]
  /** 关闭触发 (形态 C): 命中即关窗 (settled='evidence'), 不判类。 */
  closeOn?: RegExp
  /** win-<n>:close 武装标记 id (closeOn 存在时才有)。 */
  closeMarkerId?: string
  /** 显式声明的 GA 关窗基数 (未声明 = 不做 GA 关窗; 2026-09-21 定案: 声明才计 GA)。 */
  gaCount?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 已累积的纯行 (MudLine 保真)。 */
  lines: MudLine[]
  /** 已累积的纯文本 (lines 的 textOfLines 缓存)。 */
  text: string
  state: 'registered' | 'sending' | 'armed' | 'settled'
  resolve: (r: WindowResult) => void
  reject: (e: Error) => void
  timeoutTimer: ReturnType<typeof setTimeout> | null
  abortListener: (() => void) | null
  /** 已见的 GA/EOR 数 (仅 armed 后计数; §2.2 N-GA 边界)。 */
  gaSeen: number
  /** span 起点 (confirmSent 时点的行流水位; -1 = 全部行入 span)。 */
  spanStartAbs: number
  /** 注册时刻 (diag elapsedMs)。 */
  startedAt: number
}

/**
 * 在途窗口表。非网络协程: 一张表服务**一条游戏连接** (重连后须调用 `reset()` —
 * 旧连接的行对象已随 parser 实例作废)。pending/live pump 结构防御性保留 (官方工具
 * 顺序执行下同时至多一个窗口在途, §2.6), 窗口重叠时后到者排队。
 */
export class InflightWindowTable {
  private readonly opts: { send: InflightWindowDeps['send']; onArm: InflightWindowDeps['onArm']; onDisarm: InflightWindowDeps['onDisarm']; onGate: InflightWindowDeps['onGate']; onDropQueued?: InflightWindowDeps['onDropQueued']; onLog?: (text: string) => void; defaultTimeoutMs: number; declaredTimeoutMs: number; consecutiveTimeoutLimit: number; absWatermark: () => number }

  /** 已注册但未发送的窗口 (FIFO)。 */
  private pending: WindowEntry[] = []
  /** 当前在途窗口 (pump 发送后唯一)。 */
  private live: WindowEntry | null = null
  /** 最近一次结算窗口带回的 span 行（形态 C 内容通道；工具返回后立即被 `takeSettledLines` 取走）。 */
  private lastSettledLines: readonly MudLine[] | null = null
  /** 直发延后 gate 是否已开启 (§2.8)。 */
  private gateActive = false
  /** 连续超时计数 (非超时结算即复位; 达上限 → reject)。 */
  private consecutiveTimeouts = 0
  /** 人工等待 (ask-human; 仅 diag)。 */
  private human: { label: string; since: number } | null = null
  /** 批量结算中 (interrupt/close/reset): 抑制 settle 内的 pump, 防止打断期把
   *  下一个排队窗口发送出去 (旧桥 interruptInFlight 的泄漏缺陷, 此处修复)。 */
  private batchSettling = false
  private winSeq = 0
  private disposed = false
  private readonly counters: WindowDiag['counters'] = { ok: 0, fail: 0, timeout: 0, error: 0, interrupted: 0, abort: 0 }

  constructor(deps: InflightWindowDeps) {
    this.opts = {
      send: deps.send,
      onArm: deps.onArm,
      onDisarm: deps.onDisarm,
      onGate: deps.onGate,
      ...(deps.onDropQueued !== undefined ? { onDropQueued: deps.onDropQueued } : {}),
      ...(deps.onLog !== undefined ? { onLog: deps.onLog } : {}),
      defaultTimeoutMs: deps.defaultTimeoutMs ?? 10_000,
      declaredTimeoutMs: deps.declaredTimeoutMs ?? 120_000,
      consecutiveTimeoutLimit: deps.consecutiveTimeoutLimit ?? 3,
      absWatermark: deps.absWatermark ?? (() => -1),
    }
  }

  // ── 宿主接口 ───────────────────────────────────────────

  /**
   * 注册在途窗口并挂起等待结算: 注册 → pump 发送 (宿主队列节流) → 真实写 socket 后
   * 宿主调 confirmSent 武装 → 行流中判据命中 / N-GA 关窗 / 超时 → resolve。
   * @param spec 窗口声明 (壳把工具声明与流程表覆盖合并后传入)。
   */
  register(spec: WindowSpec): Promise<WindowResult> {
    const cmds = spec.cmds.map(c => String(c))
    const display = cmds.length === 1 ? cmds[0]! : '命令序列'
    // 空命令是**合法的 MUD 指令** (登录收尾"顶"一下、翻页、退出 MXP 检测都是发空行;
    // 作者 2026-09-13 定案)。**只在"一条命令都没有"时拒绝**。
    if (cmds.length === 0) {
      return Promise.resolve({ ok: false, cmd: '', text: '空命令', lines: [], settled: 'error', outcome: 'error' })
    }
    if (this.disposed) {
      return Promise.reject(new Error('在途窗口表已关闭, 命令未发送'))
    }
    // 信号已预先中止: 不发命令, 优雅结算。
    if (spec.signal?.aborted) {
      return Promise.resolve({ ok: false, cmd: display, text: ABORT_TEXT, lines: [], settled: 'abort', outcome: 'fail' })
    }
    // 注册期校验 (§2.8): gaCount **显式声明时**须为 >=1 整数。
    //
    // **声明才计 GA**（PLAN §D3，2026-09-21 定案；第 1 项落地）：未显式声明
    // `on:{kind:'ga',count:N}` ⇒ `gaCount` 为 undefined ⇒ `boundary()` 直接返回，
    // GA/EOR 到达不构成本窗口的边界。窗口仍恒有界：三触发收敛到同一 `settle()`
    // —— ① 关闭触发命中（`closeOn` → `settleCriteria`）② GA 计数（仅声明时）③ fallback 到期。
    const gaCount = spec.gaCount
    if (gaCount !== undefined && (!Number.isInteger(gaCount) || gaCount < 1)) {
      return Promise.resolve({
        ok: false,
        cmd: display,
        text: `非法窗口声明: gaCount=${String(spec.gaCount)} (须为 >=1 整数)`,
        lines: [],
        settled: 'error',
        outcome: 'error',
      })
    }
    const n = ++this.winSeq
    const w: WindowEntry = {
      id: `w${n}`,
      label: spec.label ?? display,
      cmd: display,
      cmds,
      ...(spec.closeOn !== undefined ? { closeOn: spec.closeOn, closeMarkerId: `win-${n}:close` } : {}),
      ...(gaCount !== undefined ? { gaCount } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      lines: [],
      text: '',
      state: 'registered',
      resolve: () => {},
      reject: () => {},
      timeoutTimer: null,
      abortListener: null,
      gaSeen: 0,
      spanStartAbs: -1,
      startedAt: Date.now(),
    }
    const promise = new Promise<WindowResult>((resolve, reject) => {
      w.resolve = resolve
      w.reject = reject
    })
    this.pending.push(w)
    // 中止随时生效 (注册/发送中/武装后): 优雅结算, 不留悬挂 promise。
    if (spec.signal && !spec.signal.aborted) {
      const listener = () => this.settle(w, 'abort')
      spec.signal.addEventListener('abort', listener, { once: true })
      w.abortListener = listener
    }
    this.pump()
    return promise.then((result) => {
      // **形态 C 内容通道**（2026-09-21）：窗口带回的 span 行留在单槽里，供随本工具返回
      // 立即到达的 `noteToolResult` 交给驱动器复判（`takeSettledLines`）。内容**不进**
      // 模型可见的工具结果（那不是它的家：T2 读的是 note 文本，行号/style 是流程内部坐标）。
      // 串行保证：官方工具管道同 agent 独占执行（I11），且工具返回后紧接着回调。
      this.lastSettledLines = result.lines
      return result
    })
  }

  /**
   * 取走最近一次结算窗口带回的 **span 行**（形态 C：驱动器复判判据的唯一输入）。
   *
   * 取一次即清 —— 只服务"本工具结果 → 本步复判"这一对，不构成任何回看/历史通路。
   * @returns span 行；无（如纯工具结果、未经过窗口）为 undefined。
   */
  takeSettledLines(): readonly MudLine[] | undefined {
    const lines = this.lastSettledLines
    this.lastSettledLines = null
    return lines ?? undefined
  }

  /**
   * 事实武装: 宿主在**真实写 socket 后**调用 (队列 onSend 里)。
   * @param windowId register 穿透的 meta.replyId (幂等: 序列多命令同 id, 首次武装生效)。
   */
  confirmSent(windowId: string | undefined): void {
    const w = this.live
    if (!w || w.state !== 'sending' || w.id !== windowId) return
    w.state = 'armed'
    // span 起点 (A2 无回看): 武装时点的行流水位 —— 此前已在缓冲的行不参与本步结算
    // (结算时 span = 吸收行中 abs > spanStartAbs 的部分)。
    w.spanStartAbs = this.opts.absWatermark()
    this.armTimers(w)
    // **关闭触发**（形态 C）：confirmSent 后注册唯一的一次性武装标记 `win-<n>:close`，
    // 命中帧由裁决器站③路由回 `settleCriteria` → `settle(w,'evidence')`。经
    // `armWindowMarker` 以 `immediate:false` 武装 —— **无回看**：开放帧里命令发出前已
    // 缓冲的行不回测（与 spanStartAbs 同一水位语义）。窗口不判类，故只有一个标记。
    if (w.closeMarkerId !== undefined && w.closeOn !== undefined) this.opts.onArm(w.closeMarkerId, w.closeOn)
  }

  /**
   * 发送失败回执: 宿主在真实写 socket 失败 / 抛异常时调用, 在途 `sending` 窗口
   * settle 成 error → 工具 reject → 回合 error 终态; pump 恢复。
   * 幂等: 仅匹配 live 且 state==='sending' 的同 id 窗口。
   */
  sendFailed(windowId: string | undefined, reason: string): void {
    const w = this.live
    if (!w || w.state !== 'sending' || w.id !== windowId) return
    this.opts.onLog?.(`[在途] ${reason}`)
    this.settle(w, 'error', reason)
  }

  /**
   * 喂入一帧的行 (响应 = **armed 窗口**期间提交帧的并集): 宿主把**裁决器提交的帧**原样
   * 喂入, 在途窗口 (armed) 就地累积 —— 表不自造边界、不持有标记。
   * **无回看 (A2)**: 只吸收 armed 窗口 —— sending 期提交的帧是命令发出前已在缓冲的内容
   * (命令还没写 socket), 不属于本步应答, 由裁决器站⑤按 spanFloor 过滤留给后续消费批。
   * 无主帧 (无在途窗口) 不在此登记 —— 投递由裁决器消费链负责 (站⑤)。
   */
  feedLines(lines: readonly MudLine[]): void {
    if (lines.length === 0 || this.disposed) return
    const w = this.live
    if (!w || w.state !== 'armed') return
    w.lines = [...w.lines, ...lines]
    w.text = textOfLines(w.lines)
    // 判据命中归武装标记 (win-*, 裁决器站③路由) — 表只累积行, 不判边界。
  }

  /**
   * span 过滤水位 (W10.2 站⑤取样面): live armed 窗口的 span 起点 (spanStartAbs);
   * 无 live armed 窗口 = +Infinity (无行被 span 吸收)。裁决器站⑤必须在窗口结算前
   * 取样 (结算会清 live), abs > 水位的行归窗口 (工具应答), ≤ 水位的行是前置噪声
   * (留待决, 走正常投递)。
   */
  spanFloor(): number {
    const w = this.live
    return w !== null && w.state === 'armed' ? w.spanStartAbs : Number.POSITIVE_INFINITY
  }

  /**
   * GA/EOR 边界 (§2.2 N-GA 关窗信号): **只有显式声明了 `on:{kind:'ga',count:N}` 的窗口**
   * 才计数 —— gaSeen 达 gaCount 即关窗结算。未声明 ⇒ GA/EOR 到达不构成本窗口的边界
   * (2026-09-21 定案: 声明才计 GA, 隐式早关废除; 未声明窗口只由 fallback 到期 / 分类命中 /
   * 打断 / 断线结算)。sending 期与无主边界不计数 (无主帧走裁决器消费链的投递结算)。
   */
  boundary(kind: BoundaryKind): void {
    void kind
    const w = this.live
    if (!w || w.state !== 'armed') return
    // 未声明 GA 关窗基数 ⇒ 本窗口对 GA/EOR 不敏感。
    if (w.gaCount === undefined) return
    w.gaSeen += 1
    if (w.gaSeen < w.gaCount) return
    // **证据关闭**（形态 C）：GA 数到齐 = 窗口因证据关闭 —— **不判类**（结局由驱动器复判）。
    this.settle(w, 'ga')
  }

  /**
   * **关闭触发命中**（win- 标记路由，裁决器站③调用）：只关窗 —— `settled:'evidence'`，
   * **不解释内容**（不判类、不带分类）。仅 live armed 且 id 匹配时生效。
   * @param markerId 武装标记 id (`win-<n>:close`)。
   */
  settleCriteria(markerId: string): void {
    const parsed = parseWindowMarkerId(markerId)
    if (parsed === null || parsed.kind !== 'close') return
    const w = this.live
    if (!w || w.state !== 'armed' || w.id !== `w${parsed.n}`) return
    this.settle(w, 'evidence')
  }

  /** 断线: 在途/排队窗口全部 reject (error), 停止接受新注册 (终止语义)。 */
  close(): void {
    this.disposed = true
    this.settleAll('error')
  }

  /** 重连复位: `close()` 为终止语义 (disposed 永真), 宿主每次 connect 事件须调
   *  `reset()` 重开: 清在途/排队/连续超时/gate。断线遗留窗口本已在 close 期 reject。 */
  reset(): void {
    this.settleAll('error')
    this.pending = []
    this.live = null
    this.consecutiveTimeouts = 0
    this.gateActive = false
    this.disposed = false
  }

  /**
   * **流程打断** (§19.4): 在途与排队的窗口当场结算为 `interrupted` —— 挂起的工具
   * 调用拿到 `{ok:false, settled:'interrupted'}` 与可读原因 (不悬挂、不静默, I4)。
   * gate 随结算放行 (§2.8 打断时序: 先结算窗口释放 gate, 再发 halt)。
   *
   * 与 `close()`/`reset()` 的区别: 表**继续可用** (打断后投递的新窗口照常走), 只
   * 作废当前这一批。调用方 (流程运行时) 负责在此之前/之后复位流程。
   * @param reason 可读原因 (进工具结果文本)。
   * @returns 被结算的窗口数。
   */
  interrupt(reason: string = INTERRUPT_TEXT): number {
    let count = 0
    this.batchSettling = true
    try {
      const live = this.live
      if (live !== null && live.state !== 'settled') {
        this.settle(live, 'interrupted', reason)
        count += 1
      }
      for (const next of [...this.pending]) {
        this.settle(next, 'interrupted', reason)
        count += 1
      }
    } finally {
      this.batchSettling = false
      this.releaseGate()
    }
    return count
  }

  /** 是否存在未结算的在途/排队窗口 (诊断 / 帧归属取样 inFrame 判据)。 */
  hasOpen(): boolean {
    return (this.live !== null && this.live.state !== 'settled') || this.pending.length > 0
  }

  /** 人工等待开始 (ask-human 挂起; 仅 diag, 不参与 gate/hasOpen)。 */
  beginHuman(label: string): void {
    this.human = { label, since: Date.now() }
  }

  /** 人工等待结束 (与 beginHuman 配对; 幂等)。 */
  endHuman(): void {
    this.human = null
  }

  /** 诊断 (§2.9): 在途窗口 / 排队 / 人工等待 / 结局计数。 */
  diag(): WindowDiag {
    const live = this.live !== null && this.live.state !== 'settled' ? this.live : null
    return {
      open: live === null
        ? null
        : {
          tool: live.label,
          trigger: live.closeOn === undefined ? null : 'close',
          gaCount: live.gaCount ?? null,
          gaSeen: live.gaSeen,
          elapsedMs: Date.now() - live.startedAt,
          status: live.state === 'settled' ? 'armed' : live.state,
        },
      pending: this.pending.length,
      human: this.human === null ? null : { label: this.human.label, elapsedMs: Date.now() - this.human.since },
      counters: { ...this.counters },
    }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** 批量结算 (close/reset/interrupt): 抑制 settle 内 pump, 统一放 gate。 */
  private settleAll(kind: ReplySettle): void {
    this.batchSettling = true
    try {
      const live = this.live
      if (live !== null && live.state !== 'settled') this.settle(live, kind)
      for (const next of [...this.pending]) this.settle(next, kind)
      this.pending = this.pending.filter(next => next.state !== 'settled')
    } finally {
      this.batchSettling = false
      this.releaseGate()
    }
  }

  /** 一步一窗: 无在途窗口时把队头送出 (宿主队列节流, 写后 confirmSent)。 */
  private pump(): void {
    if (this.disposed) return
    if (this.live !== null && this.live.state !== 'settled') return
    const next = this.pending.shift()
    if (!next) {
      this.live = null
      this.releaseGate()
      return
    }
    this.live = next
    next.state = 'sending'
    // 直发延后 (§2.8): 窗口开启即压住队列里的非豁免直发命令 (窗口自身命令 noGate)。
    this.acquireGate()
    try {
      for (const c of next.cmds) {
        this.opts.send(c, { replyId: next.id, noGate: true })
      }
    } catch (err) {
      this.opts.onLog?.(`[在途] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
      this.settle(next, 'error', `命令发送异常: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // 发送守卫: 宿主 confirmSent 后才武装计时。若真实写 socket 失败/异常而不回执
    // confirmSent/sendFailed, sending 永不结算 → 死锁 (hasOpen 恒 true)。按**缺省
    // 超时窗**兜底 settle error (步预算覆盖值可达 180s, 会把守卫拉爆 — 不用 spec 值)。
    next.timeoutTimer = setTimeout(() => {
      if (next.state === 'sending') {
        this.opts.onLog?.(`[在途] 发送后 ${this.opts.defaultTimeoutMs}ms 未确认武装, 视为发送失败: ${next.cmd}`)
        this.settle(next, 'error', `命令已入队但发送后未确认武装 (${next.cmd})`)
      }
    }, this.opts.defaultTimeoutMs)
  }

  /** 结算 (唯一出口: resolve/reject 恰一次; 之后的 feed/boundary 归无主)。
   *  @param errorMessage 覆盖缺省文案 (error: 发送失败等; interrupted: 打断原因)。 */
  private settle(w: WindowEntry, kind: ReplySettle, errorMessage?: string): void {
    if (w.state === 'settled') return
    w.state = 'settled'
    this.clearTimers(w)
    // 任何结算都注销 win- 标记 (timeout/abort/error 后不能留脏标记)。
    if (w.closeMarkerId !== undefined) this.opts.onDisarm(w.closeMarkerId)
    if (w.abortListener !== null) {
      w.signal?.removeEventListener('abort', w.abortListener)
      w.abortListener = null
    }
    // 已结算项同步退出队列 (中止/断线可能发生在发送前): 防 pump 重发。
    const idx = this.pending.indexOf(w)
    if (idx !== -1) this.pending.splice(idx, 1)
    if (this.live === w) this.live = null
    // §19.4 打断: 序列命令已全部入宿主队列 (pump 一次性入队), 窗口作废后残余
    // 待发命令按 replyId 定向清除 —— 否则 gate 放行后剩余命令照发 (半截序列)。
    if (kind === 'interrupted') this.opts.onDropQueued?.(w.id)
    // gate 释放 (§2.8): 批量结算由调用方 finally 统一放; 单窗口结算走 pump 排空放行。
    if (!this.batchSettling) this.pump()

    // span (A2/A3): span = 吸收行中 abs > spanStartAbs 的部分 —— 命令发出前已在缓冲的行
    // 不属于本步应答。span 行随结果交回（驱动器复判判据的唯一输入）。
    const spanLines = w.lines.filter(l => l.abs > w.spanStartAbs)
    const span = spanLines.length > 0
      ? { fromAbs: spanLines[0]!.abs, toAbs: spanLines[spanLines.length - 1]!.abs }
      : undefined

    if (kind === 'error') {
      this.counters.error += 1
      w.reject(new Error(errorMessage ?? `窗口未结算 (连接已断开): ${w.cmd}`))
      return
    }
    if (kind === 'timeout') {
      this.counters.timeout += 1
      this.consecutiveTimeouts += 1
      const limit = this.opts.consecutiveTimeoutLimit
      if (this.consecutiveTimeouts >= limit) {
        this.consecutiveTimeouts = 0
        w.reject(new Error(`连续 ${limit} 次应答超时 (边界未命中), 回合失败终止`))
        return
      }
      // 兜底到期（三触发之③，PLAN §D4 定案 A 2026-09-21）：**带回已累积内容** ——
      // 状态仍是 `timeout`（不属于 ok/fail），但 span 行随结果返回，使调用者（尤其 T2
      // 裸调用）能"自读批内容决策"，不再拿不到回显。行仍计当前调用者消费（单水位记账，
      // 不会重复随批次投递）。
      w.resolve({
        ok: false,
        cmd: w.cmd,
        text: textOfLines(spanLines),
        lines: spanLines,
        settled: 'timeout',
        ...(span !== undefined ? { span } : {}),
      })
      return
    }

    this.consecutiveTimeouts = 0
    switch (kind) {
      case 'abort': {
        this.counters.abort += 1
        w.resolve({
          ok: false,
          cmd: w.cmd,
          text: ABORT_TEXT,
          lines: w.lines,
          settled: 'abort',
          ...(span !== undefined ? { span } : {}),
        })
        return
      }
      case 'interrupted': {
        this.counters.interrupted += 1
        w.resolve({
          ok: false,
          cmd: w.cmd,
          text: errorMessage ?? INTERRUPT_TEXT,
          lines: w.lines,
          settled: 'interrupted',
          ...(span !== undefined ? { span } : {}),
        })
        return
      }
      case 'evidence': {
        // **关闭触发命中**（形态 C 定案，2026-09-21）：窗口因**证据**关闭 —— **不判类**
        // （无 `hit` / `outcome` / `hitText`），与 GA 关窗**同形不同名**。内容（span 行）
        // 随结果交回；"这行算哪一类"由驱动器在推进点按自己的判据复判（§D3）。
        this.counters.ok += 1
        w.resolve({
          ok: true,
          cmd: w.cmd,
          text: textOfLines(spanLines),
          lines: spanLines,
          settled: 'evidence',
          ...(span !== undefined ? { span } : {}),
        })
        return
      }
      default: {
        // 'ga' | 'eor': **证据关闭**（N-GA 数到齐）。形态 C：同样**不判类** —— 结局由
        // 驱动器复判（`gaCriteriaOf` / 步表判据 / `onSettle`）；这里只把内容交回。
        this.counters.ok += 1
        w.resolve({
          ok: true,
          cmd: w.cmd,
          text: textOfLines(spanLines),
          lines: spanLines,
          settled: kind === 'eor' ? 'eor' : 'ga',
          ...(span !== undefined ? { span } : {}),
        })
      }
    }
  }

  /** 武装后的计时 (§8.4): 唯一的计时器是放弃 —— 超时即 resolve 放弃。 */
  private armTimers(w: WindowEntry): void {
    // 先清掉 pump 阶段设置的**发送守卫**定时器 (sending 兜底; settle 的 clearTimers
    // 只清最新引用, 不清会泄漏 — 与旧桥 R2-4 同款修正)。
    this.clearTimers(w)
    const timeoutMs = w.timeoutMs ?? this.opts.defaultTimeoutMs
    w.timeoutTimer = setTimeout(() => {
      if (w.state === 'armed') this.settle(w, 'timeout')
    }, timeoutMs)
  }

  private clearTimers(w: WindowEntry): void {
    if (w.timeoutTimer !== null) {
      clearTimeout(w.timeoutTimer)
      w.timeoutTimer = null
    }
  }

  private acquireGate(): void {
    if (this.gateActive) return
    this.gateActive = true
    this.opts.onGate(true)
  }

  private releaseGate(): void {
    if (!this.gateActive) return
    this.gateActive = false
    this.opts.onGate(false)
  }
}
