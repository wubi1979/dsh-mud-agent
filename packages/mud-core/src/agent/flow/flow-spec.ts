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
 * @module @deepseek-ai/dsh-mud-core/agent/flow/flow-spec
 */

import type { WorldModel } from '../../world/state.ts'

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

// ── W10.1 新口径：收口/分类/抽取（doc/PLAN.md §3.1；收口与分类分离） ──

/**
 * 自填正则声明：字符串按 JS `RegExp` 源码编译（编译失败在装配期/调用期报错）或直接给
 * `RegExp`。`text` kind 已取消（正则转义覆盖，PLAN §3.1）。
 */
export type RegexSpec = string | RegExp

/**
 * 收口的提前关窗条件（PLAN §3.1）。kind 全集 = `regex` / `ga`（**time kind 删除**——
 * 纯计时窗 = stream 无 `on`，时间恒由 `fallback` 管）；条件必须显式（ga 的 N / regex 的
 * pattern），缺省关窗兜底由 `fallback` 承担。
 */
export type SettleOn =
  | { kind: 'regex'; pattern: RegexSpec }
  | { kind: 'ga'; count: number }

/**
 * **收口声明**（判别式联合，只回答"窗口何时关闭"）：
 *   - `inline`：本步工具结果即收口（不开行流窗口），服务"只调工具、不发游戏命令"的步
 *     （fullme `prompt` 取图）；裁决固定映射 工具 ok→ok / error→fail。
 *   - `stream`：行流窗口；`on` 提前关窗条件（可省——纯计时窗），`fallback.ms` 兜底时长
 *     （缺省 3000 是 T2 量级短超时，T1 流程表按实际步骤耗时填写；到期恒 `timeout` 结果）。
 */
export type SettleSpec =
  | { mode: 'inline' }
  | { mode: 'stream'; on?: SettleOn; fallback?: { ms: number } }

/**
 * **分类声明**（只回答"行内容算哪一类"，与关窗解耦；全显式、形态只支持自填正则；
 * 空类 = 该类不命中、跳过）。`onSettle` 承载 `on` 条件关窗但分类未命中时的裁决
 * （缺省 `'ok'`；fullme `stale` 显式 `'fail'`）。GA/tool 不是分类 kind。
 */
export interface ClassifySpec {
  ok?: readonly RegexSpec[]
  fail?: readonly RegexSpec[]
  /** 条件分支（branch driver；判定序 fail → 分支 → ok。W10.4 T1 查表消费）。 */
  branch?: readonly { id: string; pattern: RegexSpec }[]
  /** `on` 条件关窗、分类未命中时的裁决（缺省 `'ok'`）。 */
  onSettle?: 'ok' | 'fail'
}

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

  // ── W10.1 新口径字段（PLAN §3.1 / §3.3；与上面 legacy 字段双形并存，过渡桥映射） ──
  /**
   * **收口声明**（PLAN §3.1；W10.1 新口径）。表级**显式必填**（`validateFlows` 新形校验：
   * 漏写报错，防笔误静默吃 3 秒）；inline 下声明 `classify` 报错。流程表 `captures` 在
   * inline 步合法（作用于 driver 命中行抽取；tool-call 参数面的 inline 拒绝在工具层）。
   * `normalizeFlowSpecs` 将其映射到 legacy `ok`/`fail`/`boundary`/`timeoutMs`。
   */
  settle?: SettleSpec
  /**
   * **分类声明**（PLAN §3.1；与 `settle` 解耦）。全显式自填正则；`onSettle` 承载
   * `on` 条件关窗但分类未命中时的裁决（缺省 `'ok'`；fullme `stale` 显式 `'fail'`）。
   * `normalizeFlowSpecs` 将其映射到 legacy `ok`/`fail` 行判据。
   */
  classify?: ClassifySpec
  /**
   * **抽取声明**（PLAN §3.1；JS RegExp 数组，槽名 = 命名捕获组 `(?<name>…)`）。
   * 与 `capture` 映射双形并存：`normalizeFlowSpecs` 从 `captures` 构造等价 `capture` 映射。
   * 未匹配不报错、如实缺省。
   */
  captures?: readonly RegexSpec[]
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
  /**
   * **步数预算**（流程级新字段，PLAN §3.3 / D4：防 T1 高速空转）。W10.4 T1 状态机消费；
   * W10.1 仅声明 + 装配期形态校验。
   */
  stepBudget?: number
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
    if (flow.stepBudget !== undefined && (!Number.isInteger(flow.stepBudget) || flow.stepBudget < 1)) {
      errors.push(`${flow.id}: stepBudget 必须是 >= 1 的整数（步数预算）`)
    }
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
      // W10.1: captures 命名捕获组即槽名 — 与 capture 同期收集（先于占位符校验，
      // 否则本步 action 里的 {槽名} 会被误报为未知占位符）；编译失败由步级校验报错。
      for (const pattern of step.captures ?? []) {
        const compiled = tryCompileRegex(pattern)
        if (compiled.ok === false) continue
        for (const name of captureGroupNames(compiled.value)) {
          if (slots.has(name)) errors.push(`${flow.id}: capture 槽名重复 (${name})`)
          slots.add(name)
        }
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
      // ── W10.1 新口径校验（PLAN §3.9 装配期校验；双形：有 settle 走新形，无 settle
      // 沿用 legacy 校验供测试夹具兼容，W10.5 删旧路径后收口收紧为必填）。
      if (step.settle !== undefined) {
        const settle = step.settle
        if (settle.mode === 'inline') {
          // inline 下声明 classify 报错（无行内容可分类）。**流程表 `captures` 合法**：
          // 它作用于 driver 命中行的抽取（normalize → `capture`，如 fullme `prompt`），
          // 与 3.1 tool-call 参数面"inline 拒 captures"是两个面 —— 参数面拒绝在工具层
          // （tools-build resolveSettleWindow）承担。
          if (step.classify !== undefined) errors.push(`${where}: mode:'inline' 收口下不能声明 classify（无行内容可分类）`)
        } else {
          // stream 形：on 条件显式（ga 的 count / regex 的 pattern），fallback.ms 正数。
          if (settle.on !== undefined) {
            const on = settle.on
            if (on.kind === 'ga' && (!Number.isInteger(on.count) || on.count < 1)) {
              errors.push(`${where}: settle.on ga count 必须是 >= 1 的整数`)
            }
            if (on.kind === 'regex') {
              const compiled = tryCompileRegex(on.pattern)
              if (compiled.ok === false) errors.push(`${where}: settle.on regex 编译失败 (${compiled.error})`)
            }
            // 层间不互斥（2026-09-21 二次定案）：收口触发（settle.on）与判据（classify）
            // 是两层正交概念，可共存；唯一约束是层内唯一类型（settle.on 单 kind 已结构保证）。
          }
          if (settle.fallback !== undefined && (!Number.isFinite(settle.fallback.ms) || settle.fallback.ms <= 0)) {
            errors.push(`${where}: settle.fallback.ms 必须是正数`)
          }
        }
        // classify 形态校验（与新口径一致：全 RegexSpec）。
        if (step.classify !== undefined) {
          const cls = step.classify
          for (const pattern of cls.ok ?? []) {
            const c = tryCompileRegex(pattern)
            if (c.ok === false) errors.push(`${where}: classify.ok 正则编译失败 (${c.error})`)
          }
          for (const pattern of cls.fail ?? []) {
            const c = tryCompileRegex(pattern)
            if (c.ok === false) errors.push(`${where}: classify.fail 正则编译失败 (${c.error})`)
          }
          for (const branch of cls.branch ?? []) {
            const c = tryCompileRegex(branch.pattern)
            if (c.ok === false) errors.push(`${where}: classify.branch[${branch.id}] 正则编译失败 (${c.error})`)
            if (!ids.has(branch.id)) errors.push(`${where}: classify.branch[${branch.id}] 引用了不存在的步骤`)
          }
          if (cls.onSettle !== undefined && cls.onSettle !== 'ok' && cls.onSettle !== 'fail') {
            errors.push(`${where}: classify.onSettle 只能是 'ok'/'fail' (${String(cls.onSettle)})`)
          }
        }
        // captures 形态校验：正则可编译（命名组槽名已在占位符校验之前收集，此处不重复注册）。
        if (step.captures !== undefined) {
          for (const pattern of step.captures) {
            const c = tryCompileRegex(pattern)
            if (c.ok === false) errors.push(`${where}: captures 正则编译失败 (${c.error})`)
          }
        }
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

// ── normalizeFlowSpecs（W10.1 过渡桥：新口径声明 → 现行引擎原语） ──
//
// 新口径（settle/classify/captures，PLAN §3.1）→ legacy 原语（ok/fail FlowMatch /
// boundary / timeoutMs / capture），引擎与裁决器**零改动、行为逐字段保持**；
// W10.2（裁决器与水位）/ W10.4（T1 状态机）再拆桥。legacy 步骤原样通过。

/** 编译一个 RegexSpec（validateFlows 已保证可编译；此处失败属内部错误，仍 fail loud）。 */
function compileRegex(spec: RegexSpec): RegExp {
  if (spec instanceof RegExp) return spec
  return new RegExp(spec)
}

/** 尝试编译 RegexSpec：失败返回 error 文本（装配期/调用期校验用）。 */
function tryCompileRegex(spec: RegexSpec): { ok: true; value: RegExp } | { ok: false; error: string } {
  try {
    return { ok: true, value: compileRegex(spec) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 提取正则源码里的命名捕获组名（`(?<name>…)`；字符串/RegExp 的 source 扫描）。 */
function captureGroupNames(regex: RegExp): string[] {
  const names: string[] = []
  for (const match of regex.source.matchAll(/\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>/g)) {
    names.push(match[1] as string)
  }
  return names
}

/**
 * **规范化流程表**（W10.1 过渡桥；FlowRuntime 构造器在 validateFlows 之后调用）。
 *
 * 对含新口径字段的流程逐步骤映射：
 *   - `settle:{mode:'inline'}` → `ok:[tool-ok]` + `fail:[tool-error]`（引擎"工具结果
 *     即结算"判据；error 结局本就无条件失败，双写只为声明忠实）；
 *   - `settle:{mode:'stream',on:{kind:'ga',count:N}}` → `boundary:N` + GA 判据进
 *     `ok`（`onSettle` 缺省/'ok'）或 `fail`（`onSettle:'fail'`，如 fullme `stale`）；
 *   - `settle:{mode:'stream',on:{kind:'regex',pattern}}` → 同判据的正则行判据（arming；
 *     W10.2 收口 owner 化后由窗口承担）；
 *   - `classify.ok`/`fail` 自填正则 → `ok`/`fail` 行判据（正则串在此编译为 RegExp）；
 *     `branch` 不映射（过渡期流程分支由后继 driver 的 arming 承接）；
 *   - `captures` → `capture` 映射（命名捕获组即槽名；引擎按进入判定行抽取，行为不变）；
 *   - `fallback.ms` → 步级 `timeoutMs`（显式 `timeoutMs` 优先——fullme `prompt` 的
 *     等人工步预算过渡保留）。
 *
 * 无新口径字段的步骤/流程**原样返回**（测试夹具的 legacy 表不受影响）。
 * @param flows 已通过 validateFlows 的流程表。
 * @returns 规范化后的流程表（新表；不修改入参）。
 */
export function normalizeFlowSpecs(flows: readonly FlowSpec[]): FlowSpec[] {
  return flows.map((flow) => {
    if (!flow.steps.some(step => step.settle !== undefined || step.classify !== undefined || step.captures !== undefined)) {
      return flow
    }
    return { ...flow, steps: flow.steps.map(step => normalizeStep(step)) }
  })
}

/** 单步规范化（见 normalizeFlowSpecs；无新口径字段的步骤原样返回）。 */
function normalizeStep(step: FlowStep): FlowStep {
  const settle = step.settle
  const classify = step.classify
  if (settle === undefined && classify === undefined && step.captures === undefined) return step
  const ok: FlowMatch[] = []
  const fail: FlowMatch[] = []
  const onSettleFail = classify?.onSettle === 'fail'
  if (settle?.mode === 'inline') {
    // inline：工具结果即收口（固定映射 ok→ok / error→fail）。
    ok.push({ kind: 'tool', outcome: 'ok' })
    fail.push({ kind: 'tool', outcome: 'error' })
  } else if (settle?.mode === 'stream' && settle.on !== undefined) {
    // on 条件关窗：结局由 classify.onSettle 承载（缺省 'ok'）。
    if (settle.on.kind === 'ga') {
      const ga: FlowMatch = { kind: 'ga' }
      if (onSettleFail) fail.push(ga)
      else ok.push(ga)
    } else {
      const match: FlowMatch = { kind: 'regex', patterns: [compileRegex(settle.on.pattern)] }
      if (onSettleFail) fail.push(match)
      else ok.push(match)
    }
  }
  // 分类正则 → 行判据（正则命中即结算；同帧定序 fail→分支→ok 由引擎现行判定序承担）。
  if (classify?.ok !== undefined && classify.ok.length > 0) {
    ok.push({ kind: 'regex', patterns: classify.ok.map(compileRegex) })
  }
  if (classify?.fail !== undefined && classify.fail.length > 0) {
    fail.push({ kind: 'regex', patterns: classify.fail.map(compileRegex) })
  }
  // captures → capture 映射（命名捕获组即槽名；槽在流程内唯一已由 validateFlows 校验）。
  let capture: Record<string, string | RegExp> | undefined
  if (step.captures !== undefined) {
    for (const spec of step.captures) {
      const regex = compileRegex(spec)
      const name = captureGroupNames(regex)[0]
      if (name !== undefined) capture = { ...capture, [name]: regex }
    }
  }
  // fallback.ms → 步级 timeoutMs（显式 timeoutMs 优先——等人工步预算过渡保留）。
  const timeoutMs = step.timeoutMs ?? (settle?.mode === 'stream' ? settle.fallback?.ms : undefined)
  const boundary = settle?.mode === 'stream' && settle.on?.kind === 'ga' ? settle.on.count : undefined
  return {
    ...step,
    ...(ok.length > 0 ? { ok } : {}),
    ...(fail.length > 0 ? { fail } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(boundary !== undefined ? { boundary } : {}),
    ...(capture !== undefined ? { capture } : {}),
  }
}
