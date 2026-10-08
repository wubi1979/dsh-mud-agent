/**
 * tools 测试 — 工具面（T2b）：拒绝序 + 持有者 + 归属父链上溯 + 端到端。
 *
 * 分两层：
 *   - 纯单元（stub runtime / stub handle）：deny 全段扫描、拒绝序、listen 编译、
 *     timeout 钳制、裸读/有 cmd 的缺省判据与 initial、持有者冲突；
 *   - 集成（真实 TCP + 真实 MudService + parentLookup）：mud_connect 幂等不重连、
 *     mud_send 端到端、并发 send 可读拒绝不劈半、mud_state 合并快照、
 *     子会话经父链解析到账号 runtime。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  registerMudTools, denyMatch, commandTokens, compileListen,
  CORE_ABSENT_ERROR, NOT_BOUND_ERROR, NOT_CONNECTED_ERROR, HOLDER_BUSY_ERROR,
  MAX_TIMEOUT_MS,
  type MudToolDefinition, type ToolRegistrar, type MudCore3Handle, type MudToolDeps,
} from '../src/tools.ts'
import { NavService } from '../src/nav/service.ts'
import type { SessionRuntime } from '../src/runtime.ts'
import { World } from '../src/world.ts'
import type { ReadOpts, ReadResult } from '../src/read.ts'
import { MudService } from '../src/service.ts'
import type {
  AccountRecord, ResolvedCredentials, ServerRecord,
} from '../src/roster.ts'
import type { MudLine } from '../src/link/line.ts'

// ── 纯单元：禁发表 / listen 编译 ─────────────────────────────────────

describe('denyMatch 全段扫描（§12.3 最小集）', () => {
  it('suicide 命中（大小写不敏感）', () => {
    expect(denyMatch('suicide')).toBe('suicide')
    expect(denyMatch('SUICIDE')).toBe('suicide')
    expect(denyMatch('  suicide  ')).toBe('suicide')
  })

  it('全段扫描：组合命令中任一 token 命中即拒（堵 look;suicide 绕过洞）', () => {
    expect(denyMatch('look;suicide')).toBe('suicide')
    expect(denyMatch('look ; suicide')).toBe('suicide')
    expect(denyMatch('save\nsuicide')).toBe('suicide')
  })

  it('最小集：quit/drop/passwd 等放行（不设拦截）', () => {
    expect(denyMatch('quit')).toBeNull()
    expect(denyMatch('drop all')).toBeNull()
    expect(denyMatch('passwd')).toBeNull()
    expect(denyMatch('look')).toBeNull()
  })

  it('commandTokens：按空白/分号切分，过滤空段', () => {
    expect(commandTokens('look;  get all')).toEqual(['look', 'get', 'all'])
    expect(commandTokens('')).toEqual([])
  })
})

describe('compileListen', () => {
  it('全空 = 空对象（调用方按有/无 cmd 填缺省判据）', () => {
    expect(compileListen(undefined)).toEqual({})
    expect(compileListen({})).toEqual({})
  })

  it('字符串正则编译为 RegExp；非法正则 throw 可读错', () => {
    const out = compileListen({ until: ['你好'], gaCount: 2 })
    expect(out.until).toHaveLength(1)
    expect(out.until![0]!.test('你好呀')).toBe(true)
    expect(out.gaCount).toBe(2)
    expect(() => compileListen({ until: ['([bad'] })).toThrow(/listen\.until 正则非法/)
  })
})

// ── 纯单元：mud_send 执行序（stub runtime + stub handle）─────────────

/** 可编程 stub runtime（只实现工具消费的面）。 */
function stubRuntime(overrides: Partial<Record<string, unknown>> = {}): SessionRuntime {
  return {
    connState: 'connected',
    acquireSend: () => true,
    releaseSend: () => {},
    send: () => true,
    recentLines: () => [],
    read: async () => ({ lines: [], reason: 'quiet' }),
    worldEntry: () => undefined, // T23.10 精力闸 / departures 读 World（真实 runtime 亦然）
    writeNavWorld: () => {}, // T23.10b 未受理时服务侧写 location.出发点就绪=false
    ...overrides,
  } as unknown as SessionRuntime
}

interface CapturedRead { opts: ReadOpts; initial: readonly MudLine[] }

/**
 * 组装：注册三工具 + 可编程 handle。
 * runtimeOverrides 未给 read 时，自动接入 read 捕获（captured.opts/initial）。
 */
function setup(
  handleOverrides: Partial<MudCore3Handle> = {},
  runtimeOverrides: Partial<Record<string, unknown>> = {},
  depsOverrides: Partial<MudToolDeps> = {},
) {
  const captured: CapturedRead = { opts: {} as ReadOpts, initial: [] }
  const rt = stubRuntime({
    ...(Object.prototype.hasOwnProperty.call(runtimeOverrides, 'read')
      ? {}
      : {
          read: async (opts: ReadOpts, initial: readonly MudLine[]) => {
            captured.opts = opts
            captured.initial = initial
            return { lines: [...initial], reason: 'quiet', hit: undefined } satisfies ReadResult
          },
        }),
    ...runtimeOverrides,
  })
  const handle: MudCore3Handle = {
    toolContextFor: () => ({ sessionId: 'acc-1', runtime: rt }),
    connect: async () => ({ state: 'connected' }),
    workflowIoFor: async () => { throw new Error('测试未预期调用 workflowIoFor') },
    stateOf: () => ({
      connState: 'connected', loggedIn: 'unknown', admitted: false, world: {}, recording: 0, dropped: 0,
    }),
    defaults: { sendTimeoutMs: 15000, sendMaxLines: 50, staminaFloorPct: 0.2 },
    ...handleOverrides,
  }
  const defs = new Map<string, MudToolDefinition>()
  const registrar: ToolRegistrar = {
    register: def => {
      defs.set(def.name, def)
      return () => {}
    },
  }
  registerMudTools(registrar, { core: () => handle, ...depsOverrides })
  const call = (name: string, args: unknown, agentId = 'acc-1') =>
    defs.get(name)!.execute(args, { signal: new AbortController().signal, agent: { id: agentId } })
  const readCapture = (): CapturedRead => captured
  return { defs, call, readCapture, rt }
}

describe('mud_send 拒绝序（stub）', () => {
  it('注册完整性：四工具全部过 registrar', () => {
    const { defs } = setup()
    expect([...defs.keys()].sort()).toEqual(['mud_connect', 'mud_send', 'mud_state', 'mud_walk'])
  })

  it('引擎缺席：四工具都给可读拒绝（注册照常）', async () => {
    const defs = new Map<string, MudToolDefinition>()
    registerMudTools({ register: def => { defs.set(def.name, def); return () => {} } }, { core: () => null })
    for (const name of ['mud_connect', 'mud_send', 'mud_state', 'mud_walk']) {
      const r = await defs.get(name)!.execute({}, { signal: new AbortController().signal, agent: { id: 'x' } })
      expect(r).toEqual({ ok: false, error: CORE_ABSENT_ERROR })
    }
  })

  it('归属 null：可读拒绝「未绑定 MUD 账号」', async () => {
    const { call } = setup({ toolContextFor: () => null })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({ ok: false, error: NOT_BOUND_ERROR })
    await expect(call('mud_state', {})).resolves.toEqual({ ok: false, error: NOT_BOUND_ERROR })
  })

  it('禁发表先于连接闸门：未连接时发 suicide 也拒禁词而非未连接', async () => {
    const { call } = setup({}, { connState: 'disconnected' })
    await expect(call('mud_send', { cmd: 'suicide' })).resolves.toMatchObject({
      ok: false, error: /危险命令（suicide）被禁/,
    })
  })

  it('全段扫描进工具：look;suicide 拒绝带命中词', async () => {
    const { call } = setup()
    await expect(call('mud_send', { cmd: 'look;suicide' })).resolves.toMatchObject({
      ok: false, error: /（suicide）/,
    })
  })

  it('未连接：可读拒绝（最小集命令 quit 放行 deny 后命中连接闸门）', async () => {
    const { call } = setup({}, { connState: 'disconnected' })
    await expect(call('mud_send', { cmd: 'quit' })).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
    await expect(call('mud_send', {})).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
  })

  it('timeoutMs 非正整数拒绝；超上限钳制到 MAX_TIMEOUT_MS', async () => {
    const { call, readCapture } = setup()
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 0 })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_send', { cmd: 'look', timeoutMs: -5 })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1.5 })).resolves.toMatchObject({ ok: false })
    await call('mud_send', { cmd: 'look', timeoutMs: 999_999 })
    expect(readCapture().opts.timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it('持有者冲突：acquireSend 失败 → 可读拒绝，不 send 不 read', async () => {
    const sent: string[] = []
    const { call } = setup({}, {
      acquireSend: () => false,
      send: (cmd: string) => { sent.push(cmd); return true },
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({ ok: false, error: HOLDER_BUSY_ERROR })
    expect(sent).toEqual([])
  })

  // ── T19.5 D11 发送即走（wait:false）───────────────────────────────

  it('wait:false：send 后立即返回 reason=sent，绝不 read', async () => {
    const sent: string[] = []
    const { call } = setup({}, {
      send: (cmd: string) => { sent.push(cmd); return true },
      read: async () => { throw new Error('wait=false 不应调用 read') },
    })
    await expect(call('mud_send', { cmd: 'hpbrief', wait: false })).resolves.toEqual({
      ok: true, reason: 'sent', lines: [],
    })
    expect(sent).toEqual(['hpbrief'])
  })

  it('wait:false 仍过禁发表与连接闸门（拒绝序不变）', async () => {
    const { call } = setup({}, { connState: 'disconnected' })
    await expect(call('mud_send', { cmd: 'suicide', wait: false })).resolves.toMatchObject({
      ok: false, error: /危险命令（suicide）被禁/,
    })
    await expect(call('mud_send', { cmd: 'save', wait: false })).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
  })

  it('wait:false 无 cmd：可读拒绝（裸读请省略 wait）', async () => {
    const { call } = setup()
    await expect(call('mud_send', { wait: false })).resolves.toMatchObject({ ok: false, error: /需要提供 cmd/ })
  })

  it('wait 缺省行为不变：send + read（应答原文返回）', async () => {
    const { call, readCapture } = setup()
    await expect(call('mud_send', { cmd: 'look' })).resolves.toMatchObject({ ok: true, reason: 'quiet' })
    expect(readCapture().opts.gaCount).toBe(1) // 有 cmd 缺省判据（§8.7）未被 wait 分支破坏
  })

  it('send 失败（连接已断）：可读拒绝并释放持有者', async () => {
    let released = false
    const { call } = setup({}, {
      send: () => false,
      releaseSend: () => { released = true },
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toMatchObject({ ok: false, error: /发送失败/ })
    expect(released).toBe(true)
  })

  it('非法 listen 正则：可读拒绝', async () => {
    const { call } = setup()
    await expect(call('mud_send', { cmd: 'look', listen: { until: ['([bad'] } }))
      .resolves.toMatchObject({ ok: false, error: /正则非法/ })
  })
})

describe('mud_send 判据与 initial（stub）', () => {
  it('有 cmd：send 后 read，initial 为空，缺省判据 gaCount:1 + maxLines 兜底', async () => {
    const sent: string[] = []
    const { call, readCapture } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    const r = await call('mud_send', { cmd: 'look' })
    expect(r).toMatchObject({ ok: true, reason: 'quiet' })
    expect(sent).toEqual(['look'])
    expect(readCapture().initial).toEqual([])
    expect(readCapture().opts.gaCount).toBe(1)
    expect(readCapture().opts.maxLines).toBe(50)
    expect(readCapture().opts.timeoutMs).toBe(15000)
  })

  it('裸读：不 send，initial = recentLines(sendMaxLines)，缺省判据 maxLines + quietMs:300', async () => {
    const sent: string[] = []
    const snapshot: MudLine[] = [
      { text: '旧行1', raw: '旧行1', style: [], abs: 1, time: 0, isPrompt: false, kind: null },
      { text: '旧行2', raw: '旧行2', style: [], abs: 2, time: 0, isPrompt: false, kind: null },
    ]
    const { call, readCapture } = setup({}, {
      send: (cmd: string) => { sent.push(cmd); return true },
      recentLines: (n: number) => (n === 50 ? snapshot : []),
    })
    await call('mud_send', {})
    expect(sent).toEqual([])
    expect(readCapture().initial).toEqual(snapshot)
    expect(readCapture().opts.maxLines).toBe(50)
    expect(readCapture().opts.quietMs).toBe(300)
    expect(readCapture().opts.gaCount).toBeUndefined()
  })

  it('模型显式 listen 整体覆盖缺省判据', async () => {
    const { call, readCapture } = setup()
    await call('mud_send', { cmd: 'look', listen: { until: [' done'], quietMs: 25 } })
    expect(readCapture().opts.until).toHaveLength(1)
    expect(readCapture().opts.quietMs).toBe(25)
    expect(readCapture().opts.gaCount).toBeUndefined()
  })

  it('read 返回行原文（MudLine.text 映射）；结束后释放持有者', async () => {
    let released = false
    const { call } = setup({}, {
      releaseSend: () => { released = true },
      read: async () => ({
        lines: [
          { text: '应答行', raw: '', style: [], abs: 9, time: 0, isPrompt: false, kind: null },
        ],
        reason: 'done',
      }),
    })
    await expect(call('mud_send', { cmd: 'look' })).resolves.toEqual({
      ok: true, reason: 'done', lines: ['应答行'],
    })
    expect(released).toBe(true)
  })
})

describe('mud_walk 判据预设特化（T23，stub）', () => {
  it('缺省 args：发裸 walk，静默窗收束（无 gaCount），超时下限 30s', async () => {
    const sent: string[] = []
    const { call, readCapture } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await expect(call('mud_walk', {})).resolves.toMatchObject({ ok: true, reason: 'quiet' })
    expect(sent).toEqual(['walk'])
    expect(readCapture().initial).toEqual([])
    expect(readCapture().opts.quietMs).toBe(1500) // WALK_QUIET_MS：静默收「走完了」
    expect(readCapture().opts.gaCount).toBeUndefined() // 每步都出提示符，GA 会第一步关窗
    expect(readCapture().opts.maxLines).toBe(50)
    expect(readCapture().opts.timeoutMs).toBe(30000) // max(15000, WALK_MIN_TIMEOUT_MS)
  })

  it('args 透传：拼音名 / -c / -q 区域 / -p 各发一条 walk 命令', async () => {
    const sent: string[] = []
    const { call } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await call('mud_walk', { args: 'xiangyang' })
    await call('mud_walk', { args: ' -c ' })
    await call('mud_walk', { args: '-q 扬州' })
    await call('mud_walk', { args: '-p' })
    expect(sent).toEqual(['walk xiangyang', 'walk -c', 'walk -q 扬州', 'walk -p'])
  })

  it('拼接注入拒绝：分号/换行不行，60 字上限', async () => {
    const sent: string[] = []
    const { call } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await expect(call('mud_walk', { args: '-q 扬州;suicide' })).resolves.toMatchObject({
      ok: false, error: /单条 walk 参数/,
    })
    await expect(call('mud_walk', { args: 'a\nb' })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_walk', { args: 'x'.repeat(61) })).resolves.toMatchObject({ ok: false })
    expect(sent).toEqual([]) // 全部拒在 send 之前
  })

  it('timeoutMs 钳制：缺省下限 30s、显式值上限 60s、非正整数拒绝', async () => {
    const { call, readCapture } = setup()
    await expect(call('mud_walk', { timeoutMs: 0 })).resolves.toMatchObject({ ok: false })
    await call('mud_walk', { timeoutMs: 999_999 })
    expect(readCapture().opts.timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it('拒绝序同 mud_send：未归属 / 未连接 / 持有者冲突', async () => {
    const unbound = setup({ toolContextFor: () => null })
    await expect(unbound.call('mud_walk', {})).resolves.toEqual({ ok: false, error: NOT_BOUND_ERROR })
    const disconnected = setup({}, { connState: 'disconnected' })
    await expect(disconnected.call('mud_walk', {})).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
    const busy = setup({}, { acquireSend: () => false })
    await expect(busy.call('mud_walk', {})).resolves.toEqual({ ok: false, error: HOLDER_BUSY_ERROR })
  })

  it('行原文返回 + 收束后释放持有者', async () => {
    let released = false
    const { call } = setup({}, {
      releaseSend: () => { released = true },
      read: async () => ({
        lines: [
          { text: '你要往哪里走？', raw: '', style: [], abs: 1, time: 0, isPrompt: false, kind: null },
        ],
        reason: 'quiet',
      }),
    })
    await expect(call('mud_walk', { args: 'jiming' })).resolves.toEqual({
      ok: true, reason: 'quiet', outcome: 'unaccepted', lines: ['你要往哪里走？'],
    })
    expect(released).toBe(true)
  })

  it('T23.5 行走判据注入：到达 ⇒ until、软阻断/未受理 ⇒ failOn（A.9 结论 5）', async () => {
    const { call, readCapture } = setup()
    await call('mud_walk', { args: 'xiangyang' })
    const until = readCapture().opts.until ?? []
    const failOn = readCapture().opts.failOn ?? []
    expect(until.some(re => re.test('你到达了荆州府。'))).toBe(true)
    expect(failOn).toHaveLength(1)
    expect(failOn[0]!.test('你因为种种原因停了下来，可以用walk继续进行。')).toBe(true)
    // 缺省 args（恢复行走）同属"行走类"，同样注入判据
    await call('mud_walk', {})
    expect((readCapture().opts.until ?? []).length).toBeGreaterThan(0)
  })

  it('T23.5 查询类参数（-c / -q）不注入行走判据——其答复含"未受理"同族句', async () => {
    const { call, readCapture } = setup()
    await call('mud_walk', { args: '-c' })
    expect(readCapture().opts.until).toBeUndefined()
    expect(readCapture().opts.failOn).toBeUndefined()
    expect(readCapture().opts.quietMs).toBe(1500)
    await call('mud_walk', { args: '-q 扬州' })
    expect(readCapture().opts.until).toBeUndefined()
    expect(readCapture().opts.failOn).toBeUndefined()
  })

  it('T23.5 结果分类：到达 / 软阻断 / 未判定（未受理由反证给，见 T23.10b 用例）', async () => {
    const mk = (reason: string) => setup({}, { read: async () => ({ lines: [], reason }) })
    await expect(mk('until').call('mud_walk', {}))
      .resolves.toMatchObject({ ok: true, outcome: 'arrived' })
    await expect(mk('failOn').call('mud_walk', {}))
      .resolves.toMatchObject({ ok: true, outcome: 'soft-stop' })
    // 有受理行 ⇒ 在出发点，静默收束即"未判定"（不被反证误判为 unaccepted）
    const started = setup({}, {
      read: async () => ({
        lines: [{ text: '你决定开始前往襄阳方向走去……', raw: '', style: [], abs: 1, time: 0, isPrompt: false, kind: null }],
        reason: 'quiet',
      }),
    })
    await expect(started.call('mud_walk', {})).resolves.toMatchObject({ ok: true, outcome: 'incomplete' })
  })

  it('T23.9 意图式工具面：缺省 action = walk，向后兼容 {args}', async () => {
    const sent: string[] = []
    const { call } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await call('mud_walk', {})
    await call('mud_walk', { action: 'walk', args: 'xiangyang' })
    await call('mud_walk', { args: '-q 扬州' })
    expect(sent).toEqual(['walk', 'walk xiangyang', 'walk -q 扬州'])
  })

  it('T23.9 action:speed ⇒ set walk_speed <值>；值域 -1..3，缺值/越界/未知动作拒', async () => {
    const sent: string[] = []
    const { call } = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await call('mud_walk', { action: 'speed', value: '2' })
    await call('mud_walk', { action: 'speed', value: '-1' })
    expect(sent).toEqual(['set walk_speed 2', 'set walk_speed -1'])
    await expect(call('mud_walk', { action: 'speed' })).resolves.toMatchObject({ ok: false, error: /需要 value/ })
    await expect(call('mud_walk', { action: 'speed', value: '9' })).resolves.toMatchObject({ ok: false, error: /取值须在/ })
    await expect(call('mud_walk', { action: 'speed', value: 'x' })).resolves.toMatchObject({ ok: false })
    await expect(call('mud_walk', { action: 'nope' })).resolves.toMatchObject({ ok: false, error: /未知 action/ })
  })

  it('T23.9 node 三动词只留槽位：执行可读拒绝，且不出现在工具描述里', async () => {
    const { defs, call } = setup()
    await expect(call('mud_walk', { action: 'node' })).resolves.toMatchObject({ ok: false, error: /本期未实现/ })
    await expect(call('mud_walk', { action: 'node-get', name: 'kd_wd' })).resolves.toMatchObject({ ok: false, error: /本期未实现/ })
    await expect(call('mud_walk', { action: 'node-walk', name: 'kd_wd' })).resolves.toMatchObject({ ok: false, error: /本期未实现/ })
    expect(defs.get('mud_walk')!.description).not.toMatch(/node/)
  })

  it('T23.10b 记录与建议：走出来的节点入图，`-q` 回 hint/suggest/region（不加动词）', async () => {
    const w = new World()
    w.set('location', '区域', '荆州府')
    const navFace = new NavService()
    const worldEntry = (zone: string, key: string) => w.get(zone, key)
    const mkLine = (text: string): MudLine => ({ text, raw: text, style: [], abs: 1, time: 0, isPrompt: false, kind: null })
    // ① 首次行走读到本区域路径表（A.9 路线表）⇒ 边入图
    const table = setup({}, {
      worldEntry,
      read: async () => ({ lines: [
        mkLine('┌───荆州府─────────────┬────────────┬─────┐'),
        mkLine('│目的地                │拼音名称                │步数      │'),
        mkLine('│襄阳  ◇ 城中心                       │xiangyang               │15        │'),
        mkLine('└─────────────────────────────国庆节祝福────┘'),
      ], reason: 'quiet' }),
    }, { nav: () => navFace })
    const first = await table.call('mud_walk', { args: 'xiangyang' })
    expect(first).toMatchObject({ ok: true, region: '荆州府' })
    expect(navFace.snapshot().nodes[0]).toMatchObject({ region: '荆州府' })
    expect(navFace.snapshot().nodes[0]!.edges[0]).toMatchObject({ pinyin: 'xiangyang', steps: 15 })
    // ② 再查 `-q 武当山`：参考链只有参考意义 ⇒ 用已记录的边给出**下一跳建议**
    const query = setup({}, {
      worldEntry,
      read: async () => ({ lines: [mkLine('从这里到武当山途径襄阳、武当山。')], reason: 'quiet' }),
    }, { nav: () => navFace })
    await expect(query.call('mud_walk', { args: '-q 武当山' })).resolves.toMatchObject({
      ok: true,
      region: '荆州府',
      hint: { to: '武当山', via: ['襄阳', '武当山'] },
      suggest: { dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 15 },
    })
    // ③ 无 nav 服务 ⇒ 不记录、不给建议，行为退回本期之前（不报错）
    const noNav = setup({}, { worldEntry, read: async () => ({ lines: [mkLine('从这里到武当山途径襄阳、武当山。')], reason: 'quiet' }) })
    const bare = await noNav.call('mud_walk', { args: '-q 武当山' })
    expect(bare).toMatchObject({ ok: true })
    expect((bare as { suggest?: unknown }).suggest).toBeUndefined()
    expect((bare as { hint?: unknown }).hint).toBeUndefined()
  })

  it('T23.10b 在出发点判定用**反证**（用户裁定）：表类无表 ⇒ false、有表 ⇒ true、`-q` 不判定', async () => {
    const writes: unknown[][] = []
    const writeNavWorld = (zone: string, key: string, value: unknown) => { writes.push([zone, key, value]) }
    /** 只看 location 面（nav.* 的阻断计数另有断言）。 */
    const locWrites = (): unknown[][] => writes.filter(w => w[0] === 'location')
    const mkLine = (text: string): MudLine => ({ text, raw: text, style: [], abs: 1, time: 0, isPrompt: false, kind: null })
    // 表类（无参 walk / -c）：**没出表** ⇒ 不在出发点（不依赖"拒绝行文"单行判据）
    const bare = setup({}, {
      writeNavWorld,
      read: async () => ({ lines: [mkLine('你现在无法恢复使用内建路径。')], reason: 'quiet' }),
    })
    await bare.call('mud_walk', { args: '-c' })
    expect(locWrites()).toEqual([['location', '出发点就绪', false]])
    // 有表 ⇒ 在出发点（正向证据：块开行 + 表行）
    const tabled = setup({}, {
      writeNavWorld,
      read: async () => ({ lines: [
        mkLine('┌───扬州──────────────┬────────────┬─────┐'),
        mkLine('│信阳  ◇ 小广场                       │xinyang                 │10        │'),
      ], reason: 'quiet' }),
    })
    await tabled.call('mud_walk', { args: '-c' })
    expect(locWrites()[1]).toEqual(['location', '出发点就绪', true])
    // `-q`（区域链与出发点无关）⇒ 不参与判定
    await tabled.call('mud_walk', { args: '-q 襄阳' })
    expect(locWrites()).toHaveLength(2)
  })

  it('T23.10b 行走类静默且无受理行 ⇒ **反证**为 unaccepted + 就绪 false', async () => {
    const writes: unknown[][] = []
    const { call } = setup({}, {
      writeNavWorld: (zone: string, key: string, value: unknown) => { writes.push([zone, key, value]) },
      read: async () => ({ lines: [], reason: 'quiet' }),
    })
    await expect(call('mud_walk', { args: 'xiangyang' })).resolves.toMatchObject({ ok: true, outcome: 'unaccepted' })
    expect(writes.filter(w => w[0] === 'location')).toEqual([['location', '出发点就绪', false]])
  })

  it('T23.10b `walk -c <拼音名>` ⇒ 附 path.directions（可执行方向序列）', async () => {
    const mkLine = (text: string): MudLine => ({ text, raw: text, style: [], abs: 1, time: 0, isPrompt: false, kind: null })
    const { call } = setup({}, {
      read: async () => ({ lines: [
        mkLine('信阳 长版本：west,west,west,west,northwest,west,west,west,west,west'),
        mkLine('     短版本：#4 w,nw,#5 w'),
      ], reason: 'quiet' }),
    })
    await expect(call('mud_walk', { args: '-c xinyang' })).resolves.toMatchObject({
      ok: true,
      path: { to: '信阳', short: '#4 w,nw,#5 w', directions: ['west', 'west', 'west', 'west', 'northwest', 'west', 'west', 'west', 'west', 'west'] },
    })
  })

  it('T23.11 阻断档案：同位置连续两次软阻断 ⇒ hard-stop（回 agent 停手，不硬重试）', async () => {
    const w = new World()
    w.set('location', '区域', '襄阳')
    const worldEntry = (zone: string, key: string) => w.get(zone, key)
    const writeNavWorld = (zone: string, key: string, value: unknown) => { w.set(zone, key, value, 'measured', { kind: 'nav', time: 0 }) }
    const mkLine = (text: string): MudLine => ({ text, raw: text, style: [], abs: 1, time: 0, isPrompt: false, kind: null })
    const softStop = {
      worldEntry, writeNavWorld,
      read: async () => ({
        lines: [
          mkLine('你决定开始前往襄阳方向走去……'), // 有受理行 ⇒ 在出发点（不被反证误判）
          mkLine('你因为种种原因停了下来，可以用walk继续进行。'),
        ],
        reason: 'failOn',
      }),
    }
    await expect(setup({}, softStop).call('mud_walk', { args: 'xiangyang' })).resolves.toMatchObject({
      ok: true, outcome: 'soft-stop', blocked: { attempts: 1, hard: false, at: '襄阳' },
    })
    await expect(setup({}, softStop).call('mud_walk', { args: 'xiangyang' })).resolves.toMatchObject({
      ok: true, outcome: 'hard-stop', blocked: { attempts: 2, hard: true, at: '襄阳' },
    })
    // 档案落 World（kind='nav'）
    expect(w.get('nav', '软阻断连击')?.value).toBe(2)
    expect(w.get('nav', '硬阻断')?.value).toBe(true)
    expect(w.get('nav', '硬阻断')?.source.kind).toBe('nav')
    // 到达 ⇒ 清零
    const arrived = setup({}, {
      worldEntry, writeNavWorld,
      read: async () => ({ lines: [mkLine('你到达了襄阳。')], reason: 'until' }),
    })
    await arrived.call('mud_walk', { args: 'xiangyang' })
    expect(w.get('nav', '软阻断连击')?.value).toBe(0)
    expect(w.get('nav', '硬阻断')?.value).toBe(false)
  })

  it('T23.10 精力闸：<20% 拒（不发命令），充足/未知放行；查询与 speed 不受闸门', async () => {
    const mkEntry = (cur: number, max: number) => {
      const w = new World()
      w.set('vitals', '精力', cur)
      w.set('vitals', '最大精力', max)
      return (zone: string, key: string) => w.get(zone, key)
    }
    const sent: string[] = []
    const low = setup({}, { worldEntry: mkEntry(10, 100), send: (cmd: string) => { sent.push(cmd); return true } })
    await expect(low.call('mud_walk', { args: 'xiangyang' })).resolves.toMatchObject({ ok: false, error: /精力不足/ })
    expect(sent).toEqual([]) // 拒在 send 之前
    // 查询类不受闸门（答复不是行动）
    await low.call('mud_walk', { args: '-c' })
    await low.call('mud_walk', { action: 'speed', value: '1' })
    expect(sent).toEqual(['walk -c', 'set walk_speed 1'])
    // 充足（精力可为上限的 200%）与未知（World 尚未写入）都放行
    const rich = setup({}, { worldEntry: mkEntry(150, 100), send: (cmd: string) => { sent.push(cmd); return true } })
    await rich.call('mud_walk', { args: 'xiangyang' })
    const unknown = setup({}, { send: (cmd: string) => { sent.push(cmd); return true } })
    await unknown.call('mud_walk', { args: 'xiangyang' })
    expect(sent).toEqual(['walk -c', 'set walk_speed 1', 'walk xiangyang', 'walk xiangyang'])
  })

  it('T23.10 unaccepted（反证）结果附 departures（World location.出发点）；到达不带', async () => {
    const w = new World()
    w.set('location', '出发点', ['当铺', '中央广场', '客店', '土地庙', '醉仙楼二楼'])
    const worldEntry = (zone: string, key: string) => w.get(zone, key)
    // 行走类静默且无受理行 ⇒ 反证为 unaccepted ⇒ 附本区域起点
    const unaccepted = setup({}, { worldEntry, read: async () => ({ lines: [], reason: 'quiet' }) })
    await expect(unaccepted.call('mud_walk', { args: 'xiangyang' }))
      .resolves.toMatchObject({ ok: true, outcome: 'unaccepted', departures: ['当铺', '中央广场', '客店', '土地庙', '醉仙楼二楼'] })
    const arrived = setup({}, { worldEntry, read: async () => ({ lines: [], reason: 'until' }) })
    const res = await arrived.call('mud_walk', { args: 'xiangyang' })
    expect(res).toMatchObject({ ok: true, outcome: 'arrived' })
    expect((res as { departures?: unknown }).departures).toBeUndefined()
  })
})

// ── 集成：真实 TCP + 真实 MudService + parentLookup ──────────────────

interface MockServer {
  port: number
  close(): Promise<void>
  /** 收到的所有数据。 */
  received: string[]
  /** 已建立的连接数（幂等断言用）。 */
  connections: () => number
  /** 向所有活跃连接写行 + GA。 */
  writeLines(lines: string[]): void
}

async function startMockServer(): Promise<MockServer> {
  const received: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('data', (d: Buffer) => {
      received.push(d.toString('utf8'))
      // 收到任何命令 → 回两行应答 + GA
      s.write('你看到这里的东西\n')
      s.write('这里的出口是显然的\n')
      s.write(Buffer.from([255, 249])) // IAC GA
    })
    s.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    connections: () => sockets.size,
    writeLines(lines: string[]) {
      for (const s of sockets) {
        for (const l of lines) s.write(`${l}\n`)
        s.write(Buffer.from([255, 249]))
      }
    },
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

/** 集成装配：MudService + 父链表 + 引擎窄面（镜像 index.ts provide 面）。 */
async function setupIntegration() {
  const server = await startMockServer()
  const servers = new Map<string, ServerRecord>([
    ['ws-1', { workspaceId: 'ws-1', name: 'S1', host: '127.0.0.1', port: server.port }],
  ])
  const accounts = new Map<string, AccountRecord>([
    ['acc-1', { id: 'acc-1', name: 'u1', passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
  ])
  const creds = new Map<string, ResolvedCredentials>([
    ['c1', { name: 'u1', pass: 'p1' }],
  ])
  const parents = new Map<string, string>([['sub-1', 'acc-1']])
  const service = new MudService({
    serverLookup: id => {
      const acc = accounts.get(id)
      return acc ? servers.get(acc.serverId) : undefined
    },
    accountLookup: id => accounts.get(id),
    resolveCreds: async account => {
      const c = creds.get(account.passRef)
      if (c === undefined) throw new Error(`凭据 ${account.passRef} 解析失败`)
      return c
    },
    parentLookup: id => parents.get(id),
  })
  service.register('acc-1')

  // 引擎窄面（镜像 index.ts provide 面）
  const handle: MudCore3Handle = {
    toolContextFor: agent => service.toolContextFor(String(agent?.id ?? '')),
    connect: async sessionId => {
      const r = await service.connect(sessionId)
      return { state: r.state }
    },
    workflowIoFor: (sessionId, holder) => service.workflowIoFor(sessionId, holder),
    stateOf: sessionId => {
      const s = service.status(sessionId)
      const rt = service.get(sessionId)
      return {
        connState: s.state, loggedIn: s.loggedIn, admitted: s.admitted, world: s.world,
        recording: rt?.pendingLineCount ?? 0, dropped: rt?.droppedLineCount ?? 0,
      }
    },
    defaults: { sendTimeoutMs: 15000, sendMaxLines: 50, staminaFloorPct: 0.2 },
  }
  const defs = new Map<string, MudToolDefinition>()
  registerMudTools({ register: def => { defs.set(def.name, def); return () => {} } }, { core: () => handle })
  const call = (name: string, args: unknown, agentId?: string) =>
    defs.get(name)!.execute(args, {
      signal: new AbortController().signal,
      ...(agentId !== undefined ? { agent: { id: agentId } } : {}),
    })
  return { server, service, call, handle }
}

describe('工具面集成（真实 TCP）', () => {
  it('mud_connect：建连成功；幂等重连不建第二条连接', async () => {
    const { server, call } = await setupIntegration()
    await expect(call('mud_connect', {}, 'acc-1')).resolves.toEqual({ ok: true, state: 'connected' })
    expect(server.connections()).toBe(1)

    await expect(call('mud_connect', {}, 'acc-1')).resolves.toEqual({ ok: true, state: 'connected' })
    // 等 socket 集合稳定
    await new Promise(r => setTimeout(r, 100))
    expect(server.connections()).toBe(1)

    await server.close()
  })

  it('mud_send：发命令收应答原文（端到端）', async () => {
    const { server, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 3000 }, 'acc-1')).resolves.toMatchObject({
      ok: true,
      lines: ['你看到这里的东西', '这里的出口是显然的'],
    })
    expect(server.received.join('')).toContain('look')
    await server.close()
  })

  it('并发 send：第二个执行体可读拒绝（不劈半），第一个完整收束', async () => {
    const { server, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')

    // 执行体 A：until 永不命中 + 短超时（占住持有者直到超时）
    const first = call('mud_send', {
      cmd: 'longwait', listen: { until: ['永不会出现'] }, timeoutMs: 400,
    }, 'acc-1')
    // 执行体 B（子会话，holder = sub-1 ≠ acc-1）：立即尝试 → 撞持有者
    await new Promise(r => setTimeout(r, 50))
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1000 }, 'sub-1'))
      .resolves.toEqual({ ok: false, error: HOLDER_BUSY_ERROR })

    // A 完整收束（应答不劈半：B 未中途读走行）
    await expect(first).resolves.toMatchObject({ ok: true })
    // A 释放后 B 可再发
    await expect(call('mud_send', { cmd: 'look', timeoutMs: 1000 }, 'sub-1')).resolves.toMatchObject({ ok: true })
    await server.close()
  })

  it('归属父链上溯：根命中自身；子会话沿父链解析到账号 runtime；无关会话拒', async () => {
    const { server, handle, service, call } = await setupIntegration()
    await call('mud_connect', {}, 'acc-1')

    // 根命中自身
    expect(handle.toolContextFor({ id: 'acc-1' })?.sessionId).toBe('acc-1')
    // 子会话（root 直接派发）沿父链命中
    expect(handle.toolContextFor({ id: 'sub-1' })?.sessionId).toBe('acc-1')
    // 子会话 mud_send 端到端（应答作为调用方的工具结果）
    await expect(call('mud_send', { cmd: 'who', timeoutMs: 3000 }, 'sub-1')).resolves.toMatchObject({ ok: true })
    // 无关会话 → null
    expect(handle.toolContextFor({ id: 'stranger' })).toBeNull()
    // 环不悬挂：parentLookup 成环时上溯护栏返回 null
    const cyclic = new MudService({
      serverLookup: () => undefined,
      accountLookup: () => undefined,
      resolveCreds: async () => ({ name: 'x', pass: 'y' }),
      parentLookup: id => (id === 'a' ? 'b' : 'a'),
    })
    cyclic.register('a')
    expect(cyclic.toolContextFor('a')).toBeNull()

    await server.close()
    void service
  })

  it('mud_state：未连接也可读（插件状态 + world 合并），连接后翻转', async () => {
    const { server, call } = await setupIntegration()
    // 未连接：mud_send 拒，mud_state 可读
    await expect(call('mud_send', { cmd: 'look' }, 'acc-1')).resolves.toEqual({ ok: false, error: NOT_CONNECTED_ERROR })
    const before = await call('mud_state', {}, 'acc-1') as { ok: boolean; state: Record<string, unknown> }
    expect(before.ok).toBe(true)
    expect(before.state.connState).toBe('disconnected')

    await call('mud_connect', {}, 'acc-1')
    const after = await call('mud_state', {}, 'acc-1') as { ok: boolean; state: Record<string, unknown> }
    expect(after.state.connState).toBe('connected')
    await server.close()
  })
})
