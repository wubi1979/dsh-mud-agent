/**
 * commands/usr — 玩家/交互命令族条目（T26.1 骨架；DEC-18 构建期数组）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，T26.7 覆盖审计门）。A.6
 * 纪律：不得凭印象写正则——确认词/频道/社交 emote 等「易遗漏族」属 `'ga'`
 * 形态（A.2 共享事实：即时命令 GA 1:1，无需逐条语料），清单实录后按族回填。
 *
 * T29（2026-10-15 用户裁定）：本族五条表类状态命令的捕获格式**就地定义**
 *（hpbrief/hp/sc/i/exp，条目 capture 本地引用）；捕获契约类型归 define.ts。
 */

import { byBoundary, byOutcomes, defineCommand, TABLE_BLOCK_FORMAT } from './define.ts'
import type { BlockReducer, RowContext, SequenceCaptureRule, CaptureEntry, CaptureRule } from './define.ts'

// ── hpbrief 捕获格式：定长 3 行位置映射（§2.2 已定稿 18 位表；实录 2026-10-06 同刻校准）──

/** hpbrief 单行判据：恰好 6 个纯数字 cell（D5 完整性校验的一部分；不满足整组不写）。
 *  负号合法：气血可为 -1（A.8.1 死亡断面实录 `#313,193,-1,…`；A.8.4：气血 <= 0
 *  不是死亡判据，状态须照写）。 */
const HPBRIEF_CELL_RE = /^-?\d+$/

/**
 * hpbrief 行映射（按行序 index）：
 *   L1 经验/潜能/最大内力/内力/最大精力/精力；L2 气血上限/最大气血/气血/精神上限/最大精神/精神；
 *   L3 真气/战意/食物/饮水/战斗中(0/1)/忙(0/1)。战斗中/忙是布尔枚举 → combat 分区。
 */
function hpbriefRow(row: RowContext): CaptureEntry[] | undefined {
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

// ── hp 捕获格式：框线表格规则（§2.3 兜底 + 只有表格才有的文本状态；片段先行，待实录校准）──

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
  readonly build: (m: RegExpExecArray) => CaptureEntry[]
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
      ...(m[3] !== undefined ? [{ key: '精力加成', value: n(m[3]) } as CaptureEntry] : []),
    ] },
  { re: new RegExp(`【内力】${CUR_MAX}${OPT_BONUS}`), build: m => [
      { key: '内力', value: n(m[1]) }, { key: '最大内力', value: n(m[2]) },
      ...(m[3] !== undefined ? [{ key: '内力加成', value: n(m[3]) } as CaptureEntry] : []),
    ] },
  // 【静气】80% ≡ hpbrief 战意 80（校准结论②，合一个键）。
  { re: /【静气】\s*(\d+)\s*%/, build: m => [{ key: '战意', value: n(m[1]) }] },
  { re: new RegExp(`【食物】${CUR_MAX}${OPT_STATE}`), build: m => [
      { key: '食物', value: n(m[1]) }, { key: '最大食物', value: n(m[2]) },
      ...(m[3] !== undefined && m[3] !== '' ? [{ key: '食物状态', value: m[3] } as CaptureEntry] : []),
    ] },
  { re: new RegExp(`【饮水】${CUR_MAX}${OPT_STATE}`), build: m => [
      { key: '饮水', value: n(m[1]) }, { key: '最大饮水', value: n(m[2]) },
      ...(m[3] !== undefined && m[3] !== '' ? [{ key: '饮水状态', value: m[3] } as CaptureEntry] : []),
    ] },
  { re: /【潜能】\s*(\d+)/, build: m => [{ key: '潜能', value: n(m[1]) }] },
  { re: /【经验】\s*(\d+)/, build: m => [{ key: '经验', value: n(m[1]) }] },
  // 【状态】健康、极度疲倦 → 数组（只有 hp 表格有的自由文本；捕获止于 cell 边界）。
  // cell 边界 = 块语法切分符（TABLE_BLOCK_FORMAT 单点，2026-10-15 格式/机制二分修正）。
  { re: new RegExp(`【状态】\\s*([^${TABLE_BLOCK_FORMAT.cellDelimiter}\\]]+)`), build: m => [{
      key: '状态',
      value: (m[1] ?? '').split('、').map(s => s.trim()).filter(s => s !== ''),
    }] },
]

/** hp 表格行解析：所有模式扫一遍，收集全部命中（0 命中 = 不匹配该行）。 */
function hpRow(row: RowContext): CaptureEntry[] | undefined {
  const out: CaptureEntry[] = []
  for (const p of HP_PATTERNS) {
    const m = p.re.exec(row.raw)
    if (m !== null) out.push(...p.build(m))
  }
  return out.length > 0 ? out : undefined
}

// ── sc 捕获格式（character，§2.4 分批①：八维 + 存款/杀气/门派履历/上榜差经验；待实录校准）──

/** 八维（允许 `?`——D7「未知」本身是有用信息，保留不猜）。 */
const SC_OCTA_RE = /(膂力|悟性|根骨|身法|福缘|容貌|灵性|胆识)[:：]\s*\[([^\]]*)\]/g
/** 数字型标签：存款/杀气/门忠/上榜差经验（千分位逗号剥除后取整）。 */
const SC_NUM_RE = /(存款|杀气|门忠|上榜差经验)[:：=]?\s*([\d,，]+)/g
/** 文本型标签：门派履历（门派/师承/出师/叛师 → 原文）。cell 边界 = 块语法切分符单点。 */
const SC_TEXT_RE = new RegExp(`(门派|师承|出师|叛师)[:：]\\s*([^${TABLE_BLOCK_FORMAT.cellDelimiter}\\]]+)`, 'g')
/** 头衔与姓名：`武当派第四代弟子 夫差(Vicrly)`（待实录校准）。 */
const SC_TITLE_RE = /([\u4e00-\u9fff]+第.{1,6}弟子)\s+([\u4e00-\u9fff]{1,8})\(([^)]+)\)/

/** 标签值收口：纯数字取整，其余原文（trim）。 */
function scValue(raw: string): number | string {
  return /^[\d,，]+$/.test(raw) ? Number.parseInt(raw.replace(/[,，]/g, ''), 10) : raw.trim()
}

function scRow(row: RowContext): CaptureEntry[] | undefined {
  const out: CaptureEntry[] = []
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

// ── i 捕获格式（inventory，§10.3；实录校准 2026-10-08，A.7.4：四分区框线表）──

/** 携带件数：中文数字先不解析（存原文，PLAN 未决 3）。 */
const I_CARRY_RE = /你共携带(.+?)件器物/
/** 负重：原文（约十斤）。 */
const I_BURDEN_RE = /(?:总负重|负重)[:：]?\s*(约?[一二三四五六七八九十百千零\d]+斤)/
/** 负重比：`接近一成`（原句尾锚定，堵正文误配；原文存档）。 */
const I_BURDEN_RATIO_RE = /(?:接近|超过|已达)?\s*[一二三四五六七八九十百零\d]+成[。，]?\s*$/
/** 财物：黄金/白银/铜板（单式三币合并；用户口径 2026-10-18：数量 1 时游戏不显
 *  `×N`，裸显 = 1）。`(?![\u4e00-\u9fff×x*])` 裸显分支堵「黄金手镯」类物品名误配。 */
const I_CURRENCY_RE = /(黄金|白银|铜板)(?:[×x*]\s*(\d+)|(?![\u4e00-\u9fff×x*]))/g

/** 装备/饰品槽位标签：`[帽子]`（1–6 字非方括号文本）。 */
const I_SLOT_RE = /\[([^\[\]]{1,6})\]/g
/** 背包物品：`北侠战甲(Pkuxkx zhanjia)` → {name, id}（实录 A.7.4）。 */
const I_ITEM_RE = /([\u4e00-\u9fff]{1,12})\(([a-z][a-z0-9' -]*)\)/gi
/** 食物物品：`干粮(Gan liang)×10` → {name, id, count}；无 ×N（`包子(Baozi)`）= 1
 *（用户口径 2026-10-18：数量 1 时游戏不显 ×N）。id 域同 I_ITEM_RE（i flag 下
 * [a-z] 兼顾大写首字母）。 */
const I_FOOD_RE = /([\u4e00-\u9fff]{1,12})\(([a-z][a-z0-9' -]*)\)(?:[×x*]\s*(\d+))?/gi
/** 槽位段含物品判据：段内有中文即视为物品名（画框字符 `▄▅█` 与 `--` 均非中文）。 */
const I_HAS_CJK_RE = /[\u4e00-\u9fff]/

/** 槽位段净化：先剥 `--` 空槽记号，再判中文（无中文 = 空槽不写；有中文收空白，
 *  `青色道袍   (+2)` → `青色道袍(+2)`，`珍珠   --` → `珍珠`）。 */
function iSlotItem(segment: string): string | undefined {
  const s = segment.replace(/-{2,}/g, ' ').trim()
  if (s === '' || !I_HAS_CJK_RE.test(s)) return undefined
  return s.replace(/\s+/g, '')
}

/**
 * 装备/饰品行（实录 A.7.4）：槽位标签成对（左右两列镜像）。行切成段
 * （S0=首 tag 前、Si=tag 间、Sn=末 tag 后），**每段只能被一个槽认领**：
 * 左列槽（偶位）物品优先前段、右列槽（奇位）优先后段，本位段无中文再取
 * 中间段（兼容 `[项链]珍珠` 布局）；段内无中文（`--`/画框）= 空槽不写。
 */
function iSlotRow(cells: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const cell of cells) {
    const tags: { name: string; start: number; end: number }[] = []
    I_SLOT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = I_SLOT_RE.exec(cell)) !== null) {
      tags.push({ name: m[1] ?? '', start: m.index, end: m.index + m[0].length })
    }
    if (tags.length === 0) continue
    // 段切分：segs[i] = tag i 的前段（i=0 即行首），segs[n] = 末 tag 后段。
    const segs = tags.map((t, i) => cell.slice(i === 0 ? 0 : tags[i - 1]!.end, t.start))
    segs.push(cell.slice(tags[tags.length - 1]!.end))
    const used = new Set<number>()
    for (let i = 0; i < tags.length; i++) {
      const own = i % 2 === 0 ? i : i + 1
      const fallback = i % 2 === 0 ? i + 1 : i
      let claimed = -1
      let item: string | undefined
      if (!used.has(own)) {
        item = iSlotItem(segs[own] ?? '')
        if (item !== undefined) claimed = own
      }
      if (item === undefined && !used.has(fallback)) {
        item = iSlotItem(segs[fallback] ?? '')
        if (item !== undefined) claimed = fallback
      }
      if (item !== undefined && claimed >= 0) {
        out[tags[i]!.name] = item
        used.add(claimed)
      }
    }
  }
  return out
}

/** 其它（背包）行：中文名(英文id) 对列表（一行可多件）。 */
function iOtherItems(cells: readonly string[]): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = []
  for (const c of cells) {
    I_ITEM_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = I_ITEM_RE.exec(c)) !== null) {
      out.push({ name: m[1] ?? '', id: m[2] ?? '' })
    }
  }
  return out
}

/** i 表分区积攒合并：数组（其它）按序追加、对象（装备/饰品/财物）按键合并、标量覆盖。 */
function mergeInvEntries(
  acc: Record<string, unknown> | undefined,
  entries: readonly CaptureEntry[],
): Record<string, unknown> {
  const out = { ...(acc ?? {}) }
  for (const e of entries) {
    const prev = out[e.key]
    if (Array.isArray(prev) && Array.isArray(e.value)) {
      out[e.key] = [...prev, ...e.value]
    } else if (prev !== undefined && prev !== null && typeof prev === 'object'
      && e.value !== null && typeof e.value === 'object') {
      out[e.key] = { ...(prev as object), ...(e.value as object) }
    } else {
      out[e.key] = e.value
    }
  }
  return out
}

function inventoryRow(row: RowContext): CaptureEntry[] | undefined {
  const out: CaptureEntry[] = []
  const carry = I_CARRY_RE.exec(row.raw)
  if (carry !== null) out.push({ key: '件数', value: carry[1] ?? '' })
  const burden = I_BURDEN_RE.exec(row.raw)
  if (burden !== null) out.push({ key: '负重', value: burden[1] ?? '' })
  const ratio = row.cells.map(c => I_BURDEN_RATIO_RE.exec(c)).find(m => m !== null)?.[0]
  if (ratio !== undefined) out.push({ key: '负重比', value: ratio.replace(/[。，\s]/g, '') })
  const money: { gold?: number; silver?: number; copper?: number } = {}
  I_CURRENCY_RE.lastIndex = 0
  let cur: RegExpExecArray | null
  while ((cur = I_CURRENCY_RE.exec(row.raw)) !== null) {
    const count = cur[2] !== undefined ? Number.parseInt(cur[2], 10) : 1
    if (cur[1] === '黄金') money.gold = count
    else if (cur[1] === '白银') money.silver = count
    else money.copper = count
  }
  if (Object.keys(money).length > 0) out.push({ key: '财物', value: money })
  // 分区行按 section 门控（堵 skills 的 中文(id) 行被本规则抢走——i 先于 skills 声明）。
  if (row.section === '装备' || row.section === '饰品') {
    const slots = iSlotRow(row.cells)
    if (Object.keys(slots).length > 0) out.push({ key: row.section, value: slots })
  }
  if (row.section === '其它') {
    const items = iOtherItems(row.cells)
    if (items.length > 0) out.push({ key: '其它', value: items })
  }
  if (row.section === '食物') {
    const foods: { name: string; id: string; count: number }[] = []
    for (const c of row.cells) {
      I_FOOD_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = I_FOOD_RE.exec(c)) !== null) {
        foods.push({
          name: m[1] ?? '',
          id: m[2] ?? '',
          count: m[3] !== undefined ? Number.parseInt(m[3], 10) : 1,
        })
      }
    }
    if (foods.length > 0) out.push({ key: '食物', value: foods })
  }
  return out.length > 0 ? out : undefined
}

/** i 表块积攒状态（mergeInvEntries 的可变持有者——acc 按 unknown 流转）。 */
interface InvAcc { inv: Record<string, unknown> }

/** i 块归约器（A.7.4）：分区行全积攒（装备/饰品跨行合并、其它跨行追加、汇总覆盖），
 *  块收口统一写——消除 tracker 对 `r.id === 'i'` 的特判（T29 D5）。 */
const I_BLOCK: BlockReducer = {
  init: () => ({ inv: {} }) satisfies InvAcc,
  step: (acc, _ctx, entries) => {
    ;(acc as InvAcc).inv = mergeInvEntries((acc as InvAcc).inv, entries)
    return [] // i 全积攒：块收口统一写
  },
  flush: (acc) => Object.entries((acc as InvAcc).inv).map(([key, value]) => ({ key, value })),
}

// ── exp 捕获格式（character，实录 2026-10-08：级别/经验对照 + 连线时长）────────

/**
 * 对照行 cell：纯数字（级别或经验值）。一行最多 6 个数字 cell（三列对：
 * 级别/经验 ×3），按 cell 序偶数位 = 级别、奇数位 = 经验（实录列序固定）。
 */
const EXP_NUM_RE = /^\d+$/
/** 连线时长句：`你连线进入北侠已经有四十八分三十九秒了。`（中文时长原文）。 */
const EXP_ONLINE_RE = /^你连线进入北侠已经有(.+?)了。$/

/**
 * exp 表行判据（table 形状，块内逐行）：
 *   - 对照行（≥2 个纯数字 cell，级别/经验 列对）→ 空产出占位独占，对照对进
 *     块归约器积攒（EXP_BLOCK）；
 *   - 连线时长句（单 cell 全句命中）→ `character.连线时长`（中文时长原文；
 *     「经验没有变化」句不稳定不抓）。
 * 对照行的合并写由块收口（tracker 机制 flush）完成——表头/框线行零写入。
 * 全数字 cell 行也须在 exp 表内（块节标题或表头行文佐证）——由调用方
 *（StateTracker.matchTableRow 的块上下文）保证：本规则只在表格块内被调用，
 * 其他表格（hp/sc/i/skills）的行已先被声明序更前的规则独占。
 */
function expRow(row: RowContext): CaptureEntry[] | undefined {
  for (const c of row.cells) {
    const online = EXP_ONLINE_RE.exec(c)
    if (online !== null) return [{ key: '连线时长', value: (online[1] ?? '').trim() }]
  }
  const nums = row.cells.filter(c => EXP_NUM_RE.test(c))
  if (nums.length < 2 || nums.length % 2 !== 0) return undefined
  return []
}

/**
 * exp 对照行积攒（块归约器，T29 D5）：一行三列对 = 6 个数字 cell，按「偶位=级别、
 * 奇位=经验」配对；块收口时整体写一次 `character.经验表`（数组后到覆盖——新表
 * 刷新旧表）。对照行（match 返回空产出占位独占）按首 cell 纯数字门控积攒（与
 * 旧 tracker 特判逐字等价）；连线时长句等非空产出照常直写。
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

/** exp 块积攒状态。 */
interface ExpAcc { pairs: { level: number; exp: number }[] }

const EXP_BLOCK: BlockReducer = {
  init: () => ({ pairs: [] }) satisfies ExpAcc,
  step: (acc, ctx, entries) => {
    const a = acc as ExpAcc
    if (entries.length === 0) {
      // 对照行（空产出占位独占）：首 cell 纯数字才积攒（旧 tracker 特判口径）。
      const first = ctx.cells[0] ?? ''
      if (EXP_NUM_RE.test(first)) a.pairs.push(...expPairsOf(ctx.cells))
      return []
    }
    return entries // 连线时长句等非空产出：立即直写
  },
  flush: (acc) => {
    const { pairs } = acc as ExpAcc
    return pairs.length > 0 ? [{ key: '经验表', value: pairs }] : []
  },
}

// ── 规则常量（本文件就地定义；条目 capture 本地引用；装配规范序见 assembler）──

/** hpbrief 序列规则（命令 hpbrief；zone vitals，战斗中/忙两键带 zone:'combat'）。
 *  cellSplit 随规则声明（序列 = 规则自理的特殊格式，引擎零格式知识）。 */
export const HPBRIEF_RULE: SequenceCaptureRule = {
  id: 'hpbrief', shape: 'sequence', zone: 'vitals', head: /^#/, length: 3, cellSplit: ',', match: hpbriefRow,
}

/** hp 表规则（命令 hp；§2.3 兜底 + 只有表格才有的文本状态；A.7 实录出处）。 */
export const HP_RULE: CaptureRule = { id: 'hp', shape: 'table', zone: 'vitals', match: hpRow }

/** sc 表规则（命令 score[sc]；zone character；A.7 分批①）。 */
export const SC_RULE: CaptureRule = { id: 'sc', shape: 'table', zone: 'character', match: scRow }

/** i 表规则（命令 inventory[i]；zone inventory；A.7.4 实录；块归约器全积攒）。 */
export const I_RULE: CaptureRule = { id: 'i', shape: 'table', zone: 'inventory', match: inventoryRow, block: I_BLOCK }

/** exp 表规则（命令 exp；zone character；2026-10-08 实录；块归约器对照对积攒）。 */
export const EXP_RULE: CaptureRule = { id: 'exp', shape: 'table', zone: 'character', match: expRow, block: EXP_BLOCK }

/**
 * 玩家/交互命令族（walk + T29 表类状态命令五条）。表类条目统一口径（T29 用户
 * 口径 2026-10-15）：应答框线表/序列后即 GA（A.2 1:1 同律）——形态 `'ga'`、
 * 关窗即 next（无分类语义条目）、timeoutMs 15s 纯兜底；capture 登记捕获格式
 *（D7 登记原则：返回与捕获一律登记在条目，tracker 只引用）。规则 id 独立于
 * 命令 id/别名（define.ts 捕获契约段头注）：'sc'↔score、'i'↔inventory。
 */
export const USR_COMMANDS = [
  defineCommand({
    // 行走（A.9 结论 5 + 用户口径 2026-10-14）：'criteria' 形态——GA 不武装
    //（每步都出提示符，GA 计数会第一步就关窗）。判据配条目级 flags 'm'（承重——
    // 多行行走窗行首锚：受理行在窗首，无 'm' 时 '^你到达了' 永不命中）。
    // 语义条目集（用户口径）：
    //   - 到达 `^你到达了`（目的地名动态，锚行首）；出发：`你决定开始前往…`；
    //   - 阻塞 `你因为种种原因停了下来`（取消软/硬阻断说法——理论上再发 walk
    //     可继续；连续失败没有推进由调用侧行为性判"阻断，需人工干预"，不入表）；
    //   - 不在出发点 `当前区域的系统内建路径出发点在`（**显式判据**：任意 walk
    //     用法不在 walk 节点都回这句，快速收束 ⇒ unaccepted，取代旧"反证"口径）；
    //   - 出发点表 `^┌`（出现路径表格 = 处于当前点位，快收并捕获记录）——锚
    //     = 块语法开行（TABLE_BLOCK_FORMAT.open 单点，2026-10-15 格式/机制二分修正）。
    // 查询只保留 `-c`（`-q`/`speed` 退役，用户口径）——走 exempt：锚定**完整
    // 发送串**（DEC-8），其答复与行走判据无关，注入会误判（§8.7）。
    // 无超时 sizing（用户口径：没有超时，后续服务）；条目 timeoutMs 只是判据
    // 未命中的兜底。非出发点拒绝行文已实录（上语义条目）；unaccepted 分类留调用侧。
    id: 'walk',
    exempt: /^walk\s+-c(\s|$)/,
    timeoutMs: 30_000,
    flags: 'm',
    meta: { corpus: '附录 A.9 结论 5（2026-10-08 实机）+ 用户口径 2026-10-14（出发点行 / 路径表实录）' },
    resolve: byOutcomes({
      fail: {
        阻塞: { patterns: ['你因为种种原因停了下来'] },
        不在出发点: { patterns: ['当前区域的系统内建路径出发点在'] },
      },
      ok: {
        到达: { patterns: ['^你到达了'] },
        出发点表: { patterns: [TABLE_BLOCK_FORMAT.open.source] },
      },
    }),
  }),
  // 气血简表（标准命令 hpbrief，无别名）：定长 3 行 `#` 序列应答（capture =
  // hpbrief sequence 规则〔上方就地定义〕，§2.2 已定稿 18 位表，2026-10-06 实录）。
  defineCommand({
    id: 'hpbrief',
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
    capture: [HPBRIEF_RULE],
  }),
  // 物品栏（标准命令 inventory，别名 i）：四分区框线表应答（capture = i 表规则
  // 含块归约器全积攒，A.7.4 实录）。
  defineCommand({
    id: 'inventory',
    aliases: ['i'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
    capture: [I_RULE],
  }),
  // 得分（标准命令 score，别名 sc）：八维/门派履历框线表应答（capture = sc 表
  // 规则，A.7 分批①）。规则 'sc' 对应命令 score——命名空间不对应，见 define.ts 头注。
  defineCommand({
    id: 'score',
    aliases: ['sc'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
    capture: [SC_RULE],
  }),
  // 状态全表（标准命令 hp）：框线表应答（capture = hp 表规则，§2.3 兜底 +
  // 文本状态；A.7 实录出处）。hp 的「你不再感到饥饿」clear **不在本条目**——
  // 存在非命令触发路径，留 tracker 本地 DEFAULT_TRACK_CLEARS（T29 边界纪律）。
  defineCommand({
    id: 'hp',
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
    capture: [HP_RULE],
  }),
  // 经验（标准命令 exp）：级别/经验对照表应答（capture = exp 表规则含块归约器
  // 对照对积攒，2026-10-08 实录）。
  defineCommand({
    id: 'exp',
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
    capture: [EXP_RULE],
  }),
  // 游戏帮助（标准命令 help，无别名；用户口径 2026-10-15 登记）：即时命令——
  // 帮助文本应答后即 GA（A.2 1:1），形态取 `'ga'`，关窗即 next（帮助文本为自由
  // 文档：无结构化捕获、无分类语义条目）。
  defineCommand({
    id: 'help',
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15' },
    resolve: byBoundary(),
  }),
]
