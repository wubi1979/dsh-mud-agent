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
 * 纯度：本文件零宿主**运行时**依赖——守卫与投递经注入窄接口（任务书正文组装
 * 归装配层）；T24 起引入 dsh-goal 的 type-only 类型面（GoalView/
 * GoalOperation，编译期擦除，运行时零导入）。
 */

import type { GoalOperation, GoalView } from '@deepseek-ai/dsh-goal'

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
  /** T24：goal 节选文本（`goalBriefText` 产出；无/暂停/完成 ⇒ 「无」）。 */
  readonly goal: string
}

/**
 * 缺省任务书模板（2026-10-01 裁定：bootstrap.ts 退役、模板走 Config `taskBrief`，
 * 缺省内置；2026-10-08 修订：目标行状态驱动——登录完成后不收尾，转按 persona
 * 的游戏目标继续自主游戏；2026-10-09 T24：追加优先目标行）。状态驱动：只给
 * 事实与目标，不写指令序列。
 */
export const DEFAULT_TASK_BRIEF = [
  '（MUD 任务书）服务器 {{serverName}}（{{endpoint}}），账号 {{account}}。',
  '当前状态：连接 = {{conn}}，登录 = {{loggedIn}}。',
  '目标：确保本账号已连接并已登录游戏；已登录后，按 persona 中的游戏目标与成长路线继续自主游戏（重新评估当前状态与资源，决定下一步）。已完成的步骤不要重做。',
  '当前优先目标：从扬州城的盛昌总行进入剑心居（enter jianxinju），在剑心居内提升基础内功到78级。因提升非常缓慢，需要研究时间效率最高的学习、内力转精神、打坐、睡觉的循环机制沉淀为专用流程。剑心居里可以补给食水（优先吃身上带的食物）、睡觉、请师傅（不是立即到达），学习次数需按精神值选择合理大小，直接最大值学50次会浪费潜能。查师傅技能cha guxu，参数-learn只支持有限NPC',
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
    .replaceAll('{{goal}}', facts.goal)
}

// ── goal 节选与源分派（T24，纯层；宿主服务读取在 index.ts）────────

/**
 * goal 视图 → 任务书「当前优先目标」节选文本。
 * 无 goal / paused / complete（或已 clear）⇒ '无'——目标生命周期外的任务书
 * 回默认节奏；active ⇒ objective 原文；blocked ⇒ objective + 阻塞说明
 * （agent 需看到卡点才能向玩家如实报告）。
 */
export function goalBriefText(view: GoalView | undefined): string {
  if (view === undefined) return '无'
  if (view.phase === 'active') return view.objective
  if (view.phase === 'blocked') {
    const reason = view.blockedReason
    return reason === undefined ? view.objective : `${view.objective}（被阻塞：${reason.message}）`
  }
  return '无' // paused / complete：生命周期暂停或已收尾，不作为优先目标
}

/**
 * goal 视图 → 任务书署名（T24 D8，2026-10-09 回流改版）。
 *
 * **恒 `mud-wake`**——原 D8 设计（active/blocked ⇒ goal 源，
 * round = `view.roundsStarted`）与上游收严后的严格回放冲突：goal 源的用户
 * 消息必须是**受理轮**（`round = roundsStarted + 1 ≥ 1`，fold.ts 硬校验），
 * kickoff / 静默唤醒不是受理主体，带源必毒（实测 seq 177 round 0 事件炸掉
 * 整个 goal 回放，服务拒一切读写）。round 的受理归 base 全局挂载的
 * goal-round-driver；本插件不再代开轮。完成权限（completionAuthority）在
 * kickoff 回合随之收窄到人类回合 / driver 轮——接受的取舍。
 */
export function goalBriefSource(): { readonly kind: 'mud-wake'; readonly plugin: 'mud-core3' } {
  return { kind: 'mud-wake', plugin: 'mud-core3' } as const
}

/**
 * goal 变更中需要立即投任务书的操作（T24.3 事件分派）：设/改/恢复 = 有新工作
 * 要让 agent 感知；pause/complete/clear/block 无新工作（后续静默唤醒按新
 * 状态走默认节奏，blocked 表示玩家已知卡点）。
 */
export function shouldKickoffOnGoalChange(operation: GoalOperation): boolean {
  return operation === 'create' || operation === 'edit' || operation === 'resume'
}
