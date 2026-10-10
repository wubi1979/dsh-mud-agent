/**
 * tools — 工具面纯层：mud_connect / mud_send / mud_walk / mud_state（三期 T2b；T23 walk）。
 *
 * 工具一个原则：**原文返回、模型自决**——mud_send 返回应答行原文（过程即
 * 结果）；mud_connect 只建连（登录归流程面）；mud_walk 是 mud_send 的判据
 * 预设特化（walk 家族 + 行走静默窗）；mud_state 返回插件状态 + world
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
import type { LoggedInState, WorldEntry, WorldSnapshot } from './world.ts'
import { DEFAULT_TRACK_RULES } from './tracker.ts'
import type { MudLine } from './link/line.ts'
import {
  belowStaminaFloor, STAMINA_CUR_KEY, STAMINA_MAX_KEY, STAMINA_ZONE,
} from './nav/stamina.ts'
import type { MudNavFace } from './nav/service.ts'
import { parseDirectionPath, parseWalkTable } from './nav/route.ts'
import { nextBlocker } from './nav/blocker.ts'
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
  readonly defaults: { readonly sendTimeoutMs: number; readonly sendMaxLines: number; readonly staminaFloorPct: number }
}

/** 工具依赖（preset 行一次注入；执行期解析引擎窄面）。 */
export interface MudToolDeps {
  /** 引擎窄面解析（执行期调用；null = 引擎缺席 ⇒ 可读拒绝，注册不受影响）。 */
  core: () => MudCore3Handle | null
  /**
   * `mudNav` 服务面解析（T23.10b；缺省 ⇒ 不记录、不给建议，工具行为退回本期之前）。
   * 服务是**插件级单例**（知识图全局），会话相关事实仍在 World（§10.3）。
   */
  nav?: () => MudNavFace | null
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

/**
 * mud_walk 行走静默窗毫秒（收「走完了」）：walk 逐步输出（walk_speed 0/1 =
 * 0.2s/步，3 = 0.8s/步），步间隔远小于 1.5s ⇒ 连续输出不断流；到达后输出停
 * ⇒ 静默 1.5s 即收束。不能用 gaCount（每步都出提示符，GA 计数会第一步就关窗）。
 * 行文判据（A.9 结论 5，2026-10-08 实机）：到达 `你到达了荆州府。` ⇒ until；
 * 软阻断 `你因为种种原因停了下来，可以用walk继续进行。`（下标 0）与未受理
 * `当前区域的系统内建路径出发点在：…`（下标 1）⇒ failOn，**下标即 outcome 分类**。
 * 查询类参数（`-c` / `-q`）**不注入**行走判据——其答复本身含"未受理"同族句。
 * 交战中：战斗接管（§8.6 持有者 + 危险抢占）会以 `reason:'danger'` 打断本读窗 ⇒
 * walk 以中断收束；**用户裁定 2026-10-08：先假设可恢复**（战斗结束后用无参 `walk`
 * 继续走完），实测发现不能恢复再改口径。被抢占时持有者已归战斗，本工具的
 * `finally releaseSend` 只解除自己的持有（runtime 按 holder 比对）⇒ 战斗持有不受影响。
 */
const WALK_QUIET_MS = 1500

/** 到达判据（A.9 结论 5）：完整句 `你到达了荆州府。`。 */
const WALK_UNTIL: readonly string[] = ['^你到达了']

/** 失败判据（A.9 结论 5）：**只有软阻断**（下标 0，无参 `walk` 可继续）。 */
const WALK_FAILON: readonly string[] = [
  '你因为种种原因停了下来',
]

/**
 * "在出发点"的**正向证据**（反证口径，用户裁定 2026-10-08）：
 *   - **表类调用**（无参 `walk` / `-c`）：出路径表 ⇒ 在出发点；**没出表 ⇒ 不在**；
 *   - **行走类调用**（`walk <拼音名>` / `-p`）：出受理行（`你决定开始前往…`）⇒ 在出发点；没出 ⇒ 不在。
 * 判据**不用单行"拒绝行文"**（那句与 `-c` 同族、易误判）；`-q` 与 `-c <拼音名>` 的输出与
 * 出发点无关 ⇒ **不参与判定**。
 */
const WALK_STARTED_RE = /^你决定开始前往/

/** 查询类参数（`-c` / `-q`）：答复是"查询结果"，不按行走判据分类。 */
const WALK_QUERY_RE = /^-(c|q)(\s|$)/

/** mud_walk 动作（T23.9，D14）：本期实现 `walk` / `speed`，`node` 家族只留槽位。 */
export type MudWalkAction = 'walk' | 'node' | 'node-get' | 'node-walk' | 'speed'

/** 本期实现、进工具描述的动作。 */
const WALK_ACTIONS: readonly MudWalkAction[] = ['walk', 'speed']

/** 预留槽位（不进描述；执行返回可读拒绝——node 不保证成功，A.9 结论 9）。 */
const WALK_RESERVED_ACTIONS: readonly MudWalkAction[] = ['node', 'node-get', 'node-walk']

/** `set walk_speed` 值域（A.9 结论 7：-1 奔跑 / 0·1 正常 / 2 慢行 / 3 缓步）。 */
const WALK_SPEED_MIN = -1
const WALK_SPEED_MAX = 3
const WALK_SPEED_RE = /^-?\d+$/

/** mud_walk 总超时下限毫秒（长路线 15+ 步 × 慢速档 ≈ 12s+；低于此值用下限）。 */
const WALK_MIN_TIMEOUT_MS = 30000

// ── 长程命令判据预设（§8.7）──────────────────────────────────────────
//
// 长程命令（打坐/睡觉等）：受理帧自带 GA + prompt，其后输出流**无 GA 无 prompt**
//（A.3：dz 受理后 56 批 / 约 57s），完成句与末条推送同块到达 ⇒ 缺省 `gaCount:1`
// 只会收在受理帧。等待完成按**完成句 until**（跨批命中）收，timeout 只做兜底。
// 纪律（A.6）：判据必须引用附录实录原文，不得凭印象写正则——条目原句见 A.3
//（2026-10-10 用户提供）；新条目实机语料校准后逐条添加，机制不变。

/** 长程命令判据预设条目。 */
export interface LongCmdProfile {
  /** 命令头匹配（对 trim 后的整条 cmd 测：首词 + 词边界）。 */
  match: RegExp
  /** 完成判据（until 正则源；在累积应答文本上测，可跨批命中）。 */
  until: readonly string[]
  /** 负面判据（failOn 正则源：受理被拒/被打断句；实机校准后补）。 */
  failOn?: readonly string[]
  /** 行间静默关窗（quietMs；输出流节奏未校准前不设——误早关窗比兜底超时更毒）。 */
  quietMs?: number
  /**
   * 总超时毫秒（**系统注入值，豁免模型面 60s 钳制**——钳制只约束模型显式给的
   * timeoutMs；until 是主收束，本值纯兜底）。
   */
  timeoutMs: number
}

/** 已知长程命令判据表（cmd 头匹配；模型显式 listen 仍整体覆盖，语义不变）。 */
export const LONG_CMD_PROFILES: readonly LongCmdProfile[] = [
  {
    // 打坐（A.3 实录：受理帧 GA 后 57s 无 GA；受理/完成句原句 2026-10-10 用户提供）
    // 完成三形态（2026-10-10 用户补）：内息收回 = 正常结束；内力增加了 = 上限突破；运功完毕站起 = 收尾变体
    // 受理被拒（A.3，2026-10-10 用户补）：精神不足 ⇒ failOn 立即收窗，拒绝句原文回给 agent 自决
    match: /^(dz|dazuo)(\s|$)/,
    until: ['你将运转于全身经脉间的内息收回丹田', '你的内力增加了！！', '你运功完毕，深深吸了口气，站了起来。'],
    failOn: ['你现在的气太少了，无法产生内息运行全身经脉。', '你现在精不够，无法控制内息的流动！'],
    timeoutMs: 120_000,
  },
  {
    // 睡觉（受理/完成句原句 2026-10-10 用户提供；全程时长无实测，兜底放宽待校准）
    // 受理被拒（A.3，2026-10-10 用户补）：刚睡过 ⇒ failOn 立即收窗。原句尾随空格不进判据
    //（子串匹配两侧兼容：句体命中即收，行文带不带尾随空白都能命中）
    match: /^sleep(\s|$)/,
    until: ['你一觉醒来，精神抖擞地活动了几下手脚'],
    failOn: ['你刚刚睡过一觉, 多睡对身体有害无益!'],
    timeoutMs: 300_000,
  },
]

/** cmd 头匹配长程判据预设；未命中返回 null。 */
export function matchLongCmdProfile(cmd: string): LongCmdProfile | null {
  const c = cmd.trim()
  for (const p of LONG_CMD_PROFILES) {
    if (p.match.test(c)) return p
  }
  return null
}

/** 预设条目 → listen 判据（until 必有；failOn/quietMs 条件展开，exactOptionalPropertyTypes）。 */
function profileListen(p: LongCmdProfile): ListenOpts {
  const until = compileRegexes([...p.until], '长程预设.until')
  const failOn = p.failOn !== undefined ? compileRegexes([...p.failOn], '长程预设.failOn') : undefined
  return {
    ...(until !== undefined ? { until } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(p.quietMs !== undefined ? { quietMs: p.quietMs } : {}),
  }
}

// ── 状态拉取命令读后投影（§8.7）──────────────────────────────────────
//
// persona 旧措辞「命令不会有返回结果」的实证后果（2026-10-10）：agent 对状态
// 拉取命令发 wait:false 盲发循环（"没有返回值 ⇒ 等待无意义"），服务器限流。
// 读后投影 = 收窗后把追踪器（T19）**本窗口**刚写入 World 的语义分区快照附进
// 工具结果——解析零重复（判据单点在 tracker），结果从表格原文升级为结构化状态。
// 命令集合单点 = DEFAULT_TRACK_RULES 的 rule id（不建第二张表；A.6 语料校准
// 随规则条目走）。

/** 投影取的语义分区（追踪器写入面，§10.3）；location/nav/gmcp/session 不在此列。 */
const STATE_PULL_ZONES: readonly string[] = ['vitals', 'combat', 'character', 'inventory', 'skills']

/**
 * 状态拉取命令识别：**单点 = DEFAULT_TRACK_RULES 推导**，但只取「命令触发的
 * 表格/序列规则」（zone ∈ 语义分区白名单 且 shape ∈ table/sequence）——规则表
 * 同时含 walk 系列、combat、id 等行流匹配规则（非命令触发、zone 不在白名单），不能
 * 全量拼接。推导结果 ≈ `hpbrief|hp|sc|i|skills|exp`，词边界保证 `id`/`inventory`
 * 不误伤。
 */
export const STATE_PULL_CMD_RE = new RegExp(
  `^(?:${DEFAULT_TRACK_RULES
    .filter(r => (r.shape === 'table' || r.shape === 'sequence') && STATE_PULL_ZONES.includes(r.zone))
    .map(r => r.id)
    .join('|')})(?:\\s|$)`,
)

/**
 * 读后投影：只取 `sinceMs`（send 时刻）之后写入的条目 = **本窗口的刷新证据**。
 * 陈旧条目不投影（如 hp 被限流时窗内零写入 ⇒ 返回 null，调用方 fail-open 回原文，
 * 绝不让旧值冒充新值）。
 */
function projectStateZones(world: WorldSnapshot, sinceMs: number): WorldSnapshot | null {
  const out: Record<string, Record<string, WorldEntry>> = {}
  let count = 0
  for (const zone of STATE_PULL_ZONES) {
    for (const [key, entry] of Object.entries(world[zone] ?? {})) {
      if (entry.source.time < sinceMs) continue
      ;(out[zone] ??= {})[key] = entry
      count += 1
    }
  }
  return count > 0 ? out : null
}

/** 引擎缺席时的可读拒绝（I9：不是必然失败的桩，注册照常、执行明确说明）。 */
export const CORE_ABSENT_ERROR = '已拒绝：mud-core3 引擎服务缺席（ctx.mudCore3 未装配），工具仅注册未接线'
/** 归属未命中的可读拒绝。 */
export const NOT_BOUND_ERROR = '已拒绝：本会话未绑定 MUD 账号'

/** 未连接的可读拒绝（三期唯一连接约束；指引 mud_connect）。 */
export const NOT_CONNECTED_ERROR = '已拒绝：未连接，无法发送命令。可先调用 mud_connect 建连（已连接时幂等成功）'

/** 会话级持有者冲突的可读拒绝（应答不劈半）。 */
export const HOLDER_BUSY_ERROR = '已拒绝：另一执行体正在发送命令或等待应答（会话级独占），请稍后重试'
/** 交战接管期专属拒绝文案（T21 W5：mud_state 照常，发送/读窗可读拒绝）。 */
export const COMBAT_HOLDING_ERROR = '已拒绝：交战中，行流由战斗系统持有（自主战斗进行中），请战斗结束后再试'

/** 工具执行体返回形态（canonical JSON）。 */
export type MudConnectResult =
  | { ok: false; error: string }
  | { ok: true; state: string }
export type MudSendResult =
  | { ok: false; error: string }
  | { ok: true; reason: string; lines: string[]; world?: WorldSnapshot }
/** mud_walk 行走结果分类（T23.5/T23.11，D13）：软/硬阻断与"没站在出发点"处置不同。 */
export type MudWalkOutcome = 'arrived' | 'soft-stop' | 'hard-stop' | 'unaccepted' | 'incomplete'

/** mud_walk 返回形态 = mud_send 同款 + `outcome`（行走结果分类；speed 等非行走动作不带）+ `departures`（未受理时的本区域起点）+ `region`/`hint`/`suggest`（T23.10b 记录与建议）。 */
export type MudWalkResult =
  | { ok: false; error: string }
  | {
    ok: true
    reason: string
    outcome?: MudWalkOutcome
    departures?: string[]
    blocked?: { attempts: number; hard: boolean; at: string | null }
    region?: string
    hint?: { to: string; via: string[] }
    suggest?: { dest: string; pinyin: string; steps: number }
    path?: { to: string; directions: string[]; short?: string }
    lines: string[]
  }

/** World 里的数值（非有限数 ⇒ undefined）。 */
function numberValue(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** World 里的字符串值（非字符串 ⇒ undefined）。 */
function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** World 里的字符串数组（非数组 / 空 ⇒ undefined）。 */
function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

/** 收束原因 ⇒ 行走结果（`failOn` 当前只有软阻断一项；未受理走**反证**，见调用点）。 */
function walkOutcome(reason: string): MudWalkOutcome {
  if (reason === 'until') return 'arrived'
  if (reason === 'failOn') return 'soft-stop'
  return 'incomplete'
}
export type MudStateResult =
  | { ok: false; error: string }
  | { ok: true; state: MudStateSnapshot }

/** 可读拒绝助手。 */
function reject(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

// ── 工具注册 ────────────────────────────────────────────────────────

/**
 * 构建并注册四个 mud 工具（preset 行在 preset 作用域调用一次；注册期不依赖
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
  const nav = (): MudNavFace | null => deps.nav?.() ?? null

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
      + 'wait=false 时发送即走：只发命令不等应答（不 read、不判成败），用于翻页/save 等'
      + '"发了就行"的动作。未连接时被拒绝，可先调用 mud_connect。listen 声明完成判据'
      + '（缺省等一段完整文字）；必须给超时或缺省由系统注入（绝不无界等待）。'
      + '返回应答行原文；状态拉取命令（hpbrief/hp/sc/i/skills）还会附带系统解析好的'
      + ' world 结构化状态（world 字段，与 mud_state 同形），直接读它即可。',
    isConcurrencySafe: () => false, // socket 写 + 行流等待，独占（谓词恒 false）
    parameters: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: '要发送的命令；缺省 = 裸读（不发命令，读近期行流）。'
            + '空命令只回一个提示符（立即返回），等待长程命令不要用它。'
            + '命令一律小写；命令参数（人名/物品名等英文 id）先用全小写尝试，'
            + '游戏不认（提示找不到/没这个东西）时再试大小写混合原样拼写',
        },
        wait: {
          type: 'boolean',
          description: '缺省 true = 发送并等待应答；false = 发送即走（只发不等，不判成败）',
        },
        listen: {
          type: 'object',
          description: '完成判据（缺省：有 cmd = 一段完整文字；已知长程命令（dz/sleep 等）= 自动等完成句、一次性返回全程行文；裸读 = 最近行 + 短静默窗口）',
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
          world: { type: 'object' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        // 模型面合同：原文/可读文本，不让模型读 JSON（canonical JSON 只走
        // output.schema/持久化面）。
        const v = value as MudSendResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        // 发送即走（wait:false）：无应答行可给，明说语义并指引状态面。
        if (v.reason === 'sent') return [{ type: 'text', text: '已发送（发送即走：未等待应答；状态可用 mud_state 查看）' }]
        // 读后投影（§8.7）：拉取命令带 world ⇒ 渲染结构化状态（与 mud_state 同款
        // JSON 风格），原文表格不再重复进上下文；无 world（非拉取命令/窗内零写入）
        // ⇒ 维持原文 join。
        if (v.world !== undefined) return [{ type: 'text', text: JSON.stringify(v.world, null, 2) }]
        return [{ type: 'text', text: v.lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { cmd?: string; listen?: ListenSpec; timeoutMs?: number; wait?: boolean }
      const c = core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)

      // 禁发表先于闸门/连接（安全面最高优先；全段扫描）。
      if (args.cmd !== undefined) {
        const hit = denyMatch(args.cmd)
        if (hit !== null) return reject(`拒绝执行：危险命令（${hit}）被禁（不可逆）`)
      }

      // 空命令放开（2026-10-10 二次裁定）：长程等待根因已除（判据预设 + persona
      // 纪律），拒绝不再必要。空输入也是命令 ⇒ 回 prompt+GA（A.2 1:1），走缺省
      // gaCount:1 立即收束——用于刷提示符无害；等长程命令仍须走预设/裸读 + until。

      // 只对「未连接」设限（三期裁定：不受接入闸门、不要求已登录）。
      // 探测中（probeState=probing）仍按已连接放行——probeState 是只读观测面，
      // 不回写 conn 三态（T5.1），TCP 确实通，发送/等待语义不受探测影响。
      if (tc.runtime.connState !== 'connected') return reject(NOT_CONNECTED_ERROR)

      // T19 D11 发送即走：只 send 不 read、不设超时、不判成败（分页/save 等
      // "发了就行"的动作）。仍过会话级持有者（避免劈开他人在途应答）；拒绝序不变。
      if (args.wait === false) {
        if (args.cmd === undefined) return reject('已拒绝：wait=false（发送即走）需要提供 cmd；裸读请省略 wait')
        const holder = String((exec.agent as ToolAgent | undefined)?.id ?? '')
        if (!tc.runtime.acquireSend(holder)) {
          return reject(tc.runtime.sendHolderId === 'combat' ? COMBAT_HOLDING_ERROR : HOLDER_BUSY_ERROR)
        }
        try {
          if (!tc.runtime.send(args.cmd)) return reject('已拒绝：发送失败（连接可能已断开）')
        } finally {
          tc.runtime.releaseSend(holder)
        }
        return { ok: true, reason: 'sent', lines: [] }
      }

      // listen 编译（非法正则 → 可读拒绝，不 throw）。
      let listen: ListenOpts
      try {
        listen = compileListen(args.listen)
      } catch (e) {
        return reject((e as Error).message)
      }

      // 长程命令判据预设（§8.7）：模型未显式给 listen 且 cmd 命中预设表 ⇒ 注入
      // 完成句判据（受理帧 GA 不再关窗，等完成句跨批命中；A.3 长程命令无 GA）。
      // 显式 listen 整体覆盖预设 ⇒ profile 一并不适用（timeout 同步回归标准缺省）。
      const profile = args.cmd !== undefined && Object.keys(listen).length === 0
        ? matchLongCmdProfile(args.cmd)
        : null

      // timeoutMs 钳制（§8.7）：模型显式值钳上限 MAX_TIMEOUT_MS；缺省 = 预设兜底
      //（系统注入值，豁免钳制——until 是主收束）或 sendTimeoutMs。
      let timeoutMs: number
      if (args.timeoutMs !== undefined) {
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
          return reject('已拒绝：timeoutMs 必须为正整数')
        }
        timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS)
      } else {
        timeoutMs = profile !== null
          ? profile.timeoutMs
          : Math.min(c.defaults.sendTimeoutMs, MAX_TIMEOUT_MS)
      }

      // 会话级持有者：同一时刻只允许一个执行体在 send+read（冲突可读拒绝，不劈半）。
      const holder = String((exec.agent as ToolAgent | undefined)?.id ?? '')
      if (!tc.runtime.acquireSend(holder)) {
        return reject(tc.runtime.sendHolderId === 'combat' ? COMBAT_HOLDING_ERROR : HOLDER_BUSY_ERROR)
      }
      try {
        const bare = args.cmd === undefined
        // 读后投影的窗口起点（§8.7）：send 时刻之后写入的条目才算本窗口刷新证据。
        const sendAt = Date.now()
        if (args.cmd !== undefined && !tc.runtime.send(args.cmd)) {
          return reject('已拒绝：发送失败（连接可能已断开）')
        }
        // initial：有 cmd = 空（acc 只收 send 后新行）；裸读 = pending 尾部快照
        //（不物理消费，范围含接入前的录制行）。
        const initial = bare ? tc.runtime.recentLines(c.defaults.sendMaxLines) : []
        // 缺省判据（§8.7）：有 cmd = 命中长程预设表 ⇒ 完成句判据（timeout 用预设
        // 兜底值）；未命中 ⇒ gaCount:1 + maxLines 兜底。裸读 = maxLines + 短静默
        // 窗口。模型显式给 listen 时整体覆盖缺省（预设同理被覆盖）。
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
                ? (profile !== null
                    ? profileListen(profile)
                    : { gaCount: 1, maxLines: c.defaults.sendMaxLines })
                : listen),
            }
        const r = await tc.runtime.read(opts, initial)
        // 读后投影（§8.7）：拉取命令收窗后附 world 语义分区快照（零解析重复）；
        // 窗内零写入 ⇒ 不带字段 fail-open 回原文。wait:false 与裸读不投影
        //（前者已提前返回，后者无 cmd 不命中档案）。
        const lines = r.lines.map(l => l.text)
        if (args.cmd !== undefined && STATE_PULL_CMD_RE.test(args.cmd.trim())) {
          const world = projectStateZones(c.stateOf(tc.sessionId).world, sendAt)
          if (world !== null) return { ok: true, reason: r.reason, lines, world }
        }
        return { ok: true, reason: r.reason, lines }
      } finally {
        tc.runtime.releaseSend(holder)
      }
    },
  }

  const mudWalk: MudToolDefinition = {
    name: 'mud_walk',
    description:
      '沿内建路径自动行走（T23；须站在带出发点标记的房间）。已知目的地优先用它，'
      + '比逐步发方向命令高效且不绕路。action 缺省 walk——args 传：'
      + '"<拼音名>" 走到目标区域（如 xiangyang，区域列表见出发房间的 walk 表）；'
      + '"-c" 查当前区域的内建路径出发点；"-c <拼音名>" 查具体地点路径；'
      + '"-q <区域中文名>" 查当前区域到其他区域的路径；'
      + '"-p" 行走中途停下（频繁使用影响任务奖励，慎用）；'
      + '缺省 = 恢复中途停下的行走。action: "speed" + value = 调整行走速度（-1 奔跑 / 1 正常 / 2 慢行 / 3 缓步）。'
      + '行走是多步连续输出，工具等行走静默后一次性返回全程行文原文，'
      + '并在 outcome 给出结果分类：arrived 到达 / soft-stop 中途停下（可用无参 walk 继续）/ '
      + 'hard-stop 同位置连续两次停下（**停手**：换路或查通过手段，别硬重试）/ '
      + 'unaccepted 不在出发点（返回里列出本区域全部起点，需自己走过去，可用 localmaps 查方位）/ '
      + 'incomplete 未判定。若 reason 为 "danger"（被战斗打断），战斗结束后可用无参 walk 继续走完。',
    isConcurrencySafe: () => false, // walk 是多步 send 的组合，独占（谓词恒 false）
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['walk', 'speed'], description: "动作；缺省 'walk'（沿内建路径行走）· 'speed' 调行走速度（配 value）" },
        args: { type: 'string', description: 'action:walk 的参数（拼音名 / -c / -c 拼音名 / -q 区域中文名 / -p）；缺省 = 恢复行走' },
        value: { type: 'string', description: "action:speed 的速度值：-1 奔跑 / 1 正常 / 2 慢行 / 3 缓步" },
        timeoutMs: { type: 'integer', minimum: 1, description: '总超时毫秒；缺省取 max(sendTimeout, 30s)（长路线需时更久）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          outcome: { type: 'string', description: '行走结果分类（T23.5）：arrived / soft-stop / unaccepted / incomplete' },
          departures: { type: 'array', items: { type: 'string' }, description: 'unaccepted 时本区域的路径起点列表（需自己走过去；可用 localmaps 查方位）' },
          blocked: { type: 'object', description: '阻断档案（T23.11）：{attempts, hard, at}——同位置软阻断连击 ≥2 判 hard（outcome=hard-stop），此时**停手**：换路或查通过手段' },
          region: { type: 'string', description: '当前区域（World location.区域；未知则不带）' },
          hint: { type: 'object', description: '`-q` 参考链解析：{to, via}（只有参考意义，不是可执行序列）' },
          suggest: { type: 'object', description: '用已记录的行走知识给出的下一跳建议：{dest, pinyin, steps}；无解则不带' },
          path: { type: 'object', description: '`walk -c <拼音名>` 的区域内方向序列：{to, directions[], short?}（**可执行**的最后一程）' },
          lines: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        const v = value as MudWalkResult
        if (!v.ok) return [{ type: 'text', text: v.error }]
        return [{ type: 'text', text: v.lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as { action?: string; args?: string; value?: string; timeoutMs?: number }
      const c = core()
      if (c === null) return reject(CORE_ABSENT_ERROR)
      const tc = c.toolContextFor(exec.agent as ToolAgent | undefined)
      if (tc === null) return reject(NOT_BOUND_ERROR)
      if (tc.runtime.connState !== 'connected') return reject(NOT_CONNECTED_ERROR)

      // action 分派（T23.9）：未知动作拒；预留槽位拒（node 家族本期不实现，A.9 结论 9）。
      const action = args.action ?? 'walk'
      const known = [...WALK_ACTIONS, ...WALK_RESERVED_ACTIONS] as readonly string[]
      if (!known.includes(action)) {
        return reject(`已拒绝：未知 action '${action}'（可用：${WALK_ACTIONS.join(' / ')}）`)
      }
      if ((WALK_RESERVED_ACTIONS as readonly string[]).includes(action)) {
        return reject(`已拒绝：action '${action}' 本期未实现（玩家自建路径不保证成功），跨区域行动请用 action:'walk'`)
      }

      // 命令拼装：命令字符串归本层（D17）——walk 族与 speed 各自成句。
      let cmd: string
      let walkArgs = ''
      if (action === 'speed') {
        const v = (args.value ?? '').trim()
        if (!WALK_SPEED_RE.test(v)) {
          return reject(`已拒绝：action:'speed' 需要 value（整数 ${WALK_SPEED_MIN}..${WALK_SPEED_MAX}，即 set walk_speed <值>）`)
        }
        const n = Number.parseInt(v, 10)
        if (n < WALK_SPEED_MIN || n > WALK_SPEED_MAX) {
          return reject(`已拒绝：walk_speed 取值须在 ${WALK_SPEED_MIN}..${WALK_SPEED_MAX}`)
        }
        cmd = `set walk_speed ${n}`
      } else {
        // 参数面：args 只允许单条 walk 参数（堵 "扬州;suicide" 类拼接——walk 前缀
        // 使 deny 扫描失效，故在此显式堵拼接符）。
        if (args.args !== undefined) {
          walkArgs = args.args.trim()
          if (/[;\n\r]/.test(walkArgs) || walkArgs.length > 60) {
            return reject('已拒绝：args 必须是单条 walk 参数（拼音名 / -c / -q 区域 / -p），禁止分号或换行')
          }
        }
        cmd = walkArgs === '' ? 'walk' : `walk ${walkArgs}`
      }

      // 行走类 / 查询类分派（判据注入与精力闸共用同一判定）。
      const isWalkAction = action === 'walk'
      const isQuery = isWalkAction && WALK_QUERY_RE.test(walkArgs)

      // 精力闸（T23.10 D16，判据出处 A.9 结论 7 + 用户裁定）：行走前看
      // `vitals.精力 / 最大精力`（百分比判据；精力可为上限的 200%）。未知 ⇒ 放行
      // （`vitals` 尚未写入时不因"不知道"卡死导航）。查询与 speed 不是行动，不受闸门。
      if (isWalkAction && !isQuery) {
        const below = belowStaminaFloor(
          tc.runtime.worldEntry(STAMINA_ZONE, STAMINA_CUR_KEY)?.value,
          tc.runtime.worldEntry(STAMINA_ZONE, STAMINA_MAX_KEY)?.value,
          c.defaults.staminaFloorPct,
        )
        if (below === true) {
          return reject(`已拒绝：精力不足（低于 ${Math.round(c.defaults.staminaFloorPct * 100)}%），暂不行走——先恢复精力再试`)
        }
      }

      // timeoutMs：缺省 = max(sendTimeout, WALK_MIN_TIMEOUT_MS)，上限同 mud_send。
      let timeoutMs: number
      if (args.timeoutMs !== undefined) {
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
          return reject('已拒绝：timeoutMs 必须为正整数')
        }
        timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS)
      } else {
        timeoutMs = Math.min(Math.max(c.defaults.sendTimeoutMs, WALK_MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      }

      // 持有者/发送/读序与 mud_send 的 send+read 路径一致（独占、可读拒绝不劈半）。
      const holder = String((exec.agent as ToolAgent | undefined)?.id ?? '')
      if (!tc.runtime.acquireSend(holder)) {
        return reject(tc.runtime.sendHolderId === 'combat' ? COMBAT_HOLDING_ERROR : HOLDER_BUSY_ERROR)
      }
      try {
        if (!tc.runtime.send(cmd)) {
          return reject('已拒绝：发送失败（连接可能已断开）')
        }
        // 判据预设（§8.7）：行走类注入到达/失败判据；查询类（-c/-q）与 speed 只静默窗
        // ——查询答复含"未受理"同族句，注入会把正常查询误判为 unaccepted。
        const listen = compileListen({
          ...(isWalkAction && !isQuery ? { until: [...WALK_UNTIL], failOn: [...WALK_FAILON] } : {}),
          quietMs: WALK_QUIET_MS,
          maxLines: c.defaults.sendMaxLines,
        })
        const r = await tc.runtime.read({ ...listen, timeoutMs, signal: exec.signal }, [])
        let outcome = isWalkAction ? walkOutcome(r.reason) : undefined
        const lines = r.lines.map(l => l.text)
        const region = stringValue(tc.runtime.worldEntry('location', '区域')?.value)
        // 「在出发点」判定（**反证**，用户裁定 2026-10-08）：看本次调用有没有**正向证据**——
        //   表类（无参 `walk` / `-c`）出路径表；行走类（`walk <拼音名>` / `-p`）出受理行。
        //   没有正向证据 ⇒ 不在出发点（写 `出发点就绪=false`）；`-q` / `-c <拼音名>` 与出发点无关 ⇒ 不判定。
        //   不用单行"拒绝行文"判据（与 `-c` 同族、易误判）。
        const table = parseWalkTable(lines)
        const started = lines.some(l => WALK_STARTED_RE.test(l))
        const judgesDeparture = isWalkAction
          && (walkArgs === '' || walkArgs === '-c' || !isQuery)
        if (judgesDeparture) {
          // 正向证据两类取并：出路径表（表类）或出受理/继续行（行走类、无参恢复）。
          const atDeparture = table.edges.length > 0 || started
          tc.runtime.writeNavWorld('location', '出发点就绪', atDeparture)
          // 行走类且"既没受理也没到达也没软阻断" ⇒ 静默收束其实是"没走出去"
          if (!atDeparture && outcome === 'incomplete' && r.reason === 'quiet') outcome = 'unaccepted'
        }
        // 未受理 ⇒ 顺手把本区域起点结构化回给 agent（World `location.出发点`，T23.6）。
        const departures = outcome === 'unaccepted'
          ? stringArray(tc.runtime.worldEntry('location', '出发点')?.value)
          : undefined
        // 阻断档案（T23.11，A.9 结论 12）：**硬阻断没有专有行文**——用户定义是
        // "同位置连续两次 walk 都无法继续前进" ⇒ 判定 = 同位置软阻断连击 ≥ 2。
        // 计数是会话相关的（"我在这儿连着没走成"）⇒ 落 World `nav.*`（kind:'nav'，断线复位）；
        // 处置 = **回给 agent 并停手**（不重试、不换路），"通过手段"逐步积累（字段留位）。
        let blocked: { attempts: number; hard: boolean; at: string | null } | undefined
        if (isWalkAction) {
          const verdict = nextBlocker({
            attempts: numberValue(tc.runtime.worldEntry('nav', '软阻断连击')?.value) ?? 0,
            at: stringValue(tc.runtime.worldEntry('nav', '软阻断位置')?.value) ?? null,
          }, region, outcome)
          tc.runtime.writeNavWorld('nav', '软阻断连击', verdict.attempts)
          if (verdict.at !== null) tc.runtime.writeNavWorld('nav', '软阻断位置', verdict.at)
          tc.runtime.writeNavWorld('nav', '硬阻断', verdict.hard)
          if (verdict.hard && outcome === 'soft-stop') outcome = 'hard-stop'
          if (verdict.attempts > 0) blocked = { attempts: verdict.attempts, hard: verdict.hard, at: verdict.at }
        }
        // 记录 + 建议（T23.10b，用户裁定"不加动词"）：把本次行文并入行走知识图
        // （路径表 ⇒ 边、`-q` ⇒ 参考链；找不到东西就什么都不记），并把
        // **我在哪（region）/ 参考链（hint）/ 下一跳建议（suggest）** 结构化回给 agent
        // ——每到一个新地点由 agent 自己再查一次，服务不存分段进度。
        const navFace = nav()
        if (navFace !== null) navFace.record({ ...(region !== undefined ? { region } : {}), lines })
        const hint = navFace !== null ? navFace.hintOf(lines) : null
        const suggest = navFace !== null && hint !== null ? navFace.suggest(region, hint.to) : null
        // `walk -c <拼音名>` ⇒ 区域内方向序列（**可执行**的最后一程，A.9 结论 11）。
        const path = parseDirectionPath(lines)
        return {
          ok: true, reason: r.reason,
          ...(outcome !== undefined ? { outcome } : {}),
          ...(departures !== undefined ? { departures } : {}),
          ...(blocked !== undefined ? { blocked } : {}),
          ...(region !== undefined ? { region } : {}),
          ...(hint !== null ? { hint } : {}),
          ...(suggest !== null ? { suggest } : {}),
          ...(path !== null
            ? { path: { to: path.to, directions: [...path.directions], ...(path.short !== undefined ? { short: path.short } : {}) } }
            : {}),
          lines,
        }
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

  // 注册完整性自检：登记实际注册的工具名，注册后断言四工具全部过 registrar。
  const registered = new Set<string>()
  const recording: ToolRegistrar = {
    register: def => {
      registered.add(def.name)
      return registrar.register(def)
    },
  }
  const disposers = [mudConnect, mudSend, mudWalk, mudState].map(def => recording.register(def))
  const missing = ['mud_connect', 'mud_send', 'mud_walk', 'mud_state'].filter(n => !registered.has(n))
  if (missing.length > 0) throw new Error(`mud-core3 注册完整性自检失败：本层未注册 ${missing.join('/')}`)
  return disposers
}
