/**
 * dsh-mud-core — 连接运行时 (ConnectionRuntime), host half. 会话层。
 *
 * 会话的**连接域**职责收拢: 幂等 connect (connected/connecting 拒绝重入 —— 迟到的
 * connect 事件曾把新条目误标成双连接)、断开/释放、socket 事件接线、连接写出口
 * (`write`) 与登录凭据持有。会话侧的子系统复位 (分帧器/桥/投递/流程) **不在这里** ——
 * 通过 `events.onConnected/onClosed` 回调留在 `MudSessionRuntime`, 连接域与感知域
 * 以事件解耦 (数据面 onText/onLines/onBoundary/onGmcp 由会话提供、原样透传传输层)。
 *
 * 传输层 (`services/network/manager.ts`) 仍是会话无关的注册表; 本类是"会话 → 连接"
 * 绑定 (`connectionId`) 的唯一持有者, 方向单向、传输层永不回指。
 * @module @deepseek-ai/dsh-mud-core/runtime/session/connection-runtime
 */

import type { MudConnectionManager, MudConnectionSink } from '../../services/network/manager.ts'
import type { SessionCredentials } from '../credentials.ts'

/** 连接生命周期事件 (会话侧复位钩子)。 */
export interface ConnectionEvents {
  /** socket 建立 (会话侧: 复位感知/桥/分帧器/投递, 登录态归零)。 */
  onConnected(): void
  /** socket 关闭 (会话侧: 桥 close、队列清空、感知上下文作废)。 */
  onClosed(): void
  /** 传输错误 (会话侧: lastError 留痕; 不自动重连)。 */
  onError(message: string): void
}

export interface ConnectionRuntimeOptions {
  connections: MudConnectionManager
  defaultHost: string
  defaultPort: number
  log: (text: string) => void
  /** 网络层协商日志 (level === 'info' 才转发)。 */
  debug: (text: string) => void
  /** 数据面透传 (感知域, 会话提供)。 */
  onText(text: string): void
  onLines(lines: import('../../services/network/ansi.ts').MudLine[]): void
  onBoundary(kind: 'ga' | 'eor'): void
  onGmcp(pkg: string, payload: unknown): void
  events: ConnectionEvents
}

/** 连接当前信息 (status 快照用)。 */
export interface ConnectionInfo {
  state: 'idle' | 'connecting' | 'connected'
  host: string
  port: number
}

/**
 * 会话的连接运行时。一条会话至多绑定一条连接; `connect` 重入安全, 重连 =
 * 旧连接先 close 再 open (socket 已销毁时 close 为 no-op)。
 */
export class ConnectionRuntime {
  private connectionId: string | null = null
  private account: SessionCredentials | null = null

  constructor(private readonly opts: ConnectionRuntimeOptions) {}

  /** 当前绑定的连接 id (未连接 = null)。 */
  get id(): string | null {
    return this.connectionId
  }

  /** 登录凭据 (命令回显署名 + {name}/{pass} 插值源; 未设 = null)。 */
  get credentials(): SessionCredentials | null {
    return this.account
  }

  /** 传输层状态。 */
  get state(): 'idle' | 'connecting' | 'connected' {
    const c = this.connectionId === null ? undefined : this.opts.connections.get(this.connectionId)
    return (c?.state ?? 'idle') as 'idle' | 'connecting' | 'connected'
  }

  /** 当前连接信息 (host/port 缺省回落配置值; status 快照用)。 */
  get info(): ConnectionInfo {
    const c = this.connectionId === null ? undefined : this.opts.connections.get(this.connectionId)
    return {
      state: (c?.state ?? 'idle') as 'idle' | 'connecting' | 'connected',
      host: c?.host ?? this.opts.defaultHost,
      port: c?.port ?? this.opts.defaultPort,
    }
  }

  /**
   * 建立本会话的游戏连接。传输层只拿到 host/port; session → connection 绑定
   * 保存在本运行时。**重入防护**: connected/connecting 状态拒绝再次发起 ——
   * connecting 中重入曾泄漏旧 socket/flushTimer, 迟到的 connect 事件曾把新条目
   * 误标 connected (双连接)。
   * @param host 服务器主机 (缺省 config.defaultHost; 空串同样走缺省)。
   * @param port 端口 (缺省 config.defaultPort)。
   * @param account 登录账户 (命令回显署名 + {name}/{pass} 插值源; 只在提供时覆盖)。
   */
  connect(host?: string, port?: number, account?: SessionCredentials): void {
    const state = this.state
    if (state === 'connected' || state === 'connecting') return // 幂等: 已连接/连接中
    if (this.connectionId !== null) this.opts.connections.close(this.connectionId)
    if (account !== undefined) this.account = account
    const target = {
      host: host !== undefined && host.trim() !== '' ? host.trim() : this.opts.defaultHost,
      port: port ?? this.opts.defaultPort,
    }
    this.opts.log(`[SYS] 连接 ${target.host}:${target.port}${this.account !== null ? ` (${this.account.name})` : ''}`)
    const sink: MudConnectionSink = {
      onText: (text) => { this.opts.onText(text) },
      onLines: (lines) => { this.opts.onLines(lines) },
      onBoundary: (kind) => { this.opts.onBoundary(kind) },
      onGmcp: (pkg, payload) => { this.opts.onGmcp(pkg, payload) },
      onConnect: () => {
        this.opts.log('[SYS] 已连接')
        this.opts.events.onConnected()
      },
      onClose: () => {
        this.opts.log('[SYS] 连接关闭')
        this.opts.events.onClosed()
      },
      onError: (err) => {
        this.opts.log(`[SYS] 连接错误: ${err.message}`)
        this.opts.events.onError(err.message)
      },
      onLog: (level, text) => {
        if (level === 'info') this.opts.debug(`[NET] ${text}`)
      },
    }
    const connection = this.opts.connections.open(target, sink)
    this.connectionId = connection.id
  }

  /** 断开本会话连接 (未连接时空操作)。 */
  disconnect(): void {
    if (this.connectionId === null) return
    this.opts.log('[SYS] 手动断开')
    this.opts.connections.close(this.connectionId)
    this.connectionId = null
  }

  /** 释放 (dispose 路径): 关闭并解绑连接。 */
  close(): void {
    if (this.connectionId !== null) {
      this.opts.connections.close(this.connectionId)
      this.connectionId = null
    }
  }

  /** 真实写 socket (未连接 = false 并留痕; 队列 onSend 调用)。 */
  write(cmd: string): boolean {
    const connection = this.connectionId === null ? undefined : this.opts.connections.get(this.connectionId)
    if (connection === undefined || connection.state !== 'connected') {
      this.opts.log(`[发送] 忽略命令 (未连接): ${JSON.stringify(cmd)}`)
      return false
    }
    return connection.client.send(String(cmd))
  }
}
