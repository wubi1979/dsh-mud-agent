/**
 * registry — 流程注册表用例：保存门（schema/结构/凭据红线/locked 拒改）
 * + 预制覆盖还原 + storage 域挂载迁移 + 内存降级。
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_SNAPSHOTS_PER_FLOW, WorkflowRegistry, snapshotKey, type WorkflowDomainTables,
} from '../src/core/index.ts'
import {
  checkFlow, type Flow, type HostTable, type WorkflowRecord, type WorkflowSnapshot,
} from '../src/contract/index.ts'

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

/** 域表组（生效记录 + 变更账本），带底层 Map 供断言。 */
function domainTables(): {
  tables: WorkflowDomainTables
  workflows: Map<string, WorkflowRecord>
  snapshots: Map<string, WorkflowSnapshot>
} {
  const workflows = memoryTable<WorkflowRecord>()
  const snapshots = memoryTable<WorkflowSnapshot>()
  return { tables: { workflows, snapshots }, workflows: workflows.store, snapshots: snapshots.store }
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
    const { tables, workflows } = domainTables()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })

    await registry.attachDomain(tables)
    expect(registry.domainAttached).toBe(true)
    expect(workflows.get('demo')?.title).toBe('演示')

    await registry.save({ name: 'demo', title: '演示 v2', flow: simpleFlow() })
    expect(workflows.get('demo')?.version).toBe(2)
  })

  it('预制与 agent 修缮合并呈现：修缮优先，预制不被写坏', async () => {
    const { tables } = domainTables()
    const prefab = record({ name: 'supply', version: 1 })
    const registry = new WorkflowRegistry([prefab])
    await registry.attachDomain(tables)
    await registry.save({ name: 'supply', title: '补给改', flow: simpleFlow() })

    const all = registry.list()
    expect(all.filter(r => r.name === 'supply')).toHaveLength(1)
    expect(registry.get('supply')?.title).toBe('补给改')
    expect(prefab.title).toBe('演示') // 预制对象未被变异
  })
})

describe('名册冲突裁决与来源标记（2026-10-05 策略 A）', () => {
  /** locked 内置 login（引擎侧名册；挂载晚于修缮的场景 = 抢名）。 */
  const lockedLogin = record({ name: 'login', title: '登录（内置 locked）', locked: true })

  it('⑫ locked 内置优先：先到的同名修缮被遮蔽（生效 = 内置，来源 = builtin，shadowed 保留）', async () => {
    const registry = new WorkflowRegistry()
    // core3 缺席期抢名（此时无内置 ⇒ save 门放行）
    await registry.save({ name: 'login', title: '冒充登录', flow: simpleFlow() })
    registry.registerBuiltins([lockedLogin])

    expect(registry.get('login')).toMatchObject({ locked: true, title: '登录（内置 locked）' })
    const entry = registry.entries().find(e => e.record.name === 'login')!
    expect(entry.origin).toBe('builtin')
    expect(entry.shadowed).toMatchObject({ title: '冒充登录', locked: false })
    // 同名只取一条（生效记录）
    expect(registry.list().filter(r => r.name === 'login')).toHaveLength(1)
  })

  it('⑬ 被遮蔽的修缮可 delete（放行）；清掉后生效仍是内置', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'login', title: '冒充登录', flow: simpleFlow() })
    registry.registerBuiltins([lockedLogin])

    await expect(registry.delete('login')).resolves.toBe(true)
    expect(registry.get('login')).toMatchObject({ locked: true, title: '登录（内置 locked）' })
    expect(registry.entries().find(e => e.record.name === 'login')!.shadowed).toBeUndefined()
  })

  it('⑭ 无同名修缮时 delete locked 仍拒（原语义不回退）', async () => {
    const registry = new WorkflowRegistry([lockedLogin])
    await expect(registry.delete('login')).rejects.toThrow(/已锁定/)
  })

  it('⑮ 来源标记：内置 = builtin；agent 新建与非 locked 预制的修缮 = refined', async () => {
    const prefab = record({ name: 'supply', title: '补给粗胚', version: 3 })
    const registry = new WorkflowRegistry([prefab])
    await registry.save({ name: 'mine', title: '自建', flow: simpleFlow() })
    await registry.save({ name: 'supply', title: '补给改', flow: simpleFlow() })

    const byName = new Map(registry.entries().map(e => [e.record.name, e]))
    expect(byName.get('supply')).toMatchObject({ origin: 'refined' })
    expect(byName.get('mine')).toMatchObject({ origin: 'refined' })
    expect(byName.get('login')).toBeUndefined()

    // 未修缮的非 locked 预制 = builtin
    const fresh = new WorkflowRegistry([prefab])
    expect(fresh.entries().find(e => e.record.name === 'supply')).toMatchObject({ origin: 'builtin' })
  })

  it('⑯ locked 名称的覆盖保存仍拒（save 门不回退）——含遮蔽状态下', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'login', title: '冒充登录', flow: simpleFlow() })
    registry.registerBuiltins([lockedLogin])
    await expect(registry.save({ name: 'login', title: '再改', flow: simpleFlow() }))
      .rejects.toThrow(/已锁定/)
  })
})

describe('迁入取新与变更账本（T16）', () => {
  const rolledFlow: Flow = {
    entry: 'a',
    steps: [{ id: 'a', next: { exit: { stage: 'rolled', ok: false } } }],
  }

  it('⑰ 迁入按 version 取新：域内 v9 不被内存 v1 覆盖，落败方归档为 migration 快照', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '内存期修缮', flow: simpleFlow() })
    const { tables, workflows, snapshots } = domainTables()
    workflows.set('demo', record({ name: 'demo', title: '域内新版', version: 9 }))

    const report = await registry.attachDomain(tables)

    expect(workflows.get('demo')).toMatchObject({ title: '域内新版', version: 9 }) // 域未被降级
    expect(report).toMatchObject({ superseded: 1, supersededNames: ['demo'], migrated: 0 })
    expect(snapshots.get(snapshotKey('demo', 1))).toMatchObject({
      title: '内存期修缮', version: 1, reason: 'migration',
    })
    expect(registry.get('demo')).toMatchObject({ title: '域内新版', version: 9 })
  })

  it('⑱ 正常迁入：内存记录与账本一并落域，迁入后继续追加', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: 'A', flow: simpleFlow() })
    await registry.save({ name: 'demo', title: 'B', flow: simpleFlow() })
    const { tables, workflows, snapshots } = domainTables()

    const report = await registry.attachDomain(tables)

    expect(report).toMatchObject({ migrated: 1, superseded: 0, snapshots: 2 })
    expect(workflows.get('demo')?.version).toBe(2)
    expect([...snapshots.keys()].sort()).toEqual(['demo:v1', 'demo:v2'])
    expect(registry.domainAttached).toBe(true)

    await registry.save({ name: 'demo', title: 'C', flow: simpleFlow() })
    expect(snapshots.get('demo:v3')).toMatchObject({ reason: 'save' })
    expect(registry.history('demo').map(s => s.version)).toEqual([3, 2, 1])
  })

  it('⑲ delete 先归档（reason=delete）再移除生效记录', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: 'A', flow: simpleFlow() })
    const { tables, workflows, snapshots } = domainTables()
    await registry.attachDomain(tables)

    await expect(registry.delete('demo')).resolves.toBe(true)
    expect(workflows.has('demo')).toBe(false)
    expect(snapshots.get('demo:v1')).toMatchObject({ reason: 'delete' })
  })

  it('⑳ 回滚 = 写一条新版本（内容取目标快照），历史不原地改', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: 'A', flow: simpleFlow() })
    await registry.save({ name: 'demo', title: 'B', flow: rolledFlow })

    const back = await registry.rollback('demo', 1)

    expect(back).toMatchObject({ title: 'A', version: 3 })
    expect(back.flow).toEqual(simpleFlow())
    expect(registry.get('demo')?.flow).toEqual(simpleFlow())
    expect(registry.history('demo').map(s => s.version)).toEqual([3, 2, 1])
    await expect(registry.rollback('demo', 99)).rejects.toThrow(/没有 v99/)
  })

  it('㉑ 强审计：账本写入失败 ⇒ 保存整体失败，生效记录不落', async () => {
    const registry = new WorkflowRegistry()
    const { tables, workflows } = domainTables()
    await registry.attachDomain(tables)
    await registry.save({ name: 'demo', title: 'A', flow: simpleFlow() })
    tables.snapshots.put = async () => { throw new Error('账本写失败') }

    await expect(registry.save({ name: 'demo', title: 'B', flow: simpleFlow() }))
      .rejects.toThrow(/账本写失败/)
    expect(workflows.get('demo')).toMatchObject({ title: 'A', version: 1 })
  })

  it('㉒ 快照上限：每流程只保留最近 MAX_SNAPSHOTS_PER_FLOW 个版本', async () => {
    const registry = new WorkflowRegistry()
    const { tables, snapshots } = domainTables()
    await registry.attachDomain(tables)
    const total = MAX_SNAPSHOTS_PER_FLOW + 3
    for (let i = 0; i < total; i++) {
      await registry.save({ name: 'demo', title: `v${i}`, flow: simpleFlow() })
    }

    expect(snapshots.size).toBe(MAX_SNAPSHOTS_PER_FLOW)
    expect(registry.history('demo')).toHaveLength(MAX_SNAPSHOTS_PER_FLOW)
    expect(snapshots.has('demo:v1')).toBe(false) // 最旧被剪
    expect(snapshots.has(`demo:v${total}`)).toBe(true)
  })

  it('㉓ 迁入失败：不挂域、不清内存（内存仍是唯一真相）', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '内存期', flow: simpleFlow() })
    const { tables } = domainTables()
    tables.workflows.put = async () => { throw new Error('域写失败') }

    await expect(registry.attachDomain(tables)).rejects.toThrow(/域写失败/)
    expect(registry.domainAttached).toBe(false)
    expect(registry.get('demo')).toMatchObject({ title: '内存期' })
  })
})
