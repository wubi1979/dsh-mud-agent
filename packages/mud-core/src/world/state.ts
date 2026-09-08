/**
 * dsh-mud-core — 状态捕获 (State), host half. (内部模块, 非服务)
 *
 * v6: 世界同步只保留 **GMCP 直连** (权威结构化数据, 置信度 1.0):
 *   - onGmcp: telnet 回调直连 → applyGmcp → world 字段映射 (变化经 onChanged 回传)。
 *
 * 感知文本事件 (mud/percept) 与 GMCP 派生事件 (mud/gmcp) 已随事件机制移除:
 * 文本语义统一走 agent (级联 provider 的 world_patch 工具), 不在状态层推断;
 * GMCP 既是铺底又是权威, 不再二次派生事件。
 * @module @deepseek-ai/dsh-mud-core/state
 */

import { applyGmcp, type WorldModel } from './world.ts'

/** 状态服务构造参数。 */
export interface StateServiceOptions {
  /** 目标 WorldModel。 */
  world: WorldModel
  /** world 发生写入后回调 (index 接 pushWorld: 节流广播 UI 快照)。 */
  onChanged?: (changes: string[], why: 'gmcp') => void
}

/**
 * 状态捕获服务: GMCP 直连 → 统一写入 world。无总线、无订阅;
 * 文本语义路径 (agent → world_patch) 不在此做任何推断。
 */
export class StateService {
  readonly world: WorldModel
  private readonly onChanged: ((changes: string[], why: 'gmcp') => void) | null

  constructor({ world, onChanged }: StateServiceOptions) {
    this.world = world
    this.onChanged = onChanged ?? null
  }

  /**
   * GMCP 数据入口 (telnet 回调直连, 不进感知): 权威同步 world。
   * @returns 变化的字段列表。
   */
  onGmcp(pkg: string, payload: unknown): string[] {
    const changes = applyGmcp(this.world, pkg, payload)
    if (changes.length > 0) this.onChanged?.(changes, 'gmcp')
    return changes
  }
}