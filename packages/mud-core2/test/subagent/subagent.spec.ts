import { describe, expect, it, vi } from 'vitest'
import { BudgetRegistry, createAgentCreatedHandler, depthByOptions, type SubagentAgent } from '../../src/subagent/subagent.ts'
import { World } from '../../src/awareness/world.ts'
import type { Flow } from '../../src/tools/flows/types.ts'
import type { Mud } from '../../src/link/mud.ts'
import type { MudLine } from '../../src/link/ansi.ts'
import type { MudToolDefinition } from '../../src/tools/tools.ts'

/** 宿主 Agent 的测试桩。 */
function mkAgent(id: string, subagentDepth?: number): SubagentAgent & { cancels: Array<{ cause: unknown; options: unknown }> } {
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  return {
    id,
    options: subagentDepth === undefined ? {} : { subagentDepth },
    cancel(cause, options) {
      cancels.push({ cause, options })
    },
    cancels,
  }
}

describe('BudgetRegistry（插件唯一保留的子级运营状态）', () => {
  it('budgetMs 上下界 fail-loud：非正整数或超 setTimeout 溢出点即拒', () => {
    expect(() => new BudgetRegistry({ budgetMs: 0 })).toThrow(TypeError)
    expect(() => new BudgetRegistry({ budgetMs: -1 })).toThrow(TypeError)
    expect(() => new BudgetRegistry({ budgetMs: 1.5 })).toThrow(TypeError)
    expect(() => new BudgetRegistry({ budgetMs: 2 ** 31 })).toThrow(TypeError) // 溢出点之上
    expect(() => new BudgetRegistry({ budgetMs: 2 ** 31 - 1 })).not.toThrow() // 恰在上界
  })

  it('到期 interrupt：缺省动词 cancel({kind:parent},{keepInbox:true}) + 自摘条目 + onExpire', () => {
    vi.useFakeTimers()
    try {
      const onExpire = vi.fn()
      const budget = new BudgetRegistry({ budgetMs: 20_000, onExpire })
      const agent = mkAgent('child-a', 1)
      budget.register(agent)

      expect(budget.size).toBe(1)
      expect(budget.deadlineOf('child-a')).toBeGreaterThan(Date.now() - 1)
      vi.advanceTimersByTime(19_999)
      expect(agent.cancels).toEqual([]) // 差 1ms 不触发
      vi.advanceTimersByTime(1)

      expect(agent.cancels).toEqual([{ cause: { kind: 'parent' }, options: { keepInbox: true } }])
      expect(onExpire).toHaveBeenCalledWith('child-a')
      expect(budget.size).toBe(0) // 自摘（终结与再 interrupt 都不归本层管）
    } finally {
      vi.useRealTimers()
    }
  })

  it('注入 interruptAgent：到期走宿主入口通路，不走直接 cancel', () => {
    vi.useFakeTimers()
    try {
      const interruptAgent = vi.fn()
      const budget = new BudgetRegistry({ budgetMs: 10_000, interruptAgent })
      const agent = mkAgent('child-a2', 1)
      budget.register(agent)
      vi.advanceTimersByTime(10_000)
      expect(interruptAgent).toHaveBeenCalledWith('child-a2')
      expect(agent.cancels).toEqual([]) // 直接 cancel 未被调用
    } finally {
      vi.useRealTimers()
    }
  })

  it('clear() 撤 timer：终结后到期不 interrupt', () => {
    vi.useFakeTimers()
    try {
      const budget = new BudgetRegistry({ budgetMs: 20_000 })
      const agent = mkAgent('child-b', 1)
      budget.register(agent)
      budget.clear('child-b')
      vi.advanceTimersByTime(60_000)
      expect(agent.cancels).toEqual([])
      expect(budget.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resume 重入 = 重计预算：旧 timer 撤销，只新预算到期会 interrupt', () => {
    vi.useFakeTimers()
    try {
      const budget = new BudgetRegistry({ budgetMs: 50_000 })
      const first = mkAgent('child-c', 1)
      budget.register(first)
      vi.advanceTimersByTime(15_000)
      const resumed = mkAgent('child-c', 1) // 同 id 重入（resume 重建 agent 对象）
      budget.register(resumed)
      vi.advanceTimersByTime(20_000) // t=35s：旧预算（t=0 计 50s）与新预算（t=15s 计）都未到期

      expect(first.cancels).toEqual([]) // 旧 timer 已撤
      expect(resumed.cancels).toEqual([])
      expect(budget.size).toBe(1)
      vi.advanceTimersByTime(45_000) // t=80s：新预算（t=15s 计 50s）已到期
      expect(first.cancels).toEqual([])
      expect(resumed.cancels).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 清全部 timer', () => {
    vi.useFakeTimers()
    try {
      const budget = new BudgetRegistry({ budgetMs: 20_000 })
      const a = mkAgent('child-d', 1)
      const b = mkAgent('child-e', 1)
      budget.register(a)
      budget.register(b)
      budget.dispose()
      vi.advanceTimersByTime(60_000)
      expect(a.cancels).toEqual([])
      expect(b.cancels).toEqual([])
      expect(budget.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createAgentCreatedHandler（agent/created 处理器，宿主作用域装配）', () => {
  function setup(budgetMs = 60_000, depthOf: (a: SubagentAgent) => number = depthByOptions) {
    const world = new World()
    const mud = { connected: false, send: () => true, connect: () => {}, read: () => undefined } as unknown as Mud
    const scope = { register: () => () => {} }
    const handler = createAgentCreatedHandler(
      { mud, world, creds: { name: 'u', pass: 'p' }, connect: { host: 'localhost', port: 23 }, defaultTimeoutMs: 30_000 },
      { budgetMs },
      depthOf,
    )
    return { handler, scope, world }
  }

  it('root agent：holder=root，三工具注册完整（自检），不登记预算', () => {
    const { handler, scope } = setup()
    const r = handler.handleCreated(scope, mkAgent('root-1'))
    expect(r.holder).toBe('root')
    expect(handler.budget.size).toBe(0)
  })

  it('child agent：holder=child:<id>，登记预算', () => {
    const { handler, scope } = setup()
    const r = handler.handleCreated(scope, mkAgent('sess-1', 1))
    expect(r.holder).toBe('child:sess-1')
    expect(handler.budget.size).toBe(1)
  })

  it('depthOf 必填：header 权威判定由装配层供给（resume 子级不被误判 root）', () => {
    // 模拟 resume：options 缺 subagentDepth，header 带深度（装配读宿主 header）。
    const agent = { id: 'sess-2', options: {}, cancel: () => {} }
    const headerDepth: (a: SubagentAgent) => number = () => 1
    const { handler, scope } = setup(60_000, headerDepth)
    const r = handler.handleCreated(scope, agent)
    expect(r.holder).toBe('child:sess-2')
    expect(handler.budget.size).toBe(1)
  })

  it('gate 跨 agent 共享：两次 handleCreated 共乘一次登录（登录流程只跑一次）', async () => {
    const runs: number[] = []
    const sent: string[] = []
    const fakeLogin: Flow = { id: 'login', description: 'fake', async run() { runs.push(1); return { done: true } } }
    const world = new World()
    const mud = {
      connected: false,
      send: (cmd: string) => { sent.push(cmd); return true },
      connect: () => {},
      read: async () => ({ lines: [] as MudLine[], reason: 'done' }),
    } as unknown as Mud
    const handler = createAgentCreatedHandler(
      { mud, world, creds: { name: 'u', pass: 'p' }, connect: { host: 'localhost', port: 23 }, defaultTimeoutMs: 30_000, flows: [fakeLogin] },
      { budgetMs: 60_000 },
      depthByOptions,
    )

    // 两次创建（root + child），各自捕获注册到的 mud_send。
    const sends: Array<MudToolDefinition> = []
    for (const agent of [mkAgent('root-x'), mkAgent('sess-x', 1)]) {
      const defs = new Map<string, MudToolDefinition>()
      handler.handleCreated({ register: (def) => { defs.set(def.name, def); return () => {} } }, agent)
      sends.push(defs.get('mud_send')!)
    }

    // 各自执行一次 mud_send：共享闸门 ⇒ 隐式登录只发生一次。
    const signal = new AbortController().signal
    await sends[0]!.execute({ cmd: 'look' }, { signal })
    await sends[1]!.execute({ cmd: 'look' }, { signal })
    expect(runs).toHaveLength(1)
    expect(sent).toEqual(['look', 'look'])
  })
})
