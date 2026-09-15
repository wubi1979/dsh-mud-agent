/**
 * dsh-mud-core — 凭据脱敏与占位符 (纯函数, 无状态, 运行时级共享)。
 *
 * 会话的凭据最小暴露面: `{name}/{pass}` 占位符流转全程 (渲染/转录/日志/工具结果),
 * 明文只在发送瞬间插值 (`agents/tools.ts` 的 `interpolateCredentials`)。本模块提供
 * 三个纯函数: 回显掩码、日志脱敏 (宽一层, 含人工回填值)、占位符值源 (流程归属比对)。
 *
 * 为什么在 runtime 根而不在 session/: 纯函数无会话状态, 消费方是"凭据机制的各接线点"
 * (会话回显/日志、流程运行时 mask、连接运行时的账户持有) —— 会话只是当前唯一的
 * 接线者, 不是机制的所有者。`SessionCredentials` 类型也归本模块 (契约随机制走,
 * tools/session/connection 统一从这里引用, 避免 runtime → agents 反向依赖)。
 * @module @deepseek-ai/dsh-mud-core/runtime/credentials
 */

// ── 会话登录凭据 (明文最小暴露面) ──────────────
// 凭据由**会话运行时**持有 (ConnectionRuntime.account), 不设模块级共享表:
// 引用一律以 {name}/{pass} 占位符流转 (转录/日志/工具结果均只见占位符),
// 明文仅在 mud_send 发送瞬间插值 (agents/tools.ts)。
export interface SessionCredentials {
  name: string
  pass: string
}

/** 凭据掩码: 仅密码 (高敏感); 长度 ≥4 时做嵌入子串掩码。 */
export function redactCredential(cmd: string, pass: string | undefined): string {
  if (!pass) return cmd
  if (cmd === pass) return '***'
  if (pass.length >= 4 && cmd.includes(pass)) return cmd.split(pass).join('***')
  return cmd
}

/**
 * **日志脱敏**（比 `redactCredential` 宽一层）: 密码 + 人工回填的外部值（验证码）。
 *
 * 用于一切"可能把命令原文写进会话日志"的通道（流程运行时的日志）。终端回显仍只用
 * `redactCredential`（人工自己看的画面不必掩盖验证码）。
 * @param text 待脱敏文本（命令或日志片段）。
 * @param pass 账户密码 (未设 = undefined)。
 * @param externalValues 人工回填的外部占位符值 (`{captcha}` → 验证码)。
 * @returns 脱敏后的文本。
 */
export function redactSecrets(
  text: string,
  pass: string | undefined,
  externalValues: Readonly<Record<string, string>>,
): string {
  let out = redactCredential(text, pass)
  for (const value of Object.values(externalValues)) {
    // 短值（1–2 字符）不做子串替换：会把正常文本打烂，收益也低。
    if (value.length < 3 || !out.includes(value)) continue
    out = out.split(value).join('***')
  }
  return out
}

/** 占位符值 (`{name}/{pass}` + 外部值; 流程命令"结算归属"比对用: 与发送瞬间插值同源)。 */
export function placeholderValues(
  account: SessionCredentials | null,
  externalValues: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...(account === null ? {} : { name: account.name, pass: account.pass }),
    ...externalValues,
  }
}
