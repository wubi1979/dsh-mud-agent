import { describe, expect, it } from 'vitest'
import { shouldVeto, vetoStopStream, type LlmGateLookup } from '../src/llm-gate.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 构造最小 GenerateOptions（只带闸门判定相关字段；sessionId 走窄结构代位 cast）。 */
function call(sessionId?: string): GenerateOptions {
  return { provider: 'p', model: 'm', messages: [], sessionId } as unknown as GenerateOptions
}

/** 可编程查询面（名册 = managed 集合；接入 = admitted 集合）。 */
function lookup(managed: readonly string[], admitted: readonly string[]): LlmGateLookup {
  return {
    isManaged: id => managed.includes(id),
    isAdmitted: id => admitted.includes(id),
  }
}

describe('shouldVeto', () => {
  it('无会话身份戳（一次性调用）→ 放行', () => {
    expect(shouldVeto(call(), lookup(['s1'], []))).toBe(false)
  })

  it('非本插件会话 → 放行', () => {
    expect(shouldVeto(call('other'), lookup(['s1'], []))).toBe(false)
  })

  it('本插件会话未接入 → 拦截', () => {
    expect(shouldVeto(call('s1'), lookup(['s1'], []))).toBe(true)
  })

  it('本插件会话已接入 → 放行', () => {
    expect(shouldVeto(call('s1'), lookup(['s1'], ['s1']))).toBe(false)
  })

  it('fail-closed：名册有记录但投递器缺席（isAdmitted false）→ 拦截', () => {
    // lookup 实现里投递器缺席 = isAdmitted 恒 false，与线上一致（?? false）。
    expect(shouldVeto(call('s1'), lookup(['s1'], []))).toBe(true)
  })
})

describe('vetoStopStream', () => {
  it('单条终块：finish/stop，无内容块、无 usage', async () => {
    const chunks = []
    for await (const chunk of vetoStopStream()) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
