/**
 * keepalive 半开探活测试（T12：静默伴随自驱）。
 *
 * 契约（T12 计划 D1–D7，PLAN.md 探活精化返工）：
 *   - 探活 = 静默伴随检查（非周期、无外部到期点入口）：唯一时钟锚 = 最后数据
 *     到达时刻（armIdle）；静默满 startMs 首发 AYT，无应答每 retryMs 重发，
 *     共 maxAttempts 次；判死刻度 = startMs + maxAttempts × retryMs（缺省
 *     90/99/108 发送，117s 判死，留 3s 给唤醒点）；
 *   - 判活 link 内部消化（D3，无 onAlive 回调）：任意行 / GA / `[-Yes-]` 到达
 *     → probeState=idle + idle 锚重置（探测窗口随下一轮静默重开）；
 *   - 吞行判定不限探测阶段：命中 `^\[-Yes-\]`（flags:'m'）的行一律吞掉
 *     （不进 pendingLines/画面/投递/onActivity）；
 *   - busy 谓词（D4）：busy 的探测 tick 跳过（不发 AYT 不耗次数，U1 不顺延，
 *     deadline 固定）；判死刻度 busy → 本轮零收束（不判死，read timeout 兜底）；
 *   - 判死回调携带实际发送次数（日志计数用）；send 失败（socket 不可用）→
 *     立即判死；
 *   - cancel 全停幂等；startMs/retryMs/maxAttempts 非正整数 fail-loud。
 *
 * Mud 接线（真 socket）：AYT 字节直写对端可见；busy 谓词经构造注入；判死走
 * disconnect → onDisconnect 硬收尾（T5.2 自动重连的触发源，service 零改动）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Keepalive, AYT_ALIVE_RE } from '../../src/link/keepalive.ts'
import { Mud } from '../../src/link/mud.ts'
import { TelnetClient } from '../../src/link/telnet.ts'

// ── Keepalive 纯层 ───────────────────────────────────────────────

describe('Keepalive 纯层（静默伴随自驱）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** 构造带计数的探活器（刻度缩比 900/90/3 = 缺省 90s/9s/3 的 1/100；缺省 send 成功）。 */
  function makeKa(overrides?: {
    startMs?: number
    retryMs?: number
    maxAttempts?: number
    sendOk?: boolean
    busy?: boolean
  }) {
    let sent = 0
    let dead = 0
    let deadAttempts = -1
    const ka = new Keepalive({
      send: () => { sent += 1; return overrides?.sendOk ?? true },
      onDead: (attempts: number) => { dead += 1; deadAttempts = attempts },
      isBusy: () => overrides?.busy ?? false,
    }, {
      startMs: overrides?.startMs ?? 900,
      retryMs: overrides?.retryMs ?? 90,
      maxAttempts: overrides?.maxAttempts ?? 3,
    })
    return { ka, sent: () => sent, dead: () => dead, deadAttempts: () => deadAttempts }
  }

  it('静默满 startMs 首发 AYT；retryMs 刻度重发；判死刻度 = startMs + maxAttempts × retryMs', () => {
    const { ka, sent, dead, deadAttempts } = makeKa()
    ka.armIdle()
    vi.advanceTimersByTime(899)
    expect(sent()).toBe(0)
    expect(ka.state).toBe('idle')
    vi.advanceTimersByTime(1) // t=900 首发
    expect(ka.state).toBe('probing')
    expect(sent()).toBe(1)
    vi.advanceTimersByTime(89)
    expect(sent()).toBe(1)
    vi.advanceTimersByTime(1) // t=990 重发 1
    expect(sent()).toBe(2)
    vi.advanceTimersByTime(90) // t=1080 重发 2
    expect(sent()).toBe(3)
    vi.advanceTimersByTime(89)
    expect(dead()).toBe(0)
    vi.advanceTimersByTime(1) // t=1170 判死
    expect(dead()).toBe(1)
    expect(deadAttempts()).toBe(3) // 判死回调携带实际发送次数
    expect(ka.state).toBe('idle')
    vi.advanceTimersByTime(10_000)
    expect(dead()).toBe(1) // 不重复判死
    expect(sent()).toBe(3)
  })

  it('任意行判活（内部消化，无回调面）+ idle 锚重置（探测窗口随静默重开）', () => {
    const { ka, sent, dead } = makeKa()
    ka.armIdle()
    vi.advanceTimersByTime(900)
    expect(sent()).toBe(1)
    expect(ka.state).toBe('probing')
    vi.advanceTimersByTime(50)
    expect(ka.observeLine('大厅的告示牌')).toBe(false) // 非应答行照常分发
    expect(ka.state).toBe('idle') // 世界自证存活 → 判活内部消化
    expect(ka.attempts).toBe(0)
    // idle 锚重置：新窗口自判活时刻（t=950）重新倒数——旧节奏的 990/1080
    // 重发刻度已不复存在，950+900 才首发
    vi.advanceTimersByTime(850)
    expect(sent()).toBe(1)
    expect(dead()).toBe(0)
    vi.advanceTimersByTime(50)
    expect(sent()).toBe(2) // t=1850 = 判活+900 新窗口首发
  })

  it('GA 边界判活主路径（AYT 应答常不带换行，GA 先到）', () => {
    const { ka, sent, dead } = makeKa()
    ka.armIdle()
    vi.advanceTimersByTime(900)
    expect(ka.state).toBe('probing')
    ka.observeBoundary() // AYT 应答主判活路径
    expect(ka.state).toBe('idle')
    // 判活重置锚：新窗口自判活时刻（t=900）重新倒数
    vi.advanceTimersByTime(899)
    expect(sent()).toBe(1) // 锚已重置，未到新窗口首发
    expect(dead()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(sent()).toBe(2) // t=1800 = 判活+900 新窗口首发
  })

  it('判据 `^\\[-Yes-\\]` 配 flags m：行首命中才吞；吞行判定不限探测阶段', () => {
    expect(AYT_ALIVE_RE.test('[-Yes-]')).toBe(true)
    expect(AYT_ALIVE_RE.test('前缀 [-Yes-]')).toBe(false) // 无行首锚不命中
    expect(AYT_ALIVE_RE.test('第二行\n[-Yes-]')).toBe(true) // m 标志跨行锚定
    const { ka } = makeKa()
    // 非探测阶段命中 → 吞掉但不判活（判活后 300ms 刷出竞态窗口外到达）
    expect(ka.observeLine('[-Yes-]')).toBe(true)
    expect(ka.state).toBe('idle')
  })

  it('busy tick 跳过：不发 AYT 不耗次数；busy 恒真贯穿窗口 = 本轮零探活不判死', () => {
    const { ka, sent, dead } = makeKa({ busy: true })
    ka.armIdle()
    vi.advanceTimersByTime(900) // 首发 tick：busy 跳过
    expect(sent()).toBe(0)
    expect(ka.state).toBe('idle')
    vi.advanceTimersByTime(90) // 重发 tick：同跳过
    vi.advanceTimersByTime(90)
    expect(sent()).toBe(0)
    vi.advanceTimersByTime(90) // 判死刻度：busy → 零收束（不判死，read timeout 兜底）
    expect(dead()).toBe(0)
    expect(ka.state).toBe('idle')
    vi.advanceTimersByTime(10_000)
    expect(dead()).toBe(0)
    expect(sent()).toBe(0)
  })

  it('busy 错过即错过（U1 不顺延）：中间 tick busy 跳过后，后续空闲 tick 补发，deadline 固定', () => {
    let busy = true
    let sent = 0
    let dead = 0
    let deadAttempts = -1
    const ka = new Keepalive({
      send: () => { sent += 1; return true },
      onDead: (attempts: number) => { dead += 1; deadAttempts = attempts },
      isBusy: () => busy,
    }, { startMs: 900, retryMs: 90, maxAttempts: 3 })
    ka.armIdle()
    vi.advanceTimersByTime(900) // 首发 tick busy：跳过（该次机会作废）
    expect(sent).toBe(0)
    busy = false
    vi.advanceTimersByTime(90) // t=990：补发第 1 次
    expect(sent).toBe(1)
    vi.advanceTimersByTime(90) // t=1080：第 2 次
    expect(sent).toBe(2)
    vi.advanceTimersByTime(90) // t=1170 判死刻度（固定，不顺延）：空闲 → 判死
    expect(dead).toBe(1)
    expect(deadAttempts).toBe(2) // 实际只发出了 2 次
  })

  it('send 失败（socket 不可用）→ 立即判死', () => {
    const { ka, dead, deadAttempts } = makeKa({ sendOk: false })
    ka.armIdle()
    vi.advanceTimersByTime(900)
    expect(ka.state).toBe('idle')
    expect(dead()).toBe(1)
    expect(deadAttempts()).toBe(1)
  })

  it('重发期 send 失败 → 判死', () => {
    let ok = true
    let sent = 0
    let dead = 0
    const ka = new Keepalive({
      send: () => { sent += 1; return ok },
      onDead: () => { dead += 1 },
    }, { startMs: 100, retryMs: 1000, maxAttempts: 5 })
    ka.armIdle()
    vi.advanceTimersByTime(100)
    expect(sent).toBe(1)
    ok = false // 第 1 次成功后连接死亡
    vi.advanceTimersByTime(1000)
    expect(sent).toBe(2)
    expect(dead).toBe(1)
  })

  it('cancel 全停幂等：取消后不重发不判死（断连/销毁收尾路径）', () => {
    const { ka, sent, dead } = makeKa()
    ka.cancel() // 未武装时取消：幂等
    ka.armIdle()
    vi.advanceTimersByTime(900)
    expect(ka.state).toBe('probing')
    ka.cancel()
    expect(ka.state).toBe('idle')
    vi.advanceTimersByTime(60_000)
    expect(sent()).toBe(1)
    expect(dead()).toBe(0)
  })

  it('数据到达重开窗口后静默持续 → 探活逐窗推进（每轮静默到期都是探活窗口）', () => {
    const { ka, sent } = makeKa()
    ka.armIdle()
    // 窗口 1：900 首发 → 900+50 应答判活（observeLine 内部消化）→ idle 锚重置
    vi.advanceTimersByTime(900)
    vi.advanceTimersByTime(50)
    ka.observeLine('[-Yes-]') // 应答行：吞掉 + 判活 + 重置
    // 窗口 2：自判活时刻起再满 startMs 首发
    vi.advanceTimersByTime(900)
    expect(sent()).toBe(2)
  })

  it('startMs / retryMs / maxAttempts 非正整数 fail-loud', () => {
    const deps = { send: () => true, onDead: () => {} }
    expect(() => new Keepalive(deps, { startMs: 0, retryMs: 90, maxAttempts: 3 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: -1, retryMs: 90, maxAttempts: 3 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: 1.5, retryMs: 90, maxAttempts: 3 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: 900, retryMs: 0, maxAttempts: 3 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: 900, retryMs: 2.5, maxAttempts: 3 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: 900, retryMs: 90, maxAttempts: 0 })).toThrow(TypeError)
    expect(() => new Keepalive(deps, { startMs: 900, retryMs: 90, maxAttempts: 3.5 })).toThrow(TypeError)
  })
})

// ── TelnetClient.sendAyt / Mud 接线（真 socket）──────────────────

describe('Mud 探活接线（真 socket，自驱）', () => {
  interface TestServer {
    port: number
    write(data: string | Buffer): void
    kill(): void
    close(): Promise<void>
    waitFor(target: string): Promise<Buffer>
  }

  async function startServer(): Promise<TestServer> {
    let sock: net.Socket | null = null
    const chunks: Buffer[] = []
    const server = net.createServer((s) => {
      sock = s
      s.on('data', (d: Buffer) => chunks.push(d))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return {
      port,
      write(data) {
        const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
        if (sock !== null) sock.write(payload)
        else server.once('connection', s => s.write(payload))
      },
      kill() { sock?.destroy() },
      close() {
        sock?.destroy()
        return new Promise(resolve => server.close(() => resolve()))
      },
      waitFor(target: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
          const t0 = Date.now()
          const probe = setInterval(() => {
            const all = Buffer.concat(chunks)
            if (all.includes(Buffer.from(target, 'binary'))) {
              clearInterval(probe)
              resolve(all)
            } else if (Date.now() - t0 > 2000) {
              clearInterval(probe)
              reject(new Error(`对端 2s 内未收到目标字节: ${target}; 实收 ${all.length} 字节`))
            }
          }, 10)
        })
      },
    }
  }

  async function setup(keepalive?: { startMs: number, retryMs: number, maxAttempts: number }, isBusy?: () => boolean) {
    const server = await startServer()
    const mud = new Mud({
      ...(keepalive === undefined ? {} : { keepalive }),
      ...(isBusy === undefined ? {} : { isBusy }),
    })
    mud.connect('127.0.0.1', server.port)
    for (let i = 0; i < 100 && !mud.connected; i += 1) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(mud.connected).toBe(true)
    return { mud, server }
  }

  /** 等待自驱探活进入 probing（startMs 缩比后 100ms 内应到位）。 */
  async function waitProbing(mud: Mud): Promise<void> {
    for (let i = 0; i < 100 && mud.probeState !== 'probing'; i += 1) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(mud.probeState).toBe('probing')
  }

  it('TelnetClient.sendAyt 未连接返回 false', () => {
    const client = new TelnetClient({ host: '127.0.0.1', port: 1 })
    expect(client.sendAyt()).toBe(false)
  })

  it('静默满 startMs 自驱首发：对端收到 IAC AYT(246) 字节；probeState = probing', async () => {
    const { mud, server } = await setup({ startMs: 50, retryMs: 50, maxAttempts: 3 })
    // '\xf6' 按 binary(latin-1) 编码 = 字节 0xF6 = AYT 命令字节
    const all = await server.waitFor('\xf6')
    expect(all.includes(Buffer.from('f6', 'hex'))).toBe(true)
    expect(mud.probeState).toBe('probing')
    await server.close()
  })

  it('busy 谓词注入：busy 期间探测 tick 跳过（零探活零收束）；数据到达重开窗口后补发', async () => {
    let busy = true
    let busyChecks = 0
    const { mud, server } = await setup({ startMs: 30, retryMs: 40, maxAttempts: 3 }, () => {
      busyChecks += 1
      return busy
    })
    // 同步闸门（替代盲等 sleep）：isBusy 全仓只在探测 tick 内恰调一次
    // （keepalive.ts onTick），busyChecks ≥ 4 即全部 4 个刻度（30/70/110/150
    // = startMs + maxAttempts × retryMs）都已带着 busy=true 走完、判死刻度已
    // 零收束。盲等 sleep(150) 与判死 tick 同刻度——Node timers 相先于 poll，
    // sleep 解析后测试续体可能先于 tick 执行，busy 已翻 false → 判死误触发
    // （用例自身时序假设竞态，非实现缺陷）。
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const probe = setInterval(() => {
        if (busyChecks >= 4) { clearInterval(probe); resolve() }
        else if (Date.now() - t0 > 2000) {
          clearInterval(probe)
          reject(new Error(`busy 刻度未走完：isBusy 仅被调 ${busyChecks} 次（期望 ≥ 4）`))
        }
      }, 5)
    })
    expect(mud.probeState).toBe('idle')
    expect(mud.connected).toBe(true) // 判死刻度 busy → 零收束：连接未被硬收尾
    busy = false
    server.write('提示行\r\n') // 数据到达 = 活证明 → idle 锚重置（窗口重开）
    await server.waitFor('\xf6') // 新窗口自驱首发
    expect(mud.probeState).toBe('probing')
    await server.close()
  })

  it('应答行（带换行）被吞：不进 onLine，判活内部消化回 idle', async () => {
    const { mud, server } = await setup({ startMs: 50, retryMs: 50, maxAttempts: 3 })
    await waitProbing(mud)
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    server.write('[-Yes-]\r\n正常行\r\n')
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toEqual(['正常行']) // 应答行吞掉，正常行照常分发
    expect(mud.probeState).toBe('idle')
    await server.close()
  })

  it('应答行（无换行 + GA）主路径判活：GA 先到，行刷出仍吞', async () => {
    const { mud, server } = await setup({ startMs: 50, retryMs: 50, maxAttempts: 3 })
    await waitProbing(mud)
    const seen: string[] = []
    mud.onLine = l => { seen.push(l.text) }
    // 探针实测形态：[-Yes-] 无换行 + IAC GA 收尾（255,249）
    server.write(Buffer.concat([Buffer.from('[-Yes-]', 'utf8'), Buffer.from('fff9', 'hex')]))
    await new Promise(r => setTimeout(r, 50))
    expect(seen).toEqual([]) // 300ms 刷出的应答行仍被吞
    expect(mud.probeState).toBe('idle')
    await server.close()
  })

  it('判死：自驱全无应答 → 硬收尾（onDisconnect）', async () => {
    const { mud, server } = await setup({ startMs: 30, retryMs: 30, maxAttempts: 2 })
    let disconnects = 0
    mud.onDisconnect = () => { disconnects += 1 }
    await new Promise(r => setTimeout(r, 150)) // 30ms 首发 + 30ms 重发 + 30ms 判死
    expect(disconnects).toBe(1)
    expect(mud.probeState).toBe('idle')
    expect(mud.connected).toBe(false)
    await server.close()
  })

  it('手工 connect（幂等建连）取消在飞探测（建连后 state=idle）', async () => {
    const { mud, server } = await setup({ startMs: 50, retryMs: 50, maxAttempts: 3 })
    await waitProbing(mud)
    mud.connect('127.0.0.1', server.port) // 幂等建连也走取消点
    expect(mud.probeState).toBe('idle')
    await server.close()
  })

  it('手工 disconnect 取消在飞探测', async () => {
    const { mud, server } = await setup({ startMs: 50, retryMs: 50, maxAttempts: 3 })
    await waitProbing(mud)
    mud.disconnect()
    expect(mud.probeState).toBe('idle')
    await server.close()
  })
})
