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
 *   - 命中 action:"flow" → flow.start 启动确定性事务 (如登录流程)
 *   - 未命中 / action:"llm" → 交给 DSH agent (游戏输出注入, LLM 用同一组工具)
 *
 * v5 说明: 旧的战斗单步 action:"tool" 反射规则 (战斗 halt / 战后 look) 已迁移到
 * 感知 lite 捕获器 (LiteCapture, src/perception/lite-capture.ts) — 它走
 * "捕获 → lite marker → agent 会话 → 确定性 mud-trigger adapter → 官方工具
 * 管道" 链路, 取代本表的战斗反射短路。非战斗的确定性单步反射 (如档案保存
 * 提醒 on-save-prompt) 仍保留在表内; 连同 flow 直调 (on-login-required) 与
 * 声明式 llm (on-death)。
 *
 * 规则 = 确定性知识 (火克金、金克木这类), 静态配置为主; 若后期需 agent 沉淀
 * 规则再提升能力。
 * @module @deepseek-ai/dsh-mud-core/config/decision-rules
 */

import type { DecisionRule } from '../agent/decision.ts'

/** 决策规则 (flow 直调 + 声明式 llm; 战斗反射由 LiteCapture 处理, 见 decision-rules 头注)。 */
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

  // ── 死亡 (声明式: 不短路, 交给 agent 修订目标) ──────────
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
