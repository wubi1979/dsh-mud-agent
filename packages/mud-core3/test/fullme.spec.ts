/**
 * fullme 流程 E2E + 验证码等待注册表（T13 断言⑦–⑬ + T14 断言⑨⑩⑪，先红后绿）：
 *   ⑦ E2E（fake fetch）：run → 推帧 → captchaAnswer 提交 → 发码 → success；
 *   ⑧ 答错 → goto answer 重来（缓存图不重抓）+ stale 自愈（urlwait failOn →
 *      `fullme 1` ×3 → fail 收束，无重试——15 分钟冷却）+ 冷却句出口；
 *   ⑨ abort → aborted 出口端到端；
 *   ⑩ 三退出路径：cancel（宿主取消回合）/ 断线 / dispose → closed 收束 + release；
 *   ⑪ 并发冲突拒（等待注册表单会话单槽）；
 *   ⑫ 未连接/未登记拒；
 *   ⑬ 装载冒烟（fullme 入册过 schema/checkFlow 红线校验）在 plugin-load.e2e.ts。
 * T14（URL 槽化）：⑨ = URL 经捕获槽传入 awaitCaptcha（E2E spy 断言）；
 * ⑩ = 答错重入沿缓存图复现不重抓（同 URL 两次挂起，页/图各 1 次）；
 * ⑪ = URL 行未出现 → urlwait 结构化 timeout（报错点前移，awaitCaptcha 不自取）。
 * ⑫（io.recentLines 水位过滤回归）在 workflow.spec.ts。
 *
 * 挂起预算（captchaTimeoutMs）与步预算（wait.timeoutMs）短超时克隆注入。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { MudService } from '../src/service.ts'
import type { AccountRecord, ServerRecord } from '../src/roster.ts'
import type { CaptchaFetch, CaptchaResponse } from '../src/captcha.ts'
import { fullme } from '../src/flows/fullme.ts'
import { runFlow } from 'mud-workflow/core'
import type { WorkflowRecord } from 'mud-workflow/contract'
import { stripIac } from './helpers.ts'

// ── 语料（与 flows/fullme.ts 同源；服务端侧原样下发）──────────────────

const URL_LINE = 'https://pkuxkx.net/robot.php?filename=abc123'
const OK_LINE = '你突然感到精神一振，浑身似乎又充满了力量！'
const WRONG_LINE = '好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！'
const STALE_LINE = '你之前请求的fullme还没有完成，请先完成或放弃。'
const COOLDOWN_LINE = '你刚刚用过这个命令不久，还要 3 分 20 秒才能再用。'
const PAGE_HTML = '<html><body><img src="/static/captcha/img-1.png"></body></html>'
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/** 步预算克隆（E2E 用：失败路径不等满 30s）。 */
function shortFlow(stepMs: number): WorkflowRecord {
  return {
    ...fullme,
    flow: {
      ...fullme.flow,
      steps: fullme.flow.steps.map(s => ({
        ...s,
        ...(s.wait === undefined ? {} : { wait: { ...s.wait, timeoutMs: stepMs } }),
      })),
    },
  }
}

const flowShort = shortFlow(1_500)

// ── mock 服务端（fullme 脚本：引子回 URL/悬挂句，答案按表回）────────────

interface FullmeServer {
  port: number
  received: string[]
  close(): Promise<void>
}

async function startFullmeServer(answerFor: (line: string) => string): Promise<FullmeServer> {
  const received: string[] = []
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.on('error', () => {})
    sock.on('data', (d: Buffer) => {
      for (const line of stripIac(d).split(/\r?\n/)) {
        if (line.trim() === '') continue
        received.push(line)
        const reply = answerFor(line)
        if (reply !== '') sock.write(`${reply}\n`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    received,
    close() {
      for (const s of sockets) s.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

// ── fake 取图 fetch（D3 注入面；计数断言「缓存不重抓」）────────────────

function fakeCaptchaFetch(state: { page: number; img: number }): CaptchaFetch {
  return async (url) => {
    if (url.includes('robot.php')) {
      state.page += 1
      return textResponse(PAGE_HTML, 'text/html')
    }
    state.img += 1
    return bytesResponse(PNG_BYTES)
  }
}

function textResponse(text: string, type: string): CaptchaResponse {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
  }
}

function bytesResponse(bytes: Uint8Array): CaptchaResponse {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
  }
}

// ── 环境组装：service（注册表 + 取图注入）+ 已连接会话 ────────────────

const NAME = 'hero'
const PASS = 'SECRET-PW'
const CREDS = { name: NAME, pass: PASS }

async function setup(opts: {
  captchaTimeoutMs?: number
  answerFor?: (line: string) => string
} = {}) {
  const fetchState = { page: 0, img: 0 }
  const server = await startFullmeServer(
    opts.answerFor ?? (line => (/^fullme \d+$/.test(line) ? OK_LINE : URL_LINE)),
  )
  const servers = new Map<string, ServerRecord>([
    ['ws-1', { workspaceId: 'ws-1', name: 'S', host: '127.0.0.1', port: server.port }],
  ])
  const accounts = new Map<string, AccountRecord>([
    ['a1', { id: 'a1', name: NAME, passRef: 'c1', serverId: 'ws-1', preset: 'mud-player', admitted: false }],
  ])
  const service = new MudService({
    serverLookup: id => servers.get(accounts.get(id)?.serverId ?? ''),
    accountLookup: id => accounts.get(id),
    resolveCreds: async () => CREDS,
    captchaFetch: fakeCaptchaFetch(fetchState),
    ...(opts.captchaTimeoutMs !== undefined ? { captchaTimeoutMs: opts.captchaTimeoutMs } : {}),
    log: { bufferMax: 50 },
  })
  service.register('a1', NAME)
  await service.connect('a1')
  return { server, service, fetchState }
}

/** 轮询等待（帧/收束的异步对齐；上限 2s 防挂死）。 */
async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时（2s）')
    await new Promise(r => setTimeout(r, 20))
  }
}

/** awaitCaptcha 传参 spy（T14 ⑨⑩）：记录流程槽传入的 URL，行为不变。 */
function spyAwaitCaptcha(io: { awaitCaptcha(url: string): Promise<unknown> }): string[] {
  const urls: string[] = []
  const inner = io.awaitCaptcha.bind(io)
  io.awaitCaptcha = (url: string) => {
    urls.push(url)
    return inner(url)
  }
  return urls
}

describe('fullme 流程 E2E（T13 断言⑦–⑨）', () => {
  it('⑦ 成功路径：run → 推帧 → captchaAnswer → 发 fullme {captcha} → success（T14 ⑨：URL 经捕获槽传入）', async () => {
    const { server, service, fetchState } = await setup()
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const captchaUrls = spyAwaitCaptcha(handle.io)
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: { image: string; url: string }[] }
      return last !== undefined && last.pending.length === 1
    })
    const row = (frames[frames.length - 1] as { pending: { image: string; url: string }[] }).pending[0]!
    expect(row.url).toBe(URL_LINE)
    expect(row.image).toMatch(/^data:image\/png;base64,/)
    // 推帧 = 页 1 次 + 图 1 次
    expect(fetchState).toEqual({ page: 1, img: 1 })
    await service.captchaAnswer('a1', '1234')
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('success')
    expect(server.received).toEqual(['fullme', 'fullme 1234'])
    // T14 ⑨：awaitCaptcha 的 URL 来自 urlwait 捕获槽（不再是闭包自取）
    expect(captchaUrls).toEqual([URL_LINE])
    // 收束推清除帧：快照回到空
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last.pending.length === 0
    })
    handle.release()
    off()
    await service.disposeAll()
    await server.close()
  })

  it('⑧a 答错 → goto answer 重入：缓存图不重抓（页/图各 1 次），同 URL 继续作答（T14 ⑩）', async () => {
    let wrong = true
    const { server, service, fetchState } = await setup({
      answerFor: (line) => {
        if (line === 'fullme') return URL_LINE
        if (wrong) { wrong = false; return WRONG_LINE }
        return OK_LINE
      },
    })
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const captchaUrls = spyAwaitCaptcha(handle.io)
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last !== undefined && last.pending.length === 1
    })
    await service.captchaAnswer('a1', '1111') // 答错
    // 第二轮推帧：帧序列 = 推帧→清除→推帧（subscribe 不推首帧，共 3 帧）
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return frames.length >= 3 && last.pending.length === 1
    })
    await service.captchaAnswer('a1', '2222')
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('success')
    // 不重发引子：fullme 只发一次，两轮码
    expect(server.received).toEqual(['fullme', 'fullme 1111', 'fullme 2222'])
    // 缓存图：同 URL 全程只抓一次页/图（T14 ⑩：重入沿缓存，awaitCaptcha 两次
    // 挂起收到的 URL 相同——槽沿用上值，未重经捕获步）
    expect(fetchState).toEqual({ page: 1, img: 1 })
    expect(captchaUrls).toEqual([URL_LINE, URL_LINE])
    handle.release()
    off()
    await service.disposeAll()
    await server.close()
  })

  it('⑧b stale 自愈：urlwait failOn → fullme 1 ×3 → abandoned 收束，无重试', async () => {
    const { server, service } = await setup({
      answerFor: line => (line === 'fullme 1' ? '' : STALE_LINE),
    })
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const r = await runFlow(flowShort, handle.io, CREDS)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('abandoned')
    // runFlow 收束与 TCP 落地异步对齐（三连 fullme 1 全部到达后再断言）
    await waitFor(() => server.received.length === 4)
    // 三连放弃后收束，不 goto request 重试
    expect(server.received).toEqual(['fullme', 'fullme 1', 'fullme 1', 'fullme 1'])
    handle.release()
    await service.disposeAll()
    await server.close()
  })

  it('⑧c 冷却句：urlwait failOn → cooldown 出口（等下次服务器提示再触发）', async () => {
    const { server, service } = await setup({
      answerFor: () => COOLDOWN_LINE,
    })
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const r = await runFlow(flowShort, handle.io, CREDS)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cooldown')
    expect(server.received).toEqual(['fullme'])
    handle.release()
    await service.disposeAll()
    await server.close()
  })

  it('T14 ⑪ URL 行未出现：urlwait 结构化 timeout 收束（报错点前移，awaitCaptcha 不再自取兜底）', async () => {
    const { server, service } = await setup({
      answerFor: () => '这条回复不是验证码地址',
    })
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const r = await runFlow(flowShort, handle.io, CREDS)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    expect(server.received).toEqual(['fullme'])
    handle.release()
    await service.disposeAll()
    await server.close()
  })

  it('⑨ 中止：captchaAbort → aborted 出口（专用收束，stage 可辨）', async () => {
    const { server, service } = await setup()
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last !== undefined && last.pending.length === 1
    })
    await service.captchaAbort('a1')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('aborted')
    expect(server.received).toEqual(['fullme'])
    handle.release()
    off()
    await service.disposeAll()
    await server.close()
  })
})

describe('三退出路径 + 挂起预算（T13 断言⑩）', () => {
  it('⑩a cancel（宿主取消回合接线面）：closed → timeout 收束 + release 后可再取', async () => {
    const { server, service } = await setup()
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last !== undefined && last.pending.length === 1
    })
    // tools.ts 接 exec.signal abort 后等价于取消回合；契约里 cancel 对消费侧
    // 可选（旧缝实现可无此句柄）——本包实现恒提供，用可选调用对齐契约语义。
    handle.cancel?.()
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    handle.release()
    // release：持有者已释放，可再取
    const again = await service.workflowIoFor('a1', 'workflow:fullme')
    await again.release()
    off()
    await service.disposeAll()
    await server.close()
  })

  it('⑩b 断线：disconnect → closed → timeout 收束（探测不救，D8）', async () => {
    const { server, service } = await setup()
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await new Promise(r => setTimeout(r, 200)) // 进入挂起
    service.disconnect('a1')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    handle.release()
    await service.disposeAll()
    await server.close()
  })

  it('⑩c 会话销毁：dispose → closed → timeout 收束', async () => {
    const { server, service } = await setup()
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await new Promise(r => setTimeout(r, 200)) // 进入挂起
    service.dispose('a1')
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    handle.release()
    await service.disposeAll()
    await server.close()
  })

  it('⑩d 挂起预算到点：captchaTimeoutMs → closed → timeout 收束 + 条目摘除', async () => {
    const { server, service } = await setup({ captchaTimeoutMs: 300 })
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last !== undefined && last.pending.length === 1
    })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('timeout')
    // 条目摘除：单槽空出（再等不再冲突），快照回空
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last.pending.length === 0
    })
    handle.release()
    off()
    await service.disposeAll()
    await server.close()
  })
})

describe('等待注册表约束（T13 断言⑪⑫）', () => {
  it('⑪ 并发冲突拒：挂起期间再次等待 → 单槽可读拒绝（收束后恢复）', async () => {
    const { server, service } = await setup()
    const frames: unknown[] = []
    const off = service.subscribeCaptcha(f => frames.push(f))
    const handle = await service.workflowIoFor('a1', 'workflow:fullme')
    const p = runFlow(flowShort, handle.io, CREDS)
    await waitFor(() => {
      const last = frames[frames.length - 1] as { pending: unknown[] }
      return last !== undefined && last.pending.length === 1
    })
    await expect(handle.io.awaitCaptcha(URL_LINE)).rejects.toThrow('挂起')
    await service.captchaAnswer('a1', '1234')
    const r = await p
    expect(r.ok).toBe(true)
    handle.release()
    off()
    await service.disposeAll()
    await server.close()
  })

  it('⑫ 未登记/未连接：可读拒绝（captchaAnswer 同面）', async () => {
    const { server, service } = await setup()
    await expect(service.workflowIoFor('ghost', 'workflow:fullme')).rejects.toThrow('未登记')
    service.register('a2')
    await expect(service.workflowIoFor('a2', 'workflow:fullme')).rejects.toThrow('未连接')
    await expect(service.captchaAnswer('a1', '1234')).rejects.toThrow('没有挂起的验证码')
    await service.disposeAll()
    await server.close()
  })
})
