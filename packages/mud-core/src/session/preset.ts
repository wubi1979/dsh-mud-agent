/**
 * dsh-mud-core — `mud-player` agent preset 的插件行 (agent 平面, `doc/ARCHITECTURE.md` §9)。
 *
 * 这是**官方 agent preset 机制**里的那一行 (见 `presets/mud-player/agent.cordis.yml`):
 * 官方在组装 `mud-player` preset 时 `import` 本模块并 `apply` 一次, 注册进的是
 * **preset 作用域** —— 加入该 preset 的每个 agent 都继承这套工具与提示区段。
 *
 * 三条设计约束 (都由官方 preset 挂载审计逼出来):
 *   1. **不 provide 服务, 也不等待组装/宿主从未提供的服务**: 本模块没有 `inject`
 *      列表, 宿主服务 (mud / tools / systemPrompt) 一律 `ctx.get(...)` 惰性读取,
 *      因此在宿主行尚未就绪时也只是"能力暂时为空", 不会把挂载卡成 pending;
 *   2. **注册发生在组装期, 执行发生在会话期**: 工具声明 (name/description/parameters)
 *      是共享的, 执行体按调用方 agent 解析到具体会话 —— 这是 per-session 状态
 *      (队列/桥/world/凭据) 与"一份共享组装"之间唯一可行的接法;
 *   3. **能力与策略分家**: 本行只管能力 (工具 + 提示区段); 选路 (`agent/request`)
 *      与权限闸门 (`tools/pre-execute`) 留在宿主插件 —— 它们是策略, 需要会话运行时
 *      与档位状态, 不属于 preset 的声明面。
 *
 * 已知取舍 (§10 × §9, 见文档 §18.9): preset 作用域共享一套工具, 因此**档位可见性层
 * 在 preset 模式下退化为"全档工具都可见 + 强制层拦截 + 提示文本说明"**; 需要严格
 * 可见性的部署应关闭 `Config.agentPreset`, 走宿主侧装配。
 * @module @deepseek-ai/dsh-mud-core/preset-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MUD_PROMPT_ORDER, runWithDeliveryChannel } from './mount.ts'
import { mudToolSchemaTable } from '../agent/tools-build.ts'
import type { MudToolResult } from '../agent/tools-schema.ts'
import type { MudAgentKit } from '../shell/service.ts'

/** 插件名 (Loader 行标识)。 */
export const name = 'mud-preset-agent'

/** 提示区段 order: 唯一来源在 `mount.ts` (宿主装配路径用同一套编号)。 */
const ORDER = MUD_PROMPT_ORDER

/**
 * 取调用方 agent 的会话 id (agent 的 id **就是**官方会话 id)。
 * @param agent 调用方 agent (工具执行体/提示组装上下文里取得)。
 * @returns 会话 id, 或 undefined (无 agent 上下文: 诊断性组装、非 agent 调用)。
 */
function sessionIdOf(agent: Agent | undefined): string | undefined {
  return agent === undefined ? undefined : String(agent.id)
}

/**
 * 从提示组装上下文取 agent。
 *
 * 官方 `AssembleContext` 由 agent-loop 扩展带上 `agent`(官方 `user-approval` /
 * `sandbox-policy` 的区段提供者就是这么读的), 但该字段不在 system-prompt 包自己
 * 声明的接口里, 所以这里按结构读取一次, 读不到就退化为"无会话上下文"。
 * @param context 组装上下文。
 * @returns 组装所属 agent。
 */
function contextAgent(context: unknown): Agent | undefined {
  const agent = (context as { agent?: unknown } | undefined)?.agent
  return typeof agent === 'object' && agent !== null && 'id' in agent ? agent as Agent : undefined
}

/** 该会话工具不可用时的统一结果 (会话未绑定 / 已注销; 不发命令)。 */
function unavailable(toolName: string): MudToolResult {
  return { ok: false, note: `${toolName}: 该会话未绑定 MUD 运行时 (会话未声明 MUD 绑定, 或已被注销)`, cmd: '' }
}

/**
 * 注册 preset 的能力面 (工具 + 提示区段)。
 * @param ctx preset 作用域上下文 (官方 `mount` 传入)。
 */
export function apply(ctx: Context): void {
  /** 宿主服务 (惰性读取: 组装期可能还没有, 执行期一定有)。 */
  const kit = (): MudAgentKit | undefined => ctx.get('mud')?.agentKit()

  ctx.inject(['tools', 'systemPrompt'], (scope) => {
    // ── 工具: 组装期注册一次 (共享给加入本 preset 的所有 agent) ──
    for (const schema of mudToolSchemaTable()) {
      scope.tools.register(defineTool({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        output: schema.output,
        execute: async (args, exec) => {
          const sessionId = sessionIdOf(exec.agent)
          const sessionKit = kit()
          const tool = sessionKit?.tools(sessionId)?.[schema.name]
          if (tool === undefined) return unavailable(schema.name)
          // 官方的回合取消信号转发给桥 (preset 线同样适用; §8)。
          // 调用留痕必须在执行前 (与宿主路径一致): 决策日志要反映因果序,
          // 执行期间的结算/发送日志先落会倒挂。
          sessionKit?.noteToolCall(sessionId, schema.name, args as Record<string, unknown>)
          // **投递通道接线**（§19.6.2）: 与宿主路径共用同一个 helper —— preset 部署下漏接它
          // 会让 defer 完全失效（实测: 投递仍走 followup, 账目停在 3 回合 / 6 次请求）。
          const channel = sessionKit?.channel(sessionId)
          const result = await runWithDeliveryChannel({
            ...(channel === undefined ? {} : { channel }),
            callId: String(exec.callId ?? ''),
            exec,
            run: async () => await tool.execute(args as Record<string, unknown>, { signal: exec.signal }),
          })
          return result
        },
      }))
    }

    // ── 提示区段: 组装期注册一次, 文本每次组装按 agent 求值 ──
    // **人设不在这里**: 会话人设已有主人 (standard preset 的 `persona` 行 = 部署人设),
    // 本行只能并列追加 —— 那会让 MUD 会话同时被告诉"你是编码 agent"和"你是 MUD 玩家"。
    // 替换必须在 agent 作用域用同名槽做 (见 `agent-bridge.ts#attachMudPersona`, 由宿主在
    // `attachToAgent` 里调, 两条装配路径共有), 所以 preset 行只提供技能/命令/档位三段。
    scope.systemPrompt.section({
      name: 'mud-skills',
      order: ORDER.skills,
      text: () => kit()?.prompt.skillsText() ?? '',
    })
    scope.systemPrompt.section({
      name: 'mud-commands',
      order: ORDER.commands,
      text: () => kit()?.prompt.commands ?? '',
    })
    scope.systemPrompt.section({
      name: 'mud-tier',
      order: ORDER.tier,
      text: (context) => kit()?.tierNote(sessionIdOf(contextAgent(context))) ?? '',
    })
  })
}
