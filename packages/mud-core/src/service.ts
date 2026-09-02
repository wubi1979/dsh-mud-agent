/**
 * dsh-mud-core — MUD 核心服务定义 (Service Definition), host face.
 *
 * 声明 `ctx.mud` 服务接口: 连接管理、状态查询、命令下发与游戏输出缓冲。
 * 界面插件 (mud-web / mud-tui) 是该服务的 Consumer — 只消费本接口与
 * session 事件 (mud/decision|mud/log|mud/world|mud/game), 与实现零耦合,
 * 可通过 profile patch 自由组合替换。
 * @module @deepseek-ai/dsh-mud-core/service
 */

import type { MudWorldSnapshot } from './shell-bridge.ts'
import type { TriggerService } from './perception/triggers.ts'
import type { FlowService } from './agent/flow.ts'
import type { SkillService } from './agent/skills.ts'
import type { DecisionCenter } from './agent/dispatcher.ts'

/** connect() 参数 (全部缺省回落插件 config 默认值)。 */
export interface MudConnectOptions {
  /** MUD 服务器主机名。 */
  host?: string
  /** MUD 服务器端口。 */
  port?: number
  /** 登录账户名 (触发登录规则链的 {name} 模板)。 */
  name?: string
  /** 登录密码 ({pass} 模板)。 */
  pass?: string
  /** 目标会话 id (用户即会话; 缺省 config.sessionId)。 */
  sessionId?: string
  /** 会话工作目录 (仅首次创建会话时用于 workspace 归属)。 */
  cwd?: string
}

/** 连接状态快照 (status() 返回; 外壳轮询或事件驱动渲染)。 */
export interface MudConnectionStatus {
  connected: boolean
  state: 'idle' | 'connecting' | 'connected'
  host: string
  port: number
  accountName: string | null
  sessionId: string | null
  /** agent 接入模式 (true = 游戏输出注入 agent 思考)。 */
  agentEnabled: boolean
}

/** 游戏输出缓冲条目 (环形缓冲, 外壳按 sinceSeq 续拉)。 */
export interface MudGameEntry {
  seq: number
  text: string
  time: number
}

/** 诊断信息 (diag(); 排查连接/agent 创建失败)。 */
export interface MudDiag {
  lastError: string | null
  agentReady: boolean
  activeSessionId: string | null
  liveSessions: string[]
}

/** readGame() 返回: 缓冲增量 + 最新 seq。 */
export interface MudGameRead {
  items: readonly MudGameEntry[]
  tailSeq: number
}

/**
 * MUD 核心服务 (`ctx.mud`)。宿主进程内单例, 由 mud-core 插件提供;
 * 会话事件契约见 shell-bridge.ts。
 */
export interface MudCoreService {
  /** 感知触发服务: register/unregister/unregisterByOwner, 命中 → MudEvent → 事件总线。 */
  trigger: TriggerService
  /** 流程引擎: start/abort/status/register/nanes (登录等确定性事务流程)。 */
  flow: FlowService
  /** 技能服务: 预制基线 + agent 动态生成的技能注册, 注入 agent 系统提示。 */
  skill: SkillService
  /**
   * 统一事件决策中心: 可行动事件的统一路由。决策知识集中在规则表
   * (action:"tool" 单步反射 / action:"skill" 激活 skill), agent 兜底。
   * skill/flow 以处理器注册制接入 (只声明激活动作, 触发时机由规则决定)。
   */
  dispatcher: DecisionCenter
  /**
   * 建立 telnet 连接 (幂等: 已连接时忽略)。目标会话必须已 materialize
   * (先调用 {@link prepareAgent} 或由界面激活会话)。
   */
  connect(options?: MudConnectOptions): void
  /** 断开当前 telnet 连接 (未连接时为空操作)。 */
  disconnect(): void
  /** 确保目标用户的 agent 会话存在 (不建 telnet 连接)。 */
  prepareAgent(sessionId: string, cwd?: string): Promise<void>
  /** 当前连接状态快照。 */
  status(): MudConnectionStatus
  /** 最近一次 connect/ensureAgent 失败等诊断信息。 */
  diag(): MudDiag
  /** 直发一条原始命令到游戏连接 (绕过规则与 agent)。 */
  sendCommand(cmd: string): boolean
  /** 读取游戏输出缓冲中 seq > sinceSeq 的条目 (外壳终端续拉)。 */
  readGame(sinceSeq: number): MudGameRead
  /** 当前世界模型快照 (JSON 可序列化)。 */
  snapshot(): MudWorldSnapshot
  /**
   * 把用户指令作为 user 消息注入当前 agent 会话并唤醒决策。
   * @returns 是否成功投递 (无活跃 agent 会话时为 false)。
   */
  askAgent(text: string): boolean
  /** 运行时切换 agent 接入模式 (等价 config.agentEnabled 的动态开关)。 */
  setAgentEnabled(enabled: boolean): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mud: MudCoreService
  }
}
