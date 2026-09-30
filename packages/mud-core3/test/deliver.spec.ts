/**
 * deliver 测试 — pull 模型聚合投递 + 接入闸门 + 水位线 + turn 抑制。
 *
 * 二期改造（doc/PLAN.md「二期详细设计 §4/§12」）：投递器不自持缓冲，
 * 投递 = 从水位线源（runtime.pendingLines）拉取 abs > seen 的行。
 *
 * 测试覆盖：
 *   - 未接入：零投递、零拉取（take 不被调用）——闸门在源头
 *   - 接入：水位 = 接入时刻（积压不回放）；静默窗口到期从水位线之后拉取投出
 *   - 水位线推进：投后 delivered 更新（已见线 = 成功投出的最大 abs）
 *   - 聚合：一批 = 一条消息；两批 = 两条消息；超 maxLines/maxChars 拆条
 *   - 最长等待：行流持续不静默也在上限内投出
 *   - agent 离线：失败批次不推进水位，flushOnce 从失败点重试不丢行
 *   - turn 抑制：turn/start 后不武装定时器；turn/end 冲刷一次投出
 *   - 空白批：不投递但推进水位（不楔住后续投递）
 *   - 两会话各投各的（互不串线）
 */

import { describe, expect, it } from 'vitest'
import { Deliverer, type LineSource } from '../src/deliver.ts'
import type { MudLine } from '../src/link/line.ts'

// ── 工具：构造 MudLine 与假水位线源 ─────────────────────────────

function line(text: string, abs: number): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false }
}

/** 假水位线源：内存数组 + delivered 水位（readAbs 为 runtime 层职责，此处恒 -1）。 */
function fakeSource(): LineSource & {
  lines: MudLine[]
  takeCalls: number
  push(text: string, abs: number): void
} {
  const lines: MudLine[] = []
  let delivered = -1
  const out = {
    lines,
    takeCalls: 0,
    push(text: string, abs: number): void { lines.push(line(text, abs)) },
    seen: () => delivered,
    end: () => lines[lines.length - 1]?.abs ?? -1,
    take(seen: number): MudLine[] {
      out.takeCalls += 1
      return lines.filter(l => l.abs > seen)
    },
    commit(abs: number): void {
      if (abs > delivered) delivered = abs
    },
  }
  return out
}

// ── 测试 ──────────────────────────────────────────────────────

describe('Deliverer 接入闸门（pull 模型）', () => {
  it('未接入：零投递、零拉取（take 不被调用，闸门在源头）', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    source.push('积压行1', 0)
    source.push('积压行2', 1)
    d.onLine(source.lines[0]!) // 未接入：不武装定时器、不拉取
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual([])
    expect(source.takeCalls).toBe(0)
    d.dispose()
  })

  it('接入：水位 = 接入时刻（积压不回放），之后新行照常投出', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    source.push('积压行1', 0)
    source.push('积压行2', 1)
    d.admit()
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual([]) // 积压不回放
    expect(source.seen()).toBe(1) // 水位推进到 pending 末端

    source.push('新行', 2)
    d.onLine(source.lines[2]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['新行'])
    d.dispose()
  })

  it('停止接入后：零投递（pending 照常积累 = 录制，runtime 层职责）', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    source.push('接入期行', 0)
    d.onLine(source.lines[0]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toHaveLength(1)

    d.stop()
    source.push('停止后行', 1)
    d.onLine(source.lines[1]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toHaveLength(1)
    d.dispose()
  })
})

describe('Deliverer 水位线与聚合', () => {
  it('静默窗口到期：从水位线之后拉取投出一条消息，delivered 推进到批次末端', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    source.push('A', 0)
    source.push('B', 1)
    source.push('C', 2)
    d.onLine(source.lines[0]!)
    d.onLine(source.lines[1]!)
    d.onLine(source.lines[2]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['A\nB\nC'])
    expect(source.seen()).toBe(2) // 已见线 = 成功投出的最大 abs
    d.dispose()
  })

  it('两批行 = 两条消息（静默窗口分隔），各自推进水位', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    source.push('第一批', 0)
    d.onLine(source.lines[0]!)
    await new Promise(r => setTimeout(r, 90))
    source.push('第二批', 1)
    d.onLine(source.lines[1]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['第一批', '第二批'])
    expect(source.seen()).toBe(1)
    d.dispose()
  })

  it('超 maxLines：拆成多条依次投递，不丢行', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, maxLines: 3, source })
    d.admit()
    for (const [i, t] of ['1', '2', '3', '4', '5'].entries()) {
      source.push(t, i)
      d.onLine(source.lines[i]!)
    }
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['1\n2\n3', '4\n5'])
    expect(source.seen()).toBe(4)
    d.dispose()
  })

  it('超 maxChars：拆成多条依次投递，不丢行', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, maxChars: 10, source })
    d.admit()
    for (const [i, t] of ['aaaa', 'bbbb', 'cccc'].entries()) {
      source.push(t, i)
      d.onLine(source.lines[i]!)
    }
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['aaaa\nbbbb', 'cccc'])
    d.dispose()
  })

  it('行流持续不静默：最长等待到期仍强制投出', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, {
      quietMs: 500,
      maxWaitMs: 120,
      source,
    })
    d.admit()
    let abs = 0
    const ticker = setInterval(() => {
      source.push('刷屏', abs)
      d.onLine(source.lines[abs]!)
      abs += 1
    }, 30)
    await new Promise(r => setTimeout(r, 260))
    clearInterval(ticker)
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    d.dispose()
  })

  it('空白批：不投递但推进水位（不楔住后续投递）', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, maxLines: 2, source })
    d.admit()
    source.push('', 0)
    source.push('', 1)
    source.push('实内容', 2)
    for (const l of source.lines) d.onLine(l)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['实内容'])
    expect(source.seen()).toBe(2)
    d.dispose()
  })
})

describe('Deliverer 投递失败与重试', () => {
  it('agent 离线：失败批次不推进水位，flushOnce 从失败点重试不丢行', async () => {
    const delivered: string[] = []
    let online = false
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => {
      if (!online) return false
      delivered.push(text)
      return true
    }, { quietMs: 40, source })
    d.admit()
    source.push('离线期行', 0)
    d.onLine(source.lines[0]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual([])
    expect(source.seen()).toBe(-1) // 失败批次不推进水位（行仍在录制缓冲）

    online = true
    d.flushOnce()
    expect(delivered).toEqual(['离线期行'])
    expect(source.seen()).toBe(0)
    d.flushOnce() // 再次补投：已见行不重复投
    expect(delivered).toEqual(['离线期行'])
    d.dispose()
  })

  it('拆条中后段投出失败：该段不推进 delivered，下次 flush 从失败点重试', async () => {
    const delivered: string[] = []
    let failedOnce = false // 瞬时失败：只拒绝第一次含 '3' 的段（模拟 agent 暂时离线）
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => {
      if (!failedOnce && text.includes('3')) {
        failedOnce = true
        return false
      }
      delivered.push(text)
      return true
    }, { quietMs: 40, maxLines: 2, source })
    d.admit()
    for (const [i, t] of ['1', '2', '3', '4', '5'].entries()) {
      source.push(t, i)
      d.onLine(source.lines[i]!)
    }
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual(['1\n2']) // 首段成功（水位=1），后段失败保留
    expect(source.seen()).toBe(1)

    d.flushOnce() // 从失败点重试：abs > 1 的行重新拉取
    expect(delivered).toEqual(['1\n2', '3\n4', '5'])
    expect(source.seen()).toBe(4)
    d.dispose()
  })
})

describe('Deliverer turn 抑制', () => {
  it('turn/start 后不武装定时器；turn/end 冲刷一次投出（一个批次，不重复）', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    d.onTurnStart()
    source.push('回合内甲', 0)
    source.push('回合内乙', 1)
    source.push('回合内丙', 2)
    for (const l of source.lines) d.onLine(l)
    await new Promise(r => setTimeout(r, 120))
    expect(delivered).toEqual([]) // turn 期间抑制

    d.onTurnEnd()
    expect(delivered).toEqual(['回合内甲\n回合内乙\n回合内丙']) // 一次冲刷
    d.onTurnEnd() // 重复 turn/end：已见行不重复投
    expect(delivered).toHaveLength(1)
    d.dispose()
  })

  it('turn 期间行持续到达也不投（定时器被抑制），turn/end 统一收', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 30, source })
    d.admit()
    d.onTurnStart()
    let abs = 0
    const ticker = setInterval(() => {
      source.push('刷屏', abs)
      d.onLine(source.lines[abs]!)
      abs += 1
    }, 20)
    await new Promise(r => setTimeout(r, 120))
    clearInterval(ticker)
    expect(delivered).toEqual([])
    d.onTurnEnd()
    expect(delivered).toHaveLength(1)
    d.dispose()
  })
})

describe('Deliverer 生命周期', () => {
  it('dispose：清定时器，后续行不投递', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    source.push('行', 0)
    d.onLine(source.lines[0]!)
    d.dispose()
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual([])
    expect(d.isDisposed).toBe(true)
  })

  it('admit 幂等：重复 admit 不改变水位语义', async () => {
    const delivered: string[] = []
    const source = fakeSource()
    const d = new Deliverer('s1', (_id, text) => { delivered.push(text) }, { quietMs: 40, source })
    d.admit()
    source.push('行', 0)
    d.onLine(source.lines[0]!)
    d.admit() // 重复 admit（commit 为单调 max，不回退）
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toHaveLength(1)
    d.dispose()
  })
})

describe('Deliverer 两会话隔离', () => {
  it('两个 Deliverer 各投各的，互不串线', async () => {
    const delivered1: string[] = []
    const delivered2: string[] = []
    const source1 = fakeSource()
    const source2 = fakeSource()
    const d1 = new Deliverer('s1', (_id, text) => { delivered1.push(text) }, { quietMs: 40, source: source1 })
    const d2 = new Deliverer('s2', (_id, text) => { delivered2.push(text) }, { quietMs: 40, source: source2 })
    d1.admit()
    d2.admit()
    source1.push('会话1行', 0)
    source2.push('会话2行', 0)
    d1.onLine(source1.lines[0]!)
    d2.onLine(source2.lines[0]!)
    await new Promise(r => setTimeout(r, 90))
    expect(delivered1).toEqual(['会话1行'])
    expect(delivered2).toEqual(['会话2行'])
    d1.dispose()
    d2.dispose()
  })
})
