/**
 * dsh-mud-core — 状态捕获 (State), host half. (内部模块, 非服务)
 *
 * 人物状态捕获 + world 同步的单一入口, 汇入两类来源:
 *   - **感知文本事件** (总线 mud/percept): 由触发器命中产出, 消费其语义事件
 *     type (如 p:login:prompt / p:combat:start) → 映射为 world patch (文本推断, 置信度 0.7);
 *   - **GMCP 系统事件** (telnet 直连进 onGmcp): 权威结构化数据 (置信度 1.0),
 *     — base 路径 applyGmcp → world 字段映射;
 *     — 派生路径包装为 mud/gmcp 事件上总线供规则/流程/agent 订阅。
 *
 * 语义映射 (感知事件 → patch) 集中在 patchForPercept, 与原 StateTracker.apply
 * 一致; world 的权威性裁决 (置信度) 留在 world.ts。
 * @module @deepseek-ai/dsh-mud-core/state
 */

import { applyGmcp, applyPatch, type WorldModel } from './world.ts'
import { makeGmcpEvent, type MudPerceptEvent } from './events.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 感知事件 type → world patch (文本推断)。与旧 StateTracker.apply 语义一致。 */
export function patchForPercept(type: string): Record<string, unknown> {
  switch (type) {
    // 登录提示 (感知推断)
    case 'p:login:prompt':
      return { awaiting: true, logged_in: false }
    case 'p:login:pass':
      return { awaiting: true }
    case 'p:login:done':
      return { awaiting: false, logged_in: true, initialized: true }
    case 'p:login:replace':
      return { awaiting: true }
    case 'p:login:failed':
      return { awaiting: false, logged_in: false }
    // 语义感知事件 (战斗/死亡)
    case 'p:combat:start':
      return { in_combat: true }
    case 'p:combat:end':
      return { in_combat: false }
    case 'p:death':
      return { dead: true, in_combat: false }
    default:
      return {}
  }
}

/** 状态服务构造参数。 */
export interface StateServiceOptions {
  /** 事件总线 (cordis ctx)。 */
  bus: Pick<Context, 'events'>
  /** 目标 WorldModel。 */
  world: WorldModel
  /** world 发生写入后回调 (index 接 pushWorld: 节流广播 UI 快照)。 */
  onChanged?: (changes: string[], why: 'percept' | 'gmcp') => void
  /** 是否发布 GMCP 派生事件上总线 (低频, 默认开)。 */
  publishGmcp?: boolean
}

/**
 * 状态捕获服务: 订阅感知事件 + 处理 GMCP, 统一写入 world。
 * 不持有感知游标/缓冲 (那是 perception 协调器的职责)。
 */
export class StateService {
  private readonly bus: Pick<Context, 'events'>
  readonly world: WorldModel
  private readonly onChanged: ((changes: string[], why: 'percept' | 'gmcp') => void) | null
  private readonly publishGmcp: boolean
  private readonly unsubscribe: () => unknown

  constructor({ bus, world, onChanged, publishGmcp = true }: StateServiceOptions) {
    this.bus = bus
    this.world = world
    this.onChanged = onChanged ?? null
    this.publishGmcp = publishGmcp
    // 订阅总线感知事件 → 状态捕获 (返回 disposer, 随 ctx 纤维 dispose 自动解绑)
    this.unsubscribe = this.bus.events.on('mud/percept', (e: MudPerceptEvent) => this.onPercept(e))
  }

  /** 断开总线订阅。 */
  dispose(): void {
    this.unsubscribe()
  }

  /** 感知事件 → world patch。 */
  onPercept(e: MudPerceptEvent): void {
    const patch = patchForPercept(e.type)
    if (Object.keys(patch).length === 0) return
    const changes = applyPatch(this.world, patch)
    if (changes.length > 0) this.onChanged?.(changes, 'percept')
  }

  /**
   * GMCP 数据入口 (telnet 回调直连, 不进感知): 权威同步 world;
   * 变化后派生 mud/gmcp 事件上总线 (供规则/流程/agent 订阅)。
   * @returns 变化的字段列表。
   */
  onGmcp(pkg: string, payload: unknown): string[] {
    const changes = applyGmcp(this.world, pkg, payload)
    if (changes.length > 0) this.onChanged?.(changes, 'gmcp')
    // 派生事件: 低频 (仅真正进房间/状态协议包), 无洪泛风险
    const bare = pkg.startsWith('GMCP.') ? pkg.slice('GMCP.'.length) : pkg
    if (this.publishGmcp) this.bus.events.emit('mud/gmcp', makeGmcpEvent(bare, payload))
    return changes
  }
}