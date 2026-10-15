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
  /** 语料出处（A.6 纪律）：ga 类可引 A.2 共享事实；其余逐条指附录 A。 */
  readonly meta: { readonly corpus: string }
}

/** 条目入参（aliases/exempt/maxLines/flags 可省；exactOptionalPropertyTypes 安全）。 */
export interface CommandProfileInput {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly exempt?: RegExp
  readonly timeoutMs: number
  readonly maxLines?: number
  readonly flags?: string
  readonly resolve: Judge
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
    meta: { corpus: c.meta.corpus },
  }
}
