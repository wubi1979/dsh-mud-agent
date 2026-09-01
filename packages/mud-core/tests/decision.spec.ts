/**
 * dsh-mud-core 决策层测试 — 规则引擎 (轻量处理器) / when 条件 / 默认规则语义。
 *
 * 重型处理器 (LLM) 由 DSH agent 承担, 不在本层测试范围。
 */

import { describe, expect, it } from 'vitest'
import { RuleEngine, matchWhen, summarizeState } from '../src/decision.ts'
import defaultDecisionRules from '../src/config/rules-decision.ts'

describe('RuleEngine 事件匹配', () => {
  it('优先级短路 + 不匹配事件', () => {
    const r = new RuleEngine()
    r.register({ id: 'low', priority: 5, match: { event: 'p:combat:start' }, action: { action: 'tool', tool: 'mud_send', cmd: 'look' } })
    r.register({ id: 'high', priority: 90, match: { event: 'p:combat:start' }, action: { action: 'tool', tool: 'mud_send', cmd: 'halt' } })
    expect(r.match({ eventType: 'p:combat:start', state: {} })?.id).toBe('high')
    expect(r.match({ eventType: 'p:login:prompt', state: {} })).toBeNull()
  })

  it('通配事件模式', () => {
    const r = new RuleEngine()
    r.register({ id: 'combat-any', match: { event: 'p:combat:*' }, action: { action: 'no_action' } })
    expect(r.match({ eventType: 'p:combat:start' })).not.toBeNull()
    expect(r.match({ eventType: 'p:combat:end' })).not.toBeNull()
    expect(r.match({ eventType: 'p:login:prompt' })).toBeNull()
  })
})

describe('matchWhen 条件求值', () => {
  it('操作符与精确值', () => {
    const state = { 'char.hp': 100, 'flags.logged_in': true, 'combat.in_combat': false }
    expect(matchWhen({ 'flags.logged_in': { truthy: true } }, state)).toBe(true)
    expect(matchWhen({ 'combat.in_combat': { falsy: true } }, state)).toBe(true)
    expect(matchWhen({ 'char.hp': { gt: 50 } }, state)).toBe(true)
    expect(matchWhen({ 'char.hp': { lte: 100 } }, state)).toBe(true)
    expect(matchWhen({ 'char.hp': { lt: 50 } }, state)).toBe(false)
    expect(matchWhen({ 'char.hp': 100 }, state)).toBe(true)
    expect(matchWhen({ 'char.hp': 99 }, state)).toBe(false)
    expect(matchWhen({ 'flags.logged_in': { in: [true, 'yes'] } }, state)).toBe(true)
  })
})

describe('summarizeState 世界摘要', () => {
  it('字段折叠与跳过', () => {
    const flat = {
      'char.hp': 100,
      'room.name': '客店',
      'room.exits': ['west', 'up'],
      'flags.logged_in': true,
      'combat.target': null,
      'char.exp': '',
    }
    const s = summarizeState(flat)
    expect(s).toContain('char.hp=100')
    expect(s).toContain('room.name=客店')
    expect(s).toContain('room.exits=[west,up]')
    expect(s).toContain('flags.logged_in=true')
    expect(s).not.toContain('combat.target')
    expect(s).not.toContain('char.exp')
    expect(summarizeState({})).toBe('(空)')
  })
})

describe('默认决策规则', () => {
  it('战斗/死亡规则 (确定性 halt + 声明式死亡)', () => {
    const r = new RuleEngine()
    for (const rule of defaultDecisionRules) r.register(rule)

    const combat = r.match({ eventType: 'p:combat:start', state: { 'flags.logged_in': true } })
    expect(combat?.id).toBe('on-combat-start')
    expect(combat?.action.action).toBe('tool')
    expect(combat?.action.action === 'tool' && combat.action.cmd).toBe('halt')

    expect(r.match({ eventType: 'p:combat:start', state: { 'flags.logged_in': false } })).toBeNull()

    const death = r.match({ eventType: 'p:death', state: {} })
    expect(death?.id).toBe('on-death')
    expect(death?.action.action).toBe('llm')
  })
})
