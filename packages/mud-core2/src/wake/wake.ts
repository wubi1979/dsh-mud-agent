/**
 * wake/wake — 唤醒器：两源自建唤醒（静默 + 危险）→ DSH 动词（impl §3.4）。
 *
 * 第三源（子级结算）由**宿主投递**（continuation-activation：idle→followup /
 * running→steer）——插件不重复唤醒、不自报结算；结算通知是 best-effort
 * （四种状态不唤醒），交付失败无独立兜底，由预算路径承担（subagent/ 的事，
 * 本层无涉）。
 *
 * 去重在 awareness/observe（world.inCombat 边沿 + 规则 latch:'combat'，impl
 * §3.3）——本层只投递正文，不做任何去重：死亡类规则无 latch，observe 每次
 * 命中都上抛同一 why，本层照投不合并。
 *
 * 守卫纪律（impl §3.4，V7 裁定）：
 *   - **不要**写"无子 agent 在途"守卫——list_agents 的 inactive 不代表任务
 *     完成（已结算的子级仍在目录里），据此判会让根首次派单后永久认为"有事在干"；
 *   - **不要**写"结算已消化"守卫——双唤醒窗口无害，接受冗余唤醒
 *     （T2 的决策输入是唤醒正文，不是唤醒次数）。
 *
 * 纯度纪律：本文件不 import 宿主；宿主动词经注入窄接口（本层只产出文本，
 * 打包 UserMessage 归装配层）。
 */

import { dangerText, silenceText } from './context.ts'
import type { DangerHit } from '../awareness/danger.ts'
import type { World } from '../awareness/world.ts'

/** 注入窄接口（impl §2：`{ followup, steer, idle }` 操作 agent）。 */
export interface WakeDeps {
  world: World
  /** 静默唤醒投递（宿主 followup：空闲自开回合、运行中排队——冗余唤醒无害）。 */
  followup(text: string): void
  /** 危险唤醒投递（宿主 steer：空闲自开回合、运行中步边界插话）。 */
  steer(text: string): void
  /**
   * 行流空闲（无在途 read 持有者）。false = 手里有活：静默到期只重新武装、
   * 不唤醒（在途 read 有自己的 quietMs/timeoutMs 收束，收束后的持续静默会
   * 再次到期唤醒）。只看行流持有者，**不查子 agent 在途**（V7，见头部）。
   * 装配约定（写死，防误闭包重蹈 V7）：`idle: () => mud.currentHolder === null`。
   */
  idle(): boolean
}

export interface WakeOptions {
  /** 静默时长（ms）：Config 化，取值待实测语料校准（impl §6）。 */
  silenceMs: number
}

/** 唤醒器（每 agent 会话一实例；装配时把 onActivity/onDanger 接到 observe）。 */
export class Wake {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: WakeDeps,
    private readonly opts: WakeOptions,
  ) {}

  /** 危险唤醒（observe 的 onDanger 接线）：事实正文 → steer。 */
  steerDanger(hit: DangerHit): void {
    this.deps.steer(dangerText(hit, this.deps.world))
  }

  /**
   * 静默重新武装（observe 的 onActivity 接线）：新行到达即重新武装（写死，
   * impl §6）。每行一次 clear+set —— 单 timer、到期驱动（形态参考宿主
   * schedule/runtime：同一时刻至多一个 timer，重算即重置）。
   */
  armSilence(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.onSilence()
    }, this.opts.silenceMs)
  }

  /** 停表（agent dispose 时调用；不唤醒）。 */
  dispose(): void {
    this.clearTimer()
  }

  /**
   * 静默到期：行流空闲才唤醒（"没事且没事干"）；手里有活（在途 read）只
   * 重新武装。不做子 agent/结算守卫（见头部纪律）。
   */
  private onSilence(): void {
    if (!this.deps.idle()) {
      this.armSilence()
      return
    }
    this.deps.followup(silenceText(this.deps.world, this.opts.silenceMs))
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
