#!/usr/bin/env node
/**
 * probe-heartbeat.mjs — 心跳探针（standalone, 零依赖；四期自动重连前置 = 真实心跳，§17.3）。
 *
 * 回答两个问题：
 *   A. 服务端是否有心跳：登录后客户端**零发送**静默观察 --observe 秒（缺省 240s），
 *      记录所有入站（文本块 / GA / EOR / GMCP / telnet 单字节命令）及其间隔；
 *      观察窗内入站为 0 = 服务端无主动心跳。
 *   B. 客户端可否发心跳：逐项试发候选并监听 --probe-wait 秒（缺省 6s）——
 *      telnet NOP(241) / AYT(246) / GMCP Core.KeepAlive / GMCP Core.Ping / 空行，
 *      最后发 look 确认链路仍活（若前面候选被当游戏命令，look 用于对照）。
 *
 * 用法：
 *   node probe-heartbeat.mjs [--host mud.pkuxkx.net] [--port 8081]
 *        [--user vicrly] [--pass <密码> | 缺省从宿主 credentials 读 MUD_PASS_vicrly_*]
 *        [--observe 240] [--probe-wait 6]
 *
 * 协议处理对齐 V1 探针（mud-core/tests/probe-client.mjs）：
 *   - 字节级 telnet 状态机；拒绝 MCCP2（日志保持明文）；接受 GMCP（观察其推送）；
 *   - 登录流式检测（提示符无换行）：编码选择回 2 → 名字 → 密码 → 覆盖确认 y；
 *   - 成功句 = 「重新连线完毕|目前权限：(player)|欢迎来到北大侠客行」。
 */

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── 参数 ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}
const HOST = arg('host', process.env.MUD_HOST || 'mud.pkuxkx.net')
const PORT = Number(arg('port', process.env.MUD_PORT || 8081))
const USER = arg('user', process.env.MUD_USER || 'vicrly')
const OBSERVE_MS = Number(arg('observe', '240')) * 1000
const PROBE_WAIT_MS = Number(arg('probe-wait', '6')) * 1000

function loadPass() {
  const p = arg('pass', process.env.MUD_PASS)
  if (p) return p
  // 宿主 credentials（C:/Users/<u>/.dsh/.credentials.yaml）refs 段里 MUD_PASS_vicrly_*
  // 只做 `KEY: value` 行解析（ref 值不含冒号，无需完整 YAML）
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const re = new RegExp(`^\\s+(MUD_PASS_${USER}_[0-9a-f]+):\\s*(\\S+)`, 'm')
  const m = fs.readFileSync(file, 'utf8').match(re)
  if (!m) throw new Error(`credentials refs 里找不到 MUD_PASS_${USER}_*`)
  return m[2]
}
const PASS = loadPass()

// ── 日志 ─────────────────────────────────────────────────────────────────────
const t0 = Date.now()
const ts = () => {
  const d = Date.now() - t0
  return `[${String(Math.floor(d / 60000)).padStart(2, '0')}:${String(Math.floor(d / 1000) % 60).padStart(2, '0')}.${String(d % 1000).padStart(3, '0')}]`
}
function log(text) { process.stdout.write(`${ts()} ${text}\n`) }

// ── telnet 常量与状态机 ─────────────────────────────────────────────────────
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250,
      GA = 249, EOR = 239, SE = 240, NOP = 241, AYT = 246
const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31, CHARSET: 42, MSSP: 70, COMPRESS2: 86, MSP: 90, GMCP: 201 }
const ACCEPT = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA, OPT.NAWS, OPT.TTYPE, OPT.CHARSET, OPT.MSSP, OPT.MSP, OPT.GMCP])
const PROVIDE = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA, OPT.TTYPE, OPT.NAWS, OPT.CHARSET])

let socket = null
let state = 'plain', iacType = 0, subBuf = [], subIac = false, curLine = []
const loginDec = new TextDecoder('utf-8', { stream: true })
let loginText = ''
const idleDec = new TextDecoder('utf-8', { stream: true })

function escapeIac(buf) {
  if (!buf.includes(IAC)) return buf
  const out = []
  for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC) }
  return Buffer.from(out)
}
function rawWrite(bytes, desc) {
  if (!socket || socket.destroyed) return
  socket.write(bytes)
  log(`TX ${desc} (${bytes.length}B)`)
}
function sendTelnet(type, option) { rawWrite(Buffer.from([IAC, type, option]), `IAC ${typeName(type)} ${optName(option)}`) }
function sendSb(option, data) {
  rawWrite(Buffer.concat([Buffer.from([IAC, SB, option]), Buffer.from(data), Buffer.from([IAC, SE])]),
    `IAC SB ${optName(option)} "${Buffer.from(data).toString('utf8')}"`)
}
function sendCommand(text) { rawWrite(escapeIac(Buffer.from(`${text}\r\n`, 'utf8')), `命令 ${JSON.stringify(text)}`) }
function typeName(t) { return { [WILL]: 'WILL', [WONT]: 'WONT', [DO]: 'DO', [DONT]: 'DONT' }[t] ?? `0x${t.toString(16)}` }
function optName(o) {
  const n = Object.entries(OPT).find(([, v]) => v === o)
  return n ? `${n[0]}(${o})` : `0x${o.toString(16)}`
}
function cmdName(b) { return { [NOP]: 'NOP', [AYT]: 'AYT', [GA]: 'GA', [EOR]: 'EOR', [SE]: 'SE' }[b] ?? `0x${b.toString(16)}` }

// ── 入站统计（心跳判定的原始数据）──────────────────────────────────────────
let lastRxAt = Date.now()
const gaps = []            // 入站间隔 ms（观察窗内）
let observeEvents = 0      // 观察窗内入站事件数（任何字节块都算）
let rxSinceProbe = false   // 探针候选发送后是否收到过入站
let probeTxtCount = 0      // 探针阶段收到的文本行数
let gaCount = 0, eorCount = 0, nopCount = 0, aytCount = 0, gmcpCount = 0

function noteRx() {
  const now = Date.now()
  gaps.push(now - lastRxAt)
  lastRxAt = now
  observeEvents += 1
}

// ── 登录状态机（流式检测，提示符无换行）────────────────────────────────────
let step = 'waitEncoding'
function loginWatch(b) {
  if (step !== 'waitEncoding' && step !== 'waitName' && step !== 'waitPass' && step !== 'waitReplace') return
  // stream:true 让解码器跨调用持有未完的多字节序列（逐字节喂入时必须，
  // 否则中文字节被打成 U+FFFD，'英文名字' 永远匹配不上）
  loginText += loginDec.decode(Buffer.from([b]), { stream: true })
  if (loginText.length > 4096) loginText = loginText.slice(-2048)
  if (step === 'waitEncoding' && loginText.includes('Input 1 for GBK')) {
    step = 'waitName'
    log('LOGIN → 编码选择提示, 发 2 (UTF-8)')
    sendCommand('2')
  } else if ((step === 'waitEncoding' || step === 'waitName') && loginText.includes('英文名字')) {
    step = 'waitPass'
    log(`LOGIN → 名字提示, 发用户名 ${USER}`)
    sendCommand(USER)
  } else if (step === 'waitPass' && /请输入密码/.test(loginText)) {
    step = 'waitReplace'
    log('LOGIN → 密码提示, 发密码')
    sendCommand(PASS)
  } else if (step === 'waitReplace' && /取而代之吗？\(y\/n\)/.test(loginText)) {
    log('LOGIN → 覆盖确认, 发 y')
    sendCommand('y')
  }
  if (step === 'waitReplace' && (/重新连线完毕|目前权限：\(player\)|欢迎来到北大侠客行/.test(loginText) || /重新连线完毕|目前权限：\(player\)/.test(lastLine))) {
    step = 'inGame'
    log('LOGIN → 登录成功，等入站静默后开始观察窗')
    armObserveStart()
  }
}
let lastLine = ''

// ── 文本行处理 ───────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
let idleTimer = null
function emitLine(asPrompt) {
  if (curLine.length === 0) return
  const text = idleDec.decode(Buffer.from(curLine), { stream: true }).replace(ANSI_RE, '').replace(CTRL_RE, '').replace(/\s+$/, '')
  curLine = []
  if (!text) return
  lastLine = text
  if (step === 'probing') probeTxtCount += 1
  log(`${asPrompt ? 'PROMPT' : 'TXT'} ${text.slice(0, 200)}`)
  loginWatchText(text)
}
function loginWatchText(text) {
  // 行级兜底（与流式检测幂等共存）：成功句/覆盖确认可能整行到达
  if (step === 'waitReplace' && /取而代之吗？\(y\/n\)/.test(text)) {
    log('LOGIN → (行级) 覆盖确认, 发 y')
    sendCommand('y')
    return
  }
  if (step === 'waitReplace' && /重新连线完毕|目前权限：\(player\)|欢迎来到北大侠客行/.test(text)) {
    step = 'inGame'
    log('LOGIN → (行级) 登录成功，等入站静默后开始观察窗')
    armObserveStart()
  }
}
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; emitLine(true) }, 400)
}

// ── 协议处理 ─────────────────────────────────────────────────────────────────
function handleCommand(type, option) {
  log(`TELNET ${typeName(type)} ${optName(option)}`)
  if (type === WILL) {
    if (option === OPT.COMPRESS2) { sendTelnet(DONT, option); return } // 拒压缩保明文
    if (ACCEPT.has(option)) { sendTelnet(DO, option); return }
    sendTelnet(DONT, option)
    return
  }
  if (type === DO) {
    if (PROVIDE.has(option)) {
      sendTelnet(WILL, option)
      if (option === OPT.NAWS) sendSb(OPT.NAWS, [80 >> 8, 80 & 0xff, 24 >> 8, 24 & 0xff])
    } else {
      sendTelnet(WONT, option)
    }
  }
}
function handleSub(option, data) {
  if (option === OPT.GMCP) {
    gmcpCount += 1
    log(`GMCP ${data.toString('utf8').slice(0, 200)}`)
    return
  }
  if (option === OPT.TTYPE && data[0] === 0x01) {
    sendSb(OPT.TTYPE, [0x00, ...Buffer.from('XTERM-256COLOR', 'ascii')])
    return
  }
  if (option === OPT.CHARSET && data[0] === 0x01) {
    const names = data.subarray(1).toString('utf8').split(/[ ,;]/).map(s => s.trim()).filter(Boolean)
    const picked = names.find(n => /^utf-?8$/i.test(n)) ?? names[0]
    if (picked) sendSb(OPT.CHARSET, [0x02, ...Buffer.from(picked, 'ascii')])
    return
  }
  log(`SB ${optName(option)} ${data.length}B (仅记录)`)
}

function processBytes(buf) {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (state === 'plain') {
      if (b === IAC) { state = 'iac'; i += 1; continue }
      if (b === 0x0a) { emitLine(false); i += 1; continue }
      if (b === 0x0d) { if (buf[i + 1] === 0x0a) i += 1; emitLine(false); i += 1; continue }
      curLine.push(b); loginWatch(b); i += 1; continue
    }
    if (state === 'iac') {
      if (b === IAC) { curLine.push(IAC); state = 'plain'; i += 1; continue }
      if (b === WILL || b === WONT || b === DO || b === DONT) { iacType = b; state = 'iac2'; i += 1; continue }
      if (b === SB) { subBuf = []; subIac = false; state = 'sub'; i += 1; continue }
      if (b === GA) { gaCount += 1; log(`RX IAC GA`); state = 'plain'; i += 1; continue }
      if (b === EOR) { eorCount += 1; log(`RX IAC EOR`); state = 'plain'; i += 1; continue }
      if (b === NOP) { nopCount += 1; log('RX IAC NOP ← 服务端心跳信号!'); state = 'plain'; i += 1; continue }
      if (b === AYT) { aytCount += 1; log('RX IAC AYT ← 服务端心跳信号!'); state = 'plain'; i += 1; continue }
      log(`RX IAC ${cmdName(b)} (单字节)`)
      state = 'plain'; i += 1; continue
    }
    if (state === 'iac2') { handleCommand(iacType, b); state = 'plain'; i += 1; continue }
    if (state === 'sub') {
      if (subIac) {
        i += 1
        if (b === SE) {
          const payload = Buffer.from(subBuf)
          handleSub(payload[0] ?? 0, payload.subarray(1))
          state = 'plain'; subIac = false
          continue
        }
        if (b === IAC) { subBuf.push(IAC); subIac = false; continue }
        const payload = Buffer.from(subBuf)
        handleSub(payload[0] ?? 0, payload.subarray(1))
        subIac = false; state = 'plain'
        continue
      }
      if (b === IAC) { subIac = true; i += 1; continue }
      subBuf.push(b); i += 1; continue
    }
  }
}

// ── 阶段编排 ─────────────────────────────────────────────────────────────────
let observeStarted = false
let observeTimer = null
let observeQuietTimer = null
let observeStartAt = 0

function armObserveStart() {
  if (observeStarted || observeQuietTimer) return
  observeQuietTimer = setTimeout(() => { observeQuietTimer = null; startObserve() }, 3000)
}
function startObserve() {
  observeStarted = true
  observeStartAt = Date.now()
  gaps.length = 0
  lastRxAt = Date.now()
  observeEvents = 0
  log(`===== 观察窗开始（客户端零发送 ${OBSERVE_MS / 1000}s）=====`)
  observeTimer = setTimeout(endObserve, OBSERVE_MS)
}
function endObserve() {
  const dur = (Date.now() - observeStartAt) / 1000
  log(`===== 观察窗结束（${dur}s）=====`)
  log(`SUMMARY-A 入站事件: ${observeEvents} 起；GA=${gaCount} EOR=${eorCount} NOP=${nopCount} AYT=${aytCount} GMCP=${gmcpCount}`)
  if (observeEvents === 0) {
    log('SUMMARY-A 判定: 观察窗内零入站 → 服务端无主动心跳')
  } else {
    const interval = gaps.slice(1).filter(g => g < 60_000)
    const maxGap = Math.max(...gaps)
    log(`SUMMARY-A 入站间隔(ms): ${interval.join(', ') || '(单起)'}；最大静默 ${Math.round(maxGap / 1000)}s`)
    log('SUMMARY-A 判定: 观察窗内有入站 → 见上方明细区分「服务端主动心跳」vs「登录尾包/回显」')
  }
  // 阶段 B：客户端心跳候选
  step = 'probing'
  log('===== 客户端心跳候选测试开始 =====')
  const candidates = [
    { desc: 'telnet NOP (IAC NOP 241)', send: () => rawWrite(Buffer.from([IAC, NOP]), 'IAC NOP') },
    { desc: 'telnet AYT (IAC AYT 246)', send: () => rawWrite(Buffer.from([IAC, AYT]), 'IAC AYT') },
    { desc: 'GMCP Core.KeepAlive', send: () => sendSb(OPT.GMCP, Buffer.from('Core.KeepAlive', 'utf8')) },
    { desc: 'GMCP Core.Ping', send: () => sendSb(OPT.GMCP, Buffer.from('Core.Ping', 'utf8')) },
    { desc: '空行 (sendCredential \'\' 等效)', send: () => sendCommand('') },
    { desc: 'look (链路存活对照)', send: () => sendCommand('look') },
  ]
  let idx = 0
  const next = () => {
    if (idx >= candidates.length) { finish('SUMMARY-B 全部候选已试发完毕'); return }
    const c = candidates[idx]
    idx += 1
    const before = { ga: gaCount, eor: eorCount, gmcp: gmcpCount, txt: probeTxtCount }
    rxSinceProbe = false
    log(`PROBE [${idx}/${candidates.length}] 发送: ${c.desc}`)
    c.send()
    setTimeout(() => {
      const dGa = gaCount - before.ga, dEor = eorCount - before.eor, dGmcp = gmcpCount - before.gmcp
      const dTxt = probeTxtCount - before.txt
      const responded = rxSinceProbe
      log(`PROBE [${idx}/${candidates.length}] 响应观察 ${PROBE_WAIT_MS / 1000}s 结束: ` +
        `GA+${dGa} EOR+${dEor} GMCP+${dGmcp} 文本+${dTxt}${responded ? '' : '（零入站）'}`)
      lastRxAt = Date.now()
      next()
    }, PROBE_WAIT_MS)
  }
  next()
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────
let closed = false
function finish(note) {
  if (closed) return
  closed = true
  if (observeTimer) clearTimeout(observeTimer)
  if (observeQuietTimer) clearTimeout(observeQuietTimer)
  if (idleTimer) clearTimeout(idleTimer)
  log(`FINISH ${note}`)
  try { socket?.end() } catch { /* ignore */ }
  setTimeout(() => process.exit(), 300)
}

log(`连接 ${HOST}:${PORT} ...`)
socket = net.createConnection({ host: HOST, port: PORT })
socket.setNoDelay(true)
socket.on('connect', () => log(`TCP 已连接, 发送 NAWS 80x24`))
socket.on('data', (chunk) => {
  noteRx()
  rxSinceProbe = true
  log(`RX 块 (${chunk.length}B)`)
  processBytes(chunk)
  armIdle()
})
socket.on('error', (err) => { log(`ERR 连接错误: ${err.message}`); finish('异常关闭') })
socket.on('close', () => {
  log('SYS 连接已关闭')
  if (step === 'inGame' && observeStarted) log('SUMMARY 判定: 静默期被服务端断开 → 服务端有 idle 踢人策略，无心跳保活')
  finish('连接关闭')
})

// 登录兜底：40s 未进游戏视为失败
setTimeout(() => {
  if (step !== 'inGame' && step !== 'probing') {
    log(`ERR 40s 未完成登录 (step=${step})，凭据或流程异常`)
    finish('登录超时')
  }
}, 40_000)

process.on('SIGINT', () => finish('收到 Ctrl+C'))
