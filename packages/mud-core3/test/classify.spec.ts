/**
 * classify 测试 — C5.2 行打标与画面分屏（详细设计测试面 1/2/6）。
 *
 * 覆盖：
 *   1. 语料回放打标：聊天（实录行）/注入规则（action）/无标三类命中正确
 *   2. 单点写入：runtime 行路径打标后 line.kind 可读（录制/画面/投递同见）
 *   3. 规则编译：非法正则 fail-loud；声明序取首个命中
 *   4. 打标零副作用：录制缓冲仍全量（有标行留在 pendingLines）
 *
 * 语料锚点（2026-10-03 校准）：聊天行取自 logs/ 实录 stream 通道原文
 * （【闲聊】×4 +【交易】×2 命中、全量 95KB 零误报的同一规则）。
 */

import { describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:net'

import { Classifier, DEFAULT_CLASSIFY_RULES } from '../src/classify.ts'
import { AnsiStreamParser, type MudLine } from '../src/link/line.ts'
import { SessionRuntime } from '../src/runtime.ts'

/** 实录聊天行（logs/mud-20261003-session-a076….log stream 通道，逐字摘录）。 */
const CORPUS_CHAT = [
  '【闲聊】库落落(Kll): jxf还算好做b吧，大不了直接跑路，比较安全 ',
  '【闲聊】一缕青烟对游鲲翼抱拳道：「青山不改，绿水常流，咱们后会有期！」 (cnemc||bye you)',
  '【交易】玩家广告现有少量位置出租，可在榷场使用post <内容>发布广告，费用一百锭黄金/天。 ',
]

/** 实录无标行（同日日志：横幅/系统/地图/战斗形态，全量零误报样本族）。 */
const CORPUS_UNTAGGED = [
  '☆ 飞雪连天射白鹿，笑书神侠倚碧鸳 ☆',
  '本游戏参考金庸武侠系列小说编写',
  '你挥出一剑。',
  ' > ',
  '',
  '提示：【闲聊】字样出现在行中不算频道行（首字符锚定的负例边界）',
]

/** 实录他人动作/进出行（2026-10-03 实机房间语料）：锚行尾 + 主语排除（非你）。 */
const CORPUS_ACTION = [
  '雷平坤往西离开。',
  '行者急急忙忙地离开了。',
  '孟早车离开游戏。',
  '雷平坤身穿北侠战衣走了过来。',
  '一个才女嘴里念念有词地慢慢踱了过来。',
  '暴雪连线进入这个世界。',
  '了悔重新连线回到这个世界。',
  '了悔断线了。',
  '文玉给梁红蝉一双巨灵之靴。',
  '护寺僧人手持龙棘，身穿南明离火之袍走了过来。',
]

/** 实录他人状态刷屏（主语非你；自身状态保留主屏，2026-10-03 用户裁定）。 */
const CORPUS_VITALS = [
  '本小减缓真气运行，让气血运行恢复正常。',
  '本小运行真气加速自身的气血恢复。',
]

/** 实录负例：战斗接近/自身活动/自身警告不打标（留给 danger 判据 / 主屏）。 */
const CORPUS_NEGATIVE = [
  '野狗向你冲了过来。', // 冲了过来 = 战斗接近，不进 action（danger 判据保留）
  '你快步离开了。', // 主语排除：自身活动「你」开头不进 action（2026-10-03 用户洞见）
  '你渴得眼冒金星，全身无力。', // 自身状态保留主屏（2026-10-03 用户裁定）
  '请注意，你的活跃度已经偏低。exp 5M以前，你可以使用fullme每15分钟补满全部状态，double内力。',
  '5M后长时间不使用fullme，会被系统判定为机器人。', // 自身/系统警告保留主屏
  '杨玄胜开始认真考虑这个问题。', // 无规则命中留主屏（房间说话暂不打标，用户裁定）
]

/** ANSI 包裹的同型行：分类输入 = 去 ANSI 的 text 变体，色标不影响命中。 */
const CORPUS_CHAT_ANSI = '\x1b[36m【闲聊】\x1b[0m测试者(Tst): 大家好呀'

describe('Classifier 规则', () => {
  it('语料回放打标：实录聊天行全命中 chat，实录无标行全 null', () => {
    const c = new Classifier()
    for (const text of CORPUS_CHAT) {
      const line: MudLine = { text, raw: text, style: [], abs: 0, time: 0, isPrompt: false, kind: null }
      c.mark(line)
      expect(line.kind, text).toBe('chat')
    }
    for (const text of CORPUS_UNTAGGED) {
      const line: MudLine = { text, raw: text, style: [], abs: 0, time: 0, isPrompt: false, kind: null }
      c.mark(line)
      expect(line.kind, JSON.stringify(text)).toBeNull()
    }
  })

  it('语料回放打标：他人动作/进出 → action；他人状态刷屏 → vitals；战斗/自身活动负例 null', () => {
    const c = new Classifier()
    for (const text of CORPUS_ACTION) {
      const line: MudLine = { text, raw: text, style: [], abs: 0, time: 0, isPrompt: false, kind: null }
      c.mark(line)
      expect(line.kind, text).toBe('action')
    }
    for (const text of CORPUS_VITALS) {
      const line: MudLine = { text, raw: text, style: [], abs: 0, time: 0, isPrompt: false, kind: null }
      c.mark(line)
      expect(line.kind, text).toBe('vitals')
    }
    for (const text of CORPUS_NEGATIVE) {
      const line: MudLine = { text, raw: text, style: [], abs: 0, time: 0, isPrompt: false, kind: null }
      c.mark(line)
      expect(line.kind, JSON.stringify(text)).toBeNull()
    }
  })

  it('匹配输入 = 去 ANSI 变体：色标包裹的频道行照常命中', () => {
    // 模拟解析层：text 已剥离 ANSI（raw 保留）——与运行时管线同型。
    const parser = new AnsiStreamParser()
    const [line] = parser.write(CORPUS_CHAT_ANSI + '\n')
    expect(line).toBeDefined()
    if (line === undefined) return
    expect(line.text).toBe('【闲聊】测试者(Tst): 大家好呀')
    new Classifier().mark(line)
    expect(line.kind).toBe('chat')
  })

  it('打标零副作用：text/raw/style/abs 不变，录制照常（有标行留在缓冲）', () => {
    const c = new Classifier()
    const text = CORPUS_CHAT[0] ?? ''
    const line: MudLine = { text, raw: `\x1b[36m${text}`, style: [], abs: 7, time: 1234, isPrompt: false, kind: null }
    c.mark(line)
    expect(line).toMatchObject({ text, raw: `\x1b[36m${text}`, abs: 7, time: 1234, kind: 'chat' })
  })

  it('注入规则：action 类按 Config 清单命中（部署覆盖/补充缺省表）', () => {
    const c = new Classifier([
      { kind: 'chat', source: '^\\s*【[^】]{1,6}】' },
      { kind: 'action', source: '向(你|库落落)使出一招' },
    ])
    const action: MudLine = {
      text: '库落落向你使出一招「黑虎掏心」。', raw: '', style: [], abs: 0, time: 0, isPrompt: false, kind: null,
    }
    c.mark(action)
    expect(action.kind).toBe('action')
    const chat: MudLine = { text: CORPUS_CHAT[0] ?? '', raw: '', style: [], abs: 1, time: 0, isPrompt: false, kind: null }
    c.mark(chat)
    expect(chat.kind).toBe('chat') // 声明序：chat 先命中
  })

  it('声明序取首个命中：先声明者优先', () => {
    const c = new Classifier([
      { kind: 'a', source: '【' },
      { kind: 'chat', source: '^\\s*【' },
    ])
    const line: MudLine = { text: '【闲聊】hi', raw: '', style: [], abs: 0, time: 0, isPrompt: false, kind: null }
    c.mark(line)
    expect(line.kind).toBe('a')
  })

  it('非法正则 fail-loud：构造即抛（部署错误不静默失效）', () => {
    expect(() => new Classifier([{ kind: 'chat', source: '【(' }])).toThrow(/分类规则编译失败/)
  })

  it('缺省规则表非空且含 chat（防误删预置）', () => {
    expect(DEFAULT_CLASSIFY_RULES.length).toBeGreaterThan(0)
    expect(DEFAULT_CLASSIFY_RULES.some(r => r.kind === 'chat')).toBe(true)
  })
})

describe('runtime 单点打标（测试面 2：onLine 后 line.kind 可读）', () => {
  it('行路径打标：onLine 回调里 kind 已写入；录制/主屏/副屏三消费者同见', async () => {
    // 真实回环 TCP（同 screen.spec 用例 2 的接线形态）。
    const server: Server = createServer(socket => {
      socket.on('data', () => {}) // 吃掉客户端命令
      socket.write('\x1b[36m【闲聊】路人(Npc): 你好啊\x1b[0m\r\n你环顾四周。\r\n')
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      const rt = new SessionRuntime('cls-1', 100)
      const seen: MudLine[] = []
      rt.onLine = line => { seen.push(line) }
      await rt.connect({ host: '127.0.0.1', port }, 2000)
      await new Promise(r => setTimeout(r, 150))

      // 单点写入：装配层 onLine 链（投递侧）读到的行已带 kind。
      expect(seen.length).toBe(2)
      expect(seen[0]?.kind).toBe('chat')
      expect(seen[1]?.kind).toBeNull()

      // 打标零副作用：录制缓冲全量（有标行留在 pendingLines，recentLines 可读）。
      const recent = rt.recentLines(10)
      expect(recent.some(l => l.kind === 'chat')).toBe(true)
      expect(recent.length).toBe(2)
      rt.dispose()
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
})
