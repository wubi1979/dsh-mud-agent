/**
 * tools — 工具面用例：注册完整性、引擎/core 缺席可读拒绝（I9）、
 * run 执行链（归属 → 取流程 → envFor → 解释器 → release）、保存门贯通。
 */

import { describe, expect, it } from 'vitest'

import {
  registerMudWorkflowTools,
  CORE_ABSENT_ERROR, ENGINE_ABSENT_ERROR,
  type MudToolDefinition, type ToolRegistrar,
} from '../src/host/tools.ts'
import { WorkflowRegistry } from '../src/core/index.ts'
import type { WorkflowIO, WorkflowIoSeam } from '../src/contract/index.ts'

/** 收集注册的假 registrar。 */
function fakeRegistrar(): { registrar: ToolRegistrar; defs: Map<string, MudToolDefinition> } {
  const defs = new Map<string, MudToolDefinition>()
  return {
    defs,
    registrar: {
      register: def => {
        defs.set(def.name, def)
        return () => {}
      },
    },
  }
}

/** 最小合法流程（单步直出 success）。 */
const simpleFlow = {
  entry: 'a',
  steps: [{
    id: 'a',
    wait: { until: ['完成'], timeoutMs: 1000 },
    next: { exit: { stage: 'success', ok: true } },
  }],
}

const CREDS = { name: 'hero', pass: 'p' }

/** 脚本化 fake IO（单窗 done；命中帧与 simpleFlow 的 until[0] 一致）。 */
function fakeIO(): WorkflowIO {
  return {
    send: () => true,
    sendCredential: () => true,
    read: async () => ({
      lines: [{ text: '完成' }],
      reason: 'done',
      hit: { by: 'until', index: 0, groups: [] },
    }),
    recentLines: () => [],
    awaitCaptcha: async () => ({ kind: 'closed' }),
    state: () => ({ state: 'connected' }),
  }
}

describe('registerMudWorkflowTools', () => {
  it('注册完整性：七工具全部过 registrar', () => {
    const { registrar, defs } = fakeRegistrar()
    registerMudWorkflowTools(registrar, { engine: () => null, core: () => null })
    expect([...defs.keys()].sort()).toEqual([
      'mud_workflow_delete', 'mud_workflow_get', 'mud_workflow_history', 'mud_workflow_list',
      'mud_workflow_rollback', 'mud_workflow_run', 'mud_workflow_save',
    ])
  })

  it('引擎缺席：执行给可读拒绝（注册照常）', async () => {
    const { registrar, defs } = fakeRegistrar()
    registerMudWorkflowTools(registrar, { engine: () => null, core: () => null })
    const r = await defs.get('mud_workflow_list')!.execute({}, { signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: ENGINE_ABSENT_ERROR })
  })

  it('core 缺席：run 可读拒绝（管理工具不受影响）', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow })
    registerMudWorkflowTools(registrar, {
      engine: () => ({ registry }),
      core: () => null,
    })
    const signal = new AbortController().signal
    const run = await defs.get('mud_workflow_run')!.execute({ name: 'demo' }, { signal })
    expect(run).toEqual({ ok: false, error: CORE_ABSENT_ERROR })
    const list = await defs.get('mud_workflow_list')!.execute({}, { signal })
    expect(list).toMatchObject({ ok: true })
  })

  it('run 执行链：归属 → 取流程 → envFor → 解释器 → release', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow })
    let released = false
    const core: WorkflowIoSeam = {
      toolContextFor: agent => (agent?.id === 'agent-1' ? { sessionId: 'sess-1' } : null),
      workflowIoFor: async () => ({ io: fakeIO(), creds: CREDS, release: () => { released = true } }),
    }
    registerMudWorkflowTools(registrar, {
      engine: () => ({ registry }),
      core: () => core,
    })
    const signal = new AbortController().signal
    const agent = { id: 'agent-1' }
    const r = await defs.get('mud_workflow_run')!.execute({ name: 'demo' }, { signal, agent })
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(released).toBe(true)
  })

  it('run：未绑定会话可读拒绝', async () => {
    const { registrar, defs } = fakeRegistrar()
    const core: WorkflowIoSeam = {
      toolContextFor: () => null,
      workflowIoFor: async () => { throw new Error('不应到达') },
    }
    registerMudWorkflowTools(registrar, {
      engine: () => ({ registry: new WorkflowRegistry() }),
      core: () => core,
    })
    const r = await defs.get('mud_workflow_run')!
      .execute({ name: 'x' }, { signal: new AbortController().signal, agent: { id: 'other' } })
    expect(r).toMatchObject({ ok: false })
  })

  it('run：未知流程可读拒绝并列出可用', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: '演示', flow: simpleFlow })
    registerMudWorkflowTools(registrar, {
      engine: () => ({ registry }),
      core: () => ({
        toolContextFor: () => ({ sessionId: 'sess-1' }),
        workflowIoFor: async () => { throw new Error('不应到达（流程不存在）') },
      }),
    })
    const r = await defs.get('mud_workflow_run')!
      .execute({ name: 'nope' }, { signal: new AbortController().signal, agent: { id: 'a' } })
    expect((r as { error: string }).error).toContain('demo')
  })

  it('save 贯通保存门：locked 拒改、凭据红线拒，成功后 registry 可见', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry([{ name: 'login', title: '登录', locked: true, version: 1, updatedAt: '', flow: simpleFlow }])
    registerMudWorkflowTools(registrar, {
      engine: () => ({ registry }),
      core: () => null,
    })
    const signal = new AbortController().signal
    const locked = await defs.get('mud_workflow_save')!
      .execute({ name: 'login', title: '登录', flow: simpleFlow }, { signal })
    expect((locked as { error: string }).error).toContain('已锁定')

    const credFlow = {
      entry: 'a',
      steps: [{ id: 'a', action: { sendCredential: '{pass}' } }],
    }
    const cred = await defs.get('mud_workflow_save')!
      .execute({ name: 'evil', title: 'x', flow: credFlow }, { signal })
    expect((cred as { error: string }).error).toContain('sendCredential')

    const ok = await defs.get('mud_workflow_save')!
      .execute({ name: 'demo', title: '演示', flow: simpleFlow }, { signal })
    expect(ok).toMatchObject({ ok: true, version: 1 })
    expect(registry.get('demo')).toBeDefined()
  })

  it('list 报来源与遮蔽标记（策略 A）：内置/修订 + 被遮蔽提示', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'login', title: '冒充登录', flow: simpleFlow })
    await registry.save({ name: 'mine', title: '自建', flow: simpleFlow })
    registry.registerBuiltins([
      { name: 'login', title: '登录（内置）', locked: true, version: 1, updatedAt: '', flow: simpleFlow },
    ])
    registerMudWorkflowTools(registrar, { engine: () => ({ registry }), core: () => null })

    const def = defs.get('mud_workflow_list')!
    const r = await def.execute({}, { signal: new AbortController().signal })
    const rows = (r as { workflows: { name: string; origin: string; shadowed: boolean }[] }).workflows
    expect(rows.find(w => w.name === 'login')).toMatchObject({ origin: 'builtin', shadowed: true, locked: true })
    expect(rows.find(w => w.name === 'mine')).toMatchObject({ origin: 'refined', shadowed: false })

    const text = def.output.render({}, r).map(b => b.text).join('\n')
    expect(text).toContain('遮蔽')
  })

  it('delete 放行被遮蔽的修缮，并提示 locked 内置继续生效（策略 A）', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'login', title: '冒充登录', flow: simpleFlow })
    registry.registerBuiltins([
      { name: 'login', title: '登录（内置）', locked: true, version: 1, updatedAt: '', flow: simpleFlow },
    ])
    registerMudWorkflowTools(registrar, { engine: () => ({ registry }), core: () => null })

    const def = defs.get('mud_workflow_delete')!
    const r = await def.execute({ name: 'login' }, { signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: true, deleted: true, lockedBuiltin: true })
    const text = def.output.render({ name: 'login' }, r).map(b => b.text).join('\n')
    expect(text).toContain('locked 内置继续生效')
  })

  it('history / rollback 贯通账本：历史倒序、回滚写新版本、未知版本可读拒绝', async () => {
    const { registrar, defs } = fakeRegistrar()
    const registry = new WorkflowRegistry()
    await registry.save({ name: 'demo', title: 'v1', flow: simpleFlow })
    await registry.save({ name: 'demo', title: 'v2', flow: simpleFlow })
    registerMudWorkflowTools(registrar, { engine: () => ({ registry }), core: () => null })
    const signal = new AbortController().signal

    const hist = await defs.get('mud_workflow_history')!.execute({ name: 'demo' }, { signal })
    expect((hist as { versions: { version: number }[] }).versions.map(v => v.version)).toEqual([2, 1])

    const back = await defs.get('mud_workflow_rollback')!.execute({ name: 'demo', version: 1 }, { signal })
    expect(back).toMatchObject({ ok: true, fromVersion: 1, version: 3 })
    expect(registry.get('demo')?.title).toBe('v1')

    const miss = await defs.get('mud_workflow_rollback')!.execute({ name: 'demo', version: 99 }, { signal })
    expect((miss as { error: string }).error).toContain('没有 v99')
  })
})
