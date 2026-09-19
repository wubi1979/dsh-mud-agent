/**
 * dsh-mud-core — 技能服务 (Skills), host half. (`ctx.mud.skill`)
 *
 * 技能目录 = 预制基线 (agent/skills.ts 内置, agent 可读) + 运行中动态注册。
 * 核心场景: **skill 除预制外主要由 agent 根据游戏经验生成** — agent 训练出新的
 * 流程能力后经本服务 register, 注入其 mud-skills 系统提示区段 (下次 prompt 构建
 * 生效; 供后续会话/重连复用)。
 *
 * 与触发服务/流程引擎协作: 一个明确、可复用的 skill 可进一步落地为 flow
 * (确定性事务) 或 trigger (应激感知); 本服务的注册表是这些能力的上游来源。
 * @module @deepseek-ai/dsh-mud-core/agent/skills
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

/** 渲染为 agent 系统提示区段文本 (技能目录)。 */
export function skillsTextForAgent(skills: readonly MudSkill[] = defaultSkills): string {
  return skills
    .map((s) => {
      const steps = (s.steps ?? []).map((t, i) => `   ${i + 1}. ${t}`).join('\n')
      return `- ${s.name}: ${s.description}${steps ? `\n  步骤:\n${steps}` : ''}`
    })
    .join('\n\n')
}

/** SkillService 构造参数。 */
export interface SkillServiceOptions {
  /** 预制基线 (缺省用 defaultSkills)。 */
  base?: readonly MudSkill[]
  /** 每次目录变化后的回调 (宿主据此更新 agent 的 mud-skills 区段)。 */
  onChange?: () => void
}

/**
 * 技能服务 (`ctx.mud.skill`): register/unregister/list/textForAgent。
 * 内部维护有序目录 (预制在前, 动态追加); 同名 id 覆盖。
 */
export class SkillService {
  private readonly skills: MudSkill[]
  private readonly onChange: (() => void) | null

  constructor({ base = defaultSkills, onChange = undefined }: SkillServiceOptions = {}) {
    this.skills = [...base]
    this.onChange = onChange ?? null
  }

  /** 注册/覆盖一个技能 (动态生成的 agent 经验落地)。 */
  register(skill: MudSkill): void {
    const idx = this.skills.findIndex(s => s.id === skill.id)
    if (idx >= 0) this.skills[idx] = skill
    else this.skills.push(skill)
    this.onChange?.()
  }

  /** 注销一个技能 (返回是否删除成功)。 */
  unregister(id: string): boolean {
    const idx = this.skills.findIndex(s => s.id === id)
    if (idx < 0) return false
    this.skills.splice(idx, 1)
    this.onChange?.()
    return true
  }

  /** 当前技能目录快照。 */
  list(): readonly MudSkill[] {
    return this.skills.slice()
  }

  /** 按 id 取技能。 */
  get(id: string): MudSkill | undefined {
    return this.skills.find(s => s.id === id)
  }

  /** 渲染为 agent 系统提示 mud-skills 区段文本。 */
  textForAgent(): string {
    return skillsTextForAgent(this.skills)
  }
}