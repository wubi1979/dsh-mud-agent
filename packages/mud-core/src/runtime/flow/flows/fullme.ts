/**
 * dsh-mud-core — fullme 流程表 (flows/fullme)。`doc/ARCHITECTURE.md` §11 / `doc/flows/fullme.md`。
 * @module @deepseek-ai/dsh-mud-core/runtime/flow/flows/fullme
 */

import type { FlowSpec } from '../flow-spec.ts'
import { PRIORITY_NORMAL } from '../flow-spec.ts'

/** fullme 入口提醒句（作者实录 2026-09-12；原文作者上线前核对）。 */
export const FULLME_REMINDER_TEXT = '5M后长时间不使用fullme，会被系统判定为机器人。'
/** 上一轮未完成提示（作者实录 2026-09-13；原文作者上线前核对）。 */
export const FULLME_STALE_TEXT = '你之前请求的fullme还没有完成。'
/** fullme 成功句（作者实录 2026-09-13）。 */
export const FULLME_OK_TEXT = '你突然感到精神一振，浑身似乎又充满了力量！'
/** fullme 答错句（作者实录 2026-09-13）。 */
export const FULLME_WRONG_TEXT = '好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！'
/** "刚刚用过"句（时长动态：`还有 3 分 20 秒` / `还有 45 秒`，总计 15 分钟 → 通配符）。 */
export const FULLME_COOLDOWN_PATTERN = /^你刚刚用过这个命令不久，还要[^。]*才能再用。/
/** 验证码页面地址（应答帧内回显）。 */
export const FULLME_URL_PATTERN = /^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/
/** 验证码地址抽取（`capture` 槽用；捕获组 1 = 地址）。 */
export const FULLME_URL_CAPTURE = /(https?:\/\/[^\s]*robot\.php\?filename=[^\s]+)/

/**
 * fullme 流程（五步；作者 2026-09-13 逐条审定）。
 *
 * 结构要点：
 *   - `request` **无 ok**：本步结果 = 下一步的新文本（`stale` / `prompt` 的 driver 就是它的两种结果），
 *     成功句只属于 `answer` —— **必须正确回码才算通过**；"刚刚用过"句直接中止（无兜底）；
 *   - `stale`（上一轮未完成）**三连发 `fullme 1`** 才能真放弃，以 GA 判定、按**失败收束**收场；
 *   - `prompt` 用 `mud_captcha`（**ask-human 工具**）取图 + 推弹窗并**回合内挂起等人工提交**，
 *     以**工具结果**判定（没有 GA 可判）；`timeoutMs` 因此放宽到图片有效期（含等人工）；
 *   - `answer` 三次答错重来（`retry`：先重挂 `mud_captcha` 再问一次、再投本步动作；
 *     错码与 `fullme 1` 等价，三次错码即"三连放弃"），
 *     `timeoutMs = 180_000` = 图片有效期 = **本步总预算**（等人工 + 重来 + 收结果都算在内；
 *     ask-human 首次回码后动作即投——码已在 externalValues，不再走人工槽挂起）；
 *   - `success` 发 `hpbrief` 补状态，`ok:[GA]`、`next` 空 = 终态。
 *
 * 三种收场（取图失败 / 答错 3 次 / 预算耗尽）都让服务端停在当前轮次 → 下一轮先撞 `stale`，
 * 运行时不另记状态。
 */
export const FULLME_FLOW: FlowSpec = {
  id: 'fullme',
  // 可被打断: 战斗/生存类事件（interrupts > 100）优先（§19.4）。
  priority: PRIORITY_NORMAL,
  when: world => world.flags.logged_in === true,
  entry: 'request',
  timeoutMs: 30_000,
  // 失败只留痕: 人工/系统问题（冷却、答错、超时），T2 补不了（作者定案 2026-09-13）。
  failPolicy: { notify: 'none' },
  steps: [
    {
      id: 'request',
      driver: { kind: 'text', includes: [FULLME_REMINDER_TEXT] },
      action: { tool: 'mud_send', args: { cmd: 'fullme' } },
      // 无 ok：本步结果 = 下一步的新文本（stale 提示 / 验证码地址行）。
      fail: [{ kind: 'regex', patterns: [FULLME_COOLDOWN_PATTERN] }],
      next: ['stale', 'prompt'],
      timeoutMs: 30_000,
    },
    {
      id: 'stale',
      driver: { kind: 'text', includes: [FULLME_STALE_TEXT] },
      // 必须三连发才能真的放弃上一轮（作者实测）。
      action: { tool: 'mud_send', args: { cmds: ['fullme 1', 'fullme 1', 'fullme 1'] } },
      // 命令被接受即"本轮作废"（复位、等下一轮）；冷却期由下一轮的 request.fail 自然吸收。
      fail: [{ kind: 'ga', why: '放弃上一轮（三连 fullme 1）→ 本轮作废' }],
      timeoutMs: 5_000,
    },
    {
      id: 'prompt',
      driver: { kind: 'regex', patterns: [FULLME_URL_PATTERN] },
      capture: { captchaUrl: FULLME_URL_CAPTURE },
      // ask-human: mud_captcha 推图后**回合内挂起等人工提交**，码随工具结果回管线。
      action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      ok: [{ kind: 'tool', outcome: 'ok' }],
      fail: [{ kind: 'tool', outcome: 'error' }],
      next: ['answer'],
      // 本步含等人工（工具兜底超时 175s 先于步预算结算）→ 放宽到图片有效期。
      timeoutMs: 180_000,
    },
    {
      id: 'answer',
      action: { tool: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
      // `awaitExternal` 现在是兜底声明: ask-human 首次回码后码已就位、动作即投（不再挂起）;
      // 答错重试时槽值被清空 → 本步动作再次挂起, 等第二次提问的工具结果带回新码。
      awaitExternal: ['captcha'],
      ok: [{ kind: 'text', includes: [FULLME_OK_TEXT] }],
      fail: [
        { kind: 'text', includes: [FULLME_WRONG_TEXT] },
        // 工具结果失败（重试取图 / 发送写失败）同样算本步失败，不必等到预算耗尽。
        { kind: 'tool', outcome: 'error' },
      ],
      retry: {
        attempts: 3,
        on: ['fail'],
        action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      },
      next: ['success'],
      timeoutMs: 180_000,
    },
    {
      id: 'success',
      action: { tool: 'mud_send', args: { cmd: 'hpbrief' } },
      // 命令被接受即成功；next 空 = 终态（fullme 不只防挂机，还补各项状态）。
      ok: [{ kind: 'ga' }],
      timeoutMs: 5_000,
    },
  ],
}
