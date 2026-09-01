/**
 * dsh-mud-core 流程引擎测试 — LoginFlow (登录确定性事务)。
 *
 * 感知事件 (p:login:*) 经总线进入 → 按进度发对应输入; 进度标志 + 会话去重防重;
 * 超时/失败 → 交给 agent (onFailed)。
 */

import { describe, expect, it, vi } from 'vitest'
import { LoginFlow, FlowService, type FlowHost } from '../src/flow.ts'
import { createWorld, flattenWorld } from '../src/world.ts'
import type { MudPerceptEvent } from '../src/events.ts'

/** 极简总线桩 (cordis ctx.events.on/emit)。 */
function makeBus() {
  const listeners = new Map<string, ((e: never) => void)[]>()
  return {
    events: {
      on: (name: string, cb: (e: never) => void) => {
        const list = listeners.get(name) ?? []
        list.push(cb)
        listeners.set(name, list)
        return () => {}
      },
      emit: (name: string, e: never) => { (listeners.get(name) ?? []).forEach(cb => cb(e)) },
    },
  }
}

function percept(type: string): MudPerceptEvent {
  return { type, data: null, line: 0, ts: Date.now() }
}

function makeHost(over?: Partial<FlowHost>) {
  const sent: string[] = []
  const progress: string[] = []
  const failed: string[] = []
  const world = createWorld()
  // 触发服务桩: 记录注册/注销的 owner, 便于断言激活/释放。
  const registeredOwners: string[] = []
  const unregisteredOwners: string[] = []
  const host: FlowHost = {
    bus: makeBus(),
    world,
    trigger: {
      register: (_rule, owner = '') => registeredOwners.push(owner),
      unregisterByOwner: (owner) => { unregisteredOwners.push(owner); return 1 },
    },
    getAccount: () => ({ name: 'alice', pass: 's3cret' }),
    send: (cmd) => sent.push(cmd),
    onProgress: (m) => progress.push(m),
    onFailed: (t) => failed.push(t),
    loginTimeoutMs: 1000,
    ...over,
  }
  return { sent, progress, failed, world, host, registeredOwners, unregisteredOwners }
}

describe('LoginFlow 登录事务', () => {
  it('prompt → 发账号并置 sent_name; pass → 发密码并置 sent_pass', () => {
    const { sent, world, host } = makeHost()
    const flow = new LoginFlow(host.bus)
    flow.start(host)

    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    expect(sent).toEqual(['alice'])
    expect(world.flags.sent_name).toBe(true)

    host.bus.events.emit('mud/percept', percept('p:login:pass'))
    expect(sent).toEqual(['alice', 's3cret'])
    expect(world.flags.sent_pass).toBe(true)
  })

  it('提示重复/prompt 再触发不重复发送 (已置位即跳过)', () => {
    const { sent, host } = makeHost()
    const flow = new LoginFlow(host.bus)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    expect(sent).toEqual(['alice'])
  })

  it('done → 发 look 并结束流程; replace → 发 y', () => {
    const { sent, host } = makeHost()
    const flow = new LoginFlow(host.bus)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:replace'))
    expect(sent).toEqual(['y'])
    host.bus.events.emit('mud/percept', percept('p:login:done'))
    expect(sent).toEqual(['y', 'look'])
    expect(flow.status()).toBe('done')
  })

  it('failed → 交给 agent (onFailed) 并置 failed 状态', () => {
    const { failed, host } = makeHost()
    const flow = new LoginFlow(host.bus)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:failed'))
    expect(failed.length).toBe(1)
    expect(flow.status()).toBe('failed')
  })

  it('超时未登录 → onFailed (交给 agent)', async () => {
    vi.useFakeTimers()
    try {
      const { failed, host } = makeHost({ loginTimeoutMs: 5000 })
      const flow = new LoginFlow(host.bus)
      flow.start(host)
      expect(flow.status()).toBe('running')
      vi.advanceTimersByTime(5000)
      expect(failed.length).toBe(1)
      expect(flow.status()).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('未 start 时不响应感知事件', () => {
    const { sent, host } = makeHost()
    const flow = new LoginFlow(host.bus)
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    expect(sent).toEqual([])
    expect(flow.status()).toBe('idle')
  })

  it('激活时注册触发规则 (owner flow:login), 完成后注销', () => {
    const { host, registeredOwners, unregisteredOwners } = makeHost()
    const flow = new LoginFlow(host.bus)
    flow.start(host)
    expect(registeredOwners).toHaveLength(5)
    expect(new Set(registeredOwners)).toEqual(new Set(['flow:login']))
    expect(unregisteredOwners).toEqual([])
    host.bus.events.emit('mud/percept', percept('p:login:done'))
    expect(flow.status()).toBe('done')
    expect(unregisteredOwners).toEqual(['flow:login'])
  })
})

describe('FlowService 流程注册表', () => {
  it('register/start/abort/status/names', () => {
    const svc = new FlowService()
    expect(svc.names()).toEqual([])
    const { host } = makeHost()
    const flow = new LoginFlow(host.bus)
    svc.register(flow)
    expect(svc.names()).toEqual(['login'])
    expect(svc.start('login', host)).toBe(true)
    expect(svc.status('login')).toBe('running')
    expect(svc.abort('login')).toBe(true)
    expect(svc.status('login')).toBe('aborted')
    expect(svc.start('nonexistent', host)).toBe(false)
    expect(svc.status('nonexistent')).toBe('idle')
  })
})