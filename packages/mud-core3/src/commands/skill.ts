/**
 * commands/skill — 修炼/技能命令族条目（T26.1；DEC-18 构建期数组）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，T26.7 覆盖审计门）；判据原文
 * 逐字搬自现役实现（tools.ts LONG_CMD_PROFILES，§3.7「不重写正则」），A.6
 * 语料出处见各条目 meta.corpus。
 */

import { byOutcomes, defineCommand } from './define.ts'

/** 修炼/技能命令族（dazuo；xue/learn/practice 等待实录后回填）。 */
export const SKILL_COMMANDS = [
  defineCommand({
    // 打坐（A.3 实录：受理帧 GA 后 57s 无 GA——'criteria' 形态，GA 不武装，
    // 完成句跨批命中收窗；受理被拒句为 fail 槽，立即收窗不空等 120s）。
    // 完成三形态（2026-10-10 用户补）：内息收回 = 正常结束；内力增加了 =
    // 上限突破；运功完毕站起 = 收尾变体。
    // 待实测（§6.2 第 1 项）：拒绝句原文与附录 A 登记串互不相同，以实机实录
    // 为准落实到底是哪几句（含是否多形态），不得凭印象保留。
    id: 'dazuo',
    aliases: ['dz'],
    timeoutMs: 120_000,
    meta: { corpus: '附录 A.3（2026-10-10 用户提供）' },
    resolve: byOutcomes({
      完成: { kind: 'ok', patterns: ['你将运转于全身经脉间的内息收回丹田'] },
      突破: { kind: 'ok', patterns: ['你的内力增加了！！'] },
      收尾: { kind: 'ok', patterns: ['你运功完毕，深深吸了口气，站了起来。'] },
      内息不足: { kind: 'fail', patterns: ['你现在的气太少了，无法产生内息运行全身经脉。'] },
      精神不足: { kind: 'fail', patterns: ['你现在精不够，无法控制内息的流动！'] },
    }),
  }),
]
