/**
 * cordis.patch.yml 漂移守卫 — 对宿主 standard.patch.yml 逐条对表（P2 D6）。
 *
 * preset 行的 config.plugins 是宿主 standard.patch.yml 的**逐条副本**，只在
 * 末尾追加本包 preset 行（mud-core2-preset）。上游 standard 演进后副本必须
 * 显式同步——本守卫把"逐条一致 + 只多一行"固化成红例（承 v1
 * preset-agent.spec.ts 的教训：副本漂移只在 mount 时才炸）。
 *
 * 另验：preset 行 name 指向的构建产物 lib/preset.js 必须存在（禁空跑守卫，
 * 改码后先 pnpm --filter mud-core2 build）；registry 覆盖行带 default: mud-player。
 *
 * 解析是**文本级**的（非 YAML 语义树）：定位 `plugins:` 行、取其缩进 N、
 * 条目 = 恰好 N+2 缩进的 `- id:` 行，块内注释/空行跳过（本副本的注释是
 * 我方标注，不参与对表）。更深缩进的嵌套 `- id:`（组内子行）天然不命中。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const OURS_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const PRODUCT_PATH = fileURLToPath(new URL('../lib/preset.js', import.meta.url))
const HARNESS_PATH = 'D:/Code/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml'

interface Entry {
  id: string
  /** 归一化文本行（去注释/空行）。 */
  lines: string[]
}

/** 文本级解析 plugins 块（详见文件头）。 */
function parsePluginEntries(text: string): Entry[] {
  const lines = text.split(/\r?\n/)
  const pluginsIdx = lines.findIndex(l => /^\s*plugins:\s*$/.test(l))
  if (pluginsIdx < 0) throw new Error('patch 中找不到 plugins: 行')
  const indent = (lines[pluginsIdx]?.match(/^ */) ?? [''])[0].length
  const entryRe = new RegExp(`^ {${indent + 2}}- id: (\\S+)\\s*$`)
  const entries: Entry[] = []
  let cur: Entry | null = null
  for (const line of lines.slice(pluginsIdx + 1)) {
    const m = line.match(entryRe)
    if (m !== null) {
      cur = { id: m[1] ?? '', lines: [line] }
      entries.push(cur)
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue // 注释/空行不参与对表
    if (cur === null) continue
    if ((line.match(/^ */) ?? [''])[0].length <= indent) break // plugins 块结束
    cur.lines.push(line)
  }
  return entries
}

describe('cordis.patch.yml 漂移守卫（vs 宿主 standard.patch.yml，P2 D6）', () => {
  const ours = parsePluginEntries(readFileSync(OURS_PATH, 'utf8'))
  const standard = parsePluginEntries(readFileSync(HARNESS_PATH, 'utf8'))

  it('plugins 逐条副本：ours = [...standard, mud-core2-preset]，顺序与 id 一致', () => {
    expect(ours.map(e => e.id)).toEqual([...standard.map(e => e.id), 'mud-core2-preset'])
  })

  it('standard 各条目文本逐一相等（上游演进必须显式同步副本，红例指路）', () => {
    expect(standard.length).toBeGreaterThan(0)
    for (let i = 0; i < standard.length; i += 1) {
      const s = standard[i]!
      const o = ours[i]!
      expect(o.lines.join('\n'), `第 ${i} 条（${s.id}）与上游不一致`).toBe(s.lines.join('\n'))
    }
  })

  it('追加行只有 mud-core2-preset 一条，指向本包构建产物且产物已构建（禁空跑守卫）', () => {
    const tail = ours.at(-1)
    expect(tail?.id).toBe('mud-core2-preset')
    expect(tail?.lines.join('\n')).toContain("name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core2/lib/preset.js'")
    expect(existsSync(PRODUCT_PATH), `构建产物缺失：${PRODUCT_PATH}（先 pnpm --filter mud-core2 build）`).toBe(true)
  })

  it('registry 覆盖行带必填 default: mud-player（整份替换纪律，D1 修订）', () => {
    const text = readFileSync(OURS_PATH, 'utf8')
    expect(text).toMatch(/- id: agent-preset-registry\s*\n\s*config:\s*\n\s*default: mud-player/)
  })
})
