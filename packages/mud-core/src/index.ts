/**
 * dsh-mud-agent — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (对齐 agent 规范):
 *   - 游戏内容就是提问内容: 游戏输出本该全部注入 agent, agent 用工具/skill 回答。
 *   - 工具/skill 属于 agent: 正常流程是 agent 思考 → 决定用哪个 skill → 调用工具。
 *   - 瀑布路由 (T1 → T2): 游戏输出统一以 user/message 提交 agent; agent 默认
 *     路由到 T1 本地模拟模型 (trigger-llm: 规则命中 → 确定性动作, 无需模型);
 *     T1 无应答经官方 agent/request-error 重试自然切换 T2 真实 LLM。
 *     GMCP 直连保持权威状态同步 (world); 文本语义经 agent 的 world_patch
 *     工具落库 (置信度 0.7; GMCP 权威 1.0 优先, 裁决在 world.ts)。
 *
 * 消息流:
 *   游戏输出 (telnet) → AnsiStreamParser 切完整逻辑行
 *     → 处理器: 断流计时复位 + 整批文本 (textOfLines) 提交 agent
 *     → agent → T1 本地模拟 (规则命中 → 确定性动作; 无应答 → T2 真实 LLM)
 *     → 工具调用 (mud_move/mud_look/mud_status/mud_send/world_patch) → 游戏
 *
 * 单面 (web face) 架构: 本包是统一 host 引擎, 唯一外壳为浏览器 WebUI
 *   (mud-webui)。游戏文本是一次性状态流 (不落会话, 避免会话无限增长), 走
 *   独立 /mud/ws 高吞吐通道 + /mud/* HTTP 路由; 借官方 webServer.registerUpgrade
 *   传载体 (复用 Host/Origin 信任围栏 + 心跳思路), 不改官方源码。
 * @module @deepseek-ai/dsh-mud-core
 */

import { TelnetClient } from './network/telnet.ts'
import type { MudLine } from './preprocess/ansi.ts'
import { textOfLines } from './preprocess/index.ts'
import { StateService } from './world/state.ts'
import {
  createWorld, applyPatch, worldSnapshot, type WorldModel,
} from './world/world.ts'
import { CommandQueue } from './agent/execution.ts'
import { buildMudTools, type MudTools } from './agent/tools.ts'
import defaultPerceptionRules from './config/trigger-rules.ts'
import { SkillService } from './agent/skills.ts'
import { commandsTextForAgent } from './config/commands.ts'
import { createMudAgent, sendGameOutput, registerTriggerProvider, disposeTriggerProvider, registerGameLines, setSessionCredentials, stateMatchService, eventMatchService, type CreateMudAgentOptions } from './agent/agent-bridge.ts'
import { CONTROL_PREFIX } from './trigger-llm/types.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MudWebSocketHub, type MudUiItem } from './network/ws.ts'
import { resolveCaptchaImage } from './network/captcha.ts'
import type { MudWorldSnapshot } from './client/wire.ts'
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

// 会话事件契约 (v5 仅保留宿主消费的 mud/command; UI shell 命令走 HTTP /mud/command)。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 客户端 → host 命令通道 (绕过 agent, 直发游戏连接)。 */
    'mud/command': { cmd: string }
  }
}

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
  /** 触发器 lite 动作去重窗口 (B 路径反射; 触发机制重构后使用)。 */
  ruleDedupMs?: number
  /** 登录超时 (login 重建为触发器 → lite 假 LLM 后使用)。 */
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
  // 当前连接账户 (WebUI 侧栏按用户连接时设置; 命令回显署名用)。
  let activeAccount: { name: string; pass: string } | null = null
  const world: WorldModel = createWorld()
  let agent: AgentHandle | null = null
  // 当前 agent 的会话 id (用户即会话: 切换用户 → 重建 agent, 各自历史恢复)。
  let activeSessionId: string | null = null
  let deadAirTimer: ReturnType<typeof setTimeout> | null = null // 断流 30s → 唤醒 agent
  let worldTimer: ReturnType<typeof setTimeout> | null = null // world 快照推送节流
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
  // ── UI 流缓冲 (WS 通道; 日志/决策/验证码) ─────────────
  // 日志/决策: 进程级环形缓冲经 /mud/ws 推送 (webui)。
  const UI_BUFFER_MAX = 2000
  const uiBuffer: MudUiItem[] = []
  let uiTailSeq = 0
  // 最新 world 快照 (替换语义, 无历史; pushWorld 节流更新并广播)。
  let latestWorld: MudWorldSnapshot | null = null
  // WS 推送通道 (webServer 解析后创建; 此前的日志/决策只进缓冲, 不广播)。
  let hub: MudWebSocketHub | null = null
  // 验证码刷新映射: 图片URL → robot.php URL (供前端刷新按钮重新获取图片)。
  // fullme 流程删除后暂无人填充, 待 login 重建 (触发器 → lite) 时接线。
  const robotUrlMap = new Map<string, string>()

  /** 目标会话是否已在 host materialize (client open/激活或 prepareAgent 创建)。 */
  function isSessionLive(sessionId: string): boolean {
    try {
      return ctx.get('sessions')?.get(sessionId as never) !== undefined
    } catch {
      return false
    }
  }

  /**
   * world 变化 → 节流推送快照 (500ms 合并; WS 广播, 替换语义)。
   */
  function pushWorld(): void {
    if (worldTimer) clearTimeout(worldTimer)
    worldTimer = setTimeout(() => {
      latestWorld = worldSnapshot(world)
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

  /** 追加一条 UI 条目 (日志/决策/验证码): 进缓冲并经 WS 广播 (替换语义)。 */
  function pushUiItem(item: Omit<MudUiItem, 'seq'>): void {
    uiTailSeq += 1
    const entry: MudUiItem = { ...item, seq: uiTailSeq }
    uiBuffer.push(entry)
    if (uiBuffer.length > UI_BUFFER_MAX) uiBuffer.shift()
    hub?.pushUi([entry])
    // 决策/验证码经 WS ui 帧 (kind decision/captcha) 由前端消费; 日志系统
    // 通道见 tuiLog/tuiDecision (走 ctx.logger, 落盘 + mud 命名空间转发)。
  }

  /**
   * 已发送命令回显 (亮蓝 ANSI; actor 区分 agent/user)。
   * 即刻直写终端缓冲 — 与游戏输出同一条"事件当拍同步落盘"的时间轴。
   */
  function appendCommandEcho(cmd: string, actor: 'agent' | 'user'): void {
    const name = activeAccount?.name ?? config.account?.name ?? 'user'
    pushGameEntry(`\x1b[94m${name}@${actor}>${cmd}\x1b[0m`)
  }

  /** 发送命令到游戏连接。actor = 命令来源 (agent/工具队列 → 'agent')。 */
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

  // ── 执行层: 工具是唯一执行路径 (agent 与路径 B 共用) ────────
  const queue = new CommandQueue({
    minInterval: config.commandIntervalMs ?? 400,
    onSend: (cmd: string) => { sendCommand(cmd) },
  })
  tuiLog(`[执行] 命令队列就绪 (最小间隔 ${config.commandIntervalMs ?? 400}ms)`)

  /** 工具集: 语义工具 (move/look/status) + mud_send 兜底。校验在工具层。 */
  const mudTools: MudTools = buildMudTools({
    send: (cmd: string) => queue.send(cmd),
    log: (t: string) => tuiLog(t),
    world,
  })
  tuiLog(`[执行] 工具集就绪: ${Object.keys(mudTools).join(', ')}`)

  // ── trigger-llm (T1 本地模拟): 承载于 agent-bridge 的 mud-t1 provider ──
  // 匹配服务按 lane 分桶 (state 预匹配折叠 / event T1 渲染), 由
  // registerTriggerProvider 统一创建双实例并挂 agent/request 瀑布路由。
  // 依赖 ctx.llm; 经 ctx.inject 延迟到 llm 就绪后注册 (幂等)。
  // 按 lane 分拣规则。
  const stateRules = defaultPerceptionRules.filter(r => r.lane === 'state')
  const eventRules = defaultPerceptionRules.filter(r => r.lane !== 'state')
  ctx.inject(['llm'], () => {
    registerTriggerProvider(ctx, {
      stateRules,
      eventRules,
      world,
      log: (t: string) => tuiLog(t),
    })
    tuiLog(`[触发] T1 provider (mud-t1) 装配就绪 (state ${stateRules.length} / event ${eventRules.length})`)
    return () => {
      // llm 移除时释放 T1 适配器路由。
      disposeTriggerProvider()
    }
  })

  // ── 状态捕获 (GMCP 直连, 权威同步 world) ──
  const state = new StateService({
    world,
    onChanged: () => pushWorld(),
  })
  tuiLog('[状态] 状态捕获就绪 (GMCP 直连)')

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

  // ── 游戏输出 → 终端 (即刻) + 感知/提交 (同管线) ─────────
  function feedRaw(text: string): void {
    // 终端通道: 每个文本块到达即写缓冲并广播 (合并推送; 命令回显同样即时直写)。
    pushGameEntry(text)
  }

  /** 感知通道: 每批完整逻辑行 → state 预匹配折叠 + 剩余行进 agent。
   *  行号由 AnsiStreamParser 分配 (MudLine.abs); state 命中行折叠入库并移除;
   *  剩余行登记行注册表 (供 T1 内容寻址) 并整批进 agent。 */
  function feedParsed(lines: MudLine[]): void {
    if (lines.length === 0) return
    resetDeadAir() // 文本到达 = 连接存活

    // state 预匹配折叠: 命中 → extract 产物 applyPatch 落库。
    if (stateMatchService) {
      const stateHits = stateMatchService.match(lines)
      for (const hit of stateHits) {
        if (hit.data) applyPatch(world, hit.data)
      }
      // 移除已命中行 (折叠: 命中行不进 agent)。
      if (stateHits.length > 0) {
        const hitLineNums = new Set(stateHits.map(h => h.lineNumber))
        lines = lines.filter(l => !hitLineNums.has(l.abs))
        if (lines.length === 0) return
      }
    }

    pushToAgent(textOfLines(lines), lines)
  }

  /** 单路径文本提取: 游戏输出以 user/message 直提 agent (无注入/折叠/忙时桶)。
   *  全部文本 (含登录期) 统一进 agent; 登录行为由 agent + T1/T2 路由决策。
   *  行对象按内容登记注册表 (T1 从请求尾部文本找回; 行号/style 保真)。 */
  function pushToAgent(text: string, lines: MudLine[]): void {
    const clean = text.trim()
    if (clean === '') return
    if (!(config.agentEnabled ?? false)) return // 暂停接入: 不唤醒 agent
    if (!agent) return
    registerGameLines(clean, lines)
    sendGameOutput(agent, clean)
    tuiLog(`[A路径] 游戏输出 → agent (${clean.length} 字符)`)
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

  /**
   * 主动请求 agent 决策 (程序唤醒): 断流 / 登录失败 / 命令路由等。
   * 抑制条件与 A 路径一致: agent 未接入 / 未就绪时忽略。
   */
  function requestAgent(reason: string, context: string): void {
    if (!agent || disposed) return
    if (!(config.agentEnabled ?? false)) return
    tuiDecision({ actor: 'agent', eventType: reason, action: 'agent', text: `[决策] ${reason}` })
    // 控制消息带 [系统] 前缀: T1 视为非游戏输出 (NO_ANSWER), 由 T2 真实决策。
    sendGameOutput(agent, `${CONTROL_PREFIX}${context}`)
  }

  /** 断流计时: 30s 无感知事件 → 唤醒 agent 主动决策 (登录期/接入关停抑制)。 */
  function armDeadAir(): void {
    if (deadAirTimer || disposed) return
    if (!(config.agentEnabled ?? false)) return
    if (!world.flags.logged_in) return // 登录期由触发器接管 (待 login 重建), 不唤醒
    deadAirTimer = setTimeout(() => {
      deadAirTimer = null
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
    // 凭据与会话绑定: 登录规则 (T1) 按本会话插值渲染 {name}/{pass}。
    if (account !== undefined) setSessionCredentials(sid, account)
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
      // 登录激活: 原经 mud/system → login flow 驱动; login 重建为"触发器 →
      // lite 假 LLM"后由感知触发器 (p:login:* 规则) 接管, 实现待重建。
    })
    client.on('text', (text: string) => feedRaw(text))
    client.on('parsed', (lines: MudLine[]) => feedParsed(lines))
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

  /** 决策事件 (感知路由/agent 动作): WebUI 决策栏 + TUI 决策轨迹。 */
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
  tuiDecision({
    actor: 'router',
    eventType: 'init',
    action: `感知引擎就绪 (${defaultPerceptionRules.length} 条感知规则, ${config.agentEnabled ?? false ? 'agent 接入' : '暂停接入'})`,
    text: '[初始化] 感知引擎就绪',
  })

  // ── ctx.mud 服务 (host API; WebUI 壳经 HTTP 路由 + /mud/ws 消费) ──
  // 匹配服务由级联 provider 注册时创建 (stateMatchService/eventMatchService 模块级
  // 变量, 经 getter 延迟解析 — llm 就绪后才有值)。
  const service: MudCoreService = {
    get stateTrigger() { return stateMatchService! },
    get eventTrigger() { return eventMatchService! },
    skill: skillService,
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
          const cmds = Array.isArray(body.cmds)
            ? body.cmds
              .filter((c): c is string => typeof c === 'string')
              .map(c => c.trim())
              .filter(c => c !== '')
            : null
          if (cmds !== null) {
            if (cmds.length === 0) {
              sendJson(res, 400, { ok: false, error: 'empty command' })
              return
            }
            let ok = true
            for (const c of cmds) {
              ok = sendCommand(c) && ok
            }
            sendJson(res, 200, { ok })
            return
          }
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
          // 删除旧映射, 重新解析获取新图片。
          robotUrlMap.delete(imageUrl)
          try {
            const newDisplayUrl = await resolveCaptchaImage(robotUrl)
            robotUrlMap.set(newDisplayUrl, robotUrl)
            tuiLog(`[验证码] 刷新图片: ${newDisplayUrl}`)
            pushUiItem({ kind: 'captcha', text: 'fullme 验证码', url: newDisplayUrl, cmd: 'fullme', time: Date.now() })
            sendJson(res, 200, { ok: true, url: newDisplayUrl })
          } catch (err) {
            tuiLog(`[验证码] 刷新失败: ${err instanceof Error ? err.message : String(err)}`)
            sendJson(res, 500, { ok: false, error: 'refresh failed' })
          }
        }).catch((err: unknown) => {
          tuiLog(`[SYS] 验证码刷新请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 400, { ok: false, error: 'invalid body' })
        })
      },
    })
    : undefined

  // teardown
  ctx.effect(() => () => {
    disposed = true
    if (worldTimer) clearTimeout(worldTimer)
    if (hub) hub.dispose()
    if (disposeConnectRoute) disposeConnectRoute()
    if (disposePrepareRoute) disposePrepareRoute()
    if (disposeDisconnectRoute) disposeDisconnectRoute()
    if (disposeStatusRoute) disposeStatusRoute()
    if (disposeDiagRoute) disposeDiagRoute()
    if (disposeCommandRoute) disposeCommandRoute()
    if (disposeCaptchaRefreshRoute) disposeCaptchaRefreshRoute()
    if (agent && typeof agent.dispose === 'function') {
      try { void agent.dispose() } catch { /* ignore */ }
    }
    for (const c of connections.values()) {
      try { c.client.close() } catch { /* ignore */ }
    }
    connections.clear()
  }, 'mud-core: lifecycle')
}