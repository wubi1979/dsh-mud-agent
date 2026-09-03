/**
 * dsh-mud-core — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (对齐 agent 规范):
 *   - 游戏内容就是提问内容: 游戏输出本该全部注入 agent, agent 用工具/skill 回答。
 *   - 工具/skill 属于 agent: 正常流程是 agent 思考 → 决定用哪个 skill → 调用工具。
 *   - 规则 = agent 的自动执行代理: 对"答案确定"的消息 (登录提示、战斗开始…),
 *     规则在注入 agent 之前拦截, 直接替 agent 调用工具, 不让 agent 再思考;
 *     执行进展反馈给 agent (上下文连续, 登录完成后随首批输出注入)。
 *
 * 消息流:
 *   游戏输出 → 感知 (world 同步 + 语义事件)
 *     → 规则拦截 (答案确定?) → 替 agent 调用工具 → 进展记录 (loginLog)
 *     → 未拦截 → 注入 agent → agent 思考 → 调用同一组工具
 *   → 工具 → 游戏
 *
 * 降级 (cascade): 登录规则链超时 (20s 未登录) → 把登录上下文注入 agent,
 *   agent 按 skills 区段中的 login skill 步骤手动完成。
 *
 * 双面 (dual-face) 架构 — 本包是统一 host 引擎, 服务两种外壳:
 *   - 进程内面 (node 外壳, 如 mud-tui / headless): `ctx.mud` 服务 +
 *     session 自定义事件 (mud/decision, mud/log, mud/world) — 官方进程内外壳
 *     模式 (对齐 bundle/headless: 服务 + ctx.on('session/event'))。
 *   - 网络面 (浏览器外壳, 如 mud-webui): 游戏文本是一次性状态流 (不落会话, 避免
 *     会话无限增长), 走独立 /mud/ws 高吞吐通道 + /mud/* HTTP 路由; 借官方
 *     webServer.registerUpgrade 传载体 (复用 Host/Origin 信任围栏 + 心跳思路),
 *     不改官方源码。
 * @module @deepseek-ai/dsh-mud-core
 */

import { TelnetClient } from './net/telnet.ts'
import type { ParsedLine } from './net/ansi.ts'
import {
  PerceptionBuffer, PerceptionDriver, MAX_PENDING_LINES,
} from './perception/perception.ts'
import { TriggerService } from './perception/triggers.ts'
import { StateService } from './world/state.ts'
import type { MudPerceptEvent } from './events.ts'
import { Transcript, INJECT_IDLE_MS, TRANSCRIPT_MIN_LINES } from './perception/transcript.ts'
import {
  createWorld, applyPatch, worldSnapshot, flattenWorld, type WorldModel,
} from './world/world.ts'
import { CommandQueue, renderTemplate } from './agent/execution.ts'
import { buildMudTools, type MudTools } from './agent/tools.ts'
import { FlowService, FlowRuntime, type FlowHost } from './agent/flow.ts'
import defaultFlows from './config/flows.ts'
import { DecisionCenter } from './agent/dispatcher.ts'
import defaultPerceptionRules from './config/trigger-rules.ts'
import defaultDecisionRules from './config/decision-rules.ts'
import { SkillService } from './agent/skills.ts'
import { commandsTextForAgent } from './config/commands.ts'
import { makeSystemEvent, type MudSystemEvent } from './events.ts'
import { createMudAgent, sendGameOutput, type CreateMudAgentOptions } from './agent/agent-bridge.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  MudCaptchaEvent, MudDecisionEvent, MudLogEvent, MudWorldEvent, MudWorldSnapshot,
} from './shell-bridge.ts'
import { MudWebSocketHub, type MudUiItem } from './net/ws.ts'
import { resolveCaptchaImage } from './net/captcha.ts'
import type {
  MudConnectOptions, MudConnectionStatus, MudCoreService, MudDiag, MudGameRead,
} from './service.ts'

/** 插件名。 */
export const name = 'mud-core'

/** 必需服务: agents 注册表 (dsh-agent-loop 提供 factory)。 */
export const inject = ['agents']

/** 断流阈值: 30s 无感知事件 → 唤醒 agent 主动决策。 */
const DEAD_AIR_MS = 30_000

export type { MudWorldSnapshot }
export type {
  MudConnectOptions,
  MudConnectionStatus,
  MudCoreService,
  MudDiag,
  MudGameEntry,
  MudGameRead,
} from './service.ts'

/** MUD 核心部署配置 (cordis.yml 行 config; 默认值在 bundle patch, 账户在 profile patch)。 */
export interface MudAgentConfig {
  host?: string
  port?: number
  account?: { name?: string; pass?: string }
  sessionId?: string
  /** 会话工作目录 (决定会话在 WebUI 列表归属的 workspace; 缺省启动目录)。 */
  cwd?: string
  /** 是否把游戏输出注入 agent 思考 (false = 暂停接入: 输出直推终端, agent 不介入)。 */
  agentEnabled?: boolean
  persona?: string
  commandIntervalMs?: number
  ruleDedupMs?: number
  loginTimeoutMs?: number
}

/** 默认 MUD 玩家 agent 人设 (config.persona 可覆盖); 技能目录单独注入 (mud-skills 区段)。 */
function buildPersona(): string {
  return [
    '你是北大侠客行 (pkuxkx) MUD 游戏的玩家。你会持续收到游戏输出, 需要像真人玩家一样决定下一步动作。',
    '游戏输出每次到达就是一次\'游戏提问\': 分析当前局面, 用工具发送合理的游戏命令。',
    '可用工具: mud_move(移动), mud_look(查看房间/目标), mud_status(查询状态), mud_send(兜底原始命令, 如 ask <npc> about <话题>)。优先使用专用工具。',
    '规则: 优先保证存活; 探索时留意房间出口; 有明确目标时持续推进; 避免无意义的重复动作。',
    '如果局面不需要动作, 不调用工具, 等待下一次游戏输出。',
  ].join('\n')
}

/** 读取并解析请求 JSON body (上限 64KB; 空 body 视为空对象)。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
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
  const SID = 'console'
  const connections = new Map<string, { client: TelnetClient; state: string; host: string; port: number }>()
  // 当前连接账户 (WebUI 侧栏按用户连接时设置; 规则渲染登录命令用)。
  let activeAccount: { name: string; pass: string } | null = null
  const world: WorldModel = createWorld()
  let agent: AgentHandle | null = null
  // 当前 agent 的会话 id (用户即会话: 切换用户 → 重建 agent, 各自历史恢复)。
  let activeSessionId: string | null = null
  // ── 登录流程进展记录 ──────────────────────────────────────────
  let loginLog: string[] = [] // 登录期间流程自动执行的进展 (登录完成后反馈给 agent)
  let deadAirTimer: ReturnType<typeof setTimeout> | null = null // 断流 30s → 唤醒 agent
  let worldTimer: ReturnType<typeof setTimeout> | null = null // world 快照推送节流
  // 注入节流: agent 忙时合并游戏输出 (状态流, 中间桶过期), 空闲后注入最新
  let agentBusy = false
  let pendingInjection = ''
  // ── 注入录制器 (agent 输入侧; 30s 时间窗 + 折叠视图, 见 src/perception/transcript.ts) ──
  let injector: Transcript | null = null
  let injectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false // teardown 已开始, 停止新的注入/泵出
  // 诊断: 最近一次 connect/ensureAgent 失败 (不依赖 agent 会话, 供 diag() 读取)。
  let lastError: string | null = null
  // ── 系统日志通道 (提前声明供全 apply 内 tuiLog/tuiDecision 引用, 避免 TDZ) ──
  // mud: 普通运行流水 → 日志窗 (exporter 转发); mud-decision: 决策留档, 只落盘。
  const mudLogger = ctx.logger('mud')
  const decisionLogger = ctx.logger('mud-decision')
  // mud 命名空间日志 → 转发到 webui/tui 日志窗 (纯传输, 不改内容)。
  // 提前注册: 让 apply 装配早期的启动日志也能投递到日志窗。
  ctx.logger.exporter({
    export: (message) => {
      if (message.name !== 'mud') return
      pushUiItem({ kind: 'log', text: `[${message.type.toUpperCase()}] ${renderLogArgs(message.args)}`, time: message.ts })
    },
  })
  /** 把日志 args (printf 格式串 + 参数) 渲染为纯文本 (转发用, 不改内容)。 */
  function renderLogArgs(args: readonly unknown[]): string {
    if (args.length === 0) return ''
    return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  }
  // ── 游戏输出缓冲 (终端独立通道) ─────────────────────────
  // host 进程级内存环形缓冲: 游戏输出只进这里 (不进 session 事件流, 避免
  // 会话膨胀)。生命周期 = host 进程 — 重启即空 (终端随之清空); 断开重连
  // 缓冲保留 (client 按 sinceSeq 续拉)。颜色信息保留在原文 (感知层另行处理)。
  const GAME_BUFFER_MAX = 2000
  /** 终端输出自增序号 (客户端去重/断线续拉)。 */
  let gameSeq = 0
  /** 缓冲条目: 普通游戏输出, 或连接/重连分隔文本 (host 在 connect 时刻写入,
   *  client 当普通输出显示 — 位置天然正确, 无时序竞态)。 */
  const gameBuffer: { seq: number; text: string; time: number }[] = []
  let connectCount = 0 // telnet 连接次数 (首次 connect / 后续 reconnect)
  // ── UI 流缓冲 (WS 通道; 与 session 双写) ─────────────────
  // 日志/决策: 进程级环形缓冲经 /mud/ws 推送 (webui) + session 事件 (tui)。
  const UI_BUFFER_MAX = 2000
  const uiBuffer: MudUiItem[] = []
  let uiTailSeq = 0
  // 最新 world 快照 (替换语义, 无历史; pushWorld 节流更新并广播)。
  let latestWorld: MudWorldSnapshot | null = null
  // WS 推送通道 (webServer 解析后创建; 此前的日志/决策只进缓冲, 不广播)。
  let hub: MudWebSocketHub | null = null

  /** 目标会话是否已在 host materialize (client open/激活或 prepareAgent 创建)。 */
  function isSessionLive(sessionId: string): boolean {
    try {
      return ctx.get('sessions')?.get(sessionId as never) !== undefined
    } catch {
      return false
    }
  }

  /**
   * 广播自定义事件给进程内外壳 (TUI): 决策/日志/状态。
   * 经 ctx.emit 进程内广播, 不再写进 agent session 日志 — mud/* 事件无需
   * 持久化 (TUI 与 host 同进程实时消费, browser 走 /mud/ws), 而写入 session
   * 日志会因类型不在 KNOWN_SESSION_EVENT_TYPES 导致重启读史失败。
   */
  function sessionAppend(
    type: 'mud/decision',
    data: { actor: 'rule' | 'router' | 'agent' | 'flow'; ruleId?: string; eventType?: string; action: string; result?: string; text: string; time: number },
  ): void
  function sessionAppend(
    type: 'mud/log',
    data: { text: string; time: number },
  ): void
  function sessionAppend(
    type: 'mud/world',
    data: { world: MudWorldSnapshot; time: number },
  ): void
  function sessionAppend(
    type: 'mud/captcha',
    data: { url: string; cmd: string; time: number },
  ): void
  function sessionAppend(
    type: 'mud/decision' | 'mud/log' | 'mud/world' | 'mud/captcha',
    data: {
      actor?: 'rule' | 'router' | 'agent' | 'flow'
      ruleId?: string
      eventType?: string
      action?: string
      result?: string
      text?: string
      world?: MudWorldSnapshot
      url?: string
      cmd?: string
      time: number
    },
  ): void {
    // 进程内广播给外壳 (TUI): 不写进 agent session 日志 (详见上方注释)。
    if (type === 'mud/decision') {
      ctx.events.emit('mud/decision', data as MudDecisionEvent)
    } else if (type === 'mud/log') {
      ctx.events.emit('mud/log', data as MudLogEvent)
    } else if (type === 'mud/captcha') {
      ctx.events.emit('mud/captcha', data as unknown as MudCaptchaEvent)
    } else {
      ctx.events.emit('mud/world', data as MudWorldEvent)
    }
  }

  /** world 变化 → 节流推送快照 (500ms 合并; session 事件 + WS 广播, 替换语义)。 */
  function pushWorld(): void {
    if (worldTimer) clearTimeout(worldTimer)
    worldTimer = setTimeout(() => {
      latestWorld = worldSnapshot(world)
      sessionAppend('mud/world', { world: latestWorld, time: Date.now() })
      hub?.broadcastWorld(latestWorld)
    }, 500)
  }

  /** 监听 session 事件: 外壳命令 (mud/command) → 直达游戏 (绕过 agent)。 */
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'mud/command') return
    if (session && session.id && config.sessionId && session.id !== config.sessionId) return
    const cmd = event.data?.cmd
    if (typeof cmd === 'string' && cmd.trim()) sendCommand(cmd.trim())
  })

  /** 追加一条游戏输出进终端缓冲并经 WS 广播 (原始文本, 即时落盘; 不落会话)。 */
  function pushGameEntry(text: string): void {
    gameSeq += 1
    const item = { seq: gameSeq, text, time: Date.now() }
    gameBuffer.push(item)
    if (gameBuffer.length > GAME_BUFFER_MAX) gameBuffer.shift()
    hub?.pushGame([item])
  }

  /** 追加一条 UI 条目 (日志/决策/验证码): 进缓冲经 WS 广播 + session 事件双写。 */
  function pushUiItem(item: Omit<MudUiItem, 'seq'>): void {
    uiTailSeq += 1
    const entry: MudUiItem = { ...item, seq: uiTailSeq }
    uiBuffer.push(entry)
    if (uiBuffer.length > UI_BUFFER_MAX) uiBuffer.shift()
    hub?.pushUi([entry])
    if (item.kind === 'decision') {
      // tuiDecision 保证 decision 必有 actor/action; exactOptionalPropertyTypes
      // 下用条件展开避免把 undefined 显式赋给可选字段。
      sessionAppend('mud/decision', {
        actor: item.actor ?? 'router',
        action: item.action ?? '',
        text: item.text,
        time: item.time,
        ...(item.ruleId !== undefined ? { ruleId: item.ruleId } : {}),
        ...(item.eventType !== undefined ? { eventType: item.eventType } : {}),
        ...(item.flow !== undefined ? { flow: item.flow } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
      })
    } else if (item.kind === 'captcha') {
      // 验证码交互 (替换语义): WebUI 经 /mud/ws ui 帧, TUI 经进程内事件。
      sessionAppend('mud/captcha', {
        url: item.url ?? '',
        cmd: item.cmd ?? 'fullme',
        time: item.time,
      })
    } else {
      sessionAppend('mud/log', { text: item.text, time: item.time })
    }
  }

  /**
   * 已发送命令回显 (亮蓝 ANSI; actor 区分 agent/user)。
   * 即刻直写终端缓冲 — 与游戏输出同一条"事件当拍同步落盘"的时间轴。
   */
  function appendCommandEcho(cmd: string, actor: 'agent' | 'user'): void {
    const name = activeAccount?.name ?? config.account?.name ?? 'user'
    pushGameEntry(`\x1b[94m${name}@${actor}>${cmd}\x1b[0m`)
  }

  /** 发送命令到游戏连接。actor = 命令来源 (规则/agent 队列 → 'agent')。 */
  function sendCommand(cmd: string, actor: 'agent' | 'user' = 'agent'): boolean {
    const c = connections.get(SID)
    if (!c || c.state !== 'connected') {
      tuiLog(`[发送] 忽略命令 (未连接): ${JSON.stringify(cmd)}`)
      return false
    }
    const sent = c.client.send(String(cmd))
    if (sent) {
      appendCommandEcho(String(cmd), actor)
      tuiLog(`[发送] ${cmd === '' ? '<空行>' : cmd}`)
    }
    return sent
  }

  // ── 执行层: 工具是唯一执行路径 (规则与 agent 共用) ────────
  const queue = new CommandQueue({
    minInterval: config.commandIntervalMs ?? 400,
    onSend: (cmd: string) => { sendCommand(cmd) },
  })
  tuiLog(`[执行] 命令队列就绪 (最小间隔 ${config.commandIntervalMs ?? 400}ms)`)

  /** 工具集: 语义工具 (move/look/status) + mud_send 兜底。校验在工具层。 */
  const mudTools: MudTools = buildMudTools({
    send: (cmd: string) => queue.send(cmd),
    log: (t: string) => tuiLog(t),
  })
  tuiLog(`[执行] 工具集就绪: ${Object.keys(mudTools).join(', ')}`)

  // ── 触发服务 (ctx.mud.trigger): 匹配 → MudEvent → 事件总线 ──
  const trigger = new TriggerService({ bus: ctx })
  for (const r of defaultPerceptionRules) trigger.register(r)
  tuiLog(`[触发] 感知触发服务就绪, 已注册 ${defaultPerceptionRules.length} 条感知规则`)

  // ── 流程引擎 (ctx.mud.flow): 确定性事务流程 (登录/fullme) ──
  // 流程语义事件 → 决策栏可读文案 (如 login:required → "未登录")。
  const FLOW_EVENT_LABELS: Record<string, string> = {
    'login:required': '未登录',
    'login-failed': '登录失败',
  }
  const flow = new FlowService({ bus: ctx, trigger })

  /** 验证码交互推送 (fullme flow onCaptcha → WebUI 对话框 / TUI 事件)。
   *  替换语义: 新事件整体替换前端对话框状态 (全局唯一, 不叠开)。
   *  游戏回显的是 robot.php 页面而非真实图片: 先异步请求该页面解析出真实
   *  图片地址 (jpg), 再把真实图片推给前端; 解析失败/超时退化为回显原地址
   *  (用户可粘贴到浏览器手动看图)。单次抓取不重试 (refresh 有限、3 分钟失效)。 */
  async function pushCaptcha(url: string): Promise<void> {
    let displayUrl = url
    try {
      displayUrl = await resolveCaptchaImage(url)
    } catch {
      tuiLog(`[验证码] 解析真实图片失败, 回退原地址: ${url}`)
    }
    tuiLog(`[验证码] 捕获图片 → 推送确认框: ${displayUrl}`)
    pushUiItem({ kind: 'captcha', text: 'fullme 验证码', url: displayUrl, cmd: 'fullme', time: Date.now() })
    void ocrCaptcha(displayUrl)
  }

  /**
   * 后台 OCR (best-effort 钩子): 识别完成 → 以增量 captcha 事件预填
   * "fullme <文字>" (前端对话框替换命令预填, 用户仍可修改)。
   * 依赖 attachments 服务 (图片导入) + 侧路 LLM 补全; 当前宿主未接入该
   * 服务 — 走设计兜底: 对话框手动输入, 用户确认/修改后经 mud/command 发送。
   */
  async function ocrCaptcha(url: string): Promise<void> {
    void url
    tuiLog('[验证码] 后台 OCR 未接入 (需 attachments 服务), 请在确认框手动输入文字')
  }

  /** 每流程宿主: 共享执行路径 (bus/world/trigger/getAccount/send/onEvent),
   *  流程间差异只在进展/收尾回调与 flow 名。 */
  function makeFlowHost(flowId: string, over: Partial<FlowHost> = {}): FlowHost {
    return {
      bus: ctx,
      world,
      trigger,
      getAccount: () => ({
        name: activeAccount?.name ?? config.account?.name ?? '',
        pass: activeAccount?.pass ?? config.account?.pass ?? '',
      }),
      // 走 mud_send 工具执行路径 (与 agent/规则共用); 命令序列 → cmds (允许空命令退 MXP)。
      send: (cmd) => {
        if (Array.isArray(cmd)) mudTools['mud_send']?.execute({ cmds: cmd })
        else mudTools['mud_send']?.execute({ cmd })
      },
      onProgress: (msg) => {
        if (flowId === 'login') loginLog.push(`[自动登录] ${msg}`)
        // 决策栏格式: [流程] HH:mm:ss (flow): 收到xx提示 → 发送xx
        tuiDecision({ actor: 'flow', flow: flowId, eventType: `${flowId}:step`, action: msg, text: msg })
      },
      onEvent: (e, action) => {
        // 命中的提示行折叠进注入录制器: agent 不再重复分析, 仅见"事件→动作"条目。
        injector?.fold({
          eventType: e.type,
          startAbs: e.line,
          endAbs: e.line,
          text: `[事件(L${e.line})] 感知 "${e.type}" → ${action}`,
          time: e.ts,
        })
      },
      ...over,
    }
  }
  const loginHost = makeFlowHost('login', {
    onDone: () => {
      tuiDecision({ actor: 'flow', flow: 'login', eventType: 'login:done', action: 'done', text: '"成功"结束流程' })
    },
    onFailed: (reason) => {
      tuiDecision({ actor: 'flow', flow: 'login', eventType: 'login-failed', action: 'agent', text: `"失败"结束流程: ${reason}` })
      const prefix = loginLog.length > 0 ? loginLog.join('\n') + '\n' : ''
      const tail = (injector?.text().trim() || reason)
      injector?.reset()
      if (agent) injectToAgent(prefix + tail)
    },
    // 登录超时覆盖 (config.loginTimeoutMs → FlowHost.timeoutMs)。
    timeoutMs: config.loginTimeoutMs ?? 20000,
  })
  const fullmeHost = makeFlowHost('fullme', {
    onDone: () => {
      tuiDecision({ actor: 'flow', flow: 'fullme', eventType: 'fullme:done', action: 'done', text: '"成功"结束流程' })
    },
    onFailed: (reason) => {
      tuiDecision({ actor: 'flow', flow: 'fullme', eventType: 'fullme-failed', action: 'failed', text: `"失败"结束流程: ${reason}` })
    },
    onCaptcha: pushCaptcha,
  })
  // 装配全部流程 (config/flows.ts): 运行器 + 装配期宿主 + watch 常驻探测注册。
  const flowHosts: Record<string, FlowHost> = { login: loginHost, fullme: fullmeHost }
  for (const cfg of defaultFlows) {
    flow.register(new FlowRuntime(ctx, cfg), flowHosts[cfg.id] ?? null)
  }
  tuiLog(`[流程] 流程引擎就绪 (${flow.names().join(', ')})`)

  // ── 统一事件决策中心 (ctx.mud.dispatcher): 规则 → tool/flow 直调 → agent 兜底 ──
  // 可行动事件的统一路由。规则命中 (action:"tool") → 执行工具 (确定性短路);
  // 命中 (action:"flow") → flow.start 直调; 未命中 → agent 兜底。
  const center = new DecisionCenter({
    stateProvider: () => flattenWorld(world),
    startFlow: (flowId) => flow.start(flowId),
    executeRule: (rule, eventType) => {
      void eventType
      const a = rule.action
      if (a.action !== 'tool') return
      const tool = mudTools[a.tool]
      if (tool) {
        const account = activeAccount ?? config.account
        const cmd = renderTemplate(a.cmd ?? '', {
          name: account?.name ?? '',
          pass: account?.pass ?? '',
        })
        const result = tool.execute({ cmd })
        emitRuleDecision(rule, a.tool, cmd, result)
      } else {
        tuiDecision({
          actor: 'rule',
          ruleId: rule.id,
          action: `未知工具 ${a.tool}`,
          text: `[规则] ${rule.id} → 未知工具 ${a.tool}`,
        })
      }
      // 命中副作用: 写 world 标志 (防重复等)
      if (rule.after) applyPatch(world, rule.after)
    },
    onRoute: (eventType, layer, id) => {
      // flow 直调 (如登录) 是低频实质决策 — 记 `flow` 决策节点, 进决策栏,
      // 而非高频感知路由噪音 (后者归 router 且被 WebUI 决策栏过滤)。
      if (layer === 'flow') {
        tuiDecision({
          actor: 'flow',
          ...(id ? { flow: id } : {}),
          eventType,
          action: `启动 ${id} 流程`,
          text: `由"${FLOW_EVENT_LABELS[eventType] ?? eventType}"事件启动流程`,
        })
        return
      }
      const label = layer === 'rule' ? '规则' : 'agent'
      tuiDecision({
        actor: 'router',
        ...(id ? { ruleId: id } : {}),
        eventType,
        action: label,
        text: `[感知] ${eventType} → ${label}${id ? ` (${id})` : ''}`,
      })
    },
    dedupMs: config.ruleDedupMs ?? 1500,
  })
  for (const r of defaultDecisionRules) center.registerRule(r)
  tuiLog(`[决策] 决策中心就绪, 已注册 ${defaultDecisionRules.length} 条决策规则`)

  // ── 感知协调器 + 状态捕获 + 决策路由 (总线消费者) ──────────
  const buffer = new PerceptionBuffer()
  // 注入录制器: 30s 时间窗 + 最小行阈值 + 折叠视图 (取代原 LineInjector)。
  injector = new Transcript(buffer)
  // 状态捕获: 订阅总线感知事件 → world 字段映射; GMCP 经 state.onGmcp 直连。
  const state = new StateService({
    bus: ctx,
    world,
    onChanged: () => pushWorld(),
  })
  // 感知协调器: 驱动触发匹配 → 发布感知事件到总线。
  const driver = new PerceptionDriver({ buffer, trigger, maxPending: MAX_PENDING_LINES })
  tuiLog(`[感知] 缓冲 ${buffer.maxRows} 行 / 注入录制器 30s 窗 (≥${TRANSCRIPT_MIN_LINES} 行)`)
  tuiLog('[状态] 状态捕获就绪 (world 同步 + GMCP 直连)')
  // 决策中心 (总线消费者): 可行动感知事件 → 统一路由 (规则/flow 直调/agent 兜底)。
  const disposePercept = ctx.events.on('mud/percept', (e: MudPerceptEvent) => {
    resetDeadAir() // 感知事件到达 → 重置断流计时 (登录期不 armed, 见实现)
    center.onPercept(e)
  })
  // 系统级状态事件 → 决策中心 (如 login:required 直调登录 flow)。
  const disposeSystem = ctx.events.on('mud/system', (e: MudSystemEvent) => {
    center.onSystem(e)
  })
  tuiLog('[事件] 总线订阅就绪: mud/percept + mud/system → 决策中心')

  // ── 技能服务 (ctx.mud.skill): 预制目录 + agent 动态生成的技能注册 ──────
  // 目录变化 → 释放当前 agent: 下次 ensureAgent 重建 (resume 恢复上下文) 时
  // 用最新 skills 文本注入 mud-skills 区段。
  const skillService = new SkillService({
    onChange: () => {
      if (agent && typeof agent.dispose === 'function') {
        try { void agent.dispose() } catch { /* ignore */ }
      }
      agent = null
      activeSessionId = null
      tuiLog('[技能] 技能目录已更新, agent 将在下次交互时加载')
    },
  })

  // ── 游戏输出 → 终端 (即刻) + 感知/注入 (同管线) ─────────
  function feedRaw(text: string): void {
    // 终端通道: 每个文本块到达即写缓冲并广播 (合并推送; 命令回显同样即时直写)。
    pushGameEntry(text)
  }

  /** 感知通道: 每批完整逻辑行 → 缓冲 → 匹配 + 注入 (各一次, 批量)。 */
  function feedParsed(lines: ParsedLine[]): void {
    if (lines.length === 0) return
    if (!injector) return // 感知组件尚未就绪 (理论不可达, 防御)
    buffer.appendLines(lines)
    driver.onData()
    if (injectTimer) { clearTimeout(injectTimer); injectTimer = null }
    const text = injector.drain()
    if (text !== null) handleInjection(text)
    else if (injector.pending) {
      injectTimer = setTimeout(() => {
        injectTimer = null
        const t = injector?.force() ?? null
        if (t !== null) handleInjection(t)
      }, INJECT_IDLE_MS)
    }
  }

  /** 注入批处理: 边界检查 + 进展合并 + 忙时桶折叠 (纯 LLM 支路)。 */
  function handleInjection(text: string): void {
    const clean = text.trim()
    if (clean === '') return
    if (!(config.agentEnabled ?? false)) return // 暂停接入: 不唤醒 agent
    if (!agent) return
    if (!world.flags.logged_in) return // 登录期: 规则拦截确定消息, 未拦截的暂缓
    let payload = clean
    if (loginLog.length > 0) {
      payload = loginLog.join('\n') + '\n' + clean
      loginLog = []
    }
    if (agentBusy) {
      pendingInjection = payload
      return
    }
    injectToAgent(payload)
  }

  /** 写入连接/重连分隔文本到终端缓冲 (client 当普通输出写入, 位置在新内容前)。 */
  function appendConnectMarker(kind: 'connect' | 'reconnect'): void {
    const when = new Date().toLocaleString()
    const label = activeAccount?.name ?? config.account?.name ?? ''
    const head = kind === 'connect' ? '连接' : '重新连接'
    const text = [
      '',
      '============================================================',
      `===== ${when} — ${head}${label !== '' ? ` ${label}` : ''} =====`,
      '============================================================',
      '',
    ].join('\n')
    pushGameEntry(text)
  }

  /** 注入一条游戏输出到 agent, 并在其空闲后泵出合并的最新桶。 */
  function injectToAgent(payload: string): void {
    if (!agent || disposed || agentBusy) return
    agentBusy = true
    sendGameOutput(agent, payload) // 游戏提问 → agent
    tuiLog(`[注入] 游戏输出 → agent (${payload.length} 字符)`)
    void agent.agent.whenIdle().then(() => {
      agentBusy = false
      pumpPendingInjection()
    }).catch(() => {
      agentBusy = false
      pumpPendingInjection()
    })
  }

  /** agent 空闲: 若还有合并的待注入文本, 继续注入 (状态流节奏 = agent 决策速度)。 */
  function pumpPendingInjection(): void {
    if (!agent || disposed || agentBusy) return
    const text = pendingInjection
    if (!text) return
    pendingInjection = ''
    injectToAgent(text)
  }

  /**
   * 主动请求 agent 决策 (第三路触发): 断流 / 登录失败 / 命令路由等程序主动唤醒。
   * 抑制条件与注入一致: agent 未接入 / 未就绪 / 忙时忽略。
   */
  function requestAgent(reason: string, context: string): void {
    if (!agent || disposed) return
    if (!(config.agentEnabled ?? false)) return
    if (agentBusy) return
    tuiDecision({ actor: 'agent', eventType: reason, action: 'agent', text: `[决策] ${reason}` })
    injectToAgent(context)
  }

  /** 断流计时: 30s 无感知事件 → 唤醒 agent 主动决策 (登录期/接入关停/忙时抑制)。 */
  function armDeadAir(): void {
    if (deadAirTimer || disposed) return
    if (!(config.agentEnabled ?? false)) return
    if (!world.flags.logged_in) return // 登录期由 flow 驱动, 不唤醒
    deadAirTimer = setTimeout(() => {
      deadAirTimer = null
      if (agentBusy) {
        armDeadAir() // 忙时重排 (注入节奏 = agent 决策速度)
        return
      }
      requestAgent('断流 30s', '已 30 秒无游戏事件, 请自主行动 (查看状态 / 探索 / 规划下一步)。')
    }, DEAD_AIR_MS)
  }

  /** 重置断流计时 (每次感知事件到达): 清除旧定时并重排。 */
  function resetDeadAir(): void {
    if (deadAirTimer) { clearTimeout(deadAirTimer); deadAirTimer = null }
    armDeadAir()
  }

  // ── 连接 (手动: WebUI 游戏页面按钮触发) ──────────────────
  function connect(
    host: string,
    port: number,
    account?: { name: string; pass: string },
    sessionId?: string,
    cwd?: string,
  ): void {
    void cwd // 会话已由创建用户时建立; cwd 仅在创建时用于 workspace 归属
    if (connections.get(SID)?.state === 'connected') return // 幂等
    if (account !== undefined) activeAccount = account
    const sid = sessionId ?? config.sessionId ?? 'mud-player'
    // 目标会话必须已 live (client 激活), 否则事件无处可送 — 由 client 先打开用户会话。
    if (activeSessionId !== sid && !isSessionLive(sid)) {
      tuiLog(`[SYS] 会话未激活 (${sid}), 请先点击用户打开会话`)
      return
    }
    activeSessionId = sid
    const client = new TelnetClient({ host, port })
    connections.set(SID, { client, state: 'connecting', host, port })
    client.on('connect', () => {
      const e = connections.get(SID)
      if (e) e.state = 'connected'
      tuiLog('[SYS] 已连接')
      applyPatch(world, { connected: true })
      pushWorld()
      connectCount += 1
      appendConnectMarker(connectCount === 1 ? 'connect' : 'reconnect')
      applyPatch(world, { sent_name: false, sent_pass: false })
      loginLog = []
      // 未登录: 发布系统级事件 → 登录 skill 由流程引擎激活 (登录提示 → 发对应输入)
      ctx.events.emit('mud/system', makeSystemEvent('login:required'))
    })
    client.on('text', (text: string) => feedRaw(text))
    client.on('parsed', (lines: ParsedLine[]) => feedParsed(lines))
    client.on('gmcp', (msg) => {
      // GMCP 系统事件 → 状态捕获直连 (world 映射 + 派生事件上总线)。
      state.onGmcp(msg.package, msg.payload)
    })
    client.on('error', (err: Error) => {
      lastError = err.message
      tuiLog(`[SYS] 连接错误: ${err.message}`)
    })
    client.on('log', (e: { level: string; text: string }) => {
      // 网络层协商调试 (MCCP2/GMCP/回显等); 错误级已由 error 事件处理, 避免重复。
      if (e.level === 'info') tuiLog(`[NET] ${e.text}`)
    })
    client.on('close', () => {
      flow.abort('login')
      const e = connections.get(SID)
      if (e) e.state = 'idle'
      tuiLog('[SYS] 连接关闭')
      applyPatch(world, { connected: false })
      pushWorld()
    })
    client.connect()
  }

  // ── agent (重型处理器; 按用户会话创建/恢复) ─────────────
  async function ensureAgent(sessionId: string, cwd?: string): Promise<AgentHandle> {
    if (agent && activeSessionId === sessionId) return agent
    if (agent && typeof agent.dispose === 'function') {
      try { await agent.dispose() } catch { /* ignore */ }
      agent = null
    }
    activeSessionId = sessionId
    const options: CreateMudAgentOptions = {
      sessionId,
      ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
      persona: config.persona || buildPersona(),
      skills: skillService.textForAgent(),
      commands: commandsTextForAgent(),
      tools: mudTools,
      onAgentTool: (name, args) => {
        const argsJson = JSON.stringify(args)
        tuiDecision({
          actor: 'agent',
          action: `${name} ${argsJson}`,
          text: `[agent] 调用 ${name} ${argsJson}`,
        })
      },
    }
    agent = await createMudAgent(ctx, options).catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err)
      throw err
    })
    tuiLog(`[SYS] MUD 玩家 agent 就绪 (${sessionId})`)
    return agent
  }

  // ── 日志通道 (走系统 ctx.logger; WS 转发 webui + session 事件 tui) ──
  // 日志内容统一由系统 logger 产生 (harness 落盘/控制台); WebUI 日志 tab 与
  // TUI 只是消费该日志流的转发。不再自行拼装日志内容。
  // (mudLogger / decisionLogger / exporter / renderLogArgs 已在 apply 顶部定义。)
  function tuiLog(text: string): void {
    mudLogger.info(String(text))
  }

  /** 决策事件 (规则命中/感知路由): WebUI 决策栏 + TUI 决策轨迹。 */
  function tuiDecision(d: {
    actor: 'rule' | 'router' | 'agent' | 'flow'
    ruleId?: string
    eventType?: string
    flow?: string
    action: string
    result?: string
    text: string
  }): void {
    pushUiItem({ kind: 'decision', ...d, time: Date.now() })
    // 决策同步落盘留档 (系统日志通道, 独立命名空间 mud-decision):
    // 结构化字段随 args 保存, 便于审计回溯; 不进前台日志窗 (exporter 只转发 mud)。
    decisionLogger.info(`${d.text}${d.result ? ` — ${d.result}` : ''}`, {
      actor: d.actor,
      ruleId: d.ruleId ?? null,
      eventType: d.eventType ?? null,
      flow: d.flow ?? null,
      action: d.action,
      result: d.result ?? null,
    })
  }

  /**
   * 规则命中 → 决策节点 (战斗/死亡反射)。规则不再构成多步骤流程
   * (确定性事务已归 flow 引擎), 命中即单条决策记录。
   */
  function emitRuleDecision(
    rule: { id: string; description: string },
    toolName: string,
    cmd: string,
    result: { ok: boolean; note: string },
  ): void {
    tuiLog(`[捕获] 规则 ${rule.id} 命中 → ${toolName} ${JSON.stringify(cmd)} (${result.ok ? '成功' : `失败: ${result.note}`})`)
    tuiDecision({
      actor: 'rule',
      ruleId: rule.id,
      action: `${toolName} ${cmd}`,
      ...(result.ok ? {} : { result: `失败: ${result.note}` }),
      text: `[规则] ${rule.id} → ${toolName} ${cmd}`,
    })
  }

  /**
   * 创建用户时激活会话: 确保该用户的会话存在 (host 已 materialize 则复用,
   * 否则创建) — 不建立 telnet 连接, 连接由游戏页面的按钮触发。
   */
  async function prepareAgent(sessionId: string, cwd?: string): Promise<void> {
    if (!isSessionLive(sessionId)) {
      await ensureAgent(sessionId, cwd)
    }
  }

  // ── 启动: 等待手动连接 (用户即会话 — agent 在连接时按 sessionId 创建/恢复) ──
  const host = config.host || 'mud.pkuxkx.net'
  const port = Number(config.port ?? 8081)
  tuiLog('[SYS] 启动中 — 等待手动连接')
  const ruleCount = defaultDecisionRules.length + defaultPerceptionRules.length
  tuiDecision({
    actor: 'router',
    eventType: 'init',
    action: `决策引擎就绪 (${ruleCount} 条规则, ${config.agentEnabled ?? false ? 'agent 接入' : '暂停接入'})`,
    text: '[初始化] 决策引擎就绪',
  })

  // ── ctx.mud 服务 (进程内面: mud-tui / headless 等 node 外壳消费) ──
  const service: MudCoreService = {
    trigger,
    flow,
    skill: skillService,
    dispatcher: center,
    connect(options: MudConnectOptions = {}): void {
      const targetHost = typeof options.host === 'string' && options.host.trim() !== ''
        ? options.host.trim()
        : host
      const targetPort = options.port ?? port
      const account = typeof options.name === 'string' && options.name.trim() !== ''
        ? { name: options.name.trim(), pass: typeof options.pass === 'string' ? options.pass : '' }
        : undefined
      const targetSessionId = typeof options.sessionId === 'string' && options.sessionId.trim() !== ''
        ? options.sessionId.trim()
        : undefined
      const targetCwd = typeof options.cwd === 'string' && options.cwd.trim() !== ''
        ? options.cwd.trim()
        : undefined
      if (connections.get(SID)?.state !== 'connected') {
        tuiLog(`[SYS] 连接 ${targetHost}:${targetPort}${account ? ` (${account.name})` : ''}${targetSessionId ? ` [${targetSessionId}]` : ''}`)
        connect(targetHost, targetPort, account, targetSessionId, targetCwd)
      }
    },
    disconnect(): void {
      const c = connections.get(SID)
      if (c !== undefined && c.state !== 'idle') {
        tuiLog('[SYS] 手动断开')
        try { c.client.close() } catch { /* ignore */ }
      }
    },
    prepareAgent,
    status(): MudConnectionStatus {
      const c = connections.get(SID)
      return {
        connected: c?.state === 'connected',
        state: (c?.state ?? 'idle') as MudConnectionStatus['state'],
        host: c?.host ?? host,
        port: c?.port ?? port,
        accountName: c?.state === 'connected' ? (activeAccount?.name ?? config.account?.name ?? null) : null,
        sessionId: activeSessionId ?? config.sessionId ?? null,
        agentEnabled: config.agentEnabled ?? false,
      }
    },
    diag(): MudDiag {
      return {
        lastError,
        agentReady: agent !== null,
        activeSessionId,
        liveSessions: (() => {
          try {
            const sessions = ctx.get('sessions')
            return sessions?.list?.().map((s: { id: string }) => s.id) ?? []
          } catch { return [] }
        })(),
      }
    },
    sendCommand(cmd: string): boolean {
      const trimmed = cmd.trim()
      if (trimmed === '') return false
      return sendCommand(trimmed)
    },
    readGame(sinceSeq: number): MudGameRead {
      const since = Number.isFinite(sinceSeq) ? sinceSeq : 0
      return {
        items: gameBuffer.filter(item => item.seq > since),
        tailSeq: gameSeq,
      }
    },
    snapshot(): MudWorldSnapshot {
      return worldSnapshot(world)
    },
    askAgent(text: string): boolean {
      const trimmed = text.trim()
      if (trimmed === '' || agent === null || disposed) return false
      sendGameOutput(agent, `[玩家指令] ${trimmed}`)
      tuiLog(`[指令] 玩家指令 → agent (${trimmed.length} 字符)`)
      return true
    },
    setAgentEnabled(enabled: boolean): void {
      if (config.agentEnabled === enabled) return
      config.agentEnabled = enabled
      tuiDecision({
        actor: 'router',
        eventType: 'agent-mode',
        action: enabled ? 'agent 接入开启' : 'agent 接入关闭',
        text: `[模式] ${enabled ? '开启' : '关闭'} agent 接入`,
      })
    },
  }
  ctx.provide('mud', service)

  // ── 网络面: /mud/* HTTP 路由 + /mud/ws 通道 (webui 浏览器外壳) ──
  const webServer = ctx.get('webServer', false)
  if (webServer !== undefined) {
    hub = new MudWebSocketHub({
      registerUpgrade: route => webServer.registerUpgrade(route),
      trustedHosts: (ctx.get('webRuntime' as never, false) as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? [],
      backfill: (lastGameSeq, lastUiSeq) => ({
        game: gameBuffer.filter(item => item.seq > lastGameSeq),
        ui: uiBuffer.filter(item => item.seq > lastUiSeq),
      }),
      onError: (err) => {
        try { ctx.logger.warn(err instanceof Error ? err : new Error(String(err))) } catch { /* ignore */ }
      },
    })
  }
  const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const createRoute = (webServer !== undefined)
    ? webServer.register.bind(webServer)
    : null
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
          const targetHost = typeof body.host === 'string' && body.host.trim() !== ''
            ? body.host.trim()
            : host
          const targetPort = Number(body.port ?? port)
          const account = typeof body.name === 'string' && body.name.trim() !== ''
            ? { name: body.name.trim(), pass: typeof body.pass === 'string' ? body.pass : '' }
            : undefined
          const targetSessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== ''
            ? body.sessionId.trim()
            : undefined
          const targetCwd = typeof body.cwd === 'string' && body.cwd.trim() !== ''
            ? body.cwd.trim()
            : undefined
          if (connections.get(SID)?.state !== 'connected') {
            tuiLog(`[SYS] 连接 ${targetHost}:${targetPort}${account ? ` (${account.name})` : ''}${targetSessionId ? ` [${targetSessionId}]` : ''}`)
            void connect(targetHost, targetPort, account, targetSessionId, targetCwd)
          }
          sendJson(res, 200, { ok: true })
        }).catch((err: unknown) => {
          tuiLog(`[SYS] 连接请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  const disposePrepareRoute = createRoute !== null
    ? createRoute({
      kind: 'exact',
      path: '/mud/prepare',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        readJsonBody(req).then((body) => {
          const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== ''
            ? body.sessionId.trim()
            : undefined
          const targetCwd = typeof body.cwd === 'string' && body.cwd.trim() !== ''
            ? body.cwd.trim()
            : undefined
          if (sessionId === undefined) {
            sendJson(res, 400, { ok: false, error: 'missing sessionId' })
            return
          }
          void prepareAgent(sessionId, targetCwd).then(() => {
            sendJson(res, 200, { ok: true })
          }).catch((err: unknown) => {
            tuiLog(`[SYS] 预创建会话失败: ${err instanceof Error ? err.message : String(err)}`)
            sendJson(res, 500, { ok: false, error: 'prepare failed' })
          })
        }).catch((err: unknown) => {
          tuiLog(`[SYS] 预创建请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
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
        const c = connections.get(SID)
        if (c !== undefined && c.state !== 'idle') {
          tuiLog('[SYS] 手动断开')
          try { c.client.close() } catch { /* ignore */ }
        }
        sendJson(res, 200, { ok: true })
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
        const c = connections.get(SID)
        sendJson(res, 200, {
          ok: true,
          connected: c?.state === 'connected',
          state: c?.state ?? 'idle',
          host: c?.host ?? host,
          port: c?.port ?? port,
          accountName: c?.state === 'connected' ? (activeAccount?.name ?? config.account?.name ?? null) : null,
          sessionId: activeSessionId ?? config.sessionId ?? null,
        })
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
        sendJson(res, 200, {
          ok: true,
          lastError,
          agentReady: agent !== null,
          activeSessionId,
          liveSessions: (() => {
            try {
              const sessions = ctx.get('sessions')
              return sessions?.list?.().map((s: { id: string }) => s.id) ?? []
            } catch { return [] }
          })(),
        })
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
          const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
          if (cmd === '') {
            sendJson(res, 400, { ok: false, error: 'empty command' })
            return
          }
          const sent = sendCommand(cmd)
          sendJson(res, 200, { ok: sent })
        }).catch((err: unknown) => {
          tuiLog(`[SYS] 命令请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // teardown
  ctx.effect(() => () => {
    disposed = true
    if (injectTimer) clearTimeout(injectTimer)
    if (worldTimer) clearTimeout(worldTimer)
    flow.dispose()
    disposePercept()
    disposeSystem()
    state.dispose()
    if (hub) hub.dispose()
    if (disposeConnectRoute) disposeConnectRoute()
    if (disposePrepareRoute) disposePrepareRoute()
    if (disposeDisconnectRoute) disposeDisconnectRoute()
    if (disposeStatusRoute) disposeStatusRoute()
    if (disposeDiagRoute) disposeDiagRoute()
    if (disposeCommandRoute) disposeCommandRoute()
    if (agent && typeof agent.dispose === 'function') {
      try { void agent.dispose() } catch { /* ignore */ }
    }
    for (const c of connections.values()) {
      try { c.client.close() } catch { /* ignore */ }
    }
    connections.clear()
  }, 'mud-core: lifecycle')
}
