/**
 * tools — 工具面用例：注册完整性、引擎/core 缺席可读拒绝（I9）、
 * run 执行链（归属 → 取流程 → envFor → 解释器 → release）、保存门贯通。
 */

import { describe, expect, it } from 'vitest'

import {
  registerMudWorkflowTools,
  CORE_ABSENT_ERROR, ENGINE_ABSENT_ERROR,
  type MudToolDefinition, type MudWorkflowCore, type ToolRegistrar,
} from '../src/tools.ts'
import { WorkflowRegistry } from '../src/registry.ts'
import type { WorkflowIO } from '../src/io.ts'

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

/** 脚本化 fake IO（单窗 done）。 */
function fakeIO(): WorkflowIO {
  return {
    send: () => true,
    sendCredential: () => true,
    read: async () => ({ lines: [{ text: '完成' }], reason: 'done' }),
    recentLines: () => [],
    awaitCaptcha: async () => ({ kind: 'closed' }),
    state: () => ({ state: 'connected' }),
  }
}

describe('registerMudWorkflowTools', () => {
  it('注册完整性：五工具全部过 registrar', () => {
    const { registrar, defs } = fakeRegistrar()
    registerMudWorkflowTools(registrar, { engine: () => null, core: () => null })
    expect([...defs.keys()].sort()).toEqual([
      'mud_workflow_delete', 'mud_workflow_get', 'mud_workflow_list', 'mud_workflow_run', 'mud_workflow_save',
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
    const core: MudWorkflowCore = {
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
    const core: MudWorkflowCore = {
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
})
