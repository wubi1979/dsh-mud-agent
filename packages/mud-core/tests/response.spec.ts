/**
 * dsh-mud-core — 命令-应答桥 (CommandResponseController) 单元测试。
 *
 * 覆盖命令-应答桥 (`doc/ARCHITECTURE.md` §8) 的全部结算路径:
 *   GA/EOR 主边界 / until 声明边界 (跨帧) / 静默窗 / 超时 / 连续超时 reject /
 *   成功复位 / 无主边界转发 / 一步一帧 / head 帧首合并 / abort / 断线 close /
 *   序列命令 / fire-and-forget。
 * 行集表 (cacheLines/resolveLines) 已随 V10 行级化删除: T1 的渲染依据是
 * 感知引擎的命中队列 (§4/§7), 不再按文本还原行对象。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { MudLine } from '../src/preprocess/ansi.ts'
import {
  CommandResponseController,
  TIMEOUT_MARKER,
  SILENT_MARKER,
  type BoundaryKind,
  type ReplyOptions,
} from '../src/network/response.ts'

/** MudLine 构造 (测试用; abs 手工分配)。 */
function ml(text: string, abs = 0): MudLine {
  return { text, raw: text, style: [], abs, time: 0, isPrompt: false }
}

/** 测试宿主: 捕获 send/meta, 记录无主边界。 */
function harness() {
  const sent: { cmd: string; meta: { replyId?: string } }[] = []
  const boundaries: BoundaryKind[] = []
  const controller = new CommandResponseController({
    send: (cmd, meta) => { sent.push({ cmd, meta }) },
    onBoundary: (kind) => { boundaries.push(kind) },
  })
  return { controller, sent, boundaries }
}

/** 已发送且尚未 confirm 的 replyId (按命令文字查找)。 */
function replyIdOf(sent: { cmd: string; meta: { replyId?: string } }[], cmd: string): string | undefined {
  const item = sent.find(s => s.cmd === cmd)
  return item?.meta.replyId
}

describe('CommandResponseController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('未声明: GA 边界结算 (ok=true, settled=ga, 文本=纯帧)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look')
    const id = replyIdOf(h.sent, 'look')
    expect(id).toBeTruthy()
    h.controller.confirmSent(id)
    h.controller.feedLines([ml('北大街 - 北大侠客行')])
    h.controller.feedLines([ml('  这里明显的出口是 south 和 east。')])
    h.controller.boundaryReceived('ga')
    const reply = await p
    expect(reply.ok).toBe(true)
    expect(reply.settled).toBe('ga')
    expect(reply.cmd).toBe('look')
    expect(reply.text).toBe('北大街 - 北大侠客行\n  这里明显的出口是 south 和 east。')
    expect(reply.lines.map(l => l.text)).toEqual(['北大街 - 北大侠客行', '  这里明显的出口是 south 和 east。'])
  })

  it('未声明: EOR 边界结算', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('hp')
    h.controller.confirmSent(replyIdOf(h.sent, 'hp'))
    h.controller.feedLines([ml('气血 100/100')])
    h.controller.boundaryReceived('eor')
    const reply = await p
    expect(reply.settled).toBe('eor')
    expect(reply.ok).toBe(true)
  })

  it('声明 until: 跨帧不结算, 命中正则即 until 结算', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('fullme', {
      until: { regex: '[0-9]{4}', timeout: 300 },
    } satisfies ReplyOptions)
    h.controller.confirmSent(replyIdOf(h.sent, 'fullme'))
    // 第一帧: 未命中 → GA 不结算。
    h.controller.feedLines([ml('请回答如下验证码:')])
    h.controller.boundaryReceived('ga')
    let settled = false
    p.then(() => { settled = true })
    expect(settled).toBe(false)
    // 第二帧: 命中声明边界。
    h.controller.feedLines([ml('验证码: 8456')])
    h.controller.boundaryReceived('ga')
    const reply = await p
    expect(reply.settled).toBe('until')
    expect(reply.ok).toBe(true)
    expect(reply.text).toContain('8456')
  })

  it('P1-2: until 锚定整行正则跨帧命中 (多行累积文本上逐行测试)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('dz', {
      until: { regex: '^你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。$', timeout: 60 },
    })
    h.controller.confirmSent(replyIdOf(h.sent, 'dz'))
    // 第一帧: 受理行 (锚定正则不命中, GA 不结算)。
    h.controller.feedLines([ml('你盘膝坐下，默运太极神功，一股内息自丹田引出……')])
    h.controller.boundaryReceived('ga')
    let settled = false
    p.then(() => { settled = true })
    expect(settled).toBe(false)
    // 渐进推送行: 仍不命中。
    h.controller.feedLines([ml('你只觉内息在带脉内回荡……')])
    expect(settled).toBe(false)
    // 完成句到达 (无 GA) → 逐行测试命中 → 立即 until 结算。
    h.controller.feedLines([ml('你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。')])
    const reply = await p
    expect(reply.settled).toBe('until')
    expect(reply.ok).toBe(true)
  })

  it('静默窗: 最后一行到达后静默 silence 毫秒结算 (无标记剥离问题: 标记追加)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look', { silence: 20 })
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.feedLines([ml('房间描述...')])
    await vi.advanceTimersByTimeAsync(30)
    const reply = await p
    expect(reply.settled).toBe('silent')
    expect(reply.ok).toBe(true)
    expect(reply.text.endsWith(SILENT_MARKER)).toBe(true)
    expect(reply.text.startsWith('房间描述...')).toBe(true)
  })

  it('静默窗: 逐行到达会重置 (最后行后 20ms 才结算)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look', { silence: 20 })
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.feedLines([ml('一行')])
    await vi.advanceTimersByTimeAsync(15)
    h.controller.feedLines([ml('二行')])  // 重置静默窗
    await vi.advanceTimersByTimeAsync(15)
    let settled = false
    p.then(() => { settled = true })
    expect(settled).toBe(false)          // 距"二行"仅 15ms
    await vi.advanceTimersByTimeAsync(10)
    const reply = await p
    expect(reply.settled).toBe('silent')
    expect(reply.lines.map(l => l.text)).toEqual(['一行', '二行'])
  })

  it('超时: 未声明默认 10s, 逐请求可覆盖', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('dz', { timeout: 50 })
    h.controller.confirmSent(replyIdOf(h.sent, 'dz'))
    await vi.advanceTimersByTimeAsync(60)
    const reply = await p
    expect(reply.settled).toBe('timeout')
    expect(reply.ok).toBe(false)
    expect(reply.text.endsWith(TIMEOUT_MARKER)).toBe(true)
  })

  it('连续 3 次超时 → 第 3 次 promise reject (DSH 失败终态)', async () => {
    const h = harness()
    const run = (cmd: string) => {
      const p = h.controller.sendAndAwait(cmd, {
        until: { regex: '永不命中', timeout: 50 },
        timeout: 50,
      })
      h.controller.confirmSent(replyIdOf(h.sent, cmd))
      return p
    }
    const p1 = run('a')
    await vi.advanceTimersByTimeAsync(60)
    expect((await p1).settled).toBe('timeout')
    const p2 = run('b')
    await vi.advanceTimersByTimeAsync(60)
    expect((await p2).settled).toBe('timeout')
    const p3 = run('c')
    const rejection = p3.then(() => null, (e: Error) => e)  // 提前挂 catch: 防 unhandled
    await vi.advanceTimersByTimeAsync(60)
    const err = await rejection
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/连续 3 次应答超时/)
  })

  it('成功结算复位连续超时计数', async () => {
    const h = harness()
    const timeoutRun = (cmd: string) => {
      const p = h.controller.sendAndAwait(cmd, { timeout: 40 })
      h.controller.confirmSent(replyIdOf(h.sent, cmd))
      return p
    }
    const p1 = timeoutRun('a')
    await vi.advanceTimersByTimeAsync(50)
    expect((await p1).settled).toBe('timeout')   // 计数 1; orphanBoundaries = 1
    const okRun = h.controller.sendAndAwait('ok')
    h.controller.confirmSent(replyIdOf(h.sent, 'ok'))
    // P3-2: timeout 后迟到 GA 先被孤儿计数消费 (丢弃), 第二个 GA 才结算新帧。
    h.controller.boundaryReceived('ga')          // 孤儿 GA → 丢弃 (orphanBoundaries: 1→0)
    h.controller.boundaryReceived('ga')          // 真实 GA → 复位
    expect((await okRun).settled).toBe('ga')
    const p2 = timeoutRun('b')                   // 计数从 1 重新计
    await vi.advanceTimersByTimeAsync(50)
    expect((await p2).settled).toBe('timeout')   // 未达上限, 正常 resolve
  })

  it('P3-2: abort 后迟到 GA 不结算下一帧', async () => {
    const h = harness()
    const ac = new AbortController()
    const pa = h.controller.sendAndAwait('busy', { signal: ac.signal })
    h.controller.confirmSent(replyIdOf(h.sent, 'busy'))
    h.controller.feedLines([ml('忙碌中...')])
    ac.abort() // 中止 → settle abort; orphanBoundaries = 1
    expect((await pa).settled).toBe('abort')
    // 下一个命令
    const pb = h.controller.sendAndAwait('look')
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.feedLines([ml('北大街')])
    // 迟到 GA (从 'busy' 残留) → 应被孤儿计数消费, 不结算 'look'
    h.controller.boundaryReceived('ga')
    // 第二个 GA → 才结算 'look'
    h.controller.boundaryReceived('ga')
    expect((await pb).settled).toBe('ga')
  })

  it('P3-5: 帧行数超限强制 timeout', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('big')
    h.controller.confirmSent(replyIdOf(h.sent, 'big'))
    // 喂入 256 行 → 超限强制 timeout
    const bigBatch = Array.from({ length: 256 }, (_, i) => ml(`line ${i}`))
    h.controller.feedLines(bigBatch)
    expect((await p).settled).toBe('timeout')
  })

  it('无主: 无主行不登记 (投递归 L2), 无主边界转发 onBoundary', () => {
    const h = harness()
    h.controller.feedLines([ml('无主一行')])
    expect(h.controller.inFlight()).toBe(false)
    h.controller.boundaryReceived('ga')
    expect(h.boundaries).toEqual(['ga'])
  })

  it('一步一帧: A 武装期间 B 不发送, A 结算后才 pump B', async () => {
    const h = harness()
    const pa = h.controller.sendAndAwait('look')
    const pb = h.controller.sendAndAwait('hp')
    expect(h.sent.length).toBe(1)  // 仅 A 出队
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    expect(h.sent.length).toBe(1)  // B 仍未发送
    h.controller.feedLines([ml('北大街')])
    h.controller.boundaryReceived('ga')  // A 结算 → pump B
    await pa
    expect(h.sent.map(s => s.cmd)).toEqual(['look', 'hp'])
    expect(h.sent[1].meta.replyId).toBeTruthy()
    h.controller.confirmSent(replyIdOf(h.sent, 'hp'))
    h.controller.boundaryReceived('eor')
    expect((await pb).settled).toBe('eor')
  })

  it('武装前 (sending 窗) 到达的行归本帧, 且不会漏进下一帧 (曾经: 宿主另存帧首 → 重复)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look')
    // 队列节流窗口: 已调用 sendAndAwait、还没真实写出 socket —— 这些行属于本帧。
    h.controller.feedLines([ml('>')])
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.feedLines([ml('北大街')])
    h.controller.boundaryReceived('ga')
    const reply = await p
    expect(reply.lines.map(l => l.text)).toEqual(['>', '北大街'])
    expect(reply.text).toBe('>\n北大街')

    // 下一条命令的帧里绝不能出现上一帧的行 (实测 bug: look 的应答混进了旧行/MXP 文本)。
    const p2 = h.controller.sendAndAwait('inventory')
    h.controller.confirmSent(replyIdOf(h.sent, 'inventory'))
    h.controller.feedLines([ml('你身上带着:')])
    h.controller.boundaryReceived('ga')
    const reply2 = await p2
    expect(reply2.lines.map(l => l.text)).toEqual(['你身上带着:'])
  })

  it('abort 信号: 优雅结算 (settled=abort), 不悬挂', async () => {
    const h = harness()
    const ac = new AbortController()
    const p = h.controller.sendAndAwait('look', { signal: ac.signal })
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    ac.abort()
    const reply = await p
    expect(reply.settled).toBe('abort')
    expect(reply.ok).toBe(false)
    // abort 后在途清空; 之后到达的行不再归属任何请求 (投递归 L2)。
    h.controller.feedLines([ml('迟到')])
    expect(h.controller.inFlight()).toBe(false)
  })

  it('abort 于调用前: settled=abort 且不发命令 (信号已预先中止)', async () => {
    const h = harness()
    const ac = new AbortController()
    ac.abort()  // 先中止: sendAndAwait 应直接弹回, 不注册、不发送
    const p = h.controller.sendAndAwait('look', { signal: ac.signal })
    const reply = await p
    expect(reply.settled).toBe('abort')
    expect(h.sent.length).toBe(0)
  })

  it('close (断线): 在途请求 reject', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look')
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.close()
    await expect(p).rejects.toThrow(/连接已断开/)
    // 关闭后新请求直接 reject。
    await expect(h.controller.sendAndAwait('hp')).rejects.toThrow(/已关闭/)
  })

  it('P0-1: close (断线) 后 reset() 重开 → 新请求可正常结算 (重连复用)', async () => {
    const h = harness()
    const p1 = h.controller.sendAndAwait('look')
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    h.controller.close()
    await expect(p1).rejects.toThrow(/连接已断开/)
    await expect(h.controller.sendAndAwait('hp')).rejects.toThrow(/已关闭/)

    h.controller.reset()  // connect 事件重开控制器 (close 为终止语义, 必须 reset)。
    const p2 = h.controller.sendAndAwait('north')
    h.controller.confirmSent(replyIdOf(h.sent, 'north'))
    h.controller.feedLines([ml('北大街')])
    h.controller.boundaryReceived('ga')
    const reply = await p2
    expect(reply.ok).toBe(true)
    expect(reply.settled).toBe('ga')
  })

  it('P0-2: sendFailed 回执 → 在途 sending 请求 reject (发送失败), 桥恢复可用', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look')
    const id = replyIdOf(h.sent, 'look')
    expect(id).toBeTruthy()
    // 宿主写 socket 失败: 回执 settle error → 工具 throw (回合 error)。
    const rejection = p.then(() => null, (e: Error) => e)  // 提前挂 catch: 防 unhandled
    h.controller.sendFailed(id, '写 socket 失败: look')
    const err = await rejection
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/写 socket 失败/)
    // 桥恢复: 后续请求正常结算 (pump 已续跑)。
    const p2 = h.controller.sendAndAwait('hp')
    h.controller.confirmSent(replyIdOf(h.sent, 'hp'))
    h.controller.feedLines([ml('气血 100/100')])
    h.controller.boundaryReceived('eor')
    expect((await p2).settled).toBe('eor')
  })

  it('P0-2: pump 发送守卫 — 超窗未 confirmSent 武装 → settle error (防 sending 死锁)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('look', { timeout: 50 })
    expect(replyIdOf(h.sent, 'look')).toBeTruthy()
    // 宿主不 confirmSent: 守卫兜底 settle error。
    const rejection = p.then(() => 'resolved', (e: Error) => e)
    await vi.advanceTimersByTimeAsync(60)
    const err = await rejection
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/发送后未确认武装/)
    // pump 恢复: 后续请求照常结算。
    const p2 = h.controller.sendAndAwait('hp')
    h.controller.confirmSent(replyIdOf(h.sent, 'hp'))
    h.controller.boundaryReceived('ga')
    expect((await p2).settled).toBe('ga')
  })

  it('超时结算: 帧行随 MudReply.lines 返回 (T1 不再按文本反查行集表)', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait('dz', { timeout: 40 })
    h.controller.confirmSent(replyIdOf(h.sent, 'dz'))
    h.controller.feedLines([ml('你开始打坐'), ml('你一无所获。')])
    await vi.advanceTimersByTimeAsync(50)
    const reply = await p
    expect(reply.settled).toBe('timeout')
    expect(reply.lines.map(l => l.text)).toEqual(['你开始打坐', '你一无所获。'])
  })

  it('序列命令: 逐条发送同 replyId, confirmSent 幂等', async () => {
    const h = harness()
    const p = h.controller.sendAndAwait(['', 'look'])  // 序列里的空命令成员 (允许; 语义由调用方定)
    expect(h.sent.map(s => s.cmd)).toEqual(['', 'look'])
    const id = replyIdOf(h.sent, 'look')
    expect(id).toBeDefined()
    h.controller.confirmSent(id)
    h.controller.confirmSent(id)   // 幂等: 第二次无操作
    h.controller.feedLines([ml('北大街')])
    h.controller.boundaryReceived('ga')
    const reply = await p
    expect(reply.cmd).toBe('命令序列')
    expect(reply.settled).toBe('ga')
  })

  it('sendFireForget: 不入应答机制, 直发', async () => {
    const h = harness()
    h.controller.sendFireForget('north', { priority: 'high' })
    expect(h.sent.map(s => s.cmd)).toEqual(['north'])
    expect(h.sent[0].meta).toEqual({ priority: 'high' })  // 无 replyId
  })

  it('inFlight: 注册/武装/空态判定 (宿主观察窗推迟依据)', async () => {
    const h = harness()
    expect(h.controller.inFlight()).toBe(false)
    const p = h.controller.sendAndAwait('look')
    expect(h.controller.inFlight()).toBe(true)   // 已发送待武装
    h.controller.confirmSent(replyIdOf(h.sent, 'look'))
    expect(h.controller.inFlight()).toBe(true)   // 武装等待
    h.controller.boundaryReceived('ga')
    await p
    expect(h.controller.inFlight()).toBe(false)
  })
})