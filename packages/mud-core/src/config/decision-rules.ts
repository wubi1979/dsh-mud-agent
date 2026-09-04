/**
 * dsh-mud-core — 决策规则 (Decision rules) 默认配置。
 *
 * 规则字段:
 *   id          规则 id (trace 显示)
 *   priority    优先级, 数字大者先匹配 (默认 10)
 *   match.event 感知事件模式 (精确或 "p:combat:*" 通配); 省略 = 空闲/状态驱动
 *   match.when  状态条件: 扁平 WorldModel 键 ("char.hp") → 期望值或操作符对象
 *               {gt,gte,lt,lte,eq,ne,in,truthy,falsy}
 *   action      命中后的动作:
 *               { action: "tool", tool: "mud_send", cmd: "look" }  发命令 (单步反射)
 *               { action: "flow", flow: "login" }                  直调命名 flow
 *               { action: "llm" }   声明式: 不短路, 交给 DSH agent 思考
 *   after       命中副作用: 写入 WorldModel 的字段 (防重复等)
 *   description 说明 (可选)
 *
 * 决策流程 (统一入口 = 决策中心 dispatcher):
 *   - 感知事件 (p:*) / 系统事件 (login:required) → 规则引擎匹配
 *   - 命中 action:"tool" → 直接调用工具 (确定性短路, 与 agent 同一条执行路径)
 *   - 命中 action:"flow" → flow.start 启动确定性事务 (如登录流程)
 *   - 未命中 / action:"llm" → 交给 DSH agent (游戏输出注入, LLM 用同一组工具)
 *
 * 规则引擎定位: 战斗 / 应激反射 / 人物状态捕获 / **flow 直调**。**确定性事务
 * 流程 (登录步骤执行) 不在本表, 由流程引擎 flow.ts 负责** —— 本表只留"等不起
 * LLM 延时的分支反射" + "何时启动哪个 flow" 两类确定性知识。
 *
 * 规则 = 确定性知识 (火克金、金克木这类), 静态配置为主; 若后期需 agent 沉淀
 * 规则再提升能力。
 * @module @deepseek-ai/dsh-mud-core/config/decision-rules
 */

import type { DecisionRule } from '../agent/decision.ts'

/** 决策规则 (战斗/死亡反射 + flow 直调; 登录步骤执行见 config/flows.ts)。 */
export default [
  // ── flow 直调 (决策中心统一调度: 系统就绪 → 未登录 → 启动登录流程) ──
  {
    id: 'on-login-required',
    priority: 30,
    match: { event: 'login:required' },
    when: { 'flags.logged_in': { falsy: true } },
    action: { action: 'flow', flow: 'login' },
    description: '未登录 (login:required) → 启动登录流程 (flow: login)',
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
  // ── 档案保存提醒反射 (确定性): 提示 → save (轻量短路, 无需 agent) ──
  {
    id: 'on-save-prompt',
    priority: 55,
    match: { event: 'p:save:prompt' },
    when: { 'flags.logged_in': { truthy: true } },
    action: { action: 'tool', tool: 'mud_send', cmd: 'save' },
    description: '系统提示建议保存档案 → 自动发送 save',
  },
] satisfies readonly DecisionRule[]
