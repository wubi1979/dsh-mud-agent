/**
 * dsh-mud-webui — MUD remote RPC surface (client half).
 *
 * 把 `ctx.remote.mud.*` (typert 生成客户端, `@deepseek-ai/dsh-mud-core/remote`
 * 工件) 收口为一个控制器: 页面全部宿主调用 (bind/connect/command/...) 走
 * 官方 RPC envelope + 信任围栏, 不再自拼 fetch('/mud/...')。挂载完成前调用
 * 一律抛错 (调用点各自 catch), 流消费由 MudSocketController 在 mount 后接入。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-remote
 */

import TYPERT_REMOTE from '@deepseek-ai/dsh-mud-core/remote'
import type { LogEntry, MudConnectionStatus, MudConnectOptions } from '@deepseek-ai/dsh-mud-core/types'
// Type-only: pulls the TypertRemoteNamespaceMap augmentation (mud namespace) into the program.
import type {} from '@deepseek-ai/dsh-mud-core/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

/** 生成客户端的 mud 命名空间 (bind/connect/.../game/ui/world, 全类型化)。 */
export type MudNamespace = TypertClientRemote['mud']

/**
 * 页面唯一的 MUD RPC 控制器: mount 一次, 全组件共享。
 * 每个 RPC 方法解包 `RemoteResult` (失败分支抛 RemoteError), 调用点沿用
 * 原 fetch 时代的 try/catch 语义, 不改变 UI 行为。
 */
export class MudRemoteController {
  private mud: MudNamespace | null = null

  /** 贡献项是否已 $mount 成功 (与 namespace 读取分离: 重试只重做读取, 不重复挂载)。 */
  private contributionMounted = false

  /** 最近一次 mount 失败的原因 (成功后清空; 调用报错时附带显示真实原因)。 */
  mountError: string | null = null

  /**
   * Mount the generated Host-for-Client contribution into the page fiber.
   * @param ctx - client root context (需宿主已加载 gateway client 的 remote 服务)。
   * @returns 类型化 mud 命名空间 (流消费起点)。
   */
  async mount(ctx: ClientContext): Promise<MudNamespace> {
    const remote = ctx.get('remote') as TypertClientRemote | undefined
    if (remote === undefined) throw new Error('[mud] ctx.remote 不可用 (gateway client 未加载)')
    // $mount 不可重入: 官方 validateContribution 在"已挂载同名方法"时抛 already
    // mounted, 因此成功过就绝不再调 —— 重试只重做下面的 namespace 读取。
    if (!this.contributionMounted) {
      try {
        await remote.$mount(TYPERT_REMOTE)
      } catch (err) {
        // $mount 纯客户端本地校验/注册 (不发网络请求), 失败即 descriptor/命名空间/
        // typert 服务问题。记录原因供调用侧报错附带, 避免只看到"尚未挂载"而无从排查。
        this.mountError = err instanceof Error ? err.message : String(err)
        throw err
      }
      this.contributionMounted = true
    }
    // namespace 属性访问器 (remote.mud) 是 cordis accessor: 必须在声明了
    // 'remote.mud' inject 的 fiber 里读取 (官方 agent-team 同款约定), 直接
    // remote.mud 会抛 cannot get property "remote.mud" without inject。
    this.mud = await new Promise<MudNamespace>((resolve, reject) => {
      const handle = ctx.inject(['remote.mud'], (injected: ClientContext) => {
        resolve((injected as unknown as { remote: TypertClientRemote }).remote.mud)
      })
      void Promise.resolve(handle).catch(reject)
    })
    this.mountError = null
    return this.mud
  }

  /** 是否已挂载 (流消费/轮询启动判据)。 */
  get ready(): boolean {
    return this.mud !== null
  }

  /** 挂载后的命名空间 (未挂载为 null — MudSocketController.start 用)。 */
  get namespace(): MudNamespace | null {
    return this.mud
  }

  /** 解包一次 RPC 调用 (未挂载 / 失败分支均抛; 未挂载报错附带真实挂载失败原因)。 */
  private async call<T>(run: (mud: MudNamespace) => Promise<RemoteResult<T>>): Promise<T> {
    const mud = this.mud
    if (mud === null) {
      throw new Error(this.mountError !== null
        ? `[mud] remote 尚未挂载 (挂载失败: ${this.mountError})`
        : '[mud] remote 尚未挂载')
    }
    const result = await run(mud)
    if (!result.ok) throw result.error
    return result.value
  }

  /** 声明"该官方会话是 MUD 账号会话" (host 装配工具/提示/选路)。 */
  bind(sessionId: string): Promise<void> {
    return this.call(mud => mud.bind(sessionId)).then(() => undefined)
  }

  /** 建立某会话的 telnet 连接。 */
  connect(options: MudConnectOptions): Promise<{ sessionId: string }> {
    return this.call(mud => mud.connect(options))
  }

  /** 断开某会话连接。 */
  disconnect(sessionId?: string): Promise<void> {
    return this.call(mud => mud.disconnect(sessionId)).then(value => void value)
  }

  /** 连接状态全表 (轮询回填)。 */
  status(sessionId?: string): Promise<{ status: MudConnectionStatus; sessions: readonly MudConnectionStatus[] }> {
    return this.call(mud => mud.status(sessionId))
  }

  /** 切换某会话权限档位。 */
  setCapability(tier: string, sessionId?: string): Promise<{ sessionId: string; tier: string; capabilities: readonly string[] }> {
    return this.call(mud => mud.setCapability(tier, sessionId))
  }

  /** 直发游戏命令 (bypass agent)。 */
  async command(cmd: string | undefined, cmds: readonly string[] | undefined, sessionId?: string): Promise<boolean> {
    const value = await this.call(mud => mud.command(cmd, cmds, sessionId))
    return value.ok
  }

  /** 刷新验证码 (重新抓取 robot.php 并推新 captcha 事件)。 */
  async captchaRefresh(imageUrl: string, sessionId?: string): Promise<string | null> {
    const value = await this.call(mud => mud.captchaRefresh(imageUrl, sessionId))
    return value.url
  }

  /** 注销某会话 (释放运行时/连接/日志/缓冲)。 */
  async purge(sessionId: string): Promise<void> {
    await this.call(mud => mud.purge(sessionId))
  }

  /** 当日日志恢复 (LogView 挂载拉取; 与 ui 流按 logSeq 去重合并)。 */
  logs(sessionId: string): Promise<readonly LogEntry[]> {
    return this.call(mud => mud.logs(sessionId)).then(value => value.entries)
  }
}
