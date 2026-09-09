/**
 * dsh-mud-core — T1 本地模拟 LLM 适配器测试。
 *
 * 验证 T1 (mud-t1 provider) 的判定输入 = 当前请求自身尾部 user 消息:
 *   - 游戏输出命中 → 渲染 output 文本 + tool-call 块 (与真实 LLM 同构);
 *   - tool-result 续步 → 安静收束 (finish stop, T1 独立完成整个 turn);
 *   - 未命中 / 无注册行 / 控制消息 ([系统] 前缀) → finish{error, NO_ANSWER}
 *     (由装配方 agent/request-error 瀑布切 T2, 本层不编排级联);
 *   - 凭据插值: {name}/{pass} 占位符经 resolveToolArgs 解析。
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TriggerLlmAdapter, T1_NO_ANSWER_CODE } from '../src/trigger-llm/index.ts'
import { TriggerMatchService } from '../src/trigger-llm/service.ts'
import { CONTROL_PREFIX } from '../src/trigger-llm/types.ts'
import type { TriggerLlmAdapterHooks } from '../src/trigger-llm/adapter.ts'
import type { TriggerAction } from '../src/trigger-llm/types.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

/** 将多行文本转成标准行 (abs 自 0 递增)。 */
function toLines(text: string): MudLine[] {
  return text.split('\n').map((t, i) => ({
    text: t, raw: t, style: [], abs: i, time: Date.now(), isPrompt: false,
  }))
}

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

function opts(messages: unknown, sessionId?: string): GenerateOptions {
  return {
    provider: 'mud-t1',
    model: 't1-local',
    ...(sessionId !== undefined ? { sessionId } : {}),
    messages,
  } as unknown as GenerateOptions
}

/** 匹配服务 (登录名提示 → mud_send {name})。 */
function makeService(): TriggerMatchService {
  return new TriggerMatchService([
    {
      id: 'login:name', eventType: 'p:login:name',
      match: { kind: 'regex', patterns: [/^您的英文名字（要注册新人物请输入new。）：$/] },
      action: { output: '登录提示: 输入英文名字', tool: { name: 'mud_send', args: { cmd: '{name}' } } },
    },
  ])
}

/** 测试脚手架: registry (text → lines) + hooks 包装, 返回 adapter 与登记函数。 */
function makeAdapter(service: TriggerMatchService, o: {
  logs?: string[]
} = {}): { adapter: TriggerLlmAdapter; register: (text: string) => void } {
  const registry = new Map<string, MudLine[]>()
  const hooks: TriggerLlmAdapterHooks = {
    resolveLines: (text) => registry.get(text) ?? null,
    matchLines: (lines): readonly TriggerAction[] =>
      service.match(lines).filter(h => h.action).map(h => ({ hit: h, action: h.action! })),
    onLog: (t) => o.logs?.push(t),
  }
  return {
    adapter: new TriggerLlmAdapter(hooks),
    register: (text: string) => registry.set(text.trim(), toLines(text)),
  }
}

const LOGIN_PROMPT = '您的英文名字（要注册新人物请输入new。）：'

describe('TriggerLlmAdapter — T1 本地模拟 (mud-t1)', () => {
  it('命中 → output 文本块 + tool-call 块 + finish{tool-calls} (与真实 LLM 同构)', async () => {
    const service = makeService()
    const { adapter, register } = makeAdapter(service)
    register(LOGIN_PROMPT)

    const chunks = await collect(adapter, opts([userMsg(LOGIN_PROMPT)]))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '登录提示: 输入英文名字' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '登录提示: 输入英文名字' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      expect.objectContaining({ type: 'tool-call-delta', name: 'mud_send', argumentsDelta: '{"cmd":"{name}"}' }),
      expect.objectContaining({ type: 'block-end', block: expect.objectContaining({ type: 'tool-call', name: 'mud_send' }) }),
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('未命中 → finish{error, MUD_T1_NO_ANSWER} (切 T2 的触发条件)', async () => {
    const service = makeService()
    const { adapter, register } = makeAdapter(service)
    register('完全无关的游戏输出')

    const chunks = await collect(adapter, opts([userMsg('完全无关的游戏输出')]))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('规则未命中'), code: T1_NO_ANSWER_CODE } },
    }])
  })

  it('无注册行 (历史回放/未登记文本) → NO_ANSWER', async () => {
    const service = makeService()
    const { adapter } = makeAdapter(service)

    const chunks = await collect(adapter, opts([userMsg(LOGIN_PROMPT)]))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('无注册行'), code: T1_NO_ANSWER_CODE } },
    }])
  })

  it('控制消息 ([系统] 前缀) → NO_ANSWER (即使同文本曾登记)', async () => {
    const service = makeService()
    const logs: string[] = []
    const { adapter, register } = makeAdapter(service, { logs })
    register(LOGIN_PROMPT)

    const chunks = await collect(adapter, opts([userMsg(`${CONTROL_PREFIX}已 30 秒无游戏事件`)]))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('控制消息'), code: T1_NO_ANSWER_CODE } },
    }])
  })

  it('tool-result 续步 → 安静收束 finish{stop} (T1-owned 回合无模型收尾)', async () => {
    const service = makeService()
    const { adapter } = makeAdapter(service)
    const toolTail = createToolResultMessage({
      callId: 'mud-trigger-login-name-1' as never,
      content: [{ type: 'text', text: '已发送' }],
      isError: false,
    })

    const chunks = await collect(adapter, opts([userMsg(LOGIN_PROMPT), toolTail]))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('空消息 / 无尾部 user 文本 → NO_ANSWER', async () => {
    const service = makeService()
    const { adapter } = makeAdapter(service)
    const chunks = await collect(adapter, opts([]))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('无尾部文本'), code: T1_NO_ANSWER_CODE } },
    }])
  })

  it('signal 已中止 → 不产出任何 chunk', async () => {
    const service = makeService()
    const { adapter, register } = makeAdapter(service)
    register(LOGIN_PROMPT)
    const controller = new AbortController()
    controller.abort()

    const options = opts([userMsg(LOGIN_PROMPT)], 's1') as GenerateOptions & { signal?: AbortSignal }
    options.signal = controller.signal
    const chunks = await collect(adapter, options)
    expect(chunks).toHaveLength(0)
  })

  it('tool args 占位符原样下发 (凭据插值责任在工具执行层, 渲染层不落明文)', async () => {
    const service = new TriggerMatchService([
      {
        id: 'login:name', eventType: 'p:login:name',
        match: { kind: 'regex', patterns: [/^您的英文名字（要注册新人物请输入new。）：$/] },
        action: { output: '登录', tool: { name: 'mud_send', args: { cmd: '{name}', note: '{pass}' } } },
      },
    ])
    const { adapter, register } = makeAdapter(service)
    register(LOGIN_PROMPT)

    const chunks = await collect(adapter, opts([userMsg(LOGIN_PROMPT)], 's1'))
    const toolEnd = chunks.filter(c => c.type === 'block-end').at(-1) as { block: { arguments: string } }
    // 转录 (assistant tool-call) 只见占位符 — 无任何明文凭据。
    expect(toolEnd.block.arguments).toBe('{"cmd":"{name}","note":"{pass}"}')
  })

  it('同一文本重复请求 (重试) → 幂等渲染 (tool-call id 时间戳除外; 依赖路由状态防重)', async () => {
    const service = makeService()
    const { adapter, register } = makeAdapter(service)
    register(LOGIN_PROMPT)

    const first = await collect(adapter, opts([userMsg(LOGIN_PROMPT)]))
    const second = await collect(adapter, opts([userMsg(LOGIN_PROMPT)]))
    // tool-call id 含时间戳 (跨回合唯一), 其余 chunk 必须完全一致。
    const strip = (chunks: StreamChunk[]) => JSON.stringify(chunks).replaceAll(/mud-trigger-[^"]+/g, 'ID')
    expect(strip(second)).toBe(strip(first))
  })
})
