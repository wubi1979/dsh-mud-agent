/**
 * dsh-mud-core — 外壳线路契约 (纯类型模块, 无 Node 运行时依赖)。
 *
 * 解决 host 半面与浏览器/终端外壳之间的持久传输空隙: 终端把一次性游戏文本
 * 挡在会话日志之外 (否则会话将无界增长), 因此游戏帧改走高吞吐的 `/mud/ws`
 * 通道。本模块是这些帧类型的唯一事实源 (single source of truth), 双方都只
 * 做 type-only 导入, 使 `import type` 在编译期被擦除, 任何运行时依赖
 * (Node、`ws` …) 都不会泄漏进浏览器 bundle。
 *
 * 帧协议 (JSON 文本帧):
 *   client → server: `{type:'hello', lastGameSeq?, lastUiSeq?}`
 *   server → client: `{ch:'game', items}` / `{ch:'ui', items}` / `{ch:'world', world}`
 * @module @deepseek-ai/dsh-mud-core/client/wire
 */

import type { MudWorldSnapshot } from '../shell-bridge.ts'

/** 世界快照 (worldSnapshot 产物, JSON 可序列化)。 */
export type { MudWorldSnapshot }

/** 一条游戏输出帧条目 (与终端缓冲条目同形, 原始文本含 ANSI)。 */
export interface MudGameItem {
  seq: number
  text: string
  time: number
}

/** 一条 UI 流帧条目 (日志或结构化决策)。 */
export interface MudUiItem {
  seq: number
  kind: 'log' | 'decision'
  text: string
  time: number
  /** decision 专用: 决策来源。 */
  actor?: 'rule' | 'router' | 'agent' | 'flow'
  /** decision 专用: 所属流程名 (actor 'flow' 时, 如 'login')。 */
  flow?: string
  ruleId?: string
  eventType?: string
  action?: string
  result?: string
}

/** Client → server hello handshake: resume from the last-seen seqs (zero = replay). */
export interface MudHelloFrame {
  type: 'hello'
  lastGameSeq?: number
  lastUiSeq?: number
}

/** Server → client: one game-output batch. */
export interface MudGameFrame {
  ch: 'game'
  items: readonly MudGameItem[]
}

/** Server → client: one UI batch (logs/decisions). */
export interface MudUiFrame {
  ch: 'ui'
  items: readonly MudUiItem[]
}

/** Server → client: one world snapshot (replacement semantics — no history). */
export interface MudWorldFrame {
  ch: 'world'
  world: MudWorldSnapshot
}

/** Union of all wire frames a shell may receive. */
export type MudDownlinkFrame =
  | MudGameFrame
  | MudUiFrame
  | MudWorldFrame
