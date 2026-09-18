/**
 * dsh-mud-core — MUD 玩家 agent 核心装配 (assemble), host face.
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
 * 消息流 (v0.9 W7.1 裁决器化; 见 `doc/ARCHITECTURE.md` §3–§8):
 *   文本块 (telnet `parsed`) / GA·EOR 边界 → 行流裁决器 SessionAdjudicator (唯一入口:
 *     行流缓冲 + 武装标记切帧 + 五站消费链, GA/EOR 八成 + 武装判据十成切帧, 内存阀兜底;
 *     300ms 静默降级为网络装配粒度, 非消费边界)
 *     → 帧提交消费链 (§8.2, 固定次序单遍): ① 状态折叠落库 → ② 规则触发 (动作/direct-exec)
 *       → ③ 事务结算 (B 桥, resolve 等待者) → ④ 流程判据 (唤醒/打断/排队) → ⑤ 投递视图
 *        有命中 → 原文投递消息 (原文 + 动作, lane=t1); 无命中 → 批次 (lane=t2)
 *     → 该会话 agent.followup(mud-owned 消息) → 官方 loop
 *     → agent/request (agent 作用域 + prepend): 仅 lane=t1 拦截为 mud-t1
 *     → L4 T1 动作渲染器按动作请求渲染 tool-call → 工具调用 (mud_*)
 *     → sendAndAwait 挂起 → 帧并集结算 (B 桥) → tool result 续步
 *
 * 单面 (web face) 架构: 本包是统一 host 引擎, 唯一外壳为浏览器 WebUI
 *   (mud-webui)。终端/日志/决策帧走独立 `/mud/ws` 高吞吐通道 (条目自带
 *   sessionId, 前端按会话过滤); 借官方 `webServer.register` /
 *   `webServer.registerUpgrade` 承载, 不改官方源码。
 * @module @deepseek-ai/dsh-mud-core/assemble
 */

import { MudConnectionManager } from './services/network/manager.ts'
import { MudSessionRuntime } from './runtime/session/session.ts'
import {
  DEFAULT_T2_DELIVER_INTERVAL_MS,
  type MudDecisionRecord,
  type MudRuntimeConfig,
  type MudRuntimeSink,
} from './runtime/session/types.ts'
import { SkillService } from './agents/skills.ts'
import type { ActivityEntry } from './agents/tools.ts'
import { commandsIndexForAgent } from './shared/commands.ts'
import defaultPerceptionRules from './perceive/rules.ts'
import { splitPerceptionRules } from './perceive/engine.ts'
import { flowCommands, defaultFlows } from './runtime/flow/flows/index.ts'
import {
  attachMudPersona, attachMudPrompt, attachMudTools,
} from './agents/mount.ts'
import {
  installOwnedLaneRouting, ownedLaneOf, presetLaneSelection, registerTriggerProvider,
  type TriggerProvider,
} from './agents/lane.ts'
import { installMudToolGate } from './services/gate/tool-gate.ts'
import { buildGateRules } from './services/gate/rules.ts'
import type { DangerousRule } from './shared/commands.ts'
import { registerMudCapability, resolveMudTier, type MudCapabilityApi } from './services/gate/capability.ts'
import { visibleTools, mudTierNote } from './services/gate/tiers.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { MudLogService, purgeSessionLogs, resolveLogDir } from './services/log/log-service.ts'
import { MudFeedHub } from './shell/streams.ts'
import { GlobalBuffers } from './shell/global-buffers.ts'
import { MudRemoteService, SessionView } from './shell/mud-remote-service.ts'
import type { MudGameItem, MudWorldSnapshot } from './shell/remote-types.ts'
import type {
  MudAgentKit, MudConnectOptions, MudConnectionStatus, MudCoreService, MudDiag,
} from './service.ts'

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
  /** agent 接入模式 (`off`/`t1`/`t2`/`full`; 缺省 `t1`; §19)。 */
  agentMode?: 'off' | 't1' | 't2' | 'full'
  persona?: string
  commandIntervalMs?: number
  /** 命令-应答桥: 未声明请求超时 (缺省 10s)。 */
  bridgeTimeoutMs?: number
  /** 命令-应答桥: 声明 (until) 请求超时 (缺省 120s)。 */
  bridgeDeclaredTimeoutMs?: number
  /** 网络装配粒度毫秒 (缺省 2s; v0.6.0 静默窗降级为分帧器装配阀 autoFlushMs, 非消费边界 §8.7)。 */
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
  /**
   * 官方 agent preset id (`doc/ARCHITECTURE.md` §9)。非空 = **preset 装配路径**:
   * MUD 会话在首个回合前由 `ctx.agentPresets.select(agent, '<id>')` 切到该 preset
   * (能力面由 preset 行提供, 见 `src/agents/preset.ts`), 宿主只保留策略面 (选路/权限
   * 闸门)。缺省空串 = **宿主侧装配** (回退门; preset 未就绪或部署未配置时使用)。
   */
  agentPreset?: string
}

/** 进程级 UI 条目归属 (启动/关闭等与具体会话无关的记录)。 */
const GLOBAL_SESSION = ''

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

/** 装配 MUD 核心插件 (index.ts 的 apply 主体)。 */
export function createMudCore(ctx: Context, config: MudAgentConfig): void {
  // ── 日志/审计漏斗 ───────────────────────────────────────
  const mudLogger = ctx.logger('mud')
  const decisionLogger = ctx.logger('mud-decision')
  const logDir = resolveLogDir(config.logDir, join(config.cwd ?? process.cwd(), 'mud-logs'))
  // 每会话一个 LogService (文件 mud-YYYYMMDD-<sessionId>.log; seq 亦按会话).
  const logServices = new Map<string, MudLogService>()
  // ── 全局流缓冲 (会话无关通道; 每条条目自带 sessionId) + 活动会话视图 ──
  const buffers = new GlobalBuffers()
  const view = new SessionView(config.sessionId ?? 'mud-player')
  // 流扇出端 (game/ui/world 三条 remote 流的实时推送出口)。
  const feeds = new MudFeedHub()
  buffers.attachSink(feeds)
  let lastError: string | null = null
  // 验证码刷新映射: 图片URL → robot.php URL (供前端刷新按钮重新获取图片)。
  const robotUrlMap = new Map<string, string>()

  /** 会话日志服务 (lazily; 日志条目同时转发 WS 日志 tab)。 */
  function logServiceOf(sessionId: string): MudLogService {
    let service = logServices.get(sessionId)
    if (service !== undefined) return service
    service = new MudLogService({
      logDir,
      sessionId,
      onEntry: (e) => {
        buffers.pushUi(sessionId, {
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
      buffers.pushUi(sessionId, { kind: 'decision', ...d, time: Date.now() })
      return
    }
    const entry = logServiceOf(sessionId).info('decision', line, { ...d })
    buffers.pushUi(sessionId, { kind: 'decision', ...d, time: entry.time, logSeq: entry.seq })
    decisionLogger.info(line, { ...d })
  }

  // ── 传输层 (会话无关) + 会话运行时表 ─────────────────────
  const connections = new MudConnectionManager()
  const runtimes = new Map<string, MudSessionRuntime>()
  /** 已装配 (提示区段/工具/选路) 的 agent 实例; agent 重建即新实例, 需重新装配。 */
  const attachedAgents = new WeakSet<Agent>()
  /** T1 provider (llm 就绪后装配; 释放随插件生命周期)。 */
  let provider: TriggerProvider | null = null
  const { stateRules, eventRules, holdRuleIds } = splitPerceptionRules(defaultPerceptionRules)
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
    agentMode: config.agentMode ?? 't1',
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
    // 流程表 (v0.4.0 §19)：登录 + fullme 等确定性流程的步骤图；只读声明。
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
  /**
   * 门禁注入规则 (机制与知识分离, 见 services/gate/rules.ts): 从 `shared/commands`
   * 的危险表 (部署可整体替换 `config.dangerousCommands`) 与 `shared/game` 的命令
   * 派生器组装, 注入 policy/tool-gate —— 判定层不直接持有游戏知识。
   */
  const gateRules = buildGateRules(
    config.dangerousCommands !== undefined ? { dangerous: config.dangerousCommands } : undefined,
  )
  /**
   * 系统流程命令集 (权限判据; §10/§19): **流程表声明的命令**（登录 + fullme 的
   * `fullme`/`halt`/`fullme {captcha}`/`fullme 1`/`hpbrief`…）。
   * 这些是系统流程发出的命令, 不受档位可见性约束 (危险命令硬边界照旧)。
   */
  const loginCommands: ReadonlySet<string> = new Set([
    ...flowCommands(defaultFlows),
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
    // 确保解析 (官方惰性路径): 新会话在首条用户消息前 agent 不存在, 连接建立时的
    // "空回合翻 blank" 需要它。走官方 sessionController.resolveAgent (创建/恢复/
    // 去重并发), 不自行 ctx.agents.create。失败回落 undefined (观察窗冲刷路径照旧)。
    resolveAgent: async (sessionId) => {
      const live = agentOf(sessionId)
      if (live !== undefined) return live
      try {
        const sc = ctx.get('sessionController') as
          | { agents?: { resolveAgent?: (id: SessionId) => Promise<{ agent?: Agent; error?: unknown }> } }
          | undefined
        const resolver = sc?.agents?.resolveAgent
        if (resolver === undefined) return undefined
        const result = await resolver(sessionId as SessionId)
        return result.agent
      } catch {
        return undefined
      }
    },
    // 会话是否无内容 (官方 blank 判定同源): attached session.seq === 0 = 事件流为空。
    // 查不到会话 (registry 不可用/形状漂移) → false 保守不发, 旧观察窗路径仍能翻页。
    sessionEmpty: (sessionId) => {
      try {
        const registry = ctx.get('sessions') as
          | { get?: (id: SessionId) => { seq?: number } | undefined }
          | undefined
        const session = registry?.get?.(sessionId as SessionId)
        return session !== undefined && session.seq === 0
      } catch {
        return false
      }
    },
    // followup 前预写 lane selection: turn=1 step=1 无预热窗口 (官方 assemble 快照
    // current 在 pre-step 写入之前), T1 首回合必须投递前就位, 否则落到会话真实模型。
    preDeliver: (sessionId, message) => {
      const agent = agentOf(sessionId)
      if (agent !== undefined) presetLaneSelection(ctx, agent, ownedLaneOf(message))
    },
    // preset 模式下"agent 存在"不等于"可以投递": 官方 composition 就绪前投递会跑在
    // 旧组装上并让会话永久锁定。就绪判定看 `capabilityReady` 标志 —— preset 挂载成功
    // 与"回落宿主侧装配"都会置位 (见其声明处的说明)。
    agentReady: (sessionId) => mudPresetId === '' || capabilityReady.has(sessionId),
    // 人工验证码 (fullme): 解析（出站围栏 + 取图）在 `mud_captcha` 工具里（流程 `prompt` 步），
    // 运行时只把**解析好的图片**转给宿主推前台弹窗；`robotUrl` 供"刷新图片"路由用。
    captcha: (sessionId, push) => {
      robotUrlMap.set(push.imageUrl, push.robotUrl)
      tuiLog(sessionId, `[验证码] 已取到图片: ${push.imageUrl} (等人工输入)`)
      buffers.pushUi(sessionId, {
        kind: 'captcha',
        text: 'fullme 验证码',
        url: push.imageUrl,
        cmd: 'fullme',
        ...(push.note === undefined ? {} : { note: push.note }),
        time: Date.now(),
      })
    },
    pushGame: (sessionId, text) => { buffers.pushGame(sessionId, text) },
    pushUi: (sessionId, item) => { buffers.pushUi(sessionId, item) },
    pushWorld: (sessionId, world) => { feeds.pushWorld(sessionId, world) },
    log: (sessionId, text) => { tuiLog(sessionId, text) },
    debug: (sessionId, channel, text) => {
      if (sessionId === GLOBAL_SESSION) return
      logServiceOf(sessionId).debug(channel, text)
    },
    decision: (sessionId, record) => { tuiDecision(sessionId, record) },
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
    view.setActive(sessionId)
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
      ctx,
      isMudSession: (id) => runtimes.has(id),
      log: (text) => { tuiLog(sessionId, text) },
    })
    installMudToolGate(agent.ctx, {
      sessionId,
      agent,
      mudTools: new Set(Object.keys(runtime.tools())),
      tier: () => capability.current(sessionId),
      rules: gateRules,
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
    // 全局缓冲按 sessionId 过滤: 流回放不再吐出已注销身份的内容。
    buffers.purgeSession(target)
    // 流扇出端同款过滤: 订阅者在途条目也不再投递 (与上者配对,
    // 否则同 tick 内"回放不吐、实时漏一帧")。
    feeds.purgeSession(target)
    view.clearActive(target)
    tuiLog(GLOBAL_SESSION, `[SYS] 会话已注销 (${target}): 运行时${runtime === undefined ? '本不存在' : '已释放'}, 日志文件删除 ${files} 个`)
    return { ok: true, files }
  }

  // ── T1 provider (mud-t1) 装配: 官方 llm 扩展点 ───────────
  ctx.inject(['llm'], (llmCtx) => {
    provider = registerTriggerProvider(llmCtx, {
      // T1 是**无状态动作渲染器** (v0.4.0 §7): 渲染依据是投递消息自带的动作请求,
      // 不再回查运行时的命中队列 (I15)。
      log: (text) => { tuiLog(view.lastActive() ?? GLOBAL_SESSION, text) },
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
    action: `感知引擎就绪 (${defaultPerceptionRules.length} 条感知规则, agent 模式 ${runtimeConfig.agentMode})`,
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
      const sessionId = view.resolve(options.sessionId)
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
      const last = view.lastActive()
      if (last !== null) runtimes.get(last)?.disconnect()
    },
    status(sessionId?: string): MudConnectionStatus {
      const target = view.resolve(sessionId)
      const runtime = runtimes.get(target)
      const runtimeStatus = runtime?.status()
      return {
        sessionId: runtimeStatus?.sessionId ?? target,
        connected: runtimeStatus?.connected ?? false,
        state: runtimeStatus?.state ?? 'idle',
        host: runtimeStatus?.host ?? runtimeConfig.defaultHost,
        port: runtimeStatus?.port ?? runtimeConfig.defaultPort,
        accountName: runtimeStatus?.accountName ?? null,
        agentMode: runtimeConfig.agentMode,
        agentReady: agentOf(target) !== undefined,
        tier: capability.current(target),
      }
    },
    statuses(): MudConnectionStatus[] {
      return [...runtimes.values()].map((runtime) => {
        const status = runtime.status()
        return {
          ...status,
          agentMode: runtimeConfig.agentMode,
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
      const target = view.resolve(sessionId)
      const runtime = runtimes.get(target)
      if (runtime === undefined) return false
      return runtime.sendCommand(cmd, 'user')
    },
    /** 弹窗"中止" → ask-human 验证码等待当场失败 (fail-closed; 无挂起等待时空操作)。 */
    captchaAbort(sessionId?: string): void {
      runtimes.get(view.resolve(sessionId))?.cancelHumanWait()
    },
    readGame(sinceSeq: number): { items: readonly MudGameItem[]; tailSeq: number } {
      return buffers.readGame(sinceSeq)
    },
    snapshot(sessionId?: string): MudWorldSnapshot | null {
      return runtimes.get(view.resolve(sessionId))?.snapshot() ?? null
    },
    setAgentMode(mode: 'off' | 't1' | 't2' | 'full'): void {
      if (runtimeConfig.agentMode === mode) return
      runtimeConfig.agentMode = mode
      config.agentMode = mode
      const label: Record<typeof mode, string> = {
        off: '暂停接入',
        t1: '仅 T1 (确定性管道)',
        t2: '仅 T2 (真实 LLM)',
        full: '完整接入 (T1 + T2)',
      }
      tuiDecision(GLOBAL_SESSION, {
        actor: 'router',
        eventType: 'agent-mode',
        action: `agent 模式 → ${mode} (${label[mode]})`,
        text: `[模式] agent 接入 → ${mode}`,
      })
      // 非 off 模式冲刷各会话门阻期滞留的观察窗批次。
      if (mode !== 'off') for (const runtime of runtimes.values()) runtime.onAgentReady()
    },
  }
  ctx.provide('mud', service)

  // ── 网络面: typert Remote 命名空间 `mud` (官方网关围栏 + mux 流通道) ──
  // 生成器模式: gen:typert 产出严格 descriptor (zod 参数校验 + 客户端工件),
  // assemble 自持注册 (file:// 补丁行 loader 解析不到)。
  new MudRemoteService(ctx, {
    service,
    view,
    buffers,
    feeds,
    logServiceOf,
    pushUi: (sessionId, item) => { buffers.pushUi(sessionId, item) },
    tuiLog,
    robotUrlMap,
  })
  // 生成工件注册进 ctx.typert: loader 按包名解析发现不了 file:// 补丁行, 所以本插件
  // 自持注册; 运行环境无 typert 注册表或工件未生成 (先 build 后 gen) 时跳过。
  const typert = (ctx as unknown as { typert?: { register: (contribution: unknown) => () => void } }).typert
  if (typert !== undefined) {
    void import('@deepseek-ai/dsh-mud-core/typert').then(({ TYPERT }) => {
      const disposeTypert = typert.register(TYPERT)
      tuiLog(GLOBAL_SESSION, '[SYS] typert 工件已注册 (remote mud 命名空间就绪)')
      ctx.effect(() => () => disposeTypert(), 'mud-core: typert')
    }).catch((err: unknown) => {
      tuiLog(GLOBAL_SESSION, `[SYS] typert 工件注册失败 (先跑 gen:typert): ${err instanceof Error ? err.message : String(err)}`)
    })
  } else {
    tuiLog(GLOBAL_SESSION, '[SYS] 无 typert 注册表, remote 命名空间未注册')
  }
  tuiLog(GLOBAL_SESSION, `[LOG] 日志系统就绪${logDir !== undefined ? `, 落盘: ${logDir}` : ''}`)

  // teardown
  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.dispose()
    runtimes.clear()
    connections.closeAll()
    buffers.attachSink(null)
  }, 'mud-core: lifecycle')
}