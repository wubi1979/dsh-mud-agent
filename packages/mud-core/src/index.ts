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

import { TelnetClient } from './telnet.ts'
import type { ParsedLine } from './ansi.ts'
import {
  PerceptionBuffer, Perceptor, StateTracker, MAX_PENDING_LINES,
} from './perception.ts'
import { LineInjector, INJECT_IDLE_MS } from './inject.ts'
import {
  createWorld, applyGmcp, applyPatch, worldSnapshot, flattenWorld, type WorldModel,
} from './world.ts'
import { RuleEngine } from './decision.ts'
import { CommandQueue, renderTemplate } from './execution.ts'
import { buildMudTools, type MudTools } from './tools.ts'
import defaultPerceptionRules from './config/rules.ts'
import defaultDecisionRules from './config/rules-decision.ts'
import defaultSkills, { skillsTextForAgent } from './config/skills.ts'
import { createMudAgent, sendGameOutput, type CreateMudAgentOptions } from './agent-bridge.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MudDecisionEvent, MudLogEvent, MudWorldEvent, MudWorldSnapshot } from './mud-events.ts'
import { MudWebSocketHub, type MudUiItem } from './ws.ts'
import type {
  MudConnectOptions, MudConnectionStatus, MudCoreService, MudDiag, MudGameRead,
} from './service.ts'

/** 插件名。 */
export const name = 'mud-core'

/** 必需服务: agents 注册表 (dsh-agent-loop 提供 factory)。 */
export const inject = ['agents']

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
  const ruleDedup = new Map<string, number>() // eventType → lastHandledAt (同类语义事件短窗去重)
  let agent: AgentHandle | null = null
  // 当前 agent 的会话 id (用户即会话: 切换用户 → 重建 agent, 各自历史恢复)。
  let activeSessionId: string | null = null
  // ── 流程级决策聚合 ────────────────────────────────────────
  const flowStarted = new Map<string, string>() // skill → 启动规则 id
  let loginTimer: ReturnType<typeof setTimeout> | null = null
  let loginLog: string[] = [] // 登录期间规则自动执行的进展 (登录完成后反馈给 agent)
  let worldTimer: ReturnType<typeof setTimeout> | null = null // world 快照推送节流
  // 注入节流: agent 忙时合并游戏输出 (状态流, 中间桶过期), 空闲后注入最新
  let agentBusy = false
  let pendingInjection = ''
  // ── 注入队列 (agent 输入侧; 与感知共用 MudLine 缓冲, 见 src/inject.ts) ──
  let injector: LineInjector | null = null
  let injectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false // teardown 已开始, 停止新的注入/泵出
  // 诊断: 最近一次 connect/ensureAgent 失败 (不依赖 agent 会话, 供 diag() 读取)。
  let lastError: string | null = null
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
    data: { actor: 'rule' | 'router' | 'agent'; ruleId?: string; eventType?: string; action: string; result?: string; text: string; time: number },
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
    type: 'mud/decision' | 'mud/log' | 'mud/world',
    data: {
      actor?: 'rule' | 'router' | 'agent'
      ruleId?: string
      eventType?: string
      action?: string
      result?: string
      text?: string
      world?: MudWorldSnapshot
      time: number
    },
  ): void {
    // 进程内广播给外壳 (TUI): 不写进 agent session 日志 (详见上方注释)。
    if (type === 'mud/decision') {
      ctx.events.emit('mud/decision', data as MudDecisionEvent)
    } else if (type === 'mud/log') {
      ctx.events.emit('mud/log', data as MudLogEvent)
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

  /** 追加一条 UI 条目 (日志/决策): 进缓冲经 WS 广播 + session 事件双写。 */
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
        ...(item.result !== undefined ? { result: item.result } : {}),
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
    if (!c || c.state !== 'connected') return false
    const sent = c.client.send(String(cmd))
    if (sent) appendCommandEcho(String(cmd), actor)
    return sent
  }

  // ── 执行层: 工具是唯一执行路径 (规则与 agent 共用) ────────
  const queue = new CommandQueue({
    minInterval: config.commandIntervalMs ?? 400,
    onSend: (cmd: string) => { sendCommand(cmd) },
  })

  /** 工具集: 语义工具 (move/look/status) + mud_send 兜底。校验在工具层。 */
  const mudTools: MudTools = buildMudTools({
    send: (cmd: string) => queue.send(cmd),
    log: (t: string) => tuiLog(t),
  })

  // ── 决策路由: 轻量处理器 (规则) / 重型处理器 (agent) ──────
  const ruleEngine = new RuleEngine({ stateProvider: () => flattenWorld(world) })
  for (const r of defaultDecisionRules) ruleEngine.register(r)
  const perceptor = new Perceptor()
  for (const r of defaultPerceptionRules) perceptor.register(r)

  /**
   * 规则拦截一次消息并替 agent 执行。返回 true = 已拦截 (消息不进 agent);
   * false = 未拦截 / 声明式 (action:"llm") → 照常注入 agent 思考。
   */
  function decide(eventType: string): boolean {
    const rule = ruleEngine.match({ eventType, state: flattenWorld(world) })
    if (!rule) return false // 未命中 → agent
    const a = rule.action
    if (a.action === 'llm' || a.action === 'no_action') return false // 声明式 → agent
    const tool = mudTools[a.tool]
    if (tool) {
      const account = activeAccount ?? config.account
      const cmd = renderTemplate(a.cmd ?? '', {
        name: account?.name ?? '',
        pass: account?.pass ?? '',
      })
      const result = tool.execute({ cmd })
      emitRuleDecision(rule, a.tool, cmd, result)
      // 登录进展: 记录规则替 agent 执行的步骤, 登录完成后反馈给 agent
      if (rule.skill === 'login' && rule.id !== 'login:failed') {
        loginLog.push(`[自动登录] ${rule.description} — 已执行`)
      }
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
    return true
  }

  // ── 感知 (世界同步 + 事件 → 决策路由) ─────────────────────
  const buffer = new PerceptionBuffer()
  injector = new LineInjector(buffer)
  const tracker = new StateTracker({
    world,
    buffer,
    perceptor,
    maxPending: MAX_PENDING_LINES,
    emit: (hit, patch) => {
      // 世界同步: patch → 语义分组 (logged_in→flags.logged_in, in_combat→combat.in_combat)
      if (patch && Object.keys(patch).length > 0) { applyPatch(world, patch); pushWorld() }
      const eventType = hit.eventType
      // 同类语义事件短窗去重 (战斗开始的"杀气/向你扑来"等多行只处理一次)
      const now = Date.now()
      const lastHandled = ruleDedup.get(eventType)
      if (lastHandled && now - lastHandled < (config.ruleDedupMs ?? 1500)) return
      // 决策路由: 规则命中 → 轻量处理; 未命中 → 注入 agent (重型)
      const handled = decide(eventType)
      if (handled) ruleDedup.set(eventType, now)
      tuiDecision({
        actor: 'router',
        eventType,
        action: handled ? '规则' : 'agent',
        text: `[感知] ${eventType}${handled ? ' → 规则' : ' → agent'}`,
      })
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
    tracker.onData()
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
      if (!(config.agentEnabled ?? false)) return
      if (loginTimer) clearTimeout(loginTimer)
      loginTimer = setTimeout(() => {
        if (world.flags.logged_in) return
        tuiDecision({
          actor: 'router',
          eventType: 'login-timeout',
          action: 'agent',
          text: '[决策] 登录超时 → 交给 agent 处理',
        })
        const ctxText = loginLog.length > 0 ? loginLog.join('\n') + '\n' : ''
        const text = (injector?.text().trim() || '登录流程超时, 尚未登录。请按\'登录流程\'技能步骤, 用 mud_send 完成登录。')
        injector?.reset()
        if (agent) injectToAgent(ctxText + text)
      }, config.loginTimeoutMs ?? 20000)
    })
    client.on('text', (text: string) => feedRaw(text))
    client.on('parsed', (lines: ParsedLine[]) => feedParsed(lines))
    client.on('gmcp', (msg) => {
      applyGmcp(world, msg.package, msg.payload)
      pushWorld()
    })
    client.on('error', (err: Error) => {
      lastError = err.message
      tuiLog(`[SYS] 连接错误: ${err.message}`)
    })
    client.on('close', () => {
      if (loginTimer) clearTimeout(loginTimer)
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
      skills: skillsTextForAgent(defaultSkills),
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

  // ── 日志通道 (双写): WS 推送 (webui) + session 事件 (tui) ──
  /** 普通日志流水 (系统/连接/注入): WebUI 日志 tab + TUI 日志。 */
  function tuiLog(text: string): void {
    pushUiItem({ kind: 'log', text: String(text), time: Date.now() })
  }

  /** 决策事件 (规则命中/感知路由): WebUI 决策栏 + TUI 决策轨迹。 */
  function tuiDecision(d: {
    actor: 'rule' | 'router' | 'agent'
    ruleId?: string
    eventType?: string
    action: string
    result?: string
    text: string
  }): void {
    pushUiItem({ kind: 'decision', ...d, time: Date.now() })
  }

  /**
   * 规则命中 → 流程级聚合决策。同一 skill 的规则构成流程:
   *   首次命中 → [规则] 命中X → 启动Y流程 (决策节点)
   *   :done/:failed → [流程] Y流程执行成功/失败 (决策结果)
   *   中间步骤 → 只进日志 (tuiLog), 不进决策栏 (执行过程不是决策)。
   */
  function emitRuleDecision(
    rule: { id: string; skill: string | null; description: string },
    toolName: string,
    cmd: string,
    result: { ok: boolean; note: string },
  ): void {
    const skill = rule.skill
    if (skill === null || skill === '') {
      tuiDecision({
        actor: 'rule',
        ruleId: rule.id,
        action: `${toolName} ${cmd}`,
        ...(result.ok ? {} : { result: `失败: ${result.note}` }),
        text: `[规则] ${rule.id} → ${toolName} ${cmd}`,
      })
      return
    }
    const isEnd = rule.id.endsWith(':done') || rule.id.endsWith(':failed')
    if (isEnd) {
      const ok = rule.id.endsWith(':done')
      flowStarted.delete(skill)
      tuiDecision({
        actor: 'rule',
        ruleId: rule.id,
        action: ok ? `${skill} 流程执行成功` : `${skill} 流程执行失败`,
        ...(ok ? {} : { result: result.note }),
        text: `[流程] ${skill} 流程${ok ? '执行成功' : '执行失败'}`,
      })
      return
    }
    const startedBy = flowStarted.get(skill)
    if (startedBy === undefined) {
      flowStarted.set(skill, rule.id)
      const why = rule.description !== '' ? rule.description : `命中 ${rule.id}`
      tuiDecision({
        actor: 'rule',
        ruleId: rule.id,
        action: `启动 ${skill} 流程`,
        text: `[规则] ${why} → 启动 ${skill} 流程`,
      })
    }
    tuiLog(`[流程] ${skill}: ${rule.id} → ${toolName} ${cmd}${result.ok ? '' : ` (失败: ${result.note})`}`)
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
    if (loginTimer) clearTimeout(loginTimer)
    if (worldTimer) clearTimeout(worldTimer)
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
