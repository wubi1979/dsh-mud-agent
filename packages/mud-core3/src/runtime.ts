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
import { GameScreen, type GameViewOptions } from './view/screen.ts'
import type { ConnState, ResolvedCredentials } from './roster.ts'

/** 连接参数。 */
export interface ConnectParams {
  readonly host: string
  readonly port: number
  readonly credentials: ResolvedCredentials
}

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
  /** 行流缓冲（未接入=录制 / 后续工具裸读用；环形上限，超出丢最旧）。 */
  private pendingLines: MudLine[] = []
  /** 录制上限（行）：挂机模式长期不收时，内存不随行数无界增长。 */
  private readonly recordLimit: number
  private dropped = 0
  private disposed = false
  /** 等待建连期间 socket 已终结（拒绝/对端关闭）——用于区分"失败"与"超时"。 */
  private connectAborted = false

  /** 行流回调（C3 聚合投递接此；C2 可选，测试用）。 */
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
    this.mud.onLine = line => {
      this.pendingLines.push(line)
      const over = this.pendingLines.length - this.recordLimit
      if (over > 0) {
        this.pendingLines.splice(0, over)
        this.dropped += over
      }
      this.screen.write(line.raw + '\r\n')
      this.onLine?.(line)
    }
    // 直发命令回显进画面（凭据走 sendCredential 不触发 onSend —— 永不进画面）。
    this.mud.onSend = cmd => { this.screen.echo(cmd) }
    this.mud.onDisconnect = () => {
      if (this.state === 'connecting') this.connectAborted = true
      this.setState('disconnected')
      this.pendingLines = []
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

  /** 消费并清空待处理行（C3 投递后调用）。 */
  consumePendingLines(): MudLine[] {
    const lines = this.pendingLines
    this.pendingLines = []
    return lines
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

  /** 直发命令（C2 不暴露给模型；C3+ 工具面用）。 */
  send(cmd: string): boolean {
    return this.mud.send(cmd)
  }
}
