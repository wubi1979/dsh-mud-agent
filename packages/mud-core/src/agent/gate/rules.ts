/**
 * dsh-mud-core — 安全闸门注入规则 (gate/rules): 机制与知识的分离点。
 *
 * 强制判定层 (policy.ts / tool-gate.ts) 只消费注入的 `GateRules`, 不直接持有游戏
 * 知识 (world/game 的移动别名/状态命令、agent/commands 的危险表)。装配方
 * (assemble.ts) 用 `buildGateRules` 把这两处数据源组装成一个可注入对象:
 *   - commands: 工具名 → 该工具调用会发出的游戏命令 (按工具语义派生);
 *   - dangerous: 危险命令策略表 (deny/ask; 数据驱动, 可整体替换)。
 *
 * @module @deepseek-ai/dsh-mud-core/agent/gate/rules
 */

import { MOVE_ALIASES, STATUS_CMDS } from '../../world/game.ts'
import { DEFAULT_DANGEROUS_COMMANDS, type DangerousRule } from '../commands.ts'

export type { DangerousRule } from '../commands.ts'

/** 工具调用 → 实际发出的游戏命令 (无发送 = 空数组)。 */
export type CommandDeriver = (args: unknown) => readonly string[]

/** 安全闸门的注入规则 (机制层消费; 由 world/game + agent/commands 组装)。 */
export interface GateRules {
  /** 工具名 → 命令派生器 (哪些 MUD 工具会发什么命令)。 */
  commands: Readonly<Record<string, CommandDeriver>>
  /** 危险命令策略表 (deny/ask; 档位感知判定数据源)。 */
  dangerous: readonly DangerousRule[]
}

/**
 * 组装缺省 GateRules (从 world/game + agent/commands)。
 *
 * 命令派生器与 `agent/tools-build.ts` 的模板口径一致: `mud_move` → 方向全名
 * (短别名归一), `mud_look` → `look [target]`, `mud_status` → `STATUS_CMDS[what]`;
 * `mud_send` 直接取 `cmd`/`cmds`。参数非法时返回由参数派生的原样文本 —— 判定层
 * 不做校验 (校验与拒绝由工具自己负责), 这里只回答"它会发什么"。
 * @param options.dangerous 危险表覆盖 (缺省 `DEFAULT_DANGEROUS_COMMANDS`; 整体替换, 不合并)。
 * @returns 可注入的规则对象。
 */
export function buildGateRules(options: { dangerous?: readonly DangerousRule[] } = {}): GateRules {
  return {
    commands: {
      mud_send: (args): readonly string[] => {
        const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        if (Array.isArray(record.cmds)) {
          return record.cmds.filter((c): c is string => typeof c === 'string')
        }
        return typeof record.cmd === 'string' ? [record.cmd] : []
      },
      mud_move: (args): readonly string[] => {
        const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        if (typeof record.direction !== 'string') return []
        const raw = record.direction.trim().toLowerCase()
        return [MOVE_ALIASES[raw] ?? raw]
      },
      mud_look: (args): readonly string[] => {
        const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        return typeof record.target === 'string' && record.target.trim() !== ''
          ? [`look ${record.target.trim()}`]
          : ['look']
      },
      mud_status: (args): readonly string[] => {
        const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        if (typeof record.what !== 'string') return []
        const key = record.what.trim().toLowerCase()
        return [STATUS_CMDS[key] ?? key]
      },
    },
    dangerous: options.dangerous ?? DEFAULT_DANGEROUS_COMMANDS,
  }
}