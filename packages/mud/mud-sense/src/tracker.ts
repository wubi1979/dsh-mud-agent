/**
 * mud-sense tracker — 状态追踪器（T19）：游戏文本 → World 结构化状态（判据解析，零 LLM）。
 *
 * **T29 分工（格式归命令条目，机制留本文件）**：六套命令应答格式（hpbrief/hp/
 * sc/i/skills/exp）已迁 mud-commands **随命令条目就地定义**（条目 capture 登记，
 * D7 登记原则），捕获契约类型归 `mud-commands` 的 define（条目契约单点）；
 * **块语法（线框四角 + cell 切分符）同为格式定义**，随契约声明于 define 的
 * `TABLE_BLOCK_FORMAT`（2026-10-15 用户裁定：定义归声明层——服务器改线框 =
 * 改声明一处），本文件只消费；保留**机制**（块/序列/lines 三形状消费、打标、
 * 写入）与**非命令触发路径**的本地规则（walk-region/walk-departure/walk-started、
 * combat、id——战斗行、walk 受理行、id 别称表不经命令窗；clears 同理留本地，
 * T29 边界纪律：capture 只承载命令应答格式，状态追踪独立于命令表）。
 *
 * 每会话一个实例，在 runtime 行路径 `classifier.mark(line)` 之后 `observe(line)`（D1，
 * 与 C5.2 打标同一单点）。三类形状（D3）：
 *   - `table`：框线表格块（`┌` 开、`└` 闭；`├` 边框行可携带中文节标题）。块内每行
 *     **就地打 `status` 标**（D8 剔除投递 + 副屏行环；kind 必须在 observe 内同步定案
 *     —— screen.write 在行路径随行路由，事后补标对画面无效）。World 写入仍需
 *     **规则命中**（行级 match，声明序首个命中者独占该行）；无命中的块只剔不写。
 *     挂**块归约器**（`CaptureRule.block`，T29 D5）的规则（i/exp）：命中产出过
 *     `step`（立即写部分随返即写 + 块内积攒按 rule id 存 accum），块收口（└ 或
 *     失控止损）`flush` 一次性写终产出；无 block 的表规则维持命中直写。
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
 * 纯 TS，零宿主依赖（mud-commands 为构建期规则源，T29 D2 新包边）。
 *
 * @module mud-sense/tracker
 */

import type { MudLine } from 'mud-link/line'
import { COMMAND_CAPTURE_RULES, TABLE_BLOCK_FORMAT } from 'mud-commands'
import type { AnyCaptureRule, RowContext, SequenceCaptureRule, CaptureEntry, CaptureRule, CaptureShape } from 'mud-commands'

/** 捕获契约类型自 mud-commands（define 条目契约单点）type-only 引入（T29 D2）；
 *  re-export 保持本模块既有公开面稳定（既有消费者按旧路径取型不受影响）。 */
export type { AnyCaptureRule, RowContext, SequenceCaptureRule, CaptureEntry, CaptureRule, CaptureShape }

/** 追踪打标 kind（D8）：打此标的行不进 agent 投递（deliver 剔除）、进副屏行环。 */
export const STATUS_KIND = 'status'

/** 追踪规则集（可注入覆盖；缺省 DEFAULT_TRACK_SPEC）。 */
export interface TrackSpec {
  readonly rules: readonly AnyCaptureRule[]
  readonly clears?: readonly TrackClearRule[]
}

/** clear 规则（D9）：行文命中即消解 World 条目（按例证逐条加）。
 *  **留 tracker 本地**（T29 边界纪律：存在非命令触发路径，不入命令表）。 */
export interface TrackClearRule {
  readonly pattern: RegExp
  readonly zone: string
  readonly key: string
}

/** 追踪器写/消解回调（runtime 薄封装进 World + onWorldChange 广播）。 */
export interface StateTrackerDeps {
  onWrite(zone: string, key: string, value: unknown): void
  onDelete(zone: string, key: string): void
}

// ── 表格块机制判据（§2.1）────────────────────────────────────────────
// 块语法（四角 + cell 切分符）= 格式定义，随捕获契约声明于 mud-commands
//（`TABLE_BLOCK_FORMAT`，2026-10-15 用户裁定：定义归声明层，机制只消费——
// 服务器改线框 = 改声明一处，本文件不出现线框字符）。

const FMT = TABLE_BLOCK_FORMAT
/** 节标题提取：优先方括号内文本（`[装  备]` 内空格剥离；实录 A.7.4），
 *  否则首个 ≥2 字的中文连串（如 四项杂学/基本功夫）。 */
const SECTION_CJK_RE = /[\u4e00-\u9fff]{2,}/
const SECTION_BRACKET_RE = /\[([^\[\]]*)\]/

function sectionOf(text: string): string | undefined {
  const b = SECTION_BRACKET_RE.exec(text)?.[1]
  if (b !== undefined) {
    const t = b.replace(/\s+/g, '')
    if (/^[\u4e00-\u9fff]{2,}$/.test(t)) return t
  }
  return SECTION_CJK_RE.exec(text)?.[0]
}

// ── 位置感知判据（T23.6；出处 = 附录 A.9 结论 4/5/6）──────────────────

/** 路线表表头行（`│目的地 … │拼音名称 … │步数 … │`）：区域名取自块开行。 */
const WALK_TABLE_HEADER_RE = /拼音名称/
const WALK_TABLE_STEPS_RE = /步数/

/** 出发点列表行（未受理答复与 `-c` 答复同族）：`当前区域共有N处内建玩家路径起点，分别在A、B、C。` */
const WALK_DEPARTURES_RE = /当前区域共有\d+处内建玩家路径起点，分别在(.+?)。/

/** 受理确认行（A.9 结论 4）：`你决定开始前往…方向走去……`。 */
const WALK_STARTED_RE = /^你决定开始前往/

/** walk 路线表 ⇒ `location.区域`（块开行的中文串，实录 `┌───荆州府──…`）。 */
function walkRegionRow(row: RowContext): CaptureEntry[] | undefined {
  if (!row.cells.some(c => WALK_TABLE_HEADER_RE.test(c)) || !row.cells.some(c => WALK_TABLE_STEPS_RE.test(c))) return undefined
  return row.blockHeader !== undefined ? [{ key: '区域', value: row.blockHeader }] : undefined
}

/** 出发点答复 ⇒ `location.出发点`（本区域起点列表；未受理与 `-c` 同族，事实一致）。 */
function walkDepartureRow(row: RowContext): CaptureEntry[] | undefined {
  const m = WALK_DEPARTURES_RE.exec(row.raw)
  if (m === null) return undefined
  const list = (m[1] ?? '').split('、').map(s => s.trim()).filter(s => s !== '')
  return list.length > 0 ? [{ key: '出发点', value: list }] : undefined
}

/** 受理行 ⇒ `location.出发点就绪` = true（正向证据；**负判断走反证**：见工具面"没出表/没出受理行"）。 */
function walkStartedRow(row: RowContext): CaptureEntry[] | undefined {
  return WALK_STARTED_RE.test(row.raw) ? [{ key: '出发点就绪', value: true }] : undefined
}

/** 表格块行数护栏：超限视为失控块（无 └ 收尾），强制闭块止损。 */
const MAX_TABLE_LINES = 120

/** 按 cell 切分符切行 cell（trim；去掉首尾边界产物空串，中间空 cell 保留由规则忽略）。 */
function splitRowCells(text: string): string[] {
  const parts = text.split(FMT.cellDelimiter).map(s => s.trim())
  while (parts.length > 0 && parts[0] === '') parts.shift()
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
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

function aliasRow(row: RowContext): CaptureEntry[] | undefined {
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
function combatRow(row: RowContext): CaptureEntry[] | undefined {
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
 * 缺省追踪规则（T29 全序 = 现役全序）：walk-region 居首 → **命令捕获格式**
 *（COMMAND_CAPTURE_RULES，装配规范序 hpbrief→hp→sc→i→skills→exp，D4——i 先于
 * skills 堵技能行抢装备表行；hp/sc/i/skills 先于 exp）→ id/combat/walk 行流
 * 规则（tracker 本地，非命令触发路径）。声明序 = 行匹配优先序（表格行声明序
 * 首个命中者独占）；id（lines）与表格不争行。
 */
export const DEFAULT_TRACK_RULES: readonly AnyCaptureRule[] = [
  { id: 'walk-region', shape: 'table', zone: 'location', match: walkRegionRow },
  ...COMMAND_CAPTURE_RULES,
  { id: 'id-header', shape: 'lines', zone: 'items', match: (row) => (ALIAS_HEADER_RE.test(row.raw) ? [] : undefined) },
  { id: 'id', shape: 'lines', zone: 'items', match: aliasRow },
  { id: 'combat', shape: 'lines', zone: 'combat', match: combatRow },
  { id: 'walk-departure', shape: 'lines', zone: 'location', match: walkDepartureRow },
  { id: 'walk-started', shape: 'lines', zone: 'location', match: walkStartedRow },
]

/** 缺省 clear 规则（D9；按例证逐条加；**tracker 本地**，T29 边界纪律）。 */
export const DEFAULT_TRACK_CLEARS: readonly TrackClearRule[] = [
  // PLAN §2.4 例证：饥饿消解（hp 表 [缺食] 写入的 食物状态 消失）。
  { pattern: /你不再感到饥饿/, zone: 'vitals', key: '食物状态' },
]

export const DEFAULT_TRACK_SPEC: TrackSpec = {
  rules: DEFAULT_TRACK_RULES,
  clears: DEFAULT_TRACK_CLEARS,
}

// ── 状态追踪器 ──────────────────────────────────────────────────────

/** 块内最小状态（§2.1）：「当前节标题 + 已见行数（护栏用）」；挂块归约器的规则
 *  （i/exp）按 rule id 存积攒（T29 D5 泛化，消除 id 特例字段）。 */
interface BlockState {
  section?: string
  rows: number
  /** 块开行（`┌…`）的中文串（T23.6：walk 路线表开行即区域名；hp 等无中文开行为空）。 */
  header?: string
  /** 块归约器积攒：规则首次命中时 init，逐行 step，收口 flush（键 = 规则 id）。 */
  accums?: Map<string, { rule: CaptureRule; value: unknown }>
}

/** 序列状态：所属规则 + 已攒行（打标随到随打，写入等凑齐全量校验）。 */
interface SeqState {
  rule: SequenceCaptureRule
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
    if (FMT.open.test(text)) {
      const header = sectionOf(text)
      this.block = { rows: 0, ...(header !== undefined ? { header } : {}) }
      this.tag(line)
      return
    }
    if (this.block !== null) {
      this.tag(line)
      if (FMT.close.test(text)) {
        this.finishTableBlock()
        this.block = null
      } else if (FMT.row.test(text)) {
        this.matchTableRow(text)
        this.block.rows += 1
        if (this.block.rows > MAX_TABLE_LINES) { // 失控块止损（标已打，不再解析）
          this.finishTableBlock()
          this.block = null
        }
      } else if (FMT.border.test(text)) {
        const section = sectionOf(text)
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
      if (r.shape === 'sequence' && (r as SequenceCaptureRule).head.test(text)) {
        const rule = r as SequenceCaptureRule
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
   *  挂块归约器的规则（T29 D5，现役 = i/exp）：产出过 step——立即写部分随返即写、
   *  块内积攒按 rule id 留块状态；无 block 的表规则维持命中直写。 */
  private matchTableRow(text: string): void {
    const block = this.block
    if (block === null) return
    const cells = splitRowCells(text)
    for (const r of this.spec.rules) {
      if (r.shape !== 'table') continue
      const ctx: RowContext = {
        cells, raw: text, index: block.rows,
        ...(block.section !== undefined ? { section: block.section } : {}),
        ...(block.header !== undefined ? { blockHeader: block.header } : {}),
      }
      const entries = r.match(ctx)
      if (entries !== undefined) {
        if (r.block !== undefined) {
          const accums = block.accums ?? (block.accums = new Map())
          let holder = accums.get(r.id)
          if (holder === undefined) {
            holder = { rule: r, value: r.block.init() }
            accums.set(r.id, holder)
          }
          this.write(r.block.step(holder.value, ctx, entries), r.zone)
        } else {
          this.write(entries, r.zone)
        }
        return
      }
    }
  }

  /** 表格块收口（└ 或失控止损）：块归约器积攒 flush 统一写（T29 D5 泛化，
   *  语义与旧 expPairs/inv 特例字段逐键等价）。 */
  private finishTableBlock(): void {
    const block = this.block
    if (block === null) return
    if (block.accums !== undefined) {
      for (const { rule, value } of block.accums.values()) {
        if (rule.block === undefined) continue
        this.write(rule.block.flush(value), rule.zone)
      }
    }
  }

  /** 序列收口：逐行 match 全部成功才写（D5）；任一行不合格 ⇒ 整组不写不猜。 */
  private finishSequence(): void {
    const seq = this.seq
    this.seq = null
    if (seq === null) return
    const collected: CaptureEntry[] = []
    for (let i = 0; i < seq.rows.length; i++) {
      const ln = seq.rows[i]
      if (ln === undefined) return
      // head 命中部分剥离 + 按规则声明切分符切 cell（序列格式随规则声明，引擎零格式知识）。
      const cells = ln.text.replace(seq.rule.head, '').split(seq.rule.cellSplit).map(s => s.trim())
      const entries = seq.rule.match({ cells, raw: ln.text, index: i })
      if (entries === undefined) return
      collected.push(...entries)
    }
    this.write(collected, seq.rule.zone)
  }

  /** 产出写入（entry.zone 可覆盖规则 zone，如 hpbrief 的 combat 两键）。 */
  private write(entries: readonly CaptureEntry[], defaultZone: string): void {
    for (const e of entries) {
      this.deps.onWrite(e.zone ?? defaultZone, e.key, e.value)
    }
  }
}
