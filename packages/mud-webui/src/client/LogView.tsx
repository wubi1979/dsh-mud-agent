/**
 * dsh-mud-webui — log window (client half).
 *
 * Registered as the `conversation.view` entry `mud-log`: rendered by the
 * native session body whenever the user's session is current and the 日志
 * tab is active. Shows only the log stream (system/connection/injection
 * lines) from the /mud/ws push channel; decisions are rendered exclusively
 * by the details rail.
 * @module @deepseek-ai/dsh-mud-webui/client/LogView
 */

import { useSyncExternalStore } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MudClientInjected } from './MudSidebar.tsx'

const LOG_STYLE: React.CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  padding: '12px 16px',
  fontFamily: 'Consolas, monospace',
  fontSize: 12,
  color: '#9a9a9a',
  lineHeight: 1.7,
}

const ROW_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-all' }

/** Log view props: the conversation-view runtime kit + injected MUD face. */
export type LogViewProps =
  PropsRuntime<'conversation.view'>
  & InjectFace<MudClientInjected>

/** Render the full run stream: logs only (decisions live in the details rail). */
export function LogView({ mudSocket }: LogViewProps) {
  const logs = useSyncExternalStore(
    listener => mudSocket.subscribeView(listener),
    () => mudSocket.getView().logs,
  )
  return (
    <div style={LOG_STYLE} data-mud-no-width="">
      {logs.length === 0
        ? <div style={{ color: '#666' }}>(等待日志…)</div>
        : logs.map(l => (
          <div key={l.seq} style={ROW_STYLE}>{l.text}</div>
        ))}
    </div>
  )
}
