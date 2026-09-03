/**
 * dsh-mud-core — 统一事件决策中心 (Dispatcher), host half. (`ctx.mud.dispatcher`)
 *
 * 可行动事件的统一处理中心。与感知/状态解耦:
 *   - 感知 (trigger)   只负责文本匹配 → 产出感知事件;
 *   - 状态 (state)     只负责 world 同步 (GMCP 权威 + 文本静默推断), 不参与决策;
 *   - 本中心           只处理"需要决策"的可行动事件, 统一路由。
 *
 * 路由模型 (单条管线, 决策知识全部集中在规则表):
 *   事件 → 规则匹配 (when 条件)
 *     ├─ action:"tool"  确定性单步 (战斗/死亡反射): 执行工具, 轻量短路;
 *     ├─ action:"flow"  直调命名 flow (唯一激活入口 flow.start, 如 login):
 *     │                 经宿主回调 startFlow 启动, 幂等 (已运行时忽略);
 *     └─ 未命中 / action:"llm" → agent 兜底 (重型, 游戏输出注入 agent)。
 *
 * flow 激活不经过 skill 注册表: skill 是 agent 的决策单元 (被动, 给 LLM 看),
 * 系统确定性调用的执行体是 flow — 触发时机 (规则表) 与执行体 (FlowService)
 * 在此解耦。
 * @module @deepseek-ai/dsh-mud-core/dispatcher
 */

import { RuleEngine, type DecisionRule, type NormalizedRule } from './decision.ts'
import type { MudPerceptEvent, MudSystemEvent } from '../events.ts'

/** 路由落点。 */
export type RouteLayer = 'rule' | 'flow' | 'agent'

/** 决策中心宿主依赖 (index 装配期注入)。 */
export interface DecisionCenterHost {
  /** 扁平世界状态提供者 (flattenWorld(world))。 */
  stateProvider: () => Record<string, unknown>
  /** 规则命中 (action:"tool") → 宿主执行工具 + 应用副作用 + 记录。 */
  executeRule: (rule: NormalizedRule, eventType: string) => void
  /** 规则命中 (action:"flow") → 宿主 flow.start (幂等: 已运行返回 false)。 */
  startFlow: (flowId: string) => boolean
  /** 路由结果记录 (tuiDecision)。 */
  onRoute?: (eventType: string, layer: RouteLayer, id?: string) => void
  /** 同类语义事件去重窗口 (ms)。 */
  dedupMs?: number
}

/**
 * 统一事件决策中心 (`ctx.mud.dispatcher`): 可行动事件的统一路由。
 * 决策知识集中在规则表 (tool 单步 / flow 直调), agent 兜底。
 */
export class DecisionCenter {
  private readonly ruleEngine: RuleEngine
  private readonly dedup = new Map<string, number>()
  private readonly host: DecisionCenterHost
  private readonly dedupMs: number

  constructor(host: DecisionCenterHost) {
    this.host = host
    this.dedupMs = host.dedupMs ?? 1500
    this.ruleEngine = new RuleEngine({ stateProvider: () => host.stateProvider() })
  }

  /** 注册一条决策规则 (单步反射 / flow 直调; 按 priority 排序)。 */
  registerRule(rule: DecisionRule): void {
    this.ruleEngine.register(rule)
  }

  /**
   * 可行动感知事件 → 统一路由: 规则(tool 执行 / flow 直调) → agent 兜底。
   * 同类语义事件短窗去重 (战斗开始的"杀气/向你扑来"等多行只处理一次)。
   */
  onPercept(e: MudPerceptEvent): void {
    const now = Date.now()
    const last = this.dedup.get(e.type)
    if (last !== undefined && now - last < this.dedupMs) return
    const state = this.host.stateProvider()
    const rule = this.ruleEngine.match({ eventType: e.type, state })
    const hit = rule ? this.dispatch(e.type, rule) : null
    if (hit?.layer === 'rule') this.dedup.set(e.type, now)
    if (hit) {
      this.host.onRoute?.(e.type, hit.layer, hit.id)
      return
    }
    // 未命中 / 声明式 (llm) → agent 兜底 (游戏输出注入由宿主正常路径完成)
    this.host.onRoute?.(e.type, 'agent')
  }

  /**
   * 系统级状态事件 → 统一路由: 规则匹配 (如 login:required → action:"flow" login)。
   * 系统事件不进入 agent 兜底 — 用于激活 flow 而非单步决策/重型思考。
   */
  onSystem(e: MudSystemEvent): void {
    const state = this.host.stateProvider()
    const rule = this.ruleEngine.match({ eventType: e.type, state })
    const hit = rule ? this.dispatch(e.type, rule) : null
    if (hit) this.host.onRoute?.(e.type, hit.layer, hit.id)
  }

  /** 规则动作分派: tool → 宿主执行; flow → 宿主 flow.start; llm/no_action → 不动作。 */
  private dispatch(eType: string, rule: NormalizedRule): { layer: 'rule' | 'flow'; id: string } | null {
    const a = rule.action
    if (a.action === 'tool') {
      this.host.executeRule(rule, eType)
      return { layer: 'rule', id: rule.id }
    }
    if (a.action === 'flow') {
      this.host.startFlow(a.flow)
      return { layer: 'flow', id: a.flow }
    }
    return null // llm / no_action: 声明式, 交 agent
  }
}
