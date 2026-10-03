/**
 * dsh-mud-webui — 「游戏画面」tab 文案（sidebar.right 的 mud-game tab 专用）。
 *
 * 本包现状不接宿主 locale 服务（侧栏/日志视图均为内置中文文案，见
 * MudSidebar/MudLogView），这里集中 zh/en 词典 + 占位符替换，供画面 tab
 * 与 tab 类型注册直接取用；后续接入 locale 服务时只需改为 register。
 *
 * @module @deepseek-ai/dsh-mud-webui/client/locales
 */

/** 简体中文文案。 */
export const zh = {
  title: '游戏画面',
  guideDesc: '打开当前会话的只读游戏画面',
  loading: '正在接入画面…',
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '已断开',
  failed: '画面中断：{message}',
  reload: '刷新画面',
  connect: '连接',
  disconnect: '断开',
  collapseChat: '收起聊天',
  showChat: '聊天栏',
} as const

/** English copy（词典位先占；本包未接 locale 服务，EN 暂不启用）。 */
export const en = {
  title: 'Game view',
  guideDesc: "Open the current session's read-only game view",
  loading: 'Attaching to the game view…',
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  failed: 'View interrupted: {message}',
  reload: 'Reload view',
  connect: 'Connect',
  disconnect: 'Disconnect',
  collapseChat: 'Hide chat',
  showChat: 'Chat pane',
} as const

/** 按 {name} 占位符填充文案。 */
export const formatCopy = (template: string, params: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? `{${key}}`)
