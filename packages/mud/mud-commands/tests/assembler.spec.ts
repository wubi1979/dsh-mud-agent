/**
 * mud-commands 装配单测（T28.2 新增，PLAN 第 4 章 T28.2 行断言）：
 * ① 解析单点 resolveAwaitPlan 四档（DEC-21：declared > table > empty > none）；
 * ② 装配期 fail-loud 自检（保留字拒用 / 语义条目名跨槽位禁重名 / 命令头冲突 /
 *    criteria 无判据 / gaCount 非法 / 空 patterns）——经 assembleProfiles 受控
 *    fixture 实证（错误路径在生产五分组上不可达）；
 * ③ 生产装配 sanity（总表非空 + 判定序 fail 槽位在前 + 匹配/exempt 面）。
 *
 * 工具面行为（listen 透传、schema 组合自由度）不在此测——留 tool-mud（tools.spec）。
 */
import { describe, expect, it } from 'vitest'
import { byBoundary, byOutcomes, defineCommand, type CommandProfile } from '../src/define.ts'
import {
  assembleProfiles,
  COMMAND_PROFILES,
  matchCommandProfile,
  resolveAwaitPlan,
  tableSlotsOf,
} from '../src/assembler.ts'

// ── 受控 fixture ────────────────────────────────────────────────────────

const profile = (id: string, over: Partial<CommandProfile> = {}): CommandProfile =>
  defineCommand({
    id,
    timeoutMs: 1_000,
    meta: { corpus: 'fixture（装配单测）' },
    resolve: byOutcomes({ ok: { 完成: { patterns: ['好了'] } } }),
    ...over,
  })

// ── ① 解析单点（DEC-21 四档）────────────────────────────────────────────

describe('resolveAwaitPlan 解析单点（DEC-21）', () => {
  it('none 档：未登记且未声明（含凭据命令 sent=null）⇒ 不收窗只等超时（DEC-4）', () => {
    expect(resolveAwaitPlan('foobar')).toEqual({ source: 'none' })
    expect(resolveAwaitPlan(null)).toEqual({ source: 'none' })
  })

  it('empty 档：空命令显式归 ga（A.2 1:1），gaCount=1 即收', () => {
    expect(resolveAwaitPlan('')).toEqual({
      source: 'empty', closeOn: 'ga', gaCount: 1, slots: [], command: '',
    })
    expect(resolveAwaitPlan('   ')).toMatchObject({ source: 'empty', closeOn: 'ga' })
  })

  it('table 档：命中条目整条采用；fail 槽位排前（判定序）+ 条目法定 timeout', () => {
    const plan = resolveAwaitPlan('sleep')
    expect(plan.source).toBe('table')
    expect(plan.command).toBe('sleep')
    expect(plan.closeOn).toBe('criteria')
    expect(plan.timeoutMs).toBe(300_000)
    expect(plan.slots?.map(s => `${s.kind}:${s.name}`)).toEqual(['fail:刚睡过', 'ok:完成'])
  })

  it('table 档 ga 形态：drink 条目整条采用（即时完成类首例，别名 he 命中，分类语义条目 fail 排前）', () => {
    const plan = resolveAwaitPlan('he cha') // 别名命中
    expect(plan.source).toBe('table')
    expect(plan.command).toBe('drink')
    expect(plan.closeOn).toBe('ga')
    expect(plan.timeoutMs).toBe(15_000)
    expect(plan.slots?.map(s => `${s.kind}:${s.name}`)).toEqual(['fail:喝饱', 'ok:喝下'])
  })

  it('table 档同形态合并：同名语义条目后声明替换、异名追加（裁定 6，合并按调用点 flags）', () => {
    const plan = resolveAwaitPlan('sleep', {
      closeOn: 'criteria',
      outcomes: { ok: { 完成: { patterns: ['自定义完成句'] }, 追加: { patterns: ['追加句'] } } },
    })
    expect(plan.source).toBe('table')
    expect(plan.command).toBe('sleep')
    const names = plan.slots?.map(s => s.name)
    expect(names).toContain('追加') // 异名追加
    const done = plan.slots?.find(s => s.name === '完成')
    expect(done?.patterns).toEqual(['自定义完成句']) // 同名：后声明为准
    expect(done?.res[0]?.source).toBe('自定义完成句') // 按调用点 flags 重编译（flags 缺省）
  })

  it('declared 档：异形态整体替换（换判据形态 = 接管全部槽位），归因保留', () => {
    const plan = resolveAwaitPlan('sleep', { closeOn: 'ga', gaCount: 2 })
    expect(plan.source).toBe('declared')
    expect(plan.closeOn).toBe('ga')
    expect(plan.gaCount).toBe(2)
    expect(plan.slots).toEqual([]) // 声明即全部配方（ga 无语义条目）
    expect(plan.command).toBe('sleep') // 归因：命中但被整体替换
  })

  it('declared 档：无表条目时声明即全部配方，command 缺省', () => {
    const plan = resolveAwaitPlan('foobar', {
      closeOn: 'criteria',
      outcomes: { ok: { 完成: { patterns: ['好了'] } } },
    })
    expect(plan.source).toBe('declared')
    expect(plan.command).toBeUndefined()
  })

  it('声明缺 closeOn 即拒（收窗形态必填；outcomes 存在 = 已声明）', () => {
    expect(() =>
      resolveAwaitPlan('sleep', { outcomes: { ok: { 完成: { patterns: ['好了'] } } } }),
    ).toThrow(/closeOn/)
  })
})

// ── ② 装配期 fail-loud 自检（assembleProfiles 受控 fixture）─────────────

describe('装配期自检（DEC-18 fail-loud）', () => {
  it('保留字语义条目名拒用（ok/fail 是 kind 寻址键）', () => {
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ ok: { ok: { patterns: ['x'] } } }) })]),
    ).toThrow(/保留字/)
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ fail: { fail: { patterns: ['x'] } } }) })]),
    ).toThrow(/保留字/)
  })

  it('语义条目名跨槽位禁重名（ok/fail 组内唯一）', () => {
    expect(() =>
      assembleProfiles([profile('a', {
        resolve: byOutcomes({
          ok: { 冲突: { patterns: ['x'] } },
          fail: { 冲突: { patterns: ['y'] } },
        }),
      })]),
    ).toThrow(/跨槽位重名/)
  })

  it('命令头冲突：id/aliases 不得与他条目重复', () => {
    expect(() => assembleProfiles([profile('dup'), profile('dup')])).toThrow(/命令头冲突/)
    expect(() => assembleProfiles([profile('d'), { ...profile('x'), aliases: ['d'] }])).toThrow(/命令头冲突/)
  })

  it('criteria 形态没有任何判据语义条目 = 配置错误', () => {
    expect(() => assembleProfiles([profile('a', { resolve: byOutcomes({}) })])).toThrow(/没有任何判据语义条目/)
  })

  it('ga 形态 gaCount 必须为正整数', () => {
    expect(() =>
      assembleProfiles([profile('a', { resolve: byBoundary(undefined, 0) })]),
    ).toThrow(/gaCount/)
    expect(() =>
      assembleProfiles([profile('a', { resolve: byBoundary(undefined, 1.5) })]),
    ).toThrow(/gaCount/)
  })

  it('登记语义条目 patterns 为空 = 配置错误（空语义条目永不命中）', () => {
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ ok: { 空: { patterns: [] } } }) })]),
    ).toThrow(/patterns 为空/)
  })

  it('quiet 形态无语义条目合法（窗长即条目 timeoutMs）', () => {
    const out = assembleProfiles([profile('q', { resolve: { closeOn: 'quiet' } })])
    expect(out[0]?.judge).toEqual({ closeOn: 'quiet', slots: [] })
  })
})

// ── ③ 生产装配 sanity + 匹配面 ──────────────────────────────────────────

describe('生产总表与匹配面', () => {
  it('总表非空且每条目判定序 fail 槽位在前', () => {
    expect(COMMAND_PROFILES.length).toBeGreaterThanOrEqual(3)
    for (const p of COMMAND_PROFILES) {
      const kinds = p.judge.slots.map(s => s.kind)
      const firstOk = kinds.indexOf('ok')
      expect(kinds.slice(firstOk)).not.toContain('fail') // fail 全部排在 ok 之前
    }
  })

  it('matchCommandProfile：id/alias/词边界/exempt（DEC-8 对最终发送串）', () => {
    expect(matchCommandProfile('sleep')?.id).toBe('sleep')
    expect(matchCommandProfile('exercise 10')?.id).toBe('exercise') // 首词 + 词边界
    expect(matchCommandProfile('dazuo')?.id).toBe('exercise') // alias
    expect(matchCommandProfile('sleepwalk')).toBeNull() // 词边界防误命中
    expect(matchCommandProfile('walk -c')).toBeNull() // exempt：查询类不注入判据
    expect(matchCommandProfile('walk')?.id).toBe('walk')
    expect(matchCommandProfile('drink')?.id).toBe('drink')
    expect(matchCommandProfile('he cha')?.id).toBe('drink') // 别名 he 首词命中，参数无关
    expect(matchCommandProfile('eat')?.id).toBe('eat')
    expect(matchCommandProfile('chi')?.id).toBe('eat') // 别名 chi
    expect(matchCommandProfile('')).toBeNull()
  })

  it('tableSlotsOf：喂令信息含形态 + 槽位 kind + 条目 flags（walk flags=m）', () => {
    expect(tableSlotsOf('walk')).toEqual({
      closeOn: 'criteria',
      slots: [{ name: '软阻断', kind: 'fail' }, { name: '到达', kind: 'ok' }],
      flags: 'm',
    })
    expect(tableSlotsOf('foobar')).toBeNull()
  })
})
