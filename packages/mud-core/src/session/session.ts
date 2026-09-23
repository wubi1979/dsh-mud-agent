/**
 * dsh-mud-core — 会话运行时 (MudSessionRuntime), host half.
 *
 * **一个 MUD 会话 = 一个 DSH 会话**。本类是该会话的**壳**: 连接绑定 (session →
 * connection, 方向单向)、WorldModel、人工环节 (fullme 验证码的挂起/回填/等待者)、
 * 命令队列与看门狗; 行流/元事件入口、五站消费链与投递记账/节拍在裁决器
 * (`adjudicator.ts`, v0.9 W7.1) — 本类只经 deps 回调向其暴露 sink/queue/state 等
 * 出口与人工状态。
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
 * @module @deepseek-ai/dsh-mud-core/session/session
 */

import { CommandQueue } from '../agent/queue.ts'
import { buildMudTools } from '../agent/tools-build.ts'
import type { MudTools } from '../agent/tools-schema.ts'
import { buildGateRules, type GateRules } from '../agent/gate/rules.ts'
import { ownedGameMessage } from '../deliver/lane.ts'
import { InflightWindowTable, type ReplySettle } from '../agent/inflight.ts'
import { placeholderValues, redactCredential, redactSecrets, type SessionCredentials } from './credentials.ts'
import { ConnectionRuntime } from './connection-runtime.ts'
import { DeliveryChannel } from '../deliver/delivery-channel.ts'
import type { MudLine } from '../network/ansi.ts'
import { StateService } from '../deliver/state-track.ts'
import { createWorld, worldSnapshot, type WorldModel } from '../world/state.ts'
import { CONTROL_PREFIX } from '../perceive/types.ts'
import type { PerceptionRule } from '../perceive/types.ts'
import { MudConnectionManager } from '../network/manager.ts'
import { WatchdogTable } from './watchdogs.ts'
import type { FlowSlot } from '../agent/flow/slot.ts'
import { FlowRuntime } from '../agent/flow/engine.ts'
import { defaultFlows } from '../agent/flow/flows/index.ts'
import type { MudWorldSnapshot } from '../shell/remote-types.ts'
import { SessionAdjudicator, t2Allowed } from '../deliver/adjudicator.ts'
// 投递通道契约 (type-only; 无运行时环): 本类**实现**该接口 —— 方法漂移时编译期就报,
// 不再退化成"静默走 channel===undefined 分支"(mount.ts 记录过这个 bug 已发生一次)。
import type { MudDeliveryChannel } from './mount.ts'
import {
  fillSlots,
  type ActionRequest,
  type CommandActor,
  type MudDecisionRecord,
  type MudRuntimeConfig,
  type MudRuntimeSink,
  type MudSessionDiag,
  type MudSessionStatus,
} from './types.ts'

/**
 * ask-human 验证码等待兜底超时 (固定值, 不暴露给模型): 略小于 fullme 图片有效期
 * (answer/prompt 步预算 180s), 保证工具结果先于流程计时器结算 —— 等待失败走工具
 * 判据 (`tool error`) 而不是步超时兜底, 两种路径都能收束但归因更清晰。
 */
const CAPTCHA_WAIT_MS = 175_000


/**
 * 单个 MUD 会话的运行时。所有字段都是**会话私有** — 不存在跨会话共享的
 * 可变状态 (旧实现的 `SID='console'` 单槽位与全局 `agent` 变量已移除)。
 */
export class MudSessionRuntime implements MudDeliveryChannel {
  readonly sessionId: string
  readonly config: MudRuntimeConfig
  private readonly sink: MudRuntimeSink
  /** 连接域 (重连状态机/socket 接线/凭据/写出口) 收拢在连接运行时, 事件回调回会话。 */
  private readonly conn: ConnectionRuntime
  private readonly world: WorldModel = createWorld()
  private readonly state: StateService
  private readonly windows: InflightWindowTable
  private readonly queue: CommandQueue
  /** 投递通道 (工具在途/defer 槽/投递账本/T2 时刻; 编排留在本类, 机制归通道)。 */
  private readonly channel: DeliveryChannel
  private worldTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 唤醒类看门狗 (断流) —— 起停条件声明在构造器里, 运行时只在固定的状态变化点调用
   * `watchdogs.reevaluate()`/`touch()` (见 `session/watchdogs.ts`)。
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
  /**
   * ask-human 挂起的 `mud_captcha` 工具等待者 (对齐官方 `ApprovalService.request`:
   * 提问发生在**未收束的回合内**, 工具调用保持 in-flight, 人工提交/中止/超时 resolve 或
   * reject 该 Promise —— 码随**工具结果**回管线, 后续动作 defer 进同一回合)。
   */
  private captchaWaiter: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null
  /** 外部占位符值 (`{captcha}` → 人工输入的验证码; 发送瞬间插值)。 */
  private externalValues: Record<string, string> = {}
  private connectCount = 0
  /** 是否已投过空回合 starter (仅无内容会话首连发一次; 遮投递↔落事件窗口)。 */
  private starterSent = false
  private latestWorld: MudWorldSnapshot | null = null
  private toolCache: MudTools | null = null
  private disposed = false
  /** 门禁注入规则 (direct-exec 判定用; 见 agent/gate/rules.ts)。 */
  private readonly gateRules: GateRules
  /** 最近一次 connect/agent/连接失败 (diag)。 */
  lastError: string | null = null
  /**
   * 行流裁决器 (v0.9 W7.1): 行流/元事件唯一入口 + 五站消费链 + 投递记账 + 投递节拍。
   * 分帧器 (FrameSplitter) 已并入其内; 人工交互状态 (awaitingHuman/externalValues)
   * 归本壳, 经 deps 回调只读写。
   */
  private readonly adjudicator: SessionAdjudicator

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
    this.gateRules = buildGateRules(config.dangerous !== undefined ? { dangerous: config.dangerous } : undefined)
    this.sink = sink
    this.conn = new ConnectionRuntime({
      connections,
      defaultHost: config.defaultHost,
      defaultPort: config.defaultPort,
      log: (text) => this.log(text),
      debug: (text) => this.debug('network', text),
      // 数据面透传 (感知域): 文本/行/边界/GMCP 由会话处理。
      onText: (text) => { this.feedRaw(text) },
      onLines: (lines) => { this.onTextBlock(lines) },
      onBoundary: (kind) => { this.adjudicator.boundary(kind) },
      onGmcp: (pkg, payload) => {
        this.state.onGmcp(pkg, payload)
        // GMCP 是权威登录信号 (置信度 1.0) → 走世界变化统一入口。
        this.noteWorldChange()
      },
      events: {
        onConnected: () => { this.onSocketConnect() },
        onClosed: () => { this.onSocketClose() },
        onError: (message) => { this.lastError = message },
      },
    })
    this.channel = new DeliveryChannel({
      debug: (text) => this.debug('perception', text),
    })
    this.state = new StateService({ world: this.world, onChanged: () => { this.pushWorld() } })
    // 在途窗口表 (W7.2): 命令-应答桥的后继。注册/结算/N-GA 关窗/超时/断线都在表内,
    // 宿主只接四条线: 发送 (经队列节流)、win- 标记武装/注销 (转裁决器)、直发延后 gate。
    this.windows = new InflightWindowTable({
      send: (cmd, meta) => { this.queue.send(cmd, { ...meta }) },
      onArm: (markerId, pattern) => { this.adjudicator?.armWindowMarker(markerId, pattern) },
      onDisarm: (markerId) => { this.adjudicator?.disarmWindowMarker(markerId) },
      onGate: (active) => { this.queue.setGate(active) },
      onDropQueued: (replyId) => { this.queue.discardByReplyId(replyId) },
      onLog: (text) => this.debug('network', text),
      defaultTimeoutMs: config.bridgeTimeoutMs,
      declaredTimeoutMs: config.bridgeDeclaredTimeoutMs,
      // span 起点取样 (W10.2): confirmSent 时点的行流缓冲半区水位 (裁决器 feedLines 更新)。
      // windows 先于 adjudicator 创建, 用可选链回落 -1 (裁决器缺省也是 -1, 语义一致)。
      absWatermark: () => this.adjudicator?.absWatermark() ?? -1,
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
        active: () => t2Allowed(this.config.agentMode)
          && this.conn.id !== null
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
        const changes = this.state.patch(patch, 'flow')
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
        // 失败也可能来自流程自己的计时器（不经过 offer/noteToolResult）→ 这里补一次出队。
        this.adjudicator.drainFlowQueue()
        this.requestAgent('流程失败', `${context} — 请判断是重试、换做法还是告知用户。`)
      },
      // 流程日志里的命令文本一律脱敏（密码/验证码不落日志；实测踩过一次明文泄漏）。
      mask: (text) => { return redactSecrets(text, this.conn.credentials?.pass, this.externalValues) },
      // §8.5 武装集同步: 流程布防 (入口 driver / 步 ok·fail / 分支进入判据) 注册为
      // 裁决器武装标记 —— 命中 → 帧立即提交 → 消费链运行 → 唤醒/推进当场发生。
      // 构造期 flow.armEntries() 即触发, 此时裁决器尚未建立 → 可选链吞掉, 由
      // 裁决器 register() 末尾的 syncArming() 全量重放补上 (W7.3 唯一注册入口)。
      onArmSync: (markers) => { this.adjudicator?.syncFlowMarkers(markers) },
      // 形态 C（2026-09-21）：本步判据随窗口走（`closeOn` 关闭触发 + 驱动器在推进点复判），
      // 会话侧不再有"流程判据命中即收口窗口"的旁路 —— 收口器就在窗口里。
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
    // 行流裁决器 (v0.9 W7.1): 五站消费链 / 投递记账 / 投递节拍上移, 分帧器并入其内。
    // 人工交互状态与出口副作用留在壳, 经 deps 回调读写。触发规则经 registration
    // 在裁决器构造器内 register() 一次性注册 (§1.2 唯一注册入口)。
    this.adjudicator = new SessionAdjudicator({
      sessionId: this.sessionId,
      config: this.config,
      windows: this.windows,
      flow: this.flow,
      channel: this.channel,
      queue: this.queue,
      state: this.state,
      tools: () => this.tools(),
      registration: {
        stateRules: perception.stateRules,
        eventRules: perception.eventRules,
        holdRuleIds: perception.holdRuleIds,
        gateRules: this.gateRules,
      },
      agentOf: () => this.sink.agentOf(this.sessionId),
      agentReady: () => this.sink.agentReady?.(this.sessionId) ?? true,
      isAwaitingHuman: () => this.awaitingHuman,
      hasConnection: () => this.conn.id !== null,
      missingExternalValues: (keys) => keys.filter(key => this.externalValues[key] === undefined),
      parkForHuman: (request, keys) => {
        // 同类动作只保留最新一条 (重复提示不堆叠)。
        this.pendingExternal = this.pendingExternal.filter(queued => queued.ruleId !== request.ruleId)
        this.pendingExternal.push(request)
        this.enterHumanWait(request.ruleId, keys)
      },
      log: (text) => { this.log(text) },
      debug: (channel, text) => { this.debug(channel, text) },
      decision: (record) => { this.decision(record) },
      onWorldChange: () => { this.noteWorldChange() },
    })
    // flow 构造期与裁决器 register() 内部的两次 syncArming 都在 `this.adjudicator`
    // 赋值完成前触发, 被可选链吞掉 → 赋值完成后这里全量重放一次 (幂等, 补上入口布防;
    // 重连/断线路径则由 resetForReconnect/abortForDisconnect 内的 register() 直接生效)。
    this.flow.syncArming()
  }

  // ── 对外状态 ───────────────────────────────────────────

  /** 是否已建立 socket。 */
  get connected(): boolean {
    return this.conn.state === 'connected'
  }

  /** 传输层状态。 */
  get connectionState(): 'idle' | 'connecting' | 'connected' {
    return this.conn.state
  }

  /** 当前连接的账户名 (命令回显署名; 未连接/未设账户 = null)。 */
  get accountName(): string | null {
    return this.conn.credentials?.name ?? null
  }

  /** 状态快照。 */
  status(): MudSessionStatus {
    const info = this.conn.info
    return {
      sessionId: this.sessionId,
      connected: info.state === 'connected',
      state: info.state,
      host: info.host,
      port: info.port,
      accountName: info.state === 'connected' ? (this.conn.credentials?.name ?? null) : null,
    }
  }

  /** 世界模型快照 (JSON 可序列化)。 */
  snapshot(): MudWorldSnapshot {
    return worldSnapshot(this.world)
  }

  /**
   * 最近 n 行游戏输出缓冲 —— **诊断通路**（2026-09-21 定案）。
   *
   * 不再是模型工具面：`mud_recall` 已删除、`mud_state` 去 `lines` 参数 —— T2 的上下文
   * 就是会话历史本身，本插件不提供任何"拉取"通路（不查 pending、不查缓存帧）。
   * 保留本方法与 `adjudicator.recall()` 仅供 `/mud/diag` 与日志排障使用。
   * @param count 最多返回行数 (取最新的 count 行)。
   * @returns 缓冲行纯文本 (可能为空)。
   */
  recall(count: number): string[] {
    return this.adjudicator.recall(count)
  }

  /**
   * **当前流程槽**（形态 C 第 5 步：T1 按 `sessionId` 查表用）。
   *
   * 只读投影；槽表归**本会话**（D10 / I8），T1 adapter 自身保持无状态。空闲 = null。
   */
  slot(): FlowSlot | null {
    return this.flow.slot()
  }

  /** 登记"已渲染但在途"的调用 id（T1 渲染后调用；随下一次迁移点自动复位）。 */
  markSlotRendered(callId: string): void {
    this.flow.setPendingCallId(callId)
  }

  /** 本会话的工具集 (闭包绑定本会话的队列/在途窗口/world/凭据)。 */
  tools(): MudTools {
    if (this.toolCache !== null) return this.toolCache
    this.toolCache = buildMudTools({
      send: (cmd) => { this.queue.send(cmd) },
      // 在途窗口注册 (W7.2): 工具自带声明 (closeOn/gaCount/timeoutMs) 与流程表覆盖
      // (windowSpecFor) 在此合并。命令文本的凭据/外部值插值已在工具层 (tools.ts wire())
      // registerWindow 之前完成, 这里不做二次插值 —— values 只供 windowSpecFor 做命令比对。
      registerWindow: (request) => {
        const values = placeholderValues(this.conn.credentials, this.externalValues)
        const override = this.flow.windowSpecFor(request.cmd, values)
        // 形态 C: 窗口只持**关闭触发 / GA 计数 / 兜底时长**三件 (没有分类/抽取面)。
        // 流程步在途时用流程覆盖 (含派生触发), 否则用工具自带声明。
        return this.windows.register({
          cmds: Array.isArray(request.cmd) ? [...request.cmd] : [request.cmd],
          ...(override === null
            ? {
              ...(request.closeOn !== undefined ? { closeOn: request.closeOn } : {}),
              ...(request.gaCount !== undefined ? { gaCount: request.gaCount } : {}),
              ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
            }
            : {
              ...(override.closeOn !== undefined ? { closeOn: override.closeOn } : {}),
              ...(override.gaCount !== undefined ? { gaCount: override.gaCount } : {}),
              ...(override.timeoutMs !== undefined ? { timeoutMs: override.timeoutMs } : {}),
            }),
          ...(request.label !== undefined ? { label: request.label } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      },
      // 人工等待诊断通道 (mud_captcha ask-human 挂起段): 进窗口表 diag, 仅诊断不参与 gate。
      humanWindow: {
        begin: (label) => { this.windows.beginHuman(label) },
        end: () => { this.windows.endHuman() },
      },
      log: (t) => this.log(t),
      world: this.world,
      resolveCredentials: () => this.conn.credentials ?? undefined,
      // 未连接时工具快速拒绝 (不注册窗口): agent 提前被唤醒也不会把命令塞进队列
      // 换来一串 "写 socket 失败"。
      isConnected: () => this.connectionState === 'connected',
      // 工具改写世界 (典型: login:done 规则渲染的 world_patch {logged_in:true}) 后
      // 重评估看门狗 —— 登录完成不是感知事件, 不重评估就永远不会布防断流计时。
      onWorldChange: () => { this.noteWorldChange() },
      resolveExternalValues: () => this.externalValues,
      // fullme 流程的解析步（`prompt`）调 `mud_captcha`：工具负责解析（出站围栏 + 取图），
      // 这里只把结果交给宿主推前台弹窗（`note` = 上一轮答错原文，供人工参考）；
      // `wait` = ask-human 挂起点：推图后工具不返回，人工提交/中止/超时才带回码。
      captcha: {
        push: (imageUrl, robotUrl, note) => {
          this.sink.captcha?.(this.sessionId, {
            imageUrl,
            robotUrl,
            ...(note === undefined ? {} : { note }),
          })
        },
        wait: opts => this.awaitCaptchaSubmit(opts),
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
   * 建立本会话的游戏连接。传输层只拿到 host/port; 会话 → 连接绑定、重入防护
   * 与凭据持有都在连接运行时 (`conn`)。
   * @param host 服务器主机 (缺省 config.defaultHost)。
   * @param port 端口 (缺省 config.defaultPort)。
   * @param account 登录账户 (命令回显署名 + {name}/{pass} 插值源)。
   */
  connect(host?: string, port?: number, account?: SessionCredentials): void {
    if (this.disposed) return
    this.conn.connect(host, port, account)
  }

  /** 断开本会话连接 (未连接时空操作)。 */
  disconnect(): void {
    this.conn.disconnect()
  }

  /**
   * 手动命令 (WebUI/用户): 走队列节流 + 'user' 归属 (直发命令受在途窗口直发延后
   * gate 约束, §2.8 —— 不绕过窗口的 N-GA 计数)。
   *
   * **人工验证码例外** (§19.3 人工只负责提供值): 等人工期间用户提交的输入不直接发出,
   * 而是当作**外部占位符值**回填 (`{captcha}`) 并解挂 ask-human 等待者 —— 输入只收
   * **图片里的文字 (裸码)** (弹窗语义), 兼容 `fullme <码>` 前缀; 随后流程 answer 步
   * 动作统一包装成 `halt + fullme {captcha}` 发出 (`doc/ARCHITECTURE.md` §11)。
   * @param cmd 原始命令。
   * @param actor 归属 (agent/user/system)。
   * @returns 是否被接受 (人工回填也算接受)。
   */
  sendCommand(cmd: string, actor: CommandActor = 'user'): boolean {
    const trimmed = cmd.trim()
    if (trimmed === '') return false
    if (this.awaitingHuman && actor === 'user') {
      const code = trimmed.replace(/^fullme\s*/i, '').trim()
      if (code === '') {
        this.log('[验证码] 收到空验证码, 继续等人工输入')
        return true
      }
      this.exitHumanWait({ captcha: code })
      return true
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
    this.adjudicator.settle()
    this.noteWorldChange()
  }

  /**
   * `agent/turn-stopping`（D0/D6）：回合边界 = 流程边界 —— 活跃流程在此失效。
   *
   * 出队/接续不在做这（此刻可能还有排队回合要开）；真正的静止点在 `onAgentIdle()`。
   */
  onTurnStopping(): void {
    if (this.disposed) return
    this.flow.noteTurnEnd()
  }

  /**
   * `agent/status` → idle（D0/D6）：官方静止点（无工具在途、无排队回合）。
   *
   * 顺序固定：① 活跃失效兜底（turn-stopping 已做则空转）→ ② 重算入口布防 →
   * ③ 打断事件动作 followup 投递（D5，新回合）→ ④ 判定节点排队动作出队 →
   * ⑤ 排队流程入口出队（pendingEntry 原路重放）。
   */
  onAgentIdle(): void {
    if (this.disposed) return
    this.flow.noteTurnEnd()
    this.flow.refreshEntries()
    this.adjudicator.flushInterruptFollowups()
    this.adjudicator.drainFlowQueue()
    this.adjudicator.drainQueuedEntries()
  }

  /** 释放本会话运行时: 关连接、清定时器、停队列、关在途窗口表。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // ask-human 等待者一并解挂: 会话都没了, 工具 Promise 不能悬挂 (fail-closed)。
    const waiter = this.captchaWaiter
    this.captchaWaiter = null
    if (waiter !== null) waiter.reject(new Error('会话已释放'))
    this.windows.close()
    this.queue.clear()
    this.watchdogs.dispose()
    this.conn.close()
    // world 推送是 500ms 防抖: 必须 clearTimeout —— 只置 null 会让定时器在 purge 之后
    // 仍触发一次 sink.pushWorld(已注销会话) (assemble 的 purge 语义: 该身份不应再能被读回)。
    if (this.worldTimer !== null) clearTimeout(this.worldTimer)
    this.worldTimer = null
    this.adjudicator.dispose()
    this.channel.reset()
    this.flow.dispose()
  }

  /** 诊断: 待决/流程/在途窗口/缺陷计数/人工环节 (不变量 I4/I9 的观测面)。 */
  diag(): MudSessionDiag {
    const metrics = this.adjudicator.metrics()
    return {
      sessionId: this.sessionId,
      connectionId: this.conn.id,
      connected: this.connected,
      pending: metrics.pending,
      actionsPending: metrics.actionsPending,
      flow: this.flow.state(),
      windows: this.windows.diag(),
      recall: metrics.recall,
      agent: this.sink.agentOf(this.sessionId) !== undefined,
      awaitingHuman: this.awaitingHuman,
      lastError: this.lastError,
      counters: metrics.counters,
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
    const creds = this.conn.credentials
    const name = creds?.name ?? 'user'
    this.pushGame(`\x1b[94m${name}@${actor}>${redactCredential(cmd, creds?.pass)}\x1b[0m`)
  }

  /** 真实写 socket (队列 onSend 调用; 未连接 = false)。 */
  private writeToSocket(cmd: string, actor: CommandActor = 'agent'): boolean {
    const sent = this.conn.write(cmd)
    if (sent) {
      this.appendCommandEcho(String(cmd), actor)
      this.log(`[发送] ${cmd === '' ? '<空行>' : redactCredential(cmd, this.conn.credentials?.pass)}`)
    }
    return sent
  }

  /** 队列 onSend: 真实写 socket 后确认在途窗口武装 (失败回执, 防 sending 死锁)。 */
  private onQueueSend(cmd: string, meta: { actor?: CommandActor; replyId?: string }): void {
    let sent = false
    try {
      sent = this.writeToSocket(cmd, meta.actor ?? 'agent')
    } catch (err) {
      this.log(`[发送] 写 socket 异常: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (sent && meta.replyId !== undefined) {
      // 窗口行由窗口表自己累积 (feedLines; 含队列节流窗口里提交的帧): 宿主只回执
      // "真实写出" —— 计时与 win- 标记武装都从这一刻开始。
      this.windows.confirmSent(meta.replyId)
    } else if (meta.replyId !== undefined) {
      this.windows.sendFailed(meta.replyId, `写 socket 失败: ${cmd === '' ? '<空行>' : cmd}`)
    }
  }

  // ── socket 事件 ────────────────────────────────────────

  private onSocketConnect(): void {
    // 成功路径清除 (W11.1②): 新连接建立 ⇒ 上一次错误文案过期, 不得在 diag 里
    // 继续遮蔽新状态 (写入点在 ConnectionRuntime 的 onError, 只写不清)。
    this.lastError = null
    // 新连接 = 新登录会话: 直接复位登录态 (置信度护栏压不过上次 GMCP 1.0)。
    this.world.flags.logged_in = false
    this.world.flags.awaiting = true
    if (this.world._conf.flags) {
      delete this.world._conf.flags.logged_in
      delete this.world._conf.flags.awaiting
    }
    this.state.patch({ connected: true }, 'lifecycle')
    this.pushWorld()
    this.connectCount += 1
    this.appendConnectMarker(this.connectCount === 1 ? 'connect' : 'reconnect')
    this.state.patch({ sent_name: false, sent_pass: false }, 'lifecycle')
    this.watchdogs.resetCounts()
    this.noteWorldChange()
    // 传输断裂 = 感知上下文作废: 重连复位在途窗口表/行流裁决器与投递缓冲。裁决器内的
    // 行流缓冲 (开放帧+武装标记) 与投递记账/交付水位一并复位, 引擎重建 + 打断标记重挂
    // + flow arming 重放全在 register() 一次完成 (§1.2: W7.3 取代旧散点补刀)。
    this.windows.reset()
    this.adjudicator.resetForReconnect()
    // 人工环节 (验证码) 属上一连接的上下文: 挂起的命中与外部值一并作废。
    this.awaitingHuman = false
    this.pendingExternal = []
    this.externalValues = {}
    // 投递通道状态随连接作废: defer 槽里的消息属于上一连接的局面, 不再投出。
    this.channel.reset()
    // 首连即翻会话 blank (连接点 UX): 新会话在首个 turn/start 前官方不渲染会话体,
    // 而旧路径要等第一批游戏输出走完 帧装配→感知→投递 整条链才开回合 —— 明显慢于
    // 数据到达。**仅无内容会话** (session.seq === 0) 才发空回合; 已有历史的会话
    // blank 已翻 (DSH 回到历史会话自动渲染), 再发只是多余的 finish stop。
    void this.deliverStarterTurn()
  }

  private onSocketClose(): void {
    this.windows.close()
    this.queue.clear()
    // 断线: 未投出的行与半截捕获失去上下文 (多行状态随连接作废), 丢弃并记日志。
    // 裁决器收尾: hold/结算计时清除 + 待决行丢弃留痕 + 行流缓冲/武装标记复位重挂。
    this.adjudicator.abortForDisconnect()
    // 断线 = 唤醒类看门狗全部停表 (`active()` 里的连接门已不满足); 流程实例随连接作废。
    this.watchdogs.reevaluate()
    this.flow.noteDisconnect()   // → 复位到只留入口 → armEntries → onArmSync 重挂流程标记
    this.state.patch({ connected: false }, 'lifecycle')
    this.pushWorld()
  }

  // ── 人工环节 (fullme 验证码) ───────────────────────────

  /**
   * 进入人工环节: 暂停全部投递 + 停看门狗 (规则表的 `active()` 里读 `awaitingHuman`)。
   * 取图与弹窗由 `mud_captcha` 工具自己完成; 计时用本步自己的预算 (fullme 图片有效期)。
   * @param ruleId 触发来源 id (留痕: 流程步命中或 ask-human 工具)。
   * @param missing 缺失/待回填的占位符名 (留痕)。
   */
  private enterHumanWait(ruleId: string, missing: readonly string[]): void {
    if (this.awaitingHuman) return
    this.awaitingHuman = true
    this.log(`[验证码] 进入人工环节 (${ruleId}; 缺 ${missing.map(k => `{${k}}`).join('/')}; ` +
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
   * **ask-human 挂起点** (`mud_captcha` 工具的 `wait`; 对齐官方 `ApprovalService.request`
   * —— 提问要求回合开着, 审计对/工具结果都被未收束的回合包住): 注册等待者并进入人工
   * 环节, 直到人工提交 (resolve)、弹窗中止 (`cancelHumanWait`)、本步预算耗尽 (流程机
   * 超时 → `syncHumanWait` 解挂) 或回合取消 (signal)。工具侧超时是固定兜底
   * (`CAPTCHA_WAIT_MS` < 图片有效期 180s), 保证工具结果先于流程计时器结算。
   * @param opts `signal` = 回合取消信号。
   * @returns 人工提交的验证码 (裸值)。
   */
  private awaitCaptchaSubmit(opts: { signal?: AbortSignal | undefined }): Promise<string> {
    this.enterHumanWait('mud_captcha', ['captcha'])
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = (run: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== null) { clearTimeout(timer); timer = null }
        if (this.captchaWaiter !== null) this.captchaWaiter = null
        opts.signal?.removeEventListener('abort', onAbort)
        run()
      }
      const onAbort = (): void => finish(() => reject(new Error('回合已取消 (abort)')))
      this.captchaWaiter = {
        resolve: code => finish(() => resolve(code)),
        reject: err => finish(() => reject(err)),
      }
      timer = setTimeout(() => finish(() => reject(new Error(
        `人工未在 ${CAPTCHA_WAIT_MS}ms 内提交验证码 (图片有效期兜底)`))), CAPTCHA_WAIT_MS)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 弹窗"中止" → ask-human 等待当场失败 (fail-closed): 工具结果 `ok:false` → 所在步按
   * 工具判据失败收束 (§19.3 与官方 `cancelled` 同型)。无挂起等待时是空操作。
   */
  cancelHumanWait(): void {
    if (this.captchaWaiter === null) return
    const waiter = this.captchaWaiter
    this.captchaWaiter = null
    this.log('[验证码] 人工中止 → ask-human 等待失败, 流程收束')
    waiter.reject(new Error('人工中止验证码输入'))
  }

  /**
   * 人工提交验证码后退出人工环节 —— **ask-human 收口** (两种形态同一出口):
   *   - 首次提问 (prompt 步工具挂起中): 有 waiter、无挂起动作 → 只解挂 + 填值。
   *     工具结果带回回合内 → 流程进 answer → 动作在工具在途窗口内 defer 进**同一回合**
   *     —— 这里绝不投递、不开新回合 (旧版回合分裂的根源就在这条多余投递);
   *   - 答错反复 (answer 步 tryRetry 再挂起): 有 waiter、有挂起动作 → 解挂 + 投出,
   *     投递落在第二次提问的工具在途窗口内 → defer 随其结果进同一回合;
   *   - 旧装配兜底 (无 waiter): 保留原 standalone 投递路径 (流程机已 resumeHuman)。
   *
   * 顺序: **先解挂 waiter** (resolve 是微任务, 工具续跑晚于本同步函数), 再 `resumeHuman`
   * + 投挂起动作 (此时工具仍在途 → 落 defer 槽; halt 优先级豁免直发延后 gate, §2.8);
   * 计时器**不重布防**（等人与重试共用本步那一份预算）。
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
    const waiter = this.captchaWaiter
    this.captchaWaiter = null
    const parked = this.pendingExternal
    this.pendingExternal = []
    this.log(`[验证码] 人工已提交: ${Object.keys(values).map(k => `{${k}}`).join('/')} → ` +
      `${waiter === null ? '旧装配路径' : '解挂 ask-human 等待者'}, 挂起动作 ${parked.length} 条, 投递与看门狗恢复`)
    this.decision({
      actor: 'flow',
      flow: 'fullme',
      eventType: 'fullme:answer',
      action: 'T1 发送 fullme',
      text: '[流程] fullme: 人工已提交, T1 发送',
    })
    if (waiter !== null) waiter.resolve(values.captcha ?? '')
    // 两拍（第 5 步③）：有拍 1 在途只翻相位；否则发布拍 2（本步动作进槽，T1 按槽渲染）。
    this.flow.resumeHuman()
    const slots = this.flow.slots()
    const names = this.flow.slotNames()
    this.noteWorldChange()   // 看门狗恢复
    // 流程步两拍后 `pendingExternal` 应为空（动作不经 park、由槽发布）；仍挂着的是
    // 入口/旧装配路径的兜底 —— 照常投出，不删这条防御通路。
    if (parked.length > 0) {
      this.adjudicator.deliverStandalone(
        `[系统] 人工已提交验证码 (${parked.map(entry => entry.ruleId).join('/')})`,
        parked.map(entry => fillSlots(entry, slots, names)),
      )
    }
    this.adjudicator.settle()  // 冲刷暂存动作 + 等人工期间攒下的行（在途窗口内 → defer 进同一回合）
  }

  /** 写入连接/重连分隔文本到终端缓冲。 */
  private appendConnectMarker(kind: 'connect' | 'reconnect'): void {
    const when = new Date().toLocaleString()
    const label = this.conn.credentials?.name ?? ''
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
   * L1+L2 入口 (v0.9 W7.1 重组): telnet 'parsed' 粒度的入站行**只进行流裁决器** (行流
   * 缓冲 + 网络装配)。消费链五站 (§8.2: ①状态抓取 → ②规则触发 → ③事务结算 → ④流程判据
   * → ⑤残余记账/投递) 全部在裁决器的**帧提交点**单遍执行 —— 裁决器是唯一的边界裁决者,
   * 静默/超时不是边界 (§8.7 删除), 本方法不再有任何判定/投递逻辑。
   */
  private onTextBlock(lines: MudLine[]): void {
    if (lines.length === 0) return
    // 活动事件: 活跃看门狗重置窗口 (网络到达粒度 —— 断流看"最后一次游戏输出", 先于帧装配)。
    this.watchdogs.touch()
    this.adjudicator.feedLines(lines)
  }

  // ── 投递通道：官方 `deferContext` / `followup`（§19.6.2） ──────────
  // 机制 (defer 槽/账本/T2 时刻) 在 DeliveryChannel; 这里只留编排与本类状态耦合的判定。

  /**
   * **工具结果 → 流程机**（官方工具结果喂回流程；§19.1 的 `tool` 判据）。
   *
   * 只有本插件确定性 call-id（`mud-<delivery>-<index>`）能定位到投递与动作，
   * 进而定位到流程步骤（动作 `ruleId` = `flow:<flowId>/<stepId>`）；T2 自己发起的调用
   * 解析失败 ⇒ 什么都不做。
   * @param callId 本次工具调用 id。
   * @param outcome 工具结算结局 (ok/fail/error)。
   * @param settled 在途窗口结算方式 (发命令工具携带; 纯校验拒绝 = undefined)。
   * @returns 本结果是否收束了流程（true ⇒ 包装器转达 `exec.concludeTurn()`，B3 定案）。
   */
  noteToolResult(callId: string, outcome: 'ok' | 'fail' | 'error', settled?: ReplySettle): boolean {
    return this.adjudicator.noteToolResult(callId, outcome, settled)
  }

  // ── 投递通道委托 (MudDeliveryChannel 接口; `session/mount.ts` §19.6.2) ──
  // 工具包装器 (attachMudTools / preset) 经会话解析出通道 —— 机制全在
  // DeliveryChannel, 这里只做接口形状的转发。

  /** 工具调用进入（期间产生的投递改走 defer 槽）。 */
  beginToolCall(): void { this.channel.beginToolCall() }

  /** 工具调用离开（与 `beginToolCall` 配对）。 */
  endToolCall(): void { this.channel.endToolCall() }

  /** 取走 defer 槽（包装器在结果提交前逐条 `exec.deferContext`）。 */
  takeDeferredDeliveries(): ReturnType<typeof ownedGameMessage>[] {
    return this.channel.takeDeferred()
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
    const waiter = this.captchaWaiter
    this.captchaWaiter = null
    // ask-human 等待者一并解挂 (fail-closed): 工具不再无限等 → 结果 ok:false →
    // 已死的流程判据忽略它, 工具 Promise 不悬挂 (对齐官方 cancelled/unavailable)。
    if (waiter !== null) waiter.reject(new Error('流程已结束 (验证码等待作废)'))
    this.log('[验证码] 流程已结束 → 退出人工环节 (挂起的动作作废, 投递与看门狗恢复)')
  }

  // ── 世界变化入口 / 登录流程收尾 / 程序唤醒 ─────────────

  /**
   * 世界模型变化后的**唯一入口** (幂等): 看门狗起停 + 登录流程收尾。
   *
   * 所有写世界的路径都调它: 连接建立/关闭、GMCP、感知状态抓取、`world_patch` 工具
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
    if (this.disposed) return
    if (!t2Allowed(this.config.agentMode)) {
      // T2 关闭 (模式 `t1`/`off`): 程序唤醒不进真实 LLM, 留痕后放弃。
      this.debug('perception', `[感知] T2 已关闭, 程序唤醒放弃 (${reason})`)
      return
    }
    if (this.awaitingHuman) return   // 人工环节 (验证码): 任何唤醒源都不许把 agent 叫起来
    if (this.conn.id === null) return
    const agent = this.sink.agentOf(this.sessionId)
    if (agent === undefined) return
    this.decision({ actor: 'agent', eventType: reason, action: 'agent', text: `[决策] ${reason}` })
    agent.followup(ownedGameMessage(`${CONTROL_PREFIX}${context}`, 't2', this.sessionId))
    // 控制消息也算一次 T2 投递：紧随其后的批次要等最小间隔（避免"刚唤醒又喂"）。
    this.channel.markT2()
  }

  /**
   * 空回合翻 blank (连接点 UX; 控制消息 lane=t1) —— **仅无内容会话**。
   *
   * 为什么存在: 官方会话体在首个 `turn/start` 前不渲染 (blank), 而 turn 旧路径要等
   * 第一批游戏输出走完 帧装配(无 GA 兜底 2s)→感知→T2 投递 才开 —— 页面点完连接后
   * 长时间停在 blank 页。连接一建立就确保 agent 解析 (官方惰性路径, 新会话此前没有
   * agent) 并投一条**无动作的 T1 控制消息**: T1 无动作 → `finish stop`, 回合立即
   * 开合, turn/start 翻 blank —— 不依赖真实 LLM (暂停时也能翻页), 不污染游戏投递
   * 账本 (不记 T2 时刻)。
   *
   * 触发条件 (与官方 blank 判定同源): 仅 `session.seq === 0` (事件流为空) 的新会话。
   * 已有历史的会话 blank 已翻, DSH 回到历史会话自动渲染, 再发纯属多余的空回合;
   * `starterSent` 防本 runtime 重复 (starter 落事件后 seq > 0, 天然幂等, 此布尔只
   * 遮住"投递与落事件之间"的窗口)。失败回落: agent 解析不到 → 静默放弃, 后续批次
   * 走观察窗冲刷的既有路径翻 blank (慢但可达)。
   */
  private async deliverStarterTurn(): Promise<void> {
    if (this.disposed || this.config.agentMode === 'off') return
    if (this.conn.id === null) return
    if (this.starterSent || !(this.sink.sessionEmpty?.(this.sessionId) ?? false)) return
    let agent = this.sink.agentOf(this.sessionId)
    if (agent === undefined) agent = await (this.sink.resolveAgent?.(this.sessionId) ?? Promise.resolve(undefined))
    if (agent === undefined || this.disposed || this.conn.id === null) return
    if (this.awaitingHuman) return
    if (!(this.sink.agentReady?.(this.sessionId) ?? true)) return
    this.starterSent = true
    this.decision({
      actor: 'router',
      eventType: 'blank-starter',
      action: '空回合',
      text: '[启动] 连接建立 → 空回合翻会话 blank (无内容会话)',
    })
    this.channel.send(agent, ownedGameMessage(`${CONTROL_PREFIX}连接已建立 (空回合: 翻转会话 blank)`, 't1', this.sessionId))
  }
}
