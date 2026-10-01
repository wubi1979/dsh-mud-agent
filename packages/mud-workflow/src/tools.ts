/**
 * tools — 工具面纯层：mud_workflow_run + 流程管理四工具（list/get/save/delete）。
 *
 * 承 core3 工具面同款纪律：
 *   - **原文返回、模型自决**：run 返回现场行原文 + stage 前缀；管理工具返回
 *     可读文本/结构化 JSON（canonical JSON 走 output.schema 面）；
 *   - **注册期不依赖引擎**：deps.engine()/deps.core() 执行期解析，缺席时注册
 *     照常、执行给可读拒绝（I9）；
 *   - **拒绝全部可读**（返回 { ok:false, error } 让模型读、能转告用户；不 throw）；
 *   - 本层零宿主 import；接线层 preset.ts 经注入窄结构接口（ToolRegistrar）注册。
 *
 * mud_workflow_run 的模型 API 与 core3 T3 版本不变（{ name } → { ok, stage, lines }）；
 * 执行链 = 归属解析（core3 toolContextFor）→ 注册表取流程 → core3 envFor 缝
 *（凭据解析 + 持有者 + env 原语）→ 解释器 runFlow → release。
 *
 * 管理四工具是 agent 进化闭环的写手：save 过 schema + 结构 + 凭据红线三门
 *（registry.save），locked 拒改拒删；get 返回完整流程 JSON 供修缮。
 */

import { runFlow } from './interpreter.ts'
import type { WorkflowRegistry } from './registry.ts'
import type { WorkflowRecord } from './schema.ts'
import type { WorkflowCredentials, WorkflowEnv } from './env.ts'

/** 宿主 ToolDefinition 的窄结构（core3 tools.ts 同款面）。 */
export interface MudToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 独占调度（send + 行流等待的工具设 false）。 */
  isConcurrencySafe?: boolean
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly { type: 'text'; text: string }[]
  }
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
}

/** 宿主注册面窄结构（对应宿主 `tools.register(ToolDefinition): () => void`）。 */
export interface ToolRegistrar {
  register(definition: MudToolDefinition): () => void
}

/** 调用期 agent 窄结构（工具层只透传不解释）。 */
export interface ToolAgent {
  readonly id: unknown
}

/**
 * core3 引擎缝（ctx.mudCore3 的本包消费面）：归属解析 + envFor。
 * envFor 由 core3 接线提供（凭据解析 + 持有者独占 + env 原语 + release）。
 */
export interface MudWorkflowCore {
  toolContextFor(agent: ToolAgent | undefined): { sessionId: string } | null
  workflowEnvFor(sessionId: string, holder: string): Promise<{
    env: WorkflowEnv
    creds: WorkflowCredentials
    release(): void
  }>
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
  core: () => MudWorkflowCore | null
}

// ── 结果形态（canonical JSON 面）────────────────────────────────

export type WorkflowRunResult =
  | { ok: false; error: string }
  | { ok: true; stage: string; lines: string[] }
export type WorkflowListResult =
  | { ok: false; error: string }
  | { ok: true; workflows: { name: string; title: string; locked: boolean; version: number }[] }
export type WorkflowGetResult =
  | { ok: false; error: string }
  | { ok: true; record: WorkflowRecord }
export type WorkflowSaveResult =
  | { ok: false; error: string }
  | { ok: true; name: string; version: number; updatedAt: string }
export type WorkflowDeleteResult =
  | { ok: false; error: string }
  | { ok: true; deleted: boolean }

/** 可读拒绝助手。 */
function reject(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** 引擎缺席时的可读拒绝（I9）。 */
export const ENGINE_ABSENT_ERROR = '已拒绝：mud-workflow 引擎服务缺席（ctx.mudWorkflow 未装配），工具仅注册未接线'

/** core3 缝缺席时的可读拒绝（run 需要 env 原语；管理工具不受影响）。 */
export const CORE_ABSENT_ERROR = '已拒绝：mud-core3 引擎服务缺席（ctx.mudCore3 未装配），无法执行流程'

/** 归属未命中的可读拒绝。 */
export const NOT_BOUND_ERROR = '已拒绝：本会话未绑定 MUD 账号'

/** 管理工具共用的 output.schema（ok/error/workflows|record…）。 */
const BASE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
  required: ['ok'],
} as const

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
    isConcurrencySafe: false, // send + read 行流等待，独占
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
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
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
      let handle: Awaited<ReturnType<MudWorkflowCore['workflowEnvFor']>> | null = null
      try {
        handle = await c.workflowEnvFor(tc.sessionId, holder)
        const r = await runFlow(record, handle.env, handle.creds)
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
      '列出可用流程（locked = 锁定不可改；version = 修缮版本）。'
      + '流程是可以一次调用执行的确定性步骤表，改进流程 = 扩展你的能力。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: BASE_SCHEMA,
      render: (_args, value) => {
        const v = value as WorkflowListResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        const rows = v.workflows.map(w =>
          `${w.name}${w.locked ? '（locked）' : ''} v${w.version} — ${w.title}`,
        )
        return [{ type: 'text', text: rows.length === 0 ? '（暂无流程）' : rows.join('\n') }]
      },
    },
    async execute() {
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      return {
        ok: true,
        workflows: e.registry.list().map(r => ({
          name: r.name, title: r.title, locked: r.locked, version: r.version,
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
      schema: BASE_SCHEMA,
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
      schema: BASE_SCHEMA,
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
    description: '删除流程（locked 拒删；预制流程删除 = 还原为随包版本）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '流程名' } },
      required: ['name'],
    },
    output: {
      schema: BASE_SCHEMA,
      render: (_args, value) => {
        const v = value as WorkflowDeleteResult
        return [{ type: 'text', text: v.ok ? (v.deleted ? '已删除' : '无此流程的修缮版本') : v.error }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { name?: string }
      const e = engine()
      if (e === null) return reject(ENGINE_ABSENT_ERROR)
      if (args.name === undefined) return reject('已拒绝：name 必填')
      try {
        return { ok: true, deleted: await e.registry.delete(args.name) }
      } catch (err) {
        return reject((err as Error).message)
      }
    },
  }

  // 注册完整性自检：登记实际注册的工具名，注册后断言五工具全部过 registrar。
  const registered = new Set<string>()
  const recording: ToolRegistrar = {
    register: def => {
      registered.add(def.name)
      return registrar.register(def)
    },
  }
  const definitions = [mudWorkflowRun, mudWorkflowList, mudWorkflowGet, mudWorkflowSave, mudWorkflowDelete]
  const disposers = definitions.map(def => recording.register(def))
  const missing = definitions.map(def => def.name).filter(n => !registered.has(n))
  if (missing.length > 0) throw new Error(`mud-workflow 注册完整性自检失败：本层未注册 ${missing.join('/')}`)
  return disposers
}
