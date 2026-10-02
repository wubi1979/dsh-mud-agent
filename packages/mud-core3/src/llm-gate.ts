/**
 * mud-core3 — LLM 调用面闸门（`llm/stream` 瀑布终审）。
 *
 * 模型调用面的准入终审（2026-10-02 裁定，接入语义规格的第 4 层「保险面」）：
 * 宿主 `LlmRuntime.stream()` 走 cordis 瀑布 `llm/stream`（监听器不调 `next()` 即
 * 否决，官方契约），且 `GenerateOptions.sessionId` 由 loop 盖会话身份戳——闸门
 * 可按 session 精确作用域。与投递面闸门（Deliverer）+ 静默唤醒三守卫构成三重
 * 防线；本层只做判定与合成流，注册接线归 index.ts（测试无法 import index）。
 *
 * 语义（接入 = 唯一任务书点火点，建账号纯登记不投递）：
 *   - 未接入账号会话的任何模型调用 → 拦成空 stop 流（0 token、无内容块、回合
 *     自然收束；turn/start 已发 → blank 照翻）。建账号后的首次 kickoff 因此成为
 *     空回合，agent 零行动；人工提问同理被拦（未接入 = agent 完全惰性）。
 *   - 停止接入后，进行中回合在下一步 LLM 调用处被拦 → 空步收束（在飞工具正常
 *     完成，无 cancelled 残迹）——不打断、不 cancel，钩子白给的准确语义。
 *   - 已接入 → 放行（admit 同步先置 admitted 再点火，时序上必放行）。
 *   - 非本插件会话（sessionId 缺省或不在名册）→ 放行（一次 Map 查找的开销）。
 *
 * @module mud-core3/llm-gate
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** 会话接入态的最小查询面（index.ts 注入；fail-closed：查不到 = 未接入）。 */
export interface LlmGateLookup {
  /** sessionId 是否属于本插件账号会话（名册判定，权威源）。 */
  isManaged(sessionId: string): boolean
  /** 该会话当前是否已接入（投递器缺席 = 未装配 = 未接入）。 */
  isAdmitted(sessionId: string): boolean
}

/**
 * 判定一次模型调用是否应被闸门拦截。
 * @param options - 本次模型调用请求（含 loop 盖的会话身份戳）。
 * @param lookup - 会话接入态查询面。
 * @returns true = 拦截（调用方返回合成流，不调 `next()`）。
 */
export function shouldVeto(options: GenerateOptions, lookup: LlmGateLookup): boolean {
  const id = options.sessionId
  if (id === undefined) return false // 一次性调用（无会话归属）不归闸门管
  if (!lookup.isManaged(String(id))) return false // 非本插件会话直接放行
  return !lookup.isAdmitted(String(id)) // fail-closed：投递器缺席按未接入
}

/**
 * 合成空 stop 流：单条终块、0 token、无内容块。loop 按空回合收束
 * （runtime-context 契约：empty head records no prompt）。
 * @returns 终止于 `finish: stop` 的块流。
 */
export async function* vetoStopStream(): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'stop' } }
}
