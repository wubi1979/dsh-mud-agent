/**
 * mud-core3 service — 多会话管理：registry + connect/disconnect/status + admit/stop。
 *
 * 纯 TS，零宿主依赖。宿主接线层（index.ts）注入：
 *   - serverLookup: sessionId → ServerRecord
 *   - accountLookup: sessionId → AccountRecord
 *   - resolveCreds: passRef → { name, pass }
 *   - deliver: (sessionId, text) => void  — 投递回调（agent.followup + createUserMessage）
 * 测试注入内存实现。
 *
 * 职责：
 *   - 维护 Map<sessionId, SessionRuntime>
 *   - register(sessionId)：登记会话 + 创建 Deliverer
 *   - connect(sessionId)：查服务器+解析凭据 → runtime.connect
 *   - disconnect(sessionId)：runtime.disconnect
 *   - admit(sessionId)：接入闸门开（投递通道开）
 *   - stop(sessionId)：停止接入（投递停）
 *   - status(sessionId)：连接状态 + 接入状态
 *   - dispose(sessionId)：断连 + 拆 runtime + 拆 deliverer
 *   - disposeAll()：插件卸载用
 */

import { SessionRuntime, type ConnectParams } from './runtime.ts'
import { Deliverer, type DeliverFn, type DelivererConfig } from './deliver.ts'
import type {
  AccountLookup,
  ConnState,
  CredentialResolver,
  ServerLookup,
} from './roster.ts'

/** 服务依赖（宿主/测试注入）。 */
export interface MudServiceDeps {
  readonly serverLookup: ServerLookup
  readonly accountLookup: AccountLookup
  readonly resolveCreds: CredentialResolver
  /** 投递回调：MUD 行流聚合后以用户消息投递进会话（agent.followup）。 */
  readonly deliver?: DeliverFn
  /** 投递器配置（静默窗口等）。 */
  readonly delivererConfig?: DelivererConfig
}

/** 连接状态快照（remote status 返回面）。 */
export interface SessionStatus {
  readonly sessionId: string
  readonly state: ConnState
  readonly admitted: boolean
}

/** 连接结果。 */
export interface ConnectResult {
  readonly sessionId: string
  readonly state: ConnState
}

/** 多会话管理服务。 */
export class MudService {
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly deliverers = new Map<string, Deliverer>()
  private readonly deps: MudServiceDeps

  constructor(deps: MudServiceDeps) {
    this.deps = deps
  }

  /** 登记会话（agent/created 调用；幂等）。创建 Deliverer 并接线到 runtime.onLine。 */
  register(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (rt !== undefined) return rt
    rt = new SessionRuntime(sessionId)
    this.runtimes.set(sessionId, rt)

    // 创建 Deliverer 并接线
    if (this.deps.deliver !== undefined) {
      const del = new Deliverer(sessionId, this.deps.deliver, this.deps.delivererConfig)
      this.deliverers.set(sessionId, del)
      // 行流到达 → Deliverer.onLine（未接入时只积累）
      rt.onLine = _line => del.onLine(_line)
    }

    return rt
  }

  /** 取运行时（工具/投递用；不存在返回 null）。 */
  get(sessionId: string): SessionRuntime | null {
    return this.runtimes.get(sessionId) ?? null
  }

  /** 取投递器（测试/观测用）。 */
  getDeliverer(sessionId: string): Deliverer | null {
    return this.deliverers.get(sessionId) ?? null
  }

  /** 建连 + login。 */
  async connect(sessionId: string): Promise<ConnectResult> {
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) throw new Error(`会话 ${sessionId} 未登记`)
    if (rt.isDisposed) throw new Error(`会话 ${sessionId} 已销毁`)

    const server = this.deps.serverLookup(sessionId)
    if (server === undefined) throw new Error(`会话 ${sessionId} 未绑定服务器`)

    const account = this.deps.accountLookup(sessionId)
    if (account === undefined) throw new Error(`会话 ${sessionId} 未在 roster`)

    const credentials = await this.deps.resolveCreds(account.passRef)

    const params: ConnectParams = {
      host: server.host,
      port: server.port,
      credentials,
    }
    await rt.connect(params)
    return { sessionId, state: rt.connState }
  }

  /** 断连。 */
  disconnect(sessionId: string): void {
    this.runtimes.get(sessionId)?.disconnect()
  }

  /** 接入：MUD 信息开始进入 agent（投递通道开；水位 = 当前时刻）。 */
  admit(sessionId: string): void {
    this.deliverers.get(sessionId)?.admit()
  }

  /** 停止接入：MUD 信息不再进入 agent（投递停；行流照常积累）。 */
  stop(sessionId: string): void {
    this.deliverers.get(sessionId)?.stop()
  }

  /** 连接状态 + 接入状态。 */
  status(sessionId: string): SessionStatus {
    const rt = this.runtimes.get(sessionId)
    const del = this.deliverers.get(sessionId)
    return {
      sessionId,
      state: rt?.connState ?? 'disconnected',
      admitted: del?.isAdmitted ?? false,
    }
  }

  /** 全部会话状态（管理面用）。 */
  statuses(): readonly SessionStatus[] {
    return [...this.runtimes.keys()].map(id => this.status(id))
  }

  /** 销毁会话（session/disposed 调用）：断连 + 拆 runtime + 拆 deliverer。 */
  dispose(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (rt === undefined) return
    this.deliverers.get(sessionId)?.dispose()
    this.deliverers.delete(sessionId)
    rt.dispose()
    this.runtimes.delete(sessionId)
  }

  /** 销毁全部（插件卸载用）。 */
  disposeAll(): void {
    for (const id of [...this.runtimes.keys()]) this.dispose(id)
  }

  /** 当前会话数（测试/观测用）。 */
  get size(): number {
    return this.runtimes.size
  }
}
