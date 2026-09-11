/**
 * dsh-mud-core — 日志服务 (host half)。
 *
 * 统一运行/决策日志漏斗: 所有可观察事件 (运行流水 / 感知路由 / 命令发送 /
 * 网络 / 决策) 经单一入口 `log()` 进入本服务, 提供:
 *   - 进程内单调 seq 时间轴 (与 gameSeq/uiSeq 同源, 前端去重/续拉);
 *   - 内存环形缓冲 (WS backfill 回放 + 单测可读):
 *   - **文件落盘** (JSONL, 按天轮转, 超限滚动) — 与 dsh harness 的 ctx.logger
 *     通道并存: ctx.logger 负责 harness 控制台/审计 (若配置), 本服务保证 mud-core
 *     自身的日志**确定性落盘**, 路径经日志/状态接口暴露给用户;
 *   - 级别 (debug/info/warn/error) + 通道 (runtime/perception/send/network/decision)
 *     供前端分级着色与筛选;
 *   - 明文不落盘: 密码只经 `{pass}` 占位符流转 (tools.ts 发送瞬间插值), 本服务
 *     只见占位符或掩码文本 (sendCommand 的 redactCredential)。
 *
 * 落盘失败不炸主机: 文件错误经 onFileError 上报, 内存/WS 通道照常工作。
 * @module @deepseek-ai/dsh-mud-core/logging
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** 日志级别 (升序: debug < info < warn < error)。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志通道 (来源分组; 前端按此着色/筛选)。 */
export type LogChannel =
  | 'runtime'   // 系统/连接/生命周期/执行队列
  | 'network'   // telnet 网络层 (协商/断线/字节)
  | 'perception' // 感知: feedParsed/折叠/观察窗/判类路由
  | 'send'      // 命令发送/回显 (已掩码)
  | 'decision'  // 决策事件 (规则命中/agent 动作/路由判类)

/** 一条日志条目 (wire 兼容: 前端按字段渲染, 未知字段忽略)。 */
export interface LogEntry {
  seq: number
  time: number
  level: LogLevel
  channel: LogChannel
  text: string
  /** decision 通道专用: 决策来源。 */
  actor?: 'rule' | 'router' | 'agent' | 'flow'
  /** decision 通道专用: 所属规则/事件 id。 */
  ruleId?: string
  eventType?: string
  flow?: string
  action?: string
  result?: string
}

/** MudLogService 构造依赖。 */
export interface MudLogServiceOptions {
  /** 落盘目录; 缺省 undefined = 不落盘 (仅内存 + 回调)。 */
  logDir?: string | undefined
  /** 当前会话 id (用于日志文件名绑定; 缺省 'mud-player')。 */
  sessionId?: string
  /** 每条条目写入回调 (WS 转发 / 其它通道)。 */
  onEntry?: ((entry: LogEntry) => void) | undefined
  /** 文件写入失败回调 (缺省静默)。 */
  onFileError?: ((err: unknown, entry: LogEntry) => void) | undefined
  /** 内存缓冲上限 (缺省 2000; 超出丢最旧)。 */
  bufferMax?: number | undefined
}

/** 单文件字节上限: 超限滚动到 `-1.log` / `-2.log`… (5MB, JSONL 足够一天量级)。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 滚动文件数量上限 (文件数超过即覆盖最旧)。 */
const MAX_ROTATED = 3

/**
 * 解析落盘目录: 显式 `logDir` (trim 非空) 优先; 否则缺省 `defaultDir`。
 * 注意: `config.logDir` 未配置时 `?.trim() !== ''` 为 true — 必须显式判
 * undefined, 否则会返回 undefined 导致落盘被静默关闭 (曾为此踩坑: 日志 tab
 * 正常但文件不生成)。
 */
export function resolveLogDir(logDir: string | undefined, defaultDir: string): string {
  return logDir !== undefined && logDir.trim() !== '' ? logDir : defaultDir
}

/** 追加落一条 JSONL (文件不存在自动建目录; 失败上报不抛出)。 */
function appendJsonl(dir: string, stem: string, line: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stem}.log`)
  if (existsSync(path) && statSync(path).size > MAX_FILE_BYTES) {
    // 滚动: 旧文件改名 +1, 最旧的删。
    for (let i = MAX_ROTATED - 1; i >= 1; i -= 1) {
      const older = join(dir, `${stem}-${i}.log`)
      const newer = join(dir, `${stem}-${i - 1}.log`)
      if (existsSync(older)) {
        try { writeFileSync(older, '') } catch { /* best-effort */ }
      }
      if (existsSync(newer)) {
        try { writeFileSync(older, '') } catch { /* no-op */ }
      }
    }
    // 当前文件 → -1 (覆盖旧内容), 主文件重开。
    try { writeFileSync(path, '') } catch { /* best-effort */ }
  }
  appendFileSync(path, `${line}\n`, 'utf8')
}

/** 按天 + 会话文件名 stem: mud-YYYYMMDD-<sessionId>。 */
function dayStem(date: Date, sessionId: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `mud-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${sessionId}`
}

/**
 * 日志服务: 唯一漏斗 + 环形缓冲 + 文件 JSONL 落盘 + 转发回调。
 *
 * 日志文件按**当天 + 会话**绑定: `mud-YYYYMMDD-<sessionId>.log` (JSONL 行)。
 * 切换会话 (connect) 时调 `initLogFile(sessionId)` 重置文件目标;
 * 同一会话跨天时文件自动按日期区分。
 *
 * 线程模型: 插件进程内单线程, 方法全部同步 (appendFileSync 保证立即落盘,
 * 排查时"看一眼文件"即最新状态, 无需 flush)。
 */
export class MudLogService {
  private seq = 0
  private readonly buffer: LogEntry[] = []
  private readonly bufferMax: number
  private logDir: string | undefined
  private sessionId: string
  private readonly onEntry: ((entry: LogEntry) => void) | undefined
  private readonly onFileError: ((err: unknown, entry: LogEntry) => void) | undefined
  private fileErrorLogged = false

  constructor(options: MudLogServiceOptions = {}) {
    this.logDir = options.logDir?.trim() !== '' ? options.logDir : undefined
    this.sessionId = options.sessionId?.trim() || 'mud-player'
    this.onEntry = options.onEntry
    this.onFileError = options.onFileError
    this.bufferMax = options.bufferMax ?? 2000
    if (this.logDir !== undefined) {
      try {
        if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true })
      } catch { /* 目录不可建则静默降级为仅内存 */ }
    }
    // seq 从当日文件最大 seq 续起 (跨 host 运行持久递增): 使 logSeq 在
    // 当日全部条目中唯一 — 前端"文件恢复 + 实时流"按 logSeq 去重不误伤
    // 旧运行的同编号条目 (曾用 fixed 归零 seq, 恢复的旧运行 seq=1..N 与
    // 当前运行 seq=1..N 冲突, 旧条目当实时帧混入时间轴)。
    this.seedSeqFromFile(this.sessionId)
  }

  /** 从当日该会话文件读取最大 seq 并续起 (无文件/无条目则保持 0)。 */
  private seedSeqFromFile(sessionId: string): void {
    if (this.logDir === undefined) return
    const stem = dayStem(new Date(), sessionId.trim() || 'mud-player')
    const path = join(this.logDir, `${stem}.log`)
    if (!existsSync(path)) return
    try {
      const raw = readFileSync(path, 'utf8')
      let maxSeq = 0
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as { seq?: unknown }
          if (typeof parsed.seq === 'number' && parsed.seq > maxSeq) maxSeq = parsed.seq
        } catch { /* 坏行跳过 */ }
      }
      this.seq = maxSeq
    } catch { /* 读失败 → 保持当前 seq */ }
  }

  /**
   * 切换日志文件目标 (connect 时调用)。
   * 新会话 = 新文件 `mud-YYYYMMDD-<sessionId>.log`。
   * 同一会话跨天自动落在不同日期文件。
   * 切换会话时按新会话当日文件重新 seed seq (跨运行持久递增 — 文件累积
   * 旧运行条目, seq 必须越过文件最大号, 否则 logSeq 与旧运行同号冲突)。
   */
  initLogFile(sessionId: string): void {
    this.sessionId = sessionId.trim() || 'mud-player'
    this.fileErrorLogged = false // 新会话重置错误静默
    this.seedSeqFromFile(this.sessionId)
  }

  /** 是否有文件落盘目标。 */
  get fileTarget(): string | null {
    return this.logDir ?? null
  }

  /** 追加一条日志 (seq/time 由服务分配)。 */
  append(input: Omit<LogEntry, 'seq' | 'time'>): LogEntry {
    this.seq += 1
    const entry: LogEntry = {
      ...input,
      seq: this.seq,
      time: Date.now(),
    }
    // 内存缓冲 (WS backfill 回放链路)。
    this.buffer.push(entry)
    if (this.buffer.length > this.bufferMax) this.buffer.shift()
    // 文件落盘: 按当天 + 会话绑定 (`mud-YYYYMMDD-<sessionId>.log`)。
    if (this.logDir !== undefined) {
      try {
        const stem = dayStem(new Date(entry.time), this.sessionId)
        appendJsonl(this.logDir, stem, JSON.stringify(entry))
      } catch (err) {
        if (!this.fileErrorLogged) {
          this.fileErrorLogged = true
          this.onFileError?.(err, entry)
        }
      }
    }
    // 转发回调 (WS 推送等)。
    this.onEntry?.(entry)
    return entry
  }

  /** 便捷: info 级别。 */
  info(channel: LogChannel, text: string, meta: Partial<Omit<LogEntry, 'seq' | 'time' | 'level' | 'channel' | 'text'>> = {}): LogEntry {
    return this.append({ level: 'info', channel, text, ...meta })
  }

  /** 便捷: warn 级别。 */
  warn(channel: LogChannel, text: string, meta: Partial<Omit<LogEntry, 'seq' | 'time' | 'level' | 'channel' | 'text'>> = {}): LogEntry {
    return this.append({ level: 'warn', channel, text, ...meta })
  }

  /** 便捷: error 级别。 */
  error(channel: LogChannel, text: string, meta: Partial<Omit<LogEntry, 'seq' | 'time' | 'level' | 'channel' | 'text'>> = {}): LogEntry {
    return this.append({ level: 'error', channel, text, ...meta })
  }

  /** 便捷: debug 级别 (排查级细节; 前端默认弱化显示)。 */
  debug(channel: LogChannel, text: string, meta: Partial<Omit<LogEntry, 'seq' | 'time' | 'level' | 'channel' | 'text'>> = {}): LogEntry {
    return this.append({ level: 'debug', channel, text, ...meta })
  }

  /** 读内存缓冲 (测试/诊断; since 为 seq 过滤, 缺省全部)。 */
  entries(since = 0): readonly LogEntry[] {
    return since > 0 ? this.buffer.filter(e => e.seq > since) : this.buffer.slice()
  }

  /**
   * 读某会话**当日**日志文件 (JSONL → LogEntry[])。
   * 会话恢复时前端据此回写日志窗; 隔天不恢复 (只读今天)。
   * 返回当日**全部**条目 (含本 host 运行之前的): seq 已由 seedSeqFromFile
   * 续在文件最大号之后, 同一会话当日 logSeq 全局唯一 — 前端"恢复 + 实时"
   * 按 logSeq 去重不会误伤旧运行同号条目。
   * 文件不存在 → 空数组; 单行解析失败跳过该行。
   */
  readDayEntries(sessionId: string): LogEntry[] {
    if (this.logDir === undefined) return []
    const sid = sessionId.trim() || 'mud-player'
    const stem = dayStem(new Date(), sid)
    const path = join(this.logDir, `${stem}.log`)
    if (!existsSync(path)) return []
    const out: LogEntry[] = []
    try {
      const raw = readFileSync(path, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as LogEntry
          if (typeof parsed.seq === 'number' && typeof parsed.text === 'string') out.push(parsed)
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 读失败 → 空 (前端显示仅实时) */ }
    return out
  }
}