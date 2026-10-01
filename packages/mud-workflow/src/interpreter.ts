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
 *   3. **动作**：send 直发；sendCredential 先替换 {name}/{pass} 占位再直发
 *      （不回显不落盘）；发送失败 = 连接已断开 → timeout 出口；
 *   4. **路由**：本窗文本上按声明序重测 until，首个命中 index 查 branch
 *     （exit = 终结 / goto = 后继）；未命中/越界走 next；**无 next 且无
 *      branch 命中 = 结构缺出口**——返回结构化 timeout 出口并点名步骤
 *     （粗胚修缮闭环的失败信号，不静默）；
 *   5. **非 done/failOn 收束**（timeout/quiet/signal/disconnected/danger）一律
 *      timeout 出口（等待未达成；现场行已收集随结果返回）。
 *
 * 护栏：
 *   - 红线执行侧拦截：非 locked 流程执行 sendCredential 动词 → throw
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
  EnvReadOpts, EnvReadResult, WorkflowCredentials, WorkflowEnv, WorkflowOutcome,
} from './env.ts'

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

/** Wait → EnvReadOpts（正则编译）。 */
function compileWait(wait: Wait): EnvReadOpts {
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

/** 占位替换（sendCredential 专用；send 不替换——模型内容零变换）。 */
function substitute(cmd: string, creds: WorkflowCredentials): string {
  return cmd.split('{name}').join(creds.name).split('{pass}').join(creds.pass)
}

/**
 * 执行流程（纯函数：record + env + 凭据 → 结构化结果）。
 *
 * @param record - 流程记录（locked 红线判定来源；flow 结构已过 checkFlow）。
 * @param env - 会话环境原语（缝侧注入；持有者独占由缝侧保证）。
 * @param creds - 凭据（{name}/{pass} 占位替换源；不经模型）。
 * @throws 非 locked 流程使用凭据动词（红线）；判据正则非法（兜底，保存门已拦）。
 */
export async function runFlow(
  record: WorkflowRecord,
  env: WorkflowEnv,
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
  for (let i = 0; i < MAX_TRANSITIONS && step !== undefined; i++) {
    let windowText = ''

    // 1. 读窗（等待前取尾部快照：提示符可能已到达——先到先结算，不丢）。
    if (step.wait !== undefined) {
      const opts = compileWait(step.wait)
      const r: EnvReadResult = await env.read(opts, env.recentLines(SNAP_LINES))
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
    }

    // 3. 动作：路由前执行（步骤的应答总发；条件发送 = 独立步骤，login replace 同型）。
    if (step.action !== undefined) {
      if ('sendCredential' in step.action) {
        if (record.locked !== true) {
          throw new Error(`流程 ${record.name} 非 locked，禁止使用 sendCredential（凭据红线）`)
        }
        if (!env.sendCredential(substitute(step.action.sendCredential, creds))) {
          return timeoutExit(['（连接已断开：发送失败）'])
        }
      } else if (!env.send(step.action.send)) {
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
