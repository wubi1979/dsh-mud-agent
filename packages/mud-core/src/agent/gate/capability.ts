/**
 * dsh-mud-core — 档位状态与读写 (permission capability, `doc/ARCHITECTURE.md` §10).
 *
 * 档位是**每会话**的持久事实, 走官方会话机制:
 *   - 写入: `session.append('mud/capability', { tier })` —— log-only 事件, 不进模型
 *     转录 (与官方 `permission/preset` 同款);
 *   - 读取: 官方会话投影 (`sessionProjections` 的 `mudCapabilities` 单元), resume
 *     后按日志重建; 投影不可用 (未装配该服务) 时回落进程内记忆 + 部署缺省。
 *
 * 对外 API 形状对齐官方 `permissionPresets` (`names/current/resolve/optionOf/
 * defaultTier`), 因为消费方 (页面档位选择器) 已经熟悉那个形状。**agent 永不自
 * 提权**: 工具层只读档位, 写入口只有 `ctx.mud.capability.set` (页面/宿主)。
 * @module @deepseek-ai/dsh-mud-core/agent/gate/capability
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  isMudTier, MUD_TIER_NAMES, mudTierOption, resolveMudTier, tierSpec,
  type MudTier, type MudTierSpec,
} from './tiers.ts'

/** 记录档位的会话事件 (log-only; 模型不可见)。 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 用户/宿主为该会话选择的 MUD 权限档位 (只读/读写/完全)。 */
    'mud/capability': { tier: string }
  }
}

/** 投影 key 与折叠状态。 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最近一次 `mud/capability` 记录 (null = 尚未记录)。 */
    mudCapabilities: { tier: string | null }
  }
}

/** 客户端/宿主可见的档位选项 (形状对齐官方 `PresetOption`)。 */
export interface MudCapabilityOption {
  value: string
  name: string
  description: string
}

/** 档位服务 (`ctx.mud.capability`)。 */
export interface MudCapabilityApi {
  /** 可选档位 (声明顺序)。 */
  readonly names: readonly MudTier[]
  /** 新会话缺省档位 (部署配置 `defaultTier`)。 */
  readonly defaultTier: MudTier
  /**
   * 读某会话当前档位 (投影 → 进程内记忆 → 缺省)。
   * @param sessionId 官方会话 id。
   * @returns 生效档位。
   */
  current(sessionId: string): MudTier
  /**
   * 解析档位名。
   * @param tier 档位名。
   * @returns 该档声明。
   * @throws 名字不在表里。
   */
  resolve(tier: string): MudTierSpec
  /**
   * 构造客户端选项。
   * @param tier 档位名。
   * @returns `{ value, name, description }`。
   */
  optionOf(tier: string): MudCapabilityOption
  /** 全部档位选项 (声明顺序)。 */
  options(): readonly MudCapabilityOption[]
  /**
   * 该档开放的外围能力 id。
   * @param tier 档位。
   * @returns 能力 id 列表。
   */
  capabilities(tier: MudTier): readonly string[]
  /**
   * 切换某会话档位 (页面/宿主入口; 重复设置同档不写日志)。
   * @param sessionId 官方会话 id。
   * @param tier 档位名 (非法名抛出)。
   * @returns 生效档位。
   */
  set(sessionId: string, tier: string): MudTier
  /**
   * 确保该会话已有档位记录 (MUD 会话声明时调用; 缺省档位落一次日志)。
   * @param sessionId 官方会话 id。
   * @returns 生效档位。
   */
  ensure(sessionId: string): MudTier
  /**
   * 订阅档位变更 (装配方据此重挂工具可见性)。
   * @param listener 变更回调。
   * @returns 退订函数。
   */
  onChange(listener: (sessionId: string, tier: MudTier) => void): () => void
}

/** 投影单元声明 (key/版本/折叠)。 */
type CapabilityProjection = ProjectionDefinition<'mudCapabilities', SessionProjectionStateMap['mudCapabilities']>

/**
 * 折叠: 只认 `mud/capability`, 其余事件原样返回 (引用不变 → 官方变更门零开销)。
 * @param state 前一状态。
 * @param event 一条已提交会话事件。
 * @returns 下一状态。
 */
export function applyCapabilityEvent(
  state: SessionProjectionStateMap['mudCapabilities'],
  event: { type: string; data?: unknown },
): SessionProjectionStateMap['mudCapabilities'] {
  if (event.type !== 'mud/capability') return state
  const tier = (event.data as { tier?: unknown } | undefined)?.tier
  return { tier: typeof tier === 'string' ? tier : null }
}

/**
 * 持久化状态校验 (官方要求 `stateSchema` 在折叠前验一遍持久缓存值)。
 *
 * 手写而非 zod: 本包不依赖 zod (投影服务要求的是 `parse` 契约, 这里的状态只有
 * 一个可空字符串字段, 引入依赖不划算)。
 * @param value 反序列化出来的候选状态。
 * @returns 合法状态。
 * @throws 值不是本单元的状态。
 */
export function parseCapabilityState(value: unknown): SessionProjectionStateMap['mudCapabilities'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('mud capability projection: state must be an object')
  }
  const tier = (value as { tier?: unknown }).tier
  if (tier !== null && typeof tier !== 'string') {
    throw new Error('mud capability projection: tier must be a string or null')
  }
  return { tier }
}

/** 投影注册声明 (stateSchema 按官方 `ZodType` 契约结构传入)。 */
const CAPABILITY_PROJECTION: CapabilityProjection = {
  key: 'mudCapabilities',
  stateVersion: 1,
  stateSchema: { parse: parseCapabilityState } as unknown as CapabilityProjection['stateSchema'],
  init: () => ({ tier: null }),
  apply: applyCapabilityEvent,
}

/**
 * 注册档位服务。
 * @param ctx 宿主上下文。
 * @param options 缺省档位与日志回调。
 * @returns 档位 API (挂到 `ctx.mud.capability`)。
 */
export function registerMudCapability(
  ctx: Context,
  options: { defaultTier: MudTier; log?: (text: string) => void },
): MudCapabilityApi {
  const defaultTier: MudTier = options.defaultTier
  /** 进程内记忆 (投影不可用时的回落; 也是热路径的读缓存)。 */
  const live = new Map<string, MudTier>()
  const listeners = new Set<(sessionId: string, tier: MudTier) => void>()
  /** 投影与会话注册表 (官方服务后到 → 由 inject 子纤程补上)。 */
  let projections: Context['sessionProjections'] | undefined
  let sessionRegistry: Context['sessions'] | undefined

  ctx.inject(['sessions', 'sessionProjections'], (capCtx) => {
    sessionRegistry = capCtx.sessions
    projections = capCtx.sessionProjections
    capCtx.sessionProjections.register(CAPABILITY_PROJECTION)
    return () => {
      projections = undefined
      sessionRegistry = undefined
    }
  })

  /** 官方会话对象 (注册表缺失/会话不存在 → undefined)。 */
  function sessionOf(sessionId: string): Session | undefined {
    try {
      return sessionRegistry?.get(sessionId as SessionId)
    } catch {
      return undefined
    }
  }

  /** 日志里记录的档位 (无记录/非法值 → undefined)。 */
  function recordedTier(sessionId: string): MudTier | undefined {
    const session = sessionOf(sessionId)
    if (session === undefined || projections === undefined) return undefined
    const state = projections.stateOf(session, 'mudCapabilities')
    const tier = state?.tier
    return tier !== undefined && tier !== null && isMudTier(tier) ? tier : undefined
  }

  function notify(sessionId: string, tier: MudTier): void {
    for (const listener of [...listeners]) listener(sessionId, tier)
  }

  const api: MudCapabilityApi = {
    names: MUD_TIER_NAMES,
    defaultTier,
    current(sessionId: string): MudTier {
      return live.get(sessionId) ?? recordedTier(sessionId) ?? defaultTier
    },
    resolve(tier: string): MudTierSpec {
      if (!isMudTier(tier)) {
        throw new Error(`mud permission: unknown tier "${tier}" (known: ${MUD_TIER_NAMES.join(', ')})`)
      }
      return tierSpec(tier)
    },
    optionOf(tier: string): MudCapabilityOption {
      return mudTierOption(tier)
    },
    options(): readonly MudCapabilityOption[] {
      return MUD_TIER_NAMES.map(tier => mudTierOption(tier))
    },
    capabilities(tier: MudTier): readonly string[] {
      return tierSpec(tier).capabilities
    },
    set(sessionId: string, tier: string): MudTier {
      const next = api.resolve(tier).tier
      const previous = api.current(sessionId)
      live.set(sessionId, next)
      if (next === previous) return next
      const session = sessionOf(sessionId)
      if (session === undefined) {
        options.log?.(`[权限] 档位 ${previous} → ${next} (会话 ${sessionId} 未注册, 仅进程内生效)`)
      } else {
        session.append('mud/capability', { tier: next })
        options.log?.(`[权限] 档位 ${previous} → ${next} (${sessionId})`)
      }
      notify(sessionId, next)
      return next
    },
    ensure(sessionId: string): MudTier {
      const recorded = recordedTier(sessionId)
      if (recorded !== undefined) {
        live.set(sessionId, recorded)
        return recorded
      }
      // 本进程已为该会话定过档位 (例如先 set 后 ensure) → 不覆盖。
      const existing = live.get(sessionId)
      if (existing !== undefined) return existing
      const session = sessionOf(sessionId)
      live.set(sessionId, defaultTier)
      if (session === undefined) return defaultTier
      session.append('mud/capability', { tier: defaultTier })
      options.log?.(`[权限] 新会话档位 = ${defaultTier} (${sessionId})`)
      return defaultTier
    },
    onChange(listener: (sessionId: string, tier: MudTier) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return api
}

/** 配置里的档位名解析 (坏值回落, 不抛出)。 */
export { resolveMudTier }
