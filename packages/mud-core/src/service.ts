/**
 * dsh-mud-core — MUD 核心服务定义 (Service Definition), host face.
 *
 * 声明 `ctx.mud` 服务接口: 会话绑定、连接管理、状态查询、命令下发与游戏输出缓冲。
 * 所有会话相关操作都以 sessionId 为键 (用户即会话), 不存在"当前会话"全局变量;
 * 缺省参数只做**显式回落** (最近一次 bind/connect 的会话 → config.sessionId)。
 *
 * WebUI 壳 (mud-webui) 是该服务的 Consumer — 经 HTTP 路由 + /mud/ws 通道消费。
 * @module @deepseek-ai/dsh-mud-core/service
 */

import type { MudDeliveryChannel } from './agents/mount.ts'
import type { MudGameItem, MudWorldSnapshot } from './shell/wire.ts'
import type { SkillService } from './agents/skills.ts'
import type { MudTools } from './agents/tools.ts'
import type { MudSessionDiag } from './runtime/session/types.ts'
import type { MudCapabilityApi } from './services/gate/capability.ts'
import type { MudTier } from './services/gate/tiers.ts'

/** connect() 参数 (缺省回落插件 config 默认值)。 */
export interface MudConnectOptions {
  /** 目标会话 id (用户即会话; 缺省 = 最近一次 bind/connect 的会话)。 */
  sessionId?: string
  /** MUD 服务器主机名。 */
  host?: string
  /** MUD 服务器端口。 */
  port?: number
  /** 登录账户名 (登录规则 {name} 模板 + 命令回显署名)。 */
  name?: string
  /** 登录密码 ({pass} 模板; 明文只在本会话运行时内存中)。 */
  pass?: string
}

/** 单会话连接状态快照。 */
export interface MudConnectionStatus {
  sessionId: string
  connected: boolean
  state: 'idle' | 'connecting' | 'connected'
  host: string
  port: number
  accountName: string | null
  /** agent 接入模式 (true = 游戏输出投递给会话 agent)。 */
  agentEnabled: boolean
  /** 该会话当前是否有官方 live agent (只读观测)。 */
  agentReady: boolean
  /** 该会话当前权限档位 (`observe`/`operate`/`full`; §10)。 */
  tier: MudTier
}

/** 单会话诊断 (类型本体在 `runtime/session/types.ts`, 随 `MudSessionRuntime.diag()` 声明)。 */
export type { MudSessionDiag }

/** 诊断信息 (diag(); 排查连接/agent 装配失败)。 */
export interface MudDiag {
  lastError: string | null
  runtimes: MudSessionDiag[]
  liveSessions: string[]
}

/** readGame() 返回: 缓冲增量 + 最新 seq。 */
export interface MudGameRead {
  items: readonly MudGameItem[]
  tailSeq: number
}

/**
 * preset 线的装配数据源 (`doc/ARCHITECTURE.md` §9)。
 *
 * 官方 agent preset 在**组装期**只挂载一次、并被加入该 preset 的所有 agent 共享,
 * 因此每条数据都必须能按**调用方 agent** 解析到具体会话 —— 这正是本接口每个方法
 * 都收 sessionId 的原因 (工具执行体来自该会话运行时, 提示文本按该会话档位求值)。
 * 会话未绑定时各方法给出安全回落 (工具不可用 / 通用说明 / 不记留痕), 不抛出。
 */
export interface MudAgentKit {
  /** 系统提示区段文本 (persona / 技能目录 / 命令参考; 部署级, 与会话无关)。 */
  readonly prompt: { persona: string; skillsText: () => string; commands: string }
  /**
   * 该会话的工具集 (闭包绑定该会话的队列/桥/world/凭据)。
   * @param sessionId 官方会话 id。
   * @returns 工具集; 未绑定或已注销 → undefined。
   */
  tools(sessionId: string | undefined): MudTools | undefined
  /**
   * 该会话当前档位的模型可见说明 (§10)。
   * @param sessionId 官方会话 id。
   * @returns 档位说明; 会话未知 → 通用说明 (不谎报某个档位)。
   */
  tierNote(sessionId: string | undefined): string
  /**
   * 工具调用留痕 (决策栏/审计)。
   * @param sessionId 官方会话 id。
   * @param name 工具名。
   * @param args 调用参数。
   */
  noteToolCall(sessionId: string | undefined, name: string, args: Record<string, unknown>): void
  /**
   * 该会话的**投递通道**（`deferContext` / `concludeTurn` 接线；`doc/ARCHITECTURE.md` §19.6.2）。
   *
   * **两条装配路径都要接**：宿主路径（`attachMudTools`）与 preset 路径（`preset-agent`）各有
   * 自己的工具包装器；漏接一条，defer 就只在另一条路径生效（实测踩过：preset 部署下
   * `beginToolCall()` 从未被调用 ⇒ 投递仍走 `followup`，账目停在 3 回合 / 6 次请求）。
   * @param sessionId 官方会话 id。
   * @returns 通道（由会话运行时实现）; 未绑定或已注销 → undefined。
   */
  channel(sessionId: string | undefined): MudDeliveryChannel | undefined
}

/**
 * MUD 核心服务 (`ctx.mud`)。宿主进程内单例, 由 mud-core 插件提供;
 * 每会话状态收在各自的 MudSessionRuntime 中。
 */
export interface MudCoreService {
  /**
   * 规则表规模快照 (诊断)。匹配器实例**每会话一个** (L1 感知引擎, 运行态不共享),
   * 因此不再对外暴露单个服务实例。
   */
  ruleCounts(): { state: number; event: number; hold: number }
  /** 技能服务: 预制基线 + agent 动态生成的技能注册。 */
  readonly skill: SkillService
  /**
   * preset 线 (`agents/preset.ts`) 的装配数据源 (§9)。
   *
   * 只有官方 agent preset 会调用它: 宿主侧装配路径 (preset 关闭时) 直接用会话运行时,
   * 不经过本接口。返回的 kit 是进程级单例 (每次调用返回同一对象), 其方法按 sessionId
   * 解析会话状态。
   * @returns preset 线所需的工具/提示/留痕数据源。
   */
  agentKit(): MudAgentKit
  /**
   * 权限档位服务 (§10): 每会话的只读/读写/完全档位。
   *
   * 写入只有两个入口 —— 本服务的 `set()` (页面/宿主) 与会话日志
   * (`mud/capability` 事件); **agent 侧没有任何写入口** (工具只能被 deny/ask)。
   */
  readonly capability: MudCapabilityApi
  /**
   * 声明"该官方会话是 MUD 账号会话" (不建连接、不建 agent)。
   * 页面在 `sessions.create` 后调用; 已 live 的 agent 立即装配工具/提示/选路。
   * @param sessionId 官方会话 id。
   */
  bind(sessionId: string): void
  /**
   * 注销会话 (删除用户): 释放运行时与连接、删除该会话的**全部**日志文件
   * (所有日期 + 滚动分片)、清空该会话的内存与全局缓冲。
   *
   * 官方会话侧由页面调**归档** (`IWorkspaces.archiveSession`) 处理 —— 官方没有
   * 删除会话接口 (client `ISessions` 只有 create/open/clear/fork), 归档即从界面
   * 隐藏; 本方法清掉的是插件拥有的痕迹 —— 删掉的用户不能再被读回。
   * @param sessionId 官方会话 id。
   * @returns `ok` = 已执行注销 (空 id 为 false); `files` = 删除的日志文件数。
   */
  purge(sessionId: string): { ok: boolean; files: number }
  /** 建立某会话的 telnet 连接 (幂等: 已连接/连接中忽略)。 */
  connect(options?: MudConnectOptions): void
  /** 断开某会话连接 (缺省 = 最近一次 bind/connect 的会话)。 */
  disconnect(sessionId?: string): void
  /** 单会话连接状态 (缺省 = 最近一次绑定会话)。 */
  status(sessionId?: string): MudConnectionStatus
  /** 全部已绑定会话的连接状态 (侧栏/状态面板)。 */
  statuses(): MudConnectionStatus[]
  /** 最近一次错误 + 各会话诊断。 */
  diag(): MudDiag
  /** 发送一条游戏命令到指定会话的连接 (走该会话队列节流)。 */
  sendCommand(cmd: string, sessionId?: string): boolean
  /** 读取游戏输出缓冲中 seq > sinceSeq 的条目 (条目自带 sessionId)。 */
  readGame(sinceSeq: number): MudGameRead
  /** 某会话的世界模型快照 (未绑定 = null)。 */
  snapshot(sessionId?: string): MudWorldSnapshot | null
  /** 运行时切换 agent 接入模式 (等价 config.agentEnabled 的动态开关)。 */
  setAgentEnabled(enabled: boolean): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mud: MudCoreService
  }
}
