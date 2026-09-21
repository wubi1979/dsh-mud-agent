/**
 * dsh-mud-core — 工具契约 (agent/tools-schema): LLM 所见声明表的类型基础。
 *
 * 从 `tools.ts` 拆出 (v0.9.3 W8, 纯文件级重组): 本模块只含**契约** ——
 * 工具统一返回 `MudToolResult`、输出 schema `OUT_SCHEMA`、工具形状
 * `MudTool`/`MudToolSchema`/`MudTools` 与调用方上下文 `MudToolCallOptions`。
 * 构建/插值 (buildMudTools + 占位符插值 + 活动表) 见 `tools-build.ts`
 * (依赖方向: build → schema, 单向)。
 * @module @deepseek-ai/dsh-mud-core/agent/tools-schema
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ReplySettle } from './inflight.ts'

/** 工具统一返回。**形态 C：只有 `{ok, note, cmd, settled}`** —— 窗口内容与分类都不进模型可见面。 */
export interface MudToolResult {
  ok: boolean
  note: string
  cmd: string
  /** 在途窗口结算方式 (发命令工具; 见 OUT_RENDER — 窗口超时/中止
   *  是"成功结果携带错误文本", 与工具层校验拒绝区分, 不加 "工具拒绝:" 前缀)。 */
  settled?: ReplySettle
}

/**
 * 输出 schema (所有工具一致)。
 * `settled` 可选: 在途窗口的结算语义 (evidence/ga/timeout/abort…), 见
 * §8.3/§8.4。工具层校验拒绝 (未连接/危险命令) 不带该字段 —
 * 缺省即"未结算"。声明为 optional 是必需的: `additionalProperties: false`
 * 下漏声明会让**成功**的调用报 `value.settled is not a declared property`
 * (工具实际已执行, 却回给模型一条失败帧)。
 */
export const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    note: { type: 'string', required: true },
    cmd: { type: 'string', required: true },
    settled: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** OUT_SCHEMA 的精确类型 (defineTool 推理用)。 */
export type MudOutputSchema = typeof OUT_SCHEMA

export const OUT_RENDER = (_args: unknown, value: MudToolResult): ContentBlock[] => [{
  type: 'text',
  // 窗口结算结果 (timeout/abort) 的 note 即应答帧文本: 它属于"窗口的失败语义", 不是
  // 工具层校验拒绝 —— 加 "工具拒绝:" 前缀会污染模型可见文本且混淆归因。
  // 仅工具层校验拒绝 (settled 未定义) 加前缀。
  text: value.ok || value.settled ? value.note : `工具拒绝: ${value.note}`,
}]

/** 一条 MUD 工具 (defineTool 兼容定义; 规则直接调用 execute)。 */
export interface MudTool {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: {
    schema: MudOutputSchema
    render: (args: unknown, value: MudToolResult) => ContentBlock[]
  }
  /**
   * 同步或异步 (装配 registerWindow 走在途窗口时为异步)。
   * @param args 模型/规则给的参数。
   * @param opts 调用方上下文 (`signal` = 回合取消信号, 转发给在途窗口; 见 §2)。
   */
  execute: (args: Record<string, unknown>, opts?: MudToolCallOptions) => MudToolResult | Promise<MudToolResult>
}

/** 一次工具调用的调用方上下文 (来自官方 `ToolRunContext`)。 */
export interface MudToolCallOptions {
  /**
   * 回合取消信号: 转发给在途窗口 (`WindowRequest.signal`)。回合被取消/超时时,
   * 在途等待优雅结算为 `settled='abort'` 而不是干等超时 (§2.1)。
   */
  signal?: AbortSignal
  /**
   * 发完即走 (不等应答): `mud_send` 只把命令**入队**, 不注册在途窗口。
   *
   * 用于**直接执行类动作** (`ActionSpec.direct`): 运行时替规则执行命令时没有"回合"
   * 可以承载应答, 等应答会把回复文本变成无主的帧内容 (谁都不需要它)。
   */
  fireAndForget?: boolean
}

/** 工具声明 (无执行体; preset 线注册工具时用)。 */
export interface MudToolSchema {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: MudTool['output']
}

/** 工具集。 */
export type MudTools = Record<string, MudTool>
