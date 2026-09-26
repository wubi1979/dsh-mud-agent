/**
 * tools — 执行域工具面（impl §3.5）：mud_send / mud_flow / mud_state。
 *
 * 三工具一个原则：**原文返回、模型自决**——mud_send 返回 ReadResult.lines
 * 原文（过程即结果）；mud_flow 返回流程三出口的转写；mud_state 返回 world
 * 快照。第一期满（不注册 captchaRecognize）：必然失败的桩会让模型反复调用、
 * 白烧请求。
 *
 * 静态遮蔽（不做动态权限，§3.5）：
 *   - 根会话（holder === 'root'）：放行；
 *   - 子会话（`child:*`）：mud_send 工具内**静态禁发表**（suicide/quit/drop
 *     all 类不可逆命令，首词一行判断）命中即拒；mud_flow 查无此 id 同样直接拒；
 *   - 计划边界不进权限系统：经济类动作不被拦（"取钱/买食物"全链路验收依赖它）；
 *     子级自作主张发经济命令目前无例证，按"先例证后机制"不加处理（§6 语料审计）。
 *
 * 首次 mud_send 隐式建连 + login（LoginGate：已登录标志防重入；断线复位由
 * 装配层接线 mud.onDisconnect → gate.reset()）。
 *
 * 接线层：经注入窄结构接口（ToolRegistrar）注册，包内不 import 宿主、保持
 * 零依赖；exec 只消费 `signal`（读竞速机的释放阀门）。
 */

import { FLOWS as FLOWS_REF, getFlow } from './flows/index.ts'
import { FlowError, type Flow, type FlowCreds } from './flows/types.ts'
import type { MudLine } from '../link/ansi.ts'
import { type Holder, type Mud, type WaitOpts } from '../link/mud.ts'
import type { World } from '../awareness/world.ts'

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
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly TextBlock[]
  }
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

/** 宿主注册面窄结构（对应宿主 `tools.register(ToolDefinition): () => void`；
 *  在 agent 作用域内调用 = 只对该 agent 可见，装配时由 agent/created 监听器
 *  逐 agent 调用，作用域必须是宿主/preset（§3.5 实施前提 2）。 */
export interface ToolRegistrar {
  register(definition: MudToolDefinition): () => void
}

/** 工具依赖（装配层一次注入）。 */
export interface MudToolDeps {
  mud: Mud
  world: World
  creds: FlowCreds
  connect: { host: string; port: number }
  /** 本工具面所在会话的持有者身份（'root' | `child:<id>`）：deny 判据 + read/流程参数。 */
  holder: Holder
  /**
   * 缺省总超时毫秒（Config 供给，取值待 §6 校准）：兼两用 —— mud_send 的
   * 缺省总超时（§3.5"必须显式给出或由工具注入缺省"）与流程单步兜底超时
   * （FlowCtx.defaultTimeoutMs，经 LoginGate/mud_flow 双路传入）。
   */
  defaultTimeoutMs: number
  /** 流程注册表（缺省共享 FLOWS；测试可注入本地表）。 */
  flows?: readonly Flow[]
}

// ── 子会话静态禁发表（首词一行判断；deniedCommands 承旧实录）─────────────

/** 禁发表首词（不可逆命令类；根会话不受限）。 */
const DENY_HEADS: ReadonlySet<string> = new Set([
  'suicide', // 删除人物档案，不可逆
  'passwd', // 改密影响账号凭据，不可逆
  'quit', 'exit', 'logout', // 退出中断修炼/任务状态
  'drop', 'junk', // 丢弃可能永久失去物品（"drop all" 首词即 drop）
])

/** 命令首词（小写；按空白/分号切分后的第一段；承旧实现 commandHead）。 */
export function commandHead(cmd: string): string {
  return cmd.trim().toLowerCase().split(/[\s;]+/)[0] ?? ''
}

/** 子会话静态禁发表命中：返回命中首词，未命中返回 null。 */
export function denyMatch(cmd: string): string | null {
  const head = commandHead(cmd)
  return head !== '' && DENY_HEADS.has(head) ? head : null
}

// ── 隐式建连 + 登录闸门 ─────────────────────────────────────────────

/**
 * 登录闸门：首次 mud_send 隐式建连 + login；已登录标志防重入（并发调用共乘
 * 同一次 in-flight 登录）；断线复位由装配层接线（mud.onDisconnect → reset）。
 * 登录态同步写世界记忆（world.session.loggedIn，measured）——这是 context
 * 世界摘要"断线/重连判断"的唯一写点（防孤儿字段，§3.4 字段清单判据）。
 */
export class LoginGate {
  private loggedIn = false
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly mud: Mud,
    private readonly world: World,
    private readonly flows: readonly Flow[],
    private readonly creds: FlowCreds,
    private readonly connect: { host: string; port: number },
    private readonly defaultTimeoutMs: number,
  ) {}

  get isLoggedIn(): boolean {
    return this.loggedIn
  }

  /** 确保已建连已登录（幂等；并发共乘）。 */
  async ensure(holder: Holder, signal?: AbortSignal): Promise<void> {
    if (this.loggedIn) return
    if (!this.mud.connected) this.mud.connect(this.connect.host, this.connect.port)
    this.inFlight ??= this.run(holder, signal).finally(() => {
      this.inFlight = null // 失败同样清闸，允许重试（loggedIn 保持 false）
    })
    await this.inFlight
  }

  /**
   * 断线复位（装配层接线 mud.onDisconnect）。同步写回世界记忆：
   * loggedIn=false（measured）——"断线"是直测事实，摘要据此报"登录：否"。
   */
  reset(): void {
    this.loggedIn = false
    this.world.set('session', 'loggedIn', false, 'measured')
  }

  private async run(holder: Holder, signal: AbortSignal | undefined): Promise<void> {
    const flow = getFlow('login', this.flows)
    if (flow === null) throw new FlowError('登录流程未注册')
    const r = await flow.run({
      mud: this.mud,
      creds: this.creds,
      holder,
      defaultTimeoutMs: this.defaultTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    if ('done' in r) {
      if (!r.done) throw new FlowError('登录流程异常结束（带问题结束不适用于登录）')
      this.loggedIn = true
      // 登录成功是直测事实：写世界记忆（context 摘要与 mud_state 的消费源）。
      this.world.set('session', 'loggedIn', true, 'measured')
      return
    }
    throw new FlowError(r.reason === 'danger' ? '登录被危险中断' : '登录流程异常结束')
  }
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

/** 编译 listen；全空 = 缺省 gaCount:1（一段完整文字，impl §3.5）。 */
export function compileListen(spec: ListenSpec | undefined): Partial<WaitOpts> {
  if (spec === undefined) return { gaCount: 1 }
  const until = compileRegexes(spec.until, 'listen.until')
  const failOn = compileRegexes(spec.failOn, 'listen.failOn')
  // 条件展开组装（exactOptionalPropertyTypes：可选字段不收显式 undefined）
  const out: Partial<WaitOpts> = {
    ...(until !== undefined ? { until } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(spec.gaCount !== undefined ? { gaCount: spec.gaCount } : {}),
    ...(spec.quietMs !== undefined ? { quietMs: spec.quietMs } : {}),
    ...(spec.maxLines !== undefined ? { maxLines: spec.maxLines } : {}),
  }
  return Object.keys(out).length === 0 ? { gaCount: 1 } : out
}

// ── 工具注册 ────────────────────────────────────────────────────────

/** 三工具的执行体返回形态（canonical JSON）。 */
export type MudSendResult =
  | { ok: false; error: string }
  | { ok: true; reason: string; lines: string[] }
export type MudFlowResult =
  | { ok: false; error: string }
  | { ok: true; done: true }
  | { ok: true; done: false; question: string; lines: string[] }
  | { ok: true; reason: 'danger' }
export type MudStateResult = { ok: true; state: ReturnType<World['snapshot']> }

function linesText(lines: readonly MudLine[] | string[]): string {
  const texts = typeof (lines as string[])[0] === 'string'
    ? lines as string[]
    : (lines as MudLine[]).map(l => l.text)
  return texts.join('\n')
}

/**
 * 构建并注册三个 mud 工具（装配时对每个 agent 会话调用一次；子会话依赖
 * agent/created 监听器注册在宿主/preset 作用域，§3.5 实施前提 2）。
 *
 * 返回注册 disposer 列表与登录闸门 —— 装配层把 mud.onDisconnect 接到
 * gate.reset()；闸门以 deps.defaultTimeoutMs 构造（同值兼流程单步兜底
 * 超时，见 MudToolDeps.defaultTimeoutMs 注释）。
 */
export function registerMudTools(
  registrar: ToolRegistrar,
  deps: MudToolDeps,
): { disposers: Array<() => void>; gate: LoginGate } {
  const flows = deps.flows ?? FLOWS_REF
  const gate = new LoginGate(deps.mud, deps.world, flows, deps.creds, deps.connect, deps.defaultTimeoutMs)

  const mudSend: MudToolDefinition = {
    name: 'mud_send',
    description:
      '向 MUD 发送一条命令并等待应答原文（有 cmd = send + read；无 cmd = 裸读只等行流）。'
      + '必须给超时或缺省由系统注入（绝不无界等待）；listen 声明完成判据（缺省等一段完整文字）。'
      + '返回应答行原文，由你自决下一步。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要发送的命令；缺省 = 裸读（只等行流不发送）' },
        listen: {
          type: 'object',
          description: '完成判据（缺省 = gaCount:1，一段完整文字）',
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
        return [{ type: 'text', text: v.ok ? linesText(v.lines) : v.error }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { cmd?: string; listen?: ListenSpec; timeoutMs?: number }
      const timeoutMs = args.timeoutMs ?? deps.defaultTimeoutMs
      const { holder } = deps

      // 静态禁发表先于隐式登录（子会话首发即禁命令时，不为它建连登录）。
      if (args.cmd !== undefined && holder !== 'root') {
        const head = denyMatch(args.cmd)
        if (head !== null) return { ok: false, error: `已拒绝：子会话静态禁发表命中（${head}）` }
      }

      await gate.ensure(holder, exec.signal)

      if (args.cmd !== undefined) deps.mud.send(args.cmd)
      const r = await deps.mud.read({
        holder,
        timeoutMs,
        signal: exec.signal,
        ...compileListen(args.listen),
      })
      return { ok: true, reason: r.reason, lines: r.lines.map(l => l.text) }
    },
  }

  const mudFlow: MudToolDefinition = {
    name: 'mud_flow',
    description:
      '走一个注册流程（login 等）。流程因问题受阻上浮时（返回 question），把问题带给能回答的人，'
      + '拿到答案后带 answer 重入本工具继续该流程。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '流程 id' },
        answer: { type: 'string', description: '重入时携带的答案/决策值（首次调用不填）' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          done: { type: 'boolean' },
          question: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        // 三出口统一人读文本（§3.5"结果原文返回"原则；问题出口 = question + 行原文）。
        const v = value as MudFlowResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        if ('done' in v) {
          return v.done
            ? [{ type: 'text', text: '流程完成。' }]
            : [{ type: 'text', text: `${v.question}\n${linesText(v.lines)}` }]
        }
        return [{ type: 'text', text: '流程被危险中断：行流等待已被打断（触发行已收编进现场）。' }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { id: string; answer?: string }
      const flow = getFlow(args.id, flows)
      if (flow === null) return { ok: false, error: `未知流程 id: ${args.id}` } // 越权/不存在同拒
      const r = await flow.run({
        mud: deps.mud,
        creds: deps.creds,
        holder: deps.holder,
        defaultTimeoutMs: deps.defaultTimeoutMs,
        ...(args.answer !== undefined ? { answer: args.answer } : {}),
        signal: exec.signal,
      })
      if ('done' in r) {
        return r.done
          ? { ok: true, done: true }
          : { ok: true, done: false, question: r.question, lines: r.lines.map(l => l.text) }
      }
      return { ok: true, reason: 'danger' }
    },
  }

  const mudState: MudToolDefinition = {
    name: 'mud_state',
    description: '读世界状态快照（HP/内力/位置/战斗态等），无需等行流。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => {
        const v = value as MudStateResult
        return [{ type: 'text', text: JSON.stringify(v.state, null, 2) }]
      },
    },
    async execute() {
      return { ok: true, state: deps.world.snapshot() }
    },
  }

  const disposers = [mudSend, mudFlow, mudState].map(def => registrar.register(def))
  return { disposers, gate }
}
