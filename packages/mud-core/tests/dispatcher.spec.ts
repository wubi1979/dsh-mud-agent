/**
 * dsh-mud-core 统一事件决策中心测试 — DecisionCenter (规则 → tool/skill → agent 兜底)。
 *
 * 决策知识全部集中在规则表:
 *   action:"tool"  → 单步反射执行工具 (战斗/死亡)
 *   action:"skill" → 激活命名 skill/flow (触发时机由规则决定, 不在 skill 内)
 *   llm / 未命中   → agent 兜底
 */

import { describe, expect, it } from 'vitest'
import { DecisionCenter, type DecisionCenterHost } from '../src/agent/dispatcher.ts'
import type { DecisionRule, NormalizedRule } from '../src/agent/decision.ts'
import type { MudPerceptEvent, MudSystemEvent } from '../src/events.ts'

function makeCenter(over?: Partial<DecisionCenterHost>) {
  const executed: { rule: string; eventType: string }[] = []
  const activated: string[] = []
  const routes: { eventType: string; layer: string; id?: string }[] = []
  let state: Record<string, unknown> = {}
  const center = new DecisionCenter({
    stateProvider: () => state,
    executeRule: (rule: NormalizedRule, eventType: string) => {
      executed.push({ rule: rule.id, eventType })
    },
    onRoute: (eventType, layer, id) => {
      routes.push({ eventType, layer, ...(id !== undefined ? { id } : {}) })
    },
    ...over,
  })
  return {
    center,
    executed,
    activated,
    routes,
    setState: (s: Record<string, unknown>) => { state = s },
    addSkill: (id: string) => {
      center.registerSkill({ id, activate: () => activated.push(id) })
    },
  }
}

function percept(type: string): MudPerceptEvent {
  return { type, data: null, line: 0, ts: Date.now() }
}

function system(type: string): MudSystemEvent {
  return { type, data: null, ts: Date.now() }
}

/** 登录激活规则 (对齐 config/decision-rules.ts on-login-required)。 */
const loginRule: DecisionRule = {
  id: 'on-login-required',
  priority: 30,
  match: { event: 'login:required' },
  when: { 'flags.logged_in': { falsy: true } },
  action: { action: 'skill', skill: 'login' },
}

const combatRule: DecisionRule = {
  id: 'on-combat-start',
  priority: 80,
  match: { event: 'p:combat:start' },
  action: { action: 'tool', tool: 'mud_send', cmd: 'halt' },
}

describe('DecisionCenter 规则 action:"tool" (单步反射)', () => {
  it('规则命中 → 执行工具并记录 route=rule', () => {
    const { center, executed, routes } = makeCenter()
    center.registerRule(combatRule)
    center.onPercept(percept('p:combat:start'))
    expect(executed).toEqual([{ rule: 'on-combat-start', eventType: 'p:combat:start' }])
    expect(routes.at(-1)).toEqual({ eventType: 'p:combat:start', layer: 'rule', id: 'on-combat-start' })
  })

  it('同类事件短窗去重: 窗口内第二次不重复执行', () => {
    const { center, executed } = makeCenter()
    center.registerRule(combatRule)
    center.onPercept(percept('p:combat:start'))
    center.onPercept(percept('p:combat:start'))
    expect(executed).toHaveLength(1)
  })

  it('未注册规则的事件 → 落 agent 兜底', () => {
    const { center, executed, routes } = makeCenter()
    center.onPercept(percept('p:room:busy'))
    expect(executed).toEqual([])
    expect(routes.at(-1)).toEqual({ eventType: 'p:room:busy', layer: 'agent' })
  })

  it('action:"llm" 声明式规则不短路 → 落 agent 兜底', () => {
    const { center, executed, routes } = makeCenter()
    center.registerRule({ id: 'on-death', match: { event: 'p:death' }, action: { action: 'llm' } })
    center.onPercept(percept('p:death'))
    expect(executed).toEqual([])
    expect(routes.at(-1)?.layer).toBe('agent')
  })
})

describe('DecisionCenter 规则 action:"skill" (技能激活)', () => {
  it('系统事件命中规则 → 激活注册的 skill 并记录 route=skill', () => {
    const { center, activated, routes, addSkill } = makeCenter()
    center.registerRule(loginRule)
    addSkill('login')
    center.onSystem(system('login:required'))
    expect(activated).toEqual(['login'])
    expect(routes.at(-1)).toEqual({ eventType: 'login:required', layer: 'skill', id: 'login' })
  })

  it('when 状态守卫不满足 (已登录) → 不激活', () => {
    const { center, activated, addSkill, setState } = makeCenter()
    center.registerRule(loginRule)
    addSkill('login')
    setState({ 'flags.logged_in': true })
    center.onSystem(system('login:required'))
    expect(activated).toEqual([])
    expect(center.skillNames()).toEqual(['login'])
  })

  it('感知事件未命中 tool 规则 → 命中 skill 规则则激活 (优先于 agent 兜底)', () => {
    const { center, activated, routes, addSkill } = makeCenter()
    center.registerRule({ id: 'on-task', match: { event: 'p:task:start' }, action: { action: 'skill', skill: 'task' } })
    addSkill('task')
    center.onPercept(percept('p:task:start'))
    expect(activated).toEqual(['task'])
    expect(routes.at(-1)?.layer).toBe('skill')
  })

  it('skill 未注册时规则命中不激活 (静默)', () => {
    const { center, activated } = makeCenter()
    center.registerRule(loginRule)
    center.onSystem(system('login:required'))
    expect(activated).toEqual([])
  })

  it('unregisterSkill 后不再激活', () => {
    const { center, activated, addSkill } = makeCenter()
    center.registerRule(loginRule)
    addSkill('login')
    expect(center.unregisterSkill('login')).toBe(true)
    center.onSystem(system('login:required'))
    expect(activated).toEqual([])
    expect(center.unregisterSkill('login')).toBe(false)
  })

  it('未命中任何规则的系统事件静默 (不落 agent 兜底)', () => {
    const { center, routes } = makeCenter()
    center.onSystem(system('unknown:event'))
    expect(routes).toEqual([])
  })
})
