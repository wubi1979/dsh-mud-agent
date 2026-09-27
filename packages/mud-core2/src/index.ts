/**
 * mud-core2 — 引擎装配层（§3.3：唯一大范围碰 ctx 的文件；P2 修订 v2，doc/PLAN.md）。
 *
 * 职责：把纯 TS 层（link/awareness/wake）与宿主承载接线：
 *   - 存在层单例：Mud + World + CorpusWriter + LoginGate（单 MUD 连接，
 *     会话级共享，§11）；
 *   - 意识层永续：mud.onLine → corpus → awareness（swallow 透传，§6.1）；
 *   - 唤醒：Wake 仅挂根 agent 实例（唤醒是 T2 面，§10.1）；危险 → steer、
 *     静默 → followup（宿主动词，§7.3）；idle = 行流无持有者（写死，§7.2 V7）；
 *   - 预算：agent/created 监听器（插件全局层）对子级登记预算；到期 interrupt
 *     注入宿主 subagents.interrupt 通路，参数源 = 子级自己的
 *     session.header.parentSession（P2 D3）；
 *   - 工具与 persona：由 preset 行在 preset 作用域注册（src/preset.ts，P2 D6/D8），
 *     本层经 ctx.provide('mudCore2', …) 暴露引擎窄面（单例 + gate + 调用期
 *     holder 解析），preset 行执行期 ctx.get 取用；
 *   - 生命周期：agent/disposed → 撤预算/Wake；session/disposed（根登记）→
 *     断连（§19 连接随会话）；插件卸载 → budget.dispose()。
 *
 * 会话绑定与单根（P2 修订 v2 D1/D7）：归属门 = 「agent 用了 mud-player
 * preset」（composedPreset === 'mud-player'）；`default: mud-player` 之下所有
 * 新会话都是候选根，而连接/Wake/预算是单例——首个命中根独占（rootAgentId
 * / rootSessions 登记），后续命中根 fail-loud 留痕（corpus 事件）且其工具
 * 调用经 resolveHolder 得到可读拒绝（不静默、不抢占）。
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包**构建产物** lib/index.js
 * （P2 D4；cordis.patch.yml 的 name 指向 lib，改码后须 `pnpm --filter mud-core2 build`）。
 * @module mud-core2
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 宿主类型增强（Events['agent/created'|'agent/disposed'|'session/disposed']、
// agent.ctx 上的 tools/systemPrompt 服务面、ctx.agentPresets 声明合并）。
// 仅类型引用，运行时零依赖（运行时服务由宿主平面提供）。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { World } from './awareness/world.ts'
import { Awareness } from './awareness/observe.ts'
import { CorpusWriter } from './link/corpus.ts'
import { Mud } from './link/mud.ts'
import { BudgetRegistry, depthByHeader, type SubagentAgent } from './subagent/subagent.ts'
import { FLOWS } from './tools/flows/index.ts'
import { LoginGate, type MudCoreHandle, type ToolAgent } from './tools/tools.ts'
import { Wake } from './wake/wake.ts'
import { PRESET_ID, resolveConfig, type MudCore2Config } from './config.ts'

/** 插件名。 */
export const name = 'mud-core2'

/** 必需服务：subagents（到期 interrupt 的宿主通路，P2 D3）。 */
export const inject = ['subagents']

/** 宿主 subagents 服务窄面（只列本包消费的成员；真 SubagentRuntime 结构兼容）。 */
interface SubagentsNarrow {
  /** interrupt_agent 的宿主入口：authority 'user' = durable 直接父地址（父
   *  离线仍可打断；interruptByParent 同款）。归因差异待实测（§19）。 */
  interrupt(childSessionId: string, authority: { kind: 'user'; parentSessionId: string }): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentsNarrow
  }
}

/**
 * 唤醒署名（P2 D5 修正）：宿主 MessageSourceMap **没有** 'plugin' kind（PLAN
 * D5 原文与宿主 API 不符，构建期类型错暴露）——按宿主 webhook（'webhook'）与
 * v1（'mud-owned'）同款机制声明合并自扩 kind，保留「非用户、来自本插件」
 * 的可辨识署名。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mud-wake': {
      kind: 'mud-wake'
      plugin: string
    }
  }
}

/** 唤醒正文打包（followup/steer 共用；署名 mud-wake，见上）。 */
function wakeMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'mud-wake', plugin: 'mud-core2' } })
}

/** 插件主体（装配一切）。 */
export function apply(ctx: Context, config: Partial<MudCore2Config> = {}): void {
  const cfg = resolveConfig(config)

  // ── 存在层单例（单 MUD 连接；连接惰性：首次 mud_send 隐式建连，§4）──
  const mud = new Mud()
  const world = new World()
  const corpus = new CorpusWriter(cfg.corpusPath ?? null)
  const gate = new LoginGate(mud, world, FLOWS, cfg.creds, cfg.connect, cfg.defaultTimeoutMs)

  // 唤醒器按根 agent 实例换绑：resume/compact 产生新实例，旧实例 disposed 时
  // 撤表（同一时刻至多一个活根实例）。rootAgentId 兼 D7 单根守卫与 Wake owner。
  let rootWake: Wake | null = null
  let rootAgentId: string | null = null
  // 根登记：曾是根的会话 id（session/disposed 断连判据，§19 连接随会话）——
  // agent/disposed（实例终结）可能先于 session/disposed，故判据独立于实例。
  const rootSessions = new Set<string>()

  // ── 意识层（永续；与谁在等无关，§6.1）。危险唤醒与静默重锚经当前根
  //    Wake 接线——子级在途时 rootWake 仍指根：危险 steer 根（T2 决策面），
  //    在途 read 自身由 abortWait 收束（§10.5）。
  const awareness = new Awareness({
    mud,
    world,
    onDanger: hit => rootWake?.steerDanger(hit),
    onActivity: () => rootWake?.armSilence(),
  })

  // ── 预算（子级登记；到期 interrupt 注入宿主通路，P2 D3）────────────
  const budget = new BudgetRegistry({
    budgetMs: cfg.budgetMs,
    // 参数源 = 登记时捕获的子级直接父会话（BudgetRegistry.register 校验，
    // 1.1-5 的合法形态）；装配不再持有/配置根会话 id。
    interruptAgent: (childId, parentSessionId) => ctx.subagents.interrupt(childId, { kind: 'user', parentSessionId }),
  })

  // ── 行流接线（onDisconnect 需要 gate，故在 handler 建好后统一接）────
  mud.onLine = line => {
    corpus.line(line.text, line.raw, line.abs, line.time)
    return awareness.observe(line)
  }
  mud.onSend = cmd => { corpus.event('mud/command-sent', { cmd }) }
  mud.onExchange = info => { corpus.event('mud/exchange-complete', { reason: info.reason, lines: info.lines }) }
  mud.onBoundary = kind => { corpus.event('mud/boundary', { kind }) }
  mud.onDisconnect = () => {
    gate.reset()
    corpus.event('mud/disconnected')
  }

  // ── 引擎窄面（P2 D8）：preset 行执行期 ctx.get('mudCore2') 取用。────
  // resolveHolder 做调用期归属判定：depth 判定（D2）+ 单根守卫（D7）。
  ctx.provide('mudCore2', {
    mud,
    world,
    creds: cfg.creds,
    connect: cfg.connect,
    gate,
    defaultTimeoutMs: cfg.defaultTimeoutMs,
    resolveHolder(agent: ToolAgent | undefined) {
      if (agent === undefined) {
        return { error: '已拒绝：mud-core2 工具调用缺少 agent 上下文，无法判定会话身份（P2 D8）' }
      }
      if (depthByHeader(agent as unknown as SubagentAgent) > 0) return { holder: `child:${agent.id}` }
      if (agent.id === rootAgentId) return { holder: 'root' }
      return {
        error: rootAgentId === null
          ? `已拒绝：mud-core2 尚无登记的根会话（本会话 ${agent.id} 未经 agent/created 登记）`
          : `已拒绝：mud-core2 单根守卫命中——当前根会话 ${rootAgentId}，本会话 ${agent.id} 不得并行持根（P2 D7）`,
      }
    },
  } satisfies MudCoreHandle)

  // ── 归属门（P2 D1 修订）：「用了 mud-player preset」即归属。────────
  // 参数面只取归属判定需要的 ctx（宿主 Agent 上的会话作用域上下文，
  // composedPreset 据此查该会话 composed 的 preset id）；窄面 SubagentAgent
  // 不含 ctx（预算登记面不需要），故单独收窄。
  const belongs = (agent: { readonly ctx: Context }): boolean =>
    ctx.get('agentPresets')?.composedPreset(agent.ctx) === PRESET_ID

  // agent/created 注册在插件全局层（父 agent 作用域看不到子级）。工具与
  // persona 已由 preset 行注册（D6/D8），此处只做引擎侧装配：根 → 单根守卫
  // + Wake 换绑；子级 → 预算登记。
  ctx.on('agent/created', ({ agent }) => {
    // host Agent → 窄面 cast：AgentOptions 与窄 options 无公共属性（弱类型
    // 检查）（P2 D2/D4）。
    const sub = agent as unknown as SubagentAgent
    if (!belongs(agent)) return
    if (depthByHeader(sub) > 0) {
      budget.register(sub) // 参数源校验（header.parentSession）在 register 内 fail-loud
      return
    }
    // 根候选（D7 单根守卫）：首个命中根独占；后续命中 fail-loud 留痕，
    // 其工具调用将由 resolveHolder 拒绝（不静默、不抢占）。
    if (rootAgentId !== null && rootAgentId !== sub.id) {
      corpus.event('mud/core2-root-rejected', { rejected: sub.id, root: rootAgentId })
      return
    }
    rootAgentId = sub.id
    rootSessions.add(sub.id)
    // Wake 换绑 + 初始武装（静默计时从装配起算；每行到达重新武装，§6.1 写死）。
    rootWake?.dispose()
    rootWake = new Wake(
      {
        world,
        followup: text => { agent.followup(wakeMessage(text)) },
        steer: text => { agent.steer(wakeMessage(text)) },
        idle: () => mud.currentHolder === null,
      },
      { silenceMs: cfg.silenceMs },
    )
    rootWake.armSilence()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    budget.clear(String(agent.id))
    if (rootAgentId === String(agent.id)) {
      rootWake?.dispose()
      rootWake = null
      rootAgentId = null
    }
  })

  ctx.on('session/disposed', (session) => {
    if (!rootSessions.has(String(session.id))) return
    rootSessions.delete(String(session.id))
    if (rootAgentId === String(session.id)) {
      rootWake?.dispose()
      rootWake = null
      rootAgentId = null
    }
    mud.disconnect()
    corpus.event('mud/dispose-by-session-disposed')
  })

  // 插件卸载：清全部预算 timer（工具/监听器由各自作用域释放，§11）。
  ctx.effect(() => () => { budget.dispose() })
}
