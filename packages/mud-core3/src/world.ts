/**
 * mud-core3 world — 会话世界状态：分区 + 置信度 + 来源追溯，后到覆盖。
 *
 * 三期状态地基（PLAN T1）：world 由 GMCP 事件写入（HP / 口渴 / 位置 / 登录态 /
 * 金钱 …按需生长），行级规则后置（无例证不建规则层）。组织约定沿用 core2
 * world.ts 的心智：按分区（vitals/combat/location/session/gmcp…）+ 置信度分档
 * （measured/inferred）+ 来源追溯（kind/time），同一 zone+key 后到覆盖旧值。
 *
 * 断线复位：连接终结时整体 clear（世界状态随连接存亡；重连后由 GMCP 重新写入）。
 *
 * 纯 TS，零宿主依赖。
 */

/** 置信度分档：measured = 直接测量（GMCP 原文），inferred = 推断（规则层后置）。 */
export type WorldConfidence = 'measured' | 'inferred'

/** 来源追溯：值从哪来、何时来。 */
export interface WorldSource {
  /**
   * 来源种类：gmcp = 服务器 GMCP 包；system = 插件本地写入；
   * track = 状态追踪解析写入（游戏原文的判据解析，T19；置信度恒 measured）；
   * combat = 战斗模块写入的计数（拍数/干预/最后动作/规则命中，T21 D8）。
   */
  readonly kind: 'gmcp' | 'system' | 'track' | 'combat'
  /** 写入时刻（Date.now()）。 */
  readonly time: number
}

/** 单个世界状态条目。 */
export interface WorldEntry {
  readonly value: unknown
  readonly confidence: WorldConfidence
  readonly source: WorldSource
}

/** 快照面：zone → (key → entry)。只含已写入的分区。 */
export type WorldSnapshot = Readonly<Record<string, Readonly<Record<string, WorldEntry>>>>

/** 世界状态。每会话一个实例，随 runtime 产生/消亡。 */
export class World {
  private readonly zones = new Map<string, Map<string, WorldEntry>>()

  /**
   * 写入（后到覆盖）：同 zone+key 后写覆盖旧值（连同置信度与来源）。
   * @returns 是否发生了覆盖（首次写入返回 false；观测用）。
   */
  set(
    zone: string,
    key: string,
    value: unknown,
    confidence: WorldConfidence = 'measured',
    source: WorldSource = { kind: 'system', time: Date.now() },
  ): boolean {
    let entries = this.zones.get(zone)
    if (entries === undefined) {
      entries = new Map()
      this.zones.set(zone, entries)
    }
    const overwritten = entries.has(key)
    entries.set(key, { value, confidence, source })
    return overwritten
  }

  /** 读单条（无则 undefined）。 */
  get(zone: string, key: string): WorldEntry | undefined {
    return this.zones.get(zone)?.get(key)
  }

  /**
   * 消解单条（T19 D9）：状态消失时删除（如「你不再感到饥饿」→ 食物状态消解）。
   * zone 或 key 不存在时静默（幂等）。 @returns 是否实际删除了条目。
   */
  delete(zone: string, key: string): boolean {
    return this.zones.get(zone)?.delete(key) ?? false
  }

  /** 快照（防御性拷贝；外部改动不影响内部状态）。 */
  snapshot(): WorldSnapshot {
    const out: Record<string, Record<string, WorldEntry>> = {}
    for (const [zone, entries] of this.zones) {
      out[zone] = Object.fromEntries(entries)
    }
    return out
  }

  /** 整体清空（断线复位）。 */
  clear(): void {
    this.zones.clear()
  }
}

/**
 * 登录轴三态（低置信度先行，权威加固）：
 * - unknown = 未知（未登录/断线复位）
 * - inferred = 行文推断（欢迎画面声明判据命中，低置信度先行）
 * - in-game = GMCP 已确认（权威信号，覆盖推断、不降级）
 */
export type LoggedInState = 'unknown' | 'inferred' | 'in-game'
