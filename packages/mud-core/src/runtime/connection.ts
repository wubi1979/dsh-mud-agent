/**
 * dsh-mud-core — 游戏连接注册表 (host half), 会话无关的传输层.
 *
 * 本模块只知道 **连接**: host/port、socket 状态、以及把 telnet 事件转发给调用方
 * 提供的 sink。它不认识 session, 也不持有 agent — 会话 → 连接 的绑定方向由
 * 上层 (MudSessionRuntime) 持有 (`runtime.connectionId`), 传输层永不回指会话。
 *
 * 这样一次 `dsh web` 进程可以并存多条连接 (多用户/多会话), 每条连接各自
 * 引擎、节流与应答桥; 连接的生命周期只由"打开/关闭它的人"决定。
 * @module @deepseek-ai/dsh-mud-core/runtime/connection
 */

import { TelnetClient } from '../network/telnet.ts'
import type { MudLine } from '../preprocess/ansi.ts'

/** 连接状态 (传输层视角)。 */
export type MudConnectionState = 'connecting' | 'connected' | 'idle'

/** 连接事件接收方 (由需要该连接数据的上层提供)。 */
export interface MudConnectionSink {
  /** 原始文本块 (终端渲染用, 含 ANSI)。 */
  onText(text: string): void
  /** 一个文本块的行 (感知/应答桥用)。 */
  onLines(lines: MudLine[]): void
  /** 协议边界 (GA/EOR): 帧切分点, 同时是投递结算点。 */
  onBoundary(kind: 'ga' | 'eor'): void
  /** GMCP 包 (权威状态同步)。 */
  onGmcp(pkg: string, payload: unknown): void
  /** socket 建立。 */
  onConnect(): void
  /** socket 关闭。 */
  onClose(): void
  /** 传输错误 (不自动重连; 重连由上层决定)。 */
  onError(err: Error): void
  /** 网络层协商日志。 */
  onLog(level: string, text: string): void
}

/** 一条已登记的游戏连接。 */
export interface MudConnection {
  readonly id: string
  readonly host: string
  readonly port: number
  readonly client: TelnetClient
  state: MudConnectionState
}

/** 连接注册表: 打开/查询/关闭连接, 并把事件转发给各自的 sink。 */
export class MudConnectionManager {
  private readonly byId = new Map<string, MudConnection>()
  private seq = 0

  /**
   * 打开一条新连接 (调用方负责建立 session → connection 绑定)。
   * @param target 服务器地址。
   * @param sink 该连接的事件接收方。
   * @returns 已登记的连接 (id 由本模块分配)。
   */
  open(target: { host: string; port: number }, sink: MudConnectionSink): MudConnection {
    this.seq += 1
    const id = `conn-${this.seq}`
    const client = new TelnetClient({ host: target.host, port: target.port })
    const connection: MudConnection = {
      id,
      host: target.host,
      port: target.port,
      client,
      state: 'connecting',
    }
    this.byId.set(id, connection)
    client.on('connect', () => {
      connection.state = 'connected'
      sink.onConnect()
    })
    client.on('text', (text: string) => sink.onText(text))
    client.on('parsed', (lines: MudLine[]) => sink.onLines(lines))
    client.on('boundary', (e: { kind: 'ga' | 'eor' }) => sink.onBoundary(e.kind))
    client.on('gmcp', (msg: { package: string; payload: unknown }) => sink.onGmcp(msg.package, msg.payload))
    client.on('error', (err: Error) => sink.onError(err))
    client.on('log', (e: { level: string; text: string }) => sink.onLog(e.level, e.text))
    client.on('close', () => {
      connection.state = 'idle'
      sink.onClose()
    })
    client.connect()
    return connection
  }

  /** 按 id 取连接 (缺省 undefined)。 */
  get(id: string): MudConnection | undefined {
    return this.byId.get(id)
  }

  /** 关闭并注销一条连接 (幂等)。 */
  close(id: string): void {
    const connection = this.byId.get(id)
    if (connection === undefined) return
    this.byId.delete(id)
    connection.state = 'idle'
    try { connection.client.close() } catch { /* socket already gone */ }
  }

  /** 当前全部连接 (诊断/状态快照; 不含会话信息)。 */
  list(): readonly MudConnection[] {
    return [...this.byId.values()]
  }

  /** 关闭全部连接 (插件 teardown)。 */
  closeAll(): void {
    for (const id of [...this.byId.keys()]) this.close(id)
  }
}
