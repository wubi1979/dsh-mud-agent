/**
 * dsh-mud-core — 看门狗表 (watchdog table), runtime 平面。
 *
 * **看门狗** = "到点把 agent 唤醒/升级"的计时器。它的布防条件不应该散落在各个事件
 * 处理里（那是"哪里漏了就补一次"，实测连踩两次：登录完成不布防断流、断线后仍空转），
 * 而应当**声明成规则**，由本表统一起停：
 *
 *   - `active()` —— **启动条件**：为真则布防，为假则停表（每次重评估都求值）；
 *   - `timeoutMs()` —— 窗口时长（每次求值 → 部署改配置即生效）；
 *   - `fire()` —— 触发行为；
 *   - `repeat` + `guard` —— 触发后是否续期、以及触发前的最后一道门。
 *
 * 两个入口（都由运行时在固定状态变化点调用，幂等）：
 *   - `reevaluate()` —— **状态变化**（连接/断开、登录态翻转、agent 就绪、世界变化）：
 *     只按 `active()` 布防或停表，**不重置**已布防窗口；
 *   - `touch()` —— **活动事件**（收到游戏输出）：活跃的看门狗**重置窗口**（"N 毫秒无
 *     事件"里的 N 因活动而重新计时），不活跃的停表。
 *
 * **边界**（避免"什么都塞进管理器"）：行流装配阀计时器（`autoFlushMs`，v0.6.0 静默窗
 * 降级为网络装配粒度，v0.9 W7.1 起随分帧器留在 `SessionAdjudicator`）与 holdDelivery 兜底
 * （`hold`）、投递重试（settle）计时**不属于**看门狗 —— 它们属于一次投递/帧事务的生命
 * 周期，同在 `SessionAdjudicator`；传输层的空闲/断线探测属于 telnet 层，同样不在这里。
 * @module @deepseek-ai/dsh-mud-core/session/watchdogs
 */

/** 一条看门狗的运行期句柄 (传给 `fire`，便于它读计数/改写状态)。 */
export interface WatchdogHandle {
  /** 已触发次数 (自上次计数清零起)。 */
  readonly fires: number
  /** 触发次数清零 (连接重建 / 会话复位时用)。 */
  reset(): void
}

/** 一条看门狗声明。 */
export interface WatchdogSpec {
  /** 稳定 id (日志/诊断用)。 */
  id: string
  /**
   * **启动条件**: 为真 = 应当布防 (且当前无表时布防); 为假 = 停表。
   * 必须是纯读 (可被反复调用)。
   */
  active: () => boolean
  /** 窗口时长 (毫秒; 每次布防时求值)。 */
  timeoutMs: () => number
  /** 触发行为 (唤醒 agent / 升级 / 记日志)。 */
  fire: (handle: WatchdogHandle) => void
  /** 触发后是否续期 (false = 一次性, 等下一次状态变化才可能重新布防)。 */
  repeat: boolean
  /**
   * 触发前的最后一道门 (可选): 返回 false 则本次不触发、且不续期。
   * 典型用途: "条件在等待期间已变化" 的复核 (例如已经登录就不该再报登录卡住)。
   */
  guard?: () => boolean
}

/** 表内一条看门狗的计时器与计数。 */
interface Entry {
  spec: WatchdogSpec
  timer: ReturnType<typeof setTimeout> | null
  fires: number
}

/**
 * 看门狗表: 按声明统一起停, 幂等重评估。
 *
 * 线程/时钟模型: 单线程, 只用 `setTimeout`; 所有方法同步返回, `fire` 在计时器回调里
 * 同步执行 (调用方自行保证不抛出 —— 抛出会终止该计时器回调)。
 */
export class WatchdogTable {
  private readonly entries: Entry[]
  private disposed = false

  /**
   * @param specs 看门狗声明 (顺序即日志/诊断顺序)。
   * @param onLog 可选的留痕回调 (布防/停表/触发)。
   */
  constructor(specs: readonly WatchdogSpec[], private readonly onLog?: (text: string) => void) {
    this.entries = specs.map(spec => ({ spec, timer: null, fires: 0 }))
  }

  /**
   * 状态变化后重评估: 只布防/停表, **不重置**已布防窗口。
   *
   * 幂等: 条件未变时反复调用无副作用 (这是"忘记布防"这类 bug 的结构性对策 ——
   * 调用点多一点也不会破坏窗口语义)。
   */
  reevaluate(): void {
    if (this.disposed) return
    for (const entry of this.entries) {
      let active = false
      try {
        active = entry.spec.active()
      } catch { /* 条件求值失败按"不活跃"处理: 宁可不停表也不误唤醒 */ active = false }
      if (!active) {
        this.clear(entry, '条件不再满足')
        continue
      }
      if (entry.timer === null) this.arm(entry)
    }
  }

  /** 活动事件: 活跃看门狗**重置窗口**; 不活跃的停表。 */
  touch(): void {
    if (this.disposed) return
    for (const entry of this.entries) {
      let active = false
      try {
        active = entry.spec.active()
      } catch { active = false }
      if (!active) {
        this.clear(entry, '条件不再满足')
        continue
      }
      // 重置 = 先清后布 (窗口从本次活动重新计时); **静默** (不改变"已布防"这个事实)。
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.arm(entry, true)
    }
  }

  /** 触发次数清零 (连接重建/会话复位)。 */
  resetCounts(): void {
    for (const entry of this.entries) entry.fires = 0
  }

  /** 当前已布防的看门狗 id (诊断)。 */
  armed(): readonly string[] {
    return this.entries.filter(entry => entry.timer !== null).map(entry => entry.spec.id)
  }

  /** 停表并释放 (会话释放; 之后所有调用变成空操作)。 */
  dispose(): void {
    this.disposed = true
    for (const entry of this.entries) this.clear(entry)
  }

  /**
   * 布防一条 (假定条件已判定为真)。
   * @param entry 目标看门狗。
   * @param quiet 静默布防 (活动重置窗口时用) —— 每次游戏输出都打一条"布防"会把日志刷满
   *   (实测一次登录后 40+ 条)，而窗口重置并不改变"是否已布防"这个事实。
   */
  private arm(entry: Entry, quiet = false): void {
    const ms = entry.spec.timeoutMs()
    const handle: WatchdogHandle = {
      get fires(): number { return entry.fires },
      reset: () => { entry.fires = 0 },
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.disposed) return
      let active = false
      try {
        active = entry.spec.active()
        if (!active) return
        if (entry.spec.guard !== undefined && !entry.spec.guard()) return
      } catch { return }
      entry.fires += 1
      entry.spec.fire(handle)
      if (entry.spec.repeat && !this.disposed) {
        try {
          if (entry.spec.active()) this.arm(entry, quiet)
        } catch { /* 续期条件求值失败: 交给下一次 reevaluate 决定 */ }
      }
    }, ms)
    if (!quiet) this.onLog?.(`[看门狗] ${entry.spec.id} 布防 ${ms}ms`)
  }

  /** 停表一条。 */
  private clear(entry: Entry, reason?: string): void {
    if (entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
    this.onLog?.(`[看门狗] ${entry.spec.id} 停表${reason === undefined ? '' : ` (${reason})`}`)
  }
}
