/**
 * dsh-mud-tui — TUI 应用主体 (pi-tui 双栏布局), host face.
 *
 * 布局 (对齐 opencode session 路由):
 *   左栏 (grow): Tab 栏+横线 → 主区 (F1 游戏 / F2 对话) → 输入区 → 系统状态栏
 *   右栏 (固定 42 列, backgroundPanel 底色): 决策轨迹 → 世界状态 → 版本标识
 *
 * 数据源:
 *   游戏流   ctx.mud.readGame(sinceSeq) 续拉 (refreshMs 轮询)
 *   状态栏   ctx.mud.status()
 *   世界面板 ctx.mud.snapshot() + mud/world 会话事件
 *   决策轨迹 mud/decision + mud/log 会话事件
 *   对话     session/event 投影 (assistant 全文 Markdown, 用户折叠单行)
 * @module @deepseek-ai/dsh-mud-tui/app
 */

import {
  Container, HStack, Input, Markdown, ProcessTerminal, ScrollView,
  TuiAltScreen, VStack, matchesKey, truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { MudCoreService } from '@deepseek-ai/dsh-mud-core'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { InputPanel, PanelText, StatusBar, TabBar, TailPanel, WorldPanel } from './components.ts'
import { routeInput, type InputAction } from './input.ts'
import { buildMarkdownTheme, fg, style } from './theme.ts'
import { XtermView } from './xterm-view.ts'

/** TUI 插件配置。 */
export interface MudTuiConfig {
  /** 轮询周期 ms (游戏流续拉 + 状态刷新)。 */
  refreshMs?: number
  /** 右栏固定宽度 (对齐 opencode sidebar 默认 42 列)。 */
  rightWidth?: number
}

const TABS = ['游戏', '对话'] as const
const CHAT_MAX_COMPONENTS = 400

/** 单行文本组件 (决策/系统行)。 */
class Line implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, width)]
  }

  invalidate(): void {}
}

/** MUD TUI 应用。 */
export class MudTuiApp {
  private readonly tui: TuiAltScreen
  private readonly input: Input
  private readonly tabBar = new TabBar(TABS)
  private readonly gameTerm = new XtermView()
  private readonly decisionView = new TailPanel(300)
  private readonly worldPanel = new WorldPanel()
  private readonly statusBar: StatusBar
  private readonly chatContainer = new Container()
  private readonly gameScroll = new ScrollView(this.gameTerm, { follow: 'end', primary: true })
  private readonly chatScroll = new ScrollView(this.chatContainer, { follow: 'end', primary: true })
  private activeTab = 0
  private gameSeq = 0
  private hasWorldSnapshot = false
  private readonly refreshMs: number
  private readonly rightWidth: number
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private detachInput: (() => void) | null = null

  /** /quit 触发时回调 (宿主决定退出语义)。 */
  onQuit: (() => void) | null = null

  constructor(private readonly mud: MudCoreService, config: MudTuiConfig = {}) {
    this.refreshMs = Math.max(100, config.refreshMs ?? 500)
    this.rightWidth = Math.max(16, config.rightWidth ?? 42)
    const terminal = new ProcessTerminal()
    this.tui = new TuiAltScreen(terminal, false, undefined, { mouse: true })
    this.input = new Input()
    this.statusBar = new StatusBar('F1 游戏 · F2 对话 · /exit 退出 · /help 命令')
    this.input.onSubmit = (value: string): void => {
      this.handleSubmit(value)
      this.input.setValue('')
      this.tui.requestRender()
    }

    // 左栏: Tab 栏(+横线) → 主区 (grow; 两个 ScrollView 按 Tab 可见性切换,
    // 必须是直接布局条目 — 包在不透明容器里会失去滚动节点身份) → 输入区 → 状态栏
    const leftColumn = new VStack([
      { component: this.tabBar, shrink: 0 },
      { component: this.gameScroll, grow: 1, visible: (): boolean => this.activeTab === 0 },
      { component: this.chatScroll, grow: 1, visible: (): boolean => this.activeTab === 1 },
      { component: new InputPanel(this.input), shrink: 0 },
      { component: this.statusBar, shrink: 0 },
    ])
    // 右栏: 决策轨迹 (grow, 整块面板底色) → 世界状态 → 版本标识 (opencode footer 样式)
    const version = `${fg.green('•')} ${style.bold('Mud')}Agent ${style.dim('0.1.1-rc.2')}`
    const rightColumn = new VStack([
      { component: this.decisionView, grow: 1 },
      { component: this.worldPanel, shrink: 0 },
      { component: new PanelText(version), shrink: 0 },
    ])
    // 左栏占满剩余宽度; 右栏固定宽度 (opencode sidebar 布局)
    const root = new HStack([
      { component: leftColumn, grow: 1 },
      { component: rightColumn, basis: this.rightWidth, shrink: 0 },
    ])
    this.tui.setLayoutRoot(root)

    // 全局按键: F1/F2 切换主区 Tab; ctrl+q 优雅退出 (ctrl+c 留给终端复制)。
    this.detachInput = this.tui.addInputListener((data: string) => {
      if (matchesKey(data, 'f1')) { this.switchTab(0); return { consume: true } }
      if (matchesKey(data, 'f2')) { this.switchTab(1); return { consume: true } }
      if (matchesKey(data, 'ctrl+q')) {
        this.onQuit?.()
        return { consume: true }
      }
      return undefined
    })
  }

  /** 启动渲染与轮询。 */
  start(): void {
    this.tui.start()
    this.tui.setFocus(this.input)
    this.poll()
    this.pollTimer = setInterval(() => { this.poll() }, this.refreshMs)
  }

  /** 停止渲染并释放终端 (恢复主屏)。 */
  stop(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.detachInput?.()
    this.detachInput = null
    this.tui.stop()
  }

  /**
   * 订阅会话事件流 (对话转录 + 决策轨迹 + 世界快照推送)。
   * @param event 会话日志事件。
   * @param sessionKey 事件来源会话 id (mud/* 事件可缺省)。
   * @param activeSessionId 当前 MUD 会话 id (null = 尚未激活)。
   */
  handleEvent(event: SessionEvent, sessionKey: string | null, activeSessionId: string | null): void {
    const isMudEvent = event.type.startsWith('mud/')
    // 只关心当前 MUD 会话的事件 (多会话并行时不串台)。
    const own = isMudEvent || (sessionKey !== null && sessionKey === activeSessionId)
    switch (event.type) {
      case 'mud/decision':
        this.decisionView.addLine(decisionLine(event.data))
        break
      case 'mud/log':
        if (own) this.decisionView.addLine(style.dim(`· ${event.data.text}`))
        break
      case 'mud/world':
        if (own) { this.worldPanel.update(event.data.world, this.mud.status()); this.hasWorldSnapshot = true }
        break
      case 'user/message':
        if (own) this.addChatLine(style.dim(`你> ${firstLine(extractText(event.data.content), 100)}`))
        break
      case 'assistant/message': {
        if (!own) break
        const text = extractText(event.data.message.content)
        if (text.trim() !== '') this.addChatMarkdown(text)
        break
      }
      case 'tool/call':
        if (own) this.addChatLine(fg.cyan(`[工具] ${event.data.name}`))
        break
      case 'tool/result':
        if (own && event.data.error !== undefined) this.addChatLine(fg.red('[工具] 执行失败'))
        break
      default:
        break
    }
    this.tui.requestRender()
  }

  private switchTab(index: number): void {
    if (index === this.activeTab) return
    this.activeTab = index
    this.tabBar.setActive(index)
    this.tui.requestRender()
  }

  /** 轮询: 游戏流续拉 + 状态栏/世界面板刷新。 */
  private poll(): void {
    const { items, tailSeq } = this.mud.readGame(this.gameSeq)
    if (items.length > 0) {
      for (const item of items) this.gameTerm.write(item.text)
      this.gameSeq = tailSeq
    }
    const status = this.mud.status()
    this.statusBar.update(status)
    if (!this.hasWorldSnapshot) this.worldPanel.update(this.mud.snapshot(), status)
    this.tui.requestRender()
  }

  /** 输入路由: 斜杠命令 / AI 指令 / 裸游戏命令。 */
  private handleSubmit(raw: string): void {
    const action = routeInput(raw)
    switch (action.kind) {
      case 'empty':
        break
      case 'game':
        if (!this.mud.sendCommand(action.value)) {
          this.decisionView.addLine(fg.red('[SYS] 未连接 — 先 /connect'))
        }
        break
      case 'agent':
        if (!this.mud.askAgent(action.value)) {
          this.decisionView.addLine(fg.red('[SYS] agent 未就绪 — 先连接并激活会话'))
        }
        break
      case 'connect': {
        // TUI 没有「打开用户」的前置动作: 连接前先确保 agent 会话存在,
        // 否则核心 connect 因会话未 materialize 静默拒绝 (日志也无处可发)。
        void this.handleConnect(action)
        break
      }
      case 'disconnect':
        this.mud.disconnect()
        break
      case 'auto':
        this.mud.setAgentEnabled(action.enabled)
        break
      case 'status': {
        const s = this.mud.status()
        this.decisionView.addLine(`[状态] ${s.host}:${s.port} ${s.state} agent=${s.agentEnabled ? 'on' : 'off'} session=${s.sessionId ?? '-'}`)
        break
      }
      case 'quit':
        this.onQuit?.()
        break
      case 'unknown':
        this.decisionView.addLine(fg.yellow(`[SYS] 未知命令 ${action.value} — /connect /disconnect /auto on|off /ai <内容> /status /exit`))
        break
    }
    this.tui.requestRender()
  }

  /** 连接流程: 先准备 agent 会话 (创建/恢复), 再建 telnet 连接。 */
  private async handleConnect(action: Extract<InputAction, { kind: 'connect' }>): Promise<void> {
    try {
      const sessionId = this.mud.status().sessionId ?? 'mud-player'
      await this.mud.prepareAgent(sessionId)
      this.mud.connect({
        ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.pass !== undefined ? { pass: action.pass } : {}),
      })
    } catch (err) {
      this.decisionView.addLine(fg.red(`[SYS] 会话准备失败: ${err instanceof Error ? err.message : String(err)}`))
      this.tui.requestRender()
    }
  }

  private addChatLine(text: string): void {
    this.chatContainer.addChild(new Line(text))
    this.capChatHistory()
  }

  private addChatMarkdown(text: string): void {
    this.chatContainer.addChild(new Markdown(text, 0, 0, buildMarkdownTheme()))
    this.chatContainer.addChild(new Line(''))
    this.capChatHistory()
  }

  private capChatHistory(): void {
    while (this.chatContainer.children.length > CHAT_MAX_COMPONENTS) {
      this.chatContainer.removeChild(this.chatContainer.children[0] as Component)
    }
  }
}

function extractText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => typeof block === 'object' && block !== null && 'text' in block
      && typeof (block as { text: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .filter(text => text !== '')
    .join('\n')
}

function firstLine(text: string, maxLength: number): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line
}

function decisionLine(d: { actor?: string; ruleId?: string; eventType?: string; action?: string; result?: string; text?: string }): string {
  if (typeof d.text === 'string' && d.text !== '') {
    return d.result !== undefined ? `${d.text} (${d.result})` : d.text
  }
  return `[${d.actor ?? '?'}] ${d.ruleId ?? d.eventType ?? ''} → ${d.action ?? ''}`
}
