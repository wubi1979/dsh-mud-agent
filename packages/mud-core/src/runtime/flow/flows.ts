/**
 * dsh-mud-core — 流程表 (flows) 默认配置。设计见 `doc/ARCHITECTURE.md` §19。
 *
 * 流程 = **显式的步骤图**：每步 = `驱动句 → 动作 → 结果判据`。与 trigger 规则表分工:
 *   - `trigger-rules.ts`：state（入库折叠）+ 一次性 event（命中即由 T1 渲染一次动作）；
 *   - 本文件：多步确定性流程（登录、fullme…）。驱动句 / ok / fail **只写这里一份**，
 *     不在 trigger 里重复；流程状态（arming 集、挂起、打断、排队）是运行时状态。
 *
 * 结果判据里 `GA` 是一种**判据**（不是"自动成功"）：写进 `ok` 或 `fail` 才生效；
 * 同一步的 `ok` 与 `fail` 判据集必须互斥（`validateFlows` 在装配期校验）。
 * @module @deepseek-ai/dsh-mud-core/config/flows
 */

import type { WorldModel } from '../../shared/world.ts'

/** 结果/进入判据。`ga` = "该命令的应答被 GA 结算"（与行匹配并列的一种判据）。 */
export type FlowMatch =
  | { kind: 'regex'; patterns: readonly (string | RegExp)[]; why?: string }
  | { kind: 'text'; includes: readonly string[]; why?: string }
  | { kind: 'ga'; why?: string }
  /**
   * **工具结果判据**：本步动作（含重试动作）的**官方工具结果**是成功还是失败。
   * 供"只调工具、不发游戏命令"的步骤判定（如 fullme 的解析步）——
   * 这类步骤没有 GA 可判，靠它收尾。
   */
  | { kind: 'tool'; outcome: 'ok' | 'error'; why?: string }

/** 一步发出的工具调用声明（占位符 `{name}`/`{pass}`/`{captcha}` 在发送瞬间插值）。 */
export interface FlowAction {
  tool: string
  args: Record<string, unknown>
}

/** 进入节点即执行的副作用（不等结果）。 */
export interface FlowEnter {
  /** 落 world（点分键或 flags 里的键）。 */
  patch?: Record<string, unknown>
  /** 只发不等结果的直发命令（actor system；与 save/分页同一机制）。 */
  direct?: readonly string[]
}

/** 流程的一步（一个节点）。 */
export interface FlowStep {
  /** 步骤 id（流程内唯一；日志/状态/diag 用 `flowId/stepId`）。 */
  id: string
  /**
   * 驱动句（进入判据之一）：服务端提示行。省略 = 该节点**不能靠行进入**，
   * 只能由前驱的"顺序兜底"进入（或作为入口由 `FlowSpec.entry` 指定）。
   */
  driver?: FlowMatch
  /** 本步发出的工具调用。省略 = 判定节点（只判定与转移，不发命令）。 */
  action?: FlowAction
  /** 需要外部/人工补值的占位符名（如 `['captcha']`）→ 该步先挂起等人工。 */
  awaitExternal?: readonly string[]
  /**
   * **命中行的抽取（槽）**：`{ 槽名: 正则 }` —— 进入本步时按第一条命中的**捕获组 1**
   * （无捕获组则取整段匹配）存进**流程实例槽**，供动作参数里的 `{槽名}` 在**投递前**插值。
   * 答错重试**不重新抽取**（沿用首次抽到的值，如验证码地址）。
   */
  capture?: Readonly<Record<string, string | RegExp>>
  /** 进入本步即执行的副作用。 */
  onEnter?: FlowEnter
  /** 本步成功判据（命中即成功）。 */
  ok?: readonly FlowMatch[]
  /** 本步失败判据（命中即失败）。 */
  fail?: readonly FlowMatch[]
  /**
   * 后继步骤 id（可多分支）。两类：
   *   - 带**进入判据**的后继（`driver`，或判定节点的 `ok`/`fail` 行判据）= **条件分支**：
   *     先 arm，命中即走；同批行内优先于顺序兜底；
   *   - 无进入判据的后继 = **顺序兜底**：本节点成功后立即执行（不等待）。
   * 空 = 终态（进入即流程成功结束）。
   */
  next?: readonly string[]
  /**
   * **重试**：命中 `on`（缺省 `['driver']`）里的判据时，**在原步内重来**（不换步）。
   *
   *   - `attempts` = **总尝试次数（含首次）**，用尽才算失败；
   *   - `action` = 重试前先投的动作（缺省 = 重发本步动作）；重试时清空本步 `awaitExternal`
   *     的槽值、把命中行原文写进 `{lastFail}`、随后**重新挂起本步动作**等人工；
   *   - **不重置本步计时器**：时间预算是"一步总计"（fullme 的 `answer` = 3 分钟，
   *     等人工与答错重来共用同一份预算）。
   */
  retry?: { attempts: number; on?: readonly ('driver' | 'fail')[]; action?: FlowAction }
  /** 本步超时毫秒（缺省取 `FlowSpec.timeoutMs`）。 */
  timeoutMs?: number
  /** 被打断时要先发的直发命令（如练功的 halt）。 */
  onInterrupt?: readonly string[]
}

/** 一条流程的声明。 */
export interface FlowSpec {
  id: string
  /**
   * 打断档位（纯数字，直接比大小）：越大越不可打断，`normal = 100`。
   * 规则声明 `interrupts` 且 `interrupts > priority` 才可打断本流程（§19.4）。
   */
  priority: number
  /** 入口 arm 的前置条件（读 world）：满足才 arm 入口 driver。 */
  when?: (world: WorldModel) => boolean
  /** 入口步骤 id（缺省 = `steps[0]`）。 */
  entry?: string
  steps: readonly FlowStep[]
  /** 每步缺省超时（毫秒）。 */
  timeoutMs?: number
  /** 流程整体成功后的动作。 */
  onSuccess?: FlowEnter & { commands?: readonly string[] }
  /** 失败/超时出口（缺省 `{ notify: 't2' }`）。 */
  failPolicy?: { notify?: 't2' | 'none' }
}

/** 打断档位的基准值（纯数字比较；越大越不可打断）。 */
export const PRIORITY_NORMAL = 100

/**
 * 登录流程（`doc/ARCHITECTURE.md` §11）。
 *
 * 实录/待实录标注：`(估计)` = 按规则意图给的估计形，拿到实录原文后替换。
 */
export const LOGIN_FLOW: FlowSpec = {
  id: 'login',
  // 不可打断：没有任何规则的 interrupts 能高过 1000（§19.4）。
  priority: 1000,
  // 只在未登录时 arm 入口（已登录后同形文本不再触发登录流程）。
  when: world => world.flags.logged_in !== true,
  entry: 'name',
  timeoutMs: 30_000,
  // 失败一律**只留痕不唤醒 T2**（作者定案 2026-09-13）：用户名/密码是人工给的，T2/用户都补不了；
  // 服务器异常（成功句不来 / 断线）也不是模型能处理的。因此不做恢复路径，只写日志 + 决策记录。
  failPolicy: { notify: 'none' },
  steps: [
    {
      id: 'name',
      driver: {
        kind: 'regex',
        patterns: [
          /^您的英文名字（要注册新人物请输入new。）：$/,
          /^您的英文名字[：:]\s*$/,
        ],
      },
      action: { tool: 'mud_send', args: { cmd: '{name}' } },
      // **本步不写 `ok`**（作者定案 2026-09-13）：本步的结果就是**下一步的新文本** ——
      // "此ID档案已存在，请输入密码："既是 `pass` 的进入判据（driver），也就是 `name` 的成功判据
      // （§19.2：命中后继 driver ⇒ 本步成功 + 走该分支）。判据只写一份，不在这里重复声明；
      // 写成 `ok:[GA]` 反而会让"命令被接受"抢先判定，把密码提示行消费掉、走不到 pass。
      fail: [{ kind: 'text', includes: ['需要创建新人物'] }],   // (估计) 用户名不存在 → 实质失败, 中断流程
      next: ['pass'],
    },
    {
      id: 'pass',
      driver: {
        kind: 'regex',
        // 抓包字节实证 (2026-09-10, 8081 老号复登): "此ID档案已存在，请输入密码："；
        // 兼容旧估计前缀 "ID已存在，" 与裸形态 (三者都收)。
        patterns: [/^(?:此ID档案已存在，|ID已存在，)?请输入密码[：:]\s*$/],
      },
      action: { tool: 'mud_send', args: { cmd: '{pass}' } },
      fail: [
        // 密码错误提示 (估计形态, 原文待作者核对)。实测上密码错常表现为**服务器直接断连**，
        // 那条路走桥的 `error`（写失败/连接断开）→ 同样失败收束，不依赖这里的文本。
        { kind: 'regex', patterns: [/^密码错误[^]*$/, /^密码不正确[^]*$/, /^登录失败[^]*$/] },
      ],
      // 本步同样**不写 `ok`**：它的结果就是下一步的新文本 —— "替换人物"句 → `replace`，
      // "目前权限：(player)"/"重新连线完毕" → `success`。两个后继都带 driver ⇒ 都是条件分支，
      // 谁的行先到谁生效；两条都不来则本步超时失败收束（不静默）。
      next: ['replace', 'success'],
    },
    {
      id: 'replace',
      driver: {
        kind: 'regex',
        // 实录 (2026-09-11, 同名在线): "您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)"
        // —— 旧关键词集 (同名/覆盖/替换/已被占用) 全不在该句里；以实录句为准，
        // 且不要求同行 y/n（服务器可能把 "(y/n)" 折到下一行）。
        patterns: [/^您要将另一个连线中的相同人物赶出去，取而代之吗？\s*(?:[（(]\s*[yY]\s*[/／]\s*[nN]\s*[）)]\s*)?$/],
      },
      action: { tool: 'mud_send', args: { cmd: 'y' } },
      // 作者定案 2026-09-13：答完 `y` **不再回头要密码**，直接等"已进入游戏"的成功句。
      next: ['success'],
    },
    {
      // 终态步（作者定案 2026-09-13：login 精简为 4 步）：**看见"已进入游戏"的成功句**才算登录完成
      // （与旧设计同一判据，只是判据从"判定节点"挪到本步 driver）→ 置位已登录 + **发一个空命令**收尾。
      //
      // 为什么发空命令而不是 `look`：① 空行足以"顶"开服务端（登录后不发命令则输出要等约 5 分钟，
      // 实测）；② MXP 检测模式**发任何命令都能跳过**，空行同样有效（不再需要单独的 `mxp` 步）；
      // ③ 模型接管后的第一屏由 T2 自己决定（不必我们替它 `look`）。
      // 到达路径（作者定案 2026-09-13 的步骤图）：`name → pass → [replace | success]`，
      // `replace → success` —— 即"成功句"是 `pass` 与 `replace` 的条件分支后继。
      id: 'success',
      driver: {
        kind: 'regex',
        patterns: [
          /^目前权限[：:]\s*[（(]?[pP]layer[)）]\s*$/,
          /^欢迎来到北大侠客行[^]*$/,   // (估计) 备选形态
          /^重新连线完毕[^]*$/,          // (估计) 备选形态
        ],
      },
      action: { tool: 'mud_send', args: { cmd: '' } },
      // 命令被接受即成功；next 空 = 终态 ⇒ `finishFlow`（§19.2）。
      ok: [{ kind: 'ga' }],
      timeoutMs: 5_000,
      onEnter: { patch: { logged_in: true } },
    },
  ],
}

// ── fullme (防机器人验证; `doc/ARCHITECTURE.md` §11) ─────────────────────

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
 *   - `prompt` 用 `mud_captcha` 工具取图 + 推前台弹窗，以**工具结果**判定（没有 GA 可判）；
 *   - `answer` 三次答错重来（`retry`；错码与 `fullme 1` 等价，三次错码即"三连放弃"），
 *     `timeoutMs = 180_000` = 图片有效期 = **本步总预算**（等人工 + 重来 + 收结果都算在内）；
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
      action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      ok: [{ kind: 'tool', outcome: 'ok' }],
      fail: [{ kind: 'tool', outcome: 'error' }],
      next: ['answer'],
      timeoutMs: 15_000,
    },
    {
      id: 'answer',
      action: { tool: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
      // 进入即**挂起动作**、进人工环节；`timeoutMs` 同时是人工等待与整步预算。
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

/** 默认流程表（装配期注册进运行时；只读声明）。 */
export const defaultFlows: readonly FlowSpec[] = [LOGIN_FLOW, FULLME_FLOW]

/** 一条判据的可读标识（日志/冲突留痕用；不含 `why`）。 */
export function matchLabel(match: FlowMatch): string {
  switch (match.kind) {
    case 'ga':
      return 'GA'
    case 'tool':
      return `tool(${match.outcome})`
    case 'text':
      return `text(${match.includes.join('|')})`
    case 'regex':
      return `regex(${match.patterns.map(p => String(p)).join('|')})`
  }
}

/** 判据的声明文案（`why`；只影响日志/决策文案，不参与匹配与互斥判定）。 */
export function matchWhy(match: FlowMatch): string | undefined {
  return match.why
}

/** 判据是否参与"行匹配"（`ga`/`tool` 不参与：它们针对本步自己的命令/工具结果）。 */
export function isLineMatch(match: FlowMatch): match is Extract<FlowMatch, { kind: 'regex' | 'text' }> {
  return match.kind === 'regex' || match.kind === 'text'
}

/** 判据键（互斥校验 / 去重用：把同一判据归一成可比字符串）。 */
function matchKey(match: FlowMatch): string {
  return matchLabel(match)
}

/**
 * 注册期校验（装配时调用；`doc/ARCHITECTURE.md` §19.1 校验表）。
 *
 * 违反即**返回错误清单**（调用方据此留痕并拒绝装配该流程，fail loud）：
 *   - 流程 id / 步骤 id 唯一；
 *   - `entry`（缺省 `steps[0]`）存在；`next` 引用的步骤存在；
 *   - 同一步的 `ok` 与 `fail` 判据集**互斥**（同一判据不得两边都写；`GA` 不得两边都写）；
 *   - `awaitExternal` 的占位符必须出现在 `action.args` 的命令里；
 *   - `tool` 判据只能出现在有动作的步骤上；`retry` 声明合法（`attempts`/`on`/有动作）；
 *   - 动作参数里的每个 `{…}` 都必须是已知占位符（凭据 / `{lastFail}` / 本流程 `capture` 槽 /
 *     `awaitExternal` 声明的外部值）；
 *   - `capture` 槽名在流程内唯一。
 * @param flows 待校验的流程表。
 * @returns 错误清单（空 = 全部合法）。
 */
export function validateFlows(flows: readonly FlowSpec[]): string[] {
  const errors: string[] = []
  const seenFlows = new Set<string>()
  for (const flow of flows) {
    if (seenFlows.has(flow.id)) errors.push(`流程 id 重复: ${flow.id}`)
    seenFlows.add(flow.id)
    if (!Number.isFinite(flow.priority)) errors.push(`${flow.id}: priority 必须是有限数字`)
    const ids = new Set(flow.steps.map(step => step.id))
    if (ids.size !== flow.steps.length) errors.push(`${flow.id}: 步骤 id 有重复`)
    const entry = flow.entry ?? flow.steps[0]?.id
    if (entry === undefined || !ids.has(entry)) {
      errors.push(`${flow.id}: entry 不存在 (${String(flow.entry)})`)
    }
    // 已知占位符: 凭据 + 内建槽 + 本流程 capture 槽 + awaitExternal 声明的外部值。
    const slots = new Set<string>()
    const externalKeys = new Set<string>()
    for (const step of flow.steps) {
      for (const name of Object.keys(step.capture ?? {})) {
        if (slots.has(name)) errors.push(`${flow.id}: capture 槽名重复 (${name})`)
        slots.add(name)
      }
      for (const key of step.awaitExternal ?? []) externalKeys.add(key)
    }
    const knownSlots = new Set<string>(['name', 'pass', 'lastFail', ...slots, ...externalKeys])
    for (const step of flow.steps) {
      const where = `${flow.id}/${step.id}`
      for (const next of step.next ?? []) {
        if (!ids.has(next)) errors.push(`${where}: next 引用了不存在的步骤 ${next}`)
      }
      const okKeys = new Set((step.ok ?? []).map(matchKey))
      for (const fail of step.fail ?? []) {
        if (okKeys.has(matchKey(fail))) {
          errors.push(`${where}: ok 与 fail 判据重叠 (${matchLabel(fail)}) — 同一步骤的 ok/fail 必须互斥`)
        }
      }
      if (step.driver !== undefined && okKeys.has(matchKey(step.driver))) {
        errors.push(`${where}: driver 与 ok 判据重叠 (${matchLabel(step.driver)})`)
      }
      for (const key of step.awaitExternal ?? []) {
        const text = commandText(step.action)
        if (!text.includes(`{${key}}`)) {
          errors.push(`${where}: awaitExternal 声明了 {${key}}，但 action.args 里没有该占位符`)
        }
      }
      // 工具结果判据要有动作可判（本步动作或重试动作）。
      if ([...(step.ok ?? []), ...(step.fail ?? [])].some(match => match.kind === 'tool')
        && step.action === undefined && step.retry?.action === undefined) {
        errors.push(`${where}: tool 判据需要本步有 action 或 retry.action`)
      }
      // 重试声明。
      if (step.retry !== undefined) {
        const retry = step.retry
        if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
          errors.push(`${where}: retry.attempts 必须是 >= 1 的整数 (总尝试次数, 含首次)`)
        }
        for (const on of retry.on ?? []) {
          if (on !== 'driver' && on !== 'fail') errors.push(`${where}: retry.on 只能是 'driver'/'fail' (${String(on)})`)
        }
        if ((retry.on ?? ['driver']).includes('driver') && step.driver === undefined) {
          errors.push(`${where}: retry.on 含 'driver'，但本步没有 driver`)
        }
        if (retry.action === undefined && step.action === undefined) {
          errors.push(`${where}: retry 需要本步有 action 或声明 retry.action`)
        }
      }
      // 动作参数的占位符必须在已知集合里（拼错占位符会在发送时才炸 → 注册期就拦下）。
      for (const raw of actionStrings(step.action)) {
        for (const match of raw.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
          const key = match[1] as string
          if (!knownSlots.has(key)) {
            errors.push(`${where}: 未知占位符 {${key}} — 只能引用 {name}/{pass}/{lastFail}/capture 槽/awaitExternal 声明的值`)
          }
        }
      }
      if (step.action === undefined && step.driver === undefined && step.ok === undefined && step.fail === undefined) {
        // 纯终态节点合法（进入即成功）；什么都不做的中间节点是笔误。
        if ((step.next ?? []).length > 0) errors.push(`${where}: 空节点却声明了 next（无判据可触发转移）`)
      }
    }
  }
  return errors
}

/** 取动作参数里的命令文本（用于占位符校验；`cmd` 与 `cmds` 都看）。 */
function commandText(action: FlowAction | undefined): string {
  if (action === undefined) return ''
  const args = action.args
  const single = typeof args.cmd === 'string' ? [args.cmd] : []
  const series = Array.isArray(args.cmds) ? args.cmds.filter((c): c is string => typeof c === 'string') : []
  return [...single, ...series].join('\n')
}

/** 动作参数里的全部字符串（占位符校验；含 `cmds` 序列与其它字符串参数，如 `url`/`note`）。 */
function actionStrings(action: FlowAction | undefined): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const one of value) walk(one); return }
    if (typeof value === 'object' && value !== null) {
      for (const one of Object.values(value as Record<string, unknown>)) walk(one)
    }
  }
  if (action !== undefined) walk(action.args)
  return out
}

/**
 * 流程声明的全部命令（权限判据用：流程命令属系统流程，不受档位可见性约束）。
 * @param flows 流程表。
 * @returns 命令字符串列表（含占位符原样，如 `fullme {captcha}`）。
 */
export function flowCommands(flows: readonly FlowSpec[] = defaultFlows): string[] {
  const out = new Set<string>()
  for (const flow of flows) {
    for (const step of flow.steps) {
      const args = step.action?.args
      if (typeof args?.cmd === 'string') out.add(args.cmd)
      if (Array.isArray(args?.cmds)) {
        for (const cmd of args.cmds) if (typeof cmd === 'string') out.add(cmd)
      }
      for (const cmd of step.onEnter?.direct ?? []) out.add(cmd)
    }
    for (const cmd of flow.onSuccess?.direct ?? []) out.add(cmd)
    for (const cmd of flow.onSuccess?.commands ?? []) out.add(cmd)
  }
  return [...out]
}

export default defaultFlows
