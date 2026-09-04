/**
 * dsh-mud-map — 语义层 (Semantic): look 命令解析 + 指纹提取.
 *
 * 数据源: look 命令输出 (独立消费标准行)。
 *
 * 解析策略 — 出口行锚点法:
 *   完整 look 输出文本块 → 找到出口行 (匹配出口/exits 关键词) 作为锚点
 *   → 向上扫描: 取锚点上方第一条含 '-' 或含区域特征的行作为房间标题行
 *   → 向下扫描: 识别 NPC/物品/玩家列表行 (以标记字符开头或含括号 id)
 *   → 输出 RoomParsed
 *
 * 匹配规则做成可配置 (EXIT_RE / MARKER_RE), 后期由人工根据真实输出调整。
 *
 * @module @deepseek-ai/dsh-mud-map/semantic
 */

import type { RoomParsed, SemanticFingerprint } from './types.ts'
import { normalizeExits, exitsFingerprint } from './geometry.ts'

/** 出口行匹配正则 (可配置). */
const DEFAULT_EXIT_RE = /出口|exits/i

/** 列表标记行正则 (向下扫描识别 NPC/物品): 以 '>' 或 '·' 等标记开头, 或含 (id). */
const DEFAULT_MARKER_RE = /^\s*[>＞·\-*]\s*|\([a-z_]+\)/i

/** 方向词库 (从出口行文本中识别方向词). */
const DIR_WORDS = [
  'north', 'south', 'east', 'west', 'up', 'down',
  'northeast', 'northwest', 'southeast', 'southwest',
  'northup', 'northdown', 'southup', 'southdown',
  'eastup', 'eastdown', 'westup', 'westdown',
  'enter', 'out',
]

/** 语义层解析配置. */
export interface SemanticConfig {
  /** 出口行匹配正则. */
  exitRe?: RegExp
  /** 列表明细标记正则 (向下扫描). */
  markerRe?: RegExp
}

/**
 * 语义层 — look 解析.
 */
export class SemanticLayer {
  private readonly fingerprints: Map<string, SemanticFingerprint> = new Map()
  private readonly exitRe: RegExp
  private readonly markerRe: RegExp

  constructor(config: SemanticConfig = {}) {
    this.exitRe = config.exitRe ?? DEFAULT_EXIT_RE
    this.markerRe = config.markerRe ?? DEFAULT_MARKER_RE
  }

  /**
   * 解析完整 look 输出文本块为 RoomParsed.
   * @param text look 输出的完整文本
   */
  parseLook(text: string): RoomParsed {
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
    // 1. 找出口行锚点.
    const exitIdx = lines.findIndex((l) => this.exitRe.test(l))
    if (exitIdx < 0) {
      return { name: '', area: '', description: '', exits: [], npcs: [], items: [], players: [] }
    }
    // 2. 向上扫描标题行.
    const title = this.scanTitle(lines, exitIdx)
    // 3. 出口行提取方向.
    const exits = this.extractExits(lines[exitIdx] ?? '')
    // 4. 向下扫描列表.
    const { npcs, items, players } = this.scanDown(lines, exitIdx + 1)
    return {
      name: title.name,
      area: title.area,
      description: title.description,
      exits,
      npcs,
      items,
      players,
    }
  }

  /**
   * 解析 look 输出并直接记录为该节的语义指纹 (以外部提供的节点 ID 关联).
   * @param roomId 关联的房间节点 ID
   * @param text look 输出文本
   */
  parseAndRecord(roomId: string, text: string): RoomParsed {
    const parsed = this.parseLook(text)
    this.recordFingerprint({
      roomId,
      description: parsed.description,
      npcs: parsed.npcs,
      items: parsed.items,
      area: parsed.area,
    })
    return parsed
  }

  /** 由出口方向集合生成指纹串 (便捷). */
  static exitsSignature(exits: string[]): string {
    return exitsFingerprint(exits)
  }

  /** 记录/更新一个房间的语义指纹. */
  recordFingerprint(fp: SemanticFingerprint): void {
    this.fingerprints.set(fp.roomId, fp)
  }

  /** 获取指定房间的语义指纹. */
  getFingerprint(roomId: string): SemanticFingerprint | undefined {
    return this.fingerprints.get(roomId)
  }

  /** 全部语义指纹. */
  allFingerprints(): SemanticFingerprint[] {
    return [...this.fingerprints.values()]
  }

  // ── 内部 ──────────────────────────────────────────────

  /** 向上扫描: 找房间标题行 (优先含区域分隔符的行) + 描述. */
  private scanTitle(lines: string[], anchorIdx: number): { name: string; area: string; description: string } {
    // 标题通常形如 "区域 - 房间名" / "区域｜房间名" / "区域·房间名"。
    // 自锚点向上扫描: 优先取第一条含分隔符的行作标题行; 若无, 回退取第一条非空行。
    let fallback: { name: string; area: string; description: string } | null = null
    for (let i = anchorIdx - 1; i >= 0; i--) {
      const line = lines[i]?.trim() ?? ''
      if (line === '') continue
      const split = splitTitle(line)
      if (split.area !== '' || /[-|｜·]/.test(line)) {
        // 含分隔符 → 视为标题行.
        return split
      }
      fallback ??= split
    }
    return fallback ?? { name: '', area: '', description: '' }
  }

  /** 向下扫描: 识别 NPC/物品/玩家列表. */
  private scanDown(lines: string[], startIdx: number): { npcs: string[]; items: string[]; players: string[] } {
    const vs: Record<'npc' | 'item' | 'player', string[]> = { npc: [], item: [], player: [] }
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      if (!this.markerRe.test(line)) continue
      // 简单启发式分类 (后期可调): 含 () 且括号内为小写英文 id → 倾向 npc/item.
      const clean = line.replace(/^\s*[>＞·\-*]\s*/, '').trim()
      if (clean === '') continue
      // 无法可靠区分 item/player, 先归 npc (最常见).
      vs.npc.push(clean)
    }
    return { npcs: vs.npc, items: vs.item, players: vs.player }
  }

  /** 从出口行提取方向词 (按方向词库匹配). */
  private extractExits(line: string): string[] {
    const found = new Set<string>()
    for (const word of DIR_WORDS) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(line)) found.add(word)
    }
    return normalizeExits([...found])
  }
}

/** 拆解房间标题行: 形如 "区域 - 房间名" 或 "房间名". */
function splitTitle(line: string): { name: string; area: string; description: string } {
  const sep = line.indexOf('-')
  if (sep > 0) {
    const left = line.slice(0, sep).trim()
    const right = line.slice(sep + 1).trim()
    return { area: left, name: right || left, description: line }
  }
  const s2 = line.search(/[|｜·]/)
  if (s2 > 0) {
    const left = line.slice(0, s2).trim()
    const right = line.slice(s2 + 1).trim()
    return { area: left, name: right || left, description: line }
  }
  return { area: '', name: line, description: line }
}
