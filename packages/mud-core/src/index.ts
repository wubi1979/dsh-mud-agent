/**
 * dsh-mud-agent — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (官方路径对齐):
 *   - **创建用户 = 创建会话**: 页面走官方 `sessions.create` / `sessions.open`,
 *     host 不创建会话、不创建 agent; 页面只需在创建后 `POST /mud/bind` 声明
 *     "该官方会话是一个 MUD 账号会话"。
 *   - **回复用户 = 回复会话**: 游戏输出按会话投递 —
 *     `ctx.agents.get(sessionId)` 只读解析 live agent → `agent.followup(...)`。
 *     会话没有 live agent 时批次留在该会话观察窗, 待官方 `agent/created` 冲刷。
 *   - **切换用户 = 切换会话**: 会话即身份。所有 host 入口 (HTTP 路由、WS 帧、
 *     工具执行) 都带 sessionId; 运行时不持有任何跨会话可变状态。
 *   - **网络连接只接入消息**: MudConnectionManager 只认 host/port, 不认识会话;
 *     绑定方向是唯一的 会话 → 连接 (`runtime.connectionId`)。
 *
 * 消息流 (V10 行级化; 见 `doc/ARCHITECTURE.md` §3–§7):
 *   文本块 (telnet `parsed`) → L1 行级感知引擎 (每会话一实例, 多行状态持久)
 *     → state 折叠落库 + 带动作命中入队 + 消费边界
 *     → L2 投递节拍 (结算点: GA/EOR 边界 / 静默窗 / 行数上限)
 *        有命中 → 原文投递消息 (原文 + 动作, lane=t1); 无命中 → 批次 (lane=t2)
 *     → 该会话 agent.followup(mud-owned 消息) → 官方 loop
 *     → agent/request (agent 作用域 + prepend): 仅 lane=t1 拦截为 mud-t1
 *     → L4 T1 hit 渲染器按 turnRef 取命中队列 → 工具调用 (mud_*)
 *     → sendAndAwait 挂起 → 应答帧结算 (B 桥) → tool result 续步
 *
 * 单面 (web face) 架构: 本包是统一 host 引擎, 唯一外壳为浏览器 WebUI
 *   (mud-webui)。终端/日志/决策帧走独立 `/mud/ws` 高吞吐通道 (条目自带
 *   sessionId, 前端按会话过滤); 借官方 `webServer.register` /
 *   `webServer.registerUpgrade` 承载, 不改官方源码。
 * @module @deepseek-ai/dsh-mud-core
 */

import { MudConnectionManager } from './runtime/connection.ts'
import {
  DEFAULT_T2_DELIVER_INTERVAL_MS, MudSessionRuntime,
  type MudDecisionRecord, type MudRuntimeConfig, type MudRuntimeSink, type MudUiItemInput,
} from './runtime/session-runtime.ts'
import { SkillService } from './agent/skills.ts'
import { commandsIndexForAgent } from './config/commands.ts'
import defaultPerceptionRules from './config/trigger-rules.ts'
import { flowCommands, defaultFlows } from './config/flows.ts'
import {
  attachMudPersona, attachMudPrompt, attachMudTools, installOwnedLaneRouting,
  registerTriggerProvider, type TriggerProvider,
} from './agent/agent-bridge.ts'
import { installMudToolGate } from './agent/tool-gate.ts'
import type { ActivityEntry } from './agent/tools.ts'
import { DEFAULT_DANGEROUS_COMMANDS, type DangerousRule } from './config/commands.ts'
import { registerMudCapability, resolveMudTier, type MudCapabilityApi } from './permission/capability.ts'
import { visibleTools, MUD_TIER_NAMES, mudTierNote, type MudTier } from './permission/tiers.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { MudLogService, purgeSessionLogs, resolveLogDir } from './logging/log-service.ts'
import { MudWebSocketHub, isTrustedRequest } from './network/ws.ts'
import { resolveCaptchaImage } from './network/captcha.ts'
import type { MudGameItem, MudUiItem, MudWorldSnapshot } from './client/wire.ts'
import type {
  MudAgentKit, MudConnectOptions, MudConnectionStatus, MudCoreService, MudDiag,
} from './service.ts'

/** 插件名。 */
export const name = 'mud-core'

/** 必需服务: agents 注册表 (只读解析会话的 live agent — 不创建/不 dispose)。 */
export const inject = ['agents']

/** 进程级 UI 条目归属 (启动/关闭等与具体会话无关的记录)。 */
const GLOBAL_SESSION = ''

export type { MudWorldSnapshot }
export type {
  MudConnectOptions,
  MudConnectionStatus,
  MudCoreService,
  MudDiag,
  MudGameEntry,
  MudGameRead,
} from './service.ts'

// 会话事件契约: 宿主消费会话内命令 (外壳命令走 HTTP /mud/command, 带 sessionId)。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 客户端 → host 命令通道 (绕过 agent, 直发该会话的游戏连接)。 */
    'mud/command': { cmd: string }
  }
}

/** MUD 核心部署配置 (cordis.yml 行 config; 默认值在 bundle patch, 账户在 profile patch)。 */
export interface MudAgentConfig {
  host?: string
  port?: number
  account?: { name?: string; pass?: string }
  /** 缺省会话 id (路由未给 sessionId 且尚无活动会话时的回落)。 */
  sessionId?: string
  /** 缺省工作目录 (仅决定日志目录默认位置)。 */
  cwd?: string
  /** 运行日志落盘目录 (JSONL; 缺省 `<cwd>/mud-logs`)。 */
  logDir?: string
  /** 是否把游戏输出投递给会话 agent (false = 暂停接入: 输出直推终端)。 */
  agentEnabled?: boolean
  persona?: string
  commandIntervalMs?: number
  /** 命令-应答桥: 未声明请求超时 (缺省 10s)。 */
  bridgeTimeoutMs?: number
  /** 命令-应答桥: 声明 (until) 请求超时 (缺省 120s)。 */
  bridgeDeclaredTimeoutMs?: number
  /** 命令-应答桥/观察窗静默窗毫秒 (缺省 2s)。 */
  bridgeSilenceMs?: number
  /** 登录超时 (登录看门狗整体预算, 缺省 90s)。 */
  loginTimeoutMs?: number
  /** 断流阈值: 该时长无感知事件 → 唤醒 agent 主动决策 (缺省 30s; 仅已登录且已连接)。 */
  deadAirMs?: number
  /** holdDelivery 暂缓投递的兜底释放时长 (缺省 3s)。 */
  holdTimeoutMs?: number
  /**
   * 相邻两次 agent 工具调用的最小间隔毫秒 (缺省 1000; 0 = 不限速)。
   * T2 决策速度远快于服务端处理时用它压节奏; **T1 通道与登录/人工环节不受限速**。
   */
  toolCallIntervalMs?: number
  /**
   * **T2 投递**最小间隔毫秒 (缺省 2000; 0 = 不限流)。
   *
   * 与 `toolCallIntervalMs` 分工：后者压"每次工具调用"，这里压"给真实模型喂输入的节奏"
   * （每次 T2 行动都要先收到一条投递）。实测登录后 T2 会 1 秒一条地刷查询；这一层同时把
   * 多个小批次合并成大批次。**只压 T2 批次**：T1 动作、帧内动作投递、控制消息都不受影响。
   */
  t2DeliverIntervalMs?: number
  /** 新 MUD 会话的权限档位缺省值 (`observe`/`operate`/`full`; 缺省 `operate`)。 */
  defaultTier?: string
  /** 危险命令策略表覆盖 (缺省 `DEFAULT_DANGEROUS_COMMANDS`; 整体替换, 不合并)。 */
  dangerousCommands?: readonly DangerousRule[]
  /**
   * 登录收尾命令序列 (缺省 `['', 'look']`): 登录完成后发一次, 退出服务端 MXP 探测
   * (不顶一下的话输出要等约 5 分钟)。属登录流程, 走 actor `system`。
   */
  loginExitCommands?: readonly string[]
  /** 活动表 (§8 慢命令完成句; 缺省 `DEFAULT_ACTIVITY_TABLE`; 整体替换)。 */
  activityTable?: readonly ActivityEntry[]
  /** fullme 验证码地址的探测正则源串 (缺省 `DEFAULT_CAPTCHA_PATTERNS`; 整体替换)。 */
  captchaPatterns?: readonly string[]
  /**
   * 官方 agent preset id (`doc/ARCHITECTURE.md` §9)。非空 = **preset 装配路径**:
   * MUD 会话在首个回合前由 `ctx.agentPresets.select(agent, '<id>')` 切到该 preset
   * (能力面由 preset 行提供, 见 `src/preset-agent.ts`), 宿主只保留策略面 (选路/权限
   * 闸门)。缺省空串 = **宿主侧装配** (回退门; preset 未就绪或部署未配置时使用)。
   */
  agentPreset?: string
}

/** 默认 MUD 玩家 agent 人设 (config.persona 可覆盖); 技能目录单独注入。 */
function buildPersona(): string {
  return [
    '你是北大侠客行 (pkuxkx) MUD 游戏的玩家。你会持续收到游戏输出, 需要像真人玩家一样决定下一步动作。',
    '游戏输出每次到达就是一次\'游戏提问\': 分析当前局面, 用工具发送合理的游戏命令。',
    '可用工具: mud_move(移动), mud_look(查看房间/目标), mud_status(查询状态), mud_send(兜底原始命令, 如 ask <npc> about <话题>)。优先使用专用工具。',
    '规则: 优先保证存活; 探索时留意房间出口; 有明确目标时持续推进; 避免无意义的重复动作。',
    '如果局面不需要动作, 不调用工具, 等待下一次游戏输出。',
  ].join('\n')
}

/** 读取并解析请求 JSON body (上限 64KB; 空 body 视为空对象)。
 *  强制 `content-type: application/json`: 让 `/mud/*` POST 对浏览器成为
 *  "非简单请求"(触发 CORS 预检), 拒绝 text/plain 伪装的简单请求。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json(?:;|$)/i.test(contentType.trim())) {
      reject(new Error('content-type must be application/json'))
      return
    }
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (data === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(data)
        resolve(typeof parsed === 'object' && parsed !== null
          ? parsed as Record<string, unknown>
          : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** 插件主体。 */
export function apply(ctx: Context, config: MudAgentConfig = {}): void {
  // ── 日志/审计漏斗 ───────────────────────────────────────
  const mudLogger = ctx.logger('mud')
  const decisionLogger = ctx.logger('mud-decision')
  const logDir = resolveLogDir(config.logDir, join(config.cwd ?? process.cwd(), 'mud-logs'))
  // 每会话一个 LogService (文件 mud-YYYYMMDD-<sessionId>.log; seq 亦按会话).
  const logServices = new Map<string, MudLogService>()
  // ── 全局 WS 缓冲 (会话无关通道; 每条条目自带 sessionId) ──
  const GAME_BUFFER_MAX = 2000
  const UI_BUFFER_MAX = 2000
  let gameSeq = 0
  let uiTailSeq = 0
  const gameBuffer: MudGameItem[] = []
  const uiBuffer: MudUiItem[] = []
  let hub: MudWebSocketHub | null = null
  let lastError: string | null = null
  /** 最近一次 connect/bind 的会话 (路由未显式给 sessionId 时的回落)。 */
  let lastActiveSessionId: string | null = null
  // 验证码刷新映射: 图片URL → robot.php URL (供前端刷新按钮重新获取图片)。
  const robotUrlMap = new Map<string, string>()

  /** 追加一条游戏输出 (终端通道; 原始文本, 不进会话日志)。 */
  function pushGame(sessionId: string, text: string): void {
    gameSeq += 1
    const item: MudGameItem = { seq: gameSeq, sessionId, text, time: Date.now() }
    gameBuffer.push(item)
    if (gameBuffer.length > GAME_BUFFER_MAX) gameBuffer.shift()
    hub?.pushGame([item])
  }

  /** 追加一条 UI 条目 (日志/决策/验证码; 条目自带 sessionId)。 */
  function pushUi(sessionId: string, input: MudUiItemInput): void {
    uiTailSeq += 1
    const entry: MudUiItem = { ...input, sessionId, seq: uiTailSeq }
    uiBuffer.push(entry)
    if (uiBuffer.length > UI_BUFFER_MAX) uiBuffer.shift()
    hub?.pushUi([entry])
  }

  /** 会话日志服务 (lazily; 日志条目同时转发 WS 日志 tab)。 */
  function logServiceOf(sessionId: string): MudLogService {
    let service = logServices.get(sessionId)
    if (service !== undefined) return service
    service = new MudLogService({
      logDir,
      sessionId,
      onEntry: (e) => {
        pushUi(sessionId, {
          kind: 'log',
          level: e.level,
          channel: e.channel,
          text: e.text,
          time: e.time,
          logSeq: e.seq,
          ...(e.actor !== undefined ? { actor: e.actor } : {}),
          ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
          ...(e.eventType !== undefined ? { eventType: e.eventType } : {}),
          ...(e.flow !== undefined ? { flow: e.flow } : {}),
          ...(e.action !== undefined ? { action: e.action } : {}),
          ...(e.result !== undefined ? { result: e.result } : {}),
        })
      },
    })
    logServices.set(sessionId, service)
    return service
  }

  /** 运行日志 (harness 审计 + 落盘 + WS)。 */
  function tuiLog(sessionId: string, text: string): void {
    mudLogger.info(text)
    if (sessionId === GLOBAL_SESSION) return
    logServiceOf(sessionId).info('runtime', text)
  }

  /** 决策记录 (WebUI 决策栏 + 日志 tab + harness 审计)。 */
  function tuiDecision(sessionId: string, d: MudDecisionRecord): void {
    const line = `${d.text}${d.result ? ` — ${d.result}` : ''}`
    if (sessionId === GLOBAL_SESSION) {
      decisionLogger.info(line, { ...d })
      pushUi(sessionId, { kind: 'decision', ...d, time: Date.now() })
      return
    }
    const entry = logServiceOf(sessionId).info('decision', line, { ...d })
    pushUi(sessionId, { kind: 'decision', ...d, time: entry.time, logSeq: entry.seq })
    decisionLogger.info(line, { ...d })
  }

  // ── 传输层 (会话无关) + 会话运行时表 ─────────────────────
  const connections = new MudConnectionManager()
  const runtimes = new Map<string, MudSessionRuntime>()
  /** 已装配 (提示区段/工具/选路) 的 agent 实例; agent 重建即新实例, 需重新装配。 */
  const attachedAgents = new WeakSet<Agent>()
  /** T1 provider (llm 就绪后装配; 释放随插件生命周期)。 */
  let provider: TriggerProvider | null = null
  const stateRules = defaultPerceptionRules.filter(r => r.lane === 'state')
  const eventRules = defaultPerceptionRules.filter(r => r.lane !== 'state')
  /** 声明 holdDelivery 的规则 (投递原子性: 捕获未完成时暂缓窗口投递)。 */
  const holdRuleIds: ReadonlySet<string> = new Set(
    defaultPerceptionRules.filter(r => r.holdDelivery === true).map(r => r.id),
  )
  const skillService = new SkillService()

  /** 只读解析某会话当前 live agent (官方注册表; 缺失/已释放 = undefined)。 */
  function agentOf(sessionId: string): Agent | undefined {
    try {
      return ctx.agents.get(sessionId as SessionId)
    } catch {
      return undefined
    }
  }

  /** 运行时共享配置 (单实例: agent 接入开关等动态项对所有会话即时生效)。 */
  const runtimeConfig: MudRuntimeConfig = {
    agentEnabled: config.agentEnabled ?? false,
    commandIntervalMs: config.commandIntervalMs ?? 400,
    bridgeTimeoutMs: config.bridgeTimeoutMs ?? 10_000,
    bridgeDeclaredTimeoutMs: config.bridgeDeclaredTimeoutMs ?? 120_000,
    bridgeSilenceMs: config.bridgeSilenceMs ?? 2_000,
    loginTimeoutMs: config.loginTimeoutMs ?? 90_000,
    deadAirMs: config.deadAirMs ?? 30_000,
    holdTimeoutMs: config.holdTimeoutMs ?? 3_000,
    toolCallIntervalMs: config.toolCallIntervalMs ?? 1_000,
    // T2 投递限流（作者定案 2026-09-13）: 压"给真实模型喂输入"的节奏（T1 通道不受影响）。
    t2DeliverIntervalMs: config.t2DeliverIntervalMs ?? DEFAULT_T2_DELIVER_INTERVAL_MS,
    persona: config.persona !== undefined && config.persona !== '' ? config.persona : buildPersona(),
    skillsText: () => skillService.textForAgent(),
    // 系统提示里只放命令**索引** (70+ 条语法按需用 mud_help 取; 见 commandsIndexForAgent)。
    commands: commandsIndexForAgent(),
    defaultHost: config.host ?? 'mud.pkuxkx.net',
    defaultPort: Number(config.port ?? 8081),
    ...(config.dangerousCommands === undefined ? {} : { dangerous: config.dangerousCommands }),
    ...(config.activityTable === undefined ? {} : { activityTable: config.activityTable }),
    ...(config.captchaPatterns === undefined ? {} : { captchaPatterns: config.captchaPatterns }),
    // 流程表 (v0.4.0 §19)：登录等确定性流程的步骤图；只读声明。
    flows: defaultFlows,
  }

  // ── 官方 preset 装配路径 (§9): 非空即启用, 空串回落宿主侧装配 ──
  const mudPresetId = config.agentPreset?.trim() ?? ''
  /**
   * 装配就绪的会话 (preset 挂载成功 **或** 回落宿主侧装配完成)。
   *
   * 就绪门必须看这个标志而不是实时问 `composedPreset`: preset 挂载失败时我们会回落宿主侧
   * 装配, 此时 composition 仍是 `standard` —— 若仍按"composition ≠ mud-player"判未就绪,
   * 待决行会被永久留在观察窗 (实测: 登录文本一直不投递, 直到登录看门狗把 agent 唤醒)。
   */
  const capabilityReady = new Set<string>()

  /** 该 agent 的官方 composition 是否已是 MUD preset (官方判据; 无服务/无 preset → 就绪)。 */
  function presetComposed(agent: Agent): boolean {
    if (mudPresetId === '') return true
    try {
      return ctx.get('agentPresets')?.composedPreset(agent.ctx) === mudPresetId
    } catch {
      return false
    }
  }

  /** 标记装配就绪并冲刷该会话的待决行 (就绪门的唯一放行点)。 */
  function markCapabilityReady(sessionId: string): void {
    capabilityReady.add(sessionId)
    runtimes.get(sessionId)?.onAgentReady()
  }

  /**
   * preset 装配的前置条件 (服务缺失时给出说明, 供日志归因)。
   * @returns 缺失说明, 或 undefined (前置条件满足)。
   */
  function presetUnavailable(): string | undefined {
    if (ctx.get('agentPresets') === undefined) {
      return 'agentPresets 服务未装配 (profile 未加载 @deepseek-ai/dsh-agent-presets)'
    }
    return undefined
  }

  /**
   * 把该 agent 切到 MUD preset (官方 `agentPresets.select`; 仅空白会话可切)。
   * 失败时回落宿主侧装配并留痕 (不静默: 能力缺失必须吵, I9)。
   * @param agent 目标 agent。
   * @param sessionId 会话 id。
   * @param runtime 该会话运行时。
   */
  async function installPresetCapability(agent: Agent, sessionId: string, runtime: MudSessionRuntime): Promise<void> {
    if (mudPresetId === '' || presetComposed(agent)) {
      markCapabilityReady(sessionId)
      return
    }
    const unavailableReason = presetUnavailable()
    if (unavailableReason !== undefined) {
      tuiLog(sessionId, `[装配] preset ${mudPresetId} 不可用 (${unavailableReason}), 回落宿主侧装配`)
      mountHostCapability(agent, sessionId, runtime)
      markCapabilityReady(sessionId)
      return
    }
    try {
      await ctx.get('agentPresets')?.select(agent, mudPresetId)
      tuiLog(sessionId, `[装配] 官方 preset 已装配 (${mudPresetId})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      tuiLog(sessionId, `[装配] preset ${mudPresetId} 装配失败 (${message}), 回落宿主侧装配`)
      mountHostCapability(agent, sessionId, runtime)
    }
    markCapabilityReady(sessionId)
  }

  // ── 权限档位 (每会话持久事实; §10) ───────────────────────
  const dangerousCommands: readonly DangerousRule[] = config.dangerousCommands ?? DEFAULT_DANGEROUS_COMMANDS
  /**
   * 系统流程命令集 (权限判据; §10/§19): **流程表声明的命令** + `fullme:*` 规则声明的命令。
   * 这些是登录/人工验证流程发出的命令, 不受档位可见性约束 (危险命令硬边界照旧)。
   */
  const loginCommands: ReadonlySet<string> = new Set([
    ...flowCommands(defaultFlows),
    ...defaultPerceptionRules
      .filter(rule => rule.id.startsWith('fullme:') && rule.action?.tool?.name === 'mud_send')
      .flatMap((rule) => {
        const args = rule.action?.tool?.args as { cmd?: unknown; cmds?: unknown } | undefined
        const single = typeof args?.cmd === 'string' ? [args.cmd] : []
        const series = Array.isArray(args?.cmds) ? args.cmds.filter((c): c is string => typeof c === 'string') : []
        return [...single, ...series]
      }),
  ])
  const capability: MudCapabilityApi = registerMudCapability(ctx, {
    defaultTier: resolveMudTier(config.defaultTier, 'operate'),
    log: (text) => { tuiLog(GLOBAL_SESSION, text) },
  })

  /**
   * preset 线的装配数据源 (§9): 官方 preset 在组装期只注册一次工具/提示, 执行期
   * 按调用方 agent 解析到具体会话 —— 这里就是那个"按会话解析"的入口。
   */
  const agentKit: MudAgentKit = {
    prompt: {
      persona: runtimeConfig.persona,
      skillsText: () => skillService.textForAgent(),
      commands: runtimeConfig.commands,
    },
    tools: (sessionId) => (sessionId === undefined ? undefined : runtimes.get(sessionId)?.tools()),
    // 投递通道（§19.6.2）：preset 路径的工具包装器据此做 defer / 收束（漏接则 defer 失效）。
    channel: (sessionId) => (sessionId === undefined ? undefined : runtimes.get(sessionId)),
    tierNote: (sessionId) => {
      if (sessionId === undefined || !runtimes.has(sessionId)) {
        return '当前权限档位: 未知 (该会话尚未声明 MUD 绑定)。'
      }
      return mudTierNote(capability.current(sessionId))
    },
    noteToolCall: (sessionId, name, args) => {
      if (sessionId === undefined) return
      const argsJson = JSON.stringify(args)
      tuiDecision(sessionId, {
        actor: 'agent',
        action: `${name} ${argsJson}`,
        text: `[agent] 调用 ${name} ${argsJson}`,
      })
    },
  }

  const sink: MudRuntimeSink = {
    agentOf: (sessionId) => agentOf(sessionId),
    // preset 模式下"agent 存在"不等于"可以投递": 官方 composition 就绪前投递会跑在
    // 旧组装上并让会话永久锁定。就绪判定看 `capabilityReady` 标志 —— preset 挂载成功
    // 与"回落宿主侧装配"都会置位 (见其声明处的说明)。
    agentReady: (sessionId) => mudPresetId === '' || capabilityReady.has(sessionId),
    // 人工验证码 (fullme): 运行时只报告"检测到提示 + 地址", 取图与推送到页面由宿主做
    // (出站围栏在 resolveCaptchaImage 里; 页面用它已有的验证码对话框收人工输入)。
    captcha: (sessionId, robotUrl) => {
      void resolveCaptchaImage(robotUrl).then((imageUrl) => {
        robotUrlMap.set(imageUrl, robotUrl)
        tuiLog(sessionId, `[验证码] 已取到图片: ${imageUrl} (等人工输入)`)
        pushUi(sessionId, {
          kind: 'captcha',
          text: 'fullme 验证码',
          url: imageUrl,
          cmd: 'fullme',
          time: Date.now(),
        })
      }).catch((err: unknown) => {
        tuiLog(sessionId,
          `[验证码] 取图失败: ${err instanceof Error ? err.message : String(err)} — 请人工在游戏页查看验证码`)
      })
    },
    pushGame: (sessionId, text) => { pushGame(sessionId, text) },
    pushUi: (sessionId, item) => { pushUi(sessionId, item) },
    pushWorld: (sessionId, world) => { hub?.broadcastWorld(world, sessionId) },
    log: (sessionId, text) => { tuiLog(sessionId, text) },
    debug: (sessionId, channel, text) => {
      if (sessionId === GLOBAL_SESSION) return
      logServiceOf(sessionId).debug(channel, text)
    },
    decision: (sessionId, record) => { tuiDecision(sessionId, record) },
  }

  /** 默认会话 id (路由未显式给 sessionId 时使用)。 */
  function resolveSessionId(sessionId?: string): string {
    const explicit = sessionId?.trim()
    if (explicit !== undefined && explicit !== '') return explicit
    return lastActiveSessionId ?? config.sessionId ?? 'mud-player'
  }

  /**
   * 声明/取得某会话的 MUD 运行时 (不建连接、不建 agent): "该官方会话是 MUD
   * 账号会话"。已 live 的官方 agent 立即装配 (工具/提示区段/选路)。
   */
  function ensureRuntime(sessionId: string): MudSessionRuntime {
    let runtime = runtimes.get(sessionId)
    if (runtime !== undefined) return runtime
    runtime = new MudSessionRuntime(
      sessionId,
      runtimeConfig,
      sink,
      connections,
      { stateRules, eventRules, holdRuleIds },
    )
    runtimes.set(sessionId, runtime)
    lastActiveSessionId = sessionId
    // 档位: 该会话第一次被声明为 MUD 会话时落一次缺省记录 (持久事实; §10)。
    capability.ensure(sessionId)
    const agent = agentOf(sessionId)
    if (agent !== undefined) attachToAgent(agent)
    return runtime
  }

  /**
   * 把该会话的**策略面**装配到 agent: 选路 + 权限闸门 + **人设槽覆盖**。
   *
   * 策略留在宿主 (§9): 选路要 lane 状态与投递回合, 权限闸门要会话运行时的登录/档位
   * 状态 —— 都属于"会话运行时", 不是预设能声明的静态能力。能力面 (工具/提示) 则由
   * preset 行或 `mountHostCapability` 提供, 二者互斥。
   *
   * 人设 (`attachMudPersona`) 也在这里、两条路径共有: 它写的是**官方人设槽**
   * (`deployment:persona-prefix`), 目的是让 MUD 会话不再带着部署/standard preset 的
   * "编码 agent" 人设 —— 而 preset 作用域里同名注册会与 standard 的 `persona` 行冲突,
   * 只有 agent 作用域能覆盖 (见 `attachMudPersona` 的说明)。
   */
  function attachPolicy(agent: Agent, sessionId: string, runtime: MudSessionRuntime): void {
    attachMudPersona(agent.ctx, () => runtime.promptSections().persona)
    installOwnedLaneRouting(agent, {
      isMudSession: (id) => runtimes.has(id),
      log: (text) => { tuiLog(sessionId, text) },
    })
    installMudToolGate(agent.ctx, {
      sessionId,
      agent,
      mudTools: new Set(Object.keys(runtime.tools())),
      tier: () => capability.current(sessionId),
      dangerous: () => dangerousCommands,
      loginFlow: () => runtime.isSystemFlow(),
      loginCommands,
      toolCallIntervalMs: runtimeConfig.toolCallIntervalMs,
      log: (text) => { tuiLog(sessionId, text) },
    })
  }

  /**
   * 宿主侧**能力面**装配 (preset 关闭或 preset 装配失败时的路径, §9 回退门):
   * 工具按当前档位注册 (可见性层), 提示区段含按档求值的 `mud-tier`; 档位切换时重挂。
   */
  function mountHostCapability(agent: Agent, sessionId: string, runtime: MudSessionRuntime): void {
    const prompts = runtime.promptSections()
    attachMudPrompt(agent.ctx, {
      skillsText: prompts.skillsText,
      commands: prompts.commands,
      tierText: () => mudTierNote(capability.current(sessionId)),
    })
    const tools = runtime.tools()
    let disposeTools = mountToolsForTier(agent, sessionId, runtime)
    const offTier = capability.onChange((changed, tier) => {
      if (changed !== sessionId) return
      tuiLog(sessionId, `[权限] 重挂工具可见性 (档位 ${tier})`)
      disposeTools()
      disposeTools = mountToolsForTier(agent, sessionId, runtime)
    })
    agent.ctx.effect(() => () => {
      offTier()
      disposeTools()
    })
    tuiLog(sessionId, `[装配] 宿主侧能力面就绪 (${Object.keys(tools).length} 个工具, 档位 ${capability.current(sessionId)})`)
  }

  /**
   * 把会话装配到该 agent (幂等 per agent 实例)。
   *
   * 路径选择 (配置 `agentPreset`):
   *   - 非空 → 官方 preset 装配: 异步 `agentPresets.select` (仅空白会话可切), 能力面由
   *     preset 行提供, 装配落地后才 `onAgentReady()` 冲刷待决行 —— 保证第一批输出不会
   *     跑在旧组装上; 失败则回落宿主侧装配并留痕。
   *   - 空串 → 宿主侧装配 (回退门): 工具按档注册 + 提示区段。
   * 两条路径都装同一套策略面 (选路 + 权限闸门)。
   */
  function attachToAgent(agent: Agent): void {
    const sessionId = String(agent.id)
    const runtime = runtimes.get(sessionId)
    if (runtime === undefined) return
    if (attachedAgents.has(agent)) return
    attachedAgents.add(agent)
    // 新 agent 实例 = 装配重新开始: 先撤掉就绪标志, 装配落地后再置位 (否则待决行会在
    // 装配完成前被投递, 跑到旧组装上并永久锁定 preset)。
    capabilityReady.delete(sessionId)
    attachPolicy(agent, sessionId, runtime)
    tuiLog(sessionId, `[SYS] 会话 agent 已接入 (${sessionId}, 档位 ${capability.current(sessionId)}, ` +
      `${mudPresetId === '' ? '宿主侧装配' : `preset ${mudPresetId}`})`)
    if (mudPresetId === '') {
      mountHostCapability(agent, sessionId, runtime)
      markCapabilityReady(sessionId)
      return
    }
    void installPresetCapability(agent, sessionId, runtime)
  }

  /** 按当前档位注册该会话工具 (返回释放函数)。 */
  function mountToolsForTier(agent: Agent, sessionId: string, runtime: MudSessionRuntime): () => void {
    const visible = new Set(visibleTools(capability.current(sessionId)))
    // 第 5 个参数 = **投递通道**（§19.6.2）：包装器据此做"工具在途 ⇒ defer / 收束判据"。
    return attachMudTools(agent.ctx, runtime.tools(), (name, args) => {
      const argsJson = JSON.stringify(args)
      tuiDecision(sessionId, {
        actor: 'agent',
        action: `${name} ${argsJson}`,
        text: `[agent] 调用 ${name} ${argsJson}`,
      })
    }, name => visible.has(name), runtime)
  }

  /**
   * 注销一个会话 (删除用户): 停连接 + 释放运行时 + 删日志文件 + 清全局缓冲。
   *
   * 官方会话侧走**归档** (`IWorkspaces.archiveSession`, 页面在删除时调用 —
   * 官方没有删除会话, 归档即隐藏); 这里清的是**插件拥有的痕迹**: 该身份不应
   * 再能被读回 (日志文件按 sessionId 落盘且按 sessionId 恢复, 不删的话同名
   * 重建/按旧 id 补登记的会话会把上一个身份的日志原样读出来)。
   * 已装配的旧 agent 实例 (若该官方会话仍 live) 无需解绑: 运行时已不在表里,
   * 选路不再把它当 MUD 会话, 工具经 isConnected 快速拒发 (未连接)。
   * @param sessionId 官方会话 id。
   * @returns `ok` = 已执行注销; `files` = 删除的日志文件数。
   */
  function purgeSession(sessionId: string): { ok: boolean; files: number } {
    const target = sessionId.trim()
    if (target === '') return { ok: false, files: 0 }
    const runtime = runtimes.get(target)
    runtime?.dispose()
    runtimes.delete(target)
    capabilityReady.delete(target)
    logServices.get(target)?.purge()
    logServices.delete(target)
    const files = purgeSessionLogs(logDir, target)
    // 全局缓冲按 sessionId 过滤: WS 回放不再吐出已注销身份的内容。
    for (let i = gameBuffer.length - 1; i >= 0; i -= 1) {
      if (gameBuffer[i]?.sessionId === target) gameBuffer.splice(i, 1)
    }
    for (let i = uiBuffer.length - 1; i >= 0; i -= 1) {
      if (uiBuffer[i]?.sessionId === target) uiBuffer.splice(i, 1)
    }
    if (lastActiveSessionId === target) lastActiveSessionId = null
    tuiLog(GLOBAL_SESSION, `[SYS] 会话已注销 (${target}): 运行时${runtime === undefined ? '本不存在' : '已释放'}, 日志文件删除 ${files} 个`)
    return { ok: true, files }
  }

  // ── T1 provider (mud-t1) 装配: 官方 llm 扩展点 ───────────
  ctx.inject(['llm'], (llmCtx) => {
    provider = registerTriggerProvider(llmCtx, {
      // T1 是**无状态动作渲染器** (v0.4.0 §7): 渲染依据是投递消息自带的动作请求,
      // 不再回查运行时的命中队列 (I15)。
      log: (text) => { tuiLog(lastActiveSessionId ?? GLOBAL_SESSION, text) },
    })
    tuiLog(GLOBAL_SESSION, `[触发] T1 provider (mud-t1) 装配就绪 (state ${stateRules.length} / event ${eventRules.length})`)
    return () => {
      provider?.dispose()
      provider = null
    }
  })

  // ── 官方 agent 生命周期观察: 只读装配, 不创建/不 dispose ──
  ctx.on('agent/created', ({ agent }) => { attachToAgent(agent) })

  // 回合/步错误此前在本插件日志里完全不可见 (裁决/失败都发生在官方 loop 内),
  // 会表现成"判类之后什么都没有"。把 MUD 会话的 agent 错误落到该会话日志 tab。
  ctx.on('agent/error', (payload) => {
    const sessionId = String(payload.agent.id)
    if (!runtimes.has(sessionId)) return
    const message = payload.error instanceof Error ? payload.error.message : String(payload.error)
    tuiLog(sessionId, `[agent] 回合错误 turn=${payload.turn} step=${payload.step}: ${message}`)
  })

  // 投递批次被丢弃 (官方 cancel 默认清空待处理 inbox; keepInbox 才保留):
  // 之前这类丢弃完全静默, 表现成"判类投递之后就没了" — 落一条日志便于定位。
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const sessionId = String(agent.id)
    if (!runtimes.has(sessionId)) return
    const line = message.content.find(block => block.type === 'text')
    const preview = line !== undefined && line.type === 'text' ? line.text.slice(0, 40) : ''
    tuiLog(sessionId, `[agent] 待处理投递被丢弃 (回合取消): ${preview}…`)
  })

  // ── 会话内命令事件 (mud/command): 只投给该会话的游戏连接 ──
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'mud/command') return
    const cmd = event.data?.cmd
    if (typeof cmd !== 'string' || cmd.trim() === '') return
    runtimes.get(session.id)?.sendCommand(cmd.trim(), 'user')
  })

  // ── 启动 ───────────────────────────────────────────────
  tuiLog(GLOBAL_SESSION, '[SYS] 启动中 — 等待页面创建/打开会话并声明 MUD 绑定')
  tuiDecision(GLOBAL_SESSION, {
    actor: 'router',
    eventType: 'init',
    action: `感知引擎就绪 (${defaultPerceptionRules.length} 条感知规则, ${runtimeConfig.agentEnabled ? 'agent 接入' : '暂停接入'})`,
    text: '[初始化] 感知引擎就绪',
  })

  // ── ctx.mud 服务 (host API; WebUI 壳经 HTTP 路由 + /mud/ws 消费) ──
  const service: MudCoreService = {
    ruleCounts: () => ({ state: stateRules.length, event: eventRules.length, hold: holdRuleIds.size }),
    skill: skillService,
    capability,
    agentKit(): MudAgentKit {
      return agentKit
    },
    bind(sessionId: string): void {
      const existed = runtimes.has(sessionId)
      ensureRuntime(sessionId)
      // 只在首次声明时记一行 (bind 会被 open/connect/captcha 等路径重复调用,
      // 每次都记会把同一件事刷成三行, 淹掉真正的状态变化)。
      if (!existed) tuiLog(sessionId, `[SYS] MUD 会话已绑定 (${sessionId})`)
    },
    purge(sessionId: string): { ok: boolean; files: number } {
      return purgeSession(sessionId)
    },
    connect(options: MudConnectOptions = {}): void {
      const sessionId = resolveSessionId(options.sessionId)
      const runtime = ensureRuntime(sessionId)
      // 账户来源: connect 选项优先, 回落部署配置 config.account (profile patch 的
      // 部署值路径 — 规则里的 {name}/{pass} 与命令回显署名都用它)。
      const name = typeof options.name === 'string' && options.name.trim() !== ''
        ? options.name.trim()
        : (config.account?.name?.trim() ?? '')
      const pass = typeof options.pass === 'string' ? options.pass : (config.account?.pass ?? '')
      const account = name !== '' ? { name, pass } : undefined
      runtime.connect(options.host, options.port, account)
    },
    disconnect(sessionId?: string): void {
      const target = sessionId?.trim()
      if (target !== undefined && target !== '') {
        runtimes.get(target)?.disconnect()
        return
      }
      if (lastActiveSessionId !== null) runtimes.get(lastActiveSessionId)?.disconnect()
    },
    status(sessionId?: string): MudConnectionStatus {
      const target = resolveSessionId(sessionId)
      const runtime = runtimes.get(target)
      const runtimeStatus = runtime?.status()
      return {
        sessionId: runtimeStatus?.sessionId ?? target,
        connected: runtimeStatus?.connected ?? false,
        state: runtimeStatus?.state ?? 'idle',
        host: runtimeStatus?.host ?? runtimeConfig.defaultHost,
        port: runtimeStatus?.port ?? runtimeConfig.defaultPort,
        accountName: runtimeStatus?.accountName ?? null,
        agentEnabled: runtimeConfig.agentEnabled,
        agentReady: agentOf(target) !== undefined,
        tier: capability.current(target),
      }
    },
    statuses(): MudConnectionStatus[] {
      return [...runtimes.values()].map((runtime) => {
        const status = runtime.status()
        return {
          ...status,
          agentEnabled: runtimeConfig.agentEnabled,
          agentReady: agentOf(status.sessionId) !== undefined,
          tier: capability.current(status.sessionId),
        }
      })
    },
    diag(): MudDiag {
      const sessions = [...runtimes.values()].map(runtime => runtime.diag())
      return {
        lastError: lastError ?? sessions.find(s => s.lastError !== null)?.lastError ?? null,
        runtimes: sessions,
        liveSessions: (() => {
          try {
            const registry = ctx.get('sessions')
            return registry?.list?.().map((s: { id: string }) => s.id) ?? []
          } catch { return [] }
        })(),
      }
    },
    /** 手动命令 (WebUI/用户): 走该会话队列节流 + 'user' 归属。 */
    sendCommand(cmd: string, sessionId?: string): boolean {
      const target = resolveSessionId(sessionId)
      const runtime = runtimes.get(target)
      if (runtime === undefined) return false
      return runtime.sendCommand(cmd, 'user')
    },
    readGame(sinceSeq: number): { items: readonly MudGameItem[]; tailSeq: number } {
      const since = Number.isFinite(sinceSeq) ? sinceSeq : 0
      return { items: gameBuffer.filter(item => item.seq > since), tailSeq: gameSeq }
    },
    snapshot(sessionId?: string): MudWorldSnapshot | null {
      return runtimes.get(resolveSessionId(sessionId))?.snapshot() ?? null
    },
    setAgentEnabled(enabled: boolean): void {
      if (runtimeConfig.agentEnabled === enabled) return
      runtimeConfig.agentEnabled = enabled
      config.agentEnabled = enabled
      tuiDecision(GLOBAL_SESSION, {
        actor: 'router',
        eventType: 'agent-mode',
        action: enabled ? 'agent 接入开启' : 'agent 接入关闭',
        text: `[模式] ${enabled ? '开启' : '关闭'} agent 接入`,
      })
      // 开启后冲刷各会话门阻期滞留的观察窗批次。
      if (enabled) for (const runtime of runtimes.values()) runtime.onAgentReady()
    },
  }
  ctx.provide('mud', service)

  // ── 网络面: /mud/* HTTP 路由 + /mud/ws 通道 (webui 浏览器外壳) ──
  const webServer = ctx.get('webServer', false)
  const trustedHosts = (ctx.get('webRuntime' as never, false) as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []
  if (webServer !== undefined) {
    hub = new MudWebSocketHub({
      registerUpgrade: route => webServer.registerUpgrade(route),
      trustedHosts,
      backfill: (lastGameSeq, lastUiSeq) => ({
        // seq 失效保护: host 重启后 seq 归零, 客户端仍持旧大游标 → 按
        // `seq > last` 过滤会整批落空。游标大于当前尾号视为失效, 回绕全量回放。
        game: gameBuffer.filter(item => item.seq > (lastGameSeq > gameSeq ? 0 : lastGameSeq)),
        ui: uiBuffer.filter(item => item.seq > (lastUiSeq > uiTailSeq ? 0 : lastUiSeq)),
      }),
      onError: (err) => {
        try { ctx.logger.warn(err instanceof Error ? err : new Error(String(err))) } catch { /* ignore */ }
      },
    })
  }
  tuiLog(GLOBAL_SESSION, `[LOG] 日志系统就绪${logDir !== undefined ? `, 落盘: ${logDir}` : ''}`)

  const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // 统一信任围栏: 复用 ws 的 loopback/trustedHosts/Origin 判定包裹每个 /mud/* 路由。
  const createRoute = (webServer !== undefined)
    ? (route: {
      kind: string
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) => webServer.register({
      ...route,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!isTrustedRequest(req, trustedHosts)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        return route.handler(req, res)
      },
    })
    : null

  /** body → 会话 id (显式字段优先; 缺省回落 lastActive/config)。 */
  const sessionIdOf = (body: Record<string, unknown>): string =>
    resolveSessionId(typeof body.sessionId === 'string' ? body.sessionId : undefined)

  const disposeBindRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/bind',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = sessionIdOf(body)
          service.bind(sessionId)
          sendJson(res, 200, { ok: true, sessionId })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 绑定请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  const disposeConnectRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/connect',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = sessionIdOf(body)
          const host = typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : undefined
          const port = body.port === undefined ? undefined : Number(body.port)
          const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
          const pass = typeof body.pass === 'string' ? body.pass : undefined
          service.connect({
            sessionId,
            ...(host === undefined ? {} : { host }),
            ...(port === undefined || !Number.isFinite(port) ? {} : { port }),
            ...(name === undefined ? {} : { name }),
            ...(pass === undefined ? {} : { pass }),
          })
          sendJson(res, 200, { ok: true, sessionId })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 连接请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  const disposeDisconnectRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/disconnect',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          service.disconnect(sessionIdOf(body))
          sendJson(res, 200, { ok: true })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 断开请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  const disposeStatusRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/status',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const explicit = url.searchParams.get('sessionId')
        const status = service.status(explicit ?? undefined)
        sendJson(res, 200, { ok: true, ...status, sessions: service.statuses() })
      },
    })
    : undefined

  const disposeDiagRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/diag',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(res, 200, { ok: true, ...service.diag() })
      },
    })
    : undefined

  const disposeCommandRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/command',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = sessionIdOf(body)
          const cmds = Array.isArray(body.cmds)
            ? body.cmds.filter((c): c is string => typeof c === 'string').map(c => c.trim()).filter(c => c !== '')
            : null
          if (cmds !== null) {
            if (cmds.length === 0) {
              sendJson(res, 400, { ok: false, error: 'empty command' })
              return
            }
            let ok = true
            for (const c of cmds) ok = service.sendCommand(c, sessionId) && ok
            sendJson(res, 200, { ok, sessionId })
            return
          }
          const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
          if (cmd === '') {
            sendJson(res, 400, { ok: false, error: 'empty command' })
            return
          }
          const sent = service.sendCommand(cmd, sessionId)
          sendJson(res, 200, { ok: sent, sessionId })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 命令请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  const disposeCaptchaRefreshRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/captcha/refresh',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then(async (body) => {
          const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
          if (imageUrl === '') {
            sendJson(res, 400, { ok: false, error: 'missing imageUrl' })
            return
          }
          const robotUrl = robotUrlMap.get(imageUrl)
          if (robotUrl === undefined) {
            sendJson(res, 400, { ok: false, error: 'unknown captcha image' })
            return
          }
          robotUrlMap.delete(imageUrl)
          try {
            const newDisplayUrl = await resolveCaptchaImage(robotUrl)
            robotUrlMap.set(newDisplayUrl, robotUrl)
            const sessionId = sessionIdOf(body)
            tuiLog(sessionId, `[验证码] 刷新图片: ${newDisplayUrl}`)
            pushUi(sessionId, { kind: 'captcha', text: 'fullme 验证码', url: newDisplayUrl, cmd: 'fullme', time: Date.now() })
            sendJson(res, 200, { ok: true, url: newDisplayUrl })
          } catch (err) {
            tuiLog(GLOBAL_SESSION, `[验证码] 刷新失败: ${err instanceof Error ? err.message : String(err)}`)
            sendJson(res, 500, { ok: false, error: 'refresh failed' })
          }
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 验证码刷新请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // 当日日志恢复路由 (POST /mud/logs): 读取当日该会话 JSONL 文件 →
  // 前端挂载时拉历史, 与 ws 实时流按 logSeq 去重合并 (当日恢复, 隔天不恢复)。
  const disposeLogsRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/logs',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = sessionIdOf(body)
          const entries = logServiceOf(sessionId).readDayEntries(sessionId)
          sendJson(res, 200, { ok: true, sessionId, entries })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 日志恢复请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // 会话注销路由 (POST /mud/purge): 删除用户时调用 — 释放该会话运行时/连接,
  // 删除其全部日志文件, 重启后同名重建的用户读不到上一个身份的日志。
  const disposePurgeRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/purge',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'missing sessionId' })
            return
          }
          const result = service.purge(sessionId)
          sendJson(res, 200, { ok: result.ok, sessionId, files: result.files })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[SYS] 注销请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // 权限档位路由 (§10): GET 读选项与当前值 (页面档位选择器), POST 切换。
  // GET 的 sessionId 走 query (?sessionId=…), POST 走 body —— 与既有 /mud/status
  // /mud/command 的形状一致。
  const disposeCapabilityRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/capability',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = resolveSessionId(url.searchParams.get('sessionId') ?? undefined)
          sendJson(res, 200, {
            ok: true,
            sessionId,
            tier: capability.current(sessionId),
            capabilities: capability.capabilities(capability.current(sessionId)),
            options: capability.options(),
            defaultTier: capability.defaultTier,
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = sessionIdOf(body)
          const tier = typeof body.tier === 'string' ? body.tier.trim() : ''
          if (tier === '') {
            sendJson(res, 400, { ok: false, error: 'missing tier' })
            return
          }
          if (!MUD_TIER_NAMES.includes(tier as MudTier)) {
            sendJson(res, 400, { ok: false, error: `unknown tier "${tier}"` })
            return
          }
          const applied = capability.set(sessionId, tier)
          sendJson(res, 200, { ok: true, sessionId, tier: applied, capabilities: capability.capabilities(applied) })
        }).catch((err: unknown) => {
          tuiLog(GLOBAL_SESSION, `[权限] 档位请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // teardown
  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.dispose()
    runtimes.clear()
    connections.closeAll()
    if (hub) hub.dispose()
    if (disposeBindRoute) disposeBindRoute()
    if (disposeConnectRoute) disposeConnectRoute()
    if (disposeDisconnectRoute) disposeDisconnectRoute()
    if (disposeStatusRoute) disposeStatusRoute()
    if (disposeDiagRoute) disposeDiagRoute()
    if (disposeCommandRoute) disposeCommandRoute()
    if (disposeCaptchaRefreshRoute) disposeCaptchaRefreshRoute()
    if (disposeLogsRoute) disposeLogsRoute()
    if (disposePurgeRoute) disposePurgeRoute()
    if (disposeCapabilityRoute) disposeCapabilityRoute()
  }, 'mud-core: lifecycle')
}
