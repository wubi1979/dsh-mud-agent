/**
 * nav/route — 跨区分段的纯层解析（T23.10b）：路径表行 + `walk -q` 参考链 + 下一跳挑选。
 *
 * 实测口径（A.9 结论 10）：
 *   - **路径表**（出发点房间 `walk` 无参）是这个区域的**边表**：每行
 *     `│<目的地中文>  ◇ <地点> │<拼音名> │<步数> │` ⇒ `{dest, pinyin, steps}`；
 *     区域名在块开行（`┌───荆州府──…`）。**逐段执行以本表为准**。
 *   - **`walk -q <区域>`** 只给**区域名链**（`从这里到襄阳途径扬州、中原、襄阳。`，
 *     末位即目标）——用户裁定"**大致路径，只有参考意义**" ⇒ 它**不是**可执行序列，
 *     只用来**挑下一跳**：先看目标是否直接可达，否则沿链取第一个可达元素。
 *   - **每段到达后必须重新查询**（链与本区域表都会变），并用 `location.区域`（T23.6）
 *     校验是否真的移动了——**不把链当计划**。
 *
 * 纯层，零宿主依赖；不建持久图（D20：运行期现查）。
 *
 * @module mud-core3/nav/route
 */

/** 路径表一条边。 */
export interface WalkEdge {
  /** 目的地原文（含 `◇ 地点` 修饰，如 `襄阳  ◇ 城中心`）。 */
  readonly dest: string
  /** `walk` 的拼音名（如 `xiangyang`）。 */
  readonly pinyin: string
  /** 步数（大致耗时参考）。 */
  readonly steps: number
}

/** 本区域路径表（区域名可缺省——非路线表或没读到开行）。 */
export interface WalkTable {
  readonly region?: string
  readonly edges: readonly WalkEdge[]
}

/** `-q` 参考链：目标 + 途经区域（末位即目标）。 */
export interface CrossRegionHint {
  readonly to: string
  readonly via: readonly string[]
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
/** `从这里到襄阳途径扬州、中原、襄阳。` */
const HINT_RE = /^从这里到(.+?)途径(.+?)。/

/** 按 `│` 切 cell（trim；去掉首尾边界产物空串）。 */
function cells(text: string): string[] {
  const parts = text.split('│').map(s => s.trim())
  while (parts.length > 0 && parts[0] === '') parts.shift()
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * 解析路径表（行数组，任意顺序/含边框与表头）。
 * 区域名取自块开行；表行需同时具备**拼音名 cell** 与**纯数字步数 cell**（缺一不入表，不猜）。
 */
export function parseWalkTable(lines: readonly string[]): WalkTable {
  let region: string | undefined
  const edges: WalkEdge[] = []
  for (const text of lines) {
    if (TABLE_OPEN_RE.test(text)) {
      region = region ?? SECTION_CJK_RE.exec(text)?.[0]
      continue
    }
    if (!TABLE_ROW_RE.test(text)) continue
    const c = cells(text)
    if (c.some(x => HEADER_PINYIN_RE.test(x)) || c.some(x => HEADER_STEPS_RE.test(x)) || c.some(x => HEADER_DEST_RE.test(x))) continue
    const pinyin = c.find(x => PINYIN_RE.test(x))
    const steps = c.find(x => STEPS_RE.test(x))
    const dest = c.find(x => HAS_CJK_RE.test(x))
    if (pinyin === undefined || steps === undefined || dest === undefined) continue
    edges.push({ dest, pinyin, steps: Number.parseInt(steps, 10) })
  }
  return { ...(region !== undefined ? { region } : {}), edges }
}

/** 解析 `-q` 参考链；不成句 ⇒ `null`（不猜）。 */
export function parseCrossRegionHint(text: string): CrossRegionHint | null {
  const m = HINT_RE.exec(text.trim())
  if (m === null) return null
  const to = (m[1] ?? '').trim()
  const via = (m[2] ?? '').split('、').map(s => s.trim()).filter(s => s !== '')
  if (to === '' || via.length === 0) return null
  return { to, via }
}

/**
 * 挑下一跳：① 目标在本区域表里可达 ⇒ **直达**；② 否则沿参考链取**第一个可达元素**；
 * ③ 都不行 ⇒ `null`（回给 agent，不硬走）。匹配用**双向包含**（`襄阳  ◇ 城中心` ↔ `襄阳`）。
 */
export function pickNextHop(table: WalkTable, hint: CrossRegionHint): WalkEdge | null {
  return matchEdge(table.edges, hint.to) ?? hint.via.reduce<WalkEdge | null>(
    (hit, name) => hit ?? matchEdge(table.edges, name),
    null,
  )
}

/**
 * 目的地匹配（**双向包含**）：`襄阳  ◇ 城中心` ↔ `襄阳` 视为同一处。
 * 导出给 `nav/graph` 复用（同一事实只写一处）。
 */
export function destMatches(dest: string, name: string): boolean {
  return dest.includes(name) || name.includes(dest)
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

/** 方向序列（区域内"最后一程"，**可执行**——与 `-q` 的"区域名链只有参考意义"对照）。 */
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
export function parseDirectionPath(lines: readonly string[]): DirectionPath | null {
  let to = ''
  let directions: string[] | null = null
  let short: string | undefined
  for (const text of lines) {
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

function matchEdge(edges: readonly WalkEdge[], name: string): WalkEdge | null {
  const hit = edges.find(e => destMatches(e.dest, name))
  return hit ?? null
}
