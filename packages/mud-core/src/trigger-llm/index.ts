/**
 * dsh-mud-core — Trigger LLM (trigger-llm/index).
 *
 * 触发器公共面:
 *   - TriggerLlmAdapter (T1 本地模拟 LLM) + 装配方钩子类型;
 *   - Perceptor / TriggerMatchService (纯匹配 + 独立实例);
 *   - 规则/动作/命中类型。
 * marker/router (v5) 已移除: 无事件、无独立路由。
 * @module @deepseek-ai/dsh-mud-core/trigger-llm
 */

export { TriggerLlmAdapter, T1_NO_ANSWER_CODE } from './adapter.ts'
export type { TriggerLlmAdapterHooks } from './adapter.ts'
export { Perceptor, TriggerMatchService, styleMatchesColor } from './service.ts'
export type {
  ActionSpec,
  ColorCond,
  MatchContext,
  MultiCond,
  MultiMatchState,
  PerceptionRule,
  PerceptHit,
  TriggerAction,
  TriggerLane,
} from './types.ts'
export { createMatchContext, MULTI_LINE_DELTA, CONTROL_PREFIX } from './types.ts'