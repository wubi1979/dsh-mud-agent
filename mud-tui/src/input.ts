/**
 * dsh-mud-tui — 输入路由 (纯函数, 可单测), host face.
 *
 * 输入区文本 → 动作:
 *   裸文本        → 直发游戏连接 (sendCommand)
 *   /ai <内容>   → 注入 agent 决策 (askAgent)
 *   /connect     → 连接 MUD 服务器 (可带 <账户> <密码>)
 *   /disconnect  → 断开连接
 *   /auto on|off → 运行时切换 agent 接入模式
 *   /status      → 查询连接状态快照
 *   /quit|/exit  → 退出 TUI (优雅停机宿主进程)
 * @module @deepseek-ai/dsh-mud-tui/input
 */

export type InputAction =
  | { kind: 'empty' }
  | { kind: 'game'; value: string }
  | { kind: 'agent'; value: string }
  | { kind: 'connect'; name?: string; pass?: string }
  | { kind: 'disconnect' }
  | { kind: 'auto'; enabled: boolean }
  | { kind: 'status' }
  | { kind: 'quit' }
  | { kind: 'unknown'; value: string }

/**
 * 解析输入区一条文本为动作。
 * @param raw 用户原始输入 (未 trim)。
 */
export function routeInput(raw: string): InputAction {
  const text = raw.trim()
  if (text === '') return { kind: 'empty' }
  if (!text.startsWith('/')) return { kind: 'game', value: text }
  const sp = text.indexOf(' ')
  const command = (sp === -1 ? text : text.slice(0, sp)).toLowerCase()
  const rest = sp === -1 ? '' : text.slice(sp + 1).trim()
  switch (command) {
    case '/ai':
      return rest === '' ? { kind: 'unknown', value: command } : { kind: 'agent', value: rest }
    case '/connect': {
      if (rest === '') return { kind: 'connect' }
      const parts = rest.split(/\s+/)
      const name = parts[0] !== '' ? parts[0] : undefined
      const pass = parts.length > 1 && parts[1] !== '' ? parts.slice(1).join(' ') : undefined
      return {
        kind: 'connect',
        ...(name !== undefined ? { name } : {}),
        ...(pass !== undefined ? { pass } : {}),
      }
    }
    case '/disconnect':
      return { kind: 'disconnect' }
    case '/auto': {
      const on = rest.toLowerCase() === 'on'
      const off = rest.toLowerCase() === 'off'
      return on || off ? { kind: 'auto', enabled: on } : { kind: 'unknown', value: command }
    }
    case '/status':
      return { kind: 'status' }
    case '/quit':
    case '/exit':
      return { kind: 'quit' }
    default:
      return { kind: 'unknown', value: command }
  }
}
