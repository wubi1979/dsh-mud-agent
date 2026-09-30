/**
 * tools 测试 — 工具面（doc/PLAN.md「二期详细设计」测试面 8 条，假 registrar + 假 core）：
 *   1. 注册完整性：二工具注册成功 + 参数面（isConcurrencySafe/timeoutMs）；registrar 抛错 fail-loud
 *   2. 引擎缺席 / 归属 null：可读拒绝
 *   3. deny 全段扫描：suicide 任何位置/大小写拒；quit/drop/passwd 放行（最小集）
 *   4. 未接入（admitted=false）：mud_send 可读拒绝
 *   5. 未连接：mud_send 可读拒绝（连接是手工动词）
 *   6. mud_state 不受闸门/连接约束：未接入未连接也可读
 *   7. listen 编译：非法正则报可读错（不炸回合）；合法 listen 透传编译产物
 *   8. timeoutMs 钳制到 MAX_TIMEOUT_MS；缺省注入 sendTimeoutMs；有 cmd/裸读缺省判据
 */

import { describe, expect, it } from 'vitest'

import {
  CORE_ABSENT_ERROR, GATE_CLOSED_ERROR, MAX_TIMEOUT_MS, NO_ACCOUNT_ERROR, NOT_CONNECTED_ERROR,
  compileListen, denyMatch, registerMudTools,
  type MudCore3Handle, type MudToolDefinition, type ToolContext, type ToolRegistrar,
} from '../src/tools.ts'
import type { MudReadOpts, SessionRuntime } from '../src/runtime.ts'
import type { ConnState } from '../src/roster.ts'

// ── 假件 ──────────────────────────────────────────────────────────

/** 假 runtime：read 捕获调用参数（不触网），pending/dropped 计数可注入。 */
function fakeRuntime(over: { pendingLineCount?: number; droppedLineCount?: number } = {}): {
  runtime: SessionRuntime
  readCalls: MudReadOpts[]
} {
  const readCalls: MudReadOpts[] = []
  const runtime = {
    pendingLineCount: over.pendingLineCount ?? 0,
    droppedLineCount: over.droppedLineCount ?? 0,
    read: async (opts: MudReadOpts): Promise<{ lines: never[]; reason: string }> => {
      readCalls.push(opts)
      return { lines: [], reason: 'timeout' }
    },
  } as unknown as SessionRuntime
  return { runtime, readCalls }
}

/** 假工具执行上下文（缺省 = 已接入 + 已连接）。 */
function fakeToolContext(over: {
  admitted?: boolean
  connState?: ConnState
  runtime?: SessionRuntime
} = {}): ToolContext {
  const { runtime } = fakeRuntime()
  return {
    sessionId: 't1',
    runtime: over.runtime ?? runtime,
    admitted: over.admitted ?? true,
    connState: over.connState ?? 'connected',
  }
}

/** 假引擎窄面。 */
function fakeCore(tctx: ToolContext | null): MudCore3Handle {
  return {
    toolContextFor: () => tctx,
    defaults: { sendTimeoutMs: 15000, sendMaxLines: 50 },
  }
}

/** 假 registrar：记录注册的定义。 */
function fakeRegistrar(): { registrar: ToolRegistrar; defs: Map<string, MudToolDefinition> } {
  const defs = new Map<string, MudToolDefinition>()
  const registrar: ToolRegistrar = {
    register: def => {
      defs.set(def.name, def)
      return () => {}
    },
  }
  return { registrar, defs }
}

/** 装好一套工具，返回二工具定义表。 */
function setup(tctx: ToolContext | null): Map<string, MudToolDefinition> {
  const { registrar, defs } = fakeRegistrar()
  registerMudTools(registrar, { core: () => fakeCore(tctx) })
  return defs
}

const EXEC = { signal: new AbortController().signal, agent: { id: 't1' } }

// ── 测试 ──────────────────────────────────────────────────────────

describe('registerMudTools', () => {
  it('1. 注册完整性：二工具注册成功 + 参数面；registrar 抛错 fail-loud', () => {
    const { registrar, defs } = fakeRegistrar()
    registerMudTools(registrar, { core: () => null })
    expect([...defs.keys()].sort()).toEqual(['mud_send', 'mud_state'])
    // 参数面（§9）：mud_send 独占（isConcurrencySafe false）+ 60s 上限；mud_state 并发安全
    expect(defs.get('mud_send')?.isConcurrencySafe).toBe(false)
    expect(defs.get('mud_state')?.isConcurrencySafe).toBe(true)
    expect(defs.get('mud_send')?.timeoutMs).toBe(MAX_TIMEOUT_MS)
    expect(defs.get('mud_state')?.timeoutMs).toBe(5000)

    // fail-loud：registrar 抛错即冒泡（注册问题不静默）
    const boom: ToolRegistrar = { register: () => { throw new Error('registrar 炸了') } }
    expect(() => registerMudTools(boom, { core: () => null })).toThrow('registrar 炸了')
  })

  it('2. 引擎缺席 / 归属 null：可读拒绝', async () => {
    // 引擎缺席：core() → null（I9：注册照常、执行可读拒绝）
    const { registrar, defs } = fakeRegistrar()
    registerMudTools(registrar, { core: () => null })
    await expect(defs.get('mud_send')!.execute({ cmd: 'look' }, EXEC))
      .resolves.toEqual({ ok: false, error: CORE_ABSENT_ERROR })
    await expect(defs.get('mud_state')!.execute({}, EXEC))
      .resolves.toEqual({ ok: false, error: CORE_ABSENT_ERROR })

    // 归属 null：toolContextFor → null（会话不在 roster）
    const unbound = setup(null)
    await expect(unbound.get('mud_send')!.execute({ cmd: 'look' }, EXEC))
      .resolves.toEqual({ ok: false, error: NO_ACCOUNT_ERROR })
    await expect(unbound.get('mud_state')!.execute({}, EXEC))
      .resolves.toEqual({ ok: false, error: NO_ACCOUNT_ERROR })
  })

  it('3. deny 全段扫描：suicide 任何位置/大小写拒；quit/drop/passwd 放行（最小集）', async () => {
    const rt = fakeRuntime()
    const defs = setup(fakeToolContext({ runtime: rt.runtime }))
    const send = defs.get('mud_send')!

    // 首词、段中（分号）、空白、大小写全拒
    for (const cmd of ['suicide', 'look;suicide', 'SUICIDE', 'look suicide']) {
      const r = await send.execute({ cmd }, EXEC) as { ok: boolean; error: string }
      expect(r.ok).toBe(false)
      expect(r.error).toContain('suicide')
    }
    expect(rt.readCalls).toHaveLength(0) // 拒绝不触达 runtime
    // 单元面：\s 切分含换行
    expect(denyMatch('look;\nsuicide')).toBe('suicide')
    expect(denyMatch('look')).toBeNull()

    // 可逆命令放行（用户裁定最小集：quit/drop/passwd 不设拦）——放行 = 走到执行
    const r = await send.execute({ cmd: 'quit' }, EXEC) as { ok: boolean }
    expect(r.ok).toBe(true)
    await send.execute({ cmd: 'drop all' }, EXEC)
    await send.execute({ cmd: 'passwd 123456' }, EXEC)
    expect(rt.readCalls.map(c => c.cmd)).toEqual(['quit', 'drop all', 'passwd 123456'])
  })

  it('4. 未接入：mud_send 可读拒绝', async () => {
    const defs = setup(fakeToolContext({ admitted: false, connState: 'connected' }))
    await expect(defs.get('mud_send')!.execute({ cmd: 'look' }, EXEC))
      .resolves.toEqual({ ok: false, error: GATE_CLOSED_ERROR })
  })

  it('5. 未连接：mud_send 可读拒绝（连接是手工动词）', async () => {
    const defs = setup(fakeToolContext({ admitted: true, connState: 'disconnected' }))
    await expect(defs.get('mud_send')!.execute({ cmd: 'look' }, EXEC))
      .resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
  })

  it('6. mud_state 不受闸门/连接约束：未接入未连接也可读（§6 形态）', async () => {
    const rt = fakeRuntime({ pendingLineCount: 320, droppedLineCount: 5 })
    const defs = setup(fakeToolContext({
      admitted: false, connState: 'disconnected', runtime: rt.runtime,
    }))
    await expect(defs.get('mud_state')!.execute({}, EXEC)).resolves.toEqual({
      ok: true,
      state: { connState: 'disconnected', admitted: false, recording: 320, dropped: 5 },
    })
  })

  it('7. listen 编译：非法正则报可读错；合法 listen 透传编译产物', async () => {
    const rt = fakeRuntime()
    const defs = setup(fakeToolContext({ runtime: rt.runtime }))
    const send = defs.get('mud_send')!

    // 非法正则：可读拒绝（不炸回合、不触达 runtime）
    const r = await send.execute({ cmd: 'look', listen: { until: ['(['] } }, EXEC) as { ok: boolean; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('listen.until 正则非法')
    expect(rt.readCalls).toHaveLength(0)

    // 合法 listen：编译产物透传给 read
    await send.execute({ cmd: 'look', listen: { until: ['你\\s*获得'], gaCount: 2 } }, EXEC)
    expect(rt.readCalls[0]?.until).toEqual([/你\s*获得/])
    expect(rt.readCalls[0]?.gaCount).toBe(2)

    // 单元面：全空 = {}（缺省判据由工具按模式注入）
    expect(compileListen(undefined)).toEqual({})
    expect(compileListen({})).toEqual({})
  })

  it('8. timeoutMs 钳制上限；缺省注入；有 cmd / 裸读缺省判据', async () => {
    const rt = fakeRuntime()
    const defs = setup(fakeToolContext({ runtime: rt.runtime }))
    const send = defs.get('mud_send')!

    // 钳制：超上限压到 60000；参数未给用缺省 15000；未超限原样
    await send.execute({ cmd: 'look', timeoutMs: 999999 }, EXEC)
    expect(rt.readCalls[0]?.timeoutMs).toBe(MAX_TIMEOUT_MS)
    await send.execute({ cmd: 'look' }, EXEC)
    expect(rt.readCalls[1]?.timeoutMs).toBe(15000)
    await send.execute({ cmd: 'look', timeoutMs: 100 }, EXEC)
    expect(rt.readCalls[2]?.timeoutMs).toBe(100)

    // 有 cmd 缺省判据：gaCount:1 + maxLines:50 兜底
    expect(rt.readCalls[0]?.cmd).toBe('look')
    expect(rt.readCalls[0]?.gaCount).toBe(1)
    expect(rt.readCalls[0]?.maxLines).toBe(50)

    // 裸读（无 cmd）缺省判据：quietMs:300 + maxLines:50，不带 gaCount
    await send.execute({}, EXEC)
    expect(rt.readCalls[3]?.cmd).toBeUndefined()
    expect(rt.readCalls[3]?.quietMs).toBe(300)
    expect(rt.readCalls[3]?.maxLines).toBe(50)
    expect(rt.readCalls[3]?.gaCount).toBeUndefined()
  })
})
