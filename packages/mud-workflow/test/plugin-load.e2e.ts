/**
 * plugin-load — 工件面加载冒烟（T17；对齐 core3 `test/plugin-load.e2e.ts` 的纪律）。
 *
 * 导入**构建产物**（`lib/index.js` / `lib/preset.js`——宿主 overlay patch 按绝对
 * 路径加载的就是这两个文件），断言插件面形状、`mudWorkflow` 服务面在册、七工具
 * 全部过宿主注册面（含谓词与 `output.schema` 面）。缺产物**自动跳过**（先 build）。
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ENGINE = new URL('../lib/index.js', import.meta.url)
const PRESET = new URL('../lib/preset.js', import.meta.url)

/** 工具定义的最小断言面（工件面用例只读，不 import 源码类型）。 */
interface LoadedTool {
  readonly name: string
  readonly isConcurrencySafe?: (args: unknown) => boolean
  readonly output: {
    readonly schema: { readonly type?: string; readonly properties?: Record<string, unknown> }
  }
}

/** 最小 fake ctx：只提供两个插件入口装配时用到的面。 */
function fakeCtx(): {
  ctx: Record<string, unknown>
  provided: Map<string, unknown>
  defs: Map<string, LoadedTool>
} {
  const provided = new Map<string, unknown>()
  const defs = new Map<string, LoadedTool>()
  return {
    provided,
    defs,
    ctx: {
      logger: { info: () => {}, warn: () => {} },
      get: () => undefined,
      inject: () => {},
      provide: (key: string, value: unknown) => { provided.set(key, value) },
      tools: {
        register: (def: LoadedTool) => { defs.set(def.name, def); return () => {} },
      },
    },
  }
}

describe.skipIf(!existsSync(ENGINE) || !existsSync(PRESET))('工件面加载冒烟（T17）', () => {
  it('引擎入口：name/inject/apply 形状 + 装配即提供 mudWorkflow 服务面', async () => {
    const engine = await import(ENGINE.href) as {
      name: string
      inject: string[]
      apply: (ctx: unknown) => void
    }
    expect(engine.name).toBe('mud-workflow')
    expect(Array.isArray(engine.inject)).toBe(true)

    const f = fakeCtx()
    expect(() => engine.apply(f.ctx)).not.toThrow()
    const service = f.provided.get('mudWorkflow') as { registry: { list(): unknown[] } }
    expect(service.registry.list()).toEqual([]) // core3 缺席 ⇒ 空注册表（可读拒绝路径）
  })

  it('preset 入口：七工具过宿主注册面，谓词与 output.schema 面齐备', async () => {
    const preset = await import(PRESET.href) as {
      name: string
      inject: string[]
      apply: (ctx: unknown) => void
    }
    expect(preset.name).toBe('mud-workflow-preset')
    expect(preset.inject).toContain('tools')

    const f = fakeCtx()
    expect(() => preset.apply(f.ctx)).not.toThrow()
    expect([...f.defs.keys()].sort()).toEqual([
      'mud_workflow_delete', 'mud_workflow_get', 'mud_workflow_history', 'mud_workflow_list',
      'mud_workflow_rollback', 'mud_workflow_run', 'mud_workflow_save',
    ])

    // 调度谓词面：`mud_workflow_run` 是函数（不是 boolean 属性），且恒 false（独占）
    const run = f.defs.get('mud_workflow_run')!
    expect(typeof run.isConcurrencySafe).toBe('function')
    expect(run.isConcurrencySafe?.({})).toBe(false)

    // output.schema 面：每个工具都声明了对象根与至少一个真实字段（宿主强制校验该值）
    for (const [name, def] of f.defs) {
      expect(def.output.schema.type, name).toBe('object')
      expect(Object.keys(def.output.schema.properties ?? {}).length, name).toBeGreaterThan(0)
    }
  })
})
