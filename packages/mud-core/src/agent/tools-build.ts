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
 *   captures 抽取槽 (W10.2: 结算时对 span 行跑 captures 正则, 命名捕获组即槽名)
 *
 * 工具契约 (LLM 所见声明的类型基础: MudToolResult/OUT_SCHEMA/MudTool/…)
 * 见 `tools-schema.ts`; 本模块 = 构建/插值 (buildMudTools + 占位符插值 + 活动表)。
 * @module @deepseek-ai/dsh-mud-core/agent/tools-build
 */

import {
  DEFAULT_DANGEROUS_COMMANDS, commandHead, commandHelpText, deniedCommands, type DangerousRule,
} from './commands.ts'
import { resolveCaptchaImage } from '../network/captcha.ts'
import { MOVE_ALIASES, MOVE_DIRS, STATUS_CMDS } from '../world/game.ts'
import type { WindowRequest, WindowResult } from './inflight.ts'
import type { SessionCredentials } from '../session/credentials.ts'
import { applyPatch, worldSnapshot, type WorldModel } from '../world/state.ts'
import type { SettleSpec } from './flow/flow-spec.ts'
import {
  OUT_RENDER, OUT_SCHEMA, type MudToolResult, type MudToolSchema, type MudTools,
} from './tools-schema.ts'

// ── 会话登录凭据 (明文最小暴露面) ──────────────
// 类型 `SessionCredentials` 归 `session/credentials.ts` (契约随机制走);
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

/** 合法移动方向与状态命令别名见 `world/game.ts` (MOVE_DIRS/MOVE_ALIASES/STATUS_CMDS)。 */

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

// ── W10.1 收口/分类参数解析 (doc/PLAN.md §3.1: 收口与分类分离) ──────────────

/** 收口缺省兜底时长 (D3: 缺省 `{mode:'stream'}` + fallback 3000, 两 lane 一致的 T2 量级短超时)。 */
const SETTLE_FALLBACK_MS = 3000

/** T2 命令类工具的显式收口声明 (D3/R1: 现行 `gaCount:1` 迁移为 settle on ga:1)。 */
const T2_QUERY_SETTLE = { mode: 'stream', on: { kind: 'ga', count: 1 } } as const satisfies SettleSpec

/** resolveSettleWindow 的产出: 在途窗口声明 (形态 C：**只有收口**, 没有分类/抽取)。 */
interface ResolvedSettle {
  /** inline 收口: 工具结果即结算, 直发 + 立即返回 (不开窗)。 */
  inline: boolean
  /** 关闭触发 (`settle.on` regex / legacy `until`): 命中即关窗（`settled:'evidence'`）, **不判类**。 */
  closeOn?: RegExp
  gaCount?: number
  /** 兜底时长 (缺省 3000; 到期恒 timeout 结算)。 */
  timeoutMs?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 tool-call 的 `settle` 参数解析为在途窗口声明（PLAN §3.1 **形态 C**）。
 *
 * **模型可见面只有一个概念：关闭触发**。`settle.on` = `{kind:'ga',count}`（第 N 个 GA 后关窗）
 * 或 `{kind:'regex',pattern}`（正则命中即关窗）；`fallback.ms` = 兜底时长。**收口不解释内容**
 * —— 触发命中与 GA 关窗都只表示"窗口因证据关闭"（`settled:'evidence'` / `'ga'`，同形不同名），
 * 内容随窗口带回；"这行算哪一类"由**流程表的 `classify`** 决定、由驱动器复判。
 * 缺省 `{mode:'stream'}` + fallback 3000（两 lane 一致，调用期不报错）；非法声明
 * **fail-closed 拒绝**（不静默回退 —— 声明写错不该被 3s 兜底掩盖）。
 */
function resolveSettleWindow(settle: unknown): ResolvedSettle | { error: string } {
  // ① 缺省收口 = stream + fallback 3000, 无关闭触发 (恒等满兜底)。
  if (settle === undefined) return { inline: false, timeoutMs: SETTLE_FALLBACK_MS }
  if (!isPlainObject(settle)) {
    return { error: '工具拒绝: settle 必须是 {mode:"inline"} 或 {mode:"stream", on?, fallback?}' }
  }
  if (settle.mode === 'inline') {
    // inline 收口: 工具结果即结算 (不开行流窗口, 故无关闭触发可声明)。
    return { inline: true }
  }
  if (settle.mode !== 'stream') {
    return { error: '工具拒绝: settle.mode 只能是 "inline"/"stream"' }
  }
  // ② stream: on 条件 → 关闭触发 (ga 的 count / regex 的 pattern)。
  let gaCount: number | undefined
  let closeOn: RegExp | undefined
  if (settle.on !== undefined) {
    if (!isPlainObject(settle.on)) {
      return { error: '工具拒绝: settle.on 必须是 {kind:"ga", count} 或 {kind:"regex", pattern}' }
    }
    if (settle.on.kind === 'ga') {
      if (!Number.isInteger(settle.on.count) || (settle.on.count as number) < 1) {
        return { error: '工具拒绝: settle.on ga count 必须是 >= 1 的整数' }
      }
      gaCount = settle.on.count as number
    } else if (settle.on.kind === 'regex') {
      if (typeof settle.on.pattern !== 'string' && !(settle.on.pattern instanceof RegExp)) {
        return { error: '工具拒绝: settle.on regex pattern 必须是正则源码字符串' }
      }
      try {
        closeOn = new RegExp(settle.on.pattern instanceof RegExp ? settle.on.pattern.source : settle.on.pattern)
      } catch (error) {
        return { error: `工具拒绝: settle.on regex 编译失败 (${error instanceof Error ? error.message : String(error)})` }
      }
    } else {
      return { error: '工具拒绝: settle.on kind 只能是 "ga"/"regex" (time kind 已删除, 时间恒由 fallback 管)' }
    }
  }
  // ③ fallback: 兜底时长 (缺省 3000; 到期恒 timeout 结算)。
  let timeoutMs = SETTLE_FALLBACK_MS
  if (settle.fallback !== undefined) {
    const fb = settle.fallback as { ms?: unknown }
    if (!isPlainObject(settle.fallback) || !Number.isFinite(fb.ms) || (fb.ms as number) <= 0) {
      return { error: '工具拒绝: settle.fallback 必须是 {ms: 正数}' }
    }
    timeoutMs = fb.ms as number
  }
  return {
    inline: false,
    ...(closeOn !== undefined ? { closeOn } : {}),
    ...(gaCount !== undefined ? { gaCount } : {}),
    timeoutMs,
  }
}

/** T2 命令类工具的窗口请求 (显式收口 settle on ga:1 + 统一 fallback 3000, D3/R1)。 */
function t2QueryRequest(cmd: string, label: string, signal?: AbortSignal): WindowRequest {
  const settle = resolveSettleWindow(T2_QUERY_SETTLE)
  if ('error' in settle || settle.inline) {
    // 常量声明错误属编程缺陷 (恒不触发)。
    throw new Error(`T2 收口常量非法: ${'error' in settle ? settle.error : 'inline'}`)
  }
  return {
    cmd,
    ...(settle.closeOn !== undefined ? { closeOn: settle.closeOn } : {}),
    ...(settle.gaCount !== undefined ? { gaCount: settle.gaCount } : {}),
    ...(settle.timeoutMs !== undefined ? { timeoutMs: settle.timeoutMs } : {}),
    label,
    ...(signal !== undefined ? { signal } : {}),
  }
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
 * 硬边界判定: 命令首词命中危险策略表里的 `deny` 条目 → 工具层直接拒绝。
 *
 * 这是**工具自身**的最后一道闸 (不可逆操作: 删号/改密), 与档位无关 —— 档位感知
 * 的 `deny`/`ask` 由官方 `tools/pre-execute` 上的权限闸门负责
 * (`agent/gate/policy.ts`); 两层共用同一张表 (`agent/commands.ts`)。
 * @param cmd 原始命令。
 * @param denied `deny` 首词集合。
 * @returns 是否硬禁用。
 */
function isForbidden(cmd: string, denied: ReadonlySet<string>): boolean {
  return denied.has(commandHead(cmd))
}

/**
 * 工具声明表 (name/description/parameters/output), **不含执行体**。
 *
 * 用途: 官方 preset 线 (`session/preset.ts`) 在**组装期**注册工具 —— 那时还没有任何
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
 * @param opts.flowControl 触发器组开关/状态 (mud_flow_*; M4 落地前缺省不可用)。
 * @param opts.onWorldChange 世界模型被工具改写后的回调 (装配方据此重评估看门狗)。
 */
export function buildMudTools({
  send = () => {},
  registerWindow,
  humanWindow,
  log = () => {},
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
   * WindowResult 已含全部结算语义映射 (timeout **带回已累积内容**, PLAN §D4 定案 A),
   * 工具层直取。
   */
  const viaWindow = async (spec: WindowRequest): Promise<MudToolResult> => {
    const r = await registerWindow!(spec)
    // 形态 C：工具结果只有 `{ok, note, cmd, settled}` —— 内容随 `lines` 由窗口表直送驱动器
    // (不进模型可见面); 分类/命中行/抽取都不是工具面概念。
    return { ok: r.ok, note: r.text, cmd: r.cmd, settled: r.settled }
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
          // 窗口型 (§2.3): 显式收口 settle on ga:1 (D3/R1) —— 1 GA 关窗 = 成功, 窗口内行 = 工具结果 (T1/T2 同形)。
          return viaWindow(t2QueryRequest(dir, 'mud_move', opts?.signal))
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
          return viaWindow(t2QueryRequest(cmd, 'mud_look', opts?.signal))
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
          return viaWindow(t2QueryRequest(cmd, 'mud_status', opts?.signal))
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
          description: '可选 (旧口径, 规则动作使用): 声明应答关闭触发 {regex, timeout?}。声明的正则命中应答文本即关窗 (跨帧累积; 慢命令如 dz/fullme), 缺省由 settle 的关闭触发与兜底时长管。与 settle 不得同时声明',
        },
        settle: {
          type: 'object',
          additionalProperties: true,
          description: '可选收口声明 (只回答"窗口何时关闭", 不解释应答内容): {mode:"inline"} 不等应答立即返回 (工具结果即结算, 不开应答窗口); {mode:"stream", on?, fallback?} 开应答窗口——on 为关闭触发 {kind:"ga", count:N} (第 N 个 GA 后关窗) 或 {kind:"regex", pattern} (正则命中即关窗, 正则为源码字符串), fallback={ms} 为兜底超时毫秒。缺省 stream + 3000ms 兜底 (到期即 timeout 结算)',
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
        // ── W10.1/形态 C 收口参数 (PLAN §3.1): 非法声明 fail-closed 拒绝 (不静默回退);
        // legacy until (规则动作旧口径) 与 settle 互斥。**分类/抽取不是工具面概念**
        // (形态 C：它们是流程表字段, 由驱动器对窗口带回的内容复判/抽取)。
        if (args.until !== undefined && args.settle !== undefined) {
          return { ok: false, note: 'until 与 settle 不得同时声明 (until 为旧口径, 请改用 settle)', cmd: '' }
        }
        const settleResolved = resolveSettleWindow(args.settle)
        if ('error' in settleResolved) return { ok: false, note: settleResolved.error, cmd: '' }
        if (settleResolved.inline) {
          // inline 收口: 工具结果即结算 —— 直发 + 立即 ok 返回 (不开窗、不算应答)。
          const inlineSeries = Array.isArray(args.cmds) ? args.cmds.map((c) => String(c)) : null
          if (inlineSeries && inlineSeries.length > 0) {
            for (const c of inlineSeries) {
              if (isForbidden(c, denied)) {
                return { ok: false, note: `安全禁用命令, 拒绝发送: ${String(c).trim()}`, cmd: '' }
              }
            }
            log(`[工具] mud_send 序列(inline) → ${inlineSeries.length} 条命令`)
            for (const c of inlineSeries) send(wire(c))
            return { ok: true, note: '命令序列 (inline 收口: 已发出, 工具结果即结算)', cmd: '' }
          }
          if (typeof args.cmd !== 'string') return { ok: false, note: '空命令', cmd: '' }
          const inlineCmd = args.cmd.trim()
          if (isForbidden(inlineCmd, denied)) {
            return { ok: false, note: `安全禁用命令, 拒绝发送: ${inlineCmd}`, cmd: '' }
          }
          log(`[工具] mud_send(inline) → ${inlineCmd}`)
          send(wire(inlineCmd))
          return { ok: true, note: inlineCmd, cmd: inlineCmd }
        }
        // 关闭触发 (规则动作可传): args.until = { regex, timeout? } → 关闭触发 (命中即关窗,
        // 形态 C：不判类; 规则动作无"下一步"可判)。非法正则回退无触发 (只由 settle 的
        // 触发 / GA / 兜底收口)。
        // 未声明 until 时触发/兜底来自 settle 解析 (缺省 stream + 3000; 活动表附加仅在
        // 此无触发时生效, 见下)。
        const untilRaw = args.until as { regex?: unknown; timeout?: unknown } | undefined
        let closeOn: RegExp | undefined
        let timeoutMs: number | undefined
        if (untilRaw !== undefined) {
          if (typeof untilRaw.regex === 'string') {
            try {
              closeOn = new RegExp(untilRaw.regex)
            } catch {
              closeOn = undefined
            }
            if (typeof untilRaw.timeout === 'number') timeoutMs = untilRaw.timeout
          }
        } else {
          closeOn = settleResolved.closeOn
          timeoutMs = settleResolved.timeoutMs
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
              ...(closeOn !== undefined ? { closeOn } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(settleResolved.gaCount !== undefined ? { gaCount: settleResolved.gaCount } : {}),
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
        // §8 活动表: 慢命令 (打坐/静坐/睡觉 …) 未显式声明触发时自动附带完成句锚定 —
        // 完成句作为**关闭触发**注册 (命中即关窗), 不依赖 GA (dz/sleep 无 GA 无 prompt)。
        const activityEntry = activityFor(cmd, activity)
        if (activityEntry !== null && closeOn === undefined) {
          closeOn = new RegExp(activityEntry.until)
          if (activityEntry.timeoutMs !== undefined) timeoutMs = activityEntry.timeoutMs
        }
        log(`[工具] mud_send → ${cmd}`)
        if (registerWindow && opts?.fireAndForget !== true) {
          return viaWindow({
            cmd: wiredCmd,
            ...(closeOn !== undefined ? { closeOn } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(settleResolved.gaCount !== undefined ? { gaCount: settleResolved.gaCount } : {}),
            label: 'mud_send',
            ...(signal !== undefined ? { signal } : {}),
          })
        }
        send(wiredCmd)
        return { ok: true, note: cmd, cmd }
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
     * 只读世界模型快照 + 连接状态; 不碰 socket (`mud_look`/`mud_status` 本身都发命令,
     * 只读档不能用)。
     *
     * **不含"最近输出"** (2026-09-21 定案): T2 的上下文就是会话历史本身, 本插件不提供
     * 任何拉取通路 —— 原 `lines` 参数 (历史输出查询) 随 `mud_recall` 一并删除。
     */
    mud_state: {
      name: 'mud_state',
      description: '读取当前会话的已知状态: 世界模型快照 (房间/出口/气血/内力/标志位) + 连接状态。不发送任何命令; 不返回游戏输出历史 (近期输出已在你的会话上下文里) (只读通路)。',
      parameters: {},
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (_args, _opts) => {
        const snapshot = world ? worldSnapshot(world) : null
        const parts: string[] = [
          `连接: ${isConnected === undefined ? '未知' : (isConnected() ? '已连接' : '未连接')}`,
        ]
        if (snapshot === null) {
          parts.push('世界模型: 未装配')
        } else {
          parts.push(`世界模型: ${JSON.stringify(snapshot)}`)
        }
        log('[工具] mud_state → 快照')
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
