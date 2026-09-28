/**
 * mud-core3 store — 名册存储：宿主 storage 域（持久）与内存（降级）两种实现。
 *
 * 名册 = 服务器（键 = workspaceId）+ 账号（键 = accountId = sessionId），设计 §1.1/§3.1。
 * 记录 schema 是持久化边界的唯一事实源（zod），域 spec 交给宿主 `ctx.storageDomain.open`；
 * 宿主不可用时回落内存实现（开发/无 storage 档位下仍可跑，重启丢账号）。
 *
 * 纯度纪律：本文件只依赖 zod 与 node 内建；宿主 storage 域以结构化接口接入，
 * 不引 `@deepseek-ai/dsh-storage-domain`（避免为一个域声明拖进宿主包依赖）。
 */

import { z } from 'zod'
import type { AccountRecord, RosterStore, ServerRecord } from './roster.ts'

/** 服务器记录 schema（持久化边界校验）。 */
export const serverSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
}).strict()

/** 账号记录 schema（持久化边界校验；passRef 是引用名，不是密文）。 */
export const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  passRef: z.string(),
  serverId: z.string().min(1),
  preset: z.string().min(1),
  admitted: z.boolean(),
}).strict()

/**
 * 域声明（结构化字面量：宿主 `ctx.storageDomain.open` 接受任何符合 DomainSpec 的对象）。
 * 表名/域名的合法性由宿主 open 时校验（`UNIT_NAME_RE` 等）。
 */
export const mudDomainSpec = {
  name: 'mud',
  version: 1,
  tables: {
    servers: { valueSchema: serverSchema },
    accounts: { valueSchema: accountSchema },
  },
} as const

/** 宿主 storage 表的最小面（`KvTable` 结构化子集）。 */
export interface HostTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 宿主 storage 域的最小面（`ctx.storageDomain` 结构化子集）。 */
export interface HostStorageDomain {
  open(spec: unknown): Promise<{
    table(name: string): HostTable<unknown>
  }>
}

/** 名册表的宿主句柄（open 之后）。 */
export interface HostRosterTables {
  readonly servers: HostTable<ServerRecord>
  readonly accounts: HostTable<AccountRecord>
}

/** storage 域实现的名册存储。 */
class DomainRosterStore implements RosterStore {
  /**
   * @param tables - 已打开的 servers/accounts 表句柄。
   */
  constructor(private readonly tables: HostRosterTables) {}

  server(workspaceId: string): ServerRecord | undefined {
    return this.tables.servers.get(workspaceId)
  }

  servers(): readonly ServerRecord[] {
    return [...this.tables.servers.entries()].map(([, record]) => record)
  }

  putServer(record: ServerRecord): Promise<void> {
    return this.tables.servers.put(record.workspaceId, record)
  }

  deleteServer(workspaceId: string): Promise<boolean> {
    return this.tables.servers.delete(workspaceId)
  }

  account(sessionId: string): AccountRecord | undefined {
    return this.tables.accounts.get(sessionId)
  }

  accounts(): readonly AccountRecord[] {
    return [...this.tables.accounts.entries()].map(([, record]) => record)
  }

  putAccount(record: AccountRecord): Promise<void> {
    return this.tables.accounts.put(record.id, record)
  }

  deleteAccount(sessionId: string): Promise<boolean> {
    return this.tables.accounts.delete(sessionId)
  }
}

/** 内存名册存储（宿主 storage 域不可用时降级；进程内，重启丢）。 */
export class MemoryRosterStore implements RosterStore {
  private readonly serverMap = new Map<string, ServerRecord>()
  private readonly accountMap = new Map<string, AccountRecord>()

  server(workspaceId: string): ServerRecord | undefined {
    return this.serverMap.get(workspaceId)
  }

  servers(): readonly ServerRecord[] {
    return [...this.serverMap.values()]
  }

  async putServer(record: ServerRecord): Promise<void> {
    this.serverMap.set(record.workspaceId, record)
  }

  async deleteServer(workspaceId: string): Promise<boolean> {
    return this.serverMap.delete(workspaceId)
  }

  account(sessionId: string): AccountRecord | undefined {
    return this.accountMap.get(sessionId)
  }

  accounts(): readonly AccountRecord[] {
    return [...this.accountMap.values()]
  }

  async putAccount(record: AccountRecord): Promise<void> {
    this.accountMap.set(record.id, record)
  }

  async deleteAccount(sessionId: string): Promise<boolean> {
    return this.accountMap.delete(sessionId)
  }
}

/**
 * 打开宿主 storage 域上的名册存储；域不可用（服务缺失/open 失败）返回 null 由调用方降级。
 * @param domain - `ctx.storageDomain`（结构化面）。
 * @returns storage 域名册存储，或 null。
 */
export async function openDomainRosterStore(domain: HostStorageDomain): Promise<RosterStore | null> {
  try {
    const opened = await domain.open(mudDomainSpec)
    return new DomainRosterStore({
      servers: opened.table('servers') as HostTable<ServerRecord>,
      accounts: opened.table('accounts') as HostTable<AccountRecord>,
    })
  } catch {
    return null
  }
}
