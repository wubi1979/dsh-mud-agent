/**
 * dsh-mud-core — 工具调用权限判定 (permission policy, `doc/ARCHITECTURE.md` §10).
 *
 * 这里是**纯判定**: 输入一次工具调用的名字与参数, 输出 `allow / deny / ask`。
 * 执行点在 `agent/gate/tool-gate.ts` (官方 `tools/pre-execute` waterfall); 危险命令
 * 策略表由 `buildGateRules` 从 `agent/commands.ts` 组装注入 (`DEFAULT_DANGEROUS_COMMANDS`,
 * 见 `rules.ts`) —— 本模块不直接持有游戏知识。
 *
 * **actor 模型** (§10): 只有 agent 受档位约束。页面手打命令走 `/mud/command`
 * (actor `user`) 不进工具管道; 连接/断开由页面入口驱动 (actor `system`) 同样不
 * 进管道; **登录流程**(发名字/密码/确认替换)虽借道 `mud_send`, 但属于 `system`
 * —— 判据是"该会话尚未登录 + 命令 ∈ 登录流程命令集", 因此只读档也能登录
 * (否则只读档永远上不了线, 档位就成了摆设)。
 * @module @deepseek-ai/dsh-mud-core/agent/gate/policy
 */

import { dangerousRuleFor } from '../commands.ts'
import { tierSpec, type MudTier } from './tiers.ts'
import type { GateRules } from './rules.ts'

export type { DangerousAction, DangerousRule } from '../commands.ts'
export { DEFAULT_DANGEROUS_COMMANDS, deniedCommands, dangerousRuleFor } from '../commands.ts'

/**
 * 一个工具调用会发出的游戏命令 (无发送 = 空数组)。
 *
 * 派生规则由 `buildGateRules` (agent/gate/rules.ts) 从 `world/game.ts`
 * (MOVE_ALIASES/STATUS_CMDS) 组装 —— 与 `tools.ts` 的命令模板口径一致, 这里
 * 只按注入的派生器回答"它会发什么", 不做参数校验 (校验与拒绝由工具自己负责)。
 * @param name 工具名。
 * @param args 工具参数 (模型给的 JSON)。
 * @param commands 注入的命令派生表 (GateRules.commands)。
 * @returns 将发出的命令序列 (可能为空)。
 */
export function commandsOfToolCall(
  name: string,
  args: unknown,
  commands: GateRules['commands'],
): readonly string[] {
  return commands[name]?.(args) ?? []
}

/** `tools/pre-execute` 判定的输入 (纯数据; 无 ctx 依赖 → 可直接单测)。 */
export interface ToolCallVerdictInput {
  /** 工具名。 */
  name: string
  /** 模型给的参数。 */
  args: unknown
  /** 当前档位。 */
  tier: MudTier
  /** 组装注入的门禁规则 (危险表 + 工具命令派生器)。 */
  rules: GateRules
  /** 本会话尚未登录 (登录流程中) → 登录命令按 `system` 处理。 */
  loginFlow: boolean
  /** 登录流程命令集 (由登录规则派生)。 */
  loginCommands: ReadonlySet<string>
  /** 本插件注册的工具名全集 (非 MUD 工具一律放行)。 */
  mudTools: ReadonlySet<string>
}

/** 判定结果 (对齐官方 `PreToolDecision` 的三态)。 */
export type ToolVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }

const ALLOW: ToolVerdict = { kind: 'allow' }

/**
 * 判定一次工具调用 (纯函数; 强制层的**唯一**判据)。
 *
 * 顺序: 非 MUD 工具 → 放行; 档位可见性 → deny; 逐条命令 (登录流程豁免 → 危险表
 * deny/ask → 只读档 deny); 其余放行。
 * @param input 判定输入。
 * @returns `allow` / `deny{reason}` / `ask{reason}`。
 */
export function evaluateToolCall(input: ToolCallVerdictInput): ToolVerdict {
  if (!input.mudTools.has(input.name)) return ALLOW
  const spec = tierSpec(input.tier)
  if (!spec.tools.includes(input.name)) {
    return { kind: 'deny', reason: `权限档位「${spec.name}」不提供工具 ${input.name}` }
  }
  const commands = commandsOfToolCall(input.name, input.args, input.rules.commands)
  for (const cmd of commands) {
    const text = cmd.trim()
    if (text === '') continue
    if (input.loginFlow && input.loginCommands.has(text)) continue
    const dangerous = dangerousRuleFor(text, input.tier, input.rules.dangerous)
    if (dangerous?.action === 'deny') return { kind: 'deny', reason: dangerous.reason }
    if (dangerous?.action === 'ask') return { kind: 'ask', reason: dangerous.reason }
    if (input.tier === 'observe') {
      return {
        kind: 'deny',
        reason: `权限档位「${spec.name}」只读: 命令未发送 (用 mud_state/mud_recall 读取; 需要操作请切换到「读写」档)`,
      }
    }
  }
  return ALLOW
}
