/**
 * flows/fullme — 验证码流程实体（locked 预制，fullme 链路 T13）。
 *
 * 流程实体归 core3（login 同款裁定）：经 `ctx.provide('mudCore3', { builtinFlows })`
 * 交 mud-workflow 注册表挂载（registry.registerBuiltins，fail-loud 校验）。
 *
 * 主链四段 + stale 自愈环（T13 计划 D2；落地后同步 §8.15）：
 *   request    发 `fullme` 引子（触发 = 被动处置：agent 判系统提示/降级后跑本流程）
 *   urlwait    等 robot.php URL 行（仅首轮锚定）：until[0] 捕获组按 T14 提取
 *              URL 入 run 级槽 captchaUrl——答错重入 judge → goto answer 跳过
 *              urlwait，槽沿用上值（D4）；URL 行未出现 → 结构化 timeout 收束
 *              （报错点前移，awaitCaptcha 不再自取兜底）；failOn = stale 句（上一轮超时/
 *              中止留下的服务端悬挂态，本次 fullme 被拒）→ abandon1–3 三连
 *              `fullme 1` 放弃悬挂态 → 结构化 fail 收束**不重试**（服务端事实：
 *              放弃后约 15 分钟冷却，立即重试必再 stale）；failOn = 冷却句 →
 *              cooldown 出口（冷却未完，agent 等下次服务器提示再触发）；
 *   answer     纯动作步：captcha 动作收 url 参数（`{captchaUrl}` 槽，T14 D9）→
 *              抓图 → 推帧 → 挂起等人工码
 *              （预算 = Config captchaTimeoutMs，缺省 180s）；
 *   send-code  发 `fullme {captcha}`（引擎注入槽替换，{captcha} 非敏感不掩码）；
 *   judge      等判据：答对句 → success 出口 / 答错句 → 缺省 goto answer 重入
 *              （不重发 fullme 引子——服务端事实：每次 fullme 只回一次 URL 无重发，
 *              同 URL 继续作答；弹窗重现缓存图不重抓）；失效句 failOn → expired
 *              出口（URL 有效期 3 分钟 / 刷新超配额后页面失效）。
 *
 * 判据语料（v1 实录七常量起步；v1 §11 `doc/archive/mud-core/flows/fullme.md`），
 * 宽匹配起步，实机触发时按 U2 校准（stale 句与失效句原文待实录）。
 * 纪律：`^` 行首锚配 `flags: 'm'`（整窗按行 join 匹配，login 同款）。
 */

// 流程词汇表类型由 mud-workflow 契约层提供（type-only import；数据侧引用
// 架构侧的契约子路径，A1）。
import type { WorkflowRecord } from 'mud-workflow/contract'

/** 步预算（urlwait/judge 读窗；挂起预算另走 Config captchaTimeoutMs，两预算串行分立）。 */
const STEP_MS = 30_000

// ── 判据（v1 实录起步，U2 待实机语料校准）────────────────────────────

/** urlwait driver：robot.php URL 行（行首锚；v1 实录 URL 带 ?filename= 参数，
 * 通配到行尾并整体捕获——T14 URL 捕获上移：组 1 入 captchaUrl 槽传 awaitCaptcha）。 */
const URL_SRC = '^(https?:\\/\\/[^\\s]*robot\\.php[^\\s]*)'
/** urlwait failOn[0]：stale 句（上一轮未完成的悬挂态，v1 实录起句）。 */
const STALE_SRC = '你之前请求的fullme还没有完成'
/** urlwait failOn[1]：冷却句（v1 实录原文，时长动态——「还有 3 分 20 秒 / 还有 45 秒」通配）。 */
const COOLDOWN_SRC = '^你刚刚用过这个命令不久，还要[^。]*才能再用。'
/** judge until[0]：答对句（v1 实录，去尾句号宽匹配）。 */
const OK_SRC = '你突然感到精神一振，浑身似乎又充满了力量'
/** judge until[1]：答错句（v1 实录，去尾句号宽匹配）。 */
const WRONG_SRC = '好像什么都没有发生，但是又好像有什么事情做错了'
/** judge failOn[0]：失效句宽匹配起步（URL 过期/刷新超配额；原文待 U2 语料校准）。 */
const EXPIRED_SRC = '还没完成|失效|过期'

/** 验证码流程（locked；经 mudCore3.builtinFlows 交 mud-workflow 注册表挂载）。 */
export const fullme: WorkflowRecord = {
  name: 'fullme',
  title: '验证码（发 fullme → 取图等人工码 → 试错收束）',
  locked: true,
  version: 1,
  updatedAt: '2026-10-05T00:00:00.000Z',
  flow: {
    entry: 'request',
    steps: [
      { id: 'request', action: { send: 'fullme' }, next: { goto: 'urlwait' } },
      {
        id: 'urlwait',
        wait: {
          until: [URL_SRC],
          captures: ['captchaUrl'],
          failOn: [STALE_SRC, COOLDOWN_SRC],
          flags: 'm',
          timeoutMs: STEP_MS,
        },
        onFailOn: {
          // stale → 三连 fullme 1 放弃悬挂态 → fail 收束不重试（15 分钟冷却）
          '0': { goto: 'abandon1' },
          // 冷却未完 → 结构化失败，agent 等下次服务器提示再触发
          '1': { exit: { stage: 'cooldown', ok: false } },
        },
        next: { goto: 'answer' },
      },
      // answer 后必跟 judge 收束窗——fullme 应答被窗口消费（readAbs 推进）不进投递
      //（答案行不上浮 agent）。answer 的 url 参数 `{captchaUrl}` 由 urlwait 捕获槽
      // 填充（T14 D9）；答错重入沿用残留值（未重经捕获步，D4）。
      { id: 'answer', action: { captcha: { url: '{captchaUrl}' } }, next: { goto: 'send-code' } },
      { id: 'send-code', action: { send: 'fullme {captcha}' }, next: { goto: 'judge' } },
      {
        id: 'judge',
        wait: { until: [OK_SRC, WRONG_SRC], failOn: [EXPIRED_SRC], flags: 'm', timeoutMs: STEP_MS },
        onFailOn: { '0': { exit: { stage: 'expired', ok: false } } },
        branch: [{ exit: { stage: 'success', ok: true } }],
        // 缺省（答错句命中，branch 越界）→ 重入 answer：缓存图重现，不重发引子
        next: { goto: 'answer' },
      },
      // stale 自愈环：三连发（服务端事实：三连 fullme 1 才真放弃），然后 fail 收束。
      { id: 'abandon1', action: { send: 'fullme 1' }, next: { goto: 'abandon2' } },
      { id: 'abandon2', action: { send: 'fullme 1' }, next: { goto: 'abandon3' } },
      { id: 'abandon3', action: { send: 'fullme 1' }, next: { exit: { stage: 'abandoned', ok: false } } },
    ],
  },
}
