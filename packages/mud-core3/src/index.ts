/**
 * mud-core3 入口。
 *
 * 第一期：
 *   C1: link 层（telnet/line/mud/corpus），零宿主依赖
 *   C2: roster 类型 + SessionRuntime + MudService（纯 TS），宿主接线在 apply()
 *
 * apply() 是宿主插件装配函数（C2 宿主接线），需 cordis + storage-domain 等宿主服务。
 */

export * from './link/index.ts'
export { SessionRuntime } from './runtime.ts'
export type { ConnectParams } from './runtime.ts'
export { MudService } from './service.ts'
export type { MudServiceDeps, SessionStatus, ConnectResult } from './service.ts'
export type {
  ServerRecord, AccountRecord, ConnState, ResolvedCredentials,
  CredentialResolver, ServerLookup, AccountLookup,
} from './roster.ts'
