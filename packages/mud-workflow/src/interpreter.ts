/**
 * interpreter — 声明式流程解释器（纯函数，进程内，无沙箱）。
 *
 * 执行语义（每步 = wait → failOn 出口 → action → 路由）：
 *   1. **读窗**：wait 存在则先等（判据满足才动作）；等待前取 pending 尾部
 *      快照（SNAP_LINES）做 initial——提示符先到先结算，不丢（login.ts 同款）；
 *   2. **failOn 出口**：reason=failOn 时在**本窗文本**上按声明序重测 failOn
 *      正则，首个命中的 index 查 onFailOn——登记为 exit 即终结（分类出口），
 *      登记为 goto 即转后继步；无登记 → 缺省 timeout 出口（失败行是上一步
 *      应答的分类，重测序 = 声明序，确定性）；
 *   3. **动作**：send 直发（引擎槽 {captcha} + 命名槽替换，不碰 {name}/{pass}）；
 *      sendCredential 先替换 {captcha}/命名槽/{name}/{pass} 再直发（不回显不
 *      落盘）；captcha 推图挂起等人工码值（io.awaitCaptcha(url)——url 由流程
 *      捕获槽传入，T14 D9）——answer 值入 {captcha} 固定单槽继续 / aborted →
 *      专用 aborted 出口 / closed → timeout 出口；发送失败 = 连接已断开 →
 *      timeout 出口；
 *   4. **路由**：本窗文本上按声明序重测 until，首个命中 index 查 branch
 *     （exit = 终结 / goto = 后继）；未命中/越界走 next；**无 next 且无
 *      branch 命中 = 结构缺出口**——返回结构化 timeout 出口并点名步骤
 *     （粗胚修缮闭环的失败信号，不静默）；
 *   5. **非 done/failOn 收束**（timeout/quiet/signal/disconnected/danger）一律
 *      timeout 出口（等待未达成；现场行已收集随结果返回）。
 *
 * 护栏：
 *   - 红线执行侧拦截：非 locked 流程执行 sendCredential/captcha 动词 → throw
 *    （save 侧已静态拒绝，执行侧再拦一道——双闸，闸本身各只有一行判）；
 *   - 步转移上限 MAX_TRANSITIONS：goto 环 + 永不收束的窗组合下防止进程内
 *      无界循环（每步读窗有超时，环只烧预算不烧死进程）；
 *   - 出口统一过 pass 掩码（凭据零泄露最后一道闸——流程作者忘写也不泄露）。
 *
 * 结构合法性（goto 目标存在/命中序界内）由 schema.checkFlow 在保存/装载时
 * 保证，解释器不重复校验；运行期只对"缺出口"给结构化失败。
 */

import type { Step, Wait, WorkflowRecord } from './schema.ts'
import type {
  IoReadOpts, IoReadResult, WorkflowCredentials, WorkflowIO, WorkflowOutcome,
} from './io.ts'

/** pass 明文的掩码（出口脱敏用）。 */
export const PASS_MASK = '******'

/** 步转移上限（goto 环护栏；流程步骤表 ≤64，256 = 足够绕环数圈）。 */
export const MAX_TRANSITIONS = 256

/** 等待前的 pending 尾部快照行数（login.ts 同款 SNAP_LINES）。 */
const SNAP_LINES = 100

/** 正则源编译（flags 应用于整组判据；非法正则 throw 可读错——保存门已拦，此处兜底）。 */
function compileSources(sources: string[], what: string, flags = ''): RegExp[] {
  return sources.map((src) => {
    try {
      return new RegExp(src, flags)
    } catch (e) {
      throw new Error(`流程判据非法：${what} 正则非法: ${src}（${(e as Error).message}）`)
    }
  })
}

/** Wait → IoReadOpts（正则编译）。 */
function compileWait(wait: Wait): IoReadOpts {
  const flags = wait.flags ?? ''
  return {
    ...(wait.until !== undefined ? { until: compileSources(wait.until, 'until', flags) } : {}),
    ...(wait.failOn !== undefined ? { failOn: compileSources(wait.failOn, 'failOn', flags) } : {}),
    ...(wait.gaCount !== undefined ? { gaCount: wait.gaCount } : {}),
    ...(wait.quietMs !== undefined ? { quietMs: wait.quietMs } : {}),
    ...(wait.maxLines !== undefined ? { maxLines: wait.maxLines } : {}),
    timeoutMs: wait.timeoutMs,
  }
}

/** 首个命中的正则 index（声明序；无命中返回 -1）。 */
function firstHit(regexes: RegExp[], text: string): number {
  return regexes.findIndex(re => re.test(text))
}

/** 占位替换（T14 四源，次序固定）：{captcha} → 命名槽表 → {name}/{pass}。
 * 三类存储结构性分立（{captcha} 独立变量、命名槽在 Map、凭据在 creds 对象），
 * 保留名不靠运行期判名防撞（保存门已拒存撞名）；未知 {xxx} 原样保留；
 * {captcha} 未填充（captcha 动作未跑）同样原样保留。sendCredential 与
 * captcha 动作参数（D9）走本函数。 */
function substitute(
  cmd: string,
  creds: WorkflowCredentials,
  captcha: string | undefined,
  slots: ReadonlyMap<string, string>,
): string {
  let s = captcha === undefined ? cmd : cmd.split('{captcha}').join(captcha)
  for (const [k, v] of slots) s = s.split(`{${k}}`).join(v)
  return s.split('{name}').join(creds.name).split('{pass}').join(creds.pass)
}

/** send 侧槽替换（引擎注入槽 + 命名槽；仍不碰凭据占位 {name}/{pass}——不因
 * 命名槽顺手放开，凭据零进 send 纪律不变）。 */
function substituteSlots(cmd: string, captcha: string | undefined, slots: ReadonlyMap<string, string>): string {
  let s = captcha === undefined ? cmd : cmd.split('{captcha}').join(captcha)
  for (const [k, v] of slots) s = s.split(`{${k}}`).join(v)
  return s
}

/**
 * 捕获提取（T14 D3/D10/D11）：对窗文本按行找 until[0] 首个命中行，exec 取
 * 捕获组按序入槽表。用无 g 的独立正则实例（flags 含 g 时剥离——按行多次
 * test/exec，lastIndex 污染会漏捕获）；无命中行/组缺失/空值返回现场说明串
 * （调用方按 D11 空值护栏收束，不落槽），成功返回 null。
 */
function captureSlots(
  untilSrc: string,
  flags: string,
  windowText: string,
  captures: readonly string[],
  slots: Map<string, string>,
): string | null {
  const re = new RegExp(untilSrc, flags.replace(/g/g, ''))
  const hitLine = windowText.split('\n').find(l => re.test(l))
  const m = hitLine === undefined ? null : re.exec(hitLine)
  if (m === null) return `步骤判据在本窗无命中行：${untilSrc}`
  for (let i = 0; i < captures.length; i++) {
    const v = m[i + 1]
    if (v === undefined || v === '') return `捕获槽 ${captures[i]} 提取为空`
    slots.set(captures[i]!, v)
  }
  return null
}

/**
 * 执行流程（纯函数：record + io + 凭据 → 结构化结果）。
 *
 * @param record - 流程记录（locked 红线判定来源；flow 结构已过 checkFlow）。
 * @param io - 会话 IO 原语（缝侧注入；持有者独占由缝侧保证）。
 * @param creds - 凭据（{name}/{pass} 占位替换源；不经模型）。
 * @throws 非 locked 流程使用凭据动词（红线）；判据正则非法（兜底，保存门已拦）。
 */
export async function runFlow(
  record: WorkflowRecord,
  io: WorkflowIO,
  creds: WorkflowCredentials,
): Promise<WorkflowOutcome> {
  const byId = new Map(record.flow.steps.map(s => [s.id, s]))
  const lines: string[] = []
  const collect = (batch: readonly { text: string }[]) => {
    lines.push(...batch.map(l => l.text))
  }
  // 出口统一过 pass 掩码（现场行只进工具结果，掩码在这里一次性收口）。
  const exit = (stage: string, ok: boolean, notes: readonly string[] = []): WorkflowOutcome => ({
    ok,
    stage,
    lines: [...lines, ...notes].map(l =>
      creds.pass === '' ? l : l.split(creds.pass).join(PASS_MASK),
    ),
  })
  const timeoutExit = (notes: readonly string[] = []): WorkflowOutcome => exit('timeout', false, notes)

  let step: Step | undefined = byId.get(record.flow.entry)
  // 引擎注入槽（run 级固定单槽；{captcha} 值由 captcha 动作填入，D5 非敏感）。
  let captchaSlot: string | undefined
  // 命名槽表（T14 run 级；捕获步写入，后续动作经 substitute 消费。重经捕获步
  // 覆盖、未重经沿用上值——goto 不清槽，D4 两种复用情形由此自然成立）。
  const slots = new Map<string, string>()
  for (let i = 0; i < MAX_TRANSITIONS && step !== undefined; i++) {
    let windowText = ''

    // 1. 读窗（等待前取尾部快照：提示符可能已到达——先到先结算，不丢）。
    if (step.wait !== undefined) {
      const opts = compileWait(step.wait)
      const r: IoReadResult = await io.read(opts, io.recentLines(SNAP_LINES))
      collect(r.lines)
      windowText = r.lines.map(l => l.text).join('\n')

      if (r.reason === 'failOn') {
        // 2. failOn 出口：本窗文本按声明序重测，首个命中 index 查 onFailOn。
        const idx = firstHit(opts.failOn ?? [], windowText)
        const target = idx >= 0 ? step.onFailOn?.[String(idx)] : undefined
        if (target === undefined) return timeoutExit()
        if ('exit' in target) return exit(target.exit.stage, target.exit.ok)
        step = byId.get(target.goto)
        continue
      }
      if (r.reason !== 'done') return timeoutExit()

      // 1.5 捕获提取（T14 D3/D10/D11）：done 收束后、动作前——只在本窗文本
      // 的 until[0] 命中行上提取（failOn 收束已在上方分叉，不捕获）；无命中行/
      // 组空值 → 结构化 timeout 同型收束（D11 fail-loud：不落空串进槽、不进
      // 后续 send，现场可辨）。
      if (step.wait.captures !== undefined && step.wait.captures.length > 0 && step.wait.until !== undefined) {
        const failNote = captureSlots(
          step.wait.until[0]!, step.wait.flags ?? '', windowText, step.wait.captures, slots,
        )
        if (failNote !== null) {
          return timeoutExit([`（步骤 ${step.id} 捕获失败：${failNote}——空值护栏收束，不落槽）`])
        }
      }
    }

    // 3. 动作：路由前执行（步骤的应答总发；条件发送 = 独立步骤，login replace 同型）。
    if (step.action !== undefined) {
      if ('captcha' in step.action) {
        // captcha 动作（T13.1 D4 / T14 D9 参数化）：URL 由流程捕获槽传入
        //（参数值过 substitute——写死 URL 无命中即原样），引擎内置抓图/推帧/
        // 挂起，纯层只管分流与填槽；aborted = 专用收束出口（stage 可辨），
        // closed = 既有 timeout 出口。
        if (record.locked !== true) {
          throw new Error(`流程 ${record.name} 非 locked，禁止使用 captcha（凭据红线）`)
        }
        const r = await io.awaitCaptcha(substitute(step.action.captcha.url, creds, captchaSlot, slots))
        if (r.kind === 'aborted') return exit('aborted', false)
        if (r.kind !== 'answer') return timeoutExit()
        captchaSlot = r.value
      } else if ('sendCredential' in step.action) {
        if (record.locked !== true) {
          throw new Error(`流程 ${record.name} 非 locked，禁止使用 sendCredential（凭据红线）`)
        }
        if (!io.sendCredential(substitute(step.action.sendCredential, creds, captchaSlot, slots))) {
          return timeoutExit(['（连接已断开：发送失败）'])
        }
      } else if (!io.send(substituteSlots(step.action.send, captchaSlot, slots))) {
        return timeoutExit(['（连接已断开：发送失败）'])
      }
    }

    // 4. 路由：until 声明序重测 → branch[index]；未命中/越界 → next。
    let route: Step['next'] = step.next
    if (step.wait?.until !== undefined && step.branch !== undefined) {
      const idx = firstHit(compileSources(step.wait.until, 'until', step.wait.flags ?? ''), windowText)
      if (idx >= 0 && idx < step.branch.length) route = step.branch[idx]
    }
    if (route === undefined) {
      return timeoutExit([`（步骤 ${step.id} 未声明后继：branch 未命中且无 next——流程结构缺出口）`])
    }
    if ('exit' in route) return exit(route.exit.stage, route.exit.ok)
    step = byId.get(route.goto)
    if (step === undefined) {
      // checkFlow 已保证 goto 存在；防御兜底给结构化失败（不静默）。
      return timeoutExit([`（后继步不存在：${route.goto}）`])
    }
  }
  return timeoutExit([`（步转移超过上限 ${MAX_TRANSITIONS}：流程疑似 goto 环）`])
}
