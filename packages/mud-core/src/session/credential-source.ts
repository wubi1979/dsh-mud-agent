/**
 * dsh-mud-core — 登录密码的**值来源** (凭据引用名 → 明文)。
 *
 * 与 `session/credentials.ts` 的分工: 那个模块管"明文在游戏命令流/日志/转录里的
 * **暴露面**" (掩码 + `{name}/{pass}` 占位符 + 发送瞬间插值); 本模块管"明文**从哪来**"
 * —— 官方凭据 seam (`ctx.credentials`) 的适配层, 只回答一个问题: 这个引用名现在
 * 解析出什么值。
 *
 * 为什么自成一模块 (而不是留在 `assemble.ts`): `assemble.ts` 的模块图含
 * `shell/mud-remote-service.ts`, 后者用 `@Remote` (TC39 标准装饰器) 标注方法, 而本仓
 * 测试链路 (vitest 4 + Vite 8/rolldown/oxc) **没有任何一环能降级 TC39 装饰器**:
 * oxc 的 `decorator` 变换只实现 legacy 版, 打开 legacy 会让 `@Remote` 按
 * `(target, key, descriptor)` 被调用而在类定义期抛错; 只有 `tsc` 会正确降级。
 * 结果是从源码 `import` 到 `assemble.ts` 的 spec 一律在 transform 阶段死掉。
 * 因此"三条 fail-loud 策略"住在这里, 可以脱离装配被直接测 (见
 * `tests/connect-credentials.spec.ts`)。
 *
 * 三条策略都 fail loud, 且报错一律**指名引用名** —— 静默退化成一个空密码去登录,
 * 是这个模块最不能犯的错。
 * @module @deepseek-ai/dsh-mud-core/session/credential-source
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** 一次密码解析的引用名来源 (显式值优先, 缺省回落部署配置)。 */
export interface MudPassRefs {
  /** `connect` 选项显式给的引用名 (`MudConnectOptions.passRef`)。 */
  explicit?: string | undefined
  /** 部署配置的引用名 (`config.account.passRef`)。 */
  fallback?: string | undefined
}

/**
 * 取本次生效的引用名: 显式值 (去空白后非空) 优先, 否则部署值, 都没有 = 空串。
 * 空串是**合法状态**, 不是错误: 该服务器可能不校验密码。
 * @param refs 两级引用名来源。
 * @returns 生效的引用名; 无 = 空串。
 */
function passRefOf(refs: MudPassRefs): string {
  if (typeof refs.explicit === 'string' && refs.explicit.trim() !== '') return refs.explicit.trim()
  return refs.fallback?.trim() ?? ''
}

/**
 * 解析这次连接要用的登录密码。
 *
 * **每次连接都重新解析, 不跨操作缓存** —— 改密后 (改环境变量 / 重写
 * `$DSH_HOME/.credentials.yaml` / 页面重录) 下次连接即生效, 这是官方 seam 的
 * 每操作解析约定。
 *
 * 无引用名 → 返回空串且**不触碰凭据服务** (合法空密码)。有引用名时三级失败都
 * 先 `onError` 留痕再抛出, 调用方据此不建连接、不声明会话:
 *   ① 引用名不合 CredentialRef 语法 (`credentialRef` 抛 TypeError);
 *   ② 本次部署未挂载凭据 provider (`ctx.get('credentials')` 为 `undefined`);
 *   ③ 引用已挂载但未配置 (`resolve` 返回 `undefined`)。
 * @param ctx 宿主上下文 (读取可选服务 `credentials`)。
 * @param refs 显式引用名与部署回落引用名。
 * @param onError 失败留痕回调 (调用方写入诊断/会话日志); 抛出前调用一次。
 * @returns 明文密码; 无引用名时为空串。
 * @throws Error 上述三级失败之一 (消息已指名引用名与原因)。
 */
export async function resolveMudPass(
  ctx: Context,
  refs: MudPassRefs,
  onError: (message: string) => void,
): Promise<string> {
  const passRef = passRefOf(refs)
  if (passRef === '') return ''
  try {
    // 可选服务用 ctx.get (官方约定): 缺 provider 是"部署没挂", 不是编程错误。
    const credentials = ctx.get('credentials') as CredentialProvider | undefined
    if (credentials === undefined) {
      throw new Error(
        `凭据引用 "${passRef}" 无法解析: 本次部署未挂载凭据 provider`
        + ' (需在 composition 挂载 @deepseek-ai/dsh-credentials-local)',
      )
    }
    // 语法校验先于解析: 报错指名引用名, 而不是 provider 内部的模糊失败。
    const resolved = await credentials.resolve(credentialRef(passRef))
    if (resolved === undefined) {
      throw new Error(
        `凭据引用 "${passRef}" 未配置: 设置同名环境变量, 或在 WebUI 用户表单录入`
        + ' (写入 $DSH_HOME/.credentials.yaml)',
      )
    }
    return resolved.value
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error))
    throw error
  }
}
