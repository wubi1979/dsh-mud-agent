/**
 * core/interpreter — 声明式流程解释器（纯函数，进程内，无沙箱）。
 *
 * **内核层**（A1）：只依赖契约层（`../contract`），零 cordis、零宿主、零 I/O——
 * 因此可脱离宿主被离线校验器/回放器/CLI 直接引用。**T26.6 起内核不再编译正则**
 * （判据词汇单点 DEC-21）：`wait` 以 raw 声明透传 `io.read`，表条目合并与编译
 * 在缝侧单点完成（core3 `resolveAwaitPlan` + `workflowIoFor`）。
 *
 * 执行语义（每步 = wait → 负面出口 → 捕获 → 动作 → 两级路由，T26.6 终态）：
 *   0. **判据不在此层匹配**（T15）：读窗机随读结果返回**命中帧**（`hit`：哪个
 *      结局赢了 + 该条首个命中的捕获组，§5.2）；本层只用帧做分类、填槽与路由——
 *      系统内**不存在第二套判据匹配**；
 *   1. **读窗**：wait 存在则先等（判据满足才动作）；等待前取 pending 尾部
 *      快照（SNAP_LINES）做 initial——提示符先到先结算，不丢（login.ts 同款）；
 *      收窗形态与表条目合并由缝侧解析（结果归因 `closeOn`/`command`/`source`）；
 *   2. **负面出口**：fail 槽命中（criteria 判定序 fail 先于 ok / ga 分类命中
 *      fail 槽 / ga 断言失败「收窗成功，分支未知」/ quiet 零行）即裁决——
 *      onOutcome.fail 直达（粗粒度常态）或 when 细化按槽名；未覆盖 → 缺省
 *      timeout 出口 + 结果行点名未覆盖槽（DEC-13 ③）；
 *   2.5 **捕获提取**（T14/T15 改由帧供值；T26 具名化 DEC-19）：captureFrom 槽
 *      命中 → 帧里的组值按序入 run 级命名槽，组缺失/空值 → 结构化 timeout
 *      同型收束（D11 空值护栏）；无结局命中（GA 关窗无分类）⇒ 同护栏收束；
 *      其他结局命中 ⇒ 跳过捕获照常路由；
 *   3. **动作**：send 直发（引擎槽 {captcha} + 命名槽替换，不碰 {name}/{pass}）；
 *      sendCredential 先替换 {captcha}/命名槽/{name}/{pass} 再直发（不回显不
 *      落盘）；captcha 推图挂起等人工码值（io.awaitCaptcha(url)——url 由流程
 *      捕获槽传入，T14 D9）——answer 值入 {captcha} 固定单槽继续 / aborted →
 *      专用 aborted 出口 / closed → timeout 出口；发送失败 = 连接已断开 →
 *      timeout 出口；
 *   4. **路由（两级，DEC-19）**：ok 槽命中 → onOutcome.ok 直达或 when 细化
 *      （未覆盖 ⇒ next——kind 缺省）；无命中（ga 关窗未声明分类槽）⇒ next；
 *      quiet 有行 ⇒ ok 路由（读窗机合成帧，reason 不参与）；**无 next 且无
 *      覆盖 = 结构缺出口**——返回结构化 timeout 出口并点名步骤（粗胚修缮
 *      闭环的失败信号，不静默）；
 *   5. **其余收束**（criteria 判据失配：timeout/maxLines；ga 超时：GA 未到；
 *      signal/disconnected/danger）一律 timeout 出口（等待未达成；现场行已
 *      收集随结果返回）。
 *
 * 护栏：
 *   - 红线执行侧拦截：非 locked 流程执行 sendCredential/captcha 动词 → throw
 *    （save 侧已静态拒绝，执行侧再拦一道——双闸，闸本身各只有一行判）；
 *   - 步转移上限 MAX_TRANSITIONS：goto 环 + 永不收束的窗组合下防止进程内
 *      无界循环（每步读窗有超时，环只烧预算不烧死进程）；
 *   - 出口统一过 pass 掩码（凭据零泄露最后一道闸——流程作者忘写也不泄露）。
 *
 * 结构合法性（goto 目标存在/when 键 ⊆ 合并槽集/kind 一致）由契约层 checkFlow
 * 在保存/装载时保证，解释器不重复校验；运行期只对"缺出口"与动态命令引用
 * 给结构化失败（fail-loud 点名，DP 裁定 4 运行期档）。
 */

import type { Step, Target, WorkflowRecord } from '../contract/schema.ts'
import type { IoReadOpts, IoReadResult, ReadHit, WorkflowCredentials, WorkflowIO, WorkflowOutcome } from '../contract/ports.ts'

/** pass 明文的掩码（出口脱敏用）。 */
export const PASS_MASK = '******'

/** 步转移上限（goto 环护栏；流程步骤表 ≤64，256 = 足够绕环数圈）。 */
export const MAX_TRANSITIONS = 256

/** 等待前的 pending 尾部快照行数（login.ts 同款 SNAP_LINES）。 */
const SNAP_LINES = 100

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
 * 捕获组入槽（T14 D3/D10/D11；T15 起组值由读窗机命中帧供给，本层不再匹配）。
 *
 * 只在命中帧的 outcome = captureFrom 槽（捕获判据路径）时调用：组缺失/空值返回
 * 现场说明串（调用方按 D11 空值护栏收束，不落槽），成功返回 null。
 */
function fillSlots(
  groups: readonly (string | undefined)[],
  captures: readonly string[],
  slots: Map<string, string>,
): string | null {
  for (let i = 0; i < captures.length; i++) {
    const v = groups[i]
    if (v === undefined || v === '') return `捕获槽 ${captures[i]} 提取为空`
    slots.set(captures[i]!, v)
  }
  return null
}

/**
 * 执行流程（纯函数：record + io + 凭据 → 结构化结果）。
 *
 * @param record - 流程记录（locked 红线判定来源；flow 结构已过 checkFlow）。
 * @param io - 会话 IO 原语（缝侧注入；持有者独占由缝侧保证；read 收 raw 判据
 *   声明并在缝侧完成表条目合并与编译——DEC-21 单点）。
 * @param creds - 凭据（{name}/{pass} 占位替换源；不经模型）。
 * @throws 非 locked 流程使用凭据动词（红线）。
 */
export async function runFlow(
  record: WorkflowRecord,
  io: WorkflowIO,
  creds: WorkflowCredentials,
): Promise<WorkflowOutcome> {
  const flow = record.flow
  const byId = new Map(flow.steps.map(s => [s.id, s]))
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
  /** 目标应用（goto 转步 / exit 终结）；返回 undefined = 已转步（continue 由调用方）。 */
  const applyTarget = (t: Target, where: string): { step: Step } | { outcome: WorkflowOutcome } => {
    if ('exit' in t) return { outcome: exit(t.exit.stage, t.exit.ok) }
    const next = byId.get(t.goto)
    if (next === undefined) {
      // checkFlow 已保证 goto 存在；防御兜底给结构化失败（不静默）。
      return { outcome: timeoutExit([`（后继步不存在：${t.goto}——${where}）`]) }
    }
    return { step: next }
  }

  let step: Step | undefined = byId.get(flow.entry)
  // 引擎注入槽（run 级固定单槽；{captcha} 值由 captcha 动作填入，D5 非敏感）。
  let captchaSlot: string | undefined
  // 命名槽表（T14 run 级；捕获步写入，后续动作经 substitute 消费。重经捕获步
  // 覆盖、未重经沿用上值——goto 不清槽，D4 两种复用情形由此自然成立）。
  const slots = new Map<string, string>()
  for (let i = 0; i < MAX_TRANSITIONS && step !== undefined; i++) {
    // 本窗命中帧（T15）：读窗机判定"哪条判据赢了 + 首个命中的捕获组"，本层只消费
    // 帧做分类/填槽/路由——不再自己匹配一遍（`undefined` = 无判据命中）。
    let hit: ReadHit | undefined

    // 1. 读窗（等待前取尾部快照：提示符可能已到达——先到先结算，不丢）。
    if (step.wait !== undefined) {
      const wait = step.wait
      const opts: IoReadOpts = {
        ...(wait.closeOn !== undefined ? { closeOn: wait.closeOn } : {}),
        ...(wait.outcomes !== undefined ? { outcomes: wait.outcomes } : {}),
        ...(wait.count !== undefined ? { count: wait.count } : {}),
        ...(wait.maxLines !== undefined ? { maxLines: wait.maxLines } : {}),
        ...(wait.timeoutMs !== undefined ? { timeoutMs: wait.timeoutMs } : {}),
        ...(wait.flags !== undefined ? { flags: wait.flags } : {}),
      }
      const r: IoReadResult = await io.read(opts, io.recentLines(SNAP_LINES))
      collect(r.lines)
      hit = r.hit

      // 异常收束（外部中断）：signal/disconnected/danger 一律 timeout 出口。
      if (r.reason === 'signal' || r.reason === 'disconnected' || r.reason === 'danger') {
        return timeoutExit()
      }

      // ── 2. 负面出口（fail 命中即裁决——失败不应答，动作不执行）──
      // fail 来源三种：criteria fail 槽（判定序 fail 先于 ok）/ ga 分类命中 fail
      // 槽 / ga 断言失败（by:'ga' 无 outcome——「收窗成功，分支未知」）；quiet
      // 零行（合成 fail 帧）同此。
      if (hit?.kind === 'fail') {
        const assertMiss = hit.outcome === undefined
        const assertNote = assertMiss ? '（收窗成功，分支未知——分类槽无一命中）' : undefined
        const route = step.onOutcome?.fail
        if (route === undefined) {
          return timeoutExit([
            ...(assertNote !== undefined ? [assertNote] : []),
            `（步骤 ${step.id} 的 fail 结局未覆盖——落 timeout 出口；onOutcome.fail 请补全）`,
          ])
        }
        if ('when' in route) {
          const t = hit.outcome !== undefined ? route.when[hit.outcome] : undefined
          if (t === undefined) {
            return timeoutExit([
              ...(assertNote !== undefined ? [assertNote] : []),
              `（步骤 ${step.id} 的 fail 槽「${hit.outcome ?? '？'}」未覆盖——落 timeout 出口；onOutcome.fail.when 请补全）`,
            ])
          }
          const applied = applyTarget(t, `步骤 ${step.id} onOutcome.fail.when[${hit.outcome}]`)
          if ('outcome' in applied) return applied.outcome
          step = applied.step
          continue
        }
        const applied = applyTarget(route, `步骤 ${step.id} onOutcome.fail`)
        if ('outcome' in applied) return exit(applied.outcome.stage, applied.outcome.ok, assertNote !== undefined ? [assertNote] : [])
        step = applied.step
        continue
      }

      // ── 判据失配 / GA 未到：等待未达成，timeout 出口 ──
      //（criteria timeout/maxLines 全不命中；ga 超时；quiet 零行已在上方 fail 块）。
      if (hit === undefined && !(r.closeOn === 'ga' && r.reason === 'done')) {
        return timeoutExit()
      }
      // 落到这里：ok 槽命中 / quiet 有行（合成 ok 帧）/ ga 关窗未声明分类槽（next）。

      // ── 2.5 捕获填槽（captureFrom 具名槽，DEC-19）──
      if (wait.captureFrom !== undefined) {
        const captures = wait.captures ?? []
        if (hit?.outcome === wait.captureFrom) {
          const failNote = fillSlots(hit.groups, captures, slots)
          if (failNote !== null) {
            return timeoutExit([`（步骤 ${step.id} 捕获失败：${failNote}——空值护栏收束，不落槽）`])
          }
        } else if (hit?.outcome === undefined) {
          return timeoutExit([
            `（步骤 ${step.id} 捕获失败：本窗无「${wait.captureFrom}」结局命中（非判据收窗）——空值护栏收束，不落槽）`,
          ])
        }
        // 其他结局命中（如已覆盖出口的 ok 槽）⇒ 跳过捕获照常路由。
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

    // 4. 两级路由：ok 命中 → onOutcome.ok（直达常态 / when 细化，未覆盖 ⇒ next
    //    ——kind 缺省）；无命中（ga 关窗无分类）⇒ next；无 next 且无覆盖 = 缺出口。
    let route: Target | undefined = step.next
    if (hit?.kind === 'ok' && step.onOutcome?.ok !== undefined) {
      const kr = step.onOutcome.ok
      if ('when' in kr) {
        const t = hit.outcome !== undefined ? kr.when[hit.outcome] : undefined
        if (t !== undefined) route = t // 未覆盖 ⇒ 保持 next（kind 缺省，DEC-19）
      } else {
        route = kr
      }
    }
    if (route === undefined) {
      return timeoutExit([`（步骤 ${step.id} 未声明后继：onOutcome 未命中且无 next——流程结构缺出口）`])
    }
    const applied = applyTarget(route, `步骤 ${step.id} 路由`)
    if ('outcome' in applied) return applied.outcome
    step = applied.step
  }
  return timeoutExit([`（步转移超过上限 ${MAX_TRANSITIONS}：流程疑似 goto 环）`])
}
