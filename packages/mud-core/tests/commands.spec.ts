/**
 * dsh-mud-core — 命令目录的**索引 / 按需展开** (`doc/ARCHITECTURE.md` §10)。
 *
 * 用户定案: 系统提示里不放 70+ 条命令的完整语法 (固定前缀 + 每轮都带), 只放**索引**
 * (分类 + 命令 id), 具体语法由 `mud_help` 工具按需取。本文件固定三条契约:
 *   1. 索引里的 id 集合 == 注册表里可执行命令的 id 集合 (不以省 token 为由丢命令);
 *   2. 索引显著短于全量语法 (否则这个改动没有意义);
 *   3. `mud_help` 三种形态 (无 topic / 分类 / 命令 id) 都能给出可用答案,
 *      未知 topic 不抛错 (模型可输入自由文本)。
 */

import { describe, expect, it } from 'vitest'
import {
  commandHelpText, commandsIndexForAgent, mudCommands, type MudCommand,
} from '../src/config/commands.ts'

/** 可执行命令 (有模板) 的 id 集合。 */
const usableIds = mudCommands.filter(c => c.command !== '').map(c => c.id)

/** 全量语法文本 (测试内部的对照物; 生产路径已不再注入它)。 */
function fullText(commands: readonly MudCommand[] = mudCommands): string {
  return commands
    .filter(c => c.command !== '')
    .map(c => `${c.command} — ${c.name}: ${c.description}`)
    .join('\n')
}

describe('命令索引 (系统提示区段)', () => {
  it('列出全部可执行命令的 id (省 token 不能省掉命令)', () => {
    const index = commandsIndexForAgent()
    for (const id of usableIds) expect(index).toContain(id)
  })

  it('给出查询方式, 且比全量语法短得多', () => {
    const index = commandsIndexForAgent()
    expect(index).toContain('mud_help')
    // 全量语法是它的数倍 (实测 70+ 条一行一条 vs 一条分类一行)。
    expect(index.length * 3).toBeLessThan(fullText().length)
  })

  it('分类名与计数都在 (模型据此判断该查哪一类)', () => {
    const index = commandsIndexForAgent()
    expect(index).toContain('移动/探索')
    expect(index).toContain('修炼')
    // 计数形态: 类名后跟 (n)
    expect(index).toMatch(/移动\/探索 \(\d+\)/)
  })
})

describe('mud_help 文本 (按需展开)', () => {
  it('无 topic: 分类 + id 索引', () => {
    const text = commandHelpText('')
    expect(text).toContain('[navigation]')
    expect(text).toContain('go')
    expect(text).toContain('mud_help topic=')
  })

  it('topic = 分类: 该类的完整语法与说明', () => {
    const text = commandHelpText('navigation')
    expect(text).toContain('[navigation] 移动/探索')
    // 语法模板与说明都在。
    expect(text).toContain('go {direction}')
    expect(text).toContain('向指定方向移动')
    // 不含别的分类 (按需展开, 不是全量倒一遍)。
    expect(text).not.toContain('kill {target}')
  })

  it('topic = 命令 id: 该命令语法 + 同类别余命令', () => {
    const text = commandHelpText('ask')
    expect(text).toContain('ask {target} about {topic}')
    expect(text).toContain('打探消息')
    expect(text).toContain('分类 social')
  })

  it('大小写与空白容错; 未知 topic 给出可用取值 (不抛错)', () => {
    expect(commandHelpText('  NAVIGATION ')).toContain('go {direction}')
    const unknown = commandHelpText('nope')
    expect(unknown).toContain('未知主题')
    expect(unknown).toContain('navigation')
  })
})
