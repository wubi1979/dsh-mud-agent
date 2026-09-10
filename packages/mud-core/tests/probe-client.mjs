#!/usr/bin/env node
/**
 * probe-client.mjs — 最小可直接启动的网络探测客户端 (standalone, 零依赖)。
 *
 * 用途:
 *   连接真实 MUD 服务器 (默认 mud.pkuxkx.net:8081), 完整协商 telnet 选项,
 *   发送 用户名 → 密码 → 登录后命令序列 (默认 look,w,w,check,e,e,id,
 *   give 2 silver to biao,up,enter,dazuo 10,hp,score,sk,lm,sleep,dz;
 *   --send 可追加), 并把服务器返回的 **原始字节** 逐块记录到日志
 *   (hex dump + 可读文本双视图) 与 .bin 文件, 供人工核对 dsh-mud 协议层
 *   (src/network/telnet.ts) 是否丢弃了数据。
 *
 * 特性:
 *   - 字节级 telnet 状态机 (IAC/DO/DONT/WILL/WONT/SB/SE/GA/EOR/NOP/转义),
 *     与 Mudlet ctelnet.cpp 的处理方式对齐 (含"子协商中裸 IAC"恢复策略);
 *   - 默认 **拒绝 MCCP2 压缩** (回复 DONT), 使原始日志明文可读; 传
 *     --accept-compression 则镜像 mud-core 的解压路径 (zlib → raw deflate 回退);
 *   - 不加凭据也能跑: 自动抓取登录横幅后退出 (冒烟测试用);
 *   - 登录后命令发送节奏: **每秒 1 条**; sleep 后额外等 28s (游戏内睡觉,
 *     醒来再发 dz)。需要更长总时长时用 --wait 调整 (默认 90s);
 *   - 登录阶段**实时字符检测** (不按行积攒): 名字/密码提示无换行符, 用流式
 *     UTF-8 解码逐字节累积并即时检测, 不等 400ms 静默刷出 — 用于验证
 *     "CHARSET 协商后不选编码, 名字提示是否真空降", 见 --no-select2;
 *   - 分页自动翻页 (与 trigger-rules.ts pager:continue 等效): 收到
 *     `== 未完继续 NN% ==` / `-- more --` 即发空格翻页, 防止 lm 等分页界面
 *     把后续定时命令 (sleep 等) 当翻页输入吞掉。
 *
 * 用法:
 *   node probe-client.mjs [--host mud.pkuxkx.net] [--port 8081]
 *        [--user <名字>] [--pass <密码>] [--send <命令>]
 *        [--out <日志路径>] [--bin <原始字节文件>] [--wait <秒>]
 *        [--accept-compression] [--keep-ansi] [--term XTERM-256COLOR]
 *        [--no-select2]   // 验证用: 收到 "Input 1 for GBK" 后**不回 2**,
 *                         // 实时观察名字提示是否出现 (25s 超时为"必须选2"的证据)
 *   或用环境变量 MUD_USER / MUD_PASS 提供凭据。
 *
 * 日志:
 *   - 默认写到 ./probe-<时间戳>.log  (UTF-8): 含 RX/TX 双向 hex dump、
 *     TELNET 协商事件、剥离 ANSI 的游戏文本行 (TXT) 与提示符 (PROMPT);
 *   - 默认同时写 ./probe-<时间戳>.bin: 服务器发来的原始字节 (压缩前), 可离线
 *     回放给 TelnetClient 比对。
 */

import net from 'node:net'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// ── Telnet 常量 ────────────────────────────────────────────────────────────
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250,
      GA = 249, EOR = 239, SE = 240
const OPT = {
  BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31, CHARSET: 42,
  MSSP: 70, COMPRESS: 85, COMPRESS2: 86, MSP: 90, GMCP: 201,
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= args.length) return fallback
  return args[i + 1]
}
function flag(name) { return args.includes(`--${name}`) }

const HOST = arg('host', process.env.MUD_HOST || 'mud.pkuxkx.net')
const PORT = Number(arg('port', process.env.MUD_PORT || 8081))
const USER = arg('user', process.env.MUD_USER ?? '')
const PASS = arg('pass', process.env.MUD_PASS ?? '')
const EXTRA_CMDS = args
  .map((a, i) => (a === '--send' ? args[i + 1] : null))
  .filter(Boolean)
const SESSION_WAIT_MS = Number(arg('wait', '90')) * 1000
const ACCEPT_COMPRESSION = flag('accept-compression')
const KEEP_ANSI = flag('keep-ansi')
const TERM = arg('term', 'XTERM-256COLOR')
const COLS = Number(arg('cols', '80'))
const ROWS = Number(arg('rows', '24'))
const NO_SELECT2 = flag('no-select2')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const LOG_PATH = arg('out', path.join(process.cwd(), `probe-${stamp}.log`))
const BIN_PATH = arg('bin', `${LOG_PATH.replace(/\.log$/, '')}.bin`)

// ── 日志 ────────────────────────────────────────────────────────────────────
let logFd = null
let binFd = null
let rxBytes = 0, txBytes = 0, rxChunks = 0, txCommands = 0, telnetEvents = 0

function log(text) {
  if (logFd) fs.appendFileSync(logFd, text + '\n')
  process.stdout.write(text + '\n')
}
const ts = () => new Date().toISOString().slice(11, 23)
const L = (tag, text) => log(`[${ts()}] ${tag} ${text}`)

/** hex + ascii 双栏 dump。 */
function hexdump(buf) {
  const out = []
  for (let off = 0; off < buf.length; off += 16) {
    const slice = buf.subarray(off, off + 16)
    const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...slice].map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    out.push(`  ${off.toString(16).padStart(4, '0')}  ${hex.padEnd(47)} |${ascii}|`)
  }
  return out.join('\n')
}

// ── ANSI 剥离 (与 src/preprocess/ansi.ts ANSI_STRIP_RE 等价) ───────────────
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
function stripAnsi(t) { return KEEP_ANSI ? t : t.replace(ANSI_RE, '') }

// ── 发送辅助 ────────────────────────────────────────────────────────────────
let socket = null

function escapeIac(buf) {
  if (!buf.includes(IAC)) return buf
  const out = []
  for (const b of buf) { out.push(b); if (b === IAC) out.push(IAC) }
  return Buffer.from(out)
}
function rawWrite(bytes, desc) {
  if (!socket || socket.destroyed) return
  socket.write(bytes)
  txBytes += bytes.length
  L('TX', `${desc} (${bytes.length}B):`)
  log(hexdump(bytes))
}
function sendTelnet(type, option) {
  telnetEvents += 1
  rawWrite(Buffer.from([IAC, type, option]), `IAC ${typeName(type)} ${optName(option)}`)
}
function sendSb(option, data) {
  telnetEvents += 1
  rawWrite(Buffer.concat([Buffer.from([IAC, SB, option]), Buffer.from(data), Buffer.from([IAC, SE])]),
    `IAC SB ${optName(option)} (${data.length}B)`)
}
function sendCommand(text) {
  const line = `${typeof text === 'string' ? text : String(text)}\r\n`
  txCommands += 1
  rawWrite(escapeIac(Buffer.from(line, 'utf8')), `命令 ${JSON.stringify(line.slice(0, -2))}`)
}

// ── 选项表 ──────────────────────────────────────────────────────────────────
function typeName(t) {
  return t === WILL ? 'WILL' : t === WONT ? 'WONT' : t === DO ? 'DO' : t === DONT ? 'DONT' : `0x${t.toString(16)}`
}
function optName(o) {
  const n = Object.entries(OPT).find(([, v]) => v === o)
  return n ? `${n[0]}(${o})` : `0x${o.toString(16)}`
}
function cmdName(b) {
  const table = { 239: 'EOR', 240: 'SE', 241: 'NOP', 242: 'DM', 243: 'BRK', 244: 'IP', 245: 'AO', 246: 'AYT', 247: 'EC', 248: 'EL', 249: 'GA', 250: 'SB' }
  return table[b] ?? `0x${b.toString(16)}`
}

// 协商选项集合 (对齐 mud-core src/network/telnet.ts 的 ACCEPT) + 客户端可提供集
const ACCEPT = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA, OPT.NAWS, OPT.TTYPE,
  OPT.CHARSET, OPT.MSSP, OPT.COMPRESS2, OPT.MSP, OPT.GMCP])
const PROVIDE = new Set([OPT.BINARY, OPT.ECHO, OPT.SGA, OPT.TTYPE, OPT.NAWS, OPT.CHARSET])

// ── 字节级 telnet 状态机 (对齐 Mudlet processSocketData) ────────────────────
let state = 'plain'          // plain | iac | iac2 | sub
let iacType = 0              // iac2 中暂存的 WILL/WONT/DO/DONT
let subBuf = []              // 子协商载荷字节
let subIac = false           // 子协商中遇到 IAC (等待转义/SE)
let curLine = []             // 当前文本行原始字节 (未解码, 保留一切)
let mccp2 = false
let inflate = null
let inflateReady = false
let inflateBuffered = null
let idleTimer = null         // 无换行行尾 (提示符) 静默刷出定时器, 对齐 300ms posting

function plainByte(b) {
  curLine.push(b)
  loginWatch(b)
}

// ── 登录阶段实时字符检测 (不按行积攒) ──────────────────────────────────────
// 名字/密码提示无换行符; 若只靠"行缓冲 + 400ms 静默刷出"判断, 会误以为
// "服务器没发提示"。此处用流式 UTF-8 解码器逐字节累积明文, 每收到新字符立即
// 检测关键子串 (不等换行/不等静默定时器), 幂等性由 step 状态机保证 (命中即
// 迁移状态, 不重复动作)。验证 --no-select2 时, 名字提示是否"即时"出现是关键。
let loginDec = null            // 流式 UTF-8 解码器 (登录阶段专用)
let loginText = ''             // 已解码明文 (登录阶段累积, 上限保留尾部)
const LOGIN_TEXT_MAX = 2048

function loginWatch(b) {
  if (step === 'captureOnly' || step === 'inGame') return
  loginDec ??= new TextDecoder('utf-8', { stream: true })
  loginText += loginDec.decode(Buffer.from([b]))
  if (loginText.length > LOGIN_TEXT_MAX) loginText = loginText.slice(-1024)
  checkLoginLive()
}

/** 即时子串检测: 命中即迁移 step (与 onCookedLine 行级兜底幂等共存)。 */
function checkLoginLive() {
  if (step === 'waitEncoding') {
    if (loginText.includes('Input 1 for GBK')) {
      step = 'waitName'
      if (NO_SELECT2) {
        L('LOGIN', '→ (实时) 编码选择提示; --no-select2: 不回 2, 开始观察名字提示是否出现')
      } else {
        L('LOGIN', '→ (实时) 编码选择提示, 发送 2 (UTF-8)')
        sendCommand('2')
      }
      return
    }
    return
  }
  if (step === 'waitName' && (loginText.includes('您的英文名字') || loginText.includes('英文名字'))) {
    step = 'waitPass'
    L('LOGIN', '→ (实时) 名字提示出现, 发送用户名')
    sendCommand(USER)
    return
  }
  if (step === 'waitPass' && /请输入密码|请输入.*密码|password/i.test(loginText)) {
    step = 'waitInGame'
    L('LOGIN', '→ (实时) 密码提示, 发送密码')
    sendCommand(PASS)
    armInGameTimer()
    return
  }
  if (step === 'waitInGame') {
    if (/同名|覆盖|替换/.test(loginText)) {
      L('LOGIN', '→ (实时) 档案覆盖确认 (y/n), 发送 y')
      sendCommand('y')
      return
    }
    if (/欢迎来到北大侠客行|重新连线|欢迎回来/.test(loginText)) {
      step = 'inGame'
      L('LOGIN', '→ (实时) 识别到登录完成')
      scheduleNextCommand()
    }
  }
}

/** 密码后 4s 兜底: 未识别到游戏内提示则按已进入游戏继续 (与 onCookedLine 共用)。 */
function armInGameTimer() {
  if (gameTimer) clearTimeout(gameTimer)
  gameTimer = setTimeout(() => {
    if (step === 'waitInGame') {
      step = 'inGame'
      L('LOGIN', '→ 密码后 4s 未识别到游戏内提示, 按已进入游戏继续')
      scheduleNextCommand()
    }
  }, 4000)
}

/** 400ms 静默到期: 把无换行的行尾刷成 PROMPT (对齐 Mudlet mTimeOut=300 / mud-core FLUSH_IDLE_MS)。 */
function armIdle() {
  if (curLine.length === 0) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    emitLine(true)
  }, 400)
}

/** 把当前行刷出为 TXT 行 (换行终止) 或 PROMPT 行 (GA/EOR/静默终止)。 */
function emitLine(asPrompt) {
  if (curLine.length === 0) return
  const text = stripAnsi(Buffer.from(curLine).toString('utf8')).replace(CTRL_RE, '').replace(/\s+$/, '')
  curLine = []
  if (text === '') { log('  (空行)'); return }
  log(`${asPrompt ? 'PROMPT' : 'TXT  '} ${text}`)
  onCookedLine(text, asPrompt)
}
function promptFlush(why) {
  if (curLine.length > 0) {
    L('FLUSH', `~${why} 提示符边界`)
    emitLine(true)
    scheduleNextCommand()
  }
}

function handleCommand(type, option) {
  telnetEvents += 1
  L('TELNET', `${typeName(type)} ${optName(option)}`)
  if (type === WILL) {
    if (ACCEPT.has(option)) {
      if ((option === OPT.COMPRESS || option === OPT.COMPRESS2) && !ACCEPT_COMPRESSION) {
        log(`  → 拒绝压缩 (DONT ${optName(option)}): 保持日志明文可读; 传 --accept-compression 可镜像 mud-core 解压路径`)
        sendTelnet(DONT, option)
        return
      }
      if (option === OPT.COMPRESS2) log('  → 接受压缩 (DO COMPRESS2)')
      sendTelnet(DO, option)
      return
    }
    log(`  → 未在支持集, 拒绝 (DONT ${optName(option)})`)
    sendTelnet(DONT, option)
    return
  }
  if (type === WONT) {
    log(`  → 服务器关闭选项${option === OPT.ECHO ? ' (ECHO 关 = 密码输入中)' : ''}`)
    return
  }
  if (type === DO) {
    if (PROVIDE.has(option)) {
      sendTelnet(WILL, option)
      if (option === OPT.NAWS) sendNaws()
      return
    }
    log(`  → 客户端不提供, 拒绝 (WONT ${optName(option)})`)
    sendTelnet(WONT, option)
    return
  }
  if (type === DONT) {
    log('  → 服务器 DONT，被动接受')
  }
}

function handleSub(option, data) {
  telnetEvents += 1
  L('SB', `${optName(option)} 载荷 ${data.length}B`)
  log(hexdump(Buffer.from(data)))
  if (option === OPT.TTYPE) {
    if (data.length >= 1 && data[0] === 0x01 /* SEND */) {
      sendSb(OPT.TTYPE, [0x00 /* IS */, ...[...Buffer.from(TERM, 'ascii')]])
      log(`  → 回复终端类型 ${TERM}`)
    }
    return
  }
  if (option === OPT.CHARSET) {
    if (data.length >= 1 && data[0] === 0x01 /* REQUEST */) {
      const names = Buffer.from(data.subarray(1)).toString('utf8').split(/[ ,;]/).map(s => s.trim()).filter(Boolean)
      const picked = names.find(n => /^utf-?8$/i.test(n)) ?? names[0]
      if (picked) {
        sendSb(OPT.CHARSET, [0x02 /* ACCEPTED */, ...[...Buffer.from(picked, 'ascii')]])
        log(`  → 接受字符集 ${picked}`)
      }
    }
    return
  }
  if (option === OPT.COMPRESS2) {
    if (ACCEPT_COMPRESSION) {
      startMccp2()
      log('  → MCCP2 压缩流激活 (zlib 优先, raw deflate 回退)')
    } else {
      log('  → 已拒绝压缩, 此标记不应出现 (若出现说明服务器无视 DONT)')
    }
    return
  }
  // GMCP / MSSP / MSP / 其它: 仅记录, 不消费
  const sample = Buffer.from(data.subarray(0, 64)).toString('utf8').replace(CTRL_RE, ' ').replace(/\s+/g, ' ')
  log(`  → 内容(前64B): ${sample || '(空)'}`)
}

// ── MCCP2 (仅在 --accept-compression 时启用; 镜像 mud-core makeInflate/feedCompressed) ──
function startMccp2() {
  mccp2 = true
  inflateReady = false
  inflateBuffered = null
  inflate = makeInflate(false)
}
function makeInflate(raw) {
  const inf = raw ? zlib.createInflateRaw() : zlib.createInflate()
  inf.on('data', (out) => {
    inflateReady = true
    inflateBuffered = null
    processBytes(out) // 解压输出仍可能含 telnet 序列 → 重新走状态机 (与 mud-core 一致)
  })
  inf.on('error', (err) => {
    if (!inflateReady && !raw) {
      const replay = inflateBuffered
      inflateBuffered = null
      L('MCCP2', `zlib 解压失败 (${err.message}) → 回退 raw deflate (pkuxkx)`)
      inflate = makeInflate(true)
      if (replay) inflate.write(replay)
      return
    }
    L('MCCP2', `块解压失败 (${err.message}) → 本块尾部丢弃 (与 mud-core 行为一致)`)
  })
  return inf
}
function feedCompressed(chunk) {
  if (!inflateReady) {
    inflateBuffered = inflateBuffered ? Buffer.concat([inflateBuffered, chunk]) : chunk
  }
  inflate?.write(chunk)
}

/** 逐字节状态机。处理后若 mccp2 已激活且 buf 有剩余 → 剩余为压缩数据。 */
function processBytes(buf) {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (state === 'plain') {
      if (b === IAC) { state = 'iac'; i += 1; continue }
      if (b === 0x0a) { emitLine(false); i += 1; continue }                              // \n 行界
      if (b === 0x0d) { if (buf[i + 1] === 0x0a) { i += 1; continue } emitLine(false); i += 1; continue } // \r\n 或孤立 \r
      plainByte(b); i += 1; continue
    }
    if (state === 'iac') {
      if (b === IAC) { plainByte(IAC); state = 'plain'; i += 1; continue }        // IAC IAC 转义 → 字面 0xFF 文本
      if (b === WILL || b === WONT || b === DO || b === DONT) { iacType = b; state = 'iac2'; i += 1; continue }
      if (b === SB) { subBuf = []; subIac = false; state = 'sub'; i += 1; continue }
      if (b === GA) { L('TELNET', 'IAC GA'); promptFlush('GA'); state = 'plain'; i += 1; continue }
      if (b === EOR) { L('TELNET', 'IAC EOR'); promptFlush('EOR'); state = 'plain'; i += 1; continue }
      L('TELNET', `IAC ${cmdName(b)} (单字节命令, 跳过)`); state = 'plain'; i += 1; continue
    }
    if (state === 'iac2') {
      handleCommand(iacType, b); state = 'plain'; i += 1; continue
    }
    if (state === 'sub') {
      if (subIac) {
        i += 1
        if (b === SE) {
          const payload = Buffer.from(subBuf)
          const option = payload[0] ?? 0
          handleSub(option, payload.subarray(1))
          state = 'plain'
          subIac = false
          // 若刚激活压缩, 本 buffer 剩余字节是压缩数据
          if (mccp2 && inflate && option === OPT.COMPRESS2 && i < buf.length) {
            feedCompressed(buf.subarray(i))
            return
          }
          continue
        }
        if (b === IAC) { subBuf.push(IAC); subIac = false; continue }            // 转义的 IAC (子协商内字面 0xFF)
        // 裸 IAC + 非SE/非IAC: 按 Mudlet 策略截断该子协商, 本字节重新入状态机
        L('SUB', '子协商中遇裸 IAC (非 SE/非 IAC) → 截断子协商, 按 Mudlet 策略恢复')
        const payload = Buffer.from(subBuf)
        const option = payload[0] ?? 0
        handleSub(option, payload.subarray(1))
        subIac = false
        state = 'plain'
        continue // 不 i++: 该字节从 plain 重新处理
      }
      if (b === IAC) { subIac = true; i += 1; continue }
      subBuf.push(b); i += 1; continue
    }
  }
}

// ── 登录/命令编排 (文本匹配 + 定时器兜底) ───────────────────────────────────
let step = USER ? 'waitEncoding' : 'captureOnly'
let loginPromptSeen = false
let gameStarted = false
let gameTimer = null
let nextCmdIdx = 0
// 登录完成后的默认命令序列: {cmd, wait} 中 wait = "发送后到下一命令的间隔(ms)"。
// 节奏: 每秒 1 条 (wait 1000); sleep 为游戏内睡觉, 发送后等 28s 醒来再发 dz。
const DEFAULT_IN_GAME_CMDS = [
  { cmd: 'look', wait: 1000 },
  { cmd: 'w', wait: 1000 },
  { cmd: 'w', wait: 1000 },
  { cmd: 'check', wait: 1000 },
  { cmd: 'e', wait: 1000 },
  { cmd: 'e', wait: 1000 },
  { cmd: 'id', wait: 1000 },
  { cmd: 'give 2 silver to biao', wait: 1000 },
  { cmd: 'up', wait: 1000 },
  { cmd: 'enter', wait: 1000 },
  { cmd: 'dazuo 10', wait: 1000 },
  { cmd: 'hp', wait: 1000 },
  { cmd: 'score', wait: 1000 },
  { cmd: 'sk', wait: 1000 },
  { cmd: 'lm', wait: 1000 },
  { cmd: 'sleep', wait: 38000 },   // 游戏内睡觉, 等 38s (实测 28s 未醒角色仍在睡, 加 10s)
  { cmd: 'dz', wait: 1000 },
]
const inGameCmds = [...DEFAULT_IN_GAME_CMDS, ...EXTRA_CMDS.map(c => ({ cmd: c, wait: 1000 }))]

function onCookedLine(text, isPrompt) {
  const t = text.trim()
  // ── 分页自动翻页 (与 trigger-rules.ts pager:continue 等效, 探针版) ──
  //   实测 (01:52 会话): lm 大地图停在 `== 未完继续 88% ==` 分页界面, 此时
  //   定时命令 (sleep) 会被服务器当翻页输入吞掉。命中分页提示 → 立即发空格
  //   翻页, 服务器 26ms 级响应, 连续翻页先于下一条定时命令完成。不设节流:
  //   连续多页需要快速翻; 每行提示只触发一次 (正常不会洗屏循环)。
  if (step !== 'captureOnly' && (/^== 未完继续 [\d，,]+% == \(q 离开，b 前一页，其他继续下一页\)\s*$/.test(t) || /^-- more --\s*$/.test(t))) {
    L('LOGIN', '→ 分页提示, 自动翻页 (空格)')
    sendCommand(' ')
    return
  }
  if (step === 'captureOnly') {
    if (/Input 1 for GBK/.test(t)) L('LOGIN', '→ 注意: 服务器要求先选编码 (1=GBK, 2=UTF8, 3=BIG5), 真实登录需先回 2')
    if (/您的英文名字|英文名字/.test(t) && !loginPromptSeen) {
      loginPromptSeen = true
      L('LOGIN', '→ 已抓取到名字提示, 2s 后关闭')
      setTimeout(() => finish(0), 2000)
    }
    return
  }
  // 真实 pkuxkx 流程 (8081 实测): 编码选择 → 名字 → 密码
  if (step === 'waitEncoding') {
    if (/Input 1 for GBK/.test(t)) {
      step = 'waitName'
      if (NO_SELECT2) {
        L('LOGIN', '→ (行级) 编码选择提示; --no-select2: 不回 2, 观察名字提示是否出现')
      } else {
        L('LOGIN', '→ (行级) 编码选择提示, 发送 2 (UTF-8)')
        sendCommand('2')
      }
      return
    }
    if (/您的英文名字|英文名字|请输入new/.test(t)) {
      // 服务器若因 CHARSET 协商已确立而跳过编码选择: 直接进入名字阶段
      step = 'waitPass'
      L('LOGIN', '→ (未出现编码选择) 名字提示, 发送用户名')
      sendCommand(USER)
      return
    }
    return
  }
  if (step === 'waitName' && /您的英文名字|英文名字|请输入new/.test(t)) {
    step = 'waitPass'
    L('LOGIN', '→ 名字提示, 发送用户名')
    sendCommand(USER)
    return
  }
  if (step === 'waitPass' && /请输入密码|请输入.*密码|password/i.test(t)) {
    step = 'waitInGame'
    L('LOGIN', '→ 密码提示, 发送密码')
    sendCommand(PASS)
    armInGameTimer()
    return
  }
  if (step === 'waitInGame' && /同名|覆盖|替换/.test(t)) {
    L('LOGIN', '→ 档案覆盖确认 (y/n), 发送 y')
    sendCommand('y')
    return
  }
  if (step === 'waitInGame' && /欢迎来到北大侠客行|重新连线|欢迎回来/.test(t)) {
    step = 'inGame'
    L('LOGIN', '→ 识别到登录完成')
    scheduleNextCommand()
    return
  }
  void isPrompt
  void t
}

function scheduleNextCommand() {
  if (gameStarted) return
  gameStarted = true
  const next = () => {
    if (nextCmdIdx >= inGameCmds.length) {
      L('LOGIN', '→ 全部命令已发送, 静候收尾')
      return
    }
    const { cmd, wait } = inGameCmds[nextCmdIdx]
    nextCmdIdx += 1
    L('LOGIN', `→ 发送 ${JSON.stringify(cmd)}`)
    sendCommand(cmd)
    if (wait > 1000) L('LOGIN', `→ (下一条延迟 ${(wait / 1000).toFixed(0)}s)`)
    setTimeout(next, wait)
  }
  setTimeout(next, 800)
}

// ── 连接生命周期 ────────────────────────────────────────────────────────────
function sendNaws() {
  sendSb(OPT.NAWS, [COLS >> 8, COLS & 0xff, ROWS >> 8, ROWS & 0xff])
}

function finish(exitCode = 0) {
  if (closeTimer) clearTimeout(closeTimer)
  if (gameTimer) clearTimeout(gameTimer)
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (socket && !socket.destroyed) { try { socket.end() } catch { /* ignore */ } }
  if (curLine.length > 0) emitLine(false)
  const stat = [
    '',
    `===== 会话结束 ${new Date().toISOString()} =====`,
    `RX: ${rxChunks} 块 / ${rxBytes} 字节   TX: 命令 ${txCommands} 条 / ${txBytes} 字节`,
    `TELNET 事件: ${telnetEvents} 起 (已识别命令全部在日志中标注)`,
    `原始字节文件: ${BIN_PATH}`,
    `日志文件: ${LOG_PATH}`,
  ].join('\n')
  if (logFd) { try { fs.appendFileSync(logFd, stat + '\n'); fs.closeSync(logFd) } catch { /* ignore */ } logFd = null }
  if (binFd) { try { fs.closeSync(binFd) } catch { /* ignore */ } binFd = null }
  process.stdout.write(stat + '\n')
  process.exitCode = exitCode
  setTimeout(() => process.exit(), 100)
}
let closeTimer = null

// ── 启动 ────────────────────────────────────────────────────────────────────
fs.writeFileSync(LOG_PATH, `\uFEFF===== dsh-mud 网络探测会话 =====\n时间: ${new Date().toISOString()}\n` +
  `目标: ${HOST}:${PORT}   用户: ${USER ? `${USER}` : '(未提供, 仅抓取登录横幅)'}\n` +
  `压缩: ${ACCEPT_COMPRESSION ? '接受 (zlib→raw 回退)' : '拒绝 (日志保持明文)'}   终端: ${TERM} ${COLS}x${ROWS}\n` +
  `编码选择: ${NO_SELECT2 ? '不回 2 (--no-select2 验证: 观察名字提示是否自行出现)' : '收到 Input 1 for GBK 即回 2 (UTF-8)'}\n\n`)
logFd = fs.openSync(LOG_PATH, 'a')
binFd = fs.openSync(BIN_PATH, 'w')

L('SYS', `连接 ${HOST}:${PORT} ...`)
socket = net.createConnection({ host: HOST, port: PORT })
socket.setNoDelay(true)

socket.on('connect', () => {
  L('SYS', `TCP 已连接, 发送 NAWS ${COLS}x${ROWS}`)
  sendNaws()
})

socket.on('data', (chunk) => {
  rxChunks += 1
  rxBytes += chunk.length
  L('RX', `块 #${rxChunks} (${chunk.length}B)`)
  log(hexdump(chunk))
  fs.writeSync(binFd, chunk)
  if (mccp2 && inflate) { feedCompressed(chunk); return }
  processBytes(chunk)
  armIdle() // 每块新数据重置静默计时 (对齐 mud-core scheduleFlush)
})

socket.on('error', (err) => {
  L('ERR', `连接错误: ${err.message}`)
  finish(1)
})
socket.on('close', () => {
  L('SYS', '连接关闭')
  finish(0)
})

// 硬上限: 无凭据时只抓登录横幅 (≤20s); 有凭据时按 --wait (默认 90s)
const totalWait = USER ? SESSION_WAIT_MS : Math.min(SESSION_WAIT_MS, 20000)
closeTimer = setTimeout(() => {
  L('SYS', `会话达到 ${totalWait / 1000}s, 主动结束`)
  finish(0)
}, totalWait)

// 登录提示兜底: 25s 没等到名字提示/编码提示 → 凭据或端口可能不对, 直接结束
// (--no-select2 验证模式: 此时 step 停留在 waitName, 25s 无名字提示即证据 —
//  服务器不回编码选择绝不会自行给出名字提示, 结论"必须选 2")。
if (USER) {
  setTimeout(() => {
    if (step === 'waitEncoding' || step === 'waitName') {
      L('ERR', NO_SELECT2
        ? '25s 未等到名字提示 → --no-select2 验证结论: 服务器要求先选编码 (不回 2 不会进入名字阶段)'
        : '25s 未等到名字提示 (是否被服务器拒绝/需要先选编码?), 主动结束')
      finish(1)
    }
  }, 25000)
}

process.on('SIGINT', () => { L('SYS', '收到 Ctrl+C'); finish(0) })
process.on('SIGTERM', () => { L('SYS', '收到 SIGTERM'); finish(0) })