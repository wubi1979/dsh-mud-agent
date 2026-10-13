/**
 * mud-core3 view/screen — 游戏画面通道（C5）：服务端无头屏 + 只读流扇出。
 *
 * 对齐宿主 BrowserTerminal 的同型机制（terminal-controller/src/terminal.ts）：
 *   - 服务端维护 @xterm/headless 无头屏（行到达即写入，跨重连不清屏）；
 *   - attach 首帧 = SerializeAddon 序列化整屏（视口 + 全部 scrollback），随后有序增量；
 *   - **follower 注册与 snapshot 生成在同一条写操作链（enqueue）上，与写入互斥**
 *     —— attach 瞬间不丢帧、不乱序、不重复（时序不变量）；
 *   - follower 有界队列：超限**显式失败**断流（TerminalFollower 同型），
 *     客户端重新 attach 以新 snapshot 恢复 —— 与 snapshot 模式互为闭环。
 *
 * C5.2 双屏：一帧双字段（不是两条流/两个 follower 集——队列/背压/断流重连
 * 语义零改动，attach 原子性由同一操作链天然保持）：
 *   - 主屏 = 无头屏（无标行 + send 回显，机制零重构）；
 *   - 副屏 = 有界行环（有标行 MudLine 追加，cap 按有标行条数，超限丢最旧；
 *     实测语料全服输出纯行式 + SGR 零光标寻址 ⇒ 行环 join 即回放，无需 VT 栅格，
 *     且不限 cols——客户端窄栏自由 wrap）。
 *
 * 与录制缓冲的分工：pendingLines 服务工具面裸读（断线清空）；本屏服务视图
 * （跨重连连续，随 runtime 存活）。两者独立、各自有界。
 *
 * 帧形态对齐宿主 TerminalFrame：snapshot / output / state。send 回显在服务端
 * 直接写入无头屏（区分色前缀）—— 晚加入者的 snapshot 天然含历史回显，客户端零特判。
 *
 * 纯度纪律：本文件不 import 宿主；@xterm 两包为纯 JS，可在 Node 运行。
 *
 * @module mud-core3/view/screen
 */

import { createRequire } from 'node:module'
import type { Terminal } from '@xterm/headless'
import type { SerializeAddon } from '@xterm/addon-serialize'

// @xterm 两包是 webpack CJS bundle（cjs-module-lexer 探不出命名导出），Node ESM
// 的 `import { Terminal }` 会报 no named export —— 宿主 terminal-controller 同款
// 做法：类型走 type-only，值经 createRequire 相对 require 惰性加载。
const requireCjs = createRequire(import.meta.url)
const HeadlessTerminal = requireCjs('@xterm/headless').Terminal as typeof Terminal
const SerializeAddonCtor = requireCjs('@xterm/addon-serialize').SerializeAddon as typeof SerializeAddon

/** 画面通道视图参数（Config 三参数成组，逐项可省略取缺省）。 */
export interface GameViewOptions {
  /** 无头屏 scrollback 行数（snapshot 回放深度）。缺省 2000（对齐录制缓冲）。 */
  scrollback?: number
  /** 无头屏列数（固定，不做 NAWS/resize 回传，客户端自适应重排）。缺省 80。 */
  cols?: number
  /** 单 follower 缓冲上限（字节）。超限该 follower 显式失败断流。缺省 2MB。 */
  maxBufferedBytes?: number
  /** 副屏行环上限（按**有标行条数**计，超限丢最旧）。缺省 1000。 */
  subCap?: number
}

/** 画面帧公共 info（state 用 string，避免边界类型耦合 ConnState）。 */
export interface GameViewInfo {
  sessionId: string
  state: string
  cols: number
}

/** 首帧：整屏快照（一帧双屏——主屏 serialize 含视口 + 全部 scrollback；副屏行环 join）。 */
export interface GameSnapshotFrame {
  type: 'snapshot'
  sequence: number
  /** 主屏历史（termMain serialize，只含无标行 + 回显）。 */
  screenMain: string
  /** 副屏历史（行环 join，有标行原文含 ANSI；客户端窄栏原色渲染）。 */
  screenSub: string
  info: GameViewInfo
}

/** 增量帧：本批行按标拆双字段（无标行 join / 有标行 join，均含行尾）。 */
export interface GameOutputFrame {
  type: 'output'
  sequence: number
  /** 本批无标行 + send 回显 join（主屏增量原文）。 */
  main: string
  /** 本批有标行 join（副屏增量原文，含 ANSI）。 */
  sub: string
}

/** 状态帧：连接状态变化（客户端渲染状态行；不写入无头屏）。 */
export interface GameStateFrame {
  type: 'state'
  info: GameViewInfo
}

/** 画面流帧（对齐宿主 TerminalFrame 的三形态）。 */
export type GameFrame = GameSnapshotFrame | GameOutputFrame | GameStateFrame

/** 同 tick 合批直吐上限（字节，近似）：到达即不等 tick 边界（v1 ItemQueue 同型）。 */
const DIRECT_FLUSH_BYTES = 64 * 1024

/** 默认帧的计费字节（state 帧很小，给个常数）。 */
const STATE_FRAME_BYTES = 64

const encoder = new TextEncoder()

function frameBytes(frame: GameFrame): number {
  if (frame.type === 'snapshot') {
    return encoder.encode(frame.screenMain).length + encoder.encode(frame.screenSub).length
  }
  if (frame.type === 'output') {
    return encoder.encode(frame.main).length + encoder.encode(frame.sub).length
  }
  return STATE_FRAME_BYTES
}

/**
 * 单个 follower：有界帧队列 + 显式失败语义（TerminalFollower 同型）。
 *
 * push 只发生在 GameScreen 的写操作链内（与写入互斥）；frames 由流动词消费。
 * 超限即 fail：清空队列并置失败态，消费侧下一次 next() 抛错 —— 客户端重连恢复。
 */
class ScreenFollower {
  private queue: GameFrame[] = []
  private bytes = 0
  private wake: (() => void) | null = null
  private failure: Error | null = null

  constructor(private readonly maxBytes: number) {}

  /** 入队一帧（snapshot 为恢复载荷：单独超限也放行，否则慢客户端永远无法恢复）。 */
  push(frame: GameFrame): void {
    if (this.failure !== null) return
    this.bytes += frameBytes(frame)
    this.queue.push(frame)
    if (frame.type !== 'snapshot' && this.bytes > this.maxBytes) {
      this.fail(new Error(
        `slow follower: 缓冲超限（${this.bytes} > ${this.maxBytes} 字节）；重连以 snapshot 恢复`,
      ))
      return
    }
    this.wake?.()
  }

  /** 显式失败：清空在途帧，消费侧抛错断流。 */
  fail(error: Error): void {
    if (this.failure !== null) return
    this.failure = error
    this.queue = []
    this.bytes = 0
    this.wake?.()
  }

  /** 消费帧流：队列空则等待；失败态抛错；abort 干净退出。 */
  async *frames(signal: AbortSignal): AsyncGenerator<GameFrame> {
    try {
      while (true) {
        if (this.queue.length > 0) {
          const frame = this.queue.shift() as GameFrame
          this.bytes -= frameBytes(frame)
          yield frame
          continue
        }
        if (this.failure !== null) throw this.failure
        if (signal.aborted) return
        await new Promise<void>(resolve => { this.wake = resolve })
        this.wake = null
      }
    } finally {
      this.wake = null
    }
  }
}

/**
 * 每会话游戏画面：无头屏 + follower 集 + 写操作链。
 *
 * 由 SessionRuntime 持有（mud.onLine → write，mud.onSend → echo，
 * 状态变化 → setState）；remote.mud.follow 经 attach() 供流。
 */
export class GameScreen {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private readonly followers = new Set<ScreenFollower>()
  private readonly maxBufferedBytes: number
  /** 副屏行环上限（有标行条数）。 */
  private readonly subCap: number
  /** 副屏行环（有标行原文，含行尾；超限丢最旧）。join 即回放。 */
  private readonly subRing: string[] = []
  /** 当前连接状态（进 snapshot info）。 */
  private stateValue = 'disconnected'
  /** 帧序号（单调递增；观测/排序断言用，客户端不做去重）。 */
  private sequence = 0
  /** 写操作链：写入 / attach 注册+快照 / 状态广播全部经此串行（时序不变量）。 */
  private ops: Promise<unknown> = Promise.resolve()
  /** 主屏合批缓冲：同 tick 的无标行合并为一次 term.write + output.main。 */
  private pending: string[] = []
  private pendingBytes = 0
  /** 副屏合批缓冲：同 tick 的有标行合并为 output.sub（行环已同步追加）。 */
  private subPending: string[] = []
  private flushScheduled = false
  private disposedFlag = false

  constructor(
    readonly sessionId: string,
    options: GameViewOptions = {},
  ) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? 2 * 1024 * 1024
    this.subCap = options.subCap === undefined || options.subCap < 1 ? 1000 : options.subCap
    this.term = new HeadlessTerminal({
      cols: options.cols ?? 120,
      rows: 24,
      scrollback: options.scrollback ?? 2000,
      allowProposedApi: true, // SerializeAddon 依赖 proposed API（宿主同款）
    })
    this.serializer = new SerializeAddonCtor()
    this.term.loadAddon(this.serializer)
  }

  get state(): string {
    return this.stateValue
  }

  get isDisposed(): boolean {
    return this.disposedFlag
  }

  /** 当前 follower 数（观测用）。 */
  get followerCount(): number {
    return this.followers.size
  }

  /**
   * 写入游戏文本（行原文 + 行尾；C5.2 按 kind 路由双屏）。
   * 无标行（kind === null）走主屏无头屏；有标行追加副屏行环（不进无头屏）。
   * 同 tick 合批；超直吐上限立即落链。慢路径：setImmediate 合帧 —— 一次事件
   * 循环 tick 内到达的行合并为一次写入 + 一帧 output（双字段）。
   */
  write(text: string, kind: string | null = null): void {
    if (this.disposedFlag || text === '') return
    if (kind !== null) {
      // 副屏路径：增量文本攒批；**行环追加在写操作链内**（flushNow 同操作）——
      // 快照与广播严格同序，attach 瞬间不重不漏（与主屏 drain 同一不变量）。
      this.subPending.push(text)
    } else {
      // 主屏路径（无头屏，机制零改动）。
      this.pending.push(text)
      this.pendingBytes += text.length
    }
    if (this.pendingBytes >= DIRECT_FLUSH_BYTES) {
      this.flushNow()
      return
    }
    if (this.flushScheduled) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      this.flushNow()
    })
  }

  /**
   * 直发命令回显：带来源区分色前缀写进无头屏（output 帧路径，客户端零特判）——
   * agent 发送 = `账号名@agent>` 灰（90m），user 发送 = `账号名@user>` 青（36m）。
   * 凭据永不经过此路径 —— Mud.sendCredential 不触发 onSend。
   */
  echo(cmd: string, source: 'agent' | 'user' = 'agent', accountName = ''): void {
    const color = source === 'agent' ? '90' : '36'
    this.write(`\x1b[${color}m${accountName}@${source}> ${cmd}\x1b[0m\r\n`)
  }

  /** 连接状态变化：广播 state 帧（不写入无头屏 —— 屏内容只属于游戏文本）。 */
  setState(state: string): void {
    if (this.disposedFlag || state === this.stateValue) return
    this.stateValue = state
    void this.enqueue(() => {
      if (this.disposedFlag) return
      this.broadcast({ type: 'state', info: this.info() })
    })
  }

  /**
   * 附加 follower：**注册与 snapshot 生成共用一条写操作链**（与行写入互斥，
   * BrowserTerminal.follow 同型）—— 返回的流首帧必为 snapshot，随后有序增量。
   *
   * abort（tab 关闭/流断开）自动摘除 follower；慢 follower 超限显式失败
   * （错误抛给迭代器），客户端重新 attach 以新 snapshot 恢复。
   */
  attach(signal: AbortSignal): AsyncIterable<GameFrame> {
    const setup = this.enqueue(() => {
      if (this.disposedFlag) throw new Error(`会话 ${this.sessionId} 画面已销毁`)
      const follower = new ScreenFollower(this.maxBufferedBytes)
      // 同一操作链内同步取双屏：主屏 serialize + 副屏行环 join（attach 原子性）。
      const snapshot: GameSnapshotFrame = {
        type: 'snapshot',
        sequence: ++this.sequence,
        screenMain: this.serializer.serialize(),
        screenSub: this.subRing.join(''),
        info: this.info(),
      }
      this.followers.add(follower)
      follower.push(snapshot)
      return follower
    })
    // 消费侧从不迭代时（流未建立即 abort）兜底摘除。
    signal.addEventListener('abort', () => {
      void setup.then(follower => { this.followers.delete(follower) }).catch(() => {})
    }, { once: true })
    const self = this
    async function* iterate(): AsyncGenerator<GameFrame> {
      const follower = await setup
      try {
        yield* follower.frames(signal)
      } finally {
        self.followers.delete(follower)
      }
    }
    return iterate()
  }

  /** 销毁（runtime dispose）：所有 follower 显式失败 + 释放无头屏 + 清行环。 */
  dispose(): void {
    if (this.disposedFlag) return
    this.disposedFlag = true
    const failure = new Error(`会话 ${this.sessionId} 画面已销毁`)
    for (const follower of [...this.followers]) follower.fail(failure)
    this.followers.clear()
    this.pending = []
    this.pendingBytes = 0
    this.subPending = []
    this.subRing.length = 0
    this.term.dispose()
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  private info(): GameViewInfo {
    return { sessionId: this.sessionId, state: this.stateValue, cols: this.term.cols }
  }

  /** 写操作链（BrowserTerminal.enqueue 同型）：前序成败都不阻断后序。 */
  private enqueue<T>(operation: () => T): Promise<T> {
    const run = this.ops.then(operation, operation)
    this.ops = run.then(() => undefined, () => undefined)
    return run
  }

  private flushNow(): void {
    if (this.pending.length === 0 && this.subPending.length === 0) return
    const mainData = this.pending.join('')
    const subTexts = this.subPending
    const subData = subTexts.join('')
    this.pending = []
    this.pendingBytes = 0
    this.subPending = []
    void this.enqueue(() => {
      if (this.disposedFlag) return
      // 副屏行环追加（写操作链内，与快照同链同序——attach 原子性不变量；
      // 按写入文本逐条入环，cap 按有标行条数计，超限丢最旧）。
      for (const text of subTexts) this.subRing.push(text)
      const over = this.subRing.length - this.subCap
      if (over > 0) this.subRing.splice(0, over)
      // 一帧双字段：main/sub 同帧广播（不是两条流——队列/背压语义零改动）。
      this.broadcast({ type: 'output', sequence: ++this.sequence, main: mainData, sub: subData })
      // xterm 的 write 是异步解析：等 drain 完成才算本操作完成 ——
      // 否则后续 attach 的 serialize 会读到未落屏的空缓冲。
      if (mainData !== '') {
        return new Promise<void>(resolve => { this.term.write(mainData, resolve) })
      }
    })
  }

  /** 广播给全部 follower（复制集合遍历：fail 会改集合）。 */
  private broadcast(frame: GameOutputFrame | GameStateFrame): void {
    for (const follower of [...this.followers]) follower.push(frame)
  }
}
