/**
 * dsh-mud-core — Remote 流订阅源 (shell/streams).
 *
 * typert remote 三条流 (game/ui/world) 的宿主侧数据源。GlobalBuffers 仍是
 * 唯一事实账本 (seq 分配/回放/purge), 本模块只做**投递**:
 *   - MudFeedHub: buffers 的可插拔 sink, 把新条目扇出给所有活跃订阅者
 *     (取代旧 hub.ts 的广播面; 一个 mux WS 连接内的每条流各有一个订阅者);
 *   - feedGame/feedUi: 单订阅者异步生成器 — 先按 sinceSeq 从 buffers 回放,
 *     再切实时尾随, 同一次事件循环 tick 的条目合批吐出 (对齐旧 hub 的
 *     setImmediate 帧合并语义), abort 时干净退出。
 *
 * 与账本的分工: buffers 管"事实到过哪" (seq 契约/回放/按会话清理),
 * 本模块管"怎么送到这个客户端" (订阅生命周期/合批/断开清理)。
 * @module @deepseek-ai/dsh-mud-core/shell/streams
 */

import type { MudGameItem, MudUiItem, MudWorldSnapshot } from './remote-types.ts'

/** World 流条目 (快照替换语义, 无历史)。 */
export interface MudWorldEvent {
  sessionId?: string
  world: MudWorldSnapshot
}

/** 单批输出的条目数上限 (到达即不等 tick 边界, 直接吐批)。 */
const BATCH_LIMIT = 64

/**
 * buffers 的流扇出端 (实现了 GlobalBuffers 的 BufferSink 形状)。
 * 领域服务 (game/ui/world) 各持一个活跃订阅者集合; purgeSession 时通知
 * 各订阅者丢弃该会话的在途条目 (对齐旧 hub 的 pending 过滤)。
 */
export class MudFeedHub {
  private readonly gameListeners = new Set<(items: readonly MudGameItem[]) => void>()
  private readonly uiListeners = new Set<(items: readonly MudUiItem[]) => void>()
  private readonly worldListeners = new Set<(event: MudWorldEvent) => void>()
  private readonly purgeHooks = new Set<(sessionId: string) => void>()

  /** GlobalBuffers.attachSink 用。 */
  pushGame(items: readonly MudGameItem[]): void {
    for (const listener of this.gameListeners) listener(items)
  }

  /** GlobalBuffers.attachSink 用。 */
  pushUi(items: readonly MudUiItem[]): void {
    for (const listener of this.uiListeners) listener(items)
  }

  /** 会话 pushWorld 出口 (state.onChanged 节流回调)。 */
  pushWorld(sessionId: string, world: MudWorldSnapshot): void {
    for (const listener of this.worldListeners) listener({ sessionId, world })
  }

  /** 按会话清理: 通知订阅者丢弃在途条目 (buffers.purgeSession 的配对面)。 */
  purgeSession(sessionId: string): void {
    for (const hook of this.purgeHooks) hook(sessionId)
  }

  /** 订阅 game 实时尾随; 返回退订函数。 */
  onGame(listener: (items: readonly MudGameItem[]) => void): () => void {
    this.gameListeners.add(listener)
    return () => { this.gameListeners.delete(listener) }
  }

  /** 订阅 ui 实时尾随; 返回退订函数。 */
  onUi(listener: (items: readonly MudUiItem[]) => void): () => void {
    this.uiListeners.add(listener)
    return () => { this.uiListeners.delete(listener) }
  }

  /** 订阅 world 快照推送; 返回退订函数。 */
  onWorld(listener: (event: MudWorldEvent) => void): () => void {
    this.worldListeners.add(listener)
    return () => { this.worldListeners.delete(listener) }
  }

  /** 注册会话清理钩子 (purgeSession 时逐个调用)。 */
  onPurge(hook: (sessionId: string) => void): () => void {
    this.purgeHooks.add(hook)
    return () => { this.purgeHooks.delete(hook) }
  }
}

/** 条目收集器: 同 tick 合批 + 超限直吐 + purge 过滤, 供生成器消费。 */
class ItemQueue<T> {
  private pending: T[] = []
  private scheduled = false
  private wake: (() => void) | null = null

  constructor(
    purged: (item: T, sessionId: string) => boolean,
    registerPurge: (hook: (sessionId: string) => void) => () => void,
  ) {
    this.disposePurge = registerPurge((sessionId) => {
      this.pending = this.pending.filter(item => !purged(item, sessionId))
    })
  }

  private readonly disposePurge: () => void

  /** 实时尾随入口 (FeedHub.onXxx 的包装)。 */
  accept(items: readonly T[]): void {
    for (const item of items) this.pending.push(item)
    if (this.pending.length >= BATCH_LIMIT) {
      this.wake?.()
      return
    }
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.wake?.()
    })
  }

  /** 取走当前在途条目 (无则等待下一批; abort 时返回空)。 */
  async take(signal: AbortSignal): Promise<T[]> {
    while (this.pending.length === 0) {
      if (signal.aborted) return []
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = null
    }
    return this.pending.splice(0)
  }

  dispose(): void {
    this.disposePurge()
    this.wake?.()
  }
}

/** purge 命中判定: 条目属于被清理会话时返回 true (进程级条目 sessionId 为空串, 不清理)。 */
function itemPurged(item: { sessionId?: string }, sessionId: string): boolean {
  return item.sessionId === sessionId
}

/** 游戏流: sinceSeq 回放 → 实时尾随, 同 tick 合批。 */
export async function* feedGame(
  buffers: { backfill: (lastGameSeq: number, lastUiSeq: number) => { game: readonly MudGameItem[]; ui: readonly MudUiItem[] } },
  hub: MudFeedHub,
  sinceSeq: number,
  signal: AbortSignal,
): AsyncGenerator<readonly MudGameItem[]> {
  const replayed = buffers.backfill(sinceSeq, 0).game
  if (signal.aborted) return
  if (replayed.length > 0) yield replayed
  const queue = new ItemQueue<MudGameItem>(itemPurged, hook => hub.onPurge(hook))
  const unsubscribe = hub.onGame(items => queue.accept(items))
  try {
    while (!signal.aborted) {
      const batch = await queue.take(signal)
      if (batch.length > 0) yield batch
    }
  } finally {
    unsubscribe()
    queue.dispose()
  }
}

/** UI 流: sinceSeq 回放 → 实时尾随, 同 tick 合批。 */
export async function* feedUi(
  buffers: { backfill: (lastGameSeq: number, lastUiSeq: number) => { game: readonly MudGameItem[]; ui: readonly MudUiItem[] } },
  hub: MudFeedHub,
  sinceSeq: number,
  signal: AbortSignal,
): AsyncGenerator<readonly MudUiItem[]> {
  const replayed = buffers.backfill(0, sinceSeq).ui
  if (signal.aborted) return
  if (replayed.length > 0) yield replayed
  const queue = new ItemQueue<MudUiItem>(itemPurged, hook => hub.onPurge(hook))
  const unsubscribe = hub.onUi(items => queue.accept(items))
  try {
    while (!signal.aborted) {
      const batch = await queue.take(signal)
      if (batch.length > 0) yield batch
    }
  } finally {
    unsubscribe()
    queue.dispose()
  }
}

/** World 流: 纯推送 (替换语义, 无回放 — 前端打开即收下一份快照)。 */
export async function* feedWorld(
  hub: MudFeedHub,
  signal: AbortSignal,
): AsyncGenerator<MudWorldEvent> {
  const queue = new ItemQueue<MudWorldEvent>(() => false, hook => hub.onPurge(hook))
  const unsubscribe = hub.onWorld(event => queue.accept([event]))
  try {
    while (!signal.aborted) {
      const batch = await queue.take(signal)
      for (const event of batch) yield event
    }
  } finally {
    unsubscribe()
    queue.dispose()
  }
}
