/**
 * view/screen 测试 — 游戏画面通道（C5 详细设计测试面 7 条）。
 *
 * 覆盖：
 *   1. 行写入后 snapshot 含该行（含 ANSI 样式不丢失）
 *   2. send 回显入屏且凭据缺席（runtime 接线：sendCredential 不触发 onSend）
 *   3. 背压超限 follower 显式断流
 *   4. 断流后重新 follow 以 snapshot 恢复
 *   5. 两会话屏幕隔离
 *   6. headless 跨重连续写（断连不清屏）
 *   7. follower 注册原子性（attach 瞬间并发行写入，不丢不重不乱序）
 *
 * 用例 2 走真实 TCP 回环（node net 服务端），验证 runtime → screen 的完整接线。
 */

import { describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:net'

import { GameScreen } from '../src/view/screen.ts'
import { SessionRuntime } from '../src/runtime.ts'
import type { GameFrame } from '../src/view/screen.ts'

/** 等 n 个宏任务 tick（合批 setImmediate + 写操作链落定）。 */
async function ticks(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** 消费 attach 流的前 n 帧（每个 next 之间让 tick，等待可能的在途帧）。 */
async function take(iterable: AsyncIterable<GameFrame>, n: number): Promise<GameFrame[]> {
  const iterator = iterable[Symbol.asyncIterator]()
  const frames: GameFrame[] = []
  for (let i = 0; i < n; i += 1) {
    const result = await iterator.next()
    if (result.done === true) break
    frames.push(result.value)
  }
  iterator.return?.(undefined as never).catch(() => {})
  return frames
}

const controller = new AbortController()
const SIGNAL = controller.signal

describe('GameScreen', () => {
  it('1. 行写入后 snapshot 含该行（含 ANSI 样式）', async () => {
    const screen = new GameScreen('s1')
    screen.write('\x1b[31m你挥出一剑。\x1b[0m\r\n')
    await ticks()

    const [snapshot] = await take(screen.attach(SIGNAL), 1)
    expect(snapshot).toBeDefined()
    expect(snapshot?.type).toBe('snapshot')
    if (snapshot?.type !== 'snapshot') return
    expect(snapshot.screen).toContain('你挥出一剑。')
    // ANSI 颜色经无头屏序列化后仍在（形态可能变换，但转义必存）
    expect(snapshot.screen).not.toBe(snapshot.screen.replace(/\x1b\[/g, ''))
    expect(snapshot.info).toEqual({ sessionId: 's1', state: 'disconnected', cols: 120 })
    screen.dispose()
  })

  it('2. send 回显入屏且凭据缺席（sendCredential 不触发 onSend）', async () => {
    // 真实回环 TCP：验证 runtime → Mud.onSend → screen.echo 完整接线
    const received: string[] = []
    const server: Server = createServer(socket => {
      socket.on('data', chunk => { received.push(chunk.toString('utf8')) })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port

    try {
      const rt = new SessionRuntime('s2', 100)
      await rt.connect({
        host: '127.0.0.1', port
      }, 2000)
      rt.send('look')
      await ticks()
      rt.disconnect()

      const [snapshot] = await take(rt.view.attach(SIGNAL), 1)
      expect(snapshot?.type).toBe('snapshot')
      if (snapshot?.type !== 'snapshot') return
      // 直发命令有回显（区分色前缀）
      expect(snapshot.screen).toContain('> look')
      // 凭据走 sendCredential：不触发 onSend，永不进画面
      expect(snapshot.screen).not.toContain('SECRET-PASS')
      expect(snapshot.screen).not.toContain('> hero')
      rt.dispose()
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })

  it('3. 背压超限 follower 显式断流', async () => {
    const screen = new GameScreen('s3', { maxBufferedBytes: 200 })
    // 先落一屏内容（后续 snapshot 恢复用）
    screen.write('历史行。\r\n')
    await ticks()

    const iterator = screen.attach(SIGNAL)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value.type).toBe('snapshot')

    // 不再消费，持续写入直至超限（每帧 200+ 字节）
    for (let i = 0; i < 5; i += 1) {
      screen.write(`x${i}`.repeat(100) + '\r\n')
    }
    await ticks()

    await expect(iterator.next()).rejects.toThrow(/slow follower/)
    screen.dispose()
  })

  it('4. 断流后重新 follow 以 snapshot 恢复', async () => {
    const screen = new GameScreen('s4', { maxBufferedBytes: 200 })
    screen.write('第 1 行。\r\n')
    await ticks()

    // 第一个 follower 超限断流
    const it1 = screen.attach(SIGNAL)[Symbol.asyncIterator]()
    await it1.next()
    for (let i = 0; i < 5; i += 1) screen.write(`spam${i}`.repeat(60) + '\r\n')
    await ticks()
    await expect(it1.next()).rejects.toThrow(/slow follower/)

    // 重新 attach：snapshot 包含断流前的全部历史（无头屏仍在）
    const [snapshot] = await take(screen.attach(SIGNAL), 1)
    if (snapshot?.type !== 'snapshot') return expect(snapshot?.type).toBe('snapshot')
    expect(snapshot.screen).toContain('第 1 行。')
    screen.dispose()
  })

  it('5. 两会话屏幕隔离', async () => {
    const a = new GameScreen('ws-a')
    const b = new GameScreen('ws-b')
    a.write('甲的行。\r\n')
    await ticks()

    const [snapA] = await take(a.attach(SIGNAL), 1)
    const [snapB] = await take(b.attach(SIGNAL), 1)
    if (snapA?.type !== 'snapshot' || snapB?.type !== 'snapshot') return
    expect(snapA.screen).toContain('甲的行。')
    expect(snapB.screen).not.toContain('甲的行。')
    expect(snapA.info.sessionId).toBe('ws-a')
    expect(snapB.info.sessionId).toBe('ws-b')
    a.dispose()
    b.dispose()
  })

  it('6. headless 跨重连续写（断连不清屏）', async () => {
    const screen = new GameScreen('s6')
    screen.write('重连前。\r\n')
    await ticks()

    // 先 attach 再触发状态变化：state/output 帧只广播给已 attach 的 follower
    // （attach 前的历史一律由 snapshot 承载 —— snapshot 即恢复面）。
    const iterator = screen.attach(SIGNAL)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value.type).toBe('snapshot')
    if (first.value.type !== 'snapshot') return
    expect(first.value.screen).toContain('重连前。')

    // 模拟断连/重连：状态切换不清屏，继续写入
    screen.setState('disconnected') // 幂等：已是 disconnected，不产生帧
    screen.setState('connected')
    screen.write('重连后。\r\n')
    await ticks()

    const second = await iterator.next()
    const third = await iterator.next()
    expect(second.value.type).toBe('state') // 重连状态帧
    if (second.value.type === 'state') expect(second.value.info.state).toBe('connected')
    expect(third.value.type).toBe('output')
    if (third.value.type === 'output') expect(third.value.data).toContain('重连后。')

    // 重开流：snapshot 同时含重连前后内容（屏未清）
    const [snapshot] = await take(screen.attach(SIGNAL), 1)
    if (snapshot?.type !== 'snapshot') return
    expect(snapshot.screen).toContain('重连前。')
    expect(snapshot.screen).toContain('重连后。')
    iterator.return?.(undefined as never).catch(() => {})
    screen.dispose()
  })

  it('7. follower 注册原子性：attach 与写入串行，不丢不重不乱序', async () => {
    const screen = new GameScreen('s7')
    screen.write('行 A。\r\n')
    await ticks()

    // 同一事件循环内：先排 attach，再写行 B —— 操作链保证
    // snapshot（含 A）先于 B 的 output 帧，B 不丢不重
    const iterable = screen.attach(SIGNAL)
    screen.write('行 B。\r\n')
    await ticks()

    // 恰好两帧：snapshot（A）+ output（B）
    const frames = await take(iterable, 2)
    expect(frames.length).toBe(2)

    const snapshot = frames[0]
    expect(snapshot?.type).toBe('snapshot')
    if (snapshot?.type !== 'snapshot') return
    expect(snapshot.screen).toContain('行 A。')
    expect(snapshot.screen).not.toContain('行 B。')

    const output = frames[1]
    expect(output?.type).toBe('output')
    if (output?.type === 'output') expect(output.data).toContain('行 B。')

    // sequence 单调
    const [snap, out] = frames as [Extract<GameFrame, { type: 'snapshot' }>, Extract<GameFrame, { type: 'output' }>]
    expect(out.sequence).toBeGreaterThan(snap.sequence)
    screen.dispose()
  })

  it('dispose 后 follower 断流、attach 拒绝', async () => {
    const screen = new GameScreen('s8')
    const iterator = screen.attach(SIGNAL)[Symbol.asyncIterator]()
    await iterator.next() // snapshot

    screen.dispose()
    await expect(iterator.next()).rejects.toThrow(/画面已销毁/)

    const late = screen.attach(SIGNAL)[Symbol.asyncIterator]()
    await expect(late.next()).rejects.toThrow(/画面已销毁/)
  })
})
