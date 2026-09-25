/**
 * awareness/observe 单测 + 与 Mud 集成测试（impl §3.3 意识层入口）。
 *
 * 单测（假 deps，无 socket）：危险字段化意图逐项执行（halt/abortWait/onDanger）、
 * 反射吞触发行（返回 'swallow' + 直发）、行到达活动锚点、调度顺序。
 *
 * 集成（真 Mud + 假 server）：Awareness 注入 mud.onLine 后 —— 危险行让在途
 * read 以 reason:'danger' 收束且触发行收编进结果；反射行不进 read 结果、命令
 * 到达对端；世界状态随行流更新。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { MudLine } from '../../src/link/ansi.ts'
import { Mud } from '../../src/link/mud.ts'
import { Awareness, type AwarenessDeps } from '../../src/awareness/observe.ts'
import { World } from '../../src/awareness/world.ts'

let seq = 0
function mkLine(text: string, isPrompt = false): MudLine {
  seq += 1
  return { text, raw: text, style: [], abs: seq, time: 1000 + seq, isPrompt }
}

/** 假 deps：记录 send/abortWait/onDanger/onActivity 调用序。 */
function fakeDeps(world: World): AwarenessDeps & {
  sent: string[]
  aborted: MudLine[]
  dangers: string[]
  acts: number[]
} {
  const rec = { sent: [] as string[], aborted: [] as MudLine[], dangers: [] as string[], acts: [] as number[] }
  return {
    mud: {
      send(cmd: string) { rec.sent.push(cmd); return true },
      abortWait(line?: MudLine) { if (line) rec.aborted.push(line) },
    },
    world,
    onDanger: (hit) => { rec.dangers.push(hit.rule.why) },
    onActivity: () => { rec.acts.push(1) },
    ...rec,
  }
}

describe('observe 调度（假 deps）', () => {
  it('危险命中：interrupt → send(halt)，abortWait 收触发行，onDanger 上抛；行不吞', () => {
    const deps = fakeDeps(new World())
    const awareness = new Awareness(deps)
    const line = mkLine('不知哪里杀出一人向你袭来！')
    const verdict = awareness.observe(line)
    expect(verdict).toBeUndefined() // 危险行照常进模型面（无输出特例）
    expect(deps.sent).toEqual(['halt'])
    expect(deps.aborted).toEqual([line])
    expect(deps.dangers).toEqual(['遭攻击'])
  })

  it('wake=false 的危险规则: interrupt/abortWait 照常, onDanger 不上抛 (字段化意图门控)', () => {
    const deps = fakeDeps(new World())
    // 注入本地规则表（不动共享 DANGER）：免打扰/低置信刻度的形态。
    const awareness = new Awareness(deps, {
      danger: [{ re: /^演习对手$/, why: '演习（无需唤醒）', interrupt: true, abortWait: true }],
    })
    const verdict = awareness.observe(mkLine('演习对手'))
    expect(verdict).toBeUndefined()
    expect(deps.sent).toEqual(['halt'])
    expect(deps.aborted).toHaveLength(1)
    expect(deps.dangers).toEqual([])
  })

  it('latch:combat 门控: 首次命中发 halt, 战斗中再命中不重发 (abortWait 照常)', () => {
    const deps = fakeDeps(new World())
    const awareness = new Awareness(deps)
    const first = mkLine('不知哪里杀出一人向你袭来！')
    awareness.observe(first)
    expect(deps.sent).toEqual(['halt'])
    expect(deps.dangers).toEqual(['遭攻击'])
    // 战斗中第二回合再遭攻击：世界已记 inCombat=true（本行也再次置真）。
    awareness.observe(mkLine('对手再次向你攻来！'))
    expect(deps.sent).toEqual(['halt']) // 不重发
    expect(deps.dangers).toEqual(['遭攻击']) // 不重唤醒
    expect(deps.aborted).toHaveLength(2) // abortWait 不受 latch
    // 战斗结束解除 latch，下一次遭攻击重新边沿触发。
    awareness.observe(mkLine('战斗结束了。'))
    awareness.observe(mkLine('又有刺客向你袭来！'))
    expect(deps.sent).toEqual(['halt', 'halt'])
    expect(deps.dangers).toEqual(['遭攻击', '遭攻击'])
  })

  it('反射命中：直发命令并返回 swallow（吞触发行、留结果）', () => {
    const deps = fakeDeps(new World())
    const awareness = new Awareness(deps)
    expect(awareness.observe(mkLine('系统将在 3 分钟后存档，请及时存档。'))).toBe('swallow')
    expect(deps.sent).toEqual(['save'])
    expect(deps.aborted).toEqual([])
    expect(deps.dangers).toEqual([])
  })

  it('翻页行：空命令直发（裸换行）+ swallow', () => {
    const deps = fakeDeps(new World())
    const awareness = new Awareness(deps)
    expect(awareness.observe(mkLine('—— 按回车继续 ——'))).toBe('swallow')
    expect(deps.sent).toEqual([''])
  })

  it('普通行：不吞、无动作；世界状态仍被更新（永续供给）', () => {
    const world = new World()
    const deps = fakeDeps(world)
    const awareness = new Awareness(deps)
    expect(awareness.observe(mkLine('【气血】156/300'))).toBeUndefined()
    expect(deps.sent).toEqual([])
    expect(world.get('vitals', 'hp')?.value).toBe(156)
  })

  it('onActivity 每行触发（含被吞的反射行）', () => {
    const deps = fakeDeps(new World())
    const awareness = new Awareness(deps)
    awareness.observe(mkLine('第一行'))
    awareness.observe(mkLine('系统将在 3 分钟后存档，请及时存档。'))
    awareness.observe(mkLine('第三行'))
    expect(deps.acts).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------
// 集成：Awareness 注入 mud.onLine（真 Mud + 假 server）
// ---------------------------------------------------------------------

const IAC = 255
const GA = 249

interface TestServer {
  port: number
  write(data: string | Buffer): void
  close(): Promise<void>
}

async function setup(): Promise<{ mud: Mud, world: World, server: TestServer, sent: string[] }> {
  let sock: net.Socket | null = null
  const server = net.createServer((s) => { sock = s })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const mud = new Mud()
  const world = new World()
  const sent: string[] = []
  const origSend = mud.send.bind(mud)
  mud.send = (cmd: string) => { sent.push(cmd); return origSend(cmd) }
  const awareness = new Awareness({ mud, world })
  mud.onLine = line => awareness.observe(line)
  mud.connect('127.0.0.1', port)
  for (let i = 0; i < 100 && !mud.connected; i++) await new Promise(r => setTimeout(r, 10))
  expect(mud.connected).toBe(true)
  return {
    mud, world, sent,
    server: {
      port,
      write(data) {
        const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
        sock?.write(payload)
      },
      close() {
        sock?.destroy()
        return new Promise(resolve => server.close(() => resolve()))
      },
    },
  }
}

describe('observe × Mud 集成（impl §3.3 出口）', () => {
  it('危险行让在途 read 以 danger 收束, 触发行收编进结果, halt 直发, 世界记入战斗态', async () => {
    const { mud, world, sent, server } = await setup()
    const dangers: string[] = []
    const awareness = new Awareness({ mud, world, onDanger: hit => dangers.push(hit.rule.why) })
    mud.onLine = line => awareness.observe(line)
    const p = mud.read({ holder: 'root', until: [/永远不会出现/], timeoutMs: 5000 })
    server.write('你环顾四周。\n')
    await new Promise(r => setTimeout(r, 20))
    server.write('不知哪里杀出一人向你袭来！\r\n')
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['你环顾四周。', '不知哪里杀出一人向你袭来！'])
    expect(sent).toContain('halt')
    expect(dangers).toEqual(['遭攻击'])
    expect(world.inCombat).toBe(true)
    await server.close()
  })

  it('主动开战后的遭攻击命中 combat latch: read 照常被打断但不重发 halt (去重挂世界状态)', async () => {
    const { mud, world, sent, server } = await setup()
    const dangers: string[] = []
    const awareness = new Awareness({ mud, world, onDanger: hit => dangers.push(hit.rule.why) })
    mud.onLine = line => awareness.observe(line)
    const p = mud.read({ holder: 'root', until: [/永远不会出现/], timeoutMs: 5000 })
    server.write('你大喝一声，抢先出手！\n') // 主动开战帧 → inCombat=true
    await new Promise(r => setTimeout(r, 20))
    server.write('对手向你袭来！\r\n') // 战斗中再命中：abortWait 照常，interrupt/wake 被 latch
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['你大喝一声，抢先出手！', '对手向你袭来！'])
    expect(sent).toEqual([]) // 不重发 halt
    expect(dangers).toEqual([]) // 不重唤醒
    expect(world.inCombat).toBe(true)
    await server.close()
  })

  it('反射行吞触发行: 不进 read 结果, 命令到达对端; 应答行照常进', async () => {
    const { mud, sent, server } = await setup()
    const p = mud.read({ holder: 'root', until: [/存档完成/], timeoutMs: 5000 })
    server.write('系统将在 3 分钟后存档，请及时存档。\n')
    await new Promise(r => setTimeout(r, 20))
    server.write('存档完成。\r\n')
    const r = await p
    expect(r.reason).toBe('done')
    // 触发行被吞（不进模型面）；应答行照常进并参与判据。
    expect(r.lines.map(l => l.text)).toEqual(['存档完成。'])
    expect(sent).toContain('save')
    await server.close()
  })

  it('世界状态随行流更新: read 期间到达的行被抓进工作记忆', async () => {
    const { mud, world, server } = await setup()
    const p = mud.read({ holder: 'root', maxLines: 2, timeoutMs: 5000 })
    server.write('【扬州城 - 打铁铺】\n【气血】156/300\n')
    const r = await p
    expect(r.reason).toBe('done')
    expect(world.get('location', 'room')?.value).toBe('【扬州城 - 打铁铺】')
    expect(world.get('vitals', 'hp')?.value).toBe(156)
    await server.close()
  })

  it('GA 边界字节不触发意识层调度（边界非行, onLine 只收行）', async () => {
    const { mud, sent, server } = await setup()
    const activities: MudLine[] = []
    const awareness = new Awareness({ mud, world: new World(), onActivity: () => {} })
    mud.onLine = line => { activities.push(line); return awareness.observe(line) }
    const p = mud.read({ holder: 'root', timeoutMs: 2000 })
    server.write('横幅\n')
    server.write(Buffer.from([IAC, GA]))
    const r = await p
    expect(r.reason).toBe('done')
    expect(activities.map(l => l.text)).toEqual(['横幅'])
    expect(sent).toEqual([])
    await server.close()
  })
})
