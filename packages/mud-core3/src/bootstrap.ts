/**
 * mud-core3 bootstrap — 建账号后的开场消息（把 blank 会话翻成活跃会话）。
 *
 * 为什么需要它：会话体只在**非 blank** 时渲染（宿主 `sessionListMetadata.blank` 只由
 * `turn/start` 事件翻，见 session-controller/src/list.ts）。刚建出来的账号会话没有任何
 * 事件 ⇒ blank ⇒ 会话头/会话体（含 MUD 日志 tab）都不渲染。伪造一个 `turn/start` 会污染
 * 日志的回合计数与 replay，所以这里的做法是**投递一条真实用户消息**，让 agent 真的跑一个
 * 回合 —— 会话即刻脱离 blank，页面立刻可交互。
 *
 * 代价：每个账号一次模型调用（可用 `bootstrapOnCreate: false` 关掉；关掉后会话保持 blank，
 * 直到用户首次发消息或 MUD 信息被投递）。
 */

/** 开场消息所需的账号事实（不含密码）。 */
export interface BootstrapFacts {
  /** 服务器显示名。 */
  readonly serverName: string
  /** MUD 地址 host:port。 */
  readonly endpoint: string
  /** MUD 登录名。 */
  readonly accountName: string
  /** 建账号时选的 preset。 */
  readonly preset: string
}

/**
 * 生成开场消息文本（MUD 源的用户消息）。
 * @param facts - 服务器/账号事实。
 * @returns 供 `agent.followup` 投递的文本。
 */
export function bootstrapText(facts: BootstrapFacts): string {
  return [
    `（系统）MUD 账号已创建并绑定本会话：服务器 ${facts.serverName}（${facts.endpoint}），账号 ${facts.accountName}，preset ${facts.preset}。`,
    '当前状态：未连接。用户点击左侧账号行的「连接」，再点「接入」后，MUD 消息会以用户消息的形式到达这里。',
    '请用一句话确认你已就绪，不要调用任何工具。',
  ].join('\n')
}
