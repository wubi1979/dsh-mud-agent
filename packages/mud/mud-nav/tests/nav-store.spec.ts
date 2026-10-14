/**
 * nav/store 单测（用户裁定 2026-10-14 三次：持久化落**项目内文件** `<cwd>/data/nav-graph.json`，
 * 弃用 storage 域与日志目录混放）：读缺失 / 写读回 / 坏文件 / 写失败上报。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileNavStore } from '../src/store.ts'
import type { NavGraphSnapshot } from '../src/graph.ts'

const SNAP: NavGraphSnapshot = {
  nodes: [{ region: '荆州府', edges: [{ region: '襄阳', room: '城中心', pinyin: 'xiangyang', steps: 15 }], updatedAt: 1 }],
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 每例一个独立临时目录（避免用例间互相读到文件）；`segments` 支持子路径。 */
function tmpFile(...segments: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'nav-store-'))
  dirs.push(dir)
  return join(dir, ...segments)
}

describe('createFileNavStore', () => {
  it('文件不存在 ⇒ load 返回 null（首次运行正常情况，不上报）', () => {
    const messages: string[] = []
    expect(createFileNavStore(tmpFile('nav.json'), m => messages.push(m)).load()).toBeNull()
    expect(messages).toHaveLength(0)
  })

  it('save 落盘（自动建父目录）＋ 新实例读回（重启恢复）', () => {
    const file = tmpFile('nested', 'data', 'nav-graph.json')
    const first = createFileNavStore(file)
    first.save(SNAP)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(SNAP)
    expect(createFileNavStore(file).load()).toEqual(SNAP)
  })

  it('坏 JSON / 非对象 ⇒ null + onError 上报（fail-soft，按空图处理）', () => {
    const messages: string[] = []
    const bad = tmpFile('bad.json')
    writeFileSync(bad, '{not json', 'utf8')
    expect(createFileNavStore(bad, m => messages.push(m)).load()).toBeNull()
    const notObject = tmpFile('arr.json')
    writeFileSync(notObject, '[]', 'utf8')
    expect(createFileNavStore(notObject, m => messages.push(m)).load()).toBeNull()
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('解析失败')
    expect(messages[1]).toContain('结构不符')
  })

  it('写失败（父目录被文件占用）⇒ onError 上报，不抛', () => {
    const messages: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'nav-store-'))
    dirs.push(dir)
    const blocker = join(dir, 'occupied')
    writeFileSync(blocker, 'x', 'utf8')
    const store = createFileNavStore(join(blocker, 'nav-graph.json'), m => messages.push(m))
    expect(() => store.save(SNAP)).not.toThrow()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('落盘失败')
  })

  it('load 坏数据交给 NavGraph.loadSnapshot 逐条丢弃（本层只浅检对象）', () => {
    const file = tmpFile('partial.json')
    writeFileSync(file, JSON.stringify({
      nodes: [
        SNAP.nodes[0],
        { junk: true },
      ],
    }), 'utf8')
    const store = createFileNavStore(file)
    expect(store.load()).not.toBeNull() // 浅检通过；逐条校验在 graph 层
    expect(store.load()).toEqual({ nodes: [SNAP.nodes[0], { junk: true }] })
  })
})
