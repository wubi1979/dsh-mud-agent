/**
 * read 测试 — ReadMachine 竞速机单测（伪行流直接驱动，无 TCP）。
 *
 * 覆盖（doc/PLAN.md「二期详细设计」测试面 1–7）：
 *   1. 判定序：failOn > until > gaCount > maxLines（写死）；
 *   2. 异步收束源：quiet / timeout / signal / disconnected / danger 各一例；
 *   3. until 失配记错（按关窗者判：quiet/timeout/maxLines 剪断要吵；
 *      GA 关窗 / signal / danger 不吵）；
 *   4. initial 立即命中（先到先结算）；
 *   5. 并发 start fail-loud；
 *   6. 裸读：initial 尾部快照参与判定（快照式立即返回 / 新行续积 / quiet 收尾巴）；
 *   7. 吞行钩子：'swallow' 行不进 acc；钩子内 abortWait 触发行收编进现场。
 */

import { describe, expect, it } from 'vitest'
import { ReadMachine } from '../src/read.ts'
import type { MudLine } from '../src/link/line.ts'

function line(text: string, abs = 0): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

describe('判定序（写死）', () => {
  it('failOn 优先于 until：一行同时命中两者 → failOn', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/成功/], failOn: [/失败/], timeoutMs: 1000 })
    m.onLine(line('操作失败，未成功'))
    expect((await p).reason).toBe('failOn')
  })

  it('failOn 优先于 maxLines：行数兜底不得抢在负面判据之前剪断', async () => {
    const m = new ReadMachine()
    const p = m.start({ failOn: [/失败/], maxLines: 1, timeoutMs: 1000 })
    m.onLine(line('操作失败'))
    expect((await p).reason).toBe('failOn')
  })

  it('until 命中优先于 maxLines 剪断：命中即 done 且不记错', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/成功/], maxLines: 1, timeoutMs: 1000 })
    m.onLine(line('成功'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(errors).toEqual([])
  })

  it('gaCount 边界关窗：行先于边界，边界计数到即收（GA 关窗不算失配）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/不会出现/], gaCount: 1, timeoutMs: 1000 })
    m.onLine(line('一段完整文字'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(errors).toEqual([])
  })

  it('gaCount=2：两个边界才关窗（N-GA 计数）', async () => {
    const m = new ReadMachine()
    const p = m.start({ gaCount: 2, timeoutMs: 1000 })
    m.onLine(line('第一段'))
    m.onBoundary()
    expect(m.inFlight).toBe(true) // 一个边界不关窗
    m.onLine(line('第二段'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['第一段', '第二段'])
  })

  it('未声明 gaCount：GA/EOR 边界到达不关窗（声明才计 GA，裸读语义）', async () => {
    const m = new ReadMachine()
    const p = m.start({ quietMs: 30, timeoutMs: 1000 }) // 裸读形态：只声明 quiet/maxLines
    m.onLine(line('一行'))
    m.onBoundary() // GA 到达但不构成关窗
    const r = await p
    expect(r.reason).toBe('quiet') // 仍由静默收束
    expect(r.lines.map(l => l.text)).toEqual(['一行'])
  })

  it('非在途 feed 是空操作（行照常进 pending，竞速机不管）', () => {
    const m = new ReadMachine()
    expect(() => m.onLine(line('闲行'))).not.toThrow()
    expect(m.inFlight).toBe(false)
  })
})

describe('异步收束源', () => {
  it('quiet：行后静默到期收束（带走已累积行）', async () => {
    const m = new ReadMachine()
    const p = m.start({ quietMs: 30, timeoutMs: 3000 })
    m.onLine(line('一行'))
    const r = await p
    expect(r.reason).toBe('quiet')
    expect(r.lines.map(l => l.text)).toEqual(['一行'])
  })

  it('timeout：无行也按时收束（绝不无界等待）', async () => {
    const m = new ReadMachine()
    const r = await m.start({ timeoutMs: 30 })
    expect(r.reason).toBe('timeout')
    expect(r.lines).toEqual([])
    expect(m.inFlight).toBe(false)
  })

  it('signal：abort 即以 signal 收束并释放（可再次 start）', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    const p = m.start({ timeoutMs: 5000, signal: ac.signal })
    ac.abort()
    expect((await p).reason).toBe('signal')
    expect(m.inFlight).toBe(false)
    expect((await m.start({ timeoutMs: 20 })).reason).toBe('timeout')
  })

  it('disconnected：onDisconnected 收束在途 read（尾行已进 acc）', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/不会出现/], timeoutMs: 3000 })
    m.onLine(line('断流处尾行'))
    m.onDisconnected()
    const r = await p
    expect(r.reason).toBe('disconnected')
    expect(r.lines.map(l => l.text)).toEqual(['断流处尾行'])
  })

  it('danger：abortWait 打断，触发行收编进结果', async () => {
    const m = new ReadMachine()
    const p = m.start({ until: [/永远不会出现/], timeoutMs: 3000 })
    m.onLine(line('你大喝一声。'))
    m.abortWait(line('不知哪里杀出一人向你袭来！'))
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['你大喝一声。', '不知哪里杀出一人向你袭来！'])
  })

  it('abortWait 无在途 read 时是空操作', () => {
    const m = new ReadMachine()
    expect(() => m.abortWait(line('闲行'))).not.toThrow()
  })
})

describe('until 失配记错（按关窗者判）', () => {
  it('quiet 收场且 until 未命中 → 记 error', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/不会出现/], quietMs: 30, timeoutMs: 3000 })
    m.onLine(line('一些无关内容'))
    const r = await p
    expect(r.reason).toBe('quiet')
    expect(errors.some(e => e.includes('until 判据失配'))).toBe(true)
  })

  it('timeout 收场且 until 未命中 → 记 error', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const r = await m.start({ until: [/不会出现/], timeoutMs: 30 })
    expect(r.reason).toBe('timeout')
    expect(errors.some(e => e.includes('until 判据失配'))).toBe(true)
  })

  it('maxLines 剪断的 done 且 until 未命中 → 记 error（剪断 ≠ 完成语命中）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ until: [/不会出现/], maxLines: 2, timeoutMs: 3000 })
    m.onLine(line('甲'))
    m.onLine(line('乙'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(2)
    expect(errors.some(e => e.includes('until 判据失配'))).toBe(true)
  })

  it('signal / danger 收场 → 不记错（外部中断不吵）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const ac = new AbortController()
    const p1 = m.start({ until: [/不会出现/], timeoutMs: 3000, signal: ac.signal })
    ac.abort()
    await p1
    const p2 = m.start({ until: [/不会出现/], timeoutMs: 3000 })
    m.abortWait()
    await p2
    expect(errors).toEqual([])
  })
})

describe('initial 先到先结算', () => {
  it('initial 立即命中：有积压行时无新行即收', async () => {
    const m = new ReadMachine()
    const p = m.start(
      { until: [/密码/], timeoutMs: 3000 },
      [line('欢迎来到北大侠客行'), line('请输入密码：')],
    )
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['欢迎来到北大侠客行', '请输入密码：'])
  })

  it('并发 start fail-loud（不做队列）', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    const p1 = m.start({ timeoutMs: 5000, signal: ac.signal })
    expect(() => m.start({ timeoutMs: 1000 })).toThrow(/竞速冲突/)
    ac.abort()
    await p1
  })
})

describe('裸读（initial 尾部快照）', () => {
  it('initial 满足 maxLines：立即 done（快照式读取，不等新行）', async () => {
    const m = new ReadMachine()
    const initial = ['甲', '乙', '丙'].map(t => line(t))
    const r = await m.start({ maxLines: initial.length, timeoutMs: 1000 }, initial)
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['甲', '乙', '丙'])
  })

  it('initial 不足 maxLines：新行续积，行数到位收束', async () => {
    const m = new ReadMachine()
    const p = m.start({ maxLines: 3, timeoutMs: 3000 }, [line('甲'), line('乙')])
    m.onLine(line('丙'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['甲', '乙', '丙'])
  })

  it('initial 不足且再无新行：quiet 收尾巴（短静默窗口）', async () => {
    const m = new ReadMachine()
    const r = await m.start(
      { maxLines: 50, quietMs: 30, timeoutMs: 3000 },
      [line('近况甲'), line('近况乙')],
    )
    expect(r.reason).toBe('quiet')
    expect(r.lines.map(l => l.text)).toEqual(['近况甲', '近况乙'])
  })
})

describe('吞行钩子', () => {
  it("onSwallow 返回 'swallow' 的行不进 acc", async () => {
    const m = new ReadMachine()
    m.onSwallow = l => (l.text.includes('吞我') ? 'swallow' : undefined)
    const p = m.start({ maxLines: 1, timeoutMs: 3000 })
    expect(m.onLine(line('吞我'))).toBe('swallow')
    m.onLine(line('留下的行'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['留下的行'])
  })

  it('钩子内同步 abortWait：触发行收编进 danger 现场（不重复进 acc）', async () => {
    const m = new ReadMachine()
    m.onSwallow = (l) => {
      if (l.text.includes('向你袭来')) m.abortWait(l)
      return undefined
    }
    const p = m.start({ until: [/永远不会出现/], timeoutMs: 3000 })
    m.onLine(line('你大喝一声。'))
    m.onLine(line('不知哪里杀出一人向你袭来！'))
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['你大喝一声。', '不知哪里杀出一人向你袭来！'])
  })
})
