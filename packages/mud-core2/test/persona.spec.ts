/**
 * persona 单测 — systemPrompt.section 注册（impl §3.4）。
 *
 * 覆盖：段名/段序稳定、注册参数为对象（PromptSection 形态）、正文覆盖
 * impl §3.4 内容清单（五层身份 / 服务端拒绝是教育信号 / 子级在途不得直调
 * mud_send / 工具用法 / 计划格式 / 维持类自查 / fullme 兜底常识）。
 */

import { describe, expect, it } from 'vitest'
import {
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  personaText,
  registerPersona,
} from '../src/persona.ts'
import { FULLME_REMINDER_TEXT } from '../src/tools/flows/fullme.ts'

describe('registerPersona', () => {
  it('以 {name, order, text} 对象注册（prompt 不自拼，走宿主 section 组装）', () => {
    const registered: Array<{ name: string; order: number; text: string }> = []
    const disposer = registerPersona({
      section: s => { registered.push(s); return () => undefined },
    })
    expect(typeof disposer).toBe('function') // 宿主 disposer 透传（副作用释放归装配层）
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe(PERSONA_SECTION_NAME)
    expect(registered[0]?.order).toBe(PERSONA_SECTION_ORDER)
    expect(registered[0]?.text).toBe(personaText())
  })

  it('段序落在宿主 deployment persona（0）与 PLAN_POLICY（500）之间', () => {
    expect(PERSONA_SECTION_ORDER).toBeGreaterThan(0)
    expect(PERSONA_SECTION_ORDER).toBeLessThan(500)
  })
})

describe('persona 正文内容清单（impl §3.4）', () => {
  const text = personaText()

  it('五层身份：玩家本人持有目标，下属替你跑腿', () => {
    expect(text).toContain('玩家本人')
    expect(text).toContain('只由你持有')
    expect(text).toContain('替你跑腿')
  })

  it('服务端拒绝是教育信号：先处理手里的活再重试', () => {
    expect(text).toContain('教育信号')
    expect(text).toContain('先处理手里的活')
  })

  it('子级在途时不得直接调 mud_send（应走 send_message / interrupt_agent）', () => {
    expect(text).toContain('不得直接调 mud_send')
    expect(text).toContain('send_message')
    expect(text).toContain('interrupt_agent')
  })

  it('工具用法：三个 mud 工具 + 显式超时纪律', () => {
    expect(text).toContain('mud_send')
    expect(text).toContain('mud_flow')
    expect(text).toContain('mud_state')
    expect(text).toContain('超时必须显式给出')
  })

  it('计划格式：要点 + 边界声明 + 预算；一计划一子级', () => {
    expect(text).toContain('边界声明')
    expect(text).toContain('预算')
    expect(text).toContain('一计划一子级')
  })

  it('维持类自查：口渴/饥饿/疲劳是要你规划的事', () => {
    expect(text).toContain('维持类自查')
    expect(text).toContain('主动规划')
  })

  it('fullme 兜底常识：问题上浮 → 问人取码 → 带答案重入当前计划', () => {
    expect(text).toContain('fullme')
    expect(text).toContain('问人取码')
    expect(text).toContain('重入当前计划')
    expect(text).toContain('answer')
    // 入口映射句：提醒行文常量插值 + 调用入口（FULLME_REMINDER_TEXT 唯一消费点）
    expect(text).toContain(FULLME_REMINDER_TEXT)
    expect(text).toContain('调 mud_flow fullme')
  })
})
