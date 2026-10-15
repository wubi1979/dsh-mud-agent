/**
 * commands/define — 命令条目契约 + 三判定器（T26.1；DEC-15「判定器即形态」；
 * T26.6 三形态终态 2026-10-12）。
 *
 * 条目 = **纯数据单元**（DEC-15）：`{ id, aliases?, exempt?, timeoutMs,
 * maxLines?, flags?, resolve, meta }`，不含行为——执行只有一条路径
 *（`resolveAwaitPlan` → ReadMachine，见 command-profiles.ts），条目只描述
 * 「服务器的应答长什么样」。
 *
 * **形态 = 判定器选择**（DEC-3 三值）：代码面三个具名工厂（`byBoundary` /
 * `byOutcomes` / `byWindow`），数据面即 `closeOn` 三值封闭枚举（契约层
 * `ClosureKind`），两者同构；工厂签名编译期挡住形态参数不合。
 *
 * **契约模式（DEC-23）+ 术语定名（2026-10-15 用户裁定）**：`closeOn` 三值与
 * kind 二分是契约层词汇。**槽位 = ok/fail 判定类型**（kind 的中文定名）；
 * **语义条目 = 具名判据单元**（如 `完成`/`刚睡过`；旧称「槽名/槽」）——条目
 * 数据、自由命名（命名纪律：分支类目化、行文变体进同条目 patterns 不分条目、
 * 应对不同才分条目，见 PLAN DEC-7）。判据表与路由表同构——**槽位在前、
 * 语义条目在内**（outcomes 外层键 = ok/fail 槽位，语义条目不带 kind；
 * 2026-10-12 用户裁定统一）。保留字 `ok`/`fail` 由装配期自检拒。
 * 代码标识符不改（`kind` = 槽位、`slots[].name` = 语义条目名）；旧措辞
 * 「X 槽」按语境读作「X 槽位的语义条目」。
 *
 * 判据句**内联**在语义条目里（DEC-20 口径），原文以附录 A 实录为准（A.6 纪律：
 * 不得凭印象写正则）；同句跨条目复现时就地提常量。
 *
 * 构建期数组、无运行期注册面（DEC-18）：条目由各分组文件 `defineCommand(...)`
 * 数组元素静态列出，agent 不可修缮；调用点显式声明（listen / wait）是唯一逃生口。
 *
 * **捕获契约也归本文件**（T29，2026-10-15 用户裁定：`capture` 字段是命令条目
 * 契约的成员，其数据形状——`CaptureRule`/`BlockReducer` 等——随字段住在条目契约
 * 单点，不单开文件）。**捕获 = 命令总表的通用形态**：所有命令条目都可按此
 * 契约声明 `capture` 实现捕获（非 tracker 专属——tracker 只是该契约的执行
 * 机制之一）。六套格式实现**随命令条目就地定义**于分组文件（`skill.ts`/`usr.ts`），
 * 条目 `capture` 本地引用；tracker 机制 type-only 引用本文件类型，格式数据经
 * 装配器规范序汇出（assembler.ts `COMMAND_CAPTURE_RULES`）。
 */

import type { ClosureKind, OutcomeSlot, SlotTable } from 'mud-workflow/contract'

export type { ClosureKind, OutcomeSlot, SlotTable }

/**
 * 判定器返回的数据形态 = `closeOn` 三值（可序列化；调用点 wait / listen 直接
 * 声明同一形状——**一个语法三个消费点**，§3.10 / DEC-21）。
 *
 * 各形态下语义条目的语义（PLAN 3.2）：
 *   - `ga`：GA/EOR 收窗（`gaCount` 缺省 1，如 2 = 等第 2 个 GA 才关窗）；
 *     **分类语义条目可选——声明即断言**：窗口关闭时无一命中 ⇒ fail 路由 +
 *     「收窗成功，分支未知」（DP 裁定 1/8）；未声明 ⇒ 关窗即 next；
 *   - `criteria`：**语义条目收窗**（fail 槽位先于 ok 槽位 = 判定序），GA 不武装
 *     （受理帧 GA 正是要忽略的）；
 *   - `quiet`：**固定采样窗**（窗长 = 条目 `timeoutMs`，唯一计时器、行只累积
 *     不重置；到点关窗：有行 ⇒ ok、零行 ⇒ fail）——无 outcomes（要分类
 *     说明写得出判据，那是 criteria 的事）。
 *
 * `SlotTable` 形状（槽位在前）：`{ ok?: { 语义条目名: { patterns } }, fail?: { … } }`。
 */
export type Judge =
  | { readonly closeOn: 'ga'; readonly gaCount?: number; readonly outcomes?: SlotTable }
  | { readonly closeOn: 'criteria'; readonly outcomes: SlotTable }
  | { readonly closeOn: 'quiet' }

/** `byBoundary` — GA 收窗（即时命令；gaCount 缺省 1；分类语义条目可选——声明即断言）。 */
export function byBoundary(outcomes?: SlotTable, gaCount?: number): Judge {
  return {
    closeOn: 'ga',
    ...(outcomes !== undefined ? { outcomes } : {}),
    ...(gaCount !== undefined ? { gaCount } : {}),
  }
}

/** `byOutcomes` — 判据收窗，GA 不武装（长程命令；fail 槽位先于 ok 槽位判定）。 */
export function byOutcomes(outcomes: SlotTable): Judge {
  return { closeOn: 'criteria', outcomes }
}

/**
 * `byWindow` — 固定采样窗（无明确边界的命令，如 LM）。窗长即条目 `timeoutMs`
 * （**注释纪律**：quiet 判据与 timeout 配合使用，timeout 需谨慎选择时长——
 * 编写责任，非设计代价，用户裁定 2026-10-12）。如果后期需要静默等待指定行数可考虑增加 `LineCount`。
 */
export function byWindow(): Judge {
  return { closeOn: 'quiet' }
}

// ── 捕获契约（T29：capture 字段的数据形状；**命令总表通用形态**——所有命令
//    条目都可按此契约实现捕获，tracker 机制 type-only 引用）──────────────
// **命名空间纪律**：规则 id 独立于命令 id/别名，两命名空间不保证对应——规则
// 'sc' 对应命令 score、规则 'i' 对应命令 inventory（且其命令别名亦为 'i'）。
// 装配期自检（assembler.ts）错误信息双写「规则 id + 所属命令 id」。
// **边界纪律（T29 PLAN §1.3）**：capture 只承载**命令应答格式**；walk/combat/
// id/clears 等存在**非命令触发路径**的格式永久留 mud-sense/tracker 本地。

/** 捕获形状（命令应答的三类捕获方式）。 */
export type CaptureShape = 'table' | 'lines' | 'sequence'

/** 单条捕获产出（zone 缺省 = 所属规则的 zone）。 */
export interface CaptureEntry {
  readonly key: string
  readonly value: unknown
  readonly zone?: string
}

/** 规则匹配的行上下文。raw = 本行 text（无 ANSI 变体，同 classify 判据匹配面）。 */
export interface RowContext {
  readonly cells: readonly string[]
  readonly raw: string
  readonly section?: string
  /** 块开行（`┌…`）携带的事实（T23.6：walk 路线表表头即区域名）。 */
  readonly blockHeader?: string
  readonly index: number
}

/** 块归约器（T29 D5）：表规则的块内积攒契约（机制在 tracker，积攒知识随格式）。 */
export interface BlockReducer {
  /** 块内首次命中时初始化积攒状态（块与块之间不共享）。 */
  init(): unknown
  /** 命中一行：更新积攒，返回本行需要立即写出的产出（空数组 = 只积攒）。 */
  step(acc: unknown, ctx: RowContext, entries: readonly CaptureEntry[]): readonly CaptureEntry[]
  /** 块收口（└ 或失控止损）时一次性返回最终产出。 */
  flush(acc: unknown): readonly CaptureEntry[]
}

/** 捕获规则：match 返回 0..n 条产出（`undefined` = 本规则不匹配该行）。 */
export interface CaptureRule {
  readonly id: string
  readonly shape: CaptureShape
  readonly zone: string
  readonly match: (row: RowContext) => CaptureEntry[] | undefined
  /** 块归约器（可选；仅 table 形状有意义——挂了就不再「命中直写」）。 */
  readonly block?: BlockReducer
}

/** sequence 规则：head 命中即开序列，连续 length 行凑齐后逐行 match，全成才写。
 *  行内 cell 切分随规则声明（cellSplit）——序列格式是**规则自理的特殊格式**
 *  （现役唯一 hpbrief），引擎不携带格式知识。 */
export interface SequenceCaptureRule extends CaptureRule {
  readonly shape: 'sequence'
  readonly head: RegExp
  readonly length: number
  /** 行内 cell 切分符（head 命中部分剥离后按此切 cell；现役 hpbrief = ','）。 */
  readonly cellSplit: string
}

/** 全形状规则联合（sequence 附带 head/length）。 */
export type AnyCaptureRule = CaptureRule | SequenceCaptureRule

/**
 * 块语法（T29 格式/机制二分修正，2026-10-15 用户裁定）：线框四角 + cell 切分符
 * = 「服务器长什么样」的**格式定义**（实录 A.7，A.6 纪律管辖）——表格块归属的
 * **唯一锁定依据**（凡需捕获的基本都是线框格式，hpbrief 序列是唯一例外；lines
 * 逐行判据本就无法通用，随各规则自理）。定义随捕获契约声明于此（定义归声明层），
 * tracker 机制只消费不定义——**服务器改线框 = 只改本声明一处**（规则判据与流程
 * 判据中的线框引用——如 hp/sc 文本判据的 `[^│]` 终止符、walk `出发点表` 判据
 * `^┌`——一并由本声明组装，消除多调用点散落）。
 */
export interface TableBlockFormat {
  /** 块开行（`┌…`；其携带的中文串 = blockHeader）。 */
  readonly open: RegExp
  /** 表行（`│…`）。 */
  readonly row: RegExp
  /** 边框行（`├…`，可携带中文节标题）。 */
  readonly border: RegExp
  /** 块收口行（`└…`）。 */
  readonly close: RegExp
  /** 表行 cell 切分符。 */
  readonly cellDelimiter: string
}

/** 现役线框块语法（实录 A.7；改动须先录附录 A）。 */
export const TABLE_BLOCK_FORMAT: TableBlockFormat = {
  open: /^┌/,
  row: /^│/,
  border: /^├/,
  close: /^└/,
  cellDelimiter: '│',
}

/** 命令单元（数据，不含行为）。 */
export interface CommandProfile {
  /** 规范命令头 = 表键（'exercise'）；缝侧按首词精确命中，match 由 id/aliases 派生。 */
  readonly id: string
  /** 族（'exercise'；xue/learn/practice 共条目）。 */
  readonly aliases: readonly string[]
  /** 查询/豁免子形态（如 walk -c/-q）：**测试对象 = 完整发送串**（锚定命令头，
   * DEC-8 修正——参数段正则对完整串失配）；命中即不套用本条目（§8.7）。 */
  readonly exempt?: RegExp
  /** 预算法定值（criteria/ga = 兜底；quiet = 采样窗长）；豁免模型面 60s 钳制。 */
  readonly timeoutMs: number
  /** 行数兜底；缺省不设（剪断会误判）。 */
  readonly maxLines?: number
  /** 条目级正则 flags（如 'm' 多行锚），应用于该条目**全部槽判据**的编译；
   * **默认无**——多行窗行首锚判据（`^`）必须显式配 'm'（DEC-15，walk 承重）。 */
  readonly flags?: string
  /** 形态声明 = 判定器选择。 */
  readonly resolve: Judge
  /** 命令应答捕获格式（T29 D1/D7 登记原则：捕获一律登记在条目——tracker 只引用；
   * 数据形状 = 上方捕获契约；规则 id 独立于命令 id/别名，两命名空间不保证对应）。 */
  readonly capture?: readonly AnyCaptureRule[]
  /** 语料出处（A.6 纪律）：ga 类可引 A.2 共享事实；其余逐条指附录 A。 */
  readonly meta: { readonly corpus: string }
}

/** 条目入参（aliases/exempt/maxLines/flags/capture 可省；exactOptionalPropertyTypes 安全）。 */
export interface CommandProfileInput {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly exempt?: RegExp
  readonly timeoutMs: number
  readonly maxLines?: number
  readonly flags?: string
  readonly resolve: Judge
  readonly capture?: readonly AnyCaptureRule[]
  readonly meta: { readonly corpus: string }
}

/** defineCommand — 条目工厂（identity 语义：形状即上面 CommandProfile）。 */
export function defineCommand(c: CommandProfileInput): CommandProfile {
  return {
    id: c.id,
    aliases: c.aliases ?? [],
    ...(c.exempt !== undefined ? { exempt: c.exempt } : {}),
    timeoutMs: c.timeoutMs,
    ...(c.maxLines !== undefined ? { maxLines: c.maxLines } : {}),
    ...(c.flags !== undefined ? { flags: c.flags } : {}),
    resolve: c.resolve,
    ...(c.capture !== undefined ? { capture: c.capture } : {}),
    meta: { corpus: c.meta.corpus },
  }
}
