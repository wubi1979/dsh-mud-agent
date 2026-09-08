/**
 * dsh-mud-core — DSH agent 集成 (重型处理器), host half.
 *
 * MUD agent 就是 DSH agent: 游戏输出作为 user 消息注入 agent 会话,
 * agent 的工具调用就是游戏命令。DSH 全套机制 (LLM 路由/重试、
 * 会话持久化/工具循环) 直接复用, 不再自造决策引擎。
 *
 * v6 单路径: 所有文本统一进 agent; agent 使用 mud-cascade 级联 provider:
 *   T1 (确定性): TriggerLlmAdapter 触发匹配 → 渲染动作 (文本 + tool-call);
 *   T2 (真实 LLM): 未命中时转发 agentDefaultModel 的真实 provider/model。
 * @module @deepseek-ai/dsh-mud-core/agent-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TriggerService } from '../trigger-llm/service.ts'
import { TriggerLlmAdapter } from '../trigger-llm/adapter.ts'
import type { TriggerAction } from '../trigger-llm/types.ts'
import type { WorldModel } from '../world/world.ts'
import type { MudTools } from './tools.ts'

/** 级联 provider 标识 (agent 路由到此 provider → T1/T2 分支)。 */
export const CASCADE_PROVIDER = 'mud-cascade' as const

/** 级联 provider 注册句柄 (幂等: 重复调用不重新注册)。 */
let cascadeRegistration: (() => void) | null = null

/** 注册 mud-cascade 级联 provider (幂等)。 */
export function registerCascadeProvider(ctx: Context, opts: {
  trigger: TriggerService
  world: WorldModel
  mimicEnabled: () => boolean
  realAllowed: () => boolean
  log?: (text: string) => void
}): void {
  if (cascadeRegistration) return // 幂等
  const adapter = new TriggerLlmAdapter({
    matchLines: (text: string): readonly TriggerAction[] => {
      const hits = opts.trigger.matchText(text)
      const actions: TriggerAction[] = []
      for (const hit of hits) {
        if (hit.action) actions.push({ hit, action: hit.action })
      }
      return actions
    },
    mimicEnabled: opts.mimicEnabled,
    realAllowed: opts.realAllowed,
    forward: async function*(options) {
      const defaultModel = ctx.get('agentDefaultModel')
      const selection = defaultModel?.currentSelection()
      if (!selection) {
        opts.log?.('[cascade] T2 转发失败: 无 agentDefaultModel 选择')
        yield { type: 'finish', reason: { kind: 'stop' } as const }
        return
      }
      const prepared = await ctx.llm.prepareCall({
        provider: selection.provider,
        model: selection.model,
      })
      // 重建 options (deep-frozen 请求需 spread) 并替换为真实 provider/model。
      const rebuilt = { ...options, provider: selection.provider, model: selection.model }
      yield* prepared.stream(rebuilt)
    },
    onRender: (entry) => {
      opts.log?.(`[cascade] T1 命中 ${entry.hit.id}: ${entry.action.output.slice(0, 60)}`)
    },
  })
  cascadeRegistration = ctx.llm.registerAdapter([CASCADE_PROVIDER], adapter)
}

/** 释放 mud-cascade 级联 provider 注册 (llm 卸载时调用; 幂等)。 */
export function disposeCascadeProvider(): void {
  if (cascadeRegistration) {
    try { cascadeRegistration() } catch { /* ignore */ }
    cascadeRegistration = null
  }
}

/** 游戏输出 → user 消息 (DSH 消息规范: ContentBlock[])。 */
export function gameMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  })
}

/** createMudAgent 参数。 */
export interface CreateMudAgentOptions {
  /** 会话 id (持久化到 DSH 会话日志)。 */
  sessionId: string
  /** 会话工作目录 (决定会话归属的 workspace; 缺省 process.cwd())。 */
  cwd?: string
  /** 系统提示人设 (MUD 玩家)。 */
  persona: string
  /** 技能目录文本 (注入 systemPrompt 区段)。 */
  skills: string
  /** 命令参考文本 (注入 systemPrompt mud-commands 区段; 紧凑命令语法参考)。 */
  commands?: string
  /** 工具表 { name: defineTool 兼容定义 } — 规则与 agent 共用。 */
  tools: MudTools
  /** 活动回调 (日志)。 */
  onActivity?: (text: string) => void
  /**
   * agent 侧工具调用回调 (右栏决策补记)。只在 agent 的工具注册包装层触发,
   * 规则命中直接调 tool.execute 不经过这里 — 不会误记成 agent 动作。
   */
  onAgentTool?: (name: string, args: Record<string, unknown>) => void
}

/**
 * 创建 MUD 玩家 agent 会话 (重型处理器)。
 * 会话已持久化时恢复 (resume, 上下文连续), 否则新建 (create)。
 * @param ctx 宿主 ctx (提供 ctx.agents: DSH agent 注册表 + loop factory)。
 * @param opts 会话身份/人设/技能/工具。
 * @returns published handle { agent, dispose } — agent 可 send/唤醒;
 *   dispose 由宿主在 teardown 时调用。
 */
export async function createMudAgent(
  ctx: Context,
  { sessionId, cwd, persona, skills = '', commands = '', tools = {}, onActivity = () => {}, onAgentTool }: CreateMudAgentOptions,
): Promise<AgentHandle> {
  void onActivity
  const commonOptions = {
    // v6: agent 固定使用 mud-cascade 级联 provider; T1/T2 路由在 adapter 层处理,
    // 不再需要 installModelSelection (级联 adapter 自行读 agentDefaultModel 转发)。
    agentOptions: { provider: CASCADE_PROVIDER, model: 'cascade-v1' },
    setup: async (agentCtx: Context) => {
      // 人设: 系统提示区段 (最低 order, 最先)
      if (persona) {
        agentCtx.systemPrompt.section({
          name: 'mud-persona',
          order: -100,
          text: persona,
        })
      }
      // 技能目录: agent 可编排的流程能力 (描述 + 步骤序列)
      if (skills) {
        agentCtx.systemPrompt.section({
          name: 'mud-skills',
          order: -50,
          text: skills,
        })
      }
      // 命令参考: 常用命令语法 (紧凑, 一行一条) — 让 agent 用 mud_send 拼对
      if (commands) {
        agentCtx.systemPrompt.section({
          name: 'mud-commands',
          order: -40,
          text: commands,
        })
      }
      // 工具: 注册宿主提供的工具集 (规则与 agent 同一条执行路径)
      for (const tool of Object.values(tools)) {
        agentCtx.tools.register(defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: {
            schema: tool.output.schema,
            render: tool.output.render,
          },
          execute: async (args) => {
            const result = await tool.execute(args as Record<string, unknown>)
            onAgentTool?.(tool.name, args as Record<string, unknown>)
            return result
          },
        }))
      }
    },
  }
  // 会话已持久化 → resume (加载历史上下文); 否则 create (全新会话)。
  // 注意: 会话由「创建用户」时的 prepareAgent 预建; connect 不再创建会话,
  // 只用已 materialize 的 live session (MUD UI 数据自交付二起走 /mud/ws,
  // 不再写 session)。
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    try {
      const headers = (await persistence.list()) as readonly { id: string }[]
      if (headers.some(h => h.id === sessionId)) {
        return ctx.agents.resume({
          resumeSessionId: sessionId as SessionId,
          ...commonOptions,
        })
      }
    } catch {
      // list 失败视为无持久化会话, 走 create
    }
  }
  return ctx.agents.create({
    sessionId: sessionId as SessionId,
    meta: { cwd: cwd ?? process.cwd() },
    ...commonOptions,
  })
}

/** 游戏输出注入 agent 会话并唤醒循环 (next-turn)。handle = { agent, dispose }。 */
export function sendGameOutput(handle: AgentHandle, text: string): void {
  handle.agent.send(gameMessage(text), 'next-turn', true)
}
