/**
 * dsh-mud-core — 流式 ANSI / 行解析器 (host half).
 *
 * 对齐 Mudlet mIncompleteSequenceBytes 的取舍: 单遍状态机把 telnet 解码后的
 * 文本流切成"完整逻辑行", 同时保留颜色/样式。跨块的不完整 ESC 序列与未换行
 * 行尾缓存在解析器内部, 下一块到达继续接续 —— 消除了旧实现在 TCP 块边界
 * 处"拆错行/剥不掉半截序列"导致的感知行号错位与多行规则被切碎。
 *
 * 每个产出行的三个视图 (同一遍扫描得到, 消费方按需取用):
 *   - text   纯文本 (无 ANSI, 控制字符已剔除) —— agent 注入、规则匹配
 *   - raw    原始文本 (含 ANSI, 不含行末换行符) —— xterm 前端渲染
 *   - style  逐段样式 run (run-length, start/end 落在 text 坐标系) —— 颜色触发/富渲染
 *
 * 样式游标跨行保持 (符合 ANSI 语义); 行末未显式清零则延续到下一行。
 * @module @deepseek-ai/dsh-mud-core/ansi
 */

/** 样式位标志 (紧凑 bitmask, run-length 存储)。 */
export const enum StyleFlag {
  Bold = 1,
  Dim = 2,
  Italic = 4,
  Underline = 8,
  Blink = 16,
  Reverse = 32,
  Strike = 64,
}

/** 一段连续同样式文本 (start/end 为 text 的下标, [start, end))。 */
export interface StyleRun {
  start: number
  end: number
  /** 前景色: 0-255 xterm 调色板索引; null = 默认。 */
  fg: number | null
  /** 背景色: 0-255 xterm 调色板索引; null = 默认。 */
  bg: number | null
  /** 24-bit 真彩前景 (优先级高于 fg)。 */
  fgTrue: [number, number, number] | null
  /** 24-bit 真彩背景 (优先级高于 bg)。 */
  bgTrue: [number, number, number] | null
  /** StyleFlag 位掩码。 */
  flags: number
}

/**
 * 完整逻辑行 (标准行对象, Phase 2 起为全链路消费方统一的数据形态)。
 * abs 由行缓冲 (PerceptionBuffer) 分配, 解析器产出时未携带。
 */
export interface MudLine {
  /** 纯文本 (无 ANSI): agent 注入、规则匹配。 */
  text: string
  /** 原始文本 (含 ANSI, 无行末换行): xterm 前端渲染。 */
  raw: string
  /** 逐段样式 run; 无颜色/样式时为空数组。 */
  style: StyleRun[]
  /** 绝对行号 (单调递增, 由行缓冲分配)。 */
  abs: number
  /** 该行最后收尾时间戳。 */
  time: number
  /** 是否为提示符行 (启发式, 无换行的行尾在 flush 时按此标记)。 */
  isPrompt: boolean
}

/** 解析器单次产出的一行 (尚未分配 abs)。 */
export interface ParsedLine {
  text: string
  raw: string
  style: StyleRun[]
  time: number
  isPrompt: boolean
}

/** CSI/OSC/单字符转义序列剥离 (供一次性整串场景, GMCP 载荷等)。 */
export const ANSI_STRIP_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** 从一段完整文本中剥离所有 ANSI 转义序列 (非流式工具函数)。 */
export function stripAnsi(text: string): string {
  return String(text).replace(ANSI_STRIP_RE, '')
}

/** 文案中的控制字符 (保留 \t; \n/\r 为行分隔符, 不进 text)。 */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const ESC = '\u001b'

/** prompt 启发: 默认裸 > / ＞ 行 (与 perception.isPromptRow 同规则)。 */
export function isPromptText(text: string): boolean {
  const t = text.trim()
  return t === '>' || t === '＞' || /^[>＞]\s*$/.test(t)
}

function toInt(v: string | undefined, max = 255): number | null {
  if (v === undefined || v === '') return null
  const n = Number.parseInt(v, 10)
  if (Number.isNaN(n) || n < 0) return null
  return n > max ? max : n
}

function hasStyle(fg: number | null, bg: number | null,
  fgTrue: [number, number, number] | null, bgTrue: [number, number, number] | null,
  flags: number): boolean {
  return fg !== null || bg !== null || fgTrue !== null || bgTrue !== null || flags !== 0
}

const enum State {
  Text = 0,
  Esc = 1,
  Csi = 2,
  Osc = 3,
}

/**
 * 流式状态机解析器。
 *
 * write(chunk) 只返回"本块内已完结"的完整逻辑行; 行尾/转义序列若被块截断,
 * 缓存在内部状态里, 待下一块 (或 flush) 续接 —— 保证绝对行号稳定、规则不被
 * 切碎的块边界破坏。
 */
export class AnsiStreamParser {
  private state: State = State.Text
  // 当前行积累 (数组 + 长度, 避免逐字符字符串拼接)
  private raw: string[] = []
  private text: string[] = []
  private textLen = 0
  // 样式游标 (跨行保持)
  private fg: number | null = null
  private bg: number | null = null
  private fgTrue: [number, number, number] | null = null
  private bgTrue: [number, number, number] | null = null
  private flags = 0
  // 当前打开的样式段 (仅非默认样式才记录 run)
  private runOpen = false
  private openStart = 0
  private runs: StyleRun[] = []
  // 跨块残留的控制序列内容
  private csiBuf = ''
  private oscBuf = ''

  /** 是否还有未完结的行尾/半截序列 (供 telnet 侧调度 flush 定时器)。 */
  get pending(): boolean {
    return this.state !== State.Text || this.textLen > 0 || this.raw.length > 0
  }

  reset(): void {
    this.state = State.Text
    this.raw = []
    this.text = []
    this.textLen = 0
    this.fg = null
    this.bg = null
    this.fgTrue = null
    this.bgTrue = null
    this.flags = 0
    this.runOpen = false
    this.openStart = 0
    this.runs = []
    this.csiBuf = ''
    this.oscBuf = ''
  }

  /** 写入一块解码后的文本, 返回本块内完结的完整行。 */
  write(chunk: string): ParsedLine[] {
    if (chunk.length === 0) return []
    const out: ParsedLine[] = []
    let i = 0
    while (i < chunk.length) {
      if (this.state === State.Text) {
        // 快路径: 一次定位下一个特殊字符 (ESC / 换行), 整段复制。
        let next = chunk.length
        let hit = chunk.indexOf(ESC, i)
        if (hit >= 0 && hit < next) next = hit
        hit = chunk.indexOf('\n', i)
        if (hit >= 0 && hit < next) next = hit
        hit = chunk.indexOf('\r', i)
        if (hit >= 0 && hit < next) next = hit
        if (next > i) {
          this.pushPlain(chunk.slice(i, next))
          i = next
          continue
        }
        const ch = chunk.charAt(i)
        if (ch === ESC) {
          this.raw.push(ch)
          this.state = State.Esc
          i += 1
          continue
        }
        // \n / \r：行分隔符 (\r\n 视为一个)。
        if (ch === '\r' && chunk.charAt(i + 1) === '\n') i += 2
        else i += 1
        out.push(this.commitLine())
        continue
      }
      if (this.state === State.Esc) {
        const ch = chunk.charAt(i)
        if (ch === '[') {
          this.raw.push(ch)
          this.csiBuf = ''
          this.state = State.Csi
        } else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
          // OSC / DCS / PM / SOS / APC: 统一按"到 BEL 或 ESC 为止"终止
          this.raw.push(ch)
          this.oscBuf = ch
          this.state = State.Osc
        } else {
          // 单字符转义 / 其它: 忽略内容
          this.raw.push(ch)
          this.state = State.Text
        }
        i += 1
        continue
      }
      if (this.state === State.Csi) {
        const ch = chunk.charAt(i)
        this.raw.push(ch)
        if (ch >= '\x40' && ch <= '\x7e') {
          if (ch === 'm') this.applySgr(this.csiBuf)
          this.state = State.Text
        } else {
          this.csiBuf += ch
        }
        i += 1
        continue
      }
      // Osc: 内容忽略, 遇 BEL 或 ESC (ST 或新序列) 终止。
      const ch = chunk.charAt(i)
      this.raw.push(ch)
      if (ch === '\x07') {
        this.state = State.Text
      } else if (ch === ESC) {
        this.state = State.Esc
      } else {
        this.oscBuf += ch
      }
      i += 1
    }
    return out
  }

  /** 流结束: 强制把未换行的行尾刷出 (返回 null = 无可显示内容)。 */
  flush(): ParsedLine | null {
    if (this.textLen === 0 && this.runs.length === 0) {
      this.reset()
      return null
    }
    const line = this.commitLine()
    // flush 是一次全新会话的边界: 样式游标一并复位
    this.fg = null
    this.bg = null
    this.fgTrue = null
    this.bgTrue = null
    this.flags = 0
    return line
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  /** 追加一段纯文本 (同时进入 raw / text 两个视图)。 */
  private pushPlain(seg: string): void {
    if (seg.length === 0) return
    this.raw.push(seg)
    const cleaned = seg.replace(CONTROL_RE, '')
    if (cleaned.length > 0) {
      this.text.push(cleaned)
      this.textLen += cleaned.length
    }
  }

  /** 用当前样式关闭"打开"的样式段 (默认样式段不记录)。 */
  private closeStyle(): void {
    const end = this.textLen
    if (this.runOpen && end > this.openStart) {
      const last = this.runs[this.runs.length - 1]
      if (
        last !== undefined
        && last.end === this.openStart
        && last.fg === this.fg
        && last.bg === this.bg
        && last.fgTrue?.[0] === this.fgTrue?.[0]
        && last.fgTrue?.[1] === this.fgTrue?.[1]
        && last.fgTrue?.[2] === this.fgTrue?.[2]
        && last.bgTrue?.[0] === this.bgTrue?.[0]
        && last.bgTrue?.[1] === this.bgTrue?.[1]
        && last.bgTrue?.[2] === this.bgTrue?.[2]
        && last.flags === this.flags
      ) {
        last.end = end
      } else {
        this.runs.push({
          start: this.openStart,
          end,
          fg: this.fg,
          bg: this.bg,
          fgTrue: this.fgTrue,
          bgTrue: this.bgTrue,
          flags: this.flags,
        })
      }
      this.runOpen = false
    }
  }

  /** 样式变化后重建"打开段"状态。 */
  private openStyle(): void {
    this.runOpen = hasStyle(this.fg, this.bg, this.fgTrue, this.bgTrue, this.flags)
    this.openStart = this.textLen
  }

  /** 应用一条 SGR 参数串 (无结尾 'm')。 */
  private applySgr(params: string): void {
    this.closeStyle()
    const fields = params.split(/[;:]+/)
    let i = 0
    while (i < fields.length) {
      const raw = fields[i] ?? ''
      if (raw === '') {
        i += 1
        continue
      }
      const n = Number.parseInt(raw, 10)
      if (Number.isNaN(n)) {
        i += 1
        continue
      }
      i += 1
      if (n === 0) {
        this.fg = null
        this.bg = null
        this.fgTrue = null
        this.bgTrue = null
        this.flags = 0
      } else if (n === 1) {
        this.flags |= StyleFlag.Bold
      } else if (n === 2) {
        this.flags |= StyleFlag.Dim
      } else if (n === 3) {
        this.flags |= StyleFlag.Italic
      } else if (n === 4 || n === 21) {
        this.flags |= StyleFlag.Underline
      } else if (n === 5 || n === 6) {
        this.flags |= StyleFlag.Blink
      } else if (n === 7) {
        this.flags |= StyleFlag.Reverse
      } else if (n === 9) {
        this.flags |= StyleFlag.Strike
      } else if (n === 22) {
        this.flags &= ~(StyleFlag.Bold | StyleFlag.Dim)
      } else if (n === 23) {
        this.flags &= ~StyleFlag.Italic
      } else if (n === 24) {
        this.flags &= ~StyleFlag.Underline
      } else if (n === 25) {
        this.flags &= ~StyleFlag.Blink
      } else if (n === 27) {
        this.flags &= ~StyleFlag.Reverse
      } else if (n === 29) {
        this.flags &= ~StyleFlag.Strike
      } else if (n >= 30 && n <= 37) {
        this.fg = n - 30
        this.fgTrue = null
      } else if (n >= 90 && n <= 97) {
        this.fg = n - 90 + 8
        this.fgTrue = null
      } else if (n === 39) {
        this.fg = null
        this.fgTrue = null
      } else if (n >= 40 && n <= 47) {
        this.bg = n - 40
        this.bgTrue = null
      } else if (n >= 100 && n <= 107) {
        this.bg = n - 100 + 8
        this.bgTrue = null
      } else if (n === 49) {
        this.bg = null
        this.bgTrue = null
      } else if (n === 38 || n === 48) {
        // fields[i] 此刻指向"模式" token (38 之后的下一个)。
        const mode = fields[i]
        if (mode === '5') {
          const c = toInt(fields[i + 1])
          i += 2
          if (c !== null) {
            if (n === 38) {
              this.fg = c
              this.fgTrue = null
            } else {
              this.bg = c
              this.bgTrue = null
            }
          }
        } else if (mode === '2') {
          const r = toInt(fields[i + 1])
          const g = toInt(fields[i + 2])
          const b = toInt(fields[i + 3])
          i += 4
          if (r !== null && g !== null && b !== null) {
            const rgb: [number, number, number] = [r, g, b]
            if (n === 38) {
              this.fgTrue = rgb
              this.fg = null
            } else {
              this.bgTrue = rgb
              this.bg = null
            }
          }
        }
      }
      // 其它参数 (字体 10-19 等) 忽略
    }
    this.openStyle()
  }

  /** 把当前积累的行提交为 ParsedLine, 复位行内缓冲。 */
  private commitLine(): ParsedLine {
    this.closeStyle()
    const text = this.text.join('')
    const raw = this.raw.join('')
    const style = this.runs
    const line: ParsedLine = {
      text,
      raw,
      style,
      time: Date.now(),
      isPrompt: isPromptText(text),
    }
    this.raw = []
    this.text = []
    this.textLen = 0
    this.runs = []
    this.runOpen = false
    this.openStart = 0
    this.state = State.Text
    this.csiBuf = ''
    this.oscBuf = ''
    // 样式游标跨行保持 (ANSI 语义): 若本行结束时仍是非默认样式, 下一行默认延续。
    this.openStyle()
    return line
  }
}
