/**
 * dsh-mud-core — 权限档位测试 (`doc/ARCHITECTURE.md` §10)。
 *
 * 覆盖:
 *   - 档位表: 选项/顺序/能力集, 可见工具集逐档包含;
 *   - 强制判定矩阵 (`evaluateToolCall`): 三档 × 动作 × actor (登录流程豁免);
 *   - 命令提取 (`commandsOfToolCall`): 语义工具 → 实际会发的命令;
 *   - 闸门装配 (`installMudToolGate`): 非 MUD 工具放行 (必须 `next()`)、
 *     拒绝/待批准短路、留痕;
 *   - 档位服务 (`registerMudCapability`): 缺省回落、设置与通知、事件折叠与校验。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { installMudToolGate } from '../src/agent/gate/tool-gate.ts'
import { commandsOfToolCall, evaluateToolCall, type ToolCallVerdictInput } from '../src/agent/gate/policy.ts'
import { buildGateRules } from '../src/agent/gate/rules.ts'
import {
  MUD_TIER_NAMES, MUD_TIER_SPECS, isMudTier, mudTierNote, mudTierOption, resolveMudTier, visibleTools,
} from '../src/agent/gate/tiers.ts'
import {
  applyCapabilityEvent, parseCapabilityState, registerMudCapability, type MudCapabilityApi,
} from '../src/agent/gate/capability.ts'

/** 登录流程命令集 (与宿主装配一致: 由 login:* 规则派生; 这里显式列出以免测试依赖规则表)。 */
const LOGIN_COMMANDS: ReadonlySet<string> = new Set(['{name}', '{pass}', 'y'])
const MUD_TOOLS: ReadonlySet<string> = new Set([
  'mud_state', 'mud_send', 'world_patch', 'mud_move', 'mud_look', 'mud_status',
  'mud_flow_list', 'mud_flow_disable', 'mud_flow_enable',
])

function verdict(input: Partial<ToolCallVerdictInput> & { name: string }): string {
  const decision = evaluateToolCall({
    args: {},
    tier: 'operate',
    rules: buildGateRules(),
    loginFlow: false,
    loginCommands: LOGIN_COMMANDS,
    mudTools: MUD_TOOLS,
    ...input,
  })
  return decision.kind
}

describe('档位表', () => {
  it('三档顺序固定, 选项形状对齐官方 preset option', () => {
    expect(MUD_TIER_NAMES).toEqual(['observe', 'operate', 'full'])
    expect(mudTierOption('operate')).toEqual({
      value: 'operate',
      name: MUD_TIER_SPECS.operate.name,
      description: MUD_TIER_SPECS.operate.description,
    })
    expect(() => mudTierOption('nope')).toThrow(/unknown tier/)
  })

  it('可见工具集逐档包含 (只读 ⊂ 读写 ⊂ 完全)', () => {
    const observe = new Set(visibleTools('observe'))
    const operate = new Set(visibleTools('operate'))
    const full = new Set(visibleTools('full'))
    for (const tool of observe) expect(operate.has(tool)).toBe(true)
    for (const tool of operate) expect(full.has(tool)).toBe(true)
    // 只读档没有发语义命令的工具 (mud_move/look/status), 但有零发送通路。
    expect(observe.has('mud_state')).toBe(true)
    expect(observe.has('mud_move')).toBe(false)
    // 外围能力只在完全档。
    expect(MUD_TIER_SPECS.observe.capabilities).toEqual([])
    expect(MUD_TIER_SPECS.full.capabilities).toContain('connection:connect')
  })

  it('档位名解析: 坏值回落不抛出', () => {
    expect(resolveMudTier(' full ', 'operate')).toBe('full')
    expect(resolveMudTier('nope', 'operate')).toBe('operate')
    expect(resolveMudTier(undefined, 'observe')).toBe('observe')
    expect(isMudTier('observe')).toBe(true)
    expect(isMudTier('admin')).toBe(false)
  })

  it('模型可见的档位说明: 三档各不相同, 且说清了"能/不能"', () => {
    const notes = MUD_TIER_NAMES.map(tier => mudTierNote(tier))
    expect(new Set(notes).size).toBe(3)
    expect(notes[0]).toContain('只读')
    expect(notes[0]).toContain('不能发送')
    expect(notes[1]).toContain('需要用户批准')
    expect(notes[2]).toContain('触发器组')
  })
})

describe('强制判定矩阵 (evaluateToolCall)', () => {
  it('非 MUD 工具永不介入 (本插件只认自己的工具名)', () => {
    expect(verdict({ name: 'read_file', tier: 'observe' })).toBe('allow')
    expect(verdict({ name: 'bash', tier: 'observe' })).toBe('allow')
  })

  it('只读档: 零发送通路放行, 其余命令拒绝', () => {
    expect(verdict({ name: 'mud_state', tier: 'observe' })).toBe('allow')
    expect(verdict({ name: 'mud_help', tier: 'observe' })).toBe('allow')
    // world_patch 是 T1 置位通道 (登录完成/失败), 非发送 → 放行。
    expect(verdict({ name: 'world_patch', args: { patch: { logged_in: true } }, tier: 'observe' })).toBe('allow')
    // mud_captcha 是 fullme 流程的解析工具 (不发游戏命令) → 所有档位都放行。
    expect(verdict({ name: 'mud_captcha', args: { url: 'x' }, tier: 'observe' })).toBe('allow')
    expect(verdict({ name: 'mud_captcha', args: { url: 'x' }, tier: 'operate' })).toBe('allow')
    expect(verdict({ name: 'mud_captcha', args: { url: 'x' }, tier: 'full' })).toBe('allow')
    expect(verdict({ name: 'mud_send', args: { cmd: 'look' }, tier: 'observe' })).toBe('deny')
    expect(verdict({ name: 'mud_move', args: { direction: 'north' }, tier: 'observe' })).toBe('deny')
  })

  it('登录流程豁免: 未登录时的登录命令按 system 处理 (只读档也能登录)', () => {
    expect(verdict({ name: 'mud_send', args: { cmd: '{name}' }, tier: 'observe', loginFlow: true })).toBe('allow')
    expect(verdict({ name: 'mud_send', args: { cmd: '{pass}' }, tier: 'observe', loginFlow: true })).toBe('allow')
    expect(verdict({ name: 'mud_send', args: { cmd: 'y' }, tier: 'observe', loginFlow: true })).toBe('allow')
    // 已登录: 同样的命令不再是登录流程 → 只读档拒绝。
    expect(verdict({ name: 'mud_send', args: { cmd: '{pass}' }, tier: 'observe', loginFlow: false })).toBe('deny')
  })

  it('登录流程不豁免危险命令 (登录中也不许叫杀/删号)', () => {
    expect(verdict({ name: 'mud_send', args: { cmd: 'suicide' }, tier: 'operate', loginFlow: true })).toBe('deny')
    expect(verdict({ name: 'mud_send', args: { cmd: 'kill dog' }, tier: 'operate', loginFlow: true })).toBe('ask')
  })

  it('读写档: 普通命令放行; 危险表 deny/ask 生效', () => {
    expect(verdict({ name: 'mud_send', args: { cmd: 'look' }, tier: 'operate' })).toBe('allow')
    expect(verdict({ name: 'mud_send', args: { cmd: 'ask zhang about 拜师' }, tier: 'operate' })).toBe('allow')
    expect(verdict({ name: 'mud_send', args: { cmd: 'suicide' }, tier: 'operate' })).toBe('deny')
    expect(verdict({ name: 'mud_send', args: { cmd: 'passwd' }, tier: 'operate' })).toBe('deny')
    expect(verdict({ name: 'mud_send', args: { cmd: 'drop sword' }, tier: 'operate' })).toBe('ask')
    expect(verdict({ name: 'mud_send', args: { cmd: 'quit' }, tier: 'operate' })).toBe('ask')
    expect(verdict({ name: 'mud_move', args: { direction: 'north' }, tier: 'operate' })).toBe('allow')
  })

  it('命令序列逐条判定 (任一条命中危险表即拦截)', () => {
    expect(verdict({ name: 'mud_send', args: { cmds: ['look', 'drop all'] }, tier: 'operate' })).toBe('ask')
    expect(verdict({ name: 'mud_send', args: { cmds: ['look', 'i'] }, tier: 'operate' })).toBe('allow')
    // 序列里带危险命令时, 只读档仍先按危险表 (deny 优先于只读的 deny)。
    expect(verdict({ name: 'mud_send', args: { cmds: ['suicide'] }, tier: 'observe', loginFlow: true })).toBe('deny')
  })

  it('完全档: 触发器组工具放行, 只读/读写档不提供', () => {
    expect(verdict({ name: 'mud_flow_disable', args: { group: 'g' }, tier: 'full' })).toBe('allow')
    expect(verdict({ name: 'mud_flow_disable', args: { group: 'g' }, tier: 'operate' })).toBe('deny')
  })

  it('自定义策略表可整体替换 (部署配置路径)', () => {
    expect(verdict({
      name: 'mud_send', args: { cmd: 'pray' }, tier: 'operate',
      rules: buildGateRules({ dangerous: [{ id: 'pray', commands: ['pray'], action: 'ask', reason: '自定义' }] }),
    })).toBe('ask')
    // 替换后原表的 suicide 不再拦 (配置即事实)。
    expect(verdict({
      name: 'mud_send', args: { cmd: 'suicide' }, tier: 'operate',
      rules: buildGateRules({ dangerous: [{ id: 'pray', commands: ['pray'], action: 'ask', reason: '自定义' }] }),
    })).toBe('allow')
  })
})

describe('命令提取 (commandsOfToolCall)', () => {
  /** 注入缺省命令派生器 (buildGateRules 从 world/game 组装)。 */
  const commands = buildGateRules().commands

  it('mud_send / 序列', () => {
    expect(commandsOfToolCall('mud_send', { cmd: ' look ' }, commands)).toEqual([' look '])
    expect(commandsOfToolCall('mud_send', { cmds: ['a', 1, 'b'] }, commands)).toEqual(['a', 'b'])
    expect(commandsOfToolCall('mud_send', {}, commands)).toEqual([])
  })

  it('语义工具 → 实际会发的命令', () => {
    expect(commandsOfToolCall('mud_move', { direction: 'n' }, commands)).toEqual(['north'])
    // 工具自身会把方向归一成小写全名 (见 tools.ts), 判定层保持同一口径。
    expect(commandsOfToolCall('mud_move', { direction: 'NORTH' }, commands)).toEqual(['north'])
    expect(commandsOfToolCall('mud_move', { direction: 'xyz' }, commands)).toEqual(['xyz'])
    expect(commandsOfToolCall('mud_look', {}, commands)).toEqual(['look'])
    expect(commandsOfToolCall('mud_look', { target: ' paizi ' }, commands)).toEqual(['look paizi'])
    expect(commandsOfToolCall('mud_status', { what: 'inventory' }, commands)).toEqual(['i'])
    expect(commandsOfToolCall('mud_status', { what: 'xyz' }, commands)).toEqual(['xyz'])
    expect(commandsOfToolCall('mud_state', {}, commands)).toEqual([])
  })

  it('未注册的工具名派生为空 (判定层不发明语义)', () => {
    expect(commandsOfToolCall('read_file', { path: 'x' }, commands)).toEqual([])
  })
})

describe('闸门装配 (tools/pre-execute)', () => {
  /** 极简 ctx: 只捕获 waterfall 监听者。 */
  function fakeAgentCtx(): { ctx: Context; listener: () => unknown; off: () => void } {
    let captured: ((exec: unknown, next: () => Promise<PreToolDecision>) => unknown) | null = null
    const off = vi.fn()
    const ctx = {
      on: (name: string, listener: unknown) => {
        expect(name).toBe('tools/pre-execute')
        captured = listener as typeof captured
        return off
      },
    } as unknown as Context
    return {
      ctx,
      listener: () => {
        if (captured === null) throw new Error('未注册 tools/pre-execute 监听者')
        return captured
      },
      off,
    }
  }

  function gate(opts: {
    tier: 'observe' | 'operate' | 'full'
    loginFlow?: boolean
    logs?: string[]
    toolCallIntervalMs?: number
    /** 本回合通道（限速按通道豁免；`t1` = 规则反射/流程步动作）。 */
    lane?: 't1' | 't2'
  }) {
    const fake = fakeAgentCtx()
    installMudToolGate(fake.ctx, {
      sessionId: 's1',
      mudTools: MUD_TOOLS,
      tier: () => opts.tier,
      rules: buildGateRules(),
      loginFlow: () => opts.loginFlow ?? false,
      loginCommands: LOGIN_COMMANDS,
      ...(opts.lane === undefined ? {} : { currentLane: () => opts.lane }),
      ...(opts.toolCallIntervalMs === undefined ? {} : { toolCallIntervalMs: opts.toolCallIntervalMs }),
      log: (t) => opts.logs?.push(t),
    })
    const call = async (name: string, args: unknown): Promise<{ decision: PreToolDecision; nexted: boolean }> => {
      let nexted = false
      const next = async (): Promise<PreToolDecision> => { nexted = true; return { kind: 'allow' } }
      const listener = fake.listener() as (exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
      const decision = await listener({ name, arguments: args }, next)
      return { decision, nexted }
    }
    return { call, off: fake.off }
  }

  it('非 MUD 工具必须委托 next() (否则会劫持其他插件的工具)', async () => {
    const { call } = gate({ tier: 'observe' })
    const { decision, nexted } = await call('read_file', { path: 'x' })
    expect(decision).toEqual({ kind: 'allow' })
    expect(nexted).toBe(true)
  })

  it('放行的 MUD 工具同样委托 next(); 拒绝/待批准则不委托', async () => {
    const logs: string[] = []
    const { call } = gate({ tier: 'operate', logs })
    expect((await call('mud_send', { cmd: 'look' })).nexted).toBe(true)

    const denied = await call('mud_send', { cmd: 'suicide' })
    expect(denied.decision.kind).toBe('deny')
    expect(denied.nexted).toBe(false)
    expect(logs.join('\n')).toContain('[权限] mud_send → 拒绝')

    const asked = await call('mud_send', { cmd: 'drop all' })
    expect(asked.decision.kind).toBe('ask')
    expect(asked.nexted).toBe(false)
    expect(logs.join('\n')).toContain('[权限] mud_send → 待批准')
  })

  it('档位在调用时求值 (切换后立即生效, 无需重装闸门)', async () => {
    let tier: 'observe' | 'operate' = 'observe'
    const fake = fakeAgentCtx()
    installMudToolGate(fake.ctx, {
      sessionId: 's1',
      mudTools: MUD_TOOLS,
      tier: () => tier,
      rules: buildGateRules(),
      loginFlow: () => false,
      loginCommands: LOGIN_COMMANDS,
    })
    const listener = fake.listener() as (exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
    const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })
    expect((await listener({ name: 'mud_send', arguments: { cmd: 'look' } }, next)).kind).toBe('deny')
    tier = 'operate'
    expect((await listener({ name: 'mud_send', arguments: { cmd: 'look' } }, next)).kind).toBe('allow')
  })

  it('限速: 相邻 agent 工具调用按 toolCallIntervalMs 等待 (实测"服务器反应不过来")', async () => {
    const { call } = gate({ tier: 'operate', toolCallIntervalMs: 60 })

    const first = Date.now()
    expect((await call('mud_send', { cmd: 'look' })).decision.kind).toBe('allow')
    const afterFirst = Date.now()
    expect(afterFirst - first).toBeLessThan(40)              // 首次不限速

    expect((await call('mud_send', { cmd: 'inventory' })).decision.kind).toBe('allow')
    expect(Date.now() - afterFirst).toBeGreaterThanOrEqual(50) // 第二次等满窗口
  })

  it('限速豁免: 登录流程 (actor system) 与非 MUD 工具都不等', async () => {
    const { call } = gate({ tier: 'operate', loginFlow: true, toolCallIntervalMs: 80 })

    // 登录命令: 连发两次都不等待。
    const t0 = Date.now()
    await call('mud_send', { cmd: '{name}' })
    await call('mud_send', { cmd: '{pass}' })
    expect(Date.now() - t0).toBeLessThan(60)

    // 非 MUD 工具: 与本插件无关, 永不被限速。
    const t1 = Date.now()
    await call('read_file', { path: 'a' })
    await call('read_file', { path: 'b' })
    expect(Date.now() - t1).toBeLessThan(60)
  })

  /**
   * 作者定案 (2026-09-13)：限速**按通道**豁免，而不是按登录态。
   *
   * 登录完成后 `loginFlow()` 就是 false 了；若只按它豁免，T1 的规则动作与流程步动作
   * （例如 fullme 的答案）会被无谓地推迟 1 秒。所以 `currentLane() === 't1'` 一律不等。
   */
  it('限速豁免: T1 通道 (lane=t1) 即使已登录也不等; T2 通道照常等', async () => {
    const t1 = gate({ tier: 'operate', lane: 't1', toolCallIntervalMs: 80 })
    const start = Date.now()
    await t1.call('mud_send', { cmd: 'halt' })          // T1 动作 (非登录命令)
    await t1.call('mud_send', { cmd: 'fullme 1234' })
    expect(Date.now() - start).toBeLessThan(60)

    const t2 = gate({ tier: 'operate', lane: 't2', toolCallIntervalMs: 80 })
    await t2.call('mud_send', { cmd: 'look' })
    const afterFirst = Date.now()
    await t2.call('mud_send', { cmd: 'hp' })
    expect(Date.now() - afterFirst).toBeGreaterThanOrEqual(70)   // T2 仍然限速
  })
})

describe('档位服务 (registerMudCapability)', () => {
  /** 假依赖: 会话注册表 + 投影注册表 (记录 register/append 调用)。 */
  function makeCapability(options: { withServices: boolean }) {
    const appended: { type: string; data: unknown }[] = []
    let projected: { tier: string | null } | undefined
    const session = {
      id: 's1',
      append: (type: string, data: unknown) => {
        appended.push({ type, data })
        projected = applyCapabilityEvent(projected ?? { tier: null }, { type, data })
      },
    }
    const registered: unknown[] = []
    const capCtx = {
      sessions: { get: (id: string) => (id === 's1' ? session : undefined) },
      sessionProjections: {
        register: (definition: unknown) => { registered.push(definition) },
        stateOf: () => projected,
      },
    }
    const ctx = {
      inject: (_deps: string[], cb: (c: unknown) => unknown) => {
        if (options.withServices) cb(capCtx)
        return () => {}
      },
    } as unknown as Context
    const api: MudCapabilityApi = registerMudCapability(ctx, { defaultTier: 'operate' })
    return { api, appended, registered, setProjected: (v: { tier: string | null }) => { projected = v } }
  }

  it('缺省档位与设置/通知', () => {
    const { api } = makeCapability({ withServices: true })
    expect(api.defaultTier).toBe('operate')
    expect(api.names).toEqual(['observe', 'operate', 'full'])
    const seen: string[] = []
    api.onChange((sessionId, tier) => seen.push(`${sessionId}:${tier}`))
    expect(api.current('s1')).toBe('operate')
    expect(api.set('s1', 'full')).toBe('full')
    expect(api.current('s1')).toBe('full')
    // 同档重复设置不通知。
    expect(api.set('s1', 'full')).toBe('full')
    expect(seen).toEqual(['s1:full'])
    expect(() => api.set('s1', 'nope')).toThrow(/unknown tier/)
    expect(api.capabilities('full')).toContain('captcha:refresh')
  })

  it('设置写会话事件 (log-only), 投影读到记录值', () => {
    const { api, appended } = makeCapability({ withServices: true })
    api.set('s1', 'observe')
    expect(appended).toEqual([{ type: 'mud/capability', data: { tier: 'observe' } }])
    // 新实例 (模拟重启后 resume): 进程内记忆为空, 由投影/日志重建。
    const resumed = makeCapability({ withServices: true })
    resumed.setProjected({ tier: 'observe' })
    expect(resumed.api.current('s1')).toBe('observe')
  })

  it('ensure 落一次缺省档位; 已有记录时不重复写', () => {
    const { api, appended } = makeCapability({ withServices: true })
    expect(api.ensure('s1')).toBe('operate')
    expect(api.ensure('s1')).toBe('operate')
    expect(appended.filter(e => e.type === 'mud/capability')).toHaveLength(1)
  })

  it('投影服务缺失 → 进程内记忆兜底 (不抛出)', () => {
    const { api } = makeCapability({ withServices: false })
    expect(api.current('s1')).toBe('operate')
    expect(api.set('s1', 'observe')).toBe('observe')
    expect(api.current('s1')).toBe('observe')
    expect(api.ensure('s1')).toBe('observe')
  })

  it('forget 清进程内记忆 (W11.1① purge 残留): 回落缺省 / 投影不动 / 其余会话不受影响', () => {
    const { api } = makeCapability({ withServices: true })
    // s1: 注册会话 — live + 投影都有记录; s2: 未注册会话 — 仅 live (purge 要清的残留面)。
    api.set('s1', 'observe')
    api.set('s2', 'full')
    expect(api.current('s1')).toBe('observe')
    expect(api.current('s2')).toBe('full')
    // 注销 s2: live 残留清除 → 回落缺省 (W11.1①: 旧实现无 forget, 此处即会红)。
    api.forget('s2')
    expect(api.current('s2')).toBe('operate')
    // s1 条目不受波及; 且 live 清除后投影持久事实 (§10) 仍然生效。
    api.forget('s1')
    expect(api.current('s1')).toBe('observe')
    // 幂等: 重复 forget 空操作。
    api.forget('s2')
    expect(api.current('s2')).toBe('operate')
  })

  it('投影注册声明: 状态校验与折叠只认本单元事件', () => {
    const { registered } = makeCapability({ withServices: true })
    expect(registered).toHaveLength(1)
    const def = registered[0] as {
      key: string
      stateVersion: number
      init: () => { tier: string | null }
      apply: (s: { tier: string | null }, e: { type: string; data?: unknown }) => { tier: string | null }
    }
    expect(def.key).toBe('mudCapabilities')
    expect(def.stateVersion).toBe(1)
    expect(def.init()).toEqual({ tier: null })
    const before = { tier: 'operate' }
    expect(def.apply(before, { type: 'tool/call', data: {} })).toBe(before)
    expect(def.apply(before, { type: 'mud/capability', data: { tier: 'full' } })).toEqual({ tier: 'full' })
    expect(def.apply(before, { type: 'mud/capability', data: {} })).toEqual({ tier: null })
  })

  it('持久化状态校验: 结构非法即抛出 (官方在折叠前调用)', () => {
    expect(parseCapabilityState({ tier: 'observe' })).toEqual({ tier: 'observe' })
    expect(parseCapabilityState({ tier: null })).toEqual({ tier: null })
    expect(() => parseCapabilityState(null)).toThrow(/object/)
    expect(() => parseCapabilityState({ tier: 3 })).toThrow(/string or null/)
  })
})
