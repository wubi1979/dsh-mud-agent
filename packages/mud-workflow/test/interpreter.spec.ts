/**
 * interpreter — 声明式解释器用例（脚本化 fake IO，先红后绿纪律覆盖语义分支）。
 *
 * T26.6 终态词汇（DEC-3/7/19/21/23/25）：closeOn 三形态（ga / criteria / quiet）
 * + outcomes 槽表 + captureFrom/captures + 两级路由 onOutcome（kind 直达常态 /
 * when 细化）+ 契约模式（kind=契约、槽名=数据、保留字 ok/fail）。旧词汇
 * until/failOn/branch/onFailOn/gaCount/quietMs/race 全部退役。
 *
 * mini-reader 与 core3 读窗机（`read.ts`）同规则：判据编译与判定在本替身内完成
 *（真实缝侧单点在 core3 `resolveAwaitPlan` + read 缝）；判定序 **fail 槽 > ok
 * 槽**（槽表内 pattern 序），ga 关窗分类断言（声明分类槽而未命中 ⇒ 合成 fail
 * 帧），quiet 合成帧按行数定 kind。真实读窗机形状由 core3 `read.spec` 与
 * login/fullme E2E 覆盖。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { runFlow } from '../src/core/index.ts'
import type { WorkflowRecord } from '../src/contract/index.ts'
import type {
  CaptchaResume, ClosureKind, IoLine, IoReadOpts, IoReadReason, IoReadResult, ReadHit, WorkflowIO,
} from '../src/contract/index.ts'

/** 读窗剧本项：一次 read 的应答（窗行 + 收束原因；hit 可直写——静默/边界
 * 收束场景由剧本直接给帧，缺省按 sceneHit 从 opts 推导）。 */
interface Scene {
  lines: string[]
  reason: IoReadReason
  hit?: ReadHit
  /** 归因 closeOn 直写（缺省 = opts.closeOn 透传；无缝侧注入时供剧本直接给）。 */
  closeOn?: ClosureKind
}

/**
 * mini-reader（T15 替身，与 core3 `read.ts` 同规则）：
 *  - quiet：固定采样窗合成帧（有行 ⇒ ok、零行 ⇒ fail——kind 由行数定，无槽名）；
 *  - criteria：判序 **fail 槽 > ok 槽**（槽内 pattern 序），声明序 `exec` 单次取
 *    「命中 + 捕获组 + 槽名 + kind」，调用前重置 `lastIndex`；
 *  - ga：关窗分类（声明的槽表）——命中即结局帧；声明分类槽而无一命中 ⇒ 断言
 *    失败合成 fail 帧（by:'ga' 无 outcome）；未声明分类槽 ⇒ 无帧。
 * 真实读窗机由 core3 `read.spec` 与 login/fullme E2E 覆盖——本替身只负责模拟缝。
 */
function hitFrame(scene: Scene, opts: IoReadOpts): ReadHit | undefined {
  // quiet 形态（合成帧：kind 由行数定，无槽名；reason 不参与路由）。
  if (opts.closeOn === 'quiet') {
    return { by: 'quiet', index: -1, groups: [], kind: scene.lines.length > 0 ? 'ok' : 'fail' }
  }
  if (opts.outcomes === undefined || scene.reason !== 'done') return undefined
  const text = scene.lines.join('\n')
  const execOne = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = 0
    return re.exec(text)
  }
  const entries = Object.entries(opts.outcomes)
  // 判序：fail 槽先于 ok 槽（与 core3 读档 deriveCriteria 同——fail 先测防误判）。
  const ordered = [
    ...entries.filter(([, slot]) => slot.kind === 'fail'),
    ...entries.filter(([, slot]) => slot.kind === 'ok'),
  ]
  for (const [name, slot] of ordered) {
    for (let i = 0; i < slot.patterns.length; i++) {
      const m = execOne(new RegExp(slot.patterns[i]!, opts.flags))
      if (m !== null) return { by: opts.closeOn ?? 'criteria', index: i, groups: m.slice(1), outcome: name, kind: slot.kind }
    }
  }
  // ga 关窗分类断言（DEC-3/DP 裁定 8）：声明分类槽而无一命中 ⇒ 合成 fail 帧。
  if (opts.closeOn === 'ga') return { by: 'ga', index: -1, groups: [], kind: 'fail' }
  return undefined
}

/** 脚本化 fake IO：read 按剧本出窗（recorder 记录收到的 raw 读档声明）、
 * awaitCaptcha 按剧本出恢复帧，send/creds 记录调用。 */
function fakeIO(scenes: Scene[], captchaResumes: CaptchaResume[] = []): {
  io: WorkflowIO
  sent: string[]
  creds: string[]
  reads: IoReadOpts[]
} {
  const sent: string[] = []
  const creds: string[] = []
  const reads: IoReadOpts[] = []
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
      reads.push(opts)
      const closeOn = scene.closeOn ?? opts.closeOn
      return {
        lines: scene.lines.map(text => ({ text }) satisfies IoLine),
        reason: scene.reason,
        hit: scene.hit ?? hitFrame(scene, opts),
        ...(closeOn !== undefined ? { closeOn } : {}),
      } satisfies IoReadResult
    },
    recentLines: () => [],
    state: () => ({ state: 'connected' }),
  }
  return { io, sent, creds, reads }
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
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 问名字: { kind: 'ok' as const, patterns: ['英文名字'] } },
            timeoutMs: 1000,
          },
          action: { sendCredential: '{name}' },
          next: { goto: 'ask-pass' },
        },
        {
          id: 'ask-pass',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 请输入密码: { kind: 'ok' as const, patterns: ['请输入密码'] } },
            timeoutMs: 1000,
          },
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

  it('fail 槽命中 → onOutcome.fail 直达出口（粗粒度常态，ok:false）', async () => {
    const flow = {
      entry: 'ask-pass',
      steps: [{
        id: 'ask-pass',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: {
            请输入密码: { kind: 'ok' as const, patterns: ['请输入密码'] },
            需要新角色: { kind: 'fail' as const, patterns: ['需要创建新人物'] },
          },
          timeoutMs: 1000,
        },
        onOutcome: { fail: { exit: { stage: 'need-new', ok: false } } },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io } = fakeIO([{ lines: ['需要创建新人物'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'need-new' })
  })

  it('fail 槽命中但未登记 onOutcome.fail → 缺省 timeout 出口并点名', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: { 失败: { kind: 'fail' as const, patterns: ['失败'] } },
          timeoutMs: 1000,
        },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io } = fakeIO([{ lines: ['失败了'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines.join('\n')).toContain('fail 结局未覆盖')
  })

  it('分支：ok 槽命中 index → onOutcome.ok.when 细化 goto（replace 分支同型）', async () => {
    const flow = {
      entry: 'confirm',
      steps: [
        {
          id: 'confirm',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: {
              需替换: { kind: 'ok' as const, patterns: ['取而代之吗'] },
              权限就绪: { kind: 'ok' as const, patterns: ['权限：\\(player\\)'] },
            },
            timeoutMs: 1000,
          },
          onOutcome: { ok: { when: { 需替换: { goto: 'replace' } } } },
          next: { exit: { stage: 'success', ok: true } },
        },
        {
          id: 'replace',
          action: { send: 'y' },
          next: { goto: 'wait-ok' },
        },
        {
          id: 'wait-ok',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 重连完成: { kind: 'ok' as const, patterns: ['重新连线完毕'] } },
            timeoutMs: 1000,
          },
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

  it('ok 槽命中但 when 未覆盖 → 走 next（kind 缺省，DEC-19）', async () => {
    const flow = {
      entry: 'confirm',
      steps: [
        {
          id: 'confirm',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: {
              需替换: { kind: 'ok' as const, patterns: ['取而代之吗'] },
              权限就绪: { kind: 'ok' as const, patterns: ['权限：\\(player\\)'] },
            },
            timeoutMs: 1000,
          },
          onOutcome: { ok: { when: { 需替换: { goto: 'replace' } } } },
          next: { goto: 'done' },
        },
        { id: 'replace', next: { exit: { stage: 'wrong', ok: false } } },
        { id: 'done', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io } = fakeIO([{ lines: ['目前权限：(player)'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })

  it('fail 槽 when 细化命中 → 按槽名路由；action 不发（失败不应答）', async () => {
    const flow = {
      entry: 'confirm',
      steps: [{
        id: 'confirm',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: {
            权限就绪: { kind: 'ok' as const, patterns: ['目前权限'] },
            密码错误: { kind: 'fail' as const, patterns: ['密码错误'] },
          },
          timeoutMs: 1000,
        },
        action: { send: '不应发送' },
        onOutcome: {
          fail: { when: { 密码错误: { exit: { stage: 'bad-pass', ok: false } } } },
        },
        next: { goto: 'done' },
      }, { id: 'done', next: { exit: { stage: 'success', ok: true } } }],
    }
    const { io, sent } = fakeIO([{ lines: ['密码错误！'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'bad-pass' })
    expect(sent).toEqual([])
  })

  it('fail 槽 when 未覆盖该槽 → timeout 出口并点名槽名（DEC-13 ③）', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: {
            失败甲: { kind: 'fail' as const, patterns: ['甲'] },
            失败乙: { kind: 'fail' as const, patterns: ['乙'] },
          },
          timeoutMs: 1000,
        },
        onOutcome: { fail: { when: { 失败甲: { exit: { stage: 'x', ok: false } } } } },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io } = fakeIO([{ lines: ['乙'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines.join('\n')).toContain('失败乙')
  })

  it('timeout 收束 → timeout 出口，现场行随结果返回', async () => {
    const flow = {
      entry: 'a',
      steps: [{
        id: 'a',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: { 永不出现: { kind: 'ok' as const, patterns: ['永不出现'] } },
          timeoutMs: 1000,
        },
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
        wait: {
          closeOn: 'criteria' as const,
          outcomes: { 回显: { kind: 'ok' as const, patterns: ['回显'] } },
          timeoutMs: 1000,
        },
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

  it('纯等待步（closeOn ga 无分类槽）与空窗文本路由正常', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', wait: { closeOn: 'ga' as const, timeoutMs: 1000 }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io } = fakeIO([{ lines: ['> '], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })

  it('缺出口：ga 关窗无分类且无 next → 结构化 timeout 点名步骤', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', wait: { closeOn: 'ga' as const, timeoutMs: 1000 } },
      ],
    }
    const { io } = fakeIO([{ lines: ['> '], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    expect(r.lines.join('\n')).toContain('未声明后继')
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
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 出题: { kind: 'ok' as const, patterns: ['答'] } },
            timeoutMs: 1000,
          },
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

describe('捕获槽（captureFrom 具名槽，DEC-19：组值由命中帧供给）', () => {
  it('① captureFrom 命中 → 组值入槽，本步 send 正确替换', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: { 敌现身: { kind: 'ok' as const, patterns: ['^(\\S+) 看起来想要杀死你'] } },
          captureFrom: '敌现身',
          captures: ['attacker'],
          timeoutMs: 1000,
        },
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
        wait: {
          closeOn: 'criteria' as const,
          outcomes: {
            敌攻击: { kind: 'ok' as const, patterns: ['^(\\S+) 出手攻击'] },
            战斗结束: { kind: 'fail' as const, patterns: ['^战斗结束'] },
          },
          captureFrom: '敌攻击',
          captures: ['attacker'],
          timeoutMs: 1000,
        },
        action: { send: 'kill {attacker}' },
        onOutcome: { fail: { when: { 战斗结束: { exit: { stage: 'success', ok: true } } } } },
        next: { goto: 'fight' },
      }],
    }
    const { io, sent } = fakeIO([
      { lines: ['张三 出手攻击'], reason: 'done' },
      { lines: ['李四 出手攻击'], reason: 'done' },
      { lines: ['战斗结束'], reason: 'done' },
    ])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill 张三', 'kill 李四'])
  })

  it('③ fail 结局命中不写槽：后继步的槽引用原样保留', async () => {
    const flow = {
      entry: 'fight',
      steps: [
        {
          id: 'fight',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: {
              敌现身: { kind: 'ok' as const, patterns: ['^x'] },
              你死了: { kind: 'fail' as const, patterns: ['^你死了'] },
            },
            captureFrom: '敌现身',
            captures: ['attacker'],
            timeoutMs: 1000,
          },
          onOutcome: { fail: { when: { 你死了: { goto: 'after' } } } },
          next: { exit: { stage: 'success', ok: true } },
        },
        { id: 'after', action: { send: 'kill {attacker}' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['你死了'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['kill {attacker}'])
  })

  it('⑤ 未知槽原样保留不报错（命名槽只替换声明过的名字）', async () => {
    const flow = {
      entry: 'fight',
      steps: [{
        id: 'fight',
        wait: {
          closeOn: 'criteria' as const,
          outcomes: { 敌现身: { kind: 'ok' as const, patterns: ['^(\\S+) 看起来想要杀死你'] } },
          captureFrom: '敌现身',
          captures: ['attacker'],
          timeoutMs: 1000,
        },
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
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 被吸引: { kind: 'ok' as const, patterns: ['^你被(.*?)吸引了'] } },
            captureFrom: '被吸引',
            captures: ['lure'],
            timeoutMs: 1000,
          },
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

  it('⑥b 捕获槽无结局命中（ga 关窗无分类）→ 同型护栏收束并点名', async () => {
    const flow = {
      entry: 'urlwait',
      steps: [{
        id: 'urlwait',
        wait: {
          closeOn: 'ga' as const,
          captureFrom: '验证码地址',
          captures: ['captchaUrl'],
          timeoutMs: 1000,
        },
        action: { send: 'open {captchaUrl}' },
        next: { exit: { stage: 'success', ok: true } },
      }],
    }
    const { io, sent } = fakeIO([{ lines: ['一些无关输出'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'timeout' })
    expect(r.lines.join('\n')).toContain('本窗无「验证码地址」结局命中')
    expect(sent).toEqual([])
  })

  it('⑦ 位置组与命名组等价：多组按序入槽 + 整窗 exec（行首锚配 `m`，与路由同源）+ 跨步消费', async () => {
    const flow = {
      entry: 'listen',
      steps: [
        {
          id: 'listen',
          // 行首锚 + 多行窗：必须显式配 flags 'm'（整窗匹配模型；DEC-13 告警④点名失活风险）。
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 有人说话: { kind: 'ok' as const, patterns: ['^(\\S+)对(\\S+)说'] } },
            captureFrom: '有人说话',
            captures: ['who', 'whom'],
            flags: 'm',
            timeoutMs: 1000,
          },
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
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 敌现身: { kind: 'ok' as const, patterns: ['^(\\S+) 看起来想要杀死你'] } },
            captureFrom: '敌现身',
            captures: ['attacker'],
            timeoutMs: 1000,
          },
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
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 线索: { kind: 'ok' as const, patterns: ['^(\\S+) 线索'] } },
            captureFrom: '线索',
            captures: ['who'],
            timeoutMs: 1000,
          },
          action: { send: 'ask {who}' },
          next: { goto: 'other' },
        },
        { id: 'other', wait: {
          closeOn: 'criteria' as const,
          outcomes: { 再看: { kind: 'ok' as const, patterns: ['^再看'] } },
          timeoutMs: 1000,
        }, next: { goto: 'use' } },
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

  it('⑩ 跨行捕获判据整窗 exec：显式 \\n 的 patterns[0] 可捕获（不再逐行失配）', async () => {
    const flow = {
      entry: 'look',
      steps: [
        {
          id: 'look',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: { 长相: { kind: 'ok' as const, patterns: ['^名字：(\\S+)\\n级别'] } },
            captureFrom: '长相',
            captures: ['who'],
            timeoutMs: 1000,
          },
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

  it('⑪ 命中非捕获槽 → 走路由不捕获，未填充槽原样保留（语义澄清）', async () => {
    const flow = {
      entry: 'wait',
      steps: [
        {
          id: 'wait',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: {
              编号: { kind: 'ok' as const, patterns: ['^A(\\d+)'] },
              标记: { kind: 'ok' as const, patterns: ['^B'] },
            },
            captureFrom: '编号',
            captures: ['n'],
            timeoutMs: 1000,
          },
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

describe('两级路由（DEC-19：kind 直达常态 / when 细化 / ga 断言）', () => {
  it('ga 分类命中 → onOutcome.ok.when 按槽名路由', async () => {
    const flow = {
      entry: 'ask',
      steps: [
        {
          id: 'ask',
          wait: {
            closeOn: 'ga' as const,
            count: 1,
            outcomes: { 拜师成功: { kind: 'ok' as const, patterns: ['你拜入了'] } },
            timeoutMs: 1000,
          },
          onOutcome: { ok: { when: { 拜师成功: { exit: { stage: 'success', ok: true } } } } },
        },
      ],
    }
    // GA 收窗分类帧由剧本直写（by 'ga'）——读窗机形状由 core3 read.spec 覆盖。
    const { io } = fakeIO([
      { lines: ['你拜入了华山派。'], reason: 'done', hit: { by: 'ga', index: 0, groups: [], outcome: '拜师成功', kind: 'ok' } },
    ])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })

  it('ga 声明分类槽但无一命中 → 断言失败（fail 路由 + 「收窗成功，分支未知」；action 不发）', async () => {
    const flow = {
      entry: 'ask',
      steps: [
        {
          id: 'ask',
          wait: {
            closeOn: 'ga' as const,
            count: 1,
            outcomes: { 拜师成功: { kind: 'ok' as const, patterns: ['你拜入了'] } },
            timeoutMs: 1000,
          },
          action: { send: '不应发送' },
          onOutcome: { fail: { exit: { stage: 'assert-miss', ok: false } } },
        },
      ],
    }
    // 剧本直写 GA 收窗且无分类命中（合成帧 by:'ga' kind:'fail'）——读窗机形状见 core3 read.spec。
    const { io, sent } = fakeIO([
      { lines: ['一些无关输出'], reason: 'done', hit: { by: 'ga', index: -1, groups: [], kind: 'fail' } },
    ])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'assert-miss' })
    expect(r.lines.join('\n')).toContain('收窗成功，分支未知')
    expect(sent).toEqual([])
  })

  it('ga 未声明分类槽 → 关窗即 next（无 hit，命中档由 read 机 omitted）', async () => {
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', wait: { closeOn: 'ga' as const, timeoutMs: 1000 }, next: { goto: 'b' } },
        { id: 'b', next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io } = fakeIO([{ lines: ['> '], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })

  it('quiet 有行 → 合成 ok 帧 → 走 next（静默照常路由，不是 timeout）', async () => {
    const flow = {
      entry: 'walk',
      steps: [
        {
          id: 'walk',
          wait: { closeOn: 'quiet' as const, timeoutMs: 1000 },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const { io } = fakeIO([{ lines: ['回显一'], reason: 'quiet' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
  })

  it('quiet 零行 → 合成 fail 帧（等同 timeout）→ fail 路由/缺省 timeout 出口', async () => {
    const flow = {
      entry: 'walk',
      steps: [
        {
          id: 'walk',
          wait: { closeOn: 'quiet' as const, timeoutMs: 1000 },
          onOutcome: { fail: { exit: { stage: 'silent-fail', ok: false } } },
        },
      ],
    }
    const { io } = fakeIO([{ lines: [], reason: 'timeout' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: false, stage: 'silent-fail' })
  })

  it('onOutcome 两级形态互斥：直达（goto/exit）与 when 并存由 schema 拒存——见 registry 保存门', async () => {
    // 本用例只确认解释器对直达形态的消费（goto）：fail 直达转步。
    const flow = {
      entry: 'a',
      steps: [
        { id: 'a', wait: { closeOn: 'criteria' as const, outcomes: { 拦: { kind: 'fail' as const, patterns: ['^拦截'] } }, timeoutMs: 1000 }, onOutcome: { fail: { goto: 'b' } } },
        { id: 'b', action: { send: '补救' }, next: { exit: { stage: 'success', ok: true } } },
      ],
    }
    const { io, sent } = fakeIO([{ lines: ['拦截了'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    expect(sent).toEqual(['补救'])
  })
})

describe('raw 透传（DEC-21 判据词汇单点：内核不编译、不归一）', () => {
  it('wait 声明原样透传 io.read（outcomes/count/maxLines/timeoutMs/flags）', async () => {
    const flow = {
      entry: 'a',
      steps: [
        {
          id: 'a',
          wait: {
            closeOn: 'criteria' as const,
            outcomes: {
              内息不足: { kind: 'fail' as const, patterns: ['内力不够'] },
              修炼完毕: { kind: 'ok' as const, patterns: ['你将内息修炼完毕'] },
            },
            maxLines: 20,
            flags: 'm',
            timeoutMs: 3000,
          },
          next: { exit: { stage: 'success', ok: true } },
        },
      ],
    }
    const { io, reads } = fakeIO([{ lines: ['你将内息修炼完毕'], reason: 'done' }])
    const r = await runFlow(record(flow), io, CREDS)
    expect(r).toMatchObject({ ok: true, stage: 'success' })
    const opts = reads[0]!
    expect(opts).toMatchObject({
      closeOn: 'criteria',
      outcomes: {
        内息不足: { kind: 'fail', patterns: ['内力不够'] },
        修炼完毕: { kind: 'ok', patterns: ['你将内息修炼完毕'] },
      },
      maxLines: 20,
      flags: 'm',
      timeoutMs: 3000,
    })
  })
})

describe('解释器去重测（T15.2：匹配单点在 core3 读窗机）', () => {
  it('⑪ 解释器源码内不再出现判据匹配（不 test/exec/编译）', () => {
    const src = readFileSync(new URL('../src/core/interpreter.ts', import.meta.url), 'utf8')
    // 断言"代码"而非注释：剥掉块注释与行注释后再查。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.exec\(/)
    expect(code).not.toMatch(/\.test\(/)
    expect(code).not.toContain('captureSlots')
    expect(code).not.toContain('firstHit')
    expect(code).not.toMatch(/new RegExp/)
  })
})