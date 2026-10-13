/**
 * accounts 测试 — 服务器/账号写路径编排（建账号 = 一个动作）。
 *
 * 覆盖：
 *   - addAccount：先落名册再建会话（顺序可观测）、sessionId = 账号 id、preset/cwd 透传
 *   - addAccount：服务器不在名册抛错；建会话失败回滚名册（不留半成品）
 *   - addServer：端口非法拒绝；removeServer：仍有账号时拒绝
 *   - setAdmitted：接入状态持久化
 */

import { describe, expect, it } from 'vitest'
import { MemoryRosterStore } from '../src/store.ts'
import type { AccountRecord, ServerRecord } from '../src/roster.ts'
import {
  addAccount, addServer, removeAccount, removeServer, setAdmitted, renameAccount,
  type AccountWriteDeps, type CreateSessionRequest,
} from '../src/accounts.ts'

function serverRecord(over: Partial<ServerRecord> = {}): ServerRecord {
  return { workspaceId: 'ws-1', name: '北大侠客行', host: 'mud.example.org', port: 4000, ...over }
}

interface Harness {
  deps: AccountWriteDeps
  store: MemoryRosterStore
  created: CreateSessionRequest[]
  /** 建会话时名册里是否已有该账号（验证"先落名册"）。 */
  seenDuringCreate: boolean[]
}

function harness(options: { failCreate?: boolean; store?: MemoryRosterStore } = {}): Harness {
  const store = options.store ?? new MemoryRosterStore()
  const created: CreateSessionRequest[] = []
  const seenDuringCreate: boolean[] = []
  return {
    store,
    created,
    seenDuringCreate,
    deps: {
      store,
      mintId: () => 'session-fixed',
      createSession: async (request) => {
        created.push(request)
        seenDuringCreate.push(store.account(request.sessionId) !== undefined)
        if (options.failCreate === true) throw new Error('建会话失败（宿主拒绝）')
      },
    },
  }
}

const INPUT = {
  serverId: 'ws-1', name: 'hero', passRef: 'MUD_HERO', preset: 'mud-player', cwd: 'D:/mud/ws-1',
} as const

describe('addAccount', () => {
  it('先落名册再建会话；sessionId = 账号 id；preset/cwd 透传', async () => {
    const h = harness()
    await h.store.putServer(serverRecord())

    const record = await addAccount(h.deps, INPUT)
    expect(record).toEqual({
      id: 'session-fixed', name: 'hero', passRef: 'MUD_HERO',
      serverId: 'ws-1', preset: 'mud-player', admitted: false,
    } satisfies AccountRecord)
    expect(h.created).toEqual([{ sessionId: 'session-fixed', cwd: 'D:/mud/ws-1', agentPreset: 'mud-player' }])
    expect(h.seenDuringCreate).toEqual([true]) // agent/created 的归属判定必须能命中
    expect(h.store.account('session-fixed')).toEqual(record)
  })

  it('服务器不在名册：抛错且不建会话', async () => {
    const h = harness()
    await expect(addAccount(h.deps, INPUT)).rejects.toThrow('不在名册')
    expect(h.created).toEqual([])
    expect(h.store.accounts()).toEqual([])
  })

  it('必填字段为空：抛错且不落名册', async () => {
    const h = harness()
    await h.store.putServer(serverRecord())
    await expect(addAccount(h.deps, { ...INPUT, name: '  ' })).rejects.toThrow('账号名 必填')
    await expect(addAccount(h.deps, { ...INPUT, preset: '' })).rejects.toThrow('preset 必填')
    expect(h.store.accounts()).toEqual([])
  })

  it('建会话失败：回滚名册（一个动作不留半成品）', async () => {
    const h = harness({ failCreate: true })
    await h.store.putServer(serverRecord())
    await expect(addAccount(h.deps, INPUT)).rejects.toThrow('建会话失败')
    expect(h.store.account('session-fixed')).toBeUndefined()
  })
})

describe('服务器写路径', () => {
  it('addServer 落名册；端口非法拒绝', async () => {
    const h = harness()
    await addServer(h.deps, serverRecord())
    expect(h.store.server('ws-1')?.host).toBe('mud.example.org')
    await expect(addServer(h.deps, serverRecord({ workspaceId: 'ws-2', port: 0 }))).rejects.toThrow('端口非法')
    await expect(addServer(h.deps, serverRecord({ workspaceId: '', }))).rejects.toThrow('workspaceId 必填')
  })

  it('addServer 端点去重：同 host:port（大小写不敏感）拒绝，不同端口放行', async () => {
    const h = harness()
    await addServer(h.deps, serverRecord())
    await expect(addServer(h.deps, serverRecord({ workspaceId: 'ws-2', name: '同端点' })))
      .rejects.toThrow('相同端点的服务器已存在')
    await expect(addServer(h.deps, serverRecord({ workspaceId: 'ws-2', host: 'MUD.Example.ORG' })))
      .rejects.toThrow('相同端点的服务器已存在')
    await addServer(h.deps, serverRecord({ workspaceId: 'ws-2', port: 4001 }))
    expect(h.store.server('ws-2')).toBeDefined()
  })

  it('removeServer：仍有账号时拒绝，清空后允许', async () => {
    const h = harness()
    await addServer(h.deps, serverRecord())
    await addAccount(h.deps, INPUT)

    await expect(removeServer(h.deps, 'ws-1')).rejects.toThrow('仍有 1 个账号')
    expect(await removeAccount(h.deps, 'session-fixed')).toBe(true)
    await removeServer(h.deps, 'ws-1')
    expect(h.store.server('ws-1')).toBeUndefined()
  })
})

describe('setAdmitted', () => {
  it('持久化接入状态；账号不存在抛错', async () => {
    const h = harness()
    await h.store.putServer(serverRecord())
    await addAccount(h.deps, INPUT)

    expect((await setAdmitted(h.deps, 'session-fixed', true)).admitted).toBe(true)
    expect(h.store.account('session-fixed')?.admitted).toBe(true)
    expect((await setAdmitted(h.deps, 'session-fixed', false)).admitted).toBe(false)
    await expect(setAdmitted(h.deps, 'missing', true)).rejects.toThrow('不在名册')
  })
})

describe('renameAccount', () => {
  it('改名落库；其余字段保持', async () => {
    const h = harness()
    await h.store.putServer(serverRecord())
    await addAccount(h.deps, INPUT)

    const next = await renameAccount(h.deps, 'session-fixed', 'hero2')
    expect(next.name).toBe('hero2')
    expect(h.store.account('session-fixed')?.name).toBe('hero2')
    expect(h.store.account('session-fixed')?.passRef).toBe('MUD_HERO')
    expect(h.store.account('session-fixed')?.preset).toBe('mud-player')
  })

  it('账号不存在抛错；名字为空拒绝', async () => {
    const h = harness()
    await h.store.putServer(serverRecord())
    await addAccount(h.deps, INPUT)

    await expect(renameAccount(h.deps, 'missing', 'x')).rejects.toThrow('不在名册')
    await expect(renameAccount(h.deps, 'session-fixed', '  ')).rejects.toThrow('账号名 必填')
  })
})
