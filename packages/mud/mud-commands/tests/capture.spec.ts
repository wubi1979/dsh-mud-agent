/**
 * capture 单测（T29.1：六套捕获格式迁 mud-commands，单测随迁——纯 matcher /
 * 块归约器面）。断言语义与 mud 包 tracker.spec.ts 集成回放逐键一致（同一实录
 * 语料）；块/序列**机制**（开闭块、序列完整性、打标）留在 tracker.spec.ts——
 * 本文件只测格式域知识：match 逐键产出 + BlockReducer 积攒/冲刷语义。
 *
 * ctx 构造口径 = tracker 机制：table 行 cells 按 `│` 切（trim、去首尾空段）、
 * raw = 行原文、index = 块内行序、section = 节标题；sequence 行 cells =
 * `#` 剥除后按 `,` 切（trim）、index = 序内行序。
 */
import { describe, expect, it } from 'vitest'
// 规则常量随命令条目就地定义（T29 用户裁定 2026-10-15）：skills → skill.ts，
// hpbrief/hp/sc/i/exp → usr.ts；捕获契约类型归 define.ts（条目契约单点）。
import { SKILLS_RULE } from '../src/skill.ts'
import { EXP_RULE, HPBRIEF_RULE, HP_RULE, I_RULE, SC_RULE } from '../src/usr.ts'
import type { AnyCaptureRule, RowContext, CaptureEntry } from '../src/define.ts'

/** table 行 ctx 构造（与 tracker.splitRowCells 同口径）。 */
function tableRow(text: string, over: Partial<RowContext> = {}): RowContext {
  const parts = text.split('│').map(s => s.trim())
  while (parts.length > 0 && parts[0] === '') parts.shift()
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return { cells: parts, raw: text, index: 0, ...over }
}

/** sequence 行 ctx 构造（与 tracker.finishSequence 同口径）。 */
function seqRow(text: string, index: number): RowContext {
  return { cells: text.replace(/^#/, '').split(',').map(s => s.trim()), raw: text, index }
}

/** 规则命中产出（undefined → 空，便于 toEqual 断言）。 */
function entriesOf(rule: AnyCaptureRule, row: RowContext): CaptureEntry[] {
  return rule.match(row) ?? []
}

// ── hpbrief（§2.2 已定稿 18 位表；实录 2026-10-06）──────────────────

const HPBRIEF_LINES = [
  '#56074,18837,324,648,311,622',
  '#313,313,313,257,257,257',
  '#0,80,331,331,0,0',
]

describe('hpbrief sequence 规则（matcher 面）', () => {
  it('实录三行 → 18 键逐键产出（战斗中/忙带 zone:combat）', () => {
    const rows = HPBRIEF_LINES.map((t, i) => seqRow(t, i))
    const out = rows.flatMap(r => entriesOf(HPBRIEF_RULE, r))
    const kv = (key: string): unknown => out.find(e => e.key === key)?.value
    expect(out.length).toBe(18)
    expect(kv('经验')).toBe(56074)
    expect(kv('潜能')).toBe(18837)
    expect(kv('最大内力')).toBe(324)
    expect(kv('内力')).toBe(648)
    expect(kv('最大精力')).toBe(311)
    expect(kv('精力')).toBe(622)
    expect(kv('气血上限')).toBe(313)
    expect(kv('最大气血')).toBe(313)
    expect(kv('气血')).toBe(313)
    expect(kv('精神上限')).toBe(257)
    expect(kv('最大精神')).toBe(257)
    expect(kv('精神')).toBe(257)
    expect(kv('真气')).toBe(0)
    expect(kv('战意')).toBe(80)
    expect(kv('食物')).toBe(331)
    expect(kv('饮水')).toBe(331)
    expect(out.find(e => e.key === '战斗中')).toEqual({ key: '战斗中', value: false, zone: 'combat' })
    expect(out.find(e => e.key === '忙')).toEqual({ key: '忙', value: false, zone: 'combat' })
  })

  it('cell 数不对 / 非纯数字 ⇒ 该行不匹配（undefined；负号合法）', () => {
    expect(HPBRIEF_RULE.match(seqRow('#56074,18837,324,648,311', 0))).toBeUndefined()
    expect(HPBRIEF_RULE.match(seqRow('#56074,18837,324,648,311,abc', 0))).toBeUndefined()
    // 气血可为 -1（A.8.1 死亡断面）：负号 cell 合法。
    const neg = entriesOf(HPBRIEF_RULE, seqRow('#313,193,-1,257,257,257', 1))
    expect(neg.find(e => e.key === '气血')?.value).toBe(-1)
  })

  it('行序 index 定槽：非 0/1/2 的 index 不匹配（整组不写由机制保证）', () => {
    expect(HPBRIEF_RULE.match(seqRow(HPBRIEF_LINES[0]!, 3))).toBeUndefined()
  })
})

// ── hp（table，§2.3 兜底 + 文本状态；实录语料同 tracker.spec）────────

const HP_TABLE = [
  '│【精神】 257 / 257 [100%]     │',
  '│【气血】 313 / 313 [100%]     │',
  '│【真气】 0 / 0 [  0%]         │',
  '│【精力】 622 / 311 (+ 0)      │',
  '│【内力】 648 / 324 (+ 0)      │',
  '│【静气】 80% [正常]           │',
  '│【食物】 331 / 400 [缺食]     │',
  '│【饮水】 331 / 400 [缺水]     │',
  '│【潜能】 18837                │',
  '│【经验】 56074                │',
  '│【状态】 健康、极度疲倦        │',
]

describe('hp 表规则（matcher 面）', () => {
  it('逐键产出（含加成/状态数组/静气≡战意）', () => {
    const out = HP_TABLE.flatMap(t => entriesOf(HP_RULE, tableRow(t)))
    const kv = (key: string): unknown => out.find(e => e.key === key)?.value
    expect(kv('精神')).toBe(257)
    expect(kv('最大精神')).toBe(257)
    expect(kv('气血')).toBe(313)
    expect(kv('最大气血')).toBe(313)
    expect(kv('真气')).toBe(0)
    expect(kv('精力')).toBe(622)
    expect(kv('最大精力')).toBe(311)
    expect(kv('精力加成')).toBe(0)
    expect(kv('内力')).toBe(648)
    expect(kv('最大内力')).toBe(324)
    expect(kv('内力加成')).toBe(0)
    expect(kv('战意')).toBe(80)
    expect(kv('食物')).toBe(331)
    expect(kv('最大食物')).toBe(400)
    expect(kv('食物状态')).toBe('缺食')
    expect(kv('饮水')).toBe(331)
    expect(kv('最大饮水')).toBe(400)
    expect(kv('饮水状态')).toBe('缺水')
    expect(kv('潜能')).toBe(18837)
    expect(kv('经验')).toBe(56074)
    expect(kv('状态')).toEqual(['健康', '极度疲倦'])
  })

  it('框线/表头行零命中（undefined）', () => {
    expect(HP_RULE.match(tableRow('┌──────────────┐'))).toBeUndefined()
    expect(HP_RULE.match(tableRow('└──────────北大侠客行──────────┘'))).toBeUndefined()
  })
})

// ── sc（character：八维 + 存款/杀气/门派履历/上榜差经验）────────────

describe('sc 表规则（matcher 面）', () => {
  it('八维（含 ? 保留）/数字标签/门派履历/头衔姓名 逐键产出', () => {
    const out = [
      '│ 膂力：[25] │ 悟性：[?] │',
      '│ 存款：1,234,567 │ 杀气：10 │',
      '│ 门派：武当派 │ 师承：张三丰 │',
      '│ 门忠：9,999 │ 出师：否 │ 叛师：否 │',
      '│ 上榜差经验=33,144,188 │',
      '│ 武当派第四代弟子 夫差(Vicrly) │',
    ].flatMap(t => entriesOf(SC_RULE, tableRow(t)))
    const kv = (key: string): unknown => out.find(e => e.key === key)?.value
    expect(kv('膂力')).toBe(25)
    expect(kv('悟性')).toBe('?')
    expect(kv('存款')).toBe(1234567)
    expect(kv('杀气')).toBe(10)
    expect(kv('门派')).toBe('武当派')
    expect(kv('师承')).toBe('张三丰')
    expect(kv('门忠')).toBe(9999)
    expect(kv('出师')).toBe('否')
    expect(kv('上榜差经验')).toBe(33144188)
    expect(kv('头衔')).toBe('武当派第四代弟子')
    expect(kv('姓名')).toBe('夫差')
    expect(kv('英文名')).toBe('Vicrly')
  })
})

// ── i（inventory：块归约器全积攒；实录 A.7.4）───────────────────────

/** 实录 A.7.4（2026-10-08 会话日志 seq 1090–1108，脱敏缩排）——与 tracker.spec 同源。 */
const I_CAPTURE: { text: string; section?: string }[] = [
  { text: '│你共携带八件器物，负重约二十七斤，接近一成。                                │' },
  { text: '│                       -- [帽子]   ▄▄▄   [副兵] --                       │', section: '装备' },
  { text: '│          青色道袍   (+2) [衣服] █      ▄ [护肩] --                       │', section: '装备' },
  { text: '│ [项链]--                                                          --[护心] │', section: '饰品' },
  { text: '│黄金×2                  白银×88                 铜板×81                  │', section: '财宝' },
  { text: '│北侠战甲(Pkuxkx zhanjia) 青锋剑(Qingfeng sword)                             │', section: '其它' },
]

describe('i 表规则（matcher + 块归约器面）', () => {
  it('块归约器：分区行全积攒，flush 统一写（step 零立即产出）', () => {
    const block = I_RULE.block!
    const acc = block.init()
    let immediate: CaptureEntry[] = []
    for (const { text, section } of I_CAPTURE) {
      const row = tableRow(text, section !== undefined ? { section } : {})
      const hit = I_RULE.match(row)
      if (hit === undefined) continue
      immediate = immediate.concat(block.step(acc, row, hit))
    }
    expect(immediate).toEqual([]) // i 全积攒：无立即产出
    const flushed = block.flush(acc)
    const kv = (key: string): unknown => flushed.find(e => e.key === key)?.value
    expect(kv('件数')).toBe('八')
    expect(kv('负重')).toBe('约二十七斤')
    expect(kv('负重比')).toBe('接近一成')
    expect(kv('财物')).toEqual({ gold: 2, silver: 88, copper: 81 })
    // 装备：只写非空槽（青色道袍在标签前；画框/-- 空槽不写）。
    expect(kv('装备')).toEqual({ 衣服: '青色道袍(+2)' })
    // 饰品：实录全空 ⇒ 不写该键。
    expect(flushed.find(e => e.key === '饰品')).toBeUndefined()
    // 其它：中文名 + 英文 id 对。
    expect(kv('其它')).toEqual([
      { name: '北侠战甲', id: 'Pkuxkx zhanjia' },
      { name: '青锋剑', id: 'Qingfeng sword' },
    ])
    // 块收口统一写：6 键各恰好一次。
    expect(flushed.map(e => e.key).sort()).toEqual(['件数', '其它', '装备', '负重', '负重比', '财物'])
  })

  it('多行其它跨行追加；饰品有物则写槽位（[项链]珍珠 布局兼容）', () => {
    const block = I_RULE.block!
    const acc = block.init()
    const rows: { text: string; section: string }[] = [
      { text: '│ [项链]珍珠   --[护心] │', section: '饰品' },
      { text: '│烧饼(shao bing) 干粮(gan liang)│', section: '其它' },
      { text: '│水囊(water bag)│', section: '其它' },
    ]
    for (const { text, section } of rows) {
      const row = tableRow(text, { section })
      const hit = I_RULE.match(row)
      if (hit !== undefined) block.step(acc, row, hit)
    }
    const flushed = block.flush(acc)
    expect(flushed.find(e => e.key === '饰品')?.value).toEqual({ 项链: '珍珠' })
    expect(flushed.find(e => e.key === '其它')?.value).toEqual([
      { name: '烧饼', id: 'shao bing' },
      { name: '干粮', id: 'gan liang' },
      { name: '水囊', id: 'water bag' },
    ])
  })

  it('skills 的 中文(id) 行不被 i 规则抢走（无 装备/饰品/其它 section 门控）', () => {
    expect(I_RULE.match(tableRow('│＋医道(medicine)      │不堪一击      │16.00/78│'))).toBeUndefined()
  })
})

// ── skills（table；实录 A.7.3）──────────────────────────────────────

describe('skills 表规则（matcher 面）', () => {
  it('技能行：中文名+英文id 同 cell、等级/描述独立 cell、＋/□ 前缀、cap 为 - 省略', () => {
    const out = [
      { text: '│  招魂术(evocation)                           │不堪一击    │   16.00/78   │', section: '四项杂学' },
      { text: '│  读书写字(literate)                          │初窥门径    │   89.42/-    │', section: '四项杂学' },
      { text: '│＋医道(medicine)                              │不堪一击    │    4.00/78   │', section: '四项杂学' },
      { text: '│□太极拳(taiji-quan)                          │不堪一击    │   20.14/78   │', section: '七项基本功夫' },
    ].flatMap(({ text, section }) => entriesOf(SKILLS_RULE, tableRow(text, { section })))
    const kv = (key: string): unknown => out.find(e => e.key === key)?.value
    expect(kv('evocation')).toEqual({ name: '招魂术', level: 16, cap: 78, tier: '不堪一击', category: '四项杂学' })
    expect(kv('literate')).toEqual({ name: '读书写字', level: 89.42, tier: '初窥门径', category: '四项杂学' })
    expect(kv('medicine')).toEqual({ name: '医道', level: 4, cap: 78, tier: '不堪一击', flag: '＋', category: '四项杂学' })
    expect(kv('taiji-quan')).toEqual({ name: '太极拳', level: 20.14, cap: 78, tier: '不堪一击', flag: '□', category: '七项基本功夫' })
  })

  it('槽位汇总行：used/free/capDelta（原文含 %）', () => {
    const out = entriesOf(SKILLS_RULE, tableRow('│共使用了17.5个技能槽位，空余槽位(12.5)。级别上限：-5.56%。                  │'))
    expect(out).toEqual([{ key: '槽位', value: { used: 17.5, free: 12.5, capDelta: '-5.56%' } }])
  })

  it('缺等级 cell 的行不写不猜；表头行零命中', () => {
    expect(SKILLS_RULE.match(tableRow('│  招魂术(evocation)                           │不堪一击    │'))).toBeUndefined()
    expect(SKILLS_RULE.match(tableRow('│技能                                          │描述        │级别/上限     │'))).toBeUndefined()
  })
})

// ── exp（character：块归约器对照对积攒 + 连线时长直写）──────────────

describe('exp 表规则（matcher + 块归约器面）', () => {
  it('对照行空产出占位；归约器积攒后 flush 写经验表；连线时长句立即产出', () => {
    const block = EXP_RULE.block!
    const acc = block.init()
    let immediate: CaptureEntry[] = []
    const pairRows = [
      '│74    │48103           │77    │54193           │80    │60778           │',
      '│75    │50079           │78    │56332           │81    │63085           │',
      '│76    │52109           │79    │58527           │82    │65451           │',
    ]
    for (const t of pairRows) {
      const row = tableRow(t)
      const hit = EXP_RULE.match(row)
      expect(hit).toEqual([]) // 对照行：空产出占位独占
      immediate = immediate.concat(block.step(acc, row, hit ?? []))
    }
    const online = tableRow('│你连线进入北侠已经有四十八分三十九秒了。                                    │')
    const onlineHit = EXP_RULE.match(online)
    expect(onlineHit).toEqual([{ key: '连线时长', value: '四十八分三十九秒' }])
    immediate = immediate.concat(block.step(acc, online, onlineHit ?? []))
    // 连线时长句照常直写；对照对只积攒。
    expect(immediate).toEqual([{ key: '连线时长', value: '四十八分三十九秒' }])
    expect(block.flush(acc)).toEqual([{
      key: '经验表',
      value: [
        { level: 74, exp: 48103 }, { level: 77, exp: 54193 }, { level: 80, exp: 60778 },
        { level: 75, exp: 50079 }, { level: 78, exp: 56332 }, { level: 81, exp: 63085 },
        { level: 76, exp: 52109 }, { level: 79, exp: 58527 }, { level: 82, exp: 65451 },
      ],
    }])
  })

  it('表头/表尾行零命中；无对照对时 flush 零产出（旧 expPairs 空守卫等价）', () => {
    expect(EXP_RULE.match(tableRow('│级别  │所需经验        │级别  │所需经验        │级别  │所需经验        │'))).toBeUndefined()
    const block = EXP_RULE.block!
    const acc = block.init()
    expect(block.flush(acc)).toEqual([])
  })
})

// ── 规则元数据（id/shape/zone 契约面；装配规范序断言在 assembler.spec）──

describe('capture 规则元数据', () => {
  it('六规则 id/shape/zone 与现役一致（复现现役声明序的素材面）', () => {
    expect(HPBRIEF_RULE).toMatchObject({ id: 'hpbrief', shape: 'sequence', zone: 'vitals', length: 3 })
    expect(HP_RULE).toMatchObject({ id: 'hp', shape: 'table', zone: 'vitals' })
    expect(SC_RULE).toMatchObject({ id: 'sc', shape: 'table', zone: 'character' })
    expect(I_RULE).toMatchObject({ id: 'i', shape: 'table', zone: 'inventory' })
    expect(SKILLS_RULE).toMatchObject({ id: 'skills', shape: 'table', zone: 'skills' })
    expect(EXP_RULE).toMatchObject({ id: 'exp', shape: 'table', zone: 'character' })
    // 块归约器只挂 i/exp（D5 适用边界：hp/sc/skills 维持命中直写）。
    expect(I_RULE.block).toBeDefined()
    expect(EXP_RULE.block).toBeDefined()
    expect(HP_RULE.block).toBeUndefined()
    expect(SC_RULE.block).toBeUndefined()
    expect(SKILLS_RULE.block).toBeUndefined()
  })
})
