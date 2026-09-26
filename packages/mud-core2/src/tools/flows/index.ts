/**
 * flows/index — 流程注册表（impl §3.6）。
 *
 * 加流程 = 加文件 + 本数组一行；对模型只暴露 `mud_flow({id})`，注册表不进
 * 模型上下文。查无此 id = 越权/不存在，mud_flow 直接拒（§3.5 静态遮蔽）。
 */

import { LOGIN_FLOW } from './login.ts'
import type { Flow } from './types.ts'

/** 流程注册表（新流程追加到此数组）。 */
export const FLOWS: readonly Flow[] = [
  LOGIN_FLOW,
]

/** 按 id 查流程；查无返回 null（工具层据此直接拒）。 */
export function getFlow(id: string, flows: readonly Flow[] = FLOWS): Flow | null {
  return flows.find(f => f.id === id) ?? null
}
