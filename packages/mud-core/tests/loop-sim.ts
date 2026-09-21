/**
 * dsh-mud-core — **官方 loop 的最小忠实模拟器**（测试替身；`doc/ARCHITECTURE.md` §13.6）。
 *
 * 为什么需要它：原先的测试替身是"`followup` → 数组"，它只记消息、**看不到回合/步骤边界**，
 * 于是"一个流程 = 一个回合"这类结论无法验证。本模拟器按 DSH 源码逐条复刻 loop 的转移，
 * 每条规则都在注释里给出出处；它**只做 loop 该做的事**，不做任何我们的设计假设：
 *
 *   1. 驱动器循环：`kick()` = `while (await turn()) {}`；`turn()` 结束返回 `inbox.hasPending`
 *      （`core/agent-loop/src/agent.ts:225-227,344-349`）→ 有排队输入就**立刻开下一个回合**。
 *   2. 认领：`claim(target)` = 全取 `next-step`，`target==='next-turn'` 时再取**一条** `next-turn`
 *      （`agent-loop/src/inbox.ts:111-116`）。
 *   3. 回合内：第一步 `target='next-turn'`，其后 `target='next-step'`
 *      （`agent.ts:284,320`）；`pre-step` 认领为空且回合首步 → 不进模型直接收束
 *      （`agent.ts:297-300`）。
 *   4. 步进：无 tool-call ⇒ 本步收束（`agent.ts:486-487`）；有 tool-call ⇒ 按模型顺序执行，
 *      结果带 `additionalContexts` 时**追加到 `next-step`**（`agent.ts:490` + `core/tools/src/index.ts:1568-1579`），
 *      任一结果 `concludesTurn` ⇒ 回合收束（`agent.ts:492`）。
 *   5. 回合收束判据：`turnEnds && nextStep.length === 0` 才 break；否则**同回合再走一步**
 *      （`agent.ts:315-320`）—— 这就是"多步一个回合"的官方机制。
 *   6. 选路（我们的插件逻辑，不是 loop）：`agent/pre-step` 记本回合 lane（认领消息里第一条
 *      `mud-owned` 的 lane），`agent/request` 按它决定 T1/T2（`src/agent/agent-bridge.ts:194-263`）。
 *
 * 测试用法（**两个控制流交错**）：驱动器在工具调用上阻塞（等游戏应答），测试线程负责喂
 * 应答帧。用 `until(pred)` 推进假计时器直到条件成立，最后 `await sim.whenIdle()`。
 *
 * @module mud-core/tests/loop-sim
 */

import { createAssistantMessage, createToolResultMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { vi } from 'vitest'
import { TriggerLlmAdapter } from '../src/agent/t1.ts'
import type { MudSessionRuntime } from '../src/session/session.ts'
import type { ReplySettle } from '../src/agent/inflight.ts'

/** 一条轨迹记录（诊断/断言用：turn/step/认领/请求/工具/收束）。 */
export interface SimTrace {
  turn: number
  step: number
  event: string
  detail: string
}

/** 模拟器观测统计。 */
export interface SimStats {
  turns: number
  steps: number
  /** 模型请求数（每步一次）。 */
  modelCalls: number
  /** 打到 T1 的请求数。 */
  t1Calls: number
  /** 打到 T2（真实 LLM 基线）的请求数 —— 流程期间应为 0。 */
  t2Calls: number
  /** 工具调用数。 */
  toolCalls: number
  /** 认领消息为空的步数（"空续步"）。 */
  emptySteps: number
  /** 经 `deferContext` 随工具结果进下一步的投递数（§19.6.2 判据 A）。 */
  deferred: number
  /** 用 `concludeTurn` 收束的回合数（判据 B）。 */
  concludedTurns: number
}

/** 一条 assistant 步的产出。 */
interface Asked {
  message: Message
  toolCalls: { id: string; name: string; arguments: string }[]
}

/**
 * **官方包装器的早停接线**（W10.4 账目用）：`'conclude-turn'` = 生产现行接线（**B3**：
 * `noteToolResult` 返回"流程驱动器在本结果上收束了流程" ⇒ `exec.concludeTurn()`）；
 * `'none'` = 转达关掉的接线 —— 工具结果不收束回合，T1 靠"本步无 tool-call"自然收束
 * （多出一步 T1 空步）。
 *
 * 两者只切换这一处判定，defer / 工具 / 流程 / T1 全是生产实现 —— 量的是"不早停的代价"。
 */
export type SimEarlyStop = 'conclude-turn' | 'none'

/** 官方 loop 的最小忠实模拟器。 */
export class LoopSim {
  /** 模型可见表面（user / assistant / tool-result；`agent/pre-step` 就是从 inbox 认领进这里）。 */
  readonly history: Message[] = []
  readonly trace: SimTrace[] = []
  readonly stats: SimStats = {
    turns: 0, steps: 0, modelCalls: 0, t1Calls: 0, t2Calls: 0, toolCalls: 0, emptySteps: 0,
    deferred: 0, concludedTurns: 0,
  }

  private nextTurn: Message[] = []
  private nextStep: Message[] = []
  /** 本回合 lane（插件逻辑：`agent-bridge.ts` 的 `agent/pre-step`）。 */
  private turnLane: { turn: number; lane: 't1' | 't2' } | null = null
  private turn = 0
  private step = 0
  private running = false
  private activity: Promise<void> = Promise.resolve()
  private readonly adapter = new TriggerLlmAdapter()
  private readonly earlyStop: SimEarlyStop

  /**
   * @param sessionId 会话 id（= agent id，I1）。
   * @param runtime 被测运行时（工具从它取；`execute` 仿真官方包装器的投递通道接线）。
   * @param log 测试日志收集器（与 sink.log 同源；便于断言"流程完成"等）。
   * @param options `earlyStop` 选择官方包装器的早停接线（缺省 = 生产现行的 `'conclude-turn'`）。
   */
  constructor(
    readonly sessionId: string,
    private readonly runtime: MudSessionRuntime,
    private readonly log: (text: string) => void,
    options: { earlyStop?: SimEarlyStop } = {},
  ) {
    this.earlyStop = options.earlyStop ?? 'conclude-turn'
  }

  /** runtime 侧看到的 agent（`MudRuntimeSink.agentOf` 返回它）。 */
  facade(): Agent {
    const self = this
    return {
      id: this.sessionId,
      get status() { return self.running ? 'running' : 'idle' },
      inbox: {
        get nextTurn() { return self.nextTurn },
        get nextStep() { return self.nextStep },
      },
      // 官方 `followup` = 入 next-turn + 唤醒驱动器（`agent.ts:137-139`）。
      followup(message: Message) { self.enqueue(message) },
    } as unknown as Agent
  }

  /**
   * 投递一条消息（官方 `Agent.followup` 语义：入 `next-turn`，独占它自己的回合）。
   *
   * **注意**：运行时只在"没有工具在途"时才走这条通道（§19.6.2 判据 A）；工具在途期间的投递
   * 由运行时存进 defer 槽，在 `execute` 结束时随结果提交（下面仿真官方包装器）。
   */
  private enqueue(message: Message): void {
    this.nextTurn.push(message)
    this.kick()
  }

  /** 驱动器：`while (await turn()) {}`（`agent.ts:225-227`）。 */
  private kick(): void {
    if (this.running) return
    this.running = true
    this.activity = (async () => {
      try {
        while (await this.turnOnce()) { /* 有排队输入 → 继续下一个回合 */ }
      } finally {
        this.running = false
      }
    })()
  }

  /** 当前驱动器完成（测试在喂完应答后 await 它）。 */
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activity)
    } while (activity !== this.activity)
  }

  /** 一个回合（`agent.ts:268-350`）。 */
  private async turnOnce(): Promise<boolean> {
    this.turn += 1
    this.step = 0
    this.stats.turns += 1
    const turn = this.turn
    this.note('turn/start')
    let turnEnds: 'completed' | null = null
    let target: 'next-turn' | 'next-step' = 'next-turn'
    while (true) {
      const step = this.step + 1
      const claimed = this.claim(target)
      if (turnEnds !== null && claimed.length === 0) break
      if (this.step === 0 && claimed.length === 0) { turnEnds = 'completed'; break }
      this.step = step
      this.stats.steps += 1
      if (claimed.length === 0) this.stats.emptySteps += 1
      // pre-step: 记本回合 lane（插件逻辑；认领消息里第一条 mud-owned 的 lane）。
      const claimedLane = ownedLaneOf(claimed)
      if (claimedLane !== undefined) this.turnLane = { turn, lane: claimedLane }
      else if (this.turnLane !== null && this.turnLane.turn !== turn) this.turnLane = null
      const lane = this.turnLane !== null && this.turnLane.turn === turn ? this.turnLane.lane : undefined
      this.note('step/start', `claim=${claimed.length} lane=${lane ?? '无'}`)
      for (const message of claimed) this.history.push(message)
      // 模型请求（agent/request 选路：lane=t1 → T1；其余 = T2 基线）。
      const asked = await this.ask(lane)
      this.history.push(asked.message)
      if (asked.toolCalls.length === 0) {
        this.note('step/end', 'completed (无 tool-call)')
        if (turnEnds === null) turnEnds = 'completed'
      } else {
        let concluded = false
        for (const call of asked.toolCalls) {
          this.stats.toolCalls += 1
          const result = await this.execute(call, turn, step)
          this.history.push(createToolResultMessage({
            callId: call.id as never,
            content: [{ type: 'text', text: String(result.note ?? '') }],
            isError: result.ok !== true,
          }))
          // 官方：结果携带的上下文进 next-step（`agent.ts:490`）。
          const extra = (result as { additionalContexts?: Message[] }).additionalContexts ?? []
          for (const context of extra) this.nextStep.push(context)
          if ((result as { concludesTurn?: boolean }).concludesTurn === true) concluded = true
          if (result.ok !== true) this.note('tool/error', `${call.name}: ${String(result.settled ?? '')}`)
        }
        this.note('step/end', concluded ? 'completed (concludeTurn)' : 'null (工具续步)')
        if (concluded && turnEnds === null) turnEnds = 'completed'
      }
      if (turnEnds !== null && this.nextStep.length === 0) break
      target = 'next-step'
    }
    this.note('turn/end', turnEnds ?? 'completed')
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** 认领（`inbox.ts:111-116`）。 */
  private claim(target: 'next-turn' | 'next-step'): Message[] {
    const claimed = this.nextStep.splice(0)
    if (target === 'next-turn' && this.nextTurn.length > 0) claimed.push(this.nextTurn.shift() as Message)
    return claimed
  }

  /** 一次模型请求：lane=t1 走我们的 T1 适配器；其余记成 T2 基线（stub，只回一句收束文本）。 */
  private async ask(lane: 't1' | 't2' | undefined): Promise<Asked> {
    this.stats.modelCalls += 1
    if (lane !== 't1') {
      this.stats.t2Calls += 1
      this.note('request', 'T2 (真实 LLM 基线)')
      return {
        message: createAssistantMessage({
          content: [{ type: 'text', text: '[T2 基线] 本测试不模拟真实 LLM' }],
          source: { provider: 'test-t2', model: 'stub' },
        }),
        toolCalls: [],
      }
    }
    this.stats.t1Calls += 1
    const options = {
      provider: 'mud-t1',
      model: 't1-local',
      sessionId: this.sessionId,
      messages: [...this.history],
    }
    const blocks: Message['content'] = []
    for await (const chunk of this.adapter.stream(options as never)) {
      if (chunk.type === 'block-end') blocks.push(chunk.block)
    }
    const message = createAssistantMessage({
      content: blocks,
      source: { provider: 'mud-t1', model: 't1-local' },
    })
    const toolCalls = blocks
      .filter((block): block is Extract<Message['content'][number], { type: 'tool-call' }> => block.type === 'tool-call')
      .map(block => ({ id: String(block.id), name: block.name, arguments: block.arguments }))
    this.note('request', `T1 → ${toolCalls.length === 0 ? '收束' : toolCalls.map(c => c.name).join(',')}`)
    return { message, toolCalls }
  }

  /**
   * 官方工具路径执行 —— **仿真官方包装器**（`attachMudTools` 的 `defineTool` 包装）：
   *
   *   1. 进出工具调用通知运行时（`beginToolCall`/`endToolCall`）→ 期间产生的投递进 defer 槽；
   *   2. 结果提交前把槽里的投递挂到**本结果**上（`exec.deferContext`）；
   *   3. **流程驱动器说"本结果收束了流程"** ⇒ `exec.concludeTurn()`（B3；
   *      `earlyStop:'none'` 时跳过转达 —— 量"不早停"的账）。
   *
   * 这三步正是生产包装器的接线，所以 `loop-sim` 测的是**真行为**（而不是测试内建模）。
   */
  private async execute(
    call: { id: string; name: string; arguments: string },
    _turn: number,
    _step: number,
  ): Promise<Record<string, unknown>> {
    const tool = this.runtime.tools()[call.name]
    if (tool === undefined) throw new Error(`模拟器: 未知工具 ${call.name}`)
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = call.arguments === '' ? {} : JSON.parse(call.arguments)
      if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
    } catch {
      // 官方保留非法 JSON 为文本（`tool-calls.ts:104-111`）；这里等价于空参数。
    }
    this.note('tool/call', `${call.name} ${JSON.stringify(args)}`)
    this.runtime.beginToolCall()
    let result: Record<string, unknown>
    let concluded = false
    try {
      result = await tool.execute(args, {}) as Record<string, unknown>
      // 流程判定要在"工具仍算在途"时做（W7.2: `noteToolResult` 驱动单步推进 —— 生产
      // 包装器 `runWithDeliveryChannel` 的接线, 缺了它流程步永远等不到工具结果）。
      // 返回值 = 驱动器是否在本结果上收束了流程（B3 的早停判据）。
      const r = result as { ok?: boolean; settled?: ReplySettle }
      concluded = this.runtime.noteToolResult(
        call.id, r.ok === true ? 'ok' : 'error', r.settled,
      )
    } finally {
      this.runtime.endToolCall()
    }
    const deferred = this.runtime.takeDeferredDeliveries()
    const conclude = this.earlyStop === 'conclude-turn' && concluded
    if (deferred.length > 0) this.stats.deferred += deferred.length
    if (conclude) this.stats.concludedTurns += 1
    return {
      ...result,
      ...(deferred.length === 0 ? {} : { additionalContexts: deferred }),
      ...(conclude ? { concludesTurn: true } : {}),
    }
  }

  private note(event: string, detail = ''): void {
    this.trace.push({ turn: this.turn, step: this.step, event, detail })
    this.log(`[sim] turn=${this.turn} step=${this.step} ${event}${detail === '' ? '' : ` (${detail})`}`)
  }

  /** 紧凑轨迹（证据/断言用）。 */
  report(): string {
    return this.trace
      .map(entry => `t${entry.turn}s${entry.step} ${entry.event}${entry.detail === '' ? '' : ` ${entry.detail}`}`)
      .join('\n')
  }
}

/** 认领消息里第一条本插件投递的 lane（`agent-bridge.ts` 的 `ownedLaneOf` 同义）。 */
function ownedLaneOf(messages: readonly Message[]): 't1' | 't2' | undefined {
  for (const message of messages) {
    const source = message.source
    if (source.kind === 'mud-owned') return source.lane
  }
  return undefined
}

/**
 * 推进到条件成立（假计时器 + 微任务）；超时即测试失败。
 *
 * 模拟器与测试是**两个控制流**：驱动器停在"等游戏应答"的工具调用上，测试线程必须喂帧。
 * @param pred 条件。
 * @param label 失败信息。
 * @param advances 最多推进的毫秒数（每步 1ms）。
 */
export async function until(pred: () => boolean, label: string, advances = 500): Promise<void> {
  for (let i = 0; i < advances; i += 1) {
    if (pred()) return
    await vi.advanceTimersByTimeAsync(1)
  }
  if (!pred()) throw new Error(`等待超时: ${label}`)
}
