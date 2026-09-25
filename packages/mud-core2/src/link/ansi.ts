/**
 * mud-core2 link/ansi — 流式 ANSI / 行解析器（存在层）。
 *
 * 沿用 mud-core 实录验证过的单遍状态机（对齐 Mudlet mIncompleteSequenceBytes
 * 的取舍）：把 telnet 解码后的文本流切成"完整逻辑行"，跨块的不完整 ESC 序列与
 * 未换行行尾缓存在解析器内部，下一块到达继续接续 —— 保证感知绝对行号稳定、
 * 判据匹配不被 TCP 块边界切碎。
 *
 * 每个产出行的视图（同一遍扫描得到，消费方按需取用）：
 *   - text   纯文本（无 ANSI，控制字符已剔除）—— 判据匹配、模型面
 *   - raw    原始文本（含 ANSI，不含行末换行符）—— 语料/回放
 *   - style  逐段样式 run（run-length，start/end 落在 text 坐标系）
 *
 * 样式游标跨行保持（符合 ANSI 语义）；行末未显式清零则延续到下一行。
 * abs 由解析器自分配（会话生命周期内单调；reset/flush 不复位 —— GA 空刷不得
 * 归零）。mud-core2 的 Mud 持有单一 parser 实例，重连不换实例：**abs 连续
 * 递增不归零**（行号空间是 Mud 生命周期的，跨重连不复用，避免行号碰撞）——
 * 重连只复位行缓冲与样式游标（见 mud.ts connect()）。
 *
 * 纯度纪律：本文件不 import 宿主（impl §2 纯度目录纪律）。
 */

/** 样式位标志（紧凑 bitmask，run-length 存储）。 */
export const enum StyleFlag {
  Bold = 1,
  Dim = 2,
  Italic = 4,
  Underline = 8,
  Blink = 16,
  Reverse = 32,
  Strike = 64,
}

/** 一段连续同样式文本（start/end 为 text 的下标，[start, end)）。 */
export interface StyleRun {
  start: number
  end: number
  /** 前景色：0-255 xterm 调色板索引；null = 默认。 */
  fg: number | null
  /** 背景色：0-255 xterm 调色板索引；null = 默认。 */
  bg: number | null
  /** 24-bit 真彩前景（优先级高于 fg）。 */
  fgTrue: [number, number, number] | null
  /** 24-bit 真彩背景（优先级高于 bg）。 */
  bgTrue: [number, number, number] | null
  /** StyleFlag 位掩码。 */
  flags: number
}

/** 完整逻辑行（全链路统一的数据形态）。 */
export interface MudLine {
  /** 纯文本（无 ANSI）：判据匹配、模型面。 */
  text: string
  /** 原始文本（含 ANSI，无行末换行）：语料/回放。 */
  raw: string
  /** 逐段样式 run；无颜色/样式时为空数组。 */
  style: StyleRun[]
  /** 绝对行号（单调递增，由 AnsiStreamParser 分配）。 */
  abs: number
  /** 该行收尾时间戳。 */
  time: number
  /** 是否为提示符行（启发式，无换行的行尾在 flush 时按此标记）。 */
  isPrompt: boolean
}

/** CSI/OSC/单字符转义序列剥离（供一次性整串场景，GMCP 载荷等）。 */
export const ANSI_STRIP_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** 从一段完整文本中剥离所有 ANSI 转义序列（非流式工具函数）。 */
export function stripAnsi(text: string): string {
  return String(text).replace(ANSI_STRIP_RE, '')
}

/** 文案中的控制字符（保留 \t; \n/\r 为行分隔符，不进 text）。 */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const ESC = '\u001b'

/**
 * 转义序列参数缓冲上限（对照 telnet 子协商上限 64KB）：超限字节进**丢弃态**
 * —— 不再进序列缓冲与行 raw，终止符判定不变（CSI 终字节 / OSC BEL|ESC）。
 * 内存有界；终止符到达后解析照常恢复。
 */
export const MAX_SEQUENCE_BUF = 64 * 1024

/** prompt 启发：默认裸 > / ＞ 行。 */
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

function hasStyle(
  fg: number | null,
  bg: number | null,
  fgTrue: [number, number, number] | null,
  bgTrue: [number, number, number] | null,
  flags: number,
): boolean {
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
 * write(chunk) 只返回"本块内已完结"的完整逻辑行；行尾/转义序列若被块截断，
 * 缓存在内部状态里，待下一块（或 flush）续接 —— 保证绝对行号稳定、判据不被
 * 切碎的块边界破坏。
 */
export class AnsiStreamParser {
  private state: State = State.Text
  // 当前行积累（数组 + 长度，避免逐字符字符串拼接）
  private raw: string[] = []
  private text: string[] = []
  private textLen = 0
  // 样式游标（跨行保持）
  private fg: number | null = null
  private bg: number | null = null
  private fgTrue: [number, number, number] | null = null
  private bgTrue: [number, number, number] | null = null
  private flags = 0
  // 当前打开的样式段（仅非默认样式才记录 run）
  private runOpen = false
  private openStart = 0
  private runs: StyleRun[] = []
  // 跨块残留的控制序列内容
  private csiBuf = ''
  private oscBuf = ''
  /**
   * 跨块终止符状态（S1/S2）。行缓冲与半截转义序列本来就跨块保留，终止符也必须：
   *   - `skipLF`: 本块刚用 `\r` 提交了行 ⇒ 紧随其后的 `\n` 是**同一个 CRLF** 的后半；
   *   - `absorbFlushTerminator`: 刚被 `flushLine()` 刷出的行**本来没有终止符**
   *     （服务器只是晚发了行尾）⇒ 紧随其后的整个终止符（`\n` / `\r` / `\r\n`）属于那一行。
   *
   * 单靠块内前瞻（`charAt(i+1)`）判断 `\r\n` 是错的：`\r` 正好落在块尾时前瞻看不到
   * 下一块的 `\n`，于是多提交一个空行 —— 该空行会拿到 abs、进 read 累积、
   * 推进判据计数。
   */
  private skipLF = false
  private absorbFlushTerminator = false
  // 绝对行号分配器（连接生命周期内单调递增；reset/flush 不复位）
  private absSeq = 0

  /** 是否还有未完结的行尾/半截序列（供行尾静默刷出定时器调度）。 */
  get pending(): boolean {
    return this.state !== State.Text || this.textLen > 0 || this.raw.length > 0
  }

  /** 复位解析状态（行缓冲/样式游标/半截控制序列；不动 absSeq）。 */
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
    this.skipLF = false
    this.absorbFlushTerminator = false
  }

  /** 写入一块解码后的文本，返回本块内完结的完整行（携带自分配递增 abs）。 */
  write(chunk: string): MudLine[] {
    if (chunk.length === 0) return []
    const out: MudLine[] = []
    let i = 0
    while (i < chunk.length) {
      if (this.state === State.Text) {
        // 跨块终止符吸收（S1/S2）：先看本块开头是否有"上一块欠下的"终止符后半。
        // 命中即整段吃掉并清位；遇到其它字符则清位后走常规路径 —— 因此真正的空白行
        // （上一行由终止符正常提交，标志未置位）不受影响。
        if (this.skipLF || this.absorbFlushTerminator) {
          const pending = chunk.charAt(i)
          if (pending === '\n') {
            this.skipLF = false
            this.absorbFlushTerminator = false
            i += 1
            continue
          }
          // flushLine 刷出的行：整个终止符（含 CRLF）都归它，不能再产出一个空行。
          const absorbCR = this.absorbFlushTerminator && pending === '\r'
          this.skipLF = false
          this.absorbFlushTerminator = false
          if (absorbCR) {
            i += chunk.charAt(i + 1) === '\n' ? 2 : 1
            continue
          }
          // `\r\r` 的另一半：skipLF 由下面的常规路径按"两次终止符"处理（产出一个空行）。
        }
        // 快路径：一次定位下一个特殊字符（ESC / 换行），整段复制。
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
        // \n / \r：行分隔符。CRLF **跨块**配对靠 skipLF 标志，不用块内前瞻。
        if (ch === '\r') this.skipLF = true
        i += 1
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
          // 单字符转义 / 其它：忽略内容
          this.raw.push(ch)
          this.state = State.Text
        }
        i += 1
        continue
      }
      if (this.state === State.Csi) {
        const ch = chunk.charAt(i)
        if (ch >= '\x40' && ch <= '\x7e') {
          this.raw.push(ch)
          if (ch === 'm') this.applySgr(this.csiBuf)
          this.state = State.Text
        } else if (this.csiBuf.length < MAX_SEQUENCE_BUF) {
          this.raw.push(ch)
          this.csiBuf += ch
        }
        // else: 超限丢弃态 — 字节不进缓冲与 raw（内存有界），等终字节恢复。
        i += 1
        continue
      }
      // Osc: 内容忽略，遇 BEL 或 ESC（ST 或新序列）终止；超限字节丢弃（内存有界）。
      const ch = chunk.charAt(i)
      if (ch === '\x07') {
        this.raw.push(ch)
        this.state = State.Text
      } else if (ch === ESC) {
        this.raw.push(ch)
        this.state = State.Esc
      } else if (this.oscBuf.length < MAX_SEQUENCE_BUF) {
        this.raw.push(ch)
        this.oscBuf += ch
      }
      i += 1
    }
    return out
  }

  /** 行尾刷出：只 commit 当前行，**保留样式游标** — GA/静默刷出是常规行边界，
   *  不是新会话，颜色应跨行延续。返回 null = 无可显示内容。 */
  flushLine(): MudLine | null {
    if (this.textLen === 0 && this.runs.length === 0) return null
    // S2: 刷出的行本来没有终止符 ⇒ 紧随其后的终止符属于它，不能再提交一个空行。
    // **空刷（上面 return null）不得置位** —— 此时并没有"欠着行尾"的行。
    this.absorbFlushTerminator = true
    return this.commitLine()
  }

  /** 复位样式游标 — 仅断线/重连等真正会话边界调用。 */
  resetStyles(): void {
    this.fg = null
    this.bg = null
    this.fgTrue = null
    this.bgTrue = null
    this.flags = 0
  }

  /** 流结束：强制把未换行的行尾刷出并复位样式（断线 close 等会话边界用；
   *  常规行边界请用 flushLine()）。 */
  flush(): MudLine | null {
    if (this.textLen === 0 && this.runs.length === 0) {
      this.reset()
      return null
    }
    const line = this.commitLine()
    this.resetStyles()
    return line
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  /** 追加一段纯文本（同时进入 raw / text 两个视图）。 */
  private pushPlain(seg: string): void {
    if (seg.length === 0) return
    this.raw.push(seg)
    const cleaned = seg.replace(CONTROL_RE, '')
    if (cleaned.length > 0) {
      this.text.push(cleaned)
      this.textLen += cleaned.length
    }
  }

  /** 用当前样式关闭"打开"的样式段（默认样式段不记录）。 */
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

  /** 应用一条 SGR 参数串（无结尾 'm'）。 */
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
        // fields[i] 此刻指向"模式" token（38 之后的下一个）。
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
      // 其它参数（字体 10-19 等）忽略
    }
    this.openStyle()
  }

  /** 把当前积累的行提交为 MudLine（携带本实例自分配递增 abs），复位行内缓冲。 */
  private commitLine(): MudLine {
    this.closeStyle()
    const text = this.text.join('')
    const raw = this.raw.join('')
    const style = this.runs
    const line: MudLine = {
      text,
      raw,
      style,
      abs: this.absSeq,
      time: Date.now(),
      isPrompt: isPromptText(text),
    }
    this.absSeq += 1
    this.raw = []
    this.text = []
    this.textLen = 0
    this.runs = []
    this.runOpen = false
    this.openStart = 0
    this.state = State.Text
    this.csiBuf = ''
    this.oscBuf = ''
    // 样式游标跨行保持（ANSI 语义）：若本行结束时仍是非默认样式，下一行默认延续。
    this.openStyle()
    return line
  }
}
