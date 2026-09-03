/**
 * dsh-mud-core — 外壳桥接 (Shell Bridge) 事件契约 (SessionEventMap merge),
 * host half. host 与 UI 外壳 (webui / tui) 之间的会话事件桥:
 *
 * 插件自定义会话事件:
 *   - mud/decision  决策事件 (规则命中 / 感知路由 / agent 工具调用 →
 *     WebUI 决策栏): 谁 (actor) + 为什么 (ruleId/eventType) + 做了什么 (action)
 *   - mud/log       普通日志流水 (系统/注入/连接状态 → WebUI 日志 tab)
 *   - mud/world     world 快照 (host 节流推送 → WebUI 状态面板)
 *   - mud/command   客户端 → host 命令通道 (WebUI 无输入框, 保留供未来扩展)
 *
 * 事件数据必须 lossless-JSON 可序列化 (Session.append 强制)。
 * @module @deepseek-ai/dsh-mud-core/shell-bridge
 */

/** 世界快照 (worldSnapshot 产物, JSON 可序列化)。 */
export interface MudWorldSnapshot {
  char: Record<string, unknown>
  room: Record<string, unknown>
  combat: Record<string, unknown>
  flags: Record<string, unknown>
}

/**
 * One decision the MUD host or its agent made: who acted (rule engine,
 * perception router, or the agent's tool call), why (rule id / perception
 * event), and what was done (tool + command). The WebUI decision rail
 * renders these; the payload carries the structured fields plus a
 * preformatted display text.
 */
export interface MudDecisionEvent {
  /** Who made the decision. */
  actor: 'rule' | 'router' | 'agent' | 'flow'
  /** The rule id that fired (actor 'rule'). */
  ruleId?: string
  /** The perception event type routed (actor 'router'). */
  eventType?: string
  /** The flow name (actor 'flow'), e.g. 'login'. */
  flow?: string
  /** What was done: tool + command (rule/agent) or routing target (router). */
  action: string
  /** Result of the action (tool ok/note), when available. */
  result?: string
  /** Preformatted display text (fallback when structured fields are absent). */
  text: string
  /** Epoch-ms time. */
  time: number
}

/**
 * One plain log line (system/connection/injection noise) the MUD host
 * published. The WebUI log tab renders these; the payload is the display
 * text plus its epoch-ms time.
 */
export interface MudLogEvent {
  text: string
  time: number
}

/**
 * One throttled world snapshot the MUD host published after a perception
 * or GMCP change. The WebUI details rail renders the latest one as the
 * status panel; the payload is the serialized WorldModel sections.
 */
export interface MudWorldEvent {
  world: MudWorldSnapshot
  time: number
}

/**
 * One captcha interaction the fullme flow published: the captured image URL
 * plus the prefilled command ("fullme <text>"; text empty until OCR fills
 * it). Replacement semantics — a new event replaces the frontend dialog
 * state (never stacks). The WebUI dialog receives this via /mud/ws ui frames
 * (kind 'captcha'); the TUI consumes it as a session event.
 */
export interface MudCaptchaEvent {
  /** Captcha image URL (as echoed by the game). */
  url: string
  /** Prefilled command, e.g. 'fullme' or 'fullme <recognized text>'. */
  cmd: string
  /** Epoch-ms time. */
  time: number
}

/**
 * Mud 实时广播事件 (进程内, 驱动 TUI): 决策/日志/世界/验证码。
 * mud-core 经 ctx.emit 广播, 不再写进 agent session 日志 — mud/* 事件无需
 * 持久化 (TUI 与 host 同进程实时消费, browser 走 /mud/ws), 而写入 session
 * 日志会因类型不在 KNOWN_SESSION_EVENT_TYPES 导致重启读史失败。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'mud/decision': MudDecisionEvent
    'mud/log': MudLogEvent
    'mud/world': MudWorldEvent
    'mud/captcha': MudCaptchaEvent
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'mud/decision': MudDecisionEvent
    'mud/log': MudLogEvent
    'mud/world': MudWorldEvent
    'mud/captcha': MudCaptchaEvent
    /**
     * One game-output batch the MUD host pushed directly (agentEnabled=false,
     * agent pause mode): the game text plus a per-connection monotonic seq
     * the WebUI terminal uses for dedup. The agent is not involved.
     */
    'mud/game': { text: string; seq: number; time: number }
    /**
     * One raw MUD command the client asked the host to send straight to the
     * game connection (bypassing the agent). The host listens on session/event
     * for this type; the payload is the command line.
     */
    'mud/command': { cmd: string }
  }
}
