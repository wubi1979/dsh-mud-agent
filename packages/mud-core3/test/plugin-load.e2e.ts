/**
 * 装配层加载冒烟（工件面 e2e）— mud-core3 插件经 cordis 真加载一次，`apply` 不得失败。
 *
 * **为什么导入 `lib/index.js` 而不是 `src/index.ts`**：插件源用**标准装饰器**（`@Remote`），
 * vitest 的 esbuild 转译不支持（`Invalid or unexpected token`）⇒ 源码面不可加载；而宿主跑的
 * 正是 `lib/` 产物（§2.2：patch 的 `name` 指向构建产物，**改码后必须重建**），工件面反而
 * 与宿主行为一致。代价：本用例依赖 `pnpm --filter mud-core3 build` 的最新产物。
 *
 * 动因（2026-10-02 实机缺陷）：装配期读**未声明 `inject`** 的服务属性（`ctx.agents`）抛
 * `cannot get property "agents" without inject` ⇒ `apply` 整体失败 ⇒ `remote.mud` 全部动词
 * 在网关 `claimsEndpoint` 判为未注册 ⇒ 建账号/建服务器一律 404。纯层用例不加载插件，全绿也漏出。
 *
 * 提供的 ctx **只给 `typert`**（唯一必需服务）：`agents` / `credentials` /
 * `sessionController` / `storageDomain` 全缺席 —— 装配层必须容忍（§2.3、§14.3）。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

const LIB = fileURLToPath(new URL('../lib/index.js', import.meta.url))

/** 构建产物缺席即跳过（先 `pnpm --filter mud-core3 build`）。 */
const built = existsSync(LIB) ? await import('../lib/index.js') : null

describe.skipIf(built === null)('装配层加载冒烟（lib 产物）', () => {
  it('宿主可选面全缺席时 apply 成功：引擎窄面与 remote.mud 命名空间都在册', async () => {
    if (built === null) throw new Error('缺少构建产物：先 pnpm --filter mud-core3 build')
    const ctx = new Context()
    // typert 注册表 = 唯一必需服务（inject）：占位实现即可（工件注册是旁路）。
    ctx.provide('typert', { register: () => () => {} })
    await ctx.plugin({ name: built.name, inject: [...built.inject], apply: built.apply })

    // 引擎窄面（工具面依赖；缺席 = 工具执行可读拒绝）。
    expect(ctx.get('mudCore3')).toBeDefined()
    // remote 面：命名空间在册，否则网关判未注册 → 全动词 404。
    const remote = ctx.get('mudRemote') as { typertRemote?: { namespace?: string } } | undefined
    expect(remote?.typertRemote?.namespace).toBe('mud')
  })
})
