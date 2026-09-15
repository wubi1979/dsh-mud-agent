/**
 * dsh-mud-core — 外壳信任围栏 (shell/trust), host half.
 *
 * 入站请求信任判定: Host 围栏 (DNS rebinding 伪造不了的唯一头) 优先,
 * 其次跨站/Origin 标记。语义对齐 client/connection 的 api-request-trust,
 * 本地精简实现, 不依赖框架内部导出。
 *
 * 两个消费方: `/mud/ws` upgrade handler (hub.ts) 与 `/mud/*` HTTP 路由
 * (routes.ts) —— 纯 HTTP 头语义, 与 ws 无关, 独立成模块使 HTTP 路由不必
 * 传递加载 `ws`。曾住 hub.ts (routes 反向 import hub, 跨传输面横向依赖)。
 * @module @deepseek-ai/dsh-mud-core/shell/trust
 */

import type { IncomingMessage } from 'node:http'

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Browser-safe loopback classification: localhost, ::1, or any 127/8 literal. */
function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return name === 'localhost' || name === '::1' || name.endsWith('.localhost')
    || (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
}

/** Whether the request Host authority matches one trustedHosts entry. */
function matchesTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // Port-less entry matches the hostname on any port; explicit port is exact.
    return entryUrl.port === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Whether one inbound request may pass (upgrade 与普通 HTTP 共用)。
 * Host fence first (the one header DNS rebinding cannot forge), then
 * cross-site/origin markers。WS upgrade handler 与 /mud/* HTTP 路由
 * 均使用本判定。
 */
export function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !matchesTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
