/**
 * registry — 流程注册表用例：保存门（schema/结构/凭据红线/locked 拒改）
 * + 预制覆盖还原 + storage 域挂载迁移 + 内存降级。
 */

import { describe, expect, it } from 'vitest'

import { WorkflowRegistry } from '../src/core/index.ts'
import { checkFlow, type Flow, type HostTable, type WorkflowRecord } from '../src/contract/index.ts'

/** 最小合法流程（单步，等一行后成功出口）。 */
function simpleFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    entry: 'a',
    steps: [
      {
        id: 'a',
        wait: { until: ['成功'], timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      },
    ],
    ...overrides,
  }
}

/** 存储记录（合法缺省）。 */
function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    name: 'demo',
    title: '演示',
    locked: false,
    version: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    flow: simpleFlow(),
    ...overrides,
  }
}

function memoryTable<V>(): HostTable<V> & { store: Map<string, V> } {
  const store = new Map<string, V>()
  return {
    store,
    get: (key) => store.get(key),
    entries: () => store.entries(),
    put: async (key, value) => { store.set(key, value) },
    delete: async (key) => store.delete(key),
  }
}

describe('WorkflowRegistry 保存门', () => {
  it('合法流程可保存：version 从 1 起，list/get 可见', async () => {
    const registry = new WorkflowRegistry()
    const saved = await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })
    expect(saved.version).toBe(1)
    expect(registry.get('demo')?.title).toBe('演示')
    expect(registry.list().map(r => r.name)).toContain('demo')
  })

  it('覆盖保存 version 自增', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })
    const again = await registry.save({ name: 'demo', title: '演示 v2', flow: simpleFlow() })
    expect(again.version).toBe(2)
  })

  it('流程非法（goto 指向不存在的步）可读拒绝', async () => {
    const registry = new WorkflowRegistry()
    const bad = simpleFlow({
      steps: [{ id: 'a', next: { goto: 'missing' } }],
    })
    await expect(registry.save({ name: 'demo', title: '演示', flow: bad }))
      .rejects.toThrow(/指向不存在的步/)
  })

  it("出口 stage 'success' 标 ok:false 可读拒绝", async () => {
    const registry = new WorkflowRegistry()
    const bad = simpleFlow({
      steps: [{ id: 'a', next: { exit: { stage: 'success', ok: false } } }],
    })
    await expect(registry.save({ name: 'demo', title: '演示', flow: bad }))
      .rejects.toThrow(/success/)
  })

  it('凭据红线：agent 流程含 sendCredential 可读拒绝', async () => {
    const registry = new WorkflowRegistry()
    const bad = simpleFlow({
      steps: [{
        id: 'a',
        action: { sendCredential: '{pass}' },
        next: { exit: { stage: 'success', ok: true } },
      }],
    })
    await expect(registry.save({ name: 'demo', title: '演示', flow: bad }))
      .rejects.toThrow(/sendCredential/)
  })

  it('locked 预制：save 与 delete 均可读拒绝', async () => {
    const registry = new WorkflowRegistry([record({ name: 'login', locked: true })])
    await expect(registry.save({ name: 'login', title: '登录', flow: simpleFlow() }))
      .rejects.toThrow(/已锁定/)
    await expect(registry.delete('login')).rejects.toThrow(/已锁定/)
  })

  it('非 locked 预制：可覆盖（version 接续），delete 还原为预制', async () => {
    const prefab = record({ name: 'supply', version: 3 })
    const registry = new WorkflowRegistry([prefab])
    const saved = await registry.save({ name: 'supply', title: '补给', flow: simpleFlow() })
    expect(saved.version).toBe(4)
    expect(registry.get('supply')?.title).toBe('补给')
    await registry.delete('supply')
    expect(registry.get('supply')?.version).toBe(3) // 还原预制
  })

  it('onFailOn/branch 命中序越界可读拒绝', async () => {
    const registry = new WorkflowRegistry()
    const bad = simpleFlow({
      steps: [{
        id: 'a',
        wait: { failOn: ['失败'], timeoutMs: 1000 },
        onFailOn: { '1': { exit: { stage: 'x', ok: false } } }, // failOn 只有 1 条
        next: { exit: { stage: 'success', ok: true } },
      }],
    })
    await expect(registry.save({ name: 'demo', title: '演示', flow: bad }))
      .rejects.toThrow(/越界/)
  })
})

describe('WorkflowRegistry 构造门（预制 fail-loud）', () => {
  it('预制流程非法时构造 throw（宁可拒装不带病运行）', () => {
    const bad = record({ flow: { entry: 'a', steps: [{ id: 'a', next: { goto: 'missing' } }] } })
    expect(() => new WorkflowRegistry([bad])).toThrow(/指向不存在的步/)
  })

  it('非 locked 预制含凭据动词时构造 throw（红线）', () => {
    const bad = record({
      flow: {
        entry: 'a',
        steps: [{ id: 'a', action: { sendCredential: '{pass}' } }],
      },
    })
    expect(() => new WorkflowRegistry([bad])).toThrow(/sendCredential/)
  })
})

describe('captcha 动作红线与校验门（T13.1）', () => {
  /** captcha 纯动作步缩样（无 wait——wait 门已废止，结构收束归 judge 窗）。
   * T14 D9 参数化：url 收槽面（本用例只验红线，值任意）。 */
  const captchaFlow: Flow = {
    entry: 'answer',
    steps: [
      { id: 'answer', action: { captcha: { url: '{captchaUrl}' } }, next: { exit: { stage: 'success', ok: true } } },
    ],
  }

  it('④ save 侧：agent 流程含 captcha 可读拒绝（locked-only 红线，与 sendCredential 同列）', async () => {
    const registry = new WorkflowRegistry()
    await expect(registry.save({ name: 'demo', title: '演示', flow: captchaFlow }))
      .rejects.toThrow(/captcha/)
  })

  it('⑥ captcha 纯动作步（无 wait）合法通过：checkFlow 不抛 + locked 预制构造通过', () => {
    expect(() => checkFlow(captchaFlow)).not.toThrow()
    const registry = new WorkflowRegistry([record({ name: 'fullme', locked: true, flow: captchaFlow })])
    expect(registry.get('fullme')).toBeDefined()
  })

  it('构造门：非 locked 预制含 captcha throw（红线）', () => {
    expect(() => new WorkflowRegistry([record({ flow: captchaFlow })])).toThrow(/captcha/)
  })
})

describe('捕获槽保存门（T14.1：captures 声明四校验，2.3/D10）', () => {
  /** 捕获步缩样（until/failOn/captures 可覆写）。 */
  function captureFlow(overrides: {
    until?: string[]
    captures?: string[]
  }): Flow {
    const { until = ['^(\\S+) 线索'], captures = ['who'] } = overrides
    return {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { until, captures, timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
  }

  it('合法声明通过：until[0] 组数 ≥ captures 数', () => {
    expect(() => checkFlow(captureFlow({ until: ['^(\\S+)给(\\S+)的东西'], captures: ['from', 'what'] }))).not.toThrow()
  })

  it('④a 保留名拒存（captcha/name/pass）', () => {
    for (const name of ['captcha', 'name', 'pass']) {
      expect(() => checkFlow(captureFlow({ captures: [name] }))).toThrow(/保留名/)
    }
  })

  it('④b 组数不足拒存（until[0] 捕获组少于 captures 声明）', () => {
    const bad = captureFlow({ until: ['^(\\S+) 线索'], captures: ['a', 'b'] })
    expect(() => checkFlow(bad)).toThrow(/捕获组 1 个，少于 captures 声明的 2 个/)
  })

  it('④c 非 until[0] 引入捕获组拒存（组号计数与提取会错位）', () => {
    const bad = captureFlow({ until: ['^(\\S+) 线索', '^(\\S+) 出现'], captures: ['who'] })
    expect(() => checkFlow(bad)).toThrow(/只允许出现在 until\[0\]/)
  })

  it('④d 槽名非法拒存（只允许字母/数字/下划线）', () => {
    expect(() => checkFlow(captureFlow({ captures: ['attacker-name'] }))).toThrow(/槽名非法/)
  })

  it('④e captures 无 until 拒存', () => {
    const bad: Flow = {
      entry: 'a',
      steps: [{ id: 'a', wait: { gaCount: 1, captures: ['who'], timeoutMs: 1000 }, next: { exit: { stage: 'success', ok: true } } }],
    }
    expect(() => checkFlow(bad)).toThrow(/没有 until 判据/)
  })

  it('④f save 侧联动：captures 非法流程经 registry.save 可读拒绝', async () => {
    const registry = new WorkflowRegistry()
    await expect(registry.save({ name: 'demo', title: '演示', flow: captureFlow({ captures: ['pass'] }) }))
      .rejects.toThrow(/保留名/)
  })
})

describe('WorkflowRegistry 存储双态', () => {
  it('未挂域时内存降级可用', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })
    expect(registry.domainAttached).toBe(false)
    expect(registry.get('demo')).toBeDefined()
  })

  it('挂域后内存记录迁入，后续写入落域', async () => {
    const table = memoryTable<WorkflowRecord>()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })

    await registry.attachDomain(table)
    expect(registry.domainAttached).toBe(true)
    expect(table.store.get('demo')?.title).toBe('演示')

    await registry.save({ name: 'demo', title: '演示 v2', flow: simpleFlow() })
    expect(table.store.get('demo')?.version).toBe(2)
  })

  it('预制与 agent 修缮合并呈现：修缮优先，预制不被写坏', async () => {
    const table = memoryTable<WorkflowRecord>()
    const prefab = record({ name: 'supply', version: 1 })
    const registry = new WorkflowRegistry([prefab])
    await registry.attachDomain(table)
    await registry.save({ name: 'supply', title: '补给改', flow: simpleFlow() })

    const all = registry.list()
    expect(all.filter(r => r.name === 'supply')).toHaveLength(1)
    expect(registry.get('supply')?.title).toBe('补给改')
    expect(prefab.title).toBe('演示') // 预制对象未被变异
  })
})
