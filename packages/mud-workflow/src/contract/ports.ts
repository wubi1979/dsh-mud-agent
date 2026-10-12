/**
 * contract/ports — 流程 IO 端口 + 引擎缝端口（**契约层单点**，A1）。
 *
 * 本文件是"流程内核 ↔ 引擎实现"之间唯一的一份端口声明：
 *   - **IO 原语端口** `WorkflowIO`：解释器与外界的唯一通道（send /
 *     sendCredential / read / recentLines / awaitCaptcha / state）；引擎侧
 *     （core3 `workflowIoFor`）按此**实现**，实现处有编译期可赋值断言，
 *     "双侧同形"由纪律升级为编译期事实（原 core3 `service.ts` 的本地同形接口
 *     已删除）。
 *   - **引擎缝端口** `WorkflowIoSeam`：归属解析 + ioFor（凭据解析 + 持有者独占
 *     + release/cancel 句柄）。core3 侧 `MudCore3Handle extends WorkflowIoSeam`
 *     即得编译期校验。
 *
 * 契约层零 cordis、零宿主、零 I/O。
 *
 * 凭据（WorkflowCredentials）由缝侧解析后注入内核，**不经模型**；
 * 出口统一过 pass 掩码（core/interpreter）。
 */

import type { ClosureKind, OutcomeKind, SlotTable } from './schema.ts'

/**
 * 行窄面：契约只承诺 `text`（ANSI/样式/行号等字段不进内核）。
 *
 * 行载体类型参数（`WorkflowIO<L>`）：实现侧需要携带自己的完整行记录
 *（core3 `MudLine`：abs/样式/分类标），并在 `recentLines → read(initial)` 之间
 * 原样回环；契约对行类型开放一个默认本窄面的类型参数，于是解释器一律按
 * `IoLine` 消费、实现按自己的行类型实例化，**两侧都不需要 cast**。
 */
export interface IoLine {
  readonly text: string
}

/**
 * 读参数（**raw 判据声明**——与流程 `wait` / 工具 `listen` 同一语法，DEC-21
 * 「一个语法三个消费点」）：正则编译与表条目合并在**缝侧单点**完成
 *（core3 `resolveAwaitPlan` + `workflowIoFor` 的 read 缝），内核不持正则。
 * `closeOn` 缺省 = 未声明判据——缝侧按喂令查表整条注入（DEC-5）；表条目也
 * 未命中 ⇒ 不收窗只等超时（DEC-4）。`timeoutMs` 可省（步声明 > 表条目 > 缝侧
 * 30s 兜底，绝不无界等待）。
 */
export interface IoReadOpts {
  /** 收窗形态（显式单值；缺省 = 未声明判据，缝侧注入表条目）。 */
  closeOn?: ClosureKind
  /** 结局槽表（raw 判据源；kind 在前、槽名在内——与流程 wait 同形状）。 */
  outcomes?: SlotTable
  /** GA/EOR 边界计数（仅 ga 形态；缺省 1）。 */
  gaCount?: number
  /** 行数兜底。 */
  maxLines?: number
  /** 总超时毫秒（可省——缝侧按「步声明 > 表条目 > 30s 兜底」填充）。 */
  timeoutMs?: number
  /** 正则编译 flags（应用于本窗全部槽判据；默认无）。 */
  flags?: string
}

/** 读窗收束原因（**单点声明**：core3 `read.ts` 的 `ReadReason` 引用本联合）。 */
export type IoReadReason =
  | 'done'      // 判据槽命中 / GA 计数到数 / maxLines 剪断
  | 'timeout'   // 总超时（quiet 形态零行同此——等同 timeout）
  | 'quiet'     // quiet 采样窗到点且有行 / 裸读静默到期
  | 'signal'    // 中止信号
  | 'disconnected' // 连接关闭
  | 'danger'    // 危险中断（abortWait）

/**
 * 命中判据帧（T15）：读窗机判定"**哪条判据赢了、取到什么值**"的结果。
 *
 * 有了它，路由（两级 onOutcome）与捕获（`groups`）不必再在流程侧重测一遍——
 * 分类、捕获与收窗因此物理上不可能不一致（§8.13）。
 *
 * T26.6（§3.3，DP 裁定 2）：`by` 四值 = **closeOn 三值 + `maxLines`**（与形态
 * 枚举同名词，无第二套名字）；`index` 为该槽 `patterns` 数组内下标（非判据
 * 收束 = -1）；`outcome` = 命中的结局槽名（条目数据，自由命名）；`kind` =
 * 槽判定（路由的输入）。合成帧：quiet 关窗 `{ by:'quiet', kind }`（kind 由行数
 * 定，无槽名）；ga 声明分类槽而未命中 `{ by:'ga', kind:'fail' }`（断言失败，
 * 结果行「收窗成功，分支未知」——DP 裁定 8）。
 */
export interface ReadHit {
  /** 实际收窗者：closeOn 三值（ga/criteria/quiet）或 maxLines。 */
  readonly by: 'ga' | 'criteria' | 'quiet' | 'maxLines'
  /** 判据命中：该槽 patterns 数组内下标；非判据收束 = -1。 */
  readonly index: number
  /** 该判据在整窗文本上**首次命中**的捕获组（组 1..n；未参与组 `undefined`；无组为空数组）。 */
  readonly groups: readonly (string | undefined)[]
  /** 命中的结局槽名（条目数据；无分类命中时缺省）。 */
  readonly outcome?: string
  /** 结局槽判定（kind 决定消费侧分流：fail 未覆盖 ⇒ 结构化失败出口）。 */
  readonly kind?: OutcomeKind
}

/** 读结果：现场行 + 收束原因 + 命中判据帧 + 缝侧归因。 */
export interface IoReadResult {
  readonly lines: IoLine[]
  readonly reason: IoReadReason
  /**
   * 命中帧；窗由 `gaCount` 到数（未声明分类槽）/ `maxLines` 剪断 / `timeout` /
   * `quiet`（零行）/ `signal` / `disconnected` / `danger` 关窗时视形态而定
   *（quiet 总有合成帧；criteria 失配无帧）。
   */
  readonly hit: ReadHit | undefined
  /** 归因（T26.5/26.6，§3.6）：生效收窗形态（缝侧合并/注入后的最终值）。 */
  readonly closeOn?: ClosureKind
  /** 归因：缝侧查表命中的表条目 id（empty 档 = ''）。 */
  readonly command?: string
  /** 归因：判据来源——table = 表条目（整条采用或同形态合并）；declared = 调用点声明（含异形态整体替换）；empty = 空命令特例；none = 未登记不收窗。 */
  readonly source?: 'table' | 'declared' | 'empty' | 'none'
}

/** 会话状态窄面（内核入口只判连接轴）。 */
export interface IoState {
  readonly state: string
}

/**
 * captcha 挂起的恢复帧（T13.1 D4/D5）：
 *   - answer = 人工提交的码值（值入 {captcha} 固定单槽）；
 *   - aborted = 人工中止（解释器走专用 aborted 出口，stage 可辨）；
 *   - closed = 断线/销毁/宿主取消回合（解释器走既有结构化 timeout 出口）。
 * 挂起预算由实现侧从 Config 注入（captchaTimeoutMs），解释器无参。
 */
export type CaptchaResume =
  | { readonly kind: 'answer'; readonly value: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'closed' }

/** 流程 IO 面（引擎注入；每会话一份，持有者独占 send+read 由缝侧保证）。 */
export interface WorkflowIO<L extends IoLine = IoLine> {
  /** 直发命令（进画面回显 + 会话日志）。 */
  send(cmd: string): boolean
  /** 凭据直发（不回显、不落盘、不进会话日志）。 */
  sendCredential(cmd: string): boolean
  /** 判据驱动读应答（initial 可带 pending 尾部快照，提示符先到不丢）。 */
  read(opts: IoReadOpts, initial?: readonly L[]): Promise<IoReadResult>
  /** pending 尾部 N 行快照（等待前的"提示符可能已到达"对齐）。 */
  recentLines(n: number): L[]
  /**
   * 推图挂起等人工验证码（T13.1 D4；fullme 链路；T14 D8 url 参数化）：URL
   * 由流程声明捕获槽传入（参数值已过解释器 substitute），实现侧据其抓图 →
   * 推帧 → 挂起，resolve 恢复帧；内核只管按 kind 分流与填槽。
   */
  awaitCaptcha(url: string): Promise<CaptchaResume>
  /** 会话状态快照（连接/登录/接入/世界）。 */
  state(): IoState
}

/** 凭据（缝侧解析注入；占位 {name}/{pass} 的替换源）。 */
export interface WorkflowCredentials {
  readonly name: string
  readonly pass: string
}

/** 内核执行结果（ok + stage 分类 + 现场行；出口已过 pass 掩码）。 */
export interface WorkflowOutcome {
  ok: boolean
  stage: string
  lines: string[]
}

/** 调用期 agent 窄面（缝侧只读 id；内核/工具层只透传不解释）。 */
export interface CallerAgent {
  readonly id: unknown
}

/**
 * ioFor 句柄：IO 原语 + 凭据 + 释放/取消。
 *   - release 由调用方 finally 保证；
 *   - cancel 可选（旧实现无此句柄时调用方跳过）：宿主取消回合（exec.signal
 *     abort）时调之 → 验证码挂起 closed 收束。
 */
export interface WorkflowIoHandle<L extends IoLine = IoLine> {
  readonly io: WorkflowIO<L>
  readonly creds: WorkflowCredentials
  release(): void
  cancel?(): void
}

/**
 * 引擎缝端口（core3 `ctx.mudCore3` 的本包消费面）：
 *   归属解析（父链上溯命中账号会话）+ ioFor（凭据解析 + 持有者独占 + IO 原语）。
 * 实现侧断言：core3 `MudCore3Handle extends WorkflowIoSeam<MudLine>`。
 */
export interface WorkflowIoSeam<L extends IoLine = IoLine> {
  /** 归属解析（父链上溯查名册）；未绑定返回 null。 */
  toolContextFor(agent: CallerAgent | undefined): { readonly sessionId: string } | null
  /** 取该会话的流程 IO 句柄；失败 throw 可读错（未连接/凭据解析失败/持有者冲突）。 */
  workflowIoFor(sessionId: string, holder: string): Promise<WorkflowIoHandle<L>>
}
