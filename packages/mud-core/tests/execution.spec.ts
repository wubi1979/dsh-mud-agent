/**
 * dsh-mud-core 执行层测试 — 命令队列 (节流/优先级/清空) + 模板渲染。
 *
 * 只有一条执行路径 (工具调用), 无流程执行器。
 */

import { describe, expect, it } from 'vitest'
import { CommandQueue, renderTemplate } from '../src/agent/execution.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('CommandQueue', () => {
  it('最小间隔节流 + 顺序', async () => {
    const sent: string[] = []
    const q = new CommandQueue({ minInterval: 30, onSend: cmd => sent.push(cmd) })
    q.send('first')
    q.send('second')
    q.send('third')
    await sleep(160)
    expect(sent).toEqual(['first', 'second', 'third'])
    expect(q.stats().sent).toBe(3)
  })

  it('优先级 (halt 先发)', async () => {
    const sent: string[] = []
    const q = new CommandQueue({ minInterval: 20, onSend: cmd => sent.push(cmd) })
    q.send('normal-cmd', { priority: 'normal' })
    q.send('low-cmd', { priority: 'low' })
    q.send('halt-cmd', { priority: 'halt' })
    await sleep(140)
    expect(sent[0]).toBe('halt-cmd')
    expect(sent[1]).toBe('normal-cmd')
    expect(sent[2]).toBe('low-cmd')
  })

  it('clear() 清空待发', async () => {
    const sent: string[] = []
    const q = new CommandQueue({ minInterval: 50, onSend: cmd => sent.push(cmd) })
    q.send('a')
    q.send('b')
    q.clear()
    await sleep(120)
    expect(sent).toEqual([])
    expect(q.stats().queued).toBe(0)
  })
})

describe('renderTemplate 参数渲染', () => {
  it('{name}/{pass} 账户参数 (登录规则)', () => {
    expect(renderTemplate('{name}', { name: 'vicrly' })).toBe('vicrly')
    expect(renderTemplate('{pass}', { pass: 'secret' })).toBe('secret')
    expect(renderTemplate('look {missing}', {})).toBe('look {missing}')
    expect(renderTemplate('look', {})).toBe('look')
  })
})
