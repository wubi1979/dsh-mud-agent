/**
 * dsh-mud-core 工具集测试 — 语义工具 (mud_move/mud_look/mud_status) + 兜底 mud_send。
 *
 * 工具 = 校验点: 非法参数在工具层拒绝 (不发命令), 合法参数转成游戏命令。
 */

import { describe, expect, it, vi } from 'vitest'
import { buildMudTools, MOVE_ALIASES, MOVE_DIRS, STATUS_CMDS, type MudTools } from '../src/agent/tools.ts'
import { CommandResponseController, type ReplyOptions } from '../src/network/response.ts'

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

describe('mud_send 兜底', () => {
  it('非空命令通过, 空白拒绝', async () => {
    const { tools, sent } = makeTools()
    expect(await tools.mud_send!.execute({ cmd: 'ask zhang about 拜师' }))
      .toEqual({ ok: true, note: 'ask zhang about 拜师', cmd: 'ask zhang about 拜师' })
    expect((await tools.mud_send!.execute({ cmd: '  ' })).ok).toBe(false)
    expect((await tools.mud_send!.execute({ cmd: '' })).ok).toBe(false)
    expect(sent).toEqual(['ask zhang about 拜师'])
  })
  it('命令序列允许空命令 (退 MXP 检测)', async () => {
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
    expect(r.note).toContain('缓冲暂无游戏输出')
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
  it('P1-4/R2-3: dz/dazuo/sleep 自动附带完成句 until (无显式 until 时)', async () => {
    const seen: { cmd: string; opts?: ReplyOptions }[] = []
    const tools = buildMudTools({
      sendAndAwait: async (cmd, opts) => {
        seen.push({ cmd: String(cmd), opts })
        return { ok: true, cmd: String(cmd), text: '完成', lines: [], settled: 'ga' }
      },
    })
    // dz: 自动 until (主形态 + 回退分支 + 90s 声明超时)。
    await tools.mud_send!.execute({ cmd: 'dz' })
    expect(seen[0]!.cmd).toBe('dz')
    expect(seen[0]!.opts?.until?.regex).toContain('你将运转于全身经脉间的内息收回丹田')
    expect(seen[0]!.opts?.until?.timeout).toBe(90_000)
    // R2-3: 抓包实发首词 `dazuo 10` 同样附带 until。
    await tools.mud_send!.execute({ cmd: 'dazuo 10' })
    expect(seen[1]!.cmd).toBe('dazuo 10')
    expect(seen[1]!.opts?.until?.regex).toContain('你将运转于全身经脉间的内息收回丹田')
    expect(seen[1]!.opts?.until?.timeout).toBe(90_000)
    // sleep: 自动 until。
    await tools.mud_send!.execute({ cmd: 'sleep' })
    expect(seen[2]!.opts?.until?.regex).toContain('你一觉醒来，精神抖擞地活动了几下手脚')
    expect(seen[2]!.opts?.until?.timeout).toBe(90_000)
    // 显式 until 不覆盖。
    await tools.mud_send!.execute({ cmd: 'dz', until: { regex: '^自定义$', timeout: 120 } })
    expect(seen[3]!.opts?.until?.regex).toBe('^自定义$')
    expect(seen[3]!.opts?.until?.timeout).toBe(120)
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
