/**
 * dsh-mud-core — MUD 权限档位表 (permission tiers, `doc/ARCHITECTURE.md` §10).
 *
 * 三档: `observe`(只读) / `operate`(读写) / `full`(完全)。档位是**每会话**的
 * 持久事实 (记录在会话日志的 `mud/capability` 事件里, 见 `capability.ts`), 由
 * 页面/宿主入口切换; agent **永不自提权**。
 *
 * 两层含义, 分别落在两个文件:
 *   - **可见性** (本文件 `tools`): 该档注册到 agent ctx 的工具集 —— 模型看到的
 *     capability 正确;
 *   - **强制** (`policy.ts` 的 `evaluateToolCall` + `agent/tool-gate.ts`):
 *     `tools/pre-execute` 上**唯一算数**的判据, T1 动作动作走同一管道。
 *
 * 一条已知取舍: `mud_send` / `world_patch` 在**所有档位**都注册 —— 它们是 T1
 * T1 动作通道本身 (登录流程发名字/密码、登录完成/失败置位)。把它们从只读档摘掉会
 * 让登录动作直接失效 (工具未注册 = 官方在 pre-execute 之前就判 UNKNOWN_TOOL,
 * 强制层根本看不到该调用)。因此只读档对 `mud_send` 的约束落在强制层: 登录流程
 * 命令放行, 其余命令一律 deny。
 * @module @deepseek-ai/dsh-mud-core/agent/gate/tiers
 */

/** MUD 权限档位。 */
export type MudTier = 'observe' | 'operate' | 'full'

/** 档位顺序 (客户端选项与表格顺序的唯一事实源)。 */
export const MUD_TIER_NAMES: readonly MudTier[] = ['observe', 'operate', 'full']

/** 一档的声明。 */
export interface MudTierSpec {
  tier: MudTier
  /** 展示名 (客户端选项 label)。 */
  name: string
  /** 一句说明 (客户端选项 description)。 */
  description: string
  /** 该档注册到 agent 的工具名 (可见性层)。 */
  tools: readonly string[]
  /** 该档开放的外围能力 id (页面/宿主入口消费; agent 侧无对应工具)。 */
  capabilities: readonly string[]
}

/** 完全档的外围能力 (显式列举; §10)。 */
export const FULL_CAPABILITIES: readonly string[] = [
  'connection:connect',
  'connection:disconnect',
  'wake:dead-air',
  'catalog:skills',
  'catalog:rules',
  'captcha:refresh',
]

/** 三档声明表。 */
export const MUD_TIER_SPECS: Record<MudTier, MudTierSpec> = {
  observe: {
    tier: 'observe',
    name: '只读',
    description: '只看不发: 读世界快照 (mud_state)、查命令语法 (mud_help); 登录流程照常。',
    // mud_send/world_patch = T1 动作通道 (登录 + 置位), 见模块头部的取舍说明。
    // mud_help = 零发送语法查询 (只读档也要能查"有哪些命令")。
    tools: ['mud_state', 'mud_help', 'mud_send', 'world_patch', 'mud_captcha'],
    capabilities: [],
  },
  operate: {
    tier: 'operate',
    name: '读写',
    description: '读写游戏: 移动/观察/状态查询/任意命令。',
    tools: ['mud_state', 'mud_help', 'mud_send', 'world_patch', 'mud_captcha', 'mud_move', 'mud_look', 'mud_status'],
    capabilities: [],
  },
  full: {
    tier: 'full',
    name: '完全',
    description: '读写 + 外围能力 (连接/唤醒/目录/验证码刷新)。',
    tools: [
      'mud_state', 'mud_help', 'mud_send', 'world_patch', 'mud_captcha', 'mud_move', 'mud_look', 'mud_status',
      'mud_flow_disable', 'mud_flow_enable',
    ],
    capabilities: FULL_CAPABILITIES,
  },
}

/**
 * 字符串是否为合法档位名。
 * @param value 待判定值。
 * @returns 是则为其收窄类型。
 */
export function isMudTier(value: string): value is MudTier {
  return value === 'observe' || value === 'operate' || value === 'full'
}

/**
 * 解析档位名 (无法识别时回落; 不抛出 —— 配置/请求里的坏值不该让会话起不来)。
 * @param value 候选值 (通常来自 Config 或 HTTP body)。
 * @param fallback 无法识别时的档位。
 * @returns 生效档位。
 */
export function resolveMudTier(value: string | undefined, fallback: MudTier): MudTier {
  const trimmed = value?.trim() ?? ''
  return isMudTier(trimmed) ? trimmed : fallback
}

/**
 * 取档位声明。
 * @param tier 档位。
 * @returns 该档声明。
 */
export function tierSpec(tier: MudTier): MudTierSpec {
  return MUD_TIER_SPECS[tier]
}

/**
 * 构造客户端选项 (形状对齐官方 `permissionPresets.optionOf`)。
 * @param tier 档位 (或非法名 → 抛出)。
 * @returns `{ value, name, description }`。
 */
export function mudTierOption(tier: string): { value: string; name: string; description: string } {
  if (!isMudTier(tier)) {
    throw new Error(`mud permission: unknown tier "${tier}" (known: ${MUD_TIER_NAMES.join(', ')})`)
  }
  const spec = MUD_TIER_SPECS[tier]
  return { value: spec.tier, name: spec.name, description: spec.description }
}

/**
 * 该档注册到 agent 的工具名。
 * @param tier 档位。
 * @returns 工具名列表 (可见性层)。
 */
export function visibleTools(tier: MudTier): readonly string[] {
  return MUD_TIER_SPECS[tier].tools
}

/**
 * 该档的**模型可见**提示文本 (系统提示区段, 每次 assembly 求值)。
 *
 * 可见性层只改工具注册表; 而 `mud_send`/`world_patch` 为了 T1 动作在所有档位都
 * 注册 (见模块头部取舍), 所以模型看到的工具列表比档位能力宽松 —— 这段文本负责
 * 把"你现在能做什么"讲清楚, 让模型不必靠被拒绝来发现边界。
 * @param tier 档位。
 * @returns 一句到两句的档位说明。
 */
export function mudTierNote(tier: MudTier): string {
  switch (tier) {
    case 'observe':
      return '当前权限档位: 只读。只能用 mud_state 读取世界模型、用 mud_help 查命令语法, 不能发送任何游戏命令 (登录流程除外); 需要操作时请让用户把档位切到「读写」。'
    case 'operate':
      return '当前权限档位: 读写。可以移动/观察/查询/发送命令; 放弃技能/偷窃/叫杀/丢弃/退出等有代价的操作需要用户批准; 删号改密类命令一律被拒绝。'
    case 'full':
      return '当前权限档位: 完全。在读写能力之外, 还可以管理触发器组 (mud_flow_*); 有代价的操作同样需要用户批准。'
  }
}
