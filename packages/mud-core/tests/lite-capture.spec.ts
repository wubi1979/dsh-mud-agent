/**
 * dsh-mud-core — LiteCapture 单测。
 *
 * 验证感知 lite 捕获器: 事件 → marker → sendLite, 含守卫 / 去重 / 抢占标记。
 * 不依赖 agent 生命周期 — sendLite 以桩注入。
 *
 * @module dsh-mud-core/tests/lite-capture
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LiteCapture, LITE_CAPTURE_DEDUP_MS, type LiteActionDef } from '../src/perception/lite-capture.ts'
import type { LiteMarker } from '../src/trigger-llm/types.ts'

function percept(type: string, line: string | null = null): void {
  ctx.events.emit('mud/percept', {
    type,
    data: line === null ? null : { line },
    line: 1,
    ts: Date.now(),
  })
}

let ctx: Context
let sent: LiteMarker[]
let capture: LiteCapture

beforeEach(() => {
  ctx = new Context()
  sent = []
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  capture?.dispose()
  vi.useRealTimers()
})

function make(actions: Record<string, LiteActionDef>, guard = () => true): LiteCapture {
  return new LiteCapture({
    bus: ctx,
    actions,
    guard,
    sendLite: (m) => sent.push(m),
  })
}

describe('LiteCapture', () => {
  it('命中动作表 → 生成 lite marker → sendLite (capturedText 取自 data.line)', () => {
    capture = make({
      'p:combat:start': {
        label: '战斗开始 → halt',
        toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }],
        interrupt: true,
      },
    })
    percept('p:combat:start', '你感到一股杀气扑面而来。')

    expect(sent).toHaveLength(1)
    const m = sent[0]!
    expect(m.kind).toBe('lite')
    expect(m.groupId).toBe('p:combat:start')
    expect(m.capturedText).toEqual(['你感到一股杀气扑面而来。'])
    expect(m.toolCalls).toEqual([{ name: 'mud_send', args: { cmd: 'halt' } }])
    expect(m.renderedCmd).toBe('战斗开始 → halt')
    expect(capture.requiresInterrupt('p:combat:start')).toBe(true)
  })

  it('未命中动作表的事件 → 不发', () => {
    capture = make({})
    percept('p:room:busy', '这里的人很多')
    expect(sent).toHaveLength(0)
    expect(capture.captures).toBe(0)
  })

  it('guard 为 false 时丢弃捕获', () => {
    capture = make({
      'p:combat:end': { label: 'look', toolCalls: [{ name: 'mud_send', args: { cmd: 'look' } }] },
    }, () => false)
    percept('p:combat:end', '战斗结束。')
    expect(sent).toHaveLength(0)
    expect(capture.captures).toBe(0)
  })

  it('同类事件在去重窗口内只发一次, 窗口过后可再发', () => {
    capture = make({
      'p:combat:start': {
        label: 'halt',
        toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }],
      },
    })
    percept('p:combat:start', '杀气。')
    percept('p:combat:start', '杀气。') // 窗口内去重
    expect(sent).toHaveLength(1)

    vi.advanceTimersByTime(LITE_CAPTURE_DEDUP_MS)
    percept('p:combat:start', '杀气。') // 窗口过后
    expect(sent).toHaveLength(2)
  })

  it('不同事件类型互不干扰去重', () => {
    capture = make({
      'p:combat:start': { label: 'halt', toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }] },
      'p:combat:end': { label: 'look', toolCalls: [{ name: 'mud_send', args: { cmd: 'look' } }] },
    })
    percept('p:combat:start', '杀气。')
    percept('p:combat:end', '战斗结束。')
    expect(sent.map(m => m.groupId)).toEqual(['p:combat:start', 'p:combat:end'])
  })

  it('data.line 缺失时 capturedText 为空数组', () => {
    capture = make({
      'p:combat:start': { label: 'halt', toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }] },
    })
    percept('p:combat:start', null)
    expect(sent[0]!.capturedText).toEqual([])
  })

  it('dispose 后不再响应', () => {
    capture = make({
      'p:combat:start': { label: 'halt', toolCalls: [{ name: 'mud_send', args: { cmd: 'halt' } }] },
    })
    capture.dispose()
    percept('p:combat:start', '杀气。')
    expect(sent).toHaveLength(0)
  })
})
