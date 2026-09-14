/**
 * dsh-mud-core — 世界状态同步 (WorldModel), host half.
 *
 * 结构化 WorldModel, 聚合三类来源:
 *   - GMCP 协议包 (Char.Vitals / Char.Status / Room.Info / GMCP.System 登录 /
 *     GMCP.Move 移动) —— 权威 (1.0)
 *   - 感知层 patch (p:login:prompt → {logged_in:false,awaiting:true} 等) —— 文本推断
 *   - 外部显式写入 (登录成功等)
 *
 * 结构:
 *   world.char    角色属性 (hp/mp/jing/jingli/potential/level/exp/gold/...)
 *   world.room    房间 (name/exits/area/desc/...)
 *   world.combat  战斗 (in_combat/target)
 *   world.flags   登录/等待等布尔标志
 *   world.raw     最近 GMCP 原始载荷 (调试/LLM 上下文)
 *
 * GMCP 包名到世界字段的映射集中在 GMCP_GROUPS, 按包分组;
 * 字段值先做数值/数组归一化, 再落入对应分组。
 * @module @deepseek-ai/dsh-mud-core/world
 */

/** 世界分组名。 */
export const WORLD_SECTIONS = ['char', 'room', 'combat', 'flags'] as const

/** 一个世界分组 (任意标量/数组字段)。 */
export type WorldSection = Record<string, unknown>

/** 结构化 WorldModel。 */
export interface WorldModel {
  char: WorldSection
  room: WorldSection
  combat: WorldSection
  flags: WorldSection
  /** 最近 GMCP 原始载荷 (调试/LLM 上下文, 上限 50 条)。 */
  raw: { pkg: string; payload: unknown }[]
  /** 字段置信度 (0~1), 权威性裁决用。 */
  _conf: Record<string, Record<string, number>>
}

/** GMCP 包 → (目标分组)。未知包进 raw。 */
const GMCP_GROUPS: Record<string, string> = {
  'Char.Vitals': 'char',
  'Char.Status': 'char',
  'Char.Skills': 'char',
  'Room.Info': 'room',
  'Room.Players': 'room',
  'Comm.Channel': 'room',
}

/** 数值字段: 字符串数字归一化为 Number。 */
const NUMERIC_KEYS = new Set([
  'hp', 'maxhp', 'max_hp', 'mp', 'maxmp', 'max_mp',
  'jing', 'maxjing', 'max_jing', 'jingli', 'maxjingli', 'max_jingli',
  'potential', 'level', 'exp', 'gold', 'silver', 'coin',
  'food', 'water', 'zhenqi', 'combat_power',
  'str', 'int', 'con', 'dex', 'luck',
  'hp_regen', 'mp_regen', 'jing_regen', 'jingli_regen',
])

/** 数组字段: 出口等逗号/空格分隔字符串 → 数组。 */
const ARRAY_KEYS = new Set(['exits', 'dir', 'inventory'])

/** 创建一个空 WorldModel。 */
export function createWorld(): WorldModel {
  return {
    char: {},
    room: {},
    combat: {},
    flags: {},
    raw: [],
    _conf: { char: {}, room: {}, combat: {}, flags: {} },
  }
}

/** 默认置信度: GMCP 协议 1.0, 文本提取 0.7, 显式写入 0.9。 */
export const CONFIDENCE = { gmcp: 1.0, extract: 0.7, manual: 0.9 } as const

function normalizeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
    return value
  }
  if (ARRAY_KEYS.has(key)) {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'string') return value.split(/[,，\s]+/).filter(Boolean)
    return value
  }
  return value
}

/**
 * 权威性裁决写入: 低置信度不覆盖高置信度 (除非值相同或高置信度来源更新)。
 * @param world 目标 WorldModel。
 * @param group 目标分组 (char/room/combat/flags)。
 * @param key 字段名。
 * @param value 字段值。
 * @param confidence 本次写入的置信度。
 * @returns 是否发生了写入。
 */
export function writeField(
  world: WorldModel,
  group: keyof typeof world | string,
  key: string,
  value: unknown,
  confidence: number = CONFIDENCE.manual,
): boolean {
  const section = world[group as keyof WorldModel] as WorldSection | undefined
  if (!section || Array.isArray(section)) return false
  const confMap = world._conf[group as string] ?? (world._conf[group as string] = {})
  const prior = section[key]
  const priorConf = confMap[key] ?? 0
  const norm = normalizeValue(key, value)
  if (norm === undefined) return false
  if (priorConf > confidence && prior !== norm) return false
  if (prior === norm && priorConf >= confidence) return false
  section[key] = norm
  confMap[key] = confidence
  return true
}

/**
 * 应用一个 GMCP 包到世界 (GMCP 置信度 1.0)。
 * @param world 目标 WorldModel (createWorld 产物)。
 * @param pkg GMCP 包名 (如 "Char.Vitals", 兼容 "GMCP.Char.Vitals" 前缀)。
 * @param payload 载荷 (dict 或原始字符串)。
 * @returns 发生了变化的字段列表。
 */
export function applyGmcp(world: WorldModel, pkg: string, payload: unknown): string[] {
  const changes: string[] = []
  // pkuxkx 把 GMCP 数据包成单元素数组 ([{"site":""}] / [{"result":"true",...}]):
  // 解包成对象, 否则所有 GMCP 包都会落进 raw, 状态栏无数据。
  const data = Array.isArray(payload) && payload.length === 1
    && payload[0] !== null && typeof payload[0] === 'object'
    ? payload[0]
    : payload
  // GMCP.System (pkuxkx 登录通知): { site } — 仅存盘点登录时发送。
  // site 通常为空串 (服务器屏蔽锚点定位) = 登录成功信号 (GMCP 权威 1.0)。
  if (pkg === 'GMCP.System' || pkg === 'System') {
    if (data !== null && typeof data === 'object' && !Array.isArray(data) && 'site' in data) {
      if (writeField(world, 'flags', 'logged_in', true, CONFIDENCE.gmcp)) changes.push('flags.logged_in')
      if (writeField(world, 'flags', 'awaiting', false, CONFIDENCE.gmcp)) changes.push('flags.awaiting')
      const site = (data as Record<string, unknown>).site
      if (site && writeField(world, 'room', 'area', site, CONFIDENCE.gmcp)) changes.push('room.area')
    }
    return changes
  }
  // GMCP.Move (pkuxkx 移动通知): { result, dir, short }
  //   result "true" = 移动成功 (确实进入房间); short = 房间短名; dir = 房间出口
  if (pkg === 'GMCP.Move' || pkg === 'Move') {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>
      if (record.short && writeField(world, 'room', 'name', record.short, CONFIDENCE.gmcp)) {
        changes.push('room.name')
      }
      if (Array.isArray(record.dir) && record.dir.length > 0
        && writeField(world, 'room', 'exits', record.dir, CONFIDENCE.gmcp)) {
        changes.push('room.exits')
      }
    }
    return changes
  }
  const bare = pkg.startsWith('GMCP.') ? pkg.slice('GMCP.'.length) : pkg
  const group = GMCP_GROUPS[pkg] ?? GMCP_GROUPS[bare]
  if (group && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (writeField(world, group, key, value, CONFIDENCE.gmcp)) {
        changes.push(`${group}.${key}`)
      }
    }
  } else if (data !== null && data !== undefined) {
    world.raw.push({ pkg, payload: data })
    if (world.raw.length > 50) world.raw.shift()
  }
  return changes
}

/**
 * 应用感知层 patch (StateTracker apply 的 patch 对象, 文本推断置信度 0.7)。
 * 语义映射:
 *   logged_in / awaiting / initialized  → flags
 *   in_combat                           → combat.in_combat
 *   "group.key" 点分键                   → 对应分组 (规则 after 副作用, 如 "flags.sent_name")
 *   其余标量                             → 原样进入 flags (保持向后兼容)
 * @param world 目标 WorldModel。
 * @param patch 感知层产出字段。
 * @returns 发生了变化的字段列表。
 */
export function applyPatch(world: WorldModel, patch: Record<string, unknown> | null | undefined): string[] {
  const changes: string[] = []
  if (!patch || typeof patch !== 'object') return changes
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'in_combat') {
      if (writeField(world, 'combat', 'in_combat', value, CONFIDENCE.extract)) changes.push('combat.in_combat')
    } else if (key === 'logged_in' || key === 'awaiting' || key === 'initialized') {
      if (writeField(world, 'flags', key, value, CONFIDENCE.extract)) changes.push(`flags.${key}`)
    } else if (key.includes('.')) {
      // 点分键: "group.key" → 写入指定分组 (规则 after 副作用, 登录进度标志等)
      const dot = key.indexOf('.')
      const group = key.slice(0, dot)
      const field = key.slice(dot + 1)
      if (writeField(world, group, field, value, CONFIDENCE.extract)) changes.push(`${group}.${field}`)
    } else {
      if (writeField(world, 'flags', key, value, CONFIDENCE.extract)) changes.push(`flags.${key}`)
    }
  }
  return changes
}

/**
 * 显式写入一个标量字段 (登录成功等外部信号, 置信度 0.9)。
 * @param world 目标 WorldModel。
 * @param group 目标分组。
 * @param key 字段名。
 * @param value 字段值。
 * @param confidence 本次写入的置信度。
 * @returns 是否发生了写入。
 */
export function setWorldField(
  world: WorldModel,
  group: string,
  key: string,
  value: unknown,
  confidence: number = CONFIDENCE.manual,
): boolean {
  return writeField(world, group, key, value, confidence)
}

/**
 * 状态提取器写入: 文本提取规则产出 → 指定分组/字段, 置信度 0.7。
 * @param world 目标 WorldModel。
 * @param group 目标分组。
 * @param fields 提取字段表。
 * @param extractorId 提取规则 id (供 trace 显示)。
 * @param confidence 本次写入的置信度。
 * @returns 发生了变化的字段列表。
 */
export function applyExtract(
  world: WorldModel,
  group: string,
  fields: Record<string, unknown> | null | undefined,
  extractorId = '',
  confidence: number = CONFIDENCE.extract,
): string[] {
  void extractorId
  const changes: string[] = []
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || value === undefined) continue
    if (writeField(world, group, key, value, confidence)) {
      changes.push(`${group}.${key}`)
    }
  }
  return changes
}

/** 序列化世界快照 (客户端状态面板 / LLM 上下文)。 */
export function worldSnapshot(world: WorldModel): {
  char: WorldSection
  room: WorldSection
  combat: WorldSection
  flags: WorldSection
} {
  return {
    char: { ...world.char },
    room: { ...world.room },
    combat: { ...world.combat },
    flags: { ...world.flags },
  }
}

/**
 * 扁平化世界 (决策规则状态条件匹配用): { "char.hp": 100, "flags.logged_in": true }。
 * @param world 目标 WorldModel。
 * @returns 扁平键值表。
 */
export function flattenWorld(world: WorldModel): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const group of WORLD_SECTIONS) {
    for (const [key, value] of Object.entries(world[group] ?? {})) {
      if (value === undefined || value === null) continue
      out[`${group}.${key}`] = value
    }
  }
  return out
}
