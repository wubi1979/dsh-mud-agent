/**
 * dsh-mud-tui — 游戏画面真终端视图 (基于 @xterm/headless), host face.
 *
 * 原始游戏文本直接喂给 headless VT 解析器: 转义序列切分、OSC 8 超链接、
 * 光标控制等全部由标准模拟器语义处理, 不再自定义清洗。渲染时把解析器的
 * 字符网格序列化成带 SGR 的行交给 pi-tui 画 (跟随尾部的整块滚动区)。
 * @module @deepseek-ai/dsh-mud-tui/xterm-view
 */

import { createRequire } from 'node:module'
import type { IBufferCell, IBufferLine, Terminal as XtermTerminal } from '@xterm/headless'
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js'
import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth } from '@earendil-works/pi-tui'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')

/** 单元格属性 → SGR 序列 (与上次不同才输出)。 */
function cellSgr(cell: IBufferCell): string {
  const codes: string[] = []
  if (cell.isBold()) codes.push('1')
  if (cell.isDim()) codes.push('2')
  if (cell.isUnderline()) codes.push('4')
  if (cell.isInverse()) codes.push('7')
  if (cell.isFgRGB()) {
    const c = cell.getFgColor()
    codes.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`)
  } else if (cell.isFgPalette()) {
    const c = cell.getFgColor()
    codes.push(c < 8 ? `3${c}` : c < 16 ? `9${c - 8}` : `38;5;${c}`)
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor()
    codes.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c &255}`)
  } else if (cell.isBgPalette()) {
    const c = cell.getBgColor()
    codes.push(c < 8 ? `4${c}` : c < 16 ? `10${c - 8}` : `48;5;${c}`)
  }
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`
}

/** 把缓冲区一行序列化成带颜色的字符串 (行尾复位, 避免样式泄漏到填充区)。 */
function serializeLine(line: IBufferLine, width: number): string {
  let out = ''
  let current = ''
  let reuse: IBufferCell | undefined
  for (let x = 0; x < width; x++) {
    const cell = line.getCell(x, reuse)
    if (cell === undefined) break
    reuse = cell
    if (cell.getWidth() === 0) continue // 宽字符续体单元
    const sgr = cellSgr(cell)
    if (sgr !== current) {
      out += sgr
      current = sgr
    }
    const chars = cell.getChars()
    out += chars === '' ? ' ' : chars
  }
  return `${out}\x1b[0m`
}

/**
 * 游戏画面视图: VT 解析 + 尾随窗口渲染。实现 pi-tui 的 scroll 布局节点,
 * 无论内容多少都填满分配高度; 结构对齐原生 ScrollView
 * (布局节点的 component 必须是纯内容子组件, 指向自身会无限递归)。
 */
export class XtermView implements Component {
  private readonly term: XtermTerminal
  private _viewportHeight = 0

  // 纯内容面: 从字符网格序列化可见窗口。
  private readonly content: Component = {
    render: (width: number): string[] => this.renderWindow(width),
    invalidate: (): void => {},
  }

  constructor(cols = 100, scrollback = 2000) {
    this.term = new Terminal({ cols, rows: 24, scrollback })
  }

  /** 喂入一段原始游戏输出 (转义序列可跨调用分段, 解析器自行缓冲)。 */
  write(data: string): void {
    this.term.write(data)
  }

  private ensureSize(width: number): void {
    const cols = Math.min(300, Math.max(20, width))
    const rows = Math.max(24, this._viewportHeight)
    if (this.term.cols !== cols || this.term.rows !== rows) {
      this.term.resize(cols, rows)
    }
  }

  /** 序列化缓冲区尾部 viewportHeight 行 (跟随最新输出)。 */
  private renderWindow(width: number): string[] {
    this.ensureSize(width)
    const vh = Math.max(1, this._viewportHeight)
    const buffer = this.term.buffer.active
    const top = Math.max(0, buffer.length - vh)
    const out: string[] = []
    for (let y = top; y < top + vh; y++) {
      const line = buffer.getLine(y)
      const text = line === undefined ? '' : truncateToWidth(serializeLine(line, width), width)
      out.push(text)
    }
    return out
  }

  render(width: number): string[] {
    return this.content.render(width)
  }

  invalidate(): void {}

  // ── ScrollLayoutState (@earendil-works/pi-tui 内部契约) ──
  getContentWidth(width: number): number {
    return width
  }

  get scrollTop(): number {
    return 0
  }

  get viewportHeight(): number {
    return this._viewportHeight
  }

  readonly primary = false
  readonly overscroll = 'contain' as const

  updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    void contentHeight
    if (this._viewportHeight !== viewportHeight) {
      this._viewportHeight = viewportHeight
      requestRender()
    }
  }

  [LAYOUT_NODE](): { type: 'scroll'; component: Component; state: XtermView } {
    return { type: 'scroll', component: this.content, state: this }
  }
}
