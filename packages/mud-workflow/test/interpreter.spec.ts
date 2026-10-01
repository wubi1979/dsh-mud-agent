/**
 * interpreter — 声明式解释器用例（脚本化 fake env，先红后绿纪律覆盖语义分支）。
 */

import { describe, expect, it } from 'vitest'

import { runFlow } from '../src/interpreter.ts'
import type { WorkflowRecord } from '../src/schema.ts'
import type { EnvLine, EnvReadResult, WorkflowEnv } from '../src/env.ts'

/** 读窗剧本项：一次 read 的应答（窗行 + 收束原因）。 */
interface Scene {
  lines: string[]
  reason: string
}

/** 脚本化 fake env：read 按剧本出窗，send/creds 记录调用。 */
function fakeEnv(scenes: Scene[]): {
  env: WorkflowEnv
  sent: string[]
  creds: string[]
} {
  const sent: string[] = []
  const creds: string[] = []
  let cursor = 0
  const env: WorkflowEnv = {
    send: (cmd) => { sent.push(cmd); return true },
    sendCredential: (cmd) => { creds.push(cmd); return true },
    read: async () => {
      const scene = scenes[cursor]
      cursor += 1
      if (scene === undefined) throw new Error(`剧本耗尽（第 ${cursor} 次读窗）`)
      return {
        lines: scene.lines.map(text => ({ text }) satisfies EnvLine),
        reason: scene.reason,
      } satisfies EnvReadResult
    },
    recentLines: () => [],
    state: () => ({ state: 'connected' }),
  }
  return { env, sent, creds }
}

/** 记录（合法缺省；flow 由用例给）。 */
function record(flow: WorkflowRecord['flow'], overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    name: 'demo',
    title: '演示',
    locked: false,
    version: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    flow,
    ...overrides,
  }
}

const CREDS = { name: 'hero', pass: 's3cret' }

describe('runFlow 执行语义', () => {
  it('直线路径：等提示 → 凭据占位替换 → 等应答 → success 出口', async () => {
    const flow = {
      entry: 'ask-name',
      steps: [
        {
          id: 'ask-name',
          wait: { until: ['英文名字'], timeoutMs: 1000 },
          action: { sendCredential: '{name}' },
          next: { goto: 'ask-pass' },
        },
        {
          id: 'ask-pass',
          wait: { until: ['请输入密码'], timeoutMs: 1000 },
          action: { sendCredential: '{pass}' },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const { env, sent, creds } = fakeEnv([
      { lines: ['您的英文名字：'], reason: 'done' },
      { lines: ['请输入密码：'], reason: 'done' },
    ])
    const r = await runFlow(record(flow, { locked: true }), env, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(creds).toEqual(['hero', 's3cret'])
    expect(sent).toEqual([])
  })

  it('failOn 命中 → onFailOn 分类出口（ok:false）', async () => {
    const flow = {
      entry: 'ask-pass',
      steps: [{
        id: 'ask-pass',
        wait: { until: ['请输入密码'], failOn: ['需要创建新人物'], timeoutMs: 1000 },
        onFailOn: { '0': { exit: { stage: 'need-new', ok: false } } },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { env } = fakeEnv([{ lines: ['需要创建新人物'], reason: 'failOn' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'need-new' })
  })

  it('failOn 命中但 onFailOn 未登记 → 缺省 timeout 出口', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { failOn: ['失败'], timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { env } = fakeEnv([{ lines: ['失败了'], reason: 'failOn' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
  })

  it('分支：until 命中 index → branch goto（replace 分支同型）', async () => {
    const flow = {
      entry: 'confirm',
      steps: [
        {
          id: 'confirm',
          wait: { until: ['取而代之吗', '权限：\\(player\\)'], timeoutMs: 1000 },
          branch: [{ goto: 'replace' }, { exit: { stage: 'success', ok: true } }],
        },
        {
          id: 'replace',
          action: { send: 'y' },
          next: { goto: 'wait-ok' },
        },
        {
          id: 'wait-ok',
          wait: { until: ['重新连线完毕'], timeoutMs: 1000 },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const { env, sent } = fakeEnv([
      { lines: ['您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)'], reason: 'done' },
      { lines: ['重新连线完毕'], reason: 'done' },
    ])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['y'])
  })

  it('branch 未命中走 next；无 next → 结构缺出口的结构化 timeout', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { until: ['x'], timeoutMs: 1000 },
        branch: [{ exit: { stage: 'branch-exit', ok: false } }],
      }],
    }
    const { env } = fakeEnv([{ lines: ['别的输出'], reason: 'done' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    expect(r.lines.join('\n')).toContain('未声明后继')
  })

  it('timeout 收束 → timeout 出口，现场行随结果返回', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { until: ['永不出现'], timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { env } = fakeEnv([{ lines: ['一些现场'], reason: 'timeout' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines).toContain('一些现场')
  })

  it('send 失败 = 连接断开 → timeout 出口带断开注记', async () => {
    const flow = {
      entry: 'a',
      steps: [{ id: 'a', action: { send: 'look' }, next: { exit: { stage: 'success', ok: true } } }],
    }
    const { env } = fakeEnv([])
    env.send = () => false
    const r = await runFlow(record(flow), env, CREDS)
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toContain('连接已断开')
  })

  it('出口统一过 pass 掩码：现场行含密码明文也会被替换', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: { until: ['回显'], timeoutMs: 1000 },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { env } = fakeEnv([{ lines: ['回显 s3cret 泄漏测试'], reason: 'done' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r.lines.join('\n')).not.toContain('s3cret')
    expect(r.lines.join('\n')).toContain('******')
  })

  it('红线执行侧拦截：非 locked 流程执行 sendCredential throw', async () => {
    const flow = {
      entry: 'a',
      steps: [{ id: 'a', action: { sendCredential: '{pass}' } }],
    }
    const { env } = fakeEnv([])
    await expect(runFlow(record(flow), env, CREDS)).rejects.toThrow(/凭据红线/)
  })

  it('goto 环在步转移上限处收束（烧预算不烧死进程）', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', next: { goto: 'b' } },
        { id: 'b', next: { goto: 'a' } },
      ],
    }
    const { env } = fakeEnv([])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toContain('goto 环')
  })

  it('纯等待步（无 action）与空窗文本路由正常', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', wait: { gaCount: 1, timeoutMs: 1000 }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { env } = fakeEnv([{ lines: ['> '], reason: 'done' }])
    const r = await runFlow(record(flow), env, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })
})
