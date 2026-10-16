/**
 * commands/std — 基础命令族条目（T26.1；DEC-18 构建期数组；T26.6 三形态重整）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，覆盖审计门）；A.6 纪律：
 * 判据原文必须引用附录实录，不得凭印象写正则——`'ga'` 类条目引 A.2 共享事实
 *（即时命令 GA 1:1，无需逐条语料），`'criteria'` / `'quiet'` 类逐条指附录 A。
 */

import { byBoundary, byOutcomes, defineCommand } from './define.ts'

/** 基础命令族（sleep；drink/eat 喝吃 2026-10-15 用户供句入库；lm 待实录后回填，见文件尾注释；其余待 79 清单实录。walk 归 usr 分组，2026-10-12 用户澄清）。 */
export const STD_COMMANDS = [
  defineCommand({
    // 睡觉（A.3：受理/完成句原句 2026-10-10 用户提供；全程时长无实测，兜底放宽待校准）。
    // 受理被拒：刚睡过 ⇒ fail 语义条目立即收窗，拒绝句原文回给 agent 自决。原句尾随
    // 空格不进判据（子串匹配两侧兼容：句体命中即收，行文带不带尾随空白都能命中）。
    id: 'sleep',
    timeoutMs: 300_000,
    meta: { corpus: '附录 A.3（2026-10-10 用户提供）' },
    resolve: byOutcomes({
      ok: { 完成: { patterns: ['你一觉醒来，精神抖擞地活动了几下手脚'] } },
      fail: { 刚睡过: { patterns: ['你刚刚睡过一觉, 多睡对身体有害无益!'] } },
    }),
  }),
  // 喝（标准命令 drink，别名 he；A.3：判据原句 2026-10-15 用户提供，茶水场景
  // 基础形态）：即时命令——应答句后即 GA（A.2 1:1），形态取 `'ga'`（GA 是主
  // 收束，timeoutMs 纯兜底）；分类语义条目声明即断言：命中按语义条目路由，全不命中 ⇒
  // fail「分支未知」。其余饮品行文变体待实录回填 patterns（行文变体不分条目，
  // DEC-7）；句尾句号不进判据（子串匹配两侧兼容，同 sleep 条目口径）。
  defineCommand({
    id: 'drink',
    aliases: ['he'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.3（2026-10-15 用户提供）' },
    resolve: byBoundary({
      ok: { 喝下: { patterns: ['你端起桌上的茶具，咕噜咕噜地喝了几口茶下去', '你感觉有点口渴，于是捧起窗边的山泉水，慢慢喝了下去。'] } },
      fail: { 喝饱: { patterns: ['你已经喝饱了，再也喝不下一丁点了'] } },
    }),
  }),
  // 吃（标准命令 eat，别名 chi；A.3：判据原句 2026-10-15 用户提供，包子场景
  // 基础形态）：口径同 drink 条目。
  defineCommand({
    id: 'eat',
    aliases: ['chi'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.3（2026-10-15 用户提供）' },
    resolve: byBoundary({
      ok: { 吃下: { patterns: ['你拿起包子咬了几口', '你拿起干粮咬了几口。'] } },
      fail: { 吃太饱: { patterns: ['你已经吃太饱了，再也塞不下任何东西了'] } },
    }),
  }),
  // 看环境（标准命令 look，别名 l；T29 用户口径 2026-10-15 登记）：即时命令——
  // 应答后即 GA（A.2 1:1），形态取 `'ga'`，关窗即 next（无分类语义条目——房间
  // 描述是自由文本，无结构化捕获判据；位置感知走 walk 系列本地规则，tracker 本地）。
  defineCommand({
    id: 'look',
    aliases: ['l'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户口径 2026-10-15（表类命令收束同律）' },
    resolve: byBoundary(),
  }),
  // 拍手（标准命令 clap，无别名；用户供句 2026-10-16 登记）：即时人物动作命令——
  // 动作行文后即 prompt+GA（A.2 1:1；用户供句两例实证：裸 clap 与 `clap 4` 各有
  // 行文变体），形态取 `'ga'`，关窗即 next（动作行文是自由变体文本，无分类语义
  // 条目、无捕获）。特殊形态 `clap 3` **在剑心居副本内**触发小童应答——由 task
  // 分组同名条目接管（解析序任务条目优先，任务条目 exempt 排除非 `clap 3` 形态
  // 落回本条目）；副本外 `clap 3` 仍归本条目 ga 收窗（剑心居外不触发小童）。
  defineCommand({
    id: 'clap',
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户供句 2026-10-16（A.3）' },
    resolve: byBoundary(),
  }),
  // LM（无判据无 GA 的命令，用户举例）：固定采样窗——窗长即 timeoutMs（A.6：
  // 只有实录证明「无判据无 GA」之后才允许 quiet 形态；命令头与应答速度分布
  // 待实录后回填并谨慎选择窗长——注释纪律：quiet 与 timeout 配合使用，timeout
  // 需谨慎选择时长。6.2 第 7 项）。
  // defineCommand({ id: 'lm', timeoutMs: 3_000, meta: { corpus: 'A.x（待补）' }, resolve: byWindow() }),
]
