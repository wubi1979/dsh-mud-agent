/**
 * deliver 测试 — pull 模型聚合投递 + 接入闸门 + 水位线 + turn 抑制。
 *
 * 测试覆盖（§16.3 验收断言）：
 *   - 未接入：零拉取零投递（录制归 runtime 环，这里用 FakeSource 代位）
 *   - 接入后：静默窗口聚合投递（一批 = 一条消息）
 *   - 水位 = 接入时刻：接入前的积压不回放
 *   - 拆条：超 maxLines / maxChars 拆成多条，不丢行
 *   - 最长等待：行流持续不静默也在上限内投出
 *   - agent 离线（deliver 返回 false）：该批水位不推进，flushNow 补投不丢行
 *   - 部分成功：拆条中后段失败 → 前段水位推进，重试从失败点开始
 *   - turn 抑制：turn/start 后不投，turn/end 一次冲刷
 *   - 纯空白行：跳过但推进水位
 *   - 两会话各投各的（互不串线）
 */

import { describe, expect, it } from 'vitest'
import { Deliverer, type DelivererConfig, type DeliverySource } from '../src/deliver.ts'
import type { MudLine } from '../src/link/line.ts'

// ── 工具 ──────────────────────────────────────────────────────

function line(text: string, abs: number, kind: string | null = null): MudLine {
  return { text, raw: text, style: [], abs, time: Date.now(), isPrompt: false, kind }
}

/** FakeSource：runtime 水位线面的内存代位（pending 数组 + delivered/read 两线）。 */
class FakeSource implements DeliverySource {
  private readonly lines: MudLine[] = []
  private deliveredAbs = -1
  private readAbs = -1

  push(l: MudLine): void { this.lines.push(l) }
  seenAbs(): number { return Math.max(this.deliveredAbs, this.readAbs) }
  linesAfter(seen: number): MudLine[] { return this.lines.filter(l => l.abs > seen) }
  lastAbs(): number { return this.lines.at(-1)?.abs ?? -1 }
  markDelivered(abs: number): void { if (abs > this.deliveredAbs) this.deliveredAbs = abs }
  markRead(abs: number): void { if (abs > this.readAbs) this.readAbs = abs }
}

/** 组装：默认已 admit 的 Deliverer + 源。 */
function setup(config: DelivererConfig = {}) {
  const source = new FakeSource()
  const delivered: string[] = []
  let online = true
  const d = new Deliverer('s1', (_id, text) => {
    if (!online) return false
    delivered.push(text)
    return true
  }, source, { quietMs: 50, ...config })
  return { d, source, delivered, setOnline: (v: boolean) => { online = v } }
}

// ── 测试 ──────────────────────────────────────────────────────

describe('Deliverer 接入闸门', () => {
  it('未接入：零拉取零投递（pending 计数也为 0）', async () => {
    const { d, source } = setup()
    source.push(line('第一行', 0))
    source.push(line('第二行', 1))
    d.onLine(line('x', 99)) // 未接入不武装定时器
    await new Promise(r => setTimeout(r, 100))
    expect(d.pendingCount).toBe(0)
    expect(d.isAdmitted).toBe(false)
    d.dispose()
  })

  it('接入后：静默窗口到期投递一条消息', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('欢迎', 0))
    source.push(line('来到', 1))
    d.onLine(line('欢迎', 0)) // 武装定时器
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('欢迎\n来到')
    d.dispose()
  })

  it('停止接入后：零投递', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('接入期行', 0))
    d.onLine(line('接入期行', 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)

    d.stop()
    source.push(line('停止后行', 1))
    d.onLine(line('停止后行', 1))
    d.flushNow()
    expect(delivered).toHaveLength(1)
    d.dispose()
  })

  it('水位 = 接入时刻：接入前的积压不回放，接入后新行才投', async () => {
    const { d, source, delivered } = setup()
    // 接入前行流到达（积压在 source，Deliverer 不感知）
    source.push(line('积压行1', 0))
    source.push(line('积压行2', 1))
    d.admit() // delivered 水位 = 末端行号 1
    expect(d.pendingCount).toBe(0) // 积压不回放

    source.push(line('新行', 2))
    d.onLine(line('新行', 2))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['新行'])
    d.dispose()
  })
})

describe('Deliverer 聚合行为', () => {
  it('静默窗口聚合：一批行 = 一条消息（非逐行）', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    for (const [i, t] of ['A', 'B', 'C'].entries()) {
      source.push(line(t, i))
      d.onLine(line(t, i))
    }
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['A\nB\nC'])
    d.dispose()
  })

  it('两批行 = 两条消息（静默窗口分隔）', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('第一批', 0))
    d.onLine(line('第一批', 0))
    await new Promise(r => setTimeout(r, 100))
    source.push(line('第二批', 1))
    d.onLine(line('第二批', 1))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['第一批', '第二批'])
    d.dispose()
  })

  it('截断护栏：超长消息截断', async () => {
    const { d, source, delivered } = setup({ maxChars: 20 })
    d.admit()
    const long = '这是一段很长的内容'.repeat(5)
    source.push(line(long, 0))
    d.onLine(line(long, 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.length).toBeLessThanOrEqual(30)
    expect(delivered[0]).toContain('截断')
    d.dispose()
  })

  it('超 maxLines：拆成多条依次投递，不丢行', async () => {
    const { d, source, delivered } = setup({ maxLines: 3 })
    d.admit()
    for (const [i, t] of ['1', '2', '3', '4', '5'].entries()) {
      source.push(line(t, i))
      d.onLine(line(t, i))
    }
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['1\n2\n3', '4\n5'])
    d.dispose()
  })

  it('超 maxChars：拆成多条依次投递，不丢行', async () => {
    const { d, source, delivered } = setup({ maxChars: 10 })
    d.admit()
    for (const [i, t] of ['aaaa', 'bbbb', 'cccc'].entries()) {
      source.push(line(t, i))
      d.onLine(line(t, i))
    }
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['aaaa\nbbbb', 'cccc'])
    d.dispose()
  })

  it('行流持续不静默：最长等待到期仍强制投出', async () => {
    const { d, source, delivered } = setup({ quietMs: 500, maxWaitMs: 120 })
    d.admit()
    let abs = 0
    const ticker = setInterval(() => {
      source.push(line('刷屏', abs))
      d.onLine(line('刷屏', abs))
      abs += 1
    }, 30)
    await new Promise(r => setTimeout(r, 260))
    clearInterval(ticker)
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    d.dispose()
  })
})

describe('Deliverer 失败与补投', () => {
  it('agent 离线（deliver 返回 false）：水位不推进，flushNow 补投不丢行', async () => {
    const { d, source, delivered, setOnline } = setup()
    d.admit()
    setOnline(false)
    source.push(line('离线期行', 0))
    d.onLine(line('离线期行', 0))
    await new Promise(r => setTimeout(r, 90))
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(1) // 行仍在 pending，水位未推进

    setOnline(true)
    d.flushNow()
    expect(delivered).toEqual(['离线期行'])
    expect(d.pendingCount).toBe(0)
    d.dispose()
  })

  it('部分成功：拆条中后段失败 → 前段水位推进，重试从失败点开始不丢行', async () => {
    const source = new FakeSource()
    const delivered: string[] = []
    let failFrom = 2 // 从第 2 批起失败
    let batches = 0
    const d = new Deliverer('s1', (_id, text) => {
      batches += 1
      if (batches >= failFrom) return false
      delivered.push(text)
      return true
    }, source, { quietMs: 50, maxLines: 2 })
    d.admit()
    for (const [i, t] of ['1', '2', '3', '4', '5'].entries()) source.push(line(t, i))
    d.flushNow()
    // 第 1 批成功（1,2），第 2 批失败（3,4）→ 水位只到 abs=1
    expect(delivered).toEqual(['1\n2'])
    expect(d.pendingCount).toBe(3)

    failFrom = 99 // 解除失败
    d.flushNow()
    expect(delivered).toEqual(['1\n2', '3\n4', '5'])
    expect(d.pendingCount).toBe(0)
    d.dispose()
  })

  it('诊断：deliver 返回原因字符串 / 抛错 → onBatch 携带 reason，异常不逃逸 flush', async () => {
    // 字符串返回 = 未投出 + 原因
    const reasons: (string | undefined)[] = []
    const src1 = new FakeSource()
    const d1 = new Deliverer('s1', () => 'followup 抛错：inbox 投影未激活', src1, {
      quietMs: 50,
      onBatch: (_id, _n, delivered, reason) => {
        if (!delivered) reasons.push(reason)
      },
    })
    d1.admit()
    src1.push(line('异常行', 0))
    d1.flushNow()
    expect(d1.pendingCount).toBe(1) // 水位不推进
    expect(reasons).toEqual(['followup 抛错：inbox 投影未激活'])

    // deliver 直接抛错 → flush 收编为原因，不逃逸
    const src2 = new FakeSource()
    const d2 = new Deliverer('s2', () => {
      throw new Error('boom')
    }, src2, {
      quietMs: 50,
      onBatch: (_id, _n, delivered, reason) => {
        if (!delivered) reasons.push(reason)
      },
    })
    d2.admit()
    src2.push(line('抛错行', 0))
    expect(() => d2.flushNow()).not.toThrow()
    expect(d2.pendingCount).toBe(1)
    expect(reasons).toEqual(['followup 抛错：inbox 投影未激活', 'followup 抛错：boom'])
    d1.dispose()
    d2.dispose()
  })

  it('失败退避重试：瞬时失败（原因字符串）自动重试自愈，句柄缺失（false）不自动重试', async () => {
    // 原因字符串 = 瞬时失败 → quietMs 后自动重试，无需外部触发
    const src1 = new FakeSource()
    let transient = true
    const d1 = new Deliverer('s1', () => (transient ? 'followup 抛错：append 重入' : true), src1, {
      quietMs: 50,
      maxWaitMs: 200,
    })
    d1.admit()
    src1.push(line('竞速行', 0))
    d1.flushNow()
    expect(d1.pendingCount).toBe(1)

    transient = false
    await new Promise(r => setTimeout(r, 120)) // 首次退避 = quietMs(50)，足够触发
    expect(d1.pendingCount).toBe(0) // 退避重试已自愈
    d1.dispose()

    // 句柄缺失（false）= 冷会话 → 不自动重试（恢复路径 = agent/created 补投 + 静默唤醒）
    const src2 = new FakeSource()
    const d2 = new Deliverer('s2', () => false, src2, { quietMs: 50, maxWaitMs: 200 })
    d2.admit()
    src2.push(line('离线行', 0))
    d2.flushNow()
    await new Promise(r => setTimeout(r, 120))
    expect(d2.pendingCount).toBe(1) // 行仍在 pending，无重试风暴
    d2.dispose()
  })
})

describe('Deliverer turn 抑制', () => {
  it('turn/start 后行不投递，turn/end 一次冲刷（一个批次，不重复）', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    d.onTurnStart()
    for (const [i, t] of ['回合内1', '回合内2', '回合内3'].entries()) {
      source.push(line(t, i))
      d.onLine(line(t, i)) // turn 模式不武装定时器
    }
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual([]) // 抑制中零投递

    d.onTurnEnd()
    expect(delivered).toEqual(['回合内1\n回合内2\n回合内3'])
    expect(d.pendingCount).toBe(0)
    d.dispose()
  })

  it('turn/end 后恢复空闲模式（静默窗口重新生效）', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    d.onTurnStart()
    d.onTurnEnd()
    source.push(line('回合后行', 0))
    d.onLine(line('回合后行', 0))
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual(['回合后行'])
    d.dispose()
  })
})

describe('Deliverer 生命周期', () => {
  it('dispose：清定时器，后续行不投递', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('行', 0))
    d.dispose()
    d.flushNow()
    await new Promise(r => setTimeout(r, 100))
    expect(delivered).toEqual([])
    expect(d.isDisposed).toBe(true)
  })

  it('admit 幂等：重复 admit 不重置水位（已拉取的行不回放）', async () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('行', 0))
    d.flushNow()
    expect(delivered).toEqual(['行'])
    d.admit() // 重复 admit
    expect(d.pendingCount).toBe(0) // 水位未回退
    d.dispose()
  })
})

describe('Deliverer 两会话隔离', () => {
  it('两个 Deliverer 各投各的，互不串线', async () => {
    const source1 = new FakeSource()
    const source2 = new FakeSource()
    const delivered1: string[] = []
    const delivered2: string[] = []
    const d1 = new Deliverer('s1', (_id, text) => { delivered1.push(text) }, source1, { quietMs: 50 })
    const d2 = new Deliverer('s2', (_id, text) => { delivered2.push(text) }, source2, { quietMs: 50 })
    d1.admit()
    d2.admit()
    source1.push(line('会话1行', 0))
    source2.push(line('会话2行', 0))
    d1.flushNow()
    d2.flushNow()
    expect(delivered1).toEqual(['会话1行'])
    expect(delivered2).toEqual(['会话2行'])
    d1.dispose()
    d2.dispose()
  })
})

describe('Deliverer 投递剔除（C5.2）', () => {
  it('缺省策略：有标行不进投递文本，水位随成功批次越过（不丢已见记账）', () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('无标1', 0))
    source.push(line('【闲聊】聊天行', 1, 'chat'))
    source.push(line('无标2', 2))
    d.flushNow()
    // 互斥剔除：聊天行不在投递文本里；无标行按原序 join。
    expect(delivered).toEqual(['无标1\n无标2'])
    expect(d.pendingCount).toBe(0) // 水位越过聊天行（已见不重扫）
    d.dispose()
  })

  it('全段有标：水位直接越过本段（剔除恒定，避免永挂重扫）', () => {
    const { d, source, delivered } = setup()
    d.admit()
    source.push(line('【闲聊】甲', 0, 'chat'))
    source.push(line('【闲聊】乙', 1, 'chat'))
    d.flushNow()
    expect(delivered).toEqual([])
    expect(d.pendingCount).toBe(0) // 水位 = 末端行号
    d.dispose()
  })

  it('白名单放行：allowKinds 列出的 kind 进投递', () => {
    const { d, source, delivered } = setup({ allowKinds: ['chat'] })
    d.admit()
    source.push(line('【闲聊】放行行', 0, 'chat'))
    source.push(line('【动作】仍剔除', 1, 'action'))
    source.push(line('无标行', 2))
    d.flushNow()
    expect(delivered).toEqual(['【闲聊】放行行\n无标行'])
    d.dispose()
  })

  it('剔除与失败语义正交：成功批之后的失败批不推进水位（剔除行不背锅）', () => {
    let fail = false
    const source = new FakeSource()
    const delivered: string[] = []
    const d = new Deliverer('s1', (_id, text) => {
      if (fail) return false
      delivered.push(text)
      return true
    }, source, { quietMs: 50 })
    d.admit()
    source.push(line('无标1', 0))
    source.push(line('【闲聊】聊天', 1, 'chat'))
    source.push(line('无标2', 2))
    fail = true
    d.flushNow()
    expect(delivered).toEqual([]) // 全批失败（含混批）→ 水位不动，下次重试
    fail = false
    d.flushNow()
    expect(delivered).toEqual(['无标1\n无标2'])
    expect(d.pendingCount).toBe(0)
    d.dispose()
  })
})
