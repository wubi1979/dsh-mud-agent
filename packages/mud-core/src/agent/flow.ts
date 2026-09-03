/**
 * dsh-mud-core — 流程引擎 (Flows), host half. (`ctx.mud.flow`)
 *
 * flow = 确定性事务 (与 skill 正交): skill 是 agent 的决策单元 (被动, 给 LLM
 * 看), flow 是系统主动调用的确定性执行体 (唯一激活入口 `flow.start`)。调用
 * 来源有三, flow 与来源无关:
 *   - 系统 watch: flow 声明的常驻探测触发器命中 → 自动 flow.start;
 *   - 人类 UI / 规则直调: decision-rules action:"flow" 或宿主直接调用;
 *   - agent 经 skill 绑定: skill 步骤指名调用。
 *
 * 激活模型 (不变式):
 *   - `flow.start` **原子注册**该 flow 的全部事务触发器 (triggers), 严格先于
 *     任何 driver.send — "先捕获再执行"与"先执行再捕获"都靠这一点保证捕图
 *     类触发器不会漏掉关键回显;
 *   - watch 触发器由 FlowService 装配时注册 (owner `watch:<id>`), 常驻不注销;
 *   - 完成/失败/中止 → 注销事务触发器; watch 不随事务注销。
 * @module @deepseek-ai/dsh-mud-core/flow
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyPatch, type WorldModel } from '../world/world.ts'
import type { MudPerceptEvent } from '../events.ts'
import type { PerceptionRule, TriggerService } from '../perception/triggers.ts'

/** 流程运行状态。 */
export type FlowStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

/** flow.start 选项。 */
export interface FlowStartOptions {
  /** 激活源感知事件 (watch 命中等): 注册完成后作为第一条事件递给 onPercept。 */
  source?: MudPerceptEvent | null
  /** 重入: 活跃时允许重新开始 (缺省 false — 防重)。 */
  repeat?: boolean
}

/** 一份流程的宿主依赖 (host 装配期注入, 每 flow 一份)。 */
export interface FlowHost {
  /** 事件总线 (cordis ctx)。 */
  bus: Pick<Context, 'events'>
  /** 目标 WorldModel (进度标志读取/写入)。 */
  world: WorldModel
  /** 感知触发服务: 流程激活时注册自身感知规则, 完成/中止时注销。 */
  trigger: Pick<TriggerService, 'register' | 'unregisterByOwner'>
  /** 取得账号密码 (activeAccount ?? config.account)。 */
  getAccount: () => { name: string; pass: string }
  /** 发命令 (与 agent 同一条 mud_send 执行路径)。数组 = 命令序列 (允许空命令)。 */
  send: (cmd: string | string[]) => void
  /** 流程进展 (宿主汇总反馈 agent / 展示)。 */
  onProgress?: (msg: string) => void
  /** 流程成功结束 — 宿主据此记录"成功"结束决策。 */
  onDone?: () => void
  /** 流程已处理一条感知事件 (宿主把命中的行折叠进注入录制器)。 */
  onEvent?: (e: MudPerceptEvent, action: string) => void
  /** 流程失败 (超时等) → 宿主把上下文交给 agent。 */
  onFailed?: (contextText: string) => void
  /** 验证码交互: 捕获到图片地址 → 推送 WebUI 确认框 (fullme 类流程)。 */
  onCaptcha?: (url: string) => void
  /** 超时阈值覆盖 (缺省用 FlowConfig.timeoutMs)。 */
  timeoutMs?: number
}

/** flow 运行期服务 (FlowService 注入; 直接构造 FlowRuntime 时可省略 startFlow)。 */
export interface FlowServices {
  /** 子流程激活: driver.startFlow 委托到此 (FlowService.start)。 */
  startFlow?: (id: string, source?: MudPerceptEvent | null) => boolean
}

/** 流程抽象: 实现类订阅总线并按进度推进。 */
interface Flow {
  readonly name: string
  /** 激活流程 (返回是否实际激活; false = 已活跃且未允许重入)。 */
  start(host: FlowHost, opts?: FlowStartOptions): boolean
  abort(): void
  status(): FlowStatus
  dispose(): void
}

/**
 * FlowConfig 提供的驱动句柄: 运行器把宿主依赖 + 运行器状态 (防重/收尾) 封装
 * 成纯数据/纯动作传给 config 的函数, 使 flow 配置不知道运行时内部。
 */
export interface FlowDriver {
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
  patchWorld: (patch: Record<string, unknown>) => void
  /** 进展反馈 (宿主汇总给 agent / 展示)。 */
  progress: (msg: string) => void
  /** 已处理一条感知事件 (宿主把命中的行折叠进注入录制器)。 */
  event: (e: MudPerceptEvent, action: string) => void
  /** 验证码交互: 捕获到图片地址 → 推送 WebUI 确认框。 */
  captcha: (url: string) => void
  /** 成功收尾 (触发宿主 onDone)。 */
  done: () => void
  /** 静默成功收尾 (不触发宿主 onDone; 用于"超时但已成功"类场景)。 */
  markDone: () => void
  /** 失败收尾 (触发宿主 onFailed 交给 agent)。 */
  failed: (ctx: string) => void
  /** 子流程激活 (如 reconnect → login): 委托 FlowService.start。 */
  startFlow: (id: string, source?: MudPerceptEvent | null) => boolean
}

/**
 * 一份确定性事务流程的静态配置 (由 config/flows.ts 提供)。运行器 (FlowRuntime)
 * 读取它: watch + 触发正则 + 事件分支处理 + 超时处理, 全部为纯函数, 不含运行
 * 时构造。
 */
export interface FlowConfig {
  /** flow 名 (FlowService 注册键 / skill 步骤指名的执行体)。 */
  id: string
  /** 事务触发器批量注销标识。 */
  owner: string
  /** 默认超时 (宿主 FlowHost.timeoutMs 可覆盖)。 */
  timeoutMs: number
  /** 常驻探测触发器 (watch): 装配期注册, 命中 → 自动 flow.start (可携捕获数据)。 */
  watch?: readonly PerceptionRule[]
  /** 激活期注册的感知触发规则 (start 时原子注册, 先于任何 send)。 */
  triggers: readonly PerceptionRule[]
  /** 纯函数: 感知事件 → 分支响应 (用 driver 声明要做什么)。 */
  onPercept: (driver: FlowDriver, e: MudPerceptEvent) => void
  /** 纯函数: 超时处理。 */
  onTimeout: (driver: FlowDriver) => void
}

/**
 * 通用流程运行器 (flow-agnostic): 读取一份 FlowConfig, 管理生命周期 / 触发器
 * 注册注销 / 计时, 具体业务 (watch + 正则 + 分支 + 超时) 委托给配置的纯函数。
 */
export class FlowRuntime implements Flow {
  readonly name: string
  private readonly cfg: FlowConfig
  private readonly services: FlowServices
  private readonly bus: Pick<Context, 'events'>
  private host: FlowHost | null = null
  private active = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private flowStatus: FlowStatus = 'idle'
  /** 本次会话内已处理的语义步骤 (防提示重复出发送精确一次)。 */
  private readonly handled = new Set<string>()
  /** 取消订阅函数。 */
  private readonly unsubscribe: () => unknown

  constructor(bus: Pick<Context, 'events'>, cfg: FlowConfig, services: FlowServices = {}) {
    this.bus = bus
    this.cfg = cfg
    this.services = services
    this.name = cfg.id
    this.unsubscribe = this.bus.events.on('mud/percept', (e: MudPerceptEvent) => this.onPercept(e))
  }

  /** watch 规则声明 (FlowService 装配常驻探测用)。 */
  get watchRules(): readonly PerceptionRule[] {
    return this.cfg.watch ?? []
  }

  /** 注入运行期服务 (FlowService 注册时回填 startFlow; 供子流程调用)。 */
  attachServices(services: FlowServices): void {
    Object.assign(this.services as Record<string, unknown>, services)
  }

  /**
   * 激活流程: **原子注册**全部事务触发器 (不变式: 先于任何 driver.send), 进入
   * 等待; 有激活源事件 (watch 命中等) 则随后作为第一条感知事件递给 onPercept。
   * 活跃时缺省防重 (repeat=true 才允许重入)。
   * @returns 是否实际激活 (false = 已活跃且未允许重入)。
   */
  start(host: FlowHost, opts: FlowStartOptions = {}): boolean {
    if (this.active && !opts.repeat) return false
    this.host = host
    this.active = true
    this.flowStatus = 'running'
    this.handled.clear()
    // 激活: 原子注册本 flow 的事务触发规则, 进入等待 (先于任何 send / 源事件)。
    for (const t of this.cfg.triggers) host.trigger.register(t, this.cfg.owner)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.onTimeout(), host.timeoutMs ?? this.cfg.timeoutMs)
    // 激活源事件 (watch 命中捕获的数据): 注册完成后立即分支处理。
    if (opts.source) this.onPercept(opts.source)
    return true
  }

  /** 结束流程 (完成/失败/中止/销毁): 注销本 flow 注入的事务触发规则。 */
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

  /** 装配 driver: 把宿主依赖 + 运行器收尾状态暴露给 flow 配置。 */
  private makeDriver(host: FlowHost): FlowDriver {
    return {
      world: host.world,
      account: () => host.getAccount(),
      send: (cmd) => host.send(cmd),
      handled: (step) => this.handled.has(step),
      markHandled: (step) => { this.handled.add(step) },
      patchWorld: (patch) => applyPatch(host.world, patch),
      progress: (msg) => host.onProgress?.(msg),
      event: (e, action) => host.onEvent?.(e, action),
      captcha: (url) => host.onCaptcha?.(url),
      done: () => { this.finalize('done'); host.onDone?.() },
      markDone: () => { this.finalize('done') },
      failed: (ctx) => { this.finalize('failed'); host.onFailed?.(ctx) },
      startFlow: (id, source) => this.services.startFlow?.(id, source) ?? false,
    }
  }

  private onTimeout(): void {
    this.timer = null
    if (!this.active || !this.host) return
    this.cfg.onTimeout(this.makeDriver(this.host))
  }

  /** 感知事件 → 交给 flow 配置的 onPercept 分支处理。 */
  private onPercept(e: MudPerceptEvent): void {
    if (!this.active || !this.host) return
    this.cfg.onPercept(this.makeDriver(this.host), e)
  }
}

/** FlowService 注册条目: 运行器 + 装配期宿主 (watch 命中时用)。 */
interface FlowEntry {
  flow: Flow
  /** watch 规则声明 (装配常驻探测用; 未声明 watch 的 flow 为空表)。 */
  watchRules: readonly PerceptionRule[]
  host: FlowHost | null
}

/**
 * 流程引擎服务 (`ctx.mud.flow`): 命名流程注册表 + watch 常驻探测 + start/abort/status。
 * 每个流程由 FlowRuntime(FlowConfig) 实例注册 (config/flows.ts 定义); 后续事务
 * 流程 (交易/任务) 只需新增 config 条目 + 装配一行。
 */
export class FlowService {
  private readonly entries = new Map<string, FlowEntry>()
  private readonly bus: Pick<Context, 'events'>
  private readonly trigger: Pick<TriggerService, 'register' | 'unregisterByOwner'>
  private readonly disposeWatch: () => unknown
  /** 运行期服务 (注册时回填运行器; 子流程 startFlow → 本服务 start)。 */
  private readonly services: FlowServices

  constructor({ bus, trigger }: {
    bus: Pick<Context, 'events'>
    trigger: Pick<TriggerService, 'register' | 'unregisterByOwner'>
  }) {
    this.bus = bus
    this.trigger = trigger
    this.services = {
      startFlow: (id, source) => this.start(id, undefined, source ? { source } : {}),
    }
    // watch 常驻探测: 感知事件命中某 flow 的 watch 事件类型 → 自动激活该 flow
    // (防重由 FlowRuntime.start 兜底: 已活跃时忽略, 支持调用方显式 repeat)。
    this.disposeWatch = this.bus.events.on('mud/percept', (e: MudPerceptEvent) => {
      for (const entry of this.entries.values()) {
        if (!entry.watchRules.some(w => (w.eventType || w.id) === e.type)) continue
        if (entry.flow.status() === 'running') continue
        this.start(entry.flow.name, undefined, { source: e })
        return
      }
    })
  }

  /** 注册一份流程 (已注册同名则替换); host 为装配期宿主 (watch 激活用)。
   *  同时回填运行期服务 (子流程 startFlow 委托本服务)。 */
  register(flow: Flow, host: FlowHost | null = null): void {
    const prev = this.entries.get(flow.name)
    if (prev) this.unregisterWatch(prev)
    const watchRules = flow instanceof FlowRuntime ? flow.watchRules : []
    if (flow instanceof FlowRuntime) flow.attachServices(this.services)
    this.entries.set(flow.name, { flow, watchRules, host })
    // 常驻注册 watch 规则 (owner `watch:<id>`): 命中 → publish 事件 → 上方订阅激活。
    for (const rule of watchRules) this.trigger.register(rule, `watch:${flow.name}`)
  }

  /** 注销一份流程 (注销 watch + 释放运行器)。 */
  unregister(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    this.unregisterWatch(entry)
    entry.flow.dispose()
    this.entries.delete(name)
  }

  /** 注销一份流程的 watch 探测触发器。 */
  private unregisterWatch(entry: FlowEntry): void {
    if (entry.watchRules.length > 0) this.trigger.unregisterByOwner(`watch:${entry.flow.name}`)
  }

  /**
   * 启动命名流程: host 缺省用注册时装配的宿主; opts 透传 (source / repeat)。
   * 子流程调用入口 (driver.startFlow → 此处)。
   */
  start(name: string, host?: FlowHost, opts: FlowStartOptions = {}): boolean {
    const entry = this.entries.get(name)
    const resolved = host ?? entry?.host
    if (!entry || !resolved) return false
    return entry.flow.start(resolved, opts)
  }

  /** 中止命名流程。 */
  abort(name: string): boolean {
    const entry = this.entries.get(name)
    if (!entry) return false
    entry.flow.abort()
    return true
  }

  /** 命名流程状态 (未知返回 idle)。 */
  status(name: string): FlowStatus {
    return this.entries.get(name)?.flow.status() ?? 'idle'
  }

  /** 已注册流程名列表。 */
  names(): string[] {
    return [...this.entries.keys()]
  }

  /** 释放全部已注册流程 (取消订阅/清定时器/注销 watch)。 */
  dispose(): void {
    this.disposeWatch()
    for (const entry of this.entries.values()) {
      this.unregisterWatch(entry)
      entry.flow.dispose()
    }
    this.entries.clear()
  }
}
