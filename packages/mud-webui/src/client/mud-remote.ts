/**
 * dsh-mud-webui — MUD remote RPC surface (client half, core3).
 *
 * core3 的 remote.mud 命名空间只有 5 个方法：connect/disconnect/admit/stop/status。
 * 全部走 typert 生成的官方 RPC envelope（'mud-core3/remote' 工件）：mount 一次进
 * 页面 fiber，namespace 读取走 ctx.inject(['remote.mud'])，每个方法解包
 * RemoteResult（失败分支抛 RemoteError），调用点沿用 try/catch 语义。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-remote
 */

import TYPERT_REMOTE from 'mud-core3/remote'
// Type-only: pulls the TypertRemoteNamespaceMap augmentation (mud namespace) into the program.
import type {} from 'mud-core3/remote'
// Type-only: Remote 边界类型（日志条目、名册记录、画面帧、状态帧）由非根子路径导出。
import type { AccountRecord, GameFrame, LogEntry, ServerRecord } from 'mud-core3/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

/** 生成客户端的 mud 命名空间（名册 CRUD + connect/disconnect/admit/stop/status/logs，全类型化）。 */
export type MudNamespace = TypertClientRemote['mud']

/** 一条 MUD 会话日志条目（与宿主 mud-core3/types 同源）。 */
export type MudLogEntry = LogEntry

/** 宿主名册里的服务器记录（键 = workspaceId）。 */
export type MudServerRecord = ServerRecord

/** 宿主名册里的账号记录（键 = accountId = sessionId）。 */
export type MudAccountRecord = AccountRecord

/**
 * 状态流帧（watchStatus）：全量会话状态快照。边界收窄版——服务端 SessionStatus
 * 的 loggedIn/world（WorldEntry.value 为 unknown）不过 Remote 边界（typert 拒绝
 * unknown），此处与 status() 同型只收三字段；扩面随 T5 webui 状态呈现一起做。
 */
export interface MudStatusFrame {
  readonly sessions: readonly { sessionId: string; state: string; admitted: boolean }[]
}

/** 会话日志返回面（内存环 + 落盘目录）。 */
export interface MudSessionLog {
  readonly sessionId: string
  readonly entries: readonly MudLogEntry[]
  readonly fileTarget: string | null
}

/**
 * 页面唯一的 MUD RPC 控制器：mount 一次，全组件共享。
 * 每个 RPC 方法解包 `RemoteResult`（失败分支抛 RemoteError），调用点各自 catch。
 */
export class MudRemoteController {
  private mud: MudNamespace | null = null

  /** 贡献项是否已 $mount 成功（与 namespace 读取分离：重试只重做读取，不重复挂载）。 */
  private contributionMounted = false

  /** 最近一次 mount 失败的原因（成功后清空；调用报错时附带显示真实原因）。 */
  mountError: string | null = null

  /**
   * Mount the generated Host-for-Client contribution into the page fiber.
   * @param ctx - client root context（需宿主已加载 gateway client 的 remote 服务）。
   * @returns 类型化 mud 命名空间。
   */
  async mount(ctx: ClientContext): Promise<MudNamespace> {
    const remote = ctx.get('remote') as TypertClientRemote | undefined
    if (remote === undefined) throw new Error('[mud] ctx.remote 不可用（gateway client 未加载）')
    // $mount 不可重入：官方 validateContribution 在"已挂载同名方法"时抛 already
    // mounted，因此成功过就绝不再调 —— 重试只重做下面的 namespace 读取。
    if (!this.contributionMounted) {
      try {
        await remote.$mount(TYPERT_REMOTE)
      } catch (err) {
        // $mount 纯客户端本地校验/注册（不发网络请求），失败即 descriptor 问题。
        // 记录原因供调用侧报错附带，避免只看到"尚未挂载"而无从排查。
        this.mountError = err instanceof Error ? err.message : String(err)
        throw err
      }
      this.contributionMounted = true
    }
    // namespace 属性访问器（remote.mud）是 cordis accessor：必须在声明了
    // 'remote.mud' inject 的 fiber 里读取，直接 remote.mud 会抛
    // cannot get property "remote.mud" without inject。
    this.mud = await new Promise<MudNamespace>((resolve, reject) => {
      const handle = ctx.inject(['remote.mud'], (injected: ClientContext) => {
        resolve((injected as unknown as { remote: TypertClientRemote }).remote.mud)
      })
      void Promise.resolve(handle).catch(reject)
    })
    this.mountError = null
    return this.mud
  }

  /** 是否已挂载（调用前判据）。 */
  get ready(): boolean {
    return this.mud !== null
  }

  /** 解包一次 RPC 调用（未挂载 / 失败分支均抛；未挂载报错附带真实挂载失败原因）。 */
  private async call<T>(run: (mud: MudNamespace) => Promise<RemoteResult<T>>): Promise<T> {
    const mud = this.mud
    if (mud === null) {
      throw new Error(this.mountError !== null
        ? `[mud] remote 尚未挂载（挂载失败: ${this.mountError}）`
        : '[mud] remote 尚未挂载')
    }
    const result = await run(mud)
    if (!result.ok) throw result.error
    return result.value
  }

  /** 建连 + login（服务器/凭据在宿主侧 roster 查找）。 */
  connect(sessionId: string): Promise<{ sessionId: string; state: string }> {
    return this.call(mud => mud.connect(sessionId))
  }

  /**
   * 跟随某会话的画面流（首帧 snapshot 整屏，随后 output/state 增量）。
   * 流动词不返回 RemoteResult：直接给 AsyncIterable；signal abort 即停，
   * 服务端 follower 随之清理（typert cancellation 走 descriptor 声明的 signal 参数）。
   */
  follow(sessionId: string, signal?: AbortSignal): AsyncIterable<GameFrame> {
    const mud = this.mud
    if (mud === null) {
      throw new Error(this.mountError !== null
        ? `[mud] remote 尚未挂载（挂载失败: ${this.mountError}）`
        : '[mud] remote 尚未挂载')
    }
    return mud.follow(sessionId, signal)
  }

  /**
   * 会话状态流（C5.1，follow 同型）：首帧全量快照，随后仅在状态变化时推帧
   * （服务端事件推送，无轮询）。signal abort 即停并清服务端订阅；
   * status() 单次动词保留做初始回填/兜底。
   */
  watchStatus(signal: AbortSignal): AsyncIterable<MudStatusFrame> {
    const mud = this.mud
    if (mud === null) {
      throw new Error(this.mountError !== null
        ? `[mud] remote 尚未挂载（挂载失败: ${this.mountError}）`
        : '[mud] remote 尚未挂载')
    }
    return mud.watchStatus(signal)
  }

  // ── 名册（宿主侧持久：storage 域，重启不丢）────────────────────

  /** 服务器名册（键 = workspaceId）。 */
  servers(): Promise<{ servers: readonly MudServerRecord[] }> {
    return this.call(mud => mud.servers())
  }

  /** 建服务器（工作区实体由页面先用 workspaces.create 建好，这里只登记 host/port/name）。 */
  addServer(record: MudServerRecord): Promise<{ server: MudServerRecord }> {
    return this.call(mud => mud.addServer(record))
  }

  /** 删服务器（该服务器下仍有账号时拒绝）。 */
  removeServer(workspaceId: string): Promise<{ workspaceId: string; removed: boolean }> {
    return this.call(mud => mud.removeServer(workspaceId))
  }

  /** 账号名册（键 = accountId = sessionId）。 */
  accounts(): Promise<{ accounts: readonly MudAccountRecord[] }> {
    return this.call(mud => mud.accounts())
  }

  /**
   * 建账号 = 一个动作：宿主写名册 → 建会话（sessionId = 账号 id，绑定 preset）。
   * 密码先经 `remote.credentials.set(passRef, …)` 写入宿主凭据域，这里只传引用名。
   */
  addAccount(input: {
    serverId: string; name: string; passRef: string; preset: string; cwd: string
  }): Promise<{ account: MudAccountRecord }> {
    return this.call(mud => mud.addAccount(input))
  }

  /** 删账号：清宿主名册 + 清该账号日志（会话销毁由宿主侧负责）。 */
  removeAccount(sessionId: string): Promise<{ sessionId: string; removed: boolean }> {
    return this.call(mud => mud.removeAccount(sessionId))
  }

  /** 断连。 */
  disconnect(sessionId: string): Promise<{ sessionId: string; state: string }> {
    return this.call(mud => mud.disconnect(sessionId))
  }

  /** 接入：MUD 信息开始进入 agent。 */
  admit(sessionId: string): Promise<{ sessionId: string; admitted: boolean }> {
    return this.call(mud => mud.admit(sessionId))
  }

  /** 停止接入：MUD 信息不再进入 agent。 */
  stop(sessionId: string): Promise<{ sessionId: string; admitted: boolean }> {
    return this.call(mud => mud.stop(sessionId))
  }

  /** 连接状态 + 接入状态（轮询回填）。 */
  status(sessionId?: string): Promise<{
    state: string
    admitted: boolean
    sessions: readonly { sessionId: string; state: string; admitted: boolean }[]
  }> {
    return this.call(mud => mud.status(sessionId))
  }

  /**
   * 会话日志：内存环条目（运行/网络/投递/闸门事件）+ 落盘目录。
   * 连接失败的原因在这里；原始行流只落盘，从 fileTarget 目录读。
   */
  logs(sessionId: string): Promise<MudSessionLog> {
    return this.call(mud => mud.logs(sessionId))
  }
}
