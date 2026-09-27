/**
 * mud-core2 — 装配层（§3.3：唯一大范围碰 ctx 的文件；P2 计划，doc/PLAN.md）。
 *
 * 职责：把纯 TS 层（link/awareness/wake）与宿主承载接线：
 *   - 存在层单例：Mud + World + CorpusWriter（单 MUD 连接，会话级共享，§11）；
 *   - 意识层永续：mud.onLine → corpus → awareness（swallow 透传，§6.1）；
 *   - 唤醒：Wake 仅挂根 agent 实例（persona/唤醒是 T2 面，§10.1）；危险 →
 *     steer、静默 → followup（宿主动词，§7.3）；idle = 行流无持有者（写死，
 *     §7.2 V7）；
 *   - 工具与预算：agent/created 监听器注册在**插件全局层**（§10.4——宿主/
 *     preset 作用域才能看到子级），belongs 过滤后逐 agent 调 handleCreated
 *     （三工具 + 预算登记）；到期 interrupt 注入宿主 subagents.interrupt
 *     通路（P2 D3）；
 *   - persona：注册在**根 agent 作用域**（全局层会泄漏进子级 prompt，P2 D6）；
 *   - 生命周期：agent/disposed → 撤预算/Wake；session/disposed（根）→ 断连
 *     （§19 连接随会话）；插件卸载 → budget.dispose()。
 *
 * 会话绑定（P2 D1）：Config.rootSessionId 必填；只装配该根会话与其直接
 * 子级（header.parentSession === rootSessionId）。深度 ≥2 的孙级不装配
 * （拓扑只有一层派单，§10）。
 *
 * 加载：宿主 overlay patch 按 plain Node ESM 加载本包**构建产物** lib/index.js
 * （P2 D4；cordis.patch.yml 的 name 指向 lib，改码后须 `pnpm --filter mud-core2 build`）。
 * @module mud-core2
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 宿主类型增强（Events['agent/created'|'agent/disposed'|'session/disposed']、
// agent.ctx 上的 tools/systemPrompt 服务面）。仅类型引用，运行时零依赖。
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { World } from './awareness/world.ts'
import { Awareness } from './awareness/observe.ts'
import { CorpusWriter } from './link/corpus.ts'
import { Mud } from './link/mud.ts'
import { registerPersona } from './persona.ts'
import { createAgentCreatedHandler, depthByHeader, type SessionShared, type SubagentAgent } from './subagent/subagent.ts'
import type { ToolRegistrar } from './tools/tools.ts'
import { Wake } from './wake/wake.ts'
import { resolveConfig, type MudCore2Config } from './config.ts'

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

/** 唤醒正文打包（P2 D5）：宿主 MessageSource kind 'plugin' 需带 plugin 署名。 */
function wakeMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'mud-core2' } })
}

/** 插件主体（装配一切）。 */
export function apply(ctx: Context, config: Partial<MudCore2Config> = {}): void {
  const cfg = resolveConfig(config)

  // ── 存在层单例（单 MUD 连接；连接惰性：首次 mud_send 隐式建连，§4）──
  const mud = new Mud()
  const world = new World()
  const corpus = new CorpusWriter(cfg.corpusPath ?? null)

  // 唤醒器按根 agent 实例换绑：resume/compact 产生新实例，旧实例 disposed 时
  // 撤表（同一时刻至多一个活根实例）。
  let rootWake: Wake | null = null
  let rootWakeOwner: string | null = null

  // ── 意识层（永续；与谁在等无关，§6.1）。危险唤醒与静默重锚经当前根
  //    Wake 接线——子级在途时 rootWake 仍指根：危险 steer 根（T2 决策面），
  //    在途 read 自身由 abortWait 收束（§10.5）。
  const awareness = new Awareness({
    mud,
    world,
    onDanger: hit => rootWake?.steerDanger(hit),
    onActivity: () => rootWake?.armSilence(),
  })

  // ── 工具与预算（agent/created 处理器；gate/budget 跨 agent 共享，§11）──
  const { handleCreated, gate, budget } = createAgentCreatedHandler(
    {
      mud,
      world,
      creds: cfg.creds,
      connect: cfg.connect,
      defaultTimeoutMs: cfg.defaultTimeoutMs,
    } satisfies SessionShared,
    {
      budgetMs: cfg.budgetMs,
      // 到期 interrupt 注入宿主通路（P2 D3）：durable 'user' authority，直接
      // 父地址 = 绑定根（子级都属于该根，P2 D1 保证归属）。
      interruptAgent: childId => ctx.subagents.interrupt(childId, { kind: 'user', parentSessionId: cfg.rootSessionId }),
    },
    depthByHeader,
  )

  // ── 行流接线（onDisconnect 需要 gate，故在 handler 建好后统一接）────
  mud.onLine = line => {
    corpus.line(line.text, line.raw, line.abs, line.time)
    return awareness.observe(line)
  }
  mud.onSend = cmd => { corpus.event('mud/command-sent', { cmd }) }
  mud.onExchange = info => { corpus.event('mud/exchange-complete', { reason: info.reason, lines: info.lines }) }
  mud.onBoundary = kind => { corpus.event('mud/boundary', { kind }) }
  mud.onLog = (level, text) => { corpus.event('mud/log', { level, text }) }
  mud.onDisconnect = () => {
    gate.reset()
    corpus.event('mud/disconnected')
  }

  // ── 会话绑定（P2 D1）：根本体，或直接子级（父 = 绑定根）────────────
  const belongs = (agent: { readonly id: string; readonly session: { readonly header: { readonly parentSession?: string } } }): boolean =>
    agent.id === cfg.rootSessionId || agent.session.header.parentSession === cfg.rootSessionId

  // agent/created 注册在插件全局层（§10.4：父 agent 作用域看不到子级）。
  ctx.on('agent/created', ({ agent }) => {
    // host Agent → 窄面 cast：AgentOptions 与窄 options 无公共属性（弱类型
    // 检查）、ToolRuntime.render 返回可变 ContentBlock[] 与窄 readonly 不一致
    // （窄面在边界处 cast 一次，P2 D2/D4）。
    const sub = agent as unknown as SubagentAgent
    if (!belongs(sub)) return
    const { holder } = handleCreated(agent.ctx.tools as unknown as ToolRegistrar, sub)
    if (holder !== 'root') return
    // 根：persona（per-agent 作用域，P2 D6）+ Wake 换绑 + 初始武装（静默
    // 计时从装配起算；每行到达重新武装，§6.1 写死）。
    registerPersona(agent.ctx.systemPrompt)
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
    rootWakeOwner = agent.id
    rootWake.armSilence()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    budget.clear(String(agent.id))
    if (rootWakeOwner === String(agent.id)) {
      rootWake?.dispose()
      rootWake = null
      rootWakeOwner = null
    }
  })

  ctx.on('session/disposed', (session) => {
    if (String(session.id) !== cfg.rootSessionId) return
    mud.disconnect()
    corpus.event('mud/dispose-by-session-disposed')
  })

  // 插件卸载：清全部预算 timer（工具/监听器由各自作用域释放，§11）。
  ctx.effect(() => () => { budget.dispose() })
}
