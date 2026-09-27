/**
 * observe/meter — 计数护栏（§16.2 两个量 + §17 每场景断言面）。
 *
 * **两个量（口径写死，§16.2）**：
 * - **决策点数 = `step/start` 数**（正确性护栏：每场景应等于真正需要模型
 *   决策的次数）；
 * - **实际调用数 = `assistant/message` ∪ `assistant/attempt`**（每次尝试恰发
 *   两者之一，故其和 = 尝试总数）。
 *
 * **重试/失败漂移 = 实际调用数 − 决策点数**（§16 口径；理由见 §16.2：
 * 一步可含多次请求，重试走 continue、不新增 step/start）。**不是**
 * message/attempt 两流之差——那数不出重试（1 步 1 重试时两流各 1）。
 *
 * **禁用 `request/header`**：它只在 initial/resume/change/series 时发
 * （宿主 agent-loop 实录），不能用来计数请求或决策点——meter 对它 fail-loud
 * （把 header 事件喂进计数器是编程错误）。
 *
 * **成本护栏（§17）**：每场景 root 上下文规模 / 峰值 token 不劣于实证基线——
 * token 量**没有 session 事件可数**（§16.2 实录：无事件表示请求真的发出），
 * 峰值测量归宿主侧实机验收；本面只出计数两量与漂移，供验收脚本逐场景
 * assertWithin。
 *
 * 纯度纪律：不 import 宿主；装配层把自己的 session 事件流转发进 forward()。
 */

/** 计数快照（§17 每场景断言的读出面）。 */
export interface MeterSnapshot {
  /** 决策点数（step/start 数）。 */
  decisionPoints: number
  /** 实际调用数（assistant/message + assistant/attempt）。 */
  actualCalls: number
  /** 重试/失败漂移 = 实际调用数 − 决策点数（§16 口径，非两流之差）。 */
  drift: number
}

/** 验收越界（§17：账目/成本护栏不达标即红）。 */
export class MeterBreachError extends Error {}

/** 场景断言边界（缺省维度不设限；min 下界防"漏转发 ⇒ 护栏恒绿空跑"）。 */
export interface MeterBounds {
  maxDecisionPoints?: number
  maxActualCalls?: number
  minDecisionPoints?: number
}

export class Meter {
  private stepStarts = 0
  private messages = 0
  private attempts = 0

  /** 装配层转发宿主 session 事件类型。计数族白名单外的成员 fail-loud
   *  （'step/end'、'Step/start'、'assistant/xxx' 等拼写/大小写错误若静默
   *  忽略，护栏会恒绿空跑）；两族之外的事件类型（agent/created 等）不进账、
   *  不拦。 */
  forward(type: string): void {
    if (type === 'request/header') {
      throw new Error('request/header 禁用于计数（§16）：只在 initial/resume/change/series 时发，数不出请求与决策点')
    }
    const lower = type.toLowerCase()
    if (lower.startsWith('step/')) {
      if (type !== 'step/start') throw new Error(`未知 step 族事件 "${type}"：计数白名单只有 step/start，其余 fail-loud（防拼写错空跑）`)
      this.stepStarts++
    } else if (lower.startsWith('assistant/')) {
      if (type === 'assistant/message') this.messages++
      else if (type === 'assistant/attempt') this.attempts++
      else throw new Error(`未知 assistant 族事件 "${type}"：白名单只有 message/attempt，其余 fail-loud（防拼写错空跑）`)
    }
    // 两族之外的事件类型不进账（两个量之外）。
  }

  snapshot(): MeterSnapshot {
    const actualCalls = this.messages + this.attempts
    return {
      decisionPoints: this.stepStarts,
      actualCalls,
      drift: actualCalls - this.stepStarts,
    }
  }

  /** 场景复位（验收逐场景跑时每场景前调）。 */
  reset(): void {
    this.stepStarts = 0
    this.messages = 0
    this.attempts = 0
  }

  /** §17 断言面：越界即抛 MeterBreachError（含实测值，验收脚本直接可读）。 */
  assertWithin(bounds: MeterBounds): void {
    const s = this.snapshot()
    if (bounds.minDecisionPoints !== undefined && s.decisionPoints < bounds.minDecisionPoints) {
      throw new MeterBreachError(`决策点数 ${s.decisionPoints} 低于下界（≥ ${bounds.minDecisionPoints}）——多半是装配漏转发 step/start，护栏空跑`)
    }
    if (bounds.maxDecisionPoints !== undefined && s.decisionPoints > bounds.maxDecisionPoints) {
      throw new MeterBreachError(`决策点数 ${s.decisionPoints} 超界（≤ ${bounds.maxDecisionPoints}）`)
    }
    if (bounds.maxActualCalls !== undefined && s.actualCalls > bounds.maxActualCalls) {
      throw new MeterBreachError(`实际调用数 ${s.actualCalls} 超界（≤ ${bounds.maxActualCalls}）`)
    }
  }
}
