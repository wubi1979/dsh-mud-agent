/**
 * tools/flows 测试 — login 流程（实录刻度）+ 注册表（impl §3.6）。
 *
 * 覆盖：happy path（名字 → 密码 → 成功句 → 空命令收尾）、替换在线同名分支、
 * 密码错误抛错、危险中断出口 3、注册表查 id；凭据只经 mud.send 发出（明文
 * 不进流程结果）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Mud } from '../../src/link/mud.ts'
import { FLOWS, getFlow } from '../../src/tools/flows/index.ts'
import { LOGIN_FLOW } from '../../src/tools/flows/login.ts'
import { FlowError } from '../../src/tools/flows/types.ts'

const IAC = 255
const GA = 249
const GA_BYTES = Buffer.from([IAC, GA])

const CREDS = { name: 'test-user', pass: 'test-pass' }

interface TestServer {
  port: number
  write(data: string | Buffer): void
  kill(): void
  close(): Promise<void>
  waitFor(target: string): Promise<Buffer>
}

async function startServer(): Promise<TestServer> {
  let sock: net.Socket | null = null
  const chunks: Buffer[] = []
  const server = net.createServer((s) => {
    sock = s
    s.on('data', (d: Buffer) => chunks.push(d))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    write(data) {
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      if (sock !== null) sock.write(payload)
      else server.once('connection', s => s.write(payload))
    },
    kill() { sock?.destroy() },
    close() {
      sock?.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
    waitFor(target: string): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const t0 = Date.now()
        const probe = setInterval(() => {
          const all = Buffer.concat(chunks)
          if (all.includes(Buffer.from(target, 'utf8'))) {
            clearInterval(probe)
            resolve(all)
          } else if (Date.now() - t0 > 2000) {
            clearInterval(probe)
            reject(new Error(`对端 2s 内未收到目标字节: ${target}; 实收 ${all.length} 字节`))
          }
        }, 10)
      })
    },
  }
}

async function setup(): Promise<{ mud: Mud, server: TestServer }> {
  const server = await startServer()
  const mud = new Mud()
  mud.connect('127.0.0.1', server.port)
  for (let i = 0; i < 100 && !mud.connected; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  expect(mud.connected).toBe(true)
  return { mud, server }
}

describe('login 流程（实录刻度）', () => {
  it('happy path: 名字 → 密码 → 成功句 → 空命令收尾+收口; 行流干净', async () => {
    const { mud, server } = await setup()
    const p = LOGIN_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    server.write('欢迎来到北大侠客行。\r\n您的英文名字（要注册新人物请输入new。）：\r\n')
    await server.waitFor(CREDS.name)
    server.write('此ID档案已存在，请输入密码：\r\n')
    await server.waitFor(CREDS.pass)
    server.write('目前权限：(player)\r\n')
    await new Promise(r => setTimeout(r, 30)) // 让收尾 read 先起，再补 GA 帧（收口判据 gaCount:1）
    server.write(GA_BYTES)

    const r = await p
    expect(r).toEqual({ done: true })
    // 行流干净：收尾帧已被流程消费，缓冲无残留（探针读不出现任何行）
    const probe = await mud.read({ holder: 'root', until: [/永远不会出现/], timeoutMs: 150 })
    expect(probe.lines).toEqual([])
    await server.close()
  })

  it('替换在线同名分支: 替换询问 → y → 成功句', async () => {
    const { mud, server } = await setup()
    const p = LOGIN_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    server.write('您的英文名字（要注册新人物请输入new。）：\r\n')
    await server.waitFor(CREDS.name)
    server.write('此ID档案已存在，请输入密码：\r\n')
    await server.waitFor(CREDS.pass)
    server.write('您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)\r\n')
    await server.waitFor('y')
    server.write('重新连线完毕。\r\n')
    await new Promise(r => setTimeout(r, 30)) // 收尾 read 先起，再补 GA 帧
    server.write(GA_BYTES)

    const r = await p
    expect(r).toEqual({ done: true })
    await server.close()
  })

  it('密码错误 → FlowError（异常终态，不是三出口）', async () => {
    const { mud, server } = await setup()
    const p = LOGIN_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    server.write('您的英文名字（要注册新人物请输入new。）：\r\n')
    await server.waitFor(CREDS.name)
    server.write('此ID档案已存在，请输入密码：\r\n')
    await server.waitFor(CREDS.pass)
    server.write('密码错误，请重新输入。\r\n')

    await expect(p).rejects.toBeInstanceOf(FlowError)
    await server.close()
  })

  it('用户名不存在（需要创建新人物）→ FlowError', async () => {
    const { mud, server } = await setup()
    const p = LOGIN_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    server.write('您的英文名字（要注册新人物请输入new。）：\r\n')
    await server.waitFor(CREDS.name)
    server.write('这个英文名字不存在，需要创建新人物。\r\n')

    await expect(p).rejects.toBeInstanceOf(FlowError)
    await server.close()
  })

  it('危险中断 → 出口 3 ({ reason: danger })', async () => {
    const { mud, server } = await setup()
    // 模拟 awareness.observe 的 danger 出口（abortWait 同源）
    mud.onLine = (line) => {
      if (line.text.includes('向你袭来')) mud.abortWait(line)
    }
    const p = LOGIN_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    server.write('您的英文名字（要注册新人物请输入new。）：\r\n')
    await server.waitFor(CREDS.name)
    server.write('此ID档案已存在，请输入密码：\r\n')
    await server.waitFor(CREDS.pass)
    server.write('不知哪里杀出一人向你袭来！\r\n')

    const r = await p
    expect(r).toEqual({ reason: 'danger' })
    await server.close()
  })
})

describe('流程注册表', () => {
  it('FLOWS 含 login；getFlow 按 id 查得', () => {
    expect(getFlow('login')).toBe(LOGIN_FLOW)
    expect(FLOWS.map(f => f.id)).toContain('login')
  })

  it('查无此 id 返回 null（mud_flow 据此直接拒）', () => {
    expect(getFlow('fullme')).toBeNull()
    expect(getFlow('不存在的流程')).toBeNull()
  })
})
