/**
 * mud-core3 — Remote 边界类型（非根子路径导出）。
 *
 * typert 生成器要求：任何跨 Remote 边界的具名类型必须从包的**公开非根子路径**导出
 * （消费者才能从 `mud-core3/types` 引入同一符号）。此文件只做转发，不承载运行时代码。
 *
 * @module mud-core3/types
 */

export type { AccountRecord, ServerRecord } from './roster.ts'
export type { LogChannel, LogEntry, LogLevel } from './log/log-service.ts'
export type {
  GameFrame, GameOutputFrame, GameSnapshotFrame, GameStateFrame,
  GameViewInfo, GameViewOptions,
} from './view/screen.ts'
