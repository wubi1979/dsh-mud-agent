/**
 * dsh-mud-core — 匹配服务 (TriggerMatchService) + 匹配器 (Perceptor), host half.
 *
 * v6.5 语义: 准入唯一判据 = 锚定整行正则 (作者书写 `^…$`; 宽松 includes/contains
 * 已废弃 —— MUD 聊天/帮助文本误触发风险)。两段式匹配:
 *   - 预筛 (候选集): 由正则字面前缀自动推导 seed, 只缩候选 (超集, 绝不误杀);
 *     `^` 锚定 → prefix 模式 (startsWith), 否则必需字面段 → substring 模式。无字面前缀的
 *     规则全量跑。预筛是纯性能路径, 命中判定永远由二级正则承载。
 *   - 准入+提取: 锚定正则 .test → 首个匹配正则的命名捕获组 → map 组装 data
 *     (numeric 数值化); extract 逃生舱 (二次颜色等复杂提取) 存在时覆盖。
 *
 * v6.2 保留: 匹配功能抽离为独立服务，支持 state/event 双桶; 行号由 AnsiStreamParser
 * 分配 (MudLine.abs)。多行是 Mudlet 逐条件状态机 (每条件测单一行), 不拼窗。
 * v6.6 增补 (匹配类型三分 + 折叠语义):
 *   - MatchSpec: regex (锚定整行, seed 预筛) / text (字面子串, 本身即预筛) /
 *     func (每行谓词, 无预筛全量跑); 构造校验 fail fast。
 *   - window: 单行规则声明命中窗口, 批内切片装配 PerceptRecord.before/after。
 *   - 折叠 (hit.foldLines): 单行 regex/text = 仅锚点行; 单行 func = 不折叠
 *     (房间抓取类复合提取, 全部行进 agent); multiline = 全部被捕获的条件行。
 * v6.7 (准入语义收紧): ruleHit 改合取式 —— 命中 = 主判据(regex/text/func) ∧
 *   color(声明时, 命中后补充判定) ∧ guard。删除旧回退 (regex 未中仍以 color/extract
 *   准入): 曾使 func+extract 规则 (state:look) 每行命中并污染 world, 且使"同词异色"
 *   区分失效。extract 只做准入后的程序化提取, 不参与准入。
 *
 * @module @deepseek-ai/dsh-mud-core/trigger-llm/service
 */

import type { MudLine, StyleRun } from '../preprocess/ansi.ts'
import { StyleFlag } from '../preprocess/ansi.ts'
import type {
  ActionSpec,
  ColorCond,
  MatchContext,
  MultiCond,
  MultiMatchState,
  PerceptionRule,
  PerceptHit,
  PerceptRecord,
  WindowSpec,
} from './types.ts'
import { createMatchContext, MULTI_LINE_DELTA } from './types.ts'

function rgbEq(a: [number, number, number] | null | undefined,
  b: [number, number, number] | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined
    && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** 任一段 run 命中全部已指定通道即算命中 (行对象携带 style run 列表)。
 *  对齐 Mudlet: bold 与非默认前景耦合 → 暗色索引 (0-7) 在 bold 时按亮色 (8-15)
 *  变体等价 (TBuffer.cpp:1378), 故 cond.fg 命中 run.fg 或 bold 的亮色变体均算。 */
export function styleMatchesColor(rows: readonly { style: readonly StyleRun[] }[], cond: ColorCond): boolean {
  if (rows.length === 0) return false
  return rows.some(row => row.style.some(r => {
    const fg = r.fg
    const fgEff = fg !== null && (r.flags & StyleFlag.Bold) !== 0 && fg < 8 ? fg + 8 : fg
    const bg = r.bg
    const bgEff = bg !== null && (r.flags & StyleFlag.Bold) !== 0 && bg < 8 ? bg + 8 : bg
    return (cond.fg === undefined || fgEff === cond.fg)
      && (cond.bg === undefined || bgEff === cond.bg)
      && (cond.fgTrue === undefined || rgbEq(r.fgTrue, cond.fgTrue))
      && (cond.bgTrue === undefined || rgbEq(r.bgTrue, cond.bgTrue))
  }))
}

/** 预筛 seed: 从锚定正则字面前缀推导的"必要出现"条件 (超集, 只缩候选不判命中)。 */
interface Seed {
  mode: 'prefix' | 'substring'
  text: string
}

/** 正则元字符 (ASCII; CJK 全角字符一律按字面处理)。 */
const REGEX_META = new Set(['\\', '.', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'])

/** 从正则源码推导预筛 seed: `^字面…` → { prefix, 字面段 }; 否则 { substring, 首段字面 }。
 *  无字面前缀 (纯元字符开头) 返回 null → 该规则不做预筛。 */
function deriveSeed(src: string): Seed | null {
  let i = 0
  const anchored = src[0] === '^'
  if (anchored) i = 1
  let run = ''
  while (i < src.length) {
    const c = src[i] as string
    if (c === '\\') {
      const next = src[i + 1]
      if (next === undefined) break
      if ('dDwWsSbB0123456789'.includes(next)) break // 字符类/边界/回溯引用 → 非字面
      run += next
      i += 2
      continue
    }
    if (REGEX_META.has(c)) break
    run += c
    i += 1
  }
  if (run === '') return null
  return { mode: anchored ? 'prefix' : 'substring', text: run }
}

/** 预筛通过: seed 为空 → 全量; 任一 seed 满足即为候选 (超集, 准入仍由正则负责)。 */
function seedPasses(seeds: readonly Seed[], text: string): boolean {
  if (seeds.length === 0) return true
  for (const s of seeds) {
    if (s.mode === 'prefix' ? text.startsWith(s.text) : text.includes(s.text)) return true
  }
  return false
}

/** 数值化: 去千分位逗号 [,，] 后 Number; 无法解析返回 null。 */
function toNumber(raw: string): number | null {
  const n = Number(String(raw).replace(/[,，]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** 由命名捕获组按 map/numeric 组装 data; 无有效捕获返回 null。
 *  numeric 组解析失败则省略该键 (对齐 parseVitals 语义: 无效字段不入库)。 */
function buildMapData(
  map: Record<string, string>,
  numeric: readonly string[] | undefined,
  groups: Record<string, string> | undefined,
): Record<string, unknown> | null {
  if (groups === null || groups === undefined) return null
  const out: Record<string, unknown> = {}
  let any = false
  for (const [gname, dotKey] of Object.entries(map)) {
    const raw = groups[gname]
    if (raw === undefined) continue
    if (numeric?.includes(gname) ?? false) {
      const n = toNumber(raw)
      if (n === null) continue
      any = true
      out[dotKey] = n
    } else {
      any = true
      out[dotKey] = raw
    }
  }
  return any ? out : null
}

/** 归一化触发规则 (配置态, 无运行时状态)。 */
interface NormalizedTriggerRule {
  id: string
  eventType: string
  priority: number
  multiline: boolean
  greedy: boolean
  /** 匹配类型 (v6.6): 分派到对应匹配器。 */
  kind: 'regex' | 'text' | 'func'
  /** kind='regex': 锚定整行正则 (multiline 派生条件也源于此)。 */
  regex: RegExp[]
  /** kind='text': 字面子串 (includes 本身即预筛)。 */
  includes: string[]
  /** kind='func': 每行谓词 (无预筛全量跑)。 */
  test: ((line: MudLine) => boolean) | null
  /** 预筛种子 (regex 字面前缀派生 / text 即 includes; func 空 = 全量)。 */
  seeds: Seed[]
  /** 多行: 有序条件 (multiline=true 时使用)。派生自 patterns 或 regex。 */
  multiConds: MultiCond[]
  /** 多行: 首末条件最大间隔行数。 */
  lineDelta: number
  color: ColorCond | null
  guard: ((record: PerceptRecord) => boolean) | null
  extract: ((record: PerceptRecord) => Record<string, unknown> | null) | null
  /** 命中窗口声明 (单行规则; null = 不装配 before/after)。 */
  window: WindowSpec | null
  /** 捕获组 → world 点分键 (命中后组装 data)。 */
  map: Record<string, string> | null
  numeric: readonly string[] | null
  /** 命中动作 (v6: 规则携带; 装配方据此渲染)。 */
  action: ActionSpec | null
}

/** 构造去 g 标志的正则 (防 lastIndex 跨行错位; Mudlet 无全局串联语义)。 */
function makeRegex(source: string, multiline: boolean): RegExp {
  return new RegExp(source, multiline ? 'm' : '')
}

function stripG(re: RegExp): RegExp {
  if (!re.global && !re.sticky) return re
  const flags = re.flags.replace(/[gy]/g, '')
  return new RegExp(re.source, flags)
}

/** 推导多行有序条件 (patterns 优先, 否则 regex 逐条)。 */
function buildMultiConds(rule: PerceptionRule, multiline: boolean): MultiCond[] {
  if (rule.patterns && rule.patterns.length > 0) {
    return rule.patterns.map(p => {
      if (p.kind === 'spacer') return { kind: 'spacer', lines: Math.max(1, p.lines || 1) } satisfies MultiCond
      if (p.kind === 'regex') {
        const re = typeof p.regex === 'string' ? makeRegex(p.regex, multiline) : stripG(p.regex)
        return { kind: 'regex', regex: re } satisfies MultiCond
      }
      return { kind: 'substring', text: String(p.text ?? '') } satisfies MultiCond
    })
  }
  const out: MultiCond[] = []
  const regexes = rule.match?.kind === 'regex' ? rule.match.patterns : []
  for (const r of regexes) {
    const re = typeof r === 'string' ? makeRegex(r, multiline) : stripG(r)
    out.push({ kind: 'regex', regex: re })
  }
  return out
}

/**
 * 触发器匹配器 (Perceptor): 确定性规则匹配器, 对齐 Python Matcher。
 * match(lines, ctx) 一次跑完窗口内全部规则, 返回按行号排序的结果。
 * 运行态 (多行状态机) 由 MatchContext 承载, 与规则定义分离。
 */
export class Perceptor {
  private rules: NormalizedTriggerRule[] = []
  private readonly owners = new Map<string, string>()

  register(rule: PerceptionRule, owner = ''): NormalizedTriggerRule {
    const multiline = !!rule.multiline
    // v6.6 构造校验 (fail fast): 判据必填; multiline 仅 regex; 窗口仅单行。
    if (rule.match === undefined) {
      throw new Error(`[trigger] 规则 ${rule.id} 缺少 match 判据`)
    }
    if (multiline && rule.match.kind !== 'regex') {
      throw new Error(`[trigger] 规则 ${rule.id}: multiline 仅支持 match.kind='regex'`)
    }
    if (rule.window !== undefined && multiline) {
      throw new Error(`[trigger] 规则 ${rule.id}: window 仅支持单行规则 (multiline 的行序列即窗口)`)
    }
    const color: ColorCond | null =
      rule.fg !== undefined || rule.bg !== undefined
      || rule.fgTrue !== undefined || rule.bgTrue !== undefined
        ? {
          ...(rule.fg !== undefined ? { fg: rule.fg } : {}),
          ...(rule.bg !== undefined ? { bg: rule.bg } : {}),
          ...(rule.fgTrue !== undefined ? { fgTrue: rule.fgTrue } : {}),
          ...(rule.bgTrue !== undefined ? { bgTrue: rule.bgTrue } : {}),
        }
        : null
    const kind = rule.match.kind
    const regex: RegExp[] = kind === 'regex'
      ? rule.match.patterns.map(r => (typeof r === 'string' ? makeRegex(r, multiline) : stripG(r)))
      : []
    const includes = kind === 'text' ? rule.match.includes.map(s => String(s)) : []
    const test = kind === 'func' ? rule.match.test : null
    const norm: NormalizedTriggerRule = {
      id: rule.id,
      eventType: rule.eventType || rule.id,
      priority: rule.priority ?? 10,
      multiline,
      greedy: !!rule.greedy,
      kind,
      regex,
      includes,
      test,
      seeds: multiline
        ? []
        : kind === 'regex'
          ? this.deriveSeeds(regex)
          : kind === 'text'
            ? includes.map(s => ({ mode: 'substring', text: s }) satisfies Seed)
            : [],
      multiConds: buildMultiConds(rule, multiline),
      lineDelta: rule.lineDelta ?? MULTI_LINE_DELTA,
      color,
      guard: rule.guard ?? null,
      extract: rule.extract ?? null,
      window: rule.window ?? null,
      map: rule.map ?? null,
      numeric: rule.numeric ?? null,
      action: rule.action ?? null,
    }
    this.unregister(norm.id)
    let i = 0
    while (i < this.rules.length && (this.rules[i]?.priority ?? 0) >= norm.priority) i += 1
    this.rules.splice(i, 0, norm)
    if (owner) this.owners.set(norm.id, owner)
    return norm
  }

  private deriveSeeds(regex: readonly RegExp[]): Seed[] {
    const out: Seed[] = []
    for (const re of regex) {
      const seed = deriveSeed(re.source)
      if (seed) out.push(seed)
    }
    return out
  }

  unregister(ruleId: string): void {
    const idx = this.rules.findIndex(r => r.id === ruleId)
    if (idx >= 0) this.rules.splice(idx, 1)
    this.owners.delete(ruleId)
  }

  unregisterByOwner(owner: string): number {
    const ids: string[] = []
    for (const [ruleId, ow] of this.owners) {
      if (ow === owner) ids.push(ruleId)
    }
    for (const id of ids) this.unregister(id)
    return ids.length
  }

  /** 窗口匹配: 返回按 lineNumber 排序的结果。运行态由 ctx 承载。 */
  match(lines: MudLine[], ctx: MatchContext): PerceptHit[] {
    if (!lines || lines.length === 0) return []
    const results: PerceptHit[] = []
    for (const rule of this.rules) {
      if (rule.multiline) {
        for (const line of lines) {
          const r = this.feedMultiline(rule, line, ctx)
          if (r) results.push(r)
        }
      } else {
        // 单行: 批内逐行 (index 随行传入, 窗口装配免 indexOf)。
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as MudLine
          if (rule.kind === 'func') {
            // func 谓词无预筛, 每行调用。
            const r = this.matchLine(rule, line, lines, i)
            if (r) results.push(r)
            continue
          }
          if (!seedPasses(rule.seeds, line.text)) continue
          const r = this.matchLine(rule, line, lines, i)
          if (r) results.push(r)
        }
      }
    }
    results.sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0))
    return results
  }

  getRules(): NormalizedTriggerRule[] {
    return this.rules.slice()
  }

  /** 准入判定 (v6.7 合取语义): 命中 ⟺ 主判据命中 ∧ color(声明时) ∧ guard。
   *  - 主判据 (v6.6 三分): regex / text / func, 分派到对应匹配器;
   *  - color: 命中后的补充判定 (AND 门, 不单独准入) —— 同词异色区分;
   *  - extract: 准入后的程序化提取 (matchLine 内调用), 绝不参与准入。
   *  v6.7 删除旧回退 (regex 全不中时曾以 color/extract 直接准入): 该回退使
   *  func+extract 规则 (state:look) 每行命中, 且 color 规则在文本未命中时误触发。 */
  private ruleHit(rule: NormalizedTriggerRule, record: PerceptRecord): boolean {
    const text = record.rows.map(r => r.text).join('\n')
    if (rule.kind === 'regex') {
      let matched = false
      for (const re of rule.regex) {
        re.lastIndex = 0
        if (re.test(text)) { matched = true; break }
      }
      if (!matched) return false
    } else if (rule.kind === 'text') {
      if (!rule.includes.some(s => text.includes(s))) return false
    } else if (rule.kind === 'func') {
      // 谓词作用于锚点行 (单行记录 rows=[锚点行]); 未命中即不准入 (无回退)。
      if (record.rows.length !== 1 || rule.test === null || !rule.test(record.rows[0] as MudLine)) return false
    }
    if (rule.color !== null && !styleMatchesColor(record.rows, rule.color)) return false
    if (rule.guard && !rule.guard(record)) return false
    return true
  }

  /** 命中窗口装配: 锚点行前后批内切片 (声明 window 时; 跨批不追)。 */
  private buildRecord(rule: NormalizedTriggerRule, line: MudLine, batch: MudLine[], index: number): PerceptRecord {
    if (rule.window === null) return { rows: [line], before: [], after: [] }
    return {
      rows: [line],
      before: batch.slice(Math.max(0, index - rule.window.before), index),
      after: batch.slice(index + 1, index + 1 + rule.window.after),
    }
  }

  private matchLine(rule: NormalizedTriggerRule, line: MudLine, batch: MudLine[], index: number): PerceptHit | null {
    const record = this.buildRecord(rule, line, batch, index)
    if (!this.ruleHit(rule, record)) return null
    const hit: PerceptHit = {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      // 折叠语义: regex/text 折叠锚点行 (窗口行不折叠); func 不折叠 (房间抓取类全行进 agent)。
      foldLines: rule.kind === 'func' ? [] : [line.abs],
      data: rule.extract
        ? (rule.extract(record) ?? null)
        : this.collectSingleData(rule, line.text),
    }
    if (rule.action) hit.action = rule.action
    return hit
  }

  /** 准入命中后: 首个匹配正则的命名捕获组 → map/numeric 组装 data。 */
  private collectSingleData(rule: NormalizedTriggerRule, text: string): Record<string, unknown> | null {
    if (rule.map === null) return null
    for (const re of rule.regex) {
      re.lastIndex = 0
      const m = re.exec(text)
      if (m !== null && m.groups !== undefined) {
        const d = buildMapData(rule.map, rule.numeric ?? undefined, m.groups)
        if (d) return d
      }
    }
    return null
  }

  /** 多行命中后: 各条件正则的命名捕获组合并 → map/numeric 组装 data。 */
  private collectMultiData(rule: NormalizedTriggerRule, st: MultiMatchState): Record<string, unknown> | null {
    if (rule.map === null) return null
    const groups: Record<string, string> = {}
    let ci = 0
    for (const cond of rule.multiConds) {
      if (cond.kind === 'spacer') continue
      const cap = st.captures[ci]
      ci += 1
      if (cap === undefined || cond.kind !== 'regex') continue
      const re = typeof cond.regex === 'string' ? makeRegex(cond.regex, false) : cond.regex
      re.lastIndex = 0
      const m = re.exec(cap.text)
      if (m !== null && m.groups !== undefined) Object.assign(groups, m.groups)
    }
    return buildMapData(rule.map, rule.numeric ?? undefined, groups)
  }

  private condMatch(cond: MultiCond, line: MudLine): boolean {
    if (cond.kind === 'substring') return line.text.includes(cond.text)
    if (cond.kind === 'regex') {
      const re = typeof cond.regex === 'string' ? makeRegex(cond.regex, false) : cond.regex
      re.lastIndex = 0
      return re.test(line.text)
    }
    return false
  }

  private stepMulti(rule: NormalizedTriggerRule, st: MultiMatchState, line: MudLine): boolean {
    if (st.next >= rule.multiConds.length) return true
    const cond = rule.multiConds[st.next]
    if (cond === undefined) return true
    if (cond.kind === 'spacer') {
      st.spacerCount += 1
      if (st.spacerCount >= cond.lines) {
        st.spacerCount = 0
        st.next += 1
      }
    } else if (this.condMatch(cond, line)) {
      st.next += 1
      st.captures.push({ text: line.text, abs: line.abs, row: line })
    }
    return st.next >= rule.multiConds.length
  }

  /** 多行状态机: 使用 ctx 中的状态, 而非规则上的可变状态。 */
  private feedMultiline(rule: NormalizedTriggerRule, line: MudLine, ctx: MatchContext): PerceptHit | null {
    const lastAbs = ctx.multiLastAbs.get(rule.id) ?? -1
    if (line.abs <= lastAbs) return null
    ctx.multiLastAbs.set(rule.id, line.abs)

    const conds = rule.multiConds
    if (conds.length === 0) return null

    const states = ctx.multiStates.get(rule.id) ?? []
    const completed: MultiMatchState[] = []
    const kept: MultiMatchState[] = []
    const step = (st: MultiMatchState): void => {
      st.lineCount += 1
      if (this.stepMulti(rule, st, line)) completed.push(st)
      else if (st.lineCount <= rule.lineDelta) kept.push(st)
    }
    for (const st of states) step(st)

    const first = conds[0]
    if (first !== undefined && first.kind !== 'spacer' && this.condMatch(first, line)) {
      const seed: MultiMatchState = {
        next: 1,
        lineCount: 0,
        spacerCount: 0,
        captures: [{ text: line.text, abs: line.abs, row: line }],
      }
      if (seed.next >= conds.length) completed.push(seed)
      else kept.push(seed)
    }
    ctx.multiStates.set(rule.id, kept)

    if (completed.length === 0) return null
    const st = completed[completed.length - 1]
    if (st === undefined) return null
    const rows = st.captures.map(c => c.row)
    // multiline 行序列即窗口: before/after 恒空 (构造校验已禁 window)。
    const record: PerceptRecord = { rows, before: [], after: [] }
    if (rule.color !== null && !styleMatchesColor(rows, rule.color)) return null
    if (rule.guard && !rule.guard(record)) return null
    const hit: PerceptHit = {
      id: rule.id,
      eventType: rule.eventType,
      lineNumber: line.abs,
      // 折叠语义: multiline 折叠全部被捕获的条件行 (行序列即窗口)。
      foldLines: st.captures.map(c => c.abs),
      reason: 'multiline',
      data: rule.extract
        ? (rule.extract(record) ?? null)
        : this.collectMultiData(rule, st),
    }
    if (rule.action) hit.action = rule.action
    return hit
  }
}

/**
 * 匹配服务 (TriggerMatchService): 独立实例，管理规则集 + 匹配上下文 + 行对象缓存。
 * 每个实例维护独立的 MatchContext (多行状态机运行态)。
 *
 * 典型用法:
 *   - stateInstance: 预匹配折叠 (状态/观察 → world)
 *   - eventInstance: T1 渲染 (事件/决策 → agent)
 */
export class TriggerMatchService {
  private readonly perceptor = new Perceptor()
  private readonly ctx: MatchContext = createMatchContext()

  constructor(rules?: PerceptionRule[], owner = '') {
    if (rules) {
      for (const r of rules) this.perceptor.register(r, owner)
    }
  }

  /** 注册一个触发规则; owner 用于批量注销。 */
  register(rule: PerceptionRule, owner = ''): void {
    this.perceptor.register(rule, owner)
  }

  /** 注销一个触发规则。 */
  unregister(ruleId: string): void {
    this.perceptor.unregister(ruleId)
  }

  /** 按 owner 批量注销 (返回注销条数)。 */
  unregisterByOwner(owner: string): number {
    return this.perceptor.unregisterByOwner(owner)
  }

  /** 当前注册的触发规则数。 */
  get size(): number {
    return this.perceptor.getRules().length
  }

  /** 现有触发规则快照 (调试/状态展示)。 */
  getRules(): { id: string; eventType: string }[] {
    return this.perceptor.getRules().map(r => ({ id: r.id, eventType: r.eventType }))
  }

  /**
   * 匹配入口: 传入行对象 (已由 AnsiStreamParser 分配 abs)，返回按行号排序的命中。
   * 运行态 (多行状态机) 由内部 MatchContext 承载。
   */
  match(lines: MudLine[]): PerceptHit[] {
    return this.perceptor.match(lines, this.ctx)
  }

  /** 重置匹配上下文 (多行状态机清空; 连接重建/测试隔离)。 */
  resetContext(): void {
    this.ctx.multiStates.clear()
    this.ctx.multiLastAbs.clear()
  }
}