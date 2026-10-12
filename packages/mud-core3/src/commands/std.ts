/**
 * commands/std — 基础命令族条目（T26.1；DEC-18 构建期数组；T26.6 三形态重整）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，覆盖审计门）；A.6 纪律：
 * 判据原文必须引用附录实录，不得凭印象写正则——`'ga'` 类条目引 A.2 共享事实
 *（即时命令 GA 1:1，无需逐条语料），`'criteria'` / `'quiet'` 类逐条指附录 A。
 */

import { byOutcomes, defineCommand } from './define.ts'

/** 基础命令族（sleep / walk；lm 待实录后回填，见文件尾注释；其余待 79 清单实录）。 */
export const STD_COMMANDS = [
  defineCommand({
    // 睡觉（A.3：受理/完成句原句 2026-10-10 用户提供；全程时长无实测，兜底放宽待校准）。
    // 受理被拒：刚睡过 ⇒ fail 槽立即收窗，拒绝句原文回给 agent 自决。原句尾随
    // 空格不进判据（子串匹配两侧兼容：句体命中即收，行文带不带尾随空白都能命中）。
    id: 'sleep',
    timeoutMs: 300_000,
    meta: { corpus: '附录 A.3（2026-10-10 用户提供）' },
    resolve: byOutcomes({
      完成: { kind: 'ok', patterns: ['你一觉醒来，精神抖擞地活动了几下手脚'] },
      刚睡过: { kind: 'fail', patterns: ['你刚刚睡过一觉, 多睡对身体有害无益!'] },
    }),
  }),
  defineCommand({
    // 行走（A.9 结论 5，2026-10-08 实机）：'criteria' 形态（T26.6 改判——race
    // 退役，2026-10-12）：到达/软阻断判据收窗，GA 不武装（每步都出提示符，GA
    // 计数会第一步就关窗）。判据配条目级 flags 'm'（承重——多行行走窗行首锚：
    // 受理行在窗首，无 'm' 时 '^你到达了' 永不命中，2026-10-12 实证死判据修复）。
    // 非出发点拒绝行文待实录（A.9 挂账，6.2 第 9 项）——实录后升 fail 槽快速
    // 收束；unaccepted / hard-stop 是行为性分类，留 mud_walk 调用侧（DEC-10）。
    // 查询类 `-c` / `-q` 走 exempt——锚定**完整发送串**（DEC-8 修正：旧参数段
    // 正则对 `walk -c` 失配致查询被误注入行走判据），其答复含「未受理」同族句，
    // 注入判据会把正常查询误判（§8.7）。
    id: 'walk',
    exempt: /^walk\s+-(c|q)(\s|$)/,
    timeoutMs: 30_000,
    flags: 'm',
    meta: { corpus: '附录 A.9 结论 5（2026-10-08 实机）' },
    resolve: byOutcomes({
      到达: { kind: 'ok', patterns: ['^你到达了'] },
      软阻断: { kind: 'fail', patterns: ['你因为种种原因停了下来'] },
    }),
  }),
  // LM（无判据无 GA 的命令，用户举例）：固定采样窗——窗长即 timeoutMs（A.6：
  // 只有实录证明「无判据无 GA」之后才允许 quiet 形态；命令头与应答速度分布
  // 待实录后回填并谨慎选择窗长——注释纪律：quiet 与 timeout 配合使用，timeout
  // 需谨慎选择时长。6.2 第 7 项）。
  // defineCommand({ id: 'lm', timeoutMs: 3_000, meta: { corpus: 'A.x（待补）' }, resolve: byWindow() }),
]
