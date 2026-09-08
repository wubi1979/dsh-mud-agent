/**
 * dsh-mud-core — Trigger LLM (trigger-llm/index).
 *
 * 触发器公共面 (v6 单路径):
 *   - TriggerLlmAdapter (T1 确定性适配层) + 装配方钩子类型;
 *   - Perceptor / TriggerService (纯匹配 + 注册管理 + 整批文本入口);
 *   - 规则/动作/命中类型 (含 MUD_TRIGGER provider 常量沿用)。
 * marker/router (v5) 已移除: 无事件、无独立路由。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm
 */

export { TriggerLlmAdapter } from './adapter.ts'
export type { TriggerLlmAdapterHooks } from './adapter.ts'
export { Perceptor, TriggerService, styleMatchesColor } from './service.ts'
export type {
  ActionSpec,
  ColorCond,
  MultiCond,
  PerceptionRule,
  PerceptHit,
  TriggerAction,
  TriggerLane,
} from './types.ts'
export { MULTI_LINE_DELTA } from './types.ts'

/** 触发 provider 标识 (装配方注册 'mud-cascade' 时使用的 provider 名前缀)。 */
export const MUD_TRIGGER_PROVIDER = 'mud-trigger'