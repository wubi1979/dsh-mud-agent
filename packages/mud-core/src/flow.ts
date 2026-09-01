/**
 * dsh-mud-core — 流程引擎 (Flows), host half. (`ctx.mud.flow`)
 *
 * 专门用于**确定性事务流程** (登录/交易/任务链): 每个流程是一段"顺序推进/按
 * 提示驱动"的序列, 与规则引擎的"分支决策"分界 —— 规则负责单步组织 (战斗/
 * 应激反射), 流程负责顺序把握整体 (登录这样的步骤事务)。
 *
 * 与规则引擎协作: 流程期间感知事件 (p:login:*) 也会进总线; 流程订阅这些语义
 * 事件按进度发对应命令。进度由 world 标志 (sent_name/sent_pass/logged_in)
 * 与流程内去重共同防止重复发送。
 *
 * 激活模型:
 *   - 系统级事件 "login:required" (未登录) 激活登录 skill → flow.start;
 *   - 激活后流程注册自身的感知触发规则 (owner "flow:login"), 第一步进入等待;
 *   - 登录完成 → 注销触发规则 (触发器仅在流程活跃期间注入)。
 * @module @deepseek-ai/dsh-mud-core/flow
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyPatch, type WorldModel } from './world.ts'
import type { MudPerceptEvent } from './events.ts'
import type { PerceptionRule, TriggerService } from './triggers.ts'

/** 流程运行状态。 */
export type FlowStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

/** 一份流程的宿主依赖 (host 装配期注入)。 */
export interface FlowHost {
  /** 事件总线 (cordis ctx)。 */
  bus: Pick<Context, 'events'>
  /** 目标 WorldModel (进度标志读取/写入)。 */
  world: WorldModel
  /** 感知触发服务: 流程激活时注册自身感知规则, 完成/中止时注销。 */
  trigger: Pick<TriggerService, 'register' | 'unregisterByOwner'>
  /** 取得账号密码 (activeAccount ?? config.account)。 */
  getAccount: () => { name: string; pass: string }
  /** 发一条命令 (与 agent 同一条 mud_send 执行路径)。 */
  send: (cmd: string) => void
  /** 流程进展 (宿主汇总反馈 agent / 展示)。 */
  onProgress?: (msg: string) => void
  /** 流程已处理一条感知事件 (宿主把命中的行折叠进注入录制器)。 */
  onEvent?: (e: MudPerceptEvent, action: string) => void
  /** 流程失败 (密码错等 / 超时) → 宿主把上下文交给 agent。 */
  onFailed?: (contextText: string) => void
  /** 登录超时阈值。 */
  loginTimeoutMs?: number
}

/** 流程抽象: 实现类订阅总线并按进度推进。 */
interface Flow {
  readonly name: string
  start(host: FlowHost): void
  abort(): void
  status(): FlowStatus
  dispose(): void
}

/** 登录流程注册的感知触发规则 (激活期注入, 完成即注销; owner "flow:login")。 */
const LOGIN_TRIGGERS: readonly PerceptionRule[] = [
  {
    id: 'login:username',
    eventType: 'p:login:prompt',
    priority: 35,
    regex: [/^\s*您的英文名字（要注册新人物请输入new。）：/],
  },
  {
    id: 'login:password',
    eventType: 'p:login:pass',
    priority: 35,
    regex: [/^\s*此ID档案已存在，请输入密码：/],
  },
  {
    id: 'login:success',
    eventType: 'p:login:done',
    priority: 35,
    regex: [/^\s+欢迎来到北大侠客行！/, /^\s*重新连线完毕。/],
  },
  {
    id: 'login:replace',
    eventType: 'p:login:replace',
    priority: 35,
    regex: [/替换.*y\/n/],
  },
  {
    id: 'login:failed',
    eventType: 'p:login:failed',
    priority: 35,
    regex: [/密码错误/],
  },
]

/** 登录流程触发规则 owner (用于批量注销)。 */
const LOGIN_OWNER = 'flow:login'

/**
 * 登录流程 (第一个确定性事务): "提示出现 → 发对应输入"。
 * 事件驱动 (游戏提示到达顺序天然保序), 进度标志防重, 超时 → 交给 agent。
 * 语义与原 rules-decision 的 login:* 原子规则 + index 登录定时器等价。
 */
export class LoginFlow implements Flow {
  readonly name = 'login'
  private readonly bus: Pick<Context, 'events'>
  private host: FlowHost | null = null
  private active = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private flowStatus: FlowStatus = 'idle'
  /** 每次会话内已处理的语义步骤 (防提示重复出发送精确一次)。 */
  private readonly handled = new Set<string>()
  /** 取消订阅函数。 */
  private readonly unsubscribe: () => unknown

  constructor(bus: Pick<Context, 'events'>) {
    this.bus = bus
    this.unsubscribe = this.bus.events.on('mud/percept', (e: MudPerceptEvent) => this.onPercept(e))
  }

  start(host: FlowHost): void {
    this.host = host
    this.active = true
    this.flowStatus = 'running'
    this.handled.clear()
    // 激活: 注册本流程的感知触发规则 (owner "flow:login"), 第一步进入等待。
    for (const t of LOGIN_TRIGGERS) host.trigger.register(t, LOGIN_OWNER)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.onTimeout(), host.loginTimeoutMs ?? 20000)
  }

  /** 结束流程 (完成/失败/中止/销毁): 注销本流程注入的触发规则。 */
  private releaseTriggers(): void {
    if (this.host) this.host.trigger.unregisterByOwner(LOGIN_OWNER)
  }

  abort(): void {
    this.active = false
    this.flowStatus = 'aborted'
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.releaseTriggers()
  }

  status(): FlowStatus {
    return this.flowStatus
  }

  dispose(): void {
    this.abort()
    this.unsubscribe()
  }

  private onTimeout(): void {
    this.timer = null
    if (!this.active) return
    if (this.host?.world.flags.logged_in) {
      this.flowStatus = 'done'
      this.active = false
      this.releaseTriggers()
      return
    }
    // 登录超时: 交给 agent (宿主注入上下文)
    this.flowStatus = 'failed'
    this.active = false
    this.releaseTriggers()
    const host = this.host
    if (host?.onFailed) {
      const progress = host.onProgress !== undefined
      let ctx = ''
      // 进展反馈由宿主自行维护 (onProgress 已记录); 此处仅提示超时原因
      void progress
      ctx = '登录流程超时, 尚未登录。请按 \'登录流程\' 技能步骤, 用 mud_send 完成登录。'
      host.onFailed(ctx)
    }
  }

  /** 感知事件 → 按进度发对应命令 (actlactive 时)。 */
  private onPercept(e: MudPerceptEvent): void {
    if (!this.active || !this.host) return
    const host = this.host
    const world = host.world
    switch (e.type) {
      case 'p:login:prompt': {
        if (this.handled.has('name')) return
        if (world.flags.sent_name) return
        this.handled.add('name')
        applyPatch(world, { sent_name: true })
        host.send(host.getAccount().name)
        host.onProgress?.('用户名提示 → 发账号')
        host.onEvent?.(e, '发送用户名')
        break
      }
      case 'p:login:pass': {
        if (this.handled.has('pass')) return
        if (world.flags.sent_pass) return
        this.handled.add('pass')
        applyPatch(world, { sent_pass: true })
        host.send(host.getAccount().pass)
        host.onProgress?.('密码提示 → 发密码')
        host.onEvent?.(e, '发送密码')
        break
      }
      case 'p:login:replace': {
        if (this.handled.has('replace')) return
        this.handled.add('replace')
        host.send('y')
        host.onProgress?.('同名档案替换 → 确认 y')
        host.onEvent?.(e, '确认替换 (y)')
        break
      }
      case 'p:login:done': {
        if (this.handled.has('done')) return
        this.handled.add('done')
        host.send('look')
        this.flowStatus = 'done'
        this.active = false
        this.releaseTriggers()
        host.onProgress?.('登录成功 → look 刷新房间')
        host.onEvent?.(e, 'look 刷新房间')
        break
      }
      case 'p:login:failed': {
        this.flowStatus = 'failed'
        this.active = false
        this.releaseTriggers()
        host.onFailed?.('登录失败 (密码错误等), 请修订登录策略。')
        break
      }
      default:
        break
    }
  }
}

/**
 * 流程引擎服务 (`ctx.mud.flow`): 命名流程注册表, 提供 start/abort/status。
 * 当前内置登录流程 (LoginFlow); 后续事务流程 (交易/任务) 注册到此。
 */
export class FlowService {
  private readonly flows = new Map<string, Flow>()

  /** 注册一份流程 (已注册同名则替换)。 */
  register(flow: Flow): void {
    this.flows.set(flow.name, flow)
  }

  /** 启动命名流程 (注入宿主依赖)。 */
  start(name: string, host: FlowHost): boolean {
    const flow = this.flows.get(name)
    if (!flow) return false
    flow.start(host)
    return true
  }

  /** 中止命名流程。 */
  abort(name: string): boolean {
    const flow = this.flows.get(name)
    if (!flow) return false
    flow.abort()
    return true
  }

  /** 命名流程状态 (未知返回 idle)。 */
  status(name: string): FlowStatus {
    return this.flows.get(name)?.status() ?? 'idle'
  }

  /** 已注册流程名列表。 */
  names(): string[] {
    return [...this.flows.keys()]
  }

  /** 释放全部已注册流程 (取消订阅/清定时器)。 */
  dispose(): void {
    for (const flow of this.flows.values()) flow.dispose()
    this.flows.clear()
  }
}