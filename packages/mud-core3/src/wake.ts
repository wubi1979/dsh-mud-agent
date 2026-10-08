/**
 * mud-core3 wake — 静默唤醒器（T4a，参照 core2 wake 形态裁剪）。
 *
 * 单 timer、到期驱动：行到达即 re-arm（runtime.onActivity 喂 `arm()`），
 * 静默满 silenceMs 到期时检查守卫。守卫分两层（T5.1 守卫分工）：
 *   - **传输面**（到期即判，任一不满足只 re-arm）：
 *     1. 非回合中（回合中开新回合会打断节奏；turn/end 后的持续静默会再次
 *        到期）；
 *     2. 行流持有者空闲（无在途 read/send；在途 read 有自己的 quiet/timeout
 *        收束，收束后的持续静默会再次到期唤醒；锁定 workflow 执行期间持有者
 *        被流程独占，同被此守卫覆盖）；
 *   - **闸门面**（完成唤醒时复查）：已接入（§6.3 闸门前置：未接入只重置
 *     静默起点，不投任务书）。
 *
 * 探活归属（T12 D5）：本器**回归纯唤醒**——探活已下沉 link 层自驱静默伴随
 * 探测（keepalive.ts），到期点零探测依赖（T5.1 的 probe/isProbing/onProbeAlive
 * 三依赖净删）；探测窗口整体落在静默窗口内、到期点之前收束。
 *
 * 守卫纪律（承 v2 §7.2 V7）：**不做**"无子 agent 在途"守卫——委派结果走
 * subagent 工具返回值（一次性前台，§7.6），插件不查子级；冗余唤醒无害
 * （根的决策输入是唤醒正文，不是唤醒次数）。
 *
 * 纯度：本文件零宿主依赖——守卫与投递经注入窄接口（任务书正文组装归装配层）。
 */

/** 到期守卫（三条件注入；任一 false = 只 re-arm 不唤醒）。 */
export interface WakeGuards {
  /** 已接入（投递闸门开）。 */
  admitted(): boolean
  /** 非回合中（agent 不在 turn）。 */
  notInTurn(): boolean
  /** 行流持有者空闲（无在途 read/send）。 */
  holderIdle(): boolean
}

/** 唤醒器依赖（注入窄接口）。 */
export interface WakeDeps {
  readonly guards: WakeGuards
  /** 守卫全过 → 投递任务书（装配层组装正文并 followup）。 */
  fire(): void
}

/** 唤醒器选项。 */
export interface WakeOptions {
  /** 静默时长毫秒（Config `silenceMs`；缺省 120_000，§7.5）。 */
  silenceMs: number
}

/**
 * 静默唤醒器（每会话一实例；装配层把 runtime.onActivity 接到 `arm()`）。
 * @throws silenceMs 非正整数时抛 TypeError（setTimeout 语义，fail-loud 同 core2）。
 */
export class Wake {
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly deps: WakeDeps,
    private readonly opts: WakeOptions,
  ) {
    if (!Number.isSafeInteger(opts.silenceMs) || opts.silenceMs <= 0) {
      throw new TypeError(`silenceMs 必须为正整数，got ${String(opts.silenceMs)}`)
    }
  }

  /**
   * 行到达重新武装（runtime.onActivity 接线）：单 timer、重算即重置——
   * 行流持续到达时永不到期，静默才倒数。
   */
  arm(): void {
    if (this.disposed) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.onExpiry()
    }, this.opts.silenceMs)
  }

  /** 停表（session/disposed 拆卸时调用；之后 arm 不再复活）。 */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  /**
   * 到期：**传输面守卫**（非回合中 / 持有者空闲；`admitted` 属闸门面下沉到
   * complete）任一不满足只 re-arm；全过则完成唤醒（探活已下沉 link 层自驱，
   * T12 D5——到期点零探测依赖）。
   */
  private onExpiry(): void {
    const { notInTurn, holderIdle } = this.deps.guards
    if (!notInTurn() || !holderIdle()) {
      this.arm()
      return
    }
    this.complete()
  }

  /** 完成唤醒（闸门面复查）：已接入 → fire；未接入 → 只重置静默起点（re-arm）。 */
  private complete(): void {
    if (this.deps.guards.admitted()) {
      this.deps.fire()
    } else {
      this.arm()
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

// ── 任务书面（T4a）─────────────────────────────────────────────
//（实施勘误：模板常量落本纯层文件而非 index.ts——index 挂 typert 装饰器，
// vitest 无法转换其导入；装配层 Config.taskBrief 缺省引用此常量，语义不变。）

/** 任务书填充事实（两轴状态实时读取；不含密码）。 */
export interface TaskBriefFacts {
  /** 服务器显示名。 */
  readonly serverName: string
  /** MUD 地址 host:port。 */
  readonly endpoint: string
  /** MUD 登录名。 */
  readonly account: string
  /** 连接轴实时值（disconnected | connecting | connected）。 */
  readonly conn: string
  /** 登录轴实时值（unknown | in-game）。 */
  readonly loggedIn: string
}

/**
 * 缺省任务书模板（2026-10-01 裁定：bootstrap.ts 退役、模板走 Config `taskBrief`，
 * 缺省内置；2026-10-08 修订：目标行状态驱动——登录完成后不收尾，转按 persona
 * 的游戏目标继续自主游戏）。状态驱动：只给事实与目标，不写指令序列。
 */
export const DEFAULT_TASK_BRIEF = [
  '（MUD 任务书）服务器 {{serverName}}（{{endpoint}}），账号 {{account}}。',
  '当前状态：连接 = {{conn}}，登录 = {{loggedIn}}。',
  '目标：确保本账号已连接并已登录游戏；已登录后，按 persona 中的游戏目标与成长路线继续自主游戏（重新评估当前状态与资源，决定下一步）。已完成的步骤不要重做。',
].join('\n')

/**
 * 以实时状态填充任务书模板占位符（{{name}} 全量替换；未知占位符原样保留，
 * 便于部署侧自查模板拼写）。
 */
export function fillTaskBrief(template: string, facts: TaskBriefFacts): string {
  return template
    .replaceAll('{{serverName}}', facts.serverName)
    .replaceAll('{{endpoint}}', facts.endpoint)
    .replaceAll('{{account}}', facts.account)
    .replaceAll('{{conn}}', facts.conn)
    .replaceAll('{{loggedIn}}', facts.loggedIn)
}
