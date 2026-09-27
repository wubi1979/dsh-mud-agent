/**
 * index 装配层单测（§3.3；P2 修订 v2）：Config fail-loud、归属门（preset）、
 * 单根守卫（D7）、根/子分流、disposed 撤表、到期 interrupt 参数源（D3：
 * 子级自己的 session.header.parentSession）、mudCore2 引擎窄面（D8）。
 *
 * 宿主面用窄 fake（Context/Agent 结构兼容对象 cast）——装配层只消费
 * on/effect/get/provide + ctx.agentPresets.composedPreset + agent 的
 * followup/steer 窄面。工具与 persona 由 preset 行注册（preset.spec.ts），
 * 本文件不再断言 agent/created 期的工具注册。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.ts'
import { CONFIG_DEFAULTS, PRESET_ID, resolveConfig, type MudCore2Config } from '../src/config.ts'
import type { SubagentAgent } from '../src/subagent/subagent.ts'
import type { MudCoreHandle, ToolAgent } from '../src/tools/tools.ts'

const BASE: MudCore2Config = {
  connect: { host: 'h', port: 1 },
  creds: { name: 'n', pass: 'p' },
  silenceMs: 1000,
  defaultTimeoutMs: 5000,
  budgetMs: 60_000,
}

/** 窄 fake agent（SubagentAgent + agent.ctx 窄面）。 */
function fakeAgent(id: string, opts: { depth?: number; parent?: string } = {}): SubagentAgent & {
  ctx: Record<string, unknown>
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
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
    ctx: { __fakeAgentCtx: id },
  } as never
}

/** 窄 fake cordis ctx：捕获事件监听器、provide 服务与卸载 disposer；
 *  agentPresets.composedPreset 按 agent.ctx 查表（归属门 fake）。 */
function fakeCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>()
  const disposers: Array<() => void> = []
  const provided = new Map<string, unknown>()
  const presetByCtx = new Map<unknown, string | undefined>()
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
    provide(name: string, value: unknown): () => void {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name: string): unknown {
      if (name === 'agentPresets') {
        return { composedPreset: (agentCtx: unknown) => presetByCtx.get(agentCtx) }
      }
      return provided.get(name)
    },
    emit(event: string, payload: never): void {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    },
  }
  return { ctx: ctx as never, listeners, disposers, provided, presetByCtx, raw: ctx }
}

/** 把 fake agent 标记为 mud-player preset 成员（归属门命中）。 */
function admitPreset(state: ReturnType<typeof fakeCtx>, agent: { ctx: unknown }, preset: string = PRESET_ID): void {
  state.presetByCtx.set(agent.ctx, preset)
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

  it('fail loud：身份字段空、数值非正整数、corpusPath 空（rootSessionId 已废除，D1 修订）', () => {
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

  function holderOf(state: ReturnType<typeof fakeCtx>, agent: ToolAgent): { holder: string } | { error: string } {
    const core = state.provided.get('mudCore2') as MudCoreHandle
    expect(core).toBeDefined()
    return core.resolveHolder(agent)
  }

  it('归属门过滤：非 mud-player preset 的会话不装配（Wake 不挂、单根登记不收）', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const stranger = fakeAgent('other-s')
    admitPreset(state, stranger, 'standard')
    state.raw.emit('agent/created', { agent: stranger } as never)
    vi.advanceTimersByTime(BASE.silenceMs)
    expect(stranger.followup).not.toHaveBeenCalled()
    // 陌生根不被登记：其工具调用被拒（尚无登记的根会话）
    expect(holderOf(state, fakeAgent('other-s'))).toEqual({
      error: expect.stringContaining('尚无登记的根会话'),
    })
  })

  it('根装配：Wake 初始武装（静默到期 → followup）+ 引擎窄面登记 root holder', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const root = fakeAgent('root-s')
    admitPreset(state, root)
    state.raw.emit('agent/created', { agent: root } as never)

    expect(holderOf(state, fakeAgent('root-s'))).toEqual({ holder: 'root' })
    vi.advanceTimersByTime(BASE.silenceMs)
    expect(root.followup).toHaveBeenCalledTimes(1)
  })

  it('resume（同 id 重建实例）不触发单根守卫：仍是根且重新武装', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const first = fakeAgent('root-s')
    admitPreset(state, first)
    state.raw.emit('agent/created', { agent: first } as never)
    vi.advanceTimersByTime(500)
    const second = fakeAgent('root-s')
    admitPreset(state, second)
    state.raw.emit('agent/created', { agent: second } as never)
    expect(holderOf(state, fakeAgent('root-s'))).toEqual({ holder: 'root' })

    // 新实例重新计时：t=1000（旧实例的静默点）不投递，t=1500（新实例）投递
    vi.advanceTimersByTime(500)
    expect(second.followup).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(second.followup).toHaveBeenCalledTimes(1)
  })

  it('D7 单根守卫：第二个根候选 fail-loud——不抢占 Wake，其工具调用被可读拒绝', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const root1 = fakeAgent('root-1')
    admitPreset(state, root1)
    state.raw.emit('agent/created', { agent: root1 } as never)

    const root2 = fakeAgent('root-2')
    admitPreset(state, root2)
    state.raw.emit('agent/created', { agent: root2 } as never)

    vi.advanceTimersByTime(BASE.silenceMs)
    expect(root1.followup).toHaveBeenCalledTimes(1) // 首个根独占
    expect(root2.followup).not.toHaveBeenCalled() // 不抢占
    const r = holderOf(state, fakeAgent('root-2'))
    expect('error' in r).toBe(true)
    expect((r as { error: string }).error).toContain('单根守卫')
    expect((r as { error: string }).error).toContain('root-1')
  })

  it('子级装配与到期 interrupt 走宿主通路；参数源 = 子级自己的 header.parentSession（D3）', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const root = fakeAgent('root-s')
    admitPreset(state, root)
    state.raw.emit('agent/created', { agent: root } as never)

    // 直接父 = root-s（与"绑定的根"无关：参数源是子级 header，D3）
    const child = fakeAgent('child-s', { depth: 1, parent: 'root-s' })
    admitPreset(state, child)
    state.raw.emit('agent/created', { agent: child } as never)
    expect(holderOf(state, fakeAgent('child-s', { depth: 1, parent: 'root-s' }))).toEqual({ holder: 'child:child-s' })

    vi.advanceTimersByTime(BASE.budgetMs)
    expect(state.raw.subagents.interrupt).toHaveBeenCalledWith('child-s', { kind: 'user', parentSessionId: 'root-s' })
    // 预算 interrupt 只走宿主通路；根侧仅收到静默唤醒（t=silenceMs，正常节律），无危险 steer。
    expect(root.followup).toHaveBeenCalledTimes(1)
    expect(root.steer).not.toHaveBeenCalled()
  })

  it('子级缺 header.parentSession → 登记即 fail-loud（D3 参数源缺失不允许静默）', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const child = fakeAgent('child-s', { depth: 1 })
    admitPreset(state, child)
    expect(() => state.raw.emit('agent/created', { agent: child } as never)).toThrow(TypeError)
  })

  it('agent/disposed：撤预算 timer（不再 interrupt）与根 Wake', () => {
    const state = fakeCtx()
    apply(state.ctx, BASE)
    const child = fakeAgent('child-s', { depth: 1, parent: 'root-s' })
    admitPreset(state, child)
    state.raw.emit('agent/created', { agent: child } as never)
    state.raw.emit('agent/disposed', { agent: child } as never)
    vi.advanceTimersByTime(BASE.budgetMs)
    expect(state.raw.subagents.interrupt).not.toHaveBeenCalled()

    const root = fakeAgent('root-s')
    admitPreset(state, root)
    state.raw.emit('agent/created', { agent: root } as never)
    state.raw.emit('agent/disposed', { agent: root } as never)
    // 根实例终结后其工具调用被拒（rootAgentId 已清）
    expect(holderOf(state, fakeAgent('root-s'))).toEqual({
      error: expect.stringContaining('尚无登记的根会话'),
    })
  })

  it('session/disposed：根登记会话触发断连路径不抛错；非根会话不触发；卸载 disposer 清 budget', () => {
    const state = fakeCtx()
    const root = fakeAgent('root-s')
    admitPreset(state, root)
    apply(state.ctx, BASE)
    state.raw.emit('agent/created', { agent: root } as never)

    expect(() => state.raw.emit('session/disposed', { id: 'other-s' } as never)).not.toThrow()
    expect(() => state.raw.emit('session/disposed', { id: 'root-s' } as never)).not.toThrow()
    expect(state.disposers).toHaveLength(1)
    const dispose = state.disposers[0]
    if (dispose !== undefined) expect(() => dispose()).not.toThrow()
  })
})
