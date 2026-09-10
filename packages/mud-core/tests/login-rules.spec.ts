/**
 * dsh-mud-core 登录规则链单测 — 登录流程重建 (2026-09-10)。
 *
 * 覆盖抓包实证驱动的修正 + GA 主边界决策:
 *   - login:pass 双形态: "请输入密码：" 与 "ID已存在，请输入密码：" (8081 老号复登前缀);
 *   - login:done 真实完成信号 "目前权限：(player)", 且**不**误判登录前横幅
 *     "欢迎使用北大侠客行游戏。" (横幅是连接横幅, 非完成判定);
 *   - 登录命令**不声明 until** — 一律按应答桥 GA 主边界结算 (见 LOGIN_BOUNDARIES 决策);
 *   - login:replace-confirm 多形态 (行首 已有同名 前缀 + 全角/半角 y/n 括号);
 *   - login:error 估计形态 → flags.login_fault 标记。
 */

import { describe, expect, it } from 'vitest'
import { TriggerMatchService } from '../src/trigger-llm/service.ts'
import defaultPerceptionRules, { LOGIN_BOUNDARIES } from '../src/config/trigger-rules.ts'
import type { MudLine } from '../src/preprocess/ansi.ts'

function toLines(rows: string[]): MudLine[] {
  return rows.map((t, i) => ({
    text: t, raw: t, style: [], abs: i, time: Date.now(), isPrompt: false,
  }))
}

/** 按 eventType 取单条登录规则, 对给定行做 event 匹配, 返回命中集。 */
function matchEvent(eventId: string, rows: string[]) {
  const rule = defaultPerceptionRules.find(r => r.eventType === eventId)
  if (!rule) throw new Error(`规则不存在: ${eventId}`)
  const svc = new TriggerMatchService([rule], 'event')
  return svc.match(toLines(rows))
}

/** 取命中动作的 mud 工具调用参数 (deep-typed: args 为 Record)。 */
function toolArgs(hit: ReturnType<TriggerMatchService['match']>[number]) {
  const t = hit.action?.tool
  if (!t || t.name !== 'mud_send') return undefined
  return t.args as Record<string, unknown>
}

describe('登录规则链 (触发器驱动登录, GA 主边界)', () => {
  it('登录命令不声明 until — 结算边界一律回归应答桥 GA 主边界', () => {
    // 决策 (2026-09-10): 登录命令不声明 until (声明链会被 GA 只测不结算 → 意外文本
    // 锁帧等超时)。回归 GA 后: 帧内容完整作 tool result, 续步判定自然承接。
    for (const eventId of ['p:login:name', 'p:login:pass', 'p:login:replace']) {
      const rule = defaultPerceptionRules.find(r => r.eventType === eventId)!
      const args = rule.action?.tool?.args as Record<string, unknown> | undefined
      expect(args?.until, `${eventId} 不应声明 until`).toBeUndefined()
    }
  })

  it('LOGIN_BOUNDARIES 边界表被登录规则复用 (单一事实来源)', () => {
    const name = defaultPerceptionRules.find(r => r.eventType === 'p:login:name')!
    const pass = defaultPerceptionRules.find(r => r.eventType === 'p:login:pass')!
    const replace = defaultPerceptionRules.find(r => r.eventType === 'p:login:replace')!
    const done = defaultPerceptionRules.find(r => r.eventType === 'p:login:done')!
    const error = defaultPerceptionRules.find(r => r.eventType === 'p:login:error')!
    if (name.match?.kind !== 'regex' || pass.match?.kind !== 'regex'
      || replace.match?.kind !== 'regex' || done.match?.kind !== 'regex'
      || error.match?.kind !== 'regex') throw new Error('登录规则应为 regex 匹配')
    expect(name.match.patterns).toEqual(LOGIN_BOUNDARIES.entry)
    expect(pass.match.patterns).toEqual(LOGIN_BOUNDARIES.pass)
    expect(replace.match.patterns).toEqual(LOGIN_BOUNDARIES.replace)
    expect(done.match.patterns).toEqual(LOGIN_BOUNDARIES.terminal)
    expect(error.match.patterns).toEqual(LOGIN_BOUNDARIES.error)
  })

  it('login:name: 长短两版名字提示均命中', () => {
    const long = matchEvent('p:login:name', ['您的英文名字（要注册新人物请输入new。）：'])
    expect(long).toHaveLength(1)
    expect(toolArgs(long[0]!).cmd).toBe('{name}')

    const short = matchEvent('p:login:name', ['您的英文名字：'])
    expect(short).toHaveLength(1)
  })

  it('login:pass: 前缀 "ID已存在" 与裸 "请输入密码" 双形态均命中 (修复漏匹配卡死)', () => {
    const withPrefix = matchEvent('p:login:pass', ['ID已存在，请输入密码：'])
    expect(withPrefix).toHaveLength(1)
    expect(toolArgs(withPrefix[0]!)?.cmd).toBe('{pass}')

    const bare = matchEvent('p:login:pass', ['请输入密码：'])
    expect(bare).toHaveLength(1)
  })

  it('login:pass: 其它"密码"相关行不误命中 (如提示语/公告)', () => {
    const rows = ['密码错误，请重新输入。', '请输入正确的密码以继续任务：', '密码保护公告']
    expect(matchEvent('p:login:pass', rows)).toHaveLength(0)
  })

  it('login:done: 真实完成信号 "目前权限：(player)" 命中 (抓包 hex: \r\n 后即此文本)', () => {
    expect(matchEvent('p:login:done', ['目前权限：(player)'])[0]?.id).toBe('login:done')
    expect(matchEvent('p:login:done', ['目前权限：（player）'])[0]?.id).toBe('login:done')
    // 备选形态保留。
    expect(matchEvent('p:login:done', ['欢迎来到北大侠客行，祝您游戏愉快！'])[0]?.id).toBe('login:done')
    expect(matchEvent('p:login:done', ['重新连线完毕。'])[0]?.id).toBe('login:done')
  })

  it('login:done: 登录前横幅不误判为完成 (锚点修正反向用例)', () => {
    const banner = [
      '☆ 飞雪连天射白鹿，笑书神侠倚碧鸳 ☆',
      '欢迎使用北大侠客行游戏。',
      '  游戏地址 mud.pkuxkx.net 8080',
    ]
    expect(matchEvent('p:login:done', banner)).toHaveLength(0)
  })

  it('login:replace-confirm: 同名前缀 + 全角/半角括号多形态均命中 (修旧双漏)', () => {
    // 旧正则对行首 "已有同名" + 全角括号（y/n）双漏 — 现已多形态全收 (估计, 待实录)。
    const withFullPrefix = matchEvent('p:login:replace', ['已有同名用户存在，是否替换人物（y/n）？'])
    expect(withFullPrefix[0]?.id).toBe('login:replace-confirm')
    expect(toolArgs(withFullPrefix[0]!)?.cmd).toBe('y')

    const ascii = matchEvent('p:login:replace', ['覆盖同名档案吗(y/n)'])
    expect(ascii[0]?.id).toBe('login:replace-confirm')
  })

  it('login:error: 估计形态命中 → world_patch 置 flags.login_fault (不自动重试循环)', () => {
    const hit = matchEvent('p:login:error', ['密码错误，请重新输入。'])
    expect(hit[0]?.id).toBe('login:error')
    const t = hit[0]?.action?.tool
    expect(t?.name).toBe('world_patch')
    expect((t?.args as Record<string, unknown>)?.patch).toEqual({ login_fault: true })
  })
})