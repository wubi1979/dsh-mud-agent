/**
 * dsh-mud-core — 流程声明面契约 (flow-spec)。设计见 `doc/ARCHITECTURE.md` §19。
 *
 * **声明面契约** = 写一条流程所需要知道的一切：`FlowMatch`/`FlowStep`/`FlowSpec` 类型、
 * 判据工具（`matchLabel`/`matchKey`/`isLineMatch`）、打断档位基准（`PRIORITY_NORMAL`）、
 * 注册期校验（`validateFlows`，§19.1 校验表，FlowRuntime 构造时的 fail-loud 门）。
 *
 * 分层同构（契约 / 数据 / 引擎三处分开）：
 *   - `flow-spec.ts`（本文件）：契约 —— 类型与校验，**不含任何具体流程**；
 *   - `flows/`：数据 —— `login.ts`/`fullme.ts` 各写各的流程表，`index.ts` 汇总默认表；
 *   - `flow.ts`：引擎 —— FlowRuntime（arming/挂起/判定/打断/排队），依赖契约不依赖数据。
 *
 * 结果判据里 `GA` 是一种**判据**（不是"自动成功"）：写进 `ok` 或 `fail` 才生效；
 * 同一步的 `ok` 与 `fail` 判据集必须互斥（`validateFlows` 在装配期校验）。
 * @module @deepseek-ai/dsh-mud-core/flow/flow-spec
 */

import type { WorldModel } from '../world/state.ts'

// ── 声明面类型 ─────────────────────────────────────────

/** 结果/进入判据。`ga` = "该命令的应答被 GA 结算"（与行匹配并列的一种判据）。 */
export type FlowMatch =
  | { kind: 'regex'; patterns: readonly (string | RegExp)[]; why?: string }
  | { kind: 'text'; includes: readonly string[]; why?: string }
  | { kind: 'ga'; why?: string }
  /**
   * **工具结果判据**：本步动作（含重试动作）的**官方工具结果**是成功还是失败。
   * 供"只调工具、不发游戏命令"的步骤判定（如 fullme 的解析步）——
   * 这类步骤没有 GA 可判，靠它收尾。
   */
  | { kind: 'tool'; outcome: 'ok' | 'error'; why?: string }

/** 一步发出的工具调用声明（占位符 `{name}`/`{pass}`/`{captcha}` 在发送瞬间插值）。 */
export interface FlowAction {
  tool: string
  args: Record<string, unknown>
}

/** 进入节点即执行的副作用（不等结果）。 */
export interface FlowEnter {
  /** 落 world（点分键或 flags 里的键）。 */
  patch?: Record<string, unknown>
  /** 只发不等结果的直发命令（actor system；与 save/分页同一机制）。 */
  direct?: readonly string[]
}

/** 流程的一步（一个节点）。 */
export interface FlowStep {
  /** 步骤 id（流程内唯一；日志/状态/diag 用 `flowId/stepId`）。 */
  id: string
  /**
   * 驱动句（进入判据之一）：服务端提示行。省略 = 该节点**不能靠行进入**，
   * 只能由前驱的"顺序兜底"进入（或作为入口由 `FlowSpec.entry` 指定）。
   */
  driver?: FlowMatch
  /** 本步发出的工具调用。省略 = 判定节点（只判定与转移，不发命令）。 */
  action?: FlowAction
  /** 需要外部/人工补值的占位符名（如 `['captcha']`）→ 该步先挂起等人工。 */
  awaitExternal?: readonly string[]
  /**
   * **命中行的抽取（槽）**：`{ 槽名: 正则 }` —— 进入本步时按第一条命中的**捕获组 1**
   * （无捕获组则取整段匹配）存进**流程实例槽**，供动作参数里的 `{槽名}` 在**投递前**插值。
   * 答错重试**不重新抽取**（沿用首次抽到的值，如验证码地址）。
   */
  capture?: Readonly<Record<string, string | RegExp>>
  /** 进入本步即执行的副作用。 */
  onEnter?: FlowEnter
  /** 本步成功判据（命中即成功）。 */
  ok?: readonly FlowMatch[]
  /** 本步失败判据（命中即失败）。 */
  fail?: readonly FlowMatch[]
  /**
   * 后继步骤 id（可多分支）。两类：
   *   - 带**进入判据**的后继（`driver`，或判定节点的 `ok`/`fail` 行判据）= **条件分支**：
   *     先 arm，命中即走；同批行内优先于顺序兜底；
   *   - 无进入判据的后继 = **顺序兜底**：本节点成功后立即执行（不等待）。
   * 空 = 终态（进入即流程成功结束）。
   */
  next?: readonly string[]
  /**
   * **重试**：命中 `on`（缺省 `['driver']`）里的判据时，**在原步内重来**（不换步）。
   *
   *   - `attempts` = **总尝试次数（含首次）**，用尽才算失败；
   *   - `action` = 重试前先投的动作（缺省 = 重发本步动作）；重试时清空本步 `awaitExternal`
   *     的槽值、把命中行原文写进 `{lastFail}`、随后**重新挂起本步动作**等人工；
   *   - **不重置本步计时器**：时间预算是"一步总计"（fullme 的 `answer` = 3 分钟，
   *     等人工与答错重来共用同一份预算）。
   */
  retry?: { attempts: number; on?: readonly ('driver' | 'fail')[]; action?: FlowAction }
  /** 本步超时毫秒（缺省取 `FlowSpec.timeoutMs`）。 */
  timeoutMs?: number
  /**
   * **N-GA 边界**（W7.2 §2.2; 在途窗口覆盖声明）：本步动作的在途窗口在第 N 个
   * GA/EOR 后兜底关窗（覆盖工具内置声明; 缺省 = 命令条数）。须为 >=1 整数。
   */
  boundary?: number
  /** 被打断时要先发的直发命令（如练功的 halt）。 */
  onInterrupt?: readonly string[]
}

/** 一条流程的声明。 */
export interface FlowSpec {
  id: string
  /**
   * 打断档位（纯数字，直接比大小）：越大越不可打断，`normal = 100`。
   * 规则声明 `interrupts` 且 `interrupts > priority` 才可打断本流程（§19.4）。
   */
  priority: number
  /** 入口 arm 的前置条件（读 world）：满足才 arm 入口 driver。 */
  when?: (world: WorldModel) => boolean
  /** 入口步骤 id（缺省 = `steps[0]`）。 */
  entry?: string
  steps: readonly FlowStep[]
  /** 每步缺省超时（毫秒）。 */
  timeoutMs?: number
  /** 流程整体成功后的动作。 */
  onSuccess?: FlowEnter & { commands?: readonly string[] }
  /** 失败/超时出口（缺省 `{ notify: 't2' }`）。 */
  failPolicy?: { notify?: 't2' | 'none' }
}

// ── 判据工具 ───────────────────────────────────────────

/** 打断档位的基准值（纯数字比较；越大越不可打断）。 */
export const PRIORITY_NORMAL = 100

/** 一条判据的可读标识（日志/冲突留痕用；不含 `why`）。 */
export function matchLabel(match: FlowMatch): string {
  switch (match.kind) {
    case 'ga':
      return 'GA'
    case 'tool':
      return `tool(${match.outcome})`
    case 'text':
      return `text(${match.includes.join('|')})`
    case 'regex':
      return `regex(${match.patterns.map(p => String(p)).join('|')})`
  }
}

/** 判据键（互斥校验 / 去重用：把同一判据归一成可比字符串）。 */
export function matchKey(match: FlowMatch): string {
  return matchLabel(match)
}

/** 判据是否参与"行匹配"（`ga`/`tool` 不参与：它们针对本步自己的命令/工具结果）。 */
export function isLineMatch(match: FlowMatch): match is Extract<FlowMatch, { kind: 'regex' | 'text' }> {
  return match.kind === 'regex' || match.kind === 'text'
}

// ── 注册期校验（§19.1 校验表；FlowRuntime 构造时调用） ──

/**
 * 注册期校验（装配时调用）。
 *
 * 违反即**返回错误清单**（调用方据此留痕并拒绝装配该流程，fail loud）：
 *   - 流程 id / 步骤 id 唯一；
 *   - `entry`（缺省 `steps[0]`）存在；`next` 引用的步骤存在；
 *   - 同一步的 `ok` 与 `fail` 判据集**互斥**（同一判据不得两边都写；`GA` 不得两边都写）；
 *   - `awaitExternal` 的占位符必须出现在 `action.args` 的命令里；
 *   - `tool` 判据只能出现在有动作的步骤上；`retry` 声明合法（`attempts`/`on`/有动作）；
 *   - 动作参数里的每个 `{…}` 都必须是已知占位符（凭据 / `{lastFail}` / 本流程 `capture` 槽 /
 *     `awaitExternal` 声明的外部值）；
 *   - `capture` 槽名在流程内唯一。
 * @param flows 待校验的流程表。
 * @returns 错误清单（空 = 全部合法）。
 */
export function validateFlows(flows: readonly FlowSpec[]): string[] {
  const errors: string[] = []
  const seenFlows = new Set<string>()
  for (const flow of flows) {
    if (seenFlows.has(flow.id)) errors.push(`流程 id 重复: ${flow.id}`)
    seenFlows.add(flow.id)
    if (!Number.isFinite(flow.priority)) errors.push(`${flow.id}: priority 必须是有限数字`)
    const ids = new Set(flow.steps.map(step => step.id))
    if (ids.size !== flow.steps.length) errors.push(`${flow.id}: 步骤 id 有重复`)
    const entry = flow.entry ?? flow.steps[0]?.id
    if (entry === undefined || !ids.has(entry)) {
      errors.push(`${flow.id}: entry 不存在 (${String(flow.entry)})`)
    }
    // 已知占位符: 凭据 + 内建槽 + 本流程 capture 槽 + awaitExternal 声明的外部值。
    const slots = new Set<string>()
    const externalKeys = new Set<string>()
    for (const step of flow.steps) {
      for (const name of Object.keys(step.capture ?? {})) {
        if (slots.has(name)) errors.push(`${flow.id}: capture 槽名重复 (${name})`)
        slots.add(name)
      }
      for (const key of step.awaitExternal ?? []) externalKeys.add(key)
    }
    const knownSlots = new Set<string>(['name', 'pass', 'lastFail', ...slots, ...externalKeys])
    for (const step of flow.steps) {
      const where = `${flow.id}/${step.id}`
      for (const next of step.next ?? []) {
        if (!ids.has(next)) errors.push(`${where}: next 引用了不存在的步骤 ${next}`)
      }
      const okKeys = new Set((step.ok ?? []).map(matchKey))
      for (const fail of step.fail ?? []) {
        if (okKeys.has(matchKey(fail))) {
          errors.push(`${where}: ok 与 fail 判据重叠 (${matchLabel(fail)}) — 同一步骤的 ok/fail 必须互斥`)
        }
      }
      if (step.driver !== undefined && okKeys.has(matchKey(step.driver))) {
        errors.push(`${where}: driver 与 ok 判据重叠 (${matchLabel(step.driver)})`)
      }
      for (const key of step.awaitExternal ?? []) {
        const text = commandText(step.action)
        if (!text.includes(`{${key}}`)) {
          errors.push(`${where}: awaitExternal 声明了 {${key}}，但 action.args 里没有该占位符`)
        }
      }
      // 工具结果判据要有动作可判（本步动作或重试动作）。
      if ([...(step.ok ?? []), ...(step.fail ?? [])].some(match => match.kind === 'tool')
        && step.action === undefined && step.retry?.action === undefined) {
        errors.push(`${where}: tool 判据需要本步有 action 或 retry.action`)
      }
      // 重试声明。
      if (step.retry !== undefined) {
        const retry = step.retry
        if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
          errors.push(`${where}: retry.attempts 必须是 >= 1 的整数 (总尝试次数, 含首次)`)
        }
        for (const on of retry.on ?? []) {
          if (on !== 'driver' && on !== 'fail') errors.push(`${where}: retry.on 只能是 'driver'/'fail' (${String(on)})`)
        }
        if ((retry.on ?? ['driver']).includes('driver') && step.driver === undefined) {
          errors.push(`${where}: retry.on 含 'driver'，但本步没有 driver`)
        }
        if (retry.action === undefined && step.action === undefined) {
          errors.push(`${where}: retry 需要本步有 action 或声明 retry.action`)
        }
      }
      // N-GA 边界 (W7.2): 在途窗口兜底关窗声明。
      if (step.boundary !== undefined && (!Number.isInteger(step.boundary) || step.boundary < 1)) {
        errors.push(`${where}: boundary 必须是 >= 1 的整数 (N-GA 兜底关窗)`)
      }
      // 动作参数的占位符必须在已知集合里（拼错占位符会在发送时才炸 → 注册期就拦下）。
      for (const raw of actionStrings(step.action)) {
        for (const match of raw.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
          const key = match[1] as string
          if (!knownSlots.has(key)) {
            errors.push(`${where}: 未知占位符 {${key}} — 只能引用 {name}/{pass}/{lastFail}/capture 槽/awaitExternal 声明的值`)
          }
        }
      }
      if (step.action === undefined && step.driver === undefined && step.ok === undefined && step.fail === undefined) {
        // 纯终态节点合法（进入即成功）；什么都不做的中间节点是笔误。
        if ((step.next ?? []).length > 0) errors.push(`${where}: 空节点却声明了 next（无判据可触发转移）`)
      }
    }
  }
  return errors
}

/** 取动作参数里的命令文本（用于占位符校验；`cmd` 与 `cmds` 都看）。 */
function commandText(action: FlowAction | undefined): string {
  if (action === undefined) return ''
  const args = action.args
  const single = typeof args.cmd === 'string' ? [args.cmd] : []
  const series = Array.isArray(args.cmds) ? args.cmds.filter((c): c is string => typeof c === 'string') : []
  return [...single, ...series].join('\n')
}

/** 动作参数里的全部字符串（占位符校验；含 `cmds` 序列与其它字符串参数，如 `url`/`note`）。 */
function actionStrings(action: FlowAction | undefined): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const one of value) walk(one); return }
    if (typeof value === 'object' && value !== null) {
      for (const one of Object.values(value as Record<string, unknown>)) walk(one)
    }
  }
  if (action !== undefined) walk(action.args)
  return out
}
