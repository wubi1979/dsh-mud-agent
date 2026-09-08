/**
 * dsh-mud-core — 触发规则表 (Trigger rules) 默认配置。v6.5 单文件双通道。
 *
 * 准入语义 (v6.5): 匹配判据唯一收敛于 `regex` —— **锚定整行正则** (作者书写首尾
 * `^…$`)。MUD 文本随处是聊天/帮助内容, 宽松子串匹配极易误触发; 首尾锚定把命中
 * 限制为"整行恰好是指定提示/事件", 聊天帮助文本天然不匹配。变体空格/尾部差异由
 * 规则作者改正则 (引擎不替文本做归一)。预筛 seed 由正则字面前缀**自动推导**, 只
 * 缩候选 (超集), 不参与命中判定。
 *
 * 提取语义 (v6.5): 默认走**命名捕获组** → `map` (捕获组名 → world 点分键) 组装
 * `hit.data`, `numeric` 数值化。`extract` 函数仅作逃生舱 (二次颜色等必须跑代码的
 * 复杂提取; 常规规则禁用)。event 规则无提取需求 → 不声明 map, payload 即 action。
 *
 * 按 `lane` 属性分流:
 *   lane: 'state' (预匹配折叠) — 状态/观察类文本。文本到达预处理层时预匹配:
 *     命中行 **折叠** (不再进 agent), 捕获组/map 产物 applyPatch 落 world。
 *   lane: 'event' (级联 T1 渲染) — 事件/决策类文本。进 agent, 由 mud-cascade
 *     级联 provider 的 T1 适配层在 agent loop 内匹配, 命中渲染 action
 *     (output 文本 + tool-call 执行)。
 *
 * 想加/改规则，直接编辑本文件即可。找不到完整整行文本的规则, 正则留近似形
 * (宁缺勿松: 不准用无锚定宽松正则), 由规则作者后续依真实文本修正。
 *
 * 规则字段:
 *   id        规则唯一标识
 *   eventType 语义事件类型 (p:xxx; 仅留痕标识)
 *   priority  优先级，数字大者先匹配（默认 10）
 *   regex     锚定整行正则数组 (准入唯一判据, 命中任一即触发)
 *   map       捕获组名 → world 点分键 (组装 hit.data)
 *   numeric   需数值化的捕获组名 (去千分位逗号 → Number)
 *   multiline 多行有序条件状态机 (每条件逐行测; 条件 = regex 或 patterns)
 *   guard     (record) => boolean 可选的守门函数，返回 false 则跳过该规则
 *   extract   逃生舱提取 (仅二次颜色等复杂提取; 存在时覆盖捕获组组装结果)
 *   action    命中的确定性动作。
 *             - output: 渲染文本 (state = 折叠占位索引文案; event = 渲染给 agent 的文本)
 *             - tool:   可选工具调用 (name + args), 由 loop 官方工具管道执行
 * @module @deepseek-ai/dsh-mud-core/config/trigger-rules
 */

import type { PerceptionRule } from '../trigger-llm/types.ts'

/** 触发规则表 (state 预匹配折叠 + event 级联 T1 双通道, 缺省 event)。 */
const defaultPerceptionRules: readonly PerceptionRule[] = [
  // ══ state: 预匹配折叠 (状态/观察 → world) ═══════════════════════════
  //   捕获组 + map 组装 char.* 点分键; 锚定整行正则 (近似文本, 依真实输出修正)。
  {
    id: 'state:hp',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^【\s*气血\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
    map: { cur: 'char.hp', max: 'char.maxhp' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(hp)' },
  },
  {
    id: 'state:jing',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^【\s*精神\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
    map: { cur: 'char.jing', max: 'char.maxjing' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(jing)' },
  },
  {
    id: 'state:mp',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^【\s*内力\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
    map: { cur: 'char.mp', max: 'char.maxmp' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(mp)' },
  },
  {
    id: 'state:jingli',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^【\s*精力\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
    map: { cur: 'char.jingli', max: 'char.maxjingli' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(jingli)' },
  },
  {
    id: 'state:zhenqi',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^【\s*真气\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/],
    map: { cur: 'char.zhenqi', max: 'char.maxzhenqi' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(zhenqi)' },
  },
  {
    id: 'state:food',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^食物[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.食物' },
    numeric: ['v'],
    action: { output: '状态已入库(food)' },
  },
  {
    id: 'state:drink',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    regex: [/^饮水[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.饮水' },
    numeric: ['v'],
    action: { output: '状态已入库(drink)' },
  },
  // ── score 各字段独立规则 (锚定整行, 近似文本待修正) ──
  {
    id: 'state:exp',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^经验[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.exp' },
    numeric: ['v'],
    action: { output: '状态已入库(exp)' },
  },
  {
    id: 'state:potential',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^潜能[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.potential' },
    numeric: ['v'],
    action: { output: '状态已入库(potential)' },
  },
  {
    id: 'state:level',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^等级[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.level' },
    numeric: ['v'],
    action: { output: '状态已入库(level)' },
  },
  {
    id: 'state:deposit',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^存款[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.deposit' },
    numeric: ['v'],
    action: { output: '状态已入库(deposit)' },
  },
  {
    id: 'state:prestige',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^声望[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.prestige' },
    numeric: ['v'],
    action: { output: '状态已入库(prestige)' },
  },
  {
    id: 'state:morality',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    regex: [/^道德[：:]\s*(?<v>[\d,，]+)\s*$/],
    map: { v: 'char.morality' },
    numeric: ['v'],
    action: { output: '状态已入库(morality)' },
  },
  {
    id: 'state:look',
    lane: 'state',
    eventType: 'p:look',
    priority: 30,
    regex: [/^这里明显的出口(?:是|有)[^]*$/],
    // 逃生舱: 房间名/描述/出口为多行复合提取 (捕获组表达不了), 保留函数式提取。
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
  //   锚定整行正则 (近似文本, 依真实提示修正); 无 map (纯 action), extract 禁用。
  //   ── login 登录 (确定性 T1): 凭据 {name}/{pass} 由会话注入 (resolveToolArgs
  //   插值, 与会话绑定)。救不回 → 硬失败交棒尾部真实 LLM, DSH 自行兜底。
  {
    id: 'login:name',
    eventType: 'p:login:name',
    priority: 30,
    regex: [/^您的英文名字（要注册新人物请输入new。）：$/],
    action: {
      output: '登录: 发送名字',
      tool: { name: 'mud_send', args: { cmd: '{name}' } },
    },
  },
  {
    id: 'login:replace-confirm',
    eventType: 'p:login:replace',
    priority: 30,
    multiline: true,
    regex: [/^(?:同名|覆盖|替换)[^]*\([yY]\/n\)[^]*$/],
    action: {
      output: '登录: 确认覆盖同名档案',
      tool: { name: 'mud_send', args: { cmd: 'y' } },
    },
  },
  {
    id: 'login:pass',
    eventType: 'p:login:pass',
    priority: 30,
    regex: [/^请输入密码[：:]\s*$/],
    action: {
      output: '登录: 发送密码',
      tool: { name: 'mud_send', args: { cmd: '{pass}' } },
    },
  },
  {
    id: 'login:done',
    eventType: 'p:login:done',
    priority: 30,
    regex: [/^欢迎来到北大侠客行[^]*$/, /^重新连线完毕[^]*$/],
    action: {
      output: '登录完成',
      tool: { name: 'world_patch', args: { patch: { logged_in: true } } },
    },
  },
  // ── combat 战斗 (近似锚定, 依真实输出修正) ──
  {
    id: 'combat:start',
    eventType: 'p:combat:start',
    priority: 20,
    regex: [
      /^[^]*杀气[^]*$/, /^[^]*向你扑来[^]*$/, /^[^]*大喝道[^]*$/,
      /^[^]*大喝一声[^]*$/, /^[^]*喝道[^]*$/, /^[^]*扑了上来[^]*$/,
    ],
    action: {
      output: '战斗开始',
      tool: { name: 'world_patch', args: { patch: { in_combat: true } } },
    },
  },
  {
    id: 'combat:end',
    eventType: 'p:combat:end',
    priority: 20,
    regex: [
      /^[^]*战斗结束[^]*$/, /^[^]*打斗结束[^]*$/, /^[^]*你战胜了[^]*$/,
      /^[^]*你打败了[^]*$/,
    ],
    action: {
      output: '战斗结束',
      tool: { name: 'world_patch', args: { patch: { in_combat: false } } },
    },
  },
  {
    id: 'room:busy',
    eventType: 'p:room:busy',
    priority: 15,
    regex: [
      /^[^]*这里的人很多[^]*$/, /^[^]*热闹非凡[^]*$/, /^[^]*人来人往[^]*$/,
      /^[^]*熙熙攘攘[^]*$/,
    ],
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
    regex: [/^[^]*你死了[^]*$/],
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
    regex: [/^建议经常使用save命令保存档案，避免造成意外损失。\s*$/],
    action: {
      output: '正在保存...',
      tool: { name: 'mud_send', args: { cmd: 'save' } },
    },
  },
]

export default defaultPerceptionRules