/**
 * wake/context — 唤醒正文组装（纯函数，impl §3.4，**瘦**）。
 *
 * 历史每请求自动携带（宿主 agent-loop deriveMessages）——计划、结算报告、
 * 技能调用都已在上下文里，组装器**不搬运历史**。每次唤醒正文只补两件模型
 * 看不到的东西：
 *
 *   [唤醒原因：事实短消息，不是指令]   "静默环顾" / "危险：遭攻击" / 事实陈述
 *   [世界摘要：字段清单判据]           见 SUMMARY_FIELDS 注释（入选判据）
 *
 * 克制原则：唤醒原因是**事实**（"HP 18%"），不是指令（"请逃跑"）——目标级
 * 决策归 T2（意识/唤醒层禁令：不持有目标、不替 T2 做计划级决策）。
 * 缺字段跳过、不补默认值：摘要只报告 world 真实测得的字段（宁缺勿假）；
 * 空世界返回显式占位"（暂无已测得的世界字段）"——说明零字段这一事实，
 * 避免摘要标题后空白被读成渲染事故。
 *
 * 纯度纪律：不 import 宿主。
 */

import type { DangerHit } from '../awareness/danger.ts'
import type { World } from '../awareness/world.ts'

/**
 * HP 缓降越界阈值（当前值/上限 比例）：低于即在世界摘要里标注"低于 N% 警戒"
 * 越界事实（impl §3.3：越界不唤醒、随静默/危险唤醒的摘要搭车上浮）。取值
 * 待实测语料标定（impl §6）。
 */
export const HP_LOW_RATIO = 0.3

/**
 * 世界摘要字段清单判据（impl §3.4）：入选 = T2 本次决策必需，**新增字段必须
 * 先在这里写理由**——防孤儿字段（world 抓了、摘要不报、谁也不消费）。
 *
 *   - HP（vitals.hp/maxHp）：生存底线；危险评估与"HP 缓降"越界事实的唯一来源；
 *   - 内力（vitals.neili/maxNeili）：维持类资源，打坐/补给的规划输入；
 *   - 位置（location.room）：移动/逃跑/寻路的事实基础；
 *   - 登录态（session.loggedIn，装配层直写）：断线/重连判断，未登录时动作序列完全不同；
 *   - 饥饿/口渴（vitals.hunger/thirst，reducer 待增补）：维持类自查的输入；
 *   - 金钱（session.money，reducer 待增补）：经济动作的事实边界。
 *
 * 精力（vitals.jingli）world 抓取但**不进摘要**：当前无决策依赖（防孤儿字段）。
 */
export function worldSummary(world: World): string {
  const snap = world.snapshot()
  const lines: string[] = []

  const hp = snap.vitals['hp']
  const maxHp = snap.vitals['maxHp']
  if (typeof hp === 'number' && typeof maxHp === 'number' && maxHp > 0) {
    const pct = Math.round((hp / maxHp) * 100)
    const low = hp / maxHp < HP_LOW_RATIO ? `，低于 ${Math.round(HP_LOW_RATIO * 100)}% 警戒` : ''
    lines.push(`HP ${hp}/${maxHp}（${pct}%${low}）`)
  }

  const neili = snap.vitals['neili']
  const maxNeili = snap.vitals['maxNeili']
  if (typeof neili === 'number' && typeof maxNeili === 'number') {
    lines.push(`内力 ${neili}/${maxNeili}`)
  }

  const room = snap.location['room']
  if (typeof room === 'string') lines.push(`位置 ${room}`)

  const loggedIn = snap.session['loggedIn']
  if (typeof loggedIn === 'boolean') lines.push(`登录：${loggedIn ? '是' : '否'}`)

  const hunger = snap.vitals['hunger']
  if (hunger !== undefined) lines.push(`饥饿 ${String(hunger)}`)
  const thirst = snap.vitals['thirst']
  if (thirst !== undefined) lines.push(`口渴 ${String(thirst)}`)

  const money = snap.session['money']
  if (money !== undefined) lines.push(`金钱 ${String(money)}`)

  if (lines.length === 0) return '世界摘要：（暂无已测得的世界字段）'
  return `世界摘要：\n${lines.map(l => `- ${l}`).join('\n')}`
}

/**
 * 静默唤醒正文：唤醒原因（事实）+ 世界摘要。触发条件（静默 && 行流空闲）
 * 由 wake 层守卫，正文只陈述事实。
 */
export function silenceText(world: World, silenceMs: number): string {
  const reason = `静默环顾：MUD 行流已 ${Math.round(silenceMs / 1000)}s 无新行，且当前没有在途命令。`
  return `${reason}\n${worldSummary(world)}`
}

/**
 * 危险唤醒正文：唤醒原因（why = 规则声明的事实描述）+ 触发行原文 + 世界摘要。
 * 不写指令（"快逃"是 T2 的事）；触发行原文照常进模型面（意识层无输出特例），
 * 这里带上是为了 steer 插话场景下 T2 不必回翻行流。
 */
export function dangerText(hit: DangerHit, world: World): string {
  const reason = `危险：${hit.rule.why}。\n触发行：${hit.line.text}`
  return `${reason}\n${worldSummary(world)}`
}
