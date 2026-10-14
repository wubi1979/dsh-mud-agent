/**
 * nav 持久化与 `kind:'nav'` 单测（T23.10b，用户裁定 2026-10-14 三次）：
 * **项目内文件**持久化（`<cwd>/data/nav-graph.json`，"跟数据库文件一样存在项目中"）
 * + 导航侧写 World 的来源标记。storage 域（落点 `$DSH_HOME/storages/` 用户目录）
 * 与日志目录混放两案均已裁定弃用。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileNavStore } from 'mud-nav/store'
import { NavService } from 'mud-nav/service'
import { walkLine } from 'mud-nav/route'
import { SessionRuntime } from '../src/runtime.ts'

/** A.9 荆州府路线表（摘 2 条）。 */
const TABLE = [
  '┌───荆州府─────────────┬────────────┬─────┐',
  '│目的地                │拼音名称                │步数      │',
  '│襄阳  ◇ 城中心                       │xiangyang               │15        │',
  '│汉口镇  ◇ 汉水西岸                   │hankou                  │14        │',
  '└─────────────────────────────国庆节祝福────┘',
].map(walkLine)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('nav 文件持久化（data/nav-graph.json，整图快照）', () => {
  it('记录即落盘；新 service 指同一文件读回同一张图（会话重启不丢知识）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nav-int-'))
    dirs.push(dir)
    const file = join(dir, 'data', 'nav-graph.json')
    const first = new NavService(createFileNavStore(file))
    first.record({ region: '荆州府', lines: TABLE })
    const second = new NavService(createFileNavStore(file))
    expect(second.snapshot().nodes[0]).toMatchObject({ region: '荆州府' })
    expect(second.snapshot().nodes[0]?.edges.map(e => e.pinyin)).toContain('xiangyang')
  })

  it('旧格式文件读时归一（dest 按 ◇ 折算、旧 paths ⇒ dirs 并入）；坏数据逐条丢弃不整体报废', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nav-int-'))
    dirs.push(dir)
    const file = join(dir, 'nav-graph.json')
    writeFileSync(file, JSON.stringify({
      nodes: [
        { region: '荆州府', edges: [{ dest: '襄阳  ◇ 城中心', pinyin: 'xiangyang', steps: 15 }], updatedAt: 1 },
        { region: '坏节点', edges: [{ pinyin: '', dest: 'x', steps: 1 }], updatedAt: 0 },
      ],
      paths: [{ region: '荆州府', to: '襄阳', directions: ['west'], updatedAt: 2 }],
    }), 'utf8')
    const service = new NavService(createFileNavStore(file))
    expect(service.snapshot().nodes.map(n => n.region)).toEqual(['荆州府'])
    expect(service.snapshot().nodes[0]?.edges[0]).toEqual({
      region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15, dirs: ['west'],
    })
  })

  it('无 store（rosterStorage:false 强制内存）⇒ record 不落盘不抛、snapshot 可读', () => {
    const memory = new NavService()
    expect(memory.record({ region: '荆州府', lines: TABLE }).edges).toBe(2)
    expect(memory.snapshot().nodes).toHaveLength(1)
  })
})

describe("导航侧写 World：kind='nav'（T23.10b）", () => {
  it('writeNavWorld 落条目并标来源 nav（与 gmcp/track/combat 并列）', () => {
    const rt = new SessionRuntime('nav-1')
    rt.writeNavWorld('location', '出发点就绪', false)
    expect(rt.world.location?.['出发点就绪']?.value).toBe(false)
    expect(rt.world.location?.['出发点就绪']?.source.kind).toBe('nav')
    rt.dispose()
  })
})
