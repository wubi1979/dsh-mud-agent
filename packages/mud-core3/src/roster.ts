/**
 * mud-core3 roster — 服务器与账号记录类型。
 *
 * 纯类型 + 验证，零宿主依赖。宿主接线层（index.ts）用这些类型定义 storage
 * domain spec（zod schema），测试用纯对象。
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
  /** 接入状态（缺省 false = 未接入）。 */
  readonly admitted: boolean
}

/** 连接状态（runtime 对外暴露面）。 */
export type ConnState = 'disconnected' | 'connecting' | 'connected'

/** 凭据解析结果。 */
export interface ResolvedCredentials {
  readonly name: string
  readonly pass: string
}

/**
 * 凭据解析器接口（宿主注入 `ctx.get('credentials').resolve`；测试注入 mock）。
 * passRef → { name, pass }；解析失败抛错。
 */
export type CredentialResolver = (passRef: string) => Promise<ResolvedCredentials>

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
