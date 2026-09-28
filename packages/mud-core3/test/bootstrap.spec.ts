/**
 * bootstrap 测试 — 建账号开场消息文本。
 *
 * 契约：文本必须点名服务器/账号/preset 与"未连接"状态，并明确"不要调用工具"
 * （开场回合只为把 blank 会话翻成活跃会话，不该触发工具副作用）。
 */

import { describe, expect, it } from 'vitest'
import { bootstrapText } from '../src/bootstrap.ts'

describe('bootstrapText', () => {
  it('包含服务器、地址、账号、preset 与当前状态', () => {
    const text = bootstrapText({
      serverName: '北大侠客行', endpoint: 'mud.example.org:4000', accountName: 'hero', preset: 'mud-player',
    })
    expect(text).toContain('北大侠客行')
    expect(text).toContain('mud.example.org:4000')
    expect(text).toContain('hero')
    expect(text).toContain('mud-player')
    expect(text).toContain('未连接')
    expect(text).toContain('不要调用任何工具')
  })

  it('未登记服务器时用占位地址（不抛错）', () => {
    const text = bootstrapText({ serverName: 'ws-1', endpoint: '未登记', accountName: 'hero', preset: 'standard' })
    expect(text).toContain('未登记')
    expect(text).toContain('standard')
  })
})
