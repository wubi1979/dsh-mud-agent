import { describe, expect, it, vi } from 'vitest'
import { BudgetRegistry, depthByHeader, depthByOptions, type SubagentAgent } from '../../src/subagent/subagent.ts'

/** 宿主 Agent 的测试桩（子级必带 header.parentSession——P2 D3 参数源）。 */
function mkAgent(
  id: string,
  subagentDepth?: number,
  parentSession?: string,
): SubagentAgent & { cancels: Array<{ cause: unknown; options: unknown }> } {
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  return {
    id,
    options: subagentDepth === undefined ? {} : { subagentDepth },
    session: {
      header: {
        ...(subagentDepth === undefined ? {} : { delegationDepth: subagentDepth }),
        ...(parentSession === undefined ? {} : { parentSession }),
      },
    },
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
      const agent = mkAgent('child-a', 1, 'root-x')
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

  it('注入 interruptAgent：到期走宿主入口通路，参数源 = 登记时的直接父会话（P2 D3）', () => {
    vi.useFakeTimers()
    try {
      const interruptAgent = vi.fn()
      const budget = new BudgetRegistry({ budgetMs: 10_000, interruptAgent })
      const agent = mkAgent('child-a2', 1, 'proxy-root')
      budget.register(agent)
      vi.advanceTimersByTime(10_000)
      expect(interruptAgent).toHaveBeenCalledWith('child-a2', 'proxy-root')
      expect(agent.cancels).toEqual([]) // 直接 cancel 未被调用
    } finally {
      vi.useRealTimers()
    }
  })

  it('子级缺 header.parentSession → 登记即 fail-loud（D3：参数缺失不允许静默登记）', () => {
    const budget = new BudgetRegistry({ budgetMs: 10_000 })
    expect(() => budget.register(mkAgent('child-no-parent', 1))).toThrow(TypeError)
    expect(budget.size).toBe(0)
  })

  it('clear() 撤 timer：终结后到期不 interrupt', () => {
    vi.useFakeTimers()
    try {
      const budget = new BudgetRegistry({ budgetMs: 20_000 })
      const agent = mkAgent('child-b', 1, 'root-x')
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
      const first = mkAgent('child-c', 1, 'root-x')
      budget.register(first)
      vi.advanceTimersByTime(15_000)
      const resumed = mkAgent('child-c', 1, 'root-x') // 同 id 重入（resume 重建 agent 对象）
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
      const a = mkAgent('child-d', 1, 'root-x')
      const b = mkAgent('child-e', 1, 'root-x')
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

describe('深度判定（D2：header 权威，options 兜底）', () => {
  it('depthByHeader：max(header.delegationDepth, options.subagentDepth)；resume 场景 header 不被 options 覆盖', () => {
    expect(depthByHeader(mkAgent('r'))).toBe(0)
    expect(depthByHeader(mkAgent('c1', 1, 'p'))).toBe(1)
    // resume 携新 options（subagentDepth 缺席）时 header 权威
    expect(depthByHeader({ id: 'r2', options: {}, session: { header: { delegationDepth: 2 } }, cancel: () => {} })).toBe(2)
  })

  it('depthByOptions：纯 options 读法（仅供测试与已知无 resume 场景显式选用）', () => {
    expect(depthByOptions(mkAgent('r'))).toBe(0)
    expect(depthByOptions(mkAgent('c1', 1, 'p'))).toBe(1)
  })
})
