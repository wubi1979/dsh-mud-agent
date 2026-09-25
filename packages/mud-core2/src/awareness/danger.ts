/**
 * awareness/danger — 危险判据（impl §3.3）。
 *
 * **一份数据、字段化动作意图**：`{ re, interrupt?, wake?, abortWait?, why }`
 * —— 一张表同时服务紧急中断（halt）、行等待中断（read reason:'danger'）、
 * T2 唤醒（wake，去重 latch 由 wake 层挂 world.inCombat，impl §3.3），不许
 * 两处派生。命中即表意：为什么（why）与该做什么（动作意图字段）都在数据里，
 * observe 只执行，不解释。
 *
 * 分界纪律（design4 §5.5）：危险判断是**意识层**动作 —— "知道为什么停"，
 * 不归反射层；误放进反射层会退化成"行文特征 → 命令"映射表，危险形态每多
 * 一种就改一次表，且无法解释为什么发。
 *
 * 刻度**待实测语料标定**（impl §6）；断线不是行（link onClose 出口），不在
 * 本表。纯度纪律：本文件不 import 宿主。
 */

import type { MudLine } from '../link/ansi.ts'

/** 危险判据条目：正则 + 字段化动作意图。 */
export interface DangerRule {
  re: RegExp
  /** 为什么危险（事实描述，进唤醒正文，不写指令）。 */
  why: string
  /** 紧急中断当前活动（halt；design4 §5.6 意识层 0ms）。 */
  interrupt?: boolean
  /** 唤醒 T2（observe 经注入的 onDanger 上抛，wake 层接线）。 */
  wake?: boolean
  /** 行等待中断（read 以 reason:'danger' 收束，触发行收编进结果）。 */
  abortWait?: boolean
  /**
   * 去重锚：'combat' = interrupt/wake 仅在战斗边沿执行一次（world.inCombat
   * null/false → true）——design4 §3.2/impl §3.3：去重**挂世界状态、不挂行
   * 模式**，行模式会在战斗每回合重新武装，导致每回合 halt/唤醒。abortWait
   * **不受 latch**（每次在途 read 都该被危险行打断）。不声明 = 每次命中都
   * 执行（死亡这类一次性事件）。
   */
  latch?: 'combat'
}

/** 命中记录：条目 + 触发行。 */
export interface DangerHit {
  rule: DangerRule
  line: MudLine
}

/** 种子判据表（刻度待实测标定；硬底线：死亡/断线/凭据 —— 断线走 link）。
 *  战斗类条目挂 latch:'combat'（一次战斗一条 latch，防每回合重发 halt/重唤醒）。 */
export const DANGER: DangerRule[] = [
  {
    re: /你已经死了|你死了/,
    why: '角色死亡',
    interrupt: true,
    wake: true,
    abortWait: true,
  },
  {
    re: /向你(袭来|攻来|出手|攻击)/,
    why: '遭攻击',
    interrupt: true,
    wake: true,
    abortWait: true,
    latch: 'combat',
  },
  {
    re: /大叫.*杀了你|对你大喊.*杀/,
    why: '被叫杀',
    interrupt: true,
    wake: true,
    abortWait: true,
    latch: 'combat',
  },
]

/** 同步匹配（每行一次，observe 调用）；取第一条命中。规则表可注入
 *  （Awareness 构造器），缺省用共享 DANGER。 */
export function matchDanger(line: MudLine, rules: DangerRule[] = DANGER): DangerHit | null {
  for (const rule of rules) {
    if (rule.re.test(line.text)) return { rule, line }
  }
  return null
}
