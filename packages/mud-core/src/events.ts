/**
 * dsh-mud-core — 事件总线 (Events), host half.
 *
 * 统一事件模型 + 总线声明。内部感知/GMCP 事件经 cordis ctx.events 广播:
 *   - mud/percept  感知文本事件 (触发器命中产出): { type, data, line, ts }
 *   - mud/gmcp     系统级 GMCP 包 (state 直接订阅的派生事件): { name, data, ts }
 *   - mud/system   系统级状态事件 (登录激活等): { type, data, ts }
 *
 * 消费者: 状态捕获 (state, 静默更新 world) / 规则引擎 (rules, 分支决策) /
 * 流程引擎 (flow, 顺序事务) / agent 路由 (未覆盖事件 + 断流 + 主动请求)。
 * 与 UI 层事件 (mud/decision|log|world) 隔离 — UI 事件见 mud-events.ts。
 *
 * 事件数据必须 lossless-JSON 可序列化 (Session.append 强制, 对齐全家桶约定)。
 * @module @deepseek-ai/dsh-mud-core/events
 */

/**
 * 感知事件 payload: type = 语义事件类型 (如 p:combat:start), data 由感知规则
 * extract 产出的附带数据 (如命中的行文本), line 为命中的绝对行号, ts 为事件时间。
 */
export interface MudPerceptEvent {
  /** 感知语义事件类型 (p:login:prompt / p:combat:start ... 或自定义)。 */
  type: string
  /** 触发器 extract 产出的附带数据 (可为 null)。 */
  data: Record<string, unknown> | null
  /** 命中的绝对行号 (行触发; 供日志定位)。 */
  line: number
  /** 事件时间 (Epoch-ms)。 */
  ts: number
}

/**
 * GMCP 事件 payload: name = 裸 GMCP 包名 (如 "Move" / "Char.Vitals"),
 * data = 原始载荷 (pkuxkx 常见单元素数组, 如 [{ result, dir, short }])。
 */
export interface MudGmcpEvent {
  /** 裸 GMCP 包名 (去掉 GMCP. 前缀)。 */
  name: string
  /** 原始载荷 (保持 telnet 层透传的形态)。 */
  data: unknown
  /** 事件时间 (Epoch-ms)。 */
  ts: number
}

/**
 * 系统级状态事件 payload: type = 系统语义 (如 "login:required" 未登录激活,
 * "login:ok" 系统确认登录)。由宿主在连接/状态跃迁时手工发布, 不是触发器产出 —
 * 用于激活 skill (把流程引擎拉到 running) 而非单步决策。
 */
export interface MudSystemEvent {
  /** 系统语义类型 (login:required / login:ok ... 可自定义)。 */
  type: string
  /** 附带数据 (可为 null)。 */
  data: Record<string, unknown> | null
  /** 事件时间 (Epoch-ms)。 */
  ts: number
}

/** 内部事件总线声明 (cordis Events 合并)。 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 感知文本事件 (触发器命中)。 */
    'mud/percept': MudPerceptEvent
    /** 系统级 GMCP 事件 (state 派生发布)。 */
    'mud/gmcp': MudGmcpEvent
    /** 系统级状态事件 (宿主手工发布, 激活 skill)。 */
    'mud/system': MudSystemEvent
  }
}

/** 创建一条感知事件 (宿主统一构造入口)。 */
export function makePerceptEvent(
  type: string,
  data: Record<string, unknown> | null,
  line: number,
): MudPerceptEvent {
  return { type, data, line, ts: Date.now() }
}

/** 创建一条 GMCP 事件。 */
export function makeGmcpEvent(name: string, data: unknown): MudGmcpEvent {
  return { name, data, ts: Date.now() }
}

/** 创建一条系统级状态事件。 */
export function makeSystemEvent(
  type: string,
  data: Record<string, unknown> | null = null,
): MudSystemEvent {
  return { type, data, ts: Date.now() }
}