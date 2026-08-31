/**
 * dsh-mud-core — 工具集 (Tools), host half.
 *
 * 工具 = 校验点 + 执行路径。规则 (轻量处理器) 与 DSH agent (重型处理器)
 * 共用同一工具集; 非法参数在工具层拒绝, 不发到游戏才报"什么？"。
 *
 * 收敛策略: 不做 70+ 个命令工具 (撑爆上下文), 而是按意图/技能分组为
 * 语义化工具 (mud_move / mud_look / mud_status / mud_send 兜底)。
 *
 * 所有工具返回 { ok, note, cmd }:
 *   ok   是否成功入队
 *   note 结果说明 (工具层校验失败时的拒绝原因)
 *   cmd  实际发出的命令 (空 = 未发出)
 * @module @deepseek-ai/dsh-mud-core/tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** 工具统一返回。 */
export interface MudToolResult {
  ok: boolean
  note: string
  cmd: string
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

/** 一条 MUD 工具 (defineTool 兼容定义; 规则直接调用 execute)。 */
export interface MudTool {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: {
    schema: MudOutputSchema
    render: (args: unknown, value: MudToolResult) => ContentBlock[]
  }
  execute: (args: Record<string, unknown>) => MudToolResult
}

/** 工具集。 */
export type MudTools = Record<string, MudTool>

/**
 * 构建工具集。
 * @param opts.send (cmd) => void 命令入队 (宿主接 CommandQueue)。
 * @param opts.log  (text) => void 活动日志 (WebUI 决策通道)。
 */
export function buildMudTools({ send = () => {}, log = () => {} }: {
  send?: (cmd: string) => void
  log?: (text: string) => void
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
        send(dir)
        log(`[工具] mud_move → ${dir}`)
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
        send(cmd)
        log(`[工具] mud_look → ${cmd}`)
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
        send(cmd)
        log(`[工具] mud_status → ${cmd}`)
        return { ok: true, note: cmd, cmd }
      },
    },

    /** 兜底: 发送任意原始命令 (无专用工具时用; 规则确定性动作也走这里)。 */
    mud_send: {
      name: 'mud_send',
      description: '向 MUD 游戏发送一条原始命令。优先使用 mud_move / mud_look / mud_status 等专用工具; 仅在无专用工具时 (如 ask/使用特殊物品) 使用本工具。',
      parameters: {
        cmd: {
          type: 'string',
          required: true,
          description: '游戏命令, 如 ask <npc> about <话题> / eat baozi',
        },
      },
      output: { schema: OUT_SCHEMA, render: OUT_RENDER },
      execute: (args) => {
        const cmd = String(args.cmd ?? '').trim()
        if (!cmd) return { ok: false, note: '空命令', cmd: '' }
        send(cmd)
        log(`[工具] mud_send → ${cmd}`)
        return { ok: true, note: cmd, cmd }
      },
    },
  }
}
