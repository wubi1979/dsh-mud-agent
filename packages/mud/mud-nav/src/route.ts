/**
 * nav/route — 行走行文的纯层解析：路径表行 + `walk -c <拼音名>` 方向序列。
 *
 * 实测口径（A.9 结论 10/11；用户口径 2026-10-14 两次）：
 *   - **路径表**（出发点房间 `walk` 无参）是这个区域的**边表**：每行
 *     `│<区域>  ◇ <房间> │<拼音名> │<步数> │` ⇒ `{region, room, pinyin, steps, direct?}`；
 *     本区域名在块开行（`┌───信阳──…`）。**出现表格 = 人物处于 walk 节点**，抓取并记录。
 *     `◇` 必须匹配：前段 = 目的**区域**名中文，后段 = 该区域内**房间**名
 *     （区域内唯一）；无 `◇` 的行不猜、丢弃。
 *   - **`◇` 分隔段颜色 = 可直达性**（实录 2026-10-14：着色的是 ` ◇ ` 分隔段本身
 *     ——红 `[31m ◇ ` ⇒ `direct: false` 不可直达，绿 `[1;32m ◇ ` ⇒ `direct: true`
 *     可直达；区域名 [1;33 黄、房间 [2;37 白，cell 其它部分不可靠。xterm 标准色
 *     1/9 红、2/10 绿起手）。无色 ⇒ 不记 direct（未知）。
 *   - **`walk -c <拼音名>`** 给**区域内方向序列**（长/短版本）——可执行的最后一程；
 *     出发前先 `-c` 查询并**按拼音并入对应边的 `dirs`**（用户口径：dirs 字段存行进路径）。
 *   - `walk -q` 已退役（用户口径 2026-10-14：查询只保留 `-c` 一种）。
 *
 * 纯层，零宿主依赖。
 *
 * @module mud-nav/route
 */

/** 带颜色的行（route 自有最小形状；消费方从 `MudLine.style` 展开，真彩色不映射按无色处理）。 */
export interface WalkLine {
  /** 纯文本（无 ANSI）。 */
  readonly text: string
  /** 逐字符前景色（xterm 0-255 索引；默认色 null；缺省/长度不足 = 无色）。 */
  readonly fg?: readonly (number | null)[]
}

/** 路径表一条边（目的地 = 另一区域里的一个房间）。 */
export interface WalkEdge {
  /** 目的**区域**名中文（`◇` 前段，如 `信阳`）。 */
  readonly region: string
  /** 目的**房间**名（`◇` 后段，如 `小广场`；理论上区域内唯一）。 */
  readonly room: string
  /** `walk` 的拼音名（如 `xinyang`）——**唯一 id**。 */
  readonly pinyin: string
  /** 步数（大致耗时参考）。 */
  readonly steps: number
  /** 可直达性（行颜色：绿 = true 可直达 / 红 = false 不可直达；无色不记 = 未知）。 */
  readonly direct?: boolean
  /** 行进方向序列（`walk -c <拼音名>` 答复，按拼音并入；后到覆盖）。 */
  readonly dirs?: readonly string[]
}

/** 本区域路径表（区域名可缺省——非路线表或没读到开行）。 */
export interface WalkTable {
  readonly region?: string
  readonly edges: readonly WalkEdge[]
}

const TABLE_OPEN_RE = /^┌/
const TABLE_ROW_RE = /^│/
/** 块开行的中文串（区域名）。 */
const SECTION_CJK_RE = /[\u4e00-\u9fff]{2,}/
const PINYIN_RE = /^[a-z][a-z0-9_]*$/
const STEPS_RE = /^\d+$/
const HAS_CJK_RE = /[\u4e00-\u9fff]/
const HEADER_PINYIN_RE = /拼音名称/
const HEADER_STEPS_RE = /步数/
const HEADER_DEST_RE = /目的地/

/** `◇` 分隔（区域 ◇ 房间；两侧空白可有可无）。 */
const DIAMOND_RE = /\s*◇\s*/

/** 红族前景（xterm 标准：1 = red、9 = bright red）⇒ 不可直达。 */
const RED_FG: ReadonlySet<number> = new Set([1, 9])
/** 绿族前景（xterm 标准：2 = green、10 = bright green）⇒ 可直达。 */
const GREEN_FG: ReadonlySet<number> = new Set([2, 10])

/** 文本行 → WalkLine（无色）。 */
export function walkLine(text: string): WalkLine {
  return { text }
}

/** 按 `│` 切 cell，**带原文本坐标**（颜色按坐标取）；trim 边界后回收偏移。 */
interface CellSpan {
  readonly value: string
  readonly start: number
  readonly end: number
}

function cellSpans(text: string): CellSpan[] {
  const spans: CellSpan[] = []
  let begin = 0
  for (;;) {
    const idx = text.indexOf('│', begin)
    const end = idx === -1 ? text.length : idx
    const raw = text.slice(begin, end)
    const lead = raw.length - raw.trimStart().length
    const value = raw.trim()
    if (value !== '') spans.push({ value, start: begin + lead, end: begin + lead + value.length })
    if (idx === -1) break
    begin = idx + 1
  }
  return spans
}

/** 一段坐标范围的主色（第一个非 null 前景；真彩色/无色 ⇒ null = 未知）。 */
function spanFg(fg: readonly (number | null)[] | undefined, start: number, end: number): number | null {
  if (fg === undefined) return null
  for (let i = Math.max(0, start); i < Math.min(end, fg.length); i += 1) {
    const c = fg[i]
    if (c !== null && c !== undefined) return c
  }
  return null
}

/**
 * `◇` 分隔符的颜色（实录 2026-10-14：着色的是 ` ◇ ` 分隔段——红行 `[31m ◇ `、
 * 绿行 `[1;32m ◇ `；区域名 [1;33 黄、房间 [2;37 白，**cell 其它部分不可靠**）。
 * 取 `◇` 字符本位色优先；本位未着色再看分隔段其余字符；都没有 ⇒ null（未知）。
 */
function diamondFg(
  fg: readonly (number | null)[] | undefined,
  segStart: number,
  diaIdx: number,
  segEnd: number,
): number | null {
  if (fg === undefined) return null
  const at = fg[diaIdx]
  if (at !== null && at !== undefined) return at
  return spanFg(fg, segStart, segEnd)
}

/** 行颜色 ⇒ direct（绿 = true / 红 = false；其余 = undefined 不猜）。 */
function directOf(fg: number | null): boolean | undefined {
  if (fg === null) return undefined
  if (RED_FG.has(fg)) return false
  if (GREEN_FG.has(fg)) return true
  return undefined
}

/**
 * 解析路径表（行数组，任意顺序/含边框与表头）。
 * 区域名取自块开行；表行需同时具备**拼音名 cell** 与**纯数字步数 cell**，且目的地
 * cell 匹配 `◇`（区域 ◇ 房间）——缺一不入表，不猜。direct 取 **`◇` 分隔符的颜色**
 * （实录 2026-10-14：着色段 = ` ◇ `，红 = 不可直达 / 绿 = 可直达；cell 其它部分
 * 是区域黄 / 房间白，不可靠）。
 */
export function parseWalkTable(lines: readonly WalkLine[]): WalkTable {
  let region: string | undefined
  const edges: WalkEdge[] = []
  for (const line of lines) {
    const text = line.text
    if (TABLE_OPEN_RE.test(text)) {
      region = region ?? SECTION_CJK_RE.exec(text)?.[0]
      continue
    }
    if (!TABLE_ROW_RE.test(text)) continue
    const spans = cellSpans(text)
    if (spans.some(s => HEADER_PINYIN_RE.test(s.value)) || spans.some(s => HEADER_STEPS_RE.test(s.value)) || spans.some(s => HEADER_DEST_RE.test(s.value))) continue
    const dest = spans.find(s => HAS_CJK_RE.test(s.value))
    const pinyin = spans.find(s => PINYIN_RE.test(s.value))
    const steps = spans.find(s => STEPS_RE.test(s.value))
    if (dest === undefined || pinyin === undefined || steps === undefined) continue
    // `◇` 必须匹配：前段 = 目的区域，后段 = 目的房间；无 `◇`（或顶格）不猜、丢弃。
    const dm = DIAMOND_RE.exec(dest.value)
    if (dm === null || dm.index <= 0) continue
    const at = dm.index
    const destRegion = dest.value.slice(0, at).trim()
    const destRoom = dest.value.slice(at).replace(DIAMOND_RE, '').trim()
    if (destRegion === '' || destRoom === '') continue
    const diaIdx = dest.start + at + dm[0].indexOf('◇')
    const direct = directOf(diamondFg(line.fg, dest.start + at, diaIdx, dest.start + at + dm[0].length))
    edges.push({
      region: destRegion,
      room: destRoom,
      pinyin: pinyin.value,
      steps: Number.parseInt(steps.value, 10),
      ...(direct !== undefined ? { direct } : {}),
    })
  }
  return { ...(region !== undefined ? { region } : {}), edges }
}

// ── 区域内方向序列（`walk -c <拼音名>`，A.9 结论 11）────────────────────

/** 方向缩写表（实录：`wu` = westup、`nu` = northup、`eu` = eastup；短版本用它压缩）。 */
const DIRECTION_ABBR: Readonly<Record<string, string>> = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  u: 'up', d: 'down',
  nu: 'northup', su: 'southup', eu: 'eastup', wu: 'westup',
  nd: 'northdown', sd: 'southdown', ed: 'eastdown', wd: 'westdown',
}

/** 方向序列（区域内"最后一程"，**可执行**）——答复按拼音并入对应边的 `dirs`。 */
export interface DirectionPath {
  /** 目的地（长/短版本行前缀，如 `信阳`；缺省 ⇒ 空串）。 */
  readonly to: string
  /** 完整方向序列（长版本原文；只有短版本时由 {@link expandShortPath} 展开）。 */
  readonly directions: readonly string[]
  /** 短版本原文（有则带）。 */
  readonly short?: string
}

const LONG_RE = /^(.*?)长版本：(.+)$/
const SHORT_RE = /^\s*短版本：(.+)$/
const COUNTED_RE = /^#(\d+)\s+(.+)$/

/**
 * 展开短版本方向串：`#4 w,nw,#5 w` ⇒ `west,west,west,west,northwest,west,…`。
 * 词表外的 token **原样保留**（`enter` / `do_push door` 这类非方向步不猜、不改写）。
 */
export function expandShortPath(short: string): string[] {
  const out: string[] = []
  for (const raw of short.split(',')) {
    const token = raw.trim()
    if (token === '') continue
    const counted = COUNTED_RE.exec(token)
    const times = counted === null ? 1 : Number.parseInt(counted[1] ?? '1', 10)
    const step = (counted === null ? token : (counted[2] ?? '').trim()).toLowerCase()
    const full = DIRECTION_ABBR[step] ?? (counted === null ? token : (counted[2] ?? '').trim())
    for (let i = 0; i < times; i += 1) out.push(full)
  }
  return out
}

/**
 * 从行文取方向序列：优先**长版本**（原文即可执行），否则用短版本展开；都没有 ⇒ `null`（不猜）。
 */
export function parseDirectionPath(lines: readonly WalkLine[]): DirectionPath | null {
  let to = ''
  let directions: string[] | null = null
  let short: string | undefined
  for (const line of lines) {
    const text = line.text
    const s = SHORT_RE.exec(text)
    if (s !== null) {
      short = (s[1] ?? '').trim()
      continue
    }
    const m = LONG_RE.exec(text)
    if (m === null) continue
    to = (m[1] ?? '').trim()
    directions = (m[2] ?? '').split(',').map(x => x.trim()).filter(x => x !== '')
  }
  if (directions === null && short !== undefined) directions = expandShortPath(short)
  if (directions === null || directions.length === 0) return null
  return { to, directions, ...(short !== undefined ? { short } : {}) }
}
