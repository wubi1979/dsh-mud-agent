/**
 * dsh-mud-map — 先验层 (PriorParser): ASCII 图解析器.
 *
 * 将人工提供的 ASCII 图文件解析为 PriorSubMap。
 *
 * box-drawing 字符映射使用可配置的 CHAR_MAP (见 types.ts DEFAULT_CHAR_MAP),
 * 后期可由人工手工调整。
 *
 * 解析流程:
 *   1. 行扫描: 逐行识别房间文本块 (非空白、非连接符字符的连续段)
 *   2. 房间提取: 房间名 = 文本末尾数字前的部分, NPC ID = 末尾连续数字;
 *      记录锚点坐标 (x, y)
 *   3. 边提取: 从每个房间沿 8 个方向追踪连接链 (空格/连接符可跨过),
 *      命中另一房间 => 有向连接; 双向对合并为 bidirectional
 *   4. 节点分类: [名称] 标记 => 子图边界 (非房间); ⊕ 标记 => NODE 房间
 *   5. 坐标: 文本位置 => (x, y)
 *   6. 输出 PriorSubMap
 *
 * @module @deepseek-ai/dsh-mud-map/prior-parser
 */

import type { PriorSubMap, PriorNode, PriorConnection, CharMapEntry } from './types.ts'
import { DEFAULT_CHAR_MAP } from './types.ts'

/** 8 方向: 方向名 → (dx, dy). 从锚点左右上下与对角. */
const DIRS: ReadonlyArray<[string, number, number]> = [
  ['east', 1, 0],
  ['west', -1, 0],
  ['north', 0, -1],
  ['south', 0, 1],
  ['northeast', 1, -1],
  ['northwest', -1, -1],
  ['southeast', 1, 1],
  ['southwest', -1, 1],
]

/** 最大连接追踪步数 (防止无限/超长扫描). */
const MAX_TRACE = 200

/** 单个房间文本块 (解析中间态). */
interface RoomBlock {
  /** 房间名 (去尾数字). */
  name: string
  /** 关联 NPC 编号. */
  npcIds: number[]
  /** 段起始列. */
  x: number
  /** 段所在行. */
  y: number
  /** 是否为 NODE 房间. */
  isNode: boolean
  /** 段内全部字符位置 (供连接命中判定). */
  cells: Array<[number, number]>
}

/**
 * ASCII 图解析器.
 */
export class PriorParser {
  private readonly charMap: Record<string, CharMapEntry>

  constructor(charMap: Record<string, CharMapEntry> = DEFAULT_CHAR_MAP) {
    this.charMap = charMap
  }

  /**
   * 解析一个 ASCII 图文本为 PriorSubMap.
   * @param id 子图 ID
   * @param name 子图显示名
   * @param ascii 原始 ASCII 图文本
   * @returns 解析产物
   */
  parse(id: string, name: string, ascii: string): PriorSubMap {
    const lines = stripPadding(ascii)
    const grid = lines.map((line) => [...line])
    const height = grid.length
    const width = grid.reduce((m, row) => Math.max(m, row.length), 0)

    // 归属矩阵: 每个格子属于哪个房间块 (index) / 连接符(-1) / 空白(-2) / 边界(-3).
    const belong: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(-2))

    // 1+2. 行扫描房间文本块.
    const blocks = this.scanBlocks(grid, belong)

    // 节点归属映射 (坐标 → 房间块索引), 供连接起点扫描.
    const byCell = new Map<string, number>()
    blocks.forEach((b, i) => {
      for (const [cx, cy] of b.cells) byCell.set(`${cx},${cy}`, i)
    })

    // 3. 边提取.
    const connections = this.traceConnections(blocks, byCell, grid, height, width)

    // 组装 PriorNode.
    const nodes: PriorNode[] = blocks.map((b, i) => ({
      id: `${id}:${slug(b.name)}`,
      name: b.name,
      npcIds: [...b.npcIds],
      x: b.x,
      y: b.y,
      connections: connections.get(i) ?? [],
    }))

    // 4. 节点分类: 边界已产出 SubMapBoundary, NODE 产出 nodeRooms.
    const boundaries = this.scanBoundaries(lines)
    const nodeRooms = blocks
      .filter((b) => b.isNode)
      .map((b) => ({ name: b.name, gameId: slug(b.name) }))

    return { id, name, nodes, boundaries, nodeRooms }
  }

  /**
   * 扫描房间文本块, 并填充归属矩阵.
   * 房间字符 = 非空白、非连接符、非边界方括号/箭头符号字符。
   * ⊕ (NODE) 标记其同行紧邻的房间为 NODE。
   */
  private scanBlocks(grid: string[][], belong: number[][]): RoomBlock[] {
    const blocks: RoomBlock[] = []
    const nodeCells: Array<[number, number]> = []
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y]!
      let x = 0
      while (x < row.length) {
        const ch = row[x]!
        if (this.isRoomChar(ch)) {
          // 收集连续房间字符段.
          let x2 = x
          let text = ''
          while (x2 < row.length && this.isRoomChar(row[x2]!)) {
            text += row[x2]!
            x2++
          }
          // 末尾连续数字 → NPC 编号; 前面为房间名 (去尾部数字与空白).
          const m = /^(.*?)(\d+)?\s*$/.exec(text)
          const rawName = m?.[1] ?? text
          const npcIds = m?.[2] ? digitIds(m[2]) : []
          const seg: RoomBlock = {
            name: rawName.trim(),
            npcIds,
            x,
            y,
            isNode: false,
            cells: [],
          }
          // 填充归属矩阵: 该段所有格归本块.
          for (let c = x; c < x2; c++) belong[y]![c] = blocks.length
          for (let c = x; c < x2; c++) seg.cells.push([c, y])
          blocks.push(seg)
          x = x2
          continue
        }
        if (this.isConnector(ch)) {
          belong[y]![x] = -1
          if (this.charMap[ch]?.type === 'node') nodeCells.push([x, y])
        } else if (ch === '[' || ch === ']') {
          belong[y]![x] = -3
        }
        x++
      }
    }
    // NODE 标记: ⊕ 与块同行且列紧邻 (块前 ±1 或块尾 +1).
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!
      for (const [nx, ny] of nodeCells) {
        if (ny === b.y && (nx === b.x - 1 || nx === b.x + b.cells.length)) {
          b.isNode = true
          break
        }
      }
    }
    return blocks
  }

  /**
   * 沿 8 方向从每个房间锚点追踪连接链, 命中其他房间即建立有向连接。
   * 返回 Map<房间索引, 有向连接列表>; 双向对随后合并。
   */
  private traceConnections(
    blocks: RoomBlock[],
    byCell: Map<string, number>,
    grid: string[][],
    height: number,
    width: number,
  ): Map<number, PriorConnection[]> {
    // 记录有向连接: key = "{fromIdx}|{dir}|{toIdx}".
    const directed = new Map<string, { from: number; dir: string; to: number }>()
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!
      for (const [dirName, dx, dy] of DIRS) {
        const target = this.traceDir(b.x, b.y, dx, dy, i, byCell, grid, height, width)
        if (target >= 0 && target !== i) {
          directed.set(`${i}|${dirName}|${target}`, { from: i, dir: dirName, to: target })
        }
      }
    }

    // 合并双向: A→B 存在且 B 存在逆方向 → bidirectional=true.
    const out = new Map<number, PriorConnection[]>()
    for (const rec of directed.values()) {
      // 找是否存在逆方向 (from=to', dir 反向).
      const inv = inverseDir(rec.dir)
      const reverse = directed.get(`${rec.to}|${inv}|${rec.from}`)
      let conn = out.get(rec.from) ?? []
      // 若反向已作为本向 (B→A) 记录, 这里只保留一次: 由 from 这一侧代表双向.
      if (reverse) {
        conn.push({ dir: rec.dir, targetName: blocks[rec.to]!.name, bidirectional: true })
      } else {
        conn.push({ dir: rec.dir, targetName: blocks[rec.to]!.name, bidirectional: false })
      }
      out.set(rec.from, conn)
    }
    return out
  }

  /** 从 (x,y) 沿 (dx,dy) 追踪: 返回命中的房间块索引, 无则 -1. */
  private traceDir(
    x: number,
    y: number,
    dx: number,
    dy: number,
    selfIdx: number,
    byCell: Map<string, number>,
    grid: string[][],
    height: number,
    width: number,
  ): number {
    let cx = x + dx
    let cy = y + dy
    let steps = 0
    while (steps < MAX_TRACE) {
      if (cy < 0 || cy >= height || cx < 0 || cx >= width) return -1
      const owner = byCell.get(`${cx},${cy}`)
      if (owner !== undefined) {
        // 命中自己房间块 → 跳过继续 (本块横向占据多列).
        if (owner === selfIdx) { cx += dx; cy += dy; steps++; continue }
        // 命中其他房间块.
        return owner
      }
      const ch = grid[cy]?.[cx]
      if (ch !== undefined && ch !== ' ' && !this.isConnector(ch)) {
        // 命中未登记字符 (边界标记等) → 不是房间, 停止.
        return -1
      }
      cx += dx
      cy += dy
      steps++
    }
    return -1
  }

  /** 扫描 "[名称]" 边界标记. */
  private scanBoundaries(lines: string[]): Array<{ targetSubMap: string; gameNodeId: string }> {
    const out: Array<{ targetSubMap: string; gameNodeId: string }> = []
    for (const line of lines) {
      const re = /\[([^\]]+)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const content = m[1]!.trim()
        if (!content) continue
        out.push({ targetSubMap: content, gameNodeId: slug(content) })
      }
    }
    return out
  }

  /** 是否房间字符 (非空白、非连接符、非边界符号). */
  private isRoomChar(ch: string): boolean {
    if (ch === ' ' || ch === '') return false
    if (this.isConnector(ch)) return false
    return ch !== '[' && ch !== ']'
  }

  /** 是否连接符 (在字符映射中, 含 box-drawing/Punctuation/NODE). */
  private isConnector(ch: string): boolean {
    return ch in this.charMap
  }
}

/**
 * 解析 "末尾连续数字" 为 NPC 编号数组 (单个或多个数字组成的串).
 * 例: "742" → [742]; "12 34" → [12, 34].
 */
function digitIds(digits: string): number[] {
  return digits
    .split(/(?<=\d)(?=\D)|(?<=\D)(?=\d)/)
    .filter((s) => s.length > 0 && Number.isFinite(Number(s)))
    .map(Number)
}

/** 反向方向 (用于双向合并). */
function inverseDir(dir: string): string {
  switch (dir) {
    case 'north': return 'south'
    case 'south': return 'north'
    case 'east': return 'west'
    case 'west': return 'east'
    case 'northeast': return 'southwest'
    case 'southwest': return 'northeast'
    case 'northwest': return 'southeast'
    case 'southeast': return 'northwest'
    default: return dir
  }
}

/** 简化 ID: 去除空白/特殊字符, 转小写 (房间名 → 拼音占位/原样). */
function slug(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^0-9a-zA-Z_\u4e00-\u9fa5]/g, '')
}

/**
 * 去除首尾空行并保留行内实际内容 (行尾空白截掉).
 */
function stripPadding(ascii: string): string[] {
  const raw = ascii.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let first = 0
  let last = raw.length
  while (first < last && raw[first]!.trim() === '') first++
  while (last > first && raw[last - 1]!.trim() === '') last--
  return raw.slice(first, last).map((line) => line.replace(/\s+$/, ''))
}
