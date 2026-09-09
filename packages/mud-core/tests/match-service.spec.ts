/**
 * dsh-mud-core 匹配服务 (TriggerMatchService) 双桶测试 — v6.2/v6.6。
 *
 * 验证:
 *   - state/event 两个实例独立 (规则集不串、多行上下文不串);
 *   - v6.5: 锚定整行正则准入, 命名捕获组 + map/numeric 组装 data, extract 逃生舱;
 *   - v6.6: 三种匹配类型 (regex/text/func 分派) + 命中窗口 (before/after 装配)。
 */

import { describe, expect, it } from 'vitest'
import { TriggerMatchService } from '../src/trigger-llm/service.ts'
import defaultPerceptionRules from '../src/config/trigger-rules.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'
import type { PerceptRecord } from '../src/trigger-llm/types.ts'

function toLines(rows: string[]): MudLine[] {
  return rows.map((t, i) => ({
    text: t, raw: t, style: [], abs: i, time: Date.now(), isPrompt: false,
  }))
}

/** 单调 abs 喂行器 (模拟 AnsiStreamParser: 跨调用 abs 递增)。 */
function makeFeed() {
  let abs = 0
  return (rows: string[]): MudLine[] => rows.map(t => ({
    text: t, raw: t, style: [], abs: abs++, time: Date.now(), isPrompt: false,
  }))
}

describe('TriggerMatchService 双桶 (state / event)', () => {
  it('独立实例规则集不串: state 规则不影响 event 匹配', () => {
    const state = new TriggerMatchService([
      { id: 'state:hp', eventType: 'p:hp', match: { kind: 'regex', patterns: [/气血/] }, extract: () => ({ 'char.hp': 1 }) },
    ], 'state')
    const event = new TriggerMatchService([
      { id: 'combat:start', eventType: 'p:combat:start', match: { kind: 'regex', patterns: [/向你扑来/] } },
    ], 'event')

    const stateHits = state.match(toLines(['【 气血 】 100 / 100']))
    expect(stateHits.map(h => h.id)).toEqual(['state:hp'])
    expect(stateHits[0]?.data).toEqual({ 'char.hp': 1 })

    // event 实例看不到 state 规则。
    expect(event.match(toLines(['【 气血 】 100 / 100']))).toHaveLength(0)
  })

  it('多行上下文独立: 两个实例各自维护 multiStates (不互相推进)', () => {
    const mkRule = (id: string) => ({
      id, eventType: id, multiline: true,
      match: { kind: 'regex', patterns: [] } as const,
      patterns: [
        { kind: 'substring', text: 'A' },
        { kind: 'substring', text: 'B' },
      ],
    })
    const a = new TriggerMatchService([mkRule('ml-a')])
    const b = new TriggerMatchService([mkRule('ml-b')])
    const feedA = makeFeed()
    const feedB = makeFeed()

    // 只给 A 播种第一条件 "A"; B 从未见过 "A"。
    a.match(feedA(['A']))

    // B 直接喂 "B" (第二条件): 不应因 A 的状态而命中。
    expect(b.match(feedB(['B']))).toHaveLength(0)

    // A 喂 "B" 完成自己的规则 (状态在 A 实例内, 独立推进)。
    const aHit = a.match(feedA(['B']))
    expect(aHit.map(h => h.id)).toEqual(['ml-a'])
  })

  it('resetContext: 清空多行状态机', () => {
    const service = new TriggerMatchService([{
      id: 'ml', eventType: 'ml', multiline: true,
      match: { kind: 'regex', patterns: [] },
      patterns: [{ kind: 'substring', text: 'A' }, { kind: 'substring', text: 'B' }],
    }])
    const feed = makeFeed()
    service.match(feed(['A']))
    service.resetContext()
    // 状态已清: 只喂 B 不再命中。
    expect(service.match(feed(['B']))).toHaveLength(0)
  })
})

describe('v6.5 锚定整行 + 捕获组提取', () => {
  it('锚定首尾: 整行相等命中; 聊天嵌词/首尾多字不命中', () => {
    const s = new TriggerMatchService([{
      id: 'login:name', eventType: 'p:login:name',
      match: { kind: 'regex', patterns: [/^您的英文名字（要注册新人物请输入new。）：$/] },
    }])
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：']))).toHaveLength(1)
    // 聊天/帮助文本中嵌入该词 → 首尾任一不满足 → 不触发。
    expect(s.match(toLines(['张三说你得去注册处填你的英文名字。']))).toHaveLength(0)
    expect(s.match(toLines(['help 提到 注册新人物请输入new 相关内容。']))).toHaveLength(0)
    // 整行以提示开头但后面还有字 → $ 锚定拒绝。
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：请稍候。']))).toHaveLength(0)
  })

  it('纯字面量无锚正则: 子串命中原样保持 (作者后续自行加锚)', () => {
    const s = new TriggerMatchService([{ id: 'r', eventType: 'p:r', match: { kind: 'regex', patterns: [/命中/] } }])
    expect(s.match(toLines(['剑法命中要害！']))).toHaveLength(1)
  })

  it('命名捕获组 + map/numeric 组装 data (千分位去逗号)', () => {
    const s = new TriggerMatchService([{
      id: 'state:hp', lane: 'state', eventType: 'p:hp',
      match: { kind: 'regex', patterns: [/^【\s*气血\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/] },
      map: { cur: 'char.hp', max: 'char.maxhp' },
      numeric: ['cur', 'max'],
    }])
    const hits = s.match(toLines(['【 气血 】  12,345 / 12,345']))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.data).toEqual({ 'char.hp': 12345, 'char.maxhp': 12345 })
  })

  it('extract 逃生舱覆盖捕获组 (二次颜色等复杂提取)', () => {
    const s = new TriggerMatchService([{
      id: 'x', eventType: 'p:x', match: { kind: 'regex', patterns: [/^特殊行$/] },
      extract: () => ({ mode: 'escape' }),
    }])
    expect(s.match(toLines(['特殊行']))[0]?.data).toEqual({ mode: 'escape' })
  })

  it('无 map 的 event 命中 data 为 null (纯 action)', () => {
    const s = new TriggerMatchService([{
      id: 'combat:start', eventType: 'p:combat:start',
      match: { kind: 'regex', patterns: [/^[^]*向你扑来[^]*$/] },
      action: { output: '战斗开始' },
    }])
    const hit = s.match(toLines(['怪物向你扑来！']))[0]
    expect(hit?.data).toBeNull()
    expect(hit?.action?.output).toBe('战斗开始')
  })

  it('multiline 捕获组合并: 各条件命名组 → map', () => {
    const s = new TriggerMatchService([{
      id: 'ml', eventType: 'ml', multiline: true,
      match: { kind: 'regex', patterns: [/^A(?<x>\d+)$/, /^B(?<y>\d+)$/] },
      map: { x: 'a', y: 'b' },
    }])
    const feed = makeFeed()
    s.match(feed(['A1']))
    const hits = s.match(feed(['B2']))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.data).toEqual({ a: '1', b: '2' })
  })

  it('预筛超集不变式: seed 命中而正则不命中 → 不触发; 正则可能命中的行必过 seed', () => {
    const s = new TriggerMatchService([{
      id: 'login:name', eventType: 'p:login:name',
      match: { kind: 'regex', patterns: [/^您的英文名字（要注册新人物请输入new。）：$/] },
    }])
    // seed (前缀) 命中但 $ 不满足 → 预筛放行、二级拒绝。
    expect(s.match(toLines(['您的英文名字（要注册新人物请输入new。）：X']))).toHaveLength(0)
    // seed 不命中的行绝不可能命中锚定正则 → 预筛选跳。
    expect(s.match(toLines(['完全不相关的聊天。']))).toHaveLength(0)
  })
})

describe('v6.6 匹配类型分派 (regex / text / func)', () => {
  it('text: 字面子串命中 (includes 本身即预筛), 聊天嵌词同样命中 (作者自保特异性)', () => {
    const s = new TriggerMatchService([
      { id: 't1', eventType: 'p:t1', match: { kind: 'text', includes: ['比武大会'] }, action: { output: '比武' } },
    ])
    expect(s.match(toLines(['【比武大会】报名开始！']))[0]?.id).toBe('t1')
    expect(s.match(toLines(['几时开比武大会?']))[0]?.id).toBe('t1')
    expect(s.match(toLines(['今天天气不错。']))).toHaveLength(0)
  })

  it('func: 函数谓词每行调用 (结构判定)', () => {
    const s = new TriggerMatchService([
      {
        id: 'f1', eventType: 'p:f1',
        match: { kind: 'func', test: (line) => /^[\u4e00-\u9fa5]+\([a-z\s]+\)$/.test(line.text.trim()) },
        action: { output: 'NPC 行' },
      },
    ])
    expect(s.match(toLines(['店小二(xiao er)']))[0]?.id).toBe('f1')
    expect(s.match(toLines(['普通聊天行']))).toHaveLength(0)
  })

  it('构造校验: 缺 match / multiline 非 regex / window+multiline 抛错', () => {
    expect(() => new TriggerMatchService([{ id: 'bad' } as never])).toThrow(/缺少 match/)
    expect(() => new TriggerMatchService([{
      id: 'bad2', multiline: true, match: { kind: 'text', includes: ['x'] },
    }])).toThrow(/multiline 仅支持/)
    expect(() => new TriggerMatchService([{
      id: 'bad3', multiline: true,
      match: { kind: 'regex', patterns: [/a/] },
      window: { before: 1, after: 1 },
    }])).toThrow(/window 仅支持单行/)
  })

  it('未声明 window 的单行命中: record.before/after 为空数组', () => {
    let seen: PerceptRecord | null = null
    const s = new TriggerMatchService([{
      id: 'w0', eventType: 'p:w0', match: { kind: 'regex', patterns: [/^锚点/] },
      extract: (r) => { seen = r; return null },
    }])
    s.match(toLines(['前行', '锚点行', '后行']))
    expect(seen).not.toBeNull()
    expect(seen!.rows).toHaveLength(1)
    expect(seen!.before).toHaveLength(0)
    expect(seen!.after).toHaveLength(0)
  })
})

describe('命中窗口 (window): before/after 批内装配', () => {
  it('声明 window: 锚点行前后按上限切片 (升序, 不含锚点行, 批尾即止)', () => {
    let seen: PerceptRecord | null = null
    const s = new TriggerMatchService([{
      id: 'w', eventType: 'p:w', match: { kind: 'regex', patterns: [/^锚点$/] },
      window: { before: 2, after: 3 },
      extract: (r) => { seen = r; return null },
    }])
    const lines = toLines(['a', 'b', 'c', '锚点', 'd', 'e'])
    s.match(lines)
    expect(seen!.before.map(l => l.text)).toEqual(['b', 'c'])
    expect(seen!.after.map(l => l.text)).toEqual(['d', 'e']) // 批尾只有 2 行 (< 上限 3)
    expect(seen!.rows.map(l => l.text)).toEqual(['锚点'])
  })

  it('批首截断: before 不足上限时从批首起 (跨批不追)', () => {
    let seen: PerceptRecord | null = null
    const s = new TriggerMatchService([{
      id: 'w', eventType: 'p:w', match: { kind: 'regex', patterns: [/^锚点$/] },
      window: { before: 5, after: 0 },
      extract: (r) => { seen = r; return null },
    }])
    s.match(toLines(['x', '锚点']))
    expect(seen!.before.map(l => l.text)).toEqual(['x'])
    expect(seen!.after).toHaveLength(0)
  })
})

describe('折叠语义 (hit.foldLines)', () => {
  it('单行 regex: 仅折叠锚点行 (窗口行不折叠)', () => {
    const s = new TriggerMatchService([{
      id: 'r', eventType: 'p:r', match: { kind: 'regex', patterns: [/^锚点$/] },
      window: { before: 2, after: 2 },
    }])
    const hit = s.match(toLines(['a', 'b', '锚点', 'd']))[0]!
    expect(hit.lineNumber).toBe(2)
    expect(hit.foldLines).toEqual([2])
  })

  it('单行 func: 不折叠 (房间抓取类全行进 agent)', () => {
    const s = new TriggerMatchService([{
      id: 'f', eventType: 'p:f', match: { kind: 'func', test: (l) => l.text === '锚点' },
      window: { before: 1, after: 1 },
    }])
    const hit = s.match(toLines(['a', '锚点', 'b']))[0]!
    expect(hit.foldLines).toEqual([])
  })

  it('multiline: 折叠全部被捕获的条件行 (行序列即窗口)', () => {
    const s = new TriggerMatchService([{
      id: 'ml', eventType: 'p:ml', multiline: true,
      match: { kind: 'regex', patterns: [] },
      patterns: [{ kind: 'substring', text: 'A' }, { kind: 'substring', text: 'B' }],
    }])
    const feed = makeFeed()
    s.match(feed(['x', 'A'])) // A 捕获 (abs=1), 未完成
    const hit = s.match(feed(['y', 'B']))[0]! // B 完成 (abs=3)
    expect(hit.lineNumber).toBe(3)
    expect(hit.foldLines).toEqual([1, 3])
  })
})

describe('state:look extract (窗口提取: 地图/房间名/描述/出口/NPC)', () => {
  const look = defaultPerceptionRules.find(r => r.id === 'state:look')!
  const run = (before: string[], anchor: string, after: string[]): Record<string, unknown> =>
    look.extract!({
      rows: toLines([anchor]),
      before: toLines(before),
      after: toLines(after),
    } as unknown as PerceptRecord)

  it('出口行解析为数组 (是/有 + 和/、/逗号分隔)', () => {
    expect(run([], '这里明显的出口是 north 和 south。', []))
      .toMatchObject({ 'room.exits': ['north', 'south'] })
    expect(run([], '这里明显的出口有 eastup、westdown。', []))
      .toMatchObject({ 'room.exits': ['eastup', 'westdown'] })
  })

  it('有地图: 地图块 + 房间名 (地图下首非空行) + 描述', () => {
    const out = run(
      [
        '      ┌───┐',
        '      │ 山│',
        '      └───┘',
        '客栈',
        '这是一家客栈。',
        '店内装饰古朴。',
        '',
      ],
      '这里明显的出口是 north 和 south。',
      [],
    )
    expect(out['room.map']).toBe('      ┌───┐\n      │ 山│\n      └───┘')
    expect(out['room.name']).toBe('客栈')
    expect(out['room.desc']).toBe('这是一家客栈。\n店内装饰古朴。')
  })

  it('无地图: 短名启发式 (块首 ≤10 字无句读 → 房间名, 余为描述)', () => {
    const out = run(['客栈', '这是一家客栈。'], '这里明显的出口是 north。', [])
    expect(out['room.name']).toBe('客栈')
    expect(out['room.desc']).toBe('这是一家客栈。')
    expect(out['room.map']).toBeUndefined()
  })

  it('无地图且块首像描述句: 整块为描述, 不猜房间名 (宁缺勿错)', () => {
    const out = run(['这里是一家装饰考究的客栈。'], '这里明显的出口是 north。', [])
    expect(out['room.name']).toBeUndefined()
    expect(out['room.desc']).toBe('这里是一家装饰考究的客栈。')
  })

  it('NPC 向下扫描: 中文(拼音) 连续收集, 首行不匹配即止; 出口行与 NPC 间空行跳过', () => {
    const out = run(
      [],
      '这里明显的出口是 north。',
      ['', '店小二(xiao er)', '王铁匠(wang tieshi)', '一个路人经过。', '李四(li si)'],
    )
    expect(out['room.npcs']).toEqual(['店小二(xiao er)', '王铁匠(wang tieshi)'])
  })

  it('格式漂移不产错数据: 解析失败不写 room.exits (不覆盖已有值); 空窗口不写 name/desc', () => {
    expect(run([], '这里明显的出口是。', [])['room.exits']).toBeUndefined()
    const empty = run([], '这里明显的出口是 north。', [])
    expect(empty['room.name']).toBeUndefined()
    expect(empty['room.desc']).toBeUndefined()
    expect(empty['room.npcs']).toBeUndefined()
  })
})
