/**
 * tracker 测试 — T19 状态追踪（游戏文本 → World 结构化状态）：
 *   - hpbrief：定稿 18 位表实录回放（§2.2）+ 完整性校验失败不写不猜（D5）
 *   - hp：表格块回放（§2.3 兜底 + 文本状态）+ 两源同键覆盖（§2.2 校准结论①）
 *   - 骨架：块识别（┌…└、页脚祝福语闭块）、│ 切列、节标题 section、
 *     C5.2 优先（已有标行不覆盖）、聊天行不撞、clear 消解、断线 reset
 *   - runtime 行路径接线：hpbrief → world(kind='track') + 行打标 status
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { StateTracker, STATUS_KIND, DEFAULT_TRACK_SPEC } from '../src/tracker.ts'
import type { TrackSpec, TrackRule, TrackEntry, RowContext } from '../src/tracker.ts'
import { World } from '../src/world.ts'
import { SessionRuntime } from '../src/runtime.ts'
import type { MudLine } from '../src/link/line.ts'

let absSeq = 0
function line(text: string): MudLine {
  return { text, raw: text, style: [], abs: absSeq++, time: Date.now(), isPrompt: false, kind: null }
}

/** 桩 deps：收集写入/删除。 */
function harness(spec: TrackSpec = DEFAULT_TRACK_SPEC) {
  const writes: Array<{ zone: string; key: string; value: unknown }> = []
  const deletes: Array<{ zone: string; key: string }> = []
  const tracker = new StateTracker({
    onWrite: (zone, key, value) => { writes.push({ zone, key, value }) },
    onDelete: (zone, key) => { deletes.push({ zone, key }) },
  }, spec)
  return { tracker, writes, deletes }
}

/** 断言写入集合含指定条目（zone.key → value）。 */
function expectWritten(writes: Array<{ zone: string; key: string; value: unknown }>, zone: string, key: string, value: unknown): void {
  const hit = writes.find(w => w.zone === zone && w.key === key)
  expect(hit, `期望写入 ${zone}.${key}`).toBeDefined()
  expect(hit?.value).toEqual(value)
}

// ── hpbrief（§2.2 已定稿）───────────────────────────────────────────

const HPBRIEF_LINES = [
  '#56074,18837,324,648,311,622',
  '#313,313,313,257,257,257',
  '#0,80,331,331,0,0',
]

describe('hpbrief（sequence，定稿 18 位表）', () => {
  it('实录回放：三行 → vitals 16 键 + combat 2 键，行全部打 status 标', () => {
    const { tracker, writes } = harness()
    const lines = HPBRIEF_LINES.map(line)
    for (const l of lines) tracker.observe(l)
    expect(lines.map(l => l.kind)).toEqual([STATUS_KIND, STATUS_KIND, STATUS_KIND])
    expect(writes.length).toBe(18)
    expectWritten(writes, 'vitals', '经验', 56074)
    expectWritten(writes, 'vitals', '潜能', 18837)
    expectWritten(writes, 'vitals', '最大内力', 324)
    expectWritten(writes, 'vitals', '内力', 648)
    expectWritten(writes, 'vitals', '最大精力', 311)
    expectWritten(writes, 'vitals', '精力', 622)
    expectWritten(writes, 'vitals', '气血上限', 313)
    expectWritten(writes, 'vitals', '最大气血', 313)
    expectWritten(writes, 'vitals', '气血', 313)
    expectWritten(writes, 'vitals', '精神上限', 257)
    expectWritten(writes, 'vitals', '最大精神', 257)
    expectWritten(writes, 'vitals', '精神', 257)
    expectWritten(writes, 'vitals', '真气', 0)
    expectWritten(writes, 'vitals', '战意', 80)
    expectWritten(writes, 'vitals', '食物', 331)
    expectWritten(writes, 'vitals', '饮水', 331)
    expectWritten(writes, 'combat', '战斗中', false)
    expectWritten(writes, 'combat', '忙', false)
  })

  it('完整性校验失败（D5）：行数不足即断 ⇒ 整组不写（已打标保留）', () => {
    const { tracker, writes } = harness()
    const l1 = line(HPBRIEF_LINES[0]!)
    const l2 = line(HPBRIEF_LINES[1]!)
    const l3 = line('你伸了个懒腰。')
    tracker.observe(l1)
    tracker.observe(l2)
    tracker.observe(l3)
    expect(writes).toEqual([])
    expect(l1.kind).toBe(STATUS_KIND)
    expect(l2.kind).toBe(STATUS_KIND)
  })

  it('完整性校验失败（D5）：cell 数不对 / 非纯数字 ⇒ 整组不写不猜；空格 trim 后合法照写', () => {
    const bad = harness()
    for (const s of ['#56074,18837,324,648,311', '#56074,18837,324,648,311,abc', HPBRIEF_LINES[1]!, HPBRIEF_LINES[2]!]) {
      bad.tracker.observe(line(s))
    }
    expect(bad.writes).toEqual([]) // 首行 5 cell / 非纯数字 ⇒ 序列作废，后续行另开新组
    // 空格分隔但 trim 后仍是 6 个纯数字 ⇒ 合法（成功率对齐实录变体）
    const spaced = harness()
    spaced.tracker.observe(line('#56074, 18837, 324, 648, 311, 622'))
    spaced.tracker.observe(line(HPBRIEF_LINES[1]!))
    spaced.tracker.observe(line(HPBRIEF_LINES[2]!))
    expect(spaced.writes.length).toBe(18)
  })

  it('与 hp 表同键覆盖：后到覆盖，World 内同事实只留一处', () => {
    const world = new World()
    const tracker = new StateTracker({
      onWrite: (zone, key, value) => { world.set(zone, key, value, 'measured', { kind: 'track', time: Date.now() }) },
      onDelete: () => {},
    })
    for (const s of HPBRIEF_LINES) tracker.observe(line(s))
    // hp 表兜底同刻写入（值一致）
    tracker.observe(line('┌──────────────┐'))
    tracker.observe(line('│【内力】 648 / 324 (+ 0)      │'))
    tracker.observe(line('└──────────────┘'))
    const entry = world.get('vitals', '内力')
    expect(entry?.value).toBe(648)
    expect(entry?.source.kind).toBe('track')
    expect(world.get('vitals', '最大内力')?.value).toBe(324)
  })
})

// ── hp（table，§2.3）────────────────────────────────────────────────

/** hp 表格实录形态（按 §2.3 行事实拼装；完整实录入档 A.7 后同步校准）。 */
const HP_TABLE = [
  '┌──────────────────────────────┐',
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
  '└──────────北大侠客行──────────┘',
]

describe('hp（table：兜底 + 只有表格才有的文本状态）', () => {
  it('表格块回放：逐键写入 + 块全部行（含框线/页脚祝福语）打 status 标', () => {
    const { tracker, writes } = harness()
    const lines = HP_TABLE.map(line)
    for (const l of lines) tracker.observe(l)
    expect(lines.map(l => l.kind).every(k => k === STATUS_KIND)).toBe(true)
    expectWritten(writes, 'vitals', '精神', 257)
    expectWritten(writes, 'vitals', '最大精神', 257)
    expectWritten(writes, 'vitals', '气血', 313)
    expectWritten(writes, 'vitals', '最大气血', 313)
    expectWritten(writes, 'vitals', '真气', 0)
    expectWritten(writes, 'vitals', '精力', 622)
    expectWritten(writes, 'vitals', '最大精力', 311)
    expectWritten(writes, 'vitals', '精力加成', 0)
    expectWritten(writes, 'vitals', '内力', 648)
    expectWritten(writes, 'vitals', '最大内力', 324)
    expectWritten(writes, 'vitals', '内力加成', 0)
    expectWritten(writes, 'vitals', '战意', 80)
    expectWritten(writes, 'vitals', '食物', 331)
    expectWritten(writes, 'vitals', '最大食物', 400)
    expectWritten(writes, 'vitals', '食物状态', '缺食')
    expectWritten(writes, 'vitals', '饮水', 331)
    expectWritten(writes, 'vitals', '最大饮水', 400)
    expectWritten(writes, 'vitals', '饮水状态', '缺水')
    expectWritten(writes, 'vitals', '潜能', 18837)
    expectWritten(writes, 'vitals', '经验', 56074)
    expectWritten(writes, 'vitals', '状态', ['健康', '极度疲倦'])
  })

  it('规则未命中的表格块：只剔不写（World 零写入）', () => {
    const { tracker, writes } = harness()
    for (const s of ['┌────┐', '│未知表格│', '└────┘']) tracker.observe(line(s))
    expect(writes).toEqual([])
  })

  it('聊天行不撞：频道行不打标不写；块内已有标行 C5.2 优先不覆盖', () => {
    const { tracker, writes } = harness()
    const chat = line('【闲聊】张三：大家好')
    tracker.observe(chat)
    expect(chat.kind).toBeNull()
    expect(writes).toEqual([])
    // 块内已被 classifier 打标的行：追踪器不覆盖其 kind
    const pre = line('│【气血】 313 / 313 [100%]     │')
    pre.kind = 'chat'
    tracker.observe(line('┌────┐'))
    tracker.observe(pre)
    expect(pre.kind).toBe('chat')
    expectWritten(writes, 'vitals', '气血', 313) // 写入照常（块上下文是强证据）
  })
})

// ── 骨架：节标题 / lines / clear / reset ────────────────────────────

describe('tracker 骨架', () => {
  /** 采集 section 的探针规则（table 形状，命中任意含「探针」的行）。 */
  function sectionProbe(): { spec: TrackSpec; seen: RowContext[] } {
    const seen: RowContext[] = []
    const rule: TrackRule = {
      id: 'probe', shape: 'table', zone: 'probe',
      match: (row) => {
        if (row.raw.includes('探针')) { seen.push(row); return [] }
        return undefined
      },
    }
    return { spec: { rules: [rule] }, seen }
  }

  it('节标题：├ 边框行的中文节标题进入后续行的 section', () => {
    const { spec, seen } = sectionProbe()
    const { tracker } = harness(spec)
    for (const s of ['┌────┐', '├────[ 基本功夫 ]────┤', '│ 探针行 │']) tracker.observe(line(s))
    expect(seen.length).toBe(1)
    expect(seen[0]?.section).toBe('基本功夫')
  })

  it('lines 形状：块外逐行命中即打标即写（undefined = 不匹配）', () => {
    const rule: TrackRule = {
      id: 'probe-lines', shape: 'lines', zone: 'items',
      match: (row) => {
        const m = /^(.+?) : (.+)$/.exec(row.raw)
        if (m === null) return undefined
        const aliases = (m[2] ?? '').split(',').map(s => s.trim()).filter(s => s !== '')
        return [{ key: m[1] ?? '', value: aliases } satisfies TrackEntry]
      },
    }
    const { tracker, writes } = harness({ rules: [rule] })
    const hit = line('青色道袍 : pao, cloth, dao pao')
    tracker.observe(hit)
    expect(hit.kind).toBe(STATUS_KIND)
    expectWritten(writes, 'items', '青色道袍', ['pao', 'cloth', 'dao pao'])
    const miss = line('你查看了别称。')
    tracker.observe(miss)
    expect(miss.kind).toBeNull()
    expect(writes.length).toBe(1)
  })

  it('clear 规则（D9）：命中即消解 World 条目；zone/key 不存在时静默幂等', () => {
    const world = new World()
    world.set('vitals', '食物状态', '缺食', 'measured', { kind: 'track', time: Date.now() })
    const tracker = new StateTracker({
      onWrite: () => {},
      onDelete: (zone, key) => { world.delete(zone, key) },
    })
    expect(world.delete('nihil', 'nothing')).toBe(false) // World.delete 缺席静默
    tracker.observe(line('你不再感到饥饿。'))
    expect(world.get('vitals', '食物状态')).toBeUndefined()
  })

  it('reset：断线后 in-block 状态清空（│ 行不再被当块内容打标）', () => {
    const { tracker } = harness()
    tracker.observe(line('┌────┐'))
    tracker.reset()
    const l = line('│普通行│')
    tracker.observe(l)
    expect(l.kind).toBeNull()
  })
})

// ── T19.4：sc / i / skills / id（片段先行，待实录校准）───────────────

describe('sc（character：八维 + 存款/杀气/门派/上榜差经验 分批①）', () => {
  it('八维（含 ? 保留）/数字标签/门派履历/头衔姓名 逐键写入', () => {
    const { tracker, writes } = harness()
    for (const s of [
      '┌────┐',
      '│ 膂力：[25] │ 悟性：[?] │',
      '│ 存款：1,234,567 │ 杀气：10 │',
      '│ 门派：武当派 │ 师承：张三丰 │',
      '│ 门忠：9,999 │ 出师：否 │ 叛师：否 │',
      '│ 上榜差经验=33,144,188 │',
      '│ 武当派第四代弟子 夫差(Vicrly) │',
      '└────┘',
    ]) tracker.observe(line(s))
    expectWritten(writes, 'character', '膂力', 25)
    expectWritten(writes, 'character', '悟性', '?')
    expectWritten(writes, 'character', '存款', 1234567)
    expectWritten(writes, 'character', '杀气', 10)
    expectWritten(writes, 'character', '门派', '武当派')
    expectWritten(writes, 'character', '师承', '张三丰')
    expectWritten(writes, 'character', '门忠', 9999)
    expectWritten(writes, 'character', '出师', '否')
    expectWritten(writes, 'character', '上榜差经验', 33144188)
    expectWritten(writes, 'character', '头衔', '武当派第四代弟子')
    expectWritten(writes, 'character', '姓名', '夫差')
    expectWritten(writes, 'character', '英文名', 'Vicrly')
  })
})

describe('i（inventory：件数/负重/财物）', () => {
  it('背包片段回放：中文数字存原文 + 财物结构化', () => {
    const { tracker, writes } = harness()
    for (const s of [
      '┌────┐',
      '│你共携带六件器物│',
      '│负重：约十斤│',
      '│ 黄金×4 白银×70 铜板×81 │',
      '└────┘',
    ]) tracker.observe(line(s))
    expectWritten(writes, 'inventory', '件数', '六')
    expectWritten(writes, 'inventory', '负重', '约十斤')
    expectWritten(writes, 'inventory', '财物', { gold: 4, silver: 70, copper: 81 })
  })
})

describe('skills（table：节标题/flag/cap/槽位汇总）', () => {
  it('技能行 + 槽位汇总行回放：英文 id 当键，cap 为 - 省略', () => {
    const { tracker, writes } = harness()
    for (const s of [
      '┌────┐',
      '├────[ 基本功夫 ]────┤',
      '│＋ 基础拳脚│ unarmed │ 10/100 │',
      '│□ 流云飞袖│ liuyun │ 5/- │',
      '│技能槽位│ 17.5 / 12.5 │ -5.56%│',
      '└────┘',
    ]) tracker.observe(line(s))
    expectWritten(writes, 'skills', 'unarmed', { name: '基础拳脚', level: 10, cap: 100, flag: '＋', category: '基本功夫' })
    expectWritten(writes, 'skills', 'liuyun', { name: '流云飞袖', level: 5, flag: '□', category: '基本功夫' })
    expectWritten(writes, 'skills', '槽位', { used: 17.5, free: 12.5, capDelta: '-5.56%' })
  })
})

describe('id（items 别称表：lines 形状）', () => {
  it('表头只打标不写；别称行写数组', () => {
    const { tracker, writes } = harness()
    const header = line('你身上携带物品的别称如下 :')
    tracker.observe(header)
    expect(header.kind).toBe(STATUS_KIND)
    expect(writes).toEqual([])
    const entry = line('青色道袍 : pao, cloth, dao pao')
    tracker.observe(entry)
    expect(entry.kind).toBe(STATUS_KIND)
    expectWritten(writes, 'items', '青色道袍', ['pao', 'cloth', 'dao pao'])
  })
})

// ── runtime 行路径接线 ──────────────────────────────────────────────

/** 接受连接并回放原始行的 TCP 服务端。 */
async function startLineServer(reply: Buffer): Promise<{ port: number; close(): Promise<void> }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((s) => {
    sockets.push(s)
    s.resume()
    s.once('data', () => { s.write(reply) })
    s.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

describe('runtime 行路径接线（D1）', () => {
  it('hpbrief 三行到达 → world 写入（kind=track）+ 行打标 status + onWorldChange', async () => {
    const reply = Buffer.from(HPBRIEF_LINES.map(l => l + '\r\n').join(''), 'utf8')
    const server = await startLineServer(reply)
    try {
      const rt = new SessionRuntime('t19')
      let worldChanges = 0
      rt.onWorldChange = () => { worldChanges += 1 }
      await rt.connect({ host: '127.0.0.1', port: server.port })
      await new Promise(r => setTimeout(r, 50))
      const entry = rt.world.vitals?.内力
      expect(entry?.value).toBe(648)
      expect(entry?.source.kind).toBe('track')
      expect(rt.world.vitals?.战意?.value).toBe(80)
      expect(rt.world.combat?.战斗中?.value).toBe(false)
      expect(worldChanges).toBeGreaterThan(0)
      rt.dispose()
    } finally {
      await server.close()
    }
  })
})
