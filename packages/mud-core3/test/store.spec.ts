/**
 * store 测试 — 名册存储：内存实现、域表实现、记录 schema。
 *
 * 覆盖：
 *   - 内存存储的 servers/accounts CRUD
 *   - 域 spec 的记录 schema（合法通过；端口越界/缺字段/多字段拒绝）
 *   - 域表实现（fake storageDomain）读写；open 失败降级返回 null
 */

import { describe, expect, it } from 'vitest'
import {
  MemoryRosterStore, accountSchema, mudDomainSpec, openDomainRosterStore, serverSchema,
  type HostStorageDomain, type HostTable,
} from '../src/store.ts'
import type { AccountRecord, ServerRecord } from '../src/roster.ts'

function server(over: Partial<ServerRecord> = {}): ServerRecord {
  return { workspaceId: 'ws-1', name: '北大侠客行', host: 'mud.example.org', port: 4000, ...over }
}

function account(over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'session-1', name: 'hero', passRef: 'MUD_HERO', serverId: 'ws-1',
    preset: 'mud-player', admitted: false, ...over,
  }
}

/** 内存表（HostTable 结构化实现），用于验证域表路径。 */
function fakeTable<V>(): HostTable<V> {
  const map = new Map<string, V>()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    delete: async key => map.delete(key),
  }
}

/** 假 storageDomain：返回固定两张内存表；open 可配置为抛错。 */
function fakeDomain(fail = false): HostStorageDomain {
  const tables: Record<string, HostTable<unknown>> = { servers: fakeTable(), accounts: fakeTable() }
  return {
    open: async () => {
      if (fail) throw new Error('domain unavailable')
      return { table: name => tables[name] ?? fakeTable() }
    },
  }
}

describe('MemoryRosterStore', () => {
  it('servers/accounts 读写删', async () => {
    const store = new MemoryRosterStore()
    expect(store.server('ws-1')).toBeUndefined()

    await store.putServer(server())
    expect(store.server('ws-1')?.host).toBe('mud.example.org')
    expect(store.servers()).toHaveLength(1)

    await store.putAccount(account())
    expect(store.account('session-1')?.name).toBe('hero')
    expect(store.accounts()).toHaveLength(1)

    expect(await store.deleteAccount('session-1')).toBe(true)
    expect(await store.deleteAccount('session-1')).toBe(false)
    expect(await store.deleteServer('ws-1')).toBe(true)
    expect(store.servers()).toHaveLength(0)
  })
})

describe('名册记录 schema', () => {
  it('服务器：合法通过；端口越界/非整数拒绝', () => {
    expect(serverSchema.safeParse(server()).success).toBe(true)
    expect(serverSchema.safeParse(server({ port: 0 })).success).toBe(false)
    expect(serverSchema.safeParse(server({ port: 70000 })).success).toBe(false)
    expect(serverSchema.safeParse(server({ port: 4000.5 })).success).toBe(false)
    expect(serverSchema.safeParse({ ...server(), extra: 1 }).success).toBe(false)
  })

  it('账号：合法通过；缺 admitted/多字段拒绝', () => {
    expect(accountSchema.safeParse(account()).success).toBe(true)
    const { admitted: _omitted, ...withoutAdmitted } = account()
    expect(accountSchema.safeParse(withoutAdmitted).success).toBe(false)
    expect(accountSchema.safeParse({ ...account(), extra: 1 }).success).toBe(false)
  })

  it('域 spec 声明 servers/accounts 两张表', () => {
    expect(mudDomainSpec.name).toBe('mud')
    expect(Object.keys(mudDomainSpec.tables).sort()).toEqual(['accounts', 'servers'])
  })
})

describe('openDomainRosterStore', () => {
  it('域可用：读写落在域表上', async () => {
    const store = await openDomainRosterStore(fakeDomain())
    expect(store).not.toBeNull()
    await store!.putServer(server())
    await store!.putAccount(account())
    expect(store!.server('ws-1')).toEqual(server())
    expect(store!.account('session-1')?.passRef).toBe('MUD_HERO')
    expect(await store!.deleteAccount('session-1')).toBe(true)
    expect(store!.accounts()).toEqual([])
  })

  it('域打开失败：返回 null（调用侧降级内存）', async () => {
    expect(await openDomainRosterStore(fakeDomain(true))).toBeNull()
  })
})
