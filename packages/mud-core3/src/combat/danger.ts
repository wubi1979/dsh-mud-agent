/**
 * mud-core3 combat/danger — 危险抢占通道判据（T21.5）：纯判定，零副作用。
 *
 * 通道本体（两处判定点 + 危险态 + 退出）在 controller 内实现（同一条同步栈），
 * 本文件单点承载**判据与跨变语义**：
 *   - 判定点①（文本类，行路径最前）：敌意确立 / 我方开战行（判据与 tracker
 *     战斗行规则同源单点，A.8.3）——命中即进入危险态并接管（2026-10-07 裁定）；
 *     致命提示行文待实录补充（A.8.5），替换只动 COMBAT_THREAT_RES；
 *   - 判定点②（状态类，tracker.observe 之后）：危险档跨变——气血档落入
 *     危险/濒危 或 容量档落入需服药（= 种子 flee 条件，PLAN 3.3 规则 1）；
 *   - 危险态退出 = 结局类行文 ∨ 危险档回升跨变 ∨ 脱战 ∨ 断线（2026-10-07 裁定）；
 *     回升跨变 = 边沿自危险档上移出（濒危/危险→五成/健康；需服药→受损/完整）。
 *
 * 动作序（D5）：先 abortWait（打断在途读窗与流程，reason='danger'），再直发
 * 危险规则集（engine.evaluateDanger：flee/heal，绕过节流）；接管不等锁（stealSend）。
 *
 * @module mud-core3/combat/danger
 */

import { COMBAT_ENGAGE_RE, COMBAT_HOSTILE_RE } from '../tracker.ts'
import type { CombatEdge, CombatTiers } from './state.ts'

/** 危险文本判据（判定点①；实录 A.8.3 + 待实录补充，替换只动这里）。 */
export const COMBAT_THREAT_RES: readonly RegExp[] = [
  COMBAT_HOSTILE_RE, // 敌意确立：看起来X想杀死你！
  COMBAT_ENGAGE_RE,  // 我方开战：你大喝一声，开始对X发动攻击！
]

/** 判定点①：行文命中威胁判据。 */
export function isThreatLine(text: string): boolean {
  return COMBAT_THREAT_RES.some(re => re.test(text))
}

/** 危险档判定（判定点②的进入条件；= 种子 flee 条件，维间 OR）。 */
export function dangerCondition(t: CombatTiers): boolean {
  return t.buffer === '危险' || t.buffer === '濒危' || t.cap === '需服药'
}

/** 回升跨变（退出条件之一）：边沿自危险档上移出危险档位。 */
export function liftsOutOfDanger(e: CombatEdge): boolean {
  if (e.key === 'buffer') {
    const fromDanger = e.from === '危险' || e.from === '濒危'
    const toLifted = e.to === '五成' || e.to === '健康'
    return fromDanger && toLifted
  }
  if (e.key === 'cap') return e.from === '需服药' && (e.to === '受损' || e.to === '完整')
  return false
}
