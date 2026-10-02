/**
 * mud-core3 accounts — 服务器/账号的写路径编排（建账号 = 一个动作，设计 §11.1/§11.2）。
 *
 * 与宿主解耦：会话创建、id 分配、名册存储都经依赖注入，宿主接线在 index.ts，
 * 测试注入内存实现。**先落名册再建会话** —— `agent/created` 的归属判定
 *（sessionId ∈ accounts）必须能在会话创建过程中命中，否则 runtime 不会登记。
 * 建会话失败回滚名册（一个动作不留半成品）。
 */

import { randomUUID } from 'node:crypto'
import type { AccountRecord, RosterStore, ServerRecord } from './roster.ts'

/** 建会话请求（sessionId = 账号 id）。 */
export interface CreateSessionRequest {
  readonly sessionId: string
  readonly cwd: string
  readonly agentPreset: string
}

/** 账号写路径依赖（宿主接线注入）。 */
export interface AccountWriteDeps {
  readonly store: RosterStore
  /** 建会话并绑定 preset（宿主 `sessionController.create`）。 */
  readonly createSession: (request: CreateSessionRequest) => Promise<void>
  /** 账号 id 分配（缺省 `session-<uuid>`；与宿主会话 id 形制一致）。 */
  readonly mintId?: (() => string) | undefined
}

/** 建账号输入。 */
export interface AddAccountInput {
  /** 所属服务器 workspaceId。 */
  readonly serverId: string
  /** MUD 登录名。 */
  readonly name: string
  /** 密码凭据引用名（页面已 `credentials.set` 写入）。 */
  readonly passRef: string
  /** 建账号时选的 preset id。 */
  readonly preset: string
  /** 会话工作目录（= 服务器工作区 path）。 */
  readonly cwd: string
}

/** 缺省 id 分配：与宿主会话 id 同形（`session-<uuid>`）。 */
function defaultMintId(): string {
  return `session-${randomUUID()}`
}

/** 必填字段校验（空串/空白即拒绝，错误直接点名）。 */
function required(value: string, field: string): string {
  if (value.trim() === '') throw new Error(`${field} 必填`)
  return value
}

/**
 * 建账号：写名册 → 建会话（sessionId = 账号 id，绑定 preset）。
 * @param deps - 名册/建会话/分配器依赖。
 * @param input - 账号属性。
 * @returns 落库后的账号记录。
 * @throws 服务器不在名册、必填字段为空、建会话失败（失败时名册回滚）。
 */
export async function addAccount(deps: AccountWriteDeps, input: AddAccountInput): Promise<AccountRecord> {
  const server = deps.store.server(input.serverId)
  if (server === undefined) throw new Error(`服务器 ${input.serverId} 不在名册`)

  const record: AccountRecord = {
    id: (deps.mintId ?? defaultMintId)(),
    name: required(input.name, '账号名'),
    passRef: input.passRef,
    serverId: input.serverId,
    preset: required(input.preset, 'preset'),
    admitted: false,
  }
  await deps.store.putAccount(record)
  try {
    await deps.createSession({ sessionId: record.id, cwd: input.cwd, agentPreset: record.preset })
  } catch (error) {
    await deps.store.deleteAccount(record.id)
    throw error
  }
  return record
}

/**
 * 删账号：清名册记录（会话销毁由宿主侧自行处理——插件拿不到 agent handle 的 dispose 能力）。
 * @param deps - 名册依赖。
 * @param sessionId - 账号 id（= 会话 id）。
 * @returns 是否删掉了记录。
 */
export function removeAccount(deps: AccountWriteDeps, sessionId: string): Promise<boolean> {
  return deps.store.deleteAccount(sessionId)
}

/**
 * 建服务器：写名册（工作区实体由调用侧经宿主 workspace 面创建，本函数只记字段）。
 * @param deps - 名册依赖。
 * @param record - 服务器记录（键 = workspaceId）。
 * @returns 落库后的记录。
 */
export async function addServer(deps: AccountWriteDeps, record: ServerRecord): Promise<ServerRecord> {
  required(record.workspaceId, 'workspaceId')
  required(record.host, 'host')
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    throw new Error(`端口非法：${String(record.port)}（应为 1–65535）`)
  }
  await deps.store.putServer(record)
  return record
}

/**
 * 删服务器：无账号时才允许（设计 §11.1）。
 * @param deps - 名册依赖。
 * @param workspaceId - 服务器键。
 * @throws 该服务器下仍有账号时抛错（提示先删账号）。
 */
export async function removeServer(deps: AccountWriteDeps, workspaceId: string): Promise<void> {
  const remaining = deps.store.accounts().filter(account => account.serverId === workspaceId)
  if (remaining.length > 0) {
    throw new Error(`服务器 ${workspaceId} 下仍有 ${remaining.length} 个账号，先删账号再删服务器`)
  }
  await deps.store.deleteServer(workspaceId)
}

/**
 * 写回接入状态（admit/stop 持久化；设计 §6.3「roster accounts.admitted 持久」）。
 * @param deps - 名册依赖。
 * @param sessionId - 账号 id。
 * @param admitted - 目标接入状态。
 * @throws 账号不在名册时抛错。
 */
export async function setAdmitted(
  deps: AccountWriteDeps,
  sessionId: string,
  admitted: boolean,
): Promise<AccountRecord> {
  const current = deps.store.account(sessionId)
  if (current === undefined) throw new Error(`账号 ${sessionId} 不在名册`)
  const next: AccountRecord = { ...current, admitted }
  await deps.store.putAccount(next)
  return next
}
