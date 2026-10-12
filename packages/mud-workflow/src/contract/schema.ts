/**
 * contract/schema — 声明式流程的 JSON 词汇表 + 静态保存门（zod，持久化边界唯一事实源）。
 *
 * **契约层**（A1）：本文件是词汇表与其静态校验的**单点**——引擎侧（core3 流程实体）
 * 与机制侧（内核解释器 / 注册表保存门）都按此书写与校验，不再各写一份。
 * 契约层零 cordis、零宿主、零 I/O。
 *
 * **契约模式（DEC-23，2026-10-12 定稿）**：kind（ok/fail）= 契约——承担判定序
 * （fail 槽先于 ok 槽，同帧 fail 收束）与粗路由缺省（ok → next / fail → timeout
 * 出口）；槽名 = 条目数据——每命令的语料事实，自由命名（命名纪律见 DEC-7：分支
 * 类目化、行文变体进 patterns 不分槽、应对不同才分槽）。判据词汇单点（DEC-21）：
 * 表条目 `resolve` / 流程 `wait` / 工具 `listen` 共用本 schema 的同一形状。
 *
 * 词汇表（T26.6 终态，2026-10-12 全面整改）：
 *   - 读窗 wait：closeOn（三值：ga / criteria / quiet）+ outcomes 槽表 +
 *     captureFrom/captures（捕获）+ count（ga 等第 N 个）+ maxLines/timeoutMs +
 *     flags（多行窗语义，默认无）——until/failOn/quietMs/gaCount 全线退役；
 *   - 动作 action：send | sendCredential | captcha（单动作；凭据占位 {name}/{pass}
 *     与 {captcha} 槽由引擎注入替换，不经模型）；
 *   - 路由 onOutcome（两级，DEC-19）：外层 kind 键直达（ok/fail → 目标，粗粒度
 *     常态）；细化 when（键 ⊆ 合并槽集 + kind 一致、不跨键位查找）；
 *   - 目标 target：goto（后继步）| exit（终结，stage 分类 + ok）。
 *
 * 红线（PLAN「流程面演进」；T13.1 扩列）：sendCredential 与 captcha 动词
 * **只允许 locked 流程使用**——agent 可写词汇表不含这两个动词（粗胚时序错误
 * 会把凭据发进公屏 = 泄露）。注册表 save 侧静态拒绝（usesCredentialVerb）；
 * 引擎执行侧再拦一道（仅 locked 流程可执行这两个动作），见 core/interpreter。
 */

import { z } from 'zod'

// ── 词汇表：收窗形态 + 结局 kind（DEC-3 三值 / DEC-7 kind=契约）────────
//
// closeOn 三值与 kind 二分是**词汇不是数据**（§8.8 契约层单点，DEC-23 分层）：
// 三配方各自封闭，无缺省、无组合自由度（quietMs/gaCount 已随 race/静默收窗退役）。

/**
 * 收窗形态（封闭三值，DEC-3「判定器即形态」2026-10-12 终态）：
 *   - `ga`：GA/EOR 边界收窗（`count` 缺省 1 可设等第 N 个）；分类槽可选——
 *     **声明即断言**：窗口关闭时无一命中 ⇒ fail 路由 +「收窗成功，分支未知」；
 *   - `criteria`：文本判据收窗，GA 不武装（长程命令）；fail 槽先于 ok 槽；
 *   - `quiet`：**固定采样窗**（窗长 = timeoutMs，唯一计时器，行只累积不重置）——
 *     到点关窗：有行 ⇒ ok（返回全部行），零行 ⇒ fail（等同 timeout）。适用于
 *     无明确边界的命令；无 outcomes 槽。注释纪律：quiet 与 timeout 配合使用，
 *     timeout 需谨慎选择时长（编写责任，非设计代价——用户裁定 2026-10-12）。
 */
export const CLOSURE_KINDS = ['ga', 'criteria', 'quiet'] as const
export type ClosureKind = (typeof CLOSURE_KINDS)[number]

/** 结局槽判定（契约）：kind 决定判定序（fail 先于 ok）与粗路由缺省。 */
export const OUTCOME_KINDS = ['ok', 'fail'] as const
export type OutcomeKind = (typeof OUTCOME_KINDS)[number]

/**
 * 保留槽名（DP 审阅裁定 7）：`ok` / `fail` 是 onOutcome 的 kind 寻址键——
 * 槽名与其撞名会产生「槽名路由还是 kind 路由」的歧义，保存门拒存。
 * （`槽N`/`拒N` 合成名随 normalizeFlow 退役不再保留。）
 */
export const RESERVED_SLOT_NAMES: readonly string[] = ['ok', 'fail']

/** 结局槽（DEC-7/DEC-23）：kind = 契约；判据句内联（DEC-20 口径），A.6 语料为准。
 * patterns ≥ 1（DP 审阅 10）：空槽永不命中——ga 形态只会制造「分支未知」假
 * 失败，criteria 形态是死配置；登记槽必给判据，待实录的槽不登记。 */
export interface OutcomeSlot {
  readonly kind: OutcomeKind
  readonly patterns: readonly string[]
}

/** 槽表（DEC-7 终态）：槽名自由（条目数据，命名纪律见决策表 DEC-7）。 */
export type SlotTable = Record<string, OutcomeSlot>

// ── 读窗判据 ────────────────────────────────────────────────────

/**
 * 读窗：进步骤先等（判据满足才动作）。timeoutMs 可省（DEC-5：步声明优先、
 * 表条目填缺省、缝侧兜底 30s——绝不无界等待由缝侧最终保证）。
 */
export const waitSchema = z.object({
  /** 收窗形态（显式单值；缺省 = 未声明判据——缝侧按喂令查表整条注入，DEC-5）。 */
  closeOn: z.enum(CLOSURE_KINDS).optional(),
  /** 结局槽表：键 = 槽名（自由命名，保留字 ok/fail 由 checkFlow 拒）；
   * 值 = kind + 判据句（patterns ≥ 1，推定槽已退役）。 */
  outcomes: z.record(z.string(), z.object({
    kind: z.enum(OUTCOME_KINDS),
    patterns: z.array(z.string().max(512)).min(1).max(8),
  }).strict()).optional(),
  /** 捕获源结局槽（DEC-19）：命中该槽时捕获组按序入 `captures` 声明的 run 级
   * 槽（组数只对该槽 patterns[0] 计；捕获组只允许出现在该处）。 */
  captureFrom: z.string().max(32).optional(),
  /** 捕获槽声明（T14）：组值填到哪些 run 级槽（须与 captureFrom 同声明）。 */
  captures: z.array(z.string().max(32)).max(8).optional(),
  /** GA/EOR 边界计数（仅 ga 形态）：缺省 1，如 2 = 等第 2 个 GA 才关窗。 */
  count: z.number().int().min(1).max(64).optional(),
  /** 行数兜底。 */
  maxLines: z.number().int().min(1).max(500).optional(),
  /** 总超时毫秒（可省——缝侧按「步声明 > 表条目 > 30s 兜底」填充）。 */
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  /** 正则编译 flags（应用于本窗全部槽判据；如 'm' 多行锚）。白名单 `d/i/m/s/u`
   *（`g`/`y` 有状态，跨评估污染起点 ⇒ 拒存）；**默认无**——多行窗行首锚判据
   * 必须显式配 'm'（失活风险由保存门告警④点名，DEC-13）。 */
  flags: z.string().regex(/^[dimsu]*$/).max(4).optional(),
}).strict().superRefine((w, ctx) => {
  // 组合自由度在 schema 层挡死（DEC-3 三配方各自封闭；DP 审阅裁定 1）。
  if (w.closeOn === undefined) {
    if (w.outcomes !== undefined || w.captureFrom !== undefined || w.captures !== undefined || w.count !== undefined) {
      ctx.addIssue({ code: 'custom', message: '判据声明（outcomes/captures/count）必须搭配 closeOn（收窗形态必填）' })
    }
    return
  }
  if (w.closeOn === 'quiet') {
    if (w.outcomes !== undefined || w.captureFrom !== undefined || w.captures !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'quiet 形态无 outcomes 槽（要分类说明写得出判据，那是 criteria 的事）' })
    }
    if (w.count !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'count 仅 ga 形态可用' })
    }
    return
  }
  if (w.closeOn === 'criteria') {
    if (w.count !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'count 仅 ga 形态可用（criteria 下 GA 不武装）' })
    }
    if (w.outcomes === undefined || Object.keys(w.outcomes).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'criteria 形态必须声明 outcomes 槽表（否则只剩超时收场）' })
    }
  }
  // ga：outcomes 可选（未声明 ⇒ 关窗即 next）；count 可选（缺省 1）。
})

export type Wait = z.infer<typeof waitSchema>

// ── 动作 ────────────────────────────────────────────────────────

/**
 * 动作（单动作；sendCredential 与 captcha 仅 locked 流程可用——红线，save/
 * 执行双侧拦）。sendCredential 允许空串：终态空命令（顶开服务端/跳过 MXP
 * 收 GA）走凭据通道以免进发送回显（login 终态步同款）；send 空串无意义故拒绝；
 * captcha 收 url 参数（T14 D9 参数化）——URL 由流程声明捕获槽传入（值先过
 * 解释器 substitute，写死 URL 也允许），抓图/推帧/挂起等码仍由引擎内置。
 */
export const actionSchema = z.union([
  z.object({ send: z.string().min(1).max(256) }).strict(),
  z.object({ sendCredential: z.string().max(256) }).strict(),
  z.object({ captcha: z.object({ url: z.string() }).strict() }).strict(),
])

export type Action = z.infer<typeof actionSchema>

// ── 目标（后继 / 出口）与两级路由 ────────────────────────────────

/** 出口：终结（stage 分类 + ok；'success' 约定 ok=true，校验强制）。 */
export const exitSchema = z.object({
  exit: z.object({
    stage: z.string().min(1).max(32),
    ok: z.boolean(),
  }).strict(),
}).strict()

/** 后继：goto 指定步 id。 */
export const gotoSchema = z.object({
  goto: z.string().min(1).max(32),
}).strict()

/** 目标 = 出口 | 后继。 */
export const targetSchema = z.union([exitSchema, gotoSchema])

export type Exit = z.infer<typeof exitSchema>
export type Goto = z.infer<typeof gotoSchema>
export type Target = z.infer<typeof targetSchema>

/**
 * kind 级路由（DEC-19 两级）：**粗粒度直达是常态**（`fail: { exit… }` 一条兜住
 * 所有 fail 槽）；细化用 `when`——键 = 槽名（⊆ 合并槽集且 kind 一致、**不跨键位
 * 查找**：`ok` 的 when 里只找 ok 槽）；when 未覆盖的槽落 kind 缺省（ok → next /
 * fail → timeout 出口 + 记录）。两种形态互斥（goto/exit 直达 或 when 细化）。
 */
export const kindRouteSchema = z.union([
  targetSchema,
  z.object({ when: z.record(z.string().max(32), targetSchema) }).strict(),
])

export type KindRoute = z.infer<typeof kindRouteSchema>

// ── 步骤 ────────────────────────────────────────────────────────

/** 步骤：读窗 → 动作 → 两级路由（onOutcome）/ 缺省后继（next）。 */
export const stepSchema = z.object({
  /** 步标识（goto 引用用）。 */
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(32),
  /** 读窗（缺省 = 不等待直接动作）。 */
  wait: waitSchema.optional(),
  /** 动作（缺省 = 纯等待步）。 */
  action: actionSchema.optional(),
  /** 两级结局路由（DEC-19）：`ok` / `fail` kind 键 → 直达目标或 when 细化。
   * ok 槽命中未覆盖 ⇒ next；fail 槽命中未覆盖 ⇒ 结构化 timeout 出口 + 记录。 */
  onOutcome: z.object({
    ok: kindRouteSchema.optional(),
    fail: kindRouteSchema.optional(),
  }).strict().optional(),
  /** 缺省后继（ok 未覆盖 / 无命中（GA 关窗无分类）时走）。 */
  next: targetSchema.optional(),
}).strict()

export type Step = z.infer<typeof stepSchema>

// ── 流程 ────────────────────────────────────────────────────────

/** 流程本体：入口步 + 步骤表。 */
export const flowSchema = z.object({
  entry: z.string().min(1).max(32),
  steps: z.array(stepSchema).min(1).max(64),
}).strict()

export type Flow = z.infer<typeof flowSchema>

// ── 存储记录 ────────────────────────────────────────────────────

/** 流程记录（storage 域表 + 管理工具的读写单元）。 */
export const workflowRecordSchema = z.object({
  /** 流程名（工具引用用；locked 预制名 = 受保护名单）。 */
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(32),
  /** 展示名（管理工具列表面）。 */
  title: z.string().min(1).max(64),
  /** true = 锁死（拒改拒删；唯一凭据流程所在）。 */
  locked: z.boolean(),
  /** 修缮版本（save 覆盖时自增）。 */
  version: z.number().int().min(1),
  /** 最后修改（ISO 8601）。 */
  updatedAt: z.string(),
  flow: flowSchema,
}).strict()

export type WorkflowRecord = z.infer<typeof workflowRecordSchema>

// ── 变更账本（T16：只追加的历史/审计）────────────────────────────

/** 快照归档原因：`save`/`delete` = 生效变更留档；`migration` = 迁入冲突的落败方。 */
export type SnapshotReason = 'save' | 'delete' | 'migration'

/**
 * 流程快照（**只追加**账本；键 = `` `${name}:v${version}` ``）。
 *
 * 与 `WorkflowRecord` 同形 + 归档时刻与原因：`version` 沿用被归档记录的版本号，
 * 因此"哪个版本"在历史里唯一可指（回滚动词按 `version` 取）。
 */
export const workflowSnapshotSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(32),
  version: z.number().int().min(1),
  title: z.string().min(1).max(64),
  locked: z.boolean(),
  updatedAt: z.string(),
  flow: flowSchema,
  /** 归档时刻（ISO 8601）。 */
  archivedAt: z.string(),
  reason: z.enum(['save', 'delete', 'migration']),
}).strict()

export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>

// ── 视图（list/get 的生效记录 + 来源标记；纯推导，不落库）──────────

/**
 * 生效来源：由「记录在哪一层」推导，**不进持久化 schema**（故无存量记录兼容问题）——
 *   - `builtin` = 随代码分发的预制（含 locked）；
 *   - `refined` = agent 修缮 / 新建（storage 域，或域不可用时的内存降级层）。
 */
export type WorkflowOrigin = 'builtin' | 'refined'

/**
 * 流程视图：**生效**记录 + 来源 + 被遮蔽的同名修缮。
 *
 * `shadowed` 只在「**locked 内置优先**」时出现：同名修缮仍在存储层（可 `delete`
 * 清理），但读取与执行一律用 locked 内置——locked 的「拒改拒删」在读取/执行侧
 * 同样成立（注册表裁决，§8.11）。
 */
export interface WorkflowEntryView {
  /** 生效记录（执行与 list 呈现用；**as-written**——读时归一已随 DEC-25 退役，
   * 存储即新词汇，解析失败点名（测试期零兼容层）。 */
  readonly record: WorkflowRecord
  /** 生效记录来源。 */
  readonly origin: WorkflowOrigin
  /** 被遮蔽的同名修缮（仅 locked 内置优先时有值；可 delete 清理）。 */
  readonly shadowed?: WorkflowRecord
  /** 视图告警（DEC-13 四处）：不可静态判定的引用等——放行但可见。 */
  readonly warnings?: readonly string[]
}

// ── 结构校验（zod 之外：引用完整性 + 捕获配对 + success 约定）──────

/**
 * 捕获槽保留名（T14 D5/2.2）：`captcha` = 引擎固定单槽，`name`/`pass` = 凭据
 * 占位——三类存储结构性分立，命名槽撞保留名在保存门拒存（不靠运行期判名）。
 */
export const RESERVED_SLOTS: readonly string[] = ['captcha', 'name', 'pass']

/** 命令总表喂令信息（T26.5/26.6）：保存门静态校验的查询面。 */
export interface FlowSlotsInfo {
  /** 条目收窗形态（形态比对用，DEC-5）。 */
  readonly closeOn: ClosureKind
  /** 槽位序列（fail 槽在前 = 判定序；kind 随行——when 键 kind 一致性校验用）。 */
  readonly slots: readonly { readonly name: string; readonly kind: OutcomeKind }[]
  /** 条目级 flags（告警④：合并失活风险点名用）。 */
  readonly flags?: string
}

/**
 * 命令总表槽名查询端口（T26.5）：命令命中总表条目时返回其喂令信息，未登记
 * 返回 null。core3 `tableSlotsOf` 按此实现，注册表经 `setSlotsOf` 注入——
 * checkFlow 据此把 when/captureFrom 的引用对到「本步 outcomes ∪ 喂令表槽」
 * 的合并槽集上（**仅字面量命令**；动态命令保存期只校验 kind 一致性，查表
 * 校验整体后移运行期——DP 审阅裁定 4）。
 */
export type FlowSlotsPort = (command: string) => FlowSlotsInfo | null

/**
 * 静态计组（T14 2.3）：`new RegExp(source + '|')` 在空串上必走末尾空分支，
 * exec 结果长度 - 1 = 捕获组数。源非法会 throw（调用方给可读上下文）。
 */
function countGroups(source: string): number {
  return new RegExp(`${source}|`).exec('')!.length - 1
}

/**
 * 喂令静态解析：数组序上最近的前置 send 动作（wait 先于动作执行，本窗分类的
 * 是此前发送的应答）；sendCredential 不查表（缝侧 lastSent 置 null）不算喂令。
 * 无前置 send 返回 null。
 */
function staticSendBefore(steps: readonly Step[], si: number): string | null {
  for (let i = si - 1; i >= 0; i--) {
    const a = steps[i]?.action
    if (a !== undefined && 'send' in a) return a.send
  }
  return null
}

/** when 细化键收集（两级路由的引用面）。 */
function whenKeys(route: KindRoute | undefined): readonly string[] {
  if (route === undefined || !('when' in route)) return []
  return Object.keys(route.when)
}

/**
 * 流程结构校验（schema 校验通过后调用；registry.save 与引擎执行共用——
 * 校验是确定性的，生效门 = 校验即生效）：
 *   - 步 id 不重复；entry 存在；goto 目标存在；stage 'success' 必须 ok:true；
 *   - 保留字槽名（ok/fail——kind 寻址键）拒存；判据可编译；
 *   - 捕获配对（captures ↔ captureFrom 同声明；组数只对 captureFrom 槽
 *     patterns[0] 计，捕获组只允许出现在该处）；
 *   - **when 键校验（DP 裁定 4 分档）**：字面量喂令（经 slotsOf 端口可判）⇒
 *     键 ⊆ 合并槽集（本步 outcomes ∪ 表槽）+ kind 一致，违者拒存；动态命令
 *     （头部含槽替换）⇒ 保存期只校验静态可判的 kind 一致性（引用本步自声明
 *     槽的键按其声明 kind 判），查表校验整体后移运行期 fail-loud；
 *   - 告警档（DEC-13，放行但可见）：① 喂令字面量未登记表且本步未声明收窗；
 *     ② when 未覆盖合并槽集内同 kind 槽（点名补全）；④ 同形态合并引入带
 *     flags 的表条目而本步未声明 flags（锚定判据失活风险）。
 *
 * @param flow - 待校验流程本体。
 * @param slotsOf - 命令总表槽名查询（缺省 = 无端口，喂令相关引用一律放行）。
 * @returns 告警列表（DEC-13 档：放行但必须可见；结构性非法直接 throw）。
 * @throws 可读错（保存/执行转可读拒绝）。
 */
export function checkFlow(flow: Flow, slotsOf?: FlowSlotsPort): string[] {
  const warnings: string[] = []
  const ids = new Set(flow.steps.map(s => s.id))
  if (ids.size !== flow.steps.length) {
    throw new Error('流程结构非法：步 id 重复')
  }
  if (!ids.has(flow.entry)) {
    throw new Error(`流程结构非法：入口步不存在：${flow.entry}`)
  }
  const structural = (msg: string): never => {
    throw new Error(`流程结构非法：${msg}`)
  }
  const checkT = (stepId: string, where: string, t: Target): void => {
    if ('goto' in t && !ids.has(t.goto)) {
      structural(`步骤 ${stepId} 的${where}指向不存在的步：${t.goto}`)
    }
    if ('exit' in t && t.exit.stage === 'success' && !t.exit.ok) {
      structural(`步骤 ${stepId} 的${where}把出口 stage 'success' 标成 ok:false`)
    }
  }
  const checkCaptureNames = (stepId: string, captures: readonly string[]): void => {
    for (const name of captures) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        structural(`步骤 ${stepId} 的捕获槽名非法：${name}（只允许字母/数字/下划线）`)
      }
      if (RESERVED_SLOTS.includes(name)) {
        structural(`步骤 ${stepId} 的捕获槽名是保留名：${name}`)
      }
    }
  }
  for (let si = 0; si < flow.steps.length; si++) {
    const step = flow.steps[si]!
    if (step.next !== undefined) checkT(step.id, '缺省后继 next', step.next)
    // 两级路由目标校验（直达 + when 细化全量）。
    const okRoute = step.onOutcome?.ok
    const failRoute = step.onOutcome?.fail
    if (okRoute !== undefined) {
      if ('when' in okRoute) {
        for (const [k, t] of Object.entries(okRoute.when)) checkT(step.id, `onOutcome.ok.when[${k}]`, t)
      } else {
        checkT(step.id, 'onOutcome.ok', okRoute)
      }
    }
    if (failRoute !== undefined) {
      if ('when' in failRoute) {
        for (const [k, t] of Object.entries(failRoute.when)) checkT(step.id, `onOutcome.fail.when[${k}]`, t)
      } else {
        checkT(step.id, 'onOutcome.fail', failRoute)
      }
    }

    const wait = step.wait
    if (wait === undefined) continue
    const outcomes = wait.outcomes ?? {}
    const outcomeKeys = Object.keys(outcomes)
    const ownKind = new Map(outcomeKeys.map(k => [k, outcomes[k]!.kind]))

    // 槽表形状：保留字 + 判据可编译（patterns ≥ 1 已由 schema 保证）。
    for (const k of outcomeKeys) {
      if (RESERVED_SLOT_NAMES.includes(k)) {
        structural(`步骤 ${step.id} 的结局槽名是保留字：${k}（ok/fail 是 kind 寻址键）`)
      }
      for (const p of outcomes[k]!.patterns) {
        try {
          new RegExp(p)
        } catch (e) {
          structural(`步骤 ${step.id} 的槽「${k}」判据正则非法：${p}（${(e as Error).message}）`)
        }
      }
    }

    // 捕获配对与组数（组数只对 captureFrom 槽 patterns[0] 计；捕获组只许在该处）。
    if (wait.captureFrom !== undefined) {
      const captures = wait.captures ?? []
      if (captures.length === 0) {
        structural(`步骤 ${step.id} 声明了 captureFrom 但没有 captures 槽名表（组值无处填）`)
      }
      checkCaptureNames(step.id, captures)
      const own = outcomes[wait.captureFrom]
      if (own !== undefined) {
        let declared: number
        try {
          declared = countGroups(own.patterns[0]!)
        } catch (e) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的 captureFrom 槽「${wait.captureFrom}」判据正则非法：${own.patterns[0]}（${(e as Error).message}）`)
        }
        if (declared < captures.length) {
          structural(`步骤 ${step.id} 的 captureFrom 槽首判据捕获组 ${declared} 个，少于 captures 声明的 ${captures.length} 个`)
        }
        const stray = [
          ...own.patterns.slice(1),
          ...outcomeKeys.filter(k => k !== wait.captureFrom).flatMap(k => outcomes[k]!.patterns),
        ].find(p => countGroups(p) > 0)
        if (stray !== undefined) {
          structural(`步骤 ${step.id} 存在 captureFrom 槽首判据之外的捕获组（只允许出现在 captureFrom 槽 patterns[0]）：${stray}`)
        }
      }
      // captureFrom 引用本步未声明的槽 ⇒ 可能来自喂令表槽（组数校验运行期 D11 兜底）。
    }
    if (wait.captures !== undefined && wait.captureFrom === undefined) {
      structural(`步骤 ${step.id} 声明了 captures 但没有 captureFrom（捕获以结局槽为源）`)
    }

    // ── 喂令静态分析（when 键校验 + DEC-13 告警）─────────────────
    const cmd = staticSendBefore(flow.steps, si)
    const dynamic = cmd !== null && cmd.includes('{')
    const info = slotsOf !== undefined && cmd !== null && !dynamic ? slotsOf(cmd) : undefined
    // 槽 kind 解析：本步声明优先，字面量喂令的表槽次之（动态/未登记 ⇒ 不可判）。
    const kindOf = (name: string): OutcomeKind | undefined =>
      ownKind.get(name) ?? info?.slots.find(s => s.name === name)?.kind
    const allRefs = [...whenKeys(okRoute), ...whenKeys(failRoute)]
    const refNames = [...allRefs, ...(wait.captureFrom !== undefined ? [wait.captureFrom] : [])]

    // kind 一致性（静态可判的都判——不跨键位查找，DP 裁定 4 保存期职责）。
    for (const [label, route] of [['ok', okRoute], ['fail', failRoute]] as const) {
      for (const k of whenKeys(route)) {
        const kind = kindOf(k)
        if (kind !== undefined && kind !== label) {
          structural(`步骤 ${step.id} 的 onOutcome.${label}.when[${k}] 引用了 ${kind} 槽（不跨键位查找：${label} 键下只找 ${label} 槽）`)
        }
      }
    }

    if (info != null) {
      // 字面量已登记：引用 ⊆ 合并槽集（本步 outcomes ∪ 表槽），缺席 = 死引用拒存。
      const merged = new Set(outcomeKeys)
      const kindMap = new Map<string, OutcomeKind>()
      for (const k of outcomeKeys) kindMap.set(k, ownKind.get(k)!)
      for (const s of info.slots) {
        merged.add(s.name)
        if (!kindMap.has(s.name)) kindMap.set(s.name, s.kind)
      }
      const missing = refNames.filter(r => !merged.has(r))
      if (missing.length > 0) {
        structural(`步骤 ${step.id} 的结局引用超喂令 ${cmd}（表条目）的槽集：${missing.join('、')}`)
      }
      // 告警②：when 未覆盖同 kind 槽（直达形态 = 全覆盖，不告警）。
      const okCovered = new Set(whenKeys(okRoute))
      const failCovered = new Set(whenKeys(failRoute))
      if (okRoute !== undefined && 'when' in okRoute) {
        const uncovered = [...merged].filter(n => kindMap.get(n) === 'ok' && !okCovered.has(n))
        if (uncovered.length > 0) {
          warnings.push(`步骤 ${step.id} 的 onOutcome.ok.when 未覆盖 ok 槽：${uncovered.join('、')}——未覆盖落缺省 next（需分支请补全）`)
        }
      }
      if (failRoute !== undefined && 'when' in failRoute) {
        const uncovered = [...merged].filter(n => kindMap.get(n) === 'fail' && !failCovered.has(n))
        if (uncovered.length > 0) {
          warnings.push(`步骤 ${step.id} 的 onOutcome.fail.when 未覆盖 fail 槽：${uncovered.join('、')}——未覆盖落 timeout 出口并记录（需分支请补全）`)
        }
      }
      // 告警④：同形态合并引入带 flags 的表条目而本步未声明 flags（锚定判据失活）。
      if (wait.closeOn !== undefined && info.closeOn === wait.closeOn
        && info.flags !== undefined && wait.flags === undefined) {
        warnings.push(`步骤 ${step.id} 同形态合并表条目 ${cmd}（条目 flags '${info.flags}'）而本步未声明 flags——表槽锚定判据（^）按默认编译可能在多行窗失活，请显式声明 flags`)
      }
    } else {
      // 未登记 / 动态 / 无喂令 / 无端口：
      if (wait.closeOn === undefined) {
        // 告警①：未声明收窗 + 喂令不可走表 ⇒ 不收窗只等超时（动态喂令运行期仍可能注入，不告警）。
        if (cmd === null) {
          warnings.push(`步骤 ${step.id} 未声明收窗且无喂令（首步或凭据动作后）——本窗不收窗只等超时（DEC-4），请显式声明 closeOn`)
        } else if (!dynamic) {
          warnings.push(`步骤 ${step.id} 未声明收窗且喂令「${cmd}」未登记命令总表——本窗不收窗只等超时（DEC-4），请显式声明 closeOn 或登记条目`)
        }
      } else if (refNames.length > 0) {
        const unknown = refNames.filter(r => !ownKind.has(r))
        if (unknown.length > 0 && cmd !== null && !dynamic) {
          warnings.push(`步骤 ${step.id} 的结局引用 ${unknown.join('、')} 不在本步声明且喂令「${cmd}」未登记——保存放行，运行期按实际分类路由`)
        }
      }
    }
  }
  return warnings
}

/**
 * 流程是否使用 locked-only 动词（红线判定：agent 可写词汇表不含
 * sendCredential/captcha——registry.save 静态拒绝；引擎执行侧对非 locked
 * 流程再拦一道）。
 */
export function usesCredentialVerb(flow: Flow): boolean {
  return flow.steps.some((s) => {
    if (s.action === undefined) return false
    return 'sendCredential' in s.action || 'captcha' in s.action
  })
}
