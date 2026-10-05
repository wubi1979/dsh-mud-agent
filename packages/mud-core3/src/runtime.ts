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
import type { KeepaliveOptions, ProbeState } from './link/keepalive.ts'
import { ReadMachine, type ReadOpts, type ReadResult } from './read.ts'
import { GameScreen, type GameViewOptions } from './view/screen.ts'
import { World, type LoggedInState, type WorldSnapshot } from './world.ts'
import { Classifier } from './classify.ts'
import type { ConnState } from './roster.ts'

// 类型面 re-export（E2E/流程环境按 read/recentLines 签名桥接用）。
export type { MudLine, ReadOpts, ReadResult }

/**
 * 登录轴声明判据（行文推断用）：与 flows/login.ts 成功判据同源——
 * 「欢迎来到」与建连横幅「欢迎来到北大侠客行」撞车不可用（见 login.ts 文件头勘误），
 * 以「目前权限：(player)」「重新连线完毕」为准。
 */
const WELCOME_RE = /目前权限：\(player\)|重新连线完毕/

/** 连接参数（三期裁定：connect 只建连，登录由脚本要点执行——盲发退役）。 */
export interface ConnectParams {
  readonly host: string
  readonly port: number
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
  private readonly mud: Mud
  private state: ConnState = 'disconnected'
  /** 登录轴（三期两轴状态）：GMCP 是权威登录信号，断线复位为 unknown。 */
  private loggedInState: LoggedInState = 'unknown'
  /** 世界状态（三期）：GMCP 事件写入，断线整体复位（重连后由 GMCP 重新建立）。 */
  private readonly worldState = new World()
  /** 画面通道（C5）：无头屏 + follower 扇出；行/回显/状态在此汇合。 */
  private readonly screen: GameScreen
  /** 行分类器（C5.2）：行路径单点打标（mark 就地写 line.kind）。 */
  private readonly classifier: Classifier
  /** 行流缓冲（单一真相：录制 + 工具裸读源 + 投递拉取源；环形上限，超出丢最旧）。 */
  private pendingLines: MudLine[] = []
  /** 录制上限（行）：挂机模式长期不收时，内存不随行数无界增长。 */
  private readonly recordLimit: number
  private dropped = 0
  private disposed = false
  /** D4 自动重连闸门标记①：曾建连成功（TCP 握手完成即置，不要求已登录）。 */
  private hasConnectedFlag = false
  /** D4 自动重连闸门标记②：手工断连（手工 disconnect 置位，connect 成功清除）。 */
  private manualDisconnectedFlag = false
  /** 等待建连期间 socket 已终结（拒绝/对端关闭）——用于区分"失败"与"超时"。 */
  private connectAborted = false
  // 水位线（§4.3，行号空间 = MudLine.abs）：已见线 seen = max(delivered, read)。
  // 初始/断线重置 = -1。abs 跨重连不归零，pending 清空后新行照常被拉取。
  /** 投递水位：已成功投递给 agent 的最远行号。 */
  private deliveredAbs = -1
  /** 工具读水位：最近一次 read 返回结果的最远行号（裸读/应答行不再投递）。 */
  private readAbs = -1
  /** 末端行号（最后一行行号；尚无行 = -1）—— admit 水位 = 接入时刻用。 */
  private lastLineAbs = -1
  /** read 竞速机（工具面等待引擎；行路径挂为第二消费者）。 */
  private readonly readMachine = new ReadMachine()
  /** 会话级发送持有者（PLAN 三期「行流持有者」）：同一时刻只允许一个执行体在 send+read。 */
  private sendHolder: string | null = null

  /** 账号名（roster accounts.name，register 注入）：send 回显前缀 `<账号名>@agent|user>` 用。 */
  accountName = ''

  /** 行流回调（C3 聚合投递接此；C2 可选，测试用）。 */
  onLine: ((line: MudLine) => void) | null = null
  /** 行到达钩子（T4a 静默唤醒 re-arm 接此；每行一次，与投递无关）。 */
  onActivity: (() => void) | null = null
  /** 断线回调（装配层接此标记断开）。 */
  onDisconnect: (() => void) | null = null
  /** 连接状态迁移回调（值变化才触发；C5.1 服务层接此广播状态帧）。 */
  onStateChange: ((state: ConnState) => void) | null = null
  /** 登录轴/世界状态变化回调（GMCP 到达等；服务层接此广播状态帧）。 */
  onWorldChange: (() => void) | null = null

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
   * @param classifier - 行分类器（C5.2 单点打标用；缺省内置缺省规则表）。
   * @param keepalive - 半开探活参数（T12：Config probeStartMs/probeRetryMs/
   *   probeMaxAttempts 注入面；缺省 90s 首发 / 9s 重发 / 3 次上限）。
   * @param busy - busy 谓词（T12 D4：holderBusy || isInTurn，service 合成注入；
   *   link 层探测 tick 为真时跳过——AYT 应答 GA 会截断在途 read 等待窗）。
   */
  constructor(
    sessionId: string,
    recordLimit = 2000,
    view?: GameViewOptions,
    classifier?: Classifier,
    keepalive?: KeepaliveOptions,
    busy?: () => boolean,
  ) {
    this.sessionId = sessionId
    this.recordLimit = recordLimit < 1 ? 1 : recordLimit
    this.screen = new GameScreen(sessionId, view)
    this.classifier = classifier ?? new Classifier()
    this.mud = new Mud({
      ...(keepalive === undefined ? {} : { keepalive }),
      ...(busy === undefined ? {} : { isBusy: busy }),
    })
    this.mud.onLog = (level, text) => { this.onLog?.(level, text) }
    this.readMachine.onLog = (level, text) => { this.onLog?.(level, text) }
    // 行路径（单一真相，多消费者按序）：⓪分类单点打标 → ①pending 录制（永远）
    // → ②read 在途累积判定 → ③投递（onLine 回调 → Deliverer 水位拉取）。
    this.mud.onLine = line => {
      // C5.2：全系统唯一一次分类——先于录制/画面路由/投递，保证所有消费者看到 kind。
      this.classifier.mark(line)
      this.pendingLines.push(line)
      const over = this.pendingLines.length - this.recordLimit
      if (over > 0) {
        this.pendingLines.splice(0, over)
        this.dropped += over
      }
      this.lastLineAbs = line.abs
      // 画面路由（C5.2）：无标行走主屏无头屏（零改动），有标行追加副屏行环。
      this.screen.write(line.raw + '\r\n', line.kind)
      // 登录轴低置信度先行：声明判据命中（已连接且未确认）→ inferred，
      // 后续 GMCP 到达加固为 in-game（判据见 WELCOME_RE 注释与 login.ts 勘误）。
      if (this.state === 'connected' && this.loggedInState === 'unknown' && WELCOME_RE.test(line.text)) {
        this.loggedInState = 'inferred'
        this.onWorldChange?.()
      }
      this.readMachine.onLine(line)
      this.onActivity?.()
      this.onLine?.(line)
    }
    // GA/EOR 边界 → read 在途时推进 gaCount 判定（工具面"一段完整文字"关窗）。
    this.mud.onBoundary = () => { this.readMachine.onBoundary() }
    // 直发命令回显进画面（凭据走 sendCredential 不触发 onSend —— 永不进画面）。
    // 回显前缀 = 账号名@来源（agent 灰 / user 青），账号名由 register 注入。
    this.mud.onSend = (cmd, source) => { this.screen.echo(cmd, source, this.accountName) }
    // GMCP → 登录轴 + 世界状态（三期）：
    // GMCP 是权威登录信号（不依赖行文匹配）——服务器进入游戏后才发 GMCP 包，
    // 到达即置 in-game（覆盖行文推断的 inferred，不降级）并写入 world
    // （zone='gmcp'，key=包名，后到覆盖）。
    this.mud.onGmcp = msg => {
      this.loggedInState = 'in-game'
      this.worldState.set('gmcp', msg.package, msg.payload, 'measured', { kind: 'gmcp', time: Date.now() })
      this.onWorldChange?.()
    }
    this.mud.onDisconnect = () => {
      if (this.state === 'connecting') this.connectAborted = true
      this.setState('disconnected')
      // 断线同时反转两轴 + 世界状态复位（重连后由 GMCP 重新置位/写入）。
      this.loggedInState = 'unknown'
      this.worldState.clear()
      this.onWorldChange?.()
      this.pendingLines = []
      // 水位线复位（§4.3/§4.5：初始/断线 = -1）+ 在途 read 以 disconnected 收束。
      this.deliveredAbs = -1
      this.readAbs = -1
      this.readMachine.onDisconnected()
      this.screen.setState('disconnected')
      this.onDisconnect?.()
    }
  }

  get connected(): boolean {
    return this.state === 'connected' && this.mud.connected
  }

  /** D4 闸门标记①：曾建连成功（冷启动/新 runtime 为 false ⇒ 设计保证不自动重连）。 */
  get hasConnected(): boolean {
    return this.hasConnectedFlag
  }

  /** D4 闸门标记②：手工断连（true ⇒ 不自动重连，等人工）。 */
  get manualDisconnected(): boolean {
    return this.manualDisconnectedFlag
  }

  get connState(): ConnState {
    return this.state
  }

  /** 探活观测态（T5.1 只读透传；不回写 conn 三态，现役「已连接」判据零改动）。 */
  get probeState(): ProbeState {
    return this.mud.probeState
  }

  /**
   * 显式静默武装缝（T5.1 C3）：现役只在行到达时 arm（runtime.onActivity），
   * 重连成功点无行可达时由重连编排调用此缝补一脚——保证提示符静默期
   * 到期唤醒链路照样推进 agent（探活已下沉 link 层自驱，T12 D5）。
   */
  pulseActivity(): void {
    this.onActivity?.()
  }

  /** 登录轴（GMCP 权威信号；断线复位 unknown）。 */
  get loggedIn(): LoggedInState {
    return this.loggedInState
  }

  /** 世界状态快照（分区/置信度/来源；只读拷贝）。 */
  get world(): WorldSnapshot {
    return this.worldState.snapshot()
  }

  /** 画面通道（remote.mud.follow 经 service.screenOf 取用）。 */
  get view(): GameScreen {
    return this.screen
  }

  /** 自上次消费以来的待处理行数（观测用）。 */
  get pendingLineCount(): number {
    return this.pendingLines.length
  }

  /** 因超出录制上限被丢弃的累计行数（观测用）。 */
  get droppedLineCount(): number {
    return this.dropped
  }

  /** 行流持有者是否在途（read/send 持有中；静默唤醒守卫用）。 */
  get holderBusy(): boolean {
    return this.sendHolder !== null
  }

  // ── 水位线面（Deliverer 的 DeliverySource 注入面 + 工具面裸读）────────

  /** 已见线 seen = max(deliveredAbs, readAbs)：agent 已经见过的行边界。 */
  seenAbs(): number {
    return Math.max(this.deliveredAbs, this.readAbs)
  }

  /** 末端行号（最后一行行号；尚无行 = -1）。 */
  lastAbs(): number {
    return this.lastLineAbs
  }

  /** 已见线之后的待投行（快照；行仍留在 pending 环里，不物理消费）。 */
  linesAfter(seen: number): MudLine[] {
    return this.pendingLines.filter(l => l.abs > seen)
  }

  /** 推进投递水位（只到成功投出的批次；Deliverer 成功批次尾行号）。 */
  markDelivered(abs: number): void {
    if (abs > this.deliveredAbs) this.deliveredAbs = abs
  }

  /** pending 尾部 N 行快照（裸读 initial 源；不物理消费）。 */
  recentLines(n: number): MudLine[] {
    return n <= 0 ? [] : this.pendingLines.slice(-n)
  }

  /** 工具读水位（readAbs；流程 io 的 initial 快照按此过滤——已消费行不重入后续窗口）。 */
  readWatermark(): number {
    return this.readAbs
  }

  /**
   * read（工具面等待引擎）：在途 fail-loud；未连接直接以 disconnected 收束
   * （不启动等待）。返回时推进 readAbs = 结果行与 initial 的最远行号——
   * 裸读/应答行标记已见，turn/end 不再重复投递（§4.3 水位线语义）。
   */
  async read(opts: ReadOpts, initial: readonly MudLine[] = []): Promise<ReadResult> {
    if (!this.connected) return { lines: [], reason: 'disconnected', hit: undefined }
    const result = await this.readMachine.start(opts, initial)
    const tails = [result.lines, initial].map(lines => lines.at(-1)?.abs ?? -1)
    const maxAbs = Math.max(...tails)
    if (maxAbs > this.readAbs) this.readAbs = maxAbs
    return result
  }

  /**
   * 建连（幂等；**只建连不登录**——盲发已退役，登录由登录脚本经 sendCredential
   * 提示符驱动执行）。
   * 1. mud.connect(host, port)
   * 2. 等待连接建立（轮询 connected；连接在等待期终结则立即失败）
   * 任一步失败都销毁 socket —— 否则半开/残留连接会继续收数据并晚到 close 事件。
   * @param params 连接参数（host/port）
   * @param connectTimeoutMs 建连等待超时（缺省 5000ms）
   */
  async connect(params: ConnectParams, connectTimeoutMs = 5000): Promise<void> {
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
    const deadline = Date.now() + connectTimeoutMs
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
    // D4 标记维护：建连成功即置「曾连接」（不要求已登录）、清「手工断连」。
    this.hasConnectedFlag = true
    this.manualDisconnectedFlag = false
    this.screen.setState('connected')
    this.onLog?.('info', `TCP 已建立（${Date.now() - started}ms），等待登录脚本（connect 只建连）`)
  }

  /** 断连（幂等）：手工断连——置 D4 标记②，之后意外断开闸门才不会误触自动重连。 */
  disconnect(): void {
    this.manualDisconnectedFlag = true
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

  /** 直发命令（C2 不暴露给模型；C3+ 工具面用；source 区分回显样式）。 */
  send(cmd: string, source: 'agent' | 'user' = 'agent'): boolean {
    return this.mud.send(cmd, source)
  }

  /**
   * 凭据专用直发（登录脚本用）：行为同 send，但不触发 onSend —— 不进画面回显、
   * 不进会话日志（凭据零泄露的发送侧闸门；明文只经此路径上 socket）。
   */
  sendCredential(cmd: string): boolean {
    return this.mud.sendCredential(cmd)
  }

  /**
   * 获取发送权（会话级独占）：根与子 agent 都可能发命令（"争半截应答"），
   * 冲突即拒绝——同一时刻只允许一个执行体在 send+read（PLAN 三期「行流持有者」）。
   * 同 holder 重入成功（同执行体串行调用不自我冲突）。
   * @param holder - 执行体标识（调用方会话 id）。
   * @returns false = 已被其他执行体持有（调用方给可读拒绝，不劈半应答）。
   */
  acquireSend(holder: string): boolean {
    if (this.sendHolder !== null && this.sendHolder !== holder) return false
    this.sendHolder = holder
    return true
  }

  /** 释放发送权（只解除自己的持有）。 */
  releaseSend(holder: string): void {
    if (this.sendHolder === holder) this.sendHolder = null
  }
}
