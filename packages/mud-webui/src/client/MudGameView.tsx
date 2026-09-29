/**
 * dsh-mud-webui — 右侧栏「游戏画面」tab body（client half, core3 C5）。
 *
 * 只读视图：core3 的 GameScreen 以 headless xterm 维护整屏，`mud.follow` 流推送
 * snapshot（整屏）+ output（增量）+ state（状态）。这里只做渲染与滚动：
 * - snapshot：`term.reset()` + resize(服务端 cols) + write(screen)
 * - output：增量 write
 * - state：状态行文案
 * 列宽恒等于服务端屏宽（画面按服务端 cols 序列化，客户端重排会毁版式），
 * 行数由 FitAddon 按容器高度适配；不挂 onData 且 disableStdin 保证只读。
 * 流消费用 `for await` + AbortController：tab 关闭/隐藏（body 卸载）即 abort，
 * 服务端 follower 随之清理；再次打开时重新 follow，以 snapshot 回放恢复画面。
 *
 * @module @deepseek-ai/dsh-mud-webui/client/MudGameView
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GameFrame } from 'mud-core3/types'
import type { MudRemoteController } from './mud-remote.ts'
import { formatCopy, zh } from './locales.ts'
import './xterm.css'
import css from './MudGameView.module.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** 画面 tab：跟随哪个 MUD 会话（随布局持久化，刷新/重开 tab 自动恢复）。 */
    'mud-game': { sessionId: string }
  }
}

/** body 注入面：画面 RPC 控制器 + 会话归属（tab 所在会话 = MUD 会话）。 */
export interface MudGameViewInjected {
  remote: MudRemoteController
  /** tab 所在会话（DSH sessionId = MUD 会话 id）。 */
  readonly sessionId: string
  /** tab 打开时的导航参数（布局持久化恢复后的会话依据）。 */
  readonly params: (tabId: string) => { readonly sessionId: string } | undefined
}

export type MudGameViewProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<MudGameViewInjected>

/** 一次 follow 消费的句柄（close handler 同步 abort 用）。 */
export interface GameFollowHandle {
  abort(): void
  done: Promise<void>
}

/** 进行中的 follow 消费（键 = gameFollowKey(sessionId, tabId)；body 卸载即摘除）。 */
export const gameFollows = new Map<string, GameFollowHandle>()

/** follow 注册表的键（sessionId = tab 所在会话，与 close handler 对齐）。 */
export const gameFollowKey = (sessionId: string, tabId: string): string => `${sessionId}#${tabId}`

/** 右侧栏只读游戏画面。 */
export function MudGameView({ useTabInfo, sessionId, params, remote }: MudGameViewProps): ReactNode {
  const { tab } = useTabInfo()
  const target = params(tab.id)?.sessionId ?? sessionId
  const [serverState, setServerState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const cols = useRef(80)
  const rows = useRef(24)
  const refit = useRef<() => void>(() => {})

  // xterm 装配（一次）：只读、列固定、行自适应
  useLayoutEffect(() => {
    const node = host.current
    if (node === null) return
    const term = new Terminal({
      cols: cols.current, rows: rows.current,
      disableStdin: true, cursorBlink: false,
      fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 2000,
      theme: { background: '#0a0a0a' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(node)
    screen.current = { term, fit }
    const measure = (): void => {
      if (node.clientWidth === 0 || node.clientHeight === 0) return
      const dim = fit.proposeDimensions()
      if (dim === undefined || dim.rows < 2) return
      rows.current = dim.rows
      term.resize(cols.current, dim.rows)
    }
    refit.current = measure
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => {
      observer.disconnect()
      refit.current = () => {}
      screen.current = null
      term.dispose()
    }
  }, [])

  // tab 重现时容器尺寸可能已变（隐藏期间 ResizeObserver 不触发）
  useLayoutEffect(() => { if (tab.visible) refit.current() }, [tab.visible])

  // follow 流消费：snapshot 整屏回放、output 增量、state 状态行
  useEffect(() => {
    const controller = new AbortController()
    const write = (frame: GameFrame): void => {
      const s = screen.current
      if (s === null) return
      if (frame.type === 'snapshot') {
        cols.current = frame.info.cols
        s.term.reset()
        s.term.resize(cols.current, rows.current)
        s.term.write(frame.screen)
        setError(null)
      } else if (frame.type === 'output') {
        s.term.write(frame.data)
      } else {
        setServerState(frame.info.state)
      }
    }
    const run = async (): Promise<void> => {
      setServerState(null)
      try {
        for await (const frame of remote.follow(target, controller.signal)) write(frame)
        if (!controller.signal.aborted) setServerState('disconnected') // 服务端流自然结束
      } catch (err) {
        if (controller.signal.aborted) return // 主动关闭/切换 tab：不算错误
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    const done = run()
    gameFollows.set(gameFollowKey(sessionId, tab.id), { abort: () => controller.abort(), done })
    return () => {
      controller.abort()
      const key = gameFollowKey(sessionId, tab.id)
      if (gameFollows.get(key)?.done === done) gameFollows.delete(key)
    }
  }, [remote, sessionId, tab.id, target])

  const stateText = (state: string): string => {
    if (state === 'connected' || state === 'connecting' || state === 'disconnected') return zh[state]
    return state
  }
  const status = error !== null
    ? formatCopy(zh.failed, { message: error })
    : serverState === null ? zh.loading : stateText(serverState)
  return (
    <section className={css.gameRoot} data-mud-game>
      <div className={css.toolbar}>
        <span className={css.toolbarStatus} role="status">{status}</span>
      </div>
      <div className={css.xtermHost} ref={host} />
    </section>
  )
}
