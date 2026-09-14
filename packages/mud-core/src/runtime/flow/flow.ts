/**
 * dsh-mud-core — 流程运行时 (flow runtime), `doc/ARCHITECTURE.md` §19。
 *
 * 一条流程 = 显式的步骤图（`runtime/flow/flows.ts` 声明）。本类持有**每会话**的流程实例状态:
 *   - **arming 集**：当前开着的判据（本步 driver(重试) + 本步 ok/fail + 条件分支后继的进入判据）；
 *   - **挂起**：命令发出后等结果（实现上就是桥的一条 pending 应答，见 §8）；
 *   - **判定**：判据命中 / GA / 超时 → 成功 / 失败 / 超时（三态，无静默）；
 *   - **推进**：成功 → 条件分支优先（同批行内），否则顺序兜底；无后继 = 终态 ⇒ 流程成功结束；
 *   - **打断**：规则 `interrupts > flow.priority` 时可打断（结算挂起为 interrupted → 复位）；
 *   - **排队**：不可打断的事件动作 / 流程期间的其它流程入口，流程结束后接续。
 *
 * 它**不发命令、不解析帧归属**：要动的动作以"命中"返回给运行时，由运行时走投递与官方工具
 * 路径（T1 渲染 → 闸门 → 工具 → 桥）。所有状态迁移都通过 `onLog`/`onDecision` 留痕。
 * @module @deepseek-ai/dsh-mud-core/runtime/flow/flow
 */

import type { MudLine } from '../../services/network/ansi.ts'
import { TriggerMatchService } from '../../services/matcher/matcher.ts'
import type { ActionSpec, PerceptionRule } from '../../perceive/types.ts'
import {
  isLineMatch, matchLabel, PRIORITY_NORMAL, validateFlows,
  type FlowMatch, type FlowSpec, type FlowStep,
} from './flows.ts'
import type { ArmedMatch, FlowActionHit, FlowRuntimeOptions, FlowSettleKind, FlowState, InterruptOutcome, InterruptRequest } from './flow-types.ts'


/**
 * 每会话的流程运行时。
 *
 * `offer(lines)` 喂入入站行（入口 arm + 结果判定）；`noteSettle()` 接收桥结算；
 * `dispose()` 释放定时器。空闲时只 arm 各流程入口（I10：同一时刻最多一个流程实例）。
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
  } | null = null
  /** 当前 arming 判据（行判据；`ga` 单独记在 `gaArmed`）。 */
  private armed: ArmedMatch[] = []
  /** 已布防的 GA 判据（针对本节点自己发出的命令）。 */
  private gaArmed: { role: 'ok' | 'fail'; why?: string } | null = null
  /**
   * 本步**已放行过的命令**（插值 + trim 后；桥结算归属判据）。
   *
   * 为什么需要它：帧文本先到、GA 后到是常态（本步因此可能已经推进到下一步），
   * 若不做归属，下一步声明的 GA 判据会把**上一条命令**的 GA 当成自己的（错误完成）。
   *
   * 为什么是**集合**而不是布尔：一个步骤可以发多条命令（序列动作，如 fullme 的
   * `['halt','fullme {captcha}']`，或规则与流程动作同批）。布尔只能回答"本步有命令在途"，
   * 分不清"这条 GA 是哪条命令的" → 别的命令的 GA 会串结算本步。集合 + 桥传来的
   * "被结算的命令"（`onSettle(kind, text, cmds)`）把归属做成**按命令比对**。
   *
   * 生命周期：步骤迁移时清空（`enterStep`），流程收束/复位/释放时清空。
   */
  private ownCommands = new Set<string>()
  private matcher: TriggerMatchService<ActionSpec> | null = null
  /** 空闲入口匹配器（活跃期间仍用于记录其它流程入口 → pending entry）。 */
  private entryMatcher: TriggerMatchService<ActionSpec> | null = null
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
    this.flows = opts.flows.filter(flow => !invalid.has(flow.id))
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

  /** 是否**挂起中**（桥上不允许第二条应答请求；I12 闸门）。 */
  suspended(): boolean {
    return this.active !== null && this.active.phase !== 'awaiting-branch'
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
   * **工具结果通知**（官方工具路径；`doc/ARCHITECTURE.md` §19.1 的 `tool` 判据）。
   *
   * 只接受**当前步**的结果（call-id 已经由运行时解析到步骤 id）：失败判据优先于成功判据；
   * 工具结果失败**不走重试**（重试是给"答错"这类行判据用的：写失败/取图失败直接收束，
   * 否则会把同一条命令重复发出去）。
   * @param stepId 该工具调用所属的步骤 id（`mud-<delivery>-<index>` → 动作 ruleId）。
   * @param ok 工具结果是否成功（`result.ok`）。
   * @returns 判定产生的下一步动作（运行时负责投递；可能为空）。
   */
  noteToolResult(stepId: string, ok: boolean): FlowActionHit[] {
    const hits: FlowActionHit[] = []
    if (this.disposed || this.active === null) return hits
    if (this.active.step.id !== stepId) {
      this.debug(`工具结果（不是本步的: ${stepId}, 忽略）`)
      return hits
    }
    const step = this.active.step
    const outcome = ok ? 'ok' : 'error'
    const hit = (list: readonly FlowMatch[] | undefined): FlowMatch | undefined =>
      (list ?? []).find(match => match.kind === 'tool' && match.outcome === outcome)
    const failMatch = hit(step.fail)
    if (failMatch !== undefined) {
      this.failStep(failMatch.why ?? `工具结果失败 (${stepId})`)
      return hits
    }
    const okMatch = hit(step.ok)
    if (okMatch === undefined) {
      this.debug(`工具结果 ${outcome}（本步未声明该结果的判据, 忽略）`)
      return hits
    }
    this.succeedStep(okMatch.why ?? `工具结果成功 (${stepId})`)
    // 判定发生在批次之外：顺序兜底后继在这里补跑。
    this.flushSequential([], false, hits)
    return hits
  }

  /**
   * 桥结算通知（GA/until/静默/超时/取消/写失败）。
   *
   * 结算驱动的判定**不在批次里**，所以本方法自己补跑一次"顺序兜底后继"
   * （作者定案：`succeedStep` 只是里程碑，不是流程结束；流程收束在 `next` 为空的终态步）。
   * 例：`mxp` 步的成功来自它自己命令的 GA → 进入 `awaiting-branch` 且顺序后继是 `look`，
   * 若只在批尾跑兜底，则"这一帧没有后续文本"时就永远走不到 `look`（静默等待）。
   * @param kind 结算种类。
   * @param text 应答文本（诊断用）。
   * @param cmds **被这次结算关掉的命令**（桥提供；归属比对用）。缺省 = 不比对（兼容旧调用）。
   * @returns 结算产生的下一步动作（运行时负责投递；可能为空）。
   */
  noteSettle(kind: FlowSettleKind, text = '', cmds?: readonly string[]): FlowActionHit[] {
    const hits: FlowActionHit[] = []
    if (this.disposed || this.active === null) return hits
    if (this.active.phase !== 'awaiting-result') {
      this.debug(`结算 ${kind}（本步不在等结果, 忽略）`)
      return hits
    }
    if (kind === 'silent') {
      // 静默不是流程结局（I4：只有成功/失败/超时）。
      this.debug('结算 silent（流程不认静默）→ 继续等文本判据')
      return hits
    }
    // 桥结算归属（§19.3）：**按命令比对** —— 这条结算必须属于本步放行过的命令。
    // 桥给出被结算的命令列表；缺省（旧调用）时退化为"本步放行过任何命令"。
    if (!this.ownsSettle(cmds)) {
      const who = cmds === undefined || cmds.length === 0
        ? '(未提供)'
        : cmds.map(c => JSON.stringify(this.opts.mask?.(c) ?? c)).join(',')
      this.debug(`结算 ${kind}（不是本步命令的结算: ${who}, 忽略）`)
      return hits
    }
    // 归属**消费**：本步放行过的命令只结算一次（重复/迟到的 GA 不得再结算本步）。
    if (cmds === undefined) this.ownCommands.clear()
    else for (const c of cmds) this.ownCommands.delete(c.trim())
    switch (kind) {
      case 'ga':
      case 'eor':
      case 'until': {
        const ga = this.gaArmed
        if (ga === null) {
          // 本步没有声明 GA 判据 ⇒ GA 不是结果（继续等文本判据或超时）。
          this.debug(`结算 ${kind}（本步未声明 GA 判据，继续等文本判据）`)
          return hits
        }
        if (ga.role === 'fail') {
          // `why` 是作者写的声明文案（如 stale 步的"放弃上一轮 → 本轮作废"）。
          if (!this.tryRetry('fail', undefined, true, hits)) {
            this.failStep(ga.why ?? `GA 判据 → 失败 (${preview(text)})`)
          }
          return hits
        }
        this.succeedStep(ga.why ?? `GA 判据命中 (${preview(text)})`)
        // 判定发生在批次之外：顺序兜底后继在这里补跑（帧内容已作为命令应答投过）。
        this.flushSequential([], true, hits)
        return hits
      }
      case 'timeout':
        this.failStep('本步超时（桥超时）')
        return hits
      case 'abort':
        this.failStep('回合取消（abort）')
        return hits
      case 'interrupted':
        // 打断由运行时先复位流程再结算挂起 → 到这里 active 已是 null/新流程；
        // 本分支只防御"复位顺序被打乱"（不把打断误当成本步失败）。
        this.debug('结算 interrupted（流程已复位, 忽略）')
        return hits
      case 'error':
        this.failStep(`写失败/连接断开 (${preview(text)})`)
        return hits
    }
  }

  /**
   * 桥请求准入（I12 闸门 + 归属）：
   *   - 无活跃流程 → 放行；
   *   - 活跃但**不在等结果** → 拒绝（流程挂起期间不允许第二条应答请求）；
   *   - 在等结果 → 只有"本步声明的命令"放行，并把**放行的命令**记进 `ownCommands`
   *     （GA/超时结算的归属判据；§19.3）。
   * @param cmd 实际要写出的命令（已插值）。
   * @param values 占位符值（`{name}`/`{pass}`/`{captcha}`）。
   * @returns 是否放行。
   */
  allowBridgeRequest(cmd: string, values: Readonly<Record<string, string>> = {}): boolean {
    if (this.disposed || this.active === null) return true
    if (this.active.phase !== 'awaiting-result') return false
    const args = this.active.step.action?.args
    if (args === undefined) return false
    const text = String(cmd).trim()
    const expected = commandsOf(args).map(one => interpolate(one, values)).map(one => one.trim())
    if (!expected.includes(text)) return false
    this.ownCommands.add(text)
    return true
  }

  /**
   * 队列写出了一条命令：若它属于**当前步骤声明的命令**，记为"本步已放行"
   * （兜底路径；正常由 `allowBridgeRequest` 记录）。
   * @param cmd 实际写出的命令（已插值）。
   * @param values 占位符值。
   * @returns 该命令是否属于当前步骤。
   */
  noteOwnCommandWritten(cmd: string, values: Readonly<Record<string, string>> = {}): boolean {
    if (this.disposed || this.active === null) return false
    if (this.active.phase !== 'awaiting-result') return false
    const args = this.active.step.action?.args
    if (args === undefined) return false
    const text = String(cmd).trim()
    const expected = commandsOf(args).map(one => interpolate(one, values)).map(one => one.trim())
    if (!expected.includes(text)) return false
    this.ownCommands.add(text)
    return true
  }

  /**
   * 结算归属查询（§19.3）：这条结算是不是**本步放行过的命令**带来的。
   *
   * - `cmds` 给定时：本步放行集合与它**有交集**才算（按命令比对）；空数组视为"不属于本步"。
   * - `cmds` 缺省（旧调用/无从得知时）：退化为"本步放行过任何命令"。
   * @param cmds 桥报告的被结算命令（可能多条 = 一次请求里的序列）。
   * @returns 是否属于本步。
   */
  private ownsSettle(cmds: readonly string[] | undefined): boolean {
    if (cmds === undefined) return this.ownCommands.size > 0
    if (cmds.length === 0) return false
    return cmds.some(one => this.ownCommands.has(String(one).trim()))
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

  /** 人工回填后由运行时调用：回到"等结果"（命令已可发出）。 */
  resumeHuman(): void {
    if (this.active === null || this.active.phase !== 'awaiting-human') return
    this.active.phase = 'awaiting-result'
    this.opts.log(`[流程] ${this.active.flow.id}/${this.active.step.id} 人工已提交 → 挂起等结果`)
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
    this.gaArmed = null
    this.ownCommands.clear()
    this.matcher = null
    this.pendingActions.length = 0
    this.pendingEntry.length = 0
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
    this.gaArmed = null
    this.ownCommands.clear()
    this.matcher = null
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
      this.applyMatch(hit.armed, lines[hit.lineIndex] as MudLine, framed, hits)
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

  /** 应用一次判据命中（失败 / 条件分支 / 重试 / 成功）。 */
  private applyMatch(armed: ArmedMatch, line: MudLine, framed: boolean, hits: FlowActionHit[]): void {
    if (armed.role === 'fail') {
      // 声明了 `retry.on: ['fail']` 的步骤：答错**重来**而不是收场（§19.2）。
      if (this.tryRetry('fail', line, framed, hits)) return
      this.failStep(armed.match.why ?? `命中失败判据 ${armed.label} (${preview(line.text)})`)
      return
    }
    if (armed.role === 'driver' && armed.target !== undefined) {
      const flowId = this.active?.flow.id
      const from = this.active?.step.id ?? '?'
      // 命中行原文一起留痕：作者按实录核对判据、以及"到底哪一句唤醒了流程"都靠它。
      this.opts.log(`[流程] 命中后继 ${armed.target} 的进入判据 → 唤醒 ${from} = 成功 (分支 ${armed.target}; 行: ${preview(line.text)})`)
      this.opts.decision?.({
        actor: 'flow',
        ...(flowId === undefined ? {} : { flow: flowId }),
        eventType: 'step-success',
        ruleId: `${flowId ?? '?'}/${from}`,
        action: '流程步骤成功',
        result: `分支 ${armed.target}`,
        text: `[流程] ${from} → 成功（进入 ${armed.target}）`,
      })
      this.enterStep(armed.target, hits, framed, line)
      return
    }
    if (armed.role === 'driver') {
      // 命中本步 driver：声明了 `retry.on`（含 'driver'，缺省值）才重发本步动作，否则失败。
      if (this.tryRetry('driver', line, framed, hits)) return
      this.failStep(`命中本步 driver 但没有声明 retry (${armed.label})`)
      return
    }
    this.succeedStep(`命中成功判据 ${armed.label} (${preview(line.text)})`)
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
    // **每一次步骤迁移都把结算归属复位**（§19.3）：上一步命令的 GA/超时不得结算新进入的步骤。
    // 实测症状：`pass` 的命令在途时命中 `success` 的进入判据 → 进入 `success`（`ok:[GA]`），
    // 紧接着上一条命令的 GA 到达；若不复位，就会把"命令还没写出"的 `success` 判成成功。
    this.ownCommands.clear()
    // 状态已一致 → 通知运行时（看门狗据"无活跃流程"起停；§11）。
    this.opts.onTransition?.()
    this.opts.log(`[流程] ${flow.id} 进入步骤 ${step.id}`)
    this.applyEnter(step)
    this.captureSlots(step, line)
    if (step.action === undefined) {
      // 判定节点：进入判据刚命中 ⇒ 视为成功；随后 arm 它的条件分支 + 待定顺序兜底。
      this.gaArmed = null
      this.armOwnJudgements(step)
      this.succeedStep(`进入判定节点 ${step.id}（进入判据命中）`)
      return
    }
    this.armOwnJudgements(step)
    hits.push({
      ruleId: `flow:${flow.id}/${step.id}`,
      output: `流程 ${flow.id}/${step.id}: ${step.action.tool}`,
      tool: { name: step.action.tool, args: step.action.args },
      text: line?.text ?? `[系统] 流程 ${flow.id}/${step.id}`,
      anchorAbs: line?.abs ?? -1,
      framed,
      ...((step.awaitExternal ?? []).length === 0 ? {} : { awaitExternal: step.awaitExternal }),
    })
    const timeout = step.timeoutMs ?? flow.timeoutMs ?? 30_000
    this.active.deadline = Date.now() + timeout
    if ((step.awaitExternal ?? []).length > 0) {
      // **人工环节照常布防计时器**（作者定案 2026-09-13）：等人工与答错重来共用本步这一份
      // 时间预算（fullme 的 `answer` = 3 分钟 = 图片有效期）；到点即本步超时 → 流程失败收束。
      this.active.phase = 'awaiting-human'
      const keys = (step.awaitExternal ?? []).map(key => `{${key}}`).join('/')
      this.opts.log(`[流程] ${flow.id}/${step.id} 等人工输入 (${keys}; 预算 ${timeout}ms)`)
      this.armTimer(flow.id, step.id, timeout, `人工未在 ${timeout}ms 内提交（本步预算耗尽）`)
      return
    }
    this.armTimer(flow.id, step.id, timeout)
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

  /** 布防本步自己的判据（GA 单独记）+ 条件分支后继的进入判据。 */
  private armOwnJudgements(step: FlowStep): void {
    const gaOk = (step.ok ?? []).find(match => match.kind === 'ga')
    const gaFail = (step.fail ?? []).find(match => match.kind === 'ga')
    this.gaArmed = gaFail !== undefined
      ? { role: 'fail', ...(gaFail.why === undefined ? {} : { why: gaFail.why }) }
      : gaOk !== undefined
        ? { role: 'ok', ...(gaOk.why === undefined ? {} : { why: gaOk.why }) }
        : null
    const armed: ArmedMatch[] = []
    let order = 0
    if (step.driver !== undefined && step.retry !== undefined) {
      armed.push({ role: 'driver', match: step.driver, order: order++, label: `retry:${step.id}` })
    }
    for (const match of step.fail ?? []) {
      if (!isLineMatch(match)) continue
      armed.push({ role: 'fail', match, order: order++, label: `fail:${matchLabel(match)}` })
    }
    for (const match of step.ok ?? []) {
      if (!isLineMatch(match)) continue
      armed.push({ role: 'ok', match, order: order++, label: `ok:${matchLabel(match)}` })
    }
    this.setArmed(armed)
    // 条件分支后继：进入判据一起 arm（同批行不漏）。
    this.armConditional(this.successors(step).conditional, order)
  }

  /** arm 条件分支后继（`baseOrder` 之后，保证本步判据优先）。 */
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
   * **原步内重试**（§19.2）：命中 `retry.on` 里的判据时回到"重新投动作 + 等结果/等人工"，
   * **不换步、不重置计时器**（时间预算是"一步总计"）。
   *
   * 做四件事：① `{lastFail}` ← 命中行原文；② 清空本步 `awaitExternal` 的槽值（旧码作废）；
   * ③ 投 `retry.action`（缺省 = 重发本步动作；已 `awaitExternal` 的步骤把本步动作**再挂起一次**）；
   * ④ 重布防本步判据。`attempts` 用尽 → 直接失败收束（返回 true = 已处理）。
   * @param on 触发来源（'driver' = 本步 driver 再次命中；'fail' = 命中失败判据）。
   * @param line 命中行（失败原文进 `{lastFail}`）。
   * @param framed 命中是否来自应答帧（动作投递路径）。
   * @param hits 动作收集（由调用方投递）。
   * @returns 是否已处理（false = 本步未声明该来源的重试，交给调用方走失败）。
   */
  private tryRetry(
    on: 'driver' | 'fail',
    line: MudLine | undefined,
    framed: boolean,
    hits: FlowActionHit[],
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
    this.ownCommands.clear()
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
    const ruleId = `flow:${active.flow.id}/${step.id}`
    const anchorAbs = line?.abs ?? -1
    const text = line?.text ?? step.id
    // ① 重试前的动作（如重新取图 + 弹窗反馈失败原文）。
    const pre = retry.action
    if (pre !== undefined) {
      hits.push({
        ruleId,
        output: `流程 ${active.flow.id}/${step.id}: 重试 ${attempt}/${total}`,
        tool: { name: pre.tool, args: pre.args },
        text,
        anchorAbs,
        framed,
      })
    }
    if (keys.length > 0) {
      // ② 等人工的步骤：本步动作**再挂起一次**（人工回填后由运行时投出）。
      if (step.action !== undefined) {
        hits.push({
          ruleId,
          output: `流程 ${active.flow.id}/${step.id}: 重试后重新等人工`,
          tool: { name: step.action.tool, args: step.action.args },
          text,
          anchorAbs,
          framed,
          awaitExternal: keys,
        })
      }
      active.phase = 'awaiting-human'
      return true
    }
    // ③ 不等人工的步骤：缺省重发本步动作（旧语义）并重布防判据；计时器不动。
    if (pre === undefined && step.action !== undefined) {
      hits.push({
        ruleId,
        output: `流程 ${active.flow.id}/${step.id}: 重试 ${attempt}/${total}`,
        tool: { name: step.action.tool, args: step.action.args },
        text,
        anchorAbs,
        framed,
      })
    }
    this.armOwnJudgements(step)
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
    this.gaArmed = null
    this.ownCommands.clear()
    this.matcher = null
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
    this.drainPendingEntryToOffer()
    // 已回到空闲 → 通知运行时（看门狗据"无活跃流程"重新起表；§11）。
    this.opts.onTransition?.()
  }

  /** 流程结束后接续排队的入口行。 */
  private drainPendingEntryToOffer(): void {
    if (this.pendingEntry.length === 0) return
    const queued = this.pendingEntry.splice(0)
    this.opts.log(`[流程] 接续排队入口 ${queued.length} 行`)
    this.matchEntries(queued, false, [])
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
    this.gaArmed = null
    this.ownCommands.clear()
    this.matcher = null
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
    this.gaArmed = null
    this.ownCommands.clear()
    this.matcher = null
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

/** 取一个步骤的"进入判据"（driver；判定节点用 ok/fail 里的行判据）；无 = 顺序步。 */
function entryMatch(step: FlowStep): FlowMatch | null {
  if (step.driver !== undefined) return step.driver
  if (step.action === undefined) {
    const own = [...(step.ok ?? []), ...(step.fail ?? [])].find(isLineMatch)
    if (own !== undefined) return own
  }
  return null
}

/** 步骤声明的命令列表（`cmd` 单体 / `cmds` 序列）。 */
function commandsOf(args: Record<string, unknown>): string[] {
  const single = typeof args.cmd === 'string' ? [args.cmd] : []
  const series = Array.isArray(args.cmds) ? args.cmds.filter((c): c is string => typeof c === 'string') : []
  return [...single, ...series]
}

/** 占位符插值（`{name}`/`{pass}`/`{captcha}` → 实际值；未提供的原样保留）。 */
function interpolate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) => values[key] ?? whole)
}

/** 文本预览（日志用）。 */
function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 40 ? `${one.slice(0, 40)}…` : one
}

export { PRIORITY_NORMAL }
