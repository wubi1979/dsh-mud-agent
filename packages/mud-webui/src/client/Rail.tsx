/**
 * dsh-mud-webui — 右栏 (details rail), client half.
 *
 * details 单槽 (priority -100 遮蔽默认 DetailsPanel): 决策摘要 (上) +
 * 状态面板 (下)。决策与 world 状态来自 /mud/ws 推送通道的视图快照
 * (谁 + 为什么 + 做了什么), 与日志 tab 的流水分离。
 * @module @deepseek-ai/dsh-mud-webui/client/Rail
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MudClientInjected } from './MudSidebar.tsx'
import type { MudUiItem } from '@deepseek-ai/dsh-mud-core/src/client/wire.ts'
import { CaptchaDialog } from './MudDialogs.tsx'

const RAIL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minWidth: 0,
  padding: '14px 16px',
  gap: 16,
}

const TITLE_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 8,
  // 标题条: 淡灰底与下方数据行区分 (浅色主题下用实色 #f1f1f1)。
  background: '#f1f1f1',
  padding: '5px 8px',
  borderRadius: 4,
}

const DECISION_STYLE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'Consolas, monospace',
}

const STATUS_STYLE: React.CSSProperties = { fontSize: 13, color: '#ddd', lineHeight: 1.7 }

/** 决策行的标签与配色 (按 actor 区分)。 */
function actorOf(d: MudUiItem): { label: string; color: string } {
  switch (d.actor) {
    case 'rule': return { label: '规则', color: '#5c9cf5' }
    case 'agent': return { label: 'agent', color: '#7fd88f' }
    case 'flow': return { label: '流程', color: '#b78cf5' }
    default: return { label: '路由', color: '#d8a15a' }
  }
}

/** 语义事件 → 可读文案 (非流程决策行"原因"显示用; 未映射的原样显示)。 */
const EVENT_LABELS: Record<string, string> = {
  'init': '',
  'agent-mode': 'agent 模式',
}

/** 决策行: 流程 = [HH:mm:ss] (login): 消息; 其他 = [HH:mm:ss] [原因] → 动作 [结果]。 */
function decisionLine(d: MudUiItem): string {
  const when = new Date(d.time).toLocaleTimeString('zh-CN', { hour12: false })
  if (d.actor === 'flow') {
    // 流程统一消息式: (login): 由"xx"启动 / 收到xx → 发送xx / "成功|失败"结束流程
    return `${when} (${d.flow ?? 'login'}): ${d.text ?? d.action ?? ''}`
  }
  const why = d.actor === 'rule'
    ? (d.ruleId ?? '')
    : (EVENT_LABELS[d.eventType ?? ''] ?? d.eventType ?? '')
  const reason = why !== '' ? `[${why}]` : ''
  const action = d.action !== '' ? ` → ${d.action}` : ''
  const result = d.result !== undefined && d.result !== '' ? ` — ${d.result}` : ''
  return `${when} ${reason}${action}${result}`
}

/** 从 world 快照构建状态行。 */
function statusLinesOf(world: {
  room?: Record<string, unknown>
  flags?: Record<string, unknown>
  char?: Record<string, unknown>
} | null): string[] {
  if (!world) return []
  const lines: string[] = []
  if (world.room?.name) lines.push(`房间: ${String(world.room.name)}`)
  const exits = world.room?.exits
  if (Array.isArray(exits) && exits.length > 0) lines.push(`出口: ${exits.join(',')}`)
  const flags = world.flags ?? {}
  const f: string[] = []
  if (flags.logged_in) f.push('已登录')
  if (flags.awaiting) f.push('等待中')
  if (flags.in_combat) f.push('战斗中')
  if (flags.dead) f.push('已死亡')
  if (f.length > 0) lines.push(`状态: ${f.join(' ')}`)
  const char = world.char ?? {}
  if (char.hp !== undefined) {
    lines.push(`气血: ${String(char.hp)}${char.maxhp ? '/' + String(char.maxhp) : ''}`)
  }
  if (char.mp !== undefined) {
    lines.push(`内力: ${String(char.mp)}${char.maxmp ? '/' + String(char.maxmp) : ''}`)
  }
  return lines
}

/** 右栏: 决策摘要 (上) + 状态 (下)。挂载时 (会话打开) 确保 details 面板打开。
 *  同时承载 fullme 验证码对话框 (全局唯一, 由 /mud/ws captcha 帧驱动)。 */
export function Rail({ mudSocket, sendCommand, refreshCaptcha, onRailMounted }: PropsRuntime<'details'> & InjectFace<MudClientInjected> & { onRailMounted?: () => void }) {
  useEffect(() => { onRailMounted?.() }, [onRailMounted])
  const view = useSyncExternalStore(
    listener => mudSocket.subscribeView(listener),
    () => mudSocket.getView(),
  )
  const decisions = view.decisions
  // 只显示实质决策 (规则执行 / 流程激活 / agent 工具调用 / 引擎初始化);
  // 过滤高频感知路由噪音 (per 感知事件 → 规则/agent 的路由行)。
  // 注: agent 工具调用决策暂缺 (session tool/call 折叠已随通道迁移移除),
  // 交付三由 host 工具包装层补记。
  const meaningful = decisions.filter(d =>
    d.actor === 'rule' || d.actor === 'agent' || d.actor === 'flow'
    || (d.actor === 'router' && d.eventType === 'init'))
  const statusLines = statusLinesOf(view.world as Parameters<typeof statusLinesOf>[0])
  return (
    <div style={RAIL_STYLE}>
      {/* fullme 验证码对话框: 状态在 mudSocket captcha 存储, 替换语义全局唯一。 */}
      <CaptchaDialog mudSocket={mudSocket} sendCommand={sendCommand} refreshCaptcha={refreshCaptcha} />
      {/* 决策区: 与状态区各占右侧栏一半; 内容多时自身滚动, 面板高度不被撑高。 */}
      <div style={{ flex: '1 1 50%', minHeight: 0, overflowY: 'auto' }}>
        <div style={{ ...TITLE_STYLE, color: '#5c9cf5' }}>决策</div>
        {meaningful.length === 0
          ? <div style={{ color: '#666', fontSize: 12 }}>(等待决策…)</div>
          : meaningful.slice(-30).map((d, i) => {
            const actor = actorOf(d)
            return (
              <div key={i} style={{ ...DECISION_STYLE, color: actor.color }}>
                <span style={{ fontWeight: 600 }}>[{actor.label}]</span> {decisionLine(d)}
              </div>
            )
          })}
      </div>
      {/* 状态区: 与决策区各占一半; 独立滚动。 */}
      <div style={{ flex: '1 1 50%', minHeight: 0, overflowY: 'auto' }}>
        <div style={{ ...TITLE_STYLE, color: '#7fd88f' }}>状态</div>
        {statusLines.length === 0
          ? <div style={{ color: '#666', fontSize: 12 }}>(等待连接…)</div>
          : statusLines.map((l, i) => (
            <div key={i} style={STATUS_STYLE}>{l}</div>
          ))}
      </div>
    </div>
  )
}
