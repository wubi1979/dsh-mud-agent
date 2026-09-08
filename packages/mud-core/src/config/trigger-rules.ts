/**
 * dsh-mud-core — 触发规则表 (Trigger rules) 默认配置。v6.1 单文件双通道。
 *
 * 本文件是两条「确定性匹配通道」共用的规则清单，按 `lane` 属性分流：
 *
 *   lane: 'state' (预匹配折叠) — 状态/观察类文本（气血、个人档案、房间描述等）。
 *     文本到达预处理层时预匹配：命中行 **折叠**（不再进 agent），extract 产物
 *     applyPatch 直接落入 world（结构化数据交给 LLM，而非原始状态文本）。
 *     规则·action 承担「折叠占位描述」角色（索引行文案），tool.args 可省略。
 *     折叠 = 信息从 agent 视野消失 → 规则必须精确提取，漏识别即丢失。
 *
 *   lane: 'event' (级联 T1 渲染) — 事件/决策类文本（战斗/死亡/存档提示等）。
 *     进 agent，由 mud-cascade 级联 provider 的 T1 适配层（TriggerLlmAdapter）
 *     在 agent loop 内匹配，命中渲染 action（output 文本 + tool-call 执行）。
 *
 * 装配路径（index.ts）：全部规则注册进 TriggerService（纯匹配器）；
 * 「谁消费命中」由通道决定：
 *   - state → 预处理层 foldState 折叠入库（不进 agent）；
 *   - event → agent 内 T1（matchLines 只消费 event 规则）。
 * 无感知事件总线、无独立触发路由 —— 匹配与动作全程在「预处理层 / 模拟 LLM 内部」。
 *
 * 想加/改规则，直接编辑本文件即可。
 *
 * 规则字段：
 *   lane      通道 ('state' 预匹配折叠 / 'event' 级联 T1 渲染, 缺省 'event')
 *   id        规则唯一标识（trace/留痕引用）
 *   eventType 语义事件类型 (p:xxx; 仅留痕标识, 不再走事件总线)
 *   priority  优先级，数字大者先匹配（默认 10）
 *   contains  字面量数组：子串搜索（text.includes），命中任一即触发
 *   regex     正则数组：正则测试（re.test），命中任一即触发（与 contains 或关系）
 *   multiline true 时对窗口连接文本整体匹配（跨行）；否则逐行匹配
 *   guard     (record) => boolean 可选的守门函数，返回 false 则跳过该规则
 *   extract   (record) => object 可选的命中数据提取（state 通道: 提取产物直接落库）
 *   action    命中的确定性动作（v6.1: 每条规则必有 action; 无 action 视同未命中）。
 *             - output: 渲染文本（state = 折叠占位索引文案; event = 渲染给 agent 的文本）
 *             - tool:   可选工具调用 (name + args), 由 loop 官方工具管道执行
 *             - send:   可选直连命令（绕过 agent loop, 装配方暂不消费）
 * @module @deepseek-ai/dsh-mud-core/config/trigger-rules
 */

import type { PerceptionRule } from '../trigger-llm/types.ts'

/** 触发规则表（state 预匹配折叠 + event 级联 T1 双通道, 缺省 event）。 */
const defaultPerceptionRules: readonly PerceptionRule[] = [
  // ══ state: 预匹配折叠 (状态/观察 → world) ═══════════════════════════
  //   health/score/look 三类的原则: extract 提取结构化字段 → 预处理层
  //   applyPatch 落库 (点分键 char.* / room.*); action.output 为占位索引文案。
  {
    id: 'state:hp',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/【\s*气血|气血[:：]/],
    extract: (record) => parseVitals(record.rows.map(r => r.text)),
    action: { output: '状态已入库(hp)' },
  },
  {
    id: 'state:score',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/经\s*验[:：]/, /潜\s*能[:：]/],
    extract: (record) => parseScore(record.rows.map(r => r.text)),
    action: { output: '状态已入库(score)' },
  },
  {
    id: 'state:look',
    lane: 'state',
    eventType: 'p:look',
    priority: 30,
    contains: ['这里明显的出口是', '这里明显的方向有'],
    extract: (record) => {
      const lines = record.rows.map(r => r.text)
      return {
        'room.name': lines[0] || null,
        'room.exits': lines.find(l => /出口|方向/.test(l)) ?? null,
        'room.desc': lines.slice(0, 6).join('\n') || null,
      }
    },
    action: { output: '状态已入库(look)' },
  },

  // ══ event: 级联 T1 渲染 (事件/决策 → agent) ═════════════════════════
  //   命中 → agent 内 TriggerLlmAdapter 渲染 output + tool-call, 由工具管道执行。
  {
    id: 'combat:start',
    eventType: 'p:combat:start',
    priority: 20,
    contains: ['杀气', '向你扑来', '大喝道', '大喝一声', '喝道', '扑了上来'],
    extract: (record) => {
      const line = record.rows
        .map(r => r.text)
        .find(t => /杀气|扑来|大喝|喝道/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
    action: {
      output: '战斗开始',
      tool: { name: 'world_patch', args: { patch: { in_combat: true } } },
    },
  },
  {
    id: 'combat:end',
    eventType: 'p:combat:end',
    priority: 20,
    contains: ['战斗结束', '打斗结束', '你战胜了', '你打败了'],
    extract: (record) => {
      const line = record.rows
        .map(r => r.text)
        .find(t => /战斗结束|打斗结束|战胜了|打败了/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
    action: {
      output: '战斗结束',
      tool: { name: 'world_patch', args: { patch: { in_combat: false } } },
    },
  },
  {
    id: 'room:busy',
    eventType: 'p:room:busy',
    priority: 15,
    contains: ['这里的人很多', '热闹非凡', '人来人往', '熙熙攘攘'],
    extract: record => ({
      lines: record.rows.slice(0, 6).map(r => r.text),
    }),
    // 观测类: 命中即记录繁忙状态 (world_patch 落库)。注意: busy 无配套复位触发,
    // 置 true 后粘滞, 由 agent 后续 look / GMCP 房间覆盖。
    action: {
      output: '房间繁忙',
      tool: { name: 'world_patch', args: { patch: { 'room.busy': true } } },
    },
  },
  {
    id: 'death',
    eventType: 'p:death',
    priority: 30,
    contains: ['你死了'],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /你死了/.test(t))
      return { line: line ? line.slice(0, 80) : null }
    },
    action: {
      output: '你死了',
      tool: { name: 'world_patch', args: { patch: { dead: true, in_combat: false } } },
    },
  },
  // ── save 档案保存提醒 (常驻): 文本到 → 触发器反射 save ──
  {
    id: 'save:prompt',
    eventType: 'p:save:prompt',
    priority: 30,
    contains: ['建议经常使用save命令保存档案，避免造成意外损失。'],
    extract: (record) => {
      const line = record.rows.map(r => r.text).find(t => /save命令/.test(t))
      return { line: line ? line.slice(0, 120) : null }
    },
    action: {
      output: '正在保存...',
      tool: { name: 'mud_send', args: { cmd: 'save' } },
    },
  },
]

/** hp 输出块数值提取: 行内 "【 气血 】 333 / 666" 形态 → char.* 点分键。 */
function parseVitals(lines: readonly string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const line of lines) {
    const m = /(气血|精神|内力|精力|真气)[^-\d]*([-\d,]+\.?\d*)\s*\/\s*([-\d,]+\.?\d*)/.exec(line)
    if (m === null) continue
    const [num, max] = [parseNum(m[2]), parseNum(m[3])]
    if (num === null || max === null) continue
    switch (m[1]) {
      case '气血': out['char.hp'] = num; out['char.maxhp'] = max; break
      case '精神': out['char.jing'] = num; out['char.maxjing'] = max; break
      case '内力': out['char.mp'] = num; out['char.maxmp'] = max; break
      case '精力': out['char.jingli'] = num; out['char.maxjingli'] = max; break
      case '真气': out['char.zhenqi'] = num; out['char.maxzhenqi'] = max; break
      default: break
    }
  }
  for (const line of lines) {
    const m = /(食物|饮水)[^-\d]*([-\d,]+\.?\d*)/.exec(line)
    if (m !== null) {
      const v = parseNum(m[2])
      if (v !== null) out[`char.${m[1]}`] = v
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** score 输出提取: 经验/潜能等标量 → char.* 点分键。 */
function parseScore(lines: readonly string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  const scalars: Record<string, string> = {
    '经验：': 'exp', '潜能：': 'potential', '等级：': 'level',
    '存款：': 'deposit', '声望：': 'prestige', '道德：': 'morality',
  }
  for (const line of lines) {
    for (const [label, key] of Object.entries(scalars)) {
      if (!line.includes(label)) continue
      const m = /[:：]\s*([-\d,]+\.?\d*)\s*$/.exec(line.replace(/[()（].*$/, ''))
      if (m === null) continue
      const v = parseNum(m[1])
      if (v !== null && !(key in out)) out[`char.${key}`] = v
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 数字解析: 16242 → 16242; "12,000" → 12000; 无效返回 null。 */
function parseNum(raw: string): number | null {
  const n = Number(String(raw).replace(/[,，]/g, ''))
  return Number.isFinite(n) ? n : null
}

export default defaultPerceptionRules