/**
 * dsh-mud-agent — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (REFACTOR-V7 机制 A — 命令-应答桥):
 *   - 游戏内容就是提问内容: 游戏输出全部注入 agent, agent 用工具/skill 回答。
 *   - 工具调用 = 挂起等待真实应答 (CommandResponseController): mud 工具执行
 *     经 sendAndAwait 挂起, 应答 (GA/EOR 主边界 / 声明 until / 静默 / 超时) 结算
 *     后作为 tool result 在单回合 step 链内推进 — loop 本体零改动。
 *   - 所有权路由 (取代瀑布): 注入消息携带 source.kind='mud-owned' + lane
 *     (t1 反射 / t2 推理)。feed 判类: state 折叠后, event 规则命中 → lane=t1
 *     (确定性反射, 轻量), 其余 → lane=t2 (真实 LLM 推理); 控制唤醒 →
 *     lane=t2。agent/request 回扫会话 surface 选 provider (bridge)。
 *   - 观察窗与应答帧互斥 (防双重消费): controller.inFlight() 期间的到达行归
 *     应答帧 (武装前并入帧首 head, 保持帧连续), 不判类注入; 无主行经观察窗
 *     (boundary/静默 结算点) 缓冲后判类注入。
 *   - GMCP 直连保持权威状态同步 (world); 文本语义经 agent 的 world_patch
 *     工具落库 (置信度 0.7; GMCP 权威 1.0 优先, 裁决在 world.ts)。
 *
 * 消息流:
 *   游戏输出 (telnet) → AnsiStreamParser 切完整逻辑行
 *     → feedParsed: 断流计时复位 + recall 行缓冲 + state 预匹配折叠
 *     → controller.feedLines (应答帧归在途请求; 无主行进观察窗)
 *     → 观察窗结算点 → judgeAndInject: owned(lane) 注入 agent
 *     → agent 路由 (bridge) → T1 反射 (规则→工具) 或 T2 推理 (真实 LLM)
 *     → 工具调用 (mud_*) 经 sendAndAwait 挂起 → 应答结算 → tool result 续步
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
import { CommandResponseController } from './network/response.ts'
import { buildMudTools, setSessionCredentials, getSessionCredentials, type MudTools } from './agent/tools.ts'
import defaultPerceptionRules from './config/trigger-rules.ts'
import { SkillService } from './agent/skills.ts'
import { commandsTextForAgent } from './config/commands.ts'
import { createMudAgent, sendOwnedOutput, registerTriggerProvider, disposeTriggerProvider, stateMatchService, eventMatchService, type CreateMudAgentOptions, type OwnedLane } from './agent/agent-bridge.ts'
import { CONTROL_PREFIX } from './trigger-llm/types.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MudWebSocketHub, isTrustedRequest, type MudUiItem } from './network/ws.ts'
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
  /** 命令-应答桥: 未声明请求超时 (缺省 10s)。 */
  bridgeTimeoutMs?: number
  /** 命令-应答桥: 声明 (until) 请求超时 (缺省 120s)。 */
  bridgeDeclaredTimeoutMs?: number
  /** 命令-应答桥/观察窗静默窗毫秒 (缺省 2s)。 */
  bridgeSilenceMs?: number
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

/** 读取并解析请求 JSON body (上限 64KB; 空 body 视为空对象)。
 *  强制 `content-type: application/json` (R2-1): 让 `/mud/*` POST 对浏览器
 *  成为"非简单请求"(触发 CORS 预检), 拒绝 text/plain 伪装的简单请求。 */
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
  const SID = 'console'
  const connections = new Map<string, { client: TelnetClient; state: string; host: string; port: number }>()
  // 当前连接账户 (WebUI 侧栏按用户连接时设置; 命令回显署名用)。
  let activeAccount: { name: string; pass: string } | null = null
  const world: WorldModel = createWorld()
  let agent: AgentHandle | null = null
  // 当前 agent 的会话 id (用户即会话: 切换用户 → 重建 agent, 各自历史恢复)。
  let activeSessionId: string | null = null
  let deadAirTimer: ReturnType<typeof setTimeout> | null = null // 断流 30s → 唤醒 agent
  // P3-5: 观察窗行数上限 (与 response.ts MAX_FRAME_LINES 同量级; 超限立即 flush)。
  const MAX_OBSERVE_LINES = 256
  // R2-8: 观察窗**注入**裁剪 (机制 D deliver.tail 的过渡实现): 判类仍用全量行
  // (不丢事件命中), 但注入文本只保留"摘要头 + 末 N 行" — 全量 256 行 (约 10KB+)
  // 作为一条 user 消息会让 T1 单次匹配巨批、T2 上下文暴涨 (成本与噪声不可控)。
  const MAX_INJECT_TAIL_LINES = 64
  const MAX_INJECT_TAIL_CHARS = 8_000
  // 登录看门狗: 登录期 (logged_in=false) 断流计时被抑制 (登录由 p:login:* 触发器推进),
  // 规则漏配/密码错误/网络半死会让登录停在某步且**无人唤醒**。整体预算 loginTimeoutMs
  // (缺省 90s) 无推进 → 升级 T2 决策; 阶段超时 (trigger-rules until 30~45s) < 预算,
  // 先让本步超时报错 (ok:false) 收束, 再由看门狗兜底升级。
  const LOGIN_TIMEOUT_MS = config.loginTimeoutMs ?? 90_000
  let loginWatchdog: ReturnType<typeof setTimeout> | null = null
  let loginStallCount = 0 // 连续升级次数 (封顶 3, 防 T2 无解时无限刷决策消息)
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
  // ── mud_recall 行缓冲 (agent 回看游戏输出) ─────────────
  // 完整逻辑行纯文本 (feedParsed 在 state 折叠前登记 — 终端视角含全部行,
  // 含状态行); FIFO, 上限与 mud_recall 的 count 上限对齐。
  const RECALL_MAX = 200
  const recallLines: string[] = []
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
   * P3-1: 凭据命令 (仅密码) 在回显中掩码为 ***; agent/转录工具结果不受影响
   * (tools.ts log 在 wire() 前, 返回值全程占位符, 明文仅瞬时在 socket 层)。
   */
  function appendCommandEcho(cmd: string, actor: 'agent' | 'user'): void {
    const name = activeAccount?.name ?? config.account?.name ?? 'user'
    pushGameEntry(`\x1b[94m${name}@${actor}>${redactCredential(cmd)}\x1b[0m`)
  }

  /** 凭据掩码: 仅密码 (高敏感); 用户名不掩 (日志可读性)。
   *  R2-6: 密码来源补 `config.account.pass` (未走 connect 选项时 activeAccount
   *  为 null 曾漏掩); 支持 `{pass}` 插值/带前后缀的**嵌入子串**掩码 — 短密码
   *  (长度 <4) 子串匹配误伤面过大, 仅全等掩码。 */
  function redactCredential(cmd: string): string {
    const pass = activeAccount?.pass ?? config.account?.pass
    if (!pass) return cmd
    if (cmd === pass) return '***'
    if (pass.length >= 4 && cmd.includes(pass)) {
      return cmd.split(pass).join('***')
    }
    return cmd
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
      // P3-1: 日志中密码掩码 (与 echo 同策略)。
      tuiLog(`[发送] ${cmd === '' ? '<空行>' : redactCredential(cmd)}`)
    }
    return sent
  }

  // ── 执行层: 工具是唯一执行路径 (agent 与路径 B 共用) ────────
  // 命令-应答桥 (REFACTOR-V7 机制 A): mud 工具调用经 sendAndAwait 挂起,
  // 真实应答结算后作为 tool result 返回; GA/EOR 主边界 / 声明 until /
  // 静默兜底 / 超时最兜底, 收尾规则见 response.ts。
  const controller = new CommandResponseController({
    // 实际发送: 入队 (队列 onSend = 真实写 socket 后 confirmSent 武装)。
    send: (cmd, meta) => { queue.send(cmd, { ...meta }) },
    onObservation: (lines) => {
      if (lines.length === 0) return
      // 无主观察行: inFlight (武装前/排队) → 并入帧首集 (confirmSent 时合并
      // 保持帧连续, 不判类注入 — 防双重消费); 否则进观察窗缓冲等结算点。
      if (controller.inFlight()) {
        headBuf.push(...lines)
        return
      }
      observeBuf.push(...lines)
      scheduleObserveFlush()
    },
    onBoundary: () => {
      // 无主边界 = 观察窗自然结算点 (帧切分): 缓冲行判类注入。
      if (controller.inFlight()) return // 武装前边界: 行仍归帧首
      flushObserve()
    },
    onLog: (t: string) => tuiLog(t),
    defaultTimeoutMs: config.bridgeTimeoutMs ?? 10_000,
    declaredTimeoutMs: config.bridgeDeclaredTimeoutMs ?? 120_000,
  })
  // 观察窗缓冲 (无主帧行; 边界/静默结算点 flush 判类注入)。
  const observeBuf: MudLine[] = []
  // 帧首集 (武装前到达的无主行; confirmSent 时并入帧首 — 帧连续语义)。
  const headBuf: MudLine[] = []
  let observeTimer: ReturnType<typeof setTimeout> | null = null

  /** 观察窗缓冲 flush: 清缓冲 + 判类注入 (仅无在途请求时调用)。 */
  function flushObserve(): void {
    if (observeTimer) { clearTimeout(observeTimer); observeTimer = null }
    if (observeBuf.length === 0) return
    const batch = observeBuf
    observeBuf.length = 0
    // P1-3a: 合并批整批登记 — 工具结果 resolveLines 才能精确还原 (逐批登记
    // 在长批合并后只还原到第一批, 后续批规则静默丢失)。
    controller.cacheLines(batch)
    judgeAndInject(batch)
  }

  /** 观察窗静默兜底 (无 GA 时按静默窗结算, 与应答桥同语义)。 */
  function scheduleObserveFlush(): void {
    if (observeTimer) clearTimeout(observeTimer)
    // P3-5: 观察窗超限立即 flush, 不等静默窗 (防 dz 渐进推送等无限累积)。
    if (observeBuf.length >= MAX_OBSERVE_LINES) {
      flushObserve()
      return
    }
    observeTimer = setTimeout(flushObserve, config.bridgeSilenceMs ?? 2_000)
  }

  /** R2-8: 注入文本裁剪 (deliver.tail 过渡实现) — 超限时返回"摘要头 + 末 N 行"。
   *  摘要头为普通文本行 (无样式), 明确说明截断, 避免 LLM 误以为缺行是断流。 */
  function trimObservation(lines: readonly MudLine[]): MudLine[] {
    if (
      lines.length <= MAX_INJECT_TAIL_LINES
      && lines.reduce((acc, l) => acc + l.text.length, 0) <= MAX_INJECT_TAIL_CHARS
    ) {
      return lines as MudLine[]
    }
    const tail = lines.slice(-MAX_INJECT_TAIL_LINES)
    const header: MudLine = {
      text: `[观察窗截断] 共 ${lines.length} 行, 保留末 ${tail.length} 行`,
      raw: `[观察窗截断] 共 ${lines.length} 行`,
      style: [],
      abs: -1,
      time: Date.now(),
      isPrompt: false,
    }
    return [header, ...tail]
  }

  /** 判类注入: state 已折叠; event 规则命中 → T1 反射 (轻量确定性),
   *  其余 → T2 推理 (真实 LLM)。所有权随消息走 (bridge 投影选 provider)。 */
  function judgeAndInject(lines: MudLine[]): void {
    if (lines.length === 0) return
    if (!(config.agentEnabled ?? false)) return
    if (!agent) return
    // 判类用全量行 (裁剪注入不丢事件命中)。
    let hasHit = false
    if (eventMatchService) {
      // P1-3b: 判类走镜像 matchDry (不推进多行状态机) — 判类与 adapter 真渲染
      // 共用实例会双跑: 判类先推进 multiLastAbs, 渲染时同批被单调保护跳过。
      hasHit = eventMatchService.matchDry(lines).some(h => h.action !== undefined)
    }
    // R2-8: 注入侧裁剪 — 全量 256 行一条注入使 T1 匹配巨批、T2 上下文暴涨。
    const inject = trimObservation(lines)
    const text = textOfLines(inject)
    const clean = text.trim()
    if (clean === '') return
    const lane: OwnedLane = hasHit ? 't1' : 't2'
    sendOwnedOutput(agent, clean, lane)
    tuiDecision({
      actor: 'router',
      eventType: 'feed-classify',
      action: lane === 't1' ? 'T1 反射注入' : 'T2 推理注入',
      result: `${clean.length} 字符`,
      text: `[路由] ${lane === 't1' ? 'T1 规则命中 → 反射' : 'T2 推理 → 真实 LLM'}`,
    })
  }

  const queue = new CommandQueue({
    minInterval: config.commandIntervalMs ?? 400,
    onSend: (cmd: string, meta) => {
      // 真实写 socket 后武装: 无主行 (帧首集) 并入帧首, 保持帧连续。
      let sent = false
      try {
        sent = sendCommand(cmd, meta?.actor ?? 'agent')
      } catch (err) {
        tuiLog(`[发送] 写 socket 异常: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (sent && meta?.replyId) {
        const head = headBuf.length > 0 ? headBuf.splice(0) : undefined
        controller.confirmSent(meta.replyId, head)
      } else if (meta?.replyId) {
        // P0-2: 发送失败/异常 → settle error → 工具 throw (回合 error), 防 sending 永久
        // 死锁 (inFlight 恒 true, pending 永不 pump)。pump 另有超窗未武装的兜底守卫。
        controller.sendFailed(meta.replyId, `写 socket 失败: ${cmd === '' ? '<空行>' : cmd}`)
      }
    },
  })
  tuiLog(`[执行] 命令队列就绪 (最小间隔 ${config.commandIntervalMs ?? 400}ms)`)

  /** 工具集: 语义工具 (move/look/status) + mud_send 兜底。校验在工具层。
   *  凭据: mud_send 发送瞬间按当前会话插值 {name}/{pass} (转录/日志只见占位符)。
   *  桥 (sendAndAwait): 工具执行挂起等真实应答, 结算后 text 回注为 tool result。 */
  const mudTools: MudTools = buildMudTools({
    send: (cmd: string) => queue.send(cmd),
    sendAndAwait: (cmd, opts) => controller.sendAndAwait(cmd, opts),
    log: (t: string) => tuiLog(t),
    recall: (count: number) => recallLines.slice(-count),
    world,
    resolveCredentials: () => getSessionCredentials(activeSessionId ?? config.sessionId),
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
      // 行恢复 = 命令-应答桥统一行集表 (应答/观察行按纯文本登记, 保真还原)。
      resolveLines: (text: string) => controller.resolveLines(text),
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
      // 延迟到当前同步栈结束后释放: 目录变更可能由 agent 自身触发 (工具执行 /
      // turn 进行中), 同步 dispose 等于从调用栈内拆掉正在跑的 loop → in-flight
      // 请求悬挂、会话事件流不一致 (agent 永久失败)。setImmediate 让当前工具
      // 执行/事件处理安全落地后再释放; turn 中途拆由 dispose+resume 语义兜底。
      setImmediate(() => {
        if (agent && typeof agent.dispose === 'function') {
          try { void agent.dispose() } catch { /* ignore */ }
        }
        agent = null
        activeSessionId = null
        tuiLog('[技能] 技能目录已更新, agent 将在下次交互时重建 (resume 恢复上下文)')
      })
    },
  })

  // ── 游戏输出 → 终端 (即刻) + 感知/提交 (同管线) ─────────
  function feedRaw(text: string): void {
    // 终端通道: 每个文本块到达即写缓冲并广播 (合并推送; 命令回显同样即时直写)。
    pushGameEntry(text)
  }

  /** 感知通道: 每批完整逻辑行 → state 预匹配折叠 + controller.feedLines。
   *  折叠分界 (REFACTOR-V7 六): 控制器收到**原始行** (边界匹配/帧内容可能
   *  含 state 折叠行, 如 hp 的 气血 行) + 折叠后剩余行 (观察窗专用, 状态已进
   *  world 不吵 agent):
   *    在途请求 (inFlight) → 行归应答帧 (武装前入帧首); 无主 → 观察窗缓冲,
   *    在边界/静默结算点判类注入 (T1 反射 / T2 推理), 防应答帧双重消费。 */
  function feedParsed(lines: MudLine[]): void {
    if (lines.length === 0) return
    resetDeadAir() // 文本到达 = 连接存活
    if (world.flags.logged_in) {
      // 已登录: 登录看门狗使命结束 (清理并复位), 断流计时 (armDeadAir) 接管监护。
      if (loginWatchdog) { clearTimeout(loginWatchdog); loginWatchdog = null }
      loginStallCount = 0
    } else {
      resetLoginWatchdog() // 登录期: 每次文本到达 = 阶段推进信号, 重置整体预算
    }
    // mud_recall 行缓冲 (state 折叠前登记 — 终端视角含全部行)。
    for (const l of lines) {
      recallLines.push(l.text)
      if (recallLines.length > RECALL_MAX) recallLines.shift()
    }
    const raw = lines
    let remains = lines

    // state 预匹配折叠: 命中 → extract 产物 applyPatch 落库 (原始行流上照常执行,
    // 与折叠无关 — "折叠"只决定行文本是否进观察窗/agent)。
    if (stateMatchService) {
      const stateHits = stateMatchService.match(raw)
      for (const hit of stateHits) {
        if (hit.data) applyPatch(world, hit.data)
      }
      // 移除折叠行 (hit.foldLines: multiline=全部捕获行; 单行 regex/text=锚点行;
      // 单行 func 不折叠 — 折叠集可能为空)。
      if (stateHits.length > 0) {
        const foldNums = new Set(stateHits.flatMap(h => h.foldLines))
        if (foldNums.size > 0) {
          remains = raw.filter(l => !foldNums.has(l.abs))
        }
      }
    }

    // 命令-应答桥: 原始行 → armed 帧累积/声明边界匹配/注册表; 折叠后剩余行
    // → 观察窗 (inFlight 期间 = 帧首集, 否则观察缓冲 → 判类注入)。
    controller.feedLines(raw, remains.length < raw.length ? remains : undefined)
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
    // 控制消息带 [系统] 前缀 + 所有权 lane=t2: 非游戏输出, 路由至真实 LLM 决策。
    sendOwnedOutput(agent, `${CONTROL_PREFIX}${context}`, 't2')
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

  /** 登录看门狗: 登录期无推进超过整体预算 → 升级 T2 决策。
   *  登录由 p:login:* 触发器链推进 (名字→密码→完成), 每步 `until` 声明分界;
   *  某步卡住 (规则漏配 / 密码错误 / 网络半死) 时文本不再变化 → 预算耗尽唤醒
   *  真实 LLM (控制消息 lane=t2) 查看历史裁决 (重发/重连/报告用户), 封顶 3 次。 */
  function armLoginWatchdog(): void {
    if (loginWatchdog || disposed) return
    if (!(config.agentEnabled ?? false)) return
    if (!agent) return
    if (world.flags.logged_in) return // 已登录: 断流计时 (armDeadAir) 接管
    loginWatchdog = setTimeout(() => {
      loginWatchdog = null
      if (disposed || !agent) return
      if (world.flags.logged_in) return
      loginStallCount += 1
      const elapsed = Math.round((LOGIN_TIMEOUT_MS * loginStallCount) / 1000)
      if (loginStallCount < 3) {
        requestAgent(
          '登录卡住',
          `登录已进行约 ${elapsed}s 无进展 (触发器未能推进到下一阶段)。请根据历史判断原因 ` +
            '(规则漏配 / 密码错误 / 需验证码 / 网络半死), 决定重发指令、重建连接或告知用户。',
        )
        armLoginWatchdog() // 一次决策回合解决不了 → 再次观望
      } else {
        tuiLog(`[登录] 卡住升级已达上限 (${loginStallCount} 次, 约 ${elapsed}s), 停止自动唤醒, 待用户介入`)
      }
    }, LOGIN_TIMEOUT_MS)
  }

  /** 重置登录看门狗 (登录期每次文本到达/阶段推进): 清旧定时重排;
   *  logged_in 置位后使命结束, 转交断流计时。 */
  function resetLoginWatchdog(): void {
    if (loginWatchdog) { clearTimeout(loginWatchdog); loginWatchdog = null }
    if (world.flags.logged_in) return
    armLoginWatchdog()
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
    // 幂等 (防重入泄漏): 已连接 / 连接进行中均拒绝再次发起 — 否则每次
    // connect 都 new 新 client 并覆盖条目, 旧 client 的 socket/flushTimer
    // 无引用泄漏, 其迟到 connect 事件还会把新条目误标 connected (双连接)。
    const existing = connections.get(SID)
    if (existing?.state === 'connected' || existing?.state === 'connecting') return
    if (existing) existing.client.close() // idle 残留兜底 (close 已销毁 socket → no-op)
    if (account !== undefined) activeAccount = account
    const sid = sessionId ?? config.sessionId ?? 'mud-player'
    // 目标会话必须已 live (client 激活), 否则事件无处可送 — 由 client 先打开用户会话。
    if (activeSessionId !== sid && !isSessionLive(sid)) {
      tuiLog(`[SYS] 会话未激活 (${sid}), 请先点击用户打开会话`)
      return
    }
    activeSessionId = sid
    // 凭据与会话绑定: {name}/{pass} 占位符的插值只在 mud_send 发送瞬间发生
    // (tools.ts), 转录/日志/工具结果全程只见占位符, 明文不落任何通道。
    if (account !== undefined) setSessionCredentials(sid, account)
    const client = new TelnetClient({ host, port })
    connections.set(SID, { client, state: 'connecting', host, port })
    client.on('connect', () => {
      const e = connections.get(SID)
      if (e) e.state = 'connected'
      tuiLog('[SYS] 已连接')
      // 新连接 = 新登录会话: 直接复位登录态 (绕过置信度护栏 — applyPatch 的 extract 置信度
      // 压不过上次登录留下的 GMCP 1.0, 不复位则 logged_in 残留 → 登录期断流计时误触发,
      // 且 trigger-rules 的 p:login:* 阶段判定取 flags 作上下文时读到旧值)。
      world.flags.logged_in = false
      world.flags.awaiting = true
      if (world._conf.flags) {
        delete world._conf.flags.logged_in
        delete world._conf.flags.awaiting
      }
      applyPatch(world, { connected: true })
      pushWorld()
      connectCount += 1
      appendConnectMarker(connectCount === 1 ? 'connect' : 'reconnect')
      applyPatch(world, { sent_name: false, sent_pass: false })
      // 登录看门狗布防: 服务器无任何文本 (半开连接/被服务器掐线) 也能兜底升级 T2。
      loginStallCount = 0
      resetLoginWatchdog()
      // 传输断裂 = 触发器上下文作废: 清多行半匹配 (跨连接的多行匹配不成立,
      // 防旧半匹配 + 新行拼假命中) + 重连复位命令-应答桥 (P0-1: close 为终止语义
      // 置 disposed, 重连必须 reset() 才重开; 顺带清行集表 — 旧连接的行对象
      // abs 已随 parser 实例归零, 残留条目会以旧 abs 污染新状态机)。
      stateMatchService?.resetContext()
      eventMatchService?.resetContext()
      controller.reset()
      headBuf.length = 0
      observeBuf.length = 0
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
      // 断线: 在途/排队应答全部 reject (error 语义), 队列停发, 观察窗清空。
      controller.close()
      queue.clear()
      headBuf.length = 0
      observeBuf.length = 0
      if (observeTimer) { clearTimeout(observeTimer); observeTimer = null }
      if (loginWatchdog) { clearTimeout(loginWatchdog); loginWatchdog = null }
      loginStallCount = 0 // 下次 reconnect 重新累计
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
    // P3-6b: agent 晚建场景 (connect 先于 ensureAgent 完成) — 登录看门狗在 connect 期
    // 因 `!agent` 提前返回未布防; 此处 agent 就绪后补布防, 防止登录零文本时无兜底。
    if (!world.flags.logged_in) armLoginWatchdog()
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
    /** 手动命令 (WebUI/用户): 走队列节流 + 正确归属观察窗 (不绕过应答桥计数)。
     *  R2-2: 回显归属 'user' (规则/agent 工具路径维持默认 'agent')。 */
    sendCommand(cmd: string): boolean {
      const trimmed = cmd.trim()
      if (trimmed === '') return false
      queue.send(trimmed, { actor: 'user' })
      return true
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
  const trustedHosts = (ctx.get('webRuntime' as never, false) as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []
  if (webServer !== undefined) {
    hub = new MudWebSocketHub({
      registerUpgrade: route => webServer.registerUpgrade(route),
      trustedHosts,
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
  // 统一信任围栏 (R2-1): 复用 ws 的 loopback/trustedHosts/Origin 判定包裹每个
  // /mud/* 路由 — 失败即 403, 不进入业务 handler。配合 readJsonBody 的
  // content-type 强制 (POST 简单请求被拒 → 浏览器预检生效)。
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
            // R2-2: 路由改走 service.sendCommand (队列节流 + 'user' 归属),
            // 不再直写 socket 绕过控制器计数/节流 (WebUI 正是经此路由发令)。
            let ok = true
            for (const c of cmds) {
              ok = service.sendCommand(c) && ok
            }
            sendJson(res, 200, { ok })
            return
          }
          const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
          if (cmd === '') {
            sendJson(res, 400, { ok: false, error: 'empty command' })
            return
          }
          const sent = service.sendCommand(cmd)
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
    if (deadAirTimer) {
      clearTimeout(deadAirTimer)
      deadAirTimer = null
    }
    if (loginWatchdog) {
      clearTimeout(loginWatchdog)
      loginWatchdog = null
    }
    if (observeTimer) { clearTimeout(observeTimer); observeTimer = null }
    controller.close()
    queue.clear()
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