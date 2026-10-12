/**
 * registry — 流程注册表用例：保存门（schema/结构/凭据红线/locked 拒改）
 * + 预制覆盖还原 + storage 域挂载迁移 + 内存降级 + T26.6 契约模式保存门。
 *
 * 词汇（T26.6 终态）：closeOn 三形态 + outcomes 槽表 + captureFrom/captures +
 * 两级路由 onOutcome（kind 直达 / when 细化）。读时归一已退役（DEC-25）：
 * 存储即新词汇，get 面 as-written 返回，无兼容层。
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_SNAPSHOTS_PER_FLOW, WorkflowRegistry, snapshotKey, type WorkflowDomainTables,
} from '../src/core/index.ts'
import {
  checkFlow, waitSchema, type Flow, type FlowSlotsInfo, type HostTable, type WorkflowRecord,
  type WorkflowSnapshot,
} from '../src/contract/index.ts'

/** 最小合法流程（单步，criteria 等一行后成功出口）。 */
function simpleFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    entry: 'a',
    steps: [
      {
        id: 'a',
        wait: {
          closeOn: 'criteria',
          outcomes: { 成功: { kind: 'ok', patterns: ['成功'] } },
          timeoutMs: 1000,
        },
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

/** 命令总表槽名查询（T26.6 端口形：FlowSlotsInfo——形态比对/告警④ flags 点名用）。 */
const slotsOf = (cmd: string): FlowSlotsInfo | null => {
  if (cmd === 'dz') {
    return {
      closeOn: 'criteria',
      slots: [
        { name: '内息不足', kind: 'fail' },
        { name: '修炼完毕', kind: 'ok' },
      ],
    }
  }
  if (cmd === 'walk') {
    return { closeOn: 'criteria', slots: [{ name: '到达', kind: 'ok' }], flags: 'm' }
  }
  return null
}

describe('WorkflowRegistry 保存门', () => {
  it('合法流程可保存：version 从 1 起，list/get 可见', async () => {
    const registry = new WorkflowRegistry()
    const saved = await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })
    expect(saved.record.version).toBe(1)
    expect(registry.get('demo')?.title).toBe('演示')
    expect(registry.list().map(r => r.name)).toContain('demo')
  })

  it('覆盖保存 version 自增', async () => {
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow() })
    const again = await registry.save({ name: 'demo', title: '演示 v2', flow: simpleFlow() })
    expect(again.record.version).toBe(2)
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
    expect(saved.record.version).toBe(4)
    expect(registry.get('supply')?.title).toBe('补给')
    await registry.delete('supply')
    expect(registry.get('supply')?.version).toBe(3) // 还原预制
  })

  it('when 键 kind 不一致拒存（不跨键位查找，DEC-19）', async () => {
    const registry = new WorkflowRegistry()
    const bad = simpleFlow({
      steps: [{
        id: 'a',
        wait: {
          closeOn: 'criteria',
          outcomes: { 失败: { kind: 'fail', patterns: ['失败'] } },
          timeoutMs: 1000,
        },
        // ok 键下引用 fail 槽 = 跨键位
        onOutcome: { ok: { when: { 失败: { exit: { stage: 'x', ok: false } } } } },
        next: { exit: { stage: 'success', ok: true } },
      }],
    })
    await expect(registry.save({ name: 'demo', title: '演示', flow: bad }))
      .rejects.toThrow(/不跨键位/)
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

describe('捕获槽保存门（captureFrom 具名槽，DEC-19）', () => {
  /** 捕获步缩样（outcomes/captures 可覆写）。 */
  function captureFlow(overrides: {
    patterns?: string[]
    captures?: string[]
    slotName?: string
  }): Flow {
    const { patterns = ['^(\\S+) 线索'], captures = ['who'], slotName = '线索' } = overrides
    return {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: {
          closeOn: 'criteria',
          outcomes: { [slotName]: { kind: 'ok', patterns } },
          captureFrom: slotName,
          captures,
          timeoutMs: 1000,
        },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
  }

  it('合法声明通过：captureFrom 槽 patterns[0] 组数 ≥ captures 数', () => {
    expect(() => checkFlow(captureFlow({
      patterns: ['^(\\S+)给(\\S+)的东西'], captures: ['from', 'what'],
    }))).not.toThrow()
  })

  it('④a 保留名拒存（captcha/name/pass）', () => {
    for (const name of ['captcha', 'name', 'pass']) {
      expect(() => checkFlow(captureFlow({ captures: [name] }))).toThrow(/保留名/)
    }
  })

  it('④b 组数不足拒存（patterns[0] 捕获组少于 captures 声明）', () => {
    const bad = captureFlow({ patterns: ['^(\\S+) 线索'], captures: ['a', 'b'] })
    expect(() => checkFlow(bad)).toThrow(/捕获组 1 个，少于 captures 声明的 2 个/)
  })

  it('④c 非 captureFrom 槽 patterns[0] 引入捕获组拒存（组号计数与提取会错位）', () => {
    const bad = captureFlow({ patterns: ['^(\\S+) 线索', '^(\\S+) 出现'], captures: ['who'] })
    expect(() => checkFlow(bad)).toThrow(/只允许出现在 captureFrom/)
  })

  it('④d 槽名非法拒存（只允许字母/数字/下划线）', () => {
    expect(() => checkFlow(captureFlow({ captures: ['attacker-name'] }))).toThrow(/槽名非法/)
  })

  it('④e captures 无 captureFrom 拒存', () => {
    const bad: Flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { closeOn: 'ga', captures: ['who'], timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    expect(() => checkFlow(bad)).toThrow(/没有 captureFrom/)
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
    // as-written（T26.6）：get 面原样返回新词汇——存储即新词汇，读时归一已退役。
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

// ── T26.6：契约模式保存门（三形态封闭 + kind 契约 + 端口校验 + 告警档） ──

describe('T26.6 契约模式保存门', () => {
  /** 单步新格式流程骨架（wait/step 覆写由用例给出）。 */
  const flowWith = (step: Partial<Flow['steps'][number]>): Flow => ({
    entry: 'a',
    steps: [{
      id: 'a',
      wait: { closeOn: 'criteria', outcomes: { 完成: { kind: 'ok', patterns: ['成了'] } }, timeoutMs: 1000 },
      next: { exit: { stage: 'success', ok: true } },
      ...step,
    }],
  })

  it('三形态组合封闭（schema 层 superRefine）：判据声明缺 closeOn / quiet 带 outcomes / count 越界 / criteria 空槽', () => {
    // 判据声明必须搭配 closeOn（DEC-3 三配方各自封闭）。
    expect(() => waitSchema.parse({
      outcomes: { 完成: { kind: 'ok', patterns: ['x'] } }, timeoutMs: 1000,
    })).toThrow(/必须搭配 closeOn/)
    // quiet 无 outcomes 槽（要分类说明写得出判据，那是 criteria 的事）。
    expect(() => waitSchema.parse({
      closeOn: 'quiet', outcomes: { 完成: { kind: 'ok', patterns: ['x'] } }, timeoutMs: 1000,
    })).toThrow(/quiet 形态无 outcomes/)
    // count 仅 ga 形态可用。
    expect(() => waitSchema.parse({
      closeOn: 'criteria', outcomes: { 完成: { kind: 'ok', patterns: ['x'] } }, count: 2, timeoutMs: 1000,
    })).toThrow(/count 仅 ga/)
    expect(() => waitSchema.parse({
      closeOn: 'quiet', timeoutMs: 1000, count: 1,
    })).toThrow(/count 仅 ga/)
    // criteria 必须声明 outcomes（否则只剩超时收场）。
    expect(() => waitSchema.parse({
      closeOn: 'criteria', timeoutMs: 1000,
    })).toThrow(/必须声明 outcomes/)
    // ga + count 放行（缺省 1 也可显式）。
    expect(() => waitSchema.parse({
      closeOn: 'ga', count: 2, timeoutMs: 1000,
    })).not.toThrow()
  })

  it('patterns 空数组拒存（推定槽已退役：patterns ≥ 1，DEC-7 注释纪律）', () => {
    expect(() => waitSchema.parse({
      closeOn: 'criteria', outcomes: { 完成: { kind: 'ok', patterns: [] } }, timeoutMs: 1000,
    })).toThrow()
  })

  it('保留字槽名 ok/fail 拒存（kind 寻址键防撞名，DP 裁定 7）', () => {
    for (const name of ['ok', 'fail']) {
      expect(() => checkFlow(flowWith({
        wait: {
          closeOn: 'criteria',
          outcomes: { [name]: { kind: 'ok', patterns: ['x'] } },
          timeoutMs: 1000,
        },
      }))).toThrow(/保留字/)
    }
  })

  it('when 键 kind 不一致拒存（不跨键位查找，DEC-19）', () => {
    const bad = flowWith({
      wait: {
        closeOn: 'criteria',
        outcomes: { 完成: { kind: 'ok', patterns: ['x'] } },
        timeoutMs: 1000,
      },
      onOutcome: { fail: { when: { 完成: { exit: { stage: 'x', ok: false } } } } },
    })
    expect(() => checkFlow(bad)).toThrow(/不跨键位/)
  })

  it('端口校验：字面量喂令已登记 → when/captureFrom 引用须 ⊆ 合并槽集（缺席 = 死引用拒存）', () => {
    const dead: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'dz' }, next: { goto: 'b' } },
        { id: 'b', wait: { closeOn: 'criteria', outcomes: { 修炼完毕: { kind: 'ok', patterns: ['x'] } }, timeoutMs: 1000 }, onOutcome: { ok: { when: { 不存在的槽: { goto: 'c' } } } }, next: { goto: 'c' } },
        { id: 'c', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    expect(() => checkFlow(dead, slotsOf)).toThrow(/超喂令 dz/)
  })

  it('动态命令：保存期只校验静态可判的 kind 一致性，查表整体后移运行期（放行）', () => {
    const dynamic: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'look {x}' }, next: { goto: 'b' } },
        { id: 'b', wait: { closeOn: 'criteria', outcomes: { 任意: { kind: 'ok', patterns: ['y'] } }, timeoutMs: 1000 }, onOutcome: { ok: { when: { 任意: { goto: 'c' } } } }, next: { goto: 'c' } },
        { id: 'c', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    expect(() => checkFlow(dynamic, slotsOf)).not.toThrow()
  })

  it('告警①：喂令未登记且步未声明收窗 → 不收窗只等超时（DEC-4）', () => {
    const unregistered: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'foobar' }, next: { goto: 'b' } },
        { id: 'b', wait: { timeoutMs: 1000 }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const warnings = checkFlow(unregistered, slotsOf)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('未登记命令总表')
  })

  it('告警②：when 未覆盖同 kind 槽（点名补全；未覆盖落缺省）', () => {
    const partial: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'dz' }, next: { goto: 'b' } },
        {
          id: 'b',
          wait: {
            closeOn: 'criteria',
            outcomes: { 修炼完毕: { kind: 'ok', patterns: ['x'] } },
            timeoutMs: 1000,
          },
          onOutcome: { ok: { when: { 修炼完毕: { goto: 'c' } } } },
          next: { goto: 'c' },
        },
        { id: 'c', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const warnings = checkFlow(partial, slotsOf)
    // 合并槽集 ok 槽 = {修炼完毕}（本步声明，表槽 dz 的 ok 槽同名合并）；覆盖完整 → 无 ②。
    expect(warnings).toEqual([])
    // 少覆盖一个 ok 槽 → 点名。
    const partial2: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'dz' }, next: { goto: 'b' } },
        {
          id: 'b',
          wait: {
            closeOn: 'criteria',
            outcomes: { 修炼完毕: { kind: 'ok', patterns: ['x'] }, 额外: { kind: 'ok', patterns: ['y'] } },
            timeoutMs: 1000,
          },
          onOutcome: { ok: { when: { 修炼完毕: { goto: 'c' } } } },
          next: { goto: 'c' },
        },
        { id: 'c', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const w2 = checkFlow(partial2, slotsOf)
    expect(w2.some(w => w.includes('onOutcome.ok.when 未覆盖 ok 槽') && w.includes('额外'))).toBe(true)
  })

  it('告警④：同形态合并带 flags 表条目而步未声明 flags（锚定判据失活风险）', () => {
    const merged: Flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { send: 'walk' }, next: { goto: 'b' } },
        {
          id: 'b',
          wait: { closeOn: 'criteria', outcomes: { 到达: { kind: 'ok', patterns: ['^你到了'] } }, timeoutMs: 1000 },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const warnings = checkFlow(merged, slotsOf)
    expect(warnings.some(w => w.includes('同形态合并表条目 walk') && w.includes('flags'))).toBe(true)
  })

  it('registry：save 透出保存门告警；get as-written（读时归一已退役）', async () => {
    const registry = new WorkflowRegistry()
    registry.setSlotsOf(slotsOf)
    const { record, warnings } = await registry.save({
      name: 'demo',
      title: '告警放行',
      flow: {
        entry: 'a',
        steps: [
          { id: 'a', action: { send: 'foobar' }, next: { goto: 'b' } },
          { id: 'b', wait: { timeoutMs: 1000 }, next: { exit: { stage: 'success', ok: true } } },
        ],
      },
    })
    expect(record.version).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('未登记命令总表')
    // as-written：get 面原样返回新词汇（存储即新词汇）。
    const got = registry.get('demo')!
    expect(got.flow.steps[1]!.wait).toEqual({ timeoutMs: 1000 })
  })
})