/**
 * flows/fullme 测试 — fullme 验证码链路（impl §5 第 7 步 / §3.6）。
 *
 * 覆盖：取图（URL → question 出口）、冷却（FlowError）、stale 三连舞蹈后
 * 补取（按**出现次数**断言三连发，累积缓冲不空转）、二次 stale 抛错、
 * 答题正确（halt+fullme+hpbrief → done）、答题错误（question 出口指引重答）、
 * 三个 danger 出口（取图期 / stale 舞期 / 答题期）、空串 answer 拒绝、
 * 正则刻度、注册表登记。实录刻度承旧实现（作者 2026-09-13 审定）。
 */

import { describe, expect, it } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Mud } from '../../src/link/mud.ts'
import { FLOWS, getFlow } from '../../src/tools/flows/index.ts'
import {
  FULLME_FLOW,
  FULLME_COOLDOWN_PATTERN,
  FULLME_OK_TEXT,
  FULLME_STALE_TEXT,
  FULLME_URL_CAPTURE,
} from '../../src/tools/flows/fullme.ts'
import { FlowError } from '../../src/tools/flows/types.ts'

const CREDS = { name: 'test-user', pass: 'test-pass' }

const IAC = 255
const GA = 249
const GA_BYTES = Buffer.from([IAC, GA])

interface TestServer {
  port: number
  write(data: string | Buffer): void
  kill(): void
  close(): Promise<void>
  /** 首次命中 target 字节即返回（整个累积缓冲）。 */
  waitFor(target: string): Promise<Buffer>
  /** 累积缓冲中 target 出现次数 ≥ n 才返回（防历史命中导致空转）。 */
  waitForCount(target: string, n: number): Promise<void>
  /** 当前累积缓冲快照（终局断言用）。 */
  snapshot(): Buffer
}

function countOf(all: Buffer, target: string): number {
  return all.toString('utf8').split(target).length - 1
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
  const all = () => Buffer.concat(chunks)
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
          const buf = all()
          if (buf.includes(Buffer.from(target, 'utf8'))) {
            clearInterval(probe)
            resolve(buf)
          } else if (Date.now() - t0 > 2000) {
            clearInterval(probe)
            reject(new Error(`对端 2s 内未收到目标字节: ${target}; 实收 ${buf.length} 字节`))
          }
        }, 10)
      })
    },
    waitForCount(target: string, n: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const t0 = Date.now()
        const probe = setInterval(() => {
          if (countOf(all(), target) >= n) {
            clearInterval(probe)
            resolve()
          } else if (Date.now() - t0 > 2000) {
            clearInterval(probe)
            reject(new Error(`对端 2s 内 "${target}" 仅出现 ${countOf(all(), target)} 次（期望 ≥ ${n}）`))
          }
        }, 10)
      })
    },
    snapshot: all,
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

/** danger 接线模板（同 flows.spec login danger 用例）：行文含"向你袭来"即 abortWait。 */
function wireDanger(mud: Mud): void {
  mud.onLine = (line) => {
    if (line.text.includes('向你袭来')) mud.abortWait(line)
  }
}

const URL_LINE = 'http://mud.example.org/robot.php?filename=abc123 图片 3 秒内有效'

describe('fullme 取图阶段（answer 缺席）', () => {
  it('URL 行 → { done:false, question } 出口，question 含抽取的地址', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })
    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30)) // read 窗口先武装
    server.write('你集中精神，意念投射到异次元空间。\r\n')
    server.write(`${URL_LINE}\r\n`)

    const r = await p
    if (!('done' in r) || r.done !== false) throw new Error('预期 question 出口')
    expect(r.question).toContain('http://mud.example.org/robot.php?filename=abc123')
    expect(r.lines.map(l => l.text)).toContain(URL_LINE)
    await server.close()
  })

  it('冷却句 → FlowError（含原文，模型自行安排稍后重调）', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })
    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write('你刚刚用过这个命令不久，还要 3 分 20 秒才能再用。\r\n')

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error).toBeInstanceOf(FlowError)
    expect(error.message).toContain('还要 3 分 20 秒才能再用')
    await server.close()
  })

  it('stale → 三连发 fullme 1（ga:3 收口）→ 补取一轮 → URL；三连按次数断言', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_STALE_TEXT}\r\n`)
    // 三连 fullme 1：按出现次数对齐（累积缓冲不清零，普通 waitFor 会空转）
    await server.waitForCount('fullme 1', 1)
    server.write('你放弃了上次请求。\r\n')
    server.write(GA_BYTES)
    await server.waitForCount('fullme 1', 2)
    server.write('你放弃了上次请求。\r\n')
    server.write(GA_BYTES)
    await server.waitForCount('fullme 1', 3)
    server.write('你放弃了上次请求。\r\n')
    server.write(GA_BYTES) // 第 3 个 GA 关闭 ga:3 窗口
    // 补取一轮：第 4 次命令 = 裸 fullme；等窗口武装后回 URL
    await new Promise(r => setTimeout(r, 50))
    server.write(`${URL_LINE}\r\n`)

    const r = await p
    if (!('done' in r) || r.done !== false) throw new Error('预期 question 出口')
    expect(r.question).toContain('robot.php?filename=abc123')
    expect(countOf(server.snapshot(), 'fullme 1')).toBe(3) // 三连发实据
    await server.close()
  })

  it('二次 stale：三连放弃后再取仍 stale（再舞蹈后）→ FlowError 等重调', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_STALE_TEXT}\r\n`)
    // 第一次舞蹈
    for (let n = 1; n <= 3; n++) {
      await server.waitForCount('fullme 1', n)
      server.write('你放弃了上次请求。\r\n')
      server.write(GA_BYTES)
    }
    // 补取：第二轮 fullme 仍回 stale（补取的 until 窗口先武装）
    await new Promise(r => setTimeout(r, 50))
    server.write(`${FULLME_STALE_TEXT}\r\n`)
    // 第二次舞蹈（流程内 continue 后再入循环 → 第三轮 fullme → 循环耗尽抛错）
    for (let n = 4; n <= 6; n++) {
      await server.waitForCount('fullme 1', n)
      server.write('你放弃了上次请求。\r\n')
      server.write(GA_BYTES)
    }

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error).toBeInstanceOf(FlowError)
    expect(error.message).toContain('stale 舞蹈后仍未取到验证码图片')
    expect(countOf(server.snapshot(), 'fullme 1')).toBe(6)
    await server.close()
  })

  it('取图期危险行 → 出口 3 ({ reason: danger })', async () => {
    const { mud, server } = await setup()
    wireDanger(mud)
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })
    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write('不知哪里杀出一人向你袭来！\r\n')

    const r = await p
    expect(r).toEqual({ reason: 'danger' })
    await server.close()
  })

  it('边界先到且无 URL（gaCount:2 收窗）→ FlowError 未返回图片', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })
    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write('你集中精神，意念投射到异次元空间。\r\n')
    server.write(GA_BYTES) // 第 1 帧 GA 收尾（URL 未到）
    server.write('杂项输出。\r\n')
    server.write(GA_BYTES) // 第 2 个 GA 关窗，仍无 URL

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error).toBeInstanceOf(FlowError)
    expect(error.message).toContain('未返回验证码图片')
    await server.close()
  })

  it('中止（signal）后不再发出任何命令', async () => {
    const { mud, server } = await setup()
    const ac = new AbortController()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, signal: ac.signal })
    await server.waitFor('fullme')
    ac.abort()

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error.message).toContain('被中止')
    // 只有首发那一条 fullme；中止后零新命令（无 fullme 1、无补取）
    expect(countOf(server.snapshot(), 'fullme')).toBe(1)
    await server.close()
  })

  it('stale 舞期（ga:3 窗口）危险行 → 出口 3', async () => {
    const { mud, server } = await setup()
    wireDanger(mud)
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000 })

    await server.waitFor('fullme')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_STALE_TEXT}\r\n`)
    await server.waitForCount('fullme 1', 1)
    server.write('不知哪里杀出一人向你袭来！\r\n') // 打断 ga:3 等待

    const r = await p
    expect(r).toEqual({ reason: 'danger' })
    await server.close()
  })

  it('实录正则刻度：URL 捕获排除反引号、冷却通配动态时长', () => {
    expect(FULLME_COOLDOWN_PATTERN.test('你刚刚用过这个命令不久，还要 45 秒才能再用。')).toBe(true)
    const m = FULLME_URL_CAPTURE.exec('图片`http://x.org/robot.php?filename=a1`')
    expect(m?.groups?.captchaUrl).toBe('http://x.org/robot.php?filename=a1')
  })
})

describe('fullme 答题阶段（带答案重入）', () => {
  it('答对：halt + fullme {answer} + hpbrief 补状态 → { done:true }', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: 'abcd' })

    await server.waitFor('fullme abcd')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_OK_TEXT}\r\n`)
    await server.waitFor('hpbrief')
    await new Promise(r => setTimeout(r, 30))
    server.write('【气血】1200/ 3000\r\n')
    server.write(GA_BYTES) // hpbrief 收口判据 gaCount:1

    const r = await p
    expect(r).toEqual({ done: true })
    await server.close()
  })

  it('答错：{ done:false, question } 出口，指引对照原图重答（含次数纪律）', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: 'wrong' })

    await server.waitFor('fullme wrong')
    await new Promise(r => setTimeout(r, 30))
    server.write('好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！\r\n')

    const r = await p
    if (!('done' in r) || r.done !== false) throw new Error('预期 question 出口')
    expect(r.question).toContain('答案不对')
    expect(r.question).toContain('去掉 answer')
    expect(r.question).toContain('至多重试 3 次')
    await server.close()
  })

  it('答题期危险行 → 出口 3', async () => {
    const { mud, server } = await setup()
    wireDanger(mud)
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: 'abcd' })

    await server.waitFor('fullme abcd')
    await new Promise(r => setTimeout(r, 30))
    server.write('不知哪里杀出一人向你袭来！\r\n')

    const r = await p
    expect(r).toEqual({ reason: 'danger' })
    await server.close()
  })

  it('收尾步危险行（hpbrief 等待期）→ 出口 3（成功句已见仍认危险）', async () => {
    const { mud, server } = await setup()
    wireDanger(mud)
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: 'abcd' })

    await server.waitFor('fullme abcd')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_OK_TEXT}\r\n`)
    await server.waitFor('hpbrief')
    await new Promise(r => setTimeout(r, 30))
    server.write('不知哪里杀出一人向你袭来！\r\n') // 打断 hpbrief 收口 read

    const r = await p
    expect(r).toEqual({ reason: 'danger' })
    await server.close()
  })

  it('收尾步超时不算失败（成功句已见 ⇒ done；短超时构造）', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 200, answer: 'abcd' })

    await server.waitFor('fullme abcd')
    await new Promise(r => setTimeout(r, 30))
    server.write(`${FULLME_OK_TEXT}\r\n`)
    await server.waitFor('hpbrief')
    // 收口帧永不到：200ms 后收尾 read 超时，但流程仍以 done 收场

    const r = await p
    expect(r).toEqual({ done: true })
    await server.close()
  })

  it('提交后不可判定（GA 关窗且无成功/答错句）→ FlowError', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: 'abcd' })

    await server.waitFor('fullme abcd')
    await new Promise(r => setTimeout(r, 30))
    server.write('无关应答一行。\r\n')
    server.write(GA_BYTES) // 缺省 gaCount:1 关窗，行内无 OK/WRONG

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error).toBeInstanceOf(FlowError)
    expect(error.message).toContain('未收到可判定的应答')
    await server.close()
  })

  it('空串 answer → FlowError 拒绝（不发命令）', async () => {
    const { mud, server } = await setup()
    const p = FULLME_FLOW.run({ mud, creds: CREDS, holder: 'root', defaultTimeoutMs: 30_000, answer: '' })

    const error = await p.then(() => { throw new Error('不应成功') }, (e: Error) => e)
    expect(error).toBeInstanceOf(FlowError)
    expect(error.message).toContain('空串')
    expect(countOf(server.snapshot(), 'fullme')).toBe(0) // 未发出任何命令（快照仅含连接协商字节）
    await server.close()
  })
})

describe('fullme 注册表', () => {
  it('FLOWS 登记 login + fullme；getFlow 命中', () => {
    expect(FLOWS.map(f => f.id)).toEqual(['login', 'fullme'])
    expect(getFlow('fullme')?.id).toBe('fullme')
  })
})
