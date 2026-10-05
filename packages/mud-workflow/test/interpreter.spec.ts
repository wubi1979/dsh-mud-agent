/**
 * interpreter — 声明式解释器用例（脚本化 fake IO，先红后绿纪律覆盖语义分支）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { runFlow } from '../src/core/index.ts'
import type { WorkflowRecord } from '../src/contract/index.ts'
import type {
  CaptchaResume, IoLine, IoReadOpts, IoReadReason, IoReadResult, ReadHit, WorkflowIO,
} from '../src/contract/index.ts'

/** 读窗剧本项：一次 read 的应答（窗行 + 收束原因）。 */
interface Scene {
  lines: string[]
  reason: IoReadReason
}

/**
 * mini-reader（T15）：按场景收束原因选判据数组，**声明序 `exec` 单次**取"命中 +
 * 捕获组"、调用前重置 `lastIndex` —— 与 core3 读窗机同规则（本替身只负责模拟缝；
 * 真实读窗机由 core3 `test/read.spec.ts` 与 `login`/`fullme` E2E 覆盖）。
 */
function sceneHit(scene: Scene, opts: IoReadOpts): ReadHit | undefined {
  if (scene.reason !== 'done' && scene.reason !== 'failOn') return undefined
  const by = scene.reason === 'failOn' ? 'failOn' : 'until'
  const res = by === 'failOn' ? opts.failOn : opts.until
  if (res === undefined) return undefined
  const text = scene.lines.join('\n')
  for (let i = 0; i < res.length; i++) {
    const re = res[i]!
    re.lastIndex = 0
    const m = re.exec(text)
    if (m !== null) return { by, index: i, groups: m.slice(1) }
  }
  return undefined
}

/** 脚本化 fake IO：read 按剧本出窗，awaitCaptcha 按剧本出恢复帧，send/creds 记录调用。 */
function fakeIO(scenes: Scene[], captchaResumes: CaptchaResume[] = []): {
  io: WorkflowIO
  sent: string[]
  creds: string[]
} {
  const sent: string[] = []
  const creds: string[] = []
  let cursor = 0
  let captchaCursor = 0
  const io: WorkflowIO = {
    send: (cmd) => { sent.push(cmd); return true },
    sendCredential: (cmd) => { creds.push(cmd); return true },
    awaitCaptcha: async () => {
      const r = captchaResumes[captchaCursor]
      captchaCursor += 1
      if (r === undefined) throw new Error(`captcha 剧本耗尽（第 ${captchaCursor} 次挂起）`)
      return r
    },
    read: async (opts) => {
      const scene = scenes[cursor]
      cursor += 1
      if (scene === undefined) throw new Error(`剧本耗尽（第 ${cursor} 次读窗）`)
      return {
        lines: scene.lines.map(text => ({ text }) satisfies IoLine),
        reason: scene.reason,
        hit: sceneHit(scene, opts),
      } satisfies IoReadResult
    },
    recentLines: () => [],
    state: () => ({ state: 'connected' }),
  }
  return { io, sent, creds }
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
    const { io, sent, creds } = fakeIO([
      { lines: ['您的英文名字：'], reason: 'done' },
      { lines: ['请输入密码：'], reason: 'done' },
    ])
    const r = await runFlow(record(flow, { locked: true }), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['需要创建新人物'], reason: 'failOn' }])
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['失败了'], reason: 'failOn' }])
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io, sent } = fakeIO([
      { lines: ['您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)'], reason: 'done' },
      { lines: ['重新连线完毕'], reason: 'done' },
    ])
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['别的输出'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['一些现场'], reason: 'timeout' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines).toContain('一些现场')
  })

  it('send 失败 = 连接断开 → timeout 出口带断开注记', async () => {
    const flow = {
      entry: 'a',
      steps: [{ id: 'a', action: { send: 'look' }, next: { exit: { stage: 'success', ok: true } } }],
    }
    const { io } = fakeIO([])
    io.send = () => false
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['回显 s3cret 泄漏测试'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r.lines.join('\n')).not.toContain('s3cret')
    expect(r.lines.join('\n')).toContain('******')
  })

  it('红线执行侧拦截：非 locked 流程执行 sendCredential throw', async () => {
    const flow = {
      entry: 'a',
      steps: [{ id: 'a', action: { sendCredential: '{pass}' } }],
    }
    const { io } = fakeIO([])
    await expect(runFlow(record(flow), io, CREDS)).rejects.toThrow(/凭据红线/)
  })

  it('goto 环在步转移上限处收束（烧预算不烧死进程）', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', next: { goto: 'b' } },
        { id: 'b', next: { goto: 'a' } },
      ],
    }
    const { io } = fakeIO([])
    const r = await runFlow(record(flow), io, CREDS)
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
    const { io } = fakeIO([{ lines: ['> '], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })
})

describe('captcha 动作（T13.1：推图等码 → 值入固定单槽；T14.1 url 参数化）', () => {
  /** 主链缩样：answer（captcha 纯动作步，无 wait）→ send（槽替换发送）→ success。 */
  const captchaFlow = {
    entry: 'answer',
    steps: [
      { id: 'answer', action: { captcha: { url: '{captchaUrl}' } }, next: { goto: 'send' } },
      { id: 'send', action: { send: 'fullme {captcha}' }, next: { exit: { stage: 'success', ok: true } } },
    ],
  }

  it('① 等值 resolve → 槽填充 → fullme {captcha} 正确发出（url 参数原样传入 io）', async () => {
    const urls: string[] = []
    const { io, sent } = fakeIO([], [{ kind: 'answer', value: '8342' }])
    io.awaitCaptcha = async (url) => {
      urls.push(url)
      return { kind: 'answer', value: '8342' }
    }
    const r = await runFlow(record(captchaFlow, { locked: true }), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(urls).toEqual(['{captchaUrl}']) // 未知槽原样保留直传（D9：写死/槽面均允许）
    expect(sent).toEqual(['fullme 8342'])
  })

  it('② closed（挂起预算到点/断线/销毁）→ 结构化 timeout 出口', async () => {
    const { io } = fakeIO([], [{ kind: 'closed' }])
    const r = await runFlow(record(captchaFlow, { locked: true }), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
  })

  it('③ 人工中止 → aborted 出口（stage 可辨，区别于 timeout）', async () => {
    const { io } = fakeIO([], [{ kind: 'aborted' }])
    const r = await runFlow(record(captchaFlow, { locked: true }), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'aborted' })
  })

  it('④ 红线执行侧拦截：非 locked 流程执行 captcha throw', async () => {
    const { io } = fakeIO([])
    await expect(runFlow(record(captchaFlow), io, CREDS)).rejects.toThrow(/captcha/)
  })

  it('⑤ {captcha} 槽替换：send 与 sendCredential 均替换，未知 {xxx} 原样保留', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', action: { captcha: { url: '{captchaUrl}' } }, next: { goto: 'b' } },
        { id: 'b', action: { send: 'say {captcha} 与 {whatever}' }, next: { goto: 'c' } },
        { id: 'c', action: { sendCredential: '{name} {captcha}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent, creds } = fakeIO([], [{ kind: 'answer', value: '8342' }])
    const r = await runFlow(record(flow, { locked: true }), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['say 8342 与 {whatever}'])
    expect(creds).toEqual(['hero 8342'])
  })

  it('⑤b {captcha} 值不进 pass 掩码（验证码非敏感，D5）', async () => {
    const flow = {
      entry: 'a',
      steps: [
        {
          id: 'a',
          wait: { until: ['答'], timeoutMs: 1000 },
          action: { captcha: { url: '{captchaUrl}' } },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const { io } = fakeIO(
      [{ lines: ['答完了 s3cret 8342'], reason: 'done' }],
      [{ kind: 'answer', value: '8342' }],
    )
    const r = await runFlow(record(flow, { locked: true }), io, CREDS)
    const text = r.lines.join('\n')
    expect(text).not.toContain('s3cret')
    expect(text).toContain('8342')
  })
})

describe('捕获槽（T14.1：until[0] 命中行提取捕获组入 run 级命名槽）', () => {
  it('① wait 命中 until[0] 捕获组入槽，本步 send 正确替换', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: { until: ['^(\\S+) 看起来想要杀死你'], captures: ['attacker'], timeoutMs: 1000 },
        action: { send: 'kill {attacker}' },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io, sent } = fakeIO([{ lines: ['妖精 看起来想要杀死你'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill 妖精'])
  })

  it('② goto 回跳重经捕获步覆盖旧值（战斗动态词，D4 覆盖情形）', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: { until: ['^(\\S+) 出手攻击'], failOn: ['^战斗结束'], captures: ['attacker'], timeoutMs: 1000 },
        action: { send: 'kill {attacker}' },
        onFailOn: { '0': { exit: { stage: 'success', ok: true } } },
        branch: [{ goto: 'fight' }],
      }],
    }
    const { io, sent } = fakeIO([
      { lines: ['张三 出手攻击'], reason: 'done' },
      { lines: ['李四 出手攻击'], reason: 'done' },
      { lines: ['战斗结束'], reason: 'failOn' },
    ])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill 张三', 'kill 李四'])
  })

  it('③ failOn 收束不写槽：后继步的槽引用原样保留', async () => {
    const flow = {
      entry: 'fight',
      steps: [
        {
          id: 'fight',
          wait: { until: ['^x'], failOn: ['^你死了'], captures: ['attacker'], timeoutMs: 1000 },
          onFailOn: { '0': { goto: 'after' } },
          next: { exit: { stage: 'success', ok: true } },
        },
        { id: 'after', action: { send: 'kill {attacker}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['你死了'], reason: 'failOn' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill {attacker}'])
  })

  it('⑤ 未知槽原样保留不报错（命名槽只替换声明过的名字）', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: { until: ['^(\\S+) 看起来想要杀死你'], captures: ['attacker'], timeoutMs: 1000 },
        action: { send: 'kill {attacker} 与 {unknown}' },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io, sent } = fakeIO([{ lines: ['妖精 看起来想要杀死你'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill 妖精 与 {unknown}'])
  })

  it('⑥ 空值护栏（D11）：组提取为空 → 结构化 timeout 收束，不落槽不进 send', async () => {
    const flow = {
      entry: 'fight',
      steps: [
        {
          id: 'fight',
          wait: { until: ['^你被(.*?)吸引了'], captures: ['lure'], timeoutMs: 1000 },
          next: { goto: 'strike' },
        },
        { id: 'strike', action: { send: 'kill {lure}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['你被吸引了'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines.join('\n')).toContain('捕获失败')
    expect(r.lines.join('\n')).toContain('lure')
    expect(sent).toEqual([])
  })

  it('⑥b 空值护栏（D11）：done 收束但一条 until 都没命中 → 同型 timeout 收束', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: { gaCount: 1, until: ['^(\\S+) 看起来想要杀死你'], captures: ['attacker'], timeoutMs: 1000 },
        action: { send: 'kill {attacker}' },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io, sent } = fakeIO([{ lines: ['一些无关输出'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines.join('\n')).toContain('本窗无 until 命中判据')
    expect(sent).toEqual([])
  })

  it('⑦ 位置组与命名组等价：多组按序入槽 + 整窗 exec（行首锚配 `m`，与路由同源）+ 跨步消费', async () => {
    const flow = {
      entry: 'listen',
      steps: [
        {
          id: 'listen',
          // 行首锚 + 多行窗：按 §8.13 勘误③ 必须配 flags 'm'（整窗匹配模型；
          // 旧「逐行提取」实现会掩盖这个分歧——见 ⑨–⑪ 语义澄清用例）。
          wait: { until: ['^(\\S+)对(\\S+)说'], flags: 'm', captures: ['who', 'whom'], timeoutMs: 1000 },
          next: { goto: 'reply' },
        },
        { id: 'reply', action: { send: 'tell {whom} 收到 {who}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['风声呼啸', '张三对李四说'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['tell 李四 收到 张三'])
  })

  it('⑧ send 侧不替换 {name}/{pass}（回归确认）；sendCredential 侧命名槽与凭据共存', async () => {
    const flow = {
      entry: 'fight',
      steps: [
        {
          id: 'fight',
          wait: { until: ['^(\\S+) 看起来想要杀死你'], captures: ['attacker'], timeoutMs: 1000 },
          action: { send: 'hi {name} {pass} {attacker}' },
          next: { goto: 'cred' },
        },
        { id: 'cred', action: { sendCredential: '{name}/{pass}/{attacker}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent, creds } = fakeIO([{ lines: ['妖精 看起来想要杀死你'], reason: 'done' }])
    const r = await runFlow(record(flow, { locked: true }), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['hi {name} {pass} 妖精'])
    expect(creds).toEqual(['hero/s3cret/妖精'])
  })

  it('D4 沿用情形：goto 跳过捕获步不清槽，后续步沿用上值', async () => {
    const flow = {
      entry: 'cap',
      steps: [
        {
          id: 'cap',
          wait: { until: ['^(\\S+) 线索'], captures: ['who'], timeoutMs: 1000 },
          action: { send: 'ask {who}' },
          next: { goto: 'other' },
        },
        { id: 'other', wait: { until: ['^再看'], timeoutMs: 1000 }, next: { goto: 'use' } },
        { id: 'use', action: { send: 'kill {who}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([
      { lines: ['妖精 线索'], reason: 'done' },
      { lines: ['再看'], reason: 'done' },
    ])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['ask 妖精', 'kill 妖精'])
  })

  // ── 语义澄清（2026-10-05）：捕获与路由同源 ──────────────────────────
  // 规则：捕获判定 = 路由判定（同一份 firstHit 结果）。命中 index = 0（捕获判据
  // 路径）⇒ 整窗 exec 提取，组空 ⇒ D11 结构化 timeout；命中 index > 0（其它已
  // 声明判据）⇒ 该路径不捕获、不失败，按该判据路由；一条都没命中 ⇒ D11 timeout。

  it('⑨ 其它已声明判据命中时不被捕获失败吞掉：分类出口可达（语义澄清）', async () => {
    const flow = {
      entry: 'judge',
      steps: [
        {
          id: 'judge',
          wait: { until: ['^(\\S+) 想要杀死你', '^你已经死了'], captures: ['attacker'], timeoutMs: 1000 },
          branch: [{ goto: 'kill' }, { exit: { stage: 'dead', ok: false } }],
          next: { goto: 'kill' },
        },
        { id: 'kill', action: { send: 'kill {attacker}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['你已经死了'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'dead' })
    expect(sent).toEqual([])
  })

  it('⑩ 跨行捕获判据整窗 exec：显式 \\n 的 until[0] 可捕获（不再逐行失配）', async () => {
    const flow = {
      entry: 'look',
      steps: [
        {
          id: 'look',
          wait: { until: ['^名字：(\\S+)\\n级别'], captures: ['who'], timeoutMs: 1000 },
          next: { goto: 'use' },
        },
        { id: 'use', action: { send: 'ask {who}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['名字：hero', '级别：3'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['ask hero'])
  })

  it('⑪ 命中非捕获判据且无 branch：走 next 不捕获，未填充槽原样保留（语义澄清）', async () => {
    const flow = {
      entry: 'wait',
      steps: [
        {
          id: 'wait',
          wait: { until: ['^A(\\d+)', '^B'], captures: ['n'], timeoutMs: 1000 },
          next: { goto: 'use' },
        },
        { id: 'use', action: { send: 'v={n}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['B'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['v={n}'])
  })
})

describe('解释器去重测（T15.2：匹配单点在 core3 读窗机）', () => {
  it('⑪ 解释器源码内不再出现判据匹配（只编译判据，不 test/exec）', () => {
    const src = readFileSync(new URL('../src/core/interpreter.ts', import.meta.url), 'utf8')
    // 断言"代码"而非注释：剥掉块注释与行注释后再查。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.exec\(/)
    expect(code).not.toMatch(/\.test\(/)
    expect(code).not.toContain('captureSlots')
    expect(code).not.toContain('firstHit')
  })
})
