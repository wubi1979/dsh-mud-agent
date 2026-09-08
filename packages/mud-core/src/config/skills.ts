/**
 * dsh-mud-core — 技能目录 (Skills, agent 可读), config.
 *
 * skill = agent 的决策单元与程序性知识 (被动, 给 LLM 看): agent 判断需要时才
 * 调用。steps 是编排声明, 目标为 tool (mud_send 等) — 每步执行结果回馈 agent
 * 再决策下一步, 无自动执行引擎 (v5 后无 flow 确定性事务; 登录等确定性动作
 * 待重建为"触发器 → lite 假 LLM")。
 *
 * 消费: 描述/步骤注入 agent 系统提示 (mud-skills 区段), agent 按步骤逐步编排
 * tool 调用 (含异常诊断, 如断线重连选 reconnect skill)。
 * @module @deepseek-ai/dsh-mud-core/config/skills
 */

/** 一个流程级技能。 */
export interface MudSkill {
  id: string
  name: string
  description: string
  /** 可编排的目标 (tool 名)。 */
  targets: string[]
  /** 编排步骤: 每步指名 tool + 判断要点 (结果需 agent 判断 → step)。 */
  steps: string[]
}

/** 技能目录 (login: agent 侧的登录/重连决策知识; 确定性执行待重建为触发器 → lite)。 */
export const defaultSkills: readonly MudSkill[] = [
  {
    id: 'login',
    name: '登录/重连',
    description: '登录进入游戏。正常场景由系统自动处理 (确定性登录流程, 待重建为触发器 → lite); 断线或自动登录失效时, 由你诊断并按步骤重连。流程执行进展会随游戏输出反馈给你。',
    targets: ['mud_send'],
    steps: [
      '判断连接状态 (看输出/状态): 自动登录未生效 → 按提示修正输入重试',
      '已断线需重连 → 手动重连 (建连 + 登录提示应答)',
      '登录失败/超时 → 用 mud_send 按提示手动完成登录 (账号/密码/替换确认)',
      '出现"欢迎来到北大侠客行"或"重新连线完毕" → 登录完成, 继续正常行动',
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
