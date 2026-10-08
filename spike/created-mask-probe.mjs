/**
 * 「恢复时点遮蔽」spike 探针（方案 B 验证；临时 DSH_HOME，不随插件发布）。
 *
 * 验证问题：
 *   A1  agent/created 缝里 surfaceOp replace 是否被宿主接受（不被 reentry 守卫拒绝）；
 *   A2  该替换持久化后，下一进程重放不判 corrupt 且遮蔽仍在（表面不再含旧节点）；
 *   A3  替换之后本进程的追加（prompt 文本）照常可见；
 *   A4  下一进程再 adopt 时，上一进程的起点标记与新消息**一并**成为"既有历史"被再次遮蔽
 *      （即：恢复时点遮蔽天然给出"每进程一次"语义）。
 *
 * 流程：
 *   phase 1：create 新会话 → created（表面空 ⇒ 预期 skip）→ prompt(OLD) 一轮 → 落盘退出
 *   phase 2：create 同 id（adopt 重放）→ created 缝里立即遮蔽既有表面 → prompt(THIRD) 一轮
 *            → 请求应含 MARK/THIRD、不含 OLD → 落盘退出
 *   phase 3：create 同 id 再 adopt（重放校验 ②-a）→ created 再次遮蔽（旧标记+THIRD 成历史）
 *            → prompt(FOURTH) → 请求应含 MARK/FOURTH、不含 OLD/THIRD
 *
 * 零依赖：不 import 任何 dsh/本仓包。运行见 created-mask.patch.yml 头注。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const P = 'PROBE-B'
const OLD = 'PROBE-B-历史文本：我上一轮在客栈买了一把剑。'
const THIRD = 'PROBE-B-第三轮文本：现在去当铺。'
const FOURTH = 'PROBE-B-第四轮文本：看看背包。'
const MARK = '本次运行起点'
const SESSION = 'created-mask-1'
const STATE = 'D:/code/_spike/created-mask/state.json'

const log = line => console.log(`${P} ${line}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}

export const name = 'created-mask-probe'
export const inject = []

export function apply(ctx) {
  const requests = []
  const surfaces = new Map()
  /** 每进程一次的遮蔽守卫（同会话重复 announce 不再遮）。 */
  const masked = new Set()
  let target = ''
  const epochMs = Math.round(Date.now() - process.uptime() * 1000)

  ctx.on('llm/stream', (options, next) => {
    let text = ''
    try { text = JSON.stringify(options) ?? '' } catch { text = '' }
    requests.push(text)
    log(`req#${requests.length} bytes=${text.length} MARK=${text.includes(MARK)} OLD=${text.includes(OLD)} THIRD=${text.includes(THIRD)} FOURTH=${text.includes(FOURTH)}`)
    return next()
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== target) return
    if (event.type === 'assistant/message' || event.type === 'step/start') return
    log(`event ${event.type}#${event.seq}`)
  }, { global: true })

  const turnEnd = sessionId => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 turn/end 超时：${sessionId}`)), 60000)
    const dispose = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== sessionId || event.type !== 'turn/end') return
      clearTimeout(timer)
      dispose()
      resolve(event.data?.reason)
    }, { global: true })
  })

  /** created 缝里的恢复时点遮蔽（方案 B 本体）。 */
  const maskAtCreated = session => {
    const id = String(session.id)
    if (masked.has(id)) { log(`created ${id} 本进程已遮过 ⇒ 跳过（每进程一次守卫）`); return }
    masked.add(id)
    const nodes = [...session.surface.nodes]
    log(`created session=${id} nodes=[${nodes.join(',')}] seq=${String(session.seq)}`)
    if (nodes.length < 2) { log(`mask-at-created ⇒ skip（表面无既有历史，新会话预期）`); return }
    const events = session.snapshotEvents()
    const bySeq = new Map(events.map(event => [event.seq, event]))
    const types = nodes.map(seq => bySeq.get(seq)?.type)
    // 尾节点保留规则：最末是 system/message 则退一格（与 elide.ts 同款）。
    let endIdx = nodes.length - 1
    if (types[endIdx] === 'system/message') endIdx -= 1
    if (endIdx < 1) { log(`mask-at-created ⇒ skip（尾保留规则清空范围）`); return }
    const shadowed = nodes.slice(1, endIdx + 1)
    const marker = {
      id: `probe-epoch-${epochMs}`,
      role: 'user',
      content: [{ type: 'text', text: `${MARK}（运行标识 ${epochMs}-probe）：上一次进程的历史已失效，请勿据此判断现状。` }],
      source: { kind: 'user' },
    }
    try {
      const appended = session.append('user/message', marker, {
        surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes[endIdx] },
        sourceEventSeqs: shadowed,
      })
      log(`mask-at-created ⇒ ACCEPTED seq=${appended.seq} shadowed=[${shadowed.join(',')}] start=${nodes[1]} end=${nodes[endIdx]}`)
      log(`after-mask nodes=[${[...session.surface.nodes].join(',')}] replaceGeneration=${session.surface.replaceGeneration}`)
    } catch (error) {
      log(`mask-at-created ⇒ REJECTED（A1 FAIL）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    surfaces.set(String(session.id), session)
    if (String(session.id) === target || process.env.SMOKE_PHASE === '1') maskAtCreated(session)
  }, { global: true })

  const flushAndExit = async code => {
    try {
      const sessions = ctx.get('sessions')
      for (const session of surfaces.values()) await sessions?.flush?.(session)
      await sleep(500)
    } catch (error) {
      log(`flush 失败：${String(error)}`)
    }
    process.exit(code)
  }

  const run = async () => {
    const phase = process.env.SMOKE_PHASE ?? '1'
    const controller = await until(() => ctx.get('sessionController'), 60000, 'sessionController')
    log(`phase=${phase} controller.create=${typeof controller.create} prompt=${typeof controller.prompt}`)
    const cwd = 'D:/code/_spike/created-mask/cwd'

    if (phase === '1') {
      await controller.create({ sessionId: SESSION, cwd, agentPreset: 'standard' })
      const session = await until(() => surfaces.get(SESSION), 30000, 'agent/created(phase1)')
      const first = turnEnd(SESSION)
      await controller.prompt({ requestId: 'b-1', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: OLD }] }, new AbortController().signal)
      log(`turn1 end reason=${JSON.stringify(await first)}`)
      const nodes = [...session.surface.nodes]
      const oldSeqs = session.snapshotEvents().filter(event => JSON.stringify(event.data ?? '').includes(OLD)).map(event => event.seq)
      log(`after turn1 nodes=[${nodes.join(',')}] oldSeqs=[${oldSeqs.join(',')}]`)
      const ok = requests.some(request => request.includes(OLD))
      log(ok ? 'ASSERT-PASS ⓪ 首轮请求含 OLD 文本（历史正常落表面）' : 'ASSERT-FAIL ⓪')
      writeFileSync(STATE, JSON.stringify({ sessionId: SESSION, oldSeqs }, null, 2))
      return flushAndExit(ok ? 0 : 1)
    }

    const state = JSON.parse(readFileSync(STATE, 'utf8'))
    target = String(state.sessionId)
    try {
      const inspection = await controller.inspect(target, new AbortController().signal)
      log(`inspect=${(JSON.stringify(inspection) ?? '').slice(0, 400)}`)
    } catch (error) {
      log(`inspect 失败：${String(error)}`)
    }
    let adopted
    try {
      adopted = await controller.create({ sessionId: target, cwd, agentPreset: 'standard' })
      log(`adopt ok session=${String(adopted.sessionId)}`)
    } catch (error) {
      log(`ASSERT-FAIL ②-a 重放恢复失败（日志 corrupt？）：${String(error)}`)
      return flushAndExit(1)
    }
    const session = await until(() => surfaces.get(target), 30000, 'agent/created(adopt)')
    const nodes = [...session.surface.nodes]
    const stillVisible = state.oldSeqs.filter(seq => nodes.includes(seq))
    log(`adopt nodes=[${nodes.join(',')}] oldSeqs=[${state.oldSeqs.join(',')}] stillVisible=[${stillVisible.join(',')}]`)
    if (stillVisible.length > 0) { log('ASSERT-FAIL ②-b 旧节点在 created 遮蔽后仍可见'); return flushAndExit(1) }

    const turn = turnEnd(target)
    const text = phase === '2' ? THIRD : FOURTH
    await controller.prompt({ requestId: `b-${phase}`, sessionId: target, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
    log(`turn end reason=${JSON.stringify(await turn)}`)
    const last = requests[requests.length - 1] ?? ''
    if (phase === '2') {
      const pass = last.includes(MARK) && !last.includes(OLD) && last.includes(THIRD)
      log(`turn request: MARK=${last.includes(MARK)} OLD=${last.includes(OLD)} THIRD=${last.includes(THIRD)} ⇒ ${pass ? 'ASSERT-PASS A1+A3 created 缝遮蔽被接受、替换生效且本进程新文本在场' : 'ASSERT-FAIL A1/A3'}`)
      return flushAndExit(pass ? 0 : 1)
    }
    // phase 3：上一进程的标记与 THIRD 文本同属既有历史 ⇒ 双双不可见；OLD 同样不可见。
    const pass = last.includes(MARK) && !last.includes(OLD) && !last.includes(THIRD) && last.includes(FOURTH)
    log(`turn request: MARK=${last.includes(MARK)} OLD=${last.includes(OLD)} THIRD=${last.includes(THIRD)} FOURTH=${last.includes(FOURTH)} ⇒ ${pass ? 'ASSERT-PASS A2+A4 重放未 corrupt、遮蔽持久、上一进程上下文按进程边界再遮蔽' : 'ASSERT-FAIL A2/A4'}`)
    return flushAndExit(pass ? 0 : 1)
  }

  run().catch(error => {
    log(`FATAL ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    process.exit(2)
  })
}
