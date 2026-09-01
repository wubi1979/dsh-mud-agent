/**
 * dsh-mud-core 注入录制器测试 — Transcript (30s 时间窗 + 最小行阈值 + 折叠视图)。
 *
 * 覆盖:
 *   - 折叠: 单行触发替换 / 多行步骤折叠区间 / 覆盖行不再输出;
 *   - 行序渲染: 折叠与未触发行保持行序;
 *   - 时间窗: 超窗行丢弃; 不足阈值 (时间空洞) 时保留到阈值行数。
 */

import { describe, expect, it } from 'vitest'
import { Transcript, TRANSCRIPT_MIN_LINES } from '../src/transcript.ts'
import { PerceptionBuffer } from '../src/perception.ts'

interface Row { text: string; time: number }
function pushRows(buffer: PerceptionBuffer, rows: Row[]): void {
  buffer.appendLines(rows.map((r) => ({
    text: r.text,
    raw: r.text,
    style: [],
    abs: buffer.nextAbs,
    time: r.time,
    isPrompt: false,
  } satisfies Parameters<typeof buffer.appendLines>[0][number])))
}

function makeTranscript(opts?: { windowMs?: number; minLines?: number }) {
  const buffer = new PerceptionBuffer({ maxRows: 2000 })
  const t = new Transcript(buffer, { windowMs: 30_000, minLines: TRANSCRIPT_MIN_LINES, ...opts })
  return { buffer, t }
}

describe('Transcript 折叠视图 (单行/多行区间)', () => {
  it('单行触发替换该行为事件条目', () => {
    const { buffer, t } = makeTranscript()
    const now = Date.now()
    pushRows(buffer, [
      { text: '客店大厅', time: now },
      { text: '你的英文名字（要注册新人物请输入new。）：', time: now },
      { text: '你心一动', time: now },
    ])
    // 拉取三行 (语义与 drain 一致)
    t.drain()
    // 折叠命中行 (abs=1): 原始行被替换, 折叠条目本身含事件描述
    t.fold({ eventType: 'p:login:prompt', startAbs: 1, endAbs: 1, text: '[事件] 感知"英文名字" p:login:prompt → 动作 mud_send "alice"', time: now })
    const out = t.text()
    expect(out).toContain('[事件]')
    expect(out).not.toContain('要注册新人物') // 原始输入提示行已被替换
    expect(out).toContain('客店大厅')
    expect(out).toContain('你心一动')
  })

  it('多行多步骤折叠整个区间', () => {
    const { buffer, t } = makeTranscript()
    const now = Date.now()
    pushRows(buffer, [
      { text: '你的英文名字（）：', time: now },   // abs 0
      { text: '请输入密码：', time: now },        // abs 1
      { text: '欢迎来到北大侠客行！', time: now }, // abs 2
      { text: '客店大厅', time: now },            // abs 3
    ])
    t.drain()
    // 登录多步骤: 折叠 abs0..abs2 为一个条目
    t.fold({ eventType: 'p:login:done', startAbs: 0, endAbs: 2, text: '[事件] 登录完成 p:login:done → 动作 look → ok', time: now })
    const out = t.text()
    expect(out).toContain('登录完成')
    expect(out).not.toContain('英文名字')
    expect(out).not.toContain('请输入密码')
    expect(out).not.toContain('欢迎来到')
    expect(out).toContain('客店大厅')
  })

  it('渲染保持行序: 未触发行在折叠前后位置正确', () => {
    const { buffer, t } = makeTranscript()
    const now = Date.now()
    pushRows(buffer, [
      { text: '前导', time: now },
      { text: '触发行', time: now },
      { text: '后续', time: now },
    ])
    t.drain()
    t.fold({ eventType: 'e', startAbs: 1, endAbs: 1, text: '[折叠]', time: now })
    const lines = t.text().split('\n')
    expect(lines[0]).toBe('前导')
    expect(lines[1]).toBe('[折叠]')
    expect(lines[2]).toBe('后续')
  })
})

describe('Transcript 时间窗 + 最小行阈值', () => {
  it('行数超过阈值 → 按时间窗裁剪 (丢最旧)', () => {
    const { buffer, t } = makeTranscript({ windowMs: 1000, minLines: 1 })
    const now = Date.now()
    pushRows(buffer, [
      { text: '很旧', time: now - 2000 },  // 超窗
      { text: '最新', time: now },
    ])
    t.drain()
    const out = t.text()
    expect(out).not.toContain('很旧')
    expect(out).toContain('最新')
  })

  it('时间空洞: 30s 窗内行数不足阈值 → 补足到阈值行数 (不挤占有用行)', () => {
    const { buffer, t } = makeTranscript({ windowMs: 30_000, minLines: 4 })
    const now = Date.now()
    // 30s 窗内只有 2 行 (<4), 其余 3 行超窗 → 应保留最近 4 行 (c3,c2,c1 + 其一), 丢弃最旧超窗行
    pushRows(buffer, [
      { text: 'a', time: now - 40_000 },
      { text: 'b', time: now - 40_000 },
      { text: 'c1', time: now - 1000 },
      { text: 'c2', time: now - 1000 },
      { text: 'c3', time: now },
    ])
    t.drain()
    // 渲染走 sortUnits → 触发时间窗裁剪; 最少保留最近 minLines 行
    const out = t.text()
    expect(out).toContain('c3')
    // 最旧的 a/b 至少丢一个 (5 行只保留 4)
    expect(out.split('\n').filter((s) => s !== '').length).toBeLessThanOrEqual(4)
  })
})