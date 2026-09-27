/**
 * config — 插件装配配置（§3.3 config.ts）：连接、静默/超时缺省、路径、预算缺省。
 *
 * 校验纪律：fail loud（缺省不安全即拒装，与 depthOf 同款）——数值必须为正整数
 * （setTimeout 语义），身份字段非空。缺省取值均为 §19 待实测校准项的占位。
 */

/**
 * preset 绑定 id（P2 D1 修订）：归属门 = 「agent 用了 mud-player preset」
 * （ctx.agentPresets.composedPreset(agent.ctx) === PRESET_ID），与
 * cordis.patch.yml 的 preset-mud-player 行 config.id 一致（漂移守卫对表）。
 */
export const PRESET_ID = 'mud-player'

/** 插件装配配置（cordis.patch.yml `config` 的形态；全部字段可缺省传入）。 */
export interface MudCore2Config {
  /** MUD 服务器地址（首次 mud_send 隐式建连用，§4）。 */
  connect: { host: string; port: number }
  /** 登录凭据（resolve 双键空间的第一承载；明文只进发送瞬间，§13）。 */
  creds: { name: string; pass: string }
  /** 静默唤醒时长毫秒（§7 静默源；§19 待校准）。缺省 120_000。 */
  silenceMs: number
  /** 缺省总超时毫秒（mud_send 缺省 + 流程单步兜底，§12.1；§19 待校准）。缺省 30_000。 */
  defaultTimeoutMs: number
  /** 子 agent 总体预算毫秒（§11；§19 待校准）。缺省 600_000。 */
  budgetMs: number
  /** 行流语料 JSONL 落盘路径；缺省（undefined）= 语料落盘关闭。 */
  corpusPath?: string
}

/** 数值缺省（§19 待校准项的占位刻度）。 */
export const CONFIG_DEFAULTS = {
  silenceMs: 120_000,
  defaultTimeoutMs: 30_000,
  budgetMs: 600_000,
} as const

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`mud-core2 config: ${what} 必须为非空字符串`)
  }
  return value
}

function requirePositiveInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`mud-core2 config: ${what} 必须为正整数，got ${String(value)}`)
  }
  return value
}

/**
 * 补缺省并校验（apply 时调用；非法即抛 TypeError，不静默回落）。
 * budgetMs 的 setTimeout 溢出上界（≤2^31−1）由 BudgetRegistry 构造复查。
 */
export function resolveConfig(input: Partial<MudCore2Config>): MudCore2Config {
  const host = requireNonEmpty(input.connect?.host, 'connect.host')
  const port = requirePositiveInt(input.connect?.port, 'connect.port')
  const name = requireNonEmpty(input.creds?.name, 'creds.name')
  const pass = requireNonEmpty(input.creds?.pass, 'creds.pass')
  const silenceMs = input.silenceMs ?? CONFIG_DEFAULTS.silenceMs
  const defaultTimeoutMs = input.defaultTimeoutMs ?? CONFIG_DEFAULTS.defaultTimeoutMs
  const budgetMs = input.budgetMs ?? CONFIG_DEFAULTS.budgetMs
  requirePositiveInt(silenceMs, 'silenceMs')
  requirePositiveInt(defaultTimeoutMs, 'defaultTimeoutMs')
  requirePositiveInt(budgetMs, 'budgetMs')
  return {
    connect: { host, port },
    creds: { name, pass },
    silenceMs,
    defaultTimeoutMs,
    budgetMs,
    ...(input.corpusPath !== undefined ? { corpusPath: requireNonEmpty(input.corpusPath, 'corpusPath') } : {}),
  }
}
