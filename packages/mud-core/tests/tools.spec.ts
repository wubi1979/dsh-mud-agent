/**
 * dsh-mud-core 工具集测试 — 语义工具 (mud_move/mud_look/mud_status) + 兜底 mud_send。
 *
 * 工具 = 校验点: 非法参数在工具层拒绝 (不发命令), 合法参数转成游戏命令。
 */

import { describe, expect, it, vi } from 'vitest'
import { buildMudTools, DEFAULT_ACTIVITY_TABLE } from '../src/agent/tools-build.ts'
import { OUT_SCHEMA, type MudTools } from '../src/agent/tools-schema.ts'
import { MOVE_ALIASES, MOVE_DIRS, STATUS_CMDS } from '../src/world/game.ts'
import type { WindowRequest, WindowResult } from '../src/agent/inflight.ts'
import { createWorld } from '../src/world/state.ts'

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

/** 窗口结算 stub 的便捷结果 (WindowResult 最小形; 缺省 = 窗口型 GA 关窗成功)。 */
function winResult(partial: Partial<WindowResult> & { cmd: string }): WindowResult {
  return { ok: true, text: '', lines: [], settled: 'ga', ...partial }
}

describe('在途窗口装配 (registerWindow; W7.2 取代命令-应答桥)', () => {
  it('mud_move 异步: 注册窗口型 (gaCount 1), note = 窗口应答文本 (T1/T2 同形 §2.4)', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => {
        seen.push(req)
        return winResult({ cmd: 'north', text: '北大街 - 北大侠客行\n  这里明显的出口是 south。' })
      },
    })
    const r = await tools.mud_move!.execute({ direction: 'north' })
    expect(r).toEqual({ ok: true, note: '北大街 - 北大侠客行\n  这里明显的出口是 south。', cmd: 'north', settled: 'ga' })
    expect(seen).toEqual([{ cmd: 'north', gaCount: 1, timeoutMs: 3000, label: 'mud_move' }])   // W10.1: fallback 缺省 3000 (D3)
  })

  it('mud_send until 声明 → ok 判据 + timeoutMs; 超时结算 ok=false (outcome fail)', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => {
        seen.push(req)
        return winResult({ cmd: 'dz', ok: false, text: '你开始打坐\n[应答超时，边界未命中，请决策]', settled: 'timeout', outcome: 'fail' })
      },
    })
    const r = await tools.mud_send!.execute({ cmd: 'dz', until: { regex: '^你开始打坐', timeout: 120 } })
    expect(r.ok).toBe(false)
    expect(r.note).toContain('应答超时')
    expect(seen[0]!.criteria).toEqual({ ok: new RegExp('^你开始打坐') })
    expect(seen[0]!.timeoutMs).toBe(120)
    expect((r as { settled?: string }).settled).toBe('timeout')
    expect((r as { outcome?: string }).outcome).toBe('fail')
  })

  it('P1-1: 窗口超时结果 render 不加 "工具拒绝:" 前缀 (窗口失败语义 ≠ 工具层校验拒绝)', async () => {
    const tools = buildMudTools({
      registerWindow: async (req) => winResult({
        cmd: String(req.cmd), ok: false,
        text: '你开始打坐\n你一无所获。\n[应答超时，边界未命中，请决策]',
        settled: 'timeout', outcome: 'fail',
      }),
    })
    const r = await tools.mud_send!.execute({ cmd: 'dz' })
    expect(r).toEqual({ ok: false, note: '你开始打坐\n你一无所获。\n[应答超时，边界未命中，请决策]', cmd: 'dz', settled: 'timeout', outcome: 'fail' })
    expect(r.note.startsWith('工具拒绝:')).toBe(false)
    // 工具层校验拒绝仍加前缀 (对照; settled 未定义 = 未结算)。
    const rej = tools.mud_move!.execute({ direction: 'xyz' })
    expect(rej.ok).toBe(false)
  })

  it('§8 活动表: 每条声明的每个命令自动附带完成句 ok 判据 (表驱动)', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => { seen.push(req); return winResult({ cmd: String(req.cmd), text: '完成' }) },
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
      expect(seen[i]!.criteria?.ok?.source).toBe(c.entry.until)
      if (c.entry.timeoutMs !== undefined) expect(seen[i]!.timeoutMs).toBe(c.entry.timeoutMs)
    })
    // 覆盖抓包实证的两条关键正则 (活动表被改坏时能立刻看出来)。
    expect(DEFAULT_ACTIVITY_TABLE.map(e => e.id)).toContain('meditate')
    expect(seen.find(s => s.cmd === 'dz')!.criteria?.ok?.source).toContain('你将运转于全身经脉间的内息收回丹田')
    expect(seen.find(s => s.cmd === 'sleep')!.criteria?.ok?.source).toContain('你一觉醒来，精神抖擞地活动了几下手脚')
  })

  it('§8 活动表: 显式 until 优先; 未声明的命令不带判据; 部署可整体覆盖', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => { seen.push(req); return winResult({ cmd: String(req.cmd) }) },
    })
    await tools.mud_send!.execute({ cmd: 'dz', until: { regex: '^自定义$', timeout: 120 } })
    await tools.mud_send!.execute({ cmd: 'look' })
    expect(seen[0]!.criteria).toEqual({ ok: new RegExp('^自定义$') })
    expect(seen[0]!.timeoutMs).toBe(120)
    expect(seen[1]!.criteria).toBeUndefined()

    // 覆盖表: 只有 pray 带完成句; dz 不再自动附带 (配置即事实)。
    const custom = buildMudTools({
      activity: [{ id: 'pray', commands: ['pray'], until: '^你祈祷完毕。$', note: '自定义' }],
      registerWindow: async (req) => { seen.push(req); return winResult({ cmd: String(req.cmd) }) },
    })
    await custom.mud_send!.execute({ cmd: 'pray' })
    await custom.mud_send!.execute({ cmd: 'dz' })
    expect(seen[2]!.criteria?.ok?.source).toBe('^你祈祷完毕。$')
    expect(seen[3]!.criteria).toBeUndefined()
  })

  it('§11 插值先于窗口注册: registerWindow 拿到的是插值后的命令 (凭据/外部值)', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      resolveCredentials: () => ({ name: 'vicrly', pass: 's3cret' }),
      resolveExternalValues: () => ({ captcha: '99' }),
      registerWindow: async (req) => { seen.push(req); return winResult({ cmd: String(req.cmd) }) },
    })
    await tools.mud_send!.execute({ cmd: '{name} {pass} fullme {captcha}' })
    expect(seen[0]!.cmd).toBe('vicrly s3cret fullme 99')
  })

  it('§11 外部占位符: {captcha} 在发送瞬间由人工值插值 (明文不落转录; 直发兜底路径)', async () => {
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

  it('§2.1 exec.signal: 回合取消信号随窗口注册传递 (send 类工具), 非 send 工具不受影响', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => {
        signals.push(req.signal)
        return winResult({ cmd: String(req.cmd) })
      },
    })
    const controller = new AbortController()
    await tools.mud_send!.execute({ cmd: 'look' }, { signal: controller.signal })
    await tools.mud_move!.execute({ direction: 'north' }, { signal: controller.signal })
    await tools.mud_look!.execute({}, { signal: controller.signal })
    await tools.mud_status!.execute({ what: 'hp' }, { signal: controller.signal })
    // 无 opts → 不传信号 (窗口按自己的超时/关窗结算)。
    await tools.mud_send!.execute({ cmd: 'look' })
    // 非 send 工具只读本地状态, 不注册窗口。
    expect(tools.mud_recall!.execute({ count: 1 }, { signal: controller.signal })).toMatchObject({ cmd: '' })

    expect(signals).toHaveLength(5)
    expect(signals.slice(0, 4).every(s => s === controller.signal)).toBe(true)
    expect(signals[4]).toBeUndefined()
  })

  it('P2-2: 命令序列单窗一次注册 (缺省 gaCount = 条数; W7.2 取代逐条串行结算)', async () => {
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      registerWindow: async (req) => {
        seen.push(req)
        return winResult({ cmd: '命令序列', text: 'look done' })
      },
    })
    const r = await tools.mud_send!.execute({ cmds: ['', 'look'] })
    expect(seen[0]!.cmd).toEqual(['', 'look'])
    expect(seen[0]!.gaCount).toBeUndefined()   // 缺省由窗口表取 cmds.length (每命令至少 1 GA)
    expect(r.ok).toBe(true)
    expect(r.note).toBe('look done')
    expect(r.cmd).toBe('命令序列')
  })

  it('fireAndForget: 有 registerWindow 也直发不注册窗口 (直接执行类动作)', async () => {
    const sent: string[] = []
    const seen: WindowRequest[] = []
    const tools = buildMudTools({
      send: c => sent.push(c),
      registerWindow: async (req) => { seen.push(req); return winResult({ cmd: String(req.cmd) }) },
    })
    const r = await tools.mud_send!.execute({ cmd: 'halt' }, { fireAndForget: true })
    expect(r).toEqual({ ok: true, note: 'halt', cmd: 'halt' })
    expect(sent).toEqual(['halt'])
    expect(seen).toHaveLength(0)
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

  it('OUT_SCHEMA 声明 settled/outcome/hitText (在途窗口结算语义)', () => {
    expect(declared).toContain('settled')
    expect(declared).toContain('outcome')
    expect(declared).toContain('hitText')
    expect(OUT_SCHEMA.additionalProperties).toBe(false)
  })

  it('每个工具在 (窗口结算 / 未连接拒发 / 参数非法) 三条路径上的结果字段都已声明', async () => {
    const tools = buildMudTools({
      isConnected: () => true,
      registerWindow: async req => winResult({ cmd: String(req.cmd), text: 'ok' }),
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
