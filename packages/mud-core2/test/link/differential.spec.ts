/**
 * 新旧实现同流对读差分（评审⑧）。
 *
 * mud-core2/link/{telnet,ansi}.ts 自称沿用 mud-core 实录验证过的实现 —— 本测试
 * 把同一段字节流分别喂旧 `mud-core/network/telnet.ts` 与新链路（mud-core2
 * TelnetClient → Mud 行流），断言产出行的 text/raw/style/abs/isPrompt 序列逐行
 * 一致。两份实现同仓并存期间，这条是"行为等价"的回归真相源；旧实现删除时此
 * 测试随之退役。
 *
 * 无 socket 驱动：两侧客户端都注入假 socket 后直接喂 onSocketData；新侧 Mud
 * 经私有 onText/onBoundaryEvent 接线（等价于 connect() 的内部接线，不建真连接）。
 */

import { describe, expect, it } from 'vitest'
import { TelnetClient as LegacyTelnet } from '../../../mud-core/src/network/telnet.ts'
import { TelnetClient } from '../../src/link/telnet.ts'
import { Mud, type ReadResult } from '../../src/link/mud.ts'

const IAC = 255
const GA = 249
const EOR = 239

/** 对比用的行投影（time 不比——两侧时间戳天然不同）。 */
interface LineProjection {
  text: string
  raw: string
  abs: number
  isPrompt: boolean
  style: unknown
}

function fakeSocket(sent: Buffer[]): unknown {
  return { write: (b: Buffer) => sent.push(b), destroyed: false, readyState: 'open' }
}

/** 旧侧：mud-core TelnetClient（内部含 ansi 解析），'parsed' 事件收行。 */
function runLegacy(chunks: Buffer[]): LineProjection[] {
  const legacy = new LegacyTelnet({ host: '127.0.0.1', port: 1 })
  ;(legacy as unknown as { socket: unknown }).socket = fakeSocket([])
  const lines: LineProjection[] = []
  legacy.on('parsed', (batch: Array<Record<string, unknown>>) => {
    for (const l of batch) {
      lines.push({
        text: l.text as string,
        raw: l.raw as string,
        abs: l.abs as number,
        isPrompt: l.isPrompt as boolean,
        style: l.style,
      })
    }
  })
  const feed = (legacy as unknown as { onSocketData: (b: Buffer) => void }).onSocketData.bind(legacy)
  for (const c of chunks) feed(c)
  return lines
}

/** 新侧：mud-core2 TelnetClient → Mud（意识层 onLine 收行）。 */
function runNew(chunks: Buffer[]): LineProjection[] {
  const client = new TelnetClient({ host: '127.0.0.1', port: 1 })
  ;(client as unknown as { socket: unknown }).socket = fakeSocket([])
  const mud = new Mud()
  const lines: LineProjection[] = []
  mud.onLine = (l) => {
    lines.push({ text: l.text, raw: l.raw, abs: l.abs, isPrompt: l.isPrompt, style: l.style })
  }
  client.on('text', (t: string) => (mud as unknown as { onText: (t: string) => void }).onText(t))
  client.on('boundary', (b: { kind: 'ga' | 'eor' }) =>
    (mud as unknown as { onBoundaryEvent: (k: 'ga' | 'eor') => void }).onBoundaryEvent(b.kind))
  const feed = (client as unknown as { onSocketData: (b: Buffer) => void }).onSocketData.bind(client)
  for (const c of chunks) feed(c)
  return lines
}

/** 混合语料：颜色 / CRLF 与 LF / 无换行提示 + GA / OSC(BEL) / 跨续行 / EOR 收尾。
 *  以 GA/EOR 结尾保证行全部提交（无 300ms 静默刷出的非确定性）。 */
const STREAM = Buffer.concat([
  Buffer.from('\x1b[31m红\x1b[0m白\n横幅\r\n', 'utf8'),
  Buffer.from('第一段无换行提示', 'utf8'),
  Buffer.from([IAC, GA]),
  Buffer.from('\x1b]0;title\x07标题后\n', 'utf8'),
  Buffer.from('杀气逼人', 'utf8'),
  Buffer.from('向你扑来！\r\n', 'utf8'),
  Buffer.from('末行', 'utf8'),
  Buffer.from([IAC, EOR]),
])

/** 新侧（wait 分支）：喂流前挂 read（gaCount=2 → GA 与 EOR 各关一次窗），
 *  行经 dispatchBatch 的 wait 分支进 acc 而非缓冲；钩子收行与 read 结果各自
 *  可比 —— 验"同一行既分发又重复分发/漏分发"类错误。 */
async function runNewViaRead(chunks: Buffer[]): Promise<{ hooked: LineProjection[], read: ReadResult }> {
  const client = new TelnetClient({ host: '127.0.0.1', port: 1 })
  ;(client as unknown as { socket: unknown }).socket = fakeSocket([])
  const mud = new Mud()
  const hooked: LineProjection[] = []
  mud.onLine = (l) => {
    hooked.push({ text: l.text, raw: l.raw, abs: l.abs, isPrompt: l.isPrompt, style: l.style })
  }
  client.on('text', (t: string) => (mud as unknown as { onText: (t: string) => void }).onText(t))
  client.on('boundary', (b: { kind: 'ga' | 'eor' }) =>
    (mud as unknown as { onBoundaryEvent: (k: 'ga' | 'eor') => void }).onBoundaryEvent(b.kind))
  // 挂进 Mud 的连接槽：read() 的持有者检查走 this.connected（conn.connected），
  // 假 socket 报 readyState:'open' 即视为已连接（不建真连接）。
  ;(mud as unknown as { conn: unknown }).conn = client
  const reading = mud.read({ holder: 'root', gaCount: 2, timeoutMs: 2000 })
  const feed = (client as unknown as { onSocketData: (b: Buffer) => void }).onSocketData.bind(client)
  for (const c of chunks) feed(c)
  const read = await reading
  return { hooked, read }
}

describe('新旧实现同流对读 (差分回归)', () => {
  it('混合语料: text/raw/style/abs/isPrompt 序列逐行一致', () => {
    const legacy = runLegacy([STREAM])
    const fresh = runNew([STREAM])
    expect(fresh).toEqual(legacy)
    // 非空与代表性断言（防两侧同时坏成空序列）。
    expect(fresh.length).toBeGreaterThanOrEqual(6)
    expect(fresh.map(l => l.text)).toContain('红白')
    expect(fresh.map(l => l.text)).toContain('标题后')
    expect(fresh.map(l => l.text)).toContain('杀气逼人向你扑来！')
    expect(fresh.map(l => l.text)).toContain('末行')
  })

  it('wait 分支: 喂流前挂 read, 钩子收行 / read 结果 / 旧实现三方一致', async () => {
    const legacy = runLegacy([STREAM])
    const { hooked, read } = await runNewViaRead([STREAM])
    // read 以 gaCount=2 在 EOR 关窗: 全部行进 acc, 无 rest。
    expect(read.reason).toBe('done')
    expect(read.rest).toBeUndefined()
    const viaRead: LineProjection[] = read.lines.map(l => ({
      text: l.text, raw: l.raw, abs: l.abs, isPrompt: l.isPrompt, style: l.style,
    }))
    // 三方逐行一致: 钩子看到 == read 收到 == 旧实现产出。
    expect(hooked).toEqual(legacy)
    expect(viaRead).toEqual(legacy)
    expect(viaRead.length).toBe(hooked.length)
  })

  it('多字节 UTF-8 跨块: 拆在字符中间也能解出同一行 (差分)', () => {
    // '杀' 三字节 e6 9d 80, 从中间切开喂两次（同一实例内跨块续接）。
    const full = Buffer.from('杀气逼人\r\n', 'utf8')
    const chunks = [full.subarray(0, 2), full.subarray(2)]
    const legacy = runLegacy(chunks)
    const fresh = runNew(chunks)
    expect(fresh).toEqual(legacy)
    expect(fresh.map(l => l.text)).toEqual(['杀气逼人'])
  })
})
