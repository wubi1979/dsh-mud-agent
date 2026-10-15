/**
 * taskdetect 测试 — 任务环境探测器（T27）：行流进出判据 → 会话活跃任务集。
 *
 * 语义要点（§8.7 任务专用命令；2026-10-15 用户裁定**可多任务并存**）：
 * enter 判据命中 ⇒ 加入该任务（重复进入幂等）；exit 判据命中 ⇒ 仅移除同名任务
 * （他任务不受影响）；断线整体复位全清（§10.4）；判据 = 行文子串实录
 * （A.11，经 mud-commands 装配编译注入——此处用同形状 fixture）。
 */

import { describe, expect, it } from 'vitest'
import { TaskDetector, type TaskEnvRule } from '../src/taskdetect.ts'

const RULES: readonly TaskEnvRule[] = [
  {
    task: 'jianxinju',
    enter: [/你进入了剑心居副本，可以通过leave \S+命令来回到主站/],
    exit: [/退出了剑心居/],
  },
  {
    task: 'zhenfa',
    enter: [/开始演练阵法/],
    exit: [/阵法演练结束/],
  },
]

const feed = (d: TaskDetector, ...lines: string[]) => {
  for (const text of lines) d.onLine({ text })
}

describe('TaskDetector 活跃任务推断（T27）', () => {
  it('enter 判据命中 ⇒ 加入活跃任务；exit 判据命中 ⇒ 移除同名任务', () => {
    const d = new TaskDetector(RULES)
    expect(d.current).toEqual([])
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    expect(d.current).toEqual(['jianxinju'])
    feed(d, '别的行文不触碰标记')
    expect(d.current).toEqual(['jianxinju'])
    feed(d, '你退出了剑心居副本。')
    expect(d.current).toEqual([])
  })

  it('exit 仅移除同名任务（他任务不受影响）', () => {
    const d = new TaskDetector(RULES)
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    feed(d, '阵法演练结束了。') // zhenfa 的 exit——不移除 jianxinju
    expect(d.current).toEqual(['jianxinju'])
  })

  it('多任务并存：enter 各自加入，current 按进入顺序（2026-10-15 用户裁定）', () => {
    const d = new TaskDetector(RULES)
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    feed(d, '你开始演练阵法。')
    expect(d.current).toEqual(['jianxinju', 'zhenfa'])
    feed(d, '阵法演练结束了。') // 只移除 zhenfa，jianxinju 保持
    expect(d.current).toEqual(['jianxinju'])
  })

  it('重复 enter 幂等（同任务不重复入集）', () => {
    const d = new TaskDetector(RULES)
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    expect(d.current).toEqual(['jianxinju'])
  })

  it('reset（断线整体复位 §10.4）：多任务标记全清', () => {
    const d = new TaskDetector(RULES)
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。', '你开始演练阵法。')
    d.reset()
    expect(d.current).toEqual([])
  })

  it('空规则表：恒空集（未声明任务环境的部署零行为）', () => {
    const d = new TaskDetector([])
    feed(d, '你进入了剑心居副本，可以通过leave vicrly命令来回到主站。')
    expect(d.current).toEqual([])
  })
})
