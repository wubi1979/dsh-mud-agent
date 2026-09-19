/**
 * dsh-mud-core — connect 的凭据引用解析 (`doc/ARCHITECTURE.md` §10 + §11)。
 *
 * 测的是**密码在 RPC 面上只以引用名流转、明文由 host 在连接瞬间解析**这条契约。
 * 被测对象是 `session/credential-source.ts` 的 `resolveMudPass` —— 策略住在那里
 * 而不是 `assemble.ts`, 是因为 `assemble.ts` 的模块图含 `@Remote` (TC39 装饰器)
 * 标注的 remote 服务, 而本仓 vitest 管线 (Vite 8/rolldown/oxc) 无法降级 TC39
 * 装饰器 (oxc 只实现 legacy 版), 只有 `tsc` 会 (§ 该模块的头注释有完整说明)。
 *
 * 七条契约:
 *   ① 显式 passRef 解析成功 → 明文
 *   ② 无显式值时回落 fallback; 显式值覆盖回落
 *   ③ 未挂载凭据 provider → 抛错 + onError 留痕 (指名引用名)
 *   ④ 引用未配置 (`resolve` → `undefined`) → 同③
 *   ⑤ 引用名不合 CredentialRef 语法 → 报错指名引用名
 *   ⑥ 无 passRef (含空白串) → 合法空密码, 不触碰凭据服务
 *   ⑦ **每次连接重新解析**: 不跨操作缓存 (改密后下次连接即生效)
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { resolveMudPass, type MudPassRefs } from '../src/session/credential-source.ts'

/** 假凭据 provider: 只实现被调用的 `resolve`, 值表可变 (观测"重新解析")。 */
function stubProvider(values: Record<string, string>): {
  provider: CredentialProvider
  resolve: ReturnType<typeof vi.fn>
} {
  const resolve = vi.fn((ref: CredentialRef): Promise<ResolvedCredential | undefined> => {
    const value = values[String(ref)]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  })
  return { provider: { resolve } as unknown as CredentialProvider, resolve }
}

interface Harness {
  /** 解析入口 (绑定该 ctx 与留痕收集器)。 */
  resolve: (refs: MudPassRefs) => Promise<string>
  /** 假 provider 的 `resolve` spy (未挂载 provider 时是空 spy)。 */
  providerResolve: ReturnType<typeof vi.fn>
  /** 留痕回调收到的消息 (按调用顺序)。 */
  errors: string[]
  /** 可变值表 (改它等于"用户在别处改了密码")。 */
  values: Record<string, string>
}

/**
 * 建一个只挂需要的那一个服务的真 cordis Context。
 * @param options.provider 是否挂载假凭据 provider (false = 部署未挂载)。
 * @param options.values provider 的值表 (引用名 → 明文)。
 * @returns 观测面 (解析入口 / spy / 留痕 / 可变值表)。
 */
function harness(options: { provider?: boolean; values?: Record<string, string> } = {}): Harness {
  const values = options.values ?? {}
  const ctx = new Context()
  let providerResolve: ReturnType<typeof vi.fn> = vi.fn()
  if (options.provider !== false) {
    const stub = stubProvider(values)
    providerResolve = stub.resolve
    ctx.provide('credentials', stub.provider)
  }
  const errors: string[] = []
  return {
    resolve: refs => resolveMudPass(ctx, refs, (message) => { errors.push(message) }),
    providerResolve,
    errors,
    values,
  }
}

describe('登录密码的凭据引用解析', () => {
  it('① 显式 passRef 解析成功: 返回明文', async () => {
    const h = harness({ values: { MUD_PASS_A: 's3cret' } })

    await expect(h.resolve({ explicit: 'MUD_PASS_A' })).resolves.toBe('s3cret')
    expect(h.providerResolve).toHaveBeenCalledTimes(1)
    expect(h.errors).toEqual([])
  })

  it('② 回落 fallback; 显式 passRef 覆盖回落值', async () => {
    const h = harness({ values: { MUD_PASS_D: 'deploy-pass', MUD_PASS_A: 'override-pass' } })

    await expect(h.resolve({ fallback: 'MUD_PASS_D' })).resolves.toBe('deploy-pass')
    await expect(h.resolve({ explicit: 'MUD_PASS_A', fallback: 'MUD_PASS_D' })).resolves.toBe('override-pass')
  })

  it('③ 未挂载凭据 provider: 抛错 + 留痕指名引用名', async () => {
    const h = harness({ provider: false })

    await expect(h.resolve({ explicit: 'MUD_PASS_A' })).rejects.toThrow(/未挂载凭据 provider/)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatch(/MUD_PASS_A/)
  })

  it('④ 引用未配置 (resolve → undefined): 抛错 + 留痕指名引用名', async () => {
    const h = harness({ values: {} })

    await expect(h.resolve({ explicit: 'MUD_PASS_MISSING' })).rejects.toThrow(/未配置/)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatch(/MUD_PASS_MISSING/)
  })

  it('⑤ 引用名不合 CredentialRef 语法: 报错指名引用名', async () => {
    const h = harness({ values: {} })

    await expect(h.resolve({ explicit: '9-BAD NAME' })).rejects.toThrow(/credential ref "9-BAD NAME"/)
    expect(h.errors[0]).toMatch(/9-BAD NAME/)
  })

  it('⑥ 无 passRef (含空白串) 是合法空密码: 不触碰凭据服务', async () => {
    const h = harness({ values: { MUD_PASS_A: 's3cret' } })

    await expect(h.resolve({})).resolves.toBe('')
    await expect(h.resolve({ explicit: '   ' })).resolves.toBe('')
    await expect(h.resolve({ explicit: '', fallback: '  ' })).resolves.toBe('')
    expect(h.providerResolve).not.toHaveBeenCalled()
    expect(h.errors).toEqual([])
  })

  it('⑦ 每次连接重新解析: 不跨操作缓存', async () => {
    const h = harness({ values: { MUD_PASS_R: 'first' } })

    await expect(h.resolve({ explicit: 'MUD_PASS_R' })).resolves.toBe('first')
    // 用户在别处改密 (改 env / 重写 .credentials.yaml / 页面重录)。
    h.values.MUD_PASS_R = 'second'
    await expect(h.resolve({ explicit: 'MUD_PASS_R' })).resolves.toBe('second')

    expect(h.providerResolve).toHaveBeenCalledTimes(2)
  })
})
