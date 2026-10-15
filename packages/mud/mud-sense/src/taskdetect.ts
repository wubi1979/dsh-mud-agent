/**
 * taskdetect — 任务环境探测器（T27，纯层）：沿行流匹配任务环境进出判据，
 * 维护**会话活跃任务**标记（2026-10-15 用户裁定「任务或环境有明确开始结束
 * 标志，据此设计」——标记来自服务器行文，不依赖模型自律）。
 *
 * 判据声明在 mud-commands `commands/task.ts` `TASK_ENVIRONMENTS`（逐字实录
 * A.6 纪律），装配编译为 `TASK_ENV_RULES` 后注入本组件（core3 service 每会话
 * 一实例接线，rt.onLine 链）；断线整体复位清标记（§10.4，同 World/tracker 纪律）。
 *
 * 语义边界：探测器只推断「当前处于哪些任务环境」——**多值**（2026-10-15 用户
 * 裁定：可能同时处于 2 个或以上任务中）：enter 判据命中 ⇒ 加入该任务（已活跃
 * 则幂等），exit 判据命中 ⇒ 仅移除同名任务；集合按进入顺序排列（消费面解析
 * 任务条目时先进入者优先）。消费面只有 `resolveAwaitPlan` 第三参（任务专用
 * 命令收窗判据，§8.7），**不拦发送**。
 */

/** 编译后的任务环境进出判据（形状与 mud-commands `CompiledTaskEnv` 一致——
 * 纯层不 import 装配器，宿主注入时结构兼容即可）。 */
export interface TaskEnvRule {
  readonly task: string
  readonly enter: readonly RegExp[]
  readonly exit: readonly RegExp[]
}

/** 会话活跃任务探测器：onLine 喂行流，current 读活跃任务集（进入顺序）。 */
export class TaskDetector {
  private readonly rules: readonly TaskEnvRule[]
  private readonly activeTasks = new Set<string>()

  constructor(rules: readonly TaskEnvRule[]) {
    this.rules = rules
  }

  /** 喂一行（行文子串匹配判据；enter 加入任务、exit 仅移除同名任务）。 */
  onLine(line: { readonly text: string }): void {
    for (const rule of this.rules) {
      if (rule.exit.some(re => re.test(line.text))) {
        this.activeTasks.delete(rule.task)
        continue
      }
      if (rule.enter.some(re => re.test(line.text))) {
        this.activeTasks.add(rule.task)
      }
    }
  }

  /** 断线整体复位（§10.4）：任务环境随连接失效，标记全清。 */
  reset(): void {
    this.activeTasks.clear()
  }

  /** 会话活跃任务集（按进入顺序；空 = 不在任何任务中）。 */
  get current(): readonly string[] {
    return [...this.activeTasks]
  }
}
