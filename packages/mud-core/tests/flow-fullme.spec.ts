/**
 * dsh-mud-core — fullme 流程表与流程机 (`doc/ARCHITECTURE.md` §11 + §19.1)。
 *
 * 这里只测**声明面与判定规则**（不投递、不过桥）：
 *   - 五步图的形状（`request → [stale | prompt] → answer → success`）与每步的判据分工；
 *   - 注册期校验：新字段（`capture` / `retry` / `tool` 判据 / 占位符）非法即报错；
 *   - 入口随 world 翻转（`login: !logged_in` ↔ `fullme: logged_in`）—— `refreshEntries()`；
 *   - 系统流程命令集由流程表派生（权限判据；§10）。
 *
 * 端到端（真工具链路 / 桥 / 人工环节 / 重试 / 预算）在 `tests/runtime-captcha.spec.ts`。
 */

import { describe, expect, it } from 'vitest'
import rules from '../src/perceive/rules.ts'
import {
  defaultFlows, flowCommands, FULLME_FLOW, LOGIN_FLOW, validateFlows, type FlowSpec,
} from '../src/flow/flows/index.ts'
import { FlowRuntime } from '../src/flow/engine.ts'
import type { WorldModel } from '../src/world/state.ts'
import type { MudLine } from '../src/network/ansi.ts'

const NAME_PROMPT = '您的英文名字：'
const FULLME_REMINDER = '5M后长时间不使用fullme，会被系统判定为机器人。'

function ml(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: 0, isPrompt: false }
}

function fakeWorld(loggedIn: boolean): WorldModel {
  return { flags: loggedIn ? { logged_in: true } : {} } as unknown as WorldModel
}

/** 只跑流程机的运行时（不投递、不过桥）：入口 arm + 判定用。 */
function flowHarness(loggedIn: boolean): { flow: FlowRuntime; logs: string[] } {
  const logs: string[] = []
  const flow = new FlowRuntime({
    flows: defaultFlows,
    world: () => fakeWorld(loggedIn),
    log: text => { logs.push(text) },
    patch: () => {},
    direct: () => {},
    notifyFail: () => {},
  })
  return { flow, logs }
}

describe('fullme 流程表 (声明面)', () => {
  it('注册期校验通过；五步图与判据分工符合作者定案', () => {
    expect(validateFlows(defaultFlows)).toEqual([])
    expect(FULLME_FLOW.steps.map(step => step.id)).toEqual(['request', 'stale', 'prompt', 'answer', 'success'])
    const byId = (id: string) => FULLME_FLOW.steps.find(step => step.id === id)!

    // request: **无 ok**（本步结果 = 下一步的新文本）；fail = "刚刚用过"（时长动态）；两条条件分支。
    const request = byId('request')
    expect(request.ok).toBeUndefined()
    expect(request.next).toEqual(['stale', 'prompt'])
    expect(request.fail).toHaveLength(1)
    expect(request.fail?.[0]?.kind).toBe('regex')
    // 时长通配：`还有 3 分 20 秒` 与 `还有 45 秒` 都要命中。
    const cooldown = request.fail?.[0]
    expect(cooldown?.kind === 'regex' && cooldown.patterns[0] instanceof RegExp
      && (cooldown.patterns[0] as RegExp).test('你刚刚用过这个命令不久，还要 3 分 20 秒才能再用。')).toBe(true)
    expect(cooldown?.kind === 'regex' && cooldown.patterns[0] instanceof RegExp
      && (cooldown.patterns[0] as RegExp).test('你刚刚用过这个命令不久，还要 45 秒才能再用。')).toBe(true)

    // stale: 三连发 fullme 1 才能真放弃；以 GA 判定、声明了 why（失败收束文案）。
    const stale = byId('stale')
    expect(stale.action?.args).toEqual({ cmds: ['fullme 1', 'fullme 1', 'fullme 1'] })
    expect(stale.fail).toEqual([{ kind: 'ga', why: '放弃上一轮（三连 fullme 1）→ 本轮作废' }])
    expect(stale.next).toBeUndefined()

    // prompt: 地址判据 + capture 槽 + mud_captcha（工具结果判据，无 GA）。
    const prompt = byId('prompt')
    expect(prompt.action?.tool).toBe('mud_captcha')
    expect(prompt.action?.args).toEqual({ url: '{captchaUrl}', note: '{lastFail}' })
    expect(prompt.capture).toHaveProperty('captchaUrl')
    expect(prompt.ok).toEqual([{ kind: 'tool', outcome: 'ok' }])
    expect(prompt.fail).toEqual([{ kind: 'tool', outcome: 'error' }])
    expect(prompt.next).toEqual(['answer'])

    // answer: 挂起等人工 + **一步总计 3 分钟**预算 + 三步答错重来（步内自环，重试动作 = 重新取图）。
    const answer = byId('answer')
    expect(answer.awaitExternal).toEqual(['captcha'])
    expect(answer.timeoutMs).toBe(180_000)
    expect(answer.retry).toEqual({
      attempts: 3,
      on: ['fail'],
      action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
    })
    expect(answer.action?.args).toEqual({ cmds: ['halt', 'fullme {captcha}'] })
    expect(answer.next).toEqual(['success'])

    // success: 发 hpbrief 补状态，GA 判定，next 空 = 终态。
    const success = byId('success')
    expect(success.action?.args).toEqual({ cmd: 'hpbrief' })
    expect(success.ok).toEqual([{ kind: 'ga' }])
    expect(success.next).toBeUndefined()

    // 失败只留痕（人工/系统问题，T2 补不了）。
    expect(FULLME_FLOW.priority).toBe(100)
    expect(FULLME_FLOW.failPolicy).toEqual({ notify: 'none' })
  })

  it('规则表里不再有 fullme:* 规则（三条已流程化）', () => {
    expect(rules.map(rule => rule.id).filter(id => id.startsWith('fullme:'))).toEqual([])
  })

  it('系统流程命令集由流程表派生（含 fullme/halt/答案/hpbrief；权限判据用）', () => {
    const commands = flowCommands(defaultFlows)
    expect(commands).toContain('fullme')
    expect(commands).toContain('halt')
    expect(commands).toContain('fullme {captcha}')
    expect(commands).toContain('fullme 1')
    expect(commands).toContain('hpbrief')
    // 登录流程照旧。
    expect(commands).toContain('{name}')
    expect(commands).toContain('')
  })
})

describe('注册期校验 (新字段)', () => {
  const broken = (steps: FlowSpec['steps']): string[] => validateFlows([{
    id: 'x',
    priority: 100,
    entry: 'a',
    steps,
  }])

  it('tool 判据必须落在有动作的步骤上', () => {
    const errors = broken([{ id: 'a', ok: [{ kind: 'tool', outcome: 'ok' }] }])
    expect(errors.some(e => e.includes('tool 判据需要本步有 action'))).toBe(true)
  })

  it('未知占位符在注册期就报错（不等到发送时才炸）', () => {
    const errors = broken([{
      id: 'a',
      action: { tool: 'mud_send', args: { cmd: '{nope}' } },
      ok: [{ kind: 'ga' }],
    }])
    expect(errors.some(e => e.includes('未知占位符 {nope}'))).toBe(true)
  })

  it('capture 槽可以当占位符；槽名重复报错', () => {
    expect(broken([
      {
        id: 'a',
        driver: { kind: 'text', includes: ['go'] },
        capture: { slot: /(\d+)/ },
        action: { tool: 'mud_send', args: { cmd: 'x {slot}' } },
        ok: [{ kind: 'ga' }],
        next: ['b'],
      },
      { id: 'b', action: { tool: 'mud_send', args: { cmd: 'y' } }, ok: [{ kind: 'ga' }] },
    ])).toEqual([])
    const dup = broken([
      {
        id: 'a',
        capture: { slot: /(\d+)/ },
        action: { tool: 'mud_send', args: { cmd: 'x {slot}' } },
        ok: [{ kind: 'ga' }],
        next: ['b'],
      },
      {
        id: 'b',
        capture: { slot: /(\d+)/ },
        action: { tool: 'mud_send', args: { cmd: 'y' } },
        ok: [{ kind: 'ga' }],
      },
    ])
    expect(dup.some(e => e.includes('capture 槽名重复'))).toBe(true)
  })

  it('retry 声明非法即报错 (attempts / on / driver)', () => {
    const errors = broken([{
      id: 'a',
      action: { tool: 'mud_send', args: { cmd: 'x' } },
      ok: [{ kind: 'ga' }],
      // @ts-expect-error 故意给非法值（注册期校验的职责）
      retry: { attempts: 0, on: ['nope'] },
    }])
    expect(errors.some(e => e.includes('retry.attempts'))).toBe(true)
    expect(errors.some(e => e.includes("retry.on 只能是 'driver'/'fail'"))).toBe(true)

    // 声明了 driver 重试却没有 driver 判据（打不出"重输"这条路）。
    const driverErrors = broken([{
      id: 'a',
      action: { tool: 'mud_send', args: { cmd: 'x' } },
      ok: [{ kind: 'ga' }],
      retry: { attempts: 2, on: ['driver'] },
    }])
    expect(driverErrors.some(e => e.includes("retry.on 含 'driver'"))).toBe(true)
  })
})

describe('入口随 world 翻转 (refreshEntries)', () => {
  it('已登录: 提醒行激活 fullme；登录提示行不再激活 login', () => {
    const { flow } = flowHarness(true)
    flow.refreshEntries()
    const fullme = flow.offer([ml(FULLME_REMINDER, 0)], false)
    expect(fullme.map(hit => hit.ruleId)).toEqual(['flow:fullme/request'])
    expect(fullme[0]!.tool.args).toEqual({ cmd: 'fullme' })
    // 清理: 复位后再试另一个入口。
    flow.dispose()

    const other = flowHarness(true)
    other.flow.refreshEntries()
    expect(other.flow.offer([ml(NAME_PROMPT, 0)], false)).toEqual([])
    other.flow.dispose()
  })

  it('未登录: 名字提示激活 login；提醒行不激活 fullme', () => {
    const { flow } = flowHarness(false)
    flow.refreshEntries()
    expect(flow.offer([ml(FULLME_REMINDER, 0)], false)).toEqual([])
    flow.dispose()

    const login = flowHarness(false)
    login.flow.refreshEntries()
    const hits = login.flow.offer([ml(NAME_PROMPT, 0)], false)
    expect(hits.map(hit => hit.ruleId)).toEqual(['flow:login/name'])
    login.flow.dispose()
  })

  it('槽名集合含内建 lastFail 与声明的 capture 槽（投递前插值用）', () => {
    const { flow } = flowHarness(true)
    expect([...flow.slotNames()].sort()).toEqual(['captchaUrl', 'lastFail'])
    flow.dispose()
  })

  it('LOGIN_FLOW 与 FULLME_FLOW 都在默认流程表里, 且没有 humanTimeoutMs 字段', () => {
    expect(defaultFlows.map(f => f.id)).toEqual(['login', 'fullme'])
    for (const step of [...LOGIN_FLOW.steps, ...FULLME_FLOW.steps]) {
      expect('humanTimeoutMs' in step).toBe(false)
    }
  })
})
