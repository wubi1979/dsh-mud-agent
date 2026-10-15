/**
 * read 测试 — ReadMachine 判定序/异步收束/失配记错/swallow + runtime 集成（水位线）。
 *
 * T26.6 终态词汇（DEC-3/7/19/21/23）：closeOn 三形态（ga/criteria/quiet）+ 语义条目集
 *（fail 槽位在前 = 判定序）+ gaCount（ga 等第 N 个）+ maxLines（各形态通用兜底）。
 * until/failOn/race/quietMs（命令判据面）/静默计时器/推定槽已退役（旧 `gaCount`
 * 缺省兜底档同退役——现 gaCount 仅指 ga 形态显式计数）；
 * quietMs 仅裸读（closeOn 缺省）保留。
 *
 * 语义要点（§3.2）：
 *   - criteria：fail 槽位 > ok 槽位（条目内 pattern 序）；GA 不武装；失配（timeout/
 *     maxLines 收场）记 error；
 *   - ga：GA/EOR 计数关窗（gaCount ?? 1）；声明分类语义条目而无一命中 ⇒ 断言失败
 *     合成 fail 帧（by:'ga' 无 outcome——「收窗成功，分支未知」）；未声明分类语义条目
 *     ⇒ 无帧（关窗即 next）；ga 关窗不算失配；
 *   - quiet：固定采样窗——唯一计时器 timeoutMs，行只累积不重置；到点按行数
 *     合成帧（有行 ⇒ ok reason:'quiet'；零行 ⇒ fail reason:'timeout'）；
 *     maxLines 剪断 ⇒ by:'maxLines'。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { ReadMachine } from 'mud-sense/read'
import { SessionRuntime } from '../src/runtime.ts'
import { Deliverer } from '../src/deliver.ts'
import type { AddressInfo } from 'node:net'
import type { MudLine } from 'mud-link/line'

// ── 工具 ──────────────────────────────────────────────────────

function line(text: string, abs = 0): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false, kind: null }
}

/** 起 TCP server：连接后写 welcome 横幅，onData 可编程回写。 */
async function startServer(onData: (data: string, socket: net.Socket) => void): Promise<{
  port: number
  close(): Promise<void>
  broadcast(text: string): void
  sendGa(socketTag?: number): void
}> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.write('欢迎来到测试服务器\n')
    s.on('data', d => onData(d.toString(), s))
    s.on('error', () => {})
    s.on('close', () => { sockets.delete(s) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    broadcast: (text: string) => { for (const s of sockets) s.write(text) },
    sendGa: () => { for (const s of sockets) s.write(Buffer.from([0xff, 0xf9])) },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// ── ReadMachine 单测 ──────────────────────────────────────────

describe('ReadMachine 判定次序', () => {
  it('criteria：fail 槽位先于 ok 槽位（同帧两条语义条目命中 → fail 收束）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [
        { name: '完成', kind: 'ok', res: [/完成/] },
        { name: '爆炸', kind: 'fail', res: [/爆炸/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('爆炸且完成'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toMatchObject({ by: 'criteria', outcome: '爆炸', kind: 'fail' })
  })

  it('criteria：cooldown 槽命中 → kind=cooldown 收束（fail > cooldown > ok，2026-10-15 三分）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [
        { name: '完成', kind: 'ok', res: [/完成/] },
        { name: '刚查看过', kind: 'cooldown', res: [/刚查看过/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('你不是刚查看过吗？其实也完成了'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toMatchObject({ by: 'criteria', outcome: '刚查看过', kind: 'cooldown' })
  })

  it('criteria：fail 槽位压过 cooldown 槽位（同帧命中 → fail 收束）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [
        { name: '失败', kind: 'fail', res: [/失败/] },
        { name: '刚查看过', kind: 'cooldown', res: [/刚查看过/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('失败且刚查看过'))
    const r = await p
    expect(r.hit).toMatchObject({ by: 'criteria', outcome: '失败', kind: 'fail' })
  })

  it('criteria：判据命中优先于 maxLines（同批到达即收，行数未满）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '完成', kind: 'ok', res: [/完成/] }],
      maxLines: 10,
      timeoutMs: 500,
    })
    m.onLine(line('完成'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(1)
  })

  it('ga：边界优先于 maxLines（边界先到即收，行数未满）', async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'ga', gaCount: 1, maxLines: 10, timeoutMs: 500 })
    m.onLine(line('a'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines).toHaveLength(1)
  })

  it('maxLines 剪断：行数达到即 done 收束（裸读）', async () => {
    const m = new ReadMachine()
    const p = m.start({ maxLines: 2, timeoutMs: 500 })
    m.onLine(line('a'))
    m.onLine(line('b'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['a', 'b'])
  })

  it('criteria 可跨批命中（累积文本上测）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '跨行', kind: 'ok', res: [/第一.*第二/s] }],
      timeoutMs: 500,
    })
    m.onLine(line('这是第一'))
    m.onLine(line('行，第二在下一行'))
    const r = await p
    expect(r.reason).toBe('done')
  })
})

describe('ReadMachine closeOn 分档（T26.6，§3.2）', () => {
  it("'criteria'：受理帧 GA 不关窗，完成句语义条目命中收窗并给结局帧（outcome/kind）", async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [
        { name: '完成', kind: 'ok', res: [/完成/] },
        { name: '内息不足', kind: 'fail', res: [/气太少/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('你盘膝坐下，默运基本内功'))
    m.onBoundary() // 受理帧 GA——criteria 下不武装，窗不关
    expect(m.inFlight).toBe(true)
    m.onLine(line('你将内息收回丹田，完成'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toEqual({ by: 'criteria', index: 0, groups: [], outcome: '完成', kind: 'ok' })
  })

  it("'criteria'：fail 槽位先于 ok 槽位（声明序无关，fail 槽位摊平进判定序）", async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [
        { name: '完成', kind: 'ok', res: [/完成/] },
        { name: '内息不足', kind: 'fail', res: [/气太少/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('气太少且完成')) // 两条语义条目同帧命中
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toEqual({ by: 'criteria', index: 0, groups: [], outcome: '内息不足', kind: 'fail' })
  })

  it("'criteria'：判据未命中 timeout 收场 → 失配记 error（分档：criteria 只判 timeout/maxLines）", async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (_level, text) => { errors.push(text) }
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '完成', kind: 'ok', res: [/完成/] }],
      timeoutMs: 60,
    })
    m.onLine(line('别的行'))
    const r = await p
    expect(r.reason).toBe('timeout')
    expect(r.hit).toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it("'ga'：判据不命中仍由 GA 收窗、不记失配；GA 收束时扫窗分类给结局帧", async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (_level, text) => { errors.push(text) }
    const p = m.start({
      closeOn: 'ga',
      slots: [
        { name: '刚睡过', kind: 'fail', res: [/刚睡过/] },
        { name: '完成', kind: 'ok', res: [/醒来/] },
      ],
      timeoutMs: 500,
    })
    m.onLine(line('你一觉醒来，精神抖擞'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toEqual({ by: 'ga', index: 0, groups: [], outcome: '完成', kind: 'ok' })
    expect(errors).toHaveLength(0) // 'ga' 语义条目仅分类：无判据失配可言
  })

  it("'ga'：声明分类语义条目而无一命中 ⇒ 断言失败合成帧（by 'ga' 无 outcome，kind fail）", async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'ga',
      slots: [{ name: '完成', kind: 'ok', res: [/不出现/] }],
      timeoutMs: 500,
    })
    m.onLine(line('普通应答'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toEqual({ by: 'ga', index: -1, groups: [], kind: 'fail' })
  })

  it("'ga'：未声明分类语义条目 → 关窗无帧（关窗即 next）", async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'ga', timeoutMs: 500 })
    m.onLine(line('普通应答'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toBeUndefined()
  })

  it("'quiet'：固定采样窗——timeout 到点有行 ⇒ 合成 ok 帧（reason 'quiet'）", async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'quiet', timeoutMs: 60 })
    m.onLine(line('回显一'))
    const r = await p
    expect(r.reason).toBe('quiet')
    expect(r.hit).toEqual({ by: 'quiet', index: -1, groups: [], kind: 'ok' })
  })

  it("'quiet'：到点零行 ⇒ 合成 fail 帧（reason 'timeout'，等同 timeout）", async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'quiet', timeoutMs: 60 })
    const r = await p
    expect(r.reason).toBe('timeout')
    expect(r.hit).toEqual({ by: 'quiet', index: -1, groups: [], kind: 'fail' })
  })

  it("'quiet'：行只累积不重置（quiet 无静默计时器，新行不延长采样窗）", async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'quiet', timeoutMs: 80 })
    m.onLine(line('a'))
    await new Promise(r => setTimeout(r, 30))
    m.onLine(line('b'))
    const r = await p // 仍在原 timeoutMs 时刻关窗
    expect(r.reason).toBe('quiet')
    expect(r.lines.map(l => l.text)).toEqual(['a', 'b'])
  })

  it("'quiet'：maxLines 剪断 → 合成帧按 by 'maxLines'（reason 'done'）", async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'quiet', maxLines: 1, timeoutMs: 2000 })
    m.onLine(line('x'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toEqual({ by: 'maxLines', index: -1, groups: [], kind: 'ok' })
  })
})

describe('ReadMachine 命中帧（T15：命中判据 + 捕获组由读窗机返回）', () => {
  it('① 条目内 pattern 声明序定位命中下标（条目内第 2 条命中 ⇒ index 1）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '标记', kind: 'ok', res: [/甲/, /乙/] }],
      timeoutMs: 500,
    })
    m.onLine(line('无关行'))
    m.onLine(line('乙出现'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toMatchObject({ by: 'criteria', outcome: '标记', kind: 'ok', index: 1, groups: [] })
  })

  it('② fail 语义条目命中 ⇒ by=criteria + 条目内正确下标', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '失败', kind: 'fail', res: [/无关/, /爆炸/] }],
      timeoutMs: 500,
    })
    m.onLine(line('爆炸了'))
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toMatchObject({ by: 'criteria', kind: 'fail', outcome: '失败', index: 1 })
  })

  it('③ ga 关窗无分类语义条目 ⇒ hit 为 undefined（关窗即 next，供 D11 判空）', async () => {
    const m = new ReadMachine()
    const p = m.start({ closeOn: 'ga', timeoutMs: 2000 })
    m.onLine(line('普通行'))
    m.onBoundary()
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.hit).toBeUndefined()
  })

  it('④ 捕获组按序返回：未参与组为 undefined、参与但空串为 ""', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '捕获', kind: 'ok', res: [/(甲)?(\S+)对(\S*)说/] }],
      timeoutMs: 500,
    })
    m.onLine(line('张三对说'))
    const r = await p
    expect(r.hit?.groups).toEqual([undefined, '张三', ''])
  })

  it('⑤ 无组判据 ⇒ groups 为空数组', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: '完成', kind: 'ok', res: [/完成/] }],
      timeoutMs: 500,
    })
    m.onLine(line('完成'))
    const r = await p
    expect(r.hit).toEqual({ by: 'criteria', index: 0, groups: [], outcome: '完成', kind: 'ok' })
  })

  it('⑥a 同一正则实例跨两次 read 复用：lastIndex 重置生效（不重置则第二次丢命中）', async () => {
    const reused = /第二/g // 调用方缓存编译结果的场景（g 有状态起点会跨 read 残留）
    const m1 = new ReadMachine()
    const p1 = m1.start({ closeOn: 'criteria', slots: [{ name: 'x', kind: 'ok', res: [reused] }], timeoutMs: 500 })
    m1.onLine(line('第二'))
    expect((await p1).reason).toBe('done')

    const m2 = new ReadMachine()
    const p2 = m2.start({ closeOn: 'criteria', slots: [{ name: 'x', kind: 'ok', res: [reused] }], timeoutMs: 500 })
    m2.onLine(line('第二'))
    const r2 = await p2
    expect(r2.reason).toBe('done')
    expect(r2.hit).toMatchObject({ by: 'criteria', index: 0 })
  })

  it('⑥b 取组不因“先找下标”而丢：含 g 声明也拿到组（exec 单次调用）', async () => {
    const m = new ReadMachine()
    const p = m.start({
      closeOn: 'criteria',
      slots: [{ name: 'x', kind: 'ok', res: [/^第二(\d+)/g] }],
      timeoutMs: 500,
    })
    m.onLine(line('第二42'))
    const r = await p
    expect(r.hit).toMatchObject({ by: 'criteria', index: 0, groups: ['42'] })
  })

  it('⑥c y（sticky）语义保留：只在窗口起点命中，不向后搜', async () => {
    const atStart = new ReadMachine()
    const p1 = atStart.start({ closeOn: 'criteria', slots: [{ name: 'x', kind: 'ok', res: [/第二/y] }], timeoutMs: 500 })
    atStart.onLine(line('第二在后面'))
    expect((await p1).hit).toMatchObject({ by: 'criteria', index: 0 })

    const later = new ReadMachine()
    const p2 = later.start(
      { closeOn: 'criteria', slots: [{ name: 'x', kind: 'ok', res: [/第二/y] }], timeoutMs: 60 },
      [line('无关')],
    )
    later.onLine(line('第二在后面')) // 非窗口起点：sticky 不命中
    const r2 = await p2
    expect(r2.reason).toBe('timeout')
    expect(r2.hit).toBeUndefined()
  })
})

describe('ReadMachine 异步收束源', () => {
  it('裸读 quietMs：行后静默到期收束', async () => {
    const m = new ReadMachine()
    const r = await m.start({ quietMs: 50, timeoutMs: 2000 }, [line('预取')])
    expect(r.reason).toBe('quiet')
  })

  it('timeout：总超时收束', async () => {
    const m = new ReadMachine()
    const r = await m.start({ timeoutMs: 60 })
    expect(r.reason).toBe('timeout')
  })

  it('signal：中止即收束（不吞行）', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    const p = m.start({ timeoutMs: 5000, signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.reason).toBe('signal')
  })

  it('signal 已 abort：start 立即收束', async () => {
    const m = new ReadMachine()
    const ac = new AbortController()
    ac.abort()
    const r = await m.start({ timeoutMs: 5000, signal: ac.signal })
    expect(r.reason).toBe('signal')
  })

  it('disconnected：断线收束（在途 read 被中断）', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    m.onDisconnected()
    const r = await p
    expect(r.reason).toBe('disconnected')
  })

  it('danger：abortWait 收束，触发行收编进结果', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    m.abortWait(line('拦路者出现'))
    const r = await p
    expect(r.reason).toBe('danger')
    expect(r.lines.map(l => l.text)).toEqual(['拦路者出现'])
  })
})

describe('ReadMachine 失配记错', () => {
  it('criteria 判据未命中而 timeout 收场 → 记 error（语料可见）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    await m.start({ closeOn: 'criteria', slots: [{ name: '完成', kind: 'ok', res: [/完成/] }], timeoutMs: 40 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('criteria')
  })

  it('ga 边界关窗不算失配（不记 error，含断言失败合成帧）', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ closeOn: 'ga', slots: [{ name: '完成', kind: 'ok', res: [/完成/] }], timeoutMs: 2000 })
    m.onLine(line('普通行'))
    m.onBoundary()
    await p
    expect(errors).toEqual([])
  })

  it('criteria 命中收场不记 error', async () => {
    const m = new ReadMachine()
    const errors: string[] = []
    m.onLog = (level, text) => { if (level === 'error') errors.push(text) }
    const p = m.start({ closeOn: 'criteria', slots: [{ name: '完成', kind: 'ok', res: [/完成/] }], timeoutMs: 2000 })
    m.onLine(line('完成'))
    await p
    expect(errors).toEqual([])
  })
})

describe('ReadMachine 生命周期', () => {
  it('initial 立即命中（先到先结算，不等新行）', async () => {
    const m = new ReadMachine()
    const r = await m.start({ closeOn: 'criteria', slots: [{ name: '欢迎', kind: 'ok', res: [/欢迎/] }], timeoutMs: 2000 }, [line('欢迎光临')])
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toEqual(['欢迎光临'])
  })

  it('并发 start fail-loud', async () => {
    const m = new ReadMachine()
    const p = m.start({ timeoutMs: 5000 })
    expect(() => m.start({ timeoutMs: 5000 })).toThrow('在途')
    m.onDisconnected()
    await p
  })

  it('swallow 钩子：返回 swallow 的行不进 acc', async () => {
    const m = new ReadMachine()
    m.onSwallow = l => (l.text.includes('噪声') ? 'swallow' : undefined)
    const p = m.start({ maxLines: 2, timeoutMs: 2000 })
    m.onLine(line('噪声行'))
    m.onLine(line('实词1'))
    m.onLine(line('实词2'))
    const r = await p
    expect(r.lines.map(l => l.text)).toEqual(['实词1', '实词2'])
  })

  it('收束后可再次 start（状态复位）', async () => {
    const m = new ReadMachine()
    const r1 = await m.start({ maxLines: 1, timeoutMs: 60 })
    expect(r1.reason).toBe('timeout')
    const r2 = await m.start({ maxLines: 1, timeoutMs: 2000 }, [line('x')])
    expect(r2.reason).toBe('done')
  })
})

// ── runtime 集成（真实 TCP + 水位线）──────────────────────────

describe('SessionRuntime.read（集成）', () => {
  it('read 端到端：send 后等应答，criteria 命中返回原文', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('look')) s.write('你看到一座小屋\n')
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50)) // 欢迎横幅到达

    const p = rt.read({ closeOn: 'criteria', slots: [{ name: '小屋', kind: 'ok', res: [/小屋/] }], timeoutMs: 2000 })
    rt.send('look')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('你看到一座小屋')
    // readAbs 已推进到应答尾行
    expect(rt.seenAbs()).toBeGreaterThanOrEqual(r.lines.at(-1)!.abs)
    rt.dispose()
    await server.close()
  })

  it('未连接 read：直接 disconnected 收束（不启动等待）', async () => {
    const rt = new SessionRuntime('s1')
    const r = await rt.read({ timeoutMs: 2000 })
    expect(r.reason).toBe('disconnected')
    expect(r.lines).toEqual([])
  })

  it('GA 边界关窗：ga 形态 gaCount=1 命中即收', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('hp')) {
        s.write('气血 100/100\n')
        s.write(Buffer.from([0xff, 0xf9])) // IAC GA
      }
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50))

    const p = rt.read({ closeOn: 'ga', gaCount: 1, timeoutMs: 2000 })
    rt.send('hp')
    const r = await p
    expect(r.reason).toBe('done')
    expect(r.lines.map(l => l.text)).toContain('气血 100/100')
    rt.dispose()
    await server.close()
  })

  it('断线中断在途 read（reason: disconnected）', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })

    const p = rt.read({ closeOn: 'criteria', slots: [{ name: '永不出现', kind: 'ok', res: [/永不出现/] }], timeoutMs: 5000 })
    rt.disconnect()
    const r = await p
    expect(r.reason).toBe('disconnected')
    // 断线水位复位
    expect(rt.seenAbs()).toBe(-1)
    expect(rt.pendingLineCount).toBe(0)
    rt.dispose()
    await server.close()
  })

  it('并发 read fail-loud（同一 runtime 同一时刻只允许一个 read）', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    const p = rt.read({ timeoutMs: 5000 })
    await expect(rt.read({ timeoutMs: 5000 })).rejects.toThrow('在途')
    rt.disconnect()
    await p
    rt.dispose()
    await server.close()
  })

  it('水位线：read 消费过的行不再被投递（seen 推进），投递只拉 seen 之后', async () => {
    const server = await startServer(() => {})
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50)) // 欢迎横幅（3 行左右）入 pending

    // 接入 + 投递器（deliver 收集；onLine 接线镜像 service.register）
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, rt, { quietMs: 20 })
    rt.onLine = l => { d.onLine(l) }
    d.admit() // 水位 = 接入时刻（欢迎横幅不回放）

    // 裸读：取尾部（欢迎横幅）——读过即已见，不再投递
    const initial = rt.recentLines(10)
    expect(initial.length).toBeGreaterThan(0)
    const r = await rt.read({ quietMs: 30, timeoutMs: 2000 }, initial)
    expect(r.reason).toBe('quiet')
    expect(rt.seenAbs()).toBeGreaterThanOrEqual(initial.at(-1)!.abs)

    // 新行到达 → 投递只拉 seen 之后（不含已裸读的横幅）
    server.broadcast('新到的一行\n')
    await new Promise(x => setTimeout(x, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('新到的一行')
    expect(d.pendingCount).toBe(0)
    rt.dispose()
    await server.close()
  })

  it('投递与 read 互补不重复：未 read 的行走投递，read 过的不重复投', async () => {
    const server = await startServer((data, s) => {
      if (data.includes('look')) s.write('房间描述\n')
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 50))

    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, rt, { quietMs: 20 })
    d.admit()

    // read 消费 look 应答
    const p = rt.read({ closeOn: 'criteria', slots: [{ name: '房间', kind: 'ok', res: [/房间描述/] }], timeoutMs: 2000 })
    rt.send('look')
    const r = await p
    expect(r.reason).toBe('done')

    // turn/end 冲刷：应答行已 read（seen 推进），不重复投递
    d.onTurnEnd()
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(0)
    rt.dispose()
    await server.close()
  })
})