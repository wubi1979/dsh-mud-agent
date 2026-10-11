/**
 * command-profiles — 命令判据总表**装配器**（T26.1；DEC-1 / DEC-15 / DEC-18 / DEC-21）。
 *
 * 表落 core3 数据面（纯层零宿主 import；§8.8 纯度裁定）：收集五个分组文件
 *（`commands/std|skill|usr|stunt|profession.ts`）导出的**构建期数组** → 把
 * `Judge` 编译为「正则数组 + 并行名表」（CompiledSlot；fail 槽在前 = 判定序
 * `failOn > until`）→ 装配期自检 fail-loud → 导出只读总表。**无运行期注册面**：
 * 条目是仓库维护的资产，agent 不可修缮（DEC-18），调用点显式声明是唯一逃生口。
 *
 * **解析单点**（DEC-21）：`resolveAwaitPlan(sent, decl) → AwaitPlan` 是工具面
 *（mud_send / mud_walk）与流程缝（workflowIoFor 的 io.read 注入）**唯一**的
 * 收束解析入口——行为一致性由构造保证，不靠「两处都查同一张表」的纪律。
 * 三档：explicit（调用点显式声明）> table（表条目）> fallback（翻转前兜底，
 * T26.7 翻转后删除）；特例：`sent === ''` 归 `'ga'`（A.2 1:1 事实直接覆盖），
 * 凭据命令不走表（缝侧以 `sent = null` 表达）。
 */

import { CLOSURE_KINDS, OUTCOME_NAMES } from 'mud-workflow/contract'
import type { ClosureKind, OutcomeKind, OutcomeName } from 'mud-workflow/contract'
import type { CommandProfile, Judge } from './commands/define.ts'
import { STD_COMMANDS } from './commands/std.ts'
import { SKILL_COMMANDS } from './commands/skill.ts'
import { USR_COMMANDS } from './commands/usr.ts'
import { STUNT_COMMANDS } from './commands/stunt.ts'
import { PROFESSION_COMMANDS } from './commands/profession.ts'

// ── 编译产物（正则数组 + 并行名表；读窗机匹配模型零变化，§5.2）────────

/** 编译后的结局槽：并行名表单元（fail 槽排在 ok 槽之前 = 判定序 failOn > until）。 */
export interface CompiledSlot {
  readonly name: OutcomeName
  readonly kind: OutcomeKind
  /** 与槽 patterns 一一对应的编译正则（推定槽为空数组）。 */
  readonly res: readonly RegExp[]
}

/** 编译后的判定器形态（数据面即契约层 `ClosureKind` 四值）。 */
export interface CompiledJudge {
  readonly closeOn: ClosureKind
  /** 静默毫秒（race/quiet 形态）。 */
  readonly quietMs?: number
  /** 槽表（fail 槽在前；推定槽 patterns 为空）。 */
  readonly slots: readonly CompiledSlot[]
}

/** 编译后的命令条目（总表单元；只读）。 */
export interface CompiledProfile {
  readonly id: string
  readonly aliases: readonly string[]
  /** 查询/豁免子形态：命中即不套用本条目。 */
  readonly exempt?: RegExp
  /** 命令头匹配（对 trim 后的整条 cmd 测：首词 + 词边界）。 */
  readonly match: RegExp
  readonly timeoutMs: number
  readonly maxLines?: number
  readonly judge: CompiledJudge
  /** 语料出处（A.6 纪律；观测归因带出）。 */
  readonly corpus: string
}

// ── 装配（构建期自检 fail-loud；DEC-18）────────────────────────────

const OUTCOME_NAME_SET: ReadonlySet<string> = new Set<string>(OUTCOME_NAMES)

function escapeHead(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileSlot(name: string, slotValue: { kind: OutcomeKind; patterns: readonly string[] }, where: string, closeOn: ClosureKind): CompiledSlot {
  if (!OUTCOME_NAME_SET.has(name)) {
    throw new Error(`命令条目装配失败：${where} 引用枚举外结局名「${name}」（枚举见 mud-workflow/contract OUTCOME_NAMES）`)
  }
  if (slotValue.kind !== 'ok' && slotValue.kind !== 'fail') {
    throw new Error(`命令条目装配失败：${where} 槽「${name}」kind 非法：${String(slotValue.kind)}`)
  }
  if (!Array.isArray(slotValue.patterns)) {
    throw new Error(`命令条目装配失败：${where} 槽「${name}」patterns 必须是数组`)
  }
  const res = slotValue.patterns.map((src) => {
    if (typeof src !== 'string') throw new Error(`命令条目装配失败：${where} 槽「${name}」含非字符串判据`)
    try {
      return new RegExp(src)
    } catch (e) {
      throw new Error(`命令条目装配失败：${where} 槽「${name}」判据正则非法: ${src}（${(e as Error).message}）`)
    }
  })
  // 推定槽（patterns: []）只允许出现在 race/quiet（静默机制填）；判据收窗形态
  // 下空槽永不命中 = 配置错误，装配期 fail-loud（§3.2 / §3.5 第 3 档）。
  if (res.length === 0 && closeOn !== 'race' && closeOn !== 'quiet') {
    throw new Error(`命令条目装配失败：${where} 槽「${name}」patterns 为空（推定槽只允许出现在 race/quiet 形态）`)
  }
  return { name: name as OutcomeName, kind: slotValue.kind, res }
}

function compileJudge(profile: CommandProfile): CompiledJudge {
  const where = `条目 ${profile.id}`
  const j: Judge = profile.resolve
  if (!(CLOSURE_KINDS as readonly string[]).includes(j.closeOn)) {
    throw new Error(`命令条目装配失败：${where} closeOn 非法：${String((j as { closeOn: unknown }).closeOn)}`)
  }
  if ((j.closeOn === 'race' || j.closeOn === 'quiet') && (!Number.isInteger(j.quietMs) || j.quietMs < 1)) {
    throw new Error(`命令条目装配失败：${where}（${j.closeOn}）quietMs 必须为正整数`)
  }
  const slots: CompiledSlot[] = []
  for (const [name, slotValue] of Object.entries(j.outcomes ?? {})) {
    if (slotValue === undefined) continue
    slots.push(compileSlot(name, slotValue, where, j.closeOn))
  }
  // 判定序 fail > ok（对应 failOn > until）：fail 槽稳定排前。
  const weight = (s: CompiledSlot): number => (s.kind === 'fail' ? 0 : 1)
  slots.sort((a, b) => weight(a) - weight(b))
  // 判据收窗形态必须至少有一条可命中判据（否则只剩超时收场 + 失配 error = 配置错误）。
  if ((j.closeOn === 'criteria' || j.closeOn === 'race')
    && !slots.some(s => s.res.length > 0)) {
    throw new Error(`命令条目装配失败：${where}（${j.closeOn}）没有任何非空判据槽`)
  }
  return {
    closeOn: j.closeOn,
    ...(j.closeOn === 'race' || j.closeOn === 'quiet' ? { quietMs: j.quietMs } : {}),
    slots,
  }
}

function compileProfile(profile: CommandProfile): CompiledProfile {
  if (!/^\S+$/.test(profile.id)) {
    throw new Error(`命令条目装配失败：id 含空白字符：${profile.id}`)
  }
  const heads = [profile.id, ...profile.aliases]
  return {
    id: profile.id,
    aliases: [...profile.aliases],
    ...(profile.exempt !== undefined ? { exempt: profile.exempt } : {}),
    match: new RegExp(`^(?:${heads.map(escapeHead).join('|')})(\\s|$)`),
    timeoutMs: profile.timeoutMs,
    ...(profile.maxLines !== undefined ? { maxLines: profile.maxLines } : {}),
    judge: compileJudge(profile),
    corpus: profile.meta.corpus,
  }
}

/** 装配：五分组收集 → 自检 → 编译（模块加载期执行一次；失败即启动失败）。 */
function assemble(): readonly CompiledProfile[] {
  const raw: readonly CommandProfile[] = [
    ...STD_COMMANDS, ...SKILL_COMMANDS, ...USR_COMMANDS, ...STUNT_COMMANDS, ...PROFESSION_COMMANDS,
  ]
  const seen = new Set<string>()
  const out: CompiledProfile[] = []
  for (const p of raw) {
    const heads = [p.id, ...p.aliases]
    for (const h of heads) {
      if (seen.has(h)) {
        throw new Error(`命令条目装配失败：命令头冲突：${h}（id/aliases 不得与他条目重复）`)
      }
      seen.add(h)
    }
    out.push(compileProfile(p))
  }
  return out
}

/** 命令判据总表（只读；装配期自检通过才存在）。 */
export const COMMAND_PROFILES: readonly CompiledProfile[] = assemble()

/**
 * cmd 头匹配条目（缝侧对**最终发送串**匹配，DEC-8：流程命令带槽替换，必须
 * 替换后匹配；exempt 命中即不套用本条目）。未命中返回 null。
 */
export function matchCommandProfile(sent: string): CompiledProfile | null {
  const c = sent.trim()
  if (c === '') return null
  for (const p of COMMAND_PROFILES) {
    if (p.exempt !== undefined && p.exempt.test(c)) continue
    if (p.match.test(c)) return p
  }
  return null
}

/**
 * 表槽名查询（T26.5；mud-workflow 注册表校验端口 FlowSlotsPort 的实现）：
 * 命令命中总表条目时返回其槽名序列（fail 槽在前 = 判定序），未登记（含空串/
 * exempt 命中）返回 null。经 MudCore3Service 面交宿主插件注入注册表，
 * checkFlow 据此把 onOutcome/captureFrom 引用对到表槽集。
 */
export function tableSlotsOf(sent: string): readonly string[] | null {
  const profile = matchCommandProfile(sent)
  return profile === null ? null : profile.judge.slots.map(s => s.name)
}

// ── 解析单点（DEC-21）：explicit > table > fallback 三档 ─────────────

/** 调用点显式判据（listen 编译产物；T26 保留现役 listen 形态——机制数组是
 * 工具面既有词汇，槽表收敛随 T26.6 流程侧词汇一并定稿）。 */
export interface ListenDecl {
  until?: readonly RegExp[]
  failOn?: readonly RegExp[]
  gaCount?: number
  quietMs?: number
  maxLines?: number
}

/** 调用点声明（resolveAwaitPlan 第二参）。 */
export interface CallerDecl {
  /** 非空 = 调用点显式声明（整体走遗留判据形态，语义与现役显式 listen 一致）。 */
  listen?: ListenDecl
}

/**
 * 收束解析计划（三档，DEC-21）：消费方（工具面 / 流程缝）据此构造 ReadOpts。
 *
 * - `explicit`：调用点显式声明（遗留判据形态：until/failOn/gaCount/quietMs/maxLines）；
 * - `empty`：空命令特例——`sent === ''` 归 `'ga'`（A.2 1:1，不是「需要登记的命令」）；
 * - `table`：命中表条目（形态 + 槽表 + 条目预算；`timeoutMs` 为条目建议值）；
 * - `fallback`：未登记命令的**翻转前兜底**（DEC-4 第一步：暂按 `gaCount: 1`
 *   边界收窗；T26.7 覆盖审计通过后翻转为「不收窗只等超时」并给语料工单文案）。
 *
 * 归因：`command` = 命中的表条目 id（empty 档 = ''；explicit/fallback 档缺省）。
 * 凭据命令不走表：流程缝以 `sent = null` 表达，不进入本函数。
 */
export type AwaitPlan = {
  readonly source: 'explicit' | 'empty' | 'table' | 'fallback'
  /** 形态（table/empty 档；explicit/fallback 档缺省 = 遗留判据语义）。 */
  readonly closeOn?: ClosureKind
  /** 槽表编译产物（table/empty 档）。 */
  readonly slots?: readonly CompiledSlot[]
  /** 遗留判据（explicit 档 = 调用点 listen；fallback 档 = gaCount:1 兜底）。 */
  readonly until?: readonly RegExp[]
  readonly failOn?: readonly RegExp[]
  readonly gaCount?: number
  readonly quietMs?: number
  readonly maxLines?: number
  /** 条目建议预算（table 档；explicit/fallback 档缺省 = 调用方标准缺省）。 */
  readonly timeoutMs?: number
  /** 归因：命中的表条目 id（empty 档 = ''）。 */
  readonly command?: string
}

/** 解析单点（DEC-21）：工具面与流程缝共用；纯函数（查只读总表，无可变状态）。 */
export function resolveAwaitPlan(sent: string, decl?: CallerDecl): AwaitPlan {
  const listen = decl?.listen
  if (listen !== undefined && Object.keys(listen).length > 0) {
    return {
      source: 'explicit',
      ...(listen.until !== undefined ? { until: listen.until } : {}),
      ...(listen.failOn !== undefined ? { failOn: listen.failOn } : {}),
      ...(listen.gaCount !== undefined ? { gaCount: listen.gaCount } : {}),
      ...(listen.quietMs !== undefined ? { quietMs: listen.quietMs } : {}),
      ...(listen.maxLines !== undefined ? { maxLines: listen.maxLines } : {}),
    }
  }
  const trimmed = sent.trim()
  if (trimmed === '') {
    // 空命令特例（DEC-4）：显式归 'ga'，回 prompt+GA 立即收束。
    return { source: 'empty', closeOn: 'ga', slots: [], command: '' }
  }
  const profile = matchCommandProfile(trimmed)
  if (profile !== null) {
    return {
      source: 'table',
      closeOn: profile.judge.closeOn,
      slots: profile.judge.slots,
      ...(profile.judge.quietMs !== undefined ? { quietMs: profile.judge.quietMs } : {}),
      ...(profile.maxLines !== undefined ? { maxLines: profile.maxLines } : {}),
      timeoutMs: profile.timeoutMs,
      command: profile.id,
    }
  }
  // 翻转前兜底（DEC-4 第一步）：未登记命令暂按 gaCount:1 边界收窗（现状行为）。
  return { source: 'fallback', gaCount: 1 }
}
