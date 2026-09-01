/**
 * dsh-mud-webui — game window (xterm), client half.
 *
 * Registered as the `conversation.view` entry `mud-game`: rendered by the
 * native session body whenever the user's session is current and the 游戏
 * tab is active.
 *
 * 终端数据来自 host 的 /mud/ws WebSocket 推送通道 — 游戏输出只存在于
 * host 进程级内存缓冲, 不进 session 事件流 (避免会话膨胀)。
 * 终端生命周期 = host 进程: 挂载时回放控制器保留的近期输出 (重挂载不丢),
 * 之后订阅增量帧; 断开重连由控制器自动回填。xterm 实例在组件挂载时创建、
 * 切 tab 时销毁重建 (回放补齐)。连接/断开按钮在未连接/已连接状态下切换,
 * 游戏页面驱动连接。
 * @module @deepseek-ai/dsh-mud-webui/client/GameView
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MudClientInjected } from './MudSidebar.tsx'
import css from './MudGameView.module.css'

/**
 * 把一批游戏输出写入 xterm: 按 seq 去重续写, 原始文本 (含 ANSI) 不加工。
 * @returns 本批实际推进到的最新 seq。
 */
function writeGameBatch(term: Terminal, items: readonly { seq: number; text: string }[], lastSeq: number): number {
  let last = lastSeq
  for (const g of items) {
    if (g.seq <= last) continue
    last = g.seq
    const text = g.text
    if (text !== '') term.write(text.endsWith('\n') ? text : text + '\r\n')
  }
  return last
}

/** Game window props: conversation-view runtime kit + injected MUD face. */
export type GameViewProps =
  PropsRuntime<'conversation.view'>
  & InjectFace<MudClientInjected>

/**
 * Render the game window: connection control while idle, the xterm surface
 * once connected.
 * @param props - runtime kit + injected hooks/actions.
 * @returns the game surface or the disconnected placeholder.
 */
export function GameView({
  sessionId,
  useServers,
  connectUser,
  disconnect,
  mudSocket,
}: GameViewProps) {
  const { servers, conn } = useServers(s => s)
  const connected = conn.state === 'connected'
  const connecting = conn.state === 'connecting'
  const [connectingLocal, setConnectingLocal] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // 已写入终端的最新 seq (跨挂载保留: 断开重连续拉不重复)。
  const lastSeqRef = useRef(0)

  // 连接目标: 优先取"本会话已绑定的用户" (用户=会话, 当前 tab 即该用户的会话),
  // 兜底取最近一次连接/选中记录。会话绑定优先 → 无需在左侧重复"选择用户"。
  const target = (() => {
    if (sessionId !== undefined) {
      for (const server of servers) {
        const user = server.users.find(u => u.sessionId === sessionId)
        if (user !== undefined) {
          return { serverId: server.id, userId: user.id, label: `${server.name} / ${user.name}` }
        }
      }
    }
    if (conn.serverId !== null && conn.userId !== null) {
      return { serverId: conn.serverId, userId: conn.userId, label: conn.label }
    }
    return null
  })()

  // 终端生命周期: 组件挂载时创建, 与连接状态解耦 — 断开保留, 重连分段,
  // 只在 host 进程重启 (页面刷新) 时重建 (挂载即空)。
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.25,
      fontFamily: "Consolas, 'Courier New', monospace",
      convertEol: true,
      scrollback: 10000,
      theme: { background: '#0a0a0a', foreground: '#eeeeee' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const host = hostRef.current
    if (host) term.open(host)
    termRef.current = term
    // 挂载即 host 进程视图起点: seq 从 0 拉, 缓冲为空则终端空 (重启后)。
    lastSeqRef.current = 0
    // Fit with measurement guards: a bad character-measure (fonts not ready,
    // zero-size host) would inflate rows/cols and blow the layout — skip and
    // let the resize observer / fonts-ready retry land a sane size.
    const fitNow = (): void => {
      try {
        const dims = fit.proposeDimensions()
        if (dims === undefined || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)
          || dims.cols < 2 || dims.rows < 2) return
        fit.fit()
      } catch { /* ignore */ }
    }
    fitNow()
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => { fitNow() }).catch(() => { /* ignore */ })
    }
    let raf: number | null = null
    const observer = host !== null ? new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        fitNow()
      })
    }) : null
    if (host !== null && observer !== null) observer.observe(host)
    return () => {
      if (observer !== null) observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
      try { term.dispose() } catch { /* ignore */ }
      termRef.current = null
    }
  }, [])

  // 终端数据: /mud/ws 推送订阅 + 重挂载回放。
  // 两条路径都按 seq 去重续写; 挂载即从 0 拉 (host 重启后缓冲为空 → 自然清空)。
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    // /mud/ws 订阅: 先订阅增量 (seq 去重), 再回放控制器保留的近期历史 —
    // 组件重挂载 (切换 tab / 断开重连) 时终端不丢已收内容。回放中与订阅后
    // 重叠的 seq 由 writeGameBatch 去重, 顺序保持单调。
    const off = mudSocket.onGame((items) => {
      lastSeqRef.current = writeGameBatch(term, items, lastSeqRef.current)
    })
    lastSeqRef.current = writeGameBatch(term, mudSocket.getGameItems(), lastSeqRef.current)
    return off
  }, [mudSocket])

  // 顶部工具条: 连接/断开按钮 + 连接状态 (不覆盖终端; 终端常驻不卸载)。
  const handleConnect = (): void => {
    if (target === null) return
    setConnectingLocal(true)
    void Promise.resolve(connectUser(target.serverId, target.userId)).finally(() => { setConnectingLocal(false) })
  }
  const busyState = connecting || connectingLocal
  const hasTarget = target !== null
  const statusText = connected
    ? (target?.label ?? conn.label ?? '已连接')
    : conn.state === 'error'
      ? (conn.error ?? '连接失败')
      : hasTarget
        ? `未连接: ${target?.label ?? '已绑定会话'}`
        : '未连接 — 请在左侧添加/选择用户'

  return (
    <div className={css.gameRoot} data-mud-no-width="">
      <div className={css.toolbar}>
        {connected ? (
          <button
            type="button"
            className={css.toolbarButton}
            onClick={() => { void disconnect() }}
          >
            断开连接
          </button>
        ) : (
          <button
            type="button"
            className={css.toolbarButton}
            onClick={handleConnect}
            disabled={busyState || !hasTarget}
          >
            {busyState ? '连接中…' : hasTarget ? '连接' : '选择用户'}
          </button>
        )}
        <span className={css.toolbarStatus}>{statusText}</span>
      </div>
      <div ref={hostRef} className={css.xtermHost} />
    </div>
  )
}
