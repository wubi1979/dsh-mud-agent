/**
 * dsh-mud-core — 技能目录 (Skills, agent 可读), config.
 *
 * skill = agent 的决策单元与程序性知识 (被动, 给 LLM 看): agent 判断需要时才
 * 调用。steps 是编排声明, 目标可以是 tool (mud_send 等) 也可以是 flow (确定性
 * 事务, 经 flow.start 激活) — 每步执行结果回馈 agent 再决策下一步, 无自动执行
 * 引擎 (与 flow 正交: flow 是系统主动调用的确定性执行体, 见 config/flows.ts)。
 *
 * 两类消费:
 *   - **agent 知识** (重型处理器): 描述/步骤注入 agent 系统提示, agent 按步骤
 *     逐步编排 tool/flow 调用 (含异常诊断, 如断线重连选 reconnect skill);
 *   - **确定性旁路** (轻量处理器): step 中无判断的连续动作包成 flow 一次跑完
 *     (如 login flow 的"提示 → 发输入"), agent 只在 flow 失败/超时后接手。
 * @module @deepseek-ai/dsh-mud-core/config/skills
 */

/** 一个流程级技能。 */
export interface MudSkill {
  id: string
  name: string
  description: string
  /** 可编排的目标 (tool 名 / flow 名)。 */
  targets: string[]
  /** 编排步骤: 每步指名 tool/flow + 判断要点 (结果需 agent 判断 → step)。 */
  steps: string[]
}

/** 技能目录 (login: agent 侧的登录/重连决策知识; 确定性执行体是 login flow)。 */
export const defaultSkills: readonly MudSkill[] = [
  {
    id: 'login',
    name: '登录/重连',
    description: '登录进入游戏。正常场景由系统自动处理 (login flow 确定性事务, 无需你介入); 断线或流程失败时, 由你诊断并按步骤重连。流程执行进展会随游戏输出反馈给你。',
    targets: ['mud_send', 'flow:login'],
    steps: [
      '判断连接状态 (看输出/状态): 未断线但流程失败 → 按 failed 提示修正输入重试',
      '已断线需重连 → 激活 flow:login (内部完成建连 + 登录提示应答 + 完成后 look)',
      'flow:login 失败/超时 → 用 mud_send 按提示手动完成登录 (账号/密码/替换确认)',
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
