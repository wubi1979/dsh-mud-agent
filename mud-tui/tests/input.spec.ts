import { describe, expect, it } from 'vitest'
import { routeInput } from '../src/input.ts'

describe('routeInput', () => {
  it('routes bare text to the game connection', () => {
    expect(routeInput('look')).toEqual({ kind: 'game', value: 'look' })
    expect(routeInput('  ask xiao er about paizi  ')).toEqual({
      kind: 'game', value: 'ask xiao er about paizi',
    })
  })

  it('treats empty input as a no-op', () => {
    expect(routeInput('')).toEqual({ kind: 'empty' })
    expect(routeInput('   ')).toEqual({ kind: 'empty' })
  })

  it('routes /ai prompts to the agent and requires content', () => {
    expect(routeInput('/ai 查看任务列表')).toEqual({ kind: 'agent', value: '查看任务列表' })
    expect(routeInput('/ai   ')).toEqual({ kind: 'unknown', value: '/ai' })
  })

  it('parses /connect with optional account', () => {
    expect(routeInput('/connect')).toEqual({ kind: 'connect' })
    expect(routeInput('/connect hero')).toEqual({ kind: 'connect', name: 'hero', pass: undefined })
    expect(routeInput('/connect hero secret pass word')).toEqual({
      kind: 'connect', name: 'hero', pass: 'secret pass word',
    })
  })

  it('parses /auto on|off strictly', () => {
    expect(routeInput('/auto on')).toEqual({ kind: 'auto', enabled: true })
    expect(routeInput('/auto off')).toEqual({ kind: 'auto', enabled: false })
    expect(routeInput('/auto yes')).toEqual({ kind: 'unknown', value: '/auto' })
    expect(routeInput('/auto')).toEqual({ kind: 'unknown', value: '/auto' })
  })

  it('handles simple commands', () => {
    expect(routeInput('/disconnect')).toEqual({ kind: 'disconnect' })
    expect(routeInput('/status')).toEqual({ kind: 'status' })
    expect(routeInput('/quit')).toEqual({ kind: 'quit' })
    expect(routeInput('/exit')).toEqual({ kind: 'quit' })
  })

  it('flags unknown slash commands without sending them to the game', () => {
    expect(routeInput('/foo bar')).toEqual({ kind: 'unknown', value: '/foo' })
  })
})
