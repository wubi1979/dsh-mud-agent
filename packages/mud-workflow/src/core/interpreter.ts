/**
 * core/interpreter — 声明式流程解释器（纯函数，进程内，无沙箱）。
 *
 * **内核层**（A1）：只依赖契约层（`../contract`），零 cordis、零宿主、零 I/O——
 * 因此可脱离宿主被离线校验器/回放器/CLI 直接引用。
 *
 * 执行语义（每步 = wait → 负面出口 → action → 路由；**两套词汇并存**——T26 起
 *   新格式（closeOn/outcomes 槽表 + onOutcome）为解释器主路径，遗留 until/failOn
 *   系步在入口读时归一为槽表（normalizeFlow），仅 gaCount/quietMs/maxLines-only
 *   步保持 legacy 路由）：
 *   0. **判据不在此层匹配**（T15）：读窗机随读结果返回**命中帧**（`hit`：哪个
 *      结局赢了 + 该条首个命中的捕获组，§5.2）；本层只用帧做分类、填槽与路由——
 *      系统内**不存在第二套判据匹配**（曾经"路由整窗、捕获逐行"的分歧根源由此消除）；
 *   1. **读窗**：wait 存在则先等（判据满足才动作）；等待前取 pending 尾部
 *      快照（SNAP_LINES）做 initial——提示符先到先结算，不丢（login.ts 同款）；
 *   2. **负面出口**：fail 槽命中（新格式：reason=failOn / kind=fail）或 failOn
 *      （legacy）即裁决——onOutcome/onFailOn 登记为 exit 即终结（分类出口），
 *      登记 goto 即转后继步；未登记 → 缺省 timeout 出口（失败不应答，legacy 同序）；
 *   2.5 **捕获提取**（T14/T15 改由帧供值；T26 具名化 DEC-19）：captureFrom 槽
 *      命中（新格式）或 `until` 帧下标 0（legacy）→ 帧里的组值按序入 run 级命名
 *      槽，组缺失/空值 → 结构化 timeout 同型收束（D11 空值护栏，不落空串进槽）；
 *      新格式下其他结局命中跳过捕获照常路由，无结局命中（GA/maxLines/裸静默关窗）
 *      → 同护栏收束；legacy 的非捕获判据帧（until 下标 > 0）不捕获、不失败，
 *      按该判据路由（分支路径可组合，不吞分类出口）；
 *   3. **动作**：send 直发（引擎槽 {captcha} + 命名槽替换，不碰 {name}/{pass}）；
 *      sendCredential 先替换 {captcha}/命名槽/{name}/{pass} 再直发（不回显不
 *      落盘）；captcha 推图挂起等人工码值（io.awaitCaptcha(url)——url 由流程
 *      捕获槽传入，T14 D9）——answer 值入 {captcha} 固定单槽继续 / aborted →
 *      专用 aborted 出口 / closed → timeout 出口；发送失败 = 连接已断开 →
 *      timeout 出口；
 *   4. **路由**：新格式按命中结局查 onOutcome（ok 未覆盖/无命中走 next——
 *      PLAN §3.10 语义保持；fail 未覆盖已在 2 裁决）；legacy 帧为 `until` 且
 *      index 在 branch 界内 ⇒ branch[index]；无帧/越界走 next；**无 next 且无
 *      命中 = 结构缺出口**——返回结构化 timeout 出口并点名步骤
 *      （粗胚修缮闭环的失败信号，不静默）；
 *   5. **其余收束**（timeout/signal/disconnected/danger；quiet 在 legacy 步 =
 *      兜底）一律 timeout 出口（等待未达成；现场行已收集随结果返回）。新格式
 *      race/quiet 形态的静默是**正常收束者**（T26.4）：静默帧带推定结局照常
 *      路由，裸静默（无分类）同 GA/maxLines 关窗 → next。
 *
 * 护栏：
 *   - 红线执行侧拦截：非 locked 流程执行 sendCredential/captcha 动词 → throw
 *    （save 侧已静态拒绝，执行侧再拦一道——双闸，闸本身各只有一行判）；
 *   - 步转移上限 MAX_TRANSITIONS：goto 环 + 永不收束的窗组合下防止进程内
 *      无界循环（每步读窗有超时，环只烧预算不烧死进程）；
 *   - 出口统一过 pass 掩码（凭据零泄露最后一道闸——流程作者忘写也不泄露）。
 *
 * 结构合法性（goto 目标存在/命中序界内）由契约层 checkFlow 在保存/装载时
 * 保证，解释器不重复校验；运行期只对"缺出口"给结构化失败。
 */

import { normalizeFlow, type OutcomeName, type Step, type Wait, type WorkflowRecord } from '../contract/schema.ts'
import type {
  IoOutcomeSlot, IoReadOpts, IoReadResult, ReadHit, WorkflowCredentials, WorkflowIO, WorkflowOutcome,
} from '../contract/ports.ts'

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

/** Wait → IoReadOpts（正则编译）。新格式（closeOn 槽表，T26）：outcomes 逐槽
 * 编译（flags 应用于全部），fail 槽排前 = 判定序（对齐现役 failOn > until）；
 * legacy（until/failOn 数组）保留——gaCount/quietMs/maxLines-only 步透传。 */
function compileWait(wait: Wait): IoReadOpts {
  const flags = wait.flags ?? ''
  if (wait.closeOn !== undefined) {
    const slots: IoOutcomeSlot[] = Object.entries(wait.outcomes ?? {})
      .map(([name, slot]) => ({
        name: name as OutcomeName,
        kind: slot.kind,
        res: compileSources([...slot.patterns], `结局槽「${name}」`, flags),
      }))
      .sort((a, b) => (a.kind === 'fail' ? 0 : 1) - (b.kind === 'fail' ? 0 : 1))
    return {
      ...(slots.length > 0 ? { slots } : {}),
      closeOn: wait.closeOn,
      ...(wait.gaCount !== undefined ? { gaCount: wait.gaCount } : {}),
      ...(wait.quietMs !== undefined ? { quietMs: wait.quietMs } : {}),
      ...(wait.maxLines !== undefined ? { maxLines: wait.maxLines } : {}),
      timeoutMs: wait.timeoutMs,
    }
  }
  return {
    ...(wait.until !== undefined ? { until: compileSources(wait.until, 'until', flags) } : {}),
    ...(wait.failOn !== undefined ? { failOn: compileSources(wait.failOn, 'failOn', flags) } : {}),
    ...(wait.gaCount !== undefined ? { gaCount: wait.gaCount } : {}),
    ...(wait.quietMs !== undefined ? { quietMs: wait.quietMs } : {}),
    ...(wait.maxLines !== undefined ? { maxLines: wait.maxLines } : {}),
    timeoutMs: wait.timeoutMs,
  }
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
 * 捕获组入槽（T14 D3/D10/D11；T15 起组值由读窗机命中帧供给，本层不再匹配）。
 *
 * 只在本窗命中帧为 `until` 且 index = 0（捕获判据路径）时调用：组缺失/空值返回
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
 * @param io - 会话 IO 原语（缝侧注入；持有者独占由缝侧保证）。
 * @param creds - 凭据（{name}/{pass} 占位替换源；不经模型）。
 * @throws 非 locked 流程使用凭据动词（红线）；判据正则非法（兜底，保存门已拦）。
 */
export async function runFlow(
  record: WorkflowRecord,
  io: WorkflowIO,
  creds: WorkflowCredentials,
): Promise<WorkflowOutcome> {
  // 读时归一（T26.6，幂等纯函数）：registry.view 已归一过一次，此处防御性再
  // 归一——解释器主路径只面对一种路由词汇（closeOn 槽表 + onOutcome）；
  // gaCount/quietMs/maxLines-only 步透传原样，仍走 legacy 路由。
  const flow = normalizeFlow(record.flow)
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

  let step: Step | undefined = byId.get(flow.entry)
  // 引擎注入槽（run 级固定单槽；{captcha} 值由 captcha 动作填入，D5 非敏感）。
  let captchaSlot: string | undefined
  // 命名槽表（T14 run 级；捕获步写入，后续动作经 substitute 消费。重经捕获步
  // 覆盖、未重经沿用上值——goto 不清槽，D4 两种复用情形由此自然成立）。
  const slots = new Map<string, string>()
  for (let i = 0; i < MAX_TRANSITIONS && step !== undefined; i++) {
    // 本窗命中帧（T15）：读窗机判定"哪条判据赢了 + 首个命中的捕获组"，本层只消费
    // 帧做分类/填槽/路由——不再自己匹配一遍（`undefined` = 无判据命中：gaCount /
    // maxLines 关窗或异步收束）。
    let hit: ReadHit | undefined

    // 1. 读窗（等待前取尾部快照：提示符可能已到达——先到先结算，不丢）。
    if (step.wait !== undefined) {
      const opts = compileWait(step.wait)
      const r: IoReadResult = await io.read(opts, io.recentLines(SNAP_LINES))
      collect(r.lines)
      hit = r.hit

      if (step.wait.closeOn !== undefined) {
        // ── 新格式（T26 槽表 + onOutcome，PLAN §3.10 语义保持）──
        // 2. 负面出口：fail 槽命中（reason=failOn / kind=fail）即裁决（失败不应
        //    答，legacy failOn 出口同序）——onOutcome 登记 exit 即终结、goto 即转
        //    后继步；未登记 → 缺省 timeout 出口。
        if (r.reason === 'failOn' || hit?.kind === 'fail') {
          const target = hit?.outcome !== undefined ? step.onOutcome?.[hit.outcome] : undefined
          if (target === undefined) return timeoutExit()
          if ('exit' in target) return exit(target.exit.stage, target.exit.ok)
          step = byId.get(target.goto)
          continue
        }
        // 静默是 race/quiet 形态的正常收束者（T26.4）：quiet 帧带推定结局照常
        // 走 2.5/4 路由，裸静默（无分类）同 GA/maxLines 关窗 → next。
        if (r.reason !== 'done' && r.reason !== 'quiet') return timeoutExit()

        // 2.5 捕获填槽（captureFrom 具名槽，DEC-19）：命中捕获源槽 → 组值按序
        //     入槽，组缺失/空值 ⇒ D11 空值护栏收束（不落空串进槽）；无结局命中
        //    （GA/maxLines/裸静默关窗）⇒ 同护栏（不拿旧值/空值进后续 send）；
        //     其他结局命中（如覆盖出口的 fail 槽已在上裁决）⇒ 跳过捕获照常路由。
        if (step.wait.captureFrom !== undefined) {
          const captures = step.wait.captures ?? []
          if (hit?.outcome === step.wait.captureFrom) {
            const failNote = fillSlots(hit.groups, captures, slots)
            if (failNote !== null) {
              return timeoutExit([`（步骤 ${step.id} 捕获失败：${failNote}——空值护栏收束，不落槽）`])
            }
          } else if (hit?.outcome === undefined) {
            return timeoutExit([
              `（步骤 ${step.id} 捕获失败：本窗无「${step.wait.captureFrom}」结局命中（非判据收窗）——空值护栏收束，不落槽）`,
            ])
          }
        }
      } else {
        // ── legacy（gaCount/quietMs/maxLines-only 步；until/failOn 系已在入口
        //    归一为槽表，不会走到这里）──
        if (r.reason === 'failOn') {
          // 2. failOn 出口：帧给出的 failOn 下标查 onFailOn（无帧/未登记 ⇒ 缺省 timeout）。
          const idx = hit?.by === 'failOn' ? hit.index : -1
          const target = idx >= 0 ? step.onFailOn?.[String(idx)] : undefined
          if (target === undefined) return timeoutExit()
          if ('exit' in target) return exit(target.exit.stage, target.exit.ok)
          step = byId.get(target.goto)
          continue
        }
        if (r.reason !== 'done') return timeoutExit()

        // 1.5 捕获填槽（T14 D3/D10/D11；T15 组值来自命中帧）
        //   帧 by='until' && index=0 → 捕获判据路径：按序入槽，组缺失/空值 ⇒ D11 收束；
        //   帧 by='until' && index>0 → 其它已声明判据路径：不捕获不失败，按该判据路由
        //                              （不吞分类出口）；
        //   无 until 帧（gaCount/maxLines 关窗）⇒ D11 收束（不拿旧值/空值进后续 send）。
        const captures = step.wait.captures
        if (captures !== undefined && captures.length > 0) {
          if (hit?.by === 'until' && hit.index === 0) {
            const failNote = fillSlots(hit.groups, captures, slots)
            if (failNote !== null) {
              return timeoutExit([`（步骤 ${step.id} 捕获失败：${failNote}——空值护栏收束，不落槽）`])
            }
          } else if (hit?.by !== 'until') {
            return timeoutExit([
              `（步骤 ${step.id} 捕获失败：本窗无 until 命中判据（gaCount/maxLines 关窗）——空值护栏收束，不落槽）`,
            ])
          }
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

    // 4. 路由：新格式按命中结局查 onOutcome（ok 未覆盖/无命中走 next——PLAN
    //    §3.10 语义保持；fail 未覆盖已在 2 裁决）；legacy 按帧的 until 下标查
    //    branch[index]；无帧/越界 → next（判据匹配单点在读窗机，本层不做任何扫描）。
    let route: Step['next'] = step.next
    if (step.onOutcome !== undefined && hit?.outcome !== undefined) {
      const target = step.onOutcome[hit.outcome]
      if (target !== undefined) route = target
    } else if (step.branch !== undefined && hit?.by === 'until' && hit.index < step.branch.length) {
      route = step.branch[hit.index]
    }
    if (route === undefined) {
      return timeoutExit([`（步骤 ${step.id} 未声明后继：onOutcome/branch 未命中且无 next——流程结构缺出口）`])
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
