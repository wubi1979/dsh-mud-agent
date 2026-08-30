/**
 * dsh-mud-core — 决策规则 (Decision rules) 默认配置。
 *
 * 规则字段:
 *   id          规则 id (trace 显示)
 *   priority    优先级, 数字大者先匹配 (默认 10)
 *   match.event 感知事件模式 (精确或 "p:combat:*" 通配); 省略 = 空闲/状态驱动
 *   match.when  状态条件: 扁平 WorldModel 键 ("char.hp") → 期望值或操作符对象
 *               {gt,gte,lt,lte,eq,ne,in,truthy,falsy}
 *   action      命中后的动作 — 统一为**工具调用**:
 *               { action: "tool", tool: "mud_send", cmd: "look" }   发命令
 *               { action: "tool", tool: "mud_send", cmd: "{name}" } cmd 支持
 *               {account.name}/{account.pass} 模板 (登录)
 *               { action: "llm" }   声明式: 不短路, 交给 DSH agent 思考
 *   after       命中副作用: 写入 WorldModel 的字段 (防重复等), 如 { "flags.sent_name": true }
 *   description 说明 (可选)
 *
 * 决策流程 (统一入口):
 *   - 感知事件 (p:*) / 系统事件 → 规则引擎
 *   - 命中 → 直接调用工具 (确定性短路, 与 agent 同一条执行路径)
 *   - 未命中 / action:"llm" → 交给 DSH agent (游戏输出注入, LLM 用同一组工具)
 *
 * 登录 (无状态机): "提示出现 → 发对应输入" 的原子映射。
 *   时序由游戏输出的到达顺序天然保证; 进度由 world 标志 (sent_name /
 *   sent_pass / logged_in) 记录, 防止重复发送; 连接时重置 sent 标志。
 * @module @deepseek-ai/dsh-mud-core/config/rules-decision
 */

import type { DecisionRule } from '../decision.ts'

/** 决策规则 (登录 skill 确定性执行表 + 战斗/死亡反射)。 */
export default [
  // ── 登录 skill 的确定性执行表 ─────────────────────────────
  // skill 字段: 规则归属的流程能力 (config/skills.ts 定义, agent 的知识)。
  // 规则 = agent 的自动执行代理: 这些提示本该进 agent 思考, 因答案确定,
  // 规则直接替 agent 调用工具; 执行进展由宿主反馈给 agent (上下文连续)。
  {
    id: 'login:send-name',
    skill: 'login',
    priority: 100,
    match: { event: 'p:login:prompt' },
    when: { 'flags.sent_name': { falsy: true } },
    action: { action: 'tool', tool: 'mud_send', cmd: '{name}' },
    after: { 'flags.sent_name': true },
    description: '用户名提示 → 发账号',
  },
  {
    id: 'login:send-pass',
    skill: 'login',
    priority: 100,
    match: { event: 'p:login:pass' },
    when: { 'flags.sent_pass': { falsy: true } },
    action: { action: 'tool', tool: 'mud_send', cmd: '{pass}' },
    after: { 'flags.sent_pass': true },
    description: '密码提示 → 发密码',
  },
  {
    id: 'login:replace',
    skill: 'login',
    priority: 95,
    match: { event: 'p:login:replace' },
    action: { action: 'tool', tool: 'mud_send', cmd: 'y' },
    description: '同名档案替换 → 确认 y',
  },
  {
    id: 'login:done',
    skill: 'login',
    priority: 90,
    match: { event: 'p:login:done' },
    action: { action: 'tool', tool: 'mud_send', cmd: 'look' },
    description: '登录成功 → look 刷新房间',
  },
  {
    id: 'login:failed',
    skill: 'login',
    priority: 90,
    match: { event: 'p:login:failed' },
    action: { action: 'llm' },
    description: '密码错误 → 交给 agent (修订策略)',
  },

  // ── 战斗 / 死亡 (等不起 LLM 延时的确定性反射) ───────────
  {
    id: 'on-combat-start',
    priority: 80,
    match: { event: 'p:combat:start' },
    when: { 'flags.logged_in': { truthy: true } },
    action: { action: 'tool', tool: 'mud_send', cmd: 'halt' },
    description: '战斗开始 → 立即 halt (安全默认)',
  },
  {
    id: 'on-combat-end',
    priority: 70,
    match: { event: 'p:combat:end' },
    when: { 'flags.logged_in': { truthy: true } },
    action: { action: 'tool', tool: 'mud_send', cmd: 'look' },
    description: '战斗结束 → look 刷新房间',
  },
  {
    id: 'on-death',
    priority: 95,
    match: { event: 'p:death' },
    action: { action: 'llm' },
    description: '死亡 → 交给 agent 修订目标 (学武功防身等)',
  },
] satisfies readonly DecisionRule[]
