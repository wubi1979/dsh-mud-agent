/**
 * dsh-mud-core 预筛契约测试 (S3/S4, v0.11.2)。
 *
 * `Perceptor` 为每条正则规则推导一个"必要出现"字面量 (seed), 用它在逐行扫描前**缩候选**。
 * 契约只有一条:
 *
 *   **`pattern.test(line)` 为真 ⇒ 该规则必须仍然命中。**
 *
 * 预筛只能丢"不可能命中"的行, 绝不能丢"本来会命中"的行。这条契约靠"seed 是必要条件的
 * 超集"来维持, 而必要条件一旦推错 (量词、选择分支、转义、标志), 缺陷是**静默的** ——
 * 表现只是"某类行永远不触发", 没有任何报错。故此处按不变式测, 而不是按实现测。
 *
 * 已回归的两条:
 *   - **S3**: 同一条规则的多个 pattern 是 OR 关系, 但"提不出 seed"的分支被**丢弃**,
 *     于是留下来的 seed 变成必要条件的真子集 → 该分支命中的行被预筛拒掉
 *     (`[/abc/, /[x]yz/]` 对 `xyz` 曾 0 命中)。
 *   - **S4**: seed 比较是大小写敏感的 `startsWith`/`includes`, 而推导只看 `re.source`,
 *     不看 `re.flags` → `/^ABC/i` 推出 `ABC`, 行 `abc` 被拒掉。同类还有码点/字符转义
 *     (`\u4e2d` 被当成字面 "u4e2d")。
 */

import { describe, expect, it } from 'vitest'
import { Perceptor } from '../src/perceive/matcher.ts'
import { createMatchContext, type MatcherRule } from '../src/perceive/types.ts'
import { createDefaultPerceptionRules } from '../src/perceive/rules.ts'
import type { MudLine } from '../src/network/ansi.ts'

/** 造行 (abs 自增; 预筛只看 text)。 */
function rows(lines: readonly string[]): MudLine[] {
  return lines.map((text, abs) => ({ text, raw: text, style: [], abs, time: 0, isPrompt: false }))
}

/** 用给定 patterns 注册一条规则, 返回命中的规则 id。 */
function hitsFor(patterns: readonly (string | RegExp)[], line: string): string[] {
  const perceptor = new Perceptor()
  perceptor.register({ id: 'probe', eventType: 'p:probe', match: { kind: 'regex', patterns } })
  return perceptor.match(rows([line]), createMatchContext()).map(hit => hit.id)
}

/** 该 pattern 集合在"无预筛"下是否命中 (参照实现, 用来证明用例非空转)。 */
function rawMatches(patterns: readonly (string | RegExp)[], line: string): boolean {
  return patterns.some((p) => {
    const re = typeof p === 'string' ? new RegExp(p) : new RegExp(p.source, p.flags)
    re.lastIndex = 0
    return re.test(line)
  })
}

describe('预筛契约 (命中 ⟹ 预筛必须放行)', () => {
  const cases: { why: string; patterns: readonly (string | RegExp)[]; line: string }[] = [
    // ── S3: 多 pattern 是 OR, 一条提不出 seed 不能连累其它 ──
    { why: 'S3: 可提 seed + 不可提 seed 的两分支', patterns: [/abc/, /[x]yz/], line: 'xyz' },
    { why: 'S3: 纯元字符分支', patterns: [/abc/, /^[^]*杀气[^]*$/], line: '一股杀气逼人' },
    { why: 'S3: 顶层选择分支之一', patterns: [/^(?:foo|bar)$/], line: 'bar' },
    // ── S4: flags 影响字面量比较 ──
    { why: 'S4: i 标志 (锚定前缀)', patterns: [/^ABC/i], line: 'abc' },
    { why: 'S4: i 标志 (中缀)', patterns: [/welcome/i], line: 'WELCOME 来到北大侠客行' },
    { why: 'S4: i 标志 (s 无关, 单条)', patterns: [/^A/i, /^B/], line: 'ABC' },
    // ── 转义不是字面字符 (与 https? 同类) ──
    { why: '码点转义 \\uXXXX', patterns: [/^\u4e2d\u6587/], line: '中文' },
    { why: '码点转义 \\u{…} (u 标志)', patterns: [/^\u{4e2d}/u], line: '中' },
    { why: '字符转义 \\x41', patterns: [/^\x41/], line: 'ABC' },
    { why: 'Unicode 属性 \\p{…}', patterns: [/^\p{Script=Han}+$/u], line: '中文' },
    { why: '字符类 \\d', patterns: [/^\d+$/], line: '123' },
    { why: '词边界 \\b', patterns: [/\bcat\b/], line: 'a cat here' },
    { why: '回溯引用 \\1', patterns: [/^(a)\1$/], line: 'aa' },
    { why: '控制转义 \\t', patterns: [/^a\tb$/], line: 'a\tb' },
    { why: '量词 ? 不算必要条件', patterns: [/^https?:\/\//], line: 'http://x' },
    { why: '量词 * 不算必要条件', patterns: [/^ab*c/], line: 'ac' },
    { why: '量词 {0,n} 不算必要条件', patterns: [/^ab{0,3}c/], line: 'ac' },
    { why: '转义元字符仍是字面 (\\., \\/)', patterns: [/^a\.b\/c/], line: 'a.b/c' },
  ]

  for (const c of cases) {
    it(c.why, () => {
      // 参照实现先证明"这条正则本来命中" —— 否则用例是空转的。
      expect(rawMatches(c.patterns, c.line)).toBe(true)
      expect(hitsFor(c.patterns, c.line)).toEqual(['probe'])
    })
  }
})

describe('内置规则表 (真实规则不因预筛丢命中)', () => {
  /**
   * 语料: 取自各 spec 的实录行 (覆盖 state 抓取 / fullme / 分页 / 战斗 / 出口 / 提示符)。
   * 不必穷尽 —— 目的是保证"确实有成对命中", 而不是空转通过。
   */
  const CORPUS: readonly string[] = [
    '【 气血 】 100/200',
    '== 未完继续 50% == (q 离开，b 前一页，其他继续下一页)',
    '-- more --',
    '你捡起一把长剑。',
    '这里明显的出口是 south。',
    '北大街 -',
    '杀气逼人向你扑来！',
    '5M后长时间不使用fullme，会被系统判定为机器人。',
    'http://mud.pkuxkx.net/robot.php?filename=abc',
    '你刚刚用过这个命令不久，还要 3 分 20 秒才能再用。',
    '你的英文名字：',
    '你突然感到精神一振，浑身似乎又充满了力量！',
  ]

  it('每条正则规则: 正则本来命中的语料行, 必须在 Perceptor 里同样命中', () => {
    let pairs = 0
    for (const rule of createDefaultPerceptionRules()) {
      if (rule.multiline === true) continue
      if (rule.match.kind !== 'regex') continue
      // 颜色/guard 是**附加**准入条件, 会合法地再拒一次 —— 不在本契约范围内。
      if (rule.fg !== undefined || rule.bg !== undefined
        || rule.fgTrue !== undefined || rule.bgTrue !== undefined) continue
      if (rule.guard !== undefined) continue
      const matcherRule: MatcherRule = {
        id: rule.id,
        eventType: rule.eventType ?? rule.id,
        match: rule.match,
      }
      const perceptor = new Perceptor()
      perceptor.register(matcherRule)
      for (const line of CORPUS) {
        if (!rawMatches(rule.match.patterns, line)) continue
        pairs += 1
        const hit = perceptor.match(rows([line]), createMatchContext()).some(h => h.id === rule.id)
        expect(hit, `预筛拒绝了本该命中的行: ${rule.id} ← ${line}`).toBe(true)
      }
    }
    expect(pairs).toBeGreaterThan(0)
  })
})
