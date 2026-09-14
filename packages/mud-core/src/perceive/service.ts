/**
 * dsh-mud-core — 感知装配服务 (perceive/service): 策略面规则分桶与关注集。
 *
 * 从完整感知规则集拆出喂给 PerceptionEngine 的输入:
 *   - `stateRules` / `eventRules`: 双桶 (v6.1 分流, 见 `TriggerLane`);
 *   - `holdRuleIds`: 声明 `holdDelivery` 的规则 id 集 (投递原子性判据)。
 *
 * 纯函数, 无运行态 (运行态都在 PerceptionEngine / 匹配服务实例里)。
 * @module @deepseek-ai/dsh-mud-core/perceive/service
 */

import type { PerceptionRule } from './types.ts'

/** 感知规则分桶结果 (PerceptionEngine 构造输入)。 */
export interface PerceptionRuleSet {
  /** state 桶规则 (预匹配折叠入库)。 */
  stateRules: readonly PerceptionRule[]
  /** event 桶规则 (T1 渲染 / 判类)。 */
  eventRules: readonly PerceptionRule[]
  /** 声明 holdDelivery 的规则 id (投递原子性判据)。 */
  holdRuleIds: ReadonlySet<string>
}

/**
 * 把完整感知规则集拆成装配输入。
 * @param rules 完整感知规则集 (默认规则 + 装配方追加)。
 */
export function splitPerceptionRules(rules: readonly PerceptionRule[]): PerceptionRuleSet {
  return {
    stateRules: rules.filter(r => r.lane === 'state'),
    eventRules: rules.filter(r => r.lane !== 'state'),
    holdRuleIds: new Set(rules.filter(r => r.holdDelivery === true).map(r => r.id)),
  }
}