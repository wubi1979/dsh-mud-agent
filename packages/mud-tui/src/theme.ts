/**
 * dsh-mud-tui — ANSI 主题 (pi-tui 组件样式), host face.
 *
 * 色值对齐 opencode 暗色主题的灰阶:
 *   主背景 #141414 ≈ 256 色 234 · 面板 #1e1e1e ≈ 235 · 输入区 #0a0a0a ≈ 233。
 * @module @deepseek-ai/dsh-mud-tui/theme
 */

import type { MarkdownTheme } from '@earendil-works/pi-tui'

/** ANSI 前景/样式辅助 (SGR 包裹)。 */
export const fg = {
  red: (s: string): string => `\x1b[31m${s}\x1b[39m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string): string => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string): string => `\x1b[34m${s}\x1b[39m`,
  magenta: (s: string): string => `\x1b[35m${s}\x1b[39m`,
  cyan: (s: string): string => `\x1b[36m${s}\x1b[39m`,
}

export const style = {
  dim: (s: string): string => `\x1b[2m${s}\x1b[22m`,
  // 关闭用 22 (正常强度) 而非 21 — 部分终端把 21 解释为「双重下划线」,
  // 会把后续填充空格渲染成贯穿空白区的双横线。
  bold: (s: string): string => `\x1b[1m${s}\x1b[22m`,
  reverse: (s: string): string => `\x1b[7m${s}\x1b[27m`,
}

/** 右栏面板底色 (backgroundPanel #1e1e1e ≈ 256 色 234)。 */
export const panelBg = (s: string): string => `\x1b[48;5;234m${s}\x1b[49m`

/** 输入区底色 (backgroundElement #0a0a0a ≈ 256 色 233, 比主背景更深)。 */
export const inputBg = (s: string): string => `\x1b[48;5;233m${s}\x1b[49m`

/** 对话转录 Markdown 主题。 */
export function buildMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string): string => style.bold(fg.cyan(text)),
    link: (text: string): string => fg.blue(text),
    linkUrl: style.dim,
    code: (text: string): string => fg.yellow(text),
    codeBlock: (text: string): string => fg.yellow(text),
    codeBlockBorder: style.dim,
    quote: style.dim,
    quoteBorder: style.dim,
    hr: style.dim,
    listBullet: fg.cyan,
    bold: style.bold,
    italic: (text: string): string => `\x1b[3m${text}\x1b[23m`,
    strikethrough: (text: string): string => `\x1b[9m${text}\x1b[29m`,
    underline: (text: string): string => `\x1b[4m${text}\x1b[24m`,
  }
}
