/**
 * io — 流程 IO 窄面（core3 注入的结构化子集；本包零宿主/零 core3 import）。
 *
 * 解释器与外界的唯一通道只经这五个原语（send / sendCredential / read /
 * recentLines / state），与 core3 的 WorkflowIO 结构兼容；接线层在缝上以窄结构
 * 代位 cast（承品牌化 SessionId 同款实践——pnpm 严格链接下不直连 core3 内部
 * 类型，兼容性由接线 e2e 用例保证）。
 *
 * 凭据（WorkflowCredentials）由缝侧解析后注入引擎，**不经模型**；
 * 出口统一过 pass 掩码（interpreter）。
 */

/** 行窄面（只需 text；ANSI 等字段不进引擎）。 */
export interface IoLine {
  readonly text: string
}

/** 读参数（core3 ReadOpts 的结构化子集；正则已由解释器从字符串源编译）。 */
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

/** 会话状态窄面（引擎入口只判连接轴）。 */
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

/** 流程 IO 面（core3 注入；每会话一份，持有者独占 send+read 由缝侧保证）。 */
export interface WorkflowIO {
  /** 直发命令（进画面回显 + 会话日志）。 */
  send(cmd: string): boolean
  /** 凭据直发（不回显、不落盘、不进会话日志）。 */
  sendCredential(cmd: string): boolean
  /** 判据驱动读应答（initial 可带 pending 尾部快照，提示符先到不丢）。 */
  read(opts: IoReadOpts, initial?: readonly IoLine[]): Promise<IoReadResult>
  /** pending 尾部 N 行快照（等待前的"提示符可能已到达"对齐）。 */
  recentLines(n: number): IoLine[]
  /**
   * 推图挂起等人工验证码（T13.1 D4；fullme 链路；T14 D8 url 参数化）：URL
   * 由流程声明捕获槽传入（参数值已过解释器 substitute），实现侧据其抓图 →
   * 推帧 → 挂起，resolve 恢复帧；纯层只管按 kind 分流与填槽。
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

/** 引擎执行结果（ok + stage 分类 + 现场行；出口已过 pass 掩码）。 */
export interface WorkflowOutcome {
  ok: boolean
  stage: string
  lines: string[]
}
