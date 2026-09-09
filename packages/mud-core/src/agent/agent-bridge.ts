/**
 * dsh-mud-core — DSH agent 集成 (重型处理器), host half.
 *
 * MUD agent 就是 DSH agent: 游戏输出作为 user 消息注入 agent 会话,
 * agent 的工具调用就是游戏命令。DSH 全套机制 (LLM 路由/重试、
 * 会话持久化/工具循环) 直接复用, 不再自造决策引擎。
 *
 * 瀑布路由 (T1 → T2, 官方机制, agent/用户无感):
 *   - T1 = 注册进 llm 注册表的本地模拟模型 (mud-t1): 规则命中的游戏输出
 *     由它确定性应答 (文本 + tool-call), tool-result 续步安静收束 —
 *     T1 独立完成整个 turn, 不需要任何模型收尾;
 *   - T2 = DSH 默认配置 (agentDefaultModel): T1 无应答 (finish{error,
 *     MUD_T1_NO_ANSWER}) 时 agent/request-error 瀑布返回 retry, 同步在
 *     agent/request 瀑布把路由改写为 T2 — 官方重试路径自然切换;
 *   - 回合归属: 本回合 T1 一旦失败即整体交 T2 (续步 sticky); 新回合
 *     (step 1) 一律重新给 T1 机会。无任何旁路缓存 — 路由只看回合内
 *     失败事实, 匹配输入只看当前请求自身的尾部消息。
 *
 * 行注册表: feedParsed 把 (整批文本 → 行对象) 内容寻址登记; T1 从
 * options.messages 提取尾部文本后按内容找回行对象 (行号/style 保真,
 * 多行状态机跨批连续)。无命中即 NO_ANSWER, 无陈旧窗口。
 * @module @deepseek-ai/dsh-mud-core/agent-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
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

// ── 行注册表 (内容寻址; T1 匹配输入的唯一来源) ──────────────
// key = agent 会话里 user 消息的精确文本 (feedParsed 的 textOfLines 产物);
// value = 同一批 MudLine[] (parser abs 单调, 多行状态机跨批连续)。
// 有界 FIFO: 重试同文本幂等命中; 文本未登记 (系统唤醒/历史回放) → miss。
const LINE_REGISTRY_MAX = 64
const gameLineRegistry = new Map<string, MudLine[]>()

/** 登记一批游戏输出 (发送方在 agent.send 前调用; 同文本覆盖为最新行对象)。 */
export function registerGameLines(text: string, lines: MudLine[]): void {
  const clean = text.trim()
  if (clean === '' || lines.length === 0) return
  gameLineRegistry.delete(clean)
  gameLineRegistry.set(clean, lines)
  if (gameLineRegistry.size > LINE_REGISTRY_MAX) {
    const oldest = gameLineRegistry.keys().next().value
    if (oldest !== undefined) gameLineRegistry.delete(oldest)
  }
}

/** 注册 T1 本地模拟 provider + 瀑布路由监听器 (幂等)。 */
export function registerTriggerProvider(ctx: Context, opts: {
  stateRules: PerceptionRule[]
  eventRules: PerceptionRule[]
  world: WorldModel
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
    resolveLines: (text: string) => gameLineRegistry.get(text) ?? null,
    onLog: (text: string) => opts.log?.(text),
    onRender: (entry) => {
      opts.log?.(`[t1] 命中 ${entry.hit.id}: ${entry.action.output.slice(0, 60)}`)
    },
    // 登录规则 args 的 {name}/{pass} → 会话凭据 (与会话绑定; 无凭据原样下发)。
    resolveToolArgs: (args, sessionId) => interpolateCredentials(args, getSessionCredentials(sessionId)),
  })
  const disposeAdapter = ctx.llm.registerAdapter([T1_PROVIDER], adapter)

  // ── 瀑布路由状态 (回合内失败事实; 单 agent 串行, 无并发) ──
  // t1FailedKeys: 本回合 T1 无答案的 "turn:step" 集合。非空 = T2 已接管本回合。
  // 新回合 (turn 变化或 agent 重建) 即清空 — 每个新回合重新给 T1 机会。
  let routedAgent: unknown = null
  let routedTurn = -1
  const t1FailedKeys = new Set<string>()

  /** T2 路线 (DSH 默认配置 agentDefaultModel); null = 未配置。 */
  const t2Selection = (): { provider: string; model: string } | null =>
    ctx.get('agentDefaultModel')?.currentSelection() ?? null

  // agent/request 瀑布: 逐步改写路由。
  //   - 本回合 T1 曾失败 → T2 (含同步重试的收尾);
  //   - 其余 (新回合首步 / T1-owned 续步) → T1。
  const disposeRequest = ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const config = await next()
    if (payload.agent !== routedAgent || payload.turn !== routedTurn) {
      routedAgent = payload.agent
      routedTurn = payload.turn
      t1FailedKeys.clear()
    }
    if (t1FailedKeys.size > 0) {
      const t2 = t2Selection()
      if (t2) return { ...config, provider: t2.provider, model: t2.model }
      opts.log?.('[t1] T2 未配置 (agentDefaultModel), 路由维持 T1')
      return config
    }
    return { ...config, provider: T1_PROVIDER, model: T1_MODEL }
  })

  // agent/request-error 瀑布: T1 任何失败 → retry 并标记回合交棒;
  // 其他 provider 失败原样放行 (llm-retry / loop 自行处理)。
  const disposeRequestError = ctx.on('agent/request-error', async (payload, next) => {
    if (payload.provider !== T1_PROVIDER) return next()
    const t2 = t2Selection()
    if (!t2) {
      opts.log?.('[t1] T2 未配置, T1 失败按原语义上抛')
      return next()
    }
    t1FailedKeys.add(`${payload.turn}:${payload.step}`)
    opts.log?.(`[t1] T1 失败 (${payload.failure.code}) → 重试并路由 T2 (${t2.provider}/${t2.model})`)
    return { kind: 'retry' }
  })

  t1Registration = () => {
    disposeAdapter()
    disposeRequest()
    disposeRequestError()
  }
}

/** 释放 T1 provider 注册与瀑布监听器 (llm 卸载时调用; 幂等)。 */
export function disposeTriggerProvider(): void {
  if (t1Registration) {
    try { t1Registration() } catch { /* ignore */ }
    t1Registration = null
  }
  stateMatchService = null
  eventMatchService = null
  gameLineRegistry.clear()
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
