/**
 * command-profiles — 命令判据总表**装配器**（T26.1；DEC-1 / DEC-15 / DEC-18 /
 * DEC-21；T26.6 三形态与形态比对合并终态 2026-10-12）。
 *
 * 表落 core3 数据面（纯层零宿主 import；§8.8 纯度裁定）：收集五个分组文件
 *（`commands/std|skill|usr|stunt|profession.ts`）导出的**构建期数组** → 把
 * `Judge` 编译为「正则数组 + 并行名表」（CompiledSlot；fail 槽位在前 = 判定序）→
 * 装配期自检 fail-loud → 导出只读总表。**无运行期注册面**：条目是仓库维护的
 * 资产，agent 不可修缮（DEC-18），调用点显式声明是唯一逃生口。
 *
 * **解析单点（DEC-21）**：`resolveAwaitPlan(sent, decl) → AwaitPlan` 是工具面
 *（mud_send / mud_walk）与流程缝（workflowIoFor 的 io.read 注入）**唯一**的
 * 收束解析入口——行为一致性由构造保证。三档与合并（DEC-5 形态比对）：
 *   - **声明（decl）**：调用点声明了判据（closeOn/outcomes）——与表条目**形态
 *     比对**：同形态 ⇒ **语义条目级合并**（同名语义条目后声明整体替换、异名追加；数值参数
 *     步声明优先、表填缺省）；异形态 ⇒ **整体替换**（「换判据形态 = 接管全部
 *     槽位」）。合并语义条目一律按**调用点 flags**（默认无）编译——不使用条目 flags
 *     （用户裁定 2026-10-12：flags 是覆盖；失活风险由保存门告警④点名）；
 *   - **表条目（table）**：未声明判据 ⇒ 整条采用（条目 flags 编译）；
 *   - **无（none）**：未声明且未登记（或凭据命令 sent=null）⇒ **不收窗只等
 *     超时**（DEC-4 终态——无兜底档；超时文案兼语料工单，DEC-22）。
 *   - 特例：`sent === ''` 归 `'ga'`（A.2 1:1 事实，不是「需要登记的命令」）；
 *     凭据命令不走表（缝侧以 `sent = null` 表达，DEC-8）。
 */

import { CLOSURE_KINDS, RESERVED_SLOT_NAMES } from 'mud-workflow/contract'
import type { ClosureKind, FlowSlotsInfo, OutcomeKind } from 'mud-workflow/contract'
import type { AnyCaptureRule, CommandProfile, Judge, SlotTable } from './define.ts'
import { STD_COMMANDS } from './std.ts'
import { SKILL_COMMANDS } from './skill.ts'
import { USR_COMMANDS } from './usr.ts'
import { STUNT_COMMANDS } from './stunt.ts'
import { PROFESSION_COMMANDS } from './profession.ts'

// ── 编译产物（正则数组 + 并行名表；读窗机匹配模型零变化，§5.2）────────

/** 编译后的结局语义条目：并行名表单元（fail 槽位排在 ok 槽位之前 = 判定序）。
 * `patterns` 保留 raw 源——同形态合并时按**调用点 flags** 重编译（DEC-5/裁定 6）。 */
export interface CompiledSlot {
  readonly name: string
  readonly kind: OutcomeKind
  /** 与语义条目 patterns 一一对应的编译正则（整条采用档 = 条目 flags；合并档重编译）。 */
  readonly res: readonly RegExp[]
  /** raw 判据源（合并重编译用）。 */
  readonly patterns: readonly string[]
}

/** 编译后的判定器形态（数据面即契约层 `ClosureKind` 三值）。 */
export interface CompiledJudge {
  readonly closeOn: ClosureKind
  /** GA 计数（ga 形态；缺省 1）。 */
  readonly gaCount?: number
  /** 语义条目集（fail 槽位在前）。 */
  readonly slots: readonly CompiledSlot[]
  /** 条目级 flags（整条采用档的编译 flags；告警④与合并档重编译参照）。 */
  readonly flags?: string
}

/** 编译后的命令条目（总表单元；只读）。 */
export interface CompiledProfile {
  readonly id: string
  readonly aliases: readonly string[]
  /** 查询/豁免子形态：命中即不套用本条目（测试对象 = 完整发送串）。 */
  readonly exempt?: RegExp
  /** 命令头匹配（对 trim 后的整条 cmd 测：首词 + 词边界）。 */
  readonly match: RegExp
  readonly timeoutMs: number
  readonly maxLines?: number
  readonly judge: CompiledJudge
  /** 条目捕获格式的规则 id 列表（T29 D7；消费面 = tool-mud 状态拉取投影识别。
   *  规则 id 独立于命令 id/别名——投影按**命令头**匹配，本字段只是归属索引）。 */
  readonly capture?: readonly string[]
  /** 语料出处（A.6 纪律；观测归因带出）。 */
  readonly corpus: string
}

// ── 装配（构建期自检 fail-loud；DEC-18）────────────────────────────

function escapeHead(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** raw 语义条目集（kind 在前）→ CompiledSlot（fail 组先编译 = 判定序；flags 应用于全部判据）。
 * 语义条目名跨槽位重名与保留字语义条目名在此 fail-loud（构建期自检，DEC-18）。 */
function compileSlots(
  outcomes: SlotTable, where: string, closeOn: ClosureKind, flags: string,
): CompiledSlot[] {
  const slots: CompiledSlot[] = []
  const seen = new Set<string>()
  for (const kind of ['fail', 'ok'] as const) {
    for (const [name, slotValue] of Object.entries(outcomes[kind] ?? {})) {
      if (RESERVED_SLOT_NAMES.includes(name)) {
        throw new Error(`命令条目装配失败：${where} 语义条目名「${name}」是保留字（ok/fail 是 kind 寻址键）`)
      }
      if (seen.has(name)) {
        throw new Error(`命令条目装配失败：${where} 语义条目名「${name}」跨槽位重名（语义条目名在 ok/fail 组内必须唯一）`)
      }
      seen.add(name)
      if (!Array.isArray(slotValue.patterns) || slotValue.patterns.length === 0) {
        // patterns ≥ 1（DP 审阅 10）：推定槽已退役，空语义条目永不命中 = 配置错误。
        throw new Error(`命令条目装配失败：${where} 语义条目「${name}」patterns 为空（登记语义条目必给判据，待实录的语义条目不登记）`)
      }
      const res = slotValue.patterns.map((src) => {
        if (typeof src !== 'string') throw new Error(`命令条目装配失败：${where} 语义条目「${name}」含非字符串判据`)
        try {
          return new RegExp(src, flags)
        } catch (e) {
          throw new Error(`命令条目装配失败：${where} 语义条目「${name}」判据正则非法: ${src}（${(e as Error).message}）`)
        }
      })
      slots.push({ name, kind, res, patterns: [...slotValue.patterns] })
    }
  }
  // 判定序由遍历序保证（fail 组先编译，fail 槽位排前；同 kind 内保持声明序）。
  // 判据收窗形态必须至少有一条可命中判据（否则只剩超时收场 = 配置错误）。
  if (closeOn === 'criteria' && slots.length === 0) {
    throw new Error(`命令条目装配失败：${where}（criteria）没有任何判据语义条目`)
  }
  return slots
}

function compileJudge(profile: CommandProfile): CompiledJudge {
  const where = `条目 ${profile.id}`
  const j: Judge = profile.resolve
  if (!(CLOSURE_KINDS as readonly string[]).includes(j.closeOn)) {
    throw new Error(`命令条目装配失败：${where} closeOn 非法：${String((j as { closeOn: unknown }).closeOn)}`)
  }
  const flags = profile.flags ?? ''
  if (j.closeOn === 'quiet') {
    // quiet：无语义条目（Judge 类型已挡）；窗长即条目 timeoutMs。
    return { closeOn: 'quiet', slots: [] }
  }
  if (j.closeOn === 'ga') {
    if (j.gaCount !== undefined && (!Number.isInteger(j.gaCount) || j.gaCount < 1)) {
      throw new Error(`命令条目装配失败：${where}（ga）gaCount 必须为正整数`)
    }
    const slots = j.outcomes !== undefined ? compileSlots(j.outcomes, where, 'ga', flags) : []
    return {
      closeOn: 'ga',
      ...(j.gaCount !== undefined ? { gaCount: j.gaCount } : {}),
      slots,
      ...(profile.flags !== undefined ? { flags: profile.flags } : {}),
    }
  }
  // criteria
  const slots = compileSlots(j.outcomes, where, 'criteria', flags)
  return {
    closeOn: 'criteria',
    slots,
    ...(profile.flags !== undefined ? { flags: profile.flags } : {}),
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
    ...(profile.capture !== undefined ? { capture: profile.capture.map(r => r.id) } : {}),
    corpus: profile.meta.corpus,
  }
}

// ── capture 装配（T29 D4：声明序由显式规范序保证，不依赖分组收集序）────

/**
 * capture 规则规范序（表格行匹配声明序 = 行匹配优先序）：i 先于 skills 堵技能行
 * 抢装备表行、hp/sc/i/skills 先于 exp。分组收集序（STD→SKILL→USR）会把 skills
 * 排到 sc/i 之前破坏现役序——故显式声明（D4）。clears 不经此装配（T29 PLAN
 * §1.3：非命令触发路径的 clears/walk/combat/id 留 tracker 本地）。
 */
export const CAPTURE_RULE_ORDER = ['hpbrief', 'hp', 'sc', 'i', 'skills', 'exp'] as const

/**
 * capture 装配（fail-loud，T29）：① 规则 id 跨条目重复；② capture 规则未入规范序。
 * 错误信息双写「规则 id + 所属命令 id」（两命名空间重叠且不对应——规则 'sc' 对应
 * 命令 score、规则 'i' 对应命令 inventory 且其别名亦为 'i'——单写易错挂）。
 * 返回按规范序排列的规则集（fixture 只登记部分规范序规则时返回子集——完整性
 * 校验属于生产装配，见 assembleProductionCaptureRules）。
 */
export function assembleCaptureRules(raw: readonly CommandProfile[]): readonly AnyCaptureRule[] {
  const byId = new Map<string, { rule: AnyCaptureRule; commandId: string }>()
  for (const p of raw) {
    for (const rule of p.capture ?? []) {
      const prev = byId.get(rule.id)
      if (prev !== undefined) {
        throw new Error(`命令条目装配失败：capture 规则 id 重复：${rule.id}（命令 ${prev.commandId} 与命令 ${p.id}）——规则 id 独立于命令 id/别名，不得跨条目重复`)
      }
      byId.set(rule.id, { rule, commandId: p.id })
    }
  }
  const out: AnyCaptureRule[] = []
  for (const id of CAPTURE_RULE_ORDER) {
    const hit = byId.get(id)
    if (hit !== undefined) out.push(hit.rule)
  }
  for (const [id, hit] of byId) {
    if (!(CAPTURE_RULE_ORDER as readonly string[]).includes(id)) {
      throw new Error(`命令条目装配失败：capture 规则 ${id}（命令 ${hit.commandId}）未入规范序 CAPTURE_RULE_ORDER`)
    }
  }
  return out
}

/** 生产 capture 装配：规范序每一条都必须有登记（缺 = CAPTURE_RULE_ORDER 与条目
 *  capture 登记不同步，fail-loud）。 */
function assembleProductionCaptureRules(raw: readonly CommandProfile[]): readonly AnyCaptureRule[] {
  const rules = assembleCaptureRules(raw)
  if (rules.length !== CAPTURE_RULE_ORDER.length) {
    const missing = CAPTURE_RULE_ORDER.filter(id => !rules.some(r => r.id === id))
    throw new Error(`命令条目装配失败：capture 规范序引用了不存在的规则 id：${missing.join('、')}（CAPTURE_RULE_ORDER 与条目 capture 登记不同步）`)
  }
  return rules
}

/** 装配：任意 raw 条目集 → 自检 → 编译（fail-loud；T28.2 起作为测试缝导出——
 * 保留字/跨槽位重名/命令头冲突/capture 重复与未入序等装配期自检的错误路径以
 * 受控 fixture 实证）。 */
export function assembleProfiles(raw: readonly CommandProfile[]): readonly CompiledProfile[] {
  assembleCaptureRules(raw) // capture 自检（T29：跨条目重复 / 未入规范序 fail-loud）
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

/** 装配：五分组收集（模块加载期执行一次；失败即启动失败）。 */
function rawProfiles(): readonly CommandProfile[] {
  return [...STD_COMMANDS, ...SKILL_COMMANDS, ...USR_COMMANDS, ...STUNT_COMMANDS, ...PROFESSION_COMMANDS]
}

/** 命令捕获规则总序（只读；生产装配自检通过才存在；tracker 缺省规则表引用，T29 D1）。 */
export const COMMAND_CAPTURE_RULES: readonly AnyCaptureRule[] = assembleProductionCaptureRules(rawProfiles())

/** 命令判据总表（只读；装配期自检通过才存在）。 */
export const COMMAND_PROFILES: readonly CompiledProfile[] = assembleProfiles(rawProfiles())

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
 * 表语义条目名查询（T26.5；mud-workflow 注册表校验端口 FlowSlotsPort 的实现）：
 * 命令命中总表条目时返回其喂令信息（形态 + 槽位含 kind + 条目 flags），未登记
 *（含空串/exempt 命中）返回 null。经 MudCore3Service 面交宿主插件注入注册表，
 * checkFlow 据此做 when 键双重校验与 DEC-13 告警（①②④）。
 */
export function tableSlotsOf(sent: string): FlowSlotsInfo | null {
  const profile = matchCommandProfile(sent)
  if (profile === null) return null
  return {
    closeOn: profile.judge.closeOn,
    slots: profile.judge.slots.map(s => ({ name: s.name, kind: s.kind })),
    ...(profile.judge.flags !== undefined ? { flags: profile.judge.flags } : {}),
  }
}

// ── 解析单点（DEC-21）：声明（形态比对合并）> 表条目 > 无 三档 ─────────

/** 调用点判据声明（raw——与流程 `wait` / 工具 `listen` 同一语法，DEC-21；
 * 由消费方从模型参数/步骤声明原样传入，编译在本函数单点完成）。 */
export interface CallerDecl {
  closeOn?: ClosureKind
  outcomes?: SlotTable
  gaCount?: number
  maxLines?: number
  timeoutMs?: number
  flags?: string
}

/**
 * 收束解析计划（DEC-21/DEC-5）：消费方（工具面 / 流程缝）据此构造 ReadOpts。
 *
 * - `declared`：调用点显式声明（异形态整体替换或无表条目时）；
 * - `table`：表条目参与（整条采用或同形态合并——`command` = 条目 id）；
 * - `empty`：空命令特例——`sent === ''` 归 `'ga'`（A.2 1:1）；
 * - `none`：未登记且未声明（或凭据命令 sent=null）⇒ **不收窗只等超时**
 *   （DEC-4 终态；超时文案兼语料工单 DEC-22 由工具面附注）。
 */
export type AwaitPlan = {
  readonly source: 'declared' | 'table' | 'empty' | 'none'
  readonly closeOn?: ClosureKind
  readonly slots?: readonly CompiledSlot[]
  readonly gaCount?: number
  readonly maxLines?: number
  /** 建议预算（table 档 = 条目法定值；调用方显式值优先）。 */
  readonly timeoutMs?: number
  /** 归因：命中的表条目 id（empty 档 = ''）。 */
  readonly command?: string
}

/** raw 语义条目集 → CompiledSlot（按给定 flags 编译；非法正则 throw 可读错）。
 * 声明未带 outcomes 视为空语义条目集（ga 形态分类语义条目可选——closeOn:'ga' 无分类 =
 * 关窗即 next；criteria 缺 outcomes 由下方「没有任何判据语义条目」检查 fail-loud）。 */
function compileDeclSlots(
  decl: CallerDecl, where: string,
): CompiledSlot[] {
  const flags = decl.flags ?? ''
  return compileSlots(decl.outcomes ?? {}, where, decl.closeOn ?? 'criteria', flags)
}

/**
 * 解析单点（DEC-21）：工具面与流程缝共用；纯函数（查只读总表，无可变状态）。
 *
 * @param sent - 实际发送的最终字符串（null = 凭据命令/无发送——不走表）。
 * @param decl - 调用点判据声明（closeOn/outcomes 任一存在 = 已声明）。
 * @throws 调用点声明判据正则非法（可读上下文）。
 */
export function resolveAwaitPlan(sent: string | null, decl?: CallerDecl): AwaitPlan {
  const declared = decl !== undefined && (decl.closeOn !== undefined || decl.outcomes !== undefined)

  // ① 调用点声明（形态比对，DEC-5）。
  if (declared && decl !== undefined) {
    if (decl.closeOn === undefined) {
      throw new Error('已拒绝：判据声明必须搭配 closeOn（收窗形态必填）')
    }
    const own = compileDeclSlots(decl, '调用点声明')
    const profile = sent !== null ? matchCommandProfile(sent) : null
    if (profile !== null && profile.judge.closeOn === decl.closeOn) {
      // 同形态 ⇒ 语义条目级合并：同名语义条目后声明整体替换、异名追加；合并语义条目一律按
      // **调用点 flags**（默认无）重编译——不使用条目 flags（裁定 6）。
      const byName = new Map(own.map(s => [s.name, s]))
      for (const slot of profile.judge.slots) {
        if (byName.has(slot.name)) continue // 同名：后声明为准（已在 own）
        byName.set(slot.name, {
          name: slot.name,
          kind: slot.kind,
          patterns: slot.patterns,
          res: slot.patterns.map(src => new RegExp(src, decl.flags ?? '')),
        })
      }
      const merged = [...byName.values()]
        .sort((a, b) => (a.kind === 'fail' ? 0 : 1) - (b.kind === 'fail' ? 0 : 1))
      return {
        source: 'table',
        closeOn: decl.closeOn,
        slots: merged,
        ...(decl.closeOn === 'ga' ? { gaCount: decl.gaCount ?? profile.judge.gaCount ?? 1 } : {}),
        ...(decl.maxLines !== undefined || profile.maxLines !== undefined
          ? { maxLines: decl.maxLines ?? profile.maxLines }
          : {}),
        ...(decl.timeoutMs !== undefined || profile.timeoutMs !== undefined
          ? { timeoutMs: decl.timeoutMs ?? profile.timeoutMs }
          : {}),
        command: profile.id,
      }
    }
    // 异形态（整体替换——「换判据形态 = 接管全部槽位」）或无表条目：声明即全部配方。
    return {
      source: 'declared',
      closeOn: decl.closeOn,
      slots: own,
      ...(decl.closeOn === 'ga' && decl.gaCount !== undefined ? { gaCount: decl.gaCount } : {}),
      ...(decl.maxLines !== undefined ? { maxLines: decl.maxLines } : {}),
      ...(decl.timeoutMs !== undefined ? { timeoutMs: decl.timeoutMs } : {}),
      ...(profile !== null ? { command: profile.id } : {}), // 归因：命中但被整体替换
    }
  }

  // ② 凭据命令 / 无发送：不走表（DEC-8），不收窗只等超时。
  if (sent === null) return { source: 'none' }

  // ③ 空命令特例（DEC-4）：显式归 'ga'（A.2 1:1），回 prompt+GA 立即收束。
  if (sent.trim() === '') {
    return { source: 'empty', closeOn: 'ga', gaCount: 1, slots: [], command: '' }
  }

  // ④ 表条目（未声明判据 ⇒ 整条采用；条目 flags 编译）。
  const profile = matchCommandProfile(sent)
  if (profile !== null) {
    return {
      source: 'table',
      closeOn: profile.judge.closeOn,
      slots: profile.judge.slots,
      ...(profile.judge.gaCount !== undefined ? { gaCount: profile.judge.gaCount } : {}),
      ...(profile.maxLines !== undefined ? { maxLines: profile.maxLines } : {}),
      timeoutMs: profile.timeoutMs,
      command: profile.id,
    }
  }

  // ⑤ 未登记：不收窗只等超时（DEC-4 终态——无兜底档；DEC-22 工单由调用方附注）。
  return { source: 'none' }
}
