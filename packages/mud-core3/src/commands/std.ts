/**
 * commands/std — 基础命令族条目（T26.1；DEC-18 构建期数组，无运行期注册面）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，T26.7 覆盖审计门）；A.6 纪律：
 * 判据原文必须引用附录实录，不得凭印象写正则——`'ga'` 类条目引 A.2 共享事实
 *（即时命令 GA 1:1，无需逐条语料），`'criteria'` / `'race'` / `'quiet'` 类逐条指附录 A。
 */

import { byOutcomes, byQuiet, defineCommand } from './define.ts'

/** 基础命令族（sleep / walk；其余待 79 清单实录后回填）。 */
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
    // 行走（A.9 结论 5，2026-10-08 实机）：'race' 形态——到达/软阻断句与行走
    // 静默窗竞速。不能用 'ga'（每步都出提示符，GA 计数会第一步就关窗）；静默窗
    // 1500ms 的节奏依据：walk 逐步输出（0.2s~0.8s/步）步间隔远小于 1.5s ⇒ 连续
    // 输出不断流，到达后输出停 ⇒ 静默 1.5s 即收。推定槽（patterns: []）由静默
    // 机制填（DEC-5）；unaccepted / hard-stop 是行为性分类，留 mud_walk 调用侧
    //（DEC-10）。查询类 `-c` / `-q` 走 exempt——其答复含「未受理」同族句，注入
    // 判据会把正常查询误判（§8.7）。
    id: 'walk',
    exempt: /^-(c|q)(\s|$)/,
    timeoutMs: 30_000,
    meta: { corpus: '附录 A.9 结论 5（2026-10-08 实机）' },
    resolve: byQuiet(1500, {
      到达: { kind: 'ok', patterns: ['^你到达了'] },
      软阻断: { kind: 'fail', patterns: ['你因为种种原因停了下来'] },
      推定完成: { kind: 'ok', patterns: [] },
    }),
  }),
]
