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
  /** 生效记录（执行与 list 呈现用）。 */
  readonly record: WorkflowRecord
  /** 生效记录来源。 */
  readonly origin: WorkflowOrigin
  /** 被遮蔽的同名修缮（仅 locked 内置优先时有值；可 delete 清理）。 */
  readonly shadowed?: WorkflowRecord
}

// ── 结构校验（zod 之外：引用完整性 + 命中序界内 + success 约定）────

/**
 * 捕获槽保留名（T14 D5/2.2）：`captcha` = 引擎固定单槽，`name`/`pass` = 凭据
 * 占位——三类存储结构性分立，命名槽撞保留名在保存门拒存（不靠运行期判名）。
 */
export const RESERVED_SLOTS: readonly string[] = ['captcha', 'name', 'pass']

/**
 * 静态计组（T14 2.3）：`new RegExp(source + '|')` 在空串上必走末尾空分支，
 * exec 结果长度 - 1 = 捕获组数。源非法会 throw（调用方给可读上下文）。
 */
function countGroups(source: string): number {
  return new RegExp(`${source}|`).exec('')!.length - 1
}

/**
 * 流程结构校验（schema 校验通过后调用；registry.save 与引擎执行共用——
 * 校验是确定性的，生效门 = 校验即生效）：
 *   - 步 id 不重复；entry 存在；
 *   - goto 目标必须存在；
 *   - onFailOn 的 index 必须 < failOn 长度；branch 长度必须 ≤ until 长度；
 *   - captures 声明四校验（T14 2.3/D10/D11）：槽名合法且非保留名；until[0]
 *     捕获组数 ≥ captures 数（只对 until[0] 计组）；捕获组只允许出现在
 *     until[0]（其余 until 引入组 = 组号计数与提取错位）；
 *   - stage 'success' 必须 ok:true（防粗胚把失败标成 success——成功判定
 *     是流程作者的责任，但与 ok 矛盾直接拒）。
 *
 * @throws 可读错（保存/执行转可读拒绝）。
 */
export function checkFlow(flow: Flow): void {
  const ids = new Set(flow.steps.map(s => s.id))
  if (ids.size !== flow.steps.length) {
    throw new Error('流程结构非法：步 id 重复')
  }
  if (!ids.has(flow.entry)) {
    throw new Error(`流程结构非法：入口步不存在：${flow.entry}`)
  }
  for (const step of flow.steps) {
    const checkTarget = (where: string, t: Target): void => {
      if ('goto' in t && !ids.has(t.goto)) {
        throw new Error(`流程结构非法：步骤 ${step.id} 的${where}指向不存在的步：${t.goto}`)
      }
      if ('exit' in t && t.exit.stage === 'success' && !t.exit.ok) {
        throw new Error(`流程结构非法：步骤 ${step.id} 的${where}把出口 stage 'success' 标成 ok:false`)
      }
    }
    if (step.next !== undefined) checkTarget('缺省后继 next', step.next)
    if (step.onFailOn !== undefined) {
      const failOnLen = step.wait?.failOn?.length ?? 0
      for (const [k, t] of Object.entries(step.onFailOn)) {
        if (Number(k) >= failOnLen) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的 onFailOn[${k}] 越界（failOn 只有 ${failOnLen} 条）`)
        }
        checkTarget(`onFailOn[${k}]`, t)
      }
    }
    if (step.wait?.captures !== undefined) {
      const captures = step.wait.captures
      const until = step.wait.until ?? []
      if (until.length === 0) {
        throw new Error(`流程结构非法：步骤 ${step.id} 声明了 captures 但没有 until 判据`)
      }
      for (const name of captures) {
        if (!/^[a-zA-Z0-9_]+$/.test(name)) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的捕获槽名非法：${name}（只允许字母/数字/下划线）`)
        }
        if (RESERVED_SLOTS.includes(name)) {
          throw new Error(`流程结构非法：步骤 ${step.id} 的捕获槽名是保留名：${name}`)
        }
      }
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
      const untilLen = step.wait?.until?.length ?? 0
      if (step.branch.length > untilLen) {
        throw new Error(`流程结构非法：步骤 ${step.id} 的 branch 长度 ${step.branch.length} 超过 until 数 ${untilLen}`)
      }
      step.branch.forEach((t, i) => checkTarget(`branch[${i}]`, t))
    }
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
