/**
 * commands/skill — 修炼/技能命令族条目（T26.1；DEC-18 构建期数组；T26.6 重整）。
 *
 * 成员归属以 79 命令清单实录为准（§6.1 第 7 项，覆盖审计门）；判据原文
 * 逐字搬自现役实现（tools.ts LONG_CMD_PROFILES，§3.7「不重写正则」），A.6
 * 语料出处见各条目 meta.corpus。
 */

import { byBoundary, byOutcomes, defineCommand } from './define.ts'
import type { RowContext, CaptureEntry, CaptureRule } from './define.ts'

// ── skills 捕获格式（就地定义，T29 用户裁定 2026-10-15：捕获规则随命令条目）──
// 实录校准 2026-10-08，A.7.3：中文名+英文id 同 cell 括号形式。

/**
 * 技能行名称 cell：`＋医道(medicine)` / `□太极拳(taiji-quan)` / `  招魂术(evocation)`——
 * 可选 ＋/□ 前缀（已激发/未激发）+ 中文名 + 同 cell 括号内英文 id（实录 A.7.3）。
 */
const SKILL_NAME_RE = /^\s*([＋□])?\s*([\u4e00-\u9fff]{1,12})\(([a-z][a-z0-9-]{1,})\)\s*$/
/** 等级 cell：`16.00/78`，cap 为 `-`（无上限，如知识类）时保留 `-`（D12/§2.4）。 */
const SKILL_LEVEL_RE = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?|-)$/
/**
 * 槽位汇总行（全句单 cell，实录 A.7.3）：
 * `共使用了17.5个技能槽位，空余槽位(12.5)。级别上限：-5.56%。`
 */
const SKILL_SLOT_RE = /共使用了(\d+(?:\.\d+)?)个技能槽位，空余槽位\((\d+(?:\.\d+)?)\)。级别上限：(-?\d+(?:\.\d+)?)%/
const HAS_CJK_RE = /[\u4e00-\u9fff]/

function skillsRow(row: RowContext): CaptureEntry[] | undefined {
  // 槽位汇总行：全句 cell 命中即写（used / free / capDelta 原文含 %）。
  for (const c of row.cells) {
    const slot = SKILL_SLOT_RE.exec(c)
    if (slot !== null) {
      return [{ key: '槽位', value: { used: Number(slot[1]), free: Number(slot[2]), capDelta: `${slot[3]}%` } }]
    }
  }
  // 技能行：名称 cell（flag + 中文名 + 英文 id）与等级 cell 必备（缺一不写不猜）。
  let name: { flag?: string; cn: string; id: string } | undefined
  let level: { value: string; cap: string } | undefined
  let tier: string | undefined
  for (const c of row.cells) {
    if (name === undefined) {
      const nm = SKILL_NAME_RE.exec(c)
      if (nm !== null) {
        name = { cn: (nm[2] ?? '').trim(), id: nm[3] ?? '', ...(nm[1] !== undefined ? { flag: nm[1] } : {}) }
        continue
      }
    }
    if (level === undefined) {
      const lm = SKILL_LEVEL_RE.exec(c)
      if (lm !== null) { level = { value: lm[1] ?? '', cap: lm[2] ?? '' }; continue }
    }
    // 描述（境界）cell：其余中文 cell（不堪一击/初窥门径…；名称 cell 已 continue 不重复计）。
    if (tier === undefined && HAS_CJK_RE.test(c)) tier = c.trim()
  }
  if (name === undefined || level === undefined) return undefined
  return [{
    key: name.id,
    value: {
      name: name.cn,
      level: Number(level.value),
      ...(level.cap !== '-' && level.cap !== '' ? { cap: Number(level.cap) } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(name.flag !== undefined ? { flag: name.flag } : {}),
      ...(row.section !== undefined ? { category: row.section } : {}),
    },
  }]
}

/** skills 表规则（命令 skills[cha、sk]；zone skills；A.7.3 实录；本条目就地定义）。 */
export const SKILLS_RULE: CaptureRule = { id: 'skills', shape: 'table', zone: 'skills', match: skillsRow }

/** 修炼/技能命令族（exercise、skills、learn、exert；practice 等待实录后回填）。 */
export const SKILL_COMMANDS = [
  defineCommand({
    // 打坐（标准命令 exercise，别名 dazuo；A.3 实录：受理帧 GA 后 57s 无 GA——
    // 'criteria' 形态，GA 不武装，完成句跨批命中收窗；受理被拒句为 fail 语义条目，
    // 立即收窗不空等 120s）。
    // 语义条目模型（DEC-7 纪律，2026-10-12 重整）：完成三形态收两条语义条目——「收回丹田」
    // 与「站起收尾」是同一事件（正常结束）的行文变体 ⇒ 同条目 patterns（变体
    // 不分条目）；「内力增加」= 突破（不同事件语义，独立语义条目）；两个 fail 语义条目保留
    // 分立——agent 应对不同（气血不足回血 / 精神不足会精，v0.0.68 拆句收益）。
    // 待实测（§6.2 第 1 项）：拒绝句原文与附录 A 登记串互不相同，以实机实录
    // 为准落实到底是哪几句（含是否多形态），不得凭印象保留。
    // "你将运转于全身经脉间的内息收回丹田" 这句是dz的ok判据
    id: 'exercise',
    aliases: ['dazuo'],
    timeoutMs: 120_000,
    meta: { corpus: '附录 A.3（2026-10-10 用户提供）' },
    resolve: byOutcomes({
      ok: {
        完成: {
          patterns: [
            '你将运转于全身经脉间的内息收回丹田',
            '你运功完毕，深深吸了口气，站了起来。',
          ],
        },
        突破: { patterns: ['你的内力增加了！！'] },
      },
      fail: {
        内息不足: { patterns: ['你现在的气太少了，无法产生内息运行全身经脉。'] },
        精神不足: { patterns: ['你现在精不够，无法控制内息的流动！'] },
      },
    }),
  }),
  // 技能列表（标准命令 skills，别名 cha、sk；T29 用户口径 2026-10-15 登记）：
  // 表类即时命令——应答框线表后即 GA（A.2 1:1 同律），形态取 `'ga'`；capture 登记捕获格式
  //（D7 登记原则：skills 表规则，A.7.3 实录——tracker 只引用本条目）。
  // 分类语义条目（DEC-15 声明即断言）：cooldown 槽位 `刚查看过` = 频控冷却句（2026-10-15
  // 用户供句；kind 三分首例——cooldown = 稍后重试同一命令，与 fail「换行为」分立）——
  // GA 关窗时命中 ⇒ cooldown 收束，无一命中 ⇒ 收窗成功分支未知。查师傅技能
  // = `sk|cha <师傅ID>`（同条目首词命中，应答同为技能表；`-learn` 参数已废弃，
  // 2026-10-15 用户勘误）。
  defineCommand({
    id: 'skills',
    aliases: ['cha', 'sk'],
    timeoutMs: 15_000,
    meta: { corpus: '附录 A.2（即时命令 GA 1:1）+ 用户供句 2026-10-15（冷却模式刚查看过）' },
    resolve: byBoundary({
      cooldown: {
        刚查看过: { patterns: ['你不是刚查看过吗？'] },
      },
      fail: {
        fail: { patterns: ['周围有这个人吗？只有巫师，夫妻，或有师徒关系的人能察看他人的技能。'] },
      },
    }),
    capture: [SKILLS_RULE],
  }),
  // 请教（标准命令 learn，别名 xue；用户供句 2026-10-15 登记）：即时命令——受理行
  // + 学习结果行后即 GA（A.2 1:1），形态取 `'ga'`。分类语义条目（DEC-15 声明即断言）：
  // ok「有心得」= 学有所得（可继续学）；fail「太累」= 今日疲劳无所得（agent 应对：
  // 稍后重试 / 先恢复精神）——GA 关窗无一命中 ⇒ 收窗成功分支未知。受理行
  // `你向谷虚道长请教一次有关「基本内功」的疑问。` 两形态共有且含变量（师父名/
  // 技能名），不进判据（无判别力）；ok 原句「其中一次对答你颇有所感，你听了谷虚
  // 道长的指导，似乎有些心得。」同样含变量 ⇒ 取结论子串（句尾句号不进判据，
  // 同 drink/sleep 条目口径）。
  defineCommand({
    id: 'learn',
    aliases: ['xue'],
    timeoutMs: 15_000,
    meta: { corpus: '用户供句 2026-10-15（谷虚道长「基本内功」请教实录）+ 附录 A.2（即时命令 GA 1:1）' },
    resolve: byBoundary({
      ok: {
        有心得: { patterns: ['似乎有些心得'] },
      },
      fail: {
        太累: { patterns: ['你今天太累了，结果什么也没有学到'] },
      },
    }),
  }),
  // 内功应用（标准命令 exert，别名 yun；用户供句 2026-10-16 登记，A.13）：即时 GA
  // 收窗三形态——recover/regenerate（内力即时转换）+ jing（受理帧即 GA；其完成句
  // 「你减缓真气运行，让自身恢复正常」**无 GA 异步推送**，受理即收窗，完成句不入
  // 判据、留 A.13 实录待后续完善再定判据/时长）。分类语义条目（DEC-15 声明即断言）：
  // fail 判内力枯竭/已满足/已在凝神，ok 分形态三语义条目——GA 关窗无一命中 ⇒ 收窗
  // 成功分支未知（其余参数形态 qi/heal/lifeheal/inspire/powerup/roar 待实录回填，
  // DEC-7；同头命中 GA 即时收束不误等）。原句可能带括号包裹（用户记录形如 `( …)`），
  // 锚取句体子串两侧兼容（句尾句号不进判据，learn 条目口径）。
  defineCommand({
    id: 'exert',
    aliases: ['yun'],
    timeoutMs: 15_000,
    meta: { corpus: '用户供句 2026-10-16（A.13 三形态实录）' },
    resolve: byBoundary({
      ok: {
        气血好转: { patterns: ['你深深吸了几口气，脸色看起来好多了'] },
        精神好转: { patterns: ['你略一凝神，精神看起来好多了'] },
        凝神加速: { patterns: ['你静心凝神，加速自身的精气恢复'] },
      },
      fail: {
        气力充沛: { patterns: ['你现在气力充沛'] },
        精力充沛: { patterns: ['你现在精力充沛'] },
        内力枯竭: { patterns: ['你的内力已经枯竭，不能施用内功'] },
        已在凝神: { patterns: ['你已经运行内功凝神加快自身精气恢复'] },
      },
    }),
  }),
]
