/**
 * mud-core3 tools — 执行域工具面（doc/PLAN.md「二期详细设计 §2/§5/§7/§9」）：
 * mud_send / mud_state。
 *
 * 二工具一个原则：**原文返回、模型自决**——mud_send 返回应答行原文（过程即
 * 结果）；mud_state 返回本地连接/接入/录制状态快照。
 *
 * 拒绝序（§2，全部**可读拒绝**——返回 { ok: false, error } 让模型读、能转告
 * 用户；不 throw）：
 *   1. 引擎缺席（ctx.mudCore3 未装配）→ 拒（I9 先例：注册照常、执行说明）；
 *   2. 归属：toolContextFor(agent) 为 null（会话不在 roster）→ 拒；
 *   3. 禁发表（cmd 存在时，全段扫描命中）→ 拒（安全面最高优先，先于闸门/连接）；
 *   4. 接入闸门：admitted === false → 拒「未接入」；
 *   5. 连接：connState !== 'connected' → 拒「未连接」（连接是手工动词）；
 *   6. 执行：send → read（mud_state 到 2 为止，不受闸门/连接约束）。
 *
 * 禁词表（§7，用户裁定最小集）：`suicide`（删除人物档案，不可逆）全段扫描——
 * commandTokens 按 [\s;]+ 切分得全部 token，任一命中即拒，堵 "look;suicide"
 * 绕过洞（core3 无 root 放行面，唯一防线不留洞）。quit/drop/passwd 等可逆或
 * 可恢复，不设拦截（先例证后机制）。
 *
 * 承载（§1）：工具定义在纯层（零宿主 import，窄结构同 core2 MudToolDefinition）；
 * preset.ts 只做注册适配——preset 作用域注册一次，注册期不依赖引擎；执行期经
 * deps.core() 解析引擎窄面（MudCore3Handle），归属判定 = toolContextFor（与
 * §3.1 roster 归属同一路径）。
 *
 * 纯度纪律：本文件不 import 宿主（module augmentation 只声明类型面）。
 */

import type { ReadOpts } from './read.ts'
import type { SessionRuntime } from './runtime.ts'
import type { ConnState } from './roster.ts'

/** 工具渲染块（宿主 ContentBlock 的 text 形态窄结构）。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 宿主 ToolDefinition 的窄结构（本包只用到的面）。 */
export interface MudToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 注册期协作式超时上限毫秒（宿主按此打断工具；工具参数钳制 ≤ 此值）。 */
  timeoutMs: number
  /** 是否可并发（mud_send 独占 socket 写 + 行流等待 → false；mud_state → true）。 */
  isConcurrencySafe: boolean
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly TextBlock[]
  }
  execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<unknown>
}

/** 宿主注册面窄结构（对应宿主 `tools.register(ToolDefinition): () => void`）。 */
export interface ToolRegistrar {
  register(definition: MudToolDefinition): () => void
}

/** 工具执行上下文（index.ts toolContextFor 聚合：归属 + 闸门/连接状态）。 */
export interface ToolContext {
  sessionId: string
  runtime: SessionRuntime
  admitted: boolean
  connState: ConnState
}

/**
 * 引擎窄面（index.ts `ctx.provide('mudCore3', …)` 暴露；preset 行执行期
 * `ctx.get('mudCore3')` 解析，缺席 = null ⇒ 执行可读拒绝，I9）。
 */
export interface MudCore3Handle {
  /** 工具执行上下文：归属 + 闸门/连接状态（会话不在 roster 返回 null）。 */
  toolContextFor(agent: { id: unknown }): ToolContext | null
  /** 工具缺省（Config 注入）：mud_send 总超时 / 裸读尾部行数。 */
  defaults: { sendTimeoutMs: number; sendMaxLines: number }
}

/** 工具依赖（preset 行一次注入；执行期解析引擎窄面）。 */
export interface MudToolDeps {
  /** 引擎窄面解析（执行期调用；null = 引擎缺席 ⇒ 可读拒绝，注册不受影响）。 */
  core: () => MudCore3Handle | null
}

/** mudCore3 声明合并（cordis Context 的可选服务；provide 方在 index.ts）。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    mudCore3?: MudCore3Handle
  }
}

// ── 禁词表（§7：最小集 + 全段扫描）──────────────────────────────────

/** 禁发表 token（不可逆命令；用户裁定当前仅 suicide——删档不可逆且无正常玩法需要）。 */
const DENY_HEADS: ReadonlySet<string> = new Set([
  'suicide', // 删除人物档案，不可逆
])

/** 命令全段 token（小写；按空白/分号切分得**全部**段——堵 "look;suicide" 绕过洞）。 */
export function commandTokens(cmd: string): string[] {
  return cmd.trim().toLowerCase().split(/[\s;]+/).filter(t => t !== '')
}

/** 禁发表命中（全段扫描）：返回命中 token，未命中返回 null。 */
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

function compileRegexes(sources: string[] | undefined, what: string): RegExp[] | undefined {
  if (sources === undefined || sources.length === 0) return undefined
  return sources.map((src) => {
    try {
      return new RegExp(src)
    } catch (e) {
      throw new Error(`${what} 正则非法: ${src}（${(e as Error).message}）`)
    }
  })
}

/**
 * 编译 listen 为 ReadOpts 判据面；全空 = {}（缺省判据由工具按模式注入：
 * 有 cmd = gaCount:1 + maxLines 兜底；裸读 = quietMs:300 + maxLines 兜底）。
 * @throws 正则非法时抛可读错误（execute 捕获转可读拒绝）。
 */
export function compileListen(spec: ListenSpec | undefined): Partial<ReadOpts> {
  if (spec === undefined) return {}
  const until = compileRegexes(spec.until, 'listen.until')
  const failOn = compileRegexes(spec.failOn, 'listen.failOn')
  // 条件展开组装（exactOptionalPropertyTypes：可选字段不收显式 undefined）
  return {
    ...(until !== undefined ? { until } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(spec.gaCount !== undefined ? { gaCount: spec.gaCount } : {}),
    ...(spec.quietMs !== undefined ? { quietMs: spec.quietMs } : {}),
    ...(spec.maxLines !== undefined ? { maxLines: spec.maxLines } : {}),
  }
}

// ── 工具注册 ────────────────────────────────────────────────────────

/** 工具执行体返回形态（canonical JSON）。 */
export type MudSendResult =
  | { ok: false; error: string }
  | { ok: true; reason: string; lines: string[] }
export type MudStateResult =
  | { ok: false; error: string }
  | { ok: true; state: {
      connState: ConnState
      admitted: boolean
      recording: number
      dropped: number
    } }

/** 引擎缺席时的可读拒绝（I9：不是必然失败的桩，注册照常、执行明确说明）。 */
export const CORE_ABSENT_ERROR = '已拒绝：mud-core3 引擎服务缺席（ctx.mudCore3 未装配），工具仅注册未接线'
/** 归属拒绝（toolContextFor 为 null：会话不在 roster）。 */
export const NO_ACCOUNT_ERROR = '已拒绝：本会话未绑定 MUD 账号'
/** 接入闸门拒绝（§2.4 原文）。 */
export const GATE_CLOSED_ERROR = '未接入：MUD 信息未进入本会话，工具不可用。请让用户在管理面对本账号执行「接入」'
/** 连接拒绝（§2.5 原文：连接是手工动词）。 */
export const NOT_CONNECTED_ERROR = '未连接：连接由用户手工管理，模型不能自行建连'

/** mud_send 总超时上限（工具参数钳制 ≤ 此值；§5/§9）。 */
export const MAX_TIMEOUT_MS = 60000
/** 裸读缺省静默窗口（§5：短静默收正在到达的尾巴）。 */
const BARE_READ_QUIET_MS = 300

/**
 * 构建并注册两个 mud 工具（§1：由 preset 行在 preset 作用域调用一次；
 * 注册期不依赖引擎，执行期经 deps.core() 解析引擎窄面）。
 *
 * 注册完整性自检：登记本层经 registrar 实际注册的工具名，缺即 fail-loud
 * （core2 先例保留）。
 *
 * @returns 注册 disposer 列表（由 preset 作用域容器持有，随作用域释放自动执行）。
 */
export function registerMudTools(
  registrar: ToolRegistrar,
  deps: MudToolDeps,
): Array<() => void> {
  const core = (): MudCore3Handle | null => deps.core()

  const mudSend: MudToolDefinition = {
    name: 'mud_send',
    description:
      '向 MUD 发送一条命令并等待应答原文（cmd = 发送+等应答；不带 cmd = 裸读近期行流看当前状况，不发送）。'
      + 'listen 声明完成判据（缺省等一段完整文字；裸读缺省短静默收尾）；必须给 timeoutMs 或用系统缺省（绝不无界等待）。'
      + '返回应答行原文，由你自决下一步。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要发送的命令；缺省 = 裸读（只读近期行流不发送）' },
        listen: {
          type: 'object',
          description: '完成判据（缺省：有 cmd 等 gaCount:1 一段完整文字；裸读等 quietMs:300 短静默）',
          properties: {
            until: { type: 'array', items: { type: 'string' }, description: '完成判据正则（在累积应答文本上测，可跨批命中）' },
            failOn: { type: 'array', items: { type: 'string' }, description: '负面判据正则（命中即失败收束）' },
            gaCount: { type: 'integer', minimum: 1, description: 'GA/EOR 边界计数关窗' },
            quietMs: { type: 'integer', minimum: 1, description: '行间静默毫秒（最后一次行到达后静默即收）' },
            maxLines: { type: 'integer', minimum: 1, description: '行数兜底' },
          },
        },
        timeoutMs: { type: 'integer', minimum: 1, description: '总超时毫秒；缺省由系统注入（上限 60000）' },
      },
    },
    timeoutMs: MAX_TIMEOUT_MS,
    isConcurrencySafe: false,
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
      if (c === null) return { ok: false, error: CORE_ABSENT_ERROR }
      // 拒绝序 2：归属（会话不在 roster → toolContextFor 为 null）。
      // agent 恒有（宿主工具执行必带调用方 agent）；窄面实现是 String(agent.id)，
      // 桩/测试若漏传（undefined）会直接 TypeError——fail-loud 暴露形状错误，
      // 不静默吞掉走可读拒绝。
      const tctx = c.toolContextFor(exec.agent as { id: unknown })
      if (tctx === null) return { ok: false, error: NO_ACCOUNT_ERROR }
      // 拒绝序 3：禁发表（安全面最高优先，先于闸门/连接；全段扫描）。
      if (args.cmd !== undefined) {
        const hit = denyMatch(args.cmd)
        if (hit !== null) return { ok: false, error: `拒绝执行：危险命令（${hit}）被禁（不可逆）` }
      }
      // 拒绝序 4：接入闸门。
      if (!tctx.admitted) return { ok: false, error: GATE_CLOSED_ERROR }
      // 拒绝序 5：连接（手工动词，模型不能自行建连）。
      if (tctx.connState !== 'connected') return { ok: false, error: NOT_CONNECTED_ERROR }

      // 执行（§6）：listen 编译错误转可读拒绝（模型给错正则不该炸回合）。
      let listen: Partial<ReadOpts>
      try {
        listen = compileListen(args.listen)
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
      // timeoutMs 钳制：min(参数 ?? 缺省, MAX_TIMEOUT_MS)（§5）。
      const timeoutMs = Math.min(args.timeoutMs ?? c.defaults.sendTimeoutMs, MAX_TIMEOUT_MS)
      try {
        // 有 cmd：缺省判据 gaCount:1（一段完整文字）+ maxLines 兜底；裸读：缺省
        // quietMs:300（短静默收尾）+ maxLines 兜底。模型 listen 字段覆盖缺省。
        const r = args.cmd !== undefined
          ? await tctx.runtime.read({
              cmd: args.cmd,
              timeoutMs,
              signal: exec.signal,
              gaCount: 1,
              maxLines: c.defaults.sendMaxLines,
              ...listen,
            })
          : await tctx.runtime.read({
              timeoutMs,
              signal: exec.signal,
              quietMs: BARE_READ_QUIET_MS,
              maxLines: c.defaults.sendMaxLines,
              ...listen,
            })
        return { ok: true, reason: r.reason, lines: r.lines.map(l => l.text) }
      } catch (error) {
        // read 竞速冲突/已销毁等 fail-loud 错误转可读拒绝（不炸回合）。
        return { ok: false, error: `mud_send 执行失败：${(error as Error).message}` }
      }
    },
  }

  const mudState: MudToolDefinition = {
    name: 'mud_state',
    description: '读本地连接与接入状态快照（connState/admitted/录制行数/丢弃行数）。不受接入闸门与连接约束，未接入/未连接时也可调用。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 5000,
    isConcurrencySafe: true,
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
      if (c === null) return { ok: false, error: CORE_ABSENT_ERROR }
      // mud_state 只过归属（§6）：不受闸门/连接约束——模型能答"我未接入"
      // 本身要求它能读状态；未接入时唯一可读的工具就是它。
      const tctx = c.toolContextFor(exec.agent as { id: unknown })
      if (tctx === null) return { ok: false, error: NO_ACCOUNT_ERROR }
      return {
        ok: true,
        state: {
          connState: tctx.connState,
          admitted: tctx.admitted,
          recording: tctx.runtime.pendingLineCount,
          dropped: tctx.runtime.droppedLineCount,
        },
      }
    },
  }

  // 注册完整性自检：登记实际注册的工具名，注册后断言二工具全部过 registrar
  //（core2 先例；只证明"本层注册成功"，不证明"agent 可见面含二工具"——
  // 后者属装配期探针，宿主前置验证 1）。
  const registered = new Set<string>()
  const recording: ToolRegistrar = {
    register: def => {
      registered.add(def.name)
      return registrar.register(def)
    },
  }
  const disposers = [mudSend, mudState].map(def => recording.register(def))
  const missing = ['mud_send', 'mud_state'].filter(n => !registered.has(n))
  if (missing.length > 0) throw new Error(`mud-core3 注册完整性自检失败：本层未注册 ${missing.join('/')}`)
  return disposers
}
