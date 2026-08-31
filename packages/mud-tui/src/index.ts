/**
 * dsh-mud-tui — MUD 终端外壳 (pi-tui), host face.
 *
 * Consumer 插件: 消费 `ctx.mud` 服务 (@deepseek-ai/dsh-mud-core 提供) 与
 * session 自定义事件 (mud/decision|mud/log|mud/world), 渲染 opencode 风格
 * 双栏终端界面。与 mud-web 外壳互斥可换 — 由 profile patch 组合决定。
 * @module @deepseek-ai/dsh-mud-tui
 */

import type { Context } from '@deepseek-ai/cordis'
import { MudTuiApp, type MudTuiConfig } from './app.ts'

/** 插件名。 */
export const name = 'mud-tui'

/** 必需服务: MUD 核心 (ctx.mud)。 */
export const inject = ['mud']

export type { MudTuiConfig }

/** 插件主体: 启动 TUI 并挂接会话事件流; teardown 时恢复终端。 */
export function apply(ctx: Context, config: MudTuiConfig = {}): void {
  // 非 TTY 环境 (管道/dump-config 等诊断运行) 不接管终端。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[mud-tui] 标准输入/输出不是终端 — TUI 未启动')
    return
  }
  const mud = ctx.get('mud')
  if (mud === undefined) {
    throw new Error('mud-tui 需要 ctx.mud 服务 — 请与 @deepseek-ai/dsh-mud-core 同 profile 组合')
  }
  const app = new MudTuiApp(mud, config)
  // 会话事件 → TUI (对话转录 / 决策轨迹 / 世界快照)。
  ctx.on('session/event', (session, event) => {
    app.handleEvent(event, String(session.id), mud.status().sessionId)
  })
  // /exit、/quit 或 ctrl+c: 先恢复终端主屏, 再自发 SIGINT 走宿主的
  // 优雅停机路径 (dispose 整棵插件树后退出, 与 Ctrl+C 终端信号同路)。
  app.onQuit = (): void => {
    app.stop()
    process.kill(process.pid, 'SIGINT')
  }
  app.start()
  ctx.effect(() => () => {
    app.stop()
  }, 'mud-tui: lifecycle')
}
