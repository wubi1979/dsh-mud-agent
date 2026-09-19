/**
 * dsh-mud-webui — 凭据引用面 (client half)。
 *
 * 把官方 `ctx.remote.credentials` 命名空间 (Host 侧的凭据配置面, 见官方
 * `api/settings-controller/src/credentials.ts`) 收口成一个控制器: 名单里只存
 * **引用名**, 密码值经 `set` 单向写入 host 凭据存储, 页面永不读回 (官方面没有
 * 任何回值方法), 状态只经 `describe` 取 `{configured, source?, writable}`。
 *
 * **为什么不引官方 `@deepseek-ai/dsh-api-remotes` 取类型**: 本仓
 * `packages/typert-protocol` 是官方协议包的镜像 (workspace 内解析), 而已发布的
 * `dsh-api-remotes` 内部 import npm 上的 `dsh-typert-protocol`, 两者的
 * `TypertRemoteNamespaceMap` 是两个 module 里的两个 interface, 声明合并不会生效,
 * 且会往 cordis `Context` 上再塞一个不含 `mud` 的 `remote` 类型。因此照
 * `mud-remote.ts` 的做法自持一份最小结构化接口 (只用镜像的 `RemoteResult`)。
 *
 * **为什么软解析而不是加进 `inject`**: cordis 的 `inject` 全满足才激活, 把
 * `remote.credentials` 写进去会让"客户端装配没挂这个命名空间"退化成整个 MUD
 * 侧栏/游戏/日志 tab 全部不加载且无提示。命名空间的服务键就是
 * `remote.<namespace>` (官方 gateway client `remoteServiceKey`), 所以
 * `ctx.get('remote.credentials')` 缺席时返回 `undefined`, 当场报一句人能看懂的错。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-credentials
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** 官方引用状态视图 (`CredentialsController.describe` 的返回元素; 没有值字段)。 */
export interface MudCredentialInfo {
  /** 现在解析该引用是否拿得到值。 */
  configured: boolean
  /** 供值的来源层 (`env`/`file`/`project-env`/`user-env`); 未配置时缺席。 */
  source?: string
  /** 当前 provider 能否写这个引用 (被只读源遮蔽时为 false: set/unset 必被拒)。 */
  writable: boolean
}

/** 官方 `credentials` 远端命名空间的最小面 (三个方法; 值只进不出)。 */
interface CredentialsNamespace {
  describe(refs: string[]): Promise<RemoteResult<Record<string, MudCredentialInfo>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
  unset(ref: string): Promise<RemoteResult<void>>
}

/**
 * 官方 CredentialRef 语法 (POSIX 环境变量名), 与 `@deepseek-ai/dsh-credentials`
 * 的 `REF_PATTERN` 同源。本地复刻而不引那个包: 它是 service definition 模块
 * (导出 `CredentialProvider extends Service`), 为一条正则把 cordis Service
 * 拖进浏览器 bundle 不划算。
 * @param value 候选引用名。
 * @returns 是否可作为引用名。
 */
export function isCredentialRefName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

/** 官方 `describe` 的批量上限 (`MAX_DESCRIBE_REFS`); 超出即整批被拒。 */
const MAX_DESCRIBE_REFS = 64

/** 名单引用名的前缀 (在官方 Models 页里一眼能认出是谁的)。 */
const PASS_REF_PREFIX = 'MUD_PASS_'

/**
 * 为一条名单用户生成引用名。
 *
 * 形态 `MUD_PASS_<净化名>_<6位十六进制>`。**后缀不是装饰**: `removeUser` 会
 * `unset` 这个引用, 而部署手写的 `config.account.passRef`(如 `MUD_PASS_XIAOYAO`)
 * 完全可能与"净化后的用户名"同名 —— 名字可推导就等于"删一个页面用户"能删掉部署
 * 凭据。随机后缀让生成名与手写名实际不可能相撞, `unset` 的破坏面也就限定在本条目
 * 自己的引用内 (代价: 同一账号删后重建会换名, 旧名已随删除 unset)。
 * @param taken 现有引用名 (本服务器名单里的; 用于避让)。
 * @param accountName 名单里的用户名。
 * @returns 合法的凭据引用名。
 */
export function mintPassRef(taken: readonly string[], accountName: string): string {
  const sanitized = accountName.trim().replace(/[^A-Za-z0-9_]/g, '_')
  const takenSet = new Set(taken)
  for (;;) {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 6)
    const ref = `${PASS_REF_PREFIX}${sanitized}_${suffix}`
    if (isCredentialRefName(ref) && !takenSet.has(ref)) return ref
  }
}

/** 凭据面不可用时的统一文案 (含"这是部署配置问题, 不是操作错误")。 */
function unavailable(): Error {
  return new Error('本部署未提供凭据服务 (remote.credentials 未挂载), 无法保存密码')
}

/**
 * 页面唯一的凭据控制器: 每次调用现场解析命名空间 (懒), 因此不依赖 `apply` 的
 * 时序 —— 客户端装配晚挂命名空间也不会让它永久失效。
 */
export class MudCredentialsController {
  constructor(private readonly ctx: ClientContext) {}

  /** 当下能否使用凭据面 (徽标/按钮可用性判据)。 */
  get available(): boolean {
    return this.namespace() !== null
  }

  /** 官方命名空间服务 (缺席 = 本部署没挂客户端贡献)。 */
  private namespace(): CredentialsNamespace | null {
    // 直接读服务键: 属性访问器 `ctx.remote.credentials` 要求当前 fiber 声明了
    // 同名 inject, 而这里刻意不把它做成硬依赖 (见模块头)。
    return (this.ctx.get('remote.credentials') as CredentialsNamespace | undefined) ?? null
  }

  /**
   * 写入一个引用的明文 (单向: 页面永远不会读回它)。
   * @param ref 引用名 (调用方保证合法)。
   * @param value 非空明文; 空值官方侧直接拒绝 (`min(1)`)。
   * @throws Error 凭据面不可用, 或 host 拒绝写入 (消息原样来自官方 seam)。
   */
  async set(ref: string, value: string): Promise<void> {
    const namespace = this.namespace()
    if (namespace === null) throw unavailable()
    const result = await namespace.set(ref, value)
    if (!result.ok) throw result.error
  }

  /**
   * 移除一个引用 (删用户/删服务器时回收)。
   * @param ref 引用名; 引用的缺席是 no-op。
   * @throws Error 凭据面不可用, 或 host 拒绝 (如被只读源遮蔽)。
   */
  async unset(ref: string): Promise<void> {
    const namespace = this.namespace()
    if (namespace === null) throw unavailable()
    const result = await namespace.unset(ref)
    if (!result.ok) throw result.error
  }

  /**
   * 取若干个引用的状态 (只回 `{configured, source?, writable}`, 不回值)。
   *
   * 调用前过滤空名与不合语法的名字 —— 官方 schema 只要有一个不合法就**整批**
   * 返回 `gateway/bad-request`, 一个遗留空引用名会让整屏徽标全灭。按官方上限
   * 分批, 结果按引用名键控合并。
   * @param refs 候选引用名 (去重前的原始集合)。
   * @returns 引用名 → 状态 (仅含合法且非空的项)。
   * @throws Error 凭据面不可用, 或 host 拒绝。
   */
  async describe(refs: readonly string[]): Promise<Record<string, MudCredentialInfo>> {
    const namespace = this.namespace()
    if (namespace === null) throw unavailable()
    const wanted = [...new Set(refs.filter(ref => ref !== '' && isCredentialRefName(ref)))]
    const merged: Record<string, MudCredentialInfo> = {}
    for (let at = 0; at < wanted.length; at += MAX_DESCRIBE_REFS) {
      const batch = wanted.slice(at, at + MAX_DESCRIBE_REFS)
      const result = await namespace.describe(batch)
      if (!result.ok) throw result.error
      Object.assign(merged, result.value)
    }
    return merged
  }
}
