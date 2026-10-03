/**
 * dsh-mud-webui — 世界状态 HUD 表格（T11 状态呈现，v0.0.25 表格式重设计）。
 *
 * 两列表格（键 | 值）：首行固定为登录轴（`已登录` 标签），其后按 world 写入序逐行
 * 排 GMCP 条目（值等宽字体、超宽截断、悬浮看全值 + 来源/置信度/时刻）。数据面 =
 * 服务端 `StatusRow` 窄面（§9.5），由调用方经 `useServers` selector 取本会话行传入。
 *
 * 消费方：MUD 日志视图（聊天区上部 20% 常驻）与画面 tab（工具栏下）。
 * @module @deepseek-ai/dsh-mud-webui/client/MudHudTable
 */

import type { ReactNode } from 'react'
import type { MudWorldEntry } from './mud-remote.ts'

/** 表格 props：会话状态窄面行（缺行 = 会话未登记，渲染空态）。 */
export interface MudHudTableProps {
  readonly row: { loggedIn: 'unknown' | 'inferred' | 'in-game'; world: readonly MudWorldEntry[] } | undefined
  /** 空态文案（缺省「暂无状态」）。 */
  readonly emptyText?: string
}

const TABLE_STYLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse' as const,
  tableLayout: 'fixed' as const,
  fontSize: 12,
  fontFamily: 'Consolas, "Cascadia Mono", monospace',
  lineHeight: '20px',
}

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left' as const,
  padding: '2px 12px',
  color: '#8a8a8a',
  fontWeight: 500,
  borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
}

const TD_STYLE: React.CSSProperties = {
  textAlign: 'left' as const,
  padding: '2px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const LOGIN_TAG_OK: React.CSSProperties = {
  display: 'inline-block',
  padding: '0 8px',
  borderRadius: 4,
  fontSize: 11,
  lineHeight: '18px',
  color: '#5fbf77',
  border: '1px solid color-mix(in srgb, #5fbf77 40%, transparent)',
}

/** 推断态（inferred = 行文声明判据先行，GMCP 未到）：琥珀色区分权威绿。 */
const LOGIN_TAG_INFERRED: React.CSSProperties = {
  ...LOGIN_TAG_OK,
  color: '#d9a24a',
  border: '1px solid color-mix(in srgb, #d9a24a 40%, transparent)',
}

const LOGIN_TAG_OFF: React.CSSProperties = {
  ...LOGIN_TAG_OK,
  color: '#8a8a8a',
  border: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
}

/** 世界状态 HUD 表：登录轴一行 + GMCP 条目逐行。 */
export function MudHudTable({ row, emptyText = '暂无状态' }: MudHudTableProps): ReactNode {
  const entries = row?.world ?? []
  return (
    <table style={TABLE_STYLE}>
      <colgroup><col style={{ width: '30%' }} /><col /></colgroup>
      <thead>
        <tr><th style={TH_STYLE}>键</th><th style={TH_STYLE}>值（悬浮看全值与来源）</th></tr>
      </thead>
      <tbody>
        <tr>
          <td style={TD_STYLE}>登录</td>
          <td style={TD_STYLE}>
            {row?.loggedIn === 'in-game'
              ? <span style={LOGIN_TAG_OK}>已登录</span>
              : row?.loggedIn === 'inferred'
                ? <span style={LOGIN_TAG_INFERRED}>已登录（推断）</span>
                : <span style={LOGIN_TAG_OFF}>未登录</span>}
          </td>
        </tr>
        {entries.length === 0
          ? <tr><td style={{ ...TD_STYLE, color: '#8a8a8a' }} colSpan={2}>{emptyText}</td></tr>
          : entries.map(e => (
            <tr key={`${e.zone}#${e.key}`}
              title={`${e.zone}/${e.key} · ${e.c} · ${e.sk}\n${e.v}`}>
              <td style={TD_STYLE}>{e.key}</td>
              <td style={TD_STYLE}>{e.v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  )
}
