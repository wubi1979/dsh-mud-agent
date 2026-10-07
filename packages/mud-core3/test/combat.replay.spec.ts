import { describe, expect, it } from 'vitest'
import { CombatController, COMBAT_ENDING_RES } from '../src/combat/controller.ts'
import { CombatEdgeDetector } from '../src/combat/state.ts'
import { CombatRuleEngine } from '../src/combat/rules.ts'
import { CombatReporter } from '../src/combat/report.ts'
import { StateTracker } from '../src/tracker.ts'
import { World } from '../src/world.ts'
import type { MudLine } from '../src/link/line.ts'
import type { ReadOpts, ReadResult } from '../src/read.ts'

/**
 * A.8 实录回放（T21.7，D15/W1–W12 端到端；纯层，不需真连游戏）。
 *
 * 语料 = doc/appendices/A-capture-facts.md A.8（2026-10-06 pkuxkx 实机：夫差 对 大狼狗）：
 *   - 开场：我方开战行 + 敌意确立行（A.8.1 断面一）；
 *   - 拍：受击戳（攻击行 + 结果行 + 戳尾『夫差(...)』+ hpbrief 三行，A.8.1 断面二）
 *     与未受击拍（无戳无 hpbrief，A.8.1 断面三）；
 *   - 账目：受击戳 11 条、上限恒 313、最大 283→253→223→193（4 次 wound:+30）、
 *     当前 281→-1、敌方单次 +32、内力/精力全程满（A.8.2 结论 3/A.8.6）；
 *   - 结局：`你的眼前一黑，接著什么也不知道了....`（A.8.1 断面三）；
 *     -1 后仍被攻击一拍（A.8.4：气血 <= 0 不是死亡判据）。
 * 中间拍数值按 A.8.2/A.8.6 账目重建（戳尾伤情描述语按 A.8.4 出现序）。
 *
 * 接线镜像 service.register（T21.5/T21.4 生产装配）：行路径 = onThreatLine（判定点①）
 * → tracker.observe（判据解析写 World → onWorldChange）；reporter 计数写入
 * （writeCombatWorld）与释放清键（deleteWorld）同样触发 onWorldChange。
 * 断言：命中序列 + 未跨档不发 + 占拍节流 + 接管与释放 + 危险抢占收束 + interrupted 记账。
 * 注：2026-10-07 裁定①（文本判定点命中即进入危险态并接管）⇒ 本场开战行即入危险态、
 * 整场危险规则集（flee/heal）——常态规则集（jiali/medicine）整场被抑制是裁定的字面
 * 后果，回放如实断言；占拍节流（medicine 被 heal 抑制）在常态规则集语义下由
 * combat-rules/combat-controller 规格覆盖（W2），实录本场不出现。
 */

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

/** 一拍受击戳（A.8.1 断面二形状）：攻击/结果行 + 戳尾 + hpbrief 三行。 */
function hitBeat(upper: number, max: number, cur: number, wound: boolean, tail: string): string[] {
  const pct = (a: number, b: number): number => Math.floor((a / b) * 100)
  const stamp = wound
    ? `( ${tail})『夫差(damage:+32 wound:+30 气血:${pct(cur, max)}%/${pct(max, upper)}%)』`
    : `( ${tail})『夫差(damage:+32 气血:${pct(Math.max(cur, 0), max)}%/${pct(max, upper)}%)』`
  return [
    '大狼狗扑上来张嘴往你的右腿狠狠地一咬！',
    '结果造成一处咬伤！',
    stamp,
    '#56074,20223,325,325,311,311',
    `#${upper},${max},${cur},257,257,257`,
    '#0,80,384,378,1,0',
  ]
}

/** 回放环境：真实 World + 真实 tracker + 战斗控制器；接线镜像 service.register。 */
function makeReplay() {
  const world = new World()
  const logs: string[] = []
  let controller: CombatController

  // 假 IO：行队列 + 挂起读窗（无行即挂起，abortWait 以 danger 收束并收编触发行）。
  const queue: MudLine[] = []
  let pendingRead: ((r: ReadResult) => void) | null = null
  const take = (o: ReadOpts): ReadResult => {
    const taken = queue.splice(0)
    const idx = taken.findIndex(l => (o.until ?? []).some(re => re.test(l.text)))
    if (idx >= 0) {
      return { lines: taken.slice(0, idx + 1), reason: 'done', hit: { by: 'until', index: idx, groups: [] } }
    }
    return { lines: taken, reason: 'done', hit: undefined }
  }
  const io = {
    connected: true,
    sent: [] as string[],
    holder: null as string | null,
    reads: [] as ReadOpts[],
    aborts: [] as (MudLine | undefined)[],
    send(cmd: string) { io.sent.push(cmd); return true },
    acquireSend(h: string) { if (io.holder !== null && io.holder !== h) return false; io.holder = h; return true },
    releaseSend(h: string) { if (io.holder === h) io.holder = null },
    stealSend(h: string) { io.holder = h },
    abortWait(line?: MudLine) {
      io.aborts.push(line)
      const resolve = pendingRead
      pendingRead = null
      resolve?.({ lines: line ? [line] : [], reason: 'danger', hit: undefined })
    },
    async read(o: ReadOpts) {
      io.reads.push(o)
      if (queue.length > 0) return take(o)
      return new Promise<ReadResult>(resolve => { pendingRead = resolve })
    },
  }

  // 广播面（镜像 rt.writeWorld/deleteWorld/writeCombatWorld：写后即广播）。
  const fire = (): void => { controller.onWorldChange() }
  const tracker = new StateTracker({
    onWrite: (zone, key, value) => { world.set(zone, key, value, 'measured', { kind: 'track', time: 0 }); fire() },
    onDelete: (zone, key) => { if (world.delete(zone, key)) fire() },
  })
  controller = new CombatController({
    io,
    world: {
      get: (z, k) => world.get(z, k),
      delete: (z, k) => { const ok = world.delete(z, k); if (ok) fire(); return ok },
    },
    engine: new CombatRuleEngine(), // 未注入退路：撤离规则不启用（D14，实录本场未配置）
    detector: new CombatEdgeDetector(),
    reporter: new CombatReporter({
      write: (key, value) => { world.set('combat', key, value, 'measured', { kind: 'combat', time: 0 }); fire() },
      log: text => { logs.push(text) },
    }),
    window: { pendingRetryMs: 5 },
  })

  let abs = 0
  /** 行到达（镜像 runtime 行路径序）：入队（读窗在途累积）→ 判定点① → tracker 观察。 */
  const feed = (...lines: string[]): void => {
    for (const text of lines) {
      const line: MudLine = { abs: ++abs, text, raw: text, style: [], isPrompt: false, kind: null, time: 0 }
      queue.push(line)
      controller.onThreatLine(line)
      tracker.observe(line)
    }
    // 行到达推进在途读窗（镜像 readMachine.onLine 的累积判定收束）。
    const resolve = pendingRead
    if (resolve !== null && queue.length > 0) { pendingRead = null; resolve(take(io.reads[io.reads.length - 1] ?? {} as ReadOpts)) }
  }
  return { controller, io, world, logs, feed }
}

describe('A.8 实录回放（T21.7 D15）', () => {
  it('全场回放：开战危险抢占接管 → 11 拍受击戳命中序列 → 死亡结局行释放', async () => {
    const e = makeReplay()

    // ── 开场（A.8.1 断面一）────────────────────────────────────────
    e.feed(
      '你大喝一声，开始对大狼狗发动攻击！',
      '看起来大狼狗想杀死你！',
    )
    expect(e.controller.currentPhase).toBe('held')
    expect(e.controller.inDanger).toBe(true) // 裁定①：开战行命中即进入危险态并接管
    expect(e.io.holder).toBe('combat')
    expect(e.io.aborts).toHaveLength(1) // 危险抢占收束：abortWait(触发行)
    expect((e.io.aborts[0] as MudLine).text).toContain('发动攻击')
    expect(e.logs.some(l => l.includes('危险抢占'))).toBe(true)
    expect(e.logs.some(l => l.includes('未配置退路'))).toBe(true) // D14 告警一条
    expect(e.controller.suppressDelivery).toBe(true) // D4：接管期零投递（观测面）
    expect(e.io.reads[0]?.until).toBe(COMBAT_ENDING_RES)

    // ── 11 拍受击戳 + 一拍未受击（A.8.2/A.8.6 账目重建）────────────
    // 气血比全程：99%→98%→97%→96%（cap 受损跨变）→79%→63%→46%（五成跨变）
    // →29%（未跨档不发）→13%（危险跨变）→濒危（-1）→濒危（未跨档不发）→死亡。
    e.feed('你在攻击中不断积蓄攻势。(气势：4%)', ...hitBeat(313, 283, 281, true, '你受了几处伤，不过似乎并不碍事。'))
    e.feed('你在攻击中不断积蓄攻势。(气势：8%)', ...hitBeat(313, 253, 249, true, '你动作似乎开始有点不太灵光，但是仍然有条不紊。'))
    e.feed('你在攻击中不断积蓄攻势。(气势：12%)', ...hitBeat(313, 223, 217, true, '你气喘嘘嘘，看起来状况并不太好。'))
    e.feed('你在攻击中不断积蓄攻势。(气势：16%)', ...hitBeat(313, 193, 185, true, '你似乎十分疲惫，看来需要好好休息了。'))
    e.feed(...hitBeat(313, 193, 153, false, '你已经一副头重脚轻的模样，正在勉力支撑著不倒下去。'))
    // 未受击拍（A.8.1 断面三）：无戳行无 hpbrief，敌档行写入 combat.敌档。
    e.feed(
      '大狼狗扑上来张嘴往你的右肩狠狠地一咬！',
      '但是你身子一侧，闪了开去。',
      '你对准大狼狗的后脚用力挥出一拳！',
      '结果被它挡开了。',
      '结果只是轻轻地碰到，比拍苍蝇稍微重了点。',
      '( 大狼狗已经伤痕累累，正在勉力支撑著不倒下去。 )',
    )
    e.feed(...hitBeat(313, 193, 121, false, '你已经一副头重脚轻的模样，正在勉力支撑著不倒下去。'))
    e.feed(...hitBeat(313, 193, 89, false, '你看起来已经力不从心了。'))   // 五成跨变 → heal #1
    e.feed(...hitBeat(313, 193, 57, false, '你看起来已经力不从心了。'))   // 五成内：未跨档不发
    e.feed(...hitBeat(313, 193, 25, false, '你摇头晃脑、歪歪斜斜地站都站不稳，眼看就要倒在地上。')) // 危险跨变 → heal #2
    e.feed(...hitBeat(313, 193, -1, false, '你已经陷入半昏迷状态，随时都可能摔倒晕去。'))          // 濒危跨变 → heal #3
    // -1 后仍被攻击一拍（A.8.4），随后死亡行（A.8.1 断面三结局）。
    e.feed(...hitBeat(313, 193, -1, false, '你已经陷入半昏迷状态，随时都可能摔倒晕去。'))
    e.feed('你的眼前一黑，接著什么也不知道了....')

    // ── 命中序列（W2 回放面）：heal 只在三处 buffer 跨变拍；危险态整场 ⇒
    // 常态规则集（jiali/medicine/flee）零发出（裁定①字面后果）。
    expect(e.io.sent).toEqual(['yun heal', 'yun heal', 'yun heal'])

    // World 计数（kind='combat'，W9）：有跨变才算拍（D1）。
    expect(e.world.get('combat', '拍数')?.value).toBe(4) // cap 受损 + 五成 + 危险 + 濒危
    expect(e.world.get('combat', '干预')?.value).toBe(3)
    expect(e.world.get('combat', '规则命中')?.value).toBe(3)
    expect(e.world.get('combat', '最后动作')?.value).toBe('yun heal')
    expect(e.world.get('combat', '干预')?.source.kind).toBe('combat')

    // 状态面（tracker 判据，kind='track'）。
    expect(e.world.get('vitals', '气血')?.value).toBe(-1)
    expect(e.world.get('vitals', '气血')?.source.kind).toBe('track')
    expect(e.world.get('vitals', '最大气血')?.value).toBe(193)
    expect(e.world.get('vitals', '气血上限')?.value).toBe(313)
    expect(e.world.get('combat', '目标')?.value).toBe('大狼狗')
    expect(e.world.get('combat', '敌人数')?.value).toBe(1)
    expect(e.world.get('combat', '敌档')?.value).toBe('大狼狗已经伤痕累累，正在勉力支撑著不倒下去。')
    expect(e.world.get('combat', '气势')?.value).toBe(16)

    // ── 结局行释放（接管与释放）：until 命中 → 释放 + 清遭遇键 + 结算。
    await until(() => e.controller.currentPhase === 'idle')
    expect(e.io.holder).toBeNull()
    expect(e.controller.inDanger).toBe(false)
    expect(e.controller.suppressDelivery).toBe(false)
    expect(e.world.get('combat', '目标')).toBeUndefined()
    expect(e.world.get('combat', '敌人数')).toBeUndefined()
    expect(e.logs.some(l => l.includes('遭遇结束（结局行）'))).toBe(true)
  })

  it('中断回放：战斗中断线 → interrupted 记账 + 释放 + 危险态复位（W10）', async () => {
    const e = makeReplay()
    e.feed(
      '你大喝一声，开始对大狼狗发动攻击！',
      '看起来大狼狗想杀死你！',
      ...hitBeat(313, 283, 281, true, '你受了几处伤，不过似乎并不碍事。'),
    )
    expect(e.controller.currentPhase).toBe('held')
    e.controller.onDisconnected()
    expect(e.controller.currentPhase).toBe('idle')
    expect(e.io.holder).toBeNull()
    expect(e.controller.inDanger).toBe(false)
    expect(e.world.get('combat', '目标')).toBeUndefined()
    expect(e.logs.some(l => l.includes('interrupted'))).toBe(true)
  })
})
