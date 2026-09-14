/**
 * dsh-mud-core — 活动会话视图 (shell/view).
 *
 * host 的"当前视图会话"概念: 路由 / 服务入口未显式给出 sessionId 时回落
 * 最近一次 connect/bind 的会话, 再回落部署配置的缺省会话 id (最终兜底
 * `mud-player`)。会话即身份 —— 视图只是**回落指针**, 不持有任何会话状态。
 * @module @deepseek-ai/dsh-mud-core/shell/view
 */

/** 活动会话视图 (last-active 记忆 + 回落解析)。 */
export class SessionView {
  private lastActiveSessionId: string | null = null

  constructor(private readonly fallback: string) {}

  /** 最近一次 connect/bind 的会话 (路由未显式给 sessionId 时的回落)。 */
  lastActive(): string | null {
    return this.lastActiveSessionId
  }

  /** 会话被 (重新) 声明为活动时记录。 */
  setActive(sessionId: string): void {
    this.lastActiveSessionId = sessionId
  }

  /** 会话注销时清回落指针 (只清自己)。 */
  clearActive(sessionId: string): void {
    if (this.lastActiveSessionId === sessionId) this.lastActiveSessionId = null
  }

  /** 解析目标会话 id: 显式字段优先 → last-active → 部署缺省。 */
  resolve(sessionId?: string): string {
    const explicit = sessionId?.trim()
    if (explicit !== undefined && explicit !== '') return explicit
    return this.lastActiveSessionId ?? this.fallback
  }
}