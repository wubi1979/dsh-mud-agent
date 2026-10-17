/**
 * commands/task — 任务专用命令族条目（T27，2026-10-15 落地；DEC-18 构建期数组）。
 *
 * **任务专用语义（2026-10-12 用户裁定 + 2026-10-15 行流推断裁定）**：本分组条目
 * **只在对应任务环境内有效**——生效判定 = **会话活跃任务**（任务环境有明确开始/
 * 结束行文标志，`TaskEnvironment` 声明进出判据，mud-sense `TaskDetector` 沿行流
 * 推断置/清标记，断线整体复位）；语义边界 = **只做收窗判据**（任务中先查任务
 * 条目再查全局表，同名任务条目优先），**不拦发送**；任务外不命中 = 未登记不
 * 收窗只等超时（DEC-4）。
 *
 * **不入全局总表**：本分组**不进** assembler 的 rawProfiles（matchCommandProfile
 * 看不到）；按 `task` 标记分组单独装配（assembler.ts `TASK_PROFILES`），解析单点
 * `resolveAwaitPlan(sent, decl, task?)` 第三参透传。
 *
 * 判据逐字实录（A.6 纪律）：语料见附录 A.11（2026-10-15 用户供给）。
 * 武当阵法（zhenfa/zouwei，首用例 A.10）判据待实录后回填。
 */

import { byBoundary, byOutcomes, defineCommand, type CommandProfile, type TaskEnvironment } from './define.ts'

/** 剑心居副本任务标记（A.11 第二用例）。 */
export const JIANXINJU = 'jianxinju'

/**
 * 剑心居任务专用命令（A.11 语料，2026-10-15 用户供给）：
 *   - `clap 3`（鼓掌唤小童，即时类）：应答 = 小童进来问话（师傅不在场/在场两
 *     变体共享锚「进来一名小童，向你欠身行礼」）；'ga' 档 + ok 分类语义条目
 *     （声明即断言）。
 *   - `food`（唤小童进餐，长程）：完成 = 送餐到达（`小童将…送到你面前`——数量/
 *     店铺/食物动态，桥接正则同 A.1 先例）；被拒 = 钱不够（`你的钱不够了`——
 *     句尾「买不起包子」可能随食物变体，取句首锚）。受理句（`小童听罢…`）
 *     **不入 outcomes**（criteria 档受理句命中即关窗——exercise 先例：受理帧
 *     是要忽略的，判据收窗只认完成/被拒）。
 *   - `teacher`（递信搬师傅，长程）：完成 = 师傅进门（`门被推开，…走了进来`——
 *     师傅名动态）；被拒 = 师傅已在场（`原来师父您就在这`）。受理句
 *     （`小童接过信…`）同上不入 outcomes。
 */
export const TASK_COMMANDS: readonly CommandProfile[] = [
  defineCommand({
    // exempt（2026-10-16 用户实测）：`clap` 本身是即时人物动作命令（动作行文后
    // prompt+GA，A.2 1:1），**只有 `clap 3` 在剑心居触发副本唤小童**——豁免非
    // `clap 3` 形态（裸 clap/其他参数），落回全局表 clap 条目 ga 收窗（std 分组）；
    // 恰好 `clap 3` 不豁免，任务中命中本条目收小童应答窗（同名任务条目优先）。
    id: 'clap',
    task: JIANXINJU,
    exempt: /^(?!clap 3$)/,
    timeoutMs: 15_000,
    resolve: byBoundary({
      ok: { 小童应答: { patterns: ['进来一名小童，向你欠身行礼'] } },
      cooldown: { 无人应答: { patterns: ['你轻轻击掌三下，等了一会儿，却不见有人回应。大概都在忙吧。'] } },
    }),
    meta: { corpus: 'A.11：clap 3 成功应答（问 food/teacher 与只问 food 两变体共享锚）；豁免判据 = 2026-10-16 用户实测（裸 clap 为动作命令）' },
  }),
  defineCommand({
    id: 'food',
    task: JIANXINJU,
    timeoutMs: 120_000,
    resolve: byOutcomes({
      fail: { 钱不够: { patterns: ['你的钱不够了'] } },
      ok: { 完成: { patterns: ['小童将.+送到你面前'] } },
    }),
    meta: { corpus: 'A.11：food 完成/被拒句（2026-10-15 用户供给；完成句动态桥接；受理句实录留存不判）' },
  }),
  defineCommand({
    id: 'teacher',
    task: JIANXINJU,
    timeoutMs: 120_000,
    resolve: byOutcomes({
      fail: { 师傅在场: { patterns: ['原来师父您就在这'] } },
      ok: { 完成: { patterns: ['门被推开，.+走了进来'] } },
    }),
    meta: { corpus: 'A.11：teacher 完成/被拒句（2026-10-15 用户供给；完成句师傅名动态桥接；受理句实录留存不判）' },
  }),
]

/**
 * 任务环境声明（T27 行流推断）：剑心居进出判据（实录 A.11——2026-10-15 进入句
 * 变更：`你进入了剑心居副本，可以通过leave <玩家名>命令来回到主站。`（玩家名
 * 动态，桥接正则同 A.1 先例）；退出句 `你退出了剑心居副本。` 取副本退出锚）。
 * 多任务并存：不同任务的进出判据互不影响（mud-sense `TaskDetector` 集合语义）。
 */
export const TASK_ENVIRONMENTS: readonly TaskEnvironment[] = [
  {
    task: JIANXINJU,
    enter: ['你进入了剑心居副本，可以通过leave \\S+命令来回到主站'],
    exit: ['退出了剑心居'],
    meta: { corpus: 'A.11：剑心居进入/退出行文（2026-10-15 用户供给；进入句同日变更——副本进入句含 leave 回主站提示，玩家名动态桥接）' },
  },
]
