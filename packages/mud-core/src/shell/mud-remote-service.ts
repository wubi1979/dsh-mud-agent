/**
 * dsh-mud-core — MUD Remote 服务 (shell/mud-remote-service).
 *
 * typert Remote 命名空间 `mud`: WebUI 外壳的全部消费面收敛于此 —
 * 11 个 RPC 方法 (原 /mud/* REST 路由) + 3 条流方法 (原 /mud/ws 帧协议)。
 * 传输细节全部外包给官方 typert 栈: /api 信任围栏与 browserAuth 由网关
 * requestRejection 统一施加, WS 心跳/背压/多路复用由 mux 承担, 参数与
 * 返回值由生成的严格 descriptor 校验 — 本类只写业务语义。
 *
 * 会话回落: bind/connect 记录 last-active, 其余方法的缺省 sessionId 走
 * view.resolve (显式字段 → last-active → 部署缺省), 单用户设计见 SessionView。
 * @module @deepseek-ai/dsh-mud-core/shell/mud-remote-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveCaptchaImage } from '../network/captcha.ts'
import { MUD_TIER_NAMES, type MudTier } from '../agent/gate/tiers.ts'
import type { MudCapabilityOption } from '../agent/gate/capability.ts'
import type { LogEntry } from '../log/log-service.ts'
import type { MudLogService } from '../log/log-service.ts'
import type { MudCoreService, MudConnectOptions, MudConnectionStatus, MudDiag } from './service.ts'
import type { MudUiItemInput } from '../session/types.ts'
import type { MudGameItem, MudUiItem } from './remote-types.ts'
import { feedGame, feedUi, feedWorld, type MudFeedHub, type MudWorldEvent } from './streams.ts'

/** 活动会话视图 (last-active 记忆 + 回落解析; 原 shell/view.ts 折叠于此)。
 *
 * host 的"当前视图会话"概念: RPC 入口未显式给出 sessionId 时回落最近一次
 * connect/bind 的会话, 再回落部署配置的缺省会话 id (最终兜底 `mud-player`)。
 * **单用户设计**: lastActive 是进程级指针, 多标签共享无碍; 多用户部署下
 * 缺省回落是已知代价 — 多用户场景前端必须显式传 sessionId。 */
export class SessionView {
  private lastActiveSessionId: string | null = null

  constructor(private readonly fallback: string) {}

  /** 最近一次 connect/bind 的会话 (RPC 未显式给 sessionId 时的回落)。 */
  lastActive(): string | null {
    return this.lastActiveSessionId
  }

  /** 会话被 (重新) 声明为活动时记录。 */
  setActive(sessionId: string): void {
    this.lastActiveSessionId = sessionId
  }

  /** 会话注销时清回落指针 (只清自己)。 */
  clearActive(sessionId: string): void {
    if (this.lastActiveSessionId === sessionId) this.lastActiveSessionId = null
  }

  /** 解析目标会话 id: 显式字段优先 → last-active → 部署缺省。 */
  resolve(sessionId?: string): string {
    const explicit = sessionId?.trim()
    if (explicit !== undefined && explicit !== '') return explicit
    return this.lastActiveSessionId ?? this.fallback
  }
}

/** Remote 服务的装配依赖 (由装配方注入 apply 作用域闭包)。 */
export interface MudRemoteServiceInternals {
  /** MUD 核心服务 (assemble 提供的 ctx.mud 本体)。 */
  readonly service: MudCoreService
  /** 会话 id 回落指针 (与 MudCoreService 闭包共享同一实例)。 */
  readonly view: SessionView
  /** 全局缓冲 (流回放数据源)。 */
  readonly buffers: {
    backfill: (lastGameSeq: number, lastUiSeq: number) => { game: readonly MudGameItem[]; ui: readonly MudUiItem[] }
  }
  /** 流扇出端 (streams.ts)。 */
  readonly feeds: MudFeedHub
  /** 会话日志服务 (lazily)。 */
  readonly logServiceOf: (sessionId: string) => MudLogService
  /** UI 条目写入 (验证码刷新路径复用 buffers.pushUi)。 */
  readonly pushUi: (sessionId: string, input: MudUiItemInput) => void
  readonly tuiLog: (sessionId: string, text: string) => void
  /** 验证码刷新映射: 图片URL → robot.php URL。 */
  readonly robotUrlMap: Map<string, string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `mud` Remote namespace. */
    mudRemote: MudRemoteService
  }
}

/**
 * Host service backing the generated `ctx.remote.mud` namespace.
 * @see {@link MudRemoteServiceInternals}
 */
export class MudRemoteService extends TypertRemoteService {
  private readonly service: MudCoreService
  private readonly view: SessionView
  private readonly buffers: MudRemoteServiceInternals['buffers']
  private readonly feeds: MudFeedHub
  private readonly logServiceOf: (sessionId: string) => MudLogService
  private readonly pushUi: (sessionId: string, input: MudUiItemInput) => void
  private readonly tuiLog: (sessionId: string, text: string) => void
  private readonly robotUrlMap: Map<string, string>

  constructor(ctx: Context, internals: MudRemoteServiceInternals) {
    super(ctx, 'mudRemote', { namespace: 'mud' })
    this.service = internals.service
    this.view = internals.view
    this.buffers = internals.buffers
    this.feeds = internals.feeds
    this.logServiceOf = internals.logServiceOf
    this.pushUi = internals.pushUi
    this.tuiLog = internals.tuiLog
    this.robotUrlMap = internals.robotUrlMap
  }

  /** body/参数 → 会话 id (显式字段优先; 缺省回落 lastActive/config)。 */
  private resolveSession(sessionId?: string): string {
    return this.view.resolve(sessionId)
  }

  // ── RPC: 会话与连接 ──────────────────────────────────────────────

  /** 声明"该官方会话是 MUD 账号会话" (不建连接; 页面在 sessions.create 后调用)。 */
  @Remote
  bind(sessionId?: string): { sessionId: string } {
    const target = this.resolveSession(sessionId)
    this.service.bind(target)
    return { sessionId: target }
  }

  /** 建立某会话的 telnet 连接 (幂等; 缺省回落部署 config.account; passRef 由服务解析, 失败抛错)。 */
  @Remote
  async connect(options: MudConnectOptions | undefined): Promise<{ sessionId: string }> {
    const sessionId = this.resolveSession(options?.sessionId)
    await this.service.connect({ ...options, sessionId })
    return { sessionId }
  }

  /** 断开某会话连接 (缺省 = 最近一次 bind/connect 的会话)。 */
  @Remote
  disconnect(sessionId?: string): { sessionId?: string } {
    this.service.disconnect(sessionId)
    return sessionId === undefined ? {} : { sessionId }
  }

  /** 单会话连接状态 + 全部已绑定会话的状态表 (侧栏/状态面板)。 */
  @Remote
  status(sessionId?: string): { status: MudConnectionStatus; sessions: readonly MudConnectionStatus[] } {
    return {
      status: this.service.status(sessionId),
      sessions: this.service.statuses(),
    }
  }

  /** 最近一次错误 + 各会话诊断 (排查连接/agent 装配失败)。 */
  @Remote
  diag(): MudDiag {
    return this.service.diag()
  }

  // ── RPC: 命令与权限 ──────────────────────────────────────────────

  /**
   * 发送游戏命令到指定会话的连接 (走该会话队列节流 + 'user' 归属)。
   * @param cmd 单条命令 (与 cmds 二选一)。
   * @param cmds 批量命令 (按序逐条入队; 与 cmd 二选一)。
   * @throws 参数缺失/为空时抛错 (原 400 语义)。
   */
  @Remote
  command(cmd: string | undefined, cmds: readonly string[] | undefined, sessionId?: string): { ok: boolean; sessionId: string } {
    const target = this.resolveSession(sessionId)
    if (cmds !== undefined) {
      const list = cmds.map(c => c.trim()).filter(c => c !== '')
      if (list.length === 0) throw new Error('empty command')
      let ok = true
      for (const c of list) ok = this.service.sendCommand(c, target) && ok
      return { ok, sessionId: target }
    }
    const trimmed = typeof cmd === 'string' ? cmd.trim() : ''
    if (trimmed === '') throw new Error('empty command')
    return { ok: this.service.sendCommand(trimmed, target), sessionId: target }
  }

  /**
   * 切换某会话的权限档位 (§10)。
   * @throws 未知档位抛错 (原 400 语义)。
   */
  @Remote
  setCapability(tier: string, sessionId?: string): { sessionId: string; tier: MudTier; capabilities: readonly string[] } {
    const target = this.resolveSession(sessionId)
    if (!MUD_TIER_NAMES.includes(tier as MudTier)) throw new Error(`unknown tier "${tier}"`)
    const applied = this.service.capability.set(target, tier)
    return { sessionId: target, tier: applied, capabilities: this.service.capability.capabilities(applied) }
  }

  // ── RPC: 验证码 / 日志 / 注销 ────────────────────────────────────

  /**
   * 弹窗"中止" → ask-human 验证码等待当场失败 (fail-closed; 无挂起等待时空操作)。
   * 缺省回落 last-active 会话。
   */
  @Remote
  captchaAbort(sessionId?: string): { ok: boolean } {
    this.service.captchaAbort(sessionId)
    return { ok: true }
  }

  /**
   * 刷新验证码图片 (robotUrlMap 里登记的展示 URL → 取新图 → 推 tuiCaptcha)。
   * @throws 未知图片或取图失败抛错 (原 400/500 语义)。
   */
  @Remote
  async captchaRefresh(imageUrl: string, sessionId?: string): Promise<{ url: string }> {
    const robotUrl = this.robotUrlMap.get(imageUrl)
    if (robotUrl === undefined) throw new Error('unknown captcha image')
    this.robotUrlMap.delete(imageUrl)
    const newDisplayUrl = await resolveCaptchaImage(robotUrl)
    this.robotUrlMap.set(newDisplayUrl, robotUrl)
    const target = this.resolveSession(sessionId)
    this.tuiLog(target, `[验证码] 刷新图片: ${newDisplayUrl}`)
    this.pushUi(target, { kind: 'captcha', text: 'fullme 验证码', url: newDisplayUrl, cmd: 'fullme', time: Date.now() })
    return { url: newDisplayUrl }
  }

  /** 当日日志恢复 (前端挂载时拉历史, 与 ui 流按 logSeq 去重合并)。 */
  @Remote
  logs(sessionId?: string): { sessionId: string; entries: LogEntry[] } {
    const target = this.resolveSession(sessionId)
    return { sessionId: target, entries: this.logServiceOf(target).readDayEntries(target) }
  }

  /**
   * 注销会话 (删除用户): 释放运行时/连接, 删除全部日志文件。
   * @throws 空 sessionId 抛错 (原 400 语义)。
   */
  @Remote
  purge(sessionId: string): { ok: boolean; sessionId: string; files: number } {
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (target === '') throw new Error('missing sessionId')
    const result = this.service.purge(target)
    return { ok: result.ok, sessionId: target, files: result.files }
  }

  // ── RPC: 档位读取 ────────────────────────────────────────────────

  /** 读取某会话的档位选项与当前值 (页面档位选择器)。 */
  @Remote
  capability(sessionId?: string): {
    sessionId: string
    tier: MudTier
    capabilities: readonly string[]
    options: readonly MudCapabilityOption[]
    defaultTier: MudTier
  } {
    const target = this.resolveSession(sessionId)
    const tier = this.service.capability.current(target)
    return {
      sessionId: target,
      tier,
      capabilities: this.service.capability.capabilities(tier),
      options: this.service.capability.options(),
      defaultTier: this.service.capability.defaultTier,
    }
  }

  // ── 流: game / ui / world (原 /mud/ws 帧协议) ────────────────────

  /**
   * 游戏输出流 (终端通道, 原始文本含 ANSI; 按 sinceSeq 回放后切实时)。
   *
   * **seq 契约**: seq 进程内全局单调; 回放与实时**两条路径可达**同一批条目,
   * 前端必须按 seq 去重 (GameView 已实现)。**跳号合法**: 宿主缓冲有上限,
   * 旧条目驱逐后回放从剩余最旧开始, 中间缺口前端无从察觉也不应报错。
   */
  @Remote({ mode: 'stream' })
  async *game(sinceSeq: number | undefined, signal: AbortSignal): AsyncIterable<readonly MudGameItem[]> {
    const since = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) ? sinceSeq : 0
    yield* feedGame(this.buffers, this.feeds, since, signal)
  }

  /**
   * UI 流 (日志/结构化决策/验证码事件; seq 契约同 game 流, log 类以 logSeq 优先去重)。
   */
  @Remote({ mode: 'stream' })
  async *ui(sinceSeq: number | undefined, signal: AbortSignal): AsyncIterable<readonly MudUiItem[]> {
    const since = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) ? sinceSeq : 0
    yield* feedUi(this.buffers, this.feeds, since, signal)
  }

  /** 世界快照流 (state 写入后节流推送; 替换语义 — 无回放, 打开即收下一份)。 */
  @Remote({ mode: 'stream' })
  async *world(signal: AbortSignal): AsyncIterable<MudWorldEvent> {
    yield* feedWorld(this.feeds, signal)
  }
}
