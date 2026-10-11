/**
 * contract/schema — 声明式流程的 JSON 词汇表 + 静态保存门（zod，持久化边界唯一事实源）。
 *
 * **契约层**（A1）：本文件是词汇表与其静态校验的**单点**——引擎侧（core3 流程实体）
 * 与机制侧（内核解释器 / 注册表保存门）都按此书写与校验，不再各写一份。
 * 契约层零 cordis、零宿主、零 I/O。
 *
 * 流程本体 = JSON 步骤表（非脚本文本），与 login.md 流程表
 *（driver/action/settle/classify/next）同构——login.ts 手写解释器的表化。
 * JSON 无任意代码，schema + 词汇表白名单 = 静态可验证的安全；无沙箱。
 *
 * 词汇表（从 login 提炼，够用再长；循环/计算/条件后置）：
 *   - 读窗 wait：until/failOn（字符串正则源，解释器编译）+ captures（T14 捕获槽）
 *     + gaCount/quietMs/maxLines/timeoutMs（必填——绝不无界等待，read.ts 语义）；
 *   - 动作 action：send | sendCredential | captcha（单动作；凭据占位 {name}/{pass}
 *     与 {captcha} 槽由引擎注入替换，不经模型）；
 *   - 分支 branch：until 命中序（index）→ 后继目标；onFailOn：failOn 命中序
 *     → 分类出口；next：缺省后继；
 *   - 目标 target：goto（后继步）| exit（终结，stage 分类 + ok）。
 *
 * 红线（PLAN「流程面演进」；T13.1 扩列）：sendCredential 与 captcha 动词
 * **只允许 locked 流程使用**——agent 可写词汇表不含这两个动词（粗胚时序错误
 * 会把凭据发进公屏 = 泄露）。注册表 save 侧静态拒绝（usesCredentialVerb）；
 * 引擎执行侧再拦一道（仅 locked 流程可执行这两个动作），见 core/interpreter。
 */

import { z } from 'zod'

// ── 词汇表：收窗形态 + 结局槽（T26；枚举单点，DEC-3/DEC-7/DEC-17）────
//
// 两个枚举都是**词汇表不是数据**（§8.8 契约层单点）：core3 命令条目的判定器
// 只能把正则挂到枚举成员上；流程 wait / onOutcome 按名引用同样受此约束。

/**
 * 收窗形态（封闭四值，DEC-3「判定器即形态」）：四配方各自封闭，无缺省、
 * 无组合自由度——
 *   - `ga`：GA/EOR 边界收窗，槽仅分类（即时命令）；
 *   - `criteria`：文本判据收窗，GA 不武装（长程命令）；
 *   - `race`：判据与静默竞速，先到者收窗（walk）；
 *   - `quiet`：纯静默收窗（无判据无 GA 的命令；滤波随 LM 实录后置，DEC-14）。
 */
export const CLOSURE_KINDS = ['ga', 'criteria', 'race', 'quiet'] as const
export type ClosureKind = (typeof CLOSURE_KINDS)[number]

/** 结局槽判定：kind 决定分流序（fail 先于 ok，对应现役判定序 failOn > until）。 */
export const OUTCOME_KINDS = ['ok', 'fail'] as const
export type OutcomeKind = (typeof OUTCOME_KINDS)[number]

/**
 * 结局枚举（DEC-17）：语义级成员，**只增不删**（同 §0.2「章节号永不复用」精神）；
 * 成员资格由「流程真的需要分支什么」驱动，不由游戏输出形态数量驱动。新增成员 =
 * 所有条目的槽集合自动扩展且默认缺席 ⇒ 纯加性（DEC-7）。
 */
export const OUTCOME_NAMES = [
  // 修炼族（dz/sleep；A.3）
  '完成', '突破', '收尾', '内息不足', '精神不足', '刚睡过',
  // 行走（walk；A.9）
  '到达', '软阻断', '推定完成',
  // 拜师（bai；示例条目，实录后回填）
  '拜师成功', '前置不足',
  // 登录流程（login）
  '名字提示', '密码提示', '需替换', '需建新人物', '密码错误', '登录成功',
  // 验证码流程（fullme）
  '验证码地址', '已挂起', '冷却中', '答对', '答错', '失效',
] as const
export type OutcomeName = (typeof OUTCOME_NAMES)[number]

/** 结局槽：判据句内联（DEC-20 撤销共享常量后的口径）；`patterns: []` = 推定槽
 *（由静默机制填，DEC-5 强度分级——静默是推定，不证明结局）。 */
export interface OutcomeSlot {
  readonly kind: OutcomeKind
  readonly patterns: readonly string[]
}

/** 槽表（DEC-7 修订）：Partial——缺席 = 该命令/窗口不支持此结局；流程引用缺席槽 ⇒ 报错。 */
export type SlotTable = { readonly [K in OutcomeName]?: OutcomeSlot }

// ── 读窗判据 ────────────────────────────────────────────────────

/** 读窗：进步骤先等（判据满足才动作）；timeoutMs 必填（绝不无界等待）。 */
export const waitSchema = z.object({
  /** 完成判据（正则源；在累积文本上测，可跨批命中——read.ts 语义）。 */
  until: z.array(z.string()).max(8).optional(),
  /** 捕获槽声明（T14）：until[0] 命中行的捕获组按序入 run 级命名槽（组 1 →
   * captures[0]…）；槽名校验与组数界内由 checkFlow 把关，此处只收形状。 */
  captures: z.array(z.string()).max(8).optional(),
  /** 负面判据（正则源；命中即 failOn 收束，优先于 until）。 */
  failOn: z.array(z.string()).max(8).optional(),
  /** 收窗形态（T26，§3.10）：显式声明时判据由 `outcomes` 槽表派生，`until`/
   * `failOn` 不参与判定（新旧词汇混用 = 结构非法，checkFlow 拒存）。缺省 =
   * 遗留判据形态（until/failOn 系；读时经 normalizeFlow 归一为槽表，不落库）。 */
  closeOn: z.enum(CLOSURE_KINDS).optional(),
  /** 结局槽表（T26）：键 = 结局名（枚举成员；宽松 string 由 checkFlow 校验
   * 资格——合成槽名 槽N/拒N 仅存在于归一产物），值 = 判定 + 判据句。
   * `patterns: []` = 推定槽（由静默机制填，仅允许出现在 race/quiet 形态）。 */
  outcomes: z.record(z.string(), z.object({
    kind: z.enum(OUTCOME_KINDS),
    patterns: z.array(z.string()).max(8),
  }).strict()).optional(),
  /** 捕获源结局槽（T26）：组值从该槽 patterns[0] 的捕获组提取，按序入
   * `captures` 声明的 run 级槽（captures 继续承担"组值填到哪些 run 槽"）；
   * 组数只对 captureFrom 槽计（对齐 legacy 组数只对 until[0] 计的纪律）。 */
  captureFrom: z.string().optional(),
  /** GA/EOR 边界计数关窗。 */
  gaCount: z.number().int().min(1).max(64).optional(),
  /** 行间静默毫秒。 */
  quietMs: z.number().int().min(1).max(60_000).optional(),
  /** 行数兜底。 */
  maxLines: z.number().int().min(1).max(500).optional(),
  /** 总超时毫秒（必填；到点以 timeout 收束）。 */
  timeoutMs: z.number().int().min(1).max(600_000),
  /** 正则编译 flags（应用于本窗 until+failOn 全部判据；如 'm' 多行锚——login 的 failOn）。
   * 白名单 `d/i/m/s/u`：`g`/`y` 是**有状态**标志（读窗机逐行评估时起点由 `lastIndex`
   * 决定，`y` 还要求"正好落在 `lastIndex` 处"），对单次 `exec` 无意义或只改变锚定
   * 起点 ⇒ 保存门拒存（T16；读窗机的 `lastIndex` 重置见 §5.2）。 */
  flags: z.string().regex(/^[dimsu]*$/).max(4).optional(),
}).strict()

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

// ── 目标（后继 / 出口）──────────────────────────────────────────

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

// ── 步骤 ────────────────────────────────────────────────────────

/** 步骤：读窗 → 动作 → 按命中序分支（branch/onFailOn）/ 缺省后继（next）。 */
export const stepSchema = z.object({
  /** 步标识（goto 引用用）。 */
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(32),
  /** 读窗（缺省 = 不等待直接动作）。 */
  wait: waitSchema.optional(),
  /** 动作（缺省 = 纯等待步）。 */
  action: actionSchema.optional(),
  /** failOn 命中序（index → 目标）；缺省 = timeout 出口（ok:false）。 */
  onFailOn: z.record(z.string().regex(/^\d+$/), targetSchema).optional(),
  /** until 命中序（index → 目标）；未覆盖的 index 走 next。 */
  branch: z.array(targetSchema).optional(),
  /** 结局路由（T26 新格式）：结局槽名 → 目标。fail 槽未覆盖 → timeout 出口、
   * ok 槽未覆盖 / 无命中 → next。与 branch/onFailOn 混用 = 结构非法。 */
  onOutcome: z.record(z.string(), targetSchema).optional(),
  /** 缺省后继（until 未覆盖分支 / 无 branch 时走）。 */
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
  /** 生效记录（执行与 list 呈现用；**读时已归一**——遗留 until/failOn 系步骤
   * 经 normalizeFlow 转为 closeOn/outcomes 槽表形态，agent 经 get 看到新词汇）。 */
  readonly record: WorkflowRecord
  /** 生效记录来源。 */
  readonly origin: WorkflowOrigin
  /** 被遮蔽的同名修缮（仅 locked 内置优先时有值；可 delete 清理）。 */
  readonly shadowed?: WorkflowRecord
  /** 视图告警（T26）：归一后经端口复核仍无法静态判定的结局引用等——放行但可见。 */
  readonly warnings?: readonly string[]
}

// ── 结构校验（zod 之外：引用完整性 + 命中序界内 + success 约定）────

/**
 * 捕获槽保留名（T14 D5/2.2）：`captcha` = 引擎固定单槽，`name`/`pass` = 凭据
 * 占位——三类存储结构性分立，命名槽撞保留名在保存门拒存（不靠运行期判名）。
 */
export const RESERVED_SLOTS: readonly string[] = ['captcha', 'name', 'pass']

/**
 * 命令总表槽名查询端口（T26.5）：命令命中总表条目时返回其槽名序列（fail 槽
 * 在前 = 判定序），未登记返回 null。core3 `tableSlotsOf` 按此实现，注册表经
 * `setSlotsOf` 注入——checkFlow 据此把 onOutcome/captureFrom 的引用对到
 * 「本步 outcomes ∪ 喂令表槽」的合并槽集上。
 */
export type FlowSlotsPort = (command: string) => readonly string[] | null

/** 合成槽名（normalizeFlow 产物：until[i] → `槽{i+1}`、failOn[j] → `拒{j+1}`）。
 * 不在 OUTCOME_NAMES 枚举内，但是合法 outcomes 键（归一只在运行期发生不落库；
 * 放行合成名让归一产物可再次过视图校验）。 */
export const SYNTHETIC_SLOT_RE = /^(?:槽|拒)\d+$/

const OUTCOME_KEY_SET: ReadonlySet<string> = new Set<string>(OUTCOME_NAMES)

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
 * 无前置 send 返回 null（端口校验不可判定 → 告警放行）。
 */
function staticSendBefore(steps: readonly Step[], si: number): string | null {
  for (let i = si - 1; i >= 0; i--) {
    const a = steps[i]?.action
    if (a !== undefined && 'send' in a) return a.send
  }
  return null
}

/**
 * 流程结构校验（schema 校验通过后调用；registry.save 与引擎执行共用——
 * 校验是确定性的，生效门 = 校验即生效）：
 *   - 步 id 不重复；entry 存在；
 *   - goto 目标必须存在；
 *   - **新旧词汇互斥**（T26）：wait 的 until/failOn 系与 closeOn/outcomes/
 *     captureFrom 系不得混用；路由的 branch/onFailOn 与 onOutcome 不得混用；
 *   - legacy 步（until/failOn 系）：onFailOn 的 index 必须 < failOn 长度；
 *     branch 长度必须 ≤ until 长度；captures 声明四校验（T14，组数只对
 *     until[0] 计）；
 *   - 新格式步（closeOn/outcomes 系，T26）：outcomes 键枚举资格（合成名放行）；
 *     推定槽（patterns: []）仅 race/quiet；criteria/race 必须有非空判据槽；
 *     race/quiet 必须显式 quietMs（流程自足，无表基线可借）；outcomes/
 *     captureFrom 必须搭配 closeOn（缺省形态 = 判据不参与判定，死配置）；
 *     captureFrom 需与 captures 同声明且组数只对该槽 patterns[0] 计、捕获组
 *     只允许出现在该处；onOutcome/captureFrom ⊆ 合并槽集（本步 outcomes ∪
 *     喂令表槽——喂令静态可判且已登记时缺席 = 拒存，不可判定 = 告警放行，
 *     运行期按实际分类路由）；
 *   - stage 'success' 必须 ok:true（防粗胚把失败标成 success）。
 *
 * @param flow - 待校验流程本体（as-written；遗留步不在此归一）。
 * @param slotsOf - 命令总表槽名查询（缺省 = 无端口，喂令相关引用一律告警放行）。
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
  const checkCaptureNames = (stepId: string, captures: readonly string[]): void => {
    for (const name of captures) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new Error(`流程结构非法：步骤 ${stepId} 的捕获槽名非法：${name}（只允许字母/数字/下划线）`)
      }
      if (RESERVED_SLOTS.includes(name)) {
        throw new Error(`流程结构非法：步骤 ${stepId} 的捕获槽名是保留名：${name}`)
      }
    }
  }
  for (let si = 0; si < flow.steps.length; si++) {
    const step = flow.steps[si]!
    const checkTarget = (where: string, t: Target): void => {
      if ('goto' in t && !ids.has(t.goto)) {
        throw new Error(`流程结构非法：步骤 ${step.id} 的${where}指向不存在的步：${t.goto}`)
      }
      if ('exit' in t && t.exit.stage === 'success' && !t.exit.ok) {
        throw new Error(`流程结构非法：步骤 ${step.id} 的${where}把出口 stage 'success' 标成 ok:false`)
      }
    }
    if (step.next !== undefined) checkTarget('缺省后继 next', step.next)
    const wait = step.wait
    const hasLegacyCriteria = wait !== undefined
      && (wait.until !== undefined || wait.failOn !== undefined
        // captures-only（无 until/failOn 也无新词汇）仍按 legacy 校验——
        // captures 声明必须配 until 判据（T14 纪律）。
        || (wait.captures !== undefined && wait.closeOn === undefined && wait.captureFrom === undefined))
    const hasNewVocab = (wait !== undefined
      && (wait.closeOn !== undefined || wait.outcomes !== undefined || wait.captureFrom !== undefined))
      || step.onOutcome !== undefined
    if (hasLegacyCriteria && hasNewVocab) {
      throw new Error(`流程结构非法：步骤 ${step.id} 混用新旧判据词汇（until/failOn 系与 closeOn/outcomes/captureFrom 系互斥）`)
    }
    if (step.onOutcome !== undefined && (step.branch !== undefined || step.onFailOn !== undefined)) {
      throw new Error(`流程结构非法：步骤 ${step.id} 混用新旧路由词汇（onOutcome 与 branch/onFailOn 互斥）`)
    }
    if (hasLegacyCriteria) {
      if (step.onFailOn !== undefined) {
        const failOnLen = wait?.failOn?.length ?? 0
        for (const [k, t] of Object.entries(step.onFailOn)) {
          if (Number(k) >= failOnLen) {
            throw new Error(`流程结构非法：步骤 ${step.id} 的 onFailOn[${k}] 越界（failOn 只有 ${failOnLen} 条）`)
          }
          checkTarget(`onFailOn[${k}]`, t)
        }
      }
      if (wait?.captures !== undefined) {
        const captures = wait.captures
        const until = wait.until ?? []
        if (until.length === 0) {
          throw new Error(`流程结构非法：步骤 ${step.id} 声明了 captures 但没有 until 判据`)
        }
        checkCaptureNames(step.id, captures)
        // 组数只对 until[0] 计（D10：捕获与路由同源）；源非法在此 throw 可读错。
        let declared: number
        try {
          declared = countGroups(until[0]!)
        } catch {
          throw new Error(`流程结构非法：步骤 ${step.id} 的 until[0] 正则非法：${until[0]}`)
        }
        if (declared < captures.length) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的 until[0] 捕获组 ${declared} 个，少于 captures 声明的 ${captures.length} 个`)
        }
        for (let i = 1; i < until.length; i++) {
          if (countGroups(until[i]!) > 0) {
            throw new Error(`流程结构非法：步骤 ${step.id} 的 until[${i}] 含捕获组（捕获组只允许出现在 until[0]）`)
          }
        }
      }
      if (step.branch !== undefined) {
        const untilLen = wait?.until?.length ?? 0
        if (step.branch.length > untilLen) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的 branch 长度 ${step.branch.length} 超过 until 数 ${untilLen}`)
        }
        step.branch.forEach((t, i) => checkTarget(`branch[${i}]`, t))
      }
    } else if (hasNewVocab) {
      const outcomes = wait?.outcomes ?? {}
      const outcomeKeys = Object.keys(outcomes)
      const closeOn = wait?.closeOn
      // ① outcomes/captureFrom 必须搭配 closeOn（缺省形态下槽表不参与判定 = 死配置，
      //    且缝侧查表注入按 closeOn 缺省放行会与槽表相撞）。
      if (closeOn === undefined && (wait?.outcomes !== undefined || wait?.captureFrom !== undefined)) {
        throw new Error(`流程结构非法：步骤 ${step.id} 声明了 outcomes/captureFrom 但缺 closeOn（收窗形态必填）`)
      }
      // ② 槽表形状：键枚举资格（合成名放行）；判据可编译；推定槽仅 race/quiet。
      for (const k of outcomeKeys) {
        if (!OUTCOME_KEY_SET.has(k) && !SYNTHETIC_SLOT_RE.test(k)) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的结局槽名不在枚举内：${k}（OUTCOME_NAMES 之外只允许合成名 槽N/拒N）`)
        }
        for (const p of outcomes[k]!.patterns) {
          try {
            new RegExp(p)
          } catch (e) {
            throw new Error(`流程结构非法：步骤 ${step.id} 的槽「${k}」判据正则非法：${p}（${(e as Error).message}）`)
          }
        }
        if (outcomes[k]!.patterns.length === 0 && closeOn !== 'race' && closeOn !== 'quiet') {
          throw new Error(`流程结构非法：步骤 ${step.id} 的槽「${k}」patterns 为空（推定槽只允许出现在 race/quiet 形态）`)
        }
      }
      // ③ 形态参数：criteria/race 必须有非空判据槽（否则只剩超时收场）；
      //    race/quiet 必须显式 quietMs（流程自足声明，无表基线可借）。
      if ((closeOn === 'criteria' || closeOn === 'race')
        && !outcomeKeys.some(k => outcomes[k]!.patterns.length > 0)) {
        throw new Error(`流程结构非法：步骤 ${step.id}（${closeOn}）没有任何非空判据槽`)
      }
      if ((closeOn === 'race' || closeOn === 'quiet') && wait?.quietMs === undefined) {
        throw new Error(`流程结构非法：步骤 ${step.id}（${closeOn}）缺 quietMs（形态参数必填，流程自足无表基线）`)
      }
      // ④ 捕获配对与组数：captures 需与 captureFrom 同声明（新格式下组值提取
      //    以 captureFrom 槽为源）；组数只对 captureFrom 槽 patterns[0] 计，
      //    捕获组只允许出现在该处（对齐 legacy until[0] 纪律）。
      if (wait?.captureFrom !== undefined) {
        const captures = wait.captures ?? []
        if (captures.length === 0) {
          throw new Error(`流程结构非法：步骤 ${step.id} 声明了 captureFrom 但没有 captures 槽名表（组值无处填）`)
        }
        checkCaptureNames(step.id, captures)
        const own = outcomes[wait.captureFrom]
        if (own !== undefined) {
          if (own.patterns.length === 0) {
            throw new Error(`流程结构非法：步骤 ${step.id} 的 captureFrom 槽「${wait.captureFrom}」无判据（推定槽不可捕获）`)
          }
          let declared: number
          try {
            declared = countGroups(own.patterns[0]!)
          } catch {
            throw new Error(`流程结构非法：步骤 ${step.id} 的 captureFrom 槽「${wait.captureFrom}」判据正则非法：${own.patterns[0]}`)
          }
          if (declared < captures.length) {
            throw new Error(`流程结构非法：步骤 ${step.id} 的 captureFrom 槽首判据捕获组 ${declared} 个，少于 captures 声明的 ${captures.length} 个`)
          }
          const stray = [
            ...own.patterns.slice(1),
            ...outcomeKeys.filter(k => k !== wait.captureFrom).flatMap(k => outcomes[k]!.patterns),
          ].find(p => countGroups(p) > 0)
          if (stray !== undefined) {
            throw new Error(`流程结构非法：步骤 ${step.id} 存在 captureFrom 槽首判据之外的捕获组（只允许出现在 captureFrom 槽 patterns[0]）：${stray}`)
          }
        }
      }
      if (wait?.captures !== undefined && wait.captureFrom === undefined) {
        throw new Error(`流程结构非法：步骤 ${step.id} 声明了 captures 但没有 captureFrom（新格式捕获以结局槽为源）`)
      }
      // ⑤ onOutcome 目标 + onOutcome/captureFrom ⊆ 合并槽集（本步 outcomes ∪
      //    喂令表槽）。喂令静态可判且已登记 ⇒ 缺席 = 死引用拒存；不可判定
      //    （无端口/无前置 send/动态命令/喂令未登记）⇒ 告警放行，运行期兜底。
      if (step.onOutcome !== undefined) {
        for (const [k, t] of Object.entries(step.onOutcome)) checkTarget(`onOutcome[${k}]`, t)
      }
      const refs = [
        ...(step.onOutcome !== undefined ? Object.keys(step.onOutcome) : []),
        ...(wait?.captureFrom !== undefined ? [wait.captureFrom] : []),
      ]
      if (refs.length > 0) {
        const cmd = staticSendBefore(flow.steps, si)
        const dynamic = cmd !== null && cmd.includes('{')
        const portSlots = slotsOf !== undefined && cmd !== null && !dynamic ? slotsOf(cmd) : undefined
        const merged = new Set([...outcomeKeys, ...(portSlots ?? [])])
        const missing = refs.filter(r => !merged.has(r))
        if (missing.length > 0 && (portSlots !== undefined && portSlots !== null)) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的结局引用超喂令 ${cmd}（表条目）的槽集：${missing.join('、')}`)
        }
        if (missing.length > 0 && !dynamic) {
          warnings.push(
            `步骤 ${step.id} 的结局引用无法静态判定（${missing.join('、')}）：喂令`
            + `${cmd === null ? '不存在（本窗分类的是流程外的历史发送）' : '未登记命令总表'}`
            + '——保存放行，运行期按实际分类路由',
          )
        }
        // 动态喂令（含 '{'）：槽替换后才知道命令，保存期跳过（运行期拦）。
      }
    }
  }
  return warnings
}

/**
 * 读时归一（T26.6，§3.10）：把遗留 until/failOn 系步骤转为新格式槽表形态——
 *   - until[i] → 槽 `槽{i+1}`（ok）；failOn[j] → 槽 `拒{j+1}`（fail）；
 *     closeOn = 'criteria'（fail 槽排前 = 判定序）；
 *   - branch[i] → onOutcome[`槽{i+1}`]；onFailOn[j] → onOutcome[`拒{j+1}`]；
 *   - captures → captureFrom '槽1'（captures 保留，继续承担 run 槽名表）；
 *   - gaCount/quietMs/maxLines/flags/timeoutMs 原样保留。
 * 只归一 until/failOn 系步骤（gaCount-only / quietMs-only 的 wait 保持 legacy
 * 字段透传）；新格式步幂等原样。**纯函数、不落库**——归一发生在视图/执行读取
 * 侧，存储与 save 输入仍接受两种词汇。
 */
export function normalizeFlow(flow: Flow): Flow {
  return {
    entry: flow.entry,
    steps: flow.steps.map((step) => {
      const wait = step.wait
      if (wait === undefined || (wait.until === undefined && wait.failOn === undefined)) return step
      const outcomes: Record<string, { kind: OutcomeKind; patterns: string[] }> = {}
      const onOutcome: Record<string, Target> = {}
      for (const [j, p] of (wait.failOn ?? []).entries()) {
        outcomes[`拒${j + 1}`] = { kind: 'fail', patterns: [p] }
      }
      for (const [i, p] of (wait.until ?? []).entries()) {
        outcomes[`槽${i + 1}`] = { kind: 'ok', patterns: [p] }
      }
      for (const [k, t] of Object.entries(step.onFailOn ?? {})) {
        onOutcome[`拒${Number(k) + 1}`] = t
      }
      for (const [i, t] of (step.branch ?? []).entries()) {
        onOutcome[`槽${i + 1}`] = t
      }
      const captureFrom = wait.captures !== undefined && wait.captures.length > 0 ? '槽1' : undefined
      return {
        // 显式重建（不透传 branch/onFailOn——归一后路由只走 onOutcome，混留 = 结构非法）。
        id: step.id,
        wait: {
          closeOn: 'criteria' as const,
          outcomes,
          ...(captureFrom !== undefined ? { captureFrom } : {}),
          ...(wait.gaCount !== undefined ? { gaCount: wait.gaCount } : {}),
          ...(wait.quietMs !== undefined ? { quietMs: wait.quietMs } : {}),
          ...(wait.maxLines !== undefined ? { maxLines: wait.maxLines } : {}),
          ...(wait.captures !== undefined ? { captures: wait.captures } : {}),
          timeoutMs: wait.timeoutMs,
          ...(wait.flags !== undefined ? { flags: wait.flags } : {}),
        },
        ...(step.action !== undefined ? { action: step.action } : {}),
        ...(Object.keys(onOutcome).length > 0 ? { onOutcome } : {}),
        next: step.next,
      }
    }),
  }
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
