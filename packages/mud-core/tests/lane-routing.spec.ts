/**
 * dsh-mud-core — 选路配置变换测试 (`doc/ARCHITECTURE.md` §6)。
 *
 * 关键契约: 拦截为 T1 时必须换 provider/model 并**剥离 adapter-owned 的
 * `reasoningEffort`** —— 官方 per-session 模型选择可能带 "high" 之类 effort,
 * 本地模拟 provider 不支持, 原样传递会被 llm 层拒绝:
 *   provider "mud-t1" model "t1-local" does not support reasoning effort "high"
 */

import { describe, expect, it } from 'vitest'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { resolveLaneConfig, toT1Config, T1_MODEL, T1_PROVIDER } from '../src/agent/agent-bridge.ts'

/** 会话真实模型 (官方 per-session 选择给出的配置)。 */
const REAL = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'high',
} as unknown as LlmCallConfig

describe('toT1Config (T1 拦截的配置变换)', () => {
  it('换 provider/model, 剥离继承的 reasoningEffort', () => {
    const config = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      maxTokens: 4096,
    } as unknown as LlmCallConfig

    const result = toT1Config(config) as unknown as Record<string, unknown>

    expect(result.provider).toBe(T1_PROVIDER)
    expect(result.model).toBe(T1_MODEL)
    expect('reasoningEffort' in result).toBe(false)
    // 其余字段原样保留 (如 maxTokens; 假 provider 忽略即可)。
    expect(result.maxTokens).toBe(4096)
  })

  it('无 effort 时行为不变 (不引入多余字段)', () => {
    const config = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    } as unknown as LlmCallConfig

    const result = toT1Config(config) as unknown as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(['model', 'provider'])
    expect(result.provider).toBe(T1_PROVIDER)
  })
})

describe('resolveLaneConfig (会话模型污染的防御)', () => {
  it('t1 回合: 换成 T1 配置, 并把官方给的配置记为会话真实模型', () => {
    const decision = resolveLaneConfig('t1', REAL, null)
    expect(decision.config.provider).toBe(T1_PROVIDER)
    expect(decision.memory).toBe(REAL)
    expect(decision.polluted).toBe(false)
    expect(decision.restored).toBe(false)
  })

  it('t1 回合收到 T1 占位 (已被污染) 时不覆盖记忆', () => {
    const t1 = toT1Config(REAL)
    const decision = resolveLaneConfig('t1', t1, REAL)
    expect(decision.memory).toBe(REAL)
  })

  it('非 t1 回合: 官方给真实模型 → 原样放行并更新记忆', () => {
    const other = { provider: 'deepseek-official', model: 'deepseek-reasoner' } as unknown as LlmCallConfig
    const decision = resolveLaneConfig('t2', other, REAL)
    expect(decision.config).toBe(other)
    expect(decision.memory).toBe(other)
    expect(decision.polluted).toBe(false)
  })

  it('非 t1 回合被 T1 占位污染 → 还原记忆里的真实模型 (否则真实 LLM 永不参与)', () => {
    const decision = resolveLaneConfig('t2', toT1Config(REAL), REAL)
    expect(decision.config).toBe(REAL)
    expect(decision.polluted).toBe(true)
    expect(decision.restored).toBe(true)
  })

  it('无 lane (非 MUD 投递) 同样走基线判定', () => {
    const decision = resolveLaneConfig(undefined, toT1Config(REAL), REAL)
    expect(decision.config).toBe(REAL)
    expect(decision.restored).toBe(true)
  })

  it('从未观测到真实模型时不猜: 原样放行并标记污染', () => {
    const t1 = toT1Config(REAL)
    const decision = resolveLaneConfig('t2', t1, null)
    expect(decision.config).toBe(t1)
    expect(decision.polluted).toBe(true)
    expect(decision.restored).toBe(false)
  })

  it('真实序列: 首次拦截 → 后续请求被污染 → 非 T1 回合还原', () => {
    let memory: LlmCallConfig | null = null
    // step 1: lane=t1, 官方给真实模型 → 记下并拦截
    const s1 = resolveLaneConfig('t1', REAL, memory); memory = s1.memory
    expect(s1.config.provider).toBe(T1_PROVIDER)
    // step 2: lane=t1, 官方已把选择记成占位 → 仍以记忆为准, 不覆盖
    const s2 = resolveLaneConfig('t1', toT1Config(REAL), memory); memory = s2.memory
    expect(memory).toBe(REAL)
    // turn 2: lane=t2, 官方仍给占位 → 还原真实模型
    const t2 = resolveLaneConfig('t2', toT1Config(REAL), memory); memory = t2.memory
    expect(t2.config).toBe(REAL)
    expect(t2.restored).toBe(true)
  })
})
