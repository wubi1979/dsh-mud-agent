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
  assembleCaptureRules,
  assembleProfiles,
  CAPTURE_RULE_ORDER,
  COMMAND_CAPTURE_RULES,
  COMMAND_PROFILES,
  matchCommandProfile,
  matchProfileFor,
  resolveAwaitPlan,
  tableSlotsOf,
  TASK_ENV_RULES,
  TASK_PROFILES,
} from '../src/assembler.ts'
import { SC_RULE } from '../src/usr.ts'

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
  it('保留字语义条目名拒用（ok/fail/cooldown 是 kind 寻址键）', () => {
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ ok: { ok: { patterns: ['x'] } } }) })]),
    ).toThrow(/保留字/)
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ fail: { fail: { patterns: ['x'] } } }) })]),
    ).toThrow(/保留字/)
    expect(() =>
      assembleProfiles([profile('a', { resolve: byOutcomes({ ok: { cooldown: { patterns: ['x'] } } }) })]),
    ).toThrow(/保留字/)
  })

  it('判定序：fail → cooldown → ok 组序编译（槽位排前）', () => {
    const out = assembleProfiles([profile('a', {
      resolve: byOutcomes({
        ok: { 完成: { patterns: ['ok1'] } },
        cooldown: { 刚查看过: { patterns: ['cd1'] } },
        fail: { 不足: { patterns: ['f1'] } },
      }),
    })])
    expect(out[0]!.judge.slots.map(s => `${s.kind}:${s.name}`)).toEqual([
      'fail:不足', 'cooldown:刚查看过', 'ok:完成',
    ])
  })

  it('语义条目名跨槽位禁重名（ok/fail/cooldown 组内唯一）', () => {
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

  it('capture 规则 id 跨条目重复拒（错误信息双写规则 id + 所属命令 id）', () => {
    expect(() =>
      assembleProfiles([
        profile('a', { capture: [SC_RULE] }),
        profile('b', { capture: [SC_RULE] }),
      ]),
    ).toThrow(/capture 规则 id 重复：sc（命令 a 与命令 b）/)
  })

  it('capture 规则未入规范序拒（CAPTURE_RULE_ORDER 外的 id fail-loud）', () => {
    const stray: CommandProfile = {
      ...profile('a'),
      capture: [{ id: 'stray', shape: 'table', zone: 'x', match: () => undefined }],
    }
    expect(() => assembleProfiles([stray])).toThrow(/capture 规则 stray（命令 a）未入规范序/)
  })

  it('fixture 部分登记规范序规则合法（完整性校验属于生产装配）', () => {
    const out = assembleProfiles([profile('a', { capture: [SC_RULE] })])
    expect(out[0]?.capture).toEqual(['sc'])
  })
})

// ── ③ 生产装配 sanity + 匹配面 ──────────────────────────────────────────

describe('生产总表与匹配面', () => {
  it('总表非空且每条目判定序 fail/cooldown 槽位在前', () => {
    expect(COMMAND_PROFILES.length).toBeGreaterThanOrEqual(3)
    for (const p of COMMAND_PROFILES) {
      const kinds = p.judge.slots.map(s => s.kind)
      const firstOk = kinds.indexOf('ok')
      if (firstOk === -1) {
        expect(kinds.every(k => k === 'fail' || k === 'cooldown'), p.id).toBe(true) // 负面-only 条目（如 skills 刚查看过 = cooldown）
      } else {
        expect(kinds.slice(firstOk), p.id).not.toContain('fail') // fail/cooldown 全部排在 ok 之前
        expect(kinds.slice(firstOk), p.id).not.toContain('cooldown')
      }
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
      slots: [
        { name: '阻塞', kind: 'fail' }, { name: '不在出发点', kind: 'fail' },
        { name: '到达', kind: 'ok' }, { name: '出发点表', kind: 'ok' },
      ],
      flags: 'm',
    })
    expect(tableSlotsOf('foobar')).toBeNull()
  })
})

// ── ④ capture 装配（T29：规范序 + 条目归属 + 七命令解析面）──────────────

describe('capture 装配（T29 D4/D7）', () => {
  it('COMMAND_CAPTURE_RULES 按规范序汇出：hpbrief→hp→sc→i→skills→exp', () => {
    expect(COMMAND_CAPTURE_RULES.map(r => r.id)).toEqual([...CAPTURE_RULE_ORDER])
  })

  it('七条目 capture 归属：规则 id 独立于命令 id/别名（sc↔score、i↔inventory）', () => {
    const cap = (id: string): readonly string[] | undefined =>
      COMMAND_PROFILES.find(p => p.id === id)?.capture
    expect(cap('look')).toBeUndefined() // look 无捕获
    expect(cap('skills')).toEqual(['skills'])
    expect(cap('hpbrief')).toEqual(['hpbrief'])
    expect(cap('inventory')).toEqual(['i']) // 规则 'i' ↔ 命令 inventory
    expect(cap('score')).toEqual(['sc']) // 规则 'sc' ↔ 命令 score
    expect(cap('hp')).toEqual(['hp'])
    expect(cap('exp')).toEqual(['exp'])
  })

  it('七命令（含别名）命中 table 档 ga 收束、条目法定 timeout 15s', () => {
    for (const cmd of ['look', 'l', 'hpbrief', 'inventory', 'i', 'score', 'sc', 'hp', 'exp']) {
      const plan = resolveAwaitPlan(cmd)
      expect(plan.source, cmd).toBe('table')
      expect(plan.closeOn, cmd).toBe('ga')
      expect(plan.timeoutMs, cmd).toBe(15_000)
      expect(plan.slots, cmd).toEqual([]) // 无分类语义条目：关窗即 next
    }
    // skills/cha/sk：同 ga 收束 + cooldown 语义条目 `刚查看过`（频控冷却，2026-10-15 用户供句）。
    for (const cmd of ['skills', 'cha', 'sk']) {
      const plan = resolveAwaitPlan(cmd)
      expect(plan.source, cmd).toBe('table')
      expect(plan.closeOn, cmd).toBe('ga')
      expect(plan.timeoutMs, cmd).toBe(15_000)
      expect(plan.slots, cmd).toEqual([
        expect.objectContaining({ name: '权限不足', kind: 'fail' }), // fail 先于 cooldown（判定序）
        expect.objectContaining({ name: '刚查看过', kind: 'cooldown' }),
      ])
    }
    // 词边界：未登记的相似头不误命中。
    expect(matchCommandProfile('looks')).toBeNull()
    expect(matchCommandProfile('hpx')).toBeNull()
  })

  it('learn[xue]/help 登记（用户供句 2026-10-15）：learn ga 收束 + ok/fail 分类条目、help 无判据', () => {
    // learn/xue：ga 收束 + fail「太累」先于 ok「有心得」（判定序 = 组序编译 fail → cooldown → ok）。
    for (const cmd of ['learn', 'xue']) {
      const plan = resolveAwaitPlan(cmd)
      expect(plan.source, cmd).toBe('table')
      expect(plan.closeOn, cmd).toBe('ga')
      expect(plan.timeoutMs, cmd).toBe(15_000)
      expect(plan.slots, cmd).toEqual([
        expect.objectContaining({ name: '太累', kind: 'fail' }),
        expect.objectContaining({ name: '有心得', kind: 'ok' }),
      ])
    }
    // help：无别名无判据，同七命令缺省（关窗即 next）。
    const help = resolveAwaitPlan('help')
    expect(help.source).toBe('table')
    expect(help.closeOn).toBe('ga')
    expect(help.timeoutMs).toBe(15_000)
    expect(help.slots).toEqual([])
    // 词边界：未登记的相似头不误命中。
    expect(matchCommandProfile('learns')).toBeNull()
    expect(matchCommandProfile('helper')).toBeNull()
  })

  it('exert[yun] 登记（用户供句 2026-10-16）：ga 收束 + fail 四条先于 ok 三形态', () => {
    // 判定序 = 组序编译 fail → ok；别名 yun 同头命中。
    for (const cmd of ['exert', 'yun']) {
      const plan = resolveAwaitPlan(cmd)
      expect(plan.source, cmd).toBe('table')
      expect(plan.closeOn, cmd).toBe('ga')
      expect(plan.timeoutMs, cmd).toBe(15_000)
      expect(plan.slots, cmd).toEqual([
        expect.objectContaining({ name: '气力充沛', kind: 'fail' }),
        expect.objectContaining({ name: '精力充沛', kind: 'fail' }),
        expect.objectContaining({ name: '内力枯竭', kind: 'fail' }),
        expect.objectContaining({ name: '已在凝神', kind: 'fail' }),
        expect.objectContaining({ name: '气血好转', kind: 'ok' }),
        expect.objectContaining({ name: '精神好转', kind: 'ok' }),
        expect.objectContaining({ name: '凝神加速', kind: 'ok' }),
      ])
    }
    // 词边界：相似头不误命中。
    expect(matchCommandProfile('exerts')).toBeNull()
  })
})

// ── ⑤ 任务专用命令表（T27：分组装配 + 解析序 任务 > 全局）──────────────

describe('任务专用命令（T27 jianxinju）', () => {
  it('任务条目不入全局总表；按 task 标记分组装配', () => {
    for (const id of ['food', 'teacher']) {
      expect(COMMAND_PROFILES.find(p => p.id === id), id).toBeUndefined()
    }
    // clap 例外：全局表有同名 clap 条目（即时动作 ga 收窗，2026-10-16 登记），
    // 任务表另有 clap 3 专用条目——同名任务条目优先，两表分组装配互不冲突。
    expect(COMMAND_PROFILES.find(p => p.id === 'clap')?.judge.closeOn).toBe('ga')
    const group = TASK_PROFILES.get('jianxinju')
    expect(group?.map(p => p.id).sort()).toEqual(['clap', 'food', 'teacher'])
  })

  it('解析序：任务中先查任务条目再查全局表（同名任务条目优先）', () => {
    // 任务条目命中：food → criteria 档整条采用（fail 槽位在前 = 判定序）。
    const food = resolveAwaitPlan('food', undefined, ['jianxinju'])
    expect(food).toMatchObject({ source: 'table', closeOn: 'criteria', command: 'food', timeoutMs: 120_000 })
    expect(food.slots?.map(s => `${s.name}:${s.kind}`)).toEqual(['钱不够:fail', '完成:ok'])
    // clap 3：ga 档 + ok 分类语义条目（声明即断言）。
    const clap = resolveAwaitPlan('clap 3', undefined, ['jianxinju'])
    expect(clap).toMatchObject({ source: 'table', closeOn: 'ga', command: 'clap', timeoutMs: 15_000 })
    expect(clap.slots).toEqual([expect.objectContaining({ name: '小童应答', kind: 'ok' })])
    // 任务中发全局命令：落全局表（任务组未命中不吞全局条目）。
    const exercise = resolveAwaitPlan('exercise', undefined, ['jianxinju'])
    expect(exercise).toMatchObject({ source: 'table', command: 'exercise' })
  })

  it('clap 形态二分：全局 ga 动作条目 + 任务内 clap 3 小童应答（2026-10-16 用户实测）', () => {
    // 任务内裸 clap / 其他参数 → 任务条目 exempt 落回全局 clap 条目（ga 收窗动作）。
    const bare = resolveAwaitPlan('clap', undefined, ['jianxinju'])
    expect(bare).toMatchObject({ source: 'table', closeOn: 'ga', command: 'clap', timeoutMs: 15_000 })
    expect(bare.slots).toEqual([])
    const clap4 = matchProfileFor('clap 4', ['jianxinju'])
    expect(clap4?.judge.closeOn).toBe('ga')
    expect(clap4?.judge.slots).toEqual([]) // 全局条目（无小童应答槽）
    // 任务内恰好 clap 3 → 任务条目（小童应答语义条目）。
    const trigger = resolveAwaitPlan('clap 3', undefined, ['jianxinju'])
    expect(trigger).toMatchObject({ source: 'table', closeOn: 'ga', command: 'clap', timeoutMs: 15_000 })
    expect(trigger.slots).toEqual([expect.objectContaining({ name: '小童应答', kind: 'ok' })])
    // 任务外 clap 3 → 全局条目 ga 收窗（剑心居外不触发小童）。
    const outside = resolveAwaitPlan('clap 3')
    expect(outside).toMatchObject({ source: 'table', closeOn: 'ga', command: 'clap', timeoutMs: 15_000 })
    expect(outside.slots).toEqual([])
  })

  it('任务外：任务命令 = 未登记不收窗只等超时（DEC-4，不拦发送）', () => {
    expect(resolveAwaitPlan('food')).toEqual({ source: 'none' })
    expect(resolveAwaitPlan('food', undefined, [])).toEqual({ source: 'none' }) // 活跃任务空集同任务外
    expect(resolveAwaitPlan('teacher', undefined, ['zhenfa'])).toEqual({ source: 'none' })
    expect(matchCommandProfile('food')).toBeNull()
  })

  it('declared 档任务感知：声明与任务条目同形态 ⇒ 语义条目级合并', () => {
    const plan = resolveAwaitPlan('food', {
      closeOn: 'criteria',
      outcomes: { ok: { 加急: { patterns: ['加急送达'] } } },
    }, ['jianxinju'])
    expect(plan).toMatchObject({ source: 'table', closeOn: 'criteria', command: 'food' })
    // fail 槽位在前（判定序）；同名/异名合并：声明「加急」追加、表「钱不够/完成」保留。
    expect(plan.slots?.map(s => s.name)).toEqual(['钱不够', '加急', '完成'])
  })

  it('matchProfileFor：任务命中 / 全局兜底 / 无任务直落全局', () => {
    expect(matchProfileFor('food', ['jianxinju'])?.id).toBe('food')
    expect(matchProfileFor('walk', ['jianxinju'])?.id).toBe('walk') // 全局兜底
    expect(matchProfileFor('walk')?.id).toBe('walk')
    expect(matchProfileFor('food')).toBeNull()
  })

  it('多任务并存：按进入顺序遍历任务组，先命中先用（2026-10-15 用户裁定）', () => {
    // 两任务组都未命中 food 时落全局——组间顺序只有在跨组同名/命中差异时可观察，
    // 此处实证「顺序遍历 + 先命中先用」：zhenfa 组无 food 条目 ⇒ 落到后组命中。
    expect(matchProfileFor('food', ['zhenfa', 'jianxinju'])?.id).toBe('food')
    expect(matchProfileFor('food', ['jianxinju', 'zhenfa'])?.id).toBe('food')
  })

  it('TASK_ENV_RULES：进出判据编译（实录 A.11 行文命中）', () => {
    const env = TASK_ENV_RULES.find(e => e.task === 'jianxinju')
    expect(env).toBeDefined()
    // 进入句（2026-10-15 变更）：副本进入句含 leave 回主站提示，玩家名动态桥接。
    expect(env!.enter.some(re => re.test('你进入了剑心居副本，可以通过leave vicrly命令来回到主站。'))).toBe(true)
    expect(env!.enter.some(re => re.test('你进入了剑心居副本，可以通过leave someone命令来回到主站。'))).toBe(true)
    expect(env!.enter.some(re => re.test('你沉思完毕，站起身来，进入剑心居。'))).toBe(false)
    expect(env!.enter.some(re => re.test('你退出了剑心居副本。'))).toBe(false)
    expect(env!.exit.some(re => re.test('你退出了剑心居副本。'))).toBe(true)
  })
})
