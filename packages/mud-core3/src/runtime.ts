/**
 * mud-core3 runtime — 每会话运行时：持有 MUD 连接 + 行流状态。
 *
 * 每个账号（= 会话）一个 SessionRuntime 实例，随会话生命周期产生/消亡。
 * C2 只管连接管理（connect/disconnect + 简单 login）；投递/接入在 C3。
 *
 * 纯 TS，零宿主依赖。凭据经 CredentialResolver 注入（宿主接 credentials.resolve）。
 */

import { Mud } from './link/mud.ts'
import type { MudLine } from './link/line.ts'
import { ReadMachine, type ReadOpts, type ReadResult } from './read.ts'
import { GameScreen, type GameViewOptions } from './view/screen.ts'
import type { ConnState, ResolvedCredentials } from './roster.ts'

/** 连接参数。 */
export interface ConnectParams {
  readonly host: string
  readonly port: number
  readonly credentials: ResolvedCredentials
}

/** 工具面 read 参数（mud_send）：listen 判据 + 总超时（工具层注入缺省）。 */
export type MudReadOpts = ReadOpts & { cmd?: string }

/**
 * 单会话运行时。持有一条 MUD 连接，互不可见于其他会话。
 *
 * 生命周期：
 *   - register（建账号/agent/created）→ 创建实例（无连接）
 *   - connect → 建连 + login（发 name/pass，等待提示符或超时）
 *   - disconnect → 断连
 *   - dispose（session/disposed）→ 断连 + 清理
 */
export class SessionRuntime {
  readonly sessionId: string
  private readonly mud = new Mud()
  private state: ConnState = 'disconnected'
  /** 画面通道（C5）：无头屏 + follower 扇出；行/回显/状态在此汇合。 */
  private readonly screen: GameScreen
  /**
   * 行流缓冲（单一真相源）：所有行到达即入（录制），投递/裸读都从水位线之后
   * 拉取；环形上限，超出丢最旧。
   */
  private pendingLines: MudLine[] = []
  /** 录制上限（行）：挂机模式长期不收时，内存不随行数无界增长。 */
  private readonly recordLimit: number
  private dropped = 0
  private disposed = false
  /** 等待建连期间 socket 已终结（拒绝/对端关闭）——用于区分"失败"与"超时"。 */
  private connectAborted = false
  /**
   * read 竞速机（二期工具面）：行流的又一个消费者——行到达先过吞行判定，
   * 在途 read 时累积 + 判定收束。
   */
  private readonly readMachine = new ReadMachine()
  // 双水位线（行号空间 = MudLine.abs，单调递增；断线一并复位 = -1）：
  /** deliveredAbs —— 投递推进：已投递给 agent 的最远行号。 */
  private deliveredAbs = -1
  /** readAbs —— 工具读推进：最近一次 read 返回结果的最大行号。 */
  private readAbs = -1

  /** 行流回调（投递器武装定时器 / 日志接此；pull 模型下行内容不经此传递）。 */
  onLine: ((line: MudLine) => void) | null = null
  /** 断线回调（装配层接此标记断开）。 */
  onDisconnect: (() => void) | null = null
  /** 连接状态迁移回调（值变化才触发；C5.1 服务层接此广播状态帧）。 */
  onStateChange: ((state: ConnState) => void) | null = null

  /** 状态迁移（统一入口）：值变化才赋值并上抛，杜绝重复帧。 */
  private setState(next: ConnState): void {
    if (this.state === next) return
    this.state = next
    this.onStateChange?.(next)
  }
  /** 网络层日志回调（telnet 协商/断线/协议异常）；装配层接此写入会话日志。 */
  onLog: ((level: 'info' | 'error', text: string) => void) | null = null

  /** 账号名（roster accounts.name，register 注入）：send 回显前缀 `<账号名>@agent|user>` 用。 */
  accountName = ''

  /**
   * @param sessionId - 会话 id（= 账号 id）。
   * @param recordLimit - 录制缓冲上限行数（缺省 2000；超出丢最旧）。
   * @param view - 画面通道参数（scrollback/cols/maxBufferedBytes；缺省取内置缺省）。
   */
  constructor(sessionId: string, recordLimit = 2000, view?: GameViewOptions) {
    this.sessionId = sessionId
    this.recordLimit = recordLimit < 1 ? 1 : recordLimit
    this.screen = new GameScreen(sessionId, view)
    this.mud.onLog = (level, text) => { this.onLog?.(level, text) }
    this.readMachine.onLog = (level, text) => { this.onLog?.(level, text) }
    this.mud.onLine = line => {
      // 吞行判定永续（每行都过；本期钩子空缺）——'swallow' 行不进任何模型面
      // （pending/画面/投递/acc）。
      if (this.readMachine.onLine(line) === 'swallow') return
      this.pendingLines.push(line)
      const over = this.pendingLines.length - this.recordLimit
      if (over > 0) {
        this.pendingLines.splice(0, over)
        this.dropped += over
      }
      this.screen.write(line.raw + '\r\n')
      this.onLine?.(line)
    }
    // GA/EOR 边界（全仓唯一消费者）：read 竞速机的 gaCount 关窗判定。
    this.mud.onBoundary = () => { this.readMachine.onBoundary() }
    // 直发命令回显进画面（凭据走 sendCredential 不触发 onSend —— 永不进画面）。
    // 回显前缀 = 账号名@来源（agent 灰 / user 青），账号名由 register 注入。
    this.mud.onSend = (cmd, source) => { this.screen.echo(cmd, source, this.accountName) }
    this.mud.onDisconnect = () => {
      if (this.state === 'connecting') this.connectAborted = true
      // 断流处尾行已先行分发（mud.onClose 先 flush 再上抛断线），在途 read 带尾行收束。
      this.readMachine.onDisconnected()
      this.setState('disconnected')
      // 断线 = 水位与未投批次一并复位（pull 模型推论，与一期「断线复位」一致）：
      // 未投出的残留行随录制清空丢失；abs 空间不归零，重连后新行照常推进。
      this.pendingLines = []
      this.deliveredAbs = -1
      this.readAbs = -1
      this.screen.setState('disconnected')
      this.onDisconnect?.()
    }
  }

  get connected(): boolean {
    return this.state === 'connected' && this.mud.connected
  }

  get connState(): ConnState {
    return this.state
  }

  /** 画面通道（remote.mud.follow 经 service.screenOf 取用）。 */
  get view(): GameScreen {
    return this.screen
  }

  /** 自上次消费以来的待处理行（C3 投递水位用；C2 不消费）。 */
  get pendingLineCount(): number {
    return this.pendingLines.length
  }

  /** 因超出录制上限被丢弃的累计行数（观测用）。 */
  get droppedLineCount(): number {
    return this.dropped
  }

  // ── 水位线（pull 模型；doc/PLAN.md「二期详细设计 §4」）────────────

  /** 已见线 = max(deliveredAbs, readAbs)：agent 已经见过的行边界。 */
  get seenAbs(): number {
    return Math.max(this.deliveredAbs, this.readAbs)
  }

  /** pending 末端行号（admit 水位 = 接入时刻用；空 pending = -1）。 */
  get pendingEndAbs(): number {
    const last = this.pendingLines[this.pendingLines.length - 1]
    return last?.abs ?? -1
  }

  /** 取 abs > seen 的行（不推进水位——delivered 只推进到成功投出的批次）。 */
  takeLinesAfter(seen: number): MudLine[] {
    return this.pendingLines.filter(l => l.abs > seen)
  }

  /** 投出成功后推进 deliveredAbs（单调 max）。 */
  commitDelivered(abs: number): void {
    if (abs > this.deliveredAbs) this.deliveredAbs = abs
  }

  /**
   * 工具面 read（mud_send）：
   *   - 有 cmd：send 后等新行（acc 只收 send 后新行；应答行标记已见）；
   *   - 无 cmd（裸读）：pending 尾部 maxLines 行快照为 initial（含 admit 前录制行），
   *     不物理消费；返回时推进 readAbs = 结果末行号——裸读读过的行不再投递。
   * 未连接早退（reason: 'disconnected'）；send 失败同早退。
   */
  async read(opts: MudReadOpts): Promise<ReadResult> {
    if (this.disposed) throw new Error(`runtime ${this.sessionId} 已销毁，不能 read`)
    if (!this.connected) return { lines: [], reason: 'disconnected' }
    const initial = opts.cmd === undefined
      ? this.pendingLines.slice(Math.max(0, this.pendingLines.length - (opts.maxLines ?? 50)))
      : []
    if (opts.cmd !== undefined && !this.send(opts.cmd)) {
      return { lines: [], reason: 'disconnected' } // send 失败 = 已断开
    }
    // exactOptionalPropertyTypes：可选字段不收显式 undefined，条件展开组装。
    const readOpts: ReadOpts = {
      timeoutMs: opts.timeoutMs,
      ...(opts.until !== undefined ? { until: opts.until } : {}),
      ...(opts.failOn !== undefined ? { failOn: opts.failOn } : {}),
      ...(opts.gaCount !== undefined ? { gaCount: opts.gaCount } : {}),
      ...(opts.quietMs !== undefined ? { quietMs: opts.quietMs } : {}),
      ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    }
    const result = await this.readMachine.start(readOpts, initial)
    // 水位推进：read/裸读消费的行标记已见（turn/end 不再重复投）。
    const last = result.lines[result.lines.length - 1]
    if (last !== undefined && last.abs > this.readAbs) this.readAbs = last.abs
    return result
  }

  /**
   * 建连 + login。
   * 1. mud.connect(host, port)
   * 2. 等待连接建立（轮询 connected；连接在等待期终结则立即失败）
   * 3. 发送账号名（sendCredential）
   * 4. 等待短暂时间让服务器处理
   * 5. 发送密码（sendCredential）
   * 6. 再补发一次回车（pkuxkx 登录末尾等回车，缺它行流停在欢迎屏）
   * 任一步失败都销毁 socket —— 否则半开/残留连接会继续收数据并晚到 close 事件。
   * @param params 连接参数（host/port/credentials）
   * @param loginTimeoutMs login 等待超时（缺省 5000ms）
   */
  async connect(params: ConnectParams, loginTimeoutMs = 5000): Promise<void> {
    if (this.disposed) throw new Error(`runtime ${this.sessionId} 已销毁，不能 connect`)
    if (this.connected) return // 幂等
    if (this.state === 'connecting') throw new Error(`runtime ${this.sessionId} 正在连接`)

    this.setState('connecting')
    this.connectAborted = false
    this.screen.setState('connecting')
    const started = Date.now()
    this.mud.connect(params.host, params.port)

    // 等待连接建立；socket 在等待期终结（拒绝/对端关闭）时 state 会被置回 disconnected。
    // 读经 getter（connState）：直读 this.state 会被 TS 控制流收窄误判（setState 是方法调用）。
    const deadline = Date.now() + loginTimeoutMs
    while (!this.mud.connected && this.connState === 'connecting' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (!this.mud.connected) {
      const aborted = this.connectAborted
      this.setState('disconnected')
      this.mud.disconnect()
      throw new Error(aborted
        ? `连接 ${params.host}:${params.port} 失败（对端拒绝或关闭）`
        : `连接 ${params.host}:${params.port} 超时`)
    }

    this.setState('connected')
    this.screen.setState('connected')
    this.onLog?.('info', `TCP 已建立（${Date.now() - started}ms），发送账号名`)

    // login：发账号名 → 短暂等待 → 发密码
    // 第一期最简 login：不解析提示符、不做流程，直发 name/pass。
    // 服务器提示符形态各异（"您的英文名字：" / "请输入密码：" 等），
    // 实测后可改为等待特定提示再发；先直发保证最小可用。
    if (!this.mud.sendCredential(params.credentials.name)) {
      this.setState('disconnected')
      this.mud.disconnect()
      throw new Error(`连接 ${params.host}:${params.port} 在 login 前关闭`)
    }
    await new Promise(r => setTimeout(r, 200))
    if (!this.mud.sendCredential(params.credentials.pass)) {
      this.setState('disconnected')
      this.mud.disconnect()
      throw new Error(`连接 ${params.host}:${params.port} 在 login 中关闭`)
    }
    // 盲发回车（一期最简）：pkuxkx 类 MUD 在登录末尾等一次「回车」（欢迎页/普通
    // 模式解锁），不补这行则行流停在欢迎屏，房间之后的闲聊/进出全部不来。
    await new Promise(r => setTimeout(r, 200))
    if (!this.mud.sendCredential('')) {
      this.setState('disconnected')
      this.mud.disconnect()
      throw new Error(`连接 ${params.host}:${params.port} 在 login 收尾时关闭`)
    }
    this.onLog?.('info', '账号名/密码/回车已发送（等待服务器响应）')
  }

  /** 断连（幂等）。 */
  disconnect(): void {
    this.mud.disconnect()
    this.setState('disconnected')
  }

  /** 销毁（session/disposed 调用）：断连 + 标记已销毁。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect()
    this.pendingLines = []
    this.screen.dispose()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 直发命令（工具面 mud_send = 'agent'；未来输入回传 = 'user'，回显样式随之区分）。 */
  send(cmd: string, source: 'agent' | 'user' = 'agent'): boolean {
    return this.mud.send(cmd, source)
  }
}
