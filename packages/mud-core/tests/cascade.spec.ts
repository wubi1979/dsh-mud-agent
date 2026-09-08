/**
 * dsh-mud-core 级联 provider (mud-cascade) 测试 — v6.3 阶段行走器 (瀑布数组)。
 *
 * 逐级行走: trigger 级 (T1 确定性渲染, 内容级去重) / 显式 model 级 (硬失败交棒:
 * prepareCall 拒绝或首块 finish{error|aborted} → 下一级; 其余 commit) /
 * 尾部默认级 (DSH 默认配置 agentDefaultModel)。每调用重读 stages(); enabled:false 跳过。
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TriggerLlmAdapter, TriggerMatchService } from '../src/trigger-llm/index.ts'
import type { TriggerLlmAdapterHooks } from '../src/trigger-llm/adapter.ts'
import type { CascadeStage, TriggerAction } from '../src/trigger-llm/types.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

/** 构造一个 user 文本消息 (标准游戏输出导入形态)。 */
function userMsg(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 将适配器输出流收集为 chunk 列表。 */
async function collect(adapter: TriggerLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks
}

function opts(messages: unknown): GenerateOptions {
  return {
    provider: 'mud-cascade',
    model: 'cascade-v1',
    messages,
  } as unknown as GenerateOptions
}

/** 将多行文本转成标准行 (abs 自 0 递增)。 */
function toLines(text: string): MudLine[] {
  return text.split('\n').map((t, i) => ({
    text: t, raw: t, style: [], abs: i, time: Date.now(), isPrompt: false,
  }))
}

/** 假 LLM 句柄: provider → 拒绝或流。记录 prepareCall 与 stream 收到的 options。 */
function makeLlm(procs: Record<string, { reject?: Error; stream: () => AsyncIterable<StreamChunk> }>) {
  const calls: { provider: string; model: string }[] = []
  const streamed: GenerateOptions[] = []
  const handle = {
    prepareCall: (config: { provider: string; model: string }) => {
      calls.push({ provider: config.provider, model: config.model })
      const p = procs[config.provider]
      if (p?.reject) return Promise.reject(p.reject)
      return Promise.resolve({
        stream: (o: GenerateOptions) => {
          streamed.push(o)
          return p?.stream() ?? (async function* () {})()
        },
      })
    },
  } as unknown as LlmRuntime
  return { calls, streamed, handle }
}

/** 已提交空流 (stop finish)。 */
function stopStream(): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/** 硬失败流 (首块 error / aborted finish)。 */
function failStream(kind: 'error' | 'aborted'): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'finish', reason: { kind } }
  })()
}

function defaultMatch(service: TriggerMatchService, lines: MudLine[]): readonly TriggerAction[] {
  return service.match(lines).filter(h => h.action).map(h => ({ hit: h, action: h.action! }))
}

/** 构造阶段行走器 adapter 测试脚手架 (默认瀑布: [t1 trigger])。 */
function makeAdapter(
  service: TriggerMatchService,
  o: {
    stages?: readonly CascadeStage[]
    llm?: ReturnType<typeof makeLlm>
    defaultSelection?: () => { provider: string; model: string } | null
    onRender?: (e: { hit: { id: string } }) => void
    logs?: string[]
  } = {},
): { adapter: TriggerLlmAdapter; setLines: (text: string) => void } {
  let recent: MudLine[] = []
  const llm = o.llm ?? makeLlm({})
  const hooks: TriggerLlmAdapterHooks = {
    matchLines: (lines) => defaultMatch(service, lines),
    getRecentLines: () => recent,
    stages: () => o.stages ?? [{ id: 't1', kind: 'trigger', lane: 'event' }],
    llm: llm.handle,
    defaultSelection: o.defaultSelection ?? (() => null),
    onRender: o.onRender as unknown as TriggerLlmAdapterHooks['onRender'],
    ...(o.logs ? { onLog: (t: string) => o.logs!.push(t) } : {}),
  }
  const adapter = new TriggerLlmAdapter(hooks)
  return {
    adapter,
    setLines: (text: string) => { recent = toLines(text) },
  }
}

describe('T1 trigger 级 (确定性渲染)', () => {
  it('命中(输出+工具) → 文本块 + tool-call 块, finish tool-calls', async () => {
    const service = new TriggerMatchService()
    service.register({
      id: 'combat:start', eventType: 'p:combat:start',
      regex: [/杀气逼人/],
      action: {
        output: '战斗开始',
        tool: { name: 'world_patch', args: { patch: { in_combat: true } } },
      },
    })
    let rendered: { hitId: string } | null = null
    const { adapter, setLines } = makeAdapter(service, {
      onRender: (e) => { rendered = { hitId: e.hit.id } },
    })
    setLines('杀气逼人向你扑来！')

    const chunks = await collect(adapter, opts([userMsg('杀气逼人向你扑来！')]))

    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['战斗开始'])
    const toolBlocks = chunks.filter(c => c.type === 'block-end' && (c as { block: { type?: string } }).block?.type === 'tool-call')
    expect(toolBlocks).toHaveLength(1)
    const last = chunks[chunks.length - 1]
    expect(last?.type).toBe('finish')
    expect((last as { reason: { kind: string } }).reason.kind).toBe('tool-calls')
    expect(rendered?.hitId).toBe('combat:start')
  })

  it('命中(纯输出) → 仅文本块, finish stop', async () => {
    const service = new TriggerMatchService()
    service.register({
      id: 'save:prompt', eventType: 'p:save:prompt',
      regex: [/你当前的存盘/],
      action: { output: '正在保存...' },
    })
    const { adapter, setLines } = makeAdapter(service)
    setLines('你当前的存盘时间为...')

    const chunks = await collect(adapter, opts([userMsg('你当前的存盘时间为...')]))
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['正在保存...'])
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('多规则命中 → 顺行序渲染全部动作 (工具 id 唯一)', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'a1', eventType: 'p:a', regex: [/甲/], action: { output: '动作A' } })
    service.register({ id: 'b2', eventType: 'p:b', regex: [/乙/], action: { output: '动作B' } })
    const { adapter, setLines } = makeAdapter(service)
    setLines('甲行\n乙行')

    const chunks = await collect(adapter, opts([userMsg('甲行\n乙行')]))
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['动作A', '动作B'])
  })
})

describe('尾部默认级 (DSH 默认配置)', () => {
  it('trigger 未命中 → 尾部默认级被调 (prepareCall + 重建尾部文本)', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'n', eventType: 'p:n', regex: [/绝不匹配此文本/], action: { output: 'x' } })
    const llm = makeLlm({
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('你不是武馆弟子')

    const chunks = await collect(adapter, opts([userMsg('你不是武馆弟子')]))

    expect(llm.calls).toEqual([{ provider: 'p-default', model: 'm-default' }])
    // 重建: 尾部文本承载 user 消息被替换为最近行拼接文本。
    const streamedOptions = llm.streamed[0] as GenerateOptions
    const tail = (streamedOptions.messages as { role: string; content: { type: string; text: string }[] }[])
      .filter(m => m.role === 'user').at(-1)
    expect(tail?.content[0]?.text).toBe('你不是武馆弟子')
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('trigger 未命中且无默认选择 → 空 finish(stop), 不调 prepareCall', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'n', eventType: 'p:n', regex: [/绝不匹配此文本/], action: { output: 'x' } })
    const llm = makeLlm({})
    const { adapter, setLines } = makeAdapter(service, { llm })

    setLines('你当前的存盘时间为...')
    const chunks = await collect(adapter, opts([userMsg('你当前的存盘时间为...')]))
    expect(llm.calls).toEqual([])
    expect(chunks.every(c => c.type === 'finish')).toBe(true)
    expect((chunks[0] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })
})

describe('显式 model 级 (硬失败交棒 / commit)', () => {
  it('prepareCall 拒绝 (未注册/NO_ADAPTER) → 交棒尾部默认级', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'unmounted': { reject: new Error('NO_ADAPTER'), stream: () => stopStream() },
      'p-default': { stream: () => stopStream() },
    })
    const logs: string[] = []
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'unmounted', model: 'x' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
      logs,
    })
    setLines('普通文本')

    const chunks = await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([
      { provider: 'unmounted', model: 'x' },
      { provider: 'p-default', model: 'm-default' },
    ])
    expect(logs.some(l => l.includes('m1') && l.includes('交棒'))).toBe(true)
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('首块 finish{error} → 交棒尾部默认级', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'bad': { stream: () => failStream('error') },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'bad', model: 'x' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([
      { provider: 'bad', model: 'x' },
      { provider: 'p-default', model: 'm-default' },
    ])
  })

  it('首块 finish{aborted} → 交棒', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'bad': { stream: () => failStream('aborted') },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'bad', model: 'x' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([
      { provider: 'bad', model: 'x' },
      { provider: 'p-default', model: 'm-default' },
    ])
  })

  it('首块 finish{stop} → commit: 不交棒, 尾部默认级不被调', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'cheap': { stream: () => stopStream() },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'cheap', model: 'c1' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    const chunks = await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([{ provider: 'cheap', model: 'c1' }])
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('首块 text-delta → commit, 整流后续块到 finish', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'cheap': {
        stream: () => (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '便宜模型响应' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '便宜模型响应' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'cheap', model: 'c1' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    const chunks = await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([{ provider: 'cheap', model: 'c1' }])
    const texts = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text)
    expect(texts).toEqual(['便宜模型响应'])
  })

  it('首个 model 级空流 (无 finish) → 视为空 stop 提交, 不交棒', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'empty': { stream: () => (async function* () {} )() },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'empty', model: 'e1' }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    const chunks = await collect(adapter, opts([userMsg('普通文本')]))

    expect(llm.calls).toEqual([{ provider: 'empty', model: 'e1' }])
    expect(chunks.every(c => c.type === 'finish')).toBe(true)
    expect((chunks[0] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })
})

describe('enabled 与去重', () => {
  it('trigger enabled:false → 跳过 T1, 直接到尾部默认级', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'x', eventType: 'p:x', regex: [/命中/], action: { output: '已处理' } })
    let matched = false
    const llm = makeLlm({ 'p-default': { stream: () => stopStream() } })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 't1', kind: 'trigger', lane: 'event', enabled: false }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    // override matchLines 记录是否被调用
    ;(adapter as unknown as { hooks: TriggerLlmAdapterHooks }).hooks.matchLines = () => {
      matched = true
      return []
    }
    setLines('命中要害')

    await collect(adapter, opts([userMsg('命中要害')]))
    expect(matched).toBe(false)
    expect(llm.calls).toEqual([{ provider: 'p-default', model: 'm-default' }])
  })

  it('model enabled:false → 跳过, 交棒尾部默认级', async () => {
    const service = new TriggerMatchService()
    const llm = makeLlm({
      'cheap': { stream: () => stopStream() },
      'p-default': { stream: () => stopStream() },
    })
    const { adapter, setLines } = makeAdapter(service, {
      stages: [{ id: 'm1', kind: 'model', provider: 'cheap', model: 'c1', enabled: false }],
      llm,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    })
    setLines('普通文本')

    await collect(adapter, opts([userMsg('普通文本')]))
    expect(llm.calls).toEqual([{ provider: 'p-default', model: 'm-default' }])
  })

  it('同一尾部文本在循环内重复提取 → 第二次空 finish(stop), 不重复匹配', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'x', eventType: 'p:x', regex: [/命中/], action: { output: '已处理' } })
    let calls = 0
    let recent: MudLine[] = []
    const hooks: TriggerLlmAdapterHooks = {
      matchLines: (lines) => {
        calls += 1
        return defaultMatch(service, lines)
      },
      getRecentLines: () => recent,
      stages: () => [{ id: 't1', kind: 'trigger', lane: 'event' }],
      llm: makeLlm({}).handle,
      defaultSelection: () => null,
    }
    const adapter = new TriggerLlmAdapter(hooks)
    recent = toLines('剑法命中要害')

    const first = await collect(adapter, opts([userMsg('剑法命中要害')]))
    expect(calls).toBe(1)
    // 同一文本另一轮 (模拟工具循环复用尾部): 去重层拦截, 不再匹配, 空 stop。
    const second = await collect(adapter, opts([userMsg('剑法命中要害')]))
    expect(calls).toBe(1)
    expect(second.every(c => c.type === 'finish')).toBe(true)
    expect((second[0] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })

  it('getRecentLines 为空 → trigger 不匹配, 交尾部默认级 (可应答)', async () => {
    const service = new TriggerMatchService()
    service.register({ id: 'x', eventType: 'p:x', regex: [/命中/], action: { output: '已处理' } })
    let matched = false
    let recent: MudLine[] = []
    const hooks: TriggerLlmAdapterHooks = {
      matchLines: (lines) => { matched = true; return defaultMatch(service, lines) },
      getRecentLines: () => recent,
      stages: () => [{ id: 't1', kind: 'trigger', lane: 'event' }],
      llm: makeLlm({ 'p-default': { stream: () => stopStream() } }).handle,
      defaultSelection: () => ({ provider: 'p-default', model: 'm-default' }),
    }
    const adapter = new TriggerLlmAdapter(hooks)

    const chunks = await collect(adapter, opts([userMsg('闲聊问题')]))
    expect(matched).toBe(false)
    expect((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind).toBe('stop')
  })
})

describe('T1 凭据插值 (resolveToolArgs)', () => {
  it('{name}/{pass} 占位符按会话凭据解析后渲染到 tool-call 参数', async () => {
    const service = new TriggerMatchService()
    service.register({
      id: 'login:name', eventType: 'p:login:name',
      regex: [/^您的英文名字（要注册新人物请输入new。）：$/],
      action: { output: '登录: 发送名字', tool: { name: 'mud_send', args: { cmd: '{name}' } } },
    })
    const credsBySession: Record<string, { name: string; pass: string }> = {
      's-user': { name: 'victor', pass: 's3cret' },
    }
    const hooks: TriggerLlmAdapterHooks = {
      matchLines: (lines) => defaultMatch(service, lines),
      getRecentLines: () => toLines('您的英文名字（要注册新人物请输入new。）：'),
      stages: () => [{ id: 't1', kind: 'trigger', lane: 'event' }],
      llm: makeLlm({}).handle,
      defaultSelection: () => null,
      resolveToolArgs: (args, sessionId) => {
        const creds = credsBySession[sessionId ?? '']
        return creds ? {
          ...args,
          cmd: typeof args.cmd === 'string'
            ? args.cmd.replace('{name}', creds.name).replace('{pass}', creds.pass)
            : args.cmd,
        } : args
      },
    }
    const adapter = new TriggerLlmAdapter(hooks)
    const options = {
      provider: 'mud-cascade',
      model: 'cascade-v1',
      messages: [userMsg('您的英文名字（要注册新人物请输入new。）：')],
      sessionId: 's-user',
    } as unknown as GenerateOptions

    const chunks = await collect(adapter, options)
    const toolBlock = chunks
      .filter(c => c.type === 'block-end' && (c as { block: { type?: string } }).block?.type === 'tool-call')
      .map(c => (c as { block: { arguments: string } }).block.arguments)
    expect(toolBlock).toHaveLength(1)
    expect(JSON.parse(toolBlock[0] as string)).toEqual({ cmd: 'victor' })
    expect(toolBlock[0]).not.toContain('{name}')
  })

  it('无 resolveToolArgs 钩子 → args 原样下发 (占位符不解析)', async () => {
    const service = new TriggerMatchService()
    service.register({
      id: 'login:pass', eventType: 'p:login:pass',
      regex: [/^请输入密码：$/],
      action: { output: '登录: 发送密码', tool: { name: 'mud_send', args: { cmd: '{pass}' } } },
    })
    const { adapter, setLines } = makeAdapter(service)
    setLines('请输入密码：')

    const chunks = await collect(adapter, opts([userMsg('请输入密码：')]))
    const toolBlock = chunks
      .filter(c => c.type === 'block-end' && (c as { block: { type?: string } }).block?.type === 'tool-call')
      .map(c => (c as { block: { arguments: string } }).block.arguments)
    expect(toolBlock).toHaveLength(1)
    expect(JSON.parse(toolBlock[0] as string)).toEqual({ cmd: '{pass}' })
  })
})

describe('装配形态 (TriggerAction)', () => {
  it('TriggerMatchService 规则携带 action → match 命中经过滤产出 TriggerAction', async () => {
    const service = new TriggerMatchService()
    service.register({
      id: 'combat:start', eventType: 'p:combat:start',
      regex: [/向你扑来/],
      action: { output: '战斗开始' },
    })
    const lines = toLines('怪物向你扑来！')
    const actions: TriggerAction[] = service.match(lines).filter(h => h.action).map(h => ({ hit: h, action: h.action! }))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.action.output).toBe('战斗开始')
  })
})