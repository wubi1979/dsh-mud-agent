/**
 * commands/usr — 玩家/交互命令族条目（T26.1 骨架；DEC-18 构建期数组）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，T26.7 覆盖审计门）。A.6
 * 纪律：不得凭印象写正则——确认词/频道/社交 emote 等「易遗漏族」属 `'ga'`
 * 形态（A.2 共享事实：即时命令 GA 1:1，无需逐条语料），清单实录后按族回填。
 */

import { byOutcomes, defineCommand } from './define.ts'

/** 玩家/交互命令族（walk；bai 等待 79 清单实录后回填，§3.8 示例条目落地前提）。 */
export const USR_COMMANDS = [
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
      ok: { 到达: { patterns: ['^你到达了'] } },
      fail: { 软阻断: { patterns: ['你因为种种原因停了下来'] } },
    }),
  }),
]
