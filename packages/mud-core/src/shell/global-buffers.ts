/**
 * dsh-mud-core — 全局 WS/回放缓冲 (shell/global-buffers).
 *
 * 会话无关的宿主侧输出缓冲: 游戏终端条目 + UI 流条目, 各自按 seq 单调编号,
 * 超上限丢最旧; 同时是 /mud/ws 的 backfill 数据源 (重启后 seq 归零时回绕全量)
 * 与 /mud/purge 按会话过滤的清理目标。缓冲与连接/hub 无关 —— 本类只持有
 * 条目, 通过可插拔 sink 转发到 hub。
 * @module @deepseek-ai/dsh-mud-core/shell/global-buffers
 */

import type { MudGameItem, MudUiItem } from './wire.ts'
import type { MudUiItemInput } from '../runtime/session/types.ts'

/** WS 帧合并接收端 (宿主侧形状; `MudWebSocketHub.pushGame/pushUi`)。 */
interface BufferSink {
  pushGame(items: readonly MudGameItem[]): void
  pushUi(items: readonly MudUiItem[]): void
}

/** 游戏条目缓冲上限 (超限丢最旧)。 */
const GAME_BUFFER_MAX = 2000
/** UI 条目缓冲上限 (超限丢最旧)。 */
const UI_BUFFER_MAX = 2000

/** 全局条目的字节级宿主缓冲 (进程内单实例; 每会话条目自带 sessionId)。 */
export class GlobalBuffers {
  private gameSeq = 0
  private uiTailSeq = 0
  private readonly game: MudGameItem[] = []
  private readonly ui: MudUiItem[] = []
  private sink: BufferSink | null = null

  /** 挂接 WS 转发端 (hub 就绪后; null = 未挂接, 只缓冲不推)。 */
  attachSink(sink: BufferSink | null): void {
    this.sink = sink
  }

  /** 追加一条游戏输出 (终端通道; 原始文本, 不进会话日志)。 */
  pushGame(sessionId: string, text: string): void {
    this.gameSeq += 1
    const item: MudGameItem = { seq: this.gameSeq, sessionId, text, time: Date.now() }
    this.game.push(item)
    if (this.game.length > GAME_BUFFER_MAX) this.game.shift()
    this.sink?.pushGame([item])
  }

  /** 追加一条 UI 条目 (日志/决策/验证码; 条目自带 sessionId)。 */
  pushUi(sessionId: string, input: MudUiItemInput): void {
    this.uiTailSeq += 1
    const entry: MudUiItem = { ...input, sessionId, seq: this.uiTailSeq }
    this.ui.push(entry)
    if (this.ui.length > UI_BUFFER_MAX) this.ui.shift()
    this.sink?.pushUi([entry])
  }

  /** 按 seq 回填 (ws hello 时调用一次; seq 失效保护: 游标大于当前尾号即回绕全量)。 */
  backfill(lastGameSeq: number, lastUiSeq: number): {
    game: readonly MudGameItem[]
    ui: readonly MudUiItem[]
  } {
    return {
      game: this.game.filter(item => item.seq > (lastGameSeq > this.gameSeq ? 0 : lastGameSeq)),
      ui: this.ui.filter(item => item.seq > (lastUiSeq > this.uiTailSeq ? 0 : lastUiSeq)),
    }
  }

  /** 按会话清理 (注销时: WS 回放不再吐出已注销身份的内容)。 */
  purgeSession(sessionId: string): void {
    for (let i = this.game.length - 1; i >= 0; i -= 1) {
      if (this.game[i]?.sessionId === sessionId) this.game.splice(i, 1)
    }
    for (let i = this.ui.length - 1; i >= 0; i -= 1) {
      if (this.ui[i]?.sessionId === sessionId) this.ui.splice(i, 1)
    }
  }

  /** 起点 seq 之后的游戏条目 (HTTP 回放入口)。
   *  **只读游戏不读 UI 是刻意的**: UI 历史 (日志/决策) 走 /mud/logs 当日文件
   *  恢复 (按 logSeq 与实时流去重), UI 缓冲仅服务 /mud/ws 回填, 不设 HTTP 面对称口。 */
  readGame(sinceSeq: number): { items: readonly MudGameItem[]; tailSeq: number } {
    const since = Number.isFinite(sinceSeq) ? sinceSeq : 0
    return { items: this.game.filter(item => item.seq > since), tailSeq: this.gameSeq }
  }
}