/**
 * mud-workflow — 宿主插件入口（cordis 插件，引擎作用域）。
 *
 * 声明式流程子包（与 mud-core3 并列）：**纯架构**——流程本体 = JSON 步骤表
 *（schema.ts），注册表（registry.ts，locked 预制 + agent 修缮），解释器与工具
 * 面。**不含任何具体流程实体**（2026-10-01 裁定：数据归 core3——core3 经
 * `builtinFlows` 提供流程实体，本插件启动期挂载进注册表，fail-loud 校验）。
 * 挂载即提供 `mudWorkflow` 服务面（注册表 + 流程工具面）。
 *
 * 双态挂载承 core3 名册同型：core3 服务就绪前注册表为空（工具执行给可读拒绝），
 * 就绪（immediate 或 inject 回调）后 registerBuiltins 挂载；agent 修缮层不受
 * 挂载影响。storage 域同款双态（就绪前内存先行，域挂上后迁入）。
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包构建产物 lib/index.js。
 *
 * @module mud-workflow
 */

import type { Context } from '@deepseek-ai/cordis'

import { WorkflowRegistry, mudWorkflowDomainSpec, type HostTable } from './registry.ts'
import type { WorkflowRecord } from './schema.ts'

/** 插件名。 */
export const name = 'mud-workflow'

// 词汇表类型出口（core3 流程实体按此类型书写；type-only，无运行时依赖）。
export type { Flow, WorkflowRecord } from './schema.ts'

/** 必需服务：无（storage 域为可选依赖，就绪前内存先行）。 */
export const inject: string[] = []

/** 插件配置。 */
export interface MudWorkflowConfig {
  /** 是否挂宿主 storage 域持久化 agent 修缮（缺省 true；域不可用降级内存并告警）。 */
  workflowStorage?: boolean
  /** 预制流程覆盖（测试注入用；缺省 []——宿主运行时由 core3 builtinFlows 挂载）。 */
  builtins?: readonly WorkflowRecord[]
}

/** `ctx.provide('mudWorkflow', ...)` 的服务面（挂载即提供；工具层消费）。 */
export interface MudWorkflowService {
  readonly registry: WorkflowRegistry
}

/** 宿主 storage 域的最小面（`ctx.storageDomain` 结构化子集，同 core3）。 */
interface HostStorageDomain {
  open(spec: unknown): Promise<{
    table(name: string): HostTable<unknown>
  }>
}

/**
 * 从 ctx 取宿主 storage 域；面不存在/形状不符返回 undefined。
 * @param ctx - 插件上下文。
 */
function hostStorageDomain(ctx: Context): HostStorageDomain | undefined {
  const candidate: unknown = ctx.get('storageDomain')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const open = (candidate as { open?: unknown }).open
  if (typeof open !== 'function') return undefined
  return candidate as HostStorageDomain
}

/** 打开流程域表并挂上注册表（失败 warn 点名退内存——原因必须可见）。 */
async function attachDomain(
  ctx: Context,
  registry: WorkflowRegistry,
  domain: HostStorageDomain,
): Promise<void> {
  try {
    const opened = await domain.open(mudWorkflowDomainSpec)
    await registry.attachDomain(opened.table('workflows') as HostTable<WorkflowRecord>)
    ctx.logger.info(`mud-workflow: 流程已挂 storage 域（${registry.list().length} 条）`)
  } catch (error: unknown) {
    ctx.logger.warn(`mud-workflow: storage 域打开失败，流程退回内存（重启丢 agent 修缮）: ${String(error)}`)
  }
}

/** 宿主插件装配。 */
export function apply(ctx: Context, config: MudWorkflowConfig = {}): void {
  const registry = new WorkflowRegistry(config.builtins ?? [])

  // ── 流程实体挂载（数据归 core3，2026-10-01 裁定）──────────────
  // core3 服务就绪前注册表为空；就绪（immediate 或 inject 回调）后把
  // core3.builtinFlows 挂进注册表（registerBuiltins fail-loud 校验）。双执行
  // 无害（幂等覆盖同名校验过的预制）。窄结构代位读（本包零 core3 import）。
  const attachBuiltins = (core: unknown): void => {
    const flows = (core as { builtinFlows?: unknown }).builtinFlows
    if (!Array.isArray(flows) || flows.length === 0) return
    registry.registerBuiltins(flows as readonly WorkflowRecord[])
    ctx.logger.info(`mud-workflow: 已挂载 core3 流程实体（${flows.length} 条）`)
  }
  const immediateCore: unknown = ctx.get('mudCore3')
  if (immediateCore !== undefined && immediateCore !== null) {
    attachBuiltins(immediateCore)
  } else {
    ctx.inject(['mudCore3'], (injected: Context) => {
      const core: unknown = injected.get('mudCore3')
      if (core !== undefined && core !== null) attachBuiltins(core)
    })
  }

  if (config.workflowStorage !== false) {
    // 时序真相（core3 名册同型）：storage-domain 的 provide 发生在其异步装配
    // 之后，apply 期同步 get 拿到 undefined——内存先行，域就绪（inject 回调）后
    // 挂域迁入。
    const immediate = hostStorageDomain(ctx)
    if (immediate !== undefined) {
      void attachDomain(ctx, registry, immediate)
    } else {
      ctx.logger.warn('mud-workflow: storage 域尚未就绪，流程暂以内存运行（域就绪后自动挂载）')
      ctx.inject(['storageDomain'], (injected: Context) => {
        const domain = hostStorageDomain(injected)
        if (domain !== undefined) void attachDomain(ctx, registry, domain)
      })
    }
  }

  ctx.provide('mudWorkflow', { registry } satisfies MudWorkflowService)
}
