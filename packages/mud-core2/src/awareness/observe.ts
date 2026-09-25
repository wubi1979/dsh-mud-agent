/**
 * awareness/observe — 意识层入口：每行调度（impl §3.3，**必须薄**）。
 *
 * 每行执行顺序（impl §3.3 伪码为准）：
 *   1. world.reduce(line)          —— 抓取世界字段（HP/内力/位置/战斗态；
 *      边沿采样先于 reduce：interrupt/wake 的 combat latch 判的是**本行之前**
 *      的战斗态）；
 *   2. danger.match(line)          —— 危险判据同步测；命中按字段化意图执行：
 *      interrupt → mud.send('halt')（紧急中断当前活动，细则暂不设计）；
 *      onDanger(hit)（唤醒上抛，wake 层接线 steer）；abortWait →
 *      mud.abortWait(line)（行等待中断，触发行收编进 read 结果）。
 *      interrupt/wake 受规则去重锚（latch:'combat'）门控：一次战斗一条 latch
 *      （挂 world.inCombat 边沿，design4 §3.2：去重挂世界状态、不挂行模式），
 *      战斗中每回合再命中不重发 halt、不重唤醒；abortWait 不受 latch；
 *   3. REFLEX 匹配                 —— 命中即直发命令并**吞触发行**（返回
 *      'swallow'：不进 acc/缓冲/模型面；应答照常进并参与判据）；
 *   4. onActivity()                —— 行到达活动锚点（静默重新武装，wake 层
 *      接线；新行到达即重新武装，写死 impl §6）。
 *
 * 禁令（design4 §2）：意识层**薄** —— 只感知与触发，不解释内容、不生成动作
 * 序列、不持有目标；危险命中的唤醒决策在 wake 层，目标级决策归 T2。意识层
 * 动作**无输出特例**：危险行照常进模型面、照常参与判据（只有反射行被吞）。
 *
 * 纯度纪律：本目录不 import 宿主（link/awareness 类型除外）；宿主动作经
 * deps 注入。
 */

import type { MudLine } from '../link/ansi.ts'
import type { Mud } from '../link/mud.ts'
import { matchDanger, DANGER, type DangerHit, type DangerRule } from './danger.ts'
import { matchReflex, REFLEX, type ReflexRule } from './reflex.ts'
import type { World } from './world.ts'

/** 依赖注入：mud 窄接口（send/abortWait）+ 世界状态 + wake 接线钩子。 */
export interface AwarenessDeps {
  mud: Pick<Mud, 'send' | 'abortWait'>
  world: World
  /** 危险命中上抛（wake 层接线：steer + 去重 latch 挂 world.inCombat）。 */
  onDanger?: (hit: DangerHit) => void
  /** 行到达活动锚点（wake 层接线：静默重新武装）。 */
  onActivity?: () => void
}

/** 规则表注入（测试用本地表，不动共享态；缺省用共享 DANGER/REFLEX）。 */
export interface AwarenessTables {
  danger?: DangerRule[]
  reflex?: ReflexRule[]
}

/** 意识层入口（装配时注入 mud.onLine，永续 —— 与谁在等无关）。 */
export class Awareness {
  private readonly deps: AwarenessDeps
  private readonly dangerRules: DangerRule[]
  private readonly reflexRules: ReflexRule[]

  constructor(deps: AwarenessDeps, tables: AwarenessTables = {}) {
    this.deps = deps
    this.dangerRules = tables.danger ?? DANGER
    this.reflexRules = tables.reflex ?? REFLEX
  }

  /** 每行调度。返回 'swallow' = 吞触发行（反射出口）。 */
  observe(line: MudLine): 'swallow' | void {
    // 战斗边沿取**本行处理前**的战斗态（reduce 会把本行写入 inCombat=true，
    // 边沿判定必须先于 reduce 采样）。
    const prevCombat = this.deps.world.inCombat
    this.deps.world.reduce(line)

    const d = matchDanger(line, this.dangerRules)
    if (d !== null) {
      // interrupt/wake 按规则的去重锚门控：latch:'combat' = 一次战斗一条
      // latch（design4 §3.2：去重挂世界状态、不挂行模式），战斗中再命中不重发
      // halt、不重唤醒；abortWait 不受 latch（每次在途 read 都该被打断）；
      // 死亡类不声明 latch，每次命中都执行。
      const firstOfFight = d.rule.latch !== 'combat' || prevCombat !== true
      if (firstOfFight) {
        if (d.rule.interrupt) this.deps.mud.send('halt')
        if (d.rule.wake) this.deps.onDanger?.(d)
      }
      if (d.rule.abortWait) this.deps.mud.abortWait(line)
    }

    const r = matchReflex(line, this.reflexRules)
    if (r !== null) {
      this.deps.mud.send(r.cmd)
      this.deps.onActivity?.()
      return 'swallow'
    }

    this.deps.onActivity?.()
  }
}
