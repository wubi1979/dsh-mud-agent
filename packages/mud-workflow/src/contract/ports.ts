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

/** 读参数（引擎 ReadOpts 的结构化子集；正则已由解释器从字符串源编译）。 */
export interface IoReadOpts {
  until?: RegExp[]
  failOn?: RegExp[]
  gaCount?: number
  quietMs?: number
  maxLines?: number
  /** 必填——绝不无界等待（read.ts 语义）。 */
  timeoutMs: number
}

/** 读结果（reason 收敛为字符串窄面；done/failOn/timeout/quiet/signal/disconnected/danger）。 */
export interface IoReadResult {
  readonly lines: IoLine[]
  readonly reason: string
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
