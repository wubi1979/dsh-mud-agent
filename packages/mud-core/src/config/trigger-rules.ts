/**
 * dsh-mud-core — 触发规则表 (Trigger rules) 默认配置。v6.6 三种匹配类型。
 *
 * 准入语义 (v6.6): 判据 = `match` 联合 (分派到对应匹配器):
 *   - kind: 'regex'  锚定整行正则 (作者书写首尾 `^…$`)。MUD 文本随处是聊天/帮助
 *     内容, 宽松子串匹配极易误触发; 首尾锚定把命中限制为"整行恰好是指定提示/事件",
 *     聊天帮助文本天然不匹配。变体空格/尾部差异由规则作者改正则 (引擎不替文本做归一)。
 *   - kind: 'text'   字面子串 (includes 任一命中, 本身即预筛)。仅用于高特异性短语,
 *     聊天嵌词误触发风险由规则作者保证。
 *   - kind: 'func'   函数谓词 (每行调用)。承载正则表达不了的结构判定。
 *
 * 提取语义 (v6.5): 默认走**命名捕获组** → `map` (捕获组名 → world 点分键) 组装
 * `hit.data`, `numeric` 数值化。`extract` 函数用于复合/跨行提取 (房间抓取等必须
 * 跑代码的提取), 存在时覆盖捕获组组装结果。event 规则无提取需求 → 不声明 map。
 *
 * 窗口语义 (v6.6): 单行规则可声明 `window: { before, after }` — 命中时装配锚点行
 * 前后的**批内**上下文 (跨批不追, 丢弃) 供 extract 复合提取。
 *
 * 折叠语义 (v6.6, hit.foldLines): 单行 regex/text = 仅折叠锚点行 (窗口行照常进
 * agent, 两份信息并存); 单行 func = 不折叠 (房间抓取类, 全部行进 agent);
 * multiline = 折叠全部被捕获的条件行。
 *
 * 按 `lane` 属性分流:
 *   lane: 'state' (预匹配折叠) — 状态/观察类文本。文本到达预处理层时预匹配:
 *     命中行 **折叠** (不再进 agent), 捕获组/map/extract 产物 applyPatch 落 world。
 *   lane: 'event' (T1 渲染, 缺省) — 事件/决策类文本。进 agent, 由 mud-t1 本地
 *     模拟适配器在 agent loop 内匹配, 命中渲染 action (output 文本 + tool-call 执行)。
 *
 * 想加/改规则，直接编辑本文件即可。找不到完整整行文本的规则, 正则留近似形
 * (宁缺勿松: 不准用无锚定宽松正则), 由规则作者后续依真实文本修正。
 *
 * 规则字段:
 *   id        规则唯一标识
 *   eventType 语义事件类型 (p:xxx; 仅留痕标识)
 *   priority  优先级，数字大者先匹配（默认 10）
 *   match     准入判据 (regex / text / func 三种匹配类型之一, 必填)
 *   map       捕获组名 → world 点分键 (组装 hit.data)
 *   numeric   需数值化的捕获组名 (去千分位逗号 → Number)
 *   multiline 多行有序条件状态机 (仅 kind: 'regex'; 每条件逐行测)
 *   window    命中窗口声明 (仅单行规则; extract 的复合提取输入)
 *   guard     (record) => boolean 可选的守门函数，返回 false 则跳过该规则
 *   extract   准入后的程序化提取 (复合/跨行; 存在时覆盖捕获组结果; 不参与准入)
 *   action    命中的确定性动作。
 *             - output: 渲染文本 (event = 渲染给 agent 的文本)
 *             - tool:   可选工具调用 (name + args), 由 loop 官方工具管道执行
 *             state 规则的 action 为预留的联动接口 (当前 state 桶无消费方,
 *             仅占位; 折叠入库走 hit.data → applyPatch)。
 * @module @deepseek-ai/dsh-mud-core/config/trigger-rules
 */

import type { PerceptionRule } from '../trigger-llm/types.ts'


/** 地图行判定: 行首缩进 + 框线字符 ≥2 个 (pkuxkx ASCII 房间图: ┌─┐│└┘ 框线,
 *  或 +---+ / | | 半角框线)。≥2 是为避免描述行含单个 `+`/`-`/`|` (连字符/破折号)
 *  被误判为地图行而腰斩描述块。 */
function isMapLine(t: string): boolean {
  if (t.length === 0 || !/^\s/.test(t)) return false
  return (t.match(/[─═│║┌┐└┘├┤┬┴┼╔╗╚╝|+\-]/g) ?? []).length >= 2
}

/** NPC 行判定: `中文(拼音)` 结构 — 中文主体 (可含空格) + 括号内纯小写字母/空格。 */
function isNpcLine(t: string): boolean {
  return /^[\u4e00-\u9fa5][\u4e00-\u9fa5\s]*\(\s*[a-z][a-z\s]*\)\s*$/.test(t)
}

/** 上次自动翻页的时间戳 (pager:continue 节流用, 模块级闭包, 跨规则共享)。 */
let lastPageFlipAt = 0

/** 触发规则表 (state 预匹配折叠 + event T1 渲染双通道, 缺省 event)。 */
const defaultPerceptionRules: readonly PerceptionRule[] = [
  // ══ state: 预匹配折叠 (状态/观察 → world) ═══════════════════════════
  //   捕获组 + map 组装 char.* 点分键; 锚定整行正则 (近似文本, 依真实输出修正)。
  {
    id: 'state:hp',
    lane: 'state',
    eventType: 'p:hp',
    priority: 30,
    match: { kind: 'regex', patterns: [/^【\s*气血\s*】\s*(?<cur>[\d,，]+)\s*\/\s*(?<max>[\d,，]+)\s*$/] },
    map: { cur: 'char.hp', max: 'char.maxhp' },
    numeric: ['cur', 'max'],
    action: { output: '状态已入库(hp)' },
  },
  // ── score 各字段独立规则 (锚定整行, 近似文本待修正) ──
  {
    id: 'state:exp',
    lane: 'state',
    eventType: 'p:score',
    priority: 30,
    match: { kind: 'regex', patterns: [/^经验[：:]\s*(?<v>[\d,，]+)\s*$/] },
    map: { v: 'char.exp' },
    numeric: ['v'],
    action: { output: '状态已入库(exp)' },
  },
  
  {
    id: 'state:look',
    lane: 'state',
    eventType: 'p:look',
    priority: 30,
    // 房间抓取: func 谓词做出口行准入锚点 (无预筛全量跑), 窗口装配批内上下文:
    //   before 16 行 (ASCII 地图 + 房间名 + 描述), after 8 行 (NPC 列表)。
    // func 类型不折叠 — 出口行/窗口行全部进 agent (结构化提取与 agent 自理解并存)。
    match: { kind: 'func', test: l => /^这里明显的出口(?:是|有)/.test(l.text) },
    window: { before: 16, after: 8 },
    extract: (record) => {
      const anchor = record.rows[0]?.text ?? ''
      // ── exits (锚点行解析; 格式漂移不产错数据) ──
      const m = /^这里明显的出口(?:是|有)\s*(.+?)。?\s*$/.exec(anchor)
      const exits = m?.[1] !== undefined && m[1] !== ''
        ? m[1].split(/\s*(?:和|、|,|，)\s*/).map(s => s.trim()).filter(s => /[\u4e00-\u9fa5a-z0-9]/i.test(s))
        : null
      const validExits = exits !== null && exits.length > 0 ? exits : null
      // ── 向上扫描 (before 升序, 从尾往前): 地图块 → 房间名 → 描述块 ──
      let mapText: string | null = null
      let name: string | null = null
      let desc: string | null = null
      const before = record.before
      // 1) 跳过出口行前空行, 收集描述块 (连续非空行, 直到空行/批首/地图块)。
      let i = before.length - 1
      while (i >= 0 && (before[i] as import('../preprocess/ansi.ts').MudLine).text.trim() === '') i -= 1
      const descEnd = i
      while (i >= 0 && (before[i] as import('../preprocess/ansi.ts').MudLine).text.trim() !== ''
        && !isMapLine((before[i] as import('../preprocess/ansi.ts').MudLine).text)) i -= 1
      // i 停在描述块首行之前一位 (或描述块内混入的地图行)
      const descLines = before.slice(i + 1, descEnd + 1).map(r => (r as import('../preprocess/ansi.ts').MudLine).text.trimEnd())
      // 2) 地图块: 描述块上方连续地图行 (行首缩进+框线; 从描述块首向上收)。
      let j = i
      while (j >= 0 && isMapLine((before[j] as import('../preprocess/ansi.ts').MudLine).text)) j -= 1
      if (j < i) {
        const mapLines = before.slice(j + 1, i + 1).map(r => (r as import('../preprocess/ansi.ts').MudLine).text.replace(/\s+$/, ''))
        if (mapLines.length > 0) mapText = mapLines.join('\n')
      }
      // 3) 房间名/描述 (启发式, 宁缺勿错):
      //    有地图 → 地图块下方首个顶格非空行 = 房间名, 其余 = 描述。
      //    无地图 → 描述块首行 ≤10 字符且无句读时视为房间名 (短名启发式),
      //    否则整块为描述 (块首可能是描述中部 — 不猜房间名)。
      const trimmed = descLines.map(s => s.trim()).filter(s => s !== '')
      if (mapText !== null) {
        // 地图下方再找非空行 (地图块与房间名之间可能有空行, 已含在 j..i 区间外?):
        // 保守: descLines[0] = 房间名, 其余 = 描述。
        if (trimmed.length > 0) name = trimmed[0] as string
        if (trimmed.length > 1) desc = trimmed.slice(1).join('\n')
      } else if (trimmed.length > 0) {
        const head = trimmed[0] as string
        if (head.length <= 10 && !/[，。；：、！？]/.test(head)) {
          name = head
          if (trimmed.length > 1) desc = trimmed.slice(1).join('\n')
        } else {
          desc = trimmed.join('\n')
        }
      }
      // ── 向下扫描 (after 升序): `中文(拼音)` 结构连续收集; 出口行与 NPC 列表
      //    之间天然存在一行空行 → 空行跳过, 首个非空且非 NPC 结构的行结束。 ──
      const npcs: string[] = []
      for (const r of record.after) {
        const t = r.text.trim()
        if (t === '') continue
        if (!isNpcLine(t)) break
        npcs.push(t)
      }
      const out: Record<string, unknown> = {}
      if (validExits !== null) out['room.exits'] = validExits // 判空才写: 不覆盖已有值
      if (mapText !== null) out['room.map'] = mapText
      if (name !== null) out['room.name'] = name
      if (desc !== null) out['room.desc'] = desc
      if (npcs.length > 0) out['room.npcs'] = npcs
      return out
    },
    // action 为 state 预留的联动接口 (本规则当前无消费方, 仅占位声明)。
    action: { output: '状态已入库(look)' },
  },

  // ── combat 战斗 (近似锚定, 依真实输出修正) ──
  {
    id: 'combat:start',
    eventType: 'p:combat:start',
    priority: 20,
    match: {
      kind: 'regex',
      patterns: [
        /^[^]*杀气[^]*$/, /^[^]*向你扑来[^]*$/, /^[^]*大喝道[^]*$/,
        /^[^]*大喝一声[^]*$/, /^[^]*喝道[^]*$/, /^[^]*扑了上来[^]*$/,
      ],
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
    match: {
      kind: 'regex',
      patterns: [
        /^[^]*战斗结束[^]*$/, /^[^]*打斗结束[^]*$/, /^[^]*你战胜了[^]*$/,
        /^[^]*你打败了[^]*$/,
      ],
    },
    action: {
      output: '战斗结束',
      tool: { name: 'world_patch', args: { patch: { in_combat: false } } },
    },
  },
  {
    id: 'death',
    eventType: 'p:death',
    priority: 30,
    match: { kind: 'regex', patterns: [/^[^]*你死了[^]*$/] },
    action: {
      output: '你死了',
      tool: { name: 'world_patch', args: { patch: { dead: true, in_combat: false } } },
    },
  },
  // ── fullme 防机器人验证: **已流程化**（`config/flows.ts` 的 `FULLME_FLOW`, §11）──
  // 原 `fullme:request` / `fullme:prompt` / `fullme:done` 三条规则退役：
  // 入口提醒、验证码地址、成功句、答错句、上一轮未完成提示全部成为流程步的 driver/ok/fail
  // （驱动句/动作/判据只在流程表写一份；§16 删除清单）。
  // ── save 档案保存提醒 (常驻): 文本到 → **直接执行** save (不投给 agent) ──
  {
    id: 'save:prompt',
    eventType: 'p:save:prompt',
    priority: 30,
    match: { kind: 'regex', patterns: [/^建议经常使用save命令保存档案，避免造成意外损失。\s*$/] },
    action: {
      output: '正在保存...',
      tool: { name: 'mud_send', args: { cmd: 'save' } },
      // 无状态、无需返回: 提醒行折叠 (模型不必看到"建议经常 save"), save 由运行时直接发出。
      direct: true,
    },
  },
  // ── pager 分页自动翻页 (P2-4, 逐页化: 一页一 step, 不用命令序列):
  //    pkuxkx 大地图/长输出停在 `== 未完继续 NN% == ...` 时, 输入任何一行都会
  //    被当作翻页 (实测: sleep 被吞成翻页, 命令失真)。命中即发**一个空格**
  //    翻下一页 (非序列, 防 P2-2 GA 计数失衡); 逐批最多一次; 规则作者不能假设
  //    "帧必以 prompt 行结尾" — 分页 GA 前一行可能无 prompt (抓包实证)。
  //    -- more -- 为通用 MUD 变体 (低风险附带支持)。
  //    **直接执行**: 翻页是"照做即可"的反射, 提示行折叠 (模型不必逐页读分页提示),
  //    空格由运行时立即发出 —— 也让分页不必等一个 T1 回合。
  {
    id: 'pager:continue',
    eventType: 'p:pager',
    priority: 40,
    match: { kind: 'regex', patterns: [/^== 未完继续 [\d，,]+% == \(q 离开，b 前一页，其他继续下一页\)\s*$/, /^-- more --\s*$/] },
    guard: () => {
      // 节流: 上次翻页后 1s 内不重复翻页 (防服务器异常循环重发同一提示刷爆命令)。
      const now = Date.now()
      if (now - lastPageFlipAt < 1000) return false
      lastPageFlipAt = now
      return true
    },
    action: {
      output: '分页自动翻页',
      // 用序列 `cmds` 而不是单体 `cmd`: `mud_send` 的单体命令会 trim 后把空白当"空命令"
      // 拒绝, 而翻页的语义正是**发一个空行/空白行**（`direct: true` = 发完即走, 不进桥）。
      tool: { name: 'mud_send', args: { cmds: [' '] } },
      direct: true,
    },
  },
]

export default defaultPerceptionRules
