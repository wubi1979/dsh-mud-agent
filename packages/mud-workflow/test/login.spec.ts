/**
 * login 流程 E2E（真实 TCP + core3 SessionRuntime，自 core3 T3 workflow.spec 迁移）：
 *   - 成功 / 密码错 / need-new / replace（默认答 y）/ timeout 五路径；
 *   - 判据取自 doc/flows/login.md 与 doc/appendices/A-capture-facts.md 实测定稿（「欢迎来到」勘误含）；
 *   - 凭据零泄露：结果 JSON、画面 view（snapshot 帧）均无 pass 明文。
 *
 * 短超时：流程数据超时可克隆替换（失败路径不等满 30s）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { SessionRuntime, type MudLine } from 'mud-core3/runtime'
// 流程实体归 core3（纯架构裁定）：被测数据从 core3 lib/flows 读取。
import { login } from 'mud-core3/flows'

import { runFlow } from '../src/interpreter.ts'
import type { WorkflowRecord } from '../src/schema.ts'
import type { WorkflowEnv } from '../src/env.ts'

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

// ── mock 登录服务器（IAC 剥离 + 行分发；core3 test/helpers 同款）──────

/** 剥离 IAC 序列（协商 WILL/DO 3 字节、SB…SE 子协商整段、简单命令 2 字节）。 */
function stripIac(buf: Buffer): string {
  const out: number[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]!
    if (b !== 255) { out.push(b); i += 1; continue }
    const cmd = buf[i + 1]
    if (cmd === undefined) break
    if (cmd === 255) { out.push(255); i += 2; continue }
    if (cmd === 250) {
      let j = i + 2
      while (j + 1 < buf.length && !(buf[j] === 255 && buf[j + 1] === 240)) j += 1
      i = j + 2
      continue
    }
    i += cmd >= 251 && cmd <= 254 ? 3 : 2
  }
  return Buffer.from(out).toString('utf8')
}

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

// ── 环境组装：SessionRuntime → WorkflowEnv（envFor 缝的结构化子集）────

function makeEnv(rt: SessionRuntime): WorkflowEnv {
  return {
    send: cmd => rt.send(cmd),
    sendCredential: cmd => rt.sendCredential(cmd),
    read: (opts, initial) => rt.read(opts, (initial ?? []) as readonly MudLine[]),
    recentLines: n => rt.recentLines(n),
    state: () => ({ state: rt.connState }),
  }
}

describe('login 流程 E2E（真实 TCP）', () => {
  it('成功路径：提示符驱动走完，stage=success，凭据零泄露（结果/画面）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('欢迎来到北大侠客行\n您的英文名字：\n') },
      onLine: (line, sock) => {
        if (line === NAME) sock.write('此ID档案已存在，请输入密码：\n')
        else if (line === PASS) sock.write('重新连线完毕\n')
      },
      onEmpty: sock => { sock.write(GA) }, // 终态空命令 → GA 关窗
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100)) // 提示符到达

    const result = await runFlow(loginShort, makeEnv(rt), { name: NAME, pass: PASS })

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
      onConnect: sock => { sock.write('您的英文名字：\n') },
      onLine: (line, sock) => {
        if (line === NAME) sock.write('请输入密码：\n')
        else sock.write('密码错误，请重试\n')
      },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeEnv(rt), { name: NAME, pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('bad-pass')
    expect(server.received).toEqual([NAME, PASS]) // 不重试

    rt.dispose()
    await server.close()
  })

  it('用户名不存在：failOn 命中 → need-new', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('您的英文名字：\n') },
      onLine: (_line, sock) => { sock.write('需要创建新人物，请输入 new\n') },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeEnv(rt), { name: 'newbie', pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('need-new')

    rt.dispose()
    await server.close()
  })

  it('replace 提示：默认答 y → 等成功句 → success（login.md replace 步 action=y）', async () => {
    const server = await startLoginServer({
      onConnect: sock => { sock.write('您的英文名字：\n') },
      onLine: (line, sock) => {
        // 名字应答用 driver 第一形态（「此ID档案已存在，…」），顺带验证严格判据
        if (line === NAME) sock.write('此ID档案已存在，请输入密码：\n')
        else if (line === PASS) sock.write('您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)\n')
        else if (line === 'y') sock.write('重新连线完毕\n')
      },
      onEmpty: sock => { sock.write(GA) },
    })
    const rt = new SessionRuntime('s1')
    await rt.connect({ host: '127.0.0.1', port: server.port })
    await new Promise(r => setTimeout(r, 100))

    const result = await runFlow(loginShort, makeEnv(rt), { name: NAME, pass: PASS })
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

    const result = await runFlow(loginShorter, makeEnv(rt), { name: NAME, pass: PASS })
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('timeout')
    expect(server.received).toEqual([]) // 没发任何东西

    rt.dispose()
    await server.close()
  })
})
