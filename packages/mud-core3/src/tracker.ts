/**
 * mud-core3 tracker — 状态追踪器（T19）：游戏文本 → World 结构化状态（判据解析，零 LLM）。
 *
 * 每会话一个实例，在 runtime 行路径 `classifier.mark(line)` 之后 `observe(line)`（D1，
 * 与 C5.2 打标同一单点）。三类形状（D3）：
 *   - `table`：框线表格块（`┌` 开、`└` 闭；`├` 边框行可携带中文节标题）。块内每行
 *     **就地打 `status` 标**（D8 剔除投递 + 副屏行环；kind 必须在 observe 内同步定案
 *     —— screen.write 在行路径随行路由，事后补标对画面无效）。World 写入仍需
 *     **规则命中**（行级 match，声明序首个命中者独占该行）；无命中的块只剔不写。
 *   - `lines`：块外逐行规则（`id` 别称表）；命中即打标即写。
 *   - `sequence`：`^#` 起连续 N 行定长位置映射（hpbrief）。首行命中规则 head 即开序
 *     列并逐行打标；凑齐 length 行后**逐行 match 全部成功才写**（D5 完整性校验，
 *     任一行不合格 ⇒ 整组不写不猜；已打的标保留——`#` 机器行本属噪声）。
 *
 * 跨行状态只保留「in-block（section）+ in-sequence」这一点（§2.1 最小状态机）。
 * clear 规则（D9）对任意行生效：行文命中即消解 World 条目（删除，不是写空）。
 *
 * 断线复位：reset() 清块/序列状态（in-block 状态不跨连接；World 整体复位另有
 * runtime.onDisconnect 负责）。
 *
 * 打标语义（用户裁定 2026-10-06）：只对 `kind === null` 的行打标（C5.2 规则优先，
 * 聊天/动作行不误剔）；已有标行仍参与块状态机（框线边界不漏）。
 *
 * 纯 TS，零宿主依赖。
 *
 * @module mud-core3/tracker
 */

import type { MudLine } from './link/line.ts'

/** 追踪打标 kind（D8）：打此标的行不进 agent 投递（deliver 剔除）、进副屏行环。 */
export const STATUS_KIND = 'status'

/** 追踪形状（D3）。 */
export type TrackShape = 'table' | 'lines' | 'sequence'

/** 单条追踪产出（zone 缺省 = 所属规则的 zone）。 */
export interface TrackEntry {
  readonly key: string
  readonly value: unknown
  readonly zone?: string
}

/** 规则匹配的行上下文。raw = 本行 text（无 ANSI 变体，同 classify 判据匹配面）。 */
export interface RowContext {
  readonly cells: readonly string[]
  readonly raw: string
  readonly section?: string
  readonly index: number
}

/** 追踪规则：match 返回 0..n 条产出（`undefined` = 本规则不匹配该行）。 */
export interface TrackRule {
  readonly id: string
  readonly shape: TrackShape
  readonly zone: string
  readonly match: (row: RowContext) => TrackEntry[] | undefined
}

/** 全形状规则联合（sequence 附带 head/length）。 */
export type AnyTrackRule = TrackRule | SequenceTrackRule

/** sequence 规则：head 命中即开序列，连续 length 行凑齐后逐行 match，全成才写（D5）。 */
export interface SequenceTrackRule extends TrackRule {
  readonly shape: 'sequence'
  readonly head: RegExp
  readonly length: number
}

/** clear 规则（D9）：行文命中即消解 World 条目（按例证逐条加）。 */
export interface TrackClearRule {
  readonly pattern: RegExp
  readonly zone: string
  readonly key: string
}

/** 追踪规则集（可注入覆盖；缺省 DEFAULT_TRACK_SPEC）。 */
export interface TrackSpec {
  readonly rules: readonly AnyTrackRule[]
  readonly clears?: readonly TrackClearRule[]
}

/** 追踪器写/消解回调（runtime 薄封装进 World + onWorldChange 广播）。 */
export interface StateTrackerDeps {
  onWrite(zone: string, key: string, value: unknown): void
  onDelete(zone: string, key: string): void
}

// ── 框线表格判据（§2.1；实录出处见 A.7）─────────────────────────────

const TABLE_OPEN_RE = /^┌/
const TABLE_ROW_RE = /^│/
const TABLE_BORDER_RE = /^├/
const TABLE_CLOSE_RE = /^└/
/** 节标题提取：边框行（├…┤）内首个 ≥2 字的中文连串（如 基本功夫/特殊功夫/杂学）。 */
const SECTION_CJK_RE = /[\u4e00-\u9fff]{2,}/

/** 表格块行数护栏：超限视为失控块（无 └ 收尾），强制闭块止损。 */
const MAX_TABLE_LINES = 120

/** 按 `│` 切行 cell（trim；去掉首尾边界产物空串，中间空 cell 保留由规则忽略）。 */
function splitRowCells(text: string): string[] {
  const parts = text.split('│').map(s => s.trim())
  while (parts.length > 0 && parts[0] === '') parts.shift()
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// ── hpbrief：定长 3 行位置映射（§2.2 已定稿 18 位表；实录 2026-10-06 同刻校准）──

/** hpbrief 单行判据：恰好 6 个纯数字 cell（D5 完整性校验的一部分；不满足整组不写）。
 *  负号合法：气血可为 -1（A.8.1 死亡断面实录 `#313,193,-1,…`；A.8.4：气血 <= 0
 *  不是死亡判据，状态须照写）。 */
const HPBRIEF_CELL_RE = /^-?\d+$/

/**
 * hpbrief 行映射（按行序 index）：
 *   L1 经验/潜能/最大内力/内力/最大精力/精力；L2 气血上限/最大气血/气血/精神上限/最大精神/精神；
 *   L3 真气/战意/食物/饮水/战斗中(0/1)/忙(0/1)。战斗中/忙是布尔枚举 → combat 分区。
 */
function hpbriefRow(row: RowContext): TrackEntry[] | undefined {
  if (row.cells.length !== 6) return undefined
  const nums: number[] = []
  for (const c of row.cells) {
    if (!HPBRIEF_CELL_RE.test(c)) return undefined
    nums.push(Number.parseInt(c, 10))
  }
  switch (row.index) {
    case 0:
      return [
        { key: '经验', value: nums[0] }, { key: '潜能', value: nums[1] },
        { key: '最大内力', value: nums[2] }, { key: '内力', value: nums[3] },
        { key: '最大精力', value: nums[4] }, { key: '精力', value: nums[5] },
      ]
    case 1:
      return [
        { key: '气血上限', value: nums[0] }, { key: '最大气血', value: nums[1] }, { key: '气血', value: nums[2] },
        { key: '精神上限', value: nums[3] }, { key: '最大精神', value: nums[4] }, { key: '精神', value: nums[5] },
      ]
    case 2:
      return [
        { key: '真气', value: nums[0] }, { key: '战意', value: nums[1] },
        { key: '食物', value: nums[2] }, { key: '饮水', value: nums[3] },
        { key: '战斗中', value: nums[4] !== 0, zone: 'combat' }, { key: '忙', value: nums[5] !== 0, zone: 'combat' },
      ]
    default:
      return undefined
  }
}

// ── hp：框线表格规则（§2.3 兜底 + 只有表格才有的文本状态；片段先行，待实录校准）──

const NUM_RE = /\s*(\d+)\s*/
/** `X / Y` 共用片段（校准结论①：X = 当前，Y = 最大）。 */
const CUR_MAX = `${NUM_RE.source}\\/\\s*(\\d+)`
/** 可选括号加成 `(+ N)`（括号前允许空格）。 */
const OPT_BONUS = `(?:\\s*\\(\\s*\\+\\s*(\\d+)\\s*\\))?`
/** 可选方括号状态 `[文本]`（括号前允许空格）。 */
const OPT_STATE = `(?:\\s*\\[([^\\]]*)\\])?`

/** hp 行解析模式表：对行 text（无 ANSI）逐式扫描，一行可命中多式（一行可两事实）。 */
interface HpPattern {
  readonly re: RegExp
  readonly build: (m: RegExpExecArray) => TrackEntry[]
}

function n(s: string | undefined): number {
  return Number.parseInt(s ?? '0', 10)
}

const HP_PATTERNS: readonly HpPattern[] = [
  { re: new RegExp(`【精神】${CUR_MAX}`), build: m => [{ key: '精神', value: n(m[1]) }, { key: '最大精神', value: n(m[2]) }] },
  { re: new RegExp(`【气血】${CUR_MAX}`), build: m => [{ key: '气血', value: n(m[1]) }, { key: '最大气血', value: n(m[2]) }] },
  // §2.3：真气只写当前值（括号百分比/上限按需后补）。
  { re: new RegExp(`【真气】${CUR_MAX}`), build: m => [{ key: '真气', value: n(m[1]) }] },
  { re: new RegExp(`【精力】${CUR_MAX}${OPT_BONUS}`), build: m => [
      { key: '精力', value: n(m[1]) }, { key: '最大精力', value: n(m[2]) },
      ...(m[3] !== undefined ? [{ key: '精力加成', value: n(m[3]) } as TrackEntry] : []),
    ] },
  { re: new RegExp(`【内力】${CUR_MAX}${OPT_BONUS}`), build: m => [
      { key: '内力', value: n(m[1]) }, { key: '最大内力', value: n(m[2]) },
      ...(m[3] !== undefined ? [{ key: '内力加成', value: n(m[3]) } as TrackEntry] : []),
    ] },
  // 【静气】80% ≡ hpbrief 战意 80（校准结论②，合一个键）。
  { re: /【静气】\s*(\d+)\s*%/, build: m => [{ key: '战意', value: n(m[1]) }] },
  { re: new RegExp(`【食物】${CUR_MAX}${OPT_STATE}`), build: m => [
      { key: '食物', value: n(m[1]) }, { key: '最大食物', value: n(m[2]) },
      ...(m[3] !== undefined && m[3] !== '' ? [{ key: '食物状态', value: m[3] } as TrackEntry] : []),
    ] },
  { re: new RegExp(`【饮水】${CUR_MAX}${OPT_STATE}`), build: m => [
      { key: '饮水', value: n(m[1]) }, { key: '最大饮水', value: n(m[2]) },
      ...(m[3] !== undefined && m[3] !== '' ? [{ key: '饮水状态', value: m[3] } as TrackEntry] : []),
    ] },
  { re: /【潜能】\s*(\d+)/, build: m => [{ key: '潜能', value: n(m[1]) }] },
  { re: /【经验】\s*(\d+)/, build: m => [{ key: '经验', value: n(m[1]) }] },
  // 【状态】健康、极度疲倦 → 数组（只有 hp 表格有的自由文本；捕获止于 cell 边界）。
  { re: /【状态】\s*([^│\]]+)/, build: m => [{
      key: '状态',
      value: (m[1] ?? '').split('、').map(s => s.trim()).filter(s => s !== ''),
    }] },
]

/** hp 表格行解析：所有模式扫一遍，收集全部命中（0 命中 = 不匹配该行）。 */
function hpRow(row: RowContext): TrackEntry[] | undefined {
  const out: TrackEntry[] = []
  for (const p of HP_PATTERNS) {
    const m = p.re.exec(row.raw)
    if (m !== null) out.push(...p.build(m))
  }
  return out.length > 0 ? out : undefined
}

// ── sc（character，§2.4 分批①：八维 + 存款/杀气/门派履历/上榜差经验；待实录校准）──

/** 八维（允许 `?`——D7「未知」本身是有用信息，保留不猜）。 */
const SC_OCTA_RE = /(膂力|悟性|根骨|身法|福缘|容貌|灵性|胆识)[:：]\s*\[([^\]]*)\]/g
/** 数字型标签：存款/杀气/门忠/上榜差经验（千分位逗号剥除后取整）。 */
const SC_NUM_RE = /(存款|杀气|门忠|上榜差经验)[:：=]?\s*([\d,，]+)/g
/** 文本型标签：门派履历（门派/师承/出师/叛师 → 原文）。 */
const SC_TEXT_RE = /(门派|师承|出师|叛师)[:：]\s*([^│\]]+)/g
/** 头衔与姓名：`武当派第四代弟子 夫差(Vicrly)`（待实录校准）。 */
const SC_TITLE_RE = /([\u4e00-\u9fff]+第.{1,6}弟子)\s+([\u4e00-\u9fff]{1,8})\(([^)]+)\)/

/** 标签值收口：纯数字取整，其余原文（trim）。 */
function scValue(raw: string): number | string {
  return /^[\d,，]+$/.test(raw) ? Number.parseInt(raw.replace(/[,，]/g, ''), 10) : raw.trim()
}

function scRow(row: RowContext): TrackEntry[] | undefined {
  const out: TrackEntry[] = []
  for (const re of [SC_OCTA_RE, SC_NUM_RE, SC_TEXT_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(row.raw)) !== null) {
      const key = m[1] ?? ''
      const val = m[2] ?? ''
      // 八维 `?` 保留原样（D7：「未知」本身是有用信息）；其余取整或原文。
      out.push({ key, value: val.trim() === '?' ? '?' : scValue(val) })
    }
  }
  const t = SC_TITLE_RE.exec(row.raw)
  if (t !== null) {
    out.push({ key: '头衔', value: t[1] ?? '' })
    out.push({ key: '姓名', value: t[2] ?? '' })
    out.push({ key: '英文名', value: t[3] ?? '' })
  }
  return out.length > 0 ? out : undefined
}

// ── i（inventory，§2.4；待实录校准）────────────────────────────────

/** 携带件数：中文数字先不解析（存原文，PLAN 未决 3）。 */
const I_CARRY_RE = /你共携带(.+?)件器物/
/** 负重：原文（约十斤）。 */
const I_BURDEN_RE = /(?:总负重|负重)[:：]?\s*(约?[一二三四五六七八九十百千零\d]+斤)/
/** 财物：黄金×4 白银×70 铜板×81 → { gold, silver, copper }。 */
const I_GOLD_RE = /黄金[×x*]\s*(\d+)/
const I_SILVER_RE = /白银[×x*]\s*(\d+)/
const I_COPPER_RE = /铜板[×x*]\s*(\d+)/

function inventoryRow(row: RowContext): TrackEntry[] | undefined {
  const out: TrackEntry[] = []
  const carry = I_CARRY_RE.exec(row.raw)
  if (carry !== null) out.push({ key: '件数', value: carry[1] ?? '' })
  const burden = I_BURDEN_RE.exec(row.raw)
  if (burden !== null) out.push({ key: '负重', value: burden[1] ?? '' })
  const gold = I_GOLD_RE.exec(row.raw)?.[1]
  const silver = I_SILVER_RE.exec(row.raw)?.[1]
  const copper = I_COPPER_RE.exec(row.raw)?.[1]
  if (gold !== undefined || silver !== undefined || copper !== undefined) {
    out.push({ key: '财物', value: {
      ...(gold !== undefined ? { gold: Number.parseInt(gold, 10) } : {}),
      ...(silver !== undefined ? { silver: Number.parseInt(silver, 10) } : {}),
      ...(copper !== undefined ? { copper: Number.parseInt(copper, 10) } : {}),
    } })
  }
  return out.length > 0 ? out : undefined
}

// ── skills（§2.4；实录校准 2026-10-08，A.7.3：中文名+英文id 同 cell 括号形式）──

/**
 * 技能行名称 cell：`＋医道(medicine)` / `□太极拳(taiji-quan)` / `  招魂术(evocation)`——
 * 可选 ＋/□ 前缀（已激发/未激发）+ 中文名 + 同 cell 括号内英文 id（实录 A.7.3）。
 */
const SKILL_NAME_RE = /^\s*([＋□])?\s*([\u4e00-\u9fff]{1,12})\(([a-z][a-z0-9-]{1,})\)\s*$/
/** 等级 cell：`16.00/78`，cap 为 `-`（无上限，如知识类）时保留 `-`（D12/§2.4）。 */
const SKILL_LEVEL_RE = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?|-)$/
/**
 * 槽位汇总行（全句单 cell，实录 A.7.3）：
 * `共使用了17.5个技能槽位，空余槽位(12.5)。级别上限：-5.56%。`
 */
const SKILL_SLOT_RE = /共使用了(\d+(?:\.\d+)?)个技能槽位，空余槽位\((\d+(?:\.\d+)?)\)。级别上限：(-?\d+(?:\.\d+)?)%/
const HAS_CJK_RE = /[\u4e00-\u9fff]/

function skillsRow(row: RowContext): TrackEntry[] | undefined {
  // 槽位汇总行：全句 cell 命中即写（used / free / capDelta 原文含 %）。
  for (const c of row.cells) {
    const slot = SKILL_SLOT_RE.exec(c)
    if (slot !== null) {
      return [{ key: '槽位', value: { used: Number(slot[1]), free: Number(slot[2]), capDelta: `${slot[3]}%` } }]
    }
  }
  // 技能行：名称 cell（flag + 中文名 + 英文 id）与等级 cell 必备（缺一不写不猜）。
  let name: { flag?: string; cn: string; id: string } | undefined
  let level: { value: string; cap: string } | undefined
  let tier: string | undefined
  for (const c of row.cells) {
    if (name === undefined) {
      const nm = SKILL_NAME_RE.exec(c)
      if (nm !== null) {
        name = { cn: (nm[2] ?? '').trim(), id: nm[3] ?? '', ...(nm[1] !== undefined ? { flag: nm[1] } : {}) }
        continue
      }
    }
    if (level === undefined) {
      const lm = SKILL_LEVEL_RE.exec(c)
      if (lm !== null) { level = { value: lm[1] ?? '', cap: lm[2] ?? '' }; continue }
    }
    // 描述（境界）cell：其余中文 cell（不堪一击/初窥门径…；名称 cell 已 continue 不重复计）。
    if (tier === undefined && HAS_CJK_RE.test(c)) tier = c.trim()
  }
  if (name === undefined || level === undefined) return undefined
  return [{
    key: name.id,
    value: {
      name: name.cn,
      level: Number(level.value),
      ...(level.cap !== '-' && level.cap !== '' ? { cap: Number(level.cap) } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(name.flag !== undefined ? { flag: name.flag } : {}),
      ...(row.section !== undefined ? { category: row.section } : {}),
    },
  }]
}

// ── id（items 别称表，§2.4：lines 形状；待实录校准）─────────────────

// ── exp（character，实录 2026-10-08：级别/经验对照 + 连线时长）────────

/**
 * 对照行 cell：纯数字（级别或经验值）。一行最多 6 个数字 cell（三列对：
 * 级别/经验 ×3），按 cell 序偶数位 = 级别、奇数位 = 经验（实录列序固定）。
 */
const EXP_NUM_RE = /^\d+$/
/** 连线时长句：`你连线进入北侠已经有四十八分三十九秒了。`（中文时长原文）。 */
const EXP_ONLINE_RE = /^你连线进入北侠已经有(.+?)了。$/

/**
 * exp 表行判据（table 形状，块内逐行）：
 *   - 对照行（≥2 个纯数字 cell，级别/经验 列对）→ 追加进块内积攒 `pairs`；
 *   - 连线时长句（单 cell 全句命中）→ `character.连线时长`（中文时长原文；
 *     「经验没有变化」句不稳定不抓）。
 * 对照行的合并写由块收口完成（`finishTableBlock`，见下）——表头/框线行零写入。
 */
function expRow(row: RowContext): TrackEntry[] | undefined {
  for (const c of row.cells) {
    const online = EXP_ONLINE_RE.exec(c)
    if (online !== null) return [{ key: '连线时长', value: (online[1] ?? '').trim() }]
  }
  const nums = row.cells.filter(c => EXP_NUM_RE.test(c))
  if (nums.length < 2 || nums.length % 2 !== 0) return undefined
  // 全数字 cell 行也须在 exp 表内（块节标题或表头行文佐证）——由调用方
  // （StateTracker.matchTableRow 的块上下文）保证：本规则只在表格块内被调用，
  // 其他表格（hp/sc/i/skills）的行已先被声明序更前的规则独占。
  return []
}

/**
 * exp 对照行积攒（块内状态）：{tracker 内部用}。一行三列对 = 6 个数字 cell，
 * 按「偶位=级别、奇位=经验」配对；块收口时整体写一次 `character.经验表`
 *（数组后到覆盖——新表刷新旧表）。
 */
function expPairsOf(cells: readonly string[]): { level: number; exp: number }[] {
  const nums = cells.filter(c => EXP_NUM_RE.test(c))
  const out: { level: number; exp: number }[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const level = Number.parseInt(nums[i] ?? '', 10)
    const exp = Number.parseInt(nums[i + 1] ?? '', 10)
    if (!Number.isFinite(level) || !Number.isFinite(exp)) continue
    out.push({ level, exp })
  }
  return out
}

// ── id（items 别称表，§2.4：lines 形状；待实录校准）─────────────────

/** 别称表头（PLAN §2.4：一并打标剔除，只标不写）。 */
const ALIAS_HEADER_RE = /^你身上携带物品的别称如下/
/**
 * 别称行：`中文物品名 : 英文别称, ...`。判据收紧（堵误配）：键为纯中文 ≤12 字
 * （排除【频道】头与说话句主语）、半角冒号且两侧留空（全角冒号 = 聊天说话）。
 * 别称按逗号切分、词内允许空格（`dao pao`）。
 */
const ALIAS_ENTRY_RE = /^([\u4e00-\u9fff]{1,12})\s:\s+(.+)$/
const ALIAS_TOKEN_RE = /^[a-z][a-z0-9' -]*$/i

function aliasRow(row: RowContext): TrackEntry[] | undefined {
  const m = ALIAS_ENTRY_RE.exec(row.raw)
  if (m === null) return undefined
  const aliases = (m[2] ?? '')
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(s => s !== '' && ALIAS_TOKEN_RE.test(s))
  if (aliases.length === 0) return undefined
  return [{ key: m[1] ?? '', value: aliases }]
}

// ── combat（T21.1：战斗判据，lines 形状；实录出处 A.8.3）────────────

/** 气势累积：`你在攻击中不断积蓄攻势。(气势：4%)` → 整数百分比（A.8.3）。 */
const COMBAT_MOMENTUM_RE = /^你在攻击中不断积蓄攻势。\(气势：(\d+)%\)$/
/** 我方开战：`你大喝一声，开始对大狼狗发动攻击！` → 目标 + 敌人数（A.8.3）。
 * 导出供危险抢占通道文本判定点①复用（T21.5，判据单点）。 */
export const COMBAT_ENGAGE_RE = /^你大喝一声，开始对(.{1,20}?)发动攻击！$/
/** 敌意确立：`看起来大狼狗想杀死你！` → 目标 + 敌人数（A.8.3）。
 * 导出供危险抢占通道文本判定点①复用（T21.5，判据单点）。 */
export const COMBAT_HOSTILE_RE = /^看起来(.{1,20}?)想杀死你！$/
/**
 * 敌方档位：实录确认仅 1 级 `( X已经伤痕累累，正在勉力支撑著不倒下去。 )`
 * （A.8.3）；阶梯其余档〔推断〕待实录（A.8.5），不得据此扩判据。锚「名 + 已经 +
 * 行尾右括号」——我方伤情行（主语你、『』戳尾，A.8.4）不匹配（描述语非刻度，
 * 用户裁定 2026-10-06，不作阈值依据）。
 */
const COMBAT_ENEMY_TIER_RE = /^\(\s*([\u4e00-\u9fff]{2,12})已经(.+?)\s*\)\s*$/

/** 战斗行判据（lines 形状，块外逐行；zone 固定 combat）。 */
function combatRow(row: RowContext): TrackEntry[] | undefined {
  const m = COMBAT_MOMENTUM_RE.exec(row.raw)
  if (m !== null) return [{ key: '气势', value: Number.parseInt(m[1] ?? '0', 10) }]
  const engage = COMBAT_ENGAGE_RE.exec(row.raw)
  if (engage !== null) return [{ key: '目标', value: engage[1] ?? '' }, { key: '敌人数', value: 1 }]
  const hostile = COMBAT_HOSTILE_RE.exec(row.raw)
  if (hostile !== null) return [{ key: '目标', value: hostile[1] ?? '' }, { key: '敌人数', value: 1 }]
  if (!row.raw.includes('『')) {
    const tier = COMBAT_ENEMY_TIER_RE.exec(row.raw)
    if (tier !== null) return [{ key: '敌档', value: `${tier[1] ?? ''}已经${tier[2] ?? ''}`.trim() }]
  }
  return undefined
}

// ── 缺省规则集 ──────────────────────────────────────────────────────

/**
 * 缺省追踪规则（D13 落地序：hpbrief → hp → skills → id/i → sc）。
 * 声明序 = 行匹配优先序（表格行声明序首个命中者独占）：标签锚特异的规则
 * （hp/sc/i）先于启发式规则（skills）；id（lines）与表格不争行。
 * sc/i/skills/id 规则**待实录校准**（片段先行），按 §2.4 逐块补入。
 */
export const DEFAULT_TRACK_RULES: readonly AnyTrackRule[] = [
  { id: 'hpbrief', shape: 'sequence', zone: 'vitals', head: /^#/, length: 3, match: hpbriefRow },
  { id: 'hp', shape: 'table', zone: 'vitals', match: hpRow },
  { id: 'sc', shape: 'table', zone: 'character', match: scRow },
  { id: 'i', shape: 'table', zone: 'inventory', match: inventoryRow },
  { id: 'skills', shape: 'table', zone: 'skills', match: skillsRow },
  { id: 'exp', shape: 'table', zone: 'character', match: expRow },
  { id: 'id-header', shape: 'lines', zone: 'items', match: (row) => (ALIAS_HEADER_RE.test(row.raw) ? [] : undefined) },
  { id: 'id', shape: 'lines', zone: 'items', match: aliasRow },
  { id: 'combat', shape: 'lines', zone: 'combat', match: combatRow },
]

/** 缺省 clear 规则（D9；按例证逐条加）。 */
export const DEFAULT_TRACK_CLEARS: readonly TrackClearRule[] = [
  // PLAN §2.4 例证：饥饿消解（hp 表 [缺食] 写入的 食物状态 消失）。
  { pattern: /你不再感到饥饿/, zone: 'vitals', key: '食物状态' },
]

export const DEFAULT_TRACK_SPEC: TrackSpec = {
  rules: DEFAULT_TRACK_RULES,
  clears: DEFAULT_TRACK_CLEARS,
}

// ── 状态追踪器 ──────────────────────────────────────────────────────

/** 块内最小状态（§2.1）：「当前节标题 + 已见行数（护栏用）」；exp 表块内加对照对积攒。 */
interface BlockState {
  section?: string
  rows: number
  /** exp 表对照对积攒（行序追加；块收口时整体写一次 `character.经验表`）。 */
  expPairs?: { level: number; exp: number }[]
}

/** 序列状态：所属规则 + 已攒行（打标随到随打，写入等凑齐全量校验）。 */
interface SeqState {
  rule: SequenceTrackRule
  rows: MudLine[]
}

/**
 * 状态追踪器：observe(line) 消费行流，产出 = ①行打标（就地写 line.kind）+
 * ②World 写入/消解（经 deps 回调）。无例证不建机制：只维护块/序列两份跨行状态。
 */
export class StateTracker {
  private block: BlockState | null = null
  private seq: SeqState | null = null

  constructor(
    private readonly deps: StateTrackerDeps,
    private readonly spec: TrackSpec = DEFAULT_TRACK_SPEC,
  ) {}

  /** 行消费入口（runtime 行路径在 classifier.mark 之后调用）。 */
  observe(line: MudLine): void {
    const text = line.text

    // clear 规则（D9）：任意行先查消解（clear 行不打标不剔除，保留主屏）。
    if (this.spec.clears !== undefined) {
      for (const c of this.spec.clears) {
        if (c.pattern.test(text)) {
          this.deps.onDelete(c.zone, c.key)
          break
        }
      }
    }

    // 表格块边界（D8）：┌ 开块即整块打标（框线/节标题/表头/页脚祝福语全部行）。
    if (TABLE_OPEN_RE.test(text)) {
      this.block = { rows: 0 }
      this.tag(line)
      return
    }
    if (this.block !== null) {
      this.tag(line)
      if (TABLE_CLOSE_RE.test(text)) {
        this.finishTableBlock()
        this.block = null
      } else if (TABLE_ROW_RE.test(text)) {
        this.matchTableRow(text)
        this.block.rows += 1
        if (this.block.rows > MAX_TABLE_LINES) { // 失控块止损（标已打，不再解析）
          this.finishTableBlock()
          this.block = null
        }
      } else if (TABLE_BORDER_RE.test(text)) {
        const section = SECTION_CJK_RE.exec(text)?.[0]
        if (section !== undefined) this.block.section = section
      }
      return
    }

    // 序列进行中（D5）：head 连续行攒批，非 head 行即断 ⇒ 整组不写。
    if (this.seq !== null) {
      if (this.seq.rule.head.test(text)) {
        this.seq.rows.push(line)
        this.tag(line)
        if (this.seq.rows.length >= this.seq.rule.length) this.finishSequence()
      } else {
        this.seq = null
      }
      return
    }

    // 序列开始：首个 head 命中的 sequence 规则拥有该序列。
    for (const r of this.spec.rules) {
      if (r.shape === 'sequence' && (r as SequenceTrackRule).head.test(text)) {
        const rule = r as SequenceTrackRule
        this.seq = { rule, rows: [line] }
        this.tag(line)
        if (rule.length <= 1) this.finishSequence()
        return
      }
    }

    // lines 形状（块外逐行，如 id 别称表）：命中即打标即写。
    // C5.2 优先：已被分类器打标的行（chat/action/vitals）不再参与 lines 匹配。
    if (line.kind !== null) return
    for (const r of this.spec.rules) {
      if (r.shape !== 'lines') continue
      const entries = r.match({ cells: [text], raw: text, index: 0 })
      if (entries !== undefined) {
        this.tag(line)
        this.write(entries, r.zone)
        return
      }
    }
  }

  /** 断线复位（in-block/in-sequence 状态不跨连接）。 */
  reset(): void {
    this.block = null
    this.seq = null
  }

  // ── 内部 ────────────────────────────────────────────────────────

  /** 打标（C5.2 优先：只补无标行）。 */
  private tag(line: MudLine): void {
    if (line.kind === null) line.kind = STATUS_KIND
  }

  /** 表格行匹配：声明序首个命中规则独占该行（产出经其 zone 写入）。
   *  exp 规则特殊：对照行返回空产出（占位独占）+ 对照对积攒进块，块收口统一写。 */
  private matchTableRow(text: string): void {
    const block = this.block
    if (block === null) return
    const cells = splitRowCells(text)
    for (const r of this.spec.rules) {
      if (r.shape !== 'table') continue
      const ctx: RowContext = { cells, raw: text, index: block.rows, ...(block.section !== undefined ? { section: block.section } : {}) }
      const entries = r.match(ctx)
      if (entries !== undefined) {
        if (r.id === 'exp' && entries.length === 0) {
          // exp 对照行（空产出占位独占）：纯数字 cell 列对积攒进块，块收口统一写；
          // 其余产出（连线时长句）照常写。
          const first = cells[0] ?? ''
          if (EXP_NUM_RE.test(first)) {
            block.expPairs = [...(block.expPairs ?? []), ...expPairsOf(cells)]
          }
        } else {
          this.write(entries, r.zone)
        }
        return
      }
    }
  }

  /** 表格块收口（└ 或失控止损）：exp 对照对积攒非空 ⇒ 整体写一次经验表。 */
  private finishTableBlock(): void {
    const block = this.block
    if (block === null) return
    if (block.expPairs !== undefined && block.expPairs.length > 0) {
      this.deps.onWrite('character', '经验表', block.expPairs)
    }
  }

  /** 序列收口：逐行 match 全部成功才写（D5）；任一行不合格 ⇒ 整组不写不猜。 */
  private finishSequence(): void {
    const seq = this.seq
    this.seq = null
    if (seq === null) return
    const collected: TrackEntry[] = []
    for (let i = 0; i < seq.rows.length; i++) {
      const ln = seq.rows[i]
      if (ln === undefined) return
      const cells = ln.text.replace(/^#/, '').split(',').map(s => s.trim())
      const entries = seq.rule.match({ cells, raw: ln.text, index: i })
      if (entries === undefined) return
      collected.push(...entries)
    }
    this.write(collected, seq.rule.zone)
  }

  /** 产出写入（entry.zone 可覆盖规则 zone，如 hpbrief 的 combat 两键）。 */
  private write(entries: readonly TrackEntry[], defaultZone: string): void {
    for (const e of entries) {
      this.deps.onWrite(e.zone ?? defaultZone, e.key, e.value)
    }
  }
}
