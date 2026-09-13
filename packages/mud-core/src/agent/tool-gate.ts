/**
 * dsh-mud-core — 工具调用权限闸门 (agent 平面, `doc/ARCHITECTURE.md` §10).
 *
 * 官方 `tools/pre-execute` waterfall 上的**唯一算数处**: 档位可见性只是模型视图,
 * 真正的拒绝/询问发生在这里。T1 动作渲染出的工具调用与 T2 推理调用走**同一条**
 * 管道 (都是 agent 循环发出的工具调用), 所以"T1 动作被档位 deny"天然成立。
 *
 * 非 MUD 工具一律 `next()` 放行 —— 本闸门只认本插件注册的工具名。
 * waterfall 语义: 不调用 `next()` 即短路 (拒绝/询问), 调用即委托。
 * @module @deepseek-ai/dsh-mud-core/agent/tool-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { commandsOfToolCall, evaluateToolCall, type DangerousRule } from '../permission/policy.ts'
import type { MudTier } from '../permission/tiers.ts'

/** 闸门装配参数。 */
export interface MudToolGateOptions {
  /** 本会话 id (日志归因)。 */
  sessionId: string
  /**
   * 目标 agent 实例 (作用域判据)。监听者虽然注册在 `agent.ctx` 上 (官方按 scope
   * 过滤), 这里仍显式比对一次: 万一调用归属于别的 agent, 用错档位的代价是"拿别的
   * 会话的权限去放行/拒绝", 必须按身份短路。
   */
  agent: unknown
  /** 本插件注册的工具名全集 (其余工具直接放行)。 */
  mudTools: ReadonlySet<string>
  /** 读当前档位。 */
  tier: () => MudTier
  /** 读当前危险命令策略表。 */
  dangerous: () => readonly DangerousRule[]
  /** 本会话是否仍在登录流程 (未登录 = true)。 */
  loginFlow: () => boolean
  /** 登录流程命令集 (该集合内的命令按 `system` 处理, 不受档位限制)。 */
  loginCommands: ReadonlySet<string>
  /**
   * 读**本回合的通道**（`t1` = 规则动作/流程步动作；`t2`/undefined = 真实模型）。
   *
   * 限速只压 T2：T1 是系统流程（动作由规则与流程表声明），**不能被"给模型限速"的闸压住**
   * —— 登录完成后 `loginFlow()` 就是 false 了，若只按它豁免，T1 的规则动作与流程步动作
   * （例如 fullme 的答案）会被无谓地推迟。通道读数由选路侧在 `agent/pre-step` 广播
   * （`installOwnedLaneRouting` 的 `onLane`）。
   */
  currentLane?: () => 't1' | 't2' | undefined
  /**
   * 相邻两次 **agent 工具调用**的最小间隔毫秒 (0/undefined = 不限速)。
   *
   * 为什么需要: T2 决策速度远快于服务端处理 (实测"服务器有点反应不过来"), 而队列的
   * `commandIntervalMs` 只管**写 socket**的间隔, 管不住模型连续发起工具调用的节奏。
   * 限速发生在本闸门 (官方 `tools/pre-execute`): 未到间隔则**等待**再放行 —— 不拒绝、
   * 不丢调用, 只是把节奏压下来。**T1 通道与系统流程 (登录/人工环节) 一律不等**。
   */
  toolCallIntervalMs?: number
  /** 决策留痕 (会话日志)。 */
  log?: (text: string) => void
}

/** 可等待的延时 (支持取消: 回合取消时立即返回 false)。 */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return true
  if (signal === undefined) {
    await new Promise<void>(resolve => { setTimeout(resolve, ms) })
    return true
  }
  if (signal.aborted) return false
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 把权限闸门装到某 agent 的工具管道上 (随该 agent 作用域自动释放)。
 * @param agentCtx agent 作用域上下文 (`agent.ctx`)。
 * @param options 档位/策略/登录判据 + 限速。
 * @returns 释放函数。
 */
export function installMudToolGate(agentCtx: Context, options: MudToolGateOptions): () => void {
  /** 上次放行的 agent 工具调用时刻 (限速用; 每次调用时求值)。 */
  let lastCallAt = 0
  return agentCtx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    // 身份不符 = 不是本会话的工具调用 → 不介入 (见 options.agent 的说明)。
    if (exec.agent !== undefined && exec.agent !== options.agent) return next()
    // 非本插件的工具不介入。
    if (!options.mudTools.has(exec.name)) return next()
    const tier = options.tier()
    const systemCall = options.loginFlow()
      && commandsOfToolCall(exec.name, exec.arguments).every(cmd => options.loginCommands.has(cmd.trim()))
    /** T1 通道 (规则动作 / 流程步动作): 系统流程, 免限速 (§10 限速口径)。 */
    const t1Call = options.currentLane?.() === 't1'
    const verdict = evaluateToolCall({
      name: exec.name,
      args: exec.arguments,
      tier,
      dangerous: options.dangerous(),
      loginFlow: options.loginFlow(),
      loginCommands: options.loginCommands,
      mudTools: options.mudTools,
    })
    if (verdict.kind !== 'allow') {
      options.log?.(
        `[权限] ${exec.name} → ${verdict.kind === 'deny' ? '拒绝' : '待批准'} (档位 ${tier}): ${verdict.reason}`,
      )
      // 不调用 next(): waterfall 短路, 本判定即最终结果 (官方语义)。
      return verdict
    }
    // 限速: 只压 **T2 通道** 的调用节奏; T1 动作与系统流程 (登录/人工环节) 一律不等。
    const interval = options.toolCallIntervalMs ?? 0
    if (!t1Call && !systemCall && interval > 0) {
      const wait = lastCallAt + interval - Date.now()
      if (wait > 0) {
        const settled = await delay(wait, exec.signal)
        if (!settled) return { kind: 'deny', reason: '回合已取消 (限速等待中)' }
      }
      lastCallAt = Date.now()
    }
    return next()
  })
}
