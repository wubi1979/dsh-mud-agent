/**
 * dsh-mud-core — MUD 核心服务定义 (Service Definition), host face.
 *
 * 声明 `ctx.mud` 服务接口: 连接管理、状态查询、命令下发与游戏输出缓冲。
 * WebUI 壳 (mud-webui) 是该服务的 Consumer — 经 HTTP 路由 + /mud/ws 通道
 * 消费, 与实现零耦合。
 * @module @deepseek-ai/dsh-mud-core/service
 */

import type { MudWorldSnapshot } from './client/wire.ts'
import type { TriggerMatchService } from './trigger-llm/service.ts'
import type { SkillService } from './agent/skills.ts'

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
 * MUD 核心服务 (`ctx.mud`)。宿主进程内单例, 由 mud-core 插件提供。
 */
export interface MudCoreService {
  /** 匹配服务: state 桶 (预匹配折叠) — 无事件总线; 命中由装配方 (index.ts) 消费落库。 */
  stateTrigger: TriggerMatchService
  /** 匹配服务: event 桶 (T1 渲染) — agent 级联 provider 消费。 */
  eventTrigger: TriggerMatchService
  /** 技能服务: 预制基线 + agent 动态生成的技能注册, 注入 agent 系统提示。 */
  skill: SkillService
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
  /** 运行时切换 agent 接入模式 (等价 config.agentEnabled 的动态开关)。 */
  setAgentEnabled(enabled: boolean): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mud: MudCoreService
  }
}
