/**
 * nav 持久化与 `kind:'nav'` 单测（T23.10b，用户裁定 2026-10-08）：
 * JSON 文件持久化（fail-soft）+ 导航侧写 World 的来源标记。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonNavStore } from '../src/nav/json-store.ts'
import { NavService } from '../src/nav/service.ts'
import { SessionRuntime } from '../src/runtime.ts'

/** A.9 荆州府路线表（摘 3 条）。 */
const TABLE = [
  '┌───荆州府─────────────┬────────────┬─────┐',
  '│目的地                │拼音名称                │步数      │',
  '│襄阳  ◇ 城中心                       │xiangyang               │15        │',
  '│汉口镇  ◇ 汉水西岸                   │hankou                  │14        │',
  '└─────────────────────────────国庆节祝福────┘',
]

const tempFile = (): { dir: string; file: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'mudnav-'))
  return { dir, file: join(dir, 'nav-graph.json') }
}

describe('nav JSON 持久化（T23.10b）', () => {
  it('记录即落盘；新实例读回同一张图（会话重启不丢知识）', () => {
    const { dir, file } = tempFile()
    try {
      const first = new NavService(createJsonNavStore(file))
      first.record({ region: '荆州府', lines: TABLE })
      expect(readFileSync(file, 'utf8')).toContain('荆州府')
      const second = new NavService(createJsonNavStore(file))
      expect(second.snapshot().nodes[0]).toMatchObject({ region: '荆州府' })
      expect(second.suggest('荆州府', '襄阳')?.pinyin).toBe('xiangyang')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('坏 JSON / 结构不符 ⇒ 空图 + 上报，不抛（知识是增益不是前置）', () => {
    const { dir, file } = tempFile()
    try {
      writeFileSync(file, '{ 这不是 json', 'utf8')
      const errors: string[] = []
      const bad = new NavService(createJsonNavStore(file, m => errors.push(m)))
      expect(bad.snapshot().nodes).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/JSON 解析失败/)
      // 结构不符（对象但不是快照）⇒ 也按空图（loadSnapshot 逐条丢弃）
      writeFileSync(file, '{"foo":1}', 'utf8')
      expect(new NavService(createJsonNavStore(file)).snapshot().nodes).toEqual([])
      // 文件不存在是正常情况（首次运行）⇒ 不上报
      const fresh: string[] = []
      new NavService(createJsonNavStore(join(dir, 'none.json'), m => fresh.push(m)))
      expect(fresh).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 store ⇒ 纯内存（record 不抛、snapshot 可读）', () => {
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
