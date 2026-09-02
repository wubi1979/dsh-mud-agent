/**
 * dsh-mud-core — 流程引擎 (Flows), host half. (`ctx.mud.flow`)
 *
 * 专门用于**确定性事务流程** (登录/交易/任务链): 每个流程是一段"顺序推进/按
 * 提示驱动"的序列, 与规则引擎的"分支决策"分界 —— 规则负责单步组织 (战斗/
 * 应激反射), 流程负责顺序把握整体 (登录这样的步骤事务)。
 *
 * 与规则引擎协作: 流程期间感知事件 (p:*) 也会进总线; 流程订阅这些语义事件按
 * 进度发对应命令。
 *
 * 本模块是**通用 (workflow-agnostic) 运行器**: 具体流程 (登录/交易/任务)
 * 由 config/workflows.ts 的 WorkflowConfig 用纯函数声明 (触发正则 + 事件分支
 * 处理 + 超时), 本模块的 FlowRuntime 只负责生命周期/触发器注册注销/计时, 不
 * 含任何具体业务 —— 消除 login 专属执行器。
 *
 * 激活模型:
 *   - 系统级事件 "login:required" (未登录) 激活登录 skill → flow.start;
 *   - 激活后运行器注册该 workflow 的触发规则 (owner), 第一步进入等待;
 *   - 完成 → 注销触发规则 (触发器仅在流程活跃期间注入)。
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
  /** 发命令 (与 agent 同一条 mud_send 执行路径)。数组 = 命令序列 (允许空命令, 如登录后空行退 MXP)。 */
  send: (cmd: string | string[]) => void
  /** 流程进展 (宿主汇总反馈 agent / 展示)。 */
  onProgress?: (msg: string) => void
  /** 流程成功结束 (登录完成) — 宿主据此记录"成功"结束决策。 */
  onDone?: () => void
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

/**
 * workflow 配置提供的驱动句柄: 运行器把宿主依赖 + 运行器状态 (防重/收尾) 封装
 * 成纯数据/纯动作传给 config 的函数, 使 workflow 配置不知道运行时内部。
 */
export interface WorkflowDriver {
  /** 目标 WorldModel (读进度标志 / 写 patchWorld)。 */
  world: WorldModel
  /** 取得账号密码。 */
  account: () => { name: string; pass: string }
  /** 发命令 (数组 = 命令序列, 允许空命令退 MXP)。 */
  send: (cmd: string | string[]) => void
  /** 本次会话内某语义步骤是否已处理 (防重复)。 */
  handled: (step: string) => boolean
  /** 标记某语义步骤已处理。 */
  markHandled: (step: string) => void
  /** 写 WorldModel (进度标志等)。 */
  patchWorld: (patch: object) => void
  /** 进展反馈 (宿主汇总给 agent / 展示)。 */
  progress: (msg: string) => void
  /** 已处理一条感知事件 (宿主把命中的行折叠进注入录制器)。 */
  event: (e: MudPerceptEvent, action: string) => void
  /** 成功收尾 (触发宿主 onDone)。 */
  done: () => void
  /** 静默成功收尾 (不触发宿主 onDone; 用于"超时但已成功"类场景)。 */
  markDone: () => void
  /** 失败收尾 (触发宿主 onFailed 交给 agent)。 */
  failed: (ctx: string) => void
}

/**
 * 一份确定性事务流程的静态配置 (由 config/workflows.ts 提供)。运行器 (FlowRuntime)
 * 读取它: 以及触发正则 + 事件分支处理 + 超时处理, 全部为纯函数, 不含运行时构造。
 */
export interface WorkflowConfig {
  /** workflow 名 (FlowService 注册键 / skill 绑定执行后端)。 */
  id: string
  /** 触发规则批量注销标识。 */
  owner: string
  /** 默认超时 (宿主 loginTimeoutMs 可覆盖)。 */
  timeoutMs: number
  /** 激活期注册的感知触发规则。 */
  triggers: readonly PerceptionRule[]
  /** 纯函数: 感知事件 → 分支响应 (用 driver 声明要做什么)。 */
  onPercept: (driver: WorkflowDriver, e: MudPerceptEvent) => void
  /** 纯函数: 超时处理。 */
  onTimeout: (driver: WorkflowDriver) => void
}

/**
 * 通用流程运行器 (workflow-agnostic): 读取一份 WorkflowConfig, 管理生命周期 /
 * 触发器注册注销 / 计时, 具体业务 (正则 + 分支 + 超时) 委托给配置的纯函数。
 * skill 是声明式能力, workflow 是确定性执行体; 本类 = 执行后端的薄壳。
 */
export class FlowRuntime implements Flow {
  readonly name: string
  private readonly cfg: WorkflowConfig
  private readonly bus: Pick<Context, 'events'>
  private host: FlowHost | null = null
  private active = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private flowStatus: FlowStatus = 'idle'
  /** 本次会话内已处理的语义步骤 (防提示重复出发送精确一次)。 */
  private readonly handled = new Set<string>()
  /** 取消订阅函数。 */
  private readonly unsubscribe: () => unknown

  constructor(bus: Pick<Context, 'events'>, cfg: WorkflowConfig) {
    this.bus = bus
    this.cfg = cfg
    this.name = cfg.id
    this.unsubscribe = this.bus.events.on('mud/percept', (e: MudPerceptEvent) => this.onPercept(e))
  }

  start(host: FlowHost): void {
    this.host = host
    this.active = true
    this.flowStatus = 'running'
    this.handled.clear()
    // 激活: 注册本 workflow 的感知触发规则, 进入等待。
    for (const t of this.cfg.triggers) host.trigger.register(t, this.cfg.owner)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.onTimeout(), host.loginTimeoutMs ?? this.cfg.timeoutMs)
  }

  /** 结束流程 (完成/失败/中止/销毁): 注销本 workflow 注入的触发规则。 */
  private releaseTriggers(): void {
    if (this.host) this.host.trigger.unregisterByOwner(this.cfg.owner)
  }

  /** 统一收尾: 置状态 + 退出活跃 + 注销触发规则 + 停计时。 */
  private finalize(status: FlowStatus): void {
    this.active = false
    this.flowStatus = status
    this.releaseTriggers()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  abort(): void {
    if (!this.active) return
    this.finalize('aborted')
  }

  status(): FlowStatus {
    return this.flowStatus
  }

  dispose(): void {
    this.abort()
    this.unsubscribe()
  }

  /** 装配 driver: 把宿主依赖 + 运行器收尾状态暴露给 workflow 配置。 */
  private makeDriver(host: FlowHost): WorkflowDriver {
    return {
      world: host.world,
      account: () => host.getAccount(),
      send: (cmd) => host.send(cmd),
      handled: (step) => this.handled.has(step),
      markHandled: (step) => { this.handled.add(step) },
      patchWorld: (patch) => applyPatch(host.world, patch),
      progress: (msg) => host.onProgress?.(msg),
      event: (e, action) => host.onEvent?.(e, action),
      done: () => { this.finalize('done'); host.onDone?.() },
      markDone: () => { this.finalize('done') },
      failed: (ctx) => { this.finalize('failed'); host.onFailed?.(ctx) },
    }
  }

  private onTimeout(): void {
    this.timer = null
    if (!this.active || !this.host) return
    this.cfg.onTimeout(this.makeDriver(this.host))
  }

  /** 感知事件 → 交给 workflow 配置的 onPercept 分支处理。 */
  private onPercept(e: MudPerceptEvent): void {
    if (!this.active || !this.host) return
    this.cfg.onPercept(this.makeDriver(this.host), e)
  }
}

/**
 * 流程引擎服务 (`ctx.mud.flow`): 命名流程注册表, 提供 start/abort/status。
 * 每个流程由 FlowRuntime(WorkflowConfig) 实例注册 (config/workflows.ts 定义);
 * 后续事务流程 (交易/任务) 只需新增 config 条目 + 注册一个 FlowRuntime。
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