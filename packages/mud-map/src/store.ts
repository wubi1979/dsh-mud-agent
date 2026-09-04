/**
 * dsh-mud-map — 持久化 (Store).
 *
 * MapStore 接口定义存储契约, JsonMapStore 为 JSON 文件实现 (Phase 1)。
 * 通过接口隔离, 后续可无缝替换为 SQLite 实现而不影响调用方。
 *
 * @module @deepseek-ai/dsh-mud-map/store
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MapStore, MapSnapshot } from './types.ts'

/** 当前数据版本. */
const CURRENT_VERSION = 1

/**
 * JSON 文件存储实现.
 *
 * 快照以规范化 (JSON 可序列化) 形式落盘: Map 需转换为键值对象。
 * 平台无关 — 供 WebUI 与 TUI 共用。
 */
export class JsonMapStore implements MapStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<MapSnapshot> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text) as Partial<MapSnapshot>
      return normalizeLoaded(parsed)
    } catch (err) {
      // 文件不存在或损坏 → 返回空快照 (首次运行/容错)
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') return emptySnapshot()
      throw err
    }
  }

  async save(snapshot: MapSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const normalized = {
      ...snapshot,
      version: CURRENT_VERSION,
      // Map → 键值对象 (JSON 可序列化)
      subMaps: snapshot.subMaps.map((sm) => ({
        ...sm,
        nodes: Object.fromEntries(
          [...sm.nodes.entries()].map(([id, node]) => [
            id,
            { ...node, exits: Object.fromEntries(node.exits) },
          ]),
        ),
      })),
    }
    await writeFile(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
  }
}

/** 返回空快照. */
export function emptySnapshot(): MapSnapshot {
  return {
    subMaps: [],
    edges: [],
    semantics: [],
    fences: [],
    version: CURRENT_VERSION,
  }
}

/** 规范化已加载快照 (容错: 缺失字段补默认, 键值对象还原为 Map). */
function normalizeLoaded(parsed: Partial<MapSnapshot>): MapSnapshot {
  const subMaps = Array.isArray(parsed.subMaps)
    ? parsed.subMaps.map((sm) => ({
        ...sm,
        // 键值对象 → Map
        nodes: new Map(Object.entries(sm.nodes ?? {}).map(([id, node]) => [
          id,
          { ...node, exits: new Map(Object.entries(node.exits ?? {})) },
        ])),
      }))
    : []
  return {
    subMaps,
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    semantics: Array.isArray(parsed.semantics) ? parsed.semantics : [],
    fences: Array.isArray(parsed.fences) ? parsed.fences : [],
    version: parsed.version ?? CURRENT_VERSION,
  }
}
