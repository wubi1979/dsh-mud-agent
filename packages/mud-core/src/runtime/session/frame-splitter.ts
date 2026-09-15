/**
 * dsh-mud-core — 分帧器 (FrameSplitter), host half. 会话层。
 *
 * 边界裁决的唯一出口 (`doc/architecture/07-08-t1-bridge.md` §8.0): 行流在何处切帧、
 * 帧何时提交，只由两类**标记**决定 —— GA/EOR (八成, 常驻缺省) 与声明判据
 * (十成, 武装标记)。静默/超时不是边界 (v0.6.0 删除): 超时 = 放弃等待, 由事务表
 * 处理 (§8.4); 帧的提交只发生在标记命中或内存阀 (§8.6, 防 OOM 保险) 触发时。
 *
 * 帧生命周期 (§8.2): 开放 (前帧提交后首行到达) → 累积 (一切入站行入帧,
 * 回显/插话/过程输出不分类) → 提交 (任一标记命中) → 消费 (消费链五站单遍,
 * 由装配方在 `onFrame` 接线; 本模块不关心链)。
 *
 * 武装标记 (§8.5): 凡需要被响应的语句 (打断规则 / 流程入口 driver / 流程步
 * ok·fail / 事务 expect) 都注册为标记, 命中即提交帧。§19 的 arming 集与这里的
 * 标记表是同一张表 —— GA 是常驻缺省标记, 不在本模块登记 (边界事件由宿主直送
 * `boundary()`)。
 *
 * 计时/网络节奏零依赖 (I7): 归属只由行序列决定, 不看行到达的时间窗。
 * @module @deepseek-ai/dsh-mud-core/runtime/session/frame-splitter
 */

import type { MudLine } from '../../services/network/ansi.ts'
import { textOfLines } from '../../services/network/ansi.ts'

/** 帧提交标记: ga/eor (主边界) / armed (武装判据命中) / valve (帧内存阀)。 */
export type FrameMarker = 'ga' | 'eor' | 'armed' | 'valve'

/** 提交后的帧: 消费链 (§8.2 五站) 的唯一输入。 */
export interface MudFrame {
  /** 帧行 (含标记行)。 */
  lines: MudLine[]
  /** 帧纯文本 (lines 的 textOfLines)。 */
  text: string
  /** 提交标记。 */
  marker: FrameMarker
  /** marker==='armed' 时的标记 id (事务/流程对账用)。 */
  markerId?: string
}

/** 武装标记声明 (§8.1 判据)。 */
export interface ArmedMarkerSpec {
  /** 标记 id (调用方提供, 用于对账与注销; 如 `tx-r12` / 流程步判据 id)。 */
  id: string
  /** 判据: 锚定整行正则 (逐行测, P1-2 语义)。 */
  pattern: string | RegExp
  /** 一次性: 命中提交后自动注销 (事务判据缺省 true; 常驻标记写 false)。 */
  once?: boolean
}

/** 已编译的武装标记 (内部)。 */
interface ArmedMarker extends ArmedMarkerSpec {
  re: RegExp | null
}

export interface FrameSplitterOptions {
  /** 帧内存阀行数 (§8.6; 缺省 256)。 */
  maxFrameLines?: number
  /** 自动 flush 延迟 (ms): feedLines 非空时排定时器, 到点提交 valve 帧。
   *  缺省 50ms — 真实网络 GA 几乎总在 50ms 内到达 → boundary() 会 clear;
   *  无 GA 异常场景 50ms 兜底。设 0 禁用。 */
  autoFlushMs?: number
  /** 日志。 */
  onLog?: (text: string) => void
}

/**
 * 分帧器。每会话一实例 (I8: 无模块级状态); 重连后宿主须调 `reset()`
 * (旧连接的行对象已随 parser 作废, 与旧桥 reset 同语义)。
 */
export class FrameSplitter {
  /** 帧提交出口: 装配方接线 (session 消费链入口)。 */
  onFrame: ((frame: MudFrame) => void) | undefined

  private readonly maxFrameLines: number
  private readonly autoFlushMs: number
  private readonly onLog: ((text: string) => void) | undefined
  /** 当前开放帧 (标记之间的行累积)。 */
  private open: MudLine[] = []
  private armed: ArmedMarker[] = []
  /** 自动 flush 定时器 (feedLines 非空时排, boundary/reset/commit 时 clear)。 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: FrameSplitterOptions = {}) {
    this.maxFrameLines = options.maxFrameLines ?? 256
    this.autoFlushMs = options.autoFlushMs ?? 50
    this.onLog = options.onLog
  }

  // ── 宿主接口 ───────────────────────────────────────────

  /** 喂入一个文本块的行 (telnet 'parsed' 粒度): 累积进开放帧, 逐行测武装标记。 */
  feedLines(lines: readonly MudLine[]): void {
    if (lines.length === 0) return
    for (const line of lines) {
      this.open.push(line)
      const hit = this.testLine(line)
      if (hit !== null) {
        // 命中行(含)之前的行定格为帧; **继续处理本批剩余行** (它们属于下一开放帧,
        // 不得丢弃 — I5 每行恰投一次)。
        this.commit(this.open.length - 1, 'armed', hit)
        continue
      }
      if (this.open.length >= this.maxFrameLines) {
        this.onLog?.(`[分帧] 帧内存阀触发 (${this.open.length} 行), 提交无标记帧 (§8.6)`)
        this.commit(this.open.length - 1, 'valve')
      }
    }
    // 自动 flush 兜底 (非空帧, 无标记到达时提交 valve 帧)。
    if (this.open.length > 0 && this.flushTimer === null && this.autoFlushMs > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        if (this.open.length > 0) this.commit(this.open.length - 1, 'valve')
      }, this.autoFlushMs)
    }
  }

  /** 主边界 (telnet 'boundary' 事件): GA/EOR 常驻缺省标记, 命中即提交。
   *  即使开放帧为空也要提交 (空 GA 帧) — 让宿主知道"这条请求的边界到了, settle 空帧"。 */
  boundary(kind: 'ga' | 'eor'): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    // 空帧也要提交 — 让宿主桥知道 boundary 到达 (有 live reply 时需要 settle)。
    this.commit(this.open.length - 1, kind)
  }

  /**
   * 注册武装标记 (§8.5)。**arming 即测**: 开放帧里的既有行若已命中 (重试重挂、
   * 流程换步时完成句已在帧内), 当场提交 —— 与流程"同批行优先"同语义。
   * @returns 标记 id (非法正则时同样返回, 但标记永不命中并留痕一次)。
   */
  arm(spec: ArmedMarkerSpec): string {
    const re = compile(spec.pattern)
    if (re === null) {
      this.onLog?.(`[分帧] 武装标记正则非法, 永不命中: ${spec.id}`)
    }
    this.armed.push({ ...spec, re })
    if (re !== null) {
      const idx = this.open.findIndex(line => testRe(re, line.text))
      if (idx !== -1) {
        this.commit(idx, 'armed', spec.id)
      }
    }
    return spec.id
  }

  /** 注销武装标记 (事务结算/放弃重挂/流程复位/断线时调用)。幂等。 */
  disarm(id: string): void {
    this.armed = this.armed.filter(m => m.id !== id)
  }

  /** 重连复位: 清开放帧与全部武装标记 + flush 定时器。 */
  reset(): void {
    this.open = []
    this.armed = []
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
  }

  /**
   * v0.6.0 S3b-1: 强制提交当前开放帧 (无标记, marker='valve')。
   * 用于 scheduleSettle 兜底 —— 没有 GA/武装标记时, 让帧也能提交跑感知/投递。
   * 空帧不提交 (避免无效回调)。
   */
  flush(): void {
    if (this.open.length === 0) return
    this.commit(this.open.length - 1, 'valve')
  }

  /** 诊断: 开放帧行数 / 武装标记数 (I9 观测面)。 */
  stats(): { openLines: number; armed: number } {
    return { openLines: this.open.length, armed: this.armed.length }
  }

  // ── 内部 ───────────────────────────────────────────────

  /** 单行武装标记测试 (同类多命中按声明顺序取首, I13)。 */
  private testLine(line: MudLine): string | null {
    for (const m of this.armed) {
      if (m.re !== null && testRe(m.re, line.text)) return m.id
    }
    return null
  }

  /**
   * 提交: `endIdx` (含) 之前的行定格为帧, 之后的行留作下一开放帧。
   * 提交是**同步单遍**的: `onFrame` (消费链) 里再次 arm/feed 引发的连锁提交,
   * 每次至少消费掉标记行一行, 故必然终止。
   */
  private commit(endIdx: number, marker: FrameMarker, armedId?: string): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    const lines = this.open.slice(0, endIdx + 1)
    this.open = this.open.slice(endIdx + 1)
    if (marker === 'armed') {
      const m = this.armed.find(x => x.id === armedId)
      if (m !== undefined && m.once !== false) this.disarm(armedId!)
    }
    const frame: MudFrame = { lines, text: textOfLines(lines), marker }
    if (armedId !== undefined) frame.markerId = armedId
    this.onFrame?.(frame)
  }
}

/** 编译锚定整行正则 (字符串只编译一次; 非法 → null, 调用方留痕)。 */
function compile(pattern: string | RegExp): RegExp | null {
  if (pattern instanceof RegExp) return pattern
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/** 逐行测试 (P1-2: 锚定整行正则须逐行测, 多行串上 ^…$ 恒 false)。 */
function testRe(re: RegExp, text: string): boolean {
  re.lastIndex = 0
  return re.test(text)
}
