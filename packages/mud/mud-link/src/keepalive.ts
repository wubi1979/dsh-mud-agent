/**
 * mud-core3 link/keepalive — 半开探活纯层（T5.1 引入，T12 返工为静默伴随自驱）。
 *
 * 探针实测（§17.3）：服务端无主动心跳（登录后零发送 240s 零入站），半开检测
 * 必须客户端主动探活——telnet AYT(246) 有显式应答 `[-Yes-]`+GA（唯一可判活
 * 信号）；NOP/GMCP Core.KeepAlive/Ping 静默无应答不可判活。
 *
 * 职责（T12 D1–D4）：
 *   - 静默伴随探测（非周期、无外部到期点入口）：唯一时钟锚 = 最后数据到达
 *     时刻——任何行/GA 到达即 armIdle 重置锚；静默满 `startMs` 首发 AYT，
 *     无应答每 `retryMs` 重发共 `maxAttempts` 次，判死刻度 =
 *     `startMs + maxAttempts × retryMs`（缺省 90/99/108 发送，117s 判死，
 *     距 120s 唤醒到期点留 3s）；
 *   - AYT 应答判据（`^\[-Yes-\]` 配 `flags:'m'` 行首锚纪律，§8.13）；
 *   - 吞应答行判定（telnet 层应答不进游戏语义）；
 *   - probing 观测态（`idle | probing`；不回写 conn 三态）。
 *
 * 判活/判死归属（D3）：判活 **link 内部消化**（无上报回调）——任意行 / GA /
 * `[-Yes-]` 到达即活证明，复位观测态并重开探测窗口；判死经 `onDead(attempts)`
 * 上抛（装配层接 Mud.disconnect → P4 硬收尾 → 自动重连，上层只消费断开事实）。
 *
 * busy 谓词（D4）：`isBusy`（装配层注入 `holderBusy || isInTurn`）为真的探测
 * tick **跳过**（不发 AYT、不耗次数，U1 不顺延——deadline 固定，错过的机会
 * 作废）；判死刻度 busy → 本轮零收束（不判死：disconnect 会截断在途 read，
 * 死活由 read timeout 与唤醒点守卫兜底）。busy 恒真贯穿窗口 = 本轮零探活。
 *
 * 信号次序（实现注意）：AYT 应答常以 GA 收尾且不保证带换行 ⇒ GA 先到、
 * `[-Yes-]` 行要等行尾静默刷出（FLUSH_IDLE_MS=300ms）才到 ⇒ 判活以 GA 为主
 * 路径、行刷出为次路径（先到者生效，后到幂等）。因此**吞行判定不限探测阶段**：
 * 判活发生后才刷出的应答行仍要吞掉（该行是 telnet 层应答，任何阶段都不进
 * pendingLines/画面/投递/onActivity）。
 *
 * 纯度纪律：本文件不 import 宿主；时钟用 setTimeout（测试 fake timers）。
 */

/** AYT 应答判据（行首锚 + `flags:'m'`——判据书写纪律 §8.13）。 */
export const AYT_ALIVE_RE = /^\[-Yes-\]/m

/** 探活观测态（不回写 conn 三态；conn 恒 disconnected|connecting|connected）。 */
export type ProbeState = 'idle' | 'probing'

/** 探活参数（Config probeStartMs / probeRetryMs / probeMaxAttempts；缺省 90_000 / 9_000 / 3）。 */
export interface KeepaliveOptions {
  /** 静默首发延迟毫秒（自最后数据到达起）。 */
  startMs: number
  /** 无应答重发间隔毫秒。 */
  retryMs: number
  /** 探活总次数上限（判死刻度 = startMs + maxAttempts × retryMs）。 */
  maxAttempts: number
}

/** 探活依赖（注入窄接口）。 */
export interface KeepaliveDeps {
  /** 发送 AYT（Mud.sendAyt）。返回 false = 连接已不可用 → 立即判死。 */
  send(): boolean
  /** 判死回调（装配层接 Mud.disconnect → P4 硬收尾 → 自动重连）。
   *  @param attempts 本窗口实际发出的 AYT 次数（判死日志计数用）。 */
  onDead(attempts: number): void
  /** busy 谓词（D4：holderBusy || isInTurn，装配层注入）：为真的探测 tick 跳过。 */
  isBusy?(): boolean
}

/**
 * 半开探活器（每会话一实例，Mud 持有；自驱——无外部到期点入口）。
 * @throws startMs / retryMs / maxAttempts 非正整数时抛 TypeError（fail-loud）。
 */
export class Keepalive {
  private phase: ProbeState = 'idle'
  /** 本窗口实际已发送的探活次数（busy 跳过不计）。 */
  private attemptsCount = 0
  /** 本窗口已走过的 tick 数（0..maxAttempts；= maxAttempts 的 tick 即判死刻度）。 */
  private ticks = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: KeepaliveDeps,
    private readonly opts: KeepaliveOptions,
  ) {
    if (!Number.isSafeInteger(opts.startMs) || opts.startMs <= 0) {
      throw new TypeError(`probeStartMs 必须为正整数，got ${String(opts.startMs)}`)
    }
    if (!Number.isSafeInteger(opts.retryMs) || opts.retryMs <= 0) {
      throw new TypeError(`probeRetryMs 必须为正整数，got ${String(opts.retryMs)}`)
    }
    if (!Number.isSafeInteger(opts.maxAttempts) || opts.maxAttempts <= 0) {
      throw new TypeError(`probeMaxAttempts 必须为正整数，got ${String(opts.maxAttempts)}`)
    }
  }

  /** 观测态（只读透传到状态面；不回写 conn）。 */
  get state(): ProbeState {
    return this.phase
  }

  /** 本窗口实际已发送的 AYT 次数（首发日志计数用；窗口复位后为 0）。 */
  get attempts(): number {
    return this.attemptsCount
  }

  /**
   * 静默锚重置并开窗（D1）：数据到达（observeLine/observeBoundary）与建连
   * 调用——任何活证明都把探测窗口随下一轮静默重开。
   */
  armIdle(): void {
    this.reset()
    this.schedule(this.opts.startMs)
  }

  /** 全停（手工 connect/disconnect/dispose 与 socket close 收尾路径；幂等）。 */
  cancel(): void {
    this.reset()
  }

  /**
   * 行观测（Mud 行分发前置判定）。
   * @returns true = 该行是 AYT 应答行，**吞掉**（不进 pendingLines/画面/投递/
   * onActivity）；false = 正常行，照常分发。
   * 任何行到达同时是活证明：判活内部消化 + 静默锚重置。
   */
  observeLine(text: string): boolean {
    const swallow = AYT_ALIVE_RE.test(text)
    this.armIdle()
    return swallow
  }

  /** 边界观测（GA/EOR 到达）：活证明 + 静默锚重置（AYT 应答的主判活路径）。 */
  observeBoundary(): void {
    this.armIdle()
  }

  /** 全停复位（状态 + 计数 + timer；armIdle 与 cancel 共用）。 */
  private reset(): void {
    this.phase = 'idle'
    this.attemptsCount = 0
    this.ticks = 0
    this.clearTimer()
  }

  private schedule(ms: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.onTick()
    }, ms)
  }

  /**
   * 探测 tick（固定刻度链：startMs + k×retryMs，k = 0..maxAttempts）：
   *   - k < maxAttempts：busy → 跳过（不发不耗，U1 不顺延）；空闲 → 发 AYT
   *     （send 失败立即判死）；
   *   - k = maxAttempts（判死刻度）：busy → 本轮零收束；空闲 → 判死
   *     （onDead 携带实际发送次数）。
   */
  private onTick(): void {
    if (this.ticks >= this.opts.maxAttempts) {
      if (this.deps.isBusy?.() ?? false) {
        this.reset() // busy：不收束（disconnect 会截断在途 read），窗口关闭等下次数据
        return
      }
      const sent = this.attemptsCount
      this.reset()
      this.deps.onDead(sent)
      return
    }
    this.ticks += 1
    if (this.deps.isBusy?.() ?? false) {
      this.schedule(this.opts.retryMs) // busy 跳过：不发 AYT 不耗次数
      return
    }
    this.attemptsCount += 1
    this.phase = 'probing'
    if (!this.deps.send()) {
      const sent = this.attemptsCount
      this.reset()
      this.deps.onDead(sent)
      return
    }
    this.schedule(this.opts.retryMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
