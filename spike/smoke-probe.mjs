/**
 * T18.2 实机冒烟探针（临时 DSH_HOME；只用于验证，不随插件发布）。
 *
 * 目的：在**真实宿主组合**里验证 mud-core3 的 T18 接线（surfaceOp 遮蔽）：
 *   phase 1：建服务器+账号（走真实 mudRemote 动词）→ 第 1 轮（表面空 ⇒ 预期 skip、请求照发）
 *            → 第 2 轮（head 已就位 ⇒ 预期遮蔽；本轮请求应含进程起点标记、不含上一轮文本）
 *   phase 2：新进程 create 同 id（重放恢复；日志损坏会在此抛错）→ 断言旧节点不在表面
 *            → 再发一轮 → 请求仍不含旧文本
 *
 * 零依赖：不 import 任何 dsh/本仓包，只用 ctx 与对象上的公开成员。
 * 运行：见 spike/smoke.patch.yml 头注（web profile + 临时 DSH_HOME）。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const P = 'SMOKE-T18'
const OLD = 'SMOKE-历史文本：我上一轮在客栈买了一把剑。'
const NEW = 'SMOKE-本轮文本：现在去当铺。'
const THIRD = 'SMOKE-第三轮文本：看看背包。'
const MARK = '本次运行起点'
const STATE = 'D:/code/_spike/smoke/state.json'

const log = line => console.log(`${P} ${line}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 轮询等待条件成立。 */
async function until(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await sleep(200)
  }
  throw new Error(`等待超时：${label}`)
}

export const name = 'smoke-t18'
export const inject = []

export function apply(ctx) {
  const requests = []
  let target = ''
  ctx.on('llm/stream', (options, next) => {
    let text = ''
    try { text = JSON.stringify(options) ?? '' } catch { text = '' }
    requests.push(text)
    log(`req#${requests.length} bytes=${text.length} MARK=${text.includes(MARK)} OLD=${text.includes(OLD)} NEW=${text.includes(NEW)}`)
    return next()
  }, { prepend: true })

  // 诊断 trace：本目标会话的每个 pre-step（含核心遮蔽前的表面与日志）与每个提交事件。
  ctx.on('agent/pre-step', (payload, next) => {
    const session = payload?.agent?.session
    if (session !== undefined && String(payload.agent.id) === target) {
      log(`pre-step nodes=[${[...session.surface.nodes].join(',')}] events=[${session.snapshotEvents().map(event => `${event.type}#${event.seq}`).join(' ')}]`)
    }
    return next()
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (String(session.id) !== target) return
    if (event.type === 'assistant/message' || event.type === 'step/start') return
    log(`event ${event.type}#${event.seq}`)
  }, { global: true })

  /** 等一轮结束（turn/end）。 */
  const turnEnd = sessionId => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 turn/end 超时：${sessionId}`)), 60000)
    const dispose = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== sessionId || event.type !== 'turn/end') return
      clearTimeout(timer)
      dispose()
      resolve(event.data?.reason)
    }, { global: true })
  })

  const surfaces = new Map()
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    const id = String(session.id)
    surfaces.set(id, session)
    log(`agent/created session=${id} nodes=[${[...session.surface.nodes].join(',')}] seq=${String(session.seq)}`)
  }, { global: true })

  const run = async () => {
    const phase = process.env.SMOKE_PHASE ?? '1'
    const controller = await until(() => ctx.get('sessionController'), 60000, 'sessionController')
    const remote = await until(() => ctx.get('mudRemote'), 60000, 'mudRemote')
    const storage = await until(() => ctx.get('storageDomain'), 60000, 'storageDomain')
    log(`phase=${phase} services: remote=${typeof remote.addAccount} controller=${typeof controller.create}/${typeof controller.prompt} storage=${typeof storage.open}`)

    if (phase === '1') {
      try {
        await remote.addServer({ workspaceId: 'ws-smoke', name: 'smoke', host: '127.0.0.1', port: 23 })
      } catch (error) {
        log(`addServer 跳过（重复端点）：${String(error)}`)
      }
      const added = await remote.addAccount({
        serverId: 'ws-smoke', name: 'smoke', passRef: '', preset: 'standard', cwd: 'D:/code/_spike/smoke',
      })
      const sessionId = String(added.account.id)
      log(`account created session=${sessionId} preset=${added.account.preset}`)
      await until(() => surfaces.get(sessionId), 30000, 'agent/created')

      // 第 1 轮：表面为空 ⇒ 预期 skip（不阻断），请求照发
      const first = turnEnd(sessionId)
      await controller.prompt({ requestId: 'smoke-1', sessionId, mode: 'queue', content: [{ type: 'text', text: OLD }] }, new AbortController().signal)
      log(`turn1 end reason=${JSON.stringify(await first)}`)
      const session = surfaces.get(sessionId)
      const before = [...session.surface.nodes]
      const oldSeqs = session.snapshotEvents().filter(e => JSON.stringify(e.data ?? '').includes(OLD)).map(e => e.seq)
      log(`after turn1 nodes=[${before.join(',')}] oldSeqs=[${oldSeqs.join(',')}] markerseqlater`)
      log(`turn1 request: MARK=${requests[0]?.includes(MARK) ?? false}（预期 false：表面空 ⇒ 新会话首个 step 是预期 skip 且不阻断）`)

      // 第 2 轮：head 已就位 ⇒ 预期遮蔽，本轮请求只看到起点标记
      const second = turnEnd(sessionId)
      await controller.prompt({ requestId: 'smoke-2', sessionId, mode: 'queue', content: [{ type: 'text', text: NEW }] }, new AbortController().signal)
      log(`turn2 end reason=${JSON.stringify(await second)}`)
      const nodesAfter = [...session.surface.nodes]
      const last = requests[requests.length - 1] ?? ''
      const pass = last.includes(MARK) && !last.includes(OLD) && last.includes(NEW)
      log(`after turn2 nodes=[${nodesAfter.join(',')}] replaceGeneration=${session.surface.replaceGeneration}`)
      log(`turn2 request: MARK=${last.includes(MARK)} OLD=${last.includes(OLD)} NEW=${last.includes(NEW)} ⇒ ${pass ? 'ASSERT-PASS ①（遮蔽生效且新文本在场）' : 'ASSERT-FAIL ①'}`)
      writeFileSync(STATE, JSON.stringify({ sessionId, oldSeqs, nodesBefore: before, requests: requests.length }, null, 2))
      log(`state written ${STATE}`)
      return flushAndExit(pass ? 0 : 1)
    }

    const state = JSON.parse(readFileSync(STATE, 'utf8'))
    const sessionId = String(state.sessionId)
    target = sessionId
    // 上一次进程是否把日志完整落盘（含 turn/end）：inspect 是"不激活 agent 的冷读"。
    try {
      const inspection = await controller.inspect(sessionId, new AbortController().signal)
      const text = JSON.stringify(inspection) ?? ''
      log(`inspect=${text.slice(0, 600)}`)
    } catch (error) {
      log(`inspect 失败：${String(error)}`)
    }
    // 重放恢复：日志若损坏，create 会抛错（这正是 ② 的 corruption 断言）
    let adopted
    try {
      adopted = await controller.create({ sessionId, cwd: 'D:/code/_spike/smoke', agentPreset: 'standard' })
      log(`phase2 adopt ok session=${String(adopted.sessionId)}`)
    } catch (error) {
      log(`ASSERT-FAIL ②-a 重放恢复失败（日志 corrupt？）：${String(error)}`)
      return flushAndExit(1)
    }
    const session = await until(() => surfaces.get(sessionId), 30000, 'agent/created(phase2)')
    const nodes = [...session.surface.nodes]
    const stillVisible = state.oldSeqs.filter(seq => nodes.includes(seq))
    log(`phase2 nodes=[${nodes.join(',')}] oldSeqs=[${state.oldSeqs.join(',')}] stillVisible=[${stillVisible.join(',')}]`)
    log(stillVisible.length === 0 ? 'ASSERT-PASS ②-b 重放后旧节点仍被遮蔽' : 'ASSERT-FAIL ②-b 旧节点重新可见')

    const third = turnEnd(sessionId)
    await controller.prompt({ requestId: 'smoke-3', sessionId, mode: 'queue', content: [{ type: 'text', text: THIRD }] }, new AbortController().signal)
    log(`turn3 end reason=${JSON.stringify(await third)}`)
    const last = requests[requests.length - 1] ?? ''
    const pass = last.includes(MARK) && !last.includes(OLD) && last.includes(THIRD)
    // 本进程 epoch 的标记是否真的进了请求（证明本进程又遮蔽了一次，而非沿用上一进程的标记）
    const ownEpochMs = String(Math.round(Date.now() - process.uptime() * 1000))
    const stamped = [...last.matchAll(/运行标识 (\d+)-/g)].map(match => match[1])
    const ownStamp = stamped.some(ms => Math.abs(Number(ms) - Number(ownEpochMs)) < 2000)
    const session2 = surfaces.get(sessionId)
    log(`phase2 after turn3 nodes=[${[...session2.surface.nodes].join(',')}] replaceGeneration=${session2.surface.replaceGeneration} seq=${String(session2.seq)}`)
    log(`phase2 本进程 epoch 标记在请求中=${ownStamp}（marks=[${stamped.join(',')}] 本进程≈${ownEpochMs}）`)
    log(`turn3 request: MARK=${last.includes(MARK)} OLD=${last.includes(OLD)} THIRD=${last.includes(THIRD)} ⇒ ${pass ? 'ASSERT-PASS ②-c' : 'ASSERT-FAIL ②-c'}`)
    return flushAndExit(pass && stillVisible.length === 0 && ownStamp ? 0 : 1)
  }

  /** 退出前把缓冲事件落到持久层（宿主不保证回合边界 flush）。 */
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

  run().catch(error => {
    log(`FATAL ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    process.exit(2)
  })
}
