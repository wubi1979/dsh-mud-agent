/**
 * dsh-mud-core — 分帧器 (FrameSplitter) 单元测试 (v0.6.0 §8)。
 *
 * 覆盖边界裁决 (`doc/architecture/07-08-t1-bridge.md` §8.0-§8.6):
 *   - 边界标记只此两类: GA/EOR (八成, 常驻缺省) / 武装判据 (十成);
 *   - 帧生命周期: 开放 → 累积 → 提交 (标记命中/内存阀);
 *   - arming 即测 (开放帧里已命中的行, 武装当场提交);
 *   - once 自动注销 / 幂等 disarm / 同类多命中取首 (I13);
 *   - 帧内存阀 (§8.6, 防 OOM 保险, 非边界) / reset (重连复位)。
 */

import { describe, expect, it } from 'vitest'
import type { MudLine } from '../src/network/ansi.ts'
import { FrameSplitter, type MudFrame } from '../src/deliver/adjudicator.ts'

/** MudLine 构造 (测试用; abs 手工分配)。 */
function ml(text: string, abs = 0): MudLine {
  return { text, raw: text, style: [], abs, time: 0, isPrompt: false }
}

/** 收帧宿主: 返回 splitter 与帧列表。 */
function harness(maxFrameLines = 256) {
  const frames: MudFrame[] = []
  const splitter = new FrameSplitter({ maxFrameLines, autoFlushMs: 0 })
  splitter.onFrame = (frame) => { frames.push(frame) }
  return { splitter, frames }
}

describe('FrameSplitter', () => {
  it('标记切帧: armed 命中行(含)之前的行定格为帧, 之后的行留作下一开放帧', () => {
    const { splitter, frames } = harness()
    splitter.feedLines([ml('a')])
    splitter.arm({ id: 'm1', pattern: 'b' })
    expect(frames).toEqual([]) // 开放帧只有 a, 不命中
    splitter.feedLines([ml('b'), ml('c')]) // b 命中 → 提交 [a,b]; c 留开放帧
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('armed')
    expect(frames[0].markerId).toBe('m1')
    expect(frames[0].lines.map(l => l.text)).toEqual(['a', 'b'])
    splitter.boundary('ga')
    expect(frames.length).toBe(2)
    expect(frames[1].lines.map(l => l.text)).toEqual(['c'])
    expect(frames[1].marker).toBe('ga')
  })

  it('同批命中行之后的行不丢弃 (I5): 归下一开放帧', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 'm', pattern: '命中' })
    splitter.feedLines([ml('命中'), ml('后续一'), ml('后续二')])
    expect(frames.length).toBe(1)
    expect(frames[0].lines.map(l => l.text)).toEqual(['命中'])
    splitter.boundary('ga')
    expect(frames[1].lines.map(l => l.text)).toEqual(['后续一', '后续二'])
  })

  it('arming 即测: 开放帧里已有命中行 → 武装当场提交 (§8.5 同批行优先)', () => {
    const { splitter, frames } = harness()
    splitter.feedLines([ml('你将内息收回丹田，站了起来。'), ml('其他')])
    splitter.arm({ id: 'done', pattern: '^你将内息收回丹田' })
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('armed')
    expect(frames[0].markerId).toBe('done')
    expect(frames[0].lines.map(l => l.text)).toEqual(['你将内息收回丹田，站了起来。'])
    // 后续行留作开放帧。
    splitter.boundary('ga')
    expect(frames[1].lines.map(l => l.text)).toEqual(['其他'])
  })

  it('once (缺省): 命中提交后自动注销', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 't1', pattern: '触发' })
    splitter.feedLines([ml('触发')])
    expect(frames[0].marker).toBe('armed')
    splitter.feedLines([ml('触发'), ml('x')])
    splitter.boundary('ga') // 标记已注销 → 无 armed 帧, 一次 ga 帧提交
    expect(frames.length).toBe(2)
    expect(frames[1].marker).toBe('ga')
    expect(frames[1].lines.map(l => l.text)).toEqual(['触发', 'x'])
    expect(splitter.stats().armed).toBe(0)
  })

  it('once:false 常驻标记可反复命中', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 't2', pattern: '触发', once: false })
    splitter.feedLines([ml('触发')])
    expect(frames[0].marker).toBe('armed')
    splitter.boundary('ga')
    splitter.feedLines([ml('触发')])
    expect(frames.length).toBe(3) // 常驻标记再次命中
    expect(frames[2].marker).toBe('armed')
    expect(splitter.stats().armed).toBe(1)
  })

  it('锚定整行逐行测试 (P1-2): 多行文本不误命中, 命中的只是含标记的那一行', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 'm', pattern: '^完成$' })
    splitter.feedLines([ml('前置'), ml('完成'), ml('后置')])
    expect(frames.length).toBe(1)
    expect(frames[0].lines.map(l => l.text)).toEqual(['前置', '完成'])
  })

  it('同类多命中按声明顺序取首 (I13)', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 'first', pattern: '目标' })
    splitter.arm({ id: 'second', pattern: '目标' })
    splitter.feedLines([ml('命中目标行')])
    expect(frames[0].markerId).toBe('first')
  })

  it('disarm: 注销武装标记 (幂等)', () => {
    const { splitter, frames } = harness()
    splitter.arm({ id: 'm', pattern: '永不到达' })
    splitter.disarm('m')
    splitter.disarm('m') // 幂等
    splitter.feedLines([ml('永不到达')])
    splitter.boundary('ga')
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('ga')
  })

  it('GA/EOR: 空帧也提交 (让宿主知道边界到了)', () => {
    const { splitter, frames } = harness()
    splitter.boundary('ga')
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('ga')
    expect(frames[0].lines).toEqual([])
    expect(frames[0].text).toBe('')
  })

  it('帧内存阀 (§8.6): 行数达限即提交无标记帧 (marker=valve), 照常走消费链', () => {
    const { splitter, frames } = harness(8)
    const lines = Array.from({ length: 10 }, (_, i) => ml(`line ${i}`))
    splitter.feedLines(lines)
    // 前 8 行达限 → valve 帧提交; 余 2 行留开放帧 (随下一标记/flush 提交)。
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('valve')
    expect(frames[0].lines.map(l => l.text)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'])
    expect(splitter.stats().openLines).toBe(2)
    splitter.flush()
    expect(frames[1].lines.map(l => l.text)).toEqual(['line 8', 'line 9'])
  })

  it('非法正则: 标记永不命中 (留痕由 onLog 承担)', () => {
    const logs: string[] = []
    const frames: MudFrame[] = []
    const splitter = new FrameSplitter({ autoFlushMs: 0, onLog: (t) => logs.push(t) })
    splitter.onFrame = (frame) => { frames.push(frame) }
    splitter.arm({ id: 'bad', pattern: '[' }) // 非法正则
    splitter.feedLines([ml('任何行')])
    splitter.boundary('ga')
    expect(frames.every(f => f.marker !== 'armed')).toBe(true)
    expect(logs.some(t => t.includes('非法'))).toBe(true)
  })

  it('reset: 清开放帧与全部武装标记 (重连复位)', () => {
    const { splitter, frames } = harness()
    splitter.feedLines([ml('残留行')])
    splitter.arm({ id: 'm', pattern: '永不到达' }) // 避免即测提交
    splitter.reset()
    expect(splitter.stats()).toEqual({ openLines: 0, armed: 0 })
    splitter.feedLines([ml('新连接的行')])
    splitter.boundary('ga')
    // 只有 reset 后的行; '残留行' 不再出现, 武装标记不再命中。
    expect(frames.length).toBe(1)
    expect(frames[0].lines.map(l => l.text)).toEqual(['新连接的行'])
    expect(frames[0].marker).toBe('ga')
  })

  it('flush: 强制提交开放帧 (valve; 空帧不提交)', () => {
    const { splitter, frames } = harness()
    splitter.flush()
    expect(frames).toEqual([])
    splitter.feedLines([ml('待冲行')])
    splitter.flush()
    expect(frames.length).toBe(1)
    expect(frames[0].marker).toBe('valve')
    expect(frames[0].lines.map(l => l.text)).toEqual(['待冲行'])
  })
})
