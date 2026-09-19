/**
 * dsh-mud-core — 在途窗口表 (InflightWindowTable), host half. 会话层。
 *
 * 命令-应答桥 (CommandResponseController) 的 W7.2 后继 (§17 W7.2 "桥 → 在途窗口";
 * 设计见 §8.3): 把 "发命令工具调用 → 应答" 建模为一次 **在途窗口** ——
 *
 * ```
 *   tool.execute(cmd)
 *     → register(spec) 注册窗口 { criteria?, gaCount, timeoutMs }
 *     → await 结算 (裁决器在行流中匹配/计数; signal 取消则立即返回 abort)
 *     → 返回 WindowResult (窗口行 / 判据结算 / 放弃原因)
 * ```
 *
 * 结算优先级 (§2.3): **判据命中 > 窗口关闭 (N-GA) > 超时 > 断线**; 每个窗口必有
 * 结局 (I4 无静默)。两种形态:
 *   - **窗口型** (无判据; look/hp 等查询): GA 关窗 = 成功, 窗口内行 = 工具结果;
 *   - **判据型** (ok/fail 行判据 + gaCount 兜底关窗): 判据命中 = 成功/失败 (hitText
 *     = 命中行原文, 供流程 `{lastFail}` 等槽插值); 关窗未命中 = 失败 ("判据未等到")。
 *
 * N-GA 边界 (§2.2): 第 N 个 GA/EOR 后关窗; `gaCount` 缺省 = 命令条数 (每命令至少
 * 1 个 GA); `gaOutcome` 显式覆盖关窗结局 (step.ok/fail 含 ga 判据时由 flow 声明)。
 *
 * 直发延后 (§2.8): 在途窗口开启 ⇒ 直发命令队列延后 (queue gate, `onGate(true)`);
 * 窗口自身命令 `noGate:true` 豁免, halt 优先级豁免 —— GA 计数从此不被直发应答污染。
 *
 * 判据武装 (win- 标记): confirmSent 武装后, 对 criteria.ok / criteria.fail 各注册
 * `win-<n>:ok` / `win-<n>:fail` 一次性武装标记 (once:true, 经裁决器注册进行流缓冲);
 * 命中帧由裁决器站③路由回 `settleCriteria`。任何结算都注销两标记 (不留脏标记)。
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

/** 结算方式: 边界 (ga/eor) / 判据命中 (until) / 超时放弃 (timeout) /
 *  中止 (abort, signal) / 流程打断 (interrupted) / 连接错误 (error, 断线)。 */
export type ReplySettle = BoundaryKind | 'until' | 'timeout' | 'abort' | 'interrupted' | 'error'

/** 窗口判据 (ok/fail 行判据; 命中经武装标记结算)。 */
export interface WindowCriteria {
  /** 命中 ⇒ 窗口成功结算 (outcome 'ok')。 */
  ok?: RegExp
  /** 命中 ⇒ 窗口失败结算 (outcome 'fail'; hitText = 命中行原文)。 */
  fail?: RegExp
}

/** 工具侧窗口声明 (buildMudTools registerWindow 的入参)。 */
export interface WindowRequest {
  /** 命令或命令序列 (序列 = 同一窗口, 每命令至少 1 个 GA; 空串是合法命令)。 */
  cmd: string | readonly string[]
  /** 行判据 (有 = 判据型; 无 = 窗口型)。 */
  criteria?: WindowCriteria
  /** N-GA 边界 (缺省 = 命令条数; 须为 >=1 整数)。 */
  gaCount?: number
  /** 放弃计时 (缺省链: 此值 > 有判据 120s / 无判据 10s)。 */
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
  /** 行判据 (flow.windowSpecFor 的判据优先于工具自带)。 */
  criteria?: WindowCriteria
  /** N-GA 边界 (step.boundary 覆盖工具声明; 缺省 = cmds.length)。 */
  gaCount?: number
  /** 关窗结局覆盖 (step.ok/fail 含 ga 判据时由 flow 声明; 缺省: 有判据 = fail, 无 = ok)。 */
  gaOutcome?: 'ok' | 'fail'
  /** 放弃计时 (step.timeoutMs 覆盖工具内置; 缺省链见 WindowRequest)。 */
  timeoutMs?: number
  /** 诊断标签。 */
  label?: string
  /** 中止信号。 */
  signal?: AbortSignal
}

/** 一次在途窗口的结算结果 (工具 execute 的返回值形状; 规则续步判定入参)。 */
export interface WindowResult {
  /** 是否成功结算 (ga 关窗窗口型 / until ok 为 true; 其余 false)。 */
  ok: boolean
  /** 实际发出的命令展示形 (序列 = '命令序列')。 */
  cmd: string
  /** 窗口内累积文本 (超时/放弃为留痕文案)。 */
  text: string
  /** 纯应答行 (MudLine[], 行号/style 保真 — T1 规则续步判定的唯一来源)。 */
  lines: MudLine[]
  /** 结算方式。 */
  settled: ReplySettle
  /** 结算结局 (工具结果判据用): ok / fail / error。 */
  outcome?: 'ok' | 'fail' | 'error'
  /** 判据命中行原文 (until 结算; 流程 `{lastFail}` 槽源)。 */
  hitText?: string
}

/** 在途窗口表诊断 (§2.9; 替换旧桥活动表, 进 /mud/diag)。 */
export interface WindowDiag {
  /** 当前在途窗口 (无 = null)。 */
  open: {
    /** 诊断标签 (工具名)。 */
    tool: string
    /** 等待的判据 ('ok'/'fail'/'ok+fail'; 窗口型 = null)。 */
    criteria: string | null
    /** N-GA 边界与已见 GA 数。 */
    gaCount: number
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
}

/** v0.6.0 §8.4: timeout 放弃语义文本 (放弃 = 未等到权威边界)。 */
export const ABANDON_TEXT = '[应答超时，边界未命中，请决策]'
/** 中止文本。 */
export const ABORT_TEXT = '（已中止）'
/** 流程打断的缺省原因 (工具结果文本; `interrupt` 用)。 */
export const INTERRUPT_TEXT = '（流程被打断：本步已作废，请按新情况决策）'

/** win- 武装标记 id 解析: `win-<n>:(ok|fail)` → [n, 后缀] (非 win 标记 = null)。 */
export function parseWindowMarkerId(markerId: string): { n: number; suffix: 'ok' | 'fail' } | null {
  const m = /^win-(\d+):(ok|fail)$/.exec(markerId)
  if (m === null) return null
  return { n: Number(m[1]), suffix: m[2] as 'ok' | 'fail' }
}

/** 单个窗口的运行时状态。 */
interface WindowEntry {
  id: string
  /** 诊断标签 (工具名)。 */
  label: string
  /** 展示用命令 (单体 = 命令; 序列 = '命令序列')。 */
  cmd: string
  /** 实际命令列表 (序列逐条同 replyId 穿透到队列)。 */
  cmds: string[]
  criteria?: WindowCriteria
  gaCount: number
  gaOutcome?: 'ok' | 'fail'
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
  /** win-<n>:ok / win-<n>:fail 武装标记 id (criteria 存在时才有)。 */
  okMarkerId?: string
  failMarkerId?: string
  /** 注册时刻 (diag elapsedMs)。 */
  startedAt: number
}

/**
 * 在途窗口表。非网络协程: 一张表服务**一条游戏连接** (重连后须调用 `reset()` —
 * 旧连接的行对象已随 parser 实例作废)。pending/live pump 结构防御性保留 (官方工具
 * 顺序执行下同时至多一个窗口在途, §2.6), 窗口重叠时后到者排队。
 */
export class InflightWindowTable {
  private readonly opts: { send: InflightWindowDeps['send']; onArm: InflightWindowDeps['onArm']; onDisarm: InflightWindowDeps['onDisarm']; onGate: InflightWindowDeps['onGate']; onDropQueued?: InflightWindowDeps['onDropQueued']; onLog?: (text: string) => void; defaultTimeoutMs: number; declaredTimeoutMs: number; consecutiveTimeoutLimit: number }

  /** 已注册但未发送的窗口 (FIFO)。 */
  private pending: WindowEntry[] = []
  /** 当前在途窗口 (pump 发送后唯一)。 */
  private live: WindowEntry | null = null
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
    // 注册期校验 (§2.8): gaCount 须为 >=1 整数。
    const gaCount = spec.gaCount ?? cmds.length
    if (!Number.isInteger(gaCount) || gaCount < 1) {
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
      ...(spec.criteria !== undefined ? { criteria: spec.criteria } : {}),
      gaCount,
      ...(spec.gaOutcome !== undefined ? { gaOutcome: spec.gaOutcome } : {}),
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
      ...(spec.criteria?.ok !== undefined ? { okMarkerId: `win-${n}:ok` } : {}),
      ...(spec.criteria?.fail !== undefined ? { failMarkerId: `win-${n}:fail` } : {}),
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
    return promise
  }

  /**
   * 事实武装: 宿主在**真实写 socket 后**调用 (队列 onSend 里)。
   * @param windowId register 穿透的 meta.replyId (幂等: 序列多命令同 id, 首次武装生效)。
   */
  confirmSent(windowId: string | undefined): void {
    const w = this.live
    if (!w || w.state !== 'sending' || w.id !== windowId) return
    w.state = 'armed'
    this.armTimers(w)
    // 判据型窗口: ok/fail 各注册一次性武装标记 (win-<n>:ok/:fail), 命中帧由裁决器
    // 站③路由回 settleCriteria。分帧器 arm 的"arming 即测"覆盖判据行先到的情况。
    if (w.okMarkerId !== undefined && w.criteria?.ok !== undefined) this.opts.onArm(w.okMarkerId, w.criteria.ok)
    if (w.failMarkerId !== undefined && w.criteria?.fail !== undefined) this.opts.onArm(w.failMarkerId, w.criteria.fail)
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
   * 喂入一帧的行 (响应 = 窗口开启期间提交帧的并集): 宿主把**裁决器提交的帧**原样
   * 喂入, 在途窗口 (sending/armed) 就地累积 —— 表不自造边界、不持有标记。
   * 无主帧 (无在途窗口) 不在此登记 —— 投递由裁决器消费链负责 (站⑤)。
   */
  feedLines(lines: readonly MudLine[]): void {
    if (lines.length === 0 || this.disposed) return
    const w = this.live
    if (!w || (w.state !== 'armed' && w.state !== 'sending')) return
    // `sending` = 已注册但还没真实写出 (队列节流窗口): 窗口期间提交的帧同属本窗口。
    w.lines = [...w.lines, ...lines]
    w.text = textOfLines(w.lines)
    // 判据命中归武装标记 (win-*, 裁决器站③路由) — 表只累积行, 不判边界。
  }

  /**
   * GA/EOR 边界 (§2.2 N-GA 关窗信号): 仅 **armed** 窗口计数 —— gaSeen 达 gaCount
   * 即关窗结算 (结局: gaOutcome 覆盖 > 有判据 = fail ("判据未等到") > 无判据 = ok)。
   * sending 期与无主边界不计数 (无主帧走裁决器消费链的投递结算)。
   */
  boundary(kind: BoundaryKind): void {
    void kind
    const w = this.live
    if (!w || w.state !== 'armed') return
    w.gaSeen += 1
    if (w.gaSeen < w.gaCount) return
    const hasCriteria = w.criteria?.ok !== undefined || w.criteria?.fail !== undefined
    const outcome = w.gaOutcome ?? (hasCriteria ? 'fail' : 'ok')
    this.settle(w, 'ga', undefined, undefined, outcome)
  }

  /**
   * win- 武装标记命中 (裁决器站③路由): 按标记后缀结算判据 (ok = 成功 / fail = 失败),
   * `hitText` = 命中行原文 (流程 `{lastFail}` 槽源)。仅 live armed 且 id 匹配时生效。
   */
  settleCriteria(markerId: string, hitText?: string): void {
    const parsed = parseWindowMarkerId(markerId)
    if (parsed === null) return
    const w = this.live
    if (!w || w.state !== 'armed' || w.id !== `w${parsed.n}`) return
    this.settle(w, 'until', undefined, hitText, parsed.suffix)
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
          criteria: live.criteria === undefined
            ? null
            : ([live.criteria.ok !== undefined ? 'ok' : null, live.criteria.fail !== undefined ? 'fail' : null].filter(x => x !== null).join('+') || null),
          gaCount: live.gaCount,
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
   *  @param errorMessage 覆盖缺省文案 (error: 发送失败等; interrupted: 打断原因)。
   *  @param hitText 判据命中行原文 (until)。
   *  @param untilOutcome 判据结局 (until: 标记后缀) / ga 关窗结局 (gaOutcome 链已解析)。 */
  private settle(w: WindowEntry, kind: ReplySettle, errorMessage?: string, hitText?: string, untilOutcome?: 'ok' | 'fail'): void {
    if (w.state === 'settled') return
    w.state = 'settled'
    this.clearTimers(w)
    // 任何结算都注销 win- 标记 (timeout/abort/error 后不能留脏标记)。
    if (w.okMarkerId !== undefined) this.opts.onDisarm(w.okMarkerId)
    if (w.failMarkerId !== undefined) this.opts.onDisarm(w.failMarkerId)
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
      // timeout = 放弃 (§8.4): 窗口行不随结果返回 (已在交付水位内), 回放只进诊断日志。
      w.resolve({ ok: false, cmd: w.cmd, text: ABANDON_TEXT, lines: [], settled: 'timeout', outcome: 'fail' })
      return
    }

    this.consecutiveTimeouts = 0
    switch (kind) {
      case 'abort': {
        this.counters.abort += 1
        w.resolve({ ok: false, cmd: w.cmd, text: ABORT_TEXT, lines: w.lines, settled: 'abort', outcome: 'fail' })
        return
      }
      case 'interrupted': {
        this.counters.interrupted += 1
        w.resolve({ ok: false, cmd: w.cmd, text: errorMessage ?? INTERRUPT_TEXT, lines: w.lines, settled: 'interrupted', outcome: 'fail' })
        return
      }
      case 'until': {
        const ok = untilOutcome === 'ok'
        if (ok) this.counters.ok += 1
        else this.counters.fail += 1
        w.resolve({
          ok,
          cmd: w.cmd,
          text: w.text,
          lines: w.lines,
          settled: 'until',
          outcome: ok ? 'ok' : 'fail',
          ...(hitText !== undefined ? { hitText } : {}),
        })
        return
      }
      default: {
        // 'ga' | 'eor': N-GA 关窗 (§2.3)。窗口型 = 成功 (窗口行 = 工具结果);
        // 判据型关窗未命中 = 失败 ("判据未等到")。
        const outcome = untilOutcome ?? (w.gaOutcome ?? 'ok')
        const ok = outcome === 'ok'
        if (ok) this.counters.ok += 1
        else this.counters.fail += 1
        const text = ok || w.text !== '' ? w.text : '判据未等到 (窗口在 GA 边界关闭)'
        w.resolve({ ok, cmd: w.cmd, text, lines: w.lines, settled: 'ga', outcome })
      }
    }
  }

  /** 武装后的计时 (§8.4): 唯一的计时器是放弃 —— 超时即 resolve 放弃。 */
  private armTimers(w: WindowEntry): void {
    // 先清掉 pump 阶段设置的**发送守卫**定时器 (sending 兜底; settle 的 clearTimers
    // 只清最新引用, 不清会泄漏 — 与旧桥 R2-4 同款修正)。
    this.clearTimers(w)
    const hasCriteria = w.criteria?.ok !== undefined || w.criteria?.fail !== undefined
    const timeoutMs = w.timeoutMs ?? (hasCriteria ? this.opts.declaredTimeoutMs : this.opts.defaultTimeoutMs)
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
