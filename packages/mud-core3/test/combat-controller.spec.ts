import { describe, expect, it } from 'vitest'
import { CombatController, COMBAT_ENDING_RES } from '../src/combat/controller.ts'
import { CombatEdgeDetector } from '../src/combat/state.ts'
import { CombatRuleEngine } from '../src/combat/rules.ts'
import { CombatReporter } from '../src/combat/report.ts'
import type { ReadOpts, ReadResult } from '../src/read.ts'
import type { WorldEntry } from '../src/world.ts'

const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (f()) return
    await tick(1)
  }
  expect(f()).toBe(true)
}

/** 控制器测试环境：假 IO（脚本化 read 结果，无脚本 = 挂起）+ 可变世界状态。 */
function makeEnv(opts: {
  world?: Record<string, Record<string, unknown>>
  occupiedBy?: string
  retreatMove?: string
} = {}) {
  const zones = new Map<string, Map<string, { value: unknown }>>()
  for (const [z, kv] of Object.entries(opts.world ?? {})) {
    zones.set(z, new Map(Object.entries(kv).map(([k, v]) => [k, { value: v }])))
  }
  const deleted: string[] = []
  const writes: Array<[string, unknown]> = []
  const logs: string[] = []
  const reporter = new CombatReporter({
    write: (key, value) => { writes.push([key, value]) },
    log: text => { logs.push(text) },
  })
  const io = {
    connected: true,
    sent: [] as string[],
    holder: null as string | null,
    reads: [] as ReadOpts[],
    scripted: [] as ReadResult[],
    aborts: [] as (unknown | undefined)[],
    send(cmd: string) { io.sent.push(cmd); return true },
    acquireSend(h: string) { if (io.holder !== null && io.holder !== h) return false; io.holder = h; return true },
    releaseSend(h: string) { if (io.holder === h) io.holder = null },
    stealSend(h: string) { io.holder = h },
    abortWait(line?: unknown) { io.aborts.push(line) },
    async read(o: ReadOpts) {
      io.reads.push(o)
      const next = io.scripted.shift()
      return next ?? new Promise<ReadResult>(() => { /* 长读窗在途（挂起） */ })
    },
  }
  if (opts.occupiedBy !== undefined) io.holder = opts.occupiedBy
  const controller = new CombatController({
    io,
    world: {
      get: (z, k) => zones.get(z)?.get(k) as WorldEntry | undefined,
      delete: (z, k) => { deleted.push(`${z}#${k}`); return zones.get(z)?.delete(k) ?? false },
    },
    engine: new CombatRuleEngine(opts.retreatMove === undefined ? {} : { retreatMove: opts.retreatMove }),
    detector: new CombatEdgeDetector(),
    reporter,
    window: { pendingRetryMs: 5 },
  })
  return {
    controller, io, reporter, writes, logs, deleted,
    setW: (zone: string, key: string, value: unknown) => {
      let m = zones.get(zone)
      if (m === undefined) { m = new Map(); zones.set(zone, m) }
      m.set(key, { value })
    },
  }
}

describe('CombatController（T21.4 行流接管）', () => {
  it('W3 遭遇开始接管：目标写入 → acquireSend("combat") 成功进入 held，开长读窗', async () => {
    const e = makeEnv()
    e.setW('combat', '目标', '大狼狗')
    e.controller.onWorldChange()
    expect(e.io.holder).toBe('combat')
    expect(e.controller.currentPhase).toBe('held')
    await until(() => e.io.reads.length === 1)
    expect(e.io.reads[0]?.until).toBe(COMBAT_ENDING_RES)
    expect(e.io.reads[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('W3 被占 → pending + 保命直发；在途释放后重试接管转 held', async () => {
    const e = makeEnv({ occupiedBy: 'agent-1', world: { vitals: { 气血: 40, 最大气血: 100 } } })
    e.setW('combat', '目标', '大狼狗')
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('pending')
    expect(e.io.holder).toBe('agent-1')
    expect(e.io.sent).toContain('yun heal') // 保命直发（危险规则集，不等锁）
    // 在途收束（holder 释放）→ 状态事件触发重试接管
    e.io.holder = null
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('held')
    expect(e.io.holder).toBe('combat')
  })

  it('W3 pending 期间无人触发状态事件也能经重试定时器接管', async () => {
    const e = makeEnv({ occupiedBy: 'agent-1' })
    e.setW('combat', '目标', '大狼狗')
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('pending')
    e.io.holder = null
    await until(() => e.controller.currentPhase === 'held')
    expect(e.io.holder).toBe('combat')
  })

  it('规则命中直发：气血跨变 73%→13% → 运气回血；未跨档不发', async () => {
    const e = makeEnv({ world: { vitals: { 气血: 73, 最大气血: 100 } } })
    e.setW('combat', '战斗中', true)
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('held')
    expect(e.io.sent).toEqual([]) // 健康→健康 未跨档不发
    e.setW('vitals', '气血', 13)
    e.controller.onWorldChange()
    expect(e.io.sent).toEqual(['yun heal'])
    expect(e.writes.some(([k, v]) => k === '干预' && v === 1)).toBe(true)
  })

  it('结局行收束释放：until 命中 → 释放 + 清目标/敌人数 + 结算日志', async () => {
    const e = makeEnv({ world: { combat: { 目标: '大狼狗', 敌人数: 1 } } })
    e.io.scripted.push({
      lines: [], reason: 'done',
      hit: { by: 'until', index: 0, groups: [] },
    })
    e.controller.onWorldChange()
    await until(() => e.controller.currentPhase === 'idle')
    expect(e.io.holder).toBeNull()
    expect(e.deleted).toContain('combat#目标')
    expect(e.deleted).toContain('combat#敌人数')
    expect(e.logs.some(l => l.includes('结局行'))).toBe(true)
  })

  it('脱战释放：combat.战斗中 true→false → 释放（无需结局行）', async () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('held')
    e.setW('combat', '战斗中', false)
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.holder).toBeNull()
    expect(e.logs.some(l => l.includes('脱战'))).toBe(true)
  })

  it('W10 断线复位：release + reset + interrupted 记账', async () => {
    const e = makeEnv({ world: { combat: { 目标: '大狼狗' } } })
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('held')
    e.controller.onDisconnected()
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.holder).toBeNull()
    expect(e.logs.some(l => l.includes('interrupted'))).toBe(true)
  })

  it('W11 静默兜底：连续无行收束（quiet 且零行）达上限 → 释放不悬挂', async () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    e.io.scripted.push({ lines: [], reason: 'quiet', hit: undefined })
    e.io.scripted.push({ lines: [], reason: 'quiet', hit: undefined })
    e.controller.onWorldChange()
    await until(() => e.controller.currentPhase === 'idle')
    expect(e.io.holder).toBeNull()
    expect(e.logs.some(l => l.includes('静默兜底'))).toBe(true)
  })

  it('静默兜底未达上限：有行收束即重开读窗，继续持有', async () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    e.io.scripted.push({
      lines: [{ abs: 1, text: '你一爪拍在大狼狗身上。', raw: '你一爪拍在大狼狗身上。', style: [], isPrompt: false, kind: null, time: 0 }],
      reason: 'done', hit: undefined,
    })
    e.controller.onWorldChange()
    await until(() => e.io.reads.length === 2)
    expect(e.controller.currentPhase).toBe('held')
  })

  it('W12 只响应不发起：无遭遇状态事件不动（不 send 不 acquire）', () => {
    const e = makeEnv({ world: { vitals: { 气血: 13, 最大气血: 100 } } })
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.holder).toBeNull()
    expect(e.io.sent).toEqual([])
    expect(e.io.reads).toEqual([])
  })

  it('有退路时保命直发含 halt+move（pending 路径）', () => {
    const e = makeEnv({
      occupiedBy: 'agent-1',
      retreatMove: 'east',
      world: { vitals: { 气血: 13, 最大气血: 100 } },
    })
    e.setW('combat', '目标', '大狼狗')
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('pending')
    expect(e.io.sent).toEqual(['halt', 'east'])
  })
})

describe('危险抢占通道（T21.5 W6）', () => {
  const mkLine = (text: string) => ({ abs: 1, text, raw: text, style: [], isPrompt: false, kind: null, time: 0 })

  it('① 文本判定：敌意行命中 → 进入危险态并接管（不等锁 steal + abortWait）', () => {
    const e = makeEnv({ occupiedBy: 'agent-1' })
    e.controller.onThreatLine(mkLine('看起来大狼狗想杀死你！') as never)
    expect(e.controller.inDanger).toBe(true)
    expect(e.controller.currentPhase).toBe('held')
    expect(e.io.holder).toBe('combat')
    expect(e.io.aborts).toHaveLength(1)
    expect(JSON.stringify(e.io.aborts[0])).toContain('想杀死你')
    expect(e.logs.some(l => l.includes('危险抢占'))).toBe(true)
  })

  it('① 我方开战行同样命中；危险态中重复威胁行不重复抢占', () => {
    const e = makeEnv()
    e.controller.onThreatLine(mkLine('你大喝一声，开始对大狼狗发动攻击！') as never)
    expect(e.controller.inDanger).toBe(true)
    e.controller.onThreatLine(mkLine('看起来大狼狗想杀死你！') as never)
    expect(e.io.aborts).toHaveLength(1)
  })

  it('① 非威胁行不触发', () => {
    const e = makeEnv()
    e.controller.onThreatLine(mkLine('你一爪拍在大狼狗身上。') as never)
    expect(e.controller.inDanger).toBe(false)
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.aborts).toHaveLength(0)
  })

  it('② 状态判定：危险档跨变（健康→危险）→ 进入危险态 + abort + 危险规则直发', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' }, vitals: { 气血: 73, 最大气血: 100 } } })
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(false)
    e.setW('vitals', '气血', 13)
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(true)
    expect(e.io.aborts).toHaveLength(1)
    expect(e.io.aborts[0]).toBeUndefined()
    expect(e.io.sent).toContain('yun heal')
  })

  it('危险态规则集切换：内力充沛不发 jiali；回升跨变解除后恢复常态规则集', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' }, vitals: { 气血: 73, 最大气血: 100, 内力: 150, 最大内力: 100 } } })
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(false)
    expect(e.io.sent).toContain('jiali max') // 常态规则集
    e.setW('vitals', '气血', 13)
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(true)
    expect(e.io.sent).not.toContain('jiali 0') // 危险态只有保命动作
    e.setW('vitals', '气血', 40) // 危险→五成：回升跨变
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(false)
    expect(e.logs.some(l => l.includes('危险态解除'))).toBe(true)
  })

  it('回升退出需要跨变：濒危→危险仍在危险档内，不解除', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' }, vitals: { 气血: 5, 最大气血: 100 } } })
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(true)
    e.setW('vitals', '气血', 13)
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(true)
  })

  it('结局/脱战/断线退出危险态并复位', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' }, vitals: { 气血: 13, 最大气血: 100 } } })
    e.controller.onWorldChange()
    expect(e.controller.inDanger).toBe(true)
    e.controller.onDisconnected()
    expect(e.controller.inDanger).toBe(false)
  })
})

describe('人打断总开关（T21.6 W7/W8）', () => {
  const mkLine = (text: string) => ({ abs: 1, text, raw: text, style: [], isPrompt: false, kind: null, time: 0 })

  it('缺省开启；关闭 → held 立即释放（interrupted 记账 + releaseSend + 复位）', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    expect(e.controller.combatAuto).toBe(true)
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('held')
    e.controller.setCombatAuto(false)
    expect(e.controller.combatAuto).toBe(false)
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.holder).toBeNull()
    expect(e.deleted).toContain('combat#目标')
    expect(e.logs.some(l => l.includes('interrupted'))).toBe(true)
  })

  it('关闭后不接管、不开窗、危险通道也不动作（W7 人打断 > 危险 > 交战）', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    e.controller.setCombatAuto(false)
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('idle')
    e.controller.onThreatLine(mkLine('看起来大狼狗想杀死你！') as never)
    expect(e.controller.inDanger).toBe(false)
    expect(e.io.aborts).toHaveLength(0)
    expect(e.io.sent).toEqual([])
  })

  it('恢复不追补当前场：战斗中仍为真时不接管；本场消解后新遭遇照常接管', () => {
    const e = makeEnv({ world: { combat: { 战斗中: true, 目标: '大狼狗' } } })
    e.controller.onWorldChange()
    e.controller.setCombatAuto(false)
    e.controller.setCombatAuto(true)
    e.controller.onWorldChange() // 战斗中仍为真 —— 不追补当前场
    expect(e.controller.currentPhase).toBe('idle')
    e.setW('combat', '战斗中', false)
    e.controller.onWorldChange() // 本场消解，闩解除
    e.setW('combat', '战斗中', true)
    e.controller.onWorldChange() // 新遭遇
    expect(e.controller.currentPhase).toBe('held')
    expect(e.io.holder).toBe('combat')
  })

  it('pending 阶段关闭同样立即释放；idle 期间开关往返零动作', () => {
    const e = makeEnv({ occupiedBy: 'agent-1' })
    e.setW('combat', '目标', '大狼狗')
    e.controller.onWorldChange()
    expect(e.controller.currentPhase).toBe('pending')
    e.controller.setCombatAuto(false)
    expect(e.controller.currentPhase).toBe('idle')
    const sentBefore = e.io.sent.length
    e.controller.setCombatAuto(true)
    e.controller.setCombatAuto(false)
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.sent.length).toBe(sentBefore) // 零动作（note 审计日志不算动作）
  })
})

