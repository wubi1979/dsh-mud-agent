/**
 * dsh-mud-webui — log window (client half).
 *
 * Registered as the `conversation.view` entry `mud-log`: rendered by the
 * native session body whenever the user's session is current and the 日志
 * tab is active. Shows the **full run stream** — runtime logs (system/
 * connection/perception/send/network) plus decisions (rule hits/router
 * classification/agent actions), merged on the shared ws ui seq timeline.
 * Level/channel drive badge colors so the failure layer is visible at a
 * glance (e.g. login stuck: watch `[感知] feedParsed`, `[路由] feed-classify`,
 * `[t1] 命中`, `[发送]`).
 * @module @deepseek-ai/dsh-mud-webui/client/LogView
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MudClientInjected } from './MudSidebar.tsx'
import type { MudUiItem } from '@deepseek-ai/dsh-mud-core/client-wire'

const LOG_STYLE: React.CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  padding: '12px 16px',
  fontFamily: 'Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.7,
}

const ROW_STYLE: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-all' }

const LEVEL_TEXT: Record<string, string> = {
  debug: '#5a5a5a',
  info: '#9a9a9a',
  warn: '#e6b450',
  error: '#e5484d',
}
const DECISION_TEXT = '#4cc2ff' // 决策/路由蓝
const CHANNEL_TEXT: Record<string, string> = {
  network: '#8ab4f8',
  perception: '#9adbc0',
  send: '#f5c2e7',
  runtime: '#c9c9c9',
  decision: DECISION_TEXT,
}

/** 通道徽标 (短名; 无徽标用首字符)。 */
function channelTag(item: MudUiItem): string {
  if (item.channel !== undefined) return item.channel.slice(0, 4)
  if (item.kind === 'decision' && item.actor !== undefined) return item.actor.slice(0, 4)
  return item.kind.slice(0, 4)
}

/** 行前景色: 决策蓝 > 级别色 > 通道色。 */
function rowColor(item: MudUiItem): string {
  if (item.kind === 'decision') return DECISION_TEXT
  if (item.level !== undefined && LEVEL_TEXT[item.level] !== undefined) return LEVEL_TEXT[item.level] ?? '#9a9a9a'
  if (item.channel !== undefined && CHANNEL_TEXT[item.channel] !== undefined) return CHANNEL_TEXT[item.channel] ?? '#9a9a9a'
  return '#9a9a9a'
}

/** 时间戳 (HH:mm:ss)。 */
function stampOf(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Log view props: the conversation-view runtime kit + injected MUD face. */
export type LogViewProps =
  PropsRuntime<'conversation.view'>
  & InjectFace<MudClientInjected>

/**
 * Render the full run stream: restored history + runtime logs + decisions,
 * merged on the logSeq timeline (logService.seq = global identity key).
 *
 * On mount, POST /mud/logs to fetch today's history (JSONL). Restored entries
 * share logSeq with live items → dedup by logSeq, no duplicates.
 * Next-day entries are NOT restored (readDayEntries only reads today's file).
 */
export function LogView({ sessionId, mudSocket }: LogViewProps) {
  const view = useSyncExternalStore(
    listener => mudSocket.subscribeView(listener),
    () => mudSocket.getView(),
  )
  // 当日恢复历史 (挂载时拉取; entries 带 logSeq = logService.seq)。
  const [restored, setRestored] = useState<readonly MudUiItem[]>([])

  // 挂载时拉当日会话日志 (POST /mud/logs; sessionId 来自 PropsRuntime)。
  useEffect(() => {
    if (sessionId === undefined) return
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (sid === '') return
    fetch('/mud/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
      .then(r => r.json())
      .then((data: { ok?: boolean; entries?: Array<{
        seq: number; level?: string; channel?: string;
        text: string; time: number; actor?: string;
        ruleId?: string; eventType?: string; flow?: string;
        action?: string; result?: string;
      }> }) => {
        if (data.ok && Array.isArray(data.entries)) {
          // 恢复条目转 MudUiItem (channel='decision' → kind='decision', 其余 → kind='log')。
          const items: MudUiItem[] = data.entries.map(e => {
            const isDecision = e.channel === 'decision'
            const item: MudUiItem = {
              seq: -1, // 恢复条目无 ui seq; 前端按 logSeq 排序/去重
              kind: isDecision ? 'decision' : 'log',
              text: e.text,
              time: e.time,
              logSeq: e.seq,
            }
            if (e.level !== undefined) item.level = e.level as MudUiItem['level'] & {}
            if (e.channel !== undefined) item.channel = e.channel as MudUiItem['channel'] & {}
            if (e.actor !== undefined) item.actor = e.actor as MudUiItem['actor'] & {}
            if (e.ruleId !== undefined) item.ruleId = e.ruleId
            if (e.eventType !== undefined) item.eventType = e.eventType
            if (e.flow !== undefined) item.flow = e.flow
            if (e.action !== undefined) item.action = e.action
            if (e.result !== undefined) item.result = e.result
            return item
          })
          setRestored(items)
        }
      })
      .catch(() => { /* 恢复失败不阻塞实时流 */ })
  }, [sessionId])

  // 合并: 恢复历史 + 实时日志 + 实时决策, 按 logSeq 去重归并排序。
  const items = useMemoMergedTimeline(restored, view.logs, view.decisions)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 新条目到达自动滚到底部 (关注最新故障现场)。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length])

  return (
    <div ref={scrollRef} style={LOG_STYLE} data-mud-no-width="">
      {items.length === 0
        ? <div style={{ color: '#666' }}>(等待日志…)</div>
        : items.map(item => {
          const color = rowColor(item)
          // 恢复条目无 ui seq, 用 logSeq 作 React key (logSeq 在当前会话唯一)。
          const key = item.logSeq ?? item.seq
          return (
            <div key={key} style={{ ...ROW_STYLE, color }}>
              <span style={{ color: '#666', marginRight: 6 }}>{stampOf(item.time)}</span>
              <span style={{
                display: 'inline-block',
                minWidth: 46,
                marginRight: 6,
                color: color,
                opacity: 0.75,
                fontSize: 10,
              }}>
                {channelTag(item)}
              </span>
              {item.kind === 'decision' && item.actor !== undefined
                ? <span style={{ color: DECISION_TEXT, marginRight: 6 }}>[决策:{item.actor}]</span>
                : null}
              {item.text}
            </div>
          )
        })}
    </div>
  )
}

/**
 * 三源归并: 恢复历史(无 ui seq, 有 logSeq) + 实时日志 + 实时决策。
 * 去重键 = logSeq (logService.seq, 文件与 ws 帧共用)。
 * 恢复条目与实时帧可能重叠 (同 logSeq) → 只保留一条 (实时帧优先)。
 */
function useMemoMergedTimeline(
  restored: readonly MudUiItem[],
  logs: readonly MudUiItem[],
  decisions: readonly MudUiItem[],
): readonly MudUiItem[] {
  const cache = useRef<{
    restored: readonly MudUiItem[]
    logs: readonly MudUiItem[]
    decisions: readonly MudUiItem[]
    out: readonly MudUiItem[]
  }>({ restored: [], logs: [], decisions: [], out: [] })
  const c = cache.current
  if (c.restored !== restored || c.logs !== logs || c.decisions !== decisions) {
    // 1. 合并 logs + decisions (实时流, 按 logSeq 排序)。
    const live: MudUiItem[] = new Array(logs.length + decisions.length)
    let i = 0, j = 0, k = 0
    while (i < logs.length && j < decisions.length) {
      const aSeq = logs[i]?.logSeq ?? logs[i]?.seq ?? 0
      const bSeq = decisions[j]?.logSeq ?? decisions[j]?.seq ?? 0
      live[k] = aSeq <= bSeq ? logs[i++]! : decisions[j++]!
      k += 1
    }
    while (i < logs.length) { live[k++] = logs[i++]! }
    while (j < decisions.length) { live[k++] = decisions[j++]! }

    // 2. 去重: 恢复条目与实时帧按 logSeq 去重 (实时帧优先)。
    const seen = new Set<number | undefined>()
    const out: MudUiItem[] = []
    // 先推恢复条目 (无 logSeq 或 logSeq 不与实时重叠的)。
    for (const r of restored) {
      const rk = r.logSeq
      if (rk !== undefined) seen.add(rk)
      // 先推恢复; 后面实时帧会覆盖
      out.push(r)
    }
    // 再推实时帧 (logSeq 与恢复重叠 → 覆盖恢复条目, 保持最新状态)。
    for (const l of live) {
      const lk = l.logSeq
      if (lk !== undefined && seen.has(lk)) {
        // 实时帧与恢复重叠: 替换恢复条目 (保持顺序, 用实时帧的状态)。
        const idx = out.findIndex(o => o.logSeq === lk)
        if (idx >= 0) { out[idx] = l; continue }
      }
      out.push(l)
      if (lk !== undefined) seen.add(lk)
    }

    // 3. 按 logSeq 升序排序 (恢复条目的 logSeq 在实时帧之前)。
    out.sort((a, b) => {
      const aKey = a.logSeq ?? (a.seq > 0 ? a.seq : 0)
      const bKey = b.logSeq ?? (b.seq > 0 ? b.seq : 0)
      return aKey - bKey
    })

    cache.current = { restored, logs, decisions, out }
  }
  return c.out
}