/**
 * dsh-mud-core — 工具集 (Tools), host half.
 *
 * 工具 = 校验点 + 执行路径。路径 A (标准 agent) 与路径 B (触发器 lite 借道)
 * 共用同一工具集; 非法参数在工具层拒绝, 不发到游戏才报"什么？"。
 *
 * 收敛策略: 不做 70+ 个命令工具 (撑爆上下文), 而是按意图/技能分组为
 * 语义化工具 (mud_move / mud_look / mud_status / mud_send 兜底)。
 *
 * v5 原则: 命名全部为 **agent 视角** 的中立 MUD 操作, 触发器只是借道;
 * 触发器开关组用 mud_flow_* (避免 MUD "group" 组队歧义)。
 *
 * 所有工具返回 { ok, note, cmd }:
 *   ok   是否成功入队
 *   note 结果说明 (工具层校验失败时的拒绝原因)
 *   cmd  实际发出的命令 (空 = 未发出)
 * 发命令类工具 (W7.2 在途窗口, §17 W7.2) 另带结算字段:
 *   settled 结算方式 (ga/until/timeout/abort/interrupted/error)
 *   outcome 结算结局 (ok/fail/error; 流程机单步推进判据)
 *   hitText 判据命中行原文 (until 结算; 流程 {lastFail} 槽源)
 * @module @deepseek-ai/dsh-mud-core/agents/tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_DANGEROUS_COMMANDS, commandHead, commandHelpText, deniedCommands, type DangerousRule,
} from '../shared/commands.ts'
import { resolveCaptchaImage } from '../services/network/captcha.ts'
import { MOVE_ALIASES, MOVE_DIRS, STATUS_CMDS } from '../shared/game.ts'
import type { ReplySettle, WindowCriteria, WindowRequest, WindowResult } from '../runtime/session/inflight.ts'
import type { SessionCredentials } from '../runtime/credentials.ts'
import { applyPatch, worldSnapshot, type WorldModel } from '../shared/world.ts'

/** 工具统一返回。*/
export interface MudToolResult {
  ok: boolean
  note: string
  cmd: string
  /** 在途窗口结算方式 (发命令工具; 见 OUT_RENDER — 窗口超时/中止
   *  是"成功结果携带错误文本", 与工具层校验拒绝区分, 不加 "工具拒绝:" 前缀)。 */
  settled?: ReplySettle
  /** 结算结局 (窗口判据/关窗; ok/fail/error; 未结算不带 — 流程机单步推进判据)。 */
  outcome?: 'ok' | 'fail' | 'error'
  /** 判据命中行原文 (until 结算; 流程 {lastFail} 槽源)。 */
  hitText?: string
}

// ── 会话登录凭据 (明文最小暴露面) ──────────────
// 类型 `SessionCredentials` 归 `runtime/credentials.ts` (契约随机制走);
// 引用一律以 {name}/{pass} 占位符流转 (转录/日志/工具结果均只见占位符),
// 明文仅在 mud_send 发送瞬间插值 (下方 interpolateCredentials)。

/** 凭据占位符插值: 字符串值中的 {name}/{pass} → 会话实际值 (逐值替换)。 */
export function interpolateCredentials(
  text: string,
  creds: SessionCredentials | undefined,
): string {
  if (!creds) return text
  return text.replace(/\{name\}/g, creds.name).replace(/\{pass\}/g, creds.pass)
}

/**
 * **外部占位符**插值: `{<key>}` → 外部提供的值 (目前只有 `{captcha}` = 人工输入的验证码)。
 *
 * 与凭据同一套"发送瞬间插值"策略 (明文/人工值不落转录): 规则动作声明 `fullme {captcha}`,
 * 值由人工在页面输入后存进会话, 发送那一刻才替换 (`doc/ARCHITECTURE.md` §11)。
 * @param text 待插值文本。
 * @param values 外部值表 (缺省不替换)。
 * @returns 替换后的文本。
 */
export function interpolateExternal(
  text: string,
  values: Readonly<Record<string, string>> | undefined,
): string {
  if (values === undefined) return text
  let out = text
  for (const [key, value] of Object.entries(values)) {
    if (key === '' || value === undefined) continue
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

/** 合法移动方向与状态命令别名见 `shared/game.ts` (MOVE_DIRS/MOVE_ALIASES/STATUS_CMDS)。 */

/**
 * 一条"活动"声明 (`doc/ARCHITECTURE.md` §8 活动表): 慢命令的完成句锚定 + 声明超时。
 *
 * 长程命令 (打坐/静坐/睡觉 …) 受理后长时间无 GA 也无 prompt, 只有完成句; 窗口按 GA
 * 主边界关窗的话会一直等超时。活动表把这些**数据化**: 命令首词 → 完成句正则 + 超时
 * (mud_send 未显式声明判据时自动附为窗口 ok 判据),
 * 部署可用 `Config.activityTable` 整体覆盖 (改一条命令的完成句不再改代码)。
 */
export interface ActivityEntry {
  /** 活动 id (日志/配置归因)。 */
  id: string
  /** 命令首词 (小写; 抓包实发首词与别名都要列上)。 */
  commands: readonly string[]
  /** 完成句锚定正则 (到达即结算; 跨帧累积)。 */
  until: string
  /** 声明超时毫秒 (缺省由窗口的 `declaredTimeoutMs` (120s) 决定)。 */
  timeoutMs?: number
  /** 一句说明 (抓包依据, 供维护者)。 */
  note?: string
}

/** 缺省活动表 (抓包实证 2026-09-10: dz/sleep 均无 GA 无 prompt, 直到完成句)。 */
export const DEFAULT_ACTIVITY_TABLE: readonly ActivityEntry[] = [
  {
    id: 'meditate',
    commands: ['dz', 'dazuo'],
    // 主形态为抓包原文; 回退分支放宽句尾锚定 (完成句与末条推送同块到达, 提前结算风险低,
    // 主要防止主形态因文本小变/异体字漂移而挂满声明超时)。
    until: '^(?:你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。|.*站了起来。)$',
    // dz 实测受理→完成约 57s (留余量); 缺省声明超时 120s 挂满代价更高。
    timeoutMs: 90_000,
    note: '打坐/静坐: 受理 GA 后 56 批 ~57s 无 GA, 完成句与末条推送同块',
  },
  {
    id: 'sleep',
    commands: ['sleep'],
    until: '^(?:你一觉醒来，精神抖擞地活动了几下手脚。|.*活动了几下手脚。)$',
    timeoutMs: 90_000,
    note: '睡觉: 与打坐同型 (无 GA 无 prompt, 直到完成句)',
  },
]

/**
 * 按命令首词查活动声明。
 * @param cmd 原始命令。
 * @param table 活动表 (缺省 `DEFAULT_ACTIVITY_TABLE`)。
 * @returns 命中的活动, 或 null。
 */
export function activityFor(
  cmd: string,
  table: readonly ActivityEntry[] = DEFAULT_ACTIVITY_TABLE,
): ActivityEntry | null {
  const head = String(cmd).trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (head === '') return null
  for (const entry of table) {
    if (entry.commands.includes(head)) return entry
  }
  return null
}

/**
 * 输出 schema (所有工具一致)。
 * `settled` 可选: 在途窗口的结算语义 (ga/until/timeout/abort…), 见
 * §8.3/§8.4。工具层校验拒绝 (未连接/危险命令) 不带该字段 —
 * 缺省即"未结算"。声明为 optional 是必需的: `additionalProperties: false`
 * 下漏声明会让**成功**的调用报 `value.settled is not a declared property`
 * (工具实际已执行, 却回给模型一条失败帧)。`outcome`/`hitText` 同理。
 */
export const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    note: { type: 'string', required: true },
    cmd: { type: 'string', required: true },
    settled: { type: 'string' },
    outcome: { type: 'string' },
    hitText: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** OUT_SCHEMA 的精确类型 (defineTool 推理用)。 */
export type MudOutputSchema = typeof OUT_SCHEMA

const OUT_RENDER = (_args: unknown, value: MudToolResult): ContentBlock[] => [{
  type: 'text',
  // 窗口结算结果 (timeout/abort) 的 note 即应答帧文本: 它属于"窗口的失败语义", 不是
  // 工具层校验拒绝 —— 加 "工具拒绝:" 前缀会污染模型可见文本且混淆归因。
  // 仅工具层校验拒绝 (settled 未定义) 加前缀。
  text: value.ok || value.settled ? value.note : `工具拒绝: ${value.note}`,
}]

/**
 * 硬边界判定: 命令首词命中危险策略表里的 `deny` 条目 → 工具层直接拒绝。
 *
 * 这是**工具自身**的最后一道闸 (不可逆操作: 删号/改密), 与档位无关 —— 档位感知
 * 的 `deny`/`ask` 由官方 `tools/pre-execute` 上的权限闸门负责
 * (`services/gate/policy.ts`); 两层共用同一张表 (`shared/commands.ts`)。
 * @param cmd 原始命令。
 * @param denied `deny` 首词集合。
 * @returns 是否硬禁用。
 */
function isForbidden(cmd: string, denied: ReadonlySet<string>): boolean {
  return denied.has(commandHead(cmd))
}

/** 一条 MUD 工具 (defineTool 兼容定义; 规则直接调用 execute)。 */
export interface MudTool {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: {
    schema: MudOutputSchema
    render: (args: unknown, value: MudToolResult) => ContentBlock[]
  }
  /**
   * 同步或异步 (装配 registerWindow 走在途窗口时为异步)。
   * @param args 模型/规则给的参数。
   * @param opts 调用方上下文 (`signal` = 回合取消信号, 转发给在途窗口; 见 §2)。
   */
  execute: (args: Record<string, unknown>, opts?: MudToolCallOptions) => MudToolResult | Promise<MudToolResult>
}

/** 一次工具调用的调用方上下文 (来自官方 `ToolRunContext`)。 */
export interface MudToolCallOptions {
  /**
   * 回合取消信号: 转发给在途窗口 (`WindowRequest.signal`)。回合被取消/超时时,
   * 在途等待优雅结算为 `settled='abort'` 而不是干等超时 (§2.1)。
   */
  signal?: AbortSignal
  /**
   * 发完即走 (不等应答): `mud_send` 只把命令**入队**, 不注册在途窗口。
   *
   * 用于**直接执行类动作** (`ActionSpec.direct`): 运行时替规则执行命令时没有"回合"
   * 可以承载应答, 等应答会把回复文本变成无主的帧内容 (谁都不需要它)。
   */
  fireAndForget?: boolean
}

/** 工具声明 (无执行体; preset 线注册工具时用)。 */
export interface MudToolSchema {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: MudTool['output']
}

/**
 * 工具声明表 (name/description/parameters/output), **不含执行体**。
 *
 * 用途: 官方 preset 线 (`agents/preset.ts`) 在**组装期**注册工具 —— 那时还没有任何
 * 会话, 拿不到闭包绑定会话队列/桥/world/凭据的执行体; 执行体在执行时按调用方 agent
 * 解析 (见 preset 插件的 `execute`)。声明表由 `buildMudTools()` 的无依赖默认实例
 * 产出, 保证与真实工具集同名同 schema (单一事实源, 不维护第二份列表)。
 * @returns 全部工具的声明 (与 `buildMudTools()` 的键集一致)。
 */
export function mudToolSchemaTable(): readonly MudToolSchema[] {
  return Object.values(buildMudTools()).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output,
  }))
}

/** 工具集。 */
export type MudTools = Record<string, MudTool>

/**
 * 构建工具集。
 * @param opts.send (cmd) => void 命令入队 (宿主接 CommandQueue; 未装配
 *   registerWindow 时的兜底直发路径)。
 * @param opts.registerWindow (spec) => Promise<WindowResult> 在途窗口
 *   (§8.3, W7.2 取代命令-应答桥): 注册窗口挂起等待结算, note = 窗口行
 *   文本 (T1/T2 同形, 查询工具直接拿到应答内容)。
 * @param opts.humanWindow 人工等待诊断通道 (mud_captcha 挂起段 begin/end 包裹;
 *   进在途窗口表 diag 的人工等待条目, 仅诊断不参与 gate)。
 * @param opts.log  (text) => void 活动日志 (WebUI 决策通道)。
 * @param opts.recall (n) => string[] **尚未投递**的最近 n 行游戏输出 (mud_recall/mud_state)。
 * @param opts.flowControl 触发器组开关/状态 (mud_flow_*; M4 落地前缺省不可用)。
 * @param opts.onWorldChange 世界模型被工具改写后的回调 (装配方据此重评估看门狗)。
 */
export function buildMudTools({
  send = () => {},
  registerWindow,
  humanWindow,
  log = () => {},
  recall = () => [],
  flowControl,
  world,
  resolveCredentials,
  resolveExternalValues,
  isConnected,
  captcha,
  dangerous = DEFAULT_DANGEROUS_COMMANDS,
  onWorldChange,
  activity = DEFAULT_ACTIVITY_TABLE,
}: {
  send?: (cmd: string) => void
  /** 在途窗口注册 (W7.2): 发命令工具统一走此路径 await 结算; 缺省 = 兜底直发。 */
  registerWindow?: (spec: WindowRequest) => Promise<WindowResult>
  /** 人工等待诊断 (mud_captcha 挂起段 begin/end 包裹; 缺省不记)。 */
  humanWindow?: { begin(label: string): void; end(): void }
  log?: (text: string) => void
  recall?: (count: number) => string[]
  flowControl?: {
    enable: (groupId: string) => boolean
    disable: (groupId: string) => boolean
    status: () => Record<string, 'enabled' | 'disabled' | 'unknown'>
  }
  world?: WorldModel
  /** 会话凭据读取器 (mud_send 发送瞬间插值 {name}/{pass}; 缺省不插值)。 */
  resolveCredentials?: () => SessionCredentials | undefined
  /** 外部占位符读取器 (`{captcha}` 等; 发送瞬间插值; 缺省不插值)。 */
  resolveExternalValues?: () => Readonly<Record<string, string>> | undefined
  /** 连接状态读取器: 缺省视为已连接。未连接时发命令类工具快速拒绝 (不入桥)。 */
  isConnected?: () => boolean
  /**
   * 验证码 ask-human 通道（`mud_captcha` 用；缺省 = 只解析不推 UI、不挂起）。
   *
   * `push` 取图与出站围栏在工具里做（`network/captcha.ts` 的 `resolveCaptchaImage`），宿主只把
   * 解析好的图片地址变成页面上的对话框；`robotUrl` 供宿主实现"刷新图片"。
   */
  captcha?: {
    push: (imageUrl: string, robotUrl: string, note?: string) => void
    /**
     * ask-human 挂起点: 推图后工具调用它**回合内等待**人工提交，resolve 值 = 人工输入
     * 的验证码；中止/超时/回合取消 reject（工具据此返回 `ok:false`，fail-closed）。
     * 缺省（未接通道）= 不挂起，人工环节走会话侧人工槽兜底路径。
     */
    wait?: (opts: { signal?: AbortSignal | undefined }) => Promise<string>
  }
  /** 危险命令策略表 (缺省 `DEFAULT_DANGEROUS_COMMANDS`; 部署可覆盖)。 */
  dangerous?: readonly DangerousRule[]
  /** 世界模型被工具改写后的回调 (装配方据此重评估看门狗; 缺省无操作)。 */
  onWorldChange?: () => void
  /** 活动表 (§8; 缺省 `DEFAULT_ACTIVITY_TABLE`; 部署可整体覆盖)。 */
  activity?: readonly ActivityEntry[]
} = {}): MudTools {
  const denied = deniedCommands(dangerous)
  /** 未连接时的统一拒绝 (不排队的本地失败 — agent 也不会拿到 "写 socket 失败")。 */
  const offline = (): MudToolResult | null => (
    isConnected !== undefined && !isConnected()
      ? { ok: false, note: '未连接游戏服务器, 命令未发送 (请先在游戏页点「连接」)', cmd: '' }
      : null
  )
  /**
   * 发命令类工具的统一窗口路径 (§2.4 T1/T2 同形): 注册窗口 → await 结算 → 结果透传。
   * WindowResult 已含全部结算语义映射 (timeout = ABANDON_TEXT 放弃文案), 工具层直取。
   */
  const viaWindow = async (spec: WindowRequest): Promise<MudToolResult> => {
    const r = await registerWindow!(spec)
    return {
      ok: r.ok,
      note: r.text,
      cmd: r.cmd,
      settled: r.settled,
      ...(r.outcome !== undefined ? { outcome: r.outcome } : {}),
      ...(r.hitText !== undefined ? { hitText: r.hitText } : {}),
    }
  }
  return {
    /** 移动: 只接受合法方向 (全名或别名), 非法方向拒绝。 */
    mud_move: {
      name: 'mud_move',
      description: '向指定方向移动。direction 必须是合法方向 (支持英文全名或短别名, 如 north / n / northeast / ne / up / enter)。',
      parameters: {
        direction: {
          type: 'string',
          required: true,
          description: '移动方向: north/south/east/west/up/down 或组合 ne/nw/se/sw/nu/nd/su/sd/eu/ed/wu/wd, 或 enter/out',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, opts) => {
        const raw = String(args.direction ?? '').trim().toLowerCase()
        const dir = MOVE_ALIASES[raw] ?? (MOVE_DIRS.includes(raw) ? raw : null)
        if (!dir) return { ok: false, note: `非法方向: ${raw}`, cmd: '' }
        const refused = offline()
        if (refused !== null) return refused
        log(`[工具] mud_move → ${dir}`)
        if (registerWindow) {
          // 窗口型 (§2.3): 无判据, 1 GA 关窗 = 成功, 窗口内行 = 工具结果 (T1/T2 同形)。
          return viaWindow({ cmd: dir, gaCount: 1, label: 'mud_move', ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) })
        }
        send(dir)
        return { ok: true, note: `向 ${dir} 移动`, cmd: dir }
      },
    },

    /** 查看: 无 target = 房间全貌; 有 target = look <target>。 */
    mud_look: {
      name: 'mud_look',
      description: '查看当前房间或指定目标。target 省略 = 查看房间全貌 (房间名/出口/物品/NPC); 指定 target 查看具体目标 (如 paizi / ren qunyu)。',
      parameters: {
        target: {
          type: 'string',
          description: '可选: 要查看的目标 (物品或 NPC 名称, 如 paizi / xiao er)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, opts) => {
        const target = String(args.target ?? '').trim()
        if (target && /[;\x00-\x1f]/.test(target)) {
          return { ok: false, note: `非法目标: ${target} (不能含分号/控制字符)`, cmd: '' }
        }
        const cmd = target ? `look ${target}` : 'look'
        const refused = offline()
        if (refused !== null) return refused
        log(`[工具] mud_look → ${cmd}`)
        if (registerWindow) {
          return viaWindow({ cmd, gaCount: 1, label: 'mud_look', ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) })
        }
        send(cmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 状态: what 枚举 → 对应命令, 非法拒绝。 */
    mud_status: {
      name: 'mud_status',
      description: '查询角色状态。what 决定具体状态命令: hp (气血/内力), score (经验/潜能), inventory (物品/装备), skills (武功)。',
      parameters: {
        what: {
          type: 'string',
          required: true,
          description: 'hp | score | inventory | skills',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, opts) => {
        const what = String(args.what ?? '').trim().toLowerCase()
        const cmd = STATUS_CMDS[what]
        if (!cmd) {
          return { ok: false, note: `未知状态: ${what} (可选 hp/score/inventory/skills)`, cmd: '' }
        }
        const refused = offline()
        if (refused !== null) return refused
        log(`[工具] mud_status → ${cmd}`)
        if (registerWindow) {
          return viaWindow({ cmd, gaCount: 1, label: 'mud_status', ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) })
        }
        send(cmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 兜底: 发送任意原始命令 (无专用工具时用; 规则确定性动作也走这里)。
     *  `cmds` 数组 = 命令序列 (发完即走时可含空命令, 如分页翻页的空白行);
     *  单体 `cmd` 与"只有空命令的序列"依旧拒绝空命令。
     *  凭据: {name}/{pass} 占位符仅在 send 瞬间插值 — log/返回值/转录
     *  (tool-call args + tool-result) 全程只见占位符, 明文不落任何通道。 */
    mud_send: {
      name: 'mud_send',
      description: '向 MUD 游戏发送一条原始命令 (或一组命令序列)。优先使用 mud_move / mud_look / mud_status 等专用工具; 仅在无专用工具时 (如 ask/使用特殊物品) 使用本工具。',
      parameters: {
        cmd: {
          type: 'string',
          description: '游戏命令, 如 ask <npc> about <话题> / eat baozi; 空字符串 = 发一个空行 (登录收尾/翻页)',
        },
        cmds: {
          type: 'array',
          items: { type: 'string' },
          description: '命令序列, 依次发出 (发完即走时可含空命令, 用于分页翻页)。与 cmd 二选一',
        },
        until: {
          type: 'object',
          additionalProperties: true,
          description: '可选: 声明应答结算判据 (规则动作使用)。声明的正则命中应答文本即结算 (跨帧累积; 慢命令如 dz/fullme), 缺省 GA 主边界关窗结算',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: async (args, opts) => {
        const wire = (c: string): string => interpolateExternal(
          interpolateCredentials(c, resolveCredentials?.()),
          resolveExternalValues?.(),
        )
        const refused = offline()
        if (refused !== null) return refused
        // 声明判据 (规则动作可传): args.until = { regex, timeout? } → ok 判据 (命中 =
        // 成功结算, §2.3 判据型)。非法正则回退无判据 (窗口型, GA 关窗)。
        const untilRaw = args.until as { regex?: unknown; timeout?: unknown } | undefined
        let criteria: WindowCriteria | undefined
        let timeoutMs: number | undefined
        if (untilRaw && typeof untilRaw.regex === 'string') {
          try {
            criteria = { ok: new RegExp(untilRaw.regex) }
          } catch {
            criteria = undefined
          }
          if (typeof untilRaw.timeout === 'number') timeoutMs = untilRaw.timeout
        }
        // 回合取消信号: 随窗口注册传入 (取消 → 优雅结算 settled='abort')。
        const signal = opts?.signal
        // 命令序列: **单窗一次注册** (序列 = 同一窗口, 每命令至少 1 个 GA → 缺省
        // gaCount = 条数; W7.2 取代旧桥逐条串行结算)。
        const series = Array.isArray(args.cmds) ? args.cmds.map((c) => String(c)) : null
        if (series && series.length > 0) {
          for (const c of series) {
            if (isForbidden(c, denied)) {
              return { ok: false, note: `安全禁用命令, 拒绝发送: ${String(c).trim()}`, cmd: '' }
            }
          }
          log(`[工具] mud_send 序列 → ${series.length} 条命令`)
          if (registerWindow && opts?.fireAndForget !== true) {
            // interrupted/abort 由窗口结算原样透传 (ok:false), 序列天然不再续发。
            return viaWindow({
              cmd: series.map(wire),
              ...(criteria !== undefined ? { criteria } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              label: 'mud_send',
              ...(signal !== undefined ? { signal } : {}),
            })
          }
          // 无 registerWindow 或发完即走: 直发 (不注册窗口)。
          for (const c of series) send(wire(c))
          return { ok: true, note: '命令序列', cmd: '' }
        }
        // 单体命令: **空命令合法**（发一个空行 —— 登录收尾"顶"一下 / 翻页 / 退出 MXP 检测；
        // 作者定案 2026-09-13：其他客户端也允许发空命令）。只有"既没给 cmd 也没给 cmds"
        // 才是参数错误（`args.cmd` 不是字符串）。
        if (typeof args.cmd !== 'string') return { ok: false, note: '空命令', cmd: '' }
        const cmd = args.cmd.trim()
        if (isForbidden(cmd, denied)) {
          return { ok: false, note: `安全禁用命令, 拒绝发送: ${cmd}`, cmd: '' }
        }
        const wiredCmd = wire(cmd)
        // §8 活动表: 慢命令 (打坐/静坐/睡觉 …) 未显式声明判据时自动附带完成句锚定 —
        // 完成句作为窗口 ok 判据注册 (命中即结算), 不依赖 GA (dz/sleep 无 GA 无 prompt)。
        const activityEntry = activityFor(cmd, activity)
        if (activityEntry !== null && criteria === undefined) {
          criteria = { ok: new RegExp(activityEntry.until) }
          if (activityEntry.timeoutMs !== undefined) timeoutMs = activityEntry.timeoutMs
        }
        log(`[工具] mud_send → ${cmd}`)
        if (registerWindow && opts?.fireAndForget !== true) {
          return viaWindow({
            cmd: wiredCmd,
            ...(criteria !== undefined ? { criteria } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            label: 'mud_send',
            ...(signal !== undefined ? { signal } : {}),
          })
        }
        send(wiredCmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 回看: **尚未投递给你**的最近 n 行游戏输出 (终端缓冲; 不走游戏)。 */
    mud_recall: {
      name: 'mud_recall',
      description: '读取**尚未投递给你**的最近 count 行游戏输出 (含命令回显)。已经出现在会话历史里的内容不会重复给出; 不发送任何命令。',
      parameters: {
        count: {
          type: 'integer',
          description: '最多读取多少行尚未投递的输出 (1-200, 缺省 20)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        const raw = Number(args.count ?? 20)
        const count = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20
        const lines = recall(count)
        log(`[工具] mud_recall → 最近 ${lines.length} 行`)
        // 空结果显式反馈 (静默空串会让 agent 误判工具异常/反复重试)。
        if (lines.length === 0) {
          return { ok: true, note: '（没有尚未投递的游戏输出 — 新输出到达时会自动投递给你）', cmd: '' }
        }
        return { ok: true, note: lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'), cmd: '' }
      },
    },

    /**
     * mud_captcha: **ask-human 工具** —— 解析 fullme 验证码页面、推前台弹窗并**回合内
     * 挂起等人工提交**（系统流程工具，不发游戏命令）。
     *
     * 对齐官方 `ApprovalService.request` 的提问语义（`@deepseek-ai/dsh-user-approval`）:
     * 提问要求**回合开着** —— 取图推送后工具 Promise 不返回，人工提交/中止/超时才带回
     * 结果，码随**工具结果**回管线（后续 answer 动作 defer 进同一回合, 不再分裂回合）。
     * 等待超时/中止/回合取消都 fail-closed（`ok:false`, 对应官方 `cancelled/unavailable`）;
     * 判据是**工具结果**（`ok`/`error`）而不是 GA：不经过命令-应答桥（`doc/ARCHITECTURE.md` §11）。
     * 取图失败同样立即返回 `ok:false`（流程据此失败收束，不让人对着坏图干等）；地址围栏在
     * `resolveCaptchaImage` 里（只允许 pkuxkx.net）。
     */
    mud_captcha: {
      name: 'mud_captcha',
      description: '解析 fullme 验证码页面并推送到前端对话框（取图 + 校验出站围栏），然后等待人工在对话框提交验证码（挂起直到提交/中止/超时）。url 必须是游戏回显的 robot.php 地址；note 是展示给人工的提示（如上一轮答错原文）。提交成功返回 ok:true（码已交给后台，后续由流程包装发送）；中止或超时返回 ok:false。',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: '验证码页面地址（游戏回显的 http(s)://…/robot.php?filename=…）',
        },
        note: {
          type: 'string',
          description: '展示给人工的提示（可选；例如上一轮的失败原文）',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: async (args, opts) => {
        const url = String(args.url ?? '').trim()
        if (url === '') return { ok: false, note: '缺少验证码地址 (url)', cmd: '' }
        const rawNote = typeof args.note === 'string' ? args.note.trim() : ''
        // 人工等待进窗口诊断 (§2.9): begin/end 配对包住整个挂起段 (幂等; 仅 diag,
        // 不参与 gate/hasOpen — W7.2 验证码统一进在途窗口机制)。
        humanWindow?.begin('mud_captcha')
        try {
          const imageUrl = await resolveCaptchaImage(url)
          captcha?.push(imageUrl, url, rawNote === '' ? undefined : rawNote)
          log(`[验证码] 已解析并推送图片: ${imageUrl}`)
          if (captcha?.wait === undefined) {
            // 旧装配兜底（宿主未接 ask-human 通道）: 只推图即返回，人工环节仍由
            // 会话侧的人工槽路径收口（answer 步 awaitExternal 挂起 → 回填 → 投递）。
            return { ok: true, note: `验证码图片已推送: ${imageUrl} (等待人工输入)`, cmd: '' }
          }
          // ask-human: 回合内挂起等人工提交（超时/中止/回合取消 → fail-closed）。
          const code = await captcha.wait({ signal: opts?.signal })
          log(`[验证码] 人工已提交验证码 (${code.length} 字符)`)
          return { ok: true, note: `人工已提交验证码: ${code} (后台将包装为 halt + fullme 发送)`, cmd: '' }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log(`[验证码] 等待人工失败: ${message}`)
          return { ok: false, note: `等待人工验证码失败: ${message}`, cmd: '' }
        } finally {
          humanWindow?.end()
        }
      },
    },

    /**
     * mud_state: **零发送**信息通路 (只读档的唯一信息源, §10)。
     * 读世界模型快照 + 最近输出 + 连接状态; 不碰 socket (`mud_look`/`mud_status`
     * 本身都发命令, 只读档不能用)。
     */
    mud_state: {
      name: 'mud_state',
      description: '读取当前会话的已知状态: 世界模型快照 (房间/出口/气血/内力/标志位) + **尚未投递给你**的游戏输出。不发送任何命令 (只读通路)。',
      parameters: {
        lines: {
          type: 'integer',
          description: '附带读取的尚未投递输出行数 (0-100, 缺省 20; 0 = 只看世界模型)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        const raw = Number(args.lines ?? 20)
        const lines = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.floor(raw))) : 20
        const snapshot = world ? worldSnapshot(world) : null
        const recent = lines > 0
          ? recall(lines).map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
          : []
        const parts: string[] = [
          `连接: ${isConnected === undefined ? '未知' : (isConnected() ? '已连接' : '未连接')}`,
        ]
        if (snapshot === null) {
          parts.push('世界模型: 未装配')
        } else {
          parts.push(`世界模型: ${JSON.stringify(snapshot)}`)
        }
        if (recent.length > 0) parts.push(`最近 ${recent.length} 行输出:\n${recent.join('\n')}`)
        else if (lines > 0) parts.push('（缓冲暂无游戏输出）')
        log(`[工具] mud_state → 快照${recent.length > 0 ? ` + ${recent.length} 行` : ''}`)
        return { ok: true, note: parts.join('\n'), cmd: '' }
      },
    },

    /**
     * mud_help: **零发送**命令语法查询 (§10 只读通路)。
     *
     * 系统提示里只放命令索引 (`commandsIndexForAgent`), 语法按需取 —— 70+ 条命令的
     * 完整语法不必每轮都进前缀。
     */
    mud_help: {
      name: 'mud_help',
      description: '查询游戏命令语法 (不发送任何命令): 不带 topic 列出全部分类与命令 id; topic=分类 (navigation/combat/cultivation/status/trade/quest/social/system/lifecycle) 给出该类完整语法; topic=命令 id (如 ask) 给出该命令语法与说明。',
      parameters: {
        topic: {
          type: 'string',
          description: '分类 id 或命令 id (缺省 = 全部命令 id 索引)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        const topic = String(args.topic ?? '')
        const text = commandHelpText(topic)
        log(`[工具] mud_help → ${topic.trim() === '' ? '<索引>' : topic.trim()}`)
        return { ok: true, note: text, cmd: '' }
      },
    },

    /** world_patch: 文本推断状态 → WorldModel (置信度 0.7; GMCP 权威 1.0 优先)。 */
    world_patch: {
      name: 'world_patch',
      description: '更新世界模型中的状态字段 (文本推断, 置信度 0.7)。适用于从游戏输出中推断的非 GMCP 权威状态: in_combat、logged_in、awaiting、initialized、dead 等。点分键如 "flags.sent_name" 可写入指定分组。',
      parameters: {
        patch: {
          type: 'object',
          required: true,
          additionalProperties: true,
          description: '要更新的字段键值对。已知语义键: in_combat (bool), logged_in (bool), awaiting (bool), initialized (bool), dead (bool); 其余键进入 flags 分组。',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        if (!world) return { ok: false, note: 'world_patch 未装配 (缺少 WorldModel)', cmd: '' }
        const patch = args.patch as Record<string, unknown> | undefined
        if (!patch || typeof patch !== 'object') return { ok: false, note: 'patch 参数必须为对象', cmd: '' }
        const changes = applyPatch(world, patch)
        if (changes.length === 0) return { ok: true, note: '无变化 (值相同或置信度不足)', cmd: '' }
        log(`[工具] world_patch → ${changes.join(', ')}`)
        // 世界变化可能翻转 `logged_in` → 由装配方重新评估看门狗 (登录完成必须布防断流计时)。
        onWorldChange?.()
        return { ok: true, note: `已更新: ${changes.join(', ')}`, cmd: '' }
      },
    },

    /** 触发器组: 恢复启用 (恢复被 mud_flow_disable 关闭的常驻组入口)。 */
    mud_flow_enable: {
      name: 'mud_flow_enable',
      description: '恢复启用指定的触发器组 (一次启用后该组条目重新对游戏输出生效)。groupId 为空 = 启用全部已禁用组。',
      parameters: {
        groupId: {
          type: 'string',
          description: '组 id (缺省 = 全部已禁用组)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        if (!flowControl) return { ok: false, note: '触发器组管理未装配 (M4)', cmd: '' }
        const groupId = String(args.groupId ?? '').trim()
        const ok = flowControl.enable(groupId)
        log(`[工具] mud_flow_enable → ${groupId || '<全部>'} (${ok ? '已启用' : '失败'})`)
        return { ok, note: ok ? '组已恢复启用' : '组不存在或未禁用', cmd: '' }
      },
    },

    /** 触发器组: 关闭 (禁用该组全部条目; 常驻组入口保留, 可被 mud_flow_enable 恢复)。 */
    mud_flow_disable: {
      name: 'mud_flow_disable',
      description: '禁用指定的触发器组 (该组条目暂停对游戏输出生效)。groupId 为空 = 禁用全部常驻组。',
      parameters: {
        groupId: {
          type: 'string',
          description: '组 id (缺省 = 全部常驻组)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        if (!flowControl) return { ok: false, note: '触发器组管理未装配 (M4)', cmd: '' }
        const groupId = String(args.groupId ?? '').trim()
        const ok = flowControl.disable(groupId)
        log(`[工具] mud_flow_disable → ${groupId || '<全部>'} (${ok ? '已禁用' : '失败'})`)
        return { ok, note: ok ? '组已禁用' : '组不存在', cmd: '' }
      },
    },

    /** 触发器组: 查看状态 (启/停/未知)。 */
    mud_flow_status: {
      name: 'mud_flow_status',
      description: '查看各触发器组当前状态 (enabled = 生效, disabled = 已禁用, unknown = 未注册)。',
      parameters: {
        groupId: {
          type: 'string',
          description: '可选: 只查指定组 (缺省 = 全部组)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args, _opts) => {
        if (!flowControl) return { ok: false, note: '触发器组管理未装配 (M4)', cmd: '' }
        const groupId = String(args.groupId ?? '').trim()
        const status = flowControl.status()
        const view = groupId ? { [groupId]: status[groupId] ?? 'unknown' } : status
        log(`[工具] mud_flow_status → ${JSON.stringify(view)}`)
        return { ok: true, note: JSON.stringify(view), cmd: '' }
      },
    },
  }
}
