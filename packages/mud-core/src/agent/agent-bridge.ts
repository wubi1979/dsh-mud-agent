/**
 * dsh-mud-core — DSH agent 集成 (重型处理器), host half.
 *
 * MUD agent 就是 DSH agent: 游戏输出作为 user 消息注入 agent 会话,
 * agent 的工具调用就是游戏命令。DSH 全套机制 (LLM 路由/重试、
 * 会话持久化/工具循环) 直接复用, 不再自造决策引擎。
 *
 * 所有权路由 (REFACTOR-V7 机制 A 的续步与选路, 取代旧瀑布):
 *   - 注入消息携带**所有权元数据** (source.kind='mud-owned', lane=t1|t2):
 *     feed 判类 (index.ts) 决定每批输出归谁; 工具结果/回放消息不带该元数据。
 *   - agent/request 监听器回扫会话 surface 最近一条 mud-owned user 消息
 *     (跳过 tool-result) → 选 provider: lane=t2 → T2 (agentDefaultModel),
 *     其余/T2 未配置 → T1 (本地模拟 mud-t1)。所有权随会话 surface 走,
 *     无回合粘性状态 — 新的带权注入天然覆盖旧 lane。
 *   - 无 agent/request-error 瀑布 (旧 t1FailedKeys 已删): T1 不应答不再是
 *     "失败交棒", 而是**自然收束** (回合结束, 等下一批输出重新判类注入)。
 *
 * 行恢复: feedParade 不再登记旁路行注册表 — T1 的解析经命令-应答桥
 * (CommandResponseController) 的统一行集表: 注入文本/工具结果 → resolveLines
 * 按内容还原 MudLine[] (行号/style 保真, 多行状态机跨批连续)。
 * @module @deepseek-ai/dsh-mud-core/agent-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TriggerLlmAdapter } from '../trigger-llm/adapter.ts'
import { TriggerMatchService } from '../trigger-llm/service.ts'
import type { PerceptionRule, TriggerAction } from '../trigger-llm/types.ts'
import type { MudLine } from '../preprocess/ansi.ts'
import type { WorldModel } from '../world/world.ts'
import type { MudTools } from './tools.ts'

/** T1 provider 标识 (本地模拟模型注册名; agent 默认路由)。 */
export const T1_PROVIDER = 'mud-t1' as const
/** T1 模型标识 (仅路由判别用; T1 无真实模型)。 */
export const T1_MODEL = 't1-local' as const

/** T1 适配器注册句柄 + 瀑布监听器句柄 (幂等: 重复调用不重新注册)。 */
let t1Registration: (() => void) | null = null

/** 匹配服务实例 (由 registerTriggerProvider 创建; index.ts 访问做预匹配)。 */
export let stateMatchService: TriggerMatchService | null = null
export let eventMatchService: TriggerMatchService | null = null

// ── 所有权元数据 (REFACTOR-V7 机制 A 的选路依据) ────────────────
// MessageSourceMap 是 merge-extensible 联合 (插件可增补 kind): 注入消息携带
// kind='mud-owned' + lane (t1|t2); tool-result 与旧式明文消息不带该元数据,
// 路由回扫时被跳过/归默认。所有权随会话 surface 走 — 无旁路状态。
export type OwnedLane = 't1' | 't2'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mud-owned': { kind: 'mud-owned'; lane: OwnedLane }
  }
}

/** 带所有权元数据的游戏输出 user 消息 (feed 判类后注入; 路由选 provider)。 */
export function ownedGameMessage(text: string, lane: OwnedLane) {
  return createUserMessage({
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'mud-owned', lane },
  })
}

/** 注册 T1 本地模拟 provider + 所有权路由监听器 (幂等)。 */
export function registerTriggerProvider(ctx: Context, opts: {
  stateRules: PerceptionRule[]
  eventRules: PerceptionRule[]
  world: WorldModel
  /** 行恢复: 按文本还原 MudLine[] (命令-应答桥统一行集表); 缺省 = 永不命中。 */
  resolveLines?: (text: string) => MudLine[] | null
  log?: (text: string) => void
}): void {
  if (t1Registration) return // 幂等

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
    resolveLines: opts.resolveLines ?? (() => null),
    onLog: (text: string) => opts.log?.(text),
    onRender: (entry) => {
      opts.log?.(`[t1] 命中 ${entry.hit.id}: ${entry.action.output.slice(0, 60)}`)
    },
    // 凭据: tool args 保留 {name}/{pass} 占位符原样渲染 (不落明文),
    // 插值由 mud_send.execute 在发送瞬间完成 (见 tools.ts)。
  })
  const disposeAdapter = ctx.llm.registerAdapter([T1_PROVIDER], adapter)

  /** T2 路线 (DSH 默认配置 agentDefaultModel); null = 未配置。 */
  const t2Selection = (): { provider: string; model: string } | null =>
    ctx.get('agentDefaultModel')?.currentSelection() ?? null

  /** 回扫会话 surface: 最近一条 mud-owned user 消息的 lane (跳过 tool-result
   *  与其余 kind)。工具结果续步/历史回放无元数据 → 沿用注入时的 lane —
   *  所有权随消息留在 surface, 无需旁路粘性状态。 */
  const ownedLaneFromSession = (sessionId: SessionId): 't1' | 't2' | null => {
    const job = ctx.get('sessions') as
      | { get(id: SessionId): { surface: { nodes: readonly unknown[] }; eventAt(seq: unknown): unknown } | undefined }
      | undefined
    const session = job?.get(sessionId)
    const surface = session?.surface
    if (!session || !surface) return null
    let scanned = 0
    for (let i = surface.nodes.length - 1; i >= 0 && scanned < 24; i -= 1) {
      scanned += 1
      const event = session.eventAt(surface.nodes[i])
      const message = event ? deriveEventMessage(event as never) : null
      if (!message || message.role !== 'user') continue
      const source = message.source as Partial<{ kind: string; lane: string }> | null | undefined
      if (source?.kind !== 'mud-owned') continue
      return source.lane === 't2' ? 't2' : 't1'
    }
    return null
  }

  // agent/request 瀑布: 回扫所有权元数据 → 选 provider。
  //   - lane=t2 且 T2 已配置 → T2; T2 未配置时降级 T1 (日志注明);
  //   - 其余 (含无元数据/工具续步) → T1。
  //   - 无 agent/request-error 交棒: T1 不应答 = 自然收束, 等新输出重新判类。
  const disposeRequest = ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const config = await next()
    const lane = ownedLaneFromSession(payload.agent.id)
    if (lane === 't2') {
      const t2 = t2Selection()
      if (t2) return { ...config, provider: t2.provider, model: t2.model }
      opts.log?.('[t1] T2-owned 输出但 T2 未配置 (agentDefaultModel) → 降级 T1')
    }
    return { ...config, provider: T1_PROVIDER, model: T1_MODEL }
  })

  t1Registration = () => {
    disposeAdapter()
    disposeRequest()
  }
}

/** 释放 T1 provider 注册与路由监听器 (llm 卸载时调用; 幂等)。 */
export function disposeTriggerProvider(): void {
  if (t1Registration) {
    try { t1Registration() } catch { /* ignore */ }
    t1Registration = null
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
    agentOptions: { provider: T1_PROVIDER, model: T1_MODEL },
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

/** 带所有权元数据的会话注入 (feed 判类后; 控制唤醒 lane=t2)。路由由
 *  agent/request 回扫 surface 决定 — 所有权随消息走, 无旁路状态。 */
export function sendOwnedOutput(handle: AgentHandle, text: string, lane: OwnedLane): void {
  handle.agent.send(ownedGameMessage(text, lane), 'next-turn', true)
}
