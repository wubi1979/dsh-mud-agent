/**
 * dsh-mud-agent — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (用户=会话=运行时, agent 生命周期归官方, 连接是会话无关的传输资源)
 * 与消息流详见 `assemble.ts` 头注释 (`doc/ARCHITECTURE.md` §3–§7)。
 *
 * 本模块只做**入口** (插件描述 + 部署配置 + apply 转发); 装配主体在
 * `assemble.ts`, 网络面在 `shell/mud-remote-service.ts` (typert Remote 命名空间 `mud`)。
 * @module @deepseek-ai/dsh-mud-core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MudWorldSnapshot } from './shell/remote-types.ts'
import { createMudCore, type MudAgentConfig } from './assemble.ts'

/** 插件名。 */
export const name = 'mud-core'

/** 必需服务: agents 注册表 (只读解析会话的 live agent — 不创建/不 dispose)。 */
export const inject = ['agents']

export type { MudAgentConfig }
export type { MudWorldSnapshot }
export type {
  MudConnectOptions,
  MudConnectionStatus,
  MudCoreService,
  MudDiag,
  MudGameRead,
} from './service.ts'
export { MudRemoteService, type MudRemoteServiceInternals } from './shell/mud-remote-service.ts'

// 会话事件契约: 宿主消费会话内命令 (外壳命令走 HTTP /mud/command, 带 sessionId)。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 客户端 → host 命令通道 (绕过 agent, 直发该会话的游戏连接)。 */
    'mud/command': { cmd: string }
  }
}

/** 插件主体 (装配转发)。 */
export function apply(ctx: Context, config: MudAgentConfig = {}): void {
  createMudCore(ctx, config)
}