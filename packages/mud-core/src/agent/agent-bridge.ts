/**
 * dsh-mud-core — DSH agent 集成 (重型处理器), host half.
 *
 * MUD agent 就是 DSH agent: 游戏输出作为 user 消息注入 agent 会话,
 * agent 的工具调用就是游戏命令。DSH 全套机制 (LLM 路由/重试、
 * 会话持久化/工具循环) 直接复用, 不再自造决策引擎。
 *
 * 决策路由: 规则系统 (轻量处理器, 确定性) 先于 agent; 未命中才路由到 agent
 * (重型处理器)。两者共用同一工具集 (tools 由宿主传入)。
 * @module @deepseek-ai/dsh-mud-core/agent-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installModelSelection, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MudTools } from './tools.ts'

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
  // 默认模型选择 (agent-default-model 服务, dsh-base 提供; 缺失时 agent 无路由)
  const defaultModel = ctx.get('agentDefaultModel')
  const selection = defaultModel ? defaultModel.currentSelection() : undefined
  const commonOptions = {
    agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
    setup: async (agentCtx: Context) => {
      // 模型路由: 挂载会话级模型选择 (对齐 dsh-headless)
      if (selection) {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      }
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
