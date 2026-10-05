/**
 * host/tools — 工具面纯层：mud_workflow_run + 流程管理四工具（list/get/save/delete）。
 *
 * **宿主适配层**（A1）：只做"宿主工具协议 ↔ 内核"的转译——工具定义/参数/render
 * 是宿主面，执行链把调用转给内核（解释器 + 注册表）。内核与契约都不认识宿主。
 *
 * 承 core3 工具面同款纪律：
 *   - **原文返回、模型自决**：run 返回现场行原文 + stage 前缀；管理工具返回
 *     可读文本/结构化 JSON（canonical JSON 走 output.schema 面）；
 *   - **注册期不依赖引擎**：deps.engine()/deps.core() 执行期解析，缺席时注册
 *     照常、执行给可读拒绝（I9）；
 *   - **拒绝全部可读**（返回 { ok:false, error } 让模型读、能转告用户；不 throw）；
 *   - 本层零宿主 import（宿主工具面以窄结构接口 ToolRegistrar 接入）；接线层
 *     host/preset.ts 负责解析 ctx。
 *
 * mud_workflow_run 的模型 API 不变（{ name } → { ok, stage, lines }）；
 * 执行链 = 归属解析（core3 缝）→ 注册表取流程 → core3 workflowIoFor 缝
 *（凭据解析 + 持有者 + IO 原语）→ 解释器 runFlow → release。
 *
 * 管理四工具是 agent 进化闭环的写手：save 过 schema + 结构 + 凭据红线三门
 *（registry.save），locked 拒改拒删；get 返回完整流程 JSON 供修缮。
 */

import { runFlow } from '../core/interpreter.ts'
import type { WorkflowRegistry } from '../core/registry.ts'
import type {
  CallerAgent, SnapshotReason, WorkflowIoSeam, WorkflowOrigin, WorkflowRecord,
} from '../contract/index.ts'

/** 文本内容块（宿主 `ContentBlock` 的最小可赋值形态：`render` 返回**可变**数组）。 */
export interface MudContentBlock {
  type: 'text'
  text: string
}

/**
 * 宿主 ToolDefinition 的窄结构（core3 tools.ts 同款面）。
 *
 * 与宿主真实形状对齐的两处（T17，曾在接线层被 `as unknown` 吃掉）：
 *   - `isConcurrencySafe` 是**谓词函数**`(args) => boolean`（不是 boolean 属性）——
 *     写 `false` 只因宿主 fail-closed 恰好得到"独占"，写 `true` 会被静默吞成独占；
 *   - `render` 返回**可变**数组（宿主 `ContentBlock[]`），`readonly` 不可赋值。
 * 接线层的编译期断言（`host/preset.ts`）钉住这两处。
 */
export interface MudToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 并发分类谓词：只有恰好返回 `true` 才并行；独占工具恒返回 `false`。 */
  isConcurrencySafe?(args: unknown): boolean
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): MudContentBlock[]
  }
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
}

/** 宿主注册面窄结构（对应宿主 `tools.register(ToolDefinition): () => void`）。 */
export interface ToolRegistrar {
  register(definition: MudToolDefinition): () => void
}

/** 流程注册表面（ctx.mudWorkflow 的本包消费面）。 */
export interface MudWorkflowEngine {
  readonly registry: WorkflowRegistry
}

/** 工具依赖（preset 行一次注入；执行期解析两个服务窄面）。 */
export interface MudWorkflowToolDeps {
  /** 流程引擎解析（执行期调用；null = 引擎缺席 ⇒ 可读拒绝）。 */
  engine: () => MudWorkflowEngine | null
  /** core3 缝解析（执行期调用；null = core3 缺席 ⇒ run 可读拒绝，管理工具不受影响）。 */
  core: () => WorkflowIoSeam | null
}

// ── 结果形态（canonical JSON 面）────────────────────────────────

export type WorkflowRunResult =
  | { ok: false; error: string }
  | { ok: true; stage: string; lines: string[] }
export type WorkflowListResult =
  | { ok: false; error: string }
  | {
    ok: true
    workflows: {
      name: string
      title: string
      locked: boolean
      version: number
      /** 生效来源（builtin = 随包内置；refined = agent 修缮/新建）。 */
      origin: WorkflowOrigin
      /** 是否有被 locked 内置遮蔽的同名修缮（可 delete 清理）。 */
      shadowed: boolean
    }[]
  }
export type WorkflowGetResult =
  | { ok: false; error: string }
  | { ok: true; record: WorkflowRecord }
export type WorkflowSaveResult =
  | { ok: false; error: string }
  | { ok: true; name: string; version: number; updatedAt: string }
export type WorkflowDeleteResult =
  | { ok: false; error: string }
  | { ok: true; deleted: boolean; lockedBuiltin: boolean }
export type WorkflowHistoryResult =
  | { ok: false; error: string }
  | {
    ok: true
    name: string
    versions: {
      version: number
      title: string
      updatedAt: string
      archivedAt: string
      reason: SnapshotReason
    }[]
  }
export type WorkflowRollbackResult =
  | { ok: false; error: string }
  | { ok: true; name: string; version: number; fromVersion: number }

/** 可读拒绝助手。 */
function reject(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** 引擎缺席时的可读拒绝（I9）。 */
export const ENGINE_ABSENT_ERROR = '已拒绝：mud-workflow 引擎服务缺席（ctx.mudWorkflow 未装配），工具仅注册未接线'

/** core3 缝缺席时的可读拒绝（run 需要 IO 原语；管理工具不受影响）。 */
export const CORE_ABSENT_ERROR = '已拒绝：mud-core3 引擎服务缺席（ctx.mudCore3 未装配），无法执行流程'

/** 归属未命中的可读拒绝。 */
export const NOT_BOUND_ERROR = '已拒绝：本会话未绑定 MUD 账号'

/** 管理工具共用的 output.schema 基座（ok/error 是所有管理工具的公共字段）。 */
const BASE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
  required: ['ok'],
} as const

/** 管理工具 output.schema：基座 + 该工具真实返回的字段（宿主会对成功值强制校验）。 */
function okSchema(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ...BASE_SCHEMA.properties, ...extra },
    required: BASE_SCHEMA.required,
  }
}

/** 独占谓词（宿主调度：恒 `false` ⇒ 与会话内其它调用串行，不劈半应答）。 */
const exclusive = (): boolean => false

// ── 工具注册 ────────────────────────────────────────────────────────

/**
 * 构建并注册五个流程工具（preset 行在 preset 作用域调用一次）。
 * 注册完整性自检：缺一即 fail-loud。返回注册 disposer 列表。
 */
export function registerMudWorkflowTools(
  registrar: ToolRegistrar,
  deps: MudWorkflowToolDeps,
): Array<() => void> {
  const engine = (): MudWorkflowEngine | null => deps.engine()

  const mudWorkflowRun: MudToolDefinition = {
    name: 'mud_workflow_run',
    description:
      '执行一个声明式流程（JSON 步骤表）：提示符驱动、发送、等待应答、按判据分类出口。'
      + '不做决策不重试，失败原样返回现场。用 mud_workflow_list 查可用流程。'
      + '凭据由系统解析注入，不出进程、不经你（结果行已脱敏）。需要已建立连接（可先 mud_connect）。',
    isConcurrencySafe: exclusive, // send + read 行流等待，独占（谓词恒 false）
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '流程名（mud_workflow_list 可查）' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          stage: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        // 模型面合同同 mud_send：原文/可读文本；stage 单行前缀 + 行原文。
        const v = value as WorkflowRunResult
        return [{ type: 'text', text: v.ok ? `[${v.stage}]\n${v.lines.join('\n')}` : v.error }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { name?: string }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      const c = deps.core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as CallerAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)
      const name = args.name
      if (name === undefined || name.trim() === '') {
        return reject('已拒绝：name 必填（mud_workflow_list 可查可用流程）')
      }
      const record = e.registry.get(name)
      if (record === undefined) {
        const known = e.registry.list().map(r => r.name).join('/') || '（空）'
        return reject(`已拒绝：流程 ${name} 不存在（可用：${known}）`)
      }
      const holder = `workflow:${name}`
      let handle: Awaited<ReturnType<WorkflowIoSeam['workflowIoFor']>> | null = null
      try {
        handle = await c.workflowIoFor(tc.sessionId, holder)
        // 宿主取消回合（B1③）：signal abort → cancel 句柄 → 验证码挂起 closed
        // 收束（流程走 timeout 出口，release 由 finally 保证）——「人走了」是
        // 正常路径，必须显式接。
        exec.signal.addEventListener('abort', () => { handle?.cancel?.() }, { once: true })
        const r = await runFlow(record, handle.io, handle.creds)
        return { ok: true, stage: r.stage, lines: r.lines }
      } catch (err) {
        return reject((err as Error).message)
      } finally {
        handle?.release()
      }
    },
  }

  const mudWorkflowList: MudToolDefinition = {
    name: 'mud_workflow_list',
    description:
      '列出可用流程（locked = 锁定不可改；内置 = 随包版本，修订 = 你改过的版本；'
      + 'version = 修订版本）。流程是可以一次调用执行的确定性步骤表，'
      + '改进流程 = 扩展你的能力。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: okSchema({ workflows: { type: 'array', items: { type: 'object' } } }),
      render: (_args, value) => {
        const v = value as WorkflowListResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        const rows = v.workflows.map(w =>
          `${w.name}${w.locked ? '（locked）' : ''} v${w.version} — ${w.title}`
          + `${w.origin === 'refined' ? '（修订）' : '（内置）'}`
          + `${w.shadowed ? '｜⚠ 有被 locked 内置遮蔽的修订（delete 可清理）' : ''}`,
        )
        return [{ type: 'text', text: rows.length === 0 ? '（暂无流程）' : rows.join('\n') }]
      },
    },
    async execute() {
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      return {
        ok: true,
        workflows: e.registry.entries().map(({ record, origin, shadowed }) => ({
          name: record.name,
          title: record.title,
          locked: record.locked,
          version: record.version,
          origin,
          shadowed: shadowed !== undefined,
        })),
      }
    },
  }

  const mudWorkflowGet: MudToolDefinition = {
    name: 'mud_workflow_get',
    description: '读一个流程的完整 JSON 步骤表（修缮前的现状）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '流程名' } },
      required: ['name'],
    },
    output: {
      schema: okSchema({ record: { type: 'object' } }),
      render: (_args, value) => {
        const v = value as WorkflowGetResult
        return [{ type: 'text', text: v.ok ? JSON.stringify(v.record.flow, null, 2) : v.error }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      const record = args.name === undefined ? undefined : e.registry.get(args.name)
      if (record === undefined) return reject(`已拒绝：流程 ${args.name ?? ''} 不存在`)
      return { ok: true, record }
    },
  }

  const mudWorkflowSave: MudToolDefinition = {
    name: 'mud_workflow_save',
    description:
      '保存流程（新建或修缮）：过 schema + 结构校验即生效。locked 流程拒改；'
      + 'sendCredential 凭据动词只允许锁定流程使用（会被拒绝）。'
      + '改进流程 = 一次调用即可让后续执行更准——先 mud_workflow_get 看现状再改。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '流程名（小写字母开头，[a-z0-9_-]）' },
        title: { type: 'string', description: '展示名' },
        flow: { type: 'object', description: '流程本体 { entry, steps[] }（mud_workflow_get 可参照现状）' },
      },
      required: ['name', 'title', 'flow'],
    },
    output: {
      schema: okSchema({
        name: { type: 'string' }, version: { type: 'integer' }, updatedAt: { type: 'string' },
      }),
      render: (_args, value) => {
        const v = value as WorkflowSaveResult
        return [{ type: 'text', text: v.ok ? `已保存：${v.name} v${v.version}` : v.error }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string; title?: string; flow?: unknown }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      if (args.name === undefined || args.title === undefined || args.flow === undefined) {
        return reject('已拒绝：name/title/flow 必填')
      }
      try {
        const record = await e.registry.save({
          name: args.name,
          title: args.title,
          flow: args.flow as Parameters<WorkflowRegistry['save']>[0]['flow'],
        })
        return { ok: true, name: record.name, version: record.version, updatedAt: record.updatedAt }
      } catch (err) {
        return reject((err as Error).message)
      }
    },
  }

  const mudWorkflowDelete: MudToolDefinition = {
    name: 'mud_workflow_delete',
    description:
      '删除流程的修订版本（非 locked 预制流程删除 = 还原为随包版本）。'
      + 'locked 内置本体拒删；被 locked 内置遮蔽的同名修订可删——删掉只是清掉遮蔽，'
      + '执行一直用的是内置版本。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '流程名' } },
      required: ['name'],
    },
    output: {
      schema: okSchema({ deleted: { type: 'boolean' }, lockedBuiltin: { type: 'boolean' } }),
      render: (_args, value) => {
        const v = value as WorkflowDeleteResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        if (!v.deleted) return [{ type: 'text', text: '无此流程的修缮版本' }]
        return [{
          type: 'text',
          text: v.lockedBuiltin ? '已删除被遮蔽的修订（locked 内置继续生效）' : '已删除',
        }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      if (args.name === undefined) return reject('已拒绝：name 必填')
      try {
        const deleted = await e.registry.delete(args.name)
        // 生效记录仍是 locked 内置 ⇒ deleted 只可能是「清掉了被遮蔽的同名修订」
        //（locked 本体在无修缮时 delete 已可读拒）。此处读注册表只为把结论装进
        // 返回值，render 保持纯投影（宿主 contract：render 是 args+value 的纯函数）。
        return { ok: true, deleted, lockedBuiltin: e.registry.get(args.name)?.locked === true }
      } catch (err) {
        return reject((err as Error).message)
      }
    },
  }

  const mudWorkflowHistory: MudToolDefinition = {
    name: 'mud_workflow_history',
    description:
      '读一个流程的历史版本（每次保存/删除都留档：版本号、时间与原因）。'
      + '配合 mud_workflow_get 看现状、mud_workflow_rollback 回滚到某个版本。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '流程名' } },
      required: ['name'],
    },
    output: {
      schema: okSchema({ name: { type: 'string' }, versions: { type: 'array', items: { type: 'object' } } }),
      render: (_args, value) => {
        const v = value as WorkflowHistoryResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        if (v.versions.length === 0) return [{ type: 'text', text: '（无历史版本）' }]
        const rows = v.versions.map(h =>
          `${v.name} v${h.version} — ${h.title}｜${h.reason}｜${h.archivedAt}`,
        )
        return [{ type: 'text', text: rows.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      if (args.name === undefined) return reject('已拒绝：name 必填')
      return {
        ok: true,
        name: args.name,
        versions: e.registry.history(args.name).map(h => ({
          version: h.version,
          title: h.title,
          updatedAt: h.updatedAt,
          archivedAt: h.archivedAt,
          reason: h.reason,
        })),
      }
    },
  }

  const mudWorkflowRollback: MudToolDefinition = {
    name: 'mud_workflow_rollback',
    description:
      '把流程回滚到某个历史版本（用该版本的步骤表**写一条新版本**，不改写历史）。'
      + 'locked 内置本体拒改；版本号先用 mud_workflow_history 查。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '流程名' },
        version: { type: 'integer', description: '目标历史版本号（mud_workflow_history 可查）' },
      },
      required: ['name', 'version'],
    },
    output: {
      schema: okSchema({
        name: { type: 'string' }, version: { type: 'integer' }, fromVersion: { type: 'integer' },
      }),
      render: (_args, value) => {
        const v = value as WorkflowRollbackResult
        return [{
          type: 'text',
          text: v.ok ? `已回滚：${v.name} v${v.fromVersion} → 新版本 v${v.version}` : v.error,
        }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string; version?: number }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      if (args.name === undefined) return reject('已拒绝：name 必填')
      if (args.version === undefined || !Number.isInteger(args.version)) {
        return reject('已拒绝：version 必填（历史版本号，mud_workflow_history 可查）')
      }
      try {
        const record = await e.registry.rollback(args.name, args.version)
        return { ok: true, name: record.name, version: record.version, fromVersion: args.version }
      } catch (err) {
        return reject((err as Error).message)
      }
    },
  }

  // 注册完整性自检：登记实际注册的工具名，注册后断言七工具全部过 registrar。
  const registered = new Set<string>()
  const recording: ToolRegistrar = {
    register: def => {
      registered.add(def.name)
      return registrar.register(def)
    },
  }
  const definitions = [
    mudWorkflowRun, mudWorkflowList, mudWorkflowGet, mudWorkflowSave, mudWorkflowDelete,
    mudWorkflowHistory, mudWorkflowRollback,
  ]
  const disposers = definitions.map(def => recording.register(def))
  const missing = definitions.map(def => def.name).filter(n => !registered.has(n))
  if (missing.length > 0) throw new Error(`mud-workflow 注册完整性自检失败：本层未注册 ${missing.join('/')}`)
  return disposers
}
