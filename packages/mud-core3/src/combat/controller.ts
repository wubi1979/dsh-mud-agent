/**
 * mud-core3 combat/controller — 交战接管状态机（T21.4）：遭遇开始接管行流，整场持有。
 *
 * 状态机（PLAN T21 3.4，D4/D6/D12）：
 *
 *   idle ── 遭遇开始（combat.战斗中 0→1 或 目标/敌人数写入）──► acquireSend('combat')
 *     ├─ 成功 ─► held：一个覆盖整场的长读窗（until=结局行，quiet/timeout/maxLines 兜底）
 *     │          行路径照常（classify→tracker→World），控制器在状态事件里求值规则；
 *     │          读掉的行推进 readAbs ⇒ 投递越过（不回放），投递由 suppress 钩子压制；
 *     │          读窗收束 = 重估：结局/脱战 ⇒ 释放；否则重开窗。
 *     └─ 失败 ─► pending：保命动作直发（危险规则集，不等锁）；重试定时器 + 状态事件
 *                双路重试，在途收束后立刻接管转 held。
 *   释放：结局行 / combat.战斗中→false（脱战）/ 断线（interrupted 记账）/ 静默兜底
 *   （连续零行收束达上限）⇒ idle（releaseSend + 引擎/边沿复位 + 清遭遇键）。
 *
 * 优先级（D6）：人打断（T21.6 总开关）> 危险抢占（T21.5 danger.ts）> 本接管 >
 * 默认自动攻击；普通外部动作不打断（D7）。未接入也运转（D9：不看 admit 闸门）。
 *
 * 依赖注入为窄接口（CombatIO/CombatWorld）：纯层可测，service 装配真实 runtime。
 *
 * @module mud-core3/combat/controller
 */

import { computeTiers, type CombatEdge, CombatEdgeDetector, type CombatTiers, type CombatVitals } from './state.ts'
import { CombatRuleEngine, type CombatDispatch } from './rules.ts'
import { dangerCondition, isThreatLine, liftsOutOfDanger } from './danger.ts'
import type { CombatReporter } from './report.ts'
import type { MudLine } from '../link/line.ts'
import type { ReadOpts, ReadResult } from '../read.ts'
import type { WorldEntry } from '../world.ts'

/** 控制器持有的发送权标识（会话级持有者名；工具/流程拒绝文案据此区分）。 */
export const COMBAT_HOLDER = 'combat'

/** 接管阶段。 */
export type CombatPhase = 'idle' | 'held' | 'pending'

/** 发送权 + 读窗窄接口（SessionRuntime 结构满足）。 */
export interface CombatIO {
  readonly connected: boolean
  send(cmd: string): boolean
  acquireSend(holder: string): boolean
  releaseSend(holder: string): void
  /** 抢占发送权（危险接管不等锁，D5/PLAN 3.4；同 SessionRuntime.stealSend）。 */
  stealSend(holder: string): void
  /** 打断在途 read（同 SessionRuntime.abortWait；reason='danger' 收束，触发行在结果尾）。 */
  abortWait(line?: MudLine): void
  read(opts: ReadOpts): Promise<ReadResult>
}

/** 世界状态窄接口（读判据键 + 释放时清遭遇键）。 */
export interface CombatWorld {
  get(zone: string, key: string): WorldEntry | undefined
  delete(zone: string, key: string): void
}

/** 结局行判据（until；A.8.3 实录死亡行 + A.8.5〔推断〕待实录校准，替换只动这里）。 */
export const COMBAT_ENDING_RES: readonly RegExp[] = [
  /你的眼前一黑/,   // 死亡（A.8.3 实录）
  /你战胜了/,       // 胜利〔推断，A.8.5〕
  /晕了过去/,       // 晕死（我方/敌方）〔推断〕
  /你停止了攻击/,   // 脱战行文〔推断〕
  /死了。/,         // 敌方死亡〔推断〕
]

/** 长读窗与重试参数（缺省见各字段；全部可注入覆盖）。 */
export interface CombatWindowOptions {
  /** 结局判据（缺省 COMBAT_ENDING_RES）。 */
  readonly endingRes?: readonly RegExp[]
  /** 行间静默毫秒（缺省 3000；战斗输出密集，静默即段间歇）。 */
  readonly quietMs?: number
  /** 总超时毫秒（缺省 30000）。 */
  readonly timeoutMs?: number
  /** 行数兜底（缺省 500）。 */
  readonly maxLines?: number
  /** 静默兜底上限：连续「零行收束」次数（缺省 2；防持有者悬挂，D12）。 */
  readonly silentMax?: number
  /** pending 重试接管间隔毫秒（缺省 200）。 */
  readonly pendingRetryMs?: number
}

/** 控制器依赖。 */
export interface CombatControllerDeps {
  readonly io: CombatIO
  readonly world: CombatWorld
  readonly engine: CombatRuleEngine
  readonly detector: CombatEdgeDetector
  readonly reporter: CombatReporter
  readonly window?: CombatWindowOptions | undefined
}

/** 缺省窗刻度。 */
const DEFAULT_WINDOW = { quietMs: 3000, timeoutMs: 30_000, maxLines: 500, silentMax: 2, pendingRetryMs: 200 }

/**
 * 交战接管控制器：每会话一个实例（service.register 创建并接线 onWorldChange/
 * onStateChange）。全部公共入口同步；长读窗循环为内部异步（token 守卫防悬挂）。
 */
export class CombatController {
  private readonly io: CombatIO
  private readonly world: CombatWorld
  private readonly engine: CombatRuleEngine
  private readonly detector: CombatEdgeDetector
  private readonly reporter: CombatReporter
  private readonly win: Required<Omit<CombatWindowOptions, 'endingRes'>> & {
    readonly endingRes: readonly RegExp[]
  }
  private phase: CombatPhase = 'idle'
  /** 长读窗循环令牌：释放/重开时递增使旧循环退出。 */
  private token = 0
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDangerSent = false
  private silentStreak = 0
  private retreatWarned = false
  /** 危险态（T21.5）：文本判定点①或危险档跨变②进入；结局/回升/脱战/断线退出。 */
  private dangerActive = false
  /** 人打断挂起态（T21.6）：combatAuto=false ⇒ 不接管不开窗、危险通道也不动作。 */
  private suspended = false
  /** 恢复不追补闩（T21.6）：恢复时本场仍在进行 ⇒ 跳过，直到本场消解（战斗中→false/键消失）。 */
  private skipCurrent = false
  /**
   * 重入合并闸（T21.7 回放揭示）：生产接线里本控制器自己引发的 World 写回
   * （reporter 计数经 writeCombatWorld、释放清键经 deleteWorld）都会再触发
   * onWorldChange——同步处理期间（求值/接管/释放）再入的事件一律吞掉，
   * 否则 beginEncounter/危险直发沿写回自激递归。下一真实事件照常求值。
   */
  private depth = 0

  /** 重入保护执行：只加深计数，不跳过（跳过语义只放在公共入口）。 */
  private exclusive(fn: () => void): void {
    this.depth += 1
    try { fn() } finally { this.depth -= 1 }
  }

  constructor(deps: CombatControllerDeps) {
    this.io = deps.io
    this.world = deps.world
    this.engine = deps.engine
    this.detector = deps.detector
    this.reporter = deps.reporter
    const w = deps.window ?? {}
    this.win = {
      endingRes: w.endingRes ?? COMBAT_ENDING_RES,
      quietMs: w.quietMs ?? DEFAULT_WINDOW.quietMs,
      timeoutMs: w.timeoutMs ?? DEFAULT_WINDOW.timeoutMs,
      maxLines: w.maxLines ?? DEFAULT_WINDOW.maxLines,
      silentMax: w.silentMax ?? DEFAULT_WINDOW.silentMax,
      pendingRetryMs: w.pendingRetryMs ?? DEFAULT_WINDOW.pendingRetryMs,
    }
  }

  /** 当前阶段（观测/投递 suppress/画面呈现用）。 */
  get currentPhase(): CombatPhase {
    return this.phase
  }

  /** 长读窗 suppress 谓词（Deliverer 注入）：held 期零投递（战斗原文不进 agent，D4）。 */
  get suppressDelivery(): boolean {
    return this.phase === 'held'
  }

  /** 危险态观测面（画面呈现/测试用）。 */
  get inDanger(): boolean {
    return this.dangerActive
  }

  /** 自主战斗总开关观测面（T21.6；StatusRow 呈现/测试用）。 */
  get combatAuto(): boolean {
    return !this.suspended
  }

  /**
   * 人打断总开关（T21.6，最高优先级，PLAN 3.6）：
   * 关闭 ⇒ 挂起 + 当前遭遇立即 release('interrupted')（不接管、不开窗、危险通道也不动作）；
   * 恢复 ⇒ 之后的新遭遇照常接管，**不追补**当前场（本场仍进行则闩上跳过）。
   * 不用"暂停 N 秒"形态——人想自己来，就该一直自己来直到再打开。
   */
  setCombatAuto(on: boolean): void {
    if (on) {
      if (!this.suspended) return
      this.suspended = false
      if (this.world.get('combat', '战斗中')?.value === true) {
        this.skipCurrent = true
        this.reporter.note('战斗刹车解除：本场不追补，下一场照常接管')
      } else {
        this.reporter.note('战斗刹车解除：遭遇照常接管')
      }
      return
    }
    if (this.suspended) return
    this.suspended = true
    this.skipCurrent = false
    this.reporter.note('战斗刹车：人打断自主战斗')
    if (this.phase !== 'idle') this.release('interrupted')
  }

  // ── 事件入口（service 接线）────────────────────────────────────────

  /**
   * 世界状态变化（每次 World 写入触发）：遭遇开闭判定 + 规则求值。
   * 状态驱动（D1）：没跨变引擎内部节流为无动作，本方法幂等廉价。
   */
  onWorldChange(): void {
    if (this.depth > 0) return // 重入合并：自身写回引发的广播不再求值
    this.exclusive(() => {
      if (this.suspended) return // 人打断挂起：一切事件入口不动作（T21.6）
      const started = this.encounterStarted()
      switch (this.phase) {
        case 'idle':
          if (this.skipCurrent) {
            // 恢复不追补闩：等本场消解（战斗中→false 或键消失）后自动解除。
            const v = this.world.get('combat', '战斗中')
            if (v === undefined || v.value === false) this.skipCurrent = false
            return
          }
          if (started) this.beginEncounter()
          return
        case 'pending': {
          if (this.combatEnded()) { this.release('脱战'); return }
          if (this.io.acquireSend(COMBAT_HOLDER)) {
            this.enterHeld('在途收束，pending 转正式接管')
            this.evaluate()
            return
          }
          const { tiers, edges } = this.detect()
          if (!this.dangerActive && dangerCondition(tiers)) this.enterDanger()
          // 保命直发节流：状态跨变（或进入 pending 后首次）重发危险规则集。
          if (edges.length > 0 || !this.pendingDangerSent) {
            this.pendingDangerSent = true
            this.sendDanger()
          }
          this.schedulePendingRetry()
          return
        }
        case 'held':
          if (this.combatEnded()) { this.release('脱战'); return }
          this.evaluate()
          return
      }
    })
  }

  /** 断线（W10）：释放 + 复位 + interrupted 记账；idle 时空操作。 */
  onDisconnected(): void {
    if (this.depth > 0) return // 重入合并（release 清键的写回广播不得再入）
    this.exclusive(() => {
      if (this.phase === 'idle') return
      this.release('interrupted')
    })
  }

  // ── 危险抢占通道（T21.5，D5/PLAN 3.5）────────────────────────────

  /**
   * 判定点①（文本类）：行路径最前（先于分类/追踪/读窗消费）调用。
   * 命中即进入危险态并接管（2026-10-07 裁定）——abortWait(触发行) 打断在途
   * 读窗与流程，直发保命，steal 接管不等锁。危险态中不重复抢占。
   */
  onThreatLine(line: MudLine): void {
    if (this.depth > 0) return // 重入合并（接管引发的写回广播不得再入）
    this.exclusive(() => {
      if (this.suspended || this.dangerActive || !isThreatLine(line.text)) return
      this.enterDanger(line)
    })
  }

  /** 进入危险态：abort → 直发（由后续求值执行）→ 接管（idle/pending 转 held）。 */
  private enterDanger(line?: MudLine): void {
    this.dangerActive = true
    this.io.abortWait(line)
    this.reporter.note(line !== undefined
      ? `危险抢占（文本判定）：${line.text}`
      : '危险档跨变，进入危险态（危险抢占）')
    if (this.phase === 'idle') {
      this.beginEncounter(true)
    } else if (this.phase === 'pending') {
      this.io.stealSend(COMBAT_HOLDER)
      this.enterHeld('危险抢占转正式接管')
    }
    // held：保持（自身读窗被 abort 后由 holdLoop 以 danger 收束并重开）。
  }

  /** 退出危险态（回升跨变/结局/脱战/断线）：回常态规则集。 */
  private exitDanger(reason: string): void {
    this.dangerActive = false
    this.reporter.note(`危险态解除（${reason}）`)
  }

  // ── 遭遇生命周期 ─────────────────────────────────────────────────

  private beginEncounter(forced = false): void {
    this.reporter.begin()
    this.pendingDangerSent = false
    this.silentStreak = 0
    // D14：缺退路数据 ⇒ 撤离规则不启用并告警一条（每会话一次，其余规则照常）。
    if (!this.engine.fleeEnabled && !this.retreatWarned) {
      this.retreatWarned = true
      this.reporter.note('未配置退路（retreatMove），撤离规则不启用，其余规则照常')
    }
    // forced = 危险抢占接管（D5）：不等锁，steal 归属（被抢者已因 abortWait 收束）。
    const acquired = forced
      ? ((void this.io.stealSend(COMBAT_HOLDER)), true)
      : this.io.acquireSend(COMBAT_HOLDER)
    if (acquired) {
      this.enterHeld(forced ? '遭遇开始，危险抢占接管行流' : '遭遇开始，接管行流')
      this.evaluate()
    } else {
      this.phase = 'pending'
      this.reporter.note('接管获取失败（行流被占），转入 pending：保命动作直发')
      this.sendDanger()
      this.schedulePendingRetry()
    }
  }

  private enterHeld(why: string): void {
    this.phase = 'held'
    this.silentStreak = 0
    this.clearPendingRetry()
    this.reporter.note(why)
    const token = ++this.token
    void this.holdLoop(token)
  }

  /** 长读窗循环（D4）：覆盖整场的读窗，收束即重估，未脱战重开。 */
  private async holdLoop(token: number): Promise<void> {
    while (this.token === token && this.phase === 'held') {
      const r = await this.io.read({
        until: this.win.endingRes,
        quietMs: this.win.quietMs,
        timeoutMs: this.win.timeoutMs,
        maxLines: this.win.maxLines,
      })
      if (this.token !== token || this.phase !== 'held') return
      if (r.reason === 'disconnected') { this.release('disconnected'); return }
      if (r.hit?.by === 'until') { this.release('结局行'); return }
      if (this.combatEnded()) { this.release('脱战'); return }
      // 静默兜底（D12/W11）：零行且安静/超时收束，连续达上限即释放防悬挂。
      if ((r.reason === 'quiet' || r.reason === 'timeout') && r.lines.length === 0) {
        this.silentStreak += 1
        if (this.silentStreak >= this.win.silentMax) { this.release('静默兜底'); return }
      } else {
        this.silentStreak = 0
      }
      this.reporter.note(`读窗收束（${r.reason}，${r.lines.length} 行）未脱战，重开读窗`)
    }
  }

  /** 释放（唯一出口）：归还行流 + 复位引擎/边沿/危险态 + 清遭遇键 + 结算记账。
   *  危险态随释放退出（结局/脱战/断线，2026-10-07 裁定）。 */
  private release(reason: string): void {
    this.exclusive(() => {
      this.token += 1
      this.phase = 'idle'
      this.dangerActive = false
      this.skipCurrent = false
      this.clearPendingRetry()
      this.silentStreak = 0
      this.io.releaseSend(COMBAT_HOLDER)
      this.engine.reset()
      this.detector.reset()
      this.world.delete('combat', '目标')
      this.world.delete('combat', '敌人数')
      this.reporter.end(reason)
    })
  }

  // ── 状态求值（D1：状态写入 → 重算档位 → 边沿/规则）────────────────

  /** 遭遇开始判定：战斗中=true 或 目标确立（敌意/开战行）。 */
  private encounterStarted(): boolean {
    if (this.world.get('combat', '战斗中')?.value === true) return true
    return this.world.get('combat', '目标') !== undefined
  }

  /** 脱战判定：战斗中键存在且为 false（服务器权威位；键未写不判）。 */
  private combatEnded(): boolean {
    const e = this.world.get('combat', '战斗中')
    return e !== undefined && e.value === false
  }

  /** 读 vitals/combat 原始值（缺 = 维不可测，computeTiers 内部转 null）。 */
  private readVitals(): CombatVitals {
    const n = (zone: string, key: string): number | undefined => {
      const v = this.world.get(zone, key)?.value
      return typeof v === 'number' ? v : undefined
    }
    const pairs: readonly (readonly [string, number | undefined])[] = [
      ['气血', n('vitals', '气血')],
      ['最大气血', n('vitals', '最大气血')],
      ['气血上限', n('vitals', '气血上限')],
      ['内力', n('vitals', '内力')],
      ['最大内力', n('vitals', '最大内力')],
      ['气势', n('combat', '气势')],
    ]
    const out: Record<string, number> = {}
    for (const [k, v] of pairs) {
      if (v !== undefined) out[k] = v
    }
    return out as CombatVitals
  }

  /** 边沿检测一步（拍计数：有跨变才算一拍，状态出现）。 */
  private detect(): { tiers: CombatTiers; edges: CombatEdge[] } {
    const tiers = computeTiers(this.readVitals())
    const edges = this.detector.update(tiers)
    if (edges.length > 0) this.reporter.round() // 有跨变才算一拍（状态出现）
    return { tiers, edges }
  }

  /**
   * 状态求值 + 规则直发（held 路径）：
   * ② 状态类危险判定（危险档跨变进入 / 回升跨变退出）→ 按当前态选规则集
   *（危险态 = 危险规则集 flee/heal；常态 = 全种子规则），命中即直发。
   */
  private evaluate(): void {
    this.exclusive(() => { // 直发引发的计数写回经 onWorldChange 再入——须在闸内
      const { tiers, edges } = this.detect()
      if (!this.dangerActive && dangerCondition(tiers)) {
        this.enterDanger()
      } else if (this.dangerActive && edges.some(liftsOutOfDanger)) {
        this.exitDanger('危险档回升')
      }
      // 危险直发同样受边沿门控（D1 未跨档不发；T21.7 回放揭示：evaluateDanger
      // 绕过节流，逐状态行求值会在危险态内每拍重发——保命直发只在跨变拍）。
      const d = this.dangerActive
        ? (edges.length > 0 ? this.engine.evaluateDanger(tiers) : null)
        : this.engine.evaluate(tiers)
      if (d === null) return
      this.sendDispatch(d)
    })
  }

  /** 危险规则集直发（pending 保命；绕过引擎节流——保命优先于节流语义，D5）。 */
  private sendDanger(): void {
    const tiers = computeTiers(this.readVitals())
    const d = this.engine.evaluateDanger(tiers)
    if (d === null) return
    this.sendDispatch(d)
  }

  private sendDispatch(d: CombatDispatch): void {
    for (const cmd of d.commands) {
      if (!this.io.send(cmd)) return // 连接断开：send 失败即止（断线由 onDisconnected 收尾）
    }
    this.reporter.dispatch(d)
  }

  // ── pending 重试（在途收束后立刻接管；状态事件之外的第二路）──────

  private schedulePendingRetry(): void {
    if (this.pendingTimer !== null || this.phase !== 'pending') return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      if (this.phase !== 'pending') return
      if (this.io.acquireSend(COMBAT_HOLDER)) {
        this.enterHeld('在途收束，pending 转正式接管')
        this.evaluate()
      } else {
        this.schedulePendingRetry()
      }
    }, this.win.pendingRetryMs)
  }

  private clearPendingRetry(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }
}
