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
 *     ├─ action:"skill" 激活命名 skill/flow (如登录): 查 skill 注册表启动;
 *     └─ 未命中 / action:"llm" → agent 兜底 (重型, 游戏输出注入 agent)。
 *
 * 技能注册制 (SkillHandler): skill 只提供"怎么执行" (激活回调), 不声明"何时
 * 触发" — 触发时机是决策知识, 由规则表统一管理 (如 when login:required →
 * action:"skill" login)。宿主不再硬编码订阅, 登录/任务各自一条激活规则。
 * @module @deepseek-ai/dsh-mud-core/dispatcher
 */

import { RuleEngine, type DecisionRule, type NormalizedRule } from './decision.ts'
import type { MudPerceptEvent, MudSystemEvent } from '../events.ts'

/** 路由落点。 */
export type RouteLayer = 'rule' | 'skill' | 'agent'

/** 技能处理器: 一个 skill/flow 的激活动作 (触发时机由规则表决定, 不在 skill 内)。 */
export interface SkillHandler {
  /** skill id (与规则 action:"skill" 的 skill 字段对应, 如 login)。 */
  id: string
  /** 激活动作 (宿主: 启动对应 flow / skill)。 */
  activate: () => void
}

/** 决策中心宿主依赖 (index 装配期注入)。 */
export interface DecisionCenterHost {
  /** 扁平世界状态提供者 (flattenWorld(world))。 */
  stateProvider: () => Record<string, unknown>
  /** 规则命中 (action:"tool") → 宿主执行工具 + 应用副作用 + 记录。 */
  executeRule: (rule: NormalizedRule, eventType: string) => void
  /** 路由结果记录 (tuiDecision)。 */
  onRoute?: (eventType: string, layer: RouteLayer, id?: string) => void
  /** 同类语义事件去重窗口 (ms)。 */
  dedupMs?: number
}

/**
 * 统一事件决策中心 (`ctx.mud.dispatcher`): 可行动事件的统一路由。
 * 决策知识集中在规则表 (tool 单步 / skill 激活), agent 兜底。
 */
export class DecisionCenter {
  private readonly ruleEngine: RuleEngine
  private readonly skills = new Map<string, SkillHandler>()
  private readonly dedup = new Map<string, number>()
  private readonly host: DecisionCenterHost
  private readonly dedupMs: number

  constructor(host: DecisionCenterHost) {
    this.host = host
    this.dedupMs = host.dedupMs ?? 1500
    this.ruleEngine = new RuleEngine({ stateProvider: () => host.stateProvider() })
  }

  /** 注册一条决策规则 (单步反射 / 技能激活; 按 priority 排序)。 */
  registerRule(rule: DecisionRule): void {
    this.ruleEngine.register(rule)
  }

  /** 注册一个技能处理器 (只声明激活动作, 触发时机由规则表决定)。 */
  registerSkill(handler: SkillHandler): void {
    this.skills.set(handler.id, handler)
  }

  /** 注销一个技能处理器 (按 id; 返回是否成功)。 */
  unregisterSkill(id: string): boolean {
    return this.skills.delete(id)
  }

  /** 已注册技能 id 列表 (状态展示/调试)。 */
  skillNames(): string[] {
    return [...this.skills.keys()]
  }

  /**
   * 可行动感知事件 → 统一路由: 规则(tool 执行 / skill 激活) → agent 兜底。
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
   * 系统级状态事件 → 统一路由: 规则匹配 (如 login:required → action:"skill" login)。
   * 系统事件不进入 agent 兜底 — 用于激活 skill 而非单步决策/重型思考。
   */
  onSystem(e: MudSystemEvent): void {
    const state = this.host.stateProvider()
    const rule = this.ruleEngine.match({ eventType: e.type, state })
    const hit = rule ? this.dispatch(e.type, rule) : null
    if (hit) this.host.onRoute?.(e.type, hit.layer, hit.id)
  }

  /** 规则动作分派: tool → 宿主执行; skill → 查注册表激活; llm/no_action → 不动作。 */
  private dispatch(eType: string, rule: NormalizedRule): { layer: 'rule' | 'skill'; id: string } | null {
    const a = rule.action
    if (a.action === 'tool') {
      this.host.executeRule(rule, eType)
      return { layer: 'rule', id: rule.id }
    }
    if (a.action === 'skill') {
      const handler = this.skills.get(a.skill)
      if (!handler) return null
      handler.activate()
      return { layer: 'skill', id: a.skill }
    }
    return null // llm / no_action: 声明式, 交 agent
  }
}
