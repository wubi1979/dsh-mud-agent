/**
 * dsh-mud-core — MUD agent 集成 (host half, **挂载侧**)。
 *
 * 把 MUD 会话能力挂到官方 agent 作用域上, 三件事:
 *
 *   1. **人设注入** (`attachMudPersona`): 写入官方人设槽
 *      (`deployment:persona-prefix`, 后缀槽置空), **per-agent 影子注册**,
 *      覆盖 preset 层的编码 agent 人设;
 *   2. **提示区段** (`attachMudPrompt`): skills / commands / tier 区段注册到
 *      agent 作用域 (每次 assembly 求值, 技能/档位变化即时生效);
 *   3. **工具注册与投递通道接线** (`attachMudTools` + `runWithDeliveryChannel`):
 *      档位可见性过滤决定注册哪些工具, 并经由投递通道把工具调用与会话投递
 *      (defer 槽 / 回合收束) 接起来。
 *
 * 选路 / T1 provider 在 `lane.ts`。
 * @module @deepseek-ai/dsh-mud-core/session/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MudTools, MudToolResult } from '../agent/tools-schema.ts'
import type { ReplySettle } from '../agent/inflight.ts'
import type { ownedGameMessage } from '../deliver/lane.ts'

/** agent 系统提示区段 (skills/commands/tier; 人设见 `attachMudPersona`)。 */
export interface MudPromptSections {
  /** 技能目录文本提供者 (每次 assembly 求值 — 技能变化无需重建 agent)。 */
  skillsText: () => string
  commands: string
  /** 权限档位说明提供者 (每次 assembly 求值 — 档位切换即时生效; §10)。 */
  tierText?: () => string
}

/**
 * 把 MUD 人设**写进官方人设槽** (`deployment:persona-prefix`), 即"per-agent 影子注册"。
 *
 * 为什么必须走这个槽而不是自建 `mud-persona`: 会话的系统提示里人设已有主人 ——
 * 部署的 `personaPrefix` 与 **preset 行 `persona`** (本包 preset 是 standard 的整份副本,
 * 那句话是 "You are a coding agent powered by the {{model}} model.")。自建区段只会**并列**
 * 出现 (MUD 会话被同时告知"你是编码 agent"和"你是 MUD 玩家"), 只有**同名**才替换:
 * 官方 `systemPrompt` 文档明说"作用域内同名区段覆盖外层", 并且 preset 作用域与 agent
 * 作用域同名会抛重复注册 —— 因此替换必须在 agent 作用域做 (官方注解里推荐的 per-agent
 * 覆盖路径), 不能在本包 preset 行里做。
 *
 * 同时把**人设后缀槽**置空: standard 的 `persona` 行后缀是 "Your working directory is
 * {{cwd}}.", 对游戏会话无意义 (留空区段在渲染时被丢弃, 但名字已被本注册覆盖)。
 * @param agentCtx agent 作用域上下文 (`agent.ctx`)。
 * @param persona 人设文本提供者 (每次 assembly 求值; 空串 = 不注册前缀, 由外层人设显示)。
 */
export function attachMudPersona(agentCtx: Context, persona: () => string): void {
  agentCtx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: () => persona(),
  })
  agentCtx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '',
  })
}

/**
 * 把 MUD 系统提示区段注册到 agent 作用域 (仅 MUD 会话的 agent)。
 * @param agentCtx agent 作用域上下文 (`agent.ctx`)。
 * @param sections 区段文本 (空串/空文本跳过)。
 */
export function attachMudPrompt(agentCtx: Context, sections: MudPromptSections): void {
  agentCtx.systemPrompt.section({ name: 'mud-skills', order: -50, text: () => sections.skillsText() })
  if (sections.commands !== '') {
    agentCtx.systemPrompt.section({ name: 'mud-commands', order: -40, text: sections.commands })
  }
  if (sections.tierText !== undefined) {
    agentCtx.systemPrompt.section({ name: 'mud-tier', order: -45, text: () => sections.tierText?.() ?? '' })
  }
}

/**
 * **投递通道**（由会话运行时实现；工具包装器按官方扩展点调用）。
 *
 * 三件事，都是"把工具调用与投递接起来"（`doc/ARCHITECTURE.md` §19.6.2）：
 *   - `beginToolCall` / `endToolCall`：告诉运行时"有工具在途" ⇒ 期间产生的投递**改走
 *     defer 槽**（判据 A），由本次调用的结果带进**同一回合的下一步**；
 *   - `takeDeferredDeliveries`：取走槽里的消息（包装器逐条 `exec.deferContext`）；
 *   - `shouldConcludeTurn`：判据 B —— 本调用是某投递的最后一条动作、且流程机已空闲、
 *     且没有待投递 ⇒ 可以 `exec.concludeTurn()`（省掉一次"空续步"）。
 */
export interface MudDeliveryChannel {
  /** 工具调用进入（与 `endToolCall` 配对）。 */
  beginToolCall: () => void
  /** 工具调用离开。 */
  endToolCall: () => void
  /**
   * **工具结果 → 流程机**（可选；§19.1 的 `tool` 判据）。
   *
   * 只有"只调工具、不发游戏命令"的步骤（如 fullme 的取图步）才需要它：这类步骤没有
   * GA 可判，靠工具结果是成功还是失败收尾。运行时会用 call-id 解析出步骤 id，
   * 只接受**当前步**的结果（T2 自己发起的调用解析失败 → 忽略）。
   * @param callId 本次工具调用 id（`mud-<delivery>-<index>`）。
   * @param outcome 工具结算结局 (ok/fail/error)。
   * @param settled 在途窗口结算方式 (发命令工具携带; 纯校验拒绝 = undefined)。
   * @param hitText 判据命中行原文 (until 结算; 流程 `{lastFail}` 槽源)。
   */
  noteToolResult?: (callId: string, outcome: 'ok' | 'fail' | 'error', settled?: ReplySettle, hitText?: string) => void
  /** 取走本步待随结果进下一步的投递（顺序保持）。 */
  takeDeferredDeliveries: () => ReturnType<typeof ownedGameMessage>[]
  /** 本调用能否收束当前回合。 */
  shouldConcludeTurn: (callId: string) => boolean
}

/**
 * **一次工具调用的投递通道接线**（两条装配路径共用；`doc/ARCHITECTURE.md` §19.6.2）。
 *
 * 宿主路径（`attachMudTools`）与 preset 路径（`preset-agent`）各有自己的工具包装器 ——
 * 接线必须共用一份实现，否则漏接一条就会出现"defer 只在一条路径生效"（实测踩过：preset
 * 部署下 `beginToolCall()` 从未被调用，投递仍走 `followup`，账目停在 3 回合 / 6 次请求）。
 *
 * 三步：
 *   1. 进出工具调用通知运行时（期间产生的投递进 defer 槽）；
 *   2. 结果提交前把槽里的投递逐条 `exec.deferContext`（随本结果进下一步，同一回合）；
 *   3. `result.ok && shouldConcludeTurn(callId)` ⇒ `exec.concludeTurn()`（判据 B / 判据 C）。
 *
 * 另有一步**在 `endToolCall` 之前**：把工具结果喂回流程机（`noteToolResult`，`tool` 判据）——
 * 这样判定产出的下一步动作仍在"在途"窗口里，会随本结果 defer 出去（判据 A），而不是另开回合。
 * @param input 通道（缺省 = 完全不接线，退回旧行为）、本次调用 id、官方 exec、以及工具执行体。
 * @returns 工具结果（原样透传）。
 */
export async function runWithDeliveryChannel(input: {
  channel?: MudDeliveryChannel
  callId: string
  exec: { deferContext: (message: UserMessage) => void; concludeTurn: () => void }
  run: () => Promise<MudToolResult>
}): Promise<MudToolResult> {
  const { channel, callId, exec, run } = input
  if (channel === undefined) return run()
  channel.beginToolCall()
  let result: MudToolResult
  try {
    result = await run()
    // 流程判定要在"工具仍算在途"时做（判据 A）：判定产出的投递随本结果进下一步。
    channel.noteToolResult?.(callId, result.outcome ?? (result.ok ? 'ok' : 'error'), result.settled, result.hitText)
  } finally {
    channel.endToolCall()
  }
  for (const message of channel.takeDeferredDeliveries()) exec.deferContext(message)
  if (result.ok && channel.shouldConcludeTurn(callId)) exec.concludeTurn()
  return result
}

/**
 * 把会话工具集注册到 agent 作用域 (仅 MUD 会话的 agent; agent 释放即注销)。
 *
 * 档位可见性 (`doc/ARCHITECTURE.md` §10): `visible` 决定**注册哪些工具** —— 模型
 * 看到的工具列表就是该档的能力。强制层在 `tools/pre-execute`
 * (`tool-gate.ts`), 与注册是两件事: 可见性给模型正确的视图, 强制层才是唯一算数处。
 *
 * 包装器还承担**投递通道**接线（§19.6.2）：进/出工具调用通知 → 结果提交前把 defer 槽里的
 * 投递挂到本结果上（`exec.deferContext`）→ 判据 B 成立时收束回合（`exec.concludeTurn`）。
 * @param agentCtx agent 作用域上下文 (`agent.ctx`)。
 * @param tools 会话工具集 (runtime.tools())。
 * @param onTool 工具调用留痕 (决策栏补记)。
 * @param visible 工具名过滤器 (缺省全部注册)。
 * @param channel 投递通道（会话运行时；缺省 = 不做 defer/收束，退回旧行为）。
 * @returns 释放函数 (注销本次注册的全部工具; 档位切换时先释放再重挂)。
 */
export function attachMudTools(
  agentCtx: Context,
  tools: MudTools,
  onTool?: (name: string, args: Record<string, unknown>) => void,
  visible?: (name: string) => boolean,
  channel?: MudDeliveryChannel,
): () => void {
  const disposers: (() => void)[] = []
  for (const tool of Object.values(tools)) {
    if (visible !== undefined && !visible(tool.name)) continue
    disposers.push(agentCtx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: tool.output.schema, render: tool.output.render },
      execute: async (args, exec) => {
        // 调用留痕必须在执行前: 决策日志要反映因果序 (执行期间的 [工具]/[发送]/[流程] 结算
        // 都先于"调用"落日志会倒挂, 实测踩过)。执行抛错时该次调用同样要留痕。
        onTool?.(tool.name, args as Record<string, unknown>)
        // 官方的回合取消信号转发给在途窗口: 回合取消时在途等待优雅结算, 不干等超时 (§2.1)。
        // 投递通道接线（§19.6.2）：defer / 收束判据都在这一个 helper 里（两条路径共用）。
        const result = await runWithDeliveryChannel({
          ...(channel === undefined ? {} : { channel }),
          callId: String(exec.callId ?? ''),
          exec,
          run: async () => await tool.execute(args as Record<string, unknown>, { signal: exec.signal }),
        })
        return result
      },
    })))
  }
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}