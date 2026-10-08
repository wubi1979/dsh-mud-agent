/**
 * dsh-mud-webui — 世界状态 HUD（2026-10-08 分组网格重设计）。
 *
 * 信息设计（替代 v0.0.25 的两列长表——sc/hp/skills 几十行平铺无法翻阅）：
 *   - zone 分组：vitals（常显展开）/ character / skills / inventory / items /
 *     combat / gmcp / 其它，每组一行小节标题 + 组内紧凑网格；
 *   - 组内网格：`键 值` 单元流式多列排布（auto-fill minmax），行数降为长表的
 *     1/3~1/5；「当前/上限」数值对渲染迷你进度条（气血/内力/精神/食物等）；
 *   - 动态收纳：vials/combat 常显；character/skills/inventory/items/gmcp 默认
 *     折叠为一行摘要（`skills · 12 项`），点击组头展开；空组不渲染；
 *   - 悬浮保留诊断面：zone/key · 置信度 · 来源 · 时刻。
 *
 * 数据面 = 服务端 `StatusRow` 窄面（§9.5，world 扁平数组，值字符串化）；
 * 消费方：MUD 日志视图（聊天区上部 20% 常驻）。
 * @module @deepseek-ai/dsh-mud-webui/client/MudHudTable
 */

import { useState, type ReactNode } from 'react'
import css from './MudHudTable.module.css'
import type { MudWorldEntry } from './mud-remote.ts'

/** HUD props：会话状态窄面行（缺行 = 会话未登记，渲染空态）。 */
export interface MudHudTableProps {
  readonly row: { loggedIn: 'unknown' | 'inferred' | 'in-game'; world: readonly MudWorldEntry[] } | undefined
  /** 空态文案（缺省「暂无状态」）。 */
  readonly emptyText?: string
}

/** zone 呈现序与组标签（未列出的 zone 排最后、用原名）。 */
const ZONE_ORDER: readonly { zone: string; label: string; defaultOpen: boolean }[] = [
  { zone: 'vitals', label: '生命体征', defaultOpen: true },
  { zone: 'combat', label: '战斗', defaultOpen: true },
  { zone: 'character', label: '人物', defaultOpen: false },
  { zone: 'skills', label: '技能', defaultOpen: false },
  { zone: 'inventory', label: '背包', defaultOpen: false },
  { zone: 'items', label: '物品别称', defaultOpen: false },
  { zone: 'gmcp', label: 'GMCP', defaultOpen: false },
]

/** 「当前/上限」型条目键（渲染迷你进度条；命中即启用）。 */
const RATIO_KEYS = new Set(['气血', '最大气血', '内力', '最大内力', '精神', '最大精神', '精力', '最大精力', '食物', '最大食物', '饮水', '最大饮水', '气势'])

/** 登录轴标签样式三种态。 */
function loginTag(loggedIn: 'unknown' | 'inferred' | 'in-game' | undefined): ReactNode {
  if (loggedIn === 'in-game') return <span className={css.tagOk}>已登录</span>
  if (loggedIn === 'inferred') return <span className={css.tagInferred}>已登录（推断）</span>
  return <span className={css.tagOff}>未登录</span>
}

/**
 * 解析「当前/上限」数值对（tracker 写入的字符串形如 `281`、`281 / 313`）。
 * @param value - 条目字符串值。
 * @returns `{cur, max}`（max=0 表示无上限对），不可解析返回 undefined。
 */
function parseRatio(value: string): { cur: number; max: number } | undefined {
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?$/.exec(value.trim())
  if (m === null) return undefined
  const cur = Number.parseFloat(m[1] ?? '0')
  if (!Number.isFinite(cur)) return undefined
  const max = m[2] === undefined ? 0 : Number.parseFloat(m[2])
  return { cur, max: Number.isFinite(max) ? max : 0 }
}

/** 对象值紧凑渲染结果：展示文本 + 是否隐藏键（语义已在文案内，如技能中文名）。 */
interface CompactValue {
  readonly text: string
  readonly hideKey: boolean
}

/**
 * 对象值紧凑渲染（tracker 结构化写入，如 skills 技能行 / inventory 财物）：
 * 优先取「语义字段对」拼短文案，其余对象退回 k=v 逗号串。
 * @param value - 条目字符串值（JSON 字符串化后的对象）。
 * @returns 紧凑展示文本，非对象返回 undefined。
 */
function compactObject(value: string): CompactValue | undefined {
  if (!value.startsWith('{')) return undefined
  let obj: Record<string, unknown>
  try { obj = JSON.parse(value) as Record<string, unknown> } catch { return undefined }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  // skills 技能行：`太极拳＋ 20.1/78`（键是英文 id，中文名已在文案内 → 隐藏键；
  // 描述/前缀/分类以 title 悬浮呈现，不占行宽）。
  if (typeof obj.name === 'string' && typeof obj.level === 'number') {
    return {
      text: `${obj.name}${obj.flag === '＋' ? '＋' : ''} ${obj.level}${typeof obj.cap === 'number' ? `/${obj.cap}` : ''}`,
      hideKey: true,
    }
  }
  // 通用对象：`k=v` 逗号串（如财物 gold=4, silver=70）。
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  return parts.length > 0 ? { text: parts.join(', '), hideKey: false } : undefined
}

/**
 * 单个状态单元：键 + 值（数值对 → 迷你进度条；对象值 → 紧凑文案；其余文本，超宽截断）。
 */
function EntryCell({ entry }: { entry: MudWorldEntry }): ReactNode {
  const ratio = RATIO_KEYS.has(entry.key) ? parseRatio(entry.v) : undefined
  const compact = ratio === undefined ? compactObject(entry.v) : undefined
  return (
    <span
      className={css.cell}
      title={`${entry.zone}/${entry.key} · ${entry.c} · ${entry.sk}\n${entry.v}`}
    >
      {compact === undefined || !compact.hideKey ? <span className={css.cellKey}>{entry.key}</span> : null}
      {ratio !== undefined && ratio.max > 0
        ? (
          <span className={css.cellRatio}>
            <span className={css.ratioTrack}>
              <span
                className={ratio.cur <= 0 ? css.ratioFillDanger : css.ratioFill}
                style={{ width: `${Math.max(0, Math.min(1, ratio.cur / ratio.max)) * 100}%` }}
              />
            </span>
            <span className={css.cellVal}>{entry.v}</span>
          </span>
        )
        : <span className={css.cellVal}>{compact?.text ?? entry.v}</span>}
    </span>
  )
}

/**
 * 一个 zone 组：可折叠组头（标签 + 条数摘要）+ 展开态网格。
 */
function ZoneGroup({ label, entries, defaultOpen }: { label: string; entries: MudWorldEntry[]; defaultOpen: boolean }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={css.group}>
      <button type="button" className={css.groupHead} onClick={() => { setOpen(o => !o) }}
        aria-expanded={open}>
        <span className={css.groupChevron}>{open ? '▾' : '▸'}</span>
        <span className={css.groupLabel}>{label}</span>
        <span className={css.groupCount}>{entries.length} 项</span>
      </button>
      {open && (
        <div className={css.grid}>
          {entries.map(entry => <EntryCell key={entry.key} entry={entry} />)}
        </div>
      )}
    </div>
  )
}

/** 世界状态 HUD：登录轴 + zone 分组网格（vitals/combat 常显，长清单组折叠）。 */
export function MudHudTable({ row, emptyText = '暂无状态' }: MudHudTableProps): ReactNode {
  const entries = row?.world ?? []
  const byZone = new Map<string, MudWorldEntry[]>()
  for (const e of entries) {
    const list = byZone.get(e.zone)
    if (list === undefined) byZone.set(e.zone, [e])
    else list.push(e)
  }
  const known = ZONE_ORDER.filter(z => byZone.has(z.zone))
  const rest = [...byZone.keys()].filter(z => !ZONE_ORDER.some(k => k.zone === z))
  return (
    <div className={css.root}>
      <div className={css.topline}>
        <span className={css.cellKey}>登录</span>
        {loginTag(row?.loggedIn)}
        {entries.length === 0 && <span className={css.emptyInline}>{emptyText}</span>}
      </div>
      {known.map(z => (
        <ZoneGroup key={z.zone} label={z.label} entries={byZone.get(z.zone) ?? []} defaultOpen={z.defaultOpen} />
      ))}
      {rest.map(z => (
        <ZoneGroup key={z} label={z} entries={byZone.get(z) ?? []} defaultOpen={false} />
      ))}
    </div>
  )
}
