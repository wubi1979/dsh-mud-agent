/**
 * tools 测试 — 三工具 + 静态禁发表 + 登录闸门（impl §3.5）。
 *
 * 覆盖：首词禁发表（大小写/分号切分；子会话拒、根不受限、先于隐式登录）、
 * 隐式登录（首次触发、已登录防重入）、listen 编译（缺省 gaCount:1、非法
 * 正则拒、字符串→RegExp）、mud_flow 三出口转写与越权 id 拒、mud_state 快照、
 * 注册面（三个工具名 + disposer）。
 *
 * execute 用 stub mud（send/read 记录调用）；login 流程注入假流程（不触真
 * 读竞速机，读竞速机本体已由 link/flows 测试覆盖）。
 */

import { describe, expect, it } from 'vitest'
import type { MudLine } from '../../src/link/ansi.ts'
import type { Mud, ReadResult, WaitOpts } from '../../src/link/mud.ts'
import { World } from '../../src/awareness/world.ts'
import type { Flow } from '../../src/tools/flows/types.ts'
import {
  commandHead,
  compileListen,
  denyMatch,
  registerMudTools,
  type MudToolDefinition,
  type MudToolDeps,
} from '../../src/tools/tools.ts'

let seq = 0
function mkLine(text: string): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt: false }
}

type TestMud = Mud & { sent: string[]; reads: WaitOpts[] }

/** stub mud：send/read 全记录，read 行为由注入函数决定。 */
function stubMud(readImpl: (opts: WaitOpts) => Promise<ReadResult>): TestMud {
  const sent: string[] = []
  const reads: WaitOpts[] = []
  return {
    sent,
    reads,
    connected: true,
    send(cmd: string) { sent.push(cmd); return true },
    connect() {},
    read(opts: WaitOpts) { reads.push(opts); return readImpl(opts) },
  } as unknown as TestMud
}

function makeDeps(overrides?: Partial<MudToolDeps> & { mud?: TestMud }): MudToolDeps & { mud: TestMud } {
  const mud = overrides?.mud ?? stubMud(async () => ({ lines: [mkLine('应答原文')], reason: 'done' }))
  return {
    mud,
    world: new World(),
    creds: { name: 'u', pass: 'p' },
    connect: { host: '127.0.0.1', port: 8081 },
    holder: 'root',
    defaultTimeoutMs: 30_000,
    ...overrides,
  } as MudToolDeps & { mud: TestMud }
}

/** 假 login 流程（记录执行次数）。 */
function fakeLogin(runs: number[]): Flow {
  return {
    id: 'login',
    description: 'fake',
    async run() { runs.push(1); return { done: true } },
  }
}

interface Registered {
  defs: Map<string, MudToolDefinition>
  disposers: Array<() => void>
  gate: ReturnType<typeof registerMudTools>['gate']
}

function register(deps: MudToolDeps): Registered {
  const defs = new Map<string, MudToolDefinition>()
  const { disposers, gate } = registerMudTools(
    { register: (def) => { defs.set(def.name, def); return () => defs.delete(def.name) } },
    deps,
  )
  return { defs, disposers, gate }
}

describe('静态禁发表（首词一行判断）', () => {
  it('suicide/passwd/quit/drop 类命中；大小写与分号切分不影响', () => {
    expect(denyMatch('suicide')).toBe('suicide')
    expect(denyMatch('QUIT')).toBe('quit')
    expect(denyMatch('drop all')).toBe('drop')
    expect(denyMatch('  drop  sword')).toBe('drop')
    expect(denyMatch('look;quit')).toBeNull() // 首词 look，不命中
    expect(denyMatch('junk sword')).toBe('junk')
  })

  it('白名单命令与空命令不命中', () => {
    expect(denyMatch('look')).toBeNull()
    expect(denyMatch('')).toBeNull()
    expect(denyMatch('kill bandit')).toBeNull() // kill 是 ask 档，第一期不进禁发表
  })

  it('commandHead: 按空白/分号切分取首段小写', () => {
    expect(commandHead('Halting All')).toBe('halting')
    expect(commandHead('a;b')).toBe('a')
    expect(commandHead('')).toBe('')
  })
})

describe('mud_send', () => {
  it('注册面：三个工具名齐、disposer 可注销', () => {
    const { defs, disposers } = register(makeDeps())
    expect([...defs.keys()].sort()).toEqual(['mud_flow', 'mud_send', 'mud_state'])
    expect(disposers).toHaveLength(3)
    disposers[0]?.()
    expect(defs.has('mud_send')).toBe(false)
  })

  it('首次调用隐式登录（gate.ensure），已登录后不再重入', async () => {
    const runs: number[] = []
    const deps = makeDeps({ flows: [fakeLogin(runs)] })
    const { defs } = register(deps)
    const send = defs.get('mud_send')!

    await send.execute({ cmd: 'look' }, { signal: new AbortController().signal })
    await send.execute({ cmd: 'look' }, { signal: new AbortController().signal })
    expect(runs).toHaveLength(1)
    expect(deps.mud.sent).toEqual(['look', 'look'])
    expect(deps.mud.reads).toHaveLength(2)
  })

  it('登录态写世界记忆: 登录成功 → session.loggedIn=true, gate.reset() → false', async () => {
    const runs: number[] = []
    const deps = makeDeps({ flows: [fakeLogin(runs)] })
    const { defs, gate } = register(deps)

    expect(deps.world.get('session', 'loggedIn')).toBeNull() // 初始无值（摘要跳过）
    await defs.get('mud_send')!.execute({}, { signal: new AbortController().signal })
    expect(deps.world.get('session', 'loggedIn')?.value).toBe(true) // measured 直测事实

    gate.reset() // 装配层接线 mud.onDisconnect
    expect(deps.world.get('session', 'loggedIn')?.value).toBe(false)
  })

  it('有 cmd = send + read（listen 缺省 gaCount:1）；无 cmd = 裸读不发送', async () => {
    const runs: number[] = [1]
    const deps = makeDeps({ flows: [fakeLogin(runs)] })
    const { defs } = register(deps)
    const send = defs.get('mud_send')!
    const signal = new AbortController().signal

    await send.execute({ cmd: 'look' }, { signal })
    expect(deps.mud.reads[0]?.gaCount).toBe(1)
    expect(deps.mud.reads[0]?.timeoutMs).toBe(30_000) // 缺省超时由工具注入

    await send.execute({ timeoutMs: 1234 }, { signal }) // 裸读
    expect(deps.mud.sent).toEqual(['look']) // 未再发送
    expect(deps.mud.reads[1]?.timeoutMs).toBe(1234)
    expect(deps.mud.reads[1]?.gaCount).toBe(1)
  })

  it('子会话命中禁发表 → 直接拒，且先于隐式登录、不发送', async () => {
    const runs: number[] = []
    const deps = makeDeps({ holder: 'child:a', flows: [fakeLogin(runs)] })
    const { defs } = register(deps)
    const send = defs.get('mud_send')!

    const r = await send.execute({ cmd: 'quit' }, { signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: '已拒绝：子会话静态禁发表命中（quit）' })
    expect(deps.mud.sent).toEqual([]) // 未发送
    expect(runs).toEqual([]) // 未触发登录
  })

  it('根会话不受禁发表限（quit 放行）', async () => {
    const runs: number[] = [1]
    const deps = makeDeps({ holder: 'root', flows: [fakeLogin(runs)] })
    const { defs } = register(deps)
    const send = defs.get('mud_send')!

    const r = await send.execute({ cmd: 'quit' }, { signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: true })
    expect(deps.mud.sent).toEqual(['quit'])
  })

  it('listen 字符串正则编译为 RegExp；非法正则抛错', async () => {
    const runs: number[] = [1]
    const deps = makeDeps({ flows: [fakeLogin(runs)] })
    const { defs } = register(deps)
    const send = defs.get('mud_send')!
    const signal = new AbortController().signal

    await send.execute({ cmd: 'look', listen: { until: ['去茶室'], gaCount: 2 } }, { signal })
    expect(deps.mud.reads[0]?.until?.[0]).toBeInstanceOf(RegExp)
    expect(deps.mud.reads[0]?.until?.[0]?.test('你去茶室吧。')).toBe(true)
    expect(deps.mud.reads[0]?.gaCount).toBe(2)

    await expect(
      send.execute({ cmd: 'look', listen: { until: ['[非法'] } }, { signal }),
    ).rejects.toThrow('正则非法')
  })
})

describe('mud_flow', () => {
  it('查无此 id 直接拒（越权/不存在同拒）', async () => {
    const deps = makeDeps()
    const { defs } = register(deps)
    const flow = defs.get('mud_flow')!

    const r = await flow.execute({ id: '不存在的流程' }, { signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: '未知流程 id: 不存在的流程' })
  })

  it('三出口转写: done / question（带行原文）/ danger', async () => {
    const flows: Flow[] = [
      { id: 'f-done', description: '', async run() { return { done: true } } },
      {
        id: 'f-q', description: '',
        async run() { return { done: false, question: '验证码：<图>', lines: [mkLine('fullme 图行')] } },
      },
      { id: 'f-danger', description: '', async run() { return { reason: 'danger' } } },
    ]
    const deps = makeDeps({ flows })
    const { defs } = register(deps)
    const flow = defs.get('mud_flow')!
    const signal = new AbortController().signal

    expect(await flow.execute({ id: 'f-done' }, { signal })).toEqual({ ok: true, done: true })
    expect(await flow.execute({ id: 'f-q' }, { signal })).toEqual({
      ok: true, done: false, question: '验证码：<图>', lines: ['fullme 图行'],
    })
    expect(await flow.execute({ id: 'f-danger' }, { signal })).toEqual({ ok: true, reason: 'danger' })
  })

  it('answer 透传给流程（根侧带答案重入）', async () => {
    let seen: unknown
    const flows: Flow[] = [{
      id: 'f', description: '',
      async run(ctx) { seen = ctx.answer; return { done: true } },
    }]
    const { defs } = register(makeDeps({ flows }))
    await defs.get('mud_flow')!.execute({ id: 'f', answer: 'k3x9' }, { signal: new AbortController().signal })
    expect(seen).toBe('k3x9')
  })
})

describe('mud_state', () => {
  it('返回 world 快照（measured 字段可读）', async () => {
    const world = new World()
    world.reduce(mkLine('【气血】1560/3000'))
    const deps = makeDeps({ world })
    const { defs } = register(deps)

    const r = await defs.get('mud_state')!.execute({}, { signal: new AbortController().signal }) as { ok: boolean; state: unknown }
    expect(r.ok).toBe(true)
    expect((r.state as { vitals: Record<string, unknown> }).vitals['hp']).toBe(1560)
  })
})

describe('render（模型面合同：人读文本，不让模型读 JSON）', () => {
  it('mud_send: 成功 = 行原文；失败 = 可读错误文本', () => {
    const { defs } = register(makeDeps())
    const send = defs.get('mud_send')!
    expect(send.output.render({}, { ok: true, reason: 'done', lines: ['你看到茶室。', '师父在这里。'] }))
      .toEqual([{ type: 'text', text: '你看到茶室。\n师父在这里。' }])
    expect(send.output.render({}, { ok: false, error: '已拒绝：子会话静态禁发表命中（quit）' }))
      .toEqual([{ type: 'text', text: '已拒绝：子会话静态禁发表命中（quit）' }])
  })

  it('mud_flow: done / question / danger 三出口 + 错误均人读文本', () => {
    const { defs } = register(makeDeps())
    const flow = defs.get('mud_flow')!
    expect(flow.output.render({}, { ok: true, done: true }))
      .toEqual([{ type: 'text', text: '流程完成。' }])
    expect(flow.output.render({}, { ok: true, done: false, question: '验证码：<图>', lines: ['fullme 图行'] }))
      .toEqual([{ type: 'text', text: '验证码：<图>\nfullme 图行' }])
    expect(flow.output.render({}, { ok: true, reason: 'danger' })[0]?.text)
      .toContain('危险中断')
    expect(flow.output.render({}, { ok: false, error: '未知流程 id: x' }))
      .toEqual([{ type: 'text', text: '未知流程 id: x' }])
  })

  it('mud_state: 渲染为 world 快照的缩进 JSON 文本', () => {
    const world = new World()
    world.reduce(mkLine('【气血】1560/3000'))
    const { defs } = register(makeDeps({ world }))
    const state = defs.get('mud_state')!
    const r = state.output.render({}, { ok: true, state: world.snapshot() })[0]
    expect(r?.type).toBe('text')
    expect(JSON.parse(r?.text ?? '')).toMatchObject({ vitals: { hp: 1560 } })
  })
})

describe('compileListen', () => {
  it('缺省与全空 spec 都回落 gaCount:1', () => {
    expect(compileListen(undefined)).toEqual({ gaCount: 1 })
    expect(compileListen({})).toEqual({ gaCount: 1 })
  })

  it('字段原样透传；空数组不占位', () => {
    const out = compileListen({ until: ['a'], quietMs: 500 })
    expect(out.until).toHaveLength(1)
    expect(out.quietMs).toBe(500)
    expect(out.gaCount).toBeUndefined()
    expect(compileListen({ until: [] }).until).toBeUndefined()
  })
})
