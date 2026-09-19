/**
 * dsh-mud-core — 选路判定 (resolveLaneConfig) 表驱动单元测试 (v0.9 W7.3)。
 *
 * 覆盖 `doc/architecture/04-06-perception-routing.md` §6 的纯判定核心:
 *   - T2 基线 (I3): 非 T1 回合官方链拍板原样放行, T1 是唯一干预点;
 *   - T1 拦截: lane=t1 → mud-t1/t1-local (剥 reasoningEffort);
 *   - 会话模型污染防御 (doc §6, 实测 bug): 非 T1 回合收到 T1 占位 → 还原真实模型记忆,
 *     spread 请求配置保留 temperature/maxTokens/stop;
 *   - 无记忆保守放行 (会话尚未跑过非占位请求, 下一次真实配置流经时重建);
 *   - 用户手动换模型不被覆盖 (next() 给新模型 → 放行 + 更新记忆)。
 *
 * installOwnedLaneRouting 的状态接线 (turnLane/realModel 维护与留痕) 不在此测 ——
 * 那是 cordis waterfall 的胶水, 纯函数表覆盖后接线只剩一行取值。
 */

import { describe, expect, it } from 'vitest'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { resolveLaneConfig, T1_MODEL, T1_PROVIDER } from '../src/deliver/lane.ts'

/** 真实模型配置基样 (deepseek 官方线上模型)。 */
const REAL: LlmCallConfig = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
/** T1 占位 (拦截结果 / 官方污染后的 next() 返回)。 */
const PLACEHOLDER: LlmCallConfig = { provider: T1_PROVIDER, model: T1_MODEL }
/** 记忆基样 (与 REAL 同形, 仅 identity 字段)。 */
const MEMO = { provider: REAL.provider, model: REAL.model, reasoningEffort: REAL.reasoningEffort }

describe('resolveLaneConfig', () => {
  it('lane=t1 → 拦截为 T1 占位并剥离 reasoningEffort (官方按 adapter 缺省补)', () => {
    const out = resolveLaneConfig({ lane: 't1', requested: { ...REAL }, realModel: null })
    expect(out.config).toEqual({ provider: T1_PROVIDER, model: T1_MODEL })
    expect(out.config).not.toHaveProperty('reasoningEffort')
    expect(out.restored).toBe(false)
  })

  it('lane=t1 且官方链拍板仍是真实配置 (首请求未被污染) → 顺手入记忆', () => {
    const out = resolveLaneConfig({ lane: 't1', requested: { ...REAL }, realModel: null })
    expect(out.realModel).toEqual(MEMO)
  })

  it('lane=t1 且官方链已被污染 (next() 给占位) → 记忆不变', () => {
    const out = resolveLaneConfig({ lane: 't1', requested: { ...PLACEHOLDER }, realModel: MEMO })
    expect(out.config).toEqual(PLACEHOLDER)
    expect(out.realModel).toEqual(MEMO)
  })

  it('lane=t2 → 官方链拍板原样放行 (T2 基线, I3) 并更新记忆', () => {
    const requested: LlmCallConfig = { provider: 'deepseek', model: 'deepseek-reasoner' }
    const out = resolveLaneConfig({ lane: 't2', requested, realModel: MEMO })
    expect(out.config).toBe(requested)
    expect(out.realModel).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(out.restored).toBe(false)
  })

  it('lane=undefined (控制消息/非 MUD 投递) → 原样放行', () => {
    const requested: LlmCallConfig = { ...REAL, temperature: 0.7 }
    const out = resolveLaneConfig({ lane: undefined, requested, realModel: null })
    expect(out.config).toEqual(requested)
    expect(out.restored).toBe(false)
  })

  it('非 T1 回合收到 T1 占位 (会话模型污染) → 还原真实模型, spread 保留其余字段', () => {
    const polluted: LlmCallConfig = { ...PLACEHOLDER, temperature: 0.5, maxTokens: 4096, stop: ['\n\n'] }
    const out = resolveLaneConfig({ lane: 't2', requested: polluted, realModel: MEMO })
    expect(out.config).toEqual({
      provider: REAL.provider,
      model: REAL.model,
      reasoningEffort: REAL.reasoningEffort,
      temperature: 0.5,
      maxTokens: 4096,
      stop: ['\n\n'],
    })
    expect(out.restored).toBe(true)
  })

  it('污染还原时记忆无 effort → 结果不带 reasoningEffort (防继承占位残渣)', () => {
    const memo = { provider: 'deepseek', model: 'deepseek-chat' }
    const out = resolveLaneConfig({ lane: 't2', requested: { ...PLACEHOLDER }, realModel: memo })
    expect(out.config).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out.config).not.toHaveProperty('reasoningEffort')
  })

  it('占位且无记忆 (会话尚未跑过非占位请求) → 保守放行占位, 不误还原', () => {
    const out = resolveLaneConfig({ lane: 't2', requested: { ...PLACEHOLDER }, realModel: null })
    expect(out.config).toEqual(PLACEHOLDER)
    expect(out.restored).toBe(false)
  })

  it('用户手动换模型 → next() 给新模型照原样放行并更新记忆 (不覆盖用户选择)', () => {
    const userPicked: LlmCallConfig = { provider: 'openai', model: 'gpt-x' }
    const first = resolveLaneConfig({ lane: 't2', requested: userPicked, realModel: MEMO })
    expect(first.config).toBe(userPicked)
    expect(first.realModel).toEqual({ provider: 'openai', model: 'gpt-x' })
    // 换模型后的下一个 T1 回合, 官方链给的已是新模型 → 记忆沿新模型走。
    const second = resolveLaneConfig({ lane: 't1', requested: userPicked, realModel: first.realModel })
    expect(second.config).toEqual(PLACEHOLDER)
    expect(second.realModel).toEqual({ provider: 'openai', model: 'gpt-x' })
  })

  it('空 provider/model 的拍板不更新记忆 (保守: 不让空事实冲掉已有记忆)', () => {
    const out = resolveLaneConfig({ lane: 't2', requested: { provider: '', model: '' }, realModel: MEMO })
    expect(out.config).toEqual({ provider: '', model: '' })
    expect(out.realModel).toEqual(MEMO)
  })
})
