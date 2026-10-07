/**
 * mud-core3 combat/report — 战斗模块观测面（T21.3）：World 计数 + 会话日志，零决策逻辑。
 *
 * 职责（PLAN T21 D8/D10/3.7）：
 *   1. World 计数：模块写入的计数（拍数 / 干预 / 最后动作 / 规则命中）落 zone='combat'、
 *      来源 kind='combat'（与 gmcp=服务器权威、track=文本判据 三分并列，D8）——
 *      画面/HUD 按 `zone#key` 通用呈现，模块不自己发摘要（D10）；
 *   2. 会话日志：规则命中 / 放弃 / 接管获取失败等事件经 runtime 通道留痕，
 *      人能看到「为什么这拍动了/没动」（T21 目标 5）。
 *
 * 纯计数不决策：调用方（战斗控制器）在状态写入/规则派发/接管事件时调用；
 * 本模块不理解战斗语义。begin() 开新遭遇清零；end() 只结算日志、计数保留
 * （遭遇间的历史计数可读，下一场 begin 再归零）。
 *
 * @module mud-core3/combat/report
 */

import type { CombatDispatch } from './rules.ts'

/** 战斗观测依赖（装配注入；纯层不依赖 runtime 具体类型）。 */
export interface CombatReporterDeps {
  /** World 计数写入（runtime.writeCombatWorld：zone='combat'，kind='combat'）。 */
  write(key: string, value: unknown): void
  /** 会话日志一条（runtime 通道）。 */
  log(text: string): void
}

/**
 * 战斗观测器：每会话一个实例（随战斗控制器生灭）。
 *
 * 计数键（zone='combat'）：`拍数`（状态写入拍计数）/ `干预`（规则派发次数）/
 * `最后动作`（最近一次派发的命令串，空格连接）/ `规则命中`（派发累计）。
 */
export class CombatReporter {
  private readonly deps: CombatReporterDeps
  private rounds = 0
  private interventions = 0
  private hits = 0

  constructor(deps: CombatReporterDeps) {
    this.deps = deps
  }

  /** 新遭遇开局：计数清零并写入（HUD 从 0 开始看得见）。 */
  begin(): void {
    this.rounds = 0
    this.interventions = 0
    this.hits = 0
    this.deps.write('拍数', 0)
    this.deps.write('干预', 0)
    this.deps.write('规则命中', 0)
    this.deps.write('最后动作', '')
  }

  /** 一拍状态写入（每次状态行求值调用）：拍数 +1 并写入。 @returns 当前拍数。 */
  round(): number {
    this.rounds += 1
    this.deps.write('拍数', this.rounds)
    return this.rounds
  }

  /** 规则命中：计数推进 + 最后动作 + 会话日志一条（命中了什么、发了什么）。 */
  dispatch(d: CombatDispatch): void {
    this.interventions += 1
    this.hits += 1
    const action = d.commands.join(' ')
    this.deps.write('干预', this.interventions)
    this.deps.write('规则命中', this.hits)
    this.deps.write('最后动作', action)
    this.deps.log(`[combat] 规则命中 ${d.ruleId} → ${action}（拍 ${this.rounds}）`)
  }

  /** 非派发事件留痕（放弃 / 接管获取失败 / 危险直发等）：只记日志，不动计数。 */
  note(text: string): void {
    this.deps.log(`[combat] ${text}`)
  }

  /** 遭遇结束结算：一条日志（原因 + 拍数/干预）；计数保留到下一场 begin。 */
  end(reason: string): void {
    this.deps.log(`[combat] 遭遇结束（${reason}）：拍 ${this.rounds} / 干预 ${this.interventions}`)
  }
}
