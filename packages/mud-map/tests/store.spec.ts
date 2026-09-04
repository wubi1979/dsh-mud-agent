/**
 * dsh-mud-map — 持久化 (JsonMapStore) 单元测试.
 *
 * @module @deepseek-ai/dsh-mud-map/tests/store
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonMapStore, emptySnapshot } from '../src/store.ts'
import type { MapSnapshot } from '../src/types.ts'

let dir: string | null = null
afterEach(async () => {
  if (dir) { await rm(dir, { recursive: true, force: true }); dir = null }
})

async function tempFile(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'mudmap-'))
  return join(dir, 'map.json')
}

describe('JsonMapStore', () => {
  it('空文件加载为空快照', async () => {
    const store = new JsonMapStore(await tempFile())
    const snap = await store.load()
    expect(snap.subMaps).toEqual([])
  })

  it('save 后 load 可还原 (含 Map 序列化 round-trip)', async () => {
    const path = await tempFile()
    const store = new JsonMapStore(path)

    const snap = emptySnapshot()
    snap.subMaps.push({
      id: 'sm',
      name: '子图',
      nodes: new Map([
        ['sm:A', { id: 'sm:A', name: 'A', npcIds: [27], exits: new Map([['north', 'sm:B']]), confirmed: true, source: 'gmcp' }],
        ['sm:B', { id: 'sm:B', name: 'B', npcIds: [], exits: new Map([['south', 'sm:A']]), confirmed: true, source: 'gmcp' }],
      ]),
      boundaries: [],
      nodeRooms: [],
    })

    await store.save(snap)

    const loaded = await store.load()
    expect(loaded.subMaps).toHaveLength(1)
    const sm = loaded.subMaps[0]!
    expect(sm.nodes).toBeInstanceOf(Map)
    expect(sm.nodes.get('sm:A')?.npcIds).toEqual([27])
    expect(sm.nodes.get('sm:A')?.exits.get('north')).toBe('sm:B')
  })

  it('损坏 JSON 抛错', async () => {
    const path = await tempFile()
    await writeFile(path, '{not json', 'utf8')
    const store = new JsonMapStore(path)
    await expect(store.load()).rejects.toThrow()
  })

  it('落盘文件确实存在且为 JSON', async () => {
    const path = await tempFile()
    const store = new JsonMapStore(path)
    await store.save(emptySnapshot())
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as MapSnapshot
    expect(parsed.subMaps).toEqual([])
  })
})
