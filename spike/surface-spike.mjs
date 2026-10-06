/**
 * spike: 会话「表面替换」（surfaceOp replace）作为"进程级上下文"的可行性验证。
 *
 * 三问：
 *   ① 外部插件能否对既有会话追加 surfaceOp:{op:'replace'} 事件，并让 model-visible 表面真的收缩；
 *   ② 收缩后对话请求里是否真的不再包含被遮蔽的历史（同进程 + 跨进程重放）；
 *   ③ 与宿主 compaction 共存（同组合内两者都在，且替换后可继续 append / 组装请求）。
 *
 * 纪律（第一次 spike 实测踩到，必须遵守）：
 *   - 绝不在会话 system head 就位之前追加任何 message 事件。宿主的存储格式要求
 *     「surface node 0 必须是受保护的 system head」，违反时 append 当场成功、日志照写，
 *     但下一次进程重放直接判 corrupt（`system/message requires a protected first surface head`）。
 *   - 因此只在 turn/end 边界（表面稳定）且 nodes[0] === system/message 的 seq 时动。
 *   - 替换范围不含 node 0（保留 head），sourceEventSeqs 必须覆盖全部被遮蔽节点。
 *
 * 用法（DSH_HOME 指向临时目录）：
 *   $env:DSH_HOME='D:\code\_spike\dshhome'
 *   pnpm --dir D:/Code/deepseek-harness dsh headless --patch <本目录>/surface-spike.patch.yml "spike runA"
 *   $env:SPIKE_MODE='control'      # 对照组：只追加、不替换
 *   --session-id <id>              # 第二次进程：验证重放 + 跨进程请求
 */

export const name = 'surface-spike'
export const inject = []

const P = 'SURFACE-SPIKE'

/** @param {string} line */
function log(line) {
  console.log(`${P} ${line}`)
}

/**
 * 构造一条 user 消息数据（UserMessage：id/role/content/source）。
 * @param {string} id - 消息 id（运行时任意字符串）。
 * @param {string} text - 正文。
 */
function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch (error) {
    return `<<unserializable: ${String(error)}>>`
  }
}

/**
 * 从 llm/stream 的请求对象里判定四个标记的可见性。
 * @param {unknown} options - llm/stream 的 GenerateOptions。
 * @param {string} label - 输出标签。
 */
function captureRequest(options, label) {
  const text = safeJson(options)
  const has = marker => text.includes(marker)
  const seen = {
    RESET: has('SPIKE-RESET'),
    OLD1: has('SPIKE-OLD-1'),
    OLD2: has('SPIKE-OLD-2'),
    KEEP: has('SPIKE-KEEP'),
  }
  const messages = options?.messages
  const roles = Array.isArray(messages) ? messages.map(message => String(message?.role)).join(',') : 'n/a'
  const perMessage = Array.isArray(messages)
    ? messages.map(message => {
      const body = safeJson(message)
      const marks = ['RESET', 'OLD-1', 'OLD-2', 'KEEP'].filter(mark => body.includes(`SPIKE-${mark}`))
      return `${String(message?.role)}[${marks.join('+') || '-'}]`
    }).join(' ')
    : ''
  log(`${label} request bytes=${text.length} roles=[${roles}] RESET=${seen.RESET} OLD1=${seen.OLD1} OLD2=${seen.OLD2} KEEP=${seen.KEEP}`)
  if (perMessage !== '') log(`${label} per-message ${perMessage}`)
  if (text.length < 3000) log(`${label} small-request preview ${text.slice(0, 200)}`)
  if (seen.RESET && !seen.OLD1 && !seen.OLD2 && seen.KEEP) log(`${label} ASSERT-PASS 历史已遮蔽且新消息在场`)
  else if (!seen.RESET && seen.OLD1 && seen.OLD2) log(`${label} ASSERT-CONTROL 历史在场（对照组预期）`)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  const mode = process.env.SPIKE_MODE ?? 'replace'
  let captured = 0

  // 必须先于适配器（适配器是终止监听器，不调用 next()）——所以 prepend。
  ctx.on('llm/stream', (options, next) => {
    captured += 1
    captureRequest(options, `[${P}] req#${captured}`)
    return next()
  }, { prepend: true })

  /**
   * turn/end 边界（表面稳定、system head 已就位）执行追加 / 替换。
   * @param {any} session - 目标会话。
   */
  function mutate(session) {
    const nodes = [...session.surface.nodes]
    const events = session.snapshotEvents()
    const headSeq = events.find(event => event.type === 'system/message')?.seq
    if (headSeq === undefined || nodes[0] !== headSeq) {
      log(`SKIP 未满足 head 不变量 head=${String(headSeq)} nodes=[${nodes.join(',')}]（绝不在 head 之前追加）`)
      return
    }
    const old1 = session.append('user/message', userMessage('spike-old-1', 'SPIKE-OLD-1 上一次运行的历史：我在客栈。'), { surfaceOp: 'append' })
    const old2 = session.append('user/message', userMessage('spike-old-2', 'SPIKE-OLD-2 上一次运行的历史：我买了一把剑。'), { surfaceOp: 'append' })
    let resetSeq = 'n/a'
    if (mode !== 'control') {
      const reset = session.append(
        'user/message',
        userMessage('spike-reset', 'SPIKE-RESET 上一次运行的历史已随进程结束失效；本消息为本次运行的起点。'),
        { surfaceOp: { op: 'replace', startSeq: old1.seq, endSeq: old2.seq }, sourceEventSeqs: [old1.seq, old2.seq] },
      )
      resetSeq = String(reset.seq)
    }
    const keep = session.append('user/message', userMessage('spike-keep', 'SPIKE-KEEP 本次运行有效。'), { surfaceOp: 'append' })
    log(`MUTATED mode=${mode} head=${headSeq} nodesBefore=[${nodes.join(',')}] old=[${old1.seq},${old2.seq}]`
      + ` reset=${resetSeq} keep=${keep.seq} nodesAfter=[${session.surface.nodes.join(',')}]`
      + ` replaceGeneration=${session.surface.replaceGeneration}`)
  }

  /**
   * 重放检查：日志重放后旧节点是否仍被遮蔽。
   * @param {any} session - 目标会话。
   */
  function replayCheck(session) {
    const nodes = [...session.surface.nodes]
    const events = session.snapshotEvents()
    const oldSeqs = events.filter(event => safeJson(event.data).includes('SPIKE-OLD-')).map(event => event.seq)
    const oldVisible = oldSeqs.filter(seq => nodes.includes(seq))
    const headSeq = events.find(event => event.type === 'system/message')?.seq
    log(`replay head=${String(headSeq)} nodes=[${nodes.join(',')}] oldSeqs=[${oldSeqs.join(',')}]`
      + ` oldStillVisible=[${oldVisible.join(',')}] replaceGeneration=${session.surface.replaceGeneration}`)
    log(oldVisible.length === 0
      ? '[SURFACE-SPIKE] ASSERT-DURABLE 重放后旧历史仍被遮蔽'
      : '[SURFACE-SPIKE] ASSERT-DURABLE-FAIL 重放后旧历史重新可见')
  }

  /**
   * 在 agent/pre-step（瀑布、非 append 发布期）内做遮蔽：该时点表面稳定、且晚于它组装的
   * 本次请求会读到新表面——compaction-basic 用的就是这个缝。
   * @param {any} agent - 本步的 agent。
   */
  function maybeMutate(agent) {
    const session = agent?.session
    if (session === undefined) return
    if (session.header.parentSession !== undefined) return // 只对根会话做
    const events = session.snapshotEvents()
    const touched = events.some(event => {
      const body = safeJson(event.data)
      return body.includes('SPIKE-RESET') || body.includes('SPIKE-KEEP')
    })
    if (touched) return
    const nodes = [...session.surface.nodes]
    const headSeq = events.find(event => event.type === 'system/message')?.seq
    if (nodes.length === 0 || headSeq === undefined || nodes[0] !== headSeq) {
      log(`SKIP 表面未就绪（head=${String(headSeq)} nodes=[${nodes.join(',')}]）——绝不在 head 之前追加`)
      return
    }
    mutate(session)
  }

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      maybeMutate(payload?.agent)
    } catch (error) {
      log(`MUTATE-ERROR ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
    return next()
  }, { global: true })

  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    if (session.header.parentSession !== undefined) return undefined // 只对根会话做
    const events = session.snapshotEvents()
    const touched = events.some(event => {
      const body = safeJson(event.data)
      return body.includes('SPIKE-RESET') || body.includes('SPIKE-KEEP')
    })
    log(`agent/created mode=${mode} session=${session.id} cwd=${String(session.header.cwd)} seq=${String(session.seq)}`
      + ` nodes=[${session.surface.nodes.join(',')}] touched=${touched}`)
    log(`composition compaction=${ctx.get('compaction') !== undefined} tokenMeter=${ctx.get('tokenMeter') !== undefined} llm=${ctx.get('llm') !== undefined}`)
    if (touched) replayCheck(session)
    return undefined
  }, { global: true })
}
