/**
 * dsh-mud-core 流程引擎测试 — FlowRuntime + loginFlow (登录确定性事务)。
 *
 * 感知事件 (p:login:*) 经总线进入 → 按进度发对应输入; 进度标志 + 会话去重防重;
 * 超时/失败 → 交给 agent (onFailed)。
 */

import { describe, expect, it, vi } from 'vitest'
import { FlowRuntime, FlowService, type FlowHost, type FlowConfig } from '../src/agent/flow.ts'
import { loginFlow, fullmeFlow } from '../src/config/flows.ts'
import { TriggerService } from '../src/perception/triggers.ts'
import type { MudLine } from '../src/net/ansi.ts'
import { createWorld, flattenWorld } from '../src/world/world.ts'
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

/** 运行器挂到 host 的总线上 (生产装配即同一 ctx): emit(host.bus) 才能驱动流程。 */
function makeFlow(host: FlowHost, cfg: FlowConfig = loginFlow) {
  return new FlowRuntime(host.bus, cfg)
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
    send: (cmd) => { sent.push(...(Array.isArray(cmd) ? cmd : [cmd])) },
    onProgress: (m) => progress.push(m),
    onFailed: (t) => failed.push(t),
    timeoutMs: 1000,
    ...over,
  }
  return { sent, progress, failed, world, host, registeredOwners, unregisteredOwners }
}

describe('FlowRuntime 登录事务 (config/flows)', () => {
  it('prompt → 发账号并置 sent_name; pass → 发密码并置 sent_pass', () => {
    const { sent, world, host } = makeHost()
    const flow = makeFlow(host)
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
    const flow = makeFlow(host)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    expect(sent).toEqual(['alice'])
  })

  it('done → 发空行(退 MXP 检测)+look 并结束流程; replace → 发 y', () => {
    const { sent, host } = makeHost()
    const flow = makeFlow(host)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:replace'))
    expect(sent).toEqual(['y'])
    host.bus.events.emit('mud/percept', percept('p:login:done'))
    expect(sent).toEqual(['y', '', 'look'])
    expect(flow.status()).toBe('done')
  })

  it('failed → 交给 agent (onFailed) 并置 failed 状态', () => {
    const { failed, host } = makeHost()
    const flow = makeFlow(host)
    flow.start(host)
    host.bus.events.emit('mud/percept', percept('p:login:failed'))
    expect(failed.length).toBe(1)
    expect(flow.status()).toBe('failed')
  })

  it('超时未登录 → onFailed (交给 agent)', async () => {
    vi.useFakeTimers()
    try {
      const { failed, host } = makeHost({ timeoutMs: 5000 })
      const flow = makeFlow(host)
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
    const flow = makeFlow(host)
    host.bus.events.emit('mud/percept', percept('p:login:prompt'))
    expect(sent).toEqual([])
    expect(flow.status()).toBe('idle')
  })

  it('激活时注册触发规则 (owner flow:login), 完成后注销', () => {
    const { host, registeredOwners, unregisteredOwners } = makeHost()
    const flow = makeFlow(host)
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
    const svc = new FlowService({
      bus: makeBus(),
      trigger: { register: () => {}, unregisterByOwner: () => 1 },
    })
    expect(svc.names()).toEqual([])
    const { host } = makeHost()
    const flow = makeFlow(host)
    svc.register(flow)
    expect(svc.names()).toEqual(['login'])
    expect(svc.start('login', host)).toBe(true)
    expect(svc.status('login')).toBe('running')
    expect(svc.abort('login')).toBe(true)
    expect(svc.status('login')).toBe('aborted')
    expect(svc.start('nonexistent', host)).toBe(false)
    expect(svc.status('nonexistent')).toBe('idle')
  })

  it('活跃时 start 防重 (repeat=false); repeat=true 允许重入', () => {
    const svc = new FlowService({
      bus: makeBus(),
      trigger: { register: () => {}, unregisterByOwner: () => 1 },
    })
    const { host } = makeHost()
    svc.register(makeFlow(host), host)
    expect(svc.start('login')).toBe(true)
    expect(svc.start('login')).toBe(false) // 已活跃, 防重
    expect(svc.start('login', undefined, { repeat: true })).toBe(true)
  })
})

describe('FlowRuntime fullme 事务 (config/flows)', () => {
  /** 携带 data 的感知事件。 */
  const withData = (type: string, data: Record<string, unknown> | null = null): MudPerceptEvent =>
    ({ type, data, line: 0, ts: Date.now() })

  it('request → 发 fullme; 捕获图片 → 推送确认框并正常结束 (markDone)', () => {
    const { sent, host } = makeHost()
    const flow = makeFlow(host, fullmeFlow)
    let captchaUrl = ''
    host.onCaptcha = (url) => { captchaUrl = url }
    flow.start(host)

    host.bus.events.emit('mud/percept', withData('p:fullme:request'))
    expect(sent).toEqual(['fullme'])

    host.bus.events.emit('mud/percept', withData('p:fullme:image', { url: 'http://fullme.pkuxkx.net/robot.php?filename=1' }))
    expect(captchaUrl).toBe('http://fullme.pkuxkx.net/robot.php?filename=1')
    expect(flow.status()).toBe('done')
  })

  it('冷却期: 收到"你刚刚用过这个命令不久" → 短路结束, 不发验证 (markDone)', () => {
    const { sent, host } = makeHost()
    const flow = makeFlow(host, fullmeFlow)
    flow.start(host)

    host.bus.events.emit('mud/percept', withData('p:fullme:request'))
    expect(sent).toEqual(['fullme'])

    host.bus.events.emit('mud/percept', withData('p:fullme:cooldown'))
    expect(sent).toEqual(['fullme']) // 无中间环节, 不再发命令
    expect(flow.status()).toBe('done')
  })

  it('未完成: "你之前请求的fullme还没有完成" → 发 fullme 1 三次放弃, 最后一发收"太遗憾了"结束', () => {
    const { sent, host } = makeHost()
    const flow = makeFlow(host, fullmeFlow)
    flow.start(host)

    host.bus.events.emit('mud/percept', withData('p:fullme:request'))
    expect(sent).toEqual(['fullme'])

    // 未完成提示 → 发第1发 fullme 1
    host.bus.events.emit('mud/percept', withData('p:fullme:not-completed'))
    expect(sent).toEqual(['fullme', 'fullme 1'])

    // 第1发错误提示 → 发第2发
    host.bus.events.emit('mud/percept', withData('p:fullme:wrong-input'))
    expect(sent).toEqual(['fullme', 'fullme 1', 'fullme 1'])

    // 第2发错误提示 → 发第3发
    host.bus.events.emit('mud/percept', withData('p:fullme:wrong-input'))
    expect(sent).toEqual(['fullme', 'fullme 1', 'fullme 1', 'fullme 1'])

    // 第3发 → "太遗憾了" 结束
    host.bus.events.emit('mud/percept', withData('p:fullme:final-failure'))
    expect(sent.filter(c => c === 'fullme 1')).toHaveLength(3)
    expect(flow.status()).toBe('failed')
  })

  /** 构造一行感知标准行 (watch 正则匹配用的 text 视图)。 */
  const line = (text: string, abs = 0): MudLine =>
    ({ text, raw: text, style: [], abs, time: Date.now(), isPrompt: false })

  it('watch 严格整句锚定: 仅触发句命中, 其它含 fullme 文本一律不触发', () => {
    // 用 TriggerService 注册 fullmeFlow 的 watch 规则, 走真实 Perceptor 匹配。
    const svc = new TriggerService({ bus: makeBus(), publish: false })
    const watchRules = fullmeFlow.watch ?? []
    expect(watchRules.length).toBe(1)
    for (const rule of watchRules) svc.register(rule)

    const hits = (text: string) => svc.match([line(text)])

    // 触发句整行 (含行首尾空白) → 命中 p:fullme:request
    expect(hits('  5M后长时间不使用fullme，会被系统判定为机器人。  ')
      .some(h => h.eventType === 'p:fullme:request')).toBe(true)

    // 其它含 fullme 的文本 → 均不命中
    const others = [
      'http://fullme.pkuxkx.net/robot.php?filename=1',              // 图片 URL
      '你之前请求的fullme还没有完成，如果图片已过期，可以打三次fullme 1放弃本次fullme。',
      '你刚刚用过这个命令不久，还要10分钟35秒才能再用。',
      '好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！',
      '太遗憾了。',
      'Please fullme now to verify your identity.',                 // 英文/其它 fullme 文本
      'fullme 1',                                                    // 放弃命令回显
      '系统提示:fullme马上开始了',                                   // 含 fullme 但非整句
    ]
    for (const t of others) {
      expect(hits(t).some(h => h.eventType === 'p:fullme:request'),
        `应不命中: "${t}"`).toBe(false)
    }
  })

  it('超时未捕获图片 → onFailed', async () => {
    vi.useFakeTimers()
    try {
      const { failed, host } = makeHost({ timeoutMs: 5000 })
      const flow = makeFlow(host, fullmeFlow)
      flow.start(host)
      vi.advanceTimersByTime(5000)
      expect(failed.length).toBe(1)
      expect(flow.status()).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })
})