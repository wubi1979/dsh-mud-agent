/**
 * mud-core3 log — 会话日志：内存环形缓冲 + 按天 JSONL 落盘。
 *
 * 每个已登记的 SessionRuntime 挂一个 SessionLog 实例，全链路可观察事件经唯一入口
 * `append()` 进入本服务：
 *   - 进程内单调 seq 时间轴（前端按 seq 去重/续拉）；
 *   - 内存环形缓冲（诊断/remote.mud.logs 回放）；
 *   - **文件落盘**（JSONL，按天 + 会话绑定 `mud-YYYYMMDD-<sessionId>.log`，超限滚动）；
 *   - 级别（debug/info/warn/error）+ 通道（runtime/network/stream/deliver/gate）供筛选着色。
 *
 * 纪律：
 *   - 明文不落盘：本服务只见掩码文本，密码只经 sendCredential 直发、不进日志；
 *   - 落盘失败不炸主机：文件错误经 onFileError 上报一次，内存通道照常；
 *   - 与宿主 ctx.logger 并存：ctx.logger 负责宿主控制台/审计，本服务保证确定性落盘，
 *     路径经 remote.mud.logs 的 fileTarget 暴露。
 *
 * 纯 TS（只依赖 node 内建），零宿主依赖。
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

/** 日志级别（升序: debug < info < warn < error）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志通道（来源分组；前端按此筛选/着色）。 */
export type LogChannel =
  | 'runtime' // 生命周期：登记/建连/登录/断连/销毁/上下文收口（T18）
  | 'network' // telnet 网络层：协商/断线/协议异常
  | 'stream'  // 行流：MUD 文本行（debug 级，排查用）
  | 'deliver' // 投递：聚合批次/补投/缓冲溢出
  | 'gate'    // 接入闸门：admit/stop

/** 一条日志条目（wire 兼容：前端按字段渲染，未知字段忽略）。 */
export interface LogEntry {
  seq: number
  time: number
  level: LogLevel
  channel: LogChannel
  text: string
}

/** SessionLog 构造依赖。 */
export interface SessionLogOptions {
  /** 落盘目录；undefined/空 = 不落盘（仅内存 + 回调）。 */
  logDir?: string | undefined
  /** 每条条目写入回调（观测/转发；收到本条所属会话 id）。 */
  onEntry?: ((sessionId: string, entry: LogEntry) => void) | undefined
  /** 文件写入失败回调（缺省静默；只报一次）。 */
  onFileError?: ((error: unknown, entry: LogEntry) => void) | undefined
  /** 内存缓冲上限（缺省 2000；超出丢最旧）。 */
  bufferMax?: number | undefined
}

/** 单文件字节上限：超限滚动到 `-1.log` / `-2.log`…（5MB，JSONL 足够一天量级）。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 滚动文件数量上限（超出即丢弃最旧分片）。 */
const MAX_ROTATED = 3

/**
 * 解析落盘目录：显式 `logDir`（trim 非空）优先；否则用 `defaultDir`。
 * @param logDir - 配置的落盘目录。
 * @param defaultDir - 缺省目录。
 * @returns 实际使用的目录。
 */
export function resolveLogDir(logDir: string | undefined, defaultDir: string): string {
  return logDir !== undefined && logDir.trim() !== '' ? logDir : defaultDir
}

/** 按天 + 会话文件名 stem: mud-YYYYMMDD-<sessionId>。 */
function dayStem(date: Date, sessionId: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `mud-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${sessionId}`
}

/** 某会话日志文件名匹配（`mud-<8位日期>-<sessionId>[-N].log`；sessionId 已转义）。 */
function sessionLogPattern(sessionId: string): RegExp {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^mud-\\d{8}-${escaped}(?:-\\d+)?\\.log$`)
}

/** 追加落一条 JSONL（目录不存在自动建；超限先滚动；失败上报不抛出）。 */
function appendJsonl(dir: string, stem: string, line: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stem}.log`)
  if (existsSync(path) && statSync(path).size > MAX_FILE_BYTES) {
    // 滚动：最旧分片丢弃，其余依次后移，当前文件成为 -1。
    const oldest = join(dir, `${stem}-${MAX_ROTATED}.log`)
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = MAX_ROTATED - 1; i >= 1; i -= 1) {
      const from = join(dir, `${stem}-${i}.log`)
      if (existsSync(from)) renameSync(from, join(dir, `${stem}-${i + 1}.log`))
    }
    renameSync(path, join(dir, `${stem}-1.log`))
  }
  appendFileSync(path, `${line}\n`, 'utf8')
}

/**
 * 删除某会话的**全部**日志文件（所有日期 + 滚动分片）。
 *
 * 语义：删账号 = 删该账号的会话痕迹。日志按 sessionId 落盘，若不清，同名重建的账号
 * （或按旧 sessionId 补登记的会话）会把上一个身份的日志原样读出来。
 * 只删文件名属于该 sessionId 的文件，绝不触碰其它会话。
 * @param logDir - 落盘目录（undefined/空 = 不落盘，返回 0）。
 * @param sessionId - 会话 id。
 * @returns 实际删除的文件数（删失败不抛出）。
 */
export function purgeSessionLogs(logDir: string | undefined, sessionId: string): number {
  if (logDir === undefined || logDir.trim() === '' || !existsSync(logDir)) return 0
  const pattern = sessionLogPattern(sessionId.trim() || 'mud-player')
  let removed = 0
  try {
    for (const name of readdirSync(logDir)) {
      if (!pattern.test(name)) continue
      try {
        unlinkSync(join(logDir, name))
        removed += 1
      } catch { /* 占用/权限 → 跳过该文件 */ }
    }
  } catch { /* 目录不可读 → 0 */ }
  return removed
}

/**
 * 单会话日志服务：唯一漏斗 + 环形缓冲 + 按天 JSONL 落盘。
 *
 * 线程模型：进程内单线程，方法全部同步（appendFileSync 立即落盘，排查时"看一眼文件"
 * 即最新状态，无需 flush）。
 */
export class SessionLog {
  private seq = 0
  private readonly buffer: LogEntry[] = []
  private readonly bufferMax: number
  private readonly logDir: string | undefined
  private readonly sessionId: string
  private readonly onEntry: ((sessionId: string, entry: LogEntry) => void) | undefined
  private readonly onFileError: ((error: unknown, entry: LogEntry) => void) | undefined
  private fileErrorLogged = false

  /**
   * @param sessionId - 会话 id（= 账号 id；日志文件名绑定）。
   * @param options - 落盘目录/缓冲上限/回调。
   */
  constructor(sessionId: string, options: SessionLogOptions = {}) {
    this.sessionId = sessionId.trim() || 'mud-player'
    this.logDir = options.logDir?.trim() !== '' ? options.logDir : undefined
    this.onEntry = options.onEntry
    this.onFileError = options.onFileError
    this.bufferMax = options.bufferMax ?? 2000
    if (this.logDir !== undefined) {
      try {
        if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true })
      } catch { /* 目录不可建 → 静默降级为仅内存 */ }
    }
    // seq 从当日文件最大号续起：跨 host 运行保持单调，前端"文件恢复 + 实时流"按 seq 去重不误伤。
    this.seq = this.maxSeqInDayFile()
  }

  /** 是否有文件落盘目标。 */
  get fileTarget(): string | null {
    return this.logDir ?? null
  }

  /** 当前会话 id。 */
  get session(): string {
    return this.sessionId
  }

  /** 追加一条日志（seq/time 由服务分配）。 */
  append(input: Omit<LogEntry, 'seq' | 'time'>): LogEntry {
    this.seq += 1
    const entry: LogEntry = { ...input, seq: this.seq, time: Date.now() }
    this.buffer.push(entry)
    if (this.buffer.length > this.bufferMax) this.buffer.shift()
    if (this.logDir !== undefined) {
      try {
        appendJsonl(this.logDir, dayStem(new Date(entry.time), this.sessionId), JSON.stringify(entry))
      } catch (error) {
        if (!this.fileErrorLogged) {
          this.fileErrorLogged = true
          this.onFileError?.(error, entry)
        }
      }
    }
    this.onEntry?.(this.sessionId, entry)
    return entry
  }

  /** 便捷：debug 级。 */
  debug(channel: LogChannel, text: string): LogEntry {
    return this.append({ level: 'debug', channel, text })
  }

  /** 便捷：info 级。 */
  info(channel: LogChannel, text: string): LogEntry {
    return this.append({ level: 'info', channel, text })
  }

  /** 便捷：warn 级。 */
  warn(channel: LogChannel, text: string): LogEntry {
    return this.append({ level: 'warn', channel, text })
  }

  /** 便捷：error 级。 */
  error(channel: LogChannel, text: string): LogEntry {
    return this.append({ level: 'error', channel, text })
  }

  /**
   * 读内存缓冲。
   * @param since - 只返回 seq 大于该值的条目（缺省全部）。
   * @returns 条目快照。
   */
  entries(since = 0): readonly LogEntry[] {
    return since > 0 ? this.buffer.filter(entry => entry.seq > since) : this.buffer.slice()
  }

  /**
   * 原始行流（**file-only**）：MUD 文本行只落盘、不进内存环——内存环留给运行/网络/
   * 投递事件，否则刷屏行会瞬间冲掉诊断信息。未配置落盘时为空操作。
   * @param text - 纯文本行。
   */
  stream(text: string): void {
    if (this.logDir === undefined) return
    this.seq += 1
    const entry: LogEntry = { seq: this.seq, time: Date.now(), level: 'debug', channel: 'stream', text }
    try {
      appendJsonl(this.logDir, dayStem(new Date(entry.time), this.sessionId), JSON.stringify(entry))
    } catch (error) {
      if (!this.fileErrorLogged) {
        this.fileErrorLogged = true
        this.onFileError?.(error, entry)
      }
    }
  }

  /** 当日文件里的最大 seq（无文件/无条目 → 0）。 */
  private maxSeqInDayFile(): number {
    if (this.logDir === undefined) return 0
    const path = join(this.logDir, `${dayStem(new Date(), this.sessionId)}.log`)
    if (!existsSync(path)) return 0
    try {
      let max = 0
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as { seq?: unknown }
          if (typeof parsed.seq === 'number' && parsed.seq > max) max = parsed.seq
        } catch { /* 坏行跳过 */ }
      }
      return max
    } catch {
      return 0
    }
  }
}
