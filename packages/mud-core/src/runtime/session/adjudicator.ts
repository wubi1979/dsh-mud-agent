/**
 * dsh-mud-core — 会话裁决器 (SessionAdjudicator), host half. 会话层。
 *
 * 行流与元事件 (GA/EOR) 的**唯一入口**, 五站消费链的唯一执行者 (v0.9 W7.1 等价迁移:
 * 消费链自 session.onFrameCommitted 上移, 分帧器 FrameSplitter 并入本文件成为行流
 * 缓冲半区; 行为零变更):
 *
 * ```
 *   行流 (telnet 'parsed' 行)  ─┐
 *   元事件 (GA/EOR 边界)       ─┴→ 行流缓冲半区 (开放帧累积 + 武装标记 + 内存阀/装配阀)
 *        → 帧提交 (commit) → 五站链 (站序严格不变 — 禁止重排):
 *            ① state 折叠 → state 落库
 *            ② event 规则 → direct-exec 直发 / park 待人工 / admit 打断准入
 *            ③ 在途结算   → 在途窗口表 (帧并集 + GA/EOR 关窗 + win- 判据标记路由)
 *            ④ 流程判据   → 唤醒/打断/排队
 *            ⑤ 残余记账   → 投递视图 (批次/recall) + 投递节拍 (settle)
 * ```
 *
 * **帧归属取样契约**: `inFrame` ("提交时点是否在在途窗口内", §2.3 帧并集判据) 必须
 * 在站③之前取样 —— GA/EOR 关窗结算会翻转 `windows.hasOpen()`; 站④使用③前取样值。
 *
 * 不变量: I5 每行恰被认领一次 (折叠/直发/抓取/投递); I6 一个结算点 ≤ 一条投递消息
 * (standalone 先于批次); I7 多行状态机 (engine 求值器); I8 计时器全归本类 (settle
 * 重试 / hold 兜底 / 帧装配阀)。
 *
 * 职责边界: 本类持有行流缓冲、武装标记、投递记账 (pending/pendingActions/standalone/
 * consumeTo/recallLines/deliveredAbs) 与全部会话内计时器; **不持有** agent、传输连接、
 * T1 adapter、会话日志与人工交互状态 (awaitingHuman/externalValues 归壳, 经 deps 回调
 * 只读写)。投递副作用由 deps 的薄回调执行 (state/queue/channel/log/debug/decision)。
 * @module @deepseek-ai/dsh-mud-core/runtime/session/adjudicator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { ownedGameMessage } from '../../agents/lane.ts'
import type { MudTools } from '../../agents/tools.ts'
import { evaluateToolCall } from '../../services/gate/policy.ts'
import type { GateRules } from '../../services/gate/rules.ts'
import type { MudLine } from '../../services/network/ansi.ts'
import { textOfLines } from '../../services/network/ansi.ts'
import { lineCriteriaPattern } from '../../services/matcher/criteria.ts'
import type { PerceptionRule } from '../../perceive/types.ts'
import { PerceptionEngine, type EngineHit } from '../../perceive/engine.ts'
import { splitDelivery } from '../../perceive/split.ts'
import { InflightWindowTable, type ReplySettle } from './inflight.ts'
import { DeliveryChannel } from './delivery-channel.ts'
import { CommandQueue } from './queue.ts'
import { StateService } from './state-track.ts'
import { FlowRuntime } from '../flow/flow.ts'
import type { FlowActionHit } from '../flow/flow-types.ts'
import {
  actionOf,
  EMPTY_COMMANDS,
  fillSlots,
  MAX_INJECT_TAIL_CHARS,
  MAX_INJECT_TAIL_LINES,
  MAX_PARKED_LINES,
  MAX_SETTLE_LINES,
  parseDeliveryCallId,
  type ActionRequest,
  type MudDecisionRecord,
  type MudRuntimeConfig,
} from './types.ts'

/** T1 通道允许 (模式 `t1`/`full`): 规则/流程驱动的确定性动作走 agent 管道。 */
const t1Allowed = (mode: MudRuntimeConfig['agentMode']): boolean => mode === 't1' || mode === 'full'
/** T2 通道允许 (模式 `t2`/`full`): 行批次/控制唤醒进真实 LLM 回合。 */
export const t2Allowed = (mode: MudRuntimeConfig['agentMode']): boolean => mode === 't2' || mode === 'full'

// ── 行流缓冲半区 (原 frame-splitter.ts, W7.1 等价并入; 导出仅为测试对齐保留) ────

/** 帧提交标记: ga/eor (主边界) / armed (武装判据命中) / valve (帧内存阀)。 */
export type FrameMarker = 'ga' | 'eor' | 'armed' | 'valve'

/** 提交后的帧: 消费链 (五站) 的唯一输入。 */
export interface MudFrame {
  /** 帧行 (含标记行)。 */
  lines: MudLine[]
  /** 帧纯文本 (lines 的 textOfLines)。 */
  text: string
  /** 提交标记。 */
  marker: FrameMarker
  /** marker==='armed' 时的标记 id (事务/流程对账用)。 */
  markerId?: string
}

/** 武装标记声明 (§8.1 判据)。 */
export interface ArmedMarkerSpec {
  /** 标记 id (调用方提供, 用于对账与注销; 如 `win-3:ok` / 流程步判据 id)。 */
  id: string
  /** 判据: 锚定整行正则 (逐行测, P1-2 语义)。 */
  pattern: string | RegExp
  /** 一次性: 命中提交后自动注销 (事务判据缺省 true; 常驻标记写 false)。 */
  once?: boolean
}

/** 已编译的武装标记 (内部)。 */
interface ArmedMarker extends ArmedMarkerSpec {
  re: RegExp | null
}

export interface FrameSplitterOptions {
  /** 帧内存阀行数 (§8.6; 缺省 256)。 */
  maxFrameLines?: number
  /** 自动 flush 延迟 (ms): feedLines 非空时排定时器, 到点提交 valve 帧。
   *  缺省 50ms — 真实网络 GA 几乎总在 50ms 内到达 → boundary() 会 clear;
   *  无 GA 异常场景 50ms 兜底。设 0 禁用。 */
  autoFlushMs?: number
  /** 日志。 */
  onLog?: (text: string) => void
}

/**
 * 行流缓冲半区 (原"分帧器", v0.6.0 §8; W7.1 起为裁决器的内部组件, 导出仅为
 * frame-splitter.spec / response.spec 的测试对齐保留): 行流在何处切帧、帧何时提交,
 * 只由两类**标记**决定 —— GA/EOR (八成, 常驻缺省) 与声明判据 (十成, 武装标记)。
 * 静默/超时不是边界 (v0.6.0 删除): 超时 = 放弃等待, 由事务表处理 (§8.4); 帧的提交
 * 只发生在标记命中或内存阀 (§8.6, 防 OOM 保险) 触发时。
 *
 * 武装标记 (§8.5): 凡需要被响应的语句 (打断规则 / 流程入口 driver / 流程步
 * ok·fail / 事务 expect) 都注册为标记, 命中即提交帧。§19 的 arming 集与这里的
 * 标记表是同一张表 —— GA 是常驻缺省标记, 不在本表登记 (边界事件由宿主直送
 * `boundary()`)。
 *
 * 计时/网络节奏零依赖 (I7): 归属只由行序列决定, 不看行到达的时间窗。
 */
export class FrameSplitter {
  /** 帧提交出口: 裁决器接线 (五站链入口)。 */
  onFrame: ((frame: MudFrame) => void) | undefined

  private readonly maxFrameLines: number
  private readonly autoFlushMs: number
  private readonly onLog: ((text: string) => void) | undefined
  /** 当前开放帧 (标记之间的行累积)。 */
  private open: MudLine[] = []
  private armed: ArmedMarker[] = []
  /** 自动 flush 定时器 (feedLines 非空时排, boundary/reset/commit 时 clear)。 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: FrameSplitterOptions = {}) {
    this.maxFrameLines = options.maxFrameLines ?? 256
    this.autoFlushMs = options.autoFlushMs ?? 50
    this.onLog = options.onLog
  }

  // ── 宿主接口 ───────────────────────────────────────────

  /** 喂入一个文本块的行 (telnet 'parsed' 粒度): 累积进开放帧, 逐行测武装标记。 */
  feedLines(lines: readonly MudLine[]): void {
    if (lines.length === 0) return
    for (const line of lines) {
      this.open.push(line)
      const hit = this.testLine(line)
      if (hit !== null) {
        // 命中行(含)之前的行定格为帧; **继续处理本批剩余行** (它们属于下一开放帧,
        // 不得丢弃 — I5 每行恰投一次)。
        this.commit(this.open.length - 1, 'armed', hit)
        continue
      }
      if (this.open.length >= this.maxFrameLines) {
        this.onLog?.(`[分帧] 帧内存阀触发 (${this.open.length} 行), 提交无标记帧 (§8.6)`)
        this.commit(this.open.length - 1, 'valve')
      }
    }
    // 自动 flush 兜底 (非空帧, 无标记到达时提交 valve 帧)。
    if (this.open.length > 0 && this.flushTimer === null && this.autoFlushMs > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        if (this.open.length > 0) this.commit(this.open.length - 1, 'valve')
      }, this.autoFlushMs)
    }
  }

  /** 主边界 (telnet 'boundary' 事件): GA/EOR 常驻缺省标记, 命中即提交。
   *  即使开放帧为空也要提交 (空 GA 帧) — 让宿主知道"这条请求的边界到了, settle 空帧"。 */
  boundary(kind: 'ga' | 'eor'): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    // 空帧也要提交 — 让宿主桥知道 boundary 到达 (有 live reply 时需要 settle)。
    this.commit(this.open.length - 1, kind)
  }

  /**
   * 注册武装标记 (§8.5)。**arming 即测**: 开放帧里的既有行若已命中 (重试重挂、
   * 流程换步时完成句已在帧内), 当场提交 —— 与流程"同批行优先"同语义。
   * @returns 标记 id (非法正则时同样返回, 但标记永不命中并留痕一次)。
   */
  arm(spec: ArmedMarkerSpec): string {
    const re = compile(spec.pattern)
    if (re === null) {
      this.onLog?.(`[分帧] 武装标记正则非法, 永不命中: ${spec.id}`)
    }
    this.armed.push({ ...spec, re })
    if (re !== null) {
      const idx = this.open.findIndex(line => testRe(re, line.text))
      if (idx !== -1) {
        this.commit(idx, 'armed', spec.id)
      }
    }
    return spec.id
  }

  /** 注销武装标记 (事务结算/放弃重挂/流程复位/断线时调用)。幂等。 */
  disarm(id: string): void {
    this.armed = this.armed.filter(m => m.id !== id)
  }

  /** 重连复位: 清开放帧与全部武装标记 + flush 定时器。 */
  reset(): void {
    this.open = []
    this.armed = []
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
  }

  /**
   * v0.6.0 S3b-1: 强制提交当前开放帧 (无标记, marker='valve')。
   * 用于 scheduleSettle 兜底 —— 没有 GA/武装标记时, 让帧也能提交跑感知/投递。
   * 空帧不提交 (避免无效回调)。
   */
  flush(): void {
    if (this.open.length === 0) return
    this.commit(this.open.length - 1, 'valve')
  }

  /** 诊断: 开放帧行数 / 武装标记数 (I9 观测面)。 */
  stats(): { openLines: number; armed: number } {
    return { openLines: this.open.length, armed: this.armed.length }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** 单行武装标记测试 (同类多命中按声明顺序取首, I13)。 */
  private testLine(line: MudLine): string | null {
    for (const m of this.armed) {
      if (m.re !== null && testRe(m.re, line.text)) return m.id
    }
    return null
  }

  /**
   * 提交: `endIdx` (含) 之前的行定格为帧, 之后的行留作下一开放帧。
   * 提交是**同步单遍**的: `onFrame` (消费链) 里再次 arm/feed 引发的连锁提交,
   * 每次至少消费掉标记行一行, 故必然终止。
   */
  private commit(endIdx: number, marker: FrameMarker, armedId?: string): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    const lines = this.open.slice(0, endIdx + 1)
    this.open = this.open.slice(endIdx + 1)
    if (marker === 'armed') {
      const m = this.armed.find(x => x.id === armedId)
      if (m !== undefined && m.once !== false) this.disarm(armedId!)
    }
    const frame: MudFrame = { lines, text: textOfLines(lines), marker }
    if (armedId !== undefined) frame.markerId = armedId
    this.onFrame?.(frame)
  }
}

/** 编译锚定整行正则 (字符串只编译一次; 非法 → null, 调用方留痕)。 */
function compile(pattern: string | RegExp): RegExp | null {
  if (pattern instanceof RegExp) return pattern
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/** 逐行测试 (P1-2: 锚定整行正则须逐行测, 多行串上 ^…$ 恒 false)。 */
function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0
  return re.test(text)
}

// ── 裁决器 ─────────────────────────────────────────────

/**
 * 触发规则注册声明 (v0.9 W7.3 唯一注册入口, §8.5/§8.8 注册表)。
 *
 * 全部触发规则只经 `SessionAdjudicator.register()` 进裁决器 —— ① state 桶 /
 * ② event 桶 (含 direct:true 直发与 interrupts 打断档位) 在此投影为感知引擎与
 * 打断常驻标记, direct 门禁规则在此落位, ④ flow arming 经 `flow.syncArming()`
 * 全量重放 (onArmSync → syncFlowMarkers); ③ 在途窗口与 ⑤ 批次投递参数分别走
 * 窗口表动态注册与 `deps.config`, 不在声明内。**重连 reset → register() 重挂
 * 一次** (打断标记 + flow arming + 引擎重建), 替换旧实现的散点补刀。
 */
export interface AdjudicatorRegistration {
  /** ① state 桶 (命中折叠进 world, 不进 agent)。 */
  stateRules: readonly PerceptionRule[]
  /** ② event 桶 (含 direct:true 直发 / interrupts 打断档位 / awaitExternal 人工挂起)。 */
  eventRules: readonly PerceptionRule[]
  /** holdDelivery 规则 id 集 (投递原子性判据)。 */
  holdRuleIds: ReadonlySet<string>
  /** direct 出口的门禁规则 (direct-exec 判定; 类别②的执行体参数, §7)。 */
  gateRules: GateRules
}

/** 裁决器依赖 (壳注入; 人工交互状态与出口副作用留在壳, 经回调读写)。 */
export interface AdjudicatorDeps {
  /** 官方会话 id (投递消息 lane 归属)。 */
  sessionId: string
  /** 运行时配置 (agentMode / t2DeliverIntervalMs / bridgeSilenceMs / holdTimeoutMs)。 */
  config: MudRuntimeConfig
  /** 在途窗口表 (站③在途结算; W7.2 取代命令-应答桥)。 */
  windows: InflightWindowTable
  /** 流程运行时 (站④判据求值 + 排队/打断判定; arming 变化经 onArmSync 通知本类)。 */
  flow: FlowRuntime
  /** 投递通道 (defer 槽/账本/T2 时刻; 分投器 W7.3 前的机制层)。 */
  channel: DeliveryChannel
  /** 命令队列 (direct 直发 / 打断 onInterrupt)。 */
  queue: CommandQueue
  /** 感知状态服务 (站① state 折叠落库)。 */
  state: StateService
  /** 会话工具集 (direct-exec 执行体; 惰性取, 壳持缓存)。 */
  tools: () => MudTools
  /** 触发规则注册声明 (构造时经 `register()` 注册; 重连/断线后 `register()` 重挂)。 */
  registration: AdjudicatorRegistration
  /** 该会话当前 live agent (只读解析)。 */
  agentOf: () => Agent | undefined
  /** agent 装配是否就绪 (缺省就绪语义在壳实现)。 */
  agentReady: () => boolean
  /** 是否处于人工环节 (投递门: 等验证码期间投递暂停)。 */
  isAwaitingHuman: () => boolean
  /** 连接是否存在 (direct-exec 前置)。 */
  hasConnection: () => boolean
  /** 缺失的外部占位符名 (待人工回填; externalValues 归壳)。 */
  missingExternalValues: (keys: readonly string[]) => readonly string[]
  /** 待人工动作挂起 (壳: pendingExternal 同类去重 + enterHumanWait)。 */
  parkForHuman: (request: ActionRequest, keys: readonly string[]) => void
  /** 运行日志。 */
  log: (text: string) => void
  /** 调试日志。 */
  debug: (channel: 'network' | 'perception' | 'send' | 'runtime', text: string) => void
  /** 决策记录。 */
  decision: (record: MudDecisionRecord) => void
  /** 世界变化入口 (看门狗重评估 + 流程入口重算; 壳唯一入口)。 */
  onWorldChange: () => void
}

/**
 * 会话裁决器: 行流 + 元事件唯一入口, 五站链 + 投递记账 + 投递节拍。
 * 每会话一实例 (I8: 无模块级状态); 生命周期随壳 (session.ts) —— 重连由壳调
 * `resetForReconnect()` / `abortForDisconnect()`, 释放由壳调 `dispose()`。
 */
export class SessionAdjudicator {
  private readonly deps: AdjudicatorDeps
  /** 行流缓冲半区 (开放帧 + 武装标记 + 内存阀/装配阀)。 */
  private readonly splitter: FrameSplitter
  /** 触发规则注册声明 (register 幂等重挂的依据; §1.2 唯一注册入口)。 */
  private registration!: AdjudicatorRegistration
  /** L1 行级感知引擎 (register 投影; 多行状态机宿主; 站①②求值器)。 */
  private engine!: PerceptionEngine
  /** direct 出口的门禁规则 (registration.gateRules)。 */
  private gateRules!: GateRules
  /** 已挂的打断常驻标记 id (register 重挂时先清旧, 幂等)。 */
  private interruptMarkerIds: string[] = []
  /** L2 待决行 (未投递的文本块行 = 单流切分的 segment 缓冲)。 */
  private readonly pending: MudLine[] = []
  /**
   * 待投递的**动作请求** (规则命中 / 流程步动作)。
   * 随下一条投递消息一起走 (`source.actions`)，T1 据此渲染 tool-call (`doc/ARCHITECTURE.md` §7)。
   */
  private pendingActions: ActionRequest[] = []
  /**
   * 动作投递队列 (暂存的"无行可带"动作消息): 帧内命中 / 人工回填后的答案等 ——
   * 它们的锚点行不在待决缓冲里，需要自己一条消息投出去。
   */
  private standalone: { text: string; actions: ActionRequest[] } | null = null
  /** 已消费边界 (最后一次带动作命中的锚点 abs; -1 = 无)。 */
  private consumeTo = -1
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** §8.5: 当前由流程布防同步来的武装标记 id (flow-arm:*; 全量替换同步)。 */
  private readonly flowMarkerIds = new Set<string>()
  private readonly recallLines: { text: string; abs: number }[] = []
  /** 已投递给模型的最大行 abs (交付水位): recall 只回看其后的行, 保证 session 不重复。 */
  private deliveredAbs = -1
  /** 缺陷计数 (不变量 I9): 遗留段丢弃 / hold 超时释放。 */
  private readonly counters = { hitsDropped: 0, carryDropped: 0, holdReleases: 0 }
  private disposed = false

  constructor(deps: AdjudicatorDeps) {
    this.deps = deps
    // 行流缓冲: 静默窗 (bridgeSilenceMs) 降级为**网络装配粒度** (§8.7): 无标记到达时
    // 到点提交 valve 帧兜底走消费链; 消费边界只认标记 (GA/EOR/武装判据)。
    this.splitter = new FrameSplitter({
      autoFlushMs: deps.config.bridgeSilenceMs,
      onLog: (t) => deps.debug('perception', t),
    })
    this.splitter.onFrame = (frame) => this.adjudicate(frame)
    // 触发规则注册 (唯一入口): state/event 桶投影 + 打断常驻标记 + flow arming 重放。
    this.register(deps.registration)
  }

  // ── 注册 (触发规则唯一入口; §1.2) ───────────────────────

  /**
   * **注册全部触发规则** (§8.5/§8.8; v0.9 W7.3 收口)。
   *
   * - ① state 桶 / ② event 桶 → 新建 PerceptionEngine 投影 (多行状态机随实例重建 =
   *   复位, I8);
   * - ②' 打断常驻标记: 从 event 桶派生 `interrupts` 规则 (先清旧再挂, register 幂等);
   * - direct 门禁规则落位 (站② direct-exec 判定用);
   * - ④ flow arming: `flow.syncArming()` 全量重放 → onArmSync → `syncFlowMarkers`
   *   (流程布防的订阅接线由壳在 flow 构造时建立, 这里只驱动重放)。
   *
   * **重连 reset → register() 重挂一次**: 构造、`resetForReconnect()`、
   * `abortForDisconnect()` 三处都走本方法, 替换旧实现的散点补刀。注意 register 会
   * 清空行流缓冲外的全部规则态 —— 调用方须保证此时开放帧已复位 (重挂路径先
   * `splitter.reset()`), 否则"arming 即测"会当场提交开放帧残留行。
   */
  register(reg: AdjudicatorRegistration): void {
    this.registration = reg
    this.gateRules = reg.gateRules
    // ①② 规则投影: 每会话一个引擎实例 (I8); 重建 = 多行状态复位 (重连/断线语义)。
    this.engine = new PerceptionEngine({
      stateRules: reg.stateRules,
      eventRules: reg.eventRules,
      holdRuleIds: reg.holdRuleIds,
    })
    // ②' 打断常驻标记: 声明了 interrupts 的事件规则 → 行流武装 (命中 → 帧立即提交,
    // 站②打断/排队当场发生)。register 幂等: 先清旧标记再重挂。
    for (const id of this.interruptMarkerIds) this.splitter.disarm(id)
    this.interruptMarkerIds = []
    for (const rule of reg.eventRules) {
      if (rule.action?.interrupts === undefined) continue
      const pattern = lineCriteriaPattern(rule.match)
      if (pattern === null) continue
      const id = `rule-int:${rule.id}`
      this.splitter.arm({ id, pattern, once: false })
      this.interruptMarkerIds.push(id)
    }
    // ④ flow arming 全量重放 (幂等): 本调用若发生在壳构造器内, 回调时 `壳.adjudicator`
    // 尚未赋值, onArmSync 被可选链吞掉 (由壳构造器末尾的 syncArming 补上); 重连/断线
    // 重挂路径 (resetForReconnect/abortForDisconnect) 时壳已就绪, 这里直接生效。
    this.deps.flow.syncArming()
  }

  // ── 入口 (行流 + 元事件) ───────────────────────────────

  /** 行流入口 (telnet 'parsed' 粒度): 进缓冲半区, 逐行测武装标记。 */
  feedLines(lines: readonly MudLine[]): void {
    this.splitter.feedLines(lines)
  }

  /** 元事件入口 (telnet 'boundary'): GA/EOR 主边界, 命中即提交 (空帧也提交)。 */
  boundary(kind: 'ga' | 'eor'): void {
    this.splitter.boundary(kind)
  }

  // ── 武装标记 (打断常驻 / 流程布防 / 桥 until) ──────────

  /** §8.5 武装集同步 (FlowRuntime.onArmSync): 全量替换流程布防标记 ——
   *  天然兼容重连 (复位后一次重挂) 与布防收缩。`arm()` 的"arming 即测"处理
   *  换步时判据已命中开放帧行的情况 (当场提交, 重入安全)。 */
  syncFlowMarkers(markers: readonly { id: string; pattern: RegExp }[]): void {
    for (const id of this.flowMarkerIds) this.splitter.disarm(id)
    this.flowMarkerIds.clear()
    for (const marker of markers) {
      this.splitter.arm({ id: marker.id, pattern: marker.pattern, once: false })
      this.flowMarkerIds.add(marker.id)
    }
  }

  /** win- 武装标记注册 (窗口 confirmSent 武装后; §2 判据武装)。 */
  armWindowMarker(markerId: string, pattern: string | RegExp): void {
    this.splitter.arm({ id: markerId, pattern, once: true })
  }

  /** 窗口结算注销 win- 标记 (任何结算都注销, timeout/abort/error 后不能留脏标记)。 */
  disarmWindowMarker(markerId: string): void {
    this.splitter.disarm(markerId)
  }

  // ── 五站消费链 (站序严格不变 — 禁止重排) ────────────────

  /**
   * **帧提交点 = 消费链唯一入口** (§8.2)。缓冲半区每提交一帧, 五站按固定次序单遍
   * 过链; I5/I6 (每行恰投一次、一投递点 ≤ 一条消息) 由链的单遍结构保证。
   */
  private adjudicate(frame: MudFrame): void {
    const lines = frame.lines
    // 帧归属取样 (§2.3 帧并集判据): "提交时点是否在在途窗口内"。必须在 ③ 之前 ——
    // GA/EOR 关窗结算会翻转 hasOpen()。
    const inFrame = this.deps.windows.hasOpen()
    // ① 状态折叠 → world 落库。
    const result = lines.length > 0 ? this.engine.feed(lines) : null
    if (result !== null) {
      for (const hit of result.stateHits) {
        if (hit.data) this.deps.state.patch(hit.data, 'percept')
      }
      // 本帧折叠可能翻转 `logged_in` (state 规则) → 重评估看门狗起停 (见 watchdogs.ts)。
      if (result.stateHits.length > 0) this.deps.onWorldChange()
    }
    // ② 规则触发 → 动作/direct-exec: 直接执行类先跑 (命中行已折叠, 不进投递);
    //    其余命中 park (待人工) / admit (打断准入, I14/§19.4)。
    if (result !== null && result.directHits.length > 0) this.runDirectHits(result.directHits)
    const parkedRuleHits = result !== null ? this.parkExternalHits(result.hits) : []
    const readyRuleHits = this.admitRuleHits(parkedRuleHits, lines, inFrame)
    // ③ 在途结算 (W7.2): 行先入窗口表 (响应 = 在途窗口期间提交帧的并集, §2.3), 再按
    //    帧标记路由结算 —— GA/EOR 主边界关窗; armed 帧只有窗口判据标记 (win-*) 才结算
    //    窗口, 流程/打断标记 (flow-arm:*/rule-int:*) 只负责提交帧走链 (表内自解析 id)。
    this.deps.windows.feedLines(lines)
    if (frame.marker === 'ga' || frame.marker === 'eor') this.deps.windows.boundary(frame.marker)
    else if (frame.marker === 'armed' && frame.markerId !== undefined) {
      this.deps.windows.settleCriteria(frame.markerId, frame.lines.at(-1)?.text)
    }
    // ④ 流程判据 → 唤醒/打断/排队 (与静态规则同帧行; inFrame 用 ③ 前取样值)。
    const flowHits = lines.length > 0 ? this.deps.flow.offer(lines, inFrame) : []
    if (flowHits.length > 0) this.queueFlowActions(flowHits)
    // 结算 (onSettle) / 判据命中可能让流程到达终态 → 排队的动作此时出队投递。
    this.drainFlowQueue()
    // ⑤ 残余记账 → 投递视图 (批次/recall): 只记**可能投递给模型**的行 —— 折叠行
    //    (state 入库 / 直接执行) 已被处理过, `mud_recall` 不再倒出模型本看不到的原文。
    if (result !== null) {
      for (const line of lines) {
        if (result.foldedAbs.has(line.abs)) continue
        this.recallLines.push({ text: line.text, abs: line.abs })
        if (this.recallLines.length > 200) this.recallLines.shift()
      }
    }
    if (inFrame) {
      // 帧内 (I5/I6): 帧行不进待决 → 走在途窗口 (工具应答帧并集), **不进投递**; 命中不丢:
      // 当场**动作投递** (工具应答与游戏输出同源进 L1, 见 §4)。
      if (readyRuleHits.length > 0) {
        this.deliverStandalone(
          textOfLines(lines).trim(),
          readyRuleHits.map(hit => actionOf(hit.ruleId, hit.action)),
        )
      }
      this.noteDelivered(lines)
    } else {
      // 无主帧: 动作随本帧原文在一次原文投递里走 (行序与消费边界不变)。
      const requests = readyRuleHits.map(hit => actionOf(hit.ruleId, hit.action))
      if (requests.length > 0) this.pendingActions.push(...requests)
      if (result !== null && result.consumeTo > this.consumeTo) this.consumeTo = result.consumeTo
      for (const line of lines) {
        if (result !== null && !result.foldedAbs.has(line.abs)) this.pending.push(line)
      }
    }
    this.deps.debug('perception',
      `[感知] 帧消费 ${lines.length} 行 (${frame.marker}${frame.markerId !== undefined ? `:${frame.markerId}` : ''}, ` +
      `${inFrame ? '帧内' : '无主'}, 折叠 ${result?.foldedAbs.size ?? 0}, 规则命中 ${readyRuleHits.length}, ` +
      `流程动作 ${flowHits.length}, 待决 ${this.pending.length})`)
    // hold 门 (holdDelivery 投递原子性): GA/EOR 是权威边界, 无条件结算 (沿用旧 onBoundary
    // 语义); armed/valve 帧尊重捕获 hold —— 半截捕获留待决, 等捕获完成 (后续帧合并投出)
    // 或超时释放。
    if (frame.marker !== 'ga' && frame.marker !== 'eor' && (result?.holding ?? false)) {
      this.armHoldTimeout()
      this.deps.debug('perception', '[感知] holdDelivery: 多行捕获未完成, 本帧暂不投递')
      return
    }
    this.clearHoldTimer()
    this.settle()
  }

  // ── 站②: direct-exec / 待人工挂起 / 打断准入 ──────────

  /**
   * 执行本块的直接执行类命中 (`ActionSpec.direct`, 见 `doc/ARCHITECTURE.md` §7)。
   *
   * 语义 = "类似 state 桶": 命中行已折叠 (不进 agent), 动作由**运行时自己执行** ——
   * `mud_send` 入队即走 (不等应答, 否则回复文本会变成无主的帧内容), `world_patch` 直接
   * 落库。归属 actor `system`: 不是模型的动作, 因此**不受档位可见性约束**; 危险命令硬边界
   * 照旧生效 (`ask` 没有审批通道 → 等同拒绝, §10)。
   *
   * 人工环节 (等验证码) 期间不执行: 那段时间会话整体暂停 (§11)。
   */
  private runDirectHits(hits: readonly EngineHit[]): void {
    if (this.deps.isAwaitingHuman() || !this.deps.hasConnection()) return
    const tools = this.deps.tools()
    const mudTools = new Set(Object.keys(tools))
    for (const hit of hits) {
      const call = hit.action.tool
      if (call === undefined) {
        this.deps.log(`[缺陷] 直接执行动作没有工具调用: ${hit.ruleId}`)
        continue
      }
      const tool = tools[call.name]
      if (tool === undefined) {
        this.deps.log(`[缺陷] 直接执行动作引用了未知工具 ${call.name} (${hit.ruleId})`)
        continue
      }
      const verdict = evaluateToolCall({
        name: call.name,
        args: call.args,
        // `full` = 只看危险命令硬边界: 直接执行动作不经过模型档位 (actor system)。
        tier: 'full',
        rules: this.gateRules,
        loginFlow: false,
        loginCommands: EMPTY_COMMANDS,
        mudTools,
      })
      if (verdict.kind !== 'allow') {
        this.deps.log(
          `[规则] 直接执行被拒 (${verdict.kind === 'deny' ? '硬边界' : '需批准'}): ${hit.ruleId} → ${call.name} — ${verdict.reason}`)
        continue
      }
      const argsText = JSON.stringify(call.args ?? {})
      this.deps.log(`[规则] ${hit.ruleId} → 直接执行 ${call.name} ${argsText}`)
      this.deps.decision({
        actor: 'rule',
        eventType: 'direct-exec',
        ruleId: hit.ruleId,
        action: '直接执行',
        result: `${call.name} ${argsText}`,
        text: `[规则] ${hit.ruleId} → 直接执行 ${call.name}`,
      })
      // 发完即走: 结果只用于留痕 (没有回合可以承载应答文本)。
      void Promise.resolve(tool.execute({ ...call.args }, { fireAndForget: true }))
        .then((result) => {
          if (!result.ok) this.deps.log(`[规则] ${hit.ruleId} 直接执行未成功: ${result.note}`)
        })
        .catch((err: unknown) => {
          this.deps.log(`[规则] ${hit.ruleId} 直接执行异常: ${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }

  /**
   * 检出"待人工"命中并挂起: 动作声明了 `awaitExternal` 且占位符尚无值 → 挂起该命中并进入
   * 人工环节 (暂停投递 + 停看门狗; 挂起与计时归壳)。
   *
   * **不负责投递其余命中**: 返回值交给调用方决定去向 —— 帧内分支的命中已入待渲染队列,
   * 这里再入队就会把同一条命中渲染两次。
   */
  private parkExternalHits(hits: readonly EngineHit[]): EngineHit[] {
    const ready: EngineHit[] = []
    for (const hit of hits) {
      const needed = hit.action.awaitExternal
      const unresolved = needed === undefined
        ? []
        : this.deps.missingExternalValues(needed)
      if (unresolved.length === 0) {
        ready.push(hit)
        continue
      }
      // 同类动作只保留最新一条 (重复提示不堆叠) —— 去重与 enterHumanWait 在壳里。
      this.deps.parkForHuman(actionOf(hit.ruleId, hit.action), unresolved)
    }
    return ready
  }

  /**
   * 规则动作的**打断准入**: 有流程实例挂起时, 声明了 `interrupts` 的规则参与打断/排队。
   *
   * - 未声明 `interrupts`（缺省）: 既不打断也不排队 —— 命中的动作照常投递
   *   （`direct` 动作本来就直发；发命令工具的应答等待在各自在途窗口内, 与流程实例无关）。
   * - 档位够（`interrupts > flow.priority`）: **打断** —— 挂起的工具调用当场结算为
   *   `interrupted`（不悬挂、不静默）、流程复位（只留入口）、流程声明的 `onInterrupt`
   *   直发、本规则动作照常投递（走官方工具路径）。
   * - 档位不够: **排队** —— 动作不入本批投递，等流程结束（终态/失败/打断）后立即执行。
   */
  private admitRuleHits(hits: readonly EngineHit[], lines: readonly MudLine[], framed: boolean): EngineHit[] {
    if (hits.length === 0) return []
    const admitted: EngineHit[] = []
    for (const hit of hits) {
      const interrupts = hit.action.interrupts
      if (interrupts === undefined) {
        admitted.push(hit)
        continue
      }
      const anchor = lines.find(line => line.abs === hit.anchorAbs)
      const outcome = this.deps.flow.interrupt({
        ruleId: hit.ruleId,
        interrupts,
        text: anchor?.text ?? textOfLines(lines).trim(),
        action: { ...(hit.action.tool === undefined ? {} : { tool: hit.action.tool }), output: hit.action.output },
        anchorAbs: hit.anchorAbs,
        framed,
      })
      if (outcome.kind === 'queued') continue
      if (outcome.kind === 'interrupted') {
        // ① 在途窗口当场结算为 interrupted (gate 随结算放行) ② onInterrupt 直发
        // (actor system; §2.8 打断时序: 先结算释放 gate, halt 直发不被直发延后压住)。
        const settled = this.deps.windows.interrupt(`[流程打断] ${hit.ruleId} (interrupts=${interrupts})`)
        for (const cmd of outcome.onInterrupt) this.deps.queue.send(cmd, { actor: 'system' })
        this.deps.debug('perception', `[流程] 打断已结算在途窗口 ${settled} 个`)
      }
      admitted.push(hit)
    }
    return admitted
  }

  // ── 站④: 流程动作投递 / 排队出队 ──────────────────────

  /**
   * 流程步动作 → 投递（帧内走动作投递；无主块随原文走原文投递）。
   *
   * **待人工的动作先挂起**（`doc/ARCHITECTURE.md` §19.3）：`awaitExternal` 的动作（占位符尚无
   * 值）**不投递**，经壳挂起、等人工回填后由 `exitHumanWait` 投出 —— 顺序是"先人工值、
   * 后投递"，与绑定 GA 的"先投递后唤醒"相反。挂起一律排在**本轮投递之后**：重试时"先投
   * 重新取图动作、再挂起答案动作"，投递不能被人工环节的暂停吃掉。
   *
   * 动作参数先按**流程实例槽**插值（`{captchaUrl}` / `{lastFail}`）；`{captcha}` 等外部值
   * 留到发送瞬间。
   */
  private queueFlowActions(hits: readonly FlowActionHit[]): void {
    if (hits.length === 0) return
    const slots = this.deps.flow.slots()
    const names = this.deps.flow.slotNames()
    const parks: { request: ActionRequest; framed: boolean; keys: readonly string[] }[] = []
    const framed = hits.filter(hit => hit.framed)
    const lined = hits.filter(hit => !hit.framed)
    if (lined.length > 0) {
      for (const hit of lined) {
        const request = fillSlots(actionOf(hit.ruleId, { output: hit.output, tool: hit.tool }), slots, names)
        if (this.needsHuman(hit.awaitExternal)) {
          parks.push({ request, framed: false, keys: hit.awaitExternal ?? [] })
          continue
        }
        // ask-human 已把值带回 (码在 externalValues): 动作照常投, 但流程机停在
        // `awaiting-human` (enterStep 对 awaitExternal 步一律先置该阶段) → 就地恢复,
        // 否则本步动作声明的命令发不出、在途窗口等不到结果 (§19.3)。
        if ((hit.awaitExternal ?? []).length > 0) this.deps.flow.resumeHuman()
        this.pendingActions.push(request)
        if (hit.anchorAbs > this.consumeTo) this.consumeTo = hit.anchorAbs
      }
      // 流程动作也要走投递 (无主帧已在消费链站⑤里进 pending); 帧链外的调用方
      // (人工回填等) 用装配粒度兜底重试。
      this.scheduleSettle(this.deps.config.bridgeSilenceMs)
    }
    for (const hit of framed) {
      const request = fillSlots(actionOf(hit.ruleId, { output: hit.output, tool: hit.tool }), slots, names)
      if (this.needsHuman(hit.awaitExternal)) {
        parks.push({ request, framed: true, keys: hit.awaitExternal ?? [] })
        continue
      }
      if ((hit.awaitExternal ?? []).length > 0) this.deps.flow.resumeHuman()
      this.deliverStandalone(hit.text, [request])
    }
    // 投递已 staged（此时还没进人工环节，避免"人工暂停"把刚 staged 的动作一起压住）。
    for (const park of parks) {
      this.deps.parkForHuman(park.request, park.keys)
    }
  }

  /** 该动作是否需要人工补值（`awaitExternal` 声明且占位符尚无值）。 */
  private needsHuman(keys: readonly string[] | undefined): boolean {
    return keys !== undefined && this.deps.missingExternalValues(keys).length > 0
  }

  /**
   * 流程结束（终态/失败/打断）后投递**排队动作**（`§19.4`：声明了 `interrupts` 但档位
   * 不够 → 排队 → 流程结束后立即执行）。流程仍在挂起中则继续等。
   * (壳 `flow.notifyFail` 回调也要驱动出队 —— 失败可能来自流程自己的计时器。)
   */
  drainFlowQueue(): void {
    if (this.deps.flow.state() !== null || !this.deps.flow.hasQueuedActions()) return
    const queued = this.deps.flow.drainQueuedActions()
    if (queued.length === 0) return
    this.deps.debug('perception', `[流程] 排队动作出队投递 ${queued.length} 条`)
    for (const request of queued) {
      this.deliverStandalone(request.text, [actionOf(request.ruleId, request.action)])
    }
  }

  // ── 站⑤: 投递记账与节拍 ───────────────────────────────

  /**
   * **尚未投递给模型**的最近 n 行游戏输出 (mud_recall / mud_state 数据源)。
   *
   * 只回看交付水位 (`deliveredAbs`) 之后的行: 已经随 T1 原文投递消息 / T2 批次 / 工具应答帧
   * 进过 session 的行**不再重复给出** —— 否则模型会在工具结果里再看到一遍自己刚读过的
   * 文本 (实测: `mud_state` 把从连接开始的全部输出又倒了一遍)。要回顾更早的内容, 模型
   * 的会话历史里本来就有。
   */
  recall(count: number): string[] {
    return this.recallLines
      .filter(entry => entry.abs > this.deliveredAbs)
      .slice(-count)
      .map(entry => entry.text)
  }

  /** 记录一批行已交付给模型 (交付水位前移; 只增不减)。 */
  private noteDelivered(lines: readonly { abs: number }[]): void {
    for (const line of lines) {
      if (line.abs > this.deliveredAbs) this.deliveredAbs = line.abs
    }
  }

  /** 投递重试定时 (T2 限流差额等): 只重试**投递**, 不切帧 —— 消费边界只认标记, 这不是消费边界。 */
  private scheduleSettle(delayMs: number): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settle() }, delayMs)
  }

  /**
   * 站⑤ 投递 (`doc/ARCHITECTURE.md` §5; 帧提交链的末站, 不自造边界):
   *   有动作请求 → 动作消息 = `abs <= consumeTo` 的行 (带原文) + 动作请求;
   *   无动作请求 → 整段作为**批次** (T2) 并按预算裁剪。
   * 每次投递最多一条消息 (I6); 每条行恰好投出一次、顺序不变 (I5)。
   * 调用方: 帧提交点 (adjudicate) / deliverStandalone / hold 释放 / T2 限流重试。
   */
  settle(): void {
    if (this.settleTimer !== null) { clearTimeout(this.settleTimer); this.settleTimer = null }
    const standalone = this.standalone
    if (this.pending.length === 0) {
      // 没有待决行: 暂存的动作消息就地投出 (帧内命中 / 人工回填后的答案)。
      if (standalone !== null) {
        if (t1Allowed(this.deps.config.agentMode)) this.flushStandalone()
        else {
          this.standalone = null
          this.deps.debug('perception', '[感知] T1 已关闭, 丢弃 1 条暂存动作')
        }
      }
      return
    }
    if (this.deps.config.agentMode === 'off') {
      this.deps.debug('perception', `[感知] agent 未接入, ${this.pending.length} 行仅进终端`)
      this.pending.length = 0
      this.consumeTo = -1
      this.pendingActions = []
      this.standalone = null
      return
    }
    const agent = this.deps.agentOf()
    if (this.deps.isAwaitingHuman()) {
      // **人工环节: 暂停全部投递** (验证码只能人工处理): 行留待决, 模型看不到提示也就
      // 不会自己去答; 人工回填后 (exitHumanWait) 立即冲刷。无超时, 仍受待决上限约束。
      if (this.pending.length > MAX_PARKED_LINES) {
        const dropped = this.pending.splice(0, this.pending.length - MAX_PARKED_LINES)
        this.counters.carryDropped += dropped.length
        this.deps.log(`[验证码] 等待人工期间待决行超限丢弃 ${dropped.length} 行`)
      }
      this.deps.debug('perception',
        `[感知] 人工环节 (等验证码): ${this.pending.length} 行留待决, 不投递`)
      return
    }
    const ready = agent !== undefined && this.deps.agentReady()
    if (!ready) {
      // 无 live agent (官方尚未 materialize / 已 dispose), 或 agent 已在但**装配未就绪**
      // (preset 模式下官方 composition 还没切到 mud-player): 保留待决行, 等
      // onAgentReady 冲刷 —— 见 sink.agentReady 的说明。
      if (this.pending.length > MAX_PARKED_LINES) {
        const dropped = this.pending.splice(0, this.pending.length - MAX_PARKED_LINES)
        this.counters.carryDropped += dropped.length
        this.deps.log(`[感知] 无 live agent: 待决行超限丢弃 ${dropped.length} 行`)
      }
      this.deps.debug('perception',
        `[感知] 会话 agent ${agent === undefined ? '不存在' : '装配未就绪'}, ${this.pending.length} 行留待决 (等官方 agent 就绪)`)
      return
    }
    // T1 关闭 (模式 `t2`): 暂存动作不走 agent 管道, 在 `splitDelivery` 前丢弃 ——
    // 否则动作会混进 T2 批次/原文一起喂给 LLM。仅留痕, 不影响待决行去向。
    if (!t1Allowed(this.deps.config.agentMode) && this.pendingActions.length > 0) {
      const droppedActions = this.pendingActions.length
      this.pendingActions = []
      this.standalone = null
      this.deps.debug('perception', `[感知] T1 已关闭, 丢弃 ${droppedActions} 条暂存动作`)
    }
    const { reflex: reflexLines, carry } = splitDelivery(this.pending, this.consumeTo)
    if (reflexLines.length > 0 && this.pendingActions.length > 0) {
      const actions = this.pendingActions
      this.pendingActions = []
      this.pending.length = 0
      this.pending.push(...carry)
      this.consumeTo = -1
      const text = textOfLines(reflexLines).trim()
      if (text === '') return
      this.deps.debug('perception',
        `[感知] 原文投递 ${reflexLines.length} 行 + ${actions.length} 动作 (` +
        `agent ${agent.status}, 遗留 ${carry.length} 行)`)
      this.noteDelivered(reflexLines)
      this.deliver(agent, text, actions, 'T1 原文投递')
      return
    }
    // **T2 关闭** (模式 `t1`): 行批次只进终端, 不喂真实 LLM; 暂存动作 (T1 口径) 照投。
    if (!t2Allowed(this.deps.config.agentMode)) {
      if (standalone !== null) this.flushStandalone()
      this.deps.debug('perception', `[感知] T2 已关闭, ${this.pending.length} 行仅进终端`)
      this.pending.length = 0
      this.consumeTo = -1
      return
    }
    // **T2 投递限流**（作者定案 2026-09-13）：距上次 T2 投递不足最小间隔 ⇒ 本批**不投**，
    // 行留在待决、把结算定时器延到差额到点。两个效果：① T2 不会被喂得太勤（回合开启频率被压住）；
    // ② 多个小批次天然合并成一个大批次（信息更全、回合更少）。
    // **只压 T2 批次**：上面的 T1 动作投递（规则/流程步）与 `standalone`/控制消息都不受影响 ——
    // T1 是系统流程，不能被"给模型限速"的闸压住。
    const t2Gap = this.deps.config.t2DeliverIntervalMs ?? 0
    const sinceT2 = this.deps.channel.sinceT2()
    // 待决达上限 (MAX_SETTLE_LINES) 时旁路限流立即投 —— 防止"限流永远压着积压"。
    if (t2Gap > 0 && sinceT2 < t2Gap && this.pending.length < MAX_SETTLE_LINES) {
      // 动作投递（standalone）不受 T2 限流：它与 T1 同口径，被压住会让"重试重新取图"
      // 这类动作等不到人工环节开始就挂住（而且人工环节会暂停投递）。
      if (standalone !== null) this.flushStandalone()
      this.deps.debug('perception',
        `[感知] T2 投递限流: 距上次 ${sinceT2}ms < ${t2Gap}ms → ${this.pending.length} 行留待决, 延后 ${t2Gap - sinceT2}ms`)
      this.scheduleSettle(t2Gap - sinceT2)
      return
    }
    const batchLines = this.pending.splice(0)
    this.consumeTo = -1
    // 交付水位按**实际投出的行**记账 (裁剪后), 这样被裁掉的行仍然可以被下次 recall 读到。
    const deliveredLines = this.trimObservation(batchLines)
    const text = textOfLines(deliveredLines).trim()
    // 本段没有动作请求, 但可能有"暂存的动作消息"(帧内命中): 先投它, 再投批次。
    if (standalone !== null) this.flushStandalone()
    if (text === '') return
    this.noteDelivered(deliveredLines)
    this.deps.debug('perception',
      `[感知] 批次投递 ${batchLines.length} 行 (agent ${agent.status}, 队列 ${agent.inbox.nextTurn.length} 条)`)
    this.deps.channel.send(agent, ownedGameMessage(text, 't2', this.deps.sessionId))
    // 记下这次 T2 投递的时刻（下一次批次要等 `t2DeliverIntervalMs`）；defer 也算"喂过了"。
    this.deps.channel.markT2()
    this.deps.decision({
      actor: 'router',
      eventType: 'feed-classify',
      action: 'T2 推理注入',
      result: `${text.length} 字符, 无动作`,
      text: '[路由] T2 推理 → 真实 LLM',
    })
  }

  /** 投递一条 T1 动作消息 (原文 + 动作请求; T1 据此渲染 tool-call)。 */
  private deliver(
    agent: { followup: (message: ReturnType<typeof ownedGameMessage>) => void; status?: string },
    text: string,
    actions: readonly ActionRequest[],
    reason: string,
  ): void {
    const delivery = this.deps.channel.nextId()
    this.deps.channel.rememberDelivery(delivery, actions)
    this.deps.channel.send(agent, ownedGameMessage(text, 't1', this.deps.sessionId, { actions, delivery }))
    this.deps.decision({
      actor: 'router',
      eventType: 'feed-classify',
      action: reason,
      result: `${text.length} 字符, ${actions.length} 动作 (${actions.map(a => a.ruleId).join(',')})`,
      text: `[路由] ${reason} → T1`,
    })
  }

  /**
   * 动作投递 (无原文可带 —— 帧行已作为工具结果投过, 或压根没有行): 帧内命中 / 人工回填后的答案。
   * 暂存到下一次结算点统一投出（保证同一时刻只有一条投递在飞, I6）。
   */
  deliverStandalone(text: string, actions: readonly ActionRequest[]): void {
    if (actions.length === 0) return
    if (this.standalone === null) this.standalone = { text, actions: [...actions] }
    else this.standalone.actions.push(...actions)
    this.settle()
  }

  /** 把暂存的动作消息投出。 */
  private flushStandalone(): void {
    const pending = this.standalone
    if (pending === null) return
    this.standalone = null
    const agent = this.deps.agentOf()
    if (agent === undefined) {
      // 无 live agent: 动作留待 onAgentReady 冲刷 (与待决行同一策略)。
      this.standalone = pending
      return
    }
    const text = pending.text.trim() === '' ? '[系统] 流程动作' : pending.text
    this.deps.debug('perception', `[感知] 动作投递 ${pending.actions.length} 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)`)
    this.deliver(agent, text, pending.actions, 'T1 动作投递')
  }

  /** holdDelivery 兜底: 捕获长期不完成 → 释放结算 (按无动作投出批次)。 */
  private armHoldTimeout(): void {
    this.clearHoldTimer()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (this.disposed) return
      this.counters.holdReleases += 1
      this.deps.debug('perception',
        `[感知] holdDelivery 超时释放 (${this.pending.length} 行, 捕获未完成) → 按无动作结算`)
      this.settle()
    }, this.deps.config.holdTimeoutMs)
  }

  /** 清除 hold 计时器。 */
  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  /** 注入文本裁剪 (deliver.tail 过渡实现): 超限时返回"摘要头 + 末 N 行"。 */
  private trimObservation(lines: readonly MudLine[]): MudLine[] {
    if (
      lines.length <= MAX_INJECT_TAIL_LINES
      && lines.reduce((acc, l) => acc + l.text.length, 0) <= MAX_INJECT_TAIL_CHARS
    ) {
      return lines as MudLine[]
    }
    const tail = lines.slice(-MAX_INJECT_TAIL_LINES)
    const header: MudLine = {
      text: `[观察窗截断] 共 ${lines.length} 行, 保留末 ${tail.length} 行`,
      raw: `[观察窗截断] 共 ${lines.length} 行`,
      style: [],
      abs: -1,
      time: Date.now(),
      isPrompt: false,
    }
    return [header, ...tail]
  }

  // ── 工具结果 / 回合收束 (投递通道判定面) ────────────────

  /**
   * **工具结果 → 流程机**（W7.2 §4: 在途窗口结算与纯工具判据的统一入口）。
   *
   * 只有本插件确定性 call-id（`mud-<delivery>-<index>`）能定位到投递与动作，
   * 进而定位到流程步骤（动作 `ruleId` = `flow:<flowId>/<stepId>`）；T2 自己发起的调用
   * 解析失败 ⇒ 什么都不做。结算方式/结局/命中行由工具结果携带（窗口结算在
   * `WindowResult` 上，随工具返回透传）。
   */
  noteToolResult(callId: string, outcome: 'ok' | 'fail' | 'error', settled?: ReplySettle, hitText?: string): void {
    const parsed = parseDeliveryCallId(callId)
    if (parsed === null) return
    // 记账：该投递的一条动作已收到结果（无论成败）。减到 0 = 收齐，交给下一次
    // `rememberDelivery` 按完成驱逐；这里**先不删**——同一次工具调用里 `shouldConcludeTurn`
    // 还要读账本 size 判"最后一条动作"。
    this.deps.channel.recordResult(parsed.delivery)
    const ruleId = this.deps.channel.actionRule(parsed.delivery, parsed.index)
    if (ruleId === undefined || !ruleId.startsWith('flow:')) return
    const stepId = ruleId.slice('flow:'.length).split('/')[1]
    if (stepId === undefined || stepId === '') return
    const hits = this.deps.flow.noteToolResult(stepId, outcome, settled, hitText)
    if (hits.length > 0) {
      this.queueFlowActions(hits)
      // 工具结果驱动的 lined 动作没有帧链 ⑤ 兜底 (待决缓冲不会再有新行): 无行可带时
      // 把暂存动作转动作投递、就地结算 —— 结算仍在本工具在途窗口内 → 落 defer 槽,
      // 随本工具结果进同一回合 (判据 A, ask-human 回合内提问的搭车机制)。
      if (this.pending.length === 0 && this.pendingActions.length > 0) {
        this.standalone = { text: '', actions: this.pendingActions.splice(0) }
      }
      this.settle()
    }
    this.drainFlowQueue()
  }

  /**
   * **判据 B**：本调用能否收束当前回合（`exec.concludeTurn`）。
   *
   * 三个条件同时成立才收束：① 本次工具调用是**某投递的最后一条动作**（call-id 形如
   * `mud-<delivery>-<index>` 且 `index === count-1`；T2 自己发起的调用 id 不匹配 ⇒ 永不收束）；
   * ② 没有待随结果提交的投递（defer 槽 / 待投递动作 / 暂存的动作投递 / 流程排队动作）；
   * ③ **流程机已空闲**（`flow.state() === null`）—— 流程还在推进（含等分支/等人工）时，
   * 收束权归流程自己的计时器与下一步，不能把回合掐掉。
   */
  shouldConcludeTurn(callId: string): boolean {
    if (this.deps.config.agentMode === 'off') return false
    const parsed = parseDeliveryCallId(callId)
    if (parsed === null) return false
    const count = this.deps.channel.actionCount(parsed.delivery)
    if (count === undefined || parsed.index !== count - 1) return false
    if (this.deps.channel.deferCount > 0) return false
    if (this.pendingActions.length > 0) return false
    if (this.standalone !== null) return false
    if (this.deps.flow.hasQueuedActions()) return false
    if (this.deps.flow.state() !== null) return false
    return true
  }

  // ── 生命周期 (由壳在连接事件/释放时驱动) ────────────────

  /**
   * 重连复位 (socket connect): 行流缓冲与武装标记随连接作废 (win- 标记由窗口表
   * settle 的 onDisarm 同步注销, 打断规则重挂); 投递记账 (待决/动作/暂存/消费边界/
   * 交付水位/回看缓冲) 一并复位; hold 计时清除。**行号 (abs) 由每连接一个解析器
   * 分配 → 重连后从 0 起**: 交付水位与回看缓冲必须一起清, 否则新行 (abs 小) 会被
   * 旧水位全部滤掉 (recall 永远为空)。
   */
  resetForReconnect(): void {
    this.splitter.reset()
    // 标记随 reset 全清 (在途窗口表由壳先调 windows.reset()); register() 重挂一次:
    // 引擎重建 + 打断标记 + flow arming (§1.2 唯一注册入口, 取代旧散点补刀)。
    this.register(this.registration)
    this.pending.length = 0
    this.pendingActions = []
    this.standalone = null
    this.consumeTo = -1
    this.deliveredAbs = -1
    this.recallLines.length = 0
    this.clearHoldTimer()
  }

  /**
   * 断线收尾: 未投出的行与半截捕获失去上下文 (多行状态随连接作废), 丢弃并记日志;
   * 投递记账与行流复位, 结算/hold 计时清除。
   */
  abortForDisconnect(): void {
    this.clearHoldTimer()
    if (this.settleTimer !== null) { clearTimeout(this.settleTimer); this.settleTimer = null }
    if (this.pending.length > 0) {
      this.deps.log(`[感知] 待决 ${this.pending.length} 行随断线丢弃 (感知上下文作废)`)
      this.pending.length = 0
    }
    this.pendingActions = []
    this.standalone = null
    this.consumeTo = -1
    this.splitter.reset()
    // register() 重挂一次 (§1.2 唯一注册入口): 引擎重建 + 打断标记 + flow arming。
    // 壳随后 flow.noteDisconnect() 触发 onArmSync 收缩布防, 最终态一致。
    this.register(this.registration)
  }

  /** 释放: 清结算/hold 计时与投递记账 (行流缓冲随 GC, 与旧壳 dispose 同语义)。 */
  dispose(): void {
    this.disposed = true
    if (this.settleTimer !== null) { clearTimeout(this.settleTimer); this.settleTimer = null }
    this.clearHoldTimer()
    this.pending.length = 0
    this.pendingActions = []
    this.standalone = null
  }

  /** 诊断观测 (I9): 待决行 / 待投动作 / 回看行数 / 缺陷计数。 */
  metrics(): {
    pending: number
    actionsPending: number
    recall: number
    counters: { hitsDropped: number; carryDropped: number; holdReleases: number }
  } {
    return {
      pending: this.pending.length,
      actionsPending: this.pendingActions.length,
      recall: this.recallLines.length,
      counters: { ...this.counters },
    }
  }
}
