/**
 * dsh-mud-core — preset 行测试 (`doc/ARCHITECTURE.md` §9)。
 *
 * 覆盖 `src/preset-agent.ts` 的契约:
 *   - 组装期注册: 每个工具声明一条注册项 (与 `mudToolSchemaTable()` 同名), 四段提示全部注册;
 *   - 执行期解析: 工具执行体按调用方 agent 的 id 取该会话工具集并委托 (per-session 状态),
 *     未绑定会话 → 可读拒绝 (不发命令), 委托成功后记留痕;
 *   - 提示文案按 agent 求值 (persona/skills/commands 全局, tier 说明按会话), 无 agent
 *     上下文时退化为空/通用文本而不是抛错;
 *   - 组合文件 (`presets/mud-player/agent.cordis.yml`) 存在且指向 `dist/preset-agent.js`
 *     的相对路径 (部署根就是靠这个文件被发现)。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MudDeliveryChannel } from '../src/agent/agent-bridge.ts'
import { mudToolSchemaTable, type MudTools } from '../src/agents/tools.ts'
import type { MudAgentKit } from '../src/service.ts'

/** 载入 preset 行模块 (顶层不 import 任何 cordis 服务, 可安全直接 import)。 */
import { apply as applyPresetAgent, name as presetAgentName } from '../src/agents/preset.ts'

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: {
    agent?: { id: string }
    callId?: string
    deferContext?: (message: unknown) => void
    concludeTurn?: () => void
  }) => Promise<unknown>
}

interface RegisteredSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
}

/** 假 preset 作用域: 捕获工具注册与提示注册。 */
function makeScope(kit: MudAgentKit | undefined): {
  ctx: Context
  tools: RegisteredTool[]
  sections: RegisteredSection[]
} {
  const tools: RegisteredTool[] = []
  const sections: RegisteredSection[] = []
  const scope = {
    tools: { register: (definition: RegisteredTool) => { tools.push(definition); return () => {} } },
    systemPrompt: { section: (section: RegisteredSection) => { sections.push(section); return () => {} } },
  }
  const ctx = {
    get: (serviceName: string) => (serviceName === 'mud' && kit !== undefined ? { agentKit: () => kit } : undefined),
    inject: (_services: string[], callback: (s: unknown) => unknown) => callback(scope),
  } as unknown as Context
  return { ctx, tools, sections }
}

/** 一个记录调用的假会话工具集。 */
function makeKit(options: {
  known: boolean
  /** 假工具结果是否失败（验证"失败不收束"，判据 C）。 */
  toolFails?: boolean
  /** 假投递通道（缺省 = 不接线，退回旧行为）。 */
  channel?: MudDeliveryChannel
}): { kit: MudAgentKit; calls: string[]; notes: string[] } {
  const calls: string[] = []
  const notes: string[] = []
  const tools = Object.fromEntries(mudToolSchemaTable().map(schema => [schema.name, {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    output: schema.output,
    execute: (args: Record<string, unknown>) => {
      calls.push(`${schema.name}:${JSON.stringify(args)}`)
      return options.toolFails === true
        ? { ok: false, note: `失败 ${schema.name}`, cmd: String(args.cmd ?? '') }
        : { ok: true, note: `已执行 ${schema.name}`, cmd: String(args.cmd ?? '') }
    },
  }])) as MudTools
  const kit: MudAgentKit = {
    prompt: { persona: 'MUD 人设', skillsText: () => '技能目录', commands: '命令参考' },
    tools: (sessionId) => (options.known && sessionId === 's1' ? tools : undefined),
    tierNote: (sessionId) => (sessionId === 's1' ? '当前权限档位: 读写。' : '当前权限档位: 未知。'),
    noteToolCall: (sessionId, name) => { notes.push(`${sessionId}:${name}`) },
    channel: (sessionId) => (options.known && sessionId === 's1' ? options.channel : undefined),
  }
  return { kit, calls, notes }
}

describe('preset 行 (mud-player 的能力面)', () => {
  it('插件名固定 (Loader 行标识)', () => {
    expect(presetAgentName).toBe('mud-preset-agent')
  })

  it('组装期注册每个工具声明 + 三段提示 (skills/commands/tier)', () => {
    const { kit } = makeKit({ known: true })
    const { ctx, tools, sections } = makeScope(kit)

    applyPresetAgent(ctx)

    expect(tools.map(t => t.name).sort()).toEqual(mudToolSchemaTable().map(t => t.name).sort())
    expect(sections.map(s => s.name).sort()).toEqual(['mud-commands', 'mud-skills', 'mud-tier'])
    // **人设不由 preset 行提供**: 会话人设占官方槽 `deployment:persona-prefix`, 同名替换
    // 只能在 agent 作用域做 (preset 作用域同名会与 standard 的 persona 行冲突) —— 见
    // `agent-bridge.ts#attachMudPersona`。
    expect(sections.some(s => s.name === 'mud-persona')).toBe(false)
    // order 与宿主侧装配一致 (skills -50 < tier -45 < commands -40)。
    const order = Object.fromEntries(sections.map(s => [s.name, s.order]))
    expect(order['mud-skills']).toBeLessThan(order['mud-tier'] as number)
    expect(order['mud-tier']).toBeLessThan(order['mud-commands'] as number)
  })

  it('工具执行按调用方 agent 解析到该会话工具集 (共享组装 + per-session 状态)', async () => {
    const { kit, calls, notes } = makeKit({ known: true })
    const { ctx, tools } = makeScope(kit)
    applyPresetAgent(ctx)
    const send = tools.find(t => t.name === 'mud_send')

    const result = await send!.execute({ cmd: 'look' }, { agent: { id: 's1' } })

    expect(calls).toEqual(['mud_send:{"cmd":"look"}'])
    expect(notes).toEqual(['s1:mud_send'])
    expect(result).toMatchObject({ ok: true, note: '已执行 mud_send' })
  })

  /**
   * **preset 路径的投递通道接线**（§19.6.2；实测踩过：漏接它 ⇒ defer 只在宿主路径生效，
   * preset 部署下投递仍走 `followup`，login 账目停在 3 回合 / 6 次请求）。
   */
  it('工具执行接投递通道: 进出工具调用 → defer 槽 → 成功时收束 (preset 路径同样接线)', async () => {
    const events: string[] = []
    const deferred = [{ content: [{ type: 'text', text: '下一步投递' }] }]
    const channel: MudDeliveryChannel = {
      beginToolCall: () => { events.push('begin') },
      endToolCall: () => { events.push('end') },
      takeDeferredDeliveries: () => { events.push('take'); return deferred as never },
      shouldConcludeTurn: (callId) => { events.push(`conclude?${callId}`); return true },
    }
    const { kit } = makeKit({ known: true, channel })
    const { ctx, tools } = makeScope(kit)
    applyPresetAgent(ctx)
    const send = tools.find(t => t.name === 'mud_send')

    const contexts: unknown[] = []
    let concluded = 0
    const result = await send!.execute({ cmd: 'look' }, {
      agent: { id: 's1' },
      callId: 'mud-d1-0',
      deferContext: (message: unknown) => { contexts.push(message) },
      concludeTurn: () => { concluded += 1 },
    })

    expect(result).toMatchObject({ ok: true })
    expect(events).toEqual(['begin', 'end', 'take', 'conclude?mud-d1-0'])
    expect(contexts).toEqual(deferred)   // 投递随本结果进下一步
    expect(concluded).toBe(1)            // 判据 B 成立 ⇒ 收束回合
  })

  it('工具失败时只 defer、不收束 (判据 C)', async () => {
    const events: string[] = []
    const channel: MudDeliveryChannel = {
      beginToolCall: () => { events.push('begin') },
      endToolCall: () => { events.push('end') },
      takeDeferredDeliveries: () => [],
      shouldConcludeTurn: () => { events.push('conclude?'); return true },
    }
    const { kit } = makeKit({ known: true, toolFails: true, channel })
    const { ctx, tools } = makeScope(kit)
    applyPresetAgent(ctx)
    const send = tools.find(t => t.name === 'mud_send')

    let concluded = 0
    const result = await send!.execute({ cmd: 'look' }, {
      agent: { id: 's1' },
      callId: 'mud-d1-0',
      deferContext: () => {},
      concludeTurn: () => { concluded += 1 },
    })

    expect(result).toMatchObject({ ok: false })
    expect(concluded).toBe(0)
    expect(events).not.toContain('conclude?')
  })

  it('未绑定会话 / 无 agent 上下文 → 可读拒绝, 不执行任何会话工具', async () => {
    const { kit, calls, notes } = makeKit({ known: false })
    const { ctx, tools } = makeScope(kit)
    applyPresetAgent(ctx)
    const recall = tools.find(t => t.name === 'mud_recall')

    const other = await recall!.execute({ count: 5 }, { agent: { id: 's2' } })
    const noAgent = await recall!.execute({ count: 5 }, {})

    expect(other).toMatchObject({ ok: false, cmd: '' })
    expect(String((other as { note: string }).note)).toContain('未绑定 MUD 运行时')
    expect(noAgent).toMatchObject({ ok: false, cmd: '' })
    expect(calls).toEqual([])
    expect(notes).toEqual([])
  })

  it('宿主服务缺失 (mud 未装配) 时注册照常, 执行给可读拒绝', async () => {
    const { ctx, tools, sections } = makeScope(undefined)
    applyPresetAgent(ctx)

    expect(tools.length).toBeGreaterThan(0)
    expect(sections).toHaveLength(3)
    const state = tools.find(t => t.name === 'mud_state')
    expect(await state!.execute({}, { agent: { id: 's1' } })).toMatchObject({ ok: false, cmd: '' })
  })

  it('提示文本按 agent 求值; 无 agent 上下文时不抛错', () => {
    const { kit } = makeKit({ known: true })
    const { ctx, sections } = makeScope(kit)
    applyPresetAgent(ctx)
    const textOf = (sectionName: string, context: unknown): string => {
      const section = sections.find(s => s.name === sectionName)
      if (section === undefined) throw new Error(`未注册区段 ${sectionName}`)
      return typeof section.text === 'function' ? section.text(context) : section.text
    }

    expect(textOf('mud-skills', {})).toBe('技能目录')
    expect(textOf('mud-commands', {})).toBe('命令参考')
    // tier 说明按组装上下文的 agent 求值 (官方 AssembleContext 由 agent-loop 带上 agent)。
    expect(textOf('mud-tier', { agent: { id: 's1' } })).toContain('读写')
    expect(textOf('mud-tier', { agent: { id: 's2' } })).toContain('未知')
    expect(textOf('mud-tier', {})).toContain('未知')
  })
})

describe('preset 组合文件 (部署根的被发现对象)', () => {
  const dir = join(import.meta.dirname, '..', 'presets', 'mud-player')

  /** 顶层行 id (preset 是"整份组装", 行 id 必须唯一)。 */
  function rowIds(raw: string): string[] {
    return raw.split('\n')
      .filter(line => line.startsWith('- id: '))
      .map(line => line.slice('- id: '.length).trim())
  }

  it('是**完整组装** (standard 的行都在), 且恰好追加一行 mud-agent', () => {
    const raw = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    const ids = rowIds(raw)
    // standard 的关键行必须都在 —— 只写自己那一行会让会话丢掉全部标准工具 (工具不可见)。
    for (const required of ['persona', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-todo', 'present']) {
      expect(ids, `缺 standard 行 ${required}`).toContain(required)
    }
    expect(ids.filter(id => id === 'mud-agent')).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
    // 顶层行数量下界 (standard 的顶层行约 19 行; 断言下界而非等值, 因为升级 harness
    // 重新对齐副本时这个数字会变, 而"被截断成只剩自己那一行"才是要拦住的回归)。
    expect(ids.length).toBeGreaterThanOrEqual(19)
  })

  it('我们的行用相对路径指向 dist/preset-agent.js (行内不写死盘符)', () => {
    const raw = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    expect(raw).toContain("name: '../../dist/preset-agent.js'")
    // 只查**代码行**: 注释里提到 harness 检出路径是允许的 (生成说明)。
    const codeLines = raw.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(codeLines.filter(line => /[A-Za-z]:[\\/]/.test(line))).toEqual([])
  })

  it('preset.yml 提供展示元数据 (选择器显示名/描述)', () => {
    const raw = readFileSync(join(dir, 'preset.yml'), 'utf8')
    expect(raw).toContain('name:')
    expect(raw).toContain('description:')
  })

  it('preset.yml 的标量里不出现裸 ": " (YAML 会把它当嵌套映射, 展示名整份丢失)', () => {
    // 实测踩过: `description: 玩家: 规则…` 让 js-yaml 解析失败 —— 官方 readPresetMetadata
    // 吞掉异常并退化成"无元数据", 于是选择器只显示 id。这里做同类的结构性守卫。
    const offenders = readFileSync(join(dir, 'preset.yml'), 'utf8').split('\n')
      .filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
      .filter((line) => {
        const match = /^([A-Za-z][\w-]*):\s+(.*)$/.exec(line)
        if (match === null) return false
        const value = match[2] as string
        return value.includes(': ')
          && !value.startsWith('"') && !value.startsWith("'")
          && !value.startsWith('>') && !value.startsWith('|')
      })
    expect(offenders).toEqual([])
  })
})

describe('preset 副本与 harness standard 的一致性 (本机存在检出时启用)', () => {
  // 副本是会漂移的快照 (官方 README 明列的已知限制), 所以这条守卫只在 harness 检出存在时
  // 运行: 逐行比对 standard。它拦住的正是实测踩过的坑 —— 手抄时漏掉某行的必填 config
  // (plan-mode 的 section), 结果是 preset 挂载失败、插件回落宿主侧装配。
  const HARNESS_STANDARD = 'D:/code/deepseek-harness/packages/preset/agent-presets/presets/standard/agent.cordis.yml'
  const OURS = join(import.meta.dirname, '..', 'presets', 'mud-player', 'agent.cordis.yml')

  /** 按 `- id: X` 切块并归一化 (去掉注释/空行与缩进差异)。 */
  function rowBlocks(raw: string): Map<string, string> {
    const out = new Map<string, string>()
    let current: string | null = null
    let lines: string[] = []
    const flush = (): void => { if (current !== null) out.set(current, lines.join('\n')) }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const match = /^-\s+id:\s*(\S+)\s*$/.exec(trimmed)
      if (match !== null) {
        flush()
        current = match[1] as string
        lines = [trimmed]
        continue
      }
      if (current !== null) lines.push(trimmed)
    }
    flush()
    return out
  }

  it.skipIf(!existsSync(HARNESS_STANDARD))('与 standard 逐行一致, 只多一行 mud-agent', () => {
    const standard = rowBlocks(readFileSync(HARNESS_STANDARD, 'utf8'))
    const ours = rowBlocks(readFileSync(OURS, 'utf8'))

    const extra = [...ours.keys()].filter(id => !standard.has(id))
    expect(extra).toEqual(['mud-agent'])

    const missing = [...standard.keys()].filter(id => !ours.has(id))
    expect(missing, '副本缺少 standard 的行').toEqual([])

    const mismatched = [...standard.keys()].filter(id => ours.get(id) !== standard.get(id))
    expect(mismatched, '与 standard 不一致的行 (重新对齐副本, 或补齐被漏抄的 config)').toEqual([])
  })
})

describe('patch 文件 (部署契约)', () => {
  const patch = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

  it('preset 根与 preset id 都声明在本包 patch 里 (profile patch 保持空)', () => {
    // 两者必须同处一层: agent-presets 的 roots 决定 mud-player 能否被发现,
    // agentPreset 决定插件会不会去 select 它。分开写就会出现"配了 id 但找不到 preset"。
    expect(patch).toContain('- id: agent-presets')
    expect(patch).toContain('packages/mud-core/presets')
    expect(patch).toContain('default: standard')
    expect(patch).toContain('agentPreset: mud-player')
  })

  it('mud-core 只作为 insert 行出现 (它由本层插入, 不能被同行层的 patch 当目标)', () => {
    const patchTargets = patch.split('\n').filter(line => /^-\s*id:\s*mud-core\s*$/.test(line))
    expect(patchTargets).toEqual([])
    expect(patch.match(/- id: mud-core/g) ?? []).toHaveLength(1)
  })
})
