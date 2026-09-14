/**
 * dsh-mud-core — 会话运行时 (MudSessionRuntime), host half.
 *
 * **一个 MUD 会话 = 一个 DSH 会话**。本类持有该会话的全部游戏侧状态:
 * 连接绑定 (session → connection, 方向单向)、感知折叠、观察窗、命令-应答桥、
 * 命令队列、WorldModel、recall 缓冲、登录看门狗与断流计时。
 *
 * 生命周期分工 (对齐 dsh 官方路径):
 *   - **会话与 agent 由官方拥有** — 会话由页面经官方 `sessions.create` 建立,
 *     agent 由官方 ApiSessionAgentController 创建/恢复。本类从不调用
 *     `ctx.agents.create/resume`, 也不 dispose 任何 agent; 投递前用
 *     `sink.agentOf(sessionId)` **只读解析**当前 live agent。
 *   - **回复用户 = 回复会话** — 游戏输出只投递给本会话的 agent
 *     (`agent.followup(mud-owned 消息)`); 会话无 live agent 时批次留在观察窗,
 *     待 `onAgentReady()` (官方 agent/created) 冲刷, 绝不自行创建会话/agent。
 *   - **网络连接不属于会话** — 连接由会话无关的 MudConnectionManager 持有,
 *     本类只保存 `connectionId` (会话 → 连接)。
 * @module @deepseek-ai/dsh-mud-core/runtime/session-runtime
 */

import { CommandQueue } from './session/queue.ts'
import { buildMudTools, type MudTools, type SessionCredentials } from '../agents/tools.ts'
import { DEFAULT_DANGEROUS_COMMANDS } from '../shared/commands.ts'
import { evaluateToolCall } from '../services/gate/policy.ts'
import { ownedGameMessage } from '../agents/lane.ts'
import { CommandResponseController, type BoundaryKind } from '../network/response.ts'
import type { MudLine } from '../services/network/ansi.ts'
import { textOfLines } from '../preprocess/index.ts'
import { StateService } from './session/gmcp.ts'
import { applyPatch, createWorld, worldSnapshot, type WorldModel } from '../shared/world.ts'
import { CONTROL_PREFIX } from '../perceive/types.ts'
import type { PerceptionRule } from '../perceive/types.ts'
import { PerceptionEngine, type EngineHit } from '../perceive/engine.ts'
import { splitDelivery } from '../perceive/split.ts'
import { MudConnectionManager, type MudConnectionSink } from '../services/network/manager.ts'
import { WatchdogTable } from './watchdogs.ts'
import { FlowRuntime, type FlowActionHit, type FlowState } from './flow-runtime.ts'
import { defaultFlows } from './flow/flows.ts'
import type { MudWorldSnapshot } from '../shell/wire.ts'
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
  type CommandActor,
  type MudDecisionRecord,
  type MudRuntimeConfig,
  type MudRuntimeSink,
  type MudSessionStatus,
} from './session/types.ts'


/**
 * 单个 MUD 会话的运行时。所有字段都是**会话私有** — 不存在跨会话共享的
 * 可变状态 (旧实现的 `SID='console'` 单槽位与全局 `agent` 变量已移除)。
 */
export class MudSessionRuntime {
  readonly sessionId: string
  readonly config: MudRuntimeConfig
  private readonly sink: MudRuntimeSink
  private readonly connections: MudConnectionManager
  private readonly world: WorldModel = createWorld()
  private readonly state: StateService
  private readonly controller: CommandResponseController
  private readonly queue: CommandQueue
  /** L1 行级感知引擎 (每会话一实例; 多行状态在本实例内持久)。 */
  private readonly engine: PerceptionEngine
  /** L2 待决行 (未投递的文本块行 = 单流切分的 segment 缓冲)。 */
  private readonly pending: MudLine[] = []
  /**
   * 待投递的**动作请求** (规则命中 / 流程步动作；v0.4.0 起取代命中队列+回合记录)。
   * 随下一条投递消息一起走 (`source.actions`)，T1 据此渲染 tool-call (`doc/ARCHITECTURE.md` §7)。
   */
  private pendingActions: ActionRequest[] = []
  /** 投递 id 序号 (每会话单调递增; T1 用它生成确定性 call-id)。 */
  private deliverySeq = 0
  /**
   * 动作投递队列 (暂存的"无行可带"动作消息): 帧内命中 / 人工回填后的答案等 ——
   * 它们的锚点行不在待决缓冲里，需要自己一条消息投出去。
   */
  private standalone: { text: string; actions: ActionRequest[] } | null = null
  /** 已消费边界 (最后一次带动作命中的锚点 abs; -1 = 无)。 */
  private consumeTo = -1
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private readonly recallLines: { text: string; abs: number }[] = []
  /** 已投递给模型的最大行 abs (交付水位): recall 只回看其后的行, 保证 session 不重复。 */
  private deliveredAbs = -1
  /** 上一次 **T2 投递**（批次 / 控制消息）的时刻（`t2DeliverIntervalMs` 限流用；0 = 尚未投过）。 */
  private lastT2DeliverAt = 0
  /** 在途工具调用数（>0 ⇒ 投递走 defer 槽；§19.6.2 判据 A）。 */
  private inFlightTools = 0
  /** defer 槽：工具在途期间产生的投递，由该调用结束时随结果提交（`exec.deferContext`）。 */
  private readonly deferSlot: ReturnType<typeof ownedGameMessage>[] = []
  /** 每条投递的动作数（判据 B：`mud-<delivery>-<index>` 的 index 是否等于 count-1）。 */
  private readonly deliverySizes = new Map<string, number>()
  /**
   * 每条投递的**动作来源**（`ruleId`，按 index 对齐）：工具结果回来时据此解析"这条结果
   * 属于哪个流程步骤"（`flow:<flowId>/<stepId>` → `FlowRuntime.noteToolResult`；§19.1 的
   * `tool` 判据）。
   */
  private readonly deliveryRules = new Map<string, readonly string[]>()
  /**
   * 每条投递的**未完成动作数**：工具结果每回一条（`noteToolResult`）减一，归零 = 该投递
   * 已收齐全部结果。新投递进来时把这些"已完成"的投递从账目里剔除 —— 旧版"只留最近
   * 4 条"会在动作结果迟迟不回（T2 限速 / defer 连串 / 人工等值）时把**仍在途**的投递
   * 提前清掉：`shouldConcludeTurn` 永远收不了束，`noteToolResult` 找不到 `ruleId` 而让
   * 流程的 `tool` 判据挂到超时才失败。保留窗口现在是"按完成驱逐 + 安全上限"。
   */
  private readonly deliveryPending = new Map<string, number>()
  private worldTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 唤醒类看门狗 (断流) —— 起停条件声明在构造器里, 运行时只在固定的状态变化点调用
   * `watchdogs.reevaluate()`/`touch()` (见 `runtime/watchdogs.ts`)。
   */
  private readonly watchdogs: WatchdogTable
  /** 流程运行时 (v0.4.0: arming/挂起/唤醒/打断/排队; `doc/ARCHITECTURE.md` §19)。 */
  private readonly flow: FlowRuntime
  /**
   * 是否正在等**人工**处理验证码 (fullme)。等待期间: 看门狗全部停表 + **投递全部
   * 暂停** (行留待决, 模型看不到验证码提示) + `requestAgent` 拒绝唤醒; 人工回填后
   * `flow.resumeHuman()` 并投出挂起的动作。**计时不停**：用该步自己的 `timeoutMs`
   * （fullme 的 `answer` = 3 分钟 = 图片有效期）；人工回填或断线重连时退出
   * (`doc/ARCHITECTURE.md` §11/§19.3)。
   */
  private awaitingHuman = false
  /** 待人工回填的动作 (动作声明了 `awaitExternal` 占位符; 回填后交 T1 渲染)。 */
  private pendingExternal: ActionRequest[] = []
  /** 外部占位符值 (`{captcha}` → 人工输入的验证码; 发送瞬间插值)。 */
  private externalValues: Record<string, string> = {}
  private connectionId: string | null = null
  private account: SessionCredentials | null = null
  private connectCount = 0
  private latestWorld: MudWorldSnapshot | null = null
  private toolCache: MudTools | null = null
  private disposed = false
  /** 最近一次 connect/agent/连接失败 (diag)。 */
  lastError: string | null = null
  /** 缺陷计数 (不变量 I9): 命中未渲染 / 遗留段丢弃 / hold 超时释放。 */
  private readonly counters = { hitsDropped: 0, carryDropped: 0, holdReleases: 0 }

  constructor(
    sessionId: string,
    config: MudRuntimeConfig,
    sink: MudRuntimeSink,
    connections: MudConnectionManager,
    perception: {
      stateRules: readonly PerceptionRule[]
      eventRules: readonly PerceptionRule[]
      /** 声明 holdDelivery 的规则 id 集 (投递原子性判据)。 */
      holdRuleIds: ReadonlySet<string>
    },
  ) {
    this.sessionId = sessionId
    this.config = config
    this.sink = sink
    this.connections = connections
    this.engine = new PerceptionEngine({
      stateRules: perception.stateRules,
      eventRules: perception.eventRules,
      holdRuleIds: perception.holdRuleIds,
    })
    this.state = new StateService({ world: this.world, onChanged: () => { this.pushWorld() } })
    this.controller = new CommandResponseController({
      send: (cmd, meta) => { this.queue.send(cmd, { ...meta }) },
      onLog: (text) => this.debug('network', text),
      defaultTimeoutMs: config.bridgeTimeoutMs,
      declaredTimeoutMs: config.bridgeDeclaredTimeoutMs,
      // 桥结算 → 流程判定 (GA / 超时 / 断开; §19.3)。结算驱动的判定可能直接产出下一步动作
      // （顺序兜底后继，如 mxp 成功后立刻发 look）→ 与 `offer` 同一条投递路径。
      // `cmds` = 被这次结算关掉的命令：流程据此做**按命令的归属比对**（§19.3）。
      onSettle: (kind, text, cmds) => {
        const hits = this.flow.noteSettle(kind, text, cmds)
        if (hits.length > 0) this.queueFlowActions(hits)
        // 结算可能让流程到达终态（如终态步的 GA）→ 排队的动作此时出队投递。
        this.drainFlowQueue()
      },
      // 挂起期闸门 + 结算归属 (I12/§19.3)：只有"本步声明的那条命令"能通过；
      // 流程挂起期间的第二条应答请求被拒绝并留痕。
      canSend: (cmd) => {
        if (this.flow.allowBridgeRequest(cmd, this.placeholderValues())) return true
        this.log(`[缺陷] 流程挂起期间收到第二条应答请求 (${cmd}) → 已拒绝`)
        return false
      },
    })
    this.queue = new CommandQueue({
      minInterval: config.commandIntervalMs,
      onSend: (cmd, meta) => { this.onQueueSend(cmd, meta) },
    })
    this.log(`[执行] 命令队列就绪 (最小间隔 ${config.commandIntervalMs}ms)`)
    this.watchdogs = new WatchdogTable([
      {
        // 断流唤醒 (§11): 已登录 + 已连接 + 有 live agent + **非人工环节** + **无活跃流程**。
        // 任一条件消失即停表。两条"停表"条件的理由:
        //   - 人工环节 (等验证码): agent 不该自主决策;
        //   - **活跃流程**: 流程期间唤醒归流程自己的计时器 (每步 timeout); 流程可能等很久
        //     (人工/慢命令), 让看门狗从 `logged_in` 一置真就打表会在流程中途抢答 (作者定案)。
        //     注意 `logged_in` 可能被 GMCP 提前置真 (pkuxkx 的登录成功通知), 所以"无活跃流程"
        //     这一条同时承担"布防推迟到 login 流程收尾之后"。
        id: 'dead-air',
        active: () => this.config.agentEnabled
          && this.connectionId !== null
          && this.loggedIn
          && !this.awaitingHuman
          && this.flow.state() === null
          && this.sink.agentOf(this.sessionId) !== undefined,
        timeoutMs: () => this.config.deadAirMs,
        repeat: true,
        fire: () => {
          const seconds = Math.round(this.config.deadAirMs / 1000)
          this.requestAgent(`断流 ${seconds}s`, `已 ${seconds} 秒无游戏事件, 请自主行动 (查看状态 / 探索 / 规划下一步)。`)
        },
      },
    ], (text) => { this.log(text) })
    // 流程运行时 (§19)：流程表是只读声明, 实例状态归运行时。
    this.flow = new FlowRuntime({
      flows: config.flows ?? defaultFlows,
      world: () => this.world,
      log: (text) => { this.log(text) },
      decision: (record) => { this.decision(record) },
      patch: (patch) => {
        const changes = applyPatch(this.world, patch)
        if (changes.length > 0) this.noteWorldChange()
        return changes
      },
      direct: (cmd) => { this.queue.send(cmd, { actor: 'system' }) },
      notifyFail: (context) => {
        this.decision({
          actor: 'flow',
          eventType: 'flow-failure',
          action: '流程失败',
          result: context,
          text: context,
        })
        // 失败也可能来自流程自己的计时器（不经过 offer/noteSettle）→ 这里补一次出队。
        this.drainFlowQueue()
        this.requestAgent('流程失败', `${context} — 请判断是重试、换做法还是告知用户。`)
      },
      // 流程日志里的命令文本一律脱敏（密码/验证码不落日志；实测踩过一次明文泄漏）。
      mask: (text) => { return this.redactSecrets(text) },
      // 流程实例状态变化 → 重评估看门狗（dead-air 的启动条件含"无活跃流程"；§11），
      // 并兜住"流程自己结束了但人工环节还挂着"（人工预算超时 / 打断 / 断线都会走这里）。
      onTransition: () => {
        this.syncHumanWait()
        this.noteWorldChange()
      },
      // 重试时清空本步 `awaitExternal` 的槽值（旧验证码作废，必须重新人工输入）。
      clearExternal: (keys) => {
        for (const key of keys) delete this.externalValues[key]
      },
    })
  }

  // ── 对外状态 ───────────────────────────────────────────

  /** 当前绑定的连接 id (未连接 = null)。 */
  get boundConnectionId(): string | null {
    return this.connectionId
  }

  /** 是否已建立 socket。 */
  get connected(): boolean {
    const c = this.connectionId === null ? undefined : this.connections.get(this.connectionId)
    return c?.state === 'connected'
  }

  /** 传输层状态。 */
  get connectionState(): 'idle' | 'connecting' | 'connected' {
    const c = this.connectionId === null ? undefined : this.connections.get(this.connectionId)
    return (c?.state ?? 'idle') as 'idle' | 'connecting' | 'connected'
  }

  /** 当前连接的账户名 (命令回显署名; 未连接/未设账户 = null)。 */
  get accountName(): string | null {
    return this.account?.name ?? null
  }

  /** 状态快照。 */
  status(): MudSessionStatus {
    const c = this.connectionId === null ? undefined : this.connections.get(this.connectionId)
    return {
      sessionId: this.sessionId,
      connected: c?.state === 'connected',
      state: (c?.state ?? 'idle') as 'idle' | 'connecting' | 'connected',
      host: c?.host ?? this.config.defaultHost,
      port: c?.port ?? this.config.defaultPort,
      accountName: c?.state === 'connected' ? (this.account?.name ?? null) : null,
    }
  }

  /** 世界模型快照 (JSON 可序列化)。 */
  snapshot(): MudWorldSnapshot {
    return worldSnapshot(this.world)
  }

  /**
   * **尚未投递给模型**的最近 n 行游戏输出 (mud_recall / mud_state 数据源)。
   *
   * 只回看交付水位 (`deliveredAbs`) 之后的行: 已经随 T1 原文投递消息 / T2 批次 / 工具应答帧
   * 进过 session 的行**不再重复给出** —— 否则模型会在工具结果里再看到一遍自己刚读过的
   * 文本 (实测: `mud_state` 把从连接开始的全部输出又倒了一遍)。要回顾更早的内容, 模型
   * 的会话历史里本来就有。
   * @param count 最多返回行数 (取最新的 count 行)。
   * @returns 未投递行的纯文本 (可能为空)。
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

  /** 本会话的工具集 (闭包绑定本会话的队列/桥/world/凭据)。 */
  tools(): MudTools {
    if (this.toolCache !== null) return this.toolCache
    this.toolCache = buildMudTools({
      send: (cmd) => { this.queue.send(cmd) },
      sendAndAwait: (cmd, opts) => this.controller.sendAndAwait(cmd, opts),
      log: (t) => this.log(t),
      recall: (count) => this.recall(count),
      world: this.world,
      resolveCredentials: () => this.account ?? undefined,
      // 未连接时工具快速拒绝 (不入桥): agent 提前被唤醒也不会把命令塞进队列
      // 换来一串 "写 socket 失败"。
      isConnected: () => this.connectionState === 'connected',
      // 工具改写世界 (典型: login:done 规则渲染的 world_patch {logged_in:true}) 后
      // 重评估看门狗 —— 登录完成不是感知事件, 不重评估就永远不会布防断流计时。
      onWorldChange: () => { this.noteWorldChange() },
      resolveExternalValues: () => this.externalValues,
      // fullme 流程的解析步（`prompt`）调 `mud_captcha`：工具负责解析（出站围栏 + 取图），
      // 这里只把结果交给宿主推前台弹窗（`note` = 上一轮答错原文，供人工参考）。
      captcha: {
        push: (imageUrl, robotUrl, note) => {
          this.sink.captcha?.(this.sessionId, {
            imageUrl,
            robotUrl,
            ...(note === undefined ? {} : { note }),
          })
        },
      },
      ...(this.config.dangerous === undefined ? {} : { dangerous: this.config.dangerous }),
      ...(this.config.activityTable === undefined ? {} : { activity: this.config.activityTable }),
    })
    return this.toolCache
  }

  /** agent 系统提示区段 (persona/skills/commands), 由宿主在 attach 时注入。 */
  promptSections(): { persona: string; skillsText: () => string; commands: string } {
    return {
      persona: this.config.persona,
      skillsText: this.config.skillsText,
      commands: this.config.commands,
    }
  }
  /** 是否已登录 (断流计时/看门狗判据)。 */
  get loggedIn(): boolean {
    return this.world.flags.logged_in === true
  }

  /**
   * 是否处于**人工环节** (等验证码)。看门狗与投递都据此暂停。
   * @returns 正在等人工 → true。
   */
  get humanWait(): boolean {
    return this.awaitingHuman
  }

  /**
   * 是否处于**系统流程** (权限判据: `system` actor, 不受档位限制; §10)。
   * 系统流程 = 登录中 (名字/密码/替换确认) **或** 正在等人工验证码 —— 两者都由规则表
   * 声明动作、由 `system` 发出, 只读档也必须能完成。
   * @returns 登录中或人工环节 → true。
   */
  isSystemFlow(): boolean {
    return !this.loggedIn || this.awaitingHuman
  }

  // ── 连接生命周期 (会话 → 连接; 传输层不持有会话) ────────

  /**
   * 建立本会话的游戏连接。传输层只拿到 host/port; session → connection 绑定
   * 保存在本运行时 (`connectionId`)。
   * @param host 服务器主机 (缺省 config.defaultHost)。
   * @param port 端口 (缺省 config.defaultPort)。
   * @param account 登录账户 (命令回显署名 + {name}/{pass} 插值源)。
   */
  connect(host?: string, port?: number, account?: SessionCredentials): void {
    if (this.disposed) return
    const state = this.connectionState
    if (state === 'connected' || state === 'connecting') return // 幂等: 已连接/连接中
    if (this.connectionId !== null) this.connections.close(this.connectionId)
    if (account !== undefined) this.account = account
    const target = {
      host: host !== undefined && host.trim() !== '' ? host.trim() : this.config.defaultHost,
      port: port ?? this.config.defaultPort,
    }
    this.log(`[SYS] 连接 ${target.host}:${target.port}${this.account !== null ? ` (${this.account.name})` : ''}`)
    const sink: MudConnectionSink = {
      onText: (text) => { this.feedRaw(text) },
      onLines: (lines) => { this.onTextBlock(lines) },
      onBoundary: (kind) => { this.onBoundary(kind) },
      onGmcp: (pkg, payload) => {
        this.state.onGmcp(pkg, payload)
        // GMCP 是权威登录信号 (置信度 1.0) → 走世界变化统一入口。
        this.noteWorldChange()
      },
      onConnect: () => { this.onSocketConnect() },
      onClose: () => { this.onSocketClose() },
      onError: (err) => {
        this.lastError = err.message
        this.log(`[SYS] 连接错误: ${err.message}`)
      },
      onLog: (level, text) => {
        if (level === 'info') this.debug('network', `[NET] ${text}`)
      },
    }
    const connection = this.connections.open(target, sink)
    this.connectionId = connection.id
  }

  /** 断开本会话连接 (未连接时空操作)。 */
  disconnect(): void {
    if (this.connectionId === null) return
    this.log('[SYS] 手动断开')
    this.connections.close(this.connectionId)
    this.connectionId = null
  }

  /**
   * 手动命令 (WebUI/用户): 走队列节流 + 'user' 归属 (不绕过应答桥计数)。
   *
   * **人工验证码例外**: 等人工期间用户发出的 `fullme <码>` 不直接发出, 而是当作**外部
   * 占位符值**回填 (`{captcha}`), 然后由 T1 渲染 `fullme {captcha}` 发出 —— fullme 与
   * 登录一样是规则表声明的 T1 流程, 人工只负责提供那个值 (`doc/ARCHITECTURE.md` §11)。
   * @param cmd 原始命令。
   * @param actor 归属 (agent/user/system)。
   * @returns 是否被接受 (人工回填也算接受)。
   */
  sendCommand(cmd: string, actor: CommandActor = 'user'): boolean {
    const trimmed = cmd.trim()
    if (trimmed === '') return false
    if (this.awaitingHuman && actor === 'user') {
      const match = /^fullme(?:\s+(\S.*))?$/i.exec(trimmed)
      if (match !== null) {
        const code = (match[1] ?? '').trim()
        if (code === '') {
          this.log('[验证码] 收到空验证码, 继续等人工输入')
          return true
        }
        this.exitHumanWait({ captcha: code })
        return true
      }
    }
    this.queue.send(trimmed, { actor })
    return true
  }

  /**
   * 官方 agent/created 后由宿主调用: 冲刷滞留待决行 (结算) + 重评估看门狗
   * (唤醒类看门狗要求有 live agent)。这是"回复用户 = 回复会话"在会话侧的唯一就绪
   * 信号 — 本类不创建 agent, 也**不会在未连接时唤醒 agent** (看门狗启动条件自带连接门)。
   */
  onAgentReady(): void {
    if (this.disposed) return
    this.settle()
    this.noteWorldChange()
  }

  /** 释放本会话运行时: 关连接、清定时器、停队列、关桥。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.close()
    this.queue.clear()
    this.watchdogs.dispose()
    if (this.connectionId !== null) {
      this.connections.close(this.connectionId)
      this.connectionId = null
    }
    for (const timer of [this.settleTimer, this.worldTimer, this.holdTimer]) {
      if (timer !== null) clearTimeout(timer)
    }
    this.settleTimer = null
    this.worldTimer = null
    this.holdTimer = null
    this.pending.length = 0
    this.pendingActions = []
    this.standalone = null
    this.deferSlot.length = 0
    this.inFlightTools = 0
    this.deliverySizes.clear()
    this.deliveryPending.clear()
    this.flow.dispose()
  }

  /** 诊断: 待决/流程/缺陷计数/人工环节 (不变量 I9 的观测面)。 */
  diag(): {
    sessionId: string
    connectionId: string | null
    connected: boolean
    pending: number
    /** 待投递动作数 (规则命中 / 流程步动作)。 */
    actionsPending: number
    /** 活跃流程状态 (null = 空闲; §19: arming/挂起/打断/排队)。 */
    flow: FlowState | null
    recall: number
    agent: boolean
    /** 是否正在等人工验证码 (fullme): 投递与看门狗都暂停。 */
    awaitingHuman: boolean
    lastError: string | null
    counters: { hitsDropped: number; carryDropped: number; holdReleases: number }
  } {
    return {
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      connected: this.connected,
      pending: this.pending.length,
      actionsPending: this.pendingActions.length,
      flow: this.flow.state(),
      recall: this.recallLines.length,
      agent: this.sink.agentOf(this.sessionId) !== undefined,
      awaitingHuman: this.awaitingHuman,
      lastError: this.lastError,
      counters: { ...this.counters },
    }
  }

  // ── 输出通道 ───────────────────────────────────────────

  /** 追加一条游戏输出 (终端缓冲: 原始文本, 不经会话日志)。 */
  private pushGame(text: string): void {
    this.sink.pushGame(this.sessionId, text)
  }

  /** 运行日志。 */
  private log(text: string): void {
    this.sink.log(this.sessionId, text)
  }

  /** 调试日志 (感知/网络/发送通道)。 */
  private debug(channel: 'network' | 'perception' | 'send' | 'runtime', text: string): void {
    this.sink.debug(this.sessionId, channel, text)
  }

  /** 决策记录。 */
  private decision(record: MudDecisionRecord): void {
    this.sink.decision(this.sessionId, record)
  }

  /** world 变化 → 节流推送快照 (500ms 合并; 替换语义)。 */
  private pushWorld(): void {
    if (this.worldTimer !== null) clearTimeout(this.worldTimer)
    this.worldTimer = setTimeout(() => {
      this.worldTimer = null
      this.latestWorld = worldSnapshot(this.world)
      this.sink.pushWorld(this.sessionId, this.latestWorld)
    }, 500)
  }

  // ── 命令发送 ───────────────────────────────────────────

  /** 已发送命令回显 (亮蓝 ANSI; actor 区分 agent/user; 凭据掩码)。 */
  private appendCommandEcho(cmd: string, actor: CommandActor): void {
    const name = this.account?.name ?? 'user'
    this.pushGame(`\x1b[94m${name}@${actor}>${this.redactCredential(cmd)}\x1b[0m`)
  }

  /** 凭据掩码: 仅密码 (高敏感); 长度 ≥4 时做嵌入子串掩码。 */
  private redactCredential(cmd: string): string {
    const pass = this.account?.pass
    if (!pass) return cmd
    if (cmd === pass) return '***'
    if (pass.length >= 4 && cmd.includes(pass)) return cmd.split(pass).join('***')
    return cmd
  }

  /**
   * **日志脱敏**（比 `redactCredential` 宽一层）: 密码 + 人工回填的外部值（验证码）。
   *
   * 用于一切"可能把命令原文写进会话日志"的通道（流程运行时的日志）。终端回显仍只用
   * `redactCredential`（人工自己看的画面不必掩盖验证码）。
   * @param text 待脱敏文本（命令或日志片段）。
   * @returns 脱敏后的文本。
   */
  private redactSecrets(text: string): string {
    let out = this.redactCredential(text)
    for (const value of Object.values(this.externalValues)) {
      // 短值（1–2 字符）不做子串替换：会把正常文本打烂，收益也低。
      if (value.length < 3 || !out.includes(value)) continue
      out = out.split(value).join('***')
    }
    return out
  }

  /** 真实写 socket (队列 onSend 调用; 未连接 = false)。 */
  private writeToSocket(cmd: string, actor: CommandActor = 'agent'): boolean {
    const connection = this.connectionId === null ? undefined : this.connections.get(this.connectionId)
    if (connection === undefined || connection.state !== 'connected') {
      this.log(`[发送] 忽略命令 (未连接): ${JSON.stringify(cmd)}`)
      return false
    }
    const sent = connection.client.send(String(cmd))
    if (sent) {
      this.appendCommandEcho(String(cmd), actor)
      this.log(`[发送] ${cmd === '' ? '<空行>' : this.redactCredential(cmd)}`)
    }
    return sent
  }

  /** 队列 onSend: 真实写 socket 后武装应答桥 (失败回执, 防 sending 死锁)。 */
  private onQueueSend(cmd: string, meta: { actor?: CommandActor; replyId?: string }): void {
    let sent = false
    try {
      sent = this.writeToSocket(cmd, meta.actor ?? 'agent')
    } catch (err) {
      this.log(`[发送] 写 socket 异常: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (sent && meta.replyId !== undefined) {
      // 帧内容全部由控制器自己累积 (含队列节流窗口里到达的行): 宿主不再另存"帧首"
      // 再并回来 —— 那会让同一批行同时留在本帧与下一帧 (实测旧行混进 look 的应答)。
      this.controller.confirmSent(meta.replyId)
    } else if (meta.replyId !== undefined) {
      this.controller.sendFailed(meta.replyId, `写 socket 失败: ${cmd === '' ? '<空行>' : cmd}`)
    }
  }

  /** 占位符值 (流程命令的"结算归属"比对用: 与发送瞬间插值同源)。 */
  private placeholderValues(): Record<string, string> {
    return {
      ...(this.account === null ? {} : { name: this.account.name, pass: this.account.pass }),
      ...this.externalValues,
    }
  }

  // ── socket 事件 ────────────────────────────────────────

  private onSocketConnect(): void {
    this.log('[SYS] 已连接')
    // 新连接 = 新登录会话: 直接复位登录态 (置信度护栏压不过上次 GMCP 1.0)。
    this.world.flags.logged_in = false
    this.world.flags.awaiting = true
    if (this.world._conf.flags) {
      delete this.world._conf.flags.logged_in
      delete this.world._conf.flags.awaiting
    }
    applyPatch(this.world, { connected: true })
    this.pushWorld()
    this.connectCount += 1
    this.appendConnectMarker(this.connectCount === 1 ? 'connect' : 'reconnect')
    applyPatch(this.world, { sent_name: false, sent_pass: false })
    this.watchdogs.resetCounts()
    this.noteWorldChange()
    // 传输断裂 = 感知上下文作废: 清多行半匹配 + 重连复位应答桥与投递缓冲。
    this.engine.reset()
    this.controller.reset()
    this.pending.length = 0
    this.pendingActions = []
    this.standalone = null
    this.consumeTo = -1
    // 行号 (abs) 由**每连接一个**解析器分配 → 重连后从 0 起: 交付水位与回看缓冲必须
    // 一起清, 否则新行 (abs 小) 会被旧水位全部滤掉 (recall 永远为空)。
    this.deliveredAbs = -1
    this.recallLines.length = 0
    // 人工环节 (验证码) 属上一连接的上下文: 挂起的命中与外部值一并作废。
    this.awaitingHuman = false
    this.pendingExternal = []
    this.externalValues = {}
    // 投递通道状态随连接作废: defer 槽里的消息属于上一连接的局面, 不再投出。
    this.deferSlot.length = 0
    this.inFlightTools = 0
    this.deliverySizes.clear()
    this.deliveryPending.clear()
    this.clearHoldTimer()
  }

  private onSocketClose(): void {
    this.log('[SYS] 连接关闭')
    this.controller.close()
    this.queue.clear()
    // 断线: 未投出的行与半截捕获失去上下文 (多行状态随连接作废), 丢弃并记日志。
    this.clearHoldTimer()
    if (this.settleTimer !== null) { clearTimeout(this.settleTimer); this.settleTimer = null }
    if (this.pending.length > 0) {
      this.log(`[感知] 待决 ${this.pending.length} 行随断线丢弃 (感知上下文作废)`)
      this.pending.length = 0
    }
    this.pendingActions = []
    this.standalone = null
    this.consumeTo = -1
    this.engine.reset()
    // 断线 = 唤醒类看门狗全部停表 (`active()` 里的连接门已不满足); 流程实例随连接作废。
    this.watchdogs.reevaluate()
    this.flow.noteDisconnect()
    applyPatch(this.world, { connected: false })
    this.pushWorld()
  }

  // ── 直接执行类命中 (无状态、无需返回的触发) ─────────────

  /**
   * 执行本块的直接执行类命中 (`ActionSpec.direct`, 见 `doc/ARCHITECTURE.md` §7)。
   *
   * 语义 = "类似 state 桶": 命中行已折叠 (不进 agent), 动作由**运行时自己执行** ——
   * `mud_send` 入队即走 (不等应答, 否则回复文本会变成无主的帧内容), `world_patch` 直接
   * 落库。归属 actor `system`: 不是模型的动作, 因此**不受档位可见性约束**; 危险命令硬边界
   * 照旧生效 (`ask` 没有审批通道 → 等同拒绝, §10)。
   *
   * 人工环节 (等验证码) 期间不执行: 那段时间会话整体暂停 (§11)。
   * @param hits 本块直接执行类命中。
   */
  private runDirectHits(hits: readonly EngineHit[]): void {
    if (this.awaitingHuman || this.connectionId === null) return
    const tools = this.tools()
    const mudTools = new Set(Object.keys(tools))
    for (const hit of hits) {
      const call = hit.action.tool
      if (call === undefined) {
        this.sink.log(this.sessionId, `[缺陷] 直接执行动作没有工具调用: ${hit.ruleId}`)
        continue
      }
      const tool = tools[call.name]
      if (tool === undefined) {
        this.sink.log(this.sessionId, `[缺陷] 直接执行动作引用了未知工具 ${call.name} (${hit.ruleId})`)
        continue
      }
      const verdict = evaluateToolCall({
        name: call.name,
        args: call.args,
        // `full` = 只看危险命令硬边界: 直接执行动作不经过模型档位 (actor system)。
        tier: 'full',
        dangerous: this.config.dangerous ?? DEFAULT_DANGEROUS_COMMANDS,
        loginFlow: false,
        loginCommands: EMPTY_COMMANDS,
        mudTools,
      })
      if (verdict.kind !== 'allow') {
        this.sink.log(this.sessionId,
          `[规则] 直接执行被拒 (${verdict.kind === 'deny' ? '硬边界' : '需批准'}): ${hit.ruleId} → ${call.name} — ${verdict.reason}`)
        continue
      }
      const argsText = JSON.stringify(call.args ?? {})
      this.log(`[规则] ${hit.ruleId} → 直接执行 ${call.name} ${argsText}`)
      this.decision({
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
          if (!result.ok) this.log(`[规则] ${hit.ruleId} 直接执行未成功: ${result.note}`)
        })
        .catch((err: unknown) => {
          this.log(`[规则] ${hit.ruleId} 直接执行异常: ${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }

  // ── 人工环节 (fullme 验证码) ───────────────────────────

  /**
   * 检出"待人工"命中并挂起: 动作声明了 `awaitExternal` 且占位符尚无值 → 挂起该命中并进入
   * 人工环节 (暂停投递 + 停看门狗)。
   *
   * 取图与弹窗不在这里做：fullme 流程的 `prompt` 步用 `mud_captcha` 工具完成
   * (`doc/ARCHITECTURE.md` §11 清单 6)；这里只负责"挂起 + 计时 + 收人工值"。
   *
   * **不负责投递其余命中**: 返回值交给调用方决定去向 —— 帧内分支的命中已入待渲染队列,
   * 这里再入队就会把同一条命中渲染两次。
   * @param hits 本块带动作的命中。
   * @returns 不需要外部值、可直接渲染的命中 (调用方负责入队)。
   */
  private parkExternalHits(hits: readonly EngineHit[]): EngineHit[] {
    const ready: EngineHit[] = []
    for (const hit of hits) {
      const needed = hit.action.awaitExternal
      const unresolved = needed === undefined
        ? []
        : needed.filter(key => this.externalValues[key] === undefined)
      if (unresolved.length === 0) {
        ready.push(hit)
        continue
      }
      // 同类动作只保留最新一条 (重复提示不堆叠)。
      this.pendingExternal = this.pendingExternal.filter(queued => queued.ruleId !== hit.ruleId)
      this.pendingExternal.push(actionOf(hit.ruleId, hit.action))
      this.enterHumanWait(hit.ruleId, unresolved)
    }
    return ready
  }

  // ── 打断与排队 (I14 / §19.4) ───────────────────────────

  /**
   * 规则动作的**打断准入**: 有流程实例挂起时, 声明了 `interrupts` 的规则参与打断/排队。
   *
   * - 未声明 `interrupts`（缺省）: 既不打断也不排队 —— 命中的动作照常投递
   *   （`direct` 动作本来就直发；需要桥的动作在流程挂起期由闸门拒绝并留痕）。
   * - 档位够（`interrupts > flow.priority`）: **打断** —— 挂起的工具调用当场结算为
   *   `interrupted`（不悬挂、不静默）、流程复位（只留入口）、流程声明的 `onInterrupt`
   *   直发、本规则动作照常投递（走官方工具路径）。
   * - 档位不够: **排队** —— 动作不入本批投递，等流程结束（终态/失败/打断）后立即执行。
   * @param hits 本块可直接渲染的命中（已经过 `parkExternalHits`）。
   * @param lines 本块的行（取锚点行文本当投递原文）。
   * @param framed 本块是否属于命令应答帧（排队动作的投递路径用）。
   * @returns 现在就该投递的命中。
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
      const outcome = this.flow.interrupt({
        ruleId: hit.ruleId,
        interrupts,
        text: anchor?.text ?? textOfLines(lines).trim(),
        action: { ...(hit.action.tool === undefined ? {} : { tool: hit.action.tool }), output: hit.action.output },
        anchorAbs: hit.anchorAbs,
        framed,
      })
      if (outcome.kind === 'queued') continue
      if (outcome.kind === 'interrupted') {
        // ① onInterrupt 直发（actor system, 不入桥）② 挂起的应答请求当场结算为 interrupted。
        for (const cmd of outcome.onInterrupt) this.queue.send(cmd, { actor: 'system' })
        const settled = this.controller.interruptInFlight(`[流程打断] ${hit.ruleId} (interrupts=${interrupts})`)
        this.debug('perception', `[流程] 打断已结算挂起请求 ${settled} 条`)
      }
      admitted.push(hit)
    }
    return admitted
  }

  /**
   * 流程结束（终态/失败/打断）后投递**排队动作**（`§19.4`：声明了 `interrupts` 但档位
   * 不够 → 排队 → 流程结束后立即执行）。流程仍在挂起中则继续等。
   */
  private drainFlowQueue(): void {
    if (this.flow.state() !== null || !this.flow.hasQueuedActions()) return
    const queued = this.flow.drainQueuedActions()
    if (queued.length === 0) return
    this.debug('perception', `[流程] 排队动作出队投递 ${queued.length} 条`)
    for (const request of queued) {
      this.deliverStandalone(request.text, [actionOf(request.ruleId, request.action)])
    }
  }

  /**
   * 进入人工环节: 暂停全部投递 + 停看门狗 (规则表的 `active()` 里读 `awaitingHuman`),
   * 把验证码交给宿主 (取图 + 推 UI)。**无超时** —— 人工环节可以无限等待。
   * @param robotUrl 验证码页面地址 (可能为 null: 规则命中但没抽出 URL)。
   * @param ruleId 触发规则 id (留痕)。
   * @param missing 缺失的占位符名 (留痕)。
   */
  private enterHumanWait(ruleId: string, missing: readonly string[]): void {
    if (this.awaitingHuman) return
    this.awaitingHuman = true
    this.log(`[验证码] 检测到 ${ruleId}, 等人工输入 (缺 ${missing.map(k => `{${k}}`).join('/')}; ` +
      '看门狗暂停, 投递暂停; 计时用本步预算)')
    this.decision({
      actor: 'flow',
      flow: 'fullme',
      eventType: 'fullme:prompt',
      ruleId,
      action: '等人工验证码',
      text: '[流程] fullme: 等人工输入验证码',
    })
    this.noteWorldChange()   // 看门狗据 awaitingHuman 停表
  }

  /**
   * 人工回填验证码后退出人工环节: 记下外部值 → 恢复看门狗 → 流程回到"等结果" →
   * 把挂起的动作交给 T1 渲染 (T1 会渲染 `fullme {captcha}`, 占位符在发送瞬间插值)。
   *
   * 顺序很关键: **先 `flow.resumeHuman()` 再投**（桥闸门只放行 `awaiting-result` 阶段
   * 声明的命令）；计时器**不重布防**（等人与重试共用本步那一份预算）。
   *
   * 投递形态 = **动作投递**（无原文可带）：触发这次动作的行要么是命令应答帧（已作为
   * tool result 进过模型），要么在人工环节期间留待决不投 —— 与"帧内命中/结算驱动"
   * 同一类（§5）。行本身留在待决缓冲，等人工环节结束后按 T2 批次投出。
   * @param values 外部占位符值 (如 `{ captcha: '1234' }`)。
   */
  private exitHumanWait(values: Record<string, string>): void {
    if (!this.awaitingHuman) return
    this.awaitingHuman = false
    this.externalValues = { ...this.externalValues, ...values }
    const parked = this.pendingExternal
    this.pendingExternal = []
    this.log(`[验证码] 人工已提交: ${Object.keys(values).map(k => `{${k}}`).join('/')} → 交 T1 发送, 投递与看门狗恢复`)
    this.decision({
      actor: 'flow',
      flow: 'fullme',
      eventType: 'fullme:answer',
      action: 'T1 发送 fullme',
      text: '[流程] fullme: 人工已提交, T1 发送',
    })
    this.flow.resumeHuman()
    const slots = this.flow.slots()
    const names = this.flow.slotNames()
    this.noteWorldChange()   // 看门狗恢复
    if (parked.length > 0) {
      this.deliverStandalone(
        `[系统] 人工已提交验证码 (${parked.map(entry => entry.ruleId).join('/')})`,
        parked.map(entry => fillSlots(entry, slots, names)),
      )
    }
    this.settle()            // 立即把暂存的动作投出去（standalone 不被 T2 限流压住）
  }

  /** 写入连接/重连分隔文本到终端缓冲。 */
  private appendConnectMarker(kind: 'connect' | 'reconnect'): void {
    const when = new Date().toLocaleString()
    const label = this.account?.name ?? ''
    const head = kind === 'connect' ? '连接' : '重新连接'
    this.pushGame([
      '',
      '============================================================',
      `===== ${when} — ${head}${label !== '' ? ` ${label}` : ''} =====`,
      '============================================================',
      '',
    ].join('\n'))
  }

  // ── 感知与投递 ─────────────────────────────────────────

  /** 终端通道: 每个文本块到达即写缓冲并广播。 */
  private feedRaw(text: string): void {
    this.pushGame(text)
  }

  /**
   * L1+L2 入口: 一个文本块的行 (`doc/ARCHITECTURE.md` §4/§5)。
   *   1. 逐行推进感知引擎 (多行状态在此持久; 判类与渲染是同一次匹配);
   *   2. state 折叠落库; 带动作命中入队;
   *   3. **无主文本块的行**进入待决缓冲 (holdDelivery 未完成则暂不结算);
   *   4. 结算点 (边界 / 静默 / 上限) 做单流切分并投递。
   *
   * 帧边界 (I5/I6): 在途命令应答的行走桥 (帧内容 → tool result), **不进投递** ——
   * 否则同一段文本会既出现在 tool result 又作为 user 消息投一次, 并额外开一个回合。
   * 帧里产生的命中不丢: 有工具在途就随本结果 `defer` 进下一步, 否则当场**动作投递**
   * (工具应答与游戏输出同源进 L1, 见 §4)。
   */
  private onTextBlock(lines: MudLine[]): void {
    if (lines.length === 0) return
    // 活动事件: 活跃看门狗重置窗口 (断流窗口从"最后一次游戏输出"重新计时)。
    this.watchdogs.touch()
    const result = this.engine.feed(lines)
    // 回看缓冲只收**可能投递给模型**的行: 折叠行 (state 入库 / 直接执行的动作) 已经被处理过,
    // 不再算"尚未投递的输出" —— 否则 `mud_recall` 会把模型本该看不到的原文又倒出来
    // (state 折叠行的信息在 world 快照里, 直接执行行的信息在命令执行结果里)。
    for (const line of lines) {
      if (result.foldedAbs.has(line.abs)) continue
      this.recallLines.push({ text: line.text, abs: line.abs })
      if (this.recallLines.length > 200) this.recallLines.shift()
    }
    for (const hit of result.stateHits) {
      if (hit.data) applyPatch(this.world, hit.data)
    }
    // 本块折叠可能翻转 `logged_in` (state 规则) → 重评估看门狗起停 (见 watchdogs.ts)。
    if (result.stateHits.length > 0) this.noteWorldChange()
    // 直接执行类命中 (动作声明 `direct: true`): 无状态、无需返回的触发 (save 提醒 /
    // 分页提示), 命中行已折叠 → 运行时立即执行声明的动作, 不投给 agent (见 runDirectHits)。
    if (result.directHits.length > 0) this.runDirectHits(result.directHits)
    const inFrame = this.controller.inFlight()
    // 流程判定 (v0.4.0 §19): 与静态规则同一批行; 命中即产出流程步动作 (或唤醒/打断/排队)。
    const flowHits = this.flow.offer(lines, inFrame)
    // 规则命中 → 动作请求 (待人工的先挂起)。
    const parkedRuleHits = this.parkExternalHits(result.hits)
    // 打断准入 (I14/§19.4): 有流程挂起时, 声明了 `interrupts` 的规则可能打断或排队。
    const readyRuleHits = this.admitRuleHits(parkedRuleHits, lines, inFrame)
    if (flowHits.length > 0) this.queueFlowActions(flowHits)
    // 本批可能让流程到达终态/失败（或被打断）→ 排队的动作此时出队投递。
    this.drainFlowQueue()
    if (inFrame) {
      // 帧内命中: 帧行不进待决缓冲 → 动作走**动作投递** (原文 = 命中行), 不依赖下一次结算。
      if (readyRuleHits.length > 0) {
        this.deliverStandalone(
          textOfLines(lines).trim(),
          readyRuleHits.map(hit => actionOf(hit.ruleId, hit.action)),
        )
      }
      // 帧内行会作为工具应答文本进模型 (tool result) → 计入交付水位, recall 不再重复给出。
      this.noteDelivered(lines)
    } else {
      // 无主文本块: 动作随本段原文一起在一次原文投递里走 (行序与消费边界不变)。
      const requests = readyRuleHits.map(hit => actionOf(hit.ruleId, hit.action))
      if (requests.length > 0) this.pendingActions.push(...requests)
      if (result.consumeTo > this.consumeTo) this.consumeTo = result.consumeTo
      for (const line of lines) {
        if (!result.foldedAbs.has(line.abs)) this.pending.push(line)
      }
    }
    // 桥: 原始行照常喂 (armed 帧累积 / until / 边界); 与规则判定解耦。
    this.controller.feedLines(lines)
    this.debug('perception',
      `[感知] 文本块 ${lines.length} 行 (${inFrame ? '帧内' : '无主'}, 折叠 ${result.foldedAbs.size}, ` +
      `规则命中 ${result.hits.length}, 流程动作 ${flowHits.length}, 待决 ${this.pending.length})`)
    if (inFrame) return
    if (result.holding) {
      // 半截事务: 行留在待决, 暂不结算 —— 等捕获完成 (命中后合并投出) 或超时释放。
      this.armHoldTimeout()
      this.debug('perception', '[感知] holdDelivery: 多行捕获未完成, 本块暂不投递')
      return
    }
    this.clearHoldTimer()
    this.scheduleSettle()
  }

  /** 结算点: GA/EOR 边界 (帧切分点即投递点)。 */
  private onBoundary(kind: BoundaryKind): void {
    this.controller.boundaryReceived(kind)
    this.clearHoldTimer()
    this.settle()
  }

  /** 静默窗 / 行数上限结算 (无边界时的兜底)。 */
  private scheduleSettle(delayMs: number = this.config.bridgeSilenceMs): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    if (this.pending.length >= MAX_SETTLE_LINES) {
      this.settle()
      return
    }
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settle() }, delayMs)
  }

  /**
   * 单流切分与投递 (`doc/ARCHITECTURE.md` §5):
   *   有动作请求 → 动作消息 = `abs <= consumeTo` 的行 (带原文) + 动作请求;
   *   无动作请求 → 整段作为**批次** (T2) 并按预算裁剪。
   * 每个结算点最多一条消息 (I6); 每条行恰好投出一次、顺序不变 (I5)。
   */
  private settle(): void {
    if (this.settleTimer !== null) { clearTimeout(this.settleTimer); this.settleTimer = null }
    const standalone = this.standalone
    if (this.pending.length === 0) {
      // 没有待决行: 暂存的动作消息就地投出 (帧内命中 / 人工回填后的答案)。
      if (standalone !== null) this.flushStandalone()
      return
    }
    if (!this.config.agentEnabled) {
      this.debug('perception', `[感知] agent 未接入, ${this.pending.length} 行仅进终端`)
      this.pending.length = 0
      this.consumeTo = -1
      this.pendingActions = []
      this.standalone = null
      return
    }
    const agent = this.sink.agentOf(this.sessionId)
    if (this.awaitingHuman) {
      // **人工环节: 暂停全部投递** (验证码只能人工处理): 行留待决, 模型看不到提示也就
      // 不会自己去答; 人工回填后 (exitHumanWait) 立即冲刷。无超时, 仍受待决上限约束。
      if (this.pending.length > MAX_PARKED_LINES) {
        const dropped = this.pending.splice(0, this.pending.length - MAX_PARKED_LINES)
        this.counters.carryDropped += dropped.length
        this.sink.log(this.sessionId, `[验证码] 等待人工期间待决行超限丢弃 ${dropped.length} 行`)
      }
      this.debug('perception',
        `[感知] 人工环节 (等验证码): ${this.pending.length} 行留待决, 不投递`)
      return
    }
    const ready = agent !== undefined && (this.sink.agentReady?.(this.sessionId) ?? true)
    if (!ready) {
      // 无 live agent (官方尚未 materialize / 已 dispose), 或 agent 已在但**装配未就绪**
      // (preset 模式下官方 composition 还没切到 mud-player): 保留待决行, 等
      // onAgentReady 冲刷 —— 见 sink.agentReady 的说明。
      if (this.pending.length > MAX_PARKED_LINES) {
        const dropped = this.pending.splice(0, this.pending.length - MAX_PARKED_LINES)
        this.counters.carryDropped += dropped.length
        this.sink.log(this.sessionId, `[感知] 无 live agent: 待决行超限丢弃 ${dropped.length} 行`)
      }
      this.debug('perception',
        `[感知] 会话 agent ${agent === undefined ? '不存在' : '装配未就绪'}, ${this.pending.length} 行留待决 (等官方 agent 就绪)`)
      return
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
      this.debug('perception',
        `[感知] 原文投递 ${reflexLines.length} 行 + ${actions.length} 动作 (` +
        `agent ${agent.status}, 遗留 ${carry.length} 行)`)
      this.noteDelivered(reflexLines)
      this.deliver(agent, text, actions, 'T1 原文投递')
      return
    }
    // **T2 投递限流**（作者定案 2026-09-13）：距上次 T2 投递不足最小间隔 ⇒ 本批**不投**，
    // 行留在待决、把结算定时器延到差额到点。两个效果：① T2 不会被喂得太勤（回合开启频率被压住）；
    // ② 多个小批次天然合并成一个大批次（信息更全、回合更少）。
    // **只压 T2 批次**：上面的 T1 动作投递（规则/流程步）与 `standalone`/控制消息都不受影响 ——
    // T1 是系统流程，不能被"给模型限速"的闸压住。
    const t2Gap = this.config.t2DeliverIntervalMs ?? 0
    const sinceT2 = Date.now() - this.lastT2DeliverAt
    if (t2Gap > 0 && this.lastT2DeliverAt > 0 && sinceT2 < t2Gap) {
      // 动作投递（standalone）不受 T2 限流：它与 T1 同口径，被压住会让"重试重新取图"
      // 这类动作等不到人工环节开始就挂住（而且人工环节会暂停投递）。
      if (standalone !== null) this.flushStandalone()
      this.debug('perception',
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
    this.debug('perception',
      `[感知] 批次投递 ${batchLines.length} 行 (agent ${agent.status}, 队列 ${agent.inbox.nextTurn.length} 条)`)
    this.sendDelivery(agent, ownedGameMessage(text, 't2', this.sessionId))
    // 记下这次 T2 投递的时刻（下一次批次要等 `t2DeliverIntervalMs`）；defer 也算"喂过了"。
    this.lastT2DeliverAt = Date.now()
    this.decision({
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
    const delivery = `d${++this.deliverySeq}`
    this.rememberDelivery(delivery, actions)
    this.sendDelivery(agent, ownedGameMessage(text, 't1', this.sessionId, { actions, delivery }))
    this.decision({
      actor: 'router',
      eventType: 'feed-classify',
      action: reason,
      result: `${text.length} 字符, ${actions.length} 动作 (${actions.map(a => a.ruleId).join(',')})`,
      text: `[路由] ${reason} → T1`,
    })
  }

  // ── 投递通道：官方 `deferContext` / `followup`（§19.6.2） ──────────

  /** 记下一条投递的动作（动作数 = 判据 B；来源 = 工具结果 → 流程步骤的解析依据）。 */
  private rememberDelivery(delivery: string, actions: readonly ActionRequest[]): void {
    this.deliverySizes.set(delivery, actions.length)
    this.deliveryRules.set(delivery, actions.map(action => action.ruleId))
    this.deliveryPending.set(delivery, actions.length)
    // **按完成驱逐**：只清"结果已收齐"的投递（`noteToolResult` 把 pending 减到 0 的），
    // 在途的（T2 限速 / defer 连串 / 人工等值，结果可能很晚才回）必须保留 —— 收束判据
    // 与流程 tool 判据都靠账目里的 size/rule 解析。
    for (const key of this.deliveryPending.keys()) {
      if (key === delivery) continue
      if ((this.deliveryPending.get(key) ?? 0) > 0) continue
      this.deliveryPending.delete(key)
      this.deliverySizes.delete(key)
      this.deliveryRules.delete(key)
    }
    // **安全上限**：极端场景（结果长期不回 / 投递爆发）也不让账目无界增长；超限从最旧的
    // 开始丢（在途投递被丢后只是"少一次收束/少一条 tool 判据"，不会造成结构性错误）。
    const safetyCap = 32
    while (this.deliverySizes.size > safetyCap) {
      const oldest = this.deliverySizes.keys().next().value
      if (oldest === undefined) break
      this.deliverySizes.delete(oldest)
      this.deliveryRules.delete(oldest)
      this.deliveryPending.delete(oldest)
    }
  }

  /**
   * **投递一条 mud-owned 消息**（判据 A）：工具在途 ⇒ 存入 defer 槽，由该工具调用结束时
   * 随结果提交（`exec.deferContext` → 官方 `next-step` inbox → **同一回合的下一步**）；
   * 无工具在途 ⇒ 官方 `followup`（自己开一个回合）。
   *
   * 为什么这样分：`followup` 的官方语义是"这条消息独占它自己的回合"，而工具在途时我们**有
   * 更好的载体** —— 结果本身。随结果走既省一次空续步，又让"结果 → 下一步输入"严格有序。
   * @param agent 目标 agent。
   * @param message 已构造好的 mud-owned 消息。
   */
  private sendDelivery(
    agent: { followup: (message: ReturnType<typeof ownedGameMessage>) => void },
    message: ReturnType<typeof ownedGameMessage>,
  ): void {
    if (this.inFlightTools > 0) {
      this.deferSlot.push(message)
      this.debug('perception',
        `[感知] 投递改为 defer (工具在途 ${this.inFlightTools}): 随本结果进下一步`)
      return
    }
    agent.followup(message)
  }

  /** 工具调用进入/离开（官方工具包装器调用；判据 A 的"在途"判据）。 */
  beginToolCall(): void { this.inFlightTools += 1 }

  /** 工具调用离开（与 `beginToolCall` 配对）。 */
  endToolCall(): void { if (this.inFlightTools > 0) this.inFlightTools -= 1 }

  /** 取走 defer 槽（包装器在结果提交前逐条 `exec.deferContext`）。 */
  takeDeferredDeliveries(): ReturnType<typeof ownedGameMessage>[] {
    return this.deferSlot.splice(0)
  }

  /**
   * **判据 B**：本调用能否收束当前回合（`exec.concludeTurn`）。
   *
   * 三个条件同时成立才收束：① 本次工具调用是**某投递的最后一条动作**（call-id 形如
   * `mud-<delivery>-<index>` 且 `index === count-1`；T2 自己发起的调用 id 不匹配 ⇒ 永不收束）；
   * ② 没有待随结果提交的投递（defer 槽 / 待投递动作 / 暂存的动作投递 / 流程排队动作）；
   * ③ **流程机已空闲**（`flow.state() === null`）—— 流程还在推进（含等分支/等人工）时，
   * 收束权归流程自己的计时器与下一步，不能把回合掐掉。
   * @param callId 本次工具调用的 id。
   * @returns 是否应当 `concludeTurn()`。
   */
  shouldConcludeTurn(callId: string): boolean {
    if (!this.config.agentEnabled) return false
    const parsed = parseDeliveryCallId(callId)
    if (parsed === null) return false
    const count = this.deliverySizes.get(parsed.delivery)
    if (count === undefined || parsed.index !== count - 1) return false
    if (this.deferSlot.length > 0) return false
    if (this.pendingActions.length > 0) return false
    if (this.standalone !== null) return false
    if (this.flow.hasQueuedActions()) return false
    if (this.flow.state() !== null) return false
    return true
  }

  /**
   * **工具结果 → 流程机**（官方工具结果喂回流程；§19.1 的 `tool` 判据）。
   *
   * 只有本插件确定性 call-id（`mud-<delivery>-<index>`）能定位到投递与动作，
   * 进而定位到流程步骤（动作 `ruleId` = `flow:<flowId>/<stepId>`）；T2 自己发起的调用
   * 解析失败 ⇒ 什么都不做。
   * @param callId 本次工具调用 id。
   * @param ok 工具结果是否成功。
   */
  noteToolResult(callId: string, ok: boolean): void {
    const parsed = parseDeliveryCallId(callId)
    if (parsed === null) return
    // 记账：该投递的一条动作已收到结果（无论成败）。减到 0 = 收齐，交给下一次
    // `rememberDelivery` 按完成驱逐；这里**先不删**——同一次工具调用里 `shouldConcludeTurn`
    // 还要读 `deliverySizes` 判"最后一条动作"。
    const pending = this.deliveryPending.get(parsed.delivery)
    if (pending !== undefined) this.deliveryPending.set(parsed.delivery, pending - 1)
    const ruleId = this.deliveryRules.get(parsed.delivery)?.[parsed.index]
    if (ruleId === undefined || !ruleId.startsWith('flow:')) return
    const stepId = ruleId.slice('flow:'.length).split('/')[1]
    if (stepId === undefined || stepId === '') return
    const hits = this.flow.noteToolResult(stepId, ok)
    if (hits.length > 0) this.queueFlowActions(hits)
    this.drainFlowQueue()
  }

  /**
   * 动作投递 (无原文可带 —— 帧行已作为工具结果投过, 或压根没有行): 帧内命中 / 人工回填后的答案。
   * 暂存到下一次结算点统一投出（保证同一时刻只有一条投递在飞, I6）。
   */
  private deliverStandalone(text: string, actions: readonly ActionRequest[]): void {
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
    const agent = this.sink.agentOf(this.sessionId)
    if (agent === undefined) {
      // 无 live agent: 动作留待 onAgentReady 冲刷 (与待决行同一策略)。
      this.standalone = pending
      return
    }
    const text = pending.text.trim() === '' ? '[系统] 流程动作' : pending.text
    this.debug('perception', `[感知] 动作投递 ${pending.actions.length} 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)`)
    this.deliver(agent, text, pending.actions, 'T1 动作投递')
  }

  /**
   * 流程步动作 → 投递（帧内走动作投递；无主块随原文走原文投递）。
   *
   * **待人工的动作先挂起**（`doc/ARCHITECTURE.md` §19.3）：`awaitExternal` 的动作（占位符尚无
   * 值）**不投递**，存进人工槽、等人工回填后由 `exitHumanWait` 投出 —— 顺序是"先人工值、
   * 后投递"，与绑定 GA 的"先投递后唤醒"相反。挂起一律排在**本轮投递之后**：重试时"先投
   * 重新取图动作、再挂起答案动作"，投递不能被人工环节的暂停吃掉。
   *
   * 动作参数先按**流程实例槽**插值（`{captchaUrl}` / `{lastFail}`）；`{captcha}` 等外部值
   * 留到发送瞬间。
   */
  private queueFlowActions(hits: readonly FlowActionHit[]): void {
    if (hits.length === 0) return
    const slots = this.flow.slots()
    const names = this.flow.slotNames()
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
        this.pendingActions.push(request)
        if (hit.anchorAbs > this.consumeTo) this.consumeTo = hit.anchorAbs
      }
      // 流程动作也要走结算 (无主块已在 onTextBlock 里进 pending)。
      this.scheduleSettle()
    }
    for (const hit of framed) {
      const request = fillSlots(actionOf(hit.ruleId, { output: hit.output, tool: hit.tool }), slots, names)
      if (this.needsHuman(hit.awaitExternal)) {
        parks.push({ request, framed: true, keys: hit.awaitExternal ?? [] })
        continue
      }
      this.deliverStandalone(hit.text, [request])
    }
    // 投递已 staged（此时还没进人工环节，避免"人工暂停"把刚 staged 的动作一起压住）。
    for (const park of parks) {
      // 同类动作只保留最新一条（重复重试不堆叠）。
      this.pendingExternal = this.pendingExternal.filter(queued => queued.ruleId !== park.request.ruleId)
      this.pendingExternal.push(park.request)
      this.enterHumanWait(park.request.ruleId, park.keys)
    }
  }

  /** 该动作是否需要人工补值（`awaitExternal` 声明且占位符尚无值）。 */
  private needsHuman(keys: readonly string[] | undefined): boolean {
    return keys !== undefined && keys.some(key => this.externalValues[key] === undefined)
  }

  /**
   * 流程已结束（收束/失败/复位/打断）而人工环节还挂着时，退出人工环节。
   *
   * 覆盖"人工预算耗尽"这条主路径（`answer` 步的计时器到点 → 流程失败收束）以及打断/断线：
   * 流程都没了，投递与看门狗必须恢复，挂起的动作作废。
   */
  private syncHumanWait(): void {
    if (!this.awaitingHuman) return
    if (this.flow.state() !== null) return
    this.awaitingHuman = false
    this.pendingExternal = []
    this.log('[验证码] 流程已结束 → 退出人工环节 (挂起的动作作废, 投递与看门狗恢复)')
  }

  /** holdDelivery 兜底: 捕获长期不完成 → 释放结算 (按无动作投出批次)。 */
  private armHoldTimeout(): void {
    this.clearHoldTimer()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (this.disposed) return
      this.counters.holdReleases += 1
      this.debug('perception',
        `[感知] holdDelivery 超时释放 (${this.pending.length} 行, 捕获未完成) → 按无动作结算`)
      this.settle()
    }, this.config.holdTimeoutMs)
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

  // ── 世界变化入口 / 登录流程收尾 / 程序唤醒 ─────────────

  /**
   * 世界模型变化后的**唯一入口** (幂等): 看门狗起停 + 登录流程收尾。
   *
   * 所有写世界的路径都调它: 连接建立/关闭、GMCP、感知 state 折叠、`world_patch` 工具
   * (`buildMudTools.onWorldChange`)、`onAgentReady`。集中一处是为了不再"哪里漏了就补
   * 一次布防" —— 实测连踩两次 (登录完成不布防断流 / 断线后仍空转)。
   */
  private noteWorldChange(): void {
    // 流程入口的 `when` 读 world（login: !logged_in；fullme: logged_in）→ 世界一变就重算
    // 入口布防，否则"登录完成后 fullme 入口永远不 arm"（流程机只在收束/复位时自己重算）。
    this.flow.refreshEntries()
    this.watchdogs.reevaluate()
  }

  /**
   * 主动请求 agent 决策 (程序唤醒; 控制消息 lane=t2)。
   * **未连接时不做任何唤醒** — 没有连接就没有可决策的游戏局面, 唤醒只会让
   * agent 空转 (工具全部拒绝) 并挤占后续真正该跑的 T1 批次。
   */
  private requestAgent(reason: string, context: string): void {
    if (this.disposed || !this.config.agentEnabled) return
    if (this.awaitingHuman) return   // 人工环节 (验证码): 任何唤醒源都不许把 agent 叫起来
    if (this.connectionId === null) return
    const agent = this.sink.agentOf(this.sessionId)
    if (agent === undefined) return
    this.decision({ actor: 'agent', eventType: reason, action: 'agent', text: `[决策] ${reason}` })
    agent.followup(ownedGameMessage(`${CONTROL_PREFIX}${context}`, 't2', this.sessionId))
    // 控制消息也算一次 T2 投递：紧随其后的批次要等最小间隔（避免"刚唤醒又喂"）。
    this.lastT2DeliverAt = Date.now()
  }
}