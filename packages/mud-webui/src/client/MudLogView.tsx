/**
 * dsh-mud-webui — MUD 日志视图（`conversation.view` 条目 `mud-log`）。
 *
 * 会话被选中且切到「MUD 日志」tab 时渲染：展示宿主 `remote.mud.logs` 的内存环条目
 * （运行/网络/投递/闸门事件）——**连接失败的原因就在这些条目里**；同时给出落盘目录
 * （原始行流只落盘，从该目录读 JSONL）。
 *
 * 数据只经 inject 面的 `hooks.mudLog`（绑成 `useMudLog`）与 `watchLog`/`refreshLog`
 * 回调到达，组件自身不订阅任何东西。
 * @module @deepseek-ai/dsh-mud-webui/client/MudLogView
 */

import { useEffect, useRef } from 'react'
// Type-only: pulls the conversation.view SlotMap augmentation into the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MudHudTable } from './MudHudTable.tsx'
import type { MudClientInjected } from './MudSidebar.tsx'

const SHELL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontSize: 12,
  fontFamily: 'Consolas, "Cascadia Mono", monospace',
}

const BAR_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
  flex: '0 0 auto',
}

const LIST_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  padding: '8px 12px',
  lineHeight: 1.7,
}

const ROW_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
const MUTED_STYLE: React.CSSProperties = { color: '#8a8a8a' }
/** HUD 区（T11）：视图上部 20% 常驻世界状态表；条目超出自身滚动，日志不受挤压。 */
const HUD_STYLE: React.CSSProperties = {
  flex: '0 0 20%',
  minHeight: 0,
  overflowY: 'auto',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
}
const ERROR_STYLE: React.CSSProperties = {
  padding: '6px 12px',
  color: '#e5484d',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #2a2a2a)',
  flex: '0 0 auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

const LEVEL_COLOR: Readonly<Record<string, string>> = {
  debug: '#6f6f6f', info: '#a8a8a8', warn: '#e6b450', error: '#e5484d',
}
const CHANNEL_COLOR: Readonly<Record<string, string>> = {
  runtime: '#c9c9c9', network: '#8ab4f8', stream: '#6f6f6f', deliver: '#9adbc0', gate: '#f5c2e7',
}

/** 时间戳 (HH:mm:ss)。 */
function stamp(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Log view props: conversation-view runtime kit + injected MUD face. */
export type MudLogViewProps =
  PropsRuntime<'conversation.view'>
  & InjectFace<MudClientInjected>

/**
 * Render the session's MUD log ring and its file target.
 * @param props - Conversation-view kit (sessionId) and the injected MUD face.
 * @returns the log panel, or an empty-state line when the session has no log yet.
 */
export function MudLogView({ sessionId, useServers, useMudLog, watchLog, refreshLog }: MudLogViewProps) {
  const sid = sessionId === undefined ? '' : String(sessionId)
  const log = useMudLog(snapshot => snapshot)
  // T11 状态呈现：本会话状态窄面行（watchStatus 推帧驱动）→ 上部 20% HUD 表
  const statusRow = useServers(s => s.sessionStatus[sid])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 只有当前跟随的会话的快照才属于本视图（切换目标时旧快照立即丢弃）。
  const entries = log.sessionId === sid ? log.entries : []

  useEffect(() => {
    watchLog(sid === '' ? null : sid)
    return () => { watchLog(null) }
  }, [sid, watchLog])

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div style={SHELL_STYLE}>
      <div style={HUD_STYLE}>
        <MudHudTable row={statusRow} emptyText="暂无状态：连接并登录后显示世界快照。" />
      </div>
      <div style={BAR_STYLE}>
        <span style={MUTED_STYLE}>
          MUD 日志（{entries.length} 条；原始行流只落盘）
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <span style={MUTED_STYLE}>{log.fileTarget ?? '未配置落盘'}</span>
        <button type="button" onClick={() => { refreshLog() }}>刷新</button>
      </div>
      {log.sessionId === sid && log.error !== null && (
        <div style={ERROR_STYLE} role="alert">日志拉取失败：{log.error}</div>
      )}
      <div style={LIST_STYLE} ref={scrollRef}>
        {entries.length === 0
          ? <div style={MUTED_STYLE}>暂无日志：连接后宿主会写入运行/网络/投递事件。</div>
          : entries.map(entry => (
            <div key={entry.seq} style={ROW_STYLE}>
              <span style={MUTED_STYLE}>{stamp(entry.time)} </span>
              <span style={{ color: CHANNEL_COLOR[entry.channel] ?? '#a8a8a8' }}>[{entry.channel}] </span>
              <span style={{ color: LEVEL_COLOR[entry.level] ?? '#a8a8a8' }}>{entry.text}</span>
            </div>
          ))}
      </div>
    </div>
  )
}
