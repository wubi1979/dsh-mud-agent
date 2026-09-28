/**
 * deliver 测试 — 聚合投递 + 接入闸门 + 水位 + 零工具。
 *
 * 测试覆盖（§4 验收表的 C3 断言）：
 *   - 接入后：行流以用户消息投递进会话（端到端：行到达 → 聚合 → deliver 回调）
 *   - 未接入：零投递（行流照常积累 = 录制）
 *   - 停止接入：零投递（行流照常积累）
 *   - 水位 = 接入时刻：接入前的积压不回放
 *   - 静默窗口聚合：一批 = 一条消息（非逐行）
 *   - 最长等待：行流持续不静默也在上限内投出
 *   - 超 maxLines / maxChars：拆成多条依次投递（不丢行）
 *   - 缓冲上限：未接入时不无界增长，超出丢最旧并回调 onDrop
 *   - agent 离线（deliver 返回 false）：批次保留，唤醒后 flushNow 补投
 *   - 两会话各投各的（互不串线）
 */

import { describe, expect, it } from 'vitest'
import { Deliverer } from '../src/deliver.ts'
import type { MudLine } from '../src/link/line.ts'

// ── 工具：构造 MudLine ──────────────────────────────────────────

function line(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

// ── 测试 ──────────────────────────────────────────────────────

describe('Deliverer 接入闸门', () => {
  it('未接入：行流到达只积累，零投递', () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    // 未 admit，行流只积累
    d.onLine(line('第一行', 0))
    d.onLine(line('第二行', 1))
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(2)
    d.dispose()
  })

  it('接入后：静默窗口到期投递一条消息', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    d.onLine(line('欢迎', 0))
    d.onLine(line('来到', 1))
    // 等静默窗口
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('欢迎\n来到')
    d.dispose()
  })

  it('停止接入后：零投递，行流照常积累', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    d.onLine(line('接入期行', 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)

    d.stop()
    d.onLine(line('停止后行', 1))
    await new Promise(r => setTimeout(r, 100))
    // 停止后不再投递
    expect(delivered).toHaveLength(1)
    d.dispose()
  })

  it('水位 = 接入时刻：接入前的积压不回放', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    // 接入前行流到达（积压）
    d.onLine(line('积压行1', 0))
    d.onLine(line('积压行2', 1))
    expect(d.pendingCount).toBe(2)

    // 接入（水位 = 当前时刻，积压清空）
    d.admit()
    expect(d.pendingCount).toBe(0) // 积压不回放

    // 接入后新行才投递
    d.onLine(line('新行', 2))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('新行')
    d.dispose()
  })
})

describe('Deliverer 聚合行为', () => {
  it('静默窗口聚合：一批行 = 一条消息（非逐行）', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    // 快速连续到达（一个静默窗口内）
    d.onLine(line('A', 0))
    d.onLine(line('B', 1))
    d.onLine(line('C', 2))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('A\nB\nC')
    d.dispose()
  })

  it('两批行 = 两条消息（静默窗口分隔）', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    d.onLine(line('第一批', 0))
    await new Promise(r => setTimeout(r, 100)) // 等静默到期
    d.onLine(line('第二批', 1))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toBe('第一批')
    expect(delivered[1]).toBe('第二批')
    d.dispose()
  })

  it('截断护栏：超长消息截断', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, {
      quietMs: 50,
      maxChars: 20,
    })
    d.admit()
    d.onLine(line('这是一段很长的内容'.repeat(5), 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.length).toBeLessThanOrEqual(30) // 20 + 截断标记
    expect(delivered[0]).toContain('截断')
    d.dispose()
  })

  it('超 maxLines：拆成多条依次投递，不丢行', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, {
      quietMs: 50,
      maxLines: 3,
    })
    d.admit()
    d.onLine(line('1', 0))
    d.onLine(line('2', 1))
    d.onLine(line('3', 2))
    d.onLine(line('4', 3))
    d.onLine(line('5', 4))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['1\n2\n3', '4\n5'])
    d.dispose()
  })

  it('超 maxChars：拆成多条依次投递，不丢行', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, {
      quietMs: 50,
      maxChars: 10,
    })
    d.admit()
    d.onLine(line('aaaa', 0))
    d.onLine(line('bbbb', 1))
    d.onLine(line('cccc', 2))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['aaaa\nbbbb', 'cccc'])
    d.dispose()
  })

  it('行流持续不静默：最长等待到期仍强制投出', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, {
      quietMs: 500,
      maxWaitMs: 120,
    })
    d.admit()
    const ticker = setInterval(() => d.onLine(line('刷屏', 0)), 30)
    await new Promise(r => setTimeout(r, 260))
    clearInterval(ticker)
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    d.dispose()
  })

  it('未接入时缓冲有上限：超出丢最旧并回调 onDrop', () => {
    const drops: [number, number][] = []
    const d = new Deliverer('s1', () => {}, {
      quietMs: 50,
      maxPendingLines: 3,
      onDrop: (_id, droppedNow, droppedTotal) => { drops.push([droppedNow, droppedTotal]) },
    })
    for (const [i, t] of ['1', '2', '3', '4', '5'].entries()) d.onLine(line(t, i))
    expect(d.pendingCount).toBe(3)
    expect(d.droppedLineCount).toBe(2)
    expect(drops).toEqual([[1, 1], [1, 2]])
    d.dispose()
  })

  it('agent 离线（deliver 返回 false）：批次保留，flushNow 补投', async () => {
    const delivered: string[] = []
    let online = false
    const d = new Deliverer('s1', (_id, text) => {
      if (!online) return false
      delivered.push(text)
      return true
    }, { quietMs: 50 })
    d.admit()
    d.onLine(line('离线期行', 0))
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(1) // 未投出但不丢

    online = true
    d.flushNow()
    expect(delivered).toEqual(['离线期行'])
    expect(d.pendingCount).toBe(0)
    d.dispose()
  })
})

describe('Deliverer 生命周期', () => {
  it('dispose：清定时器，后续行不投递', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    d.onLine(line('行', 0))
    d.dispose()
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual([])
    expect(d.isDisposed).toBe(true)
  })

  it('admit 幂等：重复 admit 不清空已积累的新行', async () => {
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 50 })
    d.admit()
    d.onLine(line('行', 0))
    d.admit() // 重复 admit
    expect(d.pendingCount).toBe(1) // 不清空
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    d.dispose()
  })
})

describe('Deliverer 两会话隔离', () => {
  it('两个 Deliverer 各投各的，互不串线', async () => {
    const delivered1: string[] = []
    const delivered2: string[] = []
    const d1 = new Deliverer('s1', (_id, text) => { delivered1.push(text) }, { quietMs: 50 })
    const d2 = new Deliverer('s2', (_id, text) => { delivered2.push(text) }, { quietMs: 50 })
    d1.admit()
    d2.admit()
    d1.onLine(line('会话1行', 0))
    d2.onLine(line('会话2行', 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered1).toEqual(['会话1行'])
    expect(delivered2).toEqual(['会话2行'])
    d1.dispose()
    d2.dispose()
  })
})
