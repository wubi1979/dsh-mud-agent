/**
 * dsh-mud-agent — MUD 玩家 agent 核心 (DSH agent 原生架构), host face.
 *
 * 心智模型 (官方路径对齐):
 *   - **创建用户 = 创建会话**: 页面走官方 `sessions.create` / `sessions.open`,
 *     host 不创建会话、不创建 agent; 页面只需在创建后 `POST /mud/bind` 声明
 *     "该官方会话是一个 MUD 账号会话"。
 *   - **回复用户 = 回复会话**: 游戏输出按会话投递 —
 *     `ctx.agents.get(sessionId)` 只读解析 live agent → `agent.followup(...)`。
 *     会话没有 live agent 时批次留在该会话观察窗, 待官方 `agent/created` 冲刷。
 *   - **切换用户 = 切换会话**: 会话即身份。所有 host 入口 (HTTP 路由、WS 帧、
 *     工具执行) 都带 sessionId; 运行时不持有任何跨会话可变状态。
 *   - **网络连接只接入消息**: MudConnectionManager 只认 host/port, 不认识会话;
 *     绑定方向是唯一的 会话 → 连接 (`runtime.connectionId`)。
 *
 * 单面 (web face) 架构: 本包是统一 host 引擎, 唯一外壳为浏览器 WebUI
 *   (mud-webui)。终端/日志/决策帧走独立 `/mud/ws` 高吞吐通道 (条目自带
 *   sessionId, 前端按会话过滤); 借官方 `webServer.register` /
 *   `webServer.registerUpgrade` 承载, 不改官方源码。
 *
 * 本模块只做**入口** (插件描述 + 部署配置 + apply 转发); 装配主体在
 * `assemble.ts`, 网络面在 `shell/routes.ts`。
 * @module @deepseek-ai/dsh-mud-core
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MudWorldSnapshot } from './shell/wire.ts'
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
  MudGameEntry,
  MudGameRead,
} from './service.ts'

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