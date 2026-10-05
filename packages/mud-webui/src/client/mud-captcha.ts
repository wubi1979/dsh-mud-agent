/**
 * dsh-mud-webui — 全局验证码弹窗状态（client half, core3, T13.3）。
 *
 * 订阅服务端 watchCaptcha 流（T13 D7）：首帧补推当前挂起态 + 变化推全量快照帧。
 * - 挂起帧（pending 非空）→ 快照更新，弹窗呈现（多会话并发罕见：呈现最新帧
 *   的第一行，未呈现的挂起照常等、服务端 180s 超时兜底）
 * - 清除帧（pending 空）→ 服务端收束（提交/中止/断线/销毁/超时）→ 快照清空关窗
 * - 页面刷新/重开 → 组件重挂载重新订阅 → 服务端首帧补推恢复弹窗
 *
 * 刷新配额（D7：每轮挂起限 1 次）客户端对齐：乐观标记 + 帧边界 diff 重置——
 * 行从快照消失后再重现（清除帧后答错重入）= 新一轮，配额恢复。配额真值在
 * 服务端（超配额可读拒），客户端标记只是呈现层防呆。
 * @module @deepseek-ai/dsh-mud-webui/client/mud-captcha
 */

import type { MudCaptchaFrame, MudCaptchaRow } from './mud-remote.ts'

/**
 * 控制器依赖的 remote 窄面（结构兼容 MudRemoteController；测试注假实现，
 * 免去 typert 挂载）。
 */
export interface CaptchaRemoteFace {
  watchCaptcha(signal: AbortSignal): AsyncIterable<MudCaptchaFrame>
  captchaAnswer(sessionId: string, value: string): Promise<unknown>
  captchaAbort(sessionId: string): Promise<unknown>
  captchaRefresh(sessionId: string): Promise<{ sessionId: string; image: string }>
}

/** 控制器快照（useSyncExternalStore 消费；变更整体替换）。 */
export interface MudCaptchaSnapshot {
  /** 当前挂起快照（最新到达帧；空数组 = 无挂起，弹窗关）。 */
  readonly pending: readonly MudCaptchaRow[]
  /** 本轮已刷新的会话（呈现层置灰刷新钮；配额 = 每轮 1 次，D7）。 */
  readonly refetched: ReadonlySet<string>
  /** 提交/中止在途的会话（呈现层置灰按钮防双击）。 */
  readonly busy: ReadonlySet<string>
  /** 最近一次动作失败的可读消息（提交/中止/刷新共用；成功清空）。 */
  readonly error: string | null
}

const EMPTY_SNAPSHOT: MudCaptchaSnapshot = {
  pending: [],
  refetched: new Set<string>(),
  busy: new Set<string>(),
  error: null,
}

/** 验证码弹窗控制器：watchCaptcha 流消费 + 三动作转发（呈现无关，可单测）。 */
export class MudCaptchaController {
  private snap: MudCaptchaSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private stopWatch: (() => void) | null = null
  /** 订阅世代：stop 后旧流残帧不得写入新世代快照。 */
  private generation = 0

  constructor(private readonly remote: CaptchaRemoteFace) {}

  getSnapshot = (): MudCaptchaSnapshot => this.snap

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(patch: Partial<MudCaptchaSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const fn of [...this.listeners]) fn()
  }

  /**
   * 订阅验证码流（幂等，返回停止函数）。首帧补推 = 页面刷新恢复弹窗；
   * 断流静默保持既有快照（服务端 180s 超时兜底 + 重订阅对齐）。
   */
  start(): () => void {
    if (this.stopWatch !== null) return this.stopWatch
    const controller = new AbortController()
    const generation = ++this.generation
    const stop = (): void => {
      if (this.stopWatch !== stop) return
      this.stopWatch = null
      controller.abort()
    }
    this.stopWatch = stop
    void (async () => {
      try {
        for await (const frame of this.remote.watchCaptcha(controller.signal)) {
          if (generation !== this.generation) return
          this.applyFrame(frame)
        }
      } catch { /* 断流：保持既有快照；组件重挂载重新订阅（首帧补推对齐） */ }
      if (generation === this.generation && this.stopWatch === stop) this.stopWatch = null
    })()
    return stop
  }

  /** 提交人工码值（trim；不清窗——收束由服务端推清除帧，答错重入推新帧）。 */
  async submit(sessionId: string, value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed === '') return
    this.set({ busy: new Set(this.snap.busy).add(sessionId), error: null })
    try {
      await this.remote.captchaAnswer(sessionId, trimmed)
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.removeBusy(sessionId)
    }
  }

  /** 中止挂起（服务端 aborted 收束后推清除帧关窗）。 */
  async abort(sessionId: string): Promise<void> {
    this.set({ busy: new Set(this.snap.busy).add(sessionId), error: null })
    try {
      await this.remote.captchaAbort(sessionId)
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.removeBusy(sessionId)
    }
  }

  /**
   * 刷新图片（服务端重抓同 URL 并推新帧；挂起 Promise 不动）。乐观标记
   * 本轮已刷（重复点击忽略），失败回滚——配额真值在服务端，这里只防呆。
   */
  async refresh(sessionId: string): Promise<void> {
    if (this.snap.refetched.has(sessionId)) return
    this.set({ refetched: new Set(this.snap.refetched).add(sessionId), error: null })
    try {
      await this.remote.captchaRefresh(sessionId)
    } catch (err) {
      const rollback = new Set(this.snap.refetched)
      rollback.delete(sessionId)
      this.set({ refetched: rollback, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 帧落地：全量替换挂起快照 + 配额标记的帧边界 diff（行重现 = 新一轮）。 */
  private applyFrame(frame: MudCaptchaFrame): void {
    const prevIds = new Set(this.snap.pending.map(row => row.sessionId))
    let refetched = this.snap.refetched
    if (frame.pending.length > 0 && refetched.size > 0) {
      const next = new Set(refetched)
      let changed = false
      for (const row of frame.pending) {
        if (!prevIds.has(row.sessionId) && next.delete(row.sessionId)) changed = true
      }
      if (changed) refetched = next
    }
    this.set({ pending: frame.pending, refetched })
  }

  private removeBusy(sessionId: string): void {
    if (!this.snap.busy.has(sessionId)) return
    const busy = new Set(this.snap.busy)
    busy.delete(sessionId)
    this.set({ busy })
  }
}
