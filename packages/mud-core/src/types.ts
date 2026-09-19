// Remote 边界类型公共出口 (./types 子路径)。
//
// typert 生成器要求: @Remote 方法签名中出现的具名跨线类型必须可从本包的
// 公开**非根**子路径导出 (publicRemoteType 校验), 根导出与 './remote' 等不参与。
// 本文件只做 re-export — 类型定义留在各自的域内, 此处集中为生成器提供可达性,
// 同时作为 webui 侧生成客户端的类型来源。
export type { MudConnectOptions, MudConnectionStatus, MudDiag } from './shell/service.ts'
export type { MudGameItem, MudUiItem } from './shell/remote-types.ts'
export type { MudWorldEvent } from './shell/streams.ts'
export type { MudTier } from './agent/gate/tiers.ts'
export type { LogEntry } from './log/log-service.ts'
export type { MudCapabilityOption } from './agent/gate/capability.ts'
