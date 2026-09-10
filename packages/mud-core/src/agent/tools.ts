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
 * @module @deepseek-ai/dsh-mud-core/tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { FORBIDDEN_COMMANDS } from '../config/commands.ts'
import type { MudReply, ReplyOptions } from '../network/response.ts'
import { applyPatch, type WorldModel } from '../world/world.ts'

/** 工具统一返回。 */
export interface MudToolResult {
  ok: boolean
  note: string
  cmd: string
}

// ── 会话登录凭据 (明文最小暴露面) ──────────────
// 凭据只存在内存 (connect 时写入); 引用一律以 {name}/{pass} 占位符流转
// (转录/日志/工具结果均只见占位符), 明文仅在 mud_send 发送瞬间插值。
export interface SessionCredentials {
  name: string
  pass: string
}

/** sessionId → 登录凭据 (连接时由装配方写入; 切换用户互不泄漏)。 */
const sessionCredentials = new Map<string, SessionCredentials>()

/** 写入某会话的登录凭据 (connect({name, pass}) 时调用)。 */
export function setSessionCredentials(sessionId: string, creds: SessionCredentials): void {
  if (sessionId === '' || creds === null || typeof creds !== 'object') return
  sessionCredentials.set(sessionId, { name: creds.name ?? '', pass: creds.pass ?? '' })
}

/** 读取某会话的登录凭据 (无凭据返回 undefined)。 */
export function getSessionCredentials(sessionId: string | undefined): SessionCredentials | undefined {
  return sessionId ? sessionCredentials.get(sessionId) : undefined
}

/** 凭据占位符插值: 字符串值中的 {name}/{pass} → 会话实际值 (逐值替换)。 */
export function interpolateCredentials(
  text: string,
  creds: SessionCredentials | undefined,
): string {
  if (!creds) return text
  return text.replace(/\{name\}/g, creds.name).replace(/\{pass\}/g, creds.pass)
}

/** 合法移动方向 (pkuxkx)。 */
export const MOVE_DIRS: readonly string[] = [
  'north', 'south', 'east', 'west', 'up', 'down',
  'northeast', 'northwest', 'southeast', 'southwest',
  'northup', 'northdown', 'southup', 'southdown',
  'eastup', 'eastdown', 'westup', 'westdown',
  'enter', 'out',
]

/** 短别名 → 全名。 */
export const MOVE_ALIASES: Record<string, string> = {
  n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  nu: 'northup', nd: 'northdown', su: 'southup', sd: 'southdown',
  eu: 'eastup', ed: 'eastdown', wu: 'westup', wd: 'westdown',
}

/** 状态查询: what → 实际命令。 */
export const STATUS_CMDS: Record<string, string> = {
  hp: 'hp',          // 气血/内力
  score: 'score',    // 经验/潜能/门派
  inventory: 'i',    // 物品/装备
  skills: 'skills',  // 武功
  busy: 'busy',      // 忙碌状态
}

/** 输出 schema (所有工具一致)。 */
export const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    note: { type: 'string', required: true },
    cmd: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** OUT_SCHEMA 的精确类型 (defineTool 推理用)。 */
export type MudOutputSchema = typeof OUT_SCHEMA

const OUT_RENDER = (_args: unknown, value: MudToolResult): ContentBlock[] => [{
  type: 'text',
  text: value.ok ? value.note : `工具拒绝: ${value.note}`,
}]

/** 命中任一安全禁用命令前缀 (硬边界, 原始命令层拦截)。 */
function isForbidden(cmd: string): boolean {
  const head = String(cmd).trim().toLowerCase().split(/[\s;]+/)[0] ?? ''
  return FORBIDDEN_COMMANDS.includes(head)
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
  /** 同步或异步 (装配 sendAndAwait 走命令-应答桥时为异步)。 */
  execute: (args: Record<string, unknown>) => MudToolResult | Promise<MudToolResult>
}

/** 工具集。 */
export type MudTools = Record<string, MudTool>

/**
 * 构建工具集。
 * @param opts.send (cmd) => void 命令入队 (宿主接 CommandQueue; 未装配
 *   sendAndAwait 时的兜底路径)。
 * @param opts.sendAndAwait (cmd, opts) => Promise<MudReply> 命令-应答桥
 *   (REFACTOR-V7 机制 A): 挂起等待真实应答, note = 应答文本。
 * @param opts.log  (text) => void 活动日志 (WebUI 决策通道)。
 * @param opts.recall (n) => string[] 回看最近 n 行游戏输出 (mud_recall)。
 * @param opts.flowControl 触发器组开关/状态 (mud_flow_*; M4 落地前缺省不可用)。
 */
export function buildMudTools({
  send = () => {},
  sendAndAwait,
  log = () => {},
  recall = () => [],
  flowControl,
  world,
  resolveCredentials,
}: {
  send?: (cmd: string) => void
  sendAndAwait?: (cmd: string | string[], opts?: ReplyOptions) => Promise<MudReply>
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
} = {}): MudTools {
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
      execute: (args) => {
        const raw = String(args.direction ?? '').trim().toLowerCase()
        const dir = MOVE_ALIASES[raw] ?? (MOVE_DIRS.includes(raw) ? raw : null)
        if (!dir) return { ok: false, note: `非法方向: ${raw}`, cmd: '' }
        log(`[工具] mud_move → ${dir}`)
        if (sendAndAwait) {
          return sendAndAwait(dir).then(reply => ({ ok: reply.ok, note: reply.text, cmd: dir }))
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
      execute: (args) => {
        const target = String(args.target ?? '').trim()
        if (target && /[;\x00-\x1f]/.test(target)) {
          return { ok: false, note: `非法目标: ${target} (不能含分号/控制字符)`, cmd: '' }
        }
        const cmd = target ? `look ${target}` : 'look'
        log(`[工具] mud_look → ${cmd}`)
        if (sendAndAwait) {
          return sendAndAwait(cmd).then(reply => ({ ok: reply.ok, note: reply.text, cmd }))
        }
        send(cmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 状态: what 枚举 → 对应命令, 非法拒绝。 */
    mud_status: {
      name: 'mud_status',
      description: '查询角色状态。what 决定具体状态命令: hp (气血/内力), score (经验/潜能), inventory (物品/装备), skills (武功), busy (忙碌)。',
      parameters: {
        what: {
          type: 'string',
          required: true,
          description: 'hp | score | inventory | skills | busy',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args) => {
        const what = String(args.what ?? '').trim().toLowerCase()
        const cmd = STATUS_CMDS[what]
        if (!cmd) {
          return { ok: false, note: `未知状态: ${what} (可选 hp/score/inventory/skills/busy)`, cmd: '' }
        }
        log(`[工具] mud_status → ${cmd}`)
        if (sendAndAwait) {
          return sendAndAwait(cmd).then(reply => ({ ok: reply.ok, note: reply.text, cmd }))
        }
        send(cmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 兜底: 发送任意原始命令 (无专用工具时用; 规则确定性动作也走这里)。
     *  `cmds` 数组 = 命令序列 (允许含空命令, 如"空行退 MXP 检测 + look");
     *  单体 `cmd` 依旧拒绝空命令。
     *  凭据: {name}/{pass} 占位符仅在 send 瞬间插值 — log/返回值/转录
     *  (tool-call args + tool-result) 全程只见占位符, 明文不落任何通道。 */
    mud_send: {
      name: 'mud_send',
      description: '向 MUD 游戏发送一条原始命令 (或一组命令序列)。优先使用 mud_move / mud_look / mud_status 等专用工具; 仅在无专用工具时 (如 ask/使用特殊物品) 使用本工具。',
      parameters: {
        cmd: {
          type: 'string',
          description: '游戏命令, 如 ask <npc> about <话题> / eat baozi (单体命令, 空命令拒绝)',
        },
        cmds: {
          type: 'array',
          items: { type: 'string' },
          description: '命令序列, 依次发出 (允许含空命令, 用于退出检测模式)。与 cmd 二选一',
        },
        until: {
          type: 'object',
          additionalProperties: true,
          description: '可选: 声明应答结算边界 (规则动作使用)。当声明的正则命中应答文本时结算 (跨帧累积; 慢命令如 dz/fullme), 缺省 GA/EOR 主边界 + 静默兜底',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args) => {
        const wire = (c: string): string => interpolateCredentials(c, resolveCredentials?.())
        // 声明边界 (规则动作可传): args.until = { regex, timeout? }。
        const untilRaw = args.until as { regex?: unknown; timeout?: unknown } | undefined
        const replyOpts: ReplyOptions | undefined =
          untilRaw && typeof untilRaw.regex === 'string'
            ? (typeof untilRaw.timeout === 'number'
              ? { until: { regex: untilRaw.regex, timeout: untilRaw.timeout } }
              : { until: { regex: untilRaw.regex } })
            : undefined
        // 命令序列: 允许空命令成员; 整体至少有一条合法命令才成功。
        const series = Array.isArray(args.cmds) ? args.cmds.map((c) => String(c)) : null
        if (series && series.length > 0) {
          for (const c of series) {
            if (isForbidden(c)) {
              return { ok: false, note: `安全禁用命令, 拒绝发送: ${String(c).trim()}`, cmd: '' }
            }
          }
          const wired = series.map(wire)
          log(`[工具] mud_send 序列 → ${series.length} 条命令`)
          if (sendAndAwait) {
            return sendAndAwait(wired, replyOpts).then(reply => ({ ok: reply.ok, note: reply.text, cmd: '' }))
          }
          for (const c of wired) send(c)
          return { ok: true, note: '命令序列', cmd: '' }
        }
        // 单体命令: 空命令拒绝 (与既有行为一致)。
        const cmd = String(args.cmd ?? '').trim()
        if (!cmd) return { ok: false, note: '空命令', cmd: '' }
        if (isForbidden(cmd)) {
          return { ok: false, note: `安全禁用命令, 拒绝发送: ${cmd}`, cmd: '' }
        }
        const wiredCmd = wire(cmd)
        log(`[工具] mud_send → ${cmd}`)
        if (sendAndAwait) {
          return sendAndAwait(wiredCmd, replyOpts).then(reply => ({ ok: reply.ok, note: reply.text, cmd }))
        }
        send(wiredCmd)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 回看: 最近 n 行游戏输出 (终端缓冲; 不走游戏)。 */
    mud_recall: {
      name: 'mud_recall',
      description: '回看最近 count 行游戏输出 (含命令回显; 从缓冲读取, 不发送任何命令)。',
      parameters: {
        count: {
          type: 'integer',
          description: '要回看的行数 (1-200, 缺省 20)',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args) => {
        const raw = Number(args.count ?? 20)
        const count = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20
        const lines = recall(count)
        log(`[工具] mud_recall → 最近 ${lines.length} 行`)
        // 空结果显式反馈 (静默空串会让 agent 误判工具异常/反复重试)。
        if (lines.length === 0) {
          return { ok: true, note: '（缓冲暂无游戏输出 — 本会话尚未收到任何游戏行, 或刚重连清空）', cmd: '' }
        }
        return { ok: true, note: lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'), cmd: '' }
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
      execute: (args) => {
        if (!world) return { ok: false, note: 'world_patch 未装配 (缺少 WorldModel)', cmd: '' }
        const patch = args.patch as Record<string, unknown> | undefined
        if (!patch || typeof patch !== 'object') return { ok: false, note: 'patch 参数必须为对象', cmd: '' }
        const changes = applyPatch(world, patch)
        if (changes.length === 0) return { ok: true, note: '无变化 (值相同或置信度不足)', cmd: '' }
        log(`[工具] world_patch → ${changes.join(', ')}`)
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
      execute: (args) => {
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
      execute: (args) => {
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
      execute: (args) => {
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
