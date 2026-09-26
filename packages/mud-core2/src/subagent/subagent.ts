/**
 * subagent 拓扑（impl §5 第 6 步 / §3.4 预算与释放阀门、§3.5 前提 2）。
 *
 * 纪律（设计事实源）：
 * - 子级状态归宿主——插件侧只保留 deadline 登记与到期 interrupt（本文件），
 *   不建子级看门狗、不在途上限、禁止轮询 list_agents 判定（inactive 不代表
 *   任务完成，V7）；
 * - 派单走宿主原生 subagent 工具（preset 已挂，spawn + continuable），本包
 *   不自建派单通道、不写计划级动态权限——模型自己控制派单面；
 * - 到期 interrupt：缺省动词 agent.cancel({kind:'parent'}, {keepInbox:true})
 *   **只覆盖** interrupt 的三项可观测效果（只停当前回合/保留 inbox/不释放
 *   槽）；宿主 interrupt_agent 入口额外承担的 authority/ownership 归因是否
 *   有可观测差异**待实测**（注入点见 SubagentBudgetConfig.interruptAgent）。
 *   注意宿主取消是**协作式**（Cooperative, never a hard kill）——子级若不
 *   响应信号不会硬停；且静止条件为 inbox.hasPending === false **且**
 *   ownedChildren.size === 0 两项，带自己子级的子级（depth≥2）inbox 清空
 *   也不达静止。终结由宿主 watchSettlement 的 whenIdle() 驱动；
 * - 预算耗尽的"超时失败"本身就是一次结算通知，经宿主结算单通道回根
 *   （interrupt → 子级到静止态 → 宿主投递），插件不自报、不另设结算看门狗。
 *
 * agent/created 监听器注册在**宿主/preset 作用域**（§3.5 实施前提 2）——
 * 装配层（index.ts）在自己的监听器里调用本文件的 handleCreated；子级同时
 * 经此拿到三工具（子会话静态禁发表由 registerMudTools 按 holder 生效）。
 * 装配还需把 agent/disposed 接到 budget.clear()（终结撤 timer）。
 */

import type { Flow } from '../tools/flows/types.ts'
import { FLOWS } from '../tools/flows/index.ts'
import type { Holder, Mud } from '../link/mud.ts'
import { LoginGate, registerMudTools, type ToolRegistrar } from '../tools/tools.ts'
import type { World } from '../awareness/world.ts'

/** 宿主 Agent 的窄结构面（只列本包消费的成员；真 Agent 结构兼容）。 */
export interface SubagentAgent {
  /** Session-backed 身份（真型是 SessionId branded string）。 */
  readonly id: string
  /** 运行时创建选项：subagentDepth > 0 即子级（top-level 缺省 0/缺席）。 */
  readonly options: { readonly subagentDepth?: number }
  cancel(
    cause:
      | { readonly kind: 'user' }
      | { readonly kind: 'parent' }
      | { readonly kind: 'hook'; readonly reason: string }
      | { readonly kind: 'disposed' },
    options?: { readonly keepInbox?: boolean },
  ): void
}

/** 预算配置（总体预算，每个子 agent 一份；数值由 Config 缺省供给，§6 校准）。 */
export interface SubagentBudgetConfig {
  /**
   * 子 agent 总体预算毫秒。必须为正整数且 ≤ 2^31−1（setTimeout 溢出上界，
   * 超界会立即到期），构造时 fail-loud。
   */
  budgetMs: number
  /** 到期通知（诊断留痕用；结算上报仍走宿主通道，插件不自报）。 */
  onExpire?: (childId: string) => void
  /**
   * 到期 interrupt 动词（注入点）。缺省：对登记时持有的句柄直接
   * `agent.cancel({kind:'parent'}, {keepInbox:true})`——**只覆盖** interrupt
   * 的三项可观测效果（只停当前回合/保留 inbox/不释放槽）；宿主
   * `interrupt_agent` 入口（ctx.subagents.interrupt）额外承担的
   * authority/ownership 归因被跳过，两种动词的可观测差异**待实测**（§6）。
   * 装配层应注入宿主入口以走宿主通路。
   */
  interruptAgent?: (childId: string) => void
}

/**
 * 子级预算登记：Map<childId, {timer, deadline}> + timer——插件唯一保留的
 * 子级运营状态（impl §3.4）。到期 interrupt 并自摘条目；终结（agent/disposed）
 * 由装配层调 clear() 撤 timer；插件卸载走 dispose()。
 */
export class BudgetRegistry {
  private readonly entries = new Map<string, { timer: ReturnType<typeof setTimeout>; deadlineMs: number }>()

  constructor(private readonly config: SubagentBudgetConfig) {
    // 上界 = setTimeout 溢出点（超 2^31−1 毫秒会立即到期，预算形同虚设）。
    if (!Number.isSafeInteger(config.budgetMs) || config.budgetMs <= 0 || config.budgetMs > 2 ** 31 - 1) {
      throw new TypeError(`budgetMs must be an integer in (0, 2^31-1], got ${config.budgetMs}`)
    }
  }

  get size(): number {
    return this.entries.size
  }

  /** 登记时刻的绝对期限毫秒（观测用）；未登记返回 null。 */
  deadlineOf(childId: string): number | null {
    return this.entries.get(childId)?.deadlineMs ?? null
  }

  /**
   * 登记一个子级并武装到期 timer。重复登记（resume 重入）= 先撤旧 timer 再
   * 重新计预算（缺省不续用原预算；若实测需要续用，装配层按 childId 预登记
   * 截止时刻再由本层对表，现阶段不建）。
   */
  register(agent: SubagentAgent): void {
    this.clear(agent.id)
    const deadlineMs = Date.now() + this.config.budgetMs
    const timer = setTimeout(() => {
      this.entries.delete(agent.id)
      this.config.onExpire?.(agent.id)
      // 缺省动词 = 只覆盖 interrupt 三项可观测效果的编排侧动作（等价边界见
      // 文件头与 SubagentBudgetConfig 注释）；装配注入宿主入口时走
      // ctx.subagents.interrupt 通路。
      if (this.config.interruptAgent !== undefined) {
        // timer 回调内抛出 = 进程级 uncaughtException，此处兜底吞掉（条目已
        // 自摘，不会重入）；留痕归装配层——注入的动词包装内自行 try/catch
        // 记诊断日志（本层无日志通道）。
        try {
          this.config.interruptAgent(agent.id)
        } catch {
          /* 宿主动词失败：结算通知缺失的后果归装配层观测（见上）。 */
        }
      } else {
        agent.cancel({ kind: 'parent' }, { keepInbox: true })
      }
    }, this.config.budgetMs)
    // 不为 timer 阻止进程退出（测试与常驻两用）。
    timer.unref?.()
    this.entries.set(agent.id, { timer, deadlineMs })
  }

  /** 子级终结（装配层接 agent/disposed）：撤 timer、摘条目。 */
  clear(childId: string): void {
    const entry = this.entries.get(childId)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      this.entries.delete(childId)
    }
  }

  /** 插件卸载：清全部 timer。 */
  dispose(): void {
    for (const childId of [...this.entries.keys()]) this.clear(childId)
  }
}

/** 会话级共享对象（单 MUD 连接唯一，跨根/子级复用）。 */
export interface SessionShared {
  mud: Mud
  world: World
  creds: { name: string; pass: string }
  connect: { host: string; port: number }
  /** 缺省总超时（兼流程单步兜底超时，见 MudToolDeps.defaultTimeoutMs）。 */
  defaultTimeoutMs: number
  /** 流程注册表（缺省共享 FLOWS）。 */
  flows?: readonly Flow[]
}

/**
 * 子级深度判定。**必填**（缺省不安全即拒装）：缺省读法（depthByOptions）在
 * resume 场景会把带新 options 的子级误判成 root ⇒ 静态禁发表对它失效
 * （可发 suicide/quit 类）——误判是安全相关失效，不允许静默发生。装配层
 * 注入与宿主 delegationDepthOf 等价的判定（max(header.delegationDepth,
 * options.subagentDepth)，header 权威且单调）；本包零宿主依赖，读不到
 * header，故不提供缺省值。纯 options 读法（depthByOptions）仅供测试与
 * 已知无 resume 的场景显式选用。
 */
export type DepthOf = (agent: SubagentAgent) => number

export const depthByOptions: DepthOf = agent => agent.options.subagentDepth ?? 0

/**
 * agent/created 处理器（装配层在自己的宿主作用域监听器里调用）：
 *
 * 1. 判定 root/child（depthOf，必填——见 DepthOf）→ holder `'root'` | `` `child:${id}` ``；
 * 2. 在该 agent 的 scope 注册三工具（子会话静态禁发表按 holder 生效）；
 * 3. 注册完整性自检：登记本层经 scope.register 实际注册的工具名，缺即
 *    fail-loud。注意这只证明"registerMudTools 三工具注册成功"，**不**证明
 *    "子级可见面含三工具"——后者取决于监听器是否注册在宿主作用域、agent/
 *    created 是否触达每个子级，属装配期探针（随 index.ts 落地；验收口径见
 *    impl §4 验收表"工具可见面"行与 §5 开工前置 2）；
 * 4. 子级登记总体预算（到期 interrupt，动词见 SubagentBudgetConfig）。
 *
 * gate/budget 跨 agent 共享：gate 保证全会话一次登录；budget 按 childId 一份。
 * 返回共享 gate（装配接 mud.onDisconnect → reset）与 budget（装配接
 * agent/disposed → clear、插件卸载 → dispose）。
 *
 * disposers 归属：registerMudTools 返回的 disposer 列表由 scope 容器持有
 * （随 agent 作用域释放自动执行），handler **不自持**——这是有意的；插件
 * 卸载需要兜底的只有 budget 的 timer（dispose()）。
 */
export function createAgentCreatedHandler(
  shared: SessionShared,
  budgetConfig: SubagentBudgetConfig,
  depthOf: DepthOf,
): {
  handleCreated: (scope: ToolRegistrar, agent: SubagentAgent) => { holder: Holder }
  gate: LoginGate
  budget: BudgetRegistry
} {
  const gate = new LoginGate(
    shared.mud,
    shared.world,
    shared.flows ?? FLOWS,
    shared.creds,
    shared.connect,
    shared.defaultTimeoutMs,
  )
  const budget = new BudgetRegistry(budgetConfig)

  const handleCreated = (scope: ToolRegistrar, agent: SubagentAgent): { holder: Holder } => {
    const depth = depthOf(agent)
    const holder: Holder = depth > 0 ? `child:${agent.id}` : 'root'

    // 前提 2 自检：登记实际注册的工具名，注册后断言三工具全部可见。
    const registered = new Set<string>()
    const recording: ToolRegistrar = {
      register: def => {
        registered.add(def.name)
        return scope.register(def)
      },
    }
    registerMudTools(recording, { ...shared, holder, gate })
    const missing = ['mud_send', 'mud_flow', 'mud_state'].filter(n => !registered.has(n))
    if (missing.length > 0) throw new Error(`mud-core2 注册完整性自检失败：本层未注册 ${missing.join('/')}`)

    if (depth > 0) budget.register(agent)
    return { holder }
  }

  return { handleCreated, gate, budget }
}
