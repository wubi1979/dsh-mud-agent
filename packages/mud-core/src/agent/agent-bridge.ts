/**
 * dsh-mud-core — DSH agent 集成 (重型处理器), host half.
 *
 * MUD agent 就是 DSH agent: 游戏输出作为 user 消息注入 agent 会话,
 * agent 的工具调用就是游戏命令。DSH 全套机制 (LLM 路由/重试、
 * 会话持久化/工具循环) 直接复用, 不再自造决策引擎。
 *
 * v6.2 单路径: 所有文本统一进 agent; agent 使用 mud-cascade 级联 provider:
 *   T1 (确定性): TriggerLlmAdapter 触发匹配 → 渲染动作 (文本 + tool-call);
 *   T2 (真实 LLM): 未命中时转发 agentDefaultModel 的真实 provider/model。
 *
 * v6.2 变更: 匹配服务拆分为 state/event 双实例，输入从纯文本改为 MudLine[]。
 *
 * v6.3 瀑布数组: 配置容器 = 本文件。级联 provider 改为阶段行走器, 按 stages
 *   逐级: trigger 级 (T1 确定性渲染) / 显式 model 级 (硬失败交棒) / 尾部默认级
 *   (DSH 默认配置 agentDefaultModel)。每次调用重读 getCascadeStages(), 无热拔插;
 *   默认瀑布即「T1 事件触发 + 尾部 DSH 默认」。mimicEnabled/realAllowed 已移除,
 *   由 stages 的 enabled 与数组内容统一表达。
 * @module @deepseek-ai/dsh-mud-core/agent-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TriggerLlmAdapter } from '../trigger-llm/adapter.ts'
import { TriggerMatchService } from '../trigger-llm/service.ts'
import type { CascadeStage, PerceptionRule, TriggerAction } from '../trigger-llm/types.ts'
import type { MudLine } from '../preprocess/ansi.ts'
import type { WorldModel } from '../world/world.ts'
import type { MudTools } from './tools.ts'

/** 级联 provider 标识 (agent 路由到此 provider → 阶段行走分支)。 */
export const CASCADE_PROVIDER = 'mud-cascade' as const

/** 级联 provider 注册句柄 (幂等: 重复调用不重新注册)。 */
let cascadeRegistration: (() => void) | null = null

/** 匹配服务实例 (由 registerCascadeProvider 创建; index.ts 访问做预匹配)。 */
export let stateMatchService: TriggerMatchService | null = null
export let eventMatchService: TriggerMatchService | null = null

/** 默认瀑布: T1 事件触发级 (尾部默认级为数组外隐式兜底 = DSH 默认配置)。 */
const DEFAULT_STAGES: readonly CascadeStage[] = [
  { id: 't1', kind: 'trigger', lane: 'event' },
]

/** 级联瀑布配置容器 (v6.3): 每次调用经 getCascadeStages() 重读, 无热拔插。 */
let cascadeStages: readonly CascadeStage[] = DEFAULT_STAGES

/** 替换级联瀑布 (改配置下次调用即生效; stages 内 enabled:false 级跳过)。 */
export function setCascadeStages(stages: readonly CascadeStage[]): void {
  cascadeStages = stages
}

/** 当前级联瀑布快照。 */
export function getCascadeStages(): readonly CascadeStage[] {
  return cascadeStages
}

/** 会话登录凭据 (与会话绑定: 用户即会话, 按 sessionId 存取; 登录规则 T1 插值用)。 */
export interface SessionCredentials {
  name: string
  pass: string
}

/** sessionId → 登录凭据 (连接时由装配方 setSessionCredentials 写入)。 */
const sessionCredentials = new Map<string, SessionCredentials>()

/** 写入某会话的登录凭据 (connect({name, pass}) 时调用; 切换用户互不泄漏)。 */
export function setSessionCredentials(sessionId: string, creds: SessionCredentials): void {
  if (sessionId === '' || creds === null || typeof creds !== 'object') return
  sessionCredentials.set(sessionId, { name: creds.name ?? '', pass: creds.pass ?? '' })
}

/** 读取某会话的登录凭据 (无凭据返回 undefined)。 */
export function getSessionCredentials(sessionId: string | undefined): SessionCredentials | undefined {
  return sessionId ? sessionCredentials.get(sessionId) : undefined
}

/** 工具参数插值: 用会话凭据替换 {name}/{pass} 占位符 (逐字符串值替换)。 */
export function interpolateCredentials<T extends Record<string, unknown>>(
  args: T,
  creds: SessionCredentials | undefined,
): Record<string, unknown> {
  if (!creds) return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string'
      ? value.replace(/\{name\}/g, creds.name).replace(/\{pass\}/g, creds.pass)
      : value
  }
  return out
}

/** 注册 mud-cascade 级联 provider (幂等)。 */
export function registerCascadeProvider(ctx: Context, opts: {
  stateRules: PerceptionRule[]
  eventRules: PerceptionRule[]
  world: WorldModel
  log?: (text: string) => void
}): void {
  if (cascadeRegistration) return // 幂等

  // 创建双实例
  stateMatchService = new TriggerMatchService(opts.stateRules, 'state')
  eventMatchService = new TriggerMatchService(opts.eventRules, 'event')

  const adapter = new TriggerLlmAdapter({
    matchLines: (lines: MudLine[]): readonly TriggerAction[] => {
      const hits = eventMatchService!.match(lines)
      const actions: TriggerAction[] = []
      for (const hit of hits) {
        if (hit.action) actions.push({ hit, action: hit.action })
      }
      return actions
    },
    getRecentLines: () => eventMatchService!.getRecentLines(),
    stages: () => cascadeStages,
    llm: ctx.llm,
    defaultSelection: () => ctx.get('agentDefaultModel')?.currentSelection() ?? null,
    onLog: (text: string) => opts.log?.(text),
    onRender: (entry) => {
      opts.log?.(`[cascade] T1 命中 ${entry.hit.id}: ${entry.action.output.slice(0, 60)}`)
    },
    // 登录规则 args 的 {name}/{pass} → 会话凭据 (与会话绑定; 无凭据原样下发)。
    resolveToolArgs: (args, sessionId) => interpolateCredentials(args, getSessionCredentials(sessionId)),
  })
  cascadeRegistration = ctx.llm.registerAdapter([CASCADE_PROVIDER], adapter)
}

/** 释放 mud-cascade 级联 provider 注册 (llm 卸载时调用; 幂等)。 */
export function disposeCascadeProvider(): void {
  if (cascadeRegistration) {
    try { cascadeRegistration() } catch { /* ignore */ }
    cascadeRegistration = null
  }
  stateMatchService = null
  eventMatchService = null
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
    agentOptions: { provider: CASCADE_PROVIDER, model: 'cascade-v1' },
    setup: async (agentCtx: Context) => {
      if (persona) {
        agentCtx.systemPrompt.section({
          name: 'mud-persona',
          order: -100,
          text: persona,
        })
      }
      if (skills) {
        agentCtx.systemPrompt.section({
          name: 'mud-skills',
          order: -50,
          text: skills,
        })
      }
      if (commands) {
        agentCtx.systemPrompt.section({
          name: 'mud-commands',
          order: -40,
          text: commands,
        })
      }
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
