/**
 * subagent 拓扑（§18 第 6 步 / §11 预算与释放阀门）。
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
 * 承载拆分（P2 修订 v2 D6/D8）：工具与 persona 由 preset 行在 preset 作用域
 * 注册（src/preset.ts），本文件只承担引擎侧预算登记——装配层（index.ts）在
 * agent/created 监听器里对子级调 budget.register()，并把 agent/disposed 接到
 * budget.clear()。
 */

/** 宿主 Agent 的窄结构面（只列本包消费的成员；真 Agent 结构兼容）。 */
export interface SubagentAgent {
  /** Session-backed 身份（真型是 SessionId branded string）。 */
  readonly id: string
  /** 运行时创建选项：subagentDepth > 0 即子级（top-level 缺省 0/缺席）。 */
  readonly options: { readonly subagentDepth?: number }
  /**
   * 会话头窄面：`delegationDepth` 是子级判定的**权威源**（resume 携新 options
   * 时 options 读法会误判，P2 D2）；`parentSession` 是到期 interrupt 的
   * **合法参数源**（宿主对 {kind:'user', parentSessionId} 的校验正是子级
   * 自己的直接父会话，P2 D3）。
   */
  readonly session: {
    readonly header: {
      readonly delegationDepth?: number
      readonly parentSession?: string
    }
  }
  cancel(
    cause:
      | { readonly kind: 'user' }
      | { readonly kind: 'parent' }
      | { readonly kind: 'hook'; readonly reason: string }
      | { readonly kind: 'disposed' },
    options?: { readonly keepInbox?: boolean },
  ): void
}

/** 预算配置（总体预算，每个子 agent 一份；数值由 Config 缺省供给，§19 校准）。 */
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
   * authority/ownership 归因被跳过，两种动词的可观测差异**待实测**（§19）。
   * 装配层应注入宿主入口以走宿主通路；参数源 = 登记时捕获的子级
   * `session.header.parentSession`（直接父会话即合法形态，P2 D3）。
   */
  interruptAgent?: (childId: string, parentSessionId: string) => void
}

/**
 * 子级预算登记：Map<childId, {timer, deadline}> + timer——插件唯一保留的
 * 子级运营状态（§11）。到期 interrupt 并自摘条目；终结（agent/disposed）
 * 由装配层调 clear() 撤 timer；插件卸载走 dispose()。
 */
export class BudgetRegistry {
  private readonly entries = new Map<string, { timer: ReturnType<typeof setTimeout>; deadlineMs: number; parentSessionId: string }>()

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
   *
   * 同时捕获 `session.header.parentSession` 作为到期 interrupt 的参数源
   * （P2 D3）：子级必带（宿主 subagent 派单即写）；缺失即 fail-loud——没有
   * 它宿主 interrupt 通路必拒，登记一个必然打断失败的预算是静默失效。
   */
  register(agent: SubagentAgent): void {
    this.clear(agent.id)
    const parentSessionId = agent.session.header.parentSession
    if (typeof parentSessionId !== 'string' || parentSessionId.trim() === '') {
      throw new TypeError(`mud-core2: 子级 ${agent.id} 缺 session.header.parentSession，无法登记到期 interrupt（P2 D3 参数源）`)
    }
    const deadlineMs = Date.now() + this.config.budgetMs
    const timer = setTimeout(() => {
      this.entries.delete(agent.id)
      this.config.onExpire?.(agent.id)
      // 缺省动词 = 只覆盖 interrupt 三项可观测效果的编排侧动作（等价边界见
      // 文件头与 SubagentBudgetConfig 注释）；装配注入宿主入口时走
      // ctx.subagents.interrupt 通路（参数源 = 登记时捕获的直接父会话）。
      if (this.config.interruptAgent !== undefined) {
        // timer 回调内抛出 = 进程级 uncaughtException，此处兜底吞掉（条目已
        // 自摘，不会重入）；留痕归装配层——注入的动词包装内自行 try/catch
        // 记诊断日志（本层无日志通道）。
        try {
          this.config.interruptAgent(agent.id, parentSessionId)
        } catch {
          /* 宿主动词失败：结算通知缺失的后果归装配层观测（见上）。 */
        }
      } else {
        agent.cancel({ kind: 'parent' }, { keepInbox: true })
      }
    }, this.config.budgetMs)
    // 不为 timer 阻止进程退出（测试与常驻两用）。
    timer.unref?.()
    this.entries.set(agent.id, { timer, deadlineMs, parentSessionId })
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
 * 装配注入的权威判定（P2 D2）：session header 的 `delegationDepth` 权威且
 * 单调（resume 携新 options 时 header 不变），options 读法兜底（宿主
 * AgentOptions 现无 subagentDepth 字段，缺席按 0）。子级 ⇔ 判定值 > 0。
 */
export const depthByHeader: DepthOf = agent =>
  Math.max(agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)
