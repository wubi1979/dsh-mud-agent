/**
 * dsh-mud-core — /mud/* HTTP 路由表 (shell/routes).
 *
 * WebUI 外壳的 REST 面: bind / connect / disconnect / status / diag /
 * command / captcha-refresh / logs / purge / capability。全部路由统一套
 * loopback/trustedHosts 信任围栏; body 解析强制 `application/json`
 * (让 POST 对浏览器成为"非简单请求", 拒绝 text/plain 伪装的简单请求)。
 * @module @deepseek-ai/dsh-mud-core/shell/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { isTrustedRequest } from './hub.ts'
import { resolveCaptchaImage } from '../agents/captcha.ts'
import { MUD_TIER_NAMES, type MudTier } from '../services/gate/tiers.ts'
import type { MudLogService } from '../services/log/log-service.ts'
import type { MudCoreService } from '../service.ts'
import type { MudUiItemInput } from '../runtime/session/types.ts'
import type { SessionView } from './view.ts'

/** 路由表依赖 (由装配方注入 apply 作用域的闭包)。 */
export interface RouteContext {
  ctx: Context
  trustedHosts: readonly string[]
  service: MudCoreService
  /** 会话 id 回落解析。 */
  view: SessionView
  /** 会话日志服务 (lazily)。 */
  logServiceOf: (sessionId: string) => MudLogService
  pushUi: (sessionId: string, input: MudUiItemInput) => void
  tuiLog: (sessionId: string, text: string) => void
  /** 验证码刷新映射: 图片URL → robot.php URL。 */
  robotUrlMap: Map<string, string>
}

/** 读取并解析请求 JSON body (上限 64KB; 空 body 视为空对象)。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !/^application\/json(?:;|$)/i.test(contentType.trim())) {
      reject(new Error('content-type must be application/json'))
      return
    }
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (data === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(data)
        resolve(typeof parsed === 'object' && parsed !== null
          ? parsed as Record<string, unknown>
          : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** 安装 /mud/* HTTP 路由 (无 webServer 时为 no-op); 返回统一释放函数。 */
export function installRoutes(rc: RouteContext): () => void {
  const webServer = rc.ctx.get('webServer', false)
  if (webServer === undefined) return () => {}

  const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // 统一信任围栏: 复用 ws 的 loopback/trustedHosts/Origin 判定包裹每个 /mud/* 路由。
  const createRoute = (route: {
    kind: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) => webServer.register({
    ...route,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedRequest(req, rc.trustedHosts)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      return route.handler(req, res)
    },
  })

  /** body → 会话 id (显式字段优先; 缺省回落 lastActive/config)。 */
  const sessionIdOf = (body: Record<string, unknown>): string =>
    rc.view.resolve(typeof body.sessionId === 'string' ? body.sessionId : undefined)

  const tuiLog = rc.tuiLog
  const { service, logServiceOf, pushUi, robotUrlMap } = rc

  const disposeBindRoute = createRoute({
    kind: 'exact',
    path: '/mud/bind',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = sessionIdOf(body)
        service.bind(sessionId)
        sendJson(res, 200, { ok: true, sessionId })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 绑定请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  const disposeConnectRoute = createRoute({
    kind: 'exact',
    path: '/mud/connect',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = sessionIdOf(body)
        const host = typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : undefined
        const port = body.port === undefined ? undefined : Number(body.port)
        const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
        const pass = typeof body.pass === 'string' ? body.pass : undefined
        service.connect({
          sessionId,
          ...(host === undefined ? {} : { host }),
          ...(port === undefined || !Number.isFinite(port) ? {} : { port }),
          ...(name === undefined ? {} : { name }),
          ...(pass === undefined ? {} : { pass }),
        })
        sendJson(res, 200, { ok: true, sessionId })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 连接请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  const disposeDisconnectRoute = createRoute({
    kind: 'exact',
    path: '/mud/disconnect',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        service.disconnect(sessionIdOf(body))
        sendJson(res, 200, { ok: true })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 断开请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  const disposeStatusRoute = createRoute({
    kind: 'exact',
    path: '/mud/status',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const explicit = url.searchParams.get('sessionId')
      const status = service.status(explicit ?? undefined)
      sendJson(res, 200, { ok: true, ...status, sessions: service.statuses() })
    },
  })

  const disposeDiagRoute = createRoute({
    kind: 'exact',
    path: '/mud/diag',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, { ok: true, ...service.diag() })
    },
  })

  const disposeCommandRoute = createRoute({
    kind: 'exact',
    path: '/mud/command',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = sessionIdOf(body)
        const cmds = Array.isArray(body.cmds)
          ? body.cmds.filter((c): c is string => typeof c === 'string').map(c => c.trim()).filter(c => c !== '')
          : null
        if (cmds !== null) {
          if (cmds.length === 0) {
            sendJson(res, 400, { ok: false, error: 'empty command' })
            return
          }
          let ok = true
          for (const c of cmds) ok = service.sendCommand(c, sessionId) && ok
          sendJson(res, 200, { ok, sessionId })
          return
        }
        const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
        if (cmd === '') {
          sendJson(res, 400, { ok: false, error: 'empty command' })
          return
        }
        const sent = service.sendCommand(cmd, sessionId)
        sendJson(res, 200, { ok: sent, sessionId })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 命令请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  const disposeCaptchaRefreshRoute = createRoute({
    kind: 'exact',
    path: '/mud/captcha/refresh',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then(async (body) => {
        const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
        if (imageUrl === '') {
          sendJson(res, 400, { ok: false, error: 'missing imageUrl' })
          return
        }
        const robotUrl = robotUrlMap.get(imageUrl)
        if (robotUrl === undefined) {
          sendJson(res, 400, { ok: false, error: 'unknown captcha image' })
          return
        }
        robotUrlMap.delete(imageUrl)
        try {
          const newDisplayUrl = await resolveCaptchaImage(robotUrl)
          robotUrlMap.set(newDisplayUrl, robotUrl)
          const sessionId = sessionIdOf(body)
          tuiLog(sessionId, `[验证码] 刷新图片: ${newDisplayUrl}`)
          pushUi(sessionId, { kind: 'captcha', text: 'fullme 验证码', url: newDisplayUrl, cmd: 'fullme', time: Date.now() })
          sendJson(res, 200, { ok: true, url: newDisplayUrl })
        } catch (err) {
          tuiLog('', `[验证码] 刷新失败: ${err instanceof Error ? err.message : String(err)}`)
          sendJson(res, 500, { ok: false, error: 'refresh failed' })
        }
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 验证码刷新请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  // 当日日志恢复路由 (POST /mud/logs): 读取当日该会话 JSONL 文件 →
  // 前端挂载时拉历史, 与 ws 实时流按 logSeq 去重合并 (当日恢复, 隔天不恢复)。
  const disposeLogsRoute = createRoute({
    kind: 'exact',
    path: '/mud/logs',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = sessionIdOf(body)
        const entries = logServiceOf(sessionId).readDayEntries(sessionId)
        sendJson(res, 200, { ok: true, sessionId, entries })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 日志恢复请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  // 会话注销路由 (POST /mud/purge): 删除用户时调用 — 释放该会话运行时/连接,
  // 删除其全部日志文件, 重启后同名重建的用户读不到上一个身份的日志。
  const disposePurgeRoute = createRoute({
    kind: 'exact',
    path: '/mud/purge',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') {
          sendJson(res, 400, { ok: false, error: 'missing sessionId' })
          return
        }
        const result = service.purge(sessionId)
        sendJson(res, 200, { ok: result.ok, sessionId, files: result.files })
      }).catch((err: unknown) => {
        tuiLog('', `[SYS] 注销请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  // 权限档位路由 (§10): GET 读选项与当前值 (页面档位选择器), POST 切换。
  // GET 的 sessionId 走 query (?sessionId=…), POST 走 body —— 与既有 /mud/status
  // /mud/command 的形状一致。
  const disposeCapabilityRoute = createRoute({
    kind: 'exact',
    path: '/mud/capability',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = rc.view.resolve(url.searchParams.get('sessionId') ?? undefined)
        sendJson(res, 200, {
          ok: true,
          sessionId,
          tier: service.capability.current(sessionId),
          capabilities: service.capability.capabilities(service.capability.current(sessionId)),
          options: service.capability.options(),
          defaultTier: service.capability.defaultTier,
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      readJsonBody(req).then((body) => {
        const sessionId = sessionIdOf(body)
        const tier = typeof body.tier === 'string' ? body.tier.trim() : ''
        if (tier === '') {
          sendJson(res, 400, { ok: false, error: 'missing tier' })
          return
        }
        if (!MUD_TIER_NAMES.includes(tier as MudTier)) {
          sendJson(res, 400, { ok: false, error: `unknown tier "${tier}"` })
          return
        }
        const applied = service.capability.set(sessionId, tier)
        sendJson(res, 200, { ok: true, sessionId, tier: applied, capabilities: service.capability.capabilities(applied) })
      }).catch((err: unknown) => {
        tuiLog('', `[权限] 档位请求解析失败: ${err instanceof Error ? err.message : String(err)}`)
        sendJson(res, 400, { ok: false, error: 'invalid body' })
      })
    },
  })

  return () => {
    disposeBindRoute()
    disposeConnectRoute()
    disposeDisconnectRoute()
    disposeStatusRoute()
    disposeDiagRoute()
    disposeCommandRoute()
    disposeCaptchaRefreshRoute()
    disposeLogsRoute()
    disposePurgeRoute()
    disposeCapabilityRoute()
  }
}