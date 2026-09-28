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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

/** 生成客户端的 mud 命名空间（connect/disconnect/admit/stop/status，全类型化）。 */
export type MudNamespace = TypertClientRemote['mud']

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
}
