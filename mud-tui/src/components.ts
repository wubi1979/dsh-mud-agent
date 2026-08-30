/**
 * dsh-mud-tui — 自定义 pi-tui 组件 (Tab 栏 / 决策面板 / 世界面板 / 输入区 / 状态栏), host face.
 *
 * 右栏面板视觉 (对齐 opencode): 决策轨迹 / 世界状态 / 版本标识统一使用
 * panelLine() 渲染 — 行补齐到目标宽度后套面板底色, 形成整块面板。
 * TailPanel 是自带滚动布局节点的尾随缓冲: 无论内容多少都填满分配的
 * 全部高度 (pi-tui 原生 ScrollView 对短内容不填充剩余空间)。
 * @module @deepseek-ai/dsh-mud-tui/components
 */

import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js'
import {
  Input, truncateToWidth, visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { MudConnectionStatus, MudWorldSnapshot } from '@deepseek-ai/dsh-mud-core'
import { fg, inputBg, panelBg, style } from './theme.ts'

// ── 面板视觉辅助 ────────────────────────────────────────────

/** 按可见宽度把行截断/右补空格到目标宽度 (ANSI 感知)。 */
export function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line)
  return w >= width ? truncateToWidth(line, width) : line + ' '.repeat(width - w)
}

/** 面板行: 补齐宽度后套底色 (opencode 风格右栏)。 */
export function panelLine(line: string, width: number): string {
  return panelBg(padToWidth(line, width))
}

/**
 * 右栏决策轨迹面板: 自实现 scroll 布局节点 (跟随尾部, 不支持手动回滚 —
 * 决策流是状态流, 最新在下)。与原生 ScrollView 不同, 渲染时把可见窗口
 * 用面板底色填满, 短内容也覆盖整块分配高度。
 *
 * 结构对齐原生 ScrollView: 布局节点 component 必须是「纯内容」子组件
 * (指向自身会无限递归), TailPanel 自身持有滚动状态。
 */
export class TailPanel implements Component {
  private lines: string[] = []
  private _viewportHeight = 0

  // 纯内容面: 渲染可见窗口 (贴底), 空行也套面板底色填满。
  // 箭头函数捕获实例 this, 布局节点把它作为纯内容子组件引用。
  private readonly content: Component = {
    render: (width: number): string[] => {
      const vh = Math.max(1, this._viewportHeight)
      const visible = this.lines.slice(-vh).map(line => panelLine(line, width))
      while (visible.length < vh) visible.unshift(panelLine('', width))
      return visible
    },
    invalidate: (): void => {},
  }

  constructor(private readonly maxLines = 300) {}

  /** 追加单行 (决策/日志等结构化条目)。 */
  addLine(line: string): void {
    this.lines.push(...line.replace(/\r/g, '').split('\n'))
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines)
    }
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

  [LAYOUT_NODE](): { type: 'scroll'; component: Component; state: TailPanel } {
    return { type: 'scroll', component: this.content, state: this }
  }
}

/** 主区 Tab 栏 (F1 游戏 / F2 对话) + 贯穿左栏的横线。 */
export class TabBar implements Component {
  private active = 0

  constructor(private readonly tabs: readonly string[]) {}

  setActive(index: number): void {
    if (index >= 0 && index < this.tabs.length) this.active = index
  }

  get activeIndex(): number {
    return this.active
  }

  render(width: number): string[] {
    const items = this.tabs.map((tab, i) => i === this.active
      ? style.reverse(` F${i + 1} ${tab} `)
      : style.dim(` F${i + 1} ${tab} `))
    return [
      truncateToWidth(items.join(''), width),
      style.dim('─'.repeat(Math.max(0, width))),
    ]
  }

  invalidate(): void {}
}

/** 右栏世界状态面板 (世界快照 + 连接状态摘要)。 */
export class WorldPanel implements Component {
  private world: MudWorldSnapshot | null = null
  private status: MudConnectionStatus | null = null

  update(world: MudWorldSnapshot, status: MudConnectionStatus): void {
    this.world = world
    this.status = status
  }

  render(width: number): string[] {
    const out: string[] = [style.bold(fg.cyan('世界状态'))]
    const statusLine = this.status
    if (statusLine !== null) {
      const link = statusLine.connected
        ? fg.green(`✓ ${statusLine.host}:${statusLine.port}`)
        : fg.red(`✗ ${statusLine.state}`)
      out.push(`连接 ${link}`)
    }
    const world = this.world
    if (world === null || countEntries(world) === 0) {
      out.push(style.dim('等待 GMCP 数据…'))
      return out.map(line => panelLine(line, width))
    }
    for (const [label, section] of [['角色', world.char], ['房间', world.room], ['战斗', world.combat]] as const) {
      const entries = Object.entries(section)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .slice(0, 4)
      if (entries.length === 0) continue
      out.push(style.dim(label))
      for (const [key, value] of entries) {
        out.push(`${fg.cyan(key)} ${renderValue(value)}`)
      }
    }
    return out.map(line => panelLine(line, width))
  }

  invalidate(): void {}
}

/** 左栏底部系统状态栏 (单行)。 */
export class StatusBar implements Component {
  private status: MudConnectionStatus | null = null

  constructor(private readonly hint: string) {}

  update(status: MudConnectionStatus): void {
    this.status = status
  }

  render(width: number): string[] {
    const s = this.status
    const mode = s?.agentEnabled === true ? fg.green('AUTO') : style.dim('MANUAL')
    const session = s?.sessionId ?? '-'
    const left = ` ${mode} ${style.dim(session)}`
    const right = style.dim(` ${this.hint} `)
    const leftW = visibleWidth(left)
    const rightW = visibleWidth(right)
    const padWidth = Math.max(1, width - leftW - rightW)
    return [truncateToWidth(left + ' '.repeat(padWidth) + right, width)]
  }

  invalidate(): void {}
}

/** 面板单行文本组件 (右栏版本标识)。 */
export class PanelText implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [panelLine(this.text, width)]
  }

  invalidate(): void {}
}

/**
 * 输入区面板 (对齐 opencode composer): 左侧竖线边框 + 更深底色 + 上下留白。
 * 包裹 pi-tui Input (单行输入, 光标/撤销/粘贴内建)。
 */
export class InputPanel implements Component {
  constructor(private readonly input: Input) {}

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const bar = fg.cyan('│')
    const blank = inputBg(' '.repeat(width - 1))
    const rows = this.input.render(innerWidth)
      .map(line => bar + inputBg(padToWidth(`  ${line}`, width - 1)))
    return [bar + blank, ...rows, bar + blank]
  }

  invalidate(): void {
    this.input.invalidate()
  }
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function countEntries(snapshot: MudWorldSnapshot): number {
  const sections: readonly Record<string, unknown>[] =
    [snapshot.char, snapshot.room, snapshot.combat, snapshot.flags]
  return sections.reduce((sum, section) => sum + Object.keys(section).length, 0)
}
