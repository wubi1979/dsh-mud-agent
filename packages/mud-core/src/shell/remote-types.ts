/**
 * dsh-mud-core — Remote 边界类型契约 (纯类型模块, 无运行时依赖)。
 *
 * host 半面 (typert Remote 流方法) 与浏览器外壳之间的类型唯一事实源
 * (single source of truth), 双方只做 type-only 导入, `import type` 在编译期
 * 擦除, 任何运行时依赖 (Node、`ws` …) 都不会泄漏进浏览器 bundle。
 *
 * 传输面 = typert 三条流 (mud/game, mud/ui, mud/world), 打开时按 sinceSeq
 * 回填 + 实时尾随; seq 契约见 `MudGameItem`。
 * @module @deepseek-ai/dsh-mud-core/remote-types
 */

/** 受约束 JSON 值 (typert Remote 边界要求完全受约束, 不接受 unknown)。
 *  世界状态写入源 (GMCP JSON / world_patch) 值域均在此范围内。 */
export type MudJsonValue = string | number | boolean | null | MudJsonValue[] | { [key: string]: MudJsonValue }

export interface MudWorldSnapshot {
  char: Record<string, MudJsonValue>
  room: Record<string, MudJsonValue>
  combat: Record<string, MudJsonValue>
  flags: Record<string, MudJsonValue>
}

/** 一条游戏输出帧条目 (与终端缓冲条目同形, 原始文本含 ANSI)。
 *  `sessionId` 标明来源会话 — 前端按当前会话过滤 (通道本身与会话无关)。
 *
 *  **seq 契约**: seq 进程内全局单调; 同一条目可能经实时推送与流打开回填
 *  **两条路径到达** (回填与实时推送重叠是正常时序), 前端必须按 seq 去重
 *  (GameView 已实现)。**跳号是合法的**: 宿主缓冲有上限, 旧条目驱逐后回填
 *  从剩余最旧开始, 中间缺口前端无从察觉也不应报错。 */
export interface MudGameItem {
  seq: number
  sessionId?: string
  text: string
  time: number
}

/** 一条 UI 流帧条目 (日志、结构化决策或验证码交互)。
 *  seq 契约同 `MudGameItem` (双路径可达需按 seq 去重; log 类以 logSeq 优先去重)。 */
export interface MudUiItem {
  seq: number
  /** 来源会话 id (进程级条目 = 空串, 所有会话视图都显示)。 */
  sessionId?: string
  kind: 'log' | 'decision' | 'captcha'
  text: string
  time: number
  /**
   * 日志身份键 (= LogService.seq, 会话日志文件与实时流共用): 前端按此
   * 去重/排序 — 会话恢复 (读当日文件) 与实时推送的同一事件只显示一次。
   */
  logSeq?: number
  /** log 专用: 级别 (debug/info/warn/error; 前端着色)。 */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** log 专用: 来源通道 (runtime/network/perception/send/decision; 前端分组)。 */
  channel?: 'runtime' | 'network' | 'perception' | 'send' | 'decision'
  /** decision 专用: 决策来源。 */
  actor?: 'rule' | 'router' | 'agent' | 'flow'
  /** decision 专用: 所属流程名 (actor 'flow' 时, 如 'login' / 'fullme')。 */
  flow?: string
  ruleId?: string
  eventType?: string
  action?: string
  result?: string
  /** captcha 专用: 验证码图片地址 (替换语义 — 新事件整体替换前端对话框状态)。 */
  url?: string
  /** captcha 专用: 预填命令 ("fullme <识别文字>"; OCR 完成前缺省 'fullme')。 */
  cmd?: string
  /**
   * captcha 专用: 需要展示给人工的提示（如上一轮答错的服务端原文）。
   *
   * fullme 走向流程化后，答错会**重新取图 + 重新弹窗**；服务端原话放在这里，
   * 页面把它显示在对话框里（"再来一次试试！"），人工据此重输。
   */
  note?: string
}
