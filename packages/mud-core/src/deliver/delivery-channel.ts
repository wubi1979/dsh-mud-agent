/**
 * dsh-mud-core — 投递通道 (DeliveryChannel), host half. 会话层。
 *
 * 会话投递的**传输机制**收拢: 工具在途判定与 defer 槽（官方 `deferContext`/`followup`
 * 通道, §19.6.2 判据 A）、投递账本（size/rule/pending —— 判据 B 的收束判定与流程
 * `tool` 判据的解析依据）、T2 投递时刻（限流用）。**编排不在这里**: 何时构造消息、
 * 何时结算投递 (settle)、`shouldConcludeTurn`/`noteToolResult` 的流程联动仍归
 * `MudSessionRuntime` —— 本类只做"账本 + 通道", 不认识流程机与 agent 解析。
 *
 * 账本驱逐策略（实测演进而来）: **按完成驱逐**（只清结果收齐的投递）+ **安全上限 32**
 * （在途投递被逐出只是少一次收束/少一条 tool 判据, 不会结构性出错）。
 * @module @deepseek-ai/dsh-mud-core/deliver/delivery-channel
 */

import { ownedGameMessage } from './lane.ts'

/** 一条 mud-owned 投递消息。 */
type OwnedMessage = ReturnType<typeof ownedGameMessage>

export interface DeliveryChannelOptions {
  debug: (text: string) => void
}

/** 投递账本条目 (per 投递消息)。 */
interface DeliveryLedger {
  /** 动作总数 (判据 B: call-id index === count-1 ⇒ 最后一条)。 */
  size: number
  /** 动作来源 ruleId (按 index 对齐; `flow:<flowId>/<stepId>` → 流程 tool 判据)。 */
  rules: readonly string[]
  /** 未收结果的动作数 (每条工具结果 -1; 0 = 收齐 → 下次 rememberDelivery 驱逐)。 */
  pending: number
}

/**
 * 投递通道。每会话一实例; 重连/释放时宿主调 `reset()` 清 defer 槽与账本
 * (defer 槽里的消息属于上一连接的局面, 不再投出)。
 */
export class DeliveryChannel {
  private readonly opts: DeliveryChannelOptions
  /** 投递 id 序号 (每会话单调递增; T1 用它生成确定性 call-id)。 */
  private seq = 0
  /** 在途工具调用数（>0 ⇒ 投递走 defer 槽）。 */
  private inFlight = 0
  /** defer 槽：工具在途期间产生的投递, 由该调用结束时随结果提交。 */
  private readonly deferSlot: OwnedMessage[] = []
  /** 投递账本 (按投递 id; 见类头"驱逐策略")。 */
  private readonly ledger = new Map<string, DeliveryLedger>()
  /** 上一次 **T2 投递**的时刻（限流用；0 = 尚未投过）。 */
  private lastT2DeliverAt = 0

  constructor(opts: DeliveryChannelOptions) {
    this.opts = opts
  }

  // ── 工具在途 (判据 A) ──────────────────────────────────

  /** 工具调用进入（官方工具包装器调用）。 */
  beginToolCall(): void { this.inFlight += 1 }

  /** 工具调用离开（与 `beginToolCall` 配对）。 */
  endToolCall(): void { if (this.inFlight > 0) this.inFlight -= 1 }

  /** 当前在途工具调用数。 */
  get inFlightTools(): number {
    return this.inFlight
  }

  /**
   * **投递一条 mud-owned 消息**（判据 A）：工具在途 ⇒ 存入 defer 槽, 由该工具调用
   * 结束时随结果提交（`exec.deferContext` → 官方 `next-step` inbox → 同一回号的
   * 下一步）; 无工具在途 ⇒ 官方 `followup`（自己开一个回合）。
   *
   * 为什么这样分：`followup` 的官方语义是"这条消息独占它自己的回合"，而工具在途时我们**有
   * 更好的载体** —— 结果本身。随结果走既省一次空续步，又让"结果 → 下一步输入"严格有序。
   */
  send(
    agent: { followup: (message: OwnedMessage) => void },
    message: OwnedMessage,
  ): void {
    if (this.inFlight > 0) {
      this.deferSlot.push(message)
      this.opts.debug(`[感知] 投递改为 defer (工具在途 ${this.inFlight}): 随本结果进下一步`)
      return
    }
    // followup 前无需预热 (W7.3): lane 选路在 agent/request 上拦截, 与请求时序无关。
    agent.followup(message)
  }

  /** 取走 defer 槽（包装器在结果提交前逐条 `exec.deferContext`）。 */
  takeDeferred(): OwnedMessage[] {
    return this.deferSlot.splice(0)
  }

  /** defer 槽长度 (收束判据 B 用: 槽非空 ⇒ 不收束)。 */
  get deferCount(): number {
    return this.deferSlot.length
  }

  // ── 投递账本 (判据 B + 流程 tool 判据) ─────────────────

  /** 下一个投递 id (`d<N>`; T1 据此生成确定性 call-id `mud-<delivery>-<index>`)。 */
  nextId(): string {
    return `d${++this.seq}`
  }

  /**
   * 记下一条投递的动作（动作数 = 判据 B; 来源 = 工具结果 → 流程步骤的解析依据）。
   * 驱逐策略见类头。
   */
  rememberDelivery(delivery: string, actions: readonly { ruleId: string }[]): void {
    this.ledger.set(delivery, {
      size: actions.length,
      rules: actions.map(action => action.ruleId),
      pending: actions.length,
    })
    // **按完成驱逐**：只清"结果已收齐"的投递, 在途的（T2 限速 / defer 连串 / 人工等值,
    // 结果可能很晚才回）必须保留 —— 收束判据与流程 tool 判据都靠账本里的 size/rule 解析。
    for (const [key, entry] of this.ledger) {
      if (key === delivery || entry.pending > 0) continue
      this.ledger.delete(key)
    }
    // **安全上限**：极端场景（结果长期不回 / 投递爆发）也不让账本无界增长; 超限从最旧的
    // 开始丢（在途投递被丢后只是"少一次收束/少一条 tool 判据"，不会造成结构性错误）。
    const safetyCap = 32
    while (this.ledger.size > safetyCap) {
      const oldest = this.ledger.keys().next().value
      if (oldest === undefined) break
      this.ledger.delete(oldest)
    }
  }

  /** 投递的动作总数 (未知投递 = undefined; 判据 B)。 */
  actionCount(delivery: string): number | undefined {
    return this.ledger.get(delivery)?.size
  }

  /** 投递第 `index` 条动作的来源 ruleId (未知 = undefined)。 */
  actionRule(delivery: string, index: number): string | undefined {
    return this.ledger.get(delivery)?.rules[index]
  }

  /** 该投递的一条动作已收到结果（无论成败; pending 减一 —— 减到 0 由下次记账驱逐）。 */
  recordResult(delivery: string): void {
    const entry = this.ledger.get(delivery)
    if (entry !== undefined) entry.pending -= 1
  }

  // ── T2 投递时刻 (限流) ────────────────────────────────

  /** 记下一次 T2 投递（含控制消息 —— 也算"喂过了"）。 */
  markT2(): void {
    this.lastT2DeliverAt = Date.now()
  }

  /** 距上次 T2 投递的毫秒数 (从未投过 → 很大)。 */
  sinceT2(): number {
    return Date.now() - this.lastT2DeliverAt
  }

  // ── 生命周期 ──────────────────────────────────────────

  /** 重连/释放复位: 清 defer 槽与账本 (上一连接的局面作废)。 */
  reset(): void {
    this.deferSlot.length = 0
    this.inFlight = 0
    this.ledger.clear()
  }
}
