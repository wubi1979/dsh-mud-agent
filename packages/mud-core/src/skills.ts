/**
 * dsh-mud-core — 技能服务 (Skills), host half. (`ctx.mud.skill`)
 *
 * 技能目录 = 预制基线 (config/skills.ts, agent 可读) + 运行中动态注册。
 * 核心场景: **skill 除预制外主要由 agent 根据游戏经验生成** — agent 训练出新的
 * 流程能力后经本服务 register, 注入其 mud-skills 系统提示区段 (下次 prompt 构建
 * 生效; 供后续会话/重连复用)。
 *
 * 与触发服务/流程引擎协作: 一个明确、可复用的 skill 可进一步落地为 flow
 * (确定性事务) 或 trigger (应激感知); 本服务的注册表是这些能力的上游来源。
 * @module @deepseek-ai/dsh-mud-core/skills
 */

import { defaultSkills, skillsTextForAgent, type MudSkill } from './config/skills.ts'

/** SkillService 构造参数。 */
export interface SkillServiceOptions {
  /** 预制基线 (缺省用 config/skills.ts 的 defaultSkills)。 */
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