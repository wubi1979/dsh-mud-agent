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
  /** 行流缓冲（C3 投递用；C2 只积累不消费）。 */
  private pendingLines: MudLine[] = []
  private disposed = false

  /** 行流回调（C3 聚合投递接此；C2 可选，测试用）。 */
  onLine: ((line: MudLine) => void) | null = null
  /** 断线回调（装配层接此标记断开）。 */
  onDisconnect: (() => void) | null = null

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.mud.onLine = line => {
      this.pendingLines.push(line)
      this.onLine?.(line)
    }
    this.mud.onDisconnect = () => {
      this.state = 'disconnected'
      this.pendingLines = []
      this.onDisconnect?.()
    }
  }

  get connected(): boolean {
    return this.state === 'connected' && this.mud.connected
  }

  get connState(): ConnState {
    return this.state
  }

  /** 自上次消费以来的待处理行（C3 投递水位用；C2 不消费）。 */
  get pendingLineCount(): number {
    return this.pendingLines.length
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
   * 2. 等待连接建立（轮询 connected，超时 5s）
   * 3. 发送账号名（sendCredential）
   * 4. 等待短暂时间让服务器处理
   * 5. 发送密码（sendCredential）
   * @param params 连接参数（host/port/credentials）
   * @param loginTimeoutMs login 等待超时（缺省 5000ms）
   */
  async connect(params: ConnectParams, loginTimeoutMs = 5000): Promise<void> {
    if (this.disposed) throw new Error(`runtime ${this.sessionId} 已销毁，不能 connect`)
    if (this.connected) return // 幂等

    this.state = 'connecting'
    this.mud.connect(params.host, params.port)

    // 等待连接建立
    const deadline = Date.now() + loginTimeoutMs
    while (!this.mud.connected && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (!this.mud.connected) {
      this.state = 'disconnected'
      throw new Error(`连接 ${params.host}:${params.port} 超时`)
    }

    this.state = 'connected'

    // login：发账号名 → 短暂等待 → 发密码
    // 第一期最简 login：不解析提示符、不做流程，直发 name/pass。
    // 服务器提示符形态各异（"您的英文名字：" / "请输入密码：" 等），
    // 实测后可改为等待特定提示再发；先直发保证最小可用。
    this.mud.sendCredential(params.credentials.name)
    await new Promise(r => setTimeout(r, 200))
    this.mud.sendCredential(params.credentials.pass)
  }

  /** 断连（幂等）。 */
  disconnect(): void {
    this.mud.disconnect()
    this.state = 'disconnected'
  }

  /** 销毁（session/disposed 调用）：断连 + 标记已销毁。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect()
    this.pendingLines = []
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 直发命令（C2 不暴露给模型；C3+ 工具面用）。 */
  send(cmd: string): boolean {
    return this.mud.send(cmd)
  }
}
