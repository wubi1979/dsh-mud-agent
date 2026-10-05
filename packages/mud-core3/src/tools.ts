/**
 * tools — 工具面纯层（三期 T2b 三工具）：mud_connect / mud_send / mud_state。
 *
 * 三工具一个原则：**原文返回、模型自决**——mud_send 返回应答行原文（过程即
 * 结果）；mud_connect 只建连（登录归流程面）；mud_state 返回插件状态 + world
 * 合并快照。mud_workflow_run 及流程管理工具在 mud-workflow 子包（独立 preset
 * 行），本包只通过引擎窄面 workflowIoFor 提供流程 IO 缝。
 *
 * 三期语义（PLAN「T2 范围裁定」，跳过 admit 闸门中间态）：
 *   - mud_connect：只建连不登录（T3 盲发退役，登录由流程面 login 执行）；
 *     幂等（已连接直接成功，不重连、不踢已登录会话）；模型可自行调用；
 *   - mud_send：**只对「未连接」设限**（不受接入闸门、不要求已登录——是否已
 *     登录由模型自行判断）；禁发表最小集 {suicide} **全段扫描**（堵
 *     "look;suicide" 绕过洞）先行于闸门/连接；会话级持有者独占 send+read，
 *     冲突可读拒绝不劈半应答；
 *   - mud_state：不受闸门/连接约束，只过归属（模型要能答"我未接入"）。
 *
 * 归属解析（PLAN 三期「归属解析」）在引擎窄面 toolContextFor：从调用方会话沿
 * 父链上溯查名册。不开 `mud_send({ sessionId })` 参数，避免跨账号后门。
 *
 * 拒绝全部**可读**（返回 { ok:false, error } 让模型读、能转告用户；不 throw）。
 *
 * 本层零宿主 import；接线层 preset.ts 经注入窄结构接口（ToolRegistrar）注册，
 * 执行期 deps.core() 解析引擎窄面——引擎缺席时注册照常、执行给可读拒绝（I9）。
 */

import type { SessionRuntime } from './runtime.ts'
import type { ReadOpts } from './read.ts'
import type { ConnState } from './roster.ts'
import type { LoggedInState, WorldSnapshot } from './world.ts'
import type { MudLine } from './link/line.ts'
import type { WorkflowIoSeam } from 'mud-workflow/contract'

/**
 * 宿主 ToolDefinition 的窄结构（本包只用到的面；T17 与宿主真实形状对齐）：
 * `isConcurrencySafe` 是**谓词函数**`(args) => boolean`（不是 boolean 属性——写
 * `false` 只因宿主 fail-closed 恰好得到"独占"），`render` 返回**可变**数组
 * （宿主 `ContentBlock[]`）。漂移由 preset 接线层的编译期断言钉住。
 */
export interface MudToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 并发分类谓词：只有恰好返回 `true` 才并行；独占工具恒返回 `false`。 */
  isConcurrencySafe?(args: unknown): boolean
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): { type: 'text'; text: string }[]
  }
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
}

/** 宿主注册面窄结构（对应宿主 `tools.register(ToolDefinition): () => void`）。 */
export interface ToolRegistrar {
  register(definition: MudToolDefinition): () => void
}

/** 调用期 agent 窄结构（宿主 ToolExecutionInput.agent 的本包消费面）；工具层只透传不解释。 */
export interface ToolAgent {
  readonly id: unknown
}

/** mud_state 状态快照（插件状态 + world 合并）。 */
export interface MudStateSnapshot {
  /** 传输轴。 */
  connState: ConnState
  /** 登录轴（GMCP 权威信号；断线复位 unknown）。 */
  loggedIn: LoggedInState
  /** 接入闸门状态（MUD 信息是否进入 agent 投递通路）。 */
  admitted: boolean
  /** 世界状态（GMCP 写入；断线复位）。 */
  world: WorldSnapshot
  /** 录制缓冲当前行数。 */
  recording: number
  /** 因超出录制上限被丢弃的累计行数。 */
  dropped: number
}

/**
 * 引擎窄面（index.ts `ctx.provide('mudCore3', …)` 暴露；preset 行执行期
 * `ctx.get('mudCore3')` 解析，缺席 = null ⇒ 执行可读拒绝，I9）。
 *
 * **契约化（A1）**：extends `WorkflowIoSeam<MudLine>`——流程缝端口（归属解析 +
 * `workflowIoFor`）的类型单点定义在 mud-workflow 契约层，本接口只补本包自有的
 * 更宽面（含 runtime 的归属结果、connect、stateOf、defaults）。因此
 * index.ts 的 `satisfies MudCore3Service` 同时就是"本实现满足流程契约"的
 * 编译期断言，不再靠"双侧同形"的人工纪律。
 */
export interface MudCore3Handle extends WorkflowIoSeam<MudLine> {
  /** 归属解析（父链上溯查名册）；未绑定返回 null。 */
  toolContextFor(agent: ToolAgent | undefined): { sessionId: string; runtime: SessionRuntime } | null
  /** 建连 + login（幂等；失败 throw 可读错 → 工具层转可读拒绝）。 */
  connect(sessionId: string): Promise<{ state: string }>
  /** 状态快照（插件状态 + world 合并）。 */
  stateOf(sessionId: string): MudStateSnapshot
  /** mud_send 缺省参数。 */
  readonly defaults: { readonly sendTimeoutMs: number; readonly sendMaxLines: number }
}

/** 工具依赖（preset 行一次注入；执行期解析引擎窄面）。 */
export interface MudToolDeps {
  /** 引擎窄面解析（执行期调用；null = 引擎缺席 ⇒ 可读拒绝，注册不受影响）。 */
  core: () => MudCore3Handle | null
}

// ── 禁发表（最小集 + 全段扫描，§12.3）──────────────────────────

/** 禁发表词（不可逆命令；写死常量——实证发现新危险命令按 I5 逐行加回）。 */
const DENY_HEADS: ReadonlySet<string> = new Set([
  'suicide', // 删除人物档案，不可逆，任何正常玩法都不需要
])

/** 命令全段 token（小写；按空白/分号切分）。 */
export function commandTokens(cmd: string): string[] {
  return cmd.trim().toLowerCase().split(/[\s;]+/).filter(t => t !== '')
}

/** 禁发表命中（全段扫描：任一 token 命中即拒）；返回命中词，未命中返回 null。 */
export function denyMatch(cmd: string): string | null {
  for (const token of commandTokens(cmd)) {
    if (DENY_HEADS.has(token)) return token
  }
  return null
}

// ── listen 编译（模型给字符串正则，工具层编译校验）────────────────────

/** listen 判据（模型面形态：字符串正则源）。 */
export interface ListenSpec {
  until?: string[]
  failOn?: string[]
  gaCount?: number
  quietMs?: number
  maxLines?: number
}

/** mud_send listen 可编译面（ReadOpts 的判据子集）。 */
type ListenOpts = Partial<Pick<ReadOpts, 'until' | 'failOn' | 'gaCount' | 'quietMs' | 'maxLines'>>

function compileRegexes(sources: string[] | undefined, what: string): RegExp[] | undefined {
  if (sources === undefined || sources.length === 0) return undefined
  return sources.map((src) => {
    try {
      return new RegExp(src)
    } catch (e) {
      throw new Error(`已拒绝：${what} 正则非法: ${src}（${(e as Error).message}）`)
    }
  })
}

/** 编译 listen；全空 = {}（调用方按有/无 cmd 填缺省判据）。非法正则 throw 可读错。 */
export function compileListen(spec: ListenSpec | undefined): ListenOpts {
  if (spec === undefined) return {}
  const until = compileRegexes(spec.until, 'listen.until')
  const failOn = compileRegexes(spec.failOn, 'listen.failOn')
  // 条件展开组装（exactOptionalPropertyTypes：可选字段不收显式 undefined）。
  const out: ListenOpts = {
    ...(until !== undefined ? { until } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(spec.gaCount !== undefined ? { gaCount: spec.gaCount } : {}),
    ...(spec.quietMs !== undefined ? { quietMs: spec.quietMs } : {}),
    ...(spec.maxLines !== undefined ? { maxLines: spec.maxLines } : {}),
  }
  return out
}

// ── 常量与可读拒绝文案 ───────────────────────────────────────────────

/** mud_send 总超时上限（工具参数钳制；宿主注册期 timeoutMs 同值）。 */
export const MAX_TIMEOUT_MS = 60000

/** 裸读短静默窗口毫秒（收正在到达的尾巴；硬编码，无例证不进 Config）。 */
const BARE_READ_QUIET_MS = 300

/** 引擎缺席时的可读拒绝（I9：不是必然失败的桩，注册照常、执行明确说明）。 */
export const CORE_ABSENT_ERROR = '已拒绝：mud-core3 引擎服务缺席（ctx.mudCore3 未装配），工具仅注册未接线'

/** 归属未命中的可读拒绝。 */
export const NOT_BOUND_ERROR = '已拒绝：本会话未绑定 MUD 账号'

/** 未连接的可读拒绝（三期唯一连接约束；指引 mud_connect）。 */
export const NOT_CONNECTED_ERROR = '已拒绝：未连接，无法发送命令。可先调用 mud_connect 建连（已连接时幂等成功）'

/** 会话级持有者冲突的可读拒绝（应答不劈半）。 */
export const HOLDER_BUSY_ERROR = '已拒绝：另一执行体正在发送命令或等待应答（会话级独占），请稍后重试'

/** 工具执行体返回形态（canonical JSON）。 */
export type MudConnectResult =
  | { ok: false; error: string }
  | { ok: true; state: string }
export type MudSendResult =
  | { ok: false; error: string }
  | { ok: true; reason: string; lines: string[] }
export type MudStateResult =
  | { ok: false; error: string }
  | { ok: true; state: MudStateSnapshot }

/** 可读拒绝助手。 */
function reject(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

// ── 工具注册 ────────────────────────────────────────────────────────

/**
 * 构建并注册三个 mud 工具（preset 行在 preset 作用域调用一次；注册期不依赖
 * 引擎，执行期经 deps.core() 解析引擎窄面）。
 *
 * 注册完整性自检：登记本层经 registrar 实际注册的工具名，缺一即 fail-loud。
 * 返回注册 disposer 列表（由 preset 作用域容器持有，随作用域释放自动执行）。
 */
export function registerMudTools(
  registrar: ToolRegistrar,
  deps: MudToolDeps,
): Array<() => void> {
  const core = (): MudCore3Handle | null => deps.core()

  const mudConnect: MudToolDefinition = {
    name: 'mud_connect',
    description:
      '建立与 MUD 服务器的连接（只建连，不登录；幂等：已连接时直接成功，不重连、'
      + '不踢已登录会话）。登录请随后调用 mud_workflow_run { name: "login" }。'
      + '连接失败时返回可读原因。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, state: { type: 'string' }, error: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => {
        const v = value as MudConnectResult
        return [{ type: 'text', text: v.ok ? `已连接（${v.state}）` : v.error }]
      },
    },
    async execute(_rawArgs, exec) {
      const c = core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)
      try {
        const r = await c.connect(tc.sessionId)
        return { ok: true, state: r.state }
      } catch (e) {
        return reject(`连接失败：${(e as Error).message}`)
      }
    },
  }

  const mudSend: MudToolDefinition = {
    name: 'mud_send',
    description:
      '向 MUD 发送一条命令并等待应答原文（有 cmd = send + read；无 cmd = 裸读近期行流近况）。'
      + '未连接时被拒绝，可先调用 mud_connect。listen 声明完成判据（缺省等一段完整文字）；'
      + '必须给超时或缺省由系统注入（绝不无界等待）。返回应答行原文，由你自决下一步。',
    isConcurrencySafe: () => false, // socket 写 + 行流等待，独占（谓词恒 false）
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要发送的命令；缺省 = 裸读（不发命令，读近期行流）' },
        listen: {
          type: 'object',
          description: '完成判据（缺省：有 cmd = 一段完整文字；裸读 = 最近行 + 短静默窗口）',
          properties: {
            until: { type: 'array', items: { type: 'string' }, description: '完成判据正则（在累积应答文本上测，可跨批命中）' },
            failOn: { type: 'array', items: { type: 'string' }, description: '负面判据正则（命中即失败收束）' },
            gaCount: { type: 'integer', minimum: 1, description: 'GA/EOR 边界计数关窗' },
            quietMs: { type: 'integer', minimum: 1, description: '行间静默毫秒（最后一次行到达后静默即收）' },
            maxLines: { type: 'integer', minimum: 1, description: '行数兜底' },
          },
        },
        timeoutMs: { type: 'integer', minimum: 1, description: '总超时毫秒；缺省由系统注入' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        // 模型面合同：原文/可读文本，不让模型读 JSON（canonical JSON 只走
        // output.schema/持久化面）。
        const v = value as MudSendResult
        return [{ type: 'text', text: v.ok ? v.lines.join('\n') : v.error }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { cmd?: string; listen?: ListenSpec; timeoutMs?: number }
      const c = core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)

      // 禁发表先于闸门/连接（安全面最高优先；全段扫描）。
      if (args.cmd !== undefined) {
        const hit = denyMatch(args.cmd)
        if (hit !== null) return reject(`拒绝执行：危险命令（${hit}）被禁（不可逆）`)
      }

      // 只对「未连接」设限（三期裁定：不受接入闸门、不要求已登录）。
      // 探测中（probeState=probing）仍按已连接放行——probeState 是只读观测面，
      // 不回写 conn 三态（T5.1），TCP 确实通，发送/等待语义不受探测影响。
      if (tc.runtime.connState !== 'connected') return reject(NOT_CONNECTED_ERROR)

      // timeoutMs 钳制（§8.7）：缺省注入，上限 MAX_TIMEOUT_MS。
      let timeoutMs: number
      if (args.timeoutMs !== undefined) {
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
          return reject('已拒绝：timeoutMs 必须为正整数')
        }
        timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS)
      } else {
        timeoutMs = Math.min(c.defaults.sendTimeoutMs, MAX_TIMEOUT_MS)
      }

      // listen 编译（非法正则 → 可读拒绝，不 throw）。
      let listen: ListenOpts
      try {
        listen = compileListen(args.listen)
      } catch (e) {
        return reject((e as Error).message)
      }

      // 会话级持有者：同一时刻只允许一个执行体在 send+read（冲突可读拒绝，不劈半）。
      const holder = String((exec.agent as ToolAgent | undefined)?.id ?? '')
      if (!tc.runtime.acquireSend(holder)) return reject(HOLDER_BUSY_ERROR)
      try {
        const bare = args.cmd === undefined
        if (args.cmd !== undefined && !tc.runtime.send(args.cmd)) {
          return reject('已拒绝：发送失败（连接可能已断开）')
        }
        // initial：有 cmd = 空（acc 只收 send 后新行）；裸读 = pending 尾部快照
        //（不物理消费，范围含接入前的录制行）。
        const initial = bare ? tc.runtime.recentLines(c.defaults.sendMaxLines) : []
        // 缺省判据（§8.7）：有 cmd = gaCount:1 + maxLines 兜底；
        // 裸读 = maxLines + 短静默窗口。模型显式给 listen 时整体覆盖缺省。
        const opts: ReadOpts = bare
          ? {
              timeoutMs,
              signal: exec.signal,
              ...(Object.keys(listen).length === 0
                ? { maxLines: c.defaults.sendMaxLines, quietMs: BARE_READ_QUIET_MS }
                : listen),
            }
          : {
              timeoutMs,
              signal: exec.signal,
              ...(Object.keys(listen).length === 0
                ? { gaCount: 1, maxLines: c.defaults.sendMaxLines }
                : listen),
            }
        const r = await tc.runtime.read(opts, initial)
        return { ok: true, reason: r.reason, lines: r.lines.map(l => l.text) }
      } finally {
        tc.runtime.releaseSend(holder)
      }
    },
  }

  const mudState: MudToolDefinition = {
    name: 'mud_state',
    description:
      '读 MUD 连接与状态快照（连接/登录/接入/世界状态/录制缓冲），无需等行流。'
      + '未连接/未接入时也可用（模型要能答"我未接入"）。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          state: { type: 'object' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        const v = value as MudStateResult
        return [{ type: 'text', text: v.ok ? JSON.stringify(v.state, null, 2) : v.error }]
      },
    },
    async execute(_rawArgs, exec) {
      const c = core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)
      // 不受闸门/连接约束，只过归属（归属已在上一步判定）。
      return { ok: true, state: c.stateOf(tc.sessionId) }
    },
  }

  // 注册完整性自检：登记实际注册的工具名，注册后断言三工具全部过 registrar。
  const registered = new Set<string>()
  const recording: ToolRegistrar = {
    register: def => {
      registered.add(def.name)
      return registrar.register(def)
    },
  }
  const disposers = [mudConnect, mudSend, mudState].map(def => recording.register(def))
  const missing = ['mud_connect', 'mud_send', 'mud_state'].filter(n => !registered.has(n))
  if (missing.length > 0) throw new Error(`mud-core3 注册完整性自检失败：本层未注册 ${missing.join('/')}`)
  return disposers
}
