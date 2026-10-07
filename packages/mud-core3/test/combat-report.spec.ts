import { describe, expect, it } from 'vitest'
import { CombatReporter } from '../src/combat/report.ts'

/** 捕获型依赖：记录 World 写入（key→value，后到覆盖）与日志行。 */
function makeDeps() {
  const writes = new Map<string, unknown[]>()
  const logs: string[] = []
  return {
    writes,
    logs,
    deps: {
      write: (key: string, value: unknown) => {
        const list = writes.get(key) ?? []
        list.push(value)
        writes.set(key, list)
      },
      log: (text: string) => { logs.push(text) },
    },
  }
}

describe('CombatReporter（T21.3 W9：模块计数 kind=combat + 会话日志）', () => {
  it('begin 清零：拍数/干预归 0 写入，最后动作清空', () => {
    const { writes, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.round()
    r.dispatch({ ruleId: 'heal', kind: 'burst', commands: ['yun heal'] })
    writes.clear()
    r.begin()
    expect(writes.get('拍数')).toEqual([0])
    expect(writes.get('干预')).toEqual([0])
    expect(writes.get('最后动作')).toEqual([''])
    expect(writes.get('规则命中')).toEqual([0])
  })

  it('round 递增拍数：每次状态写入 +1 并写入 World', () => {
    const { writes, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.begin()
    expect(r.round()).toBe(1)
    expect(r.round()).toBe(2)
    expect(writes.get('拍数')).toEqual([0, 1, 2])
  })

  it('dispatch：干预 +1、规则命中 +1、最后动作 = 命令串，并留一条日志', () => {
    const { writes, logs, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.begin()
    r.dispatch({ ruleId: 'heal', kind: 'burst', commands: ['yun heal'] })
    r.dispatch({ ruleId: 'medicine', kind: 'burst', commands: ['fu yao'] })
    expect(writes.get('干预')).toEqual([0, 1, 2])
    expect(writes.get('规则命中')).toEqual([0, 1, 2])
    expect(writes.get('最后动作')?.at(-1)).toBe('fu yao')
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('heal')
    expect(logs[0]).toContain('yun heal')
  })

  it('多命令派发（halt+move）：最后动作含全部命令，干预按派发次数计', () => {
    const { writes, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.begin()
    r.dispatch({ ruleId: 'flee', kind: 'burst', commands: ['halt', 'east'] })
    expect(writes.get('干预')?.at(-1)).toBe(1)
    expect(writes.get('最后动作')?.at(-1)).toBe('halt east')
  })

  it('note：放弃/接管失败等事件只留日志不动计数', () => {
    const { writes, logs, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.begin()
    r.note('接管获取失败（agent 工具在途），转入 pending')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('pending')
    expect(writes.get('干预')?.at(-1)).toBe(0)
  })

  it('end：结算日志含拍数与干预数，计数保留（历史可读）', () => {
    const { logs, deps } = makeDeps()
    const r = new CombatReporter(deps)
    r.begin()
    r.round()
    r.dispatch({ ruleId: 'heal', kind: 'burst', commands: ['yun heal'] })
    logs.length = 0
    r.end('interrupted')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('interrupted')
    expect(logs[0]).toContain('1')   // 拍数
  })

  it('未 begin 直接 round：从 1 起（容忍漏调 begin）', () => {
    const { writes, deps } = makeDeps()
    const r = new CombatReporter(deps)
    expect(r.round()).toBe(1)
    expect(writes.get('拍数')).toEqual([1])
  })
})
