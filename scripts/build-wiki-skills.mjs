#!/usr/bin/env node
// wiki → skill 转换器（T25.1，PLAN D2/D3/D4/D9）。
//
// 输入: corpus/wiki/（pages/<类目>[/<子类>]/<file>.json + url_details.json）
// 输出: knowledge/wiki-<title>/SKILL.md（190 单篇；基础知识 11 篇转 mud-basics，不产单篇）
//
// 规则:
//   - name = wiki-<metadata.title>，title 的 ':' → '-'（task:ansha → wiki-task-ansha）
//   - description = <中文标题>（<类目>[/<子类>]）；中文标题取 url_details 按 URL 映射，
//     fallback = metadata.title
//   - 正文 = 时效标注（来源 URL + 抓取日期，D9）+ text 原文
//   - name 冲突 fail-loud；生成后自校验（数量对账 / frontmatter 合法 / name kebab-case）
//   - 幂等：重跑覆盖生成；源数据不变 ⇒ 产物不变
//
// 用法: node scripts/build-wiki-skills.mjs [--dry-run]
import { readdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const corpusDir = join(root, 'corpus', 'wiki')
const outDir = join(root, 'knowledge')
const EXCLUDED_CATEGORY = '基础知识' // D4：转 mud-basics，不产单篇
const SCRAPED_AT = '2026-01-12'
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const dryRun = process.argv.includes('--dry-run')

// ── 收集页面 ───────────────────────────────────────────────────
function* walkJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJson(full)
    else if (entry.name.endsWith('.json')) yield full
  }
}

const urlDetails = JSON.parse(readFileSync(join(corpusDir, 'url_details.json'), 'utf8'))
const titleBySlug = new Map() // URL → 中文标题
for (const row of urlDetails) {
  if (typeof row?.url === 'string' && typeof row?.title === 'string' && !titleBySlug.has(row.url)) {
    titleBySlug.set(row.url, row.title)
  }
}

const pages = []
for (const file of walkJson(join(corpusDir, 'pages'))) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const rel = relative(corpusDir, file).replaceAll('\\', '/') // e.g. 任务知识/主流任务/task_ansha.json
  const segs = rel.split('/')
  const category = segs[1]
  const subcategory = segs.length > 3 ? segs[2] : undefined
  const title = String(doc?.metadata?.title ?? '')
  const url = String(doc?.metadata?.url ?? '')
  const text = String(doc?.text ?? '')
  if (title === '' || url === '' || text === '') {
    console.error(`[FAIL] 页面缺字段: ${rel}`)
    process.exit(1)
  }
  const chineseTitle = titleBySlug.get(url) ?? title
  const name = `wiki-${title.replaceAll(':', '-')}`
  pages.push({ rel, category, subcategory, title, url, text, chineseTitle, name, file })
}

// ── 转换 ───────────────────────────────────────────────────────
function skillMarkdown(page) {
  const scope = page.subcategory === undefined
    ? page.category
    : `${page.category}/${page.subcategory}`
  const frontmatter = [
    '---',
    `name: ${page.name}`,
    `description: ${page.chineseTitle}（${scope}）`,
    '---',
    '',
  ].join('\n')
  const header = [
    `> 来源：${page.url}`,
    `> 抓取：${SCRAPED_AT}（游戏版本可能已变化；实机行为为准，本文仅供参考）`,
    '',
  ].join('\n')
  return `${frontmatter}${header}${page.text.trim()}\n`
}

const singles = pages.filter(p => p.category !== EXCLUDED_CATEGORY)
const excluded = pages.filter(p => p.category === EXCLUDED_CATEGORY)

// name 冲突 fail-loud（title 全局唯一已验证；防御未来数据变化）
const seen = new Map()
for (const p of [...singles, ...excluded]) {
  if (seen.has(p.name)) {
    console.error(`[FAIL] name 冲突: ${p.name}（${seen.get(p.name)} 与 ${p.rel}）`)
    process.exit(1)
  }
  seen.set(p.name, p.rel)
}

// ── 写盘 ───────────────────────────────────────────────────────
if (!dryRun) {
  // 清掉旧的单篇产物（只清 wiki-* 前缀目录，保住手工编撰的 mud-basics 等其他技能）
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('wiki-')) {
        rmSync(join(outDir, entry.name), { recursive: true, force: true })
      }
    }
  }
  for (const p of singles) {
    const dir = join(outDir, p.name)
    if (!existsSync(dir)) {
      // mkdirSync 递归（knowledge/ 可能尚不存在）
      const { mkdirSync } = await import('node:fs')
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(p), 'utf8')
  }
}

// ── 自校验 ─────────────────────────────────────────────────────
const expectedSingles = 190
const errors = []
if (singles.length !== expectedSingles) {
  errors.push(`单篇数量 ${singles.length} ≠ 预期 ${expectedSingles}`)
}
if (excluded.length !== 11) {
  errors.push(`排除（${EXCLUDED_CATEGORY}）数量 ${excluded.length} ≠ 11`)
}
for (const p of singles) {
  if (!NAME_RE.test(p.name)) errors.push(`name 非 kebab-case: ${p.name}（${p.rel}）`)
  if (p.chineseTitle.trim() === '') errors.push(`中文标题为空: ${p.rel}`)
}
if (!dryRun) {
  const written = readdirSync(outDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('wiki-'))
  if (written.length !== singles.length) {
    errors.push(`落盘目录 ${written.length} ≠ 单篇 ${singles.length}`)
  }
  for (const p of singles) {
    const f = join(outDir, p.name, 'SKILL.md')
    if (!existsSync(f)) { errors.push(`产物缺失: ${f}`); continue }
    const content = readFileSync(f, 'utf8')
    if (!content.startsWith('---\n')) errors.push(`frontmatter 缺失: ${p.name}`)
    if (!content.includes(`name: ${p.name}`)) errors.push(`frontmatter name 不符: ${p.name}`)
    if (!content.includes('来源：')) errors.push(`时效标注缺失: ${p.name}`)
    // 正文完整性：末 40 字符应来自原文末尾（trim 后）
    const tail = p.text.trim().slice(-40)
    if (tail !== '' && !content.includes(tail)) errors.push(`正文不完整: ${p.name}`)
  }
  const mudBasics = join(outDir, 'mud-basics', 'SKILL.md')
  if (!existsSync(mudBasics)) errors.push('mud-basics 缺失（手工编撰，需单独落盘）')
}

if (errors.length > 0) {
  console.error(`[FAIL] 自校验 ${errors.length} 处:`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`[OK] 单篇 ${singles.length}（预期 ${expectedSingles}）+ 排除 ${excluded.length}（→ mud-basics）${dryRun ? '（dry-run 未写盘）' : '，落盘校验全过'}`)
