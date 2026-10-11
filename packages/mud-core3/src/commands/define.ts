/**
 * commands/define — 命令条目契约 + 四判定器（T26.1；DEC-15「判定器即形态」）。
 *
 * 条目 = **纯数据单元**（DEC-15）：`{ id, aliases?, exempt?, timeoutMs,
 * maxLines?, resolve, meta }`，不含行为——执行只有一条路径（`resolveAwaitPlan`
 * → ReadMachine，见 command-profiles.ts），条目只描述「服务器的应答长什么样」。
 *
 * **形态 = 判定器选择**（DEC-3）：代码面四个具名工厂（`byBoundary` /
 * `byOutcomes` / `byQuiet` / `bySilence`），数据面即 `closeOn` 四值封闭枚举
 *（契约层 `ClosureKind`），两者同构；工厂签名编译期挡住形态参数不合
 *（`byOutcomes` 缺 `outcomes`、`byQuiet`/`bySilence` 缺 `quietMs` 等）。
 *
 * **枚举位置**（§3.3）：结局枚举 `OutcomeName` 与形态枚举 `ClosureKind` 都
 * 定义在契约层（`mud-workflow/contract` 词汇表单点）——它们是词汇表不是数据，
 * 故不违反 §8.8；本文件只能把正则挂到枚举成员上（DEC-7/DEC-15）。
 *
 * 判据句**内联**在槽里（DEC-20 撤销共享常量后的口径），原文以附录 A 实录为
 * 准（A.6 纪律：不得凭印象写正则）；同句跨条目复现时就地提常量。
 *
 * 构建期数组、无运行期注册面（DEC-18）：条目由各分组文件 `defineCommand(...)`
 * 数组元素静态列出，agent 不可修缮；调用点显式声明（listen / wait）是唯一逃生口。
 */

import type { OutcomeName, OutcomeSlot, SlotTable } from 'mud-workflow/contract'

export type { OutcomeName, OutcomeSlot, SlotTable }

/**
 * 判定器返回的数据形态 = `closeOn` 四值（可序列化；调用点 wait / listen 直接
 * 声明同一形状——同一形态两处使用，§3.10）。
 *
 * 各形态下槽的语义（§3.2）：
 *   - `ga`：GA/EOR 收窗，**槽仅分类**（命中即带结局名；未命中则收窗、无结局、
 *     不记失配 error）；
 *   - `criteria`：**槽收窗**（fail 先于 ok），GA 不武装（受理帧 GA 正是要忽略的）；
 *   - `race`：槽收窗，与静默（`quietMs`）竞速，先到者收窗；
 *   - `quiet`：**纯静默收窗，所有槽仅分类**——静默是唯一收窗者；收束以命中帧
 *     `by: 'silence'` 上报，outcome 取 `patterns: []` 的推定槽（缺省 `推定完成`）。
 */
export type Judge =
  | { readonly closeOn: 'ga'; readonly outcomes: SlotTable }
  | { readonly closeOn: 'criteria'; readonly outcomes: SlotTable }
  | { readonly closeOn: 'race'; readonly quietMs: number; readonly outcomes: SlotTable }
  | { readonly closeOn: 'quiet'; readonly quietMs: number; readonly outcomes: SlotTable }

/** `byBoundary` — GA 收窗（即时命令；槽仅分类）。 */
export function byBoundary(outcomes: SlotTable): Judge {
  return { closeOn: 'ga', outcomes }
}

/** `byOutcomes` — 判据收窗，GA 不武装（长程命令；fail 槽先于 ok 槽判定）。 */
export function byOutcomes(outcomes: SlotTable): Judge {
  return { closeOn: 'criteria', outcomes }
}

/** `byQuiet` — 判据与静默竞速（walk：到达/软阻断句与行走静默窗赛跑）。 */
export function byQuiet(quietMs: number, outcomes: SlotTable): Judge {
  return { closeOn: 'race', quietMs, outcomes }
}

/**
 * `bySilence` — 纯静默收窗（既无完成判据也无 GA 的命令，如 LM）。缺省产出
 * **唯一推定槽** `推定完成`（`patterns: []`，由静默机制填，DEC-5）；调用方
 * 传入的槽仅分类（`quiet` 下静默是唯一收窗者，§3.2）。
 */
export function bySilence(quietMs: number, outcomes?: SlotTable): Judge {
  return {
    closeOn: 'quiet',
    quietMs,
    outcomes: {
      推定完成: { kind: 'ok', patterns: [] },
      ...outcomes,
    },
  }
}

/** 命令单元（数据，不含行为）。 */
export interface CommandProfile {
  /** 规范命令头 = 表键（'dazuo'）；缝侧按首词精确命中，match 由 id/aliases 派生。 */
  readonly id: string
  /** 族（'dz'；xue/learn/practice 共条目）。 */
  readonly aliases: readonly string[]
  /** 查询/豁免子形态（如 walk -c/-q）：命中即不套用本条目（§8.7）。 */
  readonly exempt?: RegExp
  /** 预算法定值（系统注入；豁免模型面 60s 钳制，§8.7）。 */
  readonly timeoutMs: number
  /** 行数兜底；缺省不设（剪断会误判）。 */
  readonly maxLines?: number
  /** 形态声明 = 判定器选择。 */
  readonly resolve: Judge
  /** 语料出处（A.6 纪律）：ga 类可引 A.2 共享事实；其余逐条指附录 A。 */
  readonly meta: { readonly corpus: string }
}

/** 条目入参（aliases/exempt/maxLines 可省；exactOptionalPropertyTypes 安全）。 */
export interface CommandProfileInput {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly exempt?: RegExp
  readonly timeoutMs: number
  readonly maxLines?: number
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
    resolve: c.resolve,
    meta: { corpus: c.meta.corpus },
  }
}
