/**
 * dsh-mud-core — 技能目录 (Skills, agent 可读), config.
 *
 * 流程级能力的命名清单。每个 skill = 名称 + 描述 + 涉及工具 + 步骤序列:
 *   - **确定性执行** (轻量处理器): 由 config/decision-rules.ts 的原子规则实现
 *     (登录的"提示 → 发对应输入"映射), agent 不参与;
 *   - **agent 知识** (重型处理器): 描述/步骤注入 agent 系统提示, 规则未覆盖
 *     的场景 (重连/异常/提示变体) 由 agent 按序列手动执行。
 * @module @deepseek-ai/dsh-mud-core/config/skills
 */

/** 一个流程级技能。 */
export interface MudSkill {
  id: string
  name: string
  description: string
  tools: string[]
  steps: string[]
}

/** 技能目录 (当前以登录为第一个)。 */
export const defaultSkills: readonly MudSkill[] = [
  {
    id: 'login',
    name: '登录流程',
    description: '登录进入游戏: 响应\'您的英文名字\'提示发账号, 响应\'请输入密码\'提示发密码, 欢迎横幅确认后登录完成。通常由系统自动处理; 若提示出现而系统未响应 (重连/异常/提示变体), 由你按步骤手动完成。',
    tools: ['mud_send'],
    steps: [
      '出现\'您的英文名字\'提示 → mud_send 发送账号',
      '出现\'请输入密码\'提示 → mud_send 发送密码',
      '出现\'欢迎来到北大侠客行\'或\'重新连线完毕\' → 登录完成 → mud_send 发送 look',
      '出现\'替换…y/n\'提示 → mud_send 发送 y',
    ],
  },
]

export default defaultSkills

/** 渲染为 agent 系统提示区段文本 (技能目录)。 */
export function skillsTextForAgent(skills: readonly MudSkill[] = defaultSkills): string {
  return skills
    .map((s) => {
      const steps = (s.steps ?? []).map((t, i) => `   ${i + 1}. ${t}`).join('\n')
      return `- ${s.name}: ${s.description}${steps ? `\n  步骤:\n${steps}` : ''}`
    })
    .join('\n\n')
}
