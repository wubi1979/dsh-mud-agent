/**
 * dsh-mud-core — 流程运行时 (flow runtime), `doc/ARCHITECTURE.md` §19。
 *
 * 一条流程 = 显式的步骤图（`agent/flow/flows/` 声明）。本类持有**每会话**的流程实例状态:
 *   - **挂起**：命令发出后等结果（在途窗口, §8.3 / W7.2 —— 形态 C：窗口只带回**内容**，
 *     关闭触发由本步判据派生（`windowSpecFor`），本步算哪一类由**驱动器复判**（`judgeStep`））；
 *   - **判定**：工具结果（窗口结算 / tool 判据）/ 行判据命中 / 超时 → 成功 / 失败（三态，无静默）；
 *   - **推进**：成功 → 条件分支优先（同批行内），否则顺序兜底；无后继 = 终态 ⇒ 流程成功结束；
 *   - **打断**：规则 `interrupts > flow.priority` 时可打断（在途窗口结算为 interrupted → 复位）；
 *   - **排队**：不可打断的事件动作 / 流程期间的其它流程入口，流程结束后接续
 *     （判定节点中途出队保留；流程入口出队在回合结束的 idle 静止点，D6）。
 *   - **arming 面（W10.4 批次二⑤收窄）**：步骤判据不再经标记 —— 会话侧只剩**入口 arm**（D1：
 *     无回合时也得盯行流）与**分支等待期布防**（`succeedStep` 唯一布防点）；重试即清空。
 *
 * 它**不发命令、不解析帧归属**：要动的动作以"命中"返回给运行时，由运行时走投递与官方工具
 * 路径（T1 渲染 → 闸门 → 工具 → 在途窗口）。所有状态迁移都通过 `onLog`/`onDecision` 留痕。
 * @module @deepseek-ai/dsh-mud-core/agent/flow/engine
 */

import type { MudLine } from '../../network/ansi.ts'
import { TriggerMatchService } from '../../perceive/matcher.ts'
import type { ActionSpec, PerceptionRule } from '../../perceive/types.ts'
import {
  isLineMatch, normalizeFlowSpecs, validateFlows,
  type FlowMatch, type FlowSpec, type FlowStep,
} from './flow-spec.ts'
import type { ArmedMatch, FlowActionHit, FlowRuntimeOptions, FlowState, FlowWindowSpec, InterruptOutcome, InterruptRequest } from './flow-types.ts'
import type { ReplySettle } from '../inflight.ts'
import { lineCriteriaPattern } from '../../perceive/criteria.ts'
import { commandsOf, entryMatch, interpolate, preview } from './util.ts'
import { FlowSlotTable, type FlowSlot } from './slot.ts'
import { fillSlots } from '../../session/types.ts'


/**
 * 一批**行判据**编译为单个 any-of 正则（无可用判据 = null）。
 *
 * 两处消费：① **关闭触发**（`closeTrigger`）② **复判单元**（`judgementUnits` 的 fail/ok 类）。
 * 两者同源同编译，故"窗口在触发行关掉"与"驱动器复判认出该类"不会分歧。
 */
function anyOfPattern(matches: readonly FlowMatch[]): RegExp | null {
  const sources: string[] = []
  for (const match of matches) {
    if (!isLineMatch(match)) continue
    const one = lineCriteriaPattern(match)
    if (one !== null) sources.push(`(?:${one.source})`)
  }
  if (sources.length === 0) return null
  try {
    return new RegExp(sources.join('|'))
  } catch {
    return null // 源正则均已编译过, 实际不可达; 保守退回"不派生"（窗口仍由 GA/fallback 关）
  }
}

/** 一条可复判的判据单元（形态 C：类序固定 retry → fail → 分支 → ok；类内 any-of 正则）。 */
interface JudgementUnit {
  role: 'retry' | 'fail' | 'branch' | 'ok'
  /** 留痕标签（`fail:login/name` / `branch:pass` 等）。 */
  label: string
  /** 类内 any-of 行判据（null = 该类无行判据，跳过）。 */
  pattern: RegExp | null
  /** 分支类的目标步骤 id。 */
  target?: string
  /** 失败类的声明文案（作者写的 `why`）。 */
  why?: string
}

/**
 * 每会话的流程运行时。
 *
 * `offer(lines)` 喂入入站行（入口 arm + 分支/重试判定）；`noteToolResult()` 接收
 * 工具结果（在途窗口结算 / 纯工具判据）；`dispose()` 释放定时器。空闲时只 arm 各流程
 * 入口（I10：同一时刻最多一个流程实例）。
 */
export class FlowRuntime {
  private readonly flows: readonly FlowSpec[]
  private readonly opts: FlowRuntimeOptions
  private readonly entryLabels: ReadonlyMap<string, FlowSpec>

  private active: {
    flow: FlowSpec
    step: FlowStep
    phase: 'awaiting-result' | 'awaiting-human' | 'awaiting-branch'
    deadline: number
    retries: number
    /** 顺序兜底后继（本节点成功后待执行；条件分支命中则作废）。 */
    sequential: string | null
    /**
     * **流程实例槽**：`capture` 抽出的值（如 `captchaUrl`）+ 内建 `{lastFail}`（最近一次
     * `fail` 命中行原文）。跨步骤保留（`prompt` 抽、`answer` 用），流程收束/复位即作废；
     * 重试**不重新抽取**（沿用首次的值）。
     */
    slots: Record<string, string>
    /**
     * **两拍重试的拍 1 在途**（W10.4 第 5 步③）：`tryRetry` 发布了 `retry.action`
     * （如重新取图 `mud_captcha`）、其工具结果尚未回来。结果回来时清标记并发布拍 2
     * （本步动作）。`resumeHuman` 见此标记只翻相位、不发拍 2。
     */
    awaitingPre?: boolean
  } | null = null
  /** 当前 arming 判据（行判据; W7.2 起含本步 driver(重试) + 本步 ok/fail 行判据 + 条件分支后继 —— GA/tool 判据不经 arming, 随窗口/工具结果结算）。 */
  private armed: ArmedMatch[] = []
  private matcher: TriggerMatchService<ActionSpec> | null = null
  /** 空闲入口匹配器（活跃期间仍用于记录其它流程入口 → pending entry）。 */
  private entryMatcher: TriggerMatchService<ActionSpec> | null = null
  /** **T1 流程槽**（会话作用域，W10.4 第 3 步；第 5 步起 T1 按它渲染下一步 tool-call）。 */
  private readonly slotTable = new FlowSlotTable()
  private readonly pendingActions: InterruptRequest[] = []
  private readonly pendingEntry: MudLine[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  /**
   * @param opts 流程表 + 运行时接线（world/留痕/落库/直发/失败唤醒）。
   */
  constructor(opts: FlowRuntimeOptions) {
    this.opts = opts
    // 注册期校验：非法流程**不装配**（fail loud；I13/§19.1）。
    const errors = validateFlows(opts.flows)
    for (const error of errors) this.opts.log(`[缺陷] 流程表校验失败: ${error}`)
    const invalid = new Set(errors.map(error => error.split(':')[0]?.trim() ?? '').filter(Boolean))
    // W10.1 过渡桥：新口径声明（settle/classify/captures）规范化为 legacy 引擎原语
    // （ok/fail/boundary/timeoutMs/capture），引擎零改动、行为逐字段保持（W10.2/W10.4 拆桥）。
    this.flows = normalizeFlowSpecs(opts.flows.filter(flow => !invalid.has(flow.id)))
    const entries = new Map<string, FlowSpec>()
    for (const flow of this.flows) {
      const entryId = flow.entry ?? flow.steps[0]?.id
      if (entryId !== undefined) entries.set(`entry:${flow.id}`, flow)
    }
    this.entryLabels = entries
    this.armEntries()
  }

  /**
   * **重算入口布防**（`when` 读 world；只有空闲时才动 —— 活跃期间入口本来就不 arm）。
   *
   * 运行时在世界模型变化时调用：`login` 的 `when: !logged_in`、`fullme` 的 `when: logged_in`
   * 都靠它随世界翻转（否则流程机只在收束/复位时重算，"登录完成后 fullme 入口永不 arm"）。
   */
  refreshEntries(): void {
    if (this.disposed || this.active !== null) return
    this.armEntries()
  }

  /** 当前流程状态（`diag()`；空闲 = null）。 */
  state(): FlowState | null {
    if (this.active === null) return null
    return {
      flowId: this.active.flow.id,
      stepId: this.active.step.id,
      armed: this.armed.map(entry => entry.label),
      phase: this.active.phase,
      deadline: this.active.deadline,
      pendingActions: this.pendingActions.length,
      pendingEntry: this.pendingEntry.length,
      retries: this.active.retries,
      slots: { ...this.active.slots },
    }
  }

  /** 流程实例槽快照（运行时在**投递前**按它插值动作参数；空闲 = 空表）。 */
  slots(): Readonly<Record<string, string>> {
    return this.active?.slots ?? {}
  }

  /**
   * **当前流程槽**（T1 渲染下一步 tool-call 的数据源；空闲 = null）。
   *
   * 只读投影：迁移点由 `publishSlot()` 发布（进入步骤 / 成功 / 复位 / 释放）。
   * 第 5 步起 T1 按它渲染；今天唯一消费者是本文件的发布点与测试。
   */
  slot(): FlowSlot | null {
    return this.slotTable.get()
  }

  /** 登记"已渲染但结果未回"的 tool-call id（D1：callId ↔ 步骤配对；第 5 步起 T1 调用）。 */
  setPendingCallId(callId: string | null): void {
    this.slotTable.setPendingCallId(callId)
  }

  /**
   * **callId → 步骤 id**（D1 配对；形态 C 第 5 步起 T1 按槽渲染, 不再经投递账本）。
   * @param callId 工具调用 id。
   * @returns 该调用所属步骤；槽里没有这个在途调用 = null。
   */
  stepIdForCall(callId: string): string | null {
    const slot = this.slotTable.get()
    return slot !== null && slot.pendingCallId === callId ? slot.stepId : null
  }

  /**
   * **发布流程槽**（迁移点唯一写入口）：把当前实例状态投影成公开槽。
   *
   * 只在 `awaiting-result` 且本步有动作时带 `render`（T1 要发的 tool-call）。**流程实例槽
   * 在此填实**（`{captchaUrl}`/`{lastFail}`；与投递路径 `queueFlowActions` 的 `fillSlots`
   * 同一语义），`{name}`/`{pass}`/`{captcha}` 等凭据/外部值留给工具发送瞬间；收口三件与
   * `windowSpecFor` 同一次 `windowSpecOf` 派生，保证两侧不可能分歧。
   *
   * **两拍（第 5 步③）**：`override` 用于拍 1 —— 发布 `retry.action`（如重新取图）而非本步
   * 动作；拍 2 在前置结果回来 / 人工就位后由下一次无参 `publishSlot()` 发布本步动作。
   * 收口三件仍按**本步**派生（前置动作通常 inline 不开行窗，壳侧 `windowSpecFor` 命不中即
   * 沿用工具自带声明）。
   * @param override 拍 1 要发布的动作（缺省 = 本步 `step.action`）。
   */
  private publishSlot(override?: { tool: string; args: Record<string, unknown> }): void {
    const active = this.active
    if (active === null) {
      this.slotTable.clear()
      return
    }
    const action = override ?? active.step.action
    const renderable = action !== undefined && active.phase === 'awaiting-result'
    // **流程实例槽在发布点插值**（与 `queueFlowActions` 的投递路径同一语义）：
    // `{captchaUrl}`/`{lastFail}` 等在此填实；`{name}`/`{pass}`/`{captcha}` 留给工具发送瞬间。
    // 不填则槽渲染路径下 `mud_captcha` 会收到字面 `{captchaUrl}`。
    const renderArgs = renderable
      ? fillSlots(
        {
          ruleId: `flow:${active.flow.id}/${active.step.id}`,
          output: '',
          tool: { name: action.tool, args: action.args },
        },
        active.slots,
        this.slotNames(),
      ).tool.args
      : action?.args ?? {}
    this.slotTable.publish({
      flowId: active.flow.id,
      stepId: active.step.id,
      phase: active.phase,
      ...(renderable && action !== undefined
        ? {
          render: {
            tool: action.tool,
            args: renderArgs,
            ...this.windowSpecOf(active.step, commandsOf(action.args).length),
          },
        }
        : {}),
      // 每次发布都是"新的一步 / 新相位 / 新一拍" ⇒ 上一次的在途调用 id 作废
      // （结果已回或已弃用）。
      pendingCallId: null,
      retries: active.retries,
      captureSlots: { ...active.slots },
    })
  }

  /**
   * 当前步声明的 `awaitExternal` 键（**壳侧就位检查**用；空闲/未声明 = 空数组）。
   *
   * 第 5 步③起 `enterStep`/`tryRetry` 不再为等人工步产出动作投递 —— "外部值是否已就位、
   * 要不要 `resumeHuman` 发拍 2"的判断留在持有 `externalValues` 的壳侧（D10）。
   */
  awaitingExternalKeys(): readonly string[] {
    return this.active?.step.awaitExternal ?? []
  }

  /**
   * **声明的槽名**（本流程表所有 `capture` 槽 + 内建 `lastFail`）。
   *
   * 用途：投递前插值时要能区分"未填的流程槽"（→ 空串）与"外部值"（`{captcha}`，
   * 留到发送瞬间）。缺了它，首次投递会把 `{lastFail}` 字面发给工具。
   */
  slotNames(): readonly string[] {
    const names = new Set<string>(['lastFail'])
    for (const flow of this.flows) {
      for (const step of flow.steps) {
        for (const name of Object.keys(step.capture ?? {})) names.add(name)
      }
    }
    return [...names]
  }

  /** 是否**挂起中**（在途窗口未结算、流程等待结果/人工的阶段）。 */
  suspended(): boolean {
    return this.active !== null && this.active.phase !== 'awaiting-branch'
  }

  /**
   * **回合结束接线**（W10.4 第 6 步，D6「流程活跃绑定回合」）：回合收束时若仍有活跃流程
   * （等分支判据、异常中止等回合内无法继续推进的等待期）→ **活跃失效**：复位 + 留痕。
   *
   * 正常路径不受影响：流程终态/失败由驱动器在推进点判定（B3），`concludeTurn` 之前
   * `active` 已经是 null。空闲调用 = no-op（幂等，`turn-stopping` 与 idle 静止点双保险）。
   */
  noteTurnEnd(): void {
    const active = this.active
    if (this.disposed || active === null) return
    this.opts.log(`[流程] ${active.flow.id}/${active.step.id} 随回合结束失效（回合边界 = 流程边界, D6）`)
    this.opts.decision?.({
      actor: 'flow',
      flow: active.flow.id,
      eventType: 'flow-expired',
      ruleId: `${active.flow.id}/${active.step.id}`,
      action: '流程随回合结束失效',
      result: 'turn-end',
      text: `[流程] ${active.flow.id} 随回合结束复位`,
    })
    this.reset()
  }

  /**
   * **取走排队入口行**（W10.4 第 6 步，D1/D6）：pendingEntry 的出队**只在回合结束、槽已
   * 失效之后**（idle 静止点），由运行时经 `offer()` 原路重放 —— 与即时投递行为一致
   * （复位重开、入口投递开新回合）。流程仍活跃时不取（I10）。
   */
  takePendingEntryLines(): MudLine[] {
    if (this.disposed || this.active !== null) return []
    return this.pendingEntry.splice(0)
  }

  /**
   * 喂入一个文本块的行：入口 arm → 结果判定 → 返回要投递的动作。
   * @param lines 本块的行（含帧行）。
   * @param framed 本块是否属于命令应答帧（帧行不进待决缓冲 → 动作走动作投递）。
   * @returns 需要运行时投递的动作（可能多条 = 一个批次内连推几步）。
   */
  offer(lines: readonly MudLine[], framed: boolean): FlowActionHit[] {
    if (this.disposed || lines.length === 0) return []
    const hits: FlowActionHit[] = []
    if (this.active === null) {
      this.matchEntries(lines, framed, hits)
      if (this.active === null) return hits
    } else {
      // 活跃期间：其它流程入口只记录（当前流程结束后接续），不激活。
      this.notePendingEntries(lines)
      if (this.active.phase === 'awaiting-human') {
        // **人工环节不判行**（§19.2）：本步只有一个出口（人工回填），否则同批到达的成功句会
        // 把"命令还没发出"的步判成成功。行照常进感知/终端，只是不参与流程判定。
        this.debug(`人工环节：${lines.length} 行不参与本步判定`)
        return hits
      }
    }
    this.processBatch(lines, framed, hits)
    return hits
  }

  /**
   * **工具结果通知**（官方工具路径; 在途窗口结算与纯工具判据的统一入口, W7.2）。
   *
   * 只接受**当前步**的结果（stepId 已由运行时解析到步骤 id）：
 *   - `settled='ga'/'eor'/'evidence'`（窗口关窗, 形态 C）：**只带回内容** —— 本步算哪一类由
 *     `judgeStep` 复判（固定类序 retry → fail → 分支 → ok）;
 *   - `settled='timeout'/'abort'/'error'`：本步失败收束;
 *   - `settled` 缺省（不经过在途窗口的工具, 如 `mud_captcha`; §19.1 tool 判据）：
   *     ok → tool-ok 判据或本步无 ok 判据 → 成功; fail → 重试或失败; error → 失败;
   *   - `interrupted`：打断由运行时先复位流程 → 到这里已是新上下文, 忽略（防御）。
   * @param stepId 该工具调用所属的步骤 id（`flow:<delivery>-<index>` → 动作 ruleId）。
   * @param outcome 结算结局（窗口因证据关闭 / 工具结果 ok→ok、失败→error）。
   * @param settled 窗口结算方式（经在途窗口的工具带; 纯工具结果不带）。
   * @param contentLines 窗口带回的 span 行（形态 C：**复判判据的唯一输入**；纯工具结果为空）。
   * @returns 判定产生的下一步动作（运行时负责投递；可能为空）。
   */
  noteToolResult(
    stepId: string,
    outcome: 'ok' | 'fail' | 'error',
    settled?: ReplySettle,
    contentLines?: readonly MudLine[],
  ): FlowActionHit[] {
    const hits: FlowActionHit[] = []
    if (this.disposed || this.active === null) return hits
    if (this.active.step.id !== stepId) {
      // 措辞注意：这里只是"不作本步结算判据"，动作投递已随该结果正常带过（defer 语义），
      // 不是丢弃 —— 曾因写成"忽略"被误读为投递丢失（2026-09-19 日志走查）。
      this.debug(`工具结果属于步骤 ${stepId}（非当前步 ${this.active.step.id}）: 不作本步结算判据`)
      return hits
    }
    if (settled === 'interrupted') {
      this.debug('工具结果 interrupted（流程已复位, 忽略）')
      return hits
    }
    // **两拍拍1结果**（第 5 步③）：`retry.action`（如重新取图 `mud_captcha`）的结果回来
    // ⇒ 清 `awaitingPre`、发布拍 2（本步动作）。必须在判据分支**之前**拦 —— 拍 1 是
    // 前置工具，其 ok/fail 不是本步的行判据（answer 步的 regex ok 会把它误判成"忽略"）。
    if (this.active.awaitingPre === true) {
      this.active.awaitingPre = false
      this.debug(`两拍拍1结果 (${outcome}${settled === undefined ? '' : `/${settled}`}) → 发布拍2`)
      if (outcome === 'error') {
        this.failStep('重试前置动作失败/连接断开')
        return hits
      }
      if (outcome === 'fail') {
        if (!this.tryRetry('fail', undefined)) {
          this.failStep(`重试前置动作失败 (${stepId})`)
        }
        return hits
      }
      // 拍 1 成功：拍 2 = 本步动作。有 `awaitExternal` 时外部值应在拍 1 期间已就位
      // （ask-human 的结果即人工回填）；仍停在 awaiting-human 则等壳 `resumeHuman` 发布。
      if ((this.active.step.awaitExternal ?? []).length > 0 && this.active.phase === 'awaiting-human') {
        return hits
      }
      this.active.phase = 'awaiting-result'
      this.publishSlot()
      return hits
    }
    if (settled === 'evidence' || settled === 'ga' || settled === 'eor' || settled === 'timeout') {
      // **形态 C 复判点**（2026-09-21 定案）：窗口因证据关闭（`evidence` = 关闭触发命中 /
      // `ga`/`eor` = N-GA 到齐）或 `timeout` 到期，都只带回**内容**、不携带分类 ——
      // 本步算哪一类由驱动器在此按自己的判据走一遍（固定类序 retry → fail → 分支 → ok）。
      return this.judgeStep(settled, contentLines ?? [], hits)
    }
    if (settled === 'abort') {
      this.failStep('回合取消（abort）')
      return hits
    }
    if (settled === 'error') {
      this.failStep('发送失败/连接断开')
      return hits
    }
    // settled 缺省 = 纯工具结果（mud_captcha 等不经过在途窗口的工具; §19.1 tool 判据）。
    const step = this.active.step
    if (outcome === 'ok') {
      const toolOk = (step.ok ?? []).find(match => match.kind === 'tool' && match.outcome === 'ok')
      if (toolOk !== undefined || (step.ok ?? []).length === 0) {
        this.succeedStep(toolOk?.why ?? `工具结果成功 (${stepId})`)
        // 判定发生在批次之外：顺序兜底后继在这里补跑。
        this.flushSequential([], false, hits)
        return hits
      }
      this.debug(`工具结果 ok（本步未声明该结果的判据, 忽略）`)
      return hits
    }
    if (outcome === 'fail') {
      if (!this.tryRetry('fail', undefined)) {
        this.failStep(`工具结果失败 (${stepId})`)
      }
      return hits
    }
    this.failStep(`工具结果错误 (${stepId})`)
    return hits
  }

  /**
   * **本步复判**（形态 C 定案，2026-09-21）：窗口只带回**内容**，本方法按本步声明的判据
   * 对内容走一遍 —— 固定类序 **retry driver → fail → 分支（后继 driver）→ ok**（D3），
   * 类内按行序取首个；命中即按角色推进（重试 / 失败 / 进分支 / 成功）。同一份内容里
   * 多类命中按此序**取一**后再继续扫（同帧定序由此天然正确，A2）。
   *
   * 一次都没命中时的兜底：`timeout` → 流程失败（无应答事实）；证据关闭（`evidence` / GA）
   * → 本步声明的 **GA 判据**优先（保守判定，如 fullme `stale` 的 `onSettle:'fail'`），
   * 否则按"证据关闭即成功"（`onSettle` 缺省 `'ok'`）。
   * @param kind 窗口结算方式。
   * @param lines 窗口带回的 span 行（复判的唯一输入）。
   * @param hits 动作出口（进分支/重试会追加）。
   * @returns 本步判定产生的动作。
   */
  private judgeStep(
    kind: 'evidence' | 'ga' | 'eor' | 'timeout',
    lines: readonly MudLine[],
    hits: FlowActionHit[],
  ): FlowActionHit[] {
    const active = this.active
    if (active === null || active.phase !== 'awaiting-result') {
      // 本步已被判定（或流程已换步/收束）：窗口结局不重复判定。
      this.debug(`窗口结算 ${kind}（当前非 awaiting-result, 不重复判定）`)
      return hits
    }
    const units = this.judgementUnits(active.step)
    let from = 0
    let judged = false
    const limit = this.flows.reduce((sum, flow) => sum + flow.steps.length, 0) + 4
    for (let guard = 0; guard <= limit; guard += 1) {
      const found = this.judgeFrom(units, lines, from)
      if (found === null) break
      from = found.index + 1
      judged = true
      this.applyJudgement(found.unit, found.line, true, hits)
      // 判定可能换步/收束：旧 units 随之作废（新步另等自己的窗口）。
      if (this.active === null || this.active !== active) break
    }
    if (!judged) this.settleFallback(active.step, kind)
    this.flushSequential(lines, true, hits)
    return hits
  }

  /** 本步的可复判判据单元（固定类序；每类编译为一个 any-of 正则）。 */
  private judgementUnits(step: FlowStep): JudgementUnit[] {
    const units: JudgementUnit[] = []
    if (step.driver !== undefined && step.retry !== undefined && isLineMatch(step.driver)) {
      units.push({ role: 'retry', label: `retry:${step.id}`, pattern: lineCriteriaPattern(step.driver) })
    }
    const fail = (step.fail ?? []).filter(isLineMatch)
    if (fail.length > 0) {
      const why = fail.find(match => match.why !== undefined)?.why
      units.push({
        role: 'fail',
        label: `fail:${step.id}`,
        pattern: anyOfPattern(fail),
        ...(why === undefined ? {} : { why }),
      })
    }
    for (const entry of this.successors(step).conditional) {
      if (!isLineMatch(entry.match)) continue
      units.push({
        role: 'branch',
        target: entry.step.id,
        label: `branch:${entry.step.id}`,
        pattern: lineCriteriaPattern(entry.match),
      })
    }
    const ok = (step.ok ?? []).filter(isLineMatch)
    if (ok.length > 0) units.push({ role: 'ok', label: `ok:${step.id}`, pattern: anyOfPattern(ok) })
    return units
  }

  /** 在内容里按**类序优先、类内行序**取首个命中（无命中 = null）。 */
  private judgeFrom(
    units: readonly JudgementUnit[],
    lines: readonly MudLine[],
    from: number,
  ): { unit: JudgementUnit; line: MudLine; index: number } | null {
    for (const unit of units) {
      if (unit.pattern === null) continue
      for (let i = from; i < lines.length; i += 1) {
        const line = lines[i]
        if (line === undefined) continue
        unit.pattern.lastIndex = 0
        if (unit.pattern.test(line.text)) return { unit, line, index: i }
      }
    }
    return null
  }

  /** 复判未命中任何判据时的兜底裁决（证据关闭 / 到期）。 */
  private settleFallback(step: FlowStep, kind: 'evidence' | 'ga' | 'eor' | 'timeout'): void {
    if (kind === 'timeout') {
      this.failStep('本步超时（兜底到期，无判据命中）')
      return
    }
    const ga = this.gaCriteriaOf(step)
    if (ga !== null) {
      if (ga.role === 'fail') {
        if (!this.tryRetry('fail', undefined)) this.failStep(ga.why ?? 'GA 判据 → 失败')
        return
      }
      this.succeedStep(ga.why ?? 'GA 判据命中')
      return
    }
    // 关闭触发 / GA 关窗而判据未命中 ⇒ `onSettle`（缺省 `'ok'`）：证据关闭即成功。
    this.succeedStep(`窗口因证据关闭 (${kind}, 无判据命中)`)
  }

  /** 应用一次复判命中（推进 / 重试 / 失败）。 */
  private applyJudgement(unit: JudgementUnit, line: MudLine, framed: boolean, hits: FlowActionHit[]): void {
    if (unit.role === 'retry') {
      // 命中本步 driver（步内重试判据）：声明了 retry 才重发本步动作，否则失败。
      if (this.tryRetry('driver', line)) return
      this.failStep(`命中本步 driver 但没有声明 retry (${unit.label})`)
      return
    }
    if (unit.role === 'fail') {
      // 声明了 `retry.on: ['fail']` 的步骤：答错**重来**而不是收场（§19.2）。
      if (this.tryRetry('fail', line)) return
      this.failStep(unit.why ?? `命中失败判据 ${unit.label} (${preview(line.text)})`)
      return
    }
    if (unit.role === 'branch' && unit.target !== undefined) {
      const flowId = this.active?.flow.id
      const from = this.active?.step.id ?? '?'
      // 命中行原文一起留痕：作者按实录核对判据、以及"到底哪一句唤醒了流程"都靠它。
      this.opts.log(`[流程] 命中后继 ${unit.target} 的进入判据 → 唤醒 ${from} = 成功 (分支 ${unit.target}; 行: ${preview(line.text)})`)
      this.opts.decision?.({
        actor: 'flow',
        ...(flowId === undefined ? {} : { flow: flowId }),
        eventType: 'step-success',
        ruleId: `${flowId ?? '?'}/${from}`,
        action: '流程步骤成功',
        result: `分支 ${unit.target}`,
        text: `[流程] ${from} → 成功（进入 ${unit.target}）`,
      })
      this.enterStep(unit.target, hits, framed, line)
      return
    }
    this.succeedStep(`命中成功判据 ${unit.label} (${preview(line.text)})`)
  }

  /**
   * **窗口声明覆盖**（W7.2 §4; 壳装配在 `registerWindow` 入口调用）：流程步动作 tool
   * 在途时, 本步的**命令绑定判据**（GA/N-GA/放弃计时）随窗口注册（单步的命令-应答配对
   * 移交窗口）。
   *
   * **本步判据由此移交窗口（形态 C 定案，2026-09-21）**：`closeOn` = 本步行判据派生的
   * any-of 触发（命中即关窗，只表示"内容到了"、不判类）；窗口另带命令绑定的
   * `gaCount`（显式 GA 判据时）与 `timeoutMs`。**判类不随窗口走** —— 窗口带回内容后由
   * `noteToolResult` 在推进点复判（`judgeStep`）。
   * 工具自带的判据/超时（活动表 `until` 等）由壳做**字段级合并**保留（未覆盖即沿用），
   * 因此本方法未声明的字段不影响工具声明。
   *
   * 仅当**当前步在等结果**且 `cmd` 与本步声明的命令（插值后）一致时返回覆盖 ——
   * 序列按位等长比对、单体按 includes；否则返回 null（工具用自带声明）。
   * @param cmd 工具实际要发的命令（单体或序列; 已插值）。
   * @param values 占位符值（与本步声明比对用）。
   */
  windowSpecFor(cmd: string | readonly string[], values: Readonly<Record<string, string>> = {}): FlowWindowSpec | null {
    if (this.disposed || this.active === null) return null
    if (this.active.phase !== 'awaiting-result') return null
    const args = this.active.step.action?.args
    if (args === undefined) return null
    const expected = commandsOf(args).map(one => interpolate(one, values).trim())
    const given = (Array.isArray(cmd) ? [...cmd] : [cmd]).map(one => String(one).trim())
    const matches = Array.isArray(cmd)
      ? given.length === expected.length && given.every((one, index) => one === expected[index])
      : expected.includes(given[0] ?? '')
    if (!matches) return null
    return this.windowSpecOf(this.active.step, expected.length)
  }

  /**
   * 本步的**收口三件**派生（`windowSpecFor` 与槽发布**共用同一份**，保证"T1 渲染的 tool-call"
   * 与"窗口注册"不可能分歧）：关闭触发（行判据派生）/ GA 计数 / 兜底时长。
   * @param step 目标步骤。
   * @param commandCount 本步命令条数（GA 计数即"每命令至少 1 个 GA"时的基数）。
   * @returns 窗口覆盖（字段缺省 = 不覆盖）。
   */
  private windowSpecOf(step: FlowStep, commandCount: number): FlowWindowSpec {
    const gaFail = (step.fail ?? []).some(match => match.kind === 'ga')
    const gaOk = (step.ok ?? []).some(match => match.kind === 'ga')
    // **声明才计 GA**（PLAN §D3，2026-09-21）：显式 `boundary` 优先；否则**本步声明了 GA
    // 判据**（ok/fail 含 `kind:'ga'`）时，GA 计数即"每命令至少 1 个 GA"（= 本步命令条数）。
    // 未声明 GA 判据的步 ⇒ 不给 `gaCount` ⇒ GA 到达**不关窗**（收口只由关闭触发命中 /
    // fallback 到期承担）—— 这正是"收口条件不完全等于判据"的另一半。
    const gaCount = step.boundary ?? ((gaOk || gaFail) ? commandCount : undefined)
    const trigger = this.closeTrigger(step)
    return {
      ...(trigger !== null ? { closeOn: trigger } : {}),
      ...(gaCount !== undefined ? { gaCount } : {}),
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    }
  }

  /**
   * **关闭触发派生**（形态 C 定案，2026-09-21）：把本步的**行判据**编译成**单个 any-of
   * 正则**，交给在途窗口当"关闭触发" —— 命中即关窗（`settled:'evidence'`），
   * **窗口不解释内容**（不判类、不带 hit）。
   *
   * 来源与 arming 集**完全同源**（入口 driver 不在内）：retry driver + 本步 fail + 本步 ok
   * + **直接后继的 driver**。**派生而非另声明** ⇒ 收口与判据不可能分歧（同一批正则，
   * 一份声明）。非行判据（ga/tool/func）不进触发：ga 由 `gaCount` 管、tool 由工具结果管。
   * @param step 当前步。
   * @returns any-of 触发正则；本步无行判据 = null（窗口只由 GA / fallback 关）。
   */
  private closeTrigger(step: FlowStep): RegExp | null {
    const matches: FlowMatch[] = []
    if (step.driver !== undefined && step.retry !== undefined) matches.push(step.driver)
    for (const match of step.fail ?? []) matches.push(match)
    for (const match of step.ok ?? []) matches.push(match)
    for (const entry of this.successors(step).conditional) matches.push(entry.match)
    return anyOfPattern(matches)
  }

  /** 本步 ok/fail 里的 GA 判据（fail 优先; 无 = null）。 */
  private gaCriteriaOf(step: FlowStep): { role: 'ok' | 'fail'; why?: string } | null {
    const gaFail = (step.fail ?? []).find(match => match.kind === 'ga')
    if (gaFail !== undefined) return { role: 'fail', ...(gaFail.why === undefined ? {} : { why: gaFail.why }) }
    const gaOk = (step.ok ?? []).find(match => match.kind === 'ga')
    if (gaOk !== undefined) return { role: 'ok', ...(gaOk.why === undefined ? {} : { why: gaOk.why }) }
    return null
  }

  /**
   * 规则命中时的打断判定（I14：`interrupts > flow.priority` 才能打断）。
   * @param request 打断请求（规则 + 档位 + 动作）。
   * @returns `none` 空闲无流程 / `interrupted` 已打断（运行时随后投递该动作）/ `queued` 排队。
   */
  interrupt(request: InterruptRequest): InterruptOutcome {
    if (this.disposed || this.active === null) return { kind: 'none' }
    const flow = this.active.flow
    if (request.interrupts > flow.priority) {
      const onInterrupt = this.active.step.onInterrupt ?? []
      this.opts.log(`[流程] ${flow.id} 被 ${request.ruleId} 打断 (interrupts=${request.interrupts} > priority=${flow.priority})：` +
        `结算挂起 / 复位${onInterrupt.length > 0 ? ` / onInterrupt ${onInterrupt.join(' ')}` : ''} / 投递事件动作`)
      const stepId = this.active.step.id
      this.opts.decision?.({
        actor: 'flow',
        flow: flow.id,
        eventType: 'flow-interrupted',
        ruleId: `${flow.id}/${stepId}`,
        action: '流程被打断',
        result: `${request.ruleId} (${request.interrupts} > ${flow.priority})`,
        text: `[流程] ${flow.id}/${stepId} 被打断 → 复位`,
      })
      this.reset()
      return { kind: 'interrupted', onInterrupt }
    }
    this.pendingActions.push(request)
    this.opts.log(`[流程] ${flow.id} 挂起中，${request.ruleId} (interrupts=${request.interrupts}) 无打断权 → 排队 (pending action ${this.pendingActions.length})`)
    return { kind: 'queued' }
  }

  /** 取出排队的事件动作（流程结束后由运行时投递）。 */
  drainQueuedActions(): InterruptRequest[] {
    return this.pendingActions.splice(0)
  }

  /** 是否有排队动作。 */
  hasQueuedActions(): boolean {
    return this.pendingActions.length > 0
  }

  /**
   * 人工回填后由运行时调用：回到"等结果"并**发布拍 2**（第 5 步③两拍）。
   *
   * 拍 2 = 本步动作（含 `awaitExternal` 占位符，值已由壳写进 `externalValues`，工具在
   * 发送瞬间插值）。`awaitingPre`（拍 1 在途）时**只翻相位、不发布** —— 拍 2 由
   * `noteToolResult` 在拍 1 结果回来时发布。
   */
  resumeHuman(): void {
    if (this.active === null || this.active.phase !== 'awaiting-human') return
    this.active.phase = 'awaiting-result'
    this.opts.log(`[流程] ${this.active.flow.id}/${this.active.step.id} 人工已提交 → 挂起等结果`)
    if (this.active.awaitingPre === true) {
      this.debug('两拍拍1仍在途：只翻相位，拍2等前置结果')
      return
    }
    this.publishSlot()
  }

  /** 当前是否可被该档位打断（诊断/测试用）。 */
  interruptibleBy(interrupts: number): boolean {
    if (this.active === null) return false
    return interrupts > this.active.flow.priority
  }

  /** 断线：流程上下文作废（复位到空闲）。 */
  noteDisconnect(): void {
    if (this.disposed || this.active === null) return
    this.opts.log(`[流程] ${this.active.flow.id} 随断线作废（复位）`)
    this.reset()
  }

  /** 释放（会话销毁）。 */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.active = null
    this.armed = []
    this.matcher = null
    this.pendingActions.length = 0
    this.pendingEntry.length = 0
    // 会话释放即清槽（D10：槽表归会话作用域，释放即作废）。
    this.slotTable.clear()
    this.syncArmingToHost()
  }

  // ── 内部：入口 / 批处理 / 转移 ─────────────────────────

  /** 空闲时 arm 各流程入口（`when` 前置条件必须满足）。 */
  private armEntries(): void {
    const world = this.opts.world()
    const armed: ArmedMatch[] = []
    const rules: PerceptionRule[] = []
    const entryIdOf = (flow: FlowSpec): FlowStep | undefined => {
      const entryId = flow.entry ?? flow.steps[0]?.id
      return flow.steps.find(step => step.id === entryId)
    }
    for (const flow of this.flows) {
      if (flow.when !== undefined && !flow.when(world)) continue
      const entry = entryIdOf(flow)
      if (entry?.driver === undefined) continue
      const label = `entry:${flow.id}`
      armed.push({ role: 'entry', match: entry.driver, target: flow.id, order: 0, label })
      rules.push({
        id: label,
        priority: 100,
        match: entry.driver.kind === 'regex'
          ? { kind: 'regex', patterns: entry.driver.patterns }
          : entry.driver.kind === 'text'
            ? { kind: 'text', includes: entry.driver.includes }
            : { kind: 'func', test: () => false },
        action: { output: label },
      })
    }
    this.armed = armed
    this.matcher = null
    this.syncArmingToHost()
    // 入口匹配器独立保存（活跃期间仍用于"其它流程入口 → pending entry"；空闲时
    // `matchEntries` 也复用它 —— 与入口规则同一次构建，规则集恒同步）。
    const entryRules = rules.filter(rule => this.entryLabels.has(rule.id))
    this.entryMatcher = entryRules.length > 0 ? new TriggerMatchService(entryRules, 'event') : null
  }

  /** 活跃期间：记录其它流程入口行（当前流程结束后接续）。 */
  private notePendingEntries(lines: readonly MudLine[]): void {
    if (this.entryMatcher === null) return
    const hits = this.entryMatcher.match(lines as MudLine[])
    for (const hit of hits) {
      const flow = this.entryLabels.get(hit.id)
      if (flow === undefined) continue
      const line = lines.find(l => l.abs === hit.lineNumber)
      if (line === undefined) continue
      this.pendingEntry.push(line)
      this.opts.log(`[流程] 流程期间出现 ${flow.id} 入口 → 排队 (pending entry ${this.pendingEntry.length})`)
    }
  }

  /** 空闲：入口命中即激活流程并进入入口步骤。 */
  private matchEntries(lines: readonly MudLine[], framed: boolean, hits: FlowActionHit[]): void {
    // **复用入口匹配器**（与入口规则同一次 `armEntries` 构建、恒同步）：不再每文本块
    // `new TriggerMatchService(...)`。入口块全走单行判据（regex/text/func；非行判据在
    // `armEntries` 里退化为永不命中的 func），`match()` 不触碰实例运行时态，复用与重建等价。
    if (this.entryMatcher === null) return
    const matcher = this.entryMatcher
    const percepts = matcher.match(lines as MudLine[])
    for (const percept of percepts) {
      const flow = this.entryLabels.get(percept.id)
      if (flow === undefined) continue
      if (flow.when !== undefined && !flow.when(this.opts.world())) continue
      const entryId = flow.entry ?? flow.steps[0]?.id
      const step = flow.steps.find(s => s.id === entryId)
      const line = lines.find(l => l.abs === percept.lineNumber)
      if (entryId === undefined || step === undefined || line === undefined) continue
      this.opts.log(`[流程] ${flow.id} 激活 (入口 ${entryId}: ${preview(line.text)})`)
      this.opts.decision?.({
        actor: 'flow',
        flow: flow.id,
        eventType: 'flow-start',
        action: '流程激活',
        result: `入口 ${entryId}`,
        text: `[流程] ${flow.id} 激活`,
      })
      // `enterStep` 需要 flow（此刻 `this.active` 还是 null）。
      this.pendingFlow = flow
      this.enterStep(entryId, hits, framed, line)
      return
    }
  }

  /** 处理一个批次（同批内可连推多步：条件分支优先，批尾才跑顺序兜底）。 */
  private processBatch(lines: readonly MudLine[], framed: boolean, hits: FlowActionHit[]): void {
    let from = 0
    const limit = this.flows.reduce((sum, flow) => sum + flow.steps.length, 0) + 4
    for (let guard = 0; guard <= limit; guard += 1) {
      const hit = this.matchFrom(lines, from)
      if (hit === null) break
      from = hit.lineIndex + 1
      this.applyBranchMatch(hit.armed, lines[hit.lineIndex] as MudLine, framed, hits)
      if (this.active === null) break
    }
    // 批处理结束：本节点成功且无条件分支命中 → 执行顺序兜底后继。
    this.flushSequential(lines, framed, hits)
  }

  /** 在 armed 判据里按行序取首个命中（无命中 = null）。 */
  private matchFrom(lines: readonly MudLine[], from: number): { lineIndex: number; armed: ArmedMatch } | null {
    if (this.matcher === null || this.armed.length === 0) return null
    const slice = lines.slice(from)
    if (slice.length === 0) return null
    const percepts = this.matcher.match(slice as MudLine[])
    if (percepts.length === 0) return null
    for (const percept of percepts) {
      const armed = this.armed.find(entry => entry.label === percept.id)
      if (armed === undefined) continue
      const lineIndex = lines.findIndex((line, index) => index >= from && line.abs === percept.lineNumber)
      if (lineIndex >= 0) return { lineIndex, armed }
    }
    return null
  }

  /**
   * 应用一次**分支等待期**判据命中（形态 C 定案，2026-09-21）。
   *
   * 本相位**没有在途窗口**（本步工具已结算），本步判据由窗口带走，会话侧只剩一件事要盯：
   * 后继 driver（步已成功、在等哪条分支的进入判据）。故这里只可能是分支角色；
   * 其余角色（fail/ok/retry）在本相位不该出现 —— 出现即留痕忽略（不推进）。
   */
  private applyBranchMatch(armed: ArmedMatch, line: MudLine, framed: boolean, hits: FlowActionHit[]): void {
    if (armed.role !== 'driver' || armed.target === undefined) {
      this.debug(`分支等待期命中非分支判据 ${armed.label}（形态 C 不该出现, 不推进）`)
      return
    }
    this.applyJudgement({ role: 'branch', target: armed.target, label: armed.label, pattern: null }, line, framed, hits)
  }

  /** 本节点成功：arm 条件分支后继 + 记下顺序兜底（批尾执行）。 */
  private succeedStep(why: string): void {
    const active = this.active
    if (active === null) return
    this.opts.log(`[流程] ${active.flow.id}/${active.step.id} = 成功（${why}）`)
    this.opts.decision?.({
      actor: 'flow',
      flow: active.flow.id,
      eventType: 'step-success',
      ruleId: `${active.flow.id}/${active.step.id}`,
      action: '流程步骤成功',
      result: why,
      text: `[流程] ${active.flow.id}/${active.step.id} → 成功`,
    })
    this.clearTimer()
    const { conditional, sequential } = this.successors(active.step)
    if (conditional.length === 0 && sequential.length === 0) {
      this.finishFlow()
      return
    }
    this.armConditional(conditional)
    active.phase = 'awaiting-branch'
    active.sequential = sequential.length > 0 ? (sequential[0] as FlowStep).id : null
    // **成功后不清掉时间预算**（作者定案 2026-09-13）：一步成功只是里程碑，流程还要等
    // 后继判据（条件分支 driver）或走顺序兜底；"等一个永远不来的分支"同样必须有结局（I4）。
    // 窗口 = 该步 timeoutMs ?? 流程 timeoutMs。
    const window = active.step.timeoutMs ?? active.flow.timeoutMs ?? 30_000
    this.armTimer(active.flow.id, active.step.id, window, `等待后继判据超时 (${window}ms)`)
    this.publishSlot()
  }

  /** 批尾：执行待定的顺序兜底后继。 */
  private flushSequential(lines: readonly MudLine[], framed: boolean, hits: FlowActionHit[]): void {
    const active = this.active
    if (active === null || active.phase !== 'awaiting-branch' || active.sequential === null) return
    const stepId = active.sequential
    active.sequential = null
    this.opts.log(`[流程] ${active.flow.id}/${active.step.id}: 无条件分支命中 → 顺序后继 ${stepId}`)
    this.enterStep(stepId, hits, framed, lines.at(-1))
  }

  /** 进入某一步：onEnter 副作用 → 有动作则产出动作并挂起；否则视为判定节点（进入即成功）。 */
  private enterStep(stepId: string, hits: FlowActionHit[], framed: boolean, line?: MudLine): void {
    const flow = this.active?.flow ?? this.pendingFlow
    if (flow === undefined) return
    this.pendingFlow = undefined
    const step = flow.steps.find(s => s.id === stepId)
    if (step === undefined) {
      this.opts.log(`[缺陷] 流程 ${flow.id} 引用了不存在的步骤 ${stepId}`)
      this.reset()
      return
    }
    const previous = this.active
    this.active = {
      flow,
      step,
      phase: 'awaiting-result',
      deadline: 0,
      retries: 0,
      sequential: null,
      // 槽跨步骤保留（`prompt` 抽的地址 `answer` 要用）；新流程实例则从空开始。
      slots: previous !== null && previous.flow.id === flow.id ? previous.slots : {},
    }
    // 结算归属（W7.2）：每步的命令-应答配对在各自的在途窗口内，工具结果按 stepId 回到
    // `noteToolResult` —— 上一步窗口的结局不会结算新进入的步骤。
    // 状态已一致 → 通知运行时（看门狗据"无活跃流程"起停；§11）。
    this.opts.onTransition?.()
    this.opts.log(`[流程] ${flow.id} 进入步骤 ${step.id}`)
    this.applyEnter(step)
    this.captureSlots(step, line)
    // **形态 C：进入步骤时不布防本步判据** —— 本步判据随窗口（`closeOn`）走，由窗口关窗、
    // 驱动器复判。清空会话侧判据集（入口 arm 在空闲时才有效；活跃期间不 arm 入口）。
    this.setArmed([])
    if (step.action === undefined) {
      // 判定节点：进入判据刚命中 ⇒ 视为成功；随后 arm 它的条件分支 + 待定顺序兜底。
      this.succeedStep(`进入判定节点 ${step.id}（进入判据命中）`)
      return
    }
    // **第 5 步③（两拍/删非入口投递）**：只有**入口步**（`previous === null`，流程刚激活）
    // 保留动作投递 —— 入口投递 = 开回合 + `flow:{id}`（D1）。分支/顺序后继/复判进入的
    // 步不再 push hit：动作由 T1 按槽渲染（`publishSlot` 在下方统一发布）。
    if (previous === null) {
      hits.push({
        ruleId: `flow:${flow.id}/${step.id}`,
        output: `流程 ${flow.id}/${step.id}: ${step.action.tool}`,
        tool: { name: step.action.tool, args: step.action.args },
        text: line?.text ?? `[系统] 流程 ${flow.id}/${step.id}`,
        anchorAbs: line?.abs ?? -1,
        framed,
        ...((step.awaitExternal ?? []).length === 0 ? {} : { awaitExternal: step.awaitExternal }),
      })
    }
    const timeout = step.timeoutMs ?? flow.timeoutMs ?? 30_000
    this.active.deadline = Date.now() + timeout
    if ((step.awaitExternal ?? []).length > 0) {
      // **人工环节照常布防计时器**（作者定案 2026-09-13）：等人工与答错重来共用本步这一份
      // 时间预算（fullme 的 `answer` = 3 分钟 = 图片有效期）；到点即本步超时 → 流程失败收束。
      this.active.phase = 'awaiting-human'
      const keys = (step.awaitExternal ?? []).map(key => `{${key}}`).join('/')
      this.opts.log(`[流程] ${flow.id}/${step.id} 等人工输入 (${keys}; 预算 ${timeout}ms)`)
      this.armTimer(flow.id, step.id, timeout, `人工未在 ${timeout}ms 内提交（本步预算耗尽）`)
      // 非入口的等人工步：不 push hit（第 5 步③），槽停在 `awaiting-human`（无 render）——
      // 壳在外部值就位时调 `resumeHuman()` 发拍 2。入口步仍带 hit（上方已 push）。
      this.publishSlot()
      return
    }
    this.armTimer(flow.id, step.id, timeout)
    this.publishSlot()
  }

  /** 把本步命中行按 `capture` 声明抽进流程实例槽（答错重试不重新抽取，沿用首次的值）。 */
  private captureSlots(step: FlowStep, line?: MudLine): void {
    const spec = step.capture
    const active = this.active
    if (spec === undefined || active === null || line === undefined) return
    for (const [name, pattern] of Object.entries(spec)) {
      const match = new RegExp(pattern).exec(line.text)
      if (match === null) continue
      const value = (match[1] ?? match[0]).trim()
      if (value === '') continue
      active.slots[name] = value
      this.opts.log(`[流程] ${active.flow.id}/${step.id} 槽 {${name}} = ${preview(value)}`)
    }
  }

  /** 激活流程时暂存的 flow（`enterStep` 需要）。 */
  private pendingFlow: FlowSpec | undefined

  /**
   * arm 条件分支后继（形态 C：**唯一**会话侧判据面）。
   *
   * 本步判据已随窗口走（`windowSpecFor` 的 `closeOn` + 驱动器复判），会话侧只剩"本步已成功、
   * 在等哪条分支的进入判据"这一件事要盯 —— 那一刻**没有在途窗口**可关，只能由行流当场判。
   * 在**步骤成功时**（`succeedStep`）布防，不在进入步骤时布防：进入时窗口尚未武装，
   * 提前 arm 会让 `flow-arm:*` 抢走帧切分、把窗口关窗权从 `win-close` 手里拿走。
   * @param conditional 条件分支后继（带各自进入判据）。
   * @param baseOrder 起始声明序（保序用）。
   */
  private armConditional(
    conditional: { step: FlowStep; match: FlowMatch; order: number }[],
    baseOrder = 0,
  ): void {
    const armed: ArmedMatch[] = conditional.map((entry, index) => ({
      role: 'driver' as const,
      match: entry.match,
      target: entry.step.id,
      order: baseOrder + index,
      label: `branch:${entry.step.id}`,
    }))
    // 判定节点（无 action）在进入时还没有自己的判据列表（已被进入判据消费）：
    // 直接把分支判据附加到当前 arming 上。
    this.setArmed([...this.armed.filter(a => a.role !== 'driver' || a.target === undefined), ...armed])
  }

  /** 重建 arming 与匹配器。 */
  private setArmed(armed: ArmedMatch[]): void {
    this.armed = armed.sort((a, b) => a.order - b.order)
    const rules: PerceptionRule[] = []
    for (const entry of this.armed) {
      const match = entry.match
      if (!isLineMatch(match)) continue   // `ga`/`tool` 判据不由行匹配触发
      rules.push({
        id: entry.label,
        priority: 100 - entry.order,
        match: match.kind === 'regex'
          ? { kind: 'regex', patterns: match.patterns }
          : { kind: 'text', includes: match.includes },
        // 动作只作占位（本类自己产出动作，不用规则的 action）。
        action: { output: entry.label },
      })
    }
    this.matcher = rules.length > 0 ? new TriggerMatchService(rules, 'event') : null
    this.syncArmingToHost()
  }

  /**
   * §8.5 武装集同步: 把当前 arming 集的行判据 (regex/text) 编译为标记正则回调整合
   * —— 宿主登记为分帧器武装标记, 命中 → 帧立即提交 → 链运行 → 唤醒/打断当场发生。
   */
  private syncArmingToHost(): void {
    if (this.opts.onArmSync === undefined) return
    const markers: { id: string; pattern: RegExp }[] = []
    for (const entry of this.armed) {
      if (!isLineMatch(entry.match)) continue
      const pattern = lineCriteriaPattern(entry.match)
      if (pattern === null) continue
      markers.push({ id: `flow-arm:${entry.label}`, pattern })
    }
    this.opts.onArmSync(markers)
  }

  /** 重连复位后强制重发当前布防 (宿主分帧器已随 reset 清空)。 */
  syncArming(): void {
    this.syncArmingToHost()
  }

  /** 本步后继分类：条件分支（带进入判据）与顺序兜底（无进入判据）。 */
  private successors(step: FlowStep): {
    conditional: { step: FlowStep; match: FlowMatch; order: number }[]
    sequential: FlowStep[]
  } {
    const flow = this.active?.flow ?? this.pendingFlow
    const conditional: { step: FlowStep; match: FlowMatch; order: number }[] = []
    const sequential: FlowStep[] = []
    let order = 0
    for (const id of step.next ?? []) {
      const next = flow?.steps.find(s => s.id === id)
      if (next === undefined) continue
      const entry = entryMatch(next)
      if (entry === null) sequential.push(next)
      else conditional.push({ step: next, match: entry, order: order++ })
    }
    return { conditional, sequential }
  }

  /**
   * **原步内重试**（§19.2）：命中 `retry.on` 里的判据时回到"重新发调用 + 等结果/等人工"，
   * **不换步、不重置计时器**（时间预算是"一步总计"）。
   *
   * **两拍（W10.4 第 5 步③定案）**：槽一次只放一条真能发的调用 ——
   *   - 有 `retry.action` ⇒ **拍 1** = 发布前置动作（如重新取图 `mud_captcha`），置
   *     `awaitingPre`；其结果回来时由 `noteToolResult` 清标记并发布**拍 2**（本步动作）。
   *   - 无前置、步有 `awaitExternal` ⇒ 槽停 `awaiting-human`（无 render）；外部值就位后
   *     壳调 `resumeHuman()` 发拍 2。
   *   - 无前置、不等人工 ⇒ 直接重发本步动作（`publishSlot`，与缺省重发同形）。
   *
   * 做四件事：① `{lastFail}` ← 命中行原文；② 清空本步 `awaitExternal` 的槽值（旧码作废）；
   * ③ 按上表发布拍 1 / 拍 2 / 重发；④ 重布防本步判据。`attempts` 用尽 → 直接失败收束。
   * @param on 触发来源（'driver' = 本步 driver 再次命中；'fail' = 命中失败判据）。
   * @param line 命中行（失败原文进 `{lastFail}`；工具结果路径只带 `{ text }`）。
   * @returns 是否已处理（false = 本步未声明该来源的重试，交给调用方走失败）。
   */
  private tryRetry(
    on: 'driver' | 'fail',
    line: { text: string; abs?: number } | undefined,
  ): boolean {
    const active = this.active
    if (active === null) return false
    const retry = active.step.retry
    if (retry === undefined) return false
    if (!(retry.on ?? ['driver']).includes(on)) return false
    const total = Math.max(1, retry.attempts)
    if (active.retries + 1 >= total) {
      this.failStep(`重试次数用尽 (${active.retries + 1}/${total}${on === 'fail' ? '，答错' : ''})`)
      return true
    }
    const step = active.step
    active.retries += 1
    const attempt = active.retries + 1
    if (line !== undefined) active.slots.lastFail = line.text
    const keys = step.awaitExternal ?? []
    if (keys.length > 0) this.opts.clearExternal?.(keys)
    this.opts.log(`[流程] ${active.flow.id}/${step.id} 重试 ${attempt}/${total}` +
      `${line === undefined ? '' : ` (${preview(line.text)})`}`)
    this.opts.decision?.({
      actor: 'flow',
      flow: active.flow.id,
      eventType: 'step-retry',
      ruleId: `${active.flow.id}/${step.id}`,
      action: '流程步骤重试',
      result: `${attempt}/${total}`,
      text: `[流程] ${active.flow.id}/${step.id} 重试 ${attempt}/${total}`,
    })
    this.setArmed([])
    // ① 拍 1：有前置动作（如重新取图）→ 发布它，等其结果回来再发拍 2。
    const pre = retry.action
    if (pre !== undefined) {
      active.awaitingPre = true
      active.phase = 'awaiting-result'
      this.publishSlot({ tool: pre.tool, args: pre.args })
      this.debug(`两拍拍1: 前置 ${pre.tool}（等其结果 → 拍2 本步动作）`)
      return true
    }
    // ② 无前置、等人工：槽停 awaiting-human（无 render）；值就位后壳 resumeHuman 发拍 2。
    if (keys.length > 0) {
      active.awaitingPre = false
      active.phase = 'awaiting-human'
      this.publishSlot()
      this.debug('两拍: 等人工（无拍1；外部值就位后 resumeHuman 发拍2）')
      return true
    }
    // ③ 无前置、不等人工：直接重发本步动作；计时器不动。
    // 形态 C：本步判据随窗口走，重投动作后由新窗口的 `closeOn` 接管 —— 不放回会话侧判据。
    active.awaitingPre = false
    active.phase = 'awaiting-result'
    this.publishSlot()
    return true
  }

  /** 进入本步的副作用。 */
  private applyEnter(step: FlowStep): void {
    const enter = step.onEnter
    if (enter === undefined) return
    if (enter.patch !== undefined) this.opts.patch(enter.patch)
    for (const cmd of enter.direct ?? []) this.opts.direct(cmd)
  }

  /** 流程成功结束：`onSuccess`。 */
  private finishFlow(): void {
    const active = this.active
    if (active === null) return
    const flow = active.flow
    this.clearTimer()
    this.active = null
    this.armed = []
    this.matcher = null
    // 终态收束 = 流程实例结束 ⇒ 槽作废（D10：会话释放/实例结束即清槽）。
    this.slotTable.clear()
    this.opts.log(`[流程] ${flow.id} 完成（终态）`)
    this.opts.decision?.({
      actor: 'flow',
      flow: flow.id,
      eventType: 'flow-success',
      action: '流程完成',
      result: flow.id,
      text: `[流程] ${flow.id} 完成`,
    })
    const success = flow.onSuccess
    if (success?.patch !== undefined) this.opts.patch(success.patch)
    for (const cmd of success?.direct ?? []) this.opts.direct(cmd)
    for (const cmd of success?.commands ?? []) this.opts.direct(cmd)
    this.armEntries()
    // 排队入口**不再中途接续**（D6/D1：出队只发生在回合结束、槽已失效之后）——
    // 由运行时在 idle 静止点 `takePendingEntryLines()` → `offer()` 原路重放（入口投递复位重开）。
    // 已回到空闲 → 通知运行时（看门狗据"无活跃流程"重新起表；§11）。
    this.opts.onTransition?.()
  }

  /** 本步失败 → 流程失败收束（复位 + 留痕 + 交 T2 一次）。 */
  private failStep(why: string): void {
    const active = this.active
    if (active === null) return
    const flow = active.flow
    const stepId = active.step.id
    this.clearTimer()
    this.active = null
    this.armed = []
    this.matcher = null
    this.slotTable.clear()
    this.opts.log(`[流程] ${flow.id}/${stepId} 失败：${why} → 复位（只留入口）`)
    this.opts.decision?.({
      actor: 'flow',
      flow: flow.id,
      eventType: 'flow-failure',
      ruleId: `${flow.id}/${stepId}`,
      action: '流程失败收束',
      result: why,
      text: `[流程] ${flow.id}/${stepId} → 失败: ${why}`,
    })
    this.armEntries()
    if ((flow.failPolicy?.notify ?? 't2') === 't2') {
      this.opts.notifyFail(`[流程失败] ${flow.id}/${stepId}: ${why}`)
    }
    // 已回到空闲 → 通知运行时（看门狗据"无活跃流程"重新起表；§11）。
    this.opts.onTransition?.()
  }

  /** 复位到空闲（打断 / 断线）。 */
  private reset(): void {
    this.clearTimer()
    this.active = null
    this.armed = []
    this.matcher = null
    this.slotTable.clear()
    this.armEntries()
    // 已回到空闲 → 通知运行时（看门狗据"无活跃流程"重新起表；§11）。
    this.opts.onTransition?.()
  }

  /**
   * 布防超时（人工环节不布防：人工环节无超时）。
   * 两个阶段共用：`awaiting-result`（等本步结果）与 `awaiting-branch`（等后继判据）。
   * @param why 失败原因文案（区分"本步超时"与"等待后继判据超时"）。
   */
  private armTimer(flowId: string, stepId: string, timeout: number, why = `本步超时 (${timeout}ms)`): void {
    this.clearTimer()
    if (this.active !== null) this.active.deadline = Date.now() + timeout
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || this.active === null) return
      if (this.active.flow.id !== flowId || this.active.step.id !== stepId) return
      this.failStep(why)
    }, timeout)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private debug(text: string): void {
    this.opts.log(`[流程] ${this.active === null ? '' : `${this.active.flow.id}/${this.active.step.id} `}${text}`)
  }
}
