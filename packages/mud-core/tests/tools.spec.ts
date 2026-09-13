/**
 * dsh-mud-core 工具集测试 — 语义工具 (mud_move/mud_look/mud_status) + 兜底 mud_send。
 *
 * 工具 = 校验点: 非法参数在工具层拒绝 (不发命令), 合法参数转成游戏命令。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildMudTools, DEFAULT_ACTIVITY_TABLE, MOVE_ALIASES, MOVE_DIRS, OUT_SCHEMA, STATUS_CMDS, type MudTools,
} from '../src/agent/tools.ts'
import { CommandResponseController, type ReplyOptions } from '../src/network/response.ts'
import { createWorld } from '../src/world/world.ts'

function makeTools(): { tools: MudTools; sent: string[]; logs: string[] } {
  const sent: string[] = []
  const logs: string[] = []
  const tools = buildMudTools({ send: c => sent.push(c), log: t => logs.push(t) })
  return { tools, sent, logs }
}

describe('mud_move 方向校验', () => {
  it('全名/别名/大写 → 规范命令, 非法拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_move!.execute({ direction: 'north' })).toEqual({ ok: true, note: '向 north 移动', cmd: 'north' })
    expect(tools.mud_move!.execute({ direction: 'n' })).toEqual({ ok: true, note: '向 north 移动', cmd: 'north' })
    expect(tools.mud_move!.execute({ direction: 'NE' })).toEqual({ ok: true, note: '向 northeast 移动', cmd: 'northeast' })
    expect(tools.mud_move!.execute({ direction: 'up' })).toEqual({ ok: true, note: '向 up 移动', cmd: 'up' })
    expect(tools.mud_move!.execute({ direction: 'enter' })).toEqual({ ok: true, note: '向 enter 移动', cmd: 'enter' })
    expect(sent).toEqual(['north', 'north', 'northeast', 'up', 'enter'])
    expect(tools.mud_move!.execute({ direction: 'xyz' }).ok).toBe(false)
    expect(tools.mud_move!.execute({ direction: '' }).ok).toBe(false)
    expect(sent.length).toBe(5)
  })
})

describe('mud_look target 校验', () => {
  it('无 target = 房间; 有 target = look <target>; 分号拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_look!.execute({})).toEqual({ ok: true, note: 'look', cmd: 'look' })
    expect(tools.mud_look!.execute({ target: 'paizi' })).toEqual({ ok: true, note: 'look paizi', cmd: 'look paizi' })
    expect(tools.mud_look!.execute({ target: 'ren qunyu' })).toEqual({ ok: true, note: 'look ren qunyu', cmd: 'look ren qunyu' })
    expect(sent).toEqual(['look', 'look paizi', 'look ren qunyu'])
    expect(tools.mud_look!.execute({ target: 'paizi;quit' }).ok).toBe(false)
    expect(sent.length).toBe(3)
  })
})

describe('mud_status what 枚举校验', () => {
  it('what → 命令, 非法拒绝', () => {
    const { tools, sent } = makeTools()
    expect(tools.mud_status!.execute({ what: 'hp' })).toEqual({ ok: true, note: 'hp', cmd: 'hp' })
    expect(tools.mud_status!.execute({ what: 'inventory' })).toEqual({ ok: true, note: 'i', cmd: 'i' })
    expect(tools.mud_status!.execute({ what: 'SCORE' })).toEqual({ ok: true, note: 'score', cmd: 'score' })
    expect(tools.mud_status!.execute({ what: 'xyz' }).ok).toBe(false)
    expect(tools.mud_status!.execute({ what: '' }).ok).toBe(false)
    expect(sent).toEqual(['hp', 'i', 'score'])
  })
})

describe('mud_help 命令语法查询 (零发送)', () => {
  it('三种形态都不发命令: 索引 / 分类语法 / 单条命令', async () => {
    const { tools, sent } = makeTools()

    const index = await tools.mud_help!.execute({})
    expect(index.ok).toBe(true)
    expect(index.cmd).toBe('')
    expect(index.note).toContain('[navigation]')

    const category = await tools.mud_help!.execute({ topic: 'navigation' })
    expect(category.note).toContain('go {direction}')
    const one = await tools.mud_help!.execute({ topic: 'ask' })
    expect(one.note).toContain('ask {target} about {topic}')
    const unknown = await tools.mud_help!.execute({ topic: 'nope' })
    expect(unknown.note).toContain('未知主题')

    expect(sent).toEqual([])               // 零发送: 一条命令都不能出去
  })
})

describe('mud_send 兜底', () => {
  it('非空命令通过; 空命令 = 发一个空行 (合法); 只有参数缺失才拒绝', async () => {
    const { tools, sent } = makeTools()
    expect(await tools.mud_send!.execute({ cmd: 'ask zhang about 拜师' }))
      .toEqual({ ok: true, note: 'ask zhang about 拜师', cmd: 'ask zhang about 拜师' })
    // 空命令合法 (作者定案 2026-09-13: 其他客户端也允许; 登录收尾/翻页/退出 MXP 检测都是发空行)。
    expect(await tools.mud_send!.execute({ cmd: '' })).toMatchObject({ ok: true, cmd: '' })
    expect(await tools.mud_send!.execute({ cmd: '  ' })).toMatchObject({ ok: true, cmd: '' })
    // 参数缺失 (既没 cmd 也没 cmds) = 参数错误。
    expect((await tools.mud_send!.execute({})).ok).toBe(false)
    expect(sent).toEqual(['ask zhang about 拜师', '', ''])
  })
  it('命令序列允许空命令 (发完即走的直发路径; 分页等需要空行的场合)', async () => {
    const { tools, sent } = makeTools()
    expect(await tools.mud_send!.execute({ cmds: ['', 'look'] }))
      .toEqual({ ok: true, note: '命令序列', cmd: '' })
    expect(sent).toEqual(['', 'look'])
  })
  it('凭据: {name}/{pass} 仅发送瞬间插值 — log/返回值只见占位符 (明文不落转录)', async () => {
    const sent: string[] = []
    const logs: string[] = []
    const tools = buildMudTools({
      send: c => sent.push(c),
      log: t => logs.push(t),
      resolveCredentials: () => ({ name: 'hero', pass: 's3cret' }),
    })
    const r = await tools.mud_send!.execute({ cmd: '{name}' })
    // 发送: 明文 (socket 瞬间); 返回值/日志: 占位符原文 (转录/日志不落明文)。
    expect(sent).toEqual(['hero'])
    expect(r).toEqual({ ok: true, note: '{name}', cmd: '{name}' })
    expect(logs.join('\n')).toBe('[工具] mud_send → {name}')
    expect(logs.join('\n')).not.toContain('s3cret')
    // 序列同样逐条插值。
    const r2 = await tools.mud_send!.execute({ cmds: ['{name}', '{pass}'] })
    expect(sent).toEqual(['hero', 'hero', 's3cret'])
    expect(r2).toEqual({ ok: true, note: '命令序列', cmd: '' })
    // 无凭据 (缺省): 占位符原样发送。
    const bare = buildMudTools({ send: c => sent.push(c) })
    expect((await bare.mud_send!.execute({ cmd: '{pass}' })).ok).toBe(true)
    expect(sent.at(-1)).toBe('{pass}')
  })
  it('mud_recall: 取最近 count 行; 空缓冲显式反馈 (不静默空串)', () => {
    const buffer = ['房间描述', '这里明显的出口是 north。', '> ']
    const tools = buildMudTools({ recall: (n) => buffer.slice(-n) })
    expect(tools.mud_recall!.execute({ count: 2 }).note)
      .toBe('这里明显的出口是 north。\n> ')
    const empty = buildMudTools() // 缺省 recall = () => []
    const r = empty.mud_recall!.execute({})
    expect(r.ok).toBe(true)
    expect(r.note).toContain('没有尚未投递的游戏输出')
  })
})

describe('mud_captcha 解析验证码 (系统流程工具)', () => {
  it('缺 url 直接拒绝; 白名单外的地址拒绝且不发请求; 正常地址取图并推弹窗', async () => {
    const pushed: { imageUrl: string; robotUrl: string; note?: string }[] = []
    const tools = buildMudTools({
      captcha: {
        push: (imageUrl, robotUrl, note) => {
          pushed.push({ imageUrl, robotUrl, ...(note === undefined ? {} : { note }) })
        },
      },
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('<img src="./b2evo_captcha_tmp/a.jpg">').buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)

    // 参数校验: 没有地址 → 工具层拒绝（流程据此失败收束）。
    expect((await tools.mud_captcha!.execute({})).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    // 出站围栏: 非 pkuxkx.net 一律拒绝（地址来自游戏文本，不可信）。
    const rogue = await tools.mud_captcha!.execute({ url: 'http://169.254.169.254/robot.php?filename=1' })
    expect(rogue.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    // 正常路径: 取图 → 归一为绝对地址 → 推弹窗（note 透传给人工）。
    const robot = 'http://fullme.pkuxkx.net/robot.php?filename=1699999999'
    const ok = await tools.mud_captcha!.execute({ url: robot, note: '上一轮答错了' })
    expect(ok.ok).toBe(true)
    expect(pushed).toEqual([{
      imageUrl: 'http://fullme.pkuxkx.net/b2evo_captcha_tmp/a.jpg',
      robotUrl: robot,
      note: '上一轮答错了',
    }])
    vi.unstubAllGlobals()
  })
})

describe('工具常量完备', () => {
  it('别名都在全名表内, 状态都有映射', () => {
    for (const alias of Object.keys(MOVE_ALIASES)) {
      expect(MOVE_DIRS).toContain(MOVE_ALIASES[alias]!)
    }
    for (const what of Object.keys(STATUS_CMDS)) {
      expect(STATUS_CMDS[what]).toBeTruthy()
    }
  })
})

describe('命令-应答桥装配 (sendAndAwait)', () => {
  it('mud_move 异步: note = 应答文本 (GA 结算), ok = true', async () => {
    const sent: string[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd) => {
        sent.push(String(cmd))
        return { ok: true, cmd: String(cmd), text: '北大街 - 北大侠客行\n  这里明显的出口是 south。', lines: [], settled: 'ga' }
      },
    })
    const r = await tools.mud_move!.execute({ direction: 'north' })
    expect(r).toEqual({ ok: true, note: '北大街 - 北大侠客行\n  这里明显的出口是 south。', cmd: 'north', settled: 'ga' })
    expect(sent).toEqual(['north'])
  })
  it('mud_send until 声明传递 + 超时结算 (ok=false, note 含超时标记)', async () => {
    const seen: ReplyOptions[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd, opts) => {
        expect(String(cmd)).toBe('dz')
        seen.push(opts ?? {})
        return { ok: false, cmd: 'dz', text: '你开始打坐\n[应答超时，边界未命中，请决策]', lines: [], settled: 'timeout' }
      },
    })
    const r = await tools.mud_send!.execute({ cmd: 'dz', until: { regex: '^你开始打坐', timeout: 120 } })
    expect(r.ok).toBe(false)
    expect(r.note).toContain('应答超时')
    expect(seen[0]!.until).toEqual({ regex: '^你开始打坐', timeout: 120 })
    // P1-1: 工具结果携带 settled=timeout。下方 render 走桥路径 (不加 "工具拒绝:" 前缀)。
    expect((r as { settled?: string }).settled).toBe('timeout')
  })
  it('P1-1: 桥超时结果 render 不加 "工具拒绝:" 前缀 (resolveLines 可精确还原)', async () => {
    const sent: string[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd) => {
        sent.push(String(cmd))
        return { ok: false, cmd: String(cmd), text: '你开始打坐\n你一无所获。\n[应答超时，边界未命中，请决策]', lines: [], settled: 'timeout' }
      },
    })
    const r = await tools.mud_send!.execute({ cmd: 'dz' })
    expect(r).toEqual({ ok: false, note: '你开始打坐\n你一无所获。\n[应答超时，边界未命中，请决策]', cmd: 'dz', settled: 'timeout' })
    // 快速文本还原验证: 结果文本经 strip+resolve 应还原纯行 (无 "工具拒绝:" 前缀干扰)。
    const rendered = r.note
    expect(rendered.startsWith('工具拒绝:')).toBe(false)
    expect(rendered).toContain('你开始打坐')
    // 工具层校验拒绝仍加前缀 (对照)。
    const rej = tools.mud_move!.execute({ direction: 'xyz' })
    expect(rej.ok).toBe(false)
  })
  it('§8 活动表: 每条声明的每个命令都自动附带该条的完成句 until (表驱动)', async () => {
    const seen: { cmd: string; opts?: ReplyOptions }[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd, opts) => {
        seen.push({ cmd: String(cmd), opts })
        return { ok: true, cmd: String(cmd), text: '完成', lines: [], settled: 'ga' }
      },
    })
    // 遍历活动表本身: 新增一条活动不改测试也会被覆盖 (表是唯一事实源)。
    const cases: { cmd: string; entry: (typeof DEFAULT_ACTIVITY_TABLE)[number] }[] = []
    for (const entry of DEFAULT_ACTIVITY_TABLE) {
      for (const cmd of entry.commands) cases.push({ cmd: cmd === 'dazuo' ? 'dazuo 10' : cmd, entry })
    }
    for (const c of cases) await tools.mud_send!.execute({ cmd: c.cmd })

    expect(seen).toHaveLength(cases.length)
    cases.forEach((c, i) => {
      expect(seen[i]!.cmd).toBe(c.cmd)
      expect(seen[i]!.opts?.until?.regex).toBe(c.entry.until)
      expect(seen[i]!.opts?.until?.timeout).toBe(c.entry.timeoutMs)
    })
    // 覆盖抓包实证的两条关键正则 (活动表被改坏时能立刻看出来)。
    expect(DEFAULT_ACTIVITY_TABLE.map(e => e.id)).toContain('meditate')
    expect(seen.find(s => s.cmd === 'dz')!.opts?.until?.regex).toContain('你将运转于全身经脉间的内息收回丹田')
    expect(seen.find(s => s.cmd === 'sleep')!.opts?.until?.regex).toContain('你一觉醒来，精神抖擞地活动了几下手脚')
  })

  it('§8 活动表: 显式 until 优先; 未声明的命令不带 until; 部署可整体覆盖', async () => {
    const seen: (ReplyOptions | undefined)[] = []
    const tools = buildMudTools({
      sendAndAwait: async (_cmd, opts) => {
        seen.push(opts)
        return { ok: true, cmd: 'x', text: '', lines: [], settled: 'ga' }
      },
    })
    await tools.mud_send!.execute({ cmd: 'dz', until: { regex: '^自定义$', timeout: 120 } })
    await tools.mud_send!.execute({ cmd: 'look' })
    expect(seen[0]!.until).toEqual({ regex: '^自定义$', timeout: 120 })
    expect(seen[1]).toBeUndefined()

    // 覆盖表: 只有 pray 带完成句; dz 不再自动附带 (配置即事实)。
    const custom = buildMudTools({
      activity: [{ id: 'pray', commands: ['pray'], until: '^你祈祷完毕。$', note: '自定义' }],
      sendAndAwait: async (_cmd, opts) => {
        seen.push(opts)
        return { ok: true, cmd: 'x', text: '', lines: [], settled: 'ga' }
      },
    })
    await custom.mud_send!.execute({ cmd: 'pray' })
    await custom.mud_send!.execute({ cmd: 'dz' })
    expect(seen[2]!.until).toEqual({ regex: '^你祈祷完毕。$' })
    expect(seen[3]).toBeUndefined()
  })

  it('§11 外部占位符: {captcha} 在发送瞬间由人工值插值 (明文不落转录)', async () => {
    const sent: string[] = []
    let captcha = ''
    const tools = buildMudTools({
      resolveExternalValues: () => (captcha === '' ? {} : { captcha }),
      send: c => sent.push(c),
    })
    // 规则动作原文带占位符; 没有值时原样发出 (不该凭空消失)。
    await tools.mud_send!.execute({ cmd: 'fullme {captcha}' })
    expect(sent[0]).toBe('fullme {captcha}')
    // 人工回填后插值; 凭据与外部值可同时生效。
    captcha = '1234'
    await tools.mud_send!.execute({ cmd: 'fullme {captcha}' })
    expect(sent[1]).toBe('fullme 1234')
    const withCreds = buildMudTools({
      resolveCredentials: () => ({ name: 'vicrly', pass: 's3cret' }),
      resolveExternalValues: () => ({ captcha: '99' }),
      send: c => sent.push(c),
    })
    await withCreds.mud_send!.execute({ cmd: '{name} {pass} fullme {captcha}' })
    expect(sent[2]).toBe('vicrly s3cret fullme 99')
  })

  it('§8 exec.signal: 回合取消信号转发给桥 (send 类工具), 非 send 工具不受影响', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const tools = buildMudTools({
      sendAndAwait: async (_cmd, opts) => {
        signals.push(opts?.signal)
        return { ok: true, cmd: 'x', text: '', lines: [], settled: 'ga' }
      },
    })
    const controller = new AbortController()
    await tools.mud_send!.execute({ cmd: 'look' }, { signal: controller.signal })
    await tools.mud_move!.execute({ direction: 'north' }, { signal: controller.signal })
    await tools.mud_look!.execute({}, { signal: controller.signal })
    await tools.mud_status!.execute({ what: 'hp' }, { signal: controller.signal })
    // 无 opts → 不传信号 (桥按自己的超时/静默结算)。
    await tools.mud_send!.execute({ cmd: 'look' })
    // 非 send 工具只读本地状态, 不碰桥。
    expect(tools.mud_recall!.execute({ count: 1 }, { signal: controller.signal })).toMatchObject({ cmd: '' })

    expect(signals).toHaveLength(5)
    expect(signals.slice(0, 4).every(s => s === controller.signal)).toBe(true)
    expect(signals[4]).toBeUndefined()
  })

  it('P2-2: 命令序列逐条串行结算 (每条命令独立 GA)', async () => {
    const seenCmds: string[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd) => {
        seenCmds.push(String(cmd))
        return { ok: true, cmd: String(cmd), text: `${cmd} done`, lines: [], settled: 'ga' }
      },
    })
    const r = await tools.mud_send!.execute({ cmds: ['', 'look'] })
    expect(seenCmds).toEqual(['', 'look'])
    expect(r.ok).toBe(true)
    expect(r.note).toBe('look done')
    expect(r.cmd).toBe('命令序列')
  })
})

describe('危险命令策略表 (取代静态黑名单)', () => {
  it('缺省表: deny 条目在工具层硬拦 (suicide/passwd)', async () => {
    const { tools, sent } = makeTools()
    const denied = await tools.mud_send!.execute({ cmd: 'suicide' })
    expect(denied.ok).toBe(false)
    expect(denied.note).toContain('安全禁用命令')
    // ask 条目 (drop/quit) 不是工具层的硬边界 —— 工具照发, 由权限闸门决定。
    expect((await tools.mud_send!.execute({ cmd: 'drop sword' })).ok).toBe(true)
    expect(sent).toEqual(['drop sword'])
  })

  it('自定义策略表可整体替换 (部署配置路径)', async () => {
    const sent: string[] = []
    const tools = buildMudTools({
      send: c => sent.push(c),
      dangerous: [{ id: 'pray', commands: ['pray'], action: 'deny', reason: '自定义' }],
    })
    expect((await tools.mud_send!.execute({ cmd: 'pray' })).ok).toBe(false)
    expect((await tools.mud_send!.execute({ cmd: 'suicide' })).ok).toBe(true)
  })
})

describe('mud_state 零发送通路 (只读档信息源)', () => {
  it('读世界快照 + 最近输出, 不发任何命令 (未连接也可用)', () => {
    const sent: string[] = []
    const tools = buildMudTools({
      send: c => sent.push(c),
      recall: () => ['北大街 - 北大侠客行', '这里明显的出口是 south。'],
      world: createWorld(),
      isConnected: () => false,
    })
    const r = tools.mud_state!.execute({ lines: 2 })
    expect(r.ok).toBe(true)
    expect(r.cmd).toBe('')
    expect(r.note).toContain('连接: 未连接')
    expect(r.note).toContain('世界模型:')
    expect(r.note).toContain('这里明显的出口是 south。')
    expect(sent).toEqual([])
  })

  it('lines=0 只读世界模型; 无 world 装配时显式说明', () => {
    const tools = buildMudTools({ recall: () => ['x'] })
    const r = tools.mud_state!.execute({ lines: 0 })
    expect(r.ok).toBe(true)
    expect(r.note).toContain('世界模型: 未装配')
    expect(r.note).not.toContain('x')
  })
})

describe('工具结果字段必须全部在 OUT_SCHEMA 中声明', () => {
  // 回归: `settled` 曾漏声明 — `additionalProperties: false` 下判定为非法输出,
  // 工具**实际已执行** (命令已发出、应答已收到) 却回给模型一条失败帧。
  const declared = new Set(Object.keys(OUT_SCHEMA.properties))

  it('OUT_SCHEMA 声明 settled (桥结算语义)', () => {
    expect(declared).toContain('settled')
    expect(OUT_SCHEMA.additionalProperties).toBe(false)
  })

  it('每个工具在 (桥结算 / 未连接拒发 / 参数非法) 三条路径上的结果字段都已声明', async () => {
    const tools = buildMudTools({
      isConnected: () => true,
      sendAndAwait: async cmd => ({ ok: true, cmd: String(cmd), text: 'ok', lines: [], settled: 'ga' }),
    })
    const offlineTools = buildMudTools({ isConnected: () => false })
    for (const [name, tool] of Object.entries(tools)) {
      for (const probe of [tool, offlineTools[name]!]) {
        const r = await probe.execute({})
        for (const key of Object.keys(r)) {
          expect(declared.has(key), `${name} 返回了未声明字段 ${key}`).toBe(true)
        }
      }
    }
  })
})
