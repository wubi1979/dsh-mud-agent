/**
 * dsh-mud-core — 在途窗口表 (InflightWindowTable) 单元测试 (W7.2)。
 *
 * 取代旧命令-应答桥 (CommandResponseController) 的 response.spec。机制对照
 * `doc/architecture/07-08-t1-bridge.md` §8.3/§8.4:
 *   - 注册 → pump 发送 (meta.replyId/noGate 穿透) → 宿主 confirmSent 武装 →
 *     判据命中 (win- 标记路由) / N-GA 关窗 / 超时 / abort / 断线 → 结算 (I4 必有结局);
 *   - 结算优先级: 判据命中 > 窗口关闭 (N-GA) > 超时 > 断线;
 *   - 无回看 (W10.2 A2): sending 期不吸收, span = confirmSent 水位之后的行;
 *   - 直发延后 (§8.3/I12): 窗口开启 ⇒ 队列 gate 压住非豁免直发 (noGate/halt 豁免)。
 *
 * 裁决器站③的接线 (feedLines / boundary / settleCriteria) 在测试里按宿主身份直调 ——
 * 与生产 `SessionAdjudicator.adjudicate()` 的三行路由一致。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InflightWindowTable,
  ABORT_TEXT,
  type WindowResult,
} from '../src/agent/inflight.ts'
import { CommandQueue } from '../src/agent/queue.ts'
import type { MudLine } from '../src/network/ansi.ts'

function ml(text: string): MudLine {
  return { text, raw: text, style: [], abs: 0, time: Date.now(), isPrompt: false }
}

/** ml 的带 abs 版本 (W10.2 span 测试用; abs 单调递增模拟裁决器行流水位)。 */
function mlAbs(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 宿主接线采样 (send/armed/disarmed/gate/logs)。 */
interface Harness {
  windows: InflightWindowTable
  sent: { cmd: string; meta: { replyId?: string; noGate?: boolean; priority?: 'halt' | 'high' | 'normal' | 'low' } }[]
  armed: { id: string; pattern: string | RegExp }[]
  disarmed: string[]
  gates: boolean[]
  logs: string[]
}

function makeTable(opts: { defaultTimeoutMs?: number; absWatermark?: () => number } = {}): Harness {
  const h: Harness = { sent: [], armed: [], disarmed: [], gates: [], logs: [] } as never
  h.windows = new InflightWindowTable({
    send: (cmd, meta) => { h.sent.push({ cmd, meta }) },
    onArm: (id, pattern) => { h.armed.push({ id, pattern }) },
    onDisarm: (id) => { h.disarmed.push(id) },
    onGate: (active) => { h.gates.push(active) },
    onLog: (text) => { h.logs.push(text) },
    ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
    ...(opts.absWatermark !== undefined ? { absWatermark: opts.absWatermark } : {}),
  })
  return h
}

describe('在途窗口表 (InflightWindowTable; W7.2 取代命令-应答桥)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('窗口型: 注册→发送(replyId/noGate)→confirmSent→GA 关窗 = 成功 (窗口行 = 工具结果)', async () => {
    const h = makeTable()
    // 声明才计 GA (PLAN §D3): GA 关窗必须显式声明 gaCount。
    const p = h.windows.register({ cmds: ['look'], label: 'mud_look', gaCount: 1 })
    expect(h.sent).toEqual([{ cmd: 'look', meta: { replyId: 'w1', noGate: true } }])
    expect(h.gates).toEqual([true])   // 窗口开启 → 直发延后 gate (§2.8)
    h.windows.confirmSent('w1')
    h.windows.feedLines([ml('北大街 - 北大侠客行'), ml('这里明显的出口是 south。')])
    h.windows.boundary('ga')
    const r: WindowResult = await p
    expect(r.ok).toBe(true)
    expect(r.cmd).toBe('look')
    expect(r.settled).toBe('ga')
    expect(r.text).toContain('北大街')
    // 排空后 gate 放行。
    expect(h.gates.at(-1)).toBe(false)
  })

  it('**关闭触发** (形态 C): win-<n>:close 命中即关窗 —— settled=evidence, 不解释内容', async () => {
    const h = makeTable()
    // 关闭触发只回答"窗口何时关闭"; 不判类 (无 criteria)。
    const p = h.windows.register({ cmds: ['fullme'], closeOn: /精神一振/, timeoutMs: 5_000 })
    h.windows.confirmSent('w1')
    // 武装一个关闭触发器 (区别于类标记 win-<n>:ok/:fail/:branch:<id>)。
    expect(h.armed.map(a => a.id)).toEqual(['win-1:close'])
    h.windows.feedLines([mlAbs('你突然感到精神一振，浑身似乎又充满了力量！', 6)])
    h.windows.settleCriteria('win-1:close')
    const r = await p
    expect(r.settled).toBe('evidence')   // 与 GA **同形不同名**
    expect(r.ok).toBe(true)
    expect(r.hit).toBeUndefined()        // 不携带分类
    expect(r.outcome).toBeUndefined()
    expect(r.hitText).toBeUndefined()
    expect(r.text).toContain('精神一振')
    expect(h.disarmed).toContain('win-1:close')
  })

  it('无回看 (W10.2 A2): sending 期不吸收; span = confirmSent 水位之后的行', async () => {
    const h = makeTable({ absWatermark: () => 5 })
    const p = h.windows.register({ cmds: ['look'], gaCount: 1 })
    // 还没 confirmSent (sending): 行不吸收 —— 命令发出前已在缓冲的行不进窗口。
    h.windows.feedLines([mlAbs('命令发出前已在缓冲的行', 4)])
    h.windows.confirmSent('w1')   // spanStartAbs = 5
    // armed 后喂入: abs ≤ 5 是命令发出前的行 (不进 span), abs > 5 才算本步应答。
    h.windows.feedLines([mlAbs('前置噪声行', 5), mlAbs('look 应答行', 6)])
    h.windows.boundary('ga')
    const r = await p
    expect(r.text).toBe('look 应答行')
    expect(r.span).toEqual({ fromAbs: 6, toAbs: 6 })
  })

  it('N-GA 边界: gaCount 2 需两次 GA 才关窗', async () => {
    const h = makeTable()
    const p = h.windows.register({ cmds: ['follow x'], gaCount: 2 })
    h.windows.confirmSent('w1')
    h.windows.boundary('ga')
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    h.windows.boundary('ga')
    await expect(p).resolves.toMatchObject({ ok: true, settled: 'ga' })
  })

  it('命令序列: 同一 replyId 逐条穿透; 显式 gaCount = 命令条数', async () => {
    const h = makeTable()
    const p = h.windows.register({ cmds: ['', 'look'], gaCount: 2 })
    expect(h.sent.map(s => s.cmd)).toEqual(['', 'look'])
    expect(h.sent.every(s => s.meta.replyId === 'w1' && s.meta.noGate === true)).toBe(true)
    h.windows.confirmSent('w1')
    h.windows.boundary('ga')
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)   // gaCount 2, 第一次 GA 不关窗
    h.windows.boundary('ga')
    await expect(p).resolves.toMatchObject({ ok: true, cmd: '命令序列' })
  })

  it('声明才计 GA (PLAN §D3): 未声明 gaCount 的窗口, GA 到达不关窗', async () => {
    const h = makeTable()
    const p = h.windows.register({ cmds: ['look'], timeoutMs: 5_000 })
    h.windows.confirmSent('w1')
    h.windows.boundary('ga')
    h.windows.boundary('ga')
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)                       // GA 不关窗
    expect(h.windows.diag().open!.gaCount).toBeNull() // 未声明 = null
    await vi.advanceTimersByTimeAsync(5_001)          // 只由 fallback 收口
    await expect(p).resolves.toMatchObject({ settled: 'timeout' })
  })

  it('settleCriteria: 非 win- 标记 / 非 close 类 / 非本窗 id → 无操作 (自过滤)', async () => {
    const h = makeTable()
    const p = h.windows.register({ cmds: ['dz'], closeOn: /站了起来/, timeoutMs: 5_000 })
    h.windows.confirmSent('w1')
    h.windows.settleCriteria('rule-int:xyz')   // 非 win- 标记
    h.windows.settleCriteria('win-9:close')    // id 不匹配
    h.windows.settleCriteria('win-1:ok')       // 已删除的类标记 → 不认
    let settled = false
    void p.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    h.windows.settleCriteria('win-1:close')
    await expect(p).resolves.toMatchObject({ ok: true, settled: 'evidence' })
  })

  it('兜底到期 (PLAN §D4 定案 A): resolve 带回已累积内容 (状态仍 timeout); 连续 3 次 → reject', async () => {
    const h = makeTable({ absWatermark: () => 0 })
    const p1 = h.windows.register({ cmds: ['a'], timeoutMs: 50 })
    h.windows.confirmSent('w1')
    h.windows.feedLines([mlAbs('第一行', 1), mlAbs('第二行', 2)])
    await vi.advanceTimersByTimeAsync(51)
    const r1 = await p1
    // 状态仍 timeout (不属于 ok/fail), 但**内容带回** —— T2 裸调用据此自读批内容决策。
    expect(r1).toMatchObject({ ok: false, settled: 'timeout' })
    expect(r1.text).toBe('第一行\n第二行')
    expect(r1.lines.map(l => l.text)).toEqual(['第一行', '第二行'])
    // 连续放弃计数: 非超时结算前累计; 第 3 次 → reject (DSH 失败终态)。
    const p2 = h.windows.register({ cmds: ['b'], timeoutMs: 50 })
    h.windows.confirmSent('w2')
    await vi.advanceTimersByTimeAsync(51)
    await expect(p2).resolves.toMatchObject({ settled: 'timeout' })
    const p3 = h.windows.register({ cmds: ['c'], timeoutMs: 50 })
    h.windows.confirmSent('w3')
    // 先挂 reject 断言再推进计时器: reject 在计时器 tick 内同步发生, 后挂 handler
    // 会被 Node 记一次 unhandled rejection (污染运行 → 红名单漂移根因)。
    const p3Rejects = expect(p3).rejects.toThrow(/连续 3 次应答超时/)
    await vi.advanceTimersByTimeAsync(51)
    await p3Rejects
  })

  it('非超时结算复位连续放弃计数', async () => {
    const h = makeTable()
    const p1 = h.windows.register({ cmds: ['a'], timeoutMs: 50 })
    h.windows.confirmSent('w1')
    await vi.advanceTimersByTimeAsync(51)
    await p1
    const p2 = h.windows.register({ cmds: ['b'], gaCount: 1 })
    h.windows.confirmSent('w2')
    h.windows.boundary('ga')   // 非超时结算 → 计数复位
    await p2
    const p3 = h.windows.register({ cmds: ['c'], timeoutMs: 50 })
    h.windows.confirmSent('w3')
    await vi.advanceTimersByTimeAsync(51)
    await expect(p3).resolves.toMatchObject({ settled: 'timeout' })   // 只放弃 1 次, 不 reject
  })

  it('abort: 注册前已中止 → 不发送直接结算; 在途中止 → 优雅结算 (窗口行保留)', async () => {
    const h = makeTable()
    const preAborted = new AbortController()
    preAborted.abort()
    const p1 = h.windows.register({ cmds: ['look'], signal: preAborted.signal })
    await expect(p1).resolves.toMatchObject({ ok: false, settled: 'abort', text: ABORT_TEXT })
    expect(h.sent).toHaveLength(0)   // 不发命令

    const ac = new AbortController()
    const p2 = h.windows.register({ cmds: ['look'], signal: ac.signal })
    h.windows.confirmSent('w1')
    h.windows.feedLines([ml('部分应答')])
    ac.abort()
    const r = await p2
    expect(r.settled).toBe('abort')
    expect(r.lines.map(l => l.text)).toEqual(['部分应答'])
  })

  it('断线 close(): 在途 reject (error) → 表终止 (register reject); reset() 重开', async () => {
    const h = makeTable()
    const p1 = h.windows.register({ cmds: ['look'] })
    h.windows.close()
    await expect(p1).rejects.toThrow(/连接已断开/)
    await expect(h.windows.register({ cmds: ['look'] })).rejects.toThrow(/已关闭/)
    // 重连复位: 终止语义解除, 窗口 id 序号延续 (w2)。
    h.windows.reset()
    const p2 = h.windows.register({ cmds: ['look'], gaCount: 1 })
    h.windows.confirmSent('w2')
    h.windows.boundary('ga')
    await expect(p2).resolves.toMatchObject({ ok: true })
  })

  it('sendFailed → error 结算 (pump 恢复, gate 放行)', async () => {
    const h = makeTable()
    const p = h.windows.register({ cmds: ['look'] })
    h.windows.sendFailed('w1', '写 socket 失败: look')
    await expect(p).rejects.toThrow('写 socket 失败')
    expect(h.gates.at(-1)).toBe(false)
  })

  it('发送守卫: confirmSent 迟迟不调 → defaultTimeoutMs 后 error 结算 (防 sending 死锁)', async () => {
    const h = makeTable({ defaultTimeoutMs: 1000 })
    const p = h.windows.register({ cmds: ['look'] })
    // 先挂 reject 断言再推进计时器 (理由同上: reject 在计时器 tick 内同步发生)。
    const pRejects = expect(p).rejects.toThrow(/未确认武装/)
    await vi.advanceTimersByTimeAsync(1001)
    await pRejects
  })

  it('interrupt(): 在途+排队全部结算 interrupted; gate 释放; 表继续可用', async () => {
    const h = makeTable()
    const p1 = h.windows.register({ cmds: ['a'] })
    const p2 = h.windows.register({ cmds: ['b'] })   // live 在途 → 排队
    const n = h.windows.interrupt('[流程打断] test')
    expect(n).toBe(2)
    await expect(p1).resolves.toMatchObject({ ok: false, settled: 'interrupted', text: '[流程打断] test' })
    await expect(p2).resolves.toMatchObject({ ok: false, settled: 'interrupted' })
    expect(h.gates.at(-1)).toBe(false)
    // 批量结算不泄漏下一个窗口 (旧桥 interruptInFlight 的缺陷, 此处钉住): 打断后
    // 注册的新窗口正常走完。
    const p3 = h.windows.register({ cmds: ['c'], gaCount: 1 })
    expect(h.sent.filter(s => s.cmd === 'c')).toHaveLength(1)
    h.windows.confirmSent('w3')
    h.windows.boundary('ga')
    await expect(p3).resolves.toMatchObject({ ok: true })
  })

  it('diag/hasOpen: 在途窗口 / 人工等待 / 结局计数 (§2.9 取代旧桥活动表)', async () => {
    const h = makeTable()
    expect(h.windows.hasOpen()).toBe(false)
    const p = h.windows.register({ cmds: ['look'], label: 'mud_look', gaCount: 1 })
    expect(h.windows.hasOpen()).toBe(true)
    h.windows.beginHuman('mud_captcha')
    let d = h.windows.diag()
    expect(d.open).toMatchObject({ tool: 'mud_look', trigger: null, gaCount: 1, gaSeen: 0, status: 'sending' })
    expect(d.human).toMatchObject({ label: 'mud_captcha' })
    h.windows.endHuman()
    expect(h.windows.diag().human).toBeNull()
    h.windows.confirmSent('w1')
    expect(h.windows.diag().open!.status).toBe('armed')
    h.windows.boundary('ga')
    await p
    d = h.windows.diag()
    expect(d.open).toBeNull()
    expect(d.pending).toBe(0)
    expect(d.counters).toMatchObject({ ok: 1 })
  })

  it('§2.8 直发延后: 窗口开启期间普通直发被压住, noGate/halt 豁免, 结算后放行', async () => {
    // 集成用例: CommandQueue + InflightWindowTable (生产 session.ts 的接线同款)。
    const sentToSocket: string[] = []
    const queue = new CommandQueue({ minInterval: 0, onSend: (cmd) => { sentToSocket.push(cmd) } })
    const windows = new InflightWindowTable({
      send: (cmd, meta) => { queue.send(cmd, { ...meta }) },
      onArm: () => {},
      onDisarm: () => {},
      onGate: (active) => { queue.setGate(active) },
    })
    const p = windows.register({ cmds: ['follow x'], gaCount: 1 })
    await vi.advanceTimersByTimeAsync(5)   // pump → 队列 (noGate 豁免) → 写 socket
    windows.confirmSent('w1')
    expect(sentToSocket).toEqual(['follow x'])
    // 窗口开启期间: 普通直发被 gate 压住。
    queue.send('hp')
    queue.send('look')
    await vi.advanceTimersByTimeAsync(50)
    expect(sentToSocket).toEqual(['follow x'])
    // halt 豁免 (打断命令必须走得出去, §2.8)。
    queue.send('halt', { priority: 'halt' })
    await vi.advanceTimersByTimeAsync(5)
    expect(sentToSocket).toEqual(['follow x', 'halt'])
    // 结算 → gate 放行, 压住的直发按到达序发出 (GA 计数不再被直发应答污染)。
    windows.boundary('ga')
    await p
    await vi.advanceTimersByTimeAsync(50)
    expect(sentToSocket).toEqual(['follow x', 'halt', 'hp', 'look'])
  })
})
