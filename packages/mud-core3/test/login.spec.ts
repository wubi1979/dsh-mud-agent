/**
 * login 流程 E2E（真实 TCP + SessionRuntime；自 mud-workflow 迁回 core3）：
 *   - 成功 / 密码错 / need-new / replace（默认答 y）/ timeout 五路径；
 *   - 判据取自 doc/flows/login.md 与 doc/appendices/A-capture-facts.md 实测定稿（「欢迎来到」勘误含）；
 *   - 凭据零泄露：结果 JSON、画面 view（snapshot 帧）均无 pass 明文。
 *
 * 迁移缘由：login 实体归 core3（纯架构裁定），本规格是唯一使用 core3 devDep 的
 * mud-workflow 测试——迁回后 workflow 可删 `mud-core3` 依赖边，workspace 环消解。
 *
 * 短超时：流程数据超时可克隆替换（失败路径不等满 30s）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { SessionRuntime, type MudLine } from '../src/runtime.ts'
import { login } from '../src/flows/login.ts'

import { runFlow } from 'mud-workflow'
import type { WorkflowRecord, WorkflowIO } from 'mud-workflow'
import { stripIac } from './helpers.ts'

const NAME = 'hero'
const PASS = 'SECRET-PW'

/** 短超时克隆（E2E 用：失败路径不等满 30s）。 */
function shortTimeouts(stepMs: number, successMs: number): WorkflowRecord {
  return {
    ...login,
    flow: {
      ...login.flow,
      steps: login.flow.steps.map(s => ({
        ...s,
        ...(s.wait === undefined ? {} : {
          wait: { ...s.wait, timeoutMs: s.wait.timeoutMs === 5_000 ? successMs : stepMs },
        }),
      })),
    },
  }
}

/** 短超时 login（1.5s 步预算 / 0.8s 终态）。 */
const loginShort = shortTimeouts(1_500, 800)

// ── mock 登录服务器（IAC 剥离 + 行分发）──────────────────────────────

/** GA 字节（IAC GA）：终态步「空命令收 GA」的服务端侧。 */
const GA = Buffer.from([255, 249])

interface LoginServer {
  port: number
  /** 收到的非空命令行（按序；IAC 已剥离）。 */
  received: string[]
  close(): Promise<void>
}

async function startLoginServer(handlers: {
  onConnect?(sock: net.Socket): void
  onLine?(line: string, sock: net.Socket): void
  onEmpty?(sock: net.Socket): void
}): Promise<LoginServer> {
  const received: string[] = []
  const sockets: net.Socket[] = []
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.on('error', () => {})
    handlers.onConnect?.(sock)
    sock.on('data', (d: Buffer) => {
      const text = stripIac(d)
      const parts = text.split(/\r?\n/)
      const lines = parts.filter(p => p.trim() !== '')
      const emptyCount = (parts.length - 1) - lines.length
      for (const line of lines) {
        received.push(line)
        handlers.onLine?.(line, sock)
      }
      for (let k = 0; k < emptyCount; k += 1) handlers.onEmpty?.(sock)
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

// ── IO 组装：SessionRuntime → WorkflowIO（ioFor 缝的结构化子集）────────

function makeIO(rt: SessionRuntime): WorkflowIO {
  return {
    send: cmd => rt.send(cmd),
    sendCredential: cmd => rt.sendCredential(cmd),
    read: (opts, initial) => rt.read(opts, (initial ?? []) as readonly MudLine[]),
    recentLines: n => rt.recentLines(n),
    // login 不消费 captcha（T13）；stub 满足 io 接口（B2 双侧同形后必填）。
    awaitCaptcha: async () => ({ kind: 'closed' }),
    state: () => ({ state: rt.connState }),
  }
}

describe('login 流程 E2E（真实 TCP）', () => {
  it('成功路径：提示符驱动走完，stage=success，凭据零泄露（结果/画面）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('欢迎来到北大侠客行\n您的英文名字（要注册新人物请输入new。）：\n') },
      onLine: (line, sock) => {
        if (line === NAME) sock.write('此ID档案已存在，请输入密码：\n')
        else if (line === PASS) sock.write('重新连线完毕\n')
      },
      onEmpty: sock => { sock.write(GA) }, // 终态空命令 → GA 关窗
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100)) // 提示符到达

    const result = await runFlow(loginShort, makeIO(rt), { name: NAME, pass: PASS })

    expect(result.ok).toBe(true)
    expect(result.stage).toBe('success')
    // 服务端按序收到 name/pass（空命令不计入），无多余发送
    expect(server.received).toEqual([NAME, PASS])
    // 凭据零泄露：结果 JSON 无 pass 明文
    expect(JSON.stringify(result)).not.toContain(PASS)
    // 凭据零泄露：画面 view（snapshot 帧）无 pass 明文（sendCredential 不触发回显）
    const ac = new AbortController()
    const first = await rt.view.attach(ac.signal)[Symbol.asyncIterator]().next()
    expect(first.done).toBeFalsy()
    expect(JSON.stringify(first.value)).not.toContain(PASS)

    rt.dispose()
    ac.abort()
    await server.close()
  })

  it('密码错：failOn 命中 → bad-pass（不重试）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('您的英文名字（要注册新人物请输入new。）：\n') },
      onLine: (line, sock) => {
        if (line === NAME) sock.write('此ID档案已存在，请输入密码：\n')
        else sock.write('密码错误！请重试\n')
      },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeIO(rt), { name: NAME, pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('bad-pass')
    expect(server.received).toEqual([NAME, PASS]) // 不重试

    rt.dispose()
    await server.close()
  })

  it('用户名不存在：failOn 命中 → need-new（实机整句内嵌动态用户名）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('您的英文名字（要注册新人物请输入new。）：\n') },
      onLine: (_line, sock) => { sock.write(`同意玩家须知并使用${'newbie'}创造一个新的人物，您确定吗(yes)？\n`) },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeIO(rt), { name: 'newbie', pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('need-new')

    rt.dispose()
    await server.close()
  })

  it('replace 提示：默认答 y → 等成功句 → success（login.md replace 步 action=y）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('您的英文名字（要注册新人物请输入new。）：\n') },
      onLine: (line, sock) => {
        // 密码应答用实机单形态（「此ID档案已存在，…」）
        if (line === NAME) sock.write('此ID档案已存在，请输入密码：\n')
        else if (line === PASS) sock.write('您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)\n')
        else if (line === 'y') sock.write('重新连线完毕\n')
      },
      onEmpty: sock => { sock.write(GA) },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeIO(rt), { name: NAME, pass: PASS })
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('success')
    // 默认答 y：服务端按序收到 name/pass/y（空命令不计入）
    expect(server.received).toEqual([NAME, PASS, 'y'])
    // 现场行含 replace 提示（判定依据随结果返回）
    expect(result.lines.join('\n')).toContain('取而代之吗？(y/n)')

    rt.dispose()
    await server.close()
  })

  it('提示符不到：步预算到期 → timeout（等待未达成，零发送）', async () => {
    const loginShorter = shortTimeouts(300, 200)
    const server = await startLoginServer({
      onConnect: sock => { sock.write('欢迎来到北大侠客行\n') }, // 永不出名字提示
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShorter, makeIO(rt), { name: NAME, pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('timeout')
    expect(server.received).toEqual([]) // 没发任何东西

    rt.dispose()
    await server.close()
  })
})
