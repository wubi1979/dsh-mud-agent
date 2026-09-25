/**
 * awareness/reflex — REFLEX 表（impl §3.3）。
 *
 * 反射：**天然无后果的机械反应**（save、翻页）—— 刺激 → 动作，不问为什么、
 * 不管后果（design4 §2：膝跳反射，不经觉察）。入选纪律：只放天然无后果动作
 * （多发无害），不做后果评估；需要"知道为什么"的动作归意识层（danger）。
 *
 * 语义："吞触发行、留结果"（observe 执行）—— 触发行不进模型面（提示文本对
 * 模型零信息量），命令应答照常进模型面并参与判据（整条吞掉会静默丢失"存档
 * 失败"这类负面结果）；语料与日志始终保留全部行。直发走 mud.send（宿主不可
 * 见，不经工具管线；留痕靠接线层 corpus 自记）。
 *
 * `cmd: ''` = 翻页空命令（裸 \r\n，telnet.send 对空串恰发换行；精确字节待
 * 实测核对 —— impl §6）。新条目按语料审计增补（二期支 3）。
 *
 * 纯度纪律：本文件不 import 宿主（纯表数据）。
 */

import type { MudLine } from '../link/ansi.ts'

/** 反射条目：触发正则 + 直发命令。 */
export interface ReflexRule {
  re: RegExp
  /** 直发命令（'' = 翻页空命令，裸换行）。 */
  cmd: string
  /** 入选理由（审计用，不进模型面）。 */
  why: string
}

/** REFLEX 表（数据；现存两条种子）。 */
export const REFLEX: ReflexRule[] = [
  { re: /系统将在.*分钟后存档|请及时存档/, cmd: 'save', why: '存档提示 → save（多发无害）' },
  { re: /按回车继续|press enter/i, cmd: '', why: '翻页 → 空命令（裸换行，天然无后果）' },
]

/** 同步匹配（observe 调用）；取第一条命中。规则表可注入（Awareness 构造器），
 *  缺省用共享 REFLEX。 */
export function matchReflex(line: MudLine, rules: ReflexRule[] = REFLEX): ReflexRule | null {
  for (const rule of rules) {
    if (rule.re.test(line.text)) return rule
  }
  return null
}
