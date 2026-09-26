/**
 * flows/fullme — fullme 验证码链路（impl §5 第 7 步 / §3.6）。
 *
 * 链路（impl §3.6 定案）：子 agent 调 mud_flow({id:'fullme'}) → 收图 → 以
 * { done:false, question:'验证码：<URL>' } 结束（问题随结算上浮）→ 根
 * userQuestions 问人 → 根带答案重入（mud_flow({id:'fullme', answer})）→
 * 提交应答。**不注册 captchaRecognize**（必然失败的桩会让模型反复调用、
 * 白烧请求；二期有真承载再注册，链路与验收路径不变）。这条失败路径是
 * 第一期**真实路径**，不是异常分支。入口判据 = 提醒行文（FULLME_REMINDER_TEXT，
 * persona 常识段引用）：行文出现 → 模型自决调用本流程。
 *
 * 实录刻度承旧实现（mud-core/agent/flow/flows/fullme.ts，作者 2026-09-13
 * 逐条审定）：stale 三连发 fullme 1 才能真放弃上一轮、冷却正则通配动态时长、
 * 成功句只属于答题阶段。
 *
 * 与旧五步图的对应：request+stale+prompt 合并为本文件取图阶段（stale 舞蹈
 * 后同轮补取一次——新形态下流程由模型显式调用，同轮收束免去模型↔流程
 * 往返）；answer+success 为答题阶段（halt + fullme {answer} → 成功发
 * hpbrief 补状态）。三连放弃后仍 stale（异常）抛错——本轮作废，模型稍后
 * 重调（对应旧"等下一轮"）。
 *
 * 重放无害：取图（发 fullme）与答题（错码无副作用，实录"好像什么都没有
 * 发生"）均可安全重放 → 允许 { done:false } 出口。凭据与本流程无关。
 * 纯度纪律：不 import 宿主。
 */

import type { MudLine } from '../../link/ansi.ts'
import type { Mud, ReadResult, WaitOpts } from '../../link/mud.ts'
import { FlowError, type Flow, type FlowCtx, type FlowResult } from './types.ts'

/** fullme 入口提醒句（作者实录 2026-09-12；原文作者上线前核对）。
 *  消费点：persona 常识段（"该行文出现 → 调 mud_flow fullme"交模型自决）。 */
export const FULLME_REMINDER_TEXT = '5M后长时间不使用fullme，会被系统判定为机器人。'
/** 上一轮未完成提示（作者实录 2026-09-13）。 */
export const FULLME_STALE_TEXT = '你之前请求的fullme还没有完成。'
/** fullme 成功句（作者实录 2026-09-13）。 */
export const FULLME_OK_TEXT = '你突然感到精神一振，浑身似乎又充满了力量！'
/** fullme 答错句（作者实录 2026-09-13）。 */
export const FULLME_WRONG_TEXT = '好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！'
/** "刚刚用过"句（时长动态：`还有 3 分 20 秒` / `还有 45 秒`，总计 15 分钟 → 通配符）。
 *  m 标志：until 在**累积文本**上测，`^` 锚须逐行命中（同 login 判据教训）。 */
export const FULLME_COOLDOWN_PATTERN = /^你刚刚用过这个命令不久，还要[^。]*才能再用。/m
/**
 * 验证码页面地址（应答帧内回显）。**无行首锚**：旧实现带 `^`（classify 逐行
 * 测的产物），而捕获判据容忍 `` `URL` `` 反引号包裹——两种行文形态哪种为真
 * 待实机首帧确认；取图判据取宽松形（命中即有 URL，抽取交 FULLME_URL_CAPTURE），
 * 免得行首锚与回显形态不符时白等满超时。
 */
export const FULLME_URL_PATTERN = /https?:\/\/[^\s`]*robot\.php\?filename=[^\s`]+/
/** 验证码地址抽取（命名捕获组即槽名；字符类排除反引号——游戏原文用
 *  `` `URL` `` 包裹时防其混入槽值）。 */
export const FULLME_URL_CAPTURE = /(?<captchaUrl>https?:\/\/[^\s`]*robot\.php\?filename=[^\s`]+)/

/** 字面刻度编译：**转义后**再编译（until 只收 RegExp；转义使"常量含正则
 *  元字符"的日后编辑不静默改变语义）。 */
const re = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

function findLine(lines: readonly MudLine[], rePattern: RegExp): MudLine | null {
  return lines.find(l => rePattern.test(l.text)) ?? null
}

function captureUrl(lines: readonly MudLine[]): string | null {
  for (const line of lines) {
    const m = FULLME_URL_CAPTURE.exec(line.text)
    if (m?.groups?.captchaUrl !== undefined) return m.groups.captchaUrl
  }
  return null
}

/**
 * 单步等待（与 login.step 同形）：danger → 原样返回（调用方走出口 3）；
 * timeout/disconnected/signal → 抛错（异常终态，**不落 continue**——否则
 * 中止后仍会发出后续命令）；其余（until 命中/failOn）原样返回由调用方判。
 */
async function step(mud: Mud, opts: Omit<WaitOpts, 'signal'>, signal: AbortSignal | undefined, what: string): Promise<ReadResult> {
  const r = await mud.read({ ...opts, ...(signal !== undefined ? { signal } : {}) })
  if (r.reason === 'danger') return r
  if (r.reason === 'timeout') throw new FlowError(`fullme 失败：${what}超时`)
  if (r.reason === 'disconnected') throw new FlowError(`fullme 失败：${what}期间连接断开`)
  if (r.reason === 'signal') throw new FlowError(`fullme 失败：${what}被中止`)
  return r
}

/** 取图阶段（answer 缺席）：发 fullme → URL / stale / 冷却 分类。 */
async function requestPhase(ctx: FlowCtx): Promise<FlowResult> {
  const { mud, holder, defaultTimeoutMs, signal } = ctx
  const until = [FULLME_URL_PATTERN, re(FULLME_STALE_TEXT), FULLME_COOLDOWN_PATTERN]

  // 最多两轮取图：首轮 + stale 舞蹈后补一轮（仍 stale = 异常，抛错等重调）。
  for (let attempt = 0; attempt < 2; attempt++) {
    mud.send('fullme')
    // gaCount:2 —— 容忍"完成句帧（GA 收尾）与 URL 帧分帧"：缺省 gaCount:1 会
    // 在首帧边界先到时关窗且无 URL，把 mud.ts:28-32 定为正常收束的形态判成
    // 硬失败。代价：stale/冷却判定同样多等一帧（实录中这些应答后服务端总有
    // 后续输出，不构成白等）——取值待 §6 实机校准。
    const r = await step(mud, { holder, until, gaCount: 2, timeoutMs: defaultTimeoutMs }, signal, '等验证码应答')
    if (r.reason === 'danger') return { reason: 'danger' }

    const cooldown = findLine(r.lines, FULLME_COOLDOWN_PATTERN)
    if (cooldown !== null) {
      // 冷却不是问题也不是错误应答：本次调用失败收场，模型看到时长自行安排
      // 稍后重调（旧实现按 fail 分类中止，同义）。
      throw new FlowError(`fullme 冷却中：${cooldown.text}`)
    }

    if (findLine(r.lines, re(FULLME_STALE_TEXT)) !== null) {
      // 上一轮未完成：三连发 fullme 1 才能真放弃（作者实测；ga:3 收口），
      // 然后补一轮取图。
      for (let i = 0; i < 3; i++) mud.send('fullme 1')
      const stale = await step(mud, { holder, gaCount: 3, timeoutMs: defaultTimeoutMs }, signal, '等三连放弃收口')
      if (stale.reason === 'danger') return { reason: 'danger' }
      continue
    }

    const url = captureUrl(r.lines)
    if (url === null) {
      throw new FlowError(`fullme 未返回验证码图片（收 ${r.lines.length} 行，reason=${r.reason}）`)
    }
    return {
      done: false,
      question: `验证码图片：${url}\n请人工查看图片作答；答案将随 fullme 提交（带 answer 重新调用 mud_flow fullme）。`,
      lines: r.lines,
    }
  }
  throw new FlowError('stale 舞蹈后仍未取到验证码图片（本轮作废，稍后重调）')
}

/** 答题阶段（带答案重入）：halt + fullme {answer} → 成功补状态 / 答错再问。 */
async function answerPhase(ctx: FlowCtx): Promise<FlowResult> {
  const { mud, holder, defaultTimeoutMs, signal } = ctx
  const answer = ctx.answer as string

  mud.send('halt') // 旧 answer 步动作首命令：停当前活动再提交（实录刻度）
  mud.send(`fullme ${answer}`)
  const r = await step(
    mud,
    { holder, until: [re(FULLME_OK_TEXT), re(FULLME_WRONG_TEXT)], timeoutMs: defaultTimeoutMs },
    signal,
    '等提交应答',
  )
  if (r.reason === 'danger') return { reason: 'danger' }

  if (findLine(r.lines, re(FULLME_OK_TEXT)) !== null) {
    // 成功：发 hpbrief 补状态（fullme 不只防挂机，还补各项状态），GA 收口。
    mud.send('hpbrief')
    // 收口帧**不用 step()**（与 login.ts 尾步完全同形）：成功句已见 ⇒ 本流程
    // 已完成，超时/静默/中止都不改写结论；只有危险中断仍走出口 3。
    const tail = await mud.read({
      holder,
      gaCount: 1,
      timeoutMs: defaultTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (tail.reason === 'danger') return { reason: 'danger' }
    return { done: true }
  }

  if (findLine(r.lines, re(FULLME_WRONG_TEXT)) !== null) {
    // 答错：错码与 fullme 1 等价、无副作用（重放无害成立）——同一图片仍在
    // 服务端挂起，根带新答案重入即可；图片若失效，模型可去掉 answer 重取。
    // 次数上限不建计数（旧实现 retry.attempts:3 的纪律交模型面文本承载）。
    return {
      done: false,
      question: '答案不对（服务端：好像什么都没有发生…）。请对照之前提供的验证码图片重新作答（至多重试 3 次，超过请放弃并上报）；若图片已失效，去掉 answer 重新调用 mud_flow fullme 取新图。',
      lines: r.lines,
    }
  }

  throw new FlowError(`fullme 提交后未收到可判定的应答（reason=${r.reason}，收 ${r.lines.length} 行）`)
}

/** fullme 流程：取图（answer 缺席）/ 答题（answer 在）两阶段；空串 answer 拒绝。 */
export const FULLME_FLOW: Flow = {
  id: 'fullme',
  description: 'fullme 验证码：收图上浮问题，答案重入提交（不注册识别工具）',
  async run(ctx) {
    if (ctx.answer === '') throw new FlowError('fullme answer 为空串：拒绝无效提交（人工未给值时不要带 answer 调用）')
    return ctx.answer === undefined ? requestPhase(ctx) : answerPhase(ctx)
  },
}
