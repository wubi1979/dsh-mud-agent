/**
 * dsh-mud-map — MUD 导航子包入口 (cordis 插件).
 *
 * 提供 pkuxkx MUD 无反馈环境下的地图构建、定位与导航服务 (各子模块见
 * index 聚合)。作为独立 cordis 插件与 mud-core 同 profile 组合:
 *   - 消费 `ctx.mud` (sendCommand) 与 `mud/gmcp` 事件 (构建图 + 定位)
 *   - 通过 `ctx.mud.registerMap(nav.service)` 将导航服务挂到 `ctx.mud.map`
 *     (MudMapService, 见 nav-service), 使宿主经 `ctx.mud.map` 访问
 *
 * 类型集成 (契约驱动):
 *   - `import type {} from '@deepseek-ai/dsh-mud-core'` 触发 mud-core 对
 *     `@deepseek-ai/cordis` 的 Context/Events 增强, 使 `ctx.mud` 与
 *     `mud/gmcp` 事件可类型安全访问;
 *   - core 定义最小结构契约 `MudMapCapability` (定位+导航), 本包的
 *     `MudMapService` 为其超集实现 (见 types.ts), 经 `ctx.mud.registerMap`
 *     挂载: 实现方向 core 声明, core 不反向依赖本包。
 *
 * @module @deepseek-ai/dsh-mud-map
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mud-core'
import { NavService } from './nav-service.ts'
import { JsonMapStore } from './store.ts'
import type { HumanInteraction } from './types.ts'

/** 插件名. */
export const name = 'mud-map'

/** 必需服务: MUD 核心 (ctx.mud, 提供 sendCommand + 事件总线 + 扩展槽). */
export const inject = ['mud']

/** mud-map 插件配置. */
export interface MudMapConfig {
  /** 持久化文件路径 (缺省: 当前目录 mud-map.json). */
  storePath?: string
}

/** 插件主体: 装配导航服务并挂到 ctx.mud.map. */
export function apply(ctx: Context, config: MudMapConfig = {}): void {
  const mud = ctx.mud
  const sendCommand = (cmd: string) => mud.sendCommand(cmd)

  const nav = new NavService({
    ...(config.storePath ? { store: new JsonMapStore(config.storePath) } : {}),
    sendCommand,
    // 弹窗适配由宿主注入 (当前 fallback: 返回默认选项).
    requestHuman: (interaction: HumanInteraction) => defaultHumanHandler(interaction),
  })

  // 启动 (订阅 mud/gmcp + 恢复图).
  void nav.start(ctx)

  // 将导航服务挂到 ctx.mud.map (宿主经此访问, 类型为 MudMapService).
  mud.registerMap(nav.service)

  // 生命周期: 停机落盘.
  ctx.effect(() => () => {
    void nav.dispose()
  }, 'mud-map: lifecycle')
}

/** 兜底人工交互处理: 无 UI 适配时返回首个选项 (或 undefined). */
function defaultHumanHandler(interaction: HumanInteraction): Promise<unknown> {
  return Promise.resolve(interaction.options?.[0]?.value)
}

// ── 聚合 re-export ──────────────────────────────────────

export * from './types.ts'
export { NavService } from './nav-service.ts'
export { JsonMapStore, emptySnapshot } from './store.ts'
export { PriorParser } from './prior-parser.ts'
export { GeometryLayer, normalizeExits, exitsFingerprint } from './geometry.ts'
export { SemanticLayer } from './semantic.ts'
export { Localizer } from './localizer.ts'
export { Navigator } from './navigator.ts'
export { FenceManager } from './fence.ts'
export { HumanInteractionManager } from './human.ts'
export type { NavServiceOptions } from './nav-service.ts'
