/**
 * dsh-mud-core 的游戏命令知识 (shared/game): 移动方向别名表、状态查询命令映射。
 *
 * 纯数据模块, 零依赖; 由 `agents/tools` 与 `services/gate` 作为"注入规则"共同消费,
 * 使安全闸门保持机制通用 (规则注入模式, 参见 `services/gate/policy.ts`)。
 *
 * @module @deepseek-ai/dsh-mud-core/shared/game
 */

/** 合法移动方向 (pkuxkx)。 */
export const MOVE_DIRS: readonly string[] = [
  'north', 'south', 'east', 'west', 'up', 'down',
  'northeast', 'northwest', 'southeast', 'southwest',
  'northup', 'northdown', 'southup', 'southdown',
  'eastup', 'eastdown', 'westup', 'westdown',
  'enter', 'out',
]

/** 短别名 → 全名。 */
export const MOVE_ALIASES: Record<string, string> = {
  n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  nu: 'northup', nd: 'northdown', su: 'southup', sd: 'southdown',
  eu: 'eastup', ed: 'eastdown', wu: 'westup', wd: 'westdown',
}

/** 状态查询: what → 实际命令 (值必须与命令注册表 `mudCommands` 对齐 —
 *  服务器别名也映射到注册表命令; 上线核实 2026-09-15: skills 是 sk 的别名,
 *  busy 只是个人表情无状态价值, 不收录)。 */
export const STATUS_CMDS: Record<string, string> = {
  hp: 'hp',          // 气血/内力
  score: 'score',    // 经验/潜能/门派
  inventory: 'i',    // 物品/装备
  skills: 'sk',      // 武功 (skills 是服务器别名, 统一发注册表命令 sk)
}