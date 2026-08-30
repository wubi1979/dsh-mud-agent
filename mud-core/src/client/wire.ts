/**
 * dsh-mud-core — shared wire contract (pure type module, no Node runtime).
 *
 * The persistent-transport gap between the host half and the browser/terminal
 * shells: the terminal keeps its own one-time game text out of the session log
 * (which would otherwise grow unbounded), so game frames travel over a
 * high-throughput `/mud/ws` channel instead. This module is the single source
 * of truth for those frame types, imported type-only by both faces so the
 * `import type` statement erases at compile time and no runtime dependency
 * (Node, `ws`, …) ever leaks into the browser bundle.
 *
 * 帧协议 (JSON text frames):
 *   client → server: `{type:'hello', lastGameSeq?, lastUiSeq?}`
 *   server → client: `{ch:'game', items}` / `{ch:'ui', items}` / `{ch:'world', world}`
 * @module @deepseek-ai/dsh-mud-core/client/wire
 */

import type { MudWorldSnapshot } from '../mud-events.ts'

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
  actor?: 'rule' | 'router' | 'agent'
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
