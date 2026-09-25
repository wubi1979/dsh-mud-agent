/**
 * awareness/world — 工作记忆：世界状态（impl §3.3/§3.7）。
 *
 * 职责：
 *   - 所有层读同一份（design4 §2：世界状态是唯一真相）；
 *   - **分区**（vitals / combat / location / session）+ **置信度分档**
 *     （measured = 行文显式字段；inferred = 行为推断，如战斗态）；
 *   - `reduce(line)` 每行抓取（observe 入口调用）：把行文里的世界字段抓进
 *     对应分区，并记录来源行号与时间（来源可追溯，覆盖旧值）；
 *   - `inCombat` 是危险唤醒去重 latch 的锚点（impl §3.3：latch 挂世界状态、
 *     不挂行模式 —— 行模式会在战斗每回合重新武装，导致每回合唤醒）。
 *
 * 种子判据刻度**待实测语料标定**（impl §6：正则与阈值用实录校准；二期按
 * 语料审计增补）。本层薄：只抓字段，不解释、不做危险判断（判据在 danger）。
 *
 * 纯度纪律：本文件不 import 宿主（link 类型除外）。
 */

import type { MudLine } from '../link/ansi.ts'

/** 置信度分档：measured = 行文显式字段；inferred = 行为推断。 */
export type Confidence = 'measured' | 'inferred'

/** 世界状态分区。 */
export type WorldPartition = 'vitals' | 'combat' | 'location' | 'session'

/** 单字段记录：值 + 置信度 + 来源（行号单调递增，跨重连不复用）。 */
export interface FieldValue {
  value: string | number | boolean
  confidence: Confidence
  abs: number
  time: number
}

/** 数值捕获：容忍千分位逗号（半角 , / 全角 ，），实录行如【气血】1,560/3,000。 */
function num(s: string): number {
  return Number(s.replace(/[,，]/g, ''))
}

/** 属性行形态（旧实现实录：mud-core/perceive/rules.ts state:hp）——
 *  ^【\s*气血\s*】\s*(\d+,?\d*)\s*\/\s*(\d+,?\d*)\s*$，中文标签、数字可带逗号。
 *  同族字段（内力/精力）按同形态推定（旧表无规则，char.* 同源，依实录修正）。 */
const VITAL_RE = /^【\s*(气血|内力|精力)\s*】\s*([\d,，]+)\s*\/\s*([\d,，]+)\s*$/

/** 标签 → 字段名。 */
const VITAL_FIELD: Record<string, [cur: string, max: string]> = {
  气血: ['hp', 'maxHp'],
  内力: ['neili', 'maxNeili'],
  精力: ['jingli', 'maxJingli'],
}

/** 属性标签（非房间名）：整行【…】形态时排除误写（实录属性行同形态）。 */
const ATTR_LABELS = new Set(['气血', '内力', '精力', '经验'])

/** 字段抓取器（种子，待实测标定）：命中即写入分区。 */
interface Reducer {
  re: RegExp
  part: WorldPartition
  apply(m: RegExpMatchArray, line: MudLine, write: Write): void
}

/** reduce 内部的写入句柄（记录置信度由抓取器声明）。 */
interface Write {
  (field: string, value: string | number | boolean, confidence: Confidence): void
}

/** 种子抓取器表（刻度依旧实现实录标定，仍待回放校准 —— impl §6）。 */
const REDUCERS: Reducer[] = [
  {
    re: VITAL_RE,
    part: 'vitals',
    apply(m, line, write) {
      const label = m[1]
      const fields = label !== undefined ? VITAL_FIELD[label] : undefined
      if (fields === undefined) return
      if (m[2] !== undefined) write(fields[0], num(m[2]), 'measured')
      if (m[3] !== undefined) write(fields[1], num(m[3]), 'measured')
      void line
    },
  },
  {
    // 整行恰一个【…】标签才算房间名；属性行（【气血】156/300）由形态（尾随数字）
    // 与 ATTR_LABELS 双重排除。
    re: /^【([^】]+)】\s*$/,
    part: 'location',
    apply(m, line, write) {
      const label = m[1]
      if (label === undefined || ATTR_LABELS.has(label.trim())) return
      write('room', m[0], 'measured')
      void line
    },
  },
  {
    // 战斗态（inCombat 是危险唤醒去重 latch 的锚点，必须覆盖**双向**）：
    // 被攻击（向你袭来/攻来/出手/攻击）+ 主动开战/交战帧 —— 后者采纳旧实现
    // 实录刻度（mud-core/perceive/rules.ts combat:start：杀气/向你扑来/大喝道/
    // 大喝一声/喝道/扑了上来）。`喝道` 等宽刻度的误命中面待实录校准（§6）。
    re: /杀气|向你扑来|大喝道|大喝一声|喝道|扑了上来|向你(袭来|攻来|出手|攻击)/,
    part: 'combat',
    apply(_m, line, write) {
      write('inCombat', true, 'inferred')
      void line
    },
  },
  {
    // 战斗结束（实录刻度：combat:end —— 战斗结束/打斗结束/你战胜了/你打败了）。
    re: /战斗结束|打斗结束|你战胜了|你打败了/,
    part: 'combat',
    apply(_m, line, write) {
      write('inCombat', false, 'inferred')
      void line
    },
  },
]

/** 工作记忆（会话内，意识层维护，所有层同读）。 */
export class World {
  private parts: Record<WorldPartition, Map<string, FieldValue>> = {
    vitals: new Map(),
    combat: new Map(),
    location: new Map(),
    session: new Map(),
  }

  /** 每行抓取（observe 入口调用；薄：命中即写，不解释）。 */
  reduce(line: MudLine): void {
    for (const r of REDUCERS) {
      const m = r.re.exec(line.text)
      if (m === null) continue
      r.apply(m, line, (field, value, confidence) => {
        this.parts[r.part].set(field, { value, confidence, abs: line.abs, time: line.time })
      })
    }
  }

  /** 装配层直写（登录标志复位、流程回填等非行文来源）。 */
  set(partition: WorldPartition, field: string, value: string | number | boolean, confidence: Confidence, line?: MudLine): void {
    this.parts[partition].set(field, {
      value,
      confidence,
      abs: line?.abs ?? -1,
      time: line?.time ?? Date.now(),
    })
  }

  /** 读单字段（无记录返回 null）。 */
  get(partition: WorldPartition, field: string): FieldValue | null {
    return this.parts[partition].get(field) ?? null
  }

  /** 战斗态（危险唤醒去重 latch 的锚点；未判定返回 null）。 */
  get inCombat(): boolean | null {
    const v = this.parts.combat.get('inCombat')
    return v === undefined ? null : v.value === true
  }

  /** 快照（分区 → 字段 → 值；置信度与来源不进快照 —— 唤醒正文与
   *  mud_state 只消费值，来源排查走 get()）。 */
  snapshot(): Record<WorldPartition, Record<string, string | number | boolean>> {
    const out = {} as Record<WorldPartition, Record<string, string | number | boolean>>
    for (const part of Object.keys(this.parts) as WorldPartition[]) {
      const fields: Record<string, string | number | boolean> = {}
      for (const [k, v] of this.parts[part]) fields[k] = v.value
      out[part] = fields
    }
    return out
  }

  /** 全量复位（重连复位用：世界作废，等新连接行流重建）。 */
  reset(): void {
    for (const part of Object.keys(this.parts) as WorldPartition[]) this.parts[part].clear()
  }
}
