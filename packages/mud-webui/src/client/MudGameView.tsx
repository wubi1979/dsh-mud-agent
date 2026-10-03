/**
 * dsh-mud-webui — 右侧栏「游戏画面」tab body（client half, core3 C5）。
 *
 * 只读视图：core3 的 GameScreen 以 headless xterm 维护整屏，`mud.follow` 流推送
 * snapshot（双屏）+ output（双字段）+ state（状态）。这里只做渲染与滚动（C5.2
 * 一帧双字段：s1 主屏吃 screenMain/main，s2 聊天栏吃 screenSub/sub——前端零
 * kind 逻辑）：
 * - snapshot：s1 `term.reset()` + resize(服务端 cols) + write(screenMain)；
 *   s2 同型（列宽自由——副屏行环不限 cols，按窄栏宽度 wrap）+ write(screenSub)
 * - output：s1 write(main)、s2 write(sub)
 * - state：状态行文案
 * s1 列宽恒等于服务端屏宽（画面按服务端 cols 序列化，客户端重排会毁版式），
 * 行数由 FitAddon 按容器高度适配；s2 窄栏按自身宽度自由 wrap。两者均不挂 onData
 * 且 disableStdin 保证只读。s2 可折叠：折叠仅收起容器（终端保持挂载继续吃帧），
 * 展开即恢复——折叠期间聊天历史不丢；刷新后以 snapshot.screenSub 回放。
 * 流消费用 `for await` + AbortController：tab 关闭/隐藏（body 卸载）即 abort，
 * 服务端 follower 随之清理；再次打开时重新 follow，以 snapshot 回放恢复画面。
 *
 * @module @deepseek-ai/dsh-mud-webui/client/MudGameView
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** 连接本 tab 会话的 MUD 账号（宿主侧名册找回账号）；身份稳定。 */
  readonly connect: (sessionId: string) => Promise<void>
  /** 断开本 tab 会话的 MUD 连接；身份稳定。 */
  readonly disconnect: (sessionId: string) => Promise<void>
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
export function MudGameView({ useTabInfo, sessionId, params, remote, connect, disconnect }: MudGameViewProps): ReactNode {
  const { tab } = useTabInfo()
  const target = params(tab.id)?.sessionId ?? sessionId
  const [serverState, setServerState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 「刷新画面」：递增即重触发 follow effect（旧流 abort 清理，新流以 snapshot 回放恢复）。
  const [reloadKey, setReloadKey] = useState(0)
  // s2 聊天栏折叠开关（C5.2）：折叠仅收起容器，终端保持挂载继续吃帧——历史不丢。
  const [subOpen, setSubOpen] = useState(true)
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const cols = useRef(80)
  const rows = useRef(24)
  const refit = useRef<() => void>(() => {})
  const subHost = useRef<HTMLDivElement>(null)
  const subScreen = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const subCols = useRef(28)
  const subRows = useRef(24)
  const subRefit = useRef<() => void>(() => {})

  // xterm 装配（一次）：只读、列固定、行自适应
  useLayoutEffect(() => {
    const node = host.current
    if (node === null) return
    const term = new Terminal({
      cols: cols.current, rows: rows.current,
      disableStdin: true, cursorBlink: false,
      fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 2000,
      // 只读展示不画光标：cursor 透明即不留光标块（含非闪烁的常驻块）。
      theme: { background: '#0a0a0a', cursor: 'transparent', cursorAccent: 'transparent' },
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
  useLayoutEffect(() => { if (tab.visible) { refit.current(); subRefit.current() } }, [tab.visible])

  // s2 无关文本栏 xterm 装配（一次）：只读、宽高自适应底部栏（行环不限 cols，自由 wrap）。
  // 折叠只是容器高度 0（终端不卸载，继续吃帧保历史）；展开后 ResizeObserver 重新 fit。
  useLayoutEffect(() => {
    const node = subHost.current
    if (node === null) return
    const term = new Terminal({
      cols: subCols.current, rows: subRows.current,
      disableStdin: true, cursorBlink: false,
      fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 1000,
      theme: { background: '#0a0a0a', cursor: 'transparent', cursorAccent: 'transparent' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(node)
    subScreen.current = { term, fit }
    const measure = (): void => {
      if (node.clientWidth === 0 || node.clientHeight === 0) return
      const dim = fit.proposeDimensions()
      if (dim === undefined || dim.cols < 8) return
      subCols.current = dim.cols
      subRows.current = Math.max(dim.rows, 2)
      term.resize(subCols.current, subRows.current)
    }
    subRefit.current = measure
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => {
      observer.disconnect()
      subRefit.current = () => {}
      subScreen.current = null
      term.dispose()
    }
  }, [])

  // follow 流消费：snapshot 双屏回放、output 双字段增量、state 状态行
  useEffect(() => {
    const controller = new AbortController()
    const write = (frame: GameFrame): void => {
      const s = screen.current
      const sub = subScreen.current
      if (s === null) return
      if (frame.type === 'snapshot') {
        cols.current = frame.info.cols
        s.term.reset()
        s.term.resize(cols.current, rows.current)
        s.term.write(frame.screenMain)
        // s2 快照回放（screenSub = 行环 join 载荷）：刷新后聊天历史不丢。
        // 列宽自由：不用服务端 cols，按窄栏自身 fit 宽度 wrap。
        if (sub !== null) {
          sub.term.reset()
          sub.term.resize(subCols.current, subRows.current)
          if (frame.screenSub !== '') sub.term.write(frame.screenSub)
        }
        // 快照携带当前连接态：state 帧只在状态变化时广播，重挂后若状态未变
        // 则不会再有 state 帧——工具栏必须从快照回填，否则永远停在 loading。
        setServerState(frame.info.state)
        setError(null)
      } else if (frame.type === 'output') {
        s.term.write(frame.main)
        if (sub !== null && frame.sub !== '') sub.term.write(frame.sub)
      } else {
        setServerState(frame.info.state)
      }
    }
    const run = async (): Promise<void> => {
      // 冷启动自愈：tab 可随布局恢复（或 admit 自动打开）早于 runtime 登记——
      // follow 开流即抛「未登记」，流死掉后接入成功的内容全收不到，只能手动刷新。
      // 故异常/自然结束不吊死：1.5s 退避重挂，直到成功或 tab 关闭（abort）。
      while (!controller.signal.aborted) {
        try {
          setServerState(null)
          for await (const frame of remote.follow(target, controller.signal)) write(frame)
          if (controller.signal.aborted) return // 主动关闭/切换 tab：不算错误
          setServerState('disconnected') // 服务端流自然结束：同样按可重挂处理
        } catch (err) {
          if (controller.signal.aborted) return
          setError(err instanceof Error ? err.message : String(err))
        }
        await new Promise<void>(resolve => setTimeout(resolve, 1500))
        if (controller.signal.aborted) return
        setError(null) // 重挂：先收错误态，成功后由快照回填状态
      }
    }
    const done = run()
    gameFollows.set(gameFollowKey(sessionId, tab.id), { abort: () => controller.abort(), done })
    return () => {
      controller.abort()
      const key = gameFollowKey(sessionId, tab.id)
      if (gameFollows.get(key)?.done === done) gameFollows.delete(key)
    }
  }, [remote, sessionId, tab.id, target, reloadKey])

  const stateText = (state: string): string => {
    if (state === 'connected' || state === 'connecting' || state === 'disconnected') return zh[state]
    return state
  }
  const status = error !== null
    ? formatCopy(zh.failed, { message: error })
    : serverState === null ? zh.loading : stateText(serverState)
  return (
    <section className={css.gameRoot} data-mud-game>
      {/* 分割线 + 状态 + 按钮：对齐原生文件窗口（ui-sidebar-files FilesBody header）。 */}
      <div className={css.toolbar}>
        <span className={css.toolbarStatus} role="status">{status}</span>
        {/* 连接/断开：连接动作收进画面窗口（跟随本 tab 会话），侧栏菜单不再承担。
            未连接用 primary（原生主按钮，引导点击），已连接回落 ghost（弱化）。 */}
        <Button size="sm"
          variant={serverState === 'connected' ? 'ghost' : 'primary'}
          disabled={serverState === 'connecting'}
          onClick={() => { void (serverState === 'connected' ? disconnect(target) : connect(target)) }}>
          {serverState === 'connected' ? zh.disconnect : zh.connect}
        </Button>
        {/* s2 聊天栏折叠开关（C5.2）：折叠只收容器，终端继续吃帧，历史不丢。 */}
        <Button size="sm" variant={subOpen ? 'ghost' : 'outline'}
          onClick={() => { setSubOpen(v => !v) }}>
          {subOpen ? zh.collapseChat : zh.showChat}
        </Button>
        <Tooltip label={zh.reload} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={zh.reload}
            onClick={() => { setReloadKey(k => k + 1) }}>
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
      </div>
      <div className={css.panes}>
        <div className={css.xtermHost} ref={host} />
        <div className={`${css.subHost} ${subOpen ? '' : css.subCollapsed}`} ref={subHost} />
      </div>
    </section>
  )
}
