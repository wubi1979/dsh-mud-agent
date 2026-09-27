/**
 * index 装配层最小单测（P2 计划 §3.3）：Config fail-loud、belongs 过滤、
 * 根/子分流、disposed 撤表、到期 interrupt 走注入的宿主通路。
 *
 * 宿主面用窄 fake（Context/Agent 结构兼容对象 cast）——装配层只消费
 * on/effect + agent.ctx 的 tools/systemPrompt 窄面。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.ts'
import { CONFIG_DEFAULTS, resolveConfig, type MudCore2Config } from '../src/config.ts'
import type { SubagentAgent } from '../src/subagent/subagent.ts'

const BASE: MudCore2Config = {
  rootSessionId: 'root-s',
  connect: { host: 'h', port: 1 },
  creds: { name: 'n', pass: 'p' },
  silenceMs: 1000,
  defaultTimeoutMs: 5000,
  budgetMs: 60_000,
}

/** 窄 fake agent（SubagentAgent + agent.ctx 窄面）。 */
function fakeAgent(id: string, opts: { depth?: number; parent?: string } = {}): SubagentAgent & {
  ctx: { tools: { register: ReturnType<typeof vi.fn> }; systemPrompt: { section: ReturnType<typeof vi.fn> } }
} {
  const register = vi.fn(() => () => {})
  const section = vi.fn(() => () => {})
  return {
    id,
    options: opts.depth === undefined ? {} : { subagentDepth: opts.depth },
    session: {
      header: {
        ...(opts.depth === undefined ? {} : { delegationDepth: opts.depth }),
        ...(opts.parent === undefined ? {} : { parentSession: opts.parent }),
      },
    },
    cancel: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    ctx: { tools: { register }, systemPrompt: { section } },
  } as never
}

/** 窄 fake cordis ctx：捕获事件监听器与卸载 disposer。 */
function fakeCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>()
  const disposers: Array<() => void> = []
  const ctx = {
    subagents: { interrupt: vi.fn() },
    on(event: string, cb: (payload: never) => void): void {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
    },
    effect(fn: () => () => void): void {
      disposers.push(fn())
    },
    emit(event: string, payload: never): void {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    },
  }
  return { ctx: ctx as never, listeners, disposers, raw: ctx }
}

describe('resolveConfig', () => {
  it('补缺省（§19 待校准占位）', () => {
    const { silenceMs: _s, defaultTimeoutMs: _d, budgetMs: _b, ...rest } = BASE
    const cfg = resolveConfig(rest)
    expect(cfg.silenceMs).toBe(CONFIG_DEFAULTS.silenceMs)
    expect(cfg.defaultTimeoutMs).toBe(CONFIG_DEFAULTS.defaultTimeoutMs)
    expect(cfg.budgetMs).toBe(CONFIG_DEFAULTS.budgetMs)
    expect(cfg.corpusPath).toBeUndefined()
  })

  it('fail loud：身份字段空、数值非正整数、corpusPath 空', () => {
    expect(() => resolveConfig({ ...BASE, rootSessionId: '' })).toThrow(TypeError)
    expect(() => resolveConfig({ ...BASE, creds: { name: 'n', pass: '' } })).toThrow(TypeError)
    expect(() => resolveConfig({ ...BASE, connect: { host: 'h', port: 0 } })).toThrow(TypeError)
    expect(() => resolveConfig({ ...BASE, silenceMs: -1 })).toThrow(TypeError)
    expect(() => resolveConfig({ ...BASE, budgetMs: 1.5 })).toThrow(TypeError)
    expect(() => resolveConfig({ ...BASE, corpusPath: ' ' })).toThrow(TypeError)
  })
})

describe('apply 装配', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('belongs 过滤：无关会话不装配（不注册工具/persona）', () => {
    const { ctx, raw } = fakeCtx()
    apply(ctx, BASE)
    const stranger = fakeAgent('other-s', { depth: 1, parent: 'another-root' })
    raw.emit('agent/created', { agent: stranger } as never)
    expect(stranger.ctx.tools.register).not.toHaveBeenCalled()
    expect(stranger.ctx.systemPrompt.section).not.toHaveBeenCalled()
  })

  it('根装配：persona + 三工具 + Wake 初始武装（静默到期 → followup）', () => {
    const { ctx, raw } = fakeCtx()
    apply(ctx, BASE)
    const root = fakeAgent('root-s')
    raw.emit('agent/created', { agent: root } as never)
    expect(root.ctx.systemPrompt.section).toHaveBeenCalledTimes(1)
    const names = root.ctx.tools.register.mock.calls.map(c => (c[0] as { name: string }).name)
    expect(names).toEqual(['mud_send', 'mud_flow', 'mud_state'])

    vi.advanceTimersByTime(BASE.silenceMs)
    // 静默到期 → followup（唤醒正文经 agent.followup 投递；spy 断言见下一用例）。
  })

  it('根装配（followup/steer spy）：静默到期走 followup，子级装配与到期 interrupt 走宿主通路', () => {
    const { ctx, raw } = fakeCtx()
    const followup = vi.fn()
    const steer = vi.fn()
    apply(ctx, BASE)

    const root = fakeAgent('root-s')
    ;(root as unknown as { followup: unknown }).followup = followup
    ;(root as unknown as { steer: unknown }).steer = steer
    raw.emit('agent/created', { agent: root } as never)
    vi.advanceTimersByTime(BASE.silenceMs)
    expect(followup).toHaveBeenCalledTimes(1)

    const child = fakeAgent('child-s', { depth: 1, parent: 'root-s' })
    raw.emit('agent/created', { agent: child } as never)
    const names = child.ctx.tools.register.mock.calls.map(c => (c[0] as { name: string }).name)
    expect(names).toEqual(['mud_send', 'mud_flow', 'mud_state'])
    expect(child.ctx.systemPrompt.section).not.toHaveBeenCalled() // persona 只进根

    vi.advanceTimersByTime(BASE.budgetMs)
    expect(raw.subagents.interrupt).toHaveBeenCalledWith('child-s', { kind: 'user', parentSessionId: 'root-s' })
    expect(followup).toHaveBeenCalledTimes(1) // 预算 interrupt 不经唤醒通道
  })

  it('agent/disposed：撤预算 timer（不再 interrupt）与根 Wake', () => {
    const { ctx, raw } = fakeCtx()
    apply(ctx, BASE)
    const child = fakeAgent('child-s', { depth: 1, parent: 'root-s' })
    raw.emit('agent/created', { agent: child } as never)
    raw.emit('agent/disposed', { agent: child } as never)
    vi.advanceTimersByTime(BASE.budgetMs)
    expect(raw.subagents.interrupt).not.toHaveBeenCalled()
  })

  it('session/disposed（根）触发断连路径不抛错；卸载 disposer 清 budget', () => {
    const { ctx, raw, disposers } = fakeCtx()
    apply(ctx, BASE)
    expect(() => raw.emit('session/disposed', { id: 'root-s' } as never)).not.toThrow()
    expect(() => raw.emit('session/disposed', { id: 'other-s' } as never)).not.toThrow()
    expect(disposers).toHaveLength(1)
    const dispose = disposers[0]
    if (dispose !== undefined) expect(() => dispose()).not.toThrow()
  })
})
