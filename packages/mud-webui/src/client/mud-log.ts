/**
 * dsh-mud-webui — MUD 会话日志控制器（client half）。
 *
 * 会话日志视图的数据源：跟随「当前正在看的会话」，按固定间隔从宿主拉
 * `remote.mud.logs(sessionId)`（内存环：运行/网络/投递/闸门事件），发布一份
 * 快照供视图绑定。原始行流不在环里（宿主只落盘），视图展示 fileTarget 目录
 * 供人工排查。
 *
 * 与 mud-state 的 MudStateController 同构：`getSnapshot`/`subscribe` 一对，
 * 经 inject 面的 `hooks.mudLog` 绑成 `useMudLog` 钩子；视图不自己订阅。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-log
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MudLogEntry, MudRemoteController } from './mud-remote.ts'

/** 轮询间隔毫秒（日志是排查面，不需要更密）。 */
const POLL_MS = 1500

/** 会话日志快照（视图渲染面）。 */
export interface MudLogSnapshot {
  /** 当前跟随的会话；null = 未跟随。 */
  readonly sessionId: string | null
  readonly entries: readonly MudLogEntry[]
  /** 落盘目录（null = 宿主未配置落盘）。 */
  readonly fileTarget: string | null
  /** 拉取失败原因（挂在视图顶部，不静默）。 */
  readonly error: string | null
  /** 最近一次成功/失败的刷新时刻。 */
  readonly updatedAt: number
}

/**
 * 单会话日志控制器：watch 切换目标并轮询。
 * 实现 {@link HostObservable}，由 renderer 绑成 `useMudLog`。
 */
export class MudLogController implements HostObservable<MudLogSnapshot> {
  private snapshot: MudLogSnapshot = {
    sessionId: null, entries: [], fileTarget: null, error: null, updatedAt: 0,
  }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null

  /**
   * @param remote - MUD remote 控制器（页面唯一实例）。
   */
  constructor(private readonly remote: MudRemoteController) {}

  getSnapshot(): MudLogSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 跟随某会话（切换目标即重置快照并重启轮询；null 停止）。
   * 箭头属性：身份稳定，可安全放进 React effect 依赖。
   * @param sessionId - 会话 id（= 账号 id），或 null。
   */
  watchLog = (sessionId: string | null): void => {
    if (this.snapshot.sessionId === sessionId && this.timer !== null) return
    this.stop()
    this.publish({ sessionId, entries: [], fileTarget: null, error: null, updatedAt: 0 })
    if (sessionId === null || sessionId === '') return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
  }

  /** 立即拉一次（视图刷新按钮；箭头属性，身份稳定）。 */
  refreshLog = (): void => {
    void this.refresh()
  }

  /** 立即拉一次（内部异步入口）。 */
  async refresh(): Promise<void> {
    const sessionId = this.snapshot.sessionId
    if (sessionId === null) return
    if (!this.remote.ready) {
      this.publish({ ...this.snapshot, error: 'remote 尚未挂载', updatedAt: Date.now() })
      return
    }
    try {
      const view = await this.remote.logs(sessionId)
      if (this.snapshot.sessionId !== sessionId) return // 目标已切换：丢弃过期响应
      this.publish({
        sessionId, entries: view.entries, fileTarget: view.fileTarget, error: null, updatedAt: Date.now(),
      })
    } catch (error) {
      if (this.snapshot.sessionId !== sessionId) return
      this.publish({
        ...this.snapshot,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
    }
  }

  /** 停止轮询并清空（插件卸载/视图卸载）。 */
  dispose(): void {
    this.stop()
    this.publish({ sessionId: null, entries: [], fileTarget: null, error: null, updatedAt: 0 })
  }

  private stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private publish(snapshot: MudLogSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}
