/**
 * mud-core3 — 宿主插件入口（cordis 插件）。
 *
 * C3 宿主接线：把纯 TS 层（service/runtime/roster/deliver）接到宿主事件与 remote 通道。
 *
 * 职责：
 *   - 内存 roster（C2 先行；storage domain 依赖待解决后替换为持久化）
 *   - agent/created → roster 判定 → service.register + 记录 agent 句柄
 *   - session/disposed → service.dispose（断连 + 拆 runtime + 拆 deliverer）
 *   - remote.mud.{connect,disconnect,admit,stop,status} 动词（typert）
 *   - 投递回调：deliver(sessionId, text) → agent.followup(createUserMessage(...))
 *   - 插件卸载 → service.disposeAll
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包构建产物 lib/index.js。
 *
 * @module mud-core3
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// 宿主事件类型增强（agent/created、session/disposed 等）。
import type {} from '@deepseek-ai/dsh-agent'

import { MudService } from './service.ts'
import type {
  AccountRecord, ServerRecord, ResolvedCredentials,
} from './roster.ts'

/** 插件名。 */
export const name = 'mud-core3'

/** 必需服务：typert 注册表（remote 命名空间注册）。 */
export const inject = ['typert']

/** 插件配置。 */
export interface MudCore3Config {
  /**
   * 凭据解析器注入（宿主 ctx.get('credentials').resolve 的包装）。
   * 缺省 = 空解析器（所有 resolve 抛错；C2 测试/调试用，C3 接宿主后覆盖）。
   */
  resolveCreds?: (passRef: string) => Promise<ResolvedCredentials>
  /** 投递静默窗口毫秒。缺省 500ms。 */
  deliverQuietMs?: number
}

/** 唤醒署名：MUD 消息以用户消息到达，署名 'mud' 以区分人工提问。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mud': {
      kind: 'mud'
      plugin: string
    }
  }
}

// ── 内存 roster（C2 先行；storage domain 待依赖解决后替换）────────

const servers = new Map<string, ServerRecord>()
const accounts = new Map<string, AccountRecord>()

/** 内部 API：注册服务器（建服务器时调用；C4 管理面接此）。 */
export function _registerServer(server: ServerRecord): void {
  servers.set(server.workspaceId, server)
}

/** 内部 API：注册账号（建账号时调用；C3 建账号链路接此）。 */
export function _registerAccount(account: AccountRecord): void {
  accounts.set(account.id, account)
}

/** 内部 API：删除账号（删账号时调用）。 */
export function _removeAccount(accountId: string): void {
  accounts.delete(accountId)
}

/** 内部 API：删除服务器（无账号时；C4 管理面接此）。 */
export function _removeServer(workspaceId: string): void {
  servers.delete(workspaceId)
}

// ── Remote 服务 ─────────────────────────────────────────────────

/** remote.mud 命名空间：连接管理 + 接入闸门。 */
export class MudRemoteService extends TypertRemoteService {
  private readonly service: MudService

  constructor(ctx: Context, service: MudService) {
    super(ctx, 'mudRemote', { namespace: 'mud' })
    this.service = service
  }

  /** 建连 + login。 */
  @Remote
  async connect(sessionId: string | undefined): Promise<{ sessionId: string; state: string }> {
    if (sessionId === undefined || sessionId === '') throw new Error('sessionId 必填')
    const result = await this.service.connect(sessionId)
    return { sessionId: result.sessionId, state: result.state }
  }

  /** 断连。 */
  @Remote
  disconnect(sessionId: string | undefined): { sessionId: string; state: string } {
    if (sessionId === undefined || sessionId === '') throw new Error('sessionId 必填')
    this.service.disconnect(sessionId)
    return { sessionId, state: this.service.status(sessionId).state }
  }

  /** 接入：MUD 信息开始进入 agent。 */
  @Remote
  admit(sessionId: string | undefined): { sessionId: string; admitted: boolean } {
    if (sessionId === undefined || sessionId === '') throw new Error('sessionId 必填')
    this.service.admit(sessionId)
    return { sessionId, admitted: true }
  }

  /** 停止接入：MUD 信息不再进入 agent。 */
  @Remote
  stop(sessionId: string | undefined): { sessionId: string; admitted: boolean } {
    if (sessionId === undefined || sessionId === '') throw new Error('sessionId 必填')
    this.service.stop(sessionId)
    return { sessionId, admitted: false }
  }

  /** 连接状态 + 接入状态。 */
  @Remote
  status(sessionId: string | undefined): {
    state: string; admitted: boolean; sessions: readonly { sessionId: string; state: string; admitted: boolean }[]
  } {
    if (sessionId !== undefined && sessionId !== '') {
      return {
        state: this.service.status(sessionId).state,
        admitted: this.service.status(sessionId).admitted,
        sessions: this.service.statuses(),
      }
    }
    return { state: 'disconnected', admitted: false, sessions: this.service.statuses() }
  }
}

// ── 插件主体 ───────────────────────────────────────────────────

/** 宿主插件装配。 */
export function apply(ctx: Context, config: MudCore3Config = {}): void {
  // 凭据解析器（C2 缺省 = 空解析器；C3 接宿主 credentials 后覆盖）
  const resolveCreds = config.resolveCreds ?? (async (passRef: string) => {
    throw new Error(`凭据解析未配置（passRef=${passRef}）；C3 接宿主 credentials 后启用`)
  })

  // agent 句柄表（投递用：sessionId → live agent）
  const agentMap = new Map<string, { followup: (msg: ReturnType<typeof createUserMessage>) => void }>()

  // 投递回调：MUD 行流聚合后以用户消息投递进会话（等同人工提问）
  const deliver = (sessionId: string, text: string): void => {
    const agent = agentMap.get(sessionId)
    if (agent === undefined) return // agent 不在线（冷会话）；行流已积累，等 agent 回来
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'mud', plugin: 'mud-core3' },
    })
    agent.followup(msg)
  }

  const service = new MudService({
    serverLookup: sessionId => {
      const acc = accounts.get(sessionId)
      return acc ? servers.get(acc.serverId) : undefined
    },
    accountLookup: sessionId => accounts.get(sessionId),
    resolveCreds,
    deliver,
    ...(config.deliverQuietMs !== undefined ? { delivererConfig: { quietMs: config.deliverQuietMs } } : {}),
  })

  // ── agent/created → roster 判定 → 登记会话 + 记录 agent 句柄 ──
  // 归属 = sessionId ∈ accounts（roster 判定，不按 preset 排除）。
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.id)
    if (!accounts.has(sessionId)) return // 不在 roster = 不是我们的会话
    service.register(sessionId)
    // 记录 agent 句柄（投递用；agent 有 followup 方法）
    agentMap.set(sessionId, { followup: msg => agent.followup(msg) })
  })

  // ── agent/disposed → 移除 agent 句柄（runtime/deliverer 保留）──
  ctx.on('agent/disposed', ({ agent }) => {
    agentMap.delete(String(agent.id))
  })

  // ── session/disposed → 断连 + 拆 runtime + 拆 deliverer ──────
  ctx.on('session/disposed', (session) => {
    const sessionId = String(session.id)
    if (!accounts.has(sessionId)) return
    service.dispose(sessionId)
    agentMap.delete(sessionId)
  })

  // ── Remote 服务注册 ────────────────────────────────────────
  // TypertRemoteService 构造时 super(ctx, serviceKey) 已自动 ctx.provide(serviceKey)，
  // 不需要再手动 provide——重复 provide 会导致 "service already registered" 错误。
  new MudRemoteService(ctx, service)

  // typert 工件注册（先 try-import，typert 注册表不可用时跳过）。
  const typert = (ctx as unknown as { typert?: { register: (c: unknown) => () => void } }).typert
  if (typert !== undefined) {
    void import('mud-core3/typert').then(({ TYPERT }) => {
      const dispose = typert.register(TYPERT)
      ctx.effect(() => () => dispose(), 'mud-core3: typert')
    }).catch(() => {
      ctx.logger.info('mud-core3: typert 工件未注册（先跑 gen:typert）')
    })
  }

  // ── 插件卸载：断连全部 ─────────────────────────────────────
  ctx.effect(() => () => { service.disposeAll() })
}
