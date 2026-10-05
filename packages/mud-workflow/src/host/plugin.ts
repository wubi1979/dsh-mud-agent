/**
 * host/plugin — mud-workflow 宿主插件装配（cordis 插件，引擎作用域）。
 *
 * **宿主适配层**（A1）：把内核（core）与契约（contract）接到宿主——
 * 读 `ctx.mudCore3.builtinFlows` 挂预制、开 storage 域挂修缮层、provide
 * `mudWorkflow` 服务面。本层是唯一认识 cordis 的地方。
 *
 * 声明式流程子包（与 mud-core3 并列）：**纯架构**——流程本体 = JSON 步骤表
 *（contract/schema），注册表（core/registry，locked 预制 + agent 修缮），
 * 解释器（core/interpreter）与工具面（host/tools）。**不含任何具体流程实体**
 *（2026-10-01 裁定：数据归 core3——core3 经 `builtinFlows` 提供流程实体，本插件
 * 启动期挂载进注册表，fail-loud 校验）。
 *
 * 双态挂载承 core3 名册同型：core3 服务就绪前注册表为空（工具执行给可读拒绝），
 * 就绪（immediate 或 inject 回调）后 registerBuiltins 挂载；agent 修缮层不受
 * 挂载影响。storage 域同款双态（就绪前内存先行，域挂上后迁入）。
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包构建产物 lib/index.js
 *（根入口薄壳 → 本文件）。
 *
 * @module mud-workflow/host
 */

import type { Context } from '@deepseek-ai/cordis'

import { WorkflowRegistry } from '../core/registry.ts'
import {
  mudWorkflowDomainSpec,
  type HostStorageDomain, type HostTable, type WorkflowRecord, type WorkflowSnapshot,
} from '../contract/index.ts'

/** 插件名。 */
export const name = 'mud-workflow'

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
    const report = await registry.attachDomain({
      workflows: opened.table('workflows') as HostTable<WorkflowRecord>,
      snapshots: opened.table('snapshots') as HostTable<WorkflowSnapshot>,
    })
    ctx.logger.info(
      `mud-workflow: 流程已挂 storage 域（${registry.list().length} 条；迁入 ${report.migrated} 条、账本 ${report.snapshots} 条）`,
    )
    // 取新点名（T16）：域内版本更高时内存期修缮不覆盖域，而是归档为 migration 快照。
    if (report.superseded > 0) {
      ctx.logger.warn(
        'mud-workflow: 以下内存期修缮因域内版本更高被取新（已归档为 migration 快照，未覆盖域内记录）：'
        + report.supersededNames.join('、'),
      )
    }
  } catch (error: unknown) {
    ctx.logger.warn(`mud-workflow: storage 域打开/迁入失败，流程退回内存（重启丢 agent 修缮）: ${String(error)}`)
  }
}

/** 宿主插件装配。 */
export function apply(ctx: Context, config: MudWorkflowConfig = {}): void {
  const registry = new WorkflowRegistry(config.builtins ?? [])

  // ── 流程实体挂载（数据归 core3，2026-10-01 裁定）──────────────
  // core3 服务就绪前注册表为空；就绪（immediate 或 inject 回调）后把
  // core3.builtinFlows 挂进注册表（registerBuiltins fail-loud 校验）。双执行
  // 无害（幂等覆盖同名校验过的预制）。窄结构代位读（本包零 core3 运行时依赖；
  // 类型面由契约 WorkflowIoSeam 单点声明，core3 侧编译期断言）。
  const attachBuiltins = (core: unknown): void => {
    const flows = (core as { builtinFlows?: unknown }).builtinFlows
    if (!Array.isArray(flows) || flows.length === 0) return
    registry.registerBuiltins(flows as readonly WorkflowRecord[])
    ctx.logger.info(`mud-workflow: 已挂载 core3 流程实体（${flows.length} 条）`)
    // 冲突点名（策略 A：locked 内置优先 ⇒ 同名修订降级 shadowed，必须可见）。
    const shadowed = registry.entries().filter(entry => entry.shadowed !== undefined)
    if (shadowed.length > 0) {
      ctx.logger.warn(
        'mud-workflow: 以下 agent 修订被 locked 内置遮蔽（内置优先生效，'
        + `可用 mud_workflow_delete 清理）：${shadowed.map(e => `${e.record.name}（修订 v${e.shadowed?.version}）`).join('、')}`,
      )
    }
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
