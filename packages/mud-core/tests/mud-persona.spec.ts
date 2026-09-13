/**
 * dsh-mud-core — MUD 会话的人设占位 (`doc/ARCHITECTURE.md` §9/§10)。
 *
 * 会话系统提示的人设**已有主人**: 部署的 `personaPrefix` 与 preset 行 (`standard` 的
 * `persona` 行 = "You are a coding agent powered by the {{model}} model.")。MUD 会话不能
 * 并列追加第二段人设 (那会让模型同时被告知"你是编码 agent"和"你是 MUD 玩家"), 只能**同名
 * 替换**: 官方 `systemPrompt` 的 `deployment:persona-prefix` 槽按作用域链取值, 最近的作用域
 * 胜出 —— 所以本插件在 **agent 作用域** 写这个槽 (`attachMudPersona`), 覆盖 preset 作用域
 * 的那一段。preset 行自身写同名会与 standard 的 persona 行在同一作用域撞名并抛错。
 *
 * 本文件用**真实的官方 system-prompt 注册表**复现这条作用域链 (preset 作用域 → agent 作用域)
 * 并断言渲染结果里只剩 MUD 人设。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt, {
  PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import { attachMudPersona, attachMudPrompt } from '../src/agent/agent-bridge.ts'

/** standard preset 的 `persona` 行原文 (部署人设的典型形态)。 */
const CODING_PERSONA = 'You are a coding agent powered by the deepseek-flash model.'
const CODING_SUFFIX = 'Your working directory is D:\\code.'
const MUD_PERSONA = '你是北大侠客行 (pkuxkx) MUD 游戏的玩家。'

/** 挂载真实的 system-prompt 服务 (含部署人设)。 */
async function mountSystemPrompt(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are the deployment agent.' })
  return ctx
}

/**
 * 铸一个作用域 (作用域上下文通过铸它的插件继承依赖 API, 所以这里注入 systemPrompt)。
 * @param ctx 根上下文。
 * @param key 作用域键。
 * @param parent 可选的外层作用域键。
 * @returns 作用域句柄。
 */
async function mintScope(ctx: Context, key: ScopeKey, parent?: ScopeKey): Promise<Scope> {
  let scope!: Scope
  const minter = (inner: Context): void => {
    scope = createScope(inner, key, parent === undefined ? undefined : { parent })
  }
  await ctx.plugin(Object.assign(minter, { inject: ['systemPrompt'] }))
  return scope
}

describe('MUD 人设占官方人设槽 (per-agent 同名替换)', () => {
  it('agent 作用域的人设覆盖 preset 作用域的 standard 人设 (只留 MUD 一段)', async () => {
    const ctx = await mountSystemPrompt()
    // preset 作用域: standard preset 的 persona 行 (前缀 + 后缀两段)。
    const preset: ScopeKey = {}
    const presetScope = await mintScope(ctx, preset)
    presetScope.ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: CODING_PERSONA })
    presetScope.ctx.systemPrompt.section({ name: PERSONA_SUFFIX_SECTION, order: 10_200, text: CODING_SUFFIX })

    // agent 作用域 (preset 的子作用域): 本插件的覆盖 + 三段能力提示。
    const agent: ScopeKey = {}
    const agentScope = await mintScope(ctx, agent, preset)
    attachMudPersona(agentScope.ctx, () => MUD_PERSONA)
    attachMudPrompt(agentScope.ctx, { skillsText: () => '技能目录', commands: '命令参考' })

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))

    expect(prompt).toContain(MUD_PERSONA)
    expect(prompt).toContain('技能目录')
    expect(prompt).toContain('命令参考')
    // 编码 agent 人设 (preset 行) 与工作目录后缀都被替换掉, 不是并列出现。
    expect(prompt).not.toContain('coding agent')
    expect(prompt).not.toContain('working directory')
    // 部署人设属更外层, 同样被覆盖。
    expect(prompt).not.toContain('deployment agent')
    // 上层作用域自己看去仍是它自己的那一段 (覆盖只对本 agent 生效)。
    const presetView = renderPrompt(await ctx.systemPrompt.assemble({ scope: preset }))
    expect(presetView).toContain('coding agent')
    expect(presetView).not.toContain(MUD_PERSONA)
  })

  it('宿主侧装配路径 (无 preset) 一样覆盖部署人设', async () => {
    const ctx = await mountSystemPrompt()
    const agent: ScopeKey = {}
    const agentScope = await mintScope(ctx, agent)
    attachMudPersona(agentScope.ctx, () => MUD_PERSONA)

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))
    expect(prompt).toContain(MUD_PERSONA)
    expect(prompt).not.toContain('deployment agent')
  })
})
