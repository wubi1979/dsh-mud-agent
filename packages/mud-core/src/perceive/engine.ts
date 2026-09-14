/**
 * dsh-mud-core — 行级感知引擎 (PerceptionEngine), host half.
 *
 * L1（`doc/ARCHITECTURE.md` §4）：规则语义只由**行序列 + 多行状态机**决定，
 * 与文本块/分包/截断无关（不变量 I7）。
 *
 *   - **每会话一实例**：state / event 两个匹配器都在本实例内，运行态（多行状态机）
 *     不跨会话共享（不变量 I8）。
 *   - **状态持久**：逐行推进真实匹配器（非镜像克隆），多行规则可跨文本块、跨窗口
 *     完成捕获；因此 `holdDelivery` 的"半截捕获"判定是真实状态而非探测。
 *   - **产出**：本块命中 + 消费边界（最后一次带动作命中的锚点行 abs）+ state 折叠行。
 *     折叠只决定"哪些行不进 agent"，不参与消费边界。
 *
 * 本层不认识连接、agent、会话日志 —— 只有行进、判定出。
 * @module @deepseek-ai/dsh-mud-core/perception/engine
 */

import type { MudLine } from '../services/network/ansi.ts'
import { TriggerMatchService } from '../trigger-llm/service.ts'
import type { ActionSpec, PerceptionRule, PerceptHit } from '../trigger-llm/types.ts'

/** 一条可渲染的命中 (T1 动作的输入单位)。 */
export interface EngineHit {
  /** 规则 id。 */
  ruleId: string
  /** 规则携带的确定性动作 (无动作的命中不入队)。 */
  action: ActionSpec
  /** 锚点行 abs (单行 = 命中行; multiline = 完成行)。 */
  anchorAbs: number
  /** 命中数据 (捕获组/extract 产物)。 */
  data: Record<string, unknown> | null
  /** 命中原因 ('multiline' 等; 诊断用)。 */
  reason?: string
}

/** 一个文本块的感知结果。 */
export interface FeedResult {
  /** 本块带动作的命中 (按行序; 不含 `direct` 动作)。 */
  hits: EngineHit[]
  /**
   * 本块**直接执行**类命中 (动作声明 `direct: true`; 见 `ActionSpec.direct`)。
   *
   * 这些命中不进 T1: 命中行已折叠进 `foldedAbs`, 动作由运行时自己执行 —— 装配方
   * 收到后立即执行, 不投递给 agent。
   */
  directHits: EngineHit[]
  /** 本块全部命中 (含无动作的; 供日志/诊断)。 */
  allHits: PerceptHit[]
  /** state 桶命中 (装配方据此 applyPatch 落库)。 */
  stateHits: PerceptHit[]
  /** state 桶折叠的行 abs + 直接执行命中的锚点行 abs (这些行进 world/被运行时消费, 不进 agent)。 */
  foldedAbs: ReadonlySet<number>
  /** 消费边界: 最后一次带动作命中的锚点 abs; 无命中 = -1。 */
  consumeTo: number
  /** holdDelivery 规则当前仍有未完成捕获 (投递方据此暂缓本块)。 */
  holding: boolean
}

/** PerceptionEngine 构造参数。 */
export interface PerceptionEngineOptions {
  /** state 桶规则 (预匹配折叠入库)。 */
  stateRules: readonly PerceptionRule[]
  /** event 桶规则 (T1 渲染 / 判类)。 */
  eventRules: readonly PerceptionRule[]
  /** 声明 holdDelivery 的规则 id (投递原子性判据)。 */
  holdRuleIds: ReadonlySet<string>
}

/** 行级感知引擎: 每会话一个, 状态在实例内持久。 */
export class PerceptionEngine {
  private readonly state: TriggerMatchService
  private readonly event: TriggerMatchService
  private readonly holdRuleIds: ReadonlySet<string>

  /** @param options 规则集与 hold 规则 id。 */
  constructor(options: PerceptionEngineOptions) {
    // 每实例独立注册规则 → 运行态 (MatchContext) 天然按会话隔离。
    this.state = new TriggerMatchService([...options.stateRules], 'state')
    this.event = new TriggerMatchService([...options.eventRules], 'event')
    this.holdRuleIds = options.holdRuleIds
  }

  /**
   * 喂入一个文本块的行 (逐行推进多行状态机)。
   * @param lines 本块的行 (已由 AnsiStreamParser 分配单调 abs)。
   * @returns 命中、折叠集、消费边界与 hold 判定。
   */
  feed(lines: readonly MudLine[]): FeedResult {
    const rows = lines as MudLine[]
    if (rows.length === 0) {
      return {
        hits: [], directHits: [], allHits: [], stateHits: [], foldedAbs: new Set(), consumeTo: -1, holding: false,
      }
    }
    const stateHits = this.state.match(rows)
    const foldedAbs = new Set<number>(stateHits.flatMap(h => h.foldLines))
    const allHits = this.event.match(rows)
    const hits: EngineHit[] = []
    const directHits: EngineHit[] = []
    let consumeTo = -1
    for (const hit of allHits) {
      if (hit.action === undefined) continue
      const engineHit: EngineHit = {
        ruleId: hit.id,
        action: hit.action,
        anchorAbs: hit.lineNumber,
        data: hit.data,
        ...(hit.reason === undefined ? {} : { reason: hit.reason }),
      }
      // 直接执行 (类似 state 桶): 命中行折叠, 动作交给运行时, 不进 T1 渲染队列,
      // 也不设消费边界 (折叠行不参与单流切分 —— 它根本不到投递层)。
      if (hit.action.direct === true) {
        directHits.push(engineHit)
        foldedAbs.add(hit.lineNumber)
        continue
      }
      hits.push(engineHit)
      if (hit.lineNumber > consumeTo) consumeTo = hit.lineNumber
    }
    return {
      hits,
      directHits,
      allHits,
      stateHits,
      foldedAbs,
      consumeTo,
      holding: this.event.hasPendingCapture(this.holdRuleIds),
    }
  }

  /** 重置运行态 (连接重建 / 会话结束)。 */
  reset(): void {
    this.state.resetContext()
    this.event.resetContext()
  }

  /** 诊断: 两个桶当前是否有未完成的多行捕获。 */
  pendingCaptures(): { state: boolean; event: boolean } {
    const any: ReadonlySet<string> = new Set<string>()
    return {
      state: this.state.hasPendingCapture(any) || this.state.pendingCaptureCount() > 0,
      event: this.event.pendingCaptureCount() > 0,
    }
  }
}
