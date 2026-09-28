/**
 * mud-core3 roster — 服务器与账号记录类型 + 名册存储接口。
 *
 * 纯类型（+存储接口），零宿主依赖。存储实现见 store.ts（宿主 storage 域 / 内存降级）。
 */

/** 服务器记录（roster.servers，键 = workspaceId）。 */
export interface ServerRecord {
  /** workspaceId（宿主 Workspace 实体的 id，同时是 roster 主键）。 */
  readonly workspaceId: string
  /** 服务器显示名（沿用 v1，来自 Workspace.title）。 */
  readonly name: string
  /** MUD 服务器地址。 */
  readonly host: string
  /** MUD 服务器端口。 */
  readonly port: number
}

/** 账号记录（roster.accounts，键 = accountId = sessionId）。 */
export interface AccountRecord {
  /** 账号 id（= 会话 id = sessionId）。 */
  readonly id: string
  /** 账号名（MUD 登录名）。 */
  readonly name: string
  /** 密码凭据引用名（宿主 credentials 存储 key；空串 = 无密码）。 */
  readonly passRef: string
  /** 所服务器的 workspaceId。 */
  readonly serverId: string
  /** 建账号时选的 preset id（如 'mud-player' / 'standard'）。 */
  readonly preset: string
  /** 接入状态（缺省 false = 未接入；持久化，重启保留）。 */
  readonly admitted: boolean
}

/**
 * 名册存储：服务器/账号记录的读写面（宿主 storage 域或内存实现）。
 * 读同步（域表的内存视图），写异步（等待持久化）。
 */
export interface RosterStore {
  server(workspaceId: string): ServerRecord | undefined
  servers(): readonly ServerRecord[]
  putServer(record: ServerRecord): Promise<void>
  deleteServer(workspaceId: string): Promise<boolean>
  account(sessionId: string): AccountRecord | undefined
  accounts(): readonly AccountRecord[]
  putAccount(record: AccountRecord): Promise<void>
  deleteAccount(sessionId: string): Promise<boolean>
}

/** 连接状态（runtime 对外暴露面）。 */
export type ConnState = 'disconnected' | 'connecting' | 'connected'

/** 凭据解析结果。 */
export interface ResolvedCredentials {
  readonly name: string
  readonly pass: string
}

/**
 * 凭据解析器接口（宿主注入凭据服务解析；测试注入 mock）。
 * 账号记录 → `{ name, pass }`：name 取自 roster（MUD 登录名），pass 由 `passRef`
 * 指向的密文解析得到。引用不存在/不可读 = 解析失败，抛错并附引用名。
 */
export type CredentialResolver = (account: AccountRecord) => Promise<ResolvedCredentials>

/**
 * 服务器查找器接口（宿主从 roster storage 读取；测试注入内存 map）。
 * sessionId → 该账号绑定的服务器记录；找不到返回 undefined。
 */
export type ServerLookup = (sessionId: string) => ServerRecord | undefined

/**
 * 账号查找器接口（宿主从 roster storage 读取；测试注入内存 map）。
 * sessionId → 账号记录；找不到返回 undefined。
 */
export type AccountLookup = (sessionId: string) => AccountRecord | undefined
