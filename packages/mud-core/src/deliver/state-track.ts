/**
 * dsh-mud-core — 状态跟踪 (State), host half. (内部模块, 非服务)
 *
 * world 的**写入统一入口**: 无论数据来自哪条通路, 落库都经本模块
 * (变化 → onChanged → 装配方节流广播 UI 快照)。写入通路全景:
 *   - **GMCP 直连** (`onGmcp`): telnet 回调直连 → applyGmcp, 权威结构化数据 (置信度 1.0);
 *   - **感知 state 折叠** (`patch(..., 'percept')`): 触发规则抓取的 extract 产物落库
 *     (消费链站①, §8.2);
 *   - **流程 `onEnter.patch`** (`patch(..., 'flow')`);
 *   - **连接生命周期** (`patch(..., 'lifecycle')`: connected/awaiting 等护栏位);
 *   - agent `world_patch` 工具: 工具集闭包持有**同一 WorldModel** 直写 (文本语义路径
 *     不经本模块推断, 写后经 onWorldChange 回调重评估看门狗)。
 *
 * 感知文本事件 (mud/percept) 与 GMCP 派生事件 (mud/gmcp) 已随事件机制移除:
 * 文本语义统一走 agent (级联 provider 的 world_patch 工具), 不在状态层推断;
 * GMCP 既是铺底又是权威, 不再二次派生事件。
 * @module @deepseek-ai/dsh-mud-core/deliver/state-track
 */

import { applyGmcp, applyPatch, type WorldModel } from '../world/state.ts'

/** world 写入通路归因 (onChanged 的 why)。 */
export type StateWriteSource = 'gmcp' | 'percept' | 'flow' | 'lifecycle'

/** 状态服务构造参数。 */
export interface StateServiceOptions {
  /** 目标 WorldModel。 */
  world: WorldModel
  /** world 发生写入后回调 (index 接 pushWorld: 节流广播 UI 快照)。 */
  onChanged?: (changes: string[], why: StateWriteSource) => void
}

/**
 * 状态跟踪服务: world 写入的统一入口。无总线、无订阅;
 * 文本语义路径 (agent → world_patch) 不在此做任何推断。
 */
export class StateService {
  readonly world: WorldModel
  private readonly onChanged: ((changes: string[], why: StateWriteSource) => void) | null

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

  /**
   * 通用补丁入口 (感知折叠 / 流程 onEnter / 生命周期护栏位): applyPatch 落库。
   * @param patch 补丁 (null/undefined = 无操作)。
   * @param why 写入通路归因。
   * @returns 变化的字段列表。
   */
  patch(patch: Record<string, unknown> | null | undefined, why: StateWriteSource): string[] {
    const changes = applyPatch(this.world, patch)
    if (changes.length > 0) this.onChanged?.(changes, why)
    return changes
  }
}
