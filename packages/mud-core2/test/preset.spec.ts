/**
 * preset 行插件测试 — 官方 preset 通道承载面（P2 修订 v2 D6/D8）。
 *
 * 覆盖：导出面（name/inject）、apply 注册三工具 + persona section（一次、
 * preset 作用域）、引擎缺席时注册照常但执行给可读拒绝（I9）、子级禁发表
 * 命中先于登录、root 放行。装配层归属判定（单根守卫/归属门）由 index.spec
 * 覆盖；工具行为细节由 tools.spec 覆盖——本文件只验 preset 行的接线。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MudLine } from '../src/link/ansi.ts'
import type { Mud, ReadResult } from '../src/link/mud.ts'
import { World } from '../src/awareness/world.ts'
import type { Flow } from '../src/tools/flows/types.ts'
import { LoginGate, type MudCoreHandle, type MudToolDefinition } from '../src/tools/tools.ts'
import { CORE_ABSENT_ERROR } from '../src/tools/tools.ts'
import { apply, inject, name } from '../src/preset.ts'
import { PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER } from '../src/persona.ts'

let seq = 0
function mkLine(text: string): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt: false }
}

/** 捕获注册副作用的假 scope；同一 ctx 兼具 tools/systemPrompt 服务与
 *  get('mudCore2') 解析（handle = null 即引擎缺席）。 */
function makeScope(handle: MudCoreHandle | null = null): {
  tools: MudToolDefinition[]
  sections: Array<{ name: string; order: number; text: string }>
  ctx: Context
} {
  const tools: MudToolDefinition[] = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const ctx = {
    tools: { register: (def: MudToolDefinition) => { tools.push(def); return () => void 0 } },
    systemPrompt: { section: (s: { name: string; order: number; text: string }) => { sections.push(s); return () => void 0 } },
    get: (key: string) => (key === 'mudCore2' ? handle : undefined),
  } as unknown as Context
  return { tools, sections, ctx }
}

/** 假引擎窄面：stub mud + 真 LoginGate + 可注入 holder。 */
function makeHandle(opts: { holder?: 'root' | `child:${string}`; flows?: Flow[] } = {}): MudCoreHandle {
  const sent: string[] = []
  const mud = {
    connected: true,
    sent,
    send(cmd: string) { sent.push(cmd); return true },
    connect() {},
    read(): Promise<ReadResult> {
      return Promise.resolve({ lines: [mkLine('应答原文')], reason: 'done' })
    },
  } as unknown as Mud & { sent: string[] }
  const world = new World()
  const flows: Flow[] = opts.flows ?? [{ id: 'login', description: 'fake', async run() { return { done: true } } }]
  const gate = new LoginGate(mud, world, flows, { name: 'u', pass: 'p' }, { host: '127.0.0.1', port: 8081 }, 30_000)
  return {
    mud, world,
    creds: { name: 'u', pass: 'p' },
    connect: { host: '127.0.0.1', port: 8081 },
    gate, defaultTimeoutMs: 30_000, flows,
    resolveHolder: () => ({ holder: opts.holder ?? 'root' }),
  }
}

describe('preset 行导出面', () => {
  it('name / inject 符合宿主 Loader 行约定', () => {
    expect(name).toBe('mud-core2-preset')
    expect(inject).toEqual(['tools', 'systemPrompt'])
  })
})

describe('apply：preset 作用域一次注册（D6/D8）', () => {
  it('三工具名齐 + persona section（段名/段序沿用 persona.ts）', () => {
    const scope = makeScope()
    apply(scope.ctx)
    expect(scope.tools.map(t => t.name).sort()).toEqual(['mud_flow', 'mud_send', 'mud_state'])
    expect(scope.sections).toHaveLength(1)
    expect(scope.sections[0]?.name).toBe(PERSONA_SECTION_NAME)
    expect(scope.sections[0]?.order).toBe(PERSONA_SECTION_ORDER)
  })

  it('引擎缺席：注册照常，执行给可读拒绝（I9，不是必然失败的桩）', async () => {
    const scope = makeScope(null) // 缺席
    apply(scope.ctx)
    expect(scope.tools).toHaveLength(3) // 注册期不依赖引擎

    const send = scope.tools.find(t => t.name === 'mud_send')!
    const r = await send.execute({ cmd: 'look' }, { signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: CORE_ABSENT_ERROR })
  })

  it('引擎在席：child holder 命中禁发表（quit）先于登录拒，不发送', async () => {
    const runs: number[] = []
    const handle = makeHandle({
      holder: 'child:a',
      flows: [{ id: 'login', description: 'fake', async run() { runs.push(1); return { done: true } } }],
    })
    const scope = makeScope(handle)
    apply(scope.ctx)
    const send = scope.tools.find(t => t.name === 'mud_send')!

    const r = await send.execute({ cmd: 'quit' }, { signal: new AbortController().signal })
    expect(r).toEqual({ ok: false, error: '已拒绝：子会话静态禁发表命中（quit）' })
    expect((handle.mud as unknown as { sent: string[] }).sent).toEqual([])
    expect(runs).toEqual([])
  })

  it('引擎在席：root holder 放行（look → send + read）', async () => {
    const handle = makeHandle({ holder: 'root' })
    const scope = makeScope(handle)
    apply(scope.ctx)
    const send = scope.tools.find(t => t.name === 'mud_send')!

    const r = await send.execute({ cmd: 'look' }, { signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: true })
    expect((handle.mud as unknown as { sent: string[] }).sent).toEqual(['look'])
  })
})
