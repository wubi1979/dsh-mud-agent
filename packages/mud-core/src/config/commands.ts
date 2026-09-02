/**
 * dsh-mud-core — 命令注册表 (Commands), config.
 *
 * 迁移前项目 `data/skills/*.yaml` 的命令级 API 静态编译版。这些是 pkuxkx 的
 * 命令行语法/参数契约 (一步成事的 `command` 模板), 不是流程级技能 (后者见
 * `src/config/skills.ts` 的 MudSkill)。命令与技能的判定:
 *   - 命令级 (本文件): 单条命令模板, 参数到位即 `send(cmd)` — 是"事实/语法";
 *   - 流程级 (skills.ts): 多步编排序列, 供 agent/flow 按序执行。
 *
 * 用途:
 *   - **紧凑 agent 参考** (`commandsTextForAgent`): 一行一条、按类分组的命令语法
 *     注入系统提示 `mud-commands` 区段, 让 agent 用 `mud_send` 时拼对语法,
 *     而不用 70+ 个工具 schema 占每次请求的 token;
 *   - **安全边界** (`FORBIDDEN_COMMANDS`): 原始命令层的硬禁用命令 (suicide/passwd),
 *     由 `mud_send` 工具层拦截, 不发到游戏。
 * @module @deepseek-ai/dsh-mud-core/config/commands
 */

/** 一条命令定义。 `command` 为模板串, 可含 `{占位符}` (参数由调用方注入)。 */
export interface MudCommand {
  /** 命令 id (如 go / get / hpbrief)。 */
  id: string
  /** 命令分类 (combat/cultivation/navigation/status/trade/...)。 */
  category: string
  /** 中文名。 */
  name: string
  /** 命令模板 (可含 {占位符}); 空 = 无模板 (载体/感知类)。 */
  command: string
  /** 一句中文说明。 */
  description: string
  /** 是否安全禁用 (硬边界, 工具层拦截)。 */
  forbidden?: boolean
}

/** 命令注册表 (按 id 索引的平坦数组; 渲染/校验时按需分组)。 */
export const mudCommands: readonly MudCommand[] = [
  // ── combat 战斗 ─────────────────────────────────────────────
  { id: 'fight', category: 'combat', name: '切磋', command: 'fight {target}', description: '要求目标与你点到为止地战斗 (不致死, 比 kill/hit 温和)' },
  { id: 'halt', category: 'combat', name: '中止动作', command: 'halt', description: '中止当前动作 (战斗脱身/打坐走火预防/终止修炼)' },
  { id: 'hit', category: 'combat', name: '强行攻击', command: 'hit {target}', description: '强迫目标与你战斗 (不叫杀, 可连续 hit 至昏迷; 比 kill 安全)' },
  { id: 'hitall', category: 'combat', name: '群攻', command: 'hitall {target}', description: '强迫房间内所有 npc 或所有同名 npc 与你战斗 (不叫杀)' },
  { id: 'kill', category: 'combat', name: '叫杀', command: 'kill {target}', description: '主动攻击人物 (危险: 对方叫杀反杀; 禁地慎用, 建康府官兵绝对禁止)' },
  { id: 'killall', category: 'combat', name: '群攻叫杀', command: 'killall {target}', description: '攻击房间内所有 npc 或所有同名 npc (危险: 群叫杀反杀; 建康府官兵绝对禁止)' },

  // ── cultivation 修炼 ─────────────────────────────────────────
  { id: 'abandon', category: 'cultivation', name: '放弃技能', command: 'abandon {skill}', description: '删除一项所学技能 (从人物资料移除)' },
  { id: 'bai', category: 'cultivation', name: '拜师', command: 'bai {target}', description: '拜某人为师' },
  { id: 'bei', category: 'cultivation', name: '备空手武功', command: 'bei {first} {second}', description: '备空手武功用于战斗 (两武功互备攻击速度+0.5, 不与互博叠加)' },
  { id: 'dazuo', category: 'cultivation', name: '打坐', command: 'dazuo {value}', description: '打坐将气血转化为内力 (值|max; 可能走火须安全地点)' },
  { id: 'du', category: 'cultivation', name: '读书', command: 'du {book} {times}', description: '通过读书提高技能 (需会读书识字)' },
  { id: 'dz', category: 'cultivation', name: '静坐', command: 'dz', description: '静坐缓慢增加内力与基本内功 (战斗/halt 可能走火须安全地点)' },
  { id: 'jiali', category: 'cultivation', name: '加力', command: 'jiali {value}', description: '设定攻击加力 (值|none|half|max; 每次击中发内力伤敌)' },
  { id: 'jifa', category: 'cultivation', name: '激发武功', command: 'jifa {target}', description: '激发特殊武功 (无参看当前, ? 列可激发种类)' },
  { id: 'lian', category: 'cultivation', name: '练习', command: 'lian {skill} {times}', description: '练习技能 (须已 jifa; 上限不超基本技能)' },
  { id: 'lingwu', category: 'cultivation', name: '领悟', command: 'lingwu {skill} {times}', description: '领悟基本武功 (建议剑心居, 各门派有指定地点)' },
  { id: 'part_abandon', category: 'cultivation', name: '部分放弃技能', command: 'part_abandon {skill} {level}', description: '放弃技能若干级 (调整技能等级用)' },
  { id: 'perform', category: 'cultivation', name: '外功绝招', command: 'perform {pattern} {target}', description: '使用外功绝招 (须先 jifa; 如 perform taiji-jian.chan)' },
  { id: 'research', category: 'cultivation', name: '钻研武功', command: 'research {skill} with {points}', description: '钻研武功 (无人可教时自研, 消耗技能点)' },
  { id: 'sk', category: 'cultivation', name: '查看技能', command: 'sk {target}', description: '查看所学技能 (可查他人或师傅可教级别 -learn)' },
  { id: 'skbrief', category: 'cultivation', name: '技能详情', command: 'skbrief {skill}', description: '查看某技能具体信息 (等级/小点)' },
  { id: 'transform', category: 'cultivation', name: '内力转换', command: 'transform {source} into {target} {percent}', description: '转换不同内功的内力' },
  { id: 'tuna', category: 'cultivation', name: '吐纳', command: 'tuna {value}', description: '吐纳将精神转化为精力 (值|max; 上限两倍内增长)' },
  { id: 'verify', category: 'cultivation', name: '验证武功', command: 'verify {skill}', description: '查看武功的功能及特殊招式' },
  { id: 'wbei', category: 'cultivation', name: '武器互备', command: 'wbei {first} {second}', description: '两个武器武功互备 (攻击速度+0.5, 不与互博叠加)' },
  { id: 'xiulian', category: 'cultivation', name: '修炼内功', command: 'xiulian {skill}', description: '修炼特殊内功 (后期唯一途径; 可能走火须安全地点)' },
  { id: 'xue', category: 'cultivation', name: '学习', command: 'xue {target} for {skill} {times}', description: '向他人请教技能 (消耗潜能精力; 高于师父变切磋数倍消耗)' },
  { id: 'yun', category: 'cultivation', name: '内功功能', command: 'yun {function} {target}', description: '使用内功功能 (须先 jifa; recover/qi/regenerate 普通, heal/lifeheal 等特殊)' },

  // ── lifecycle 生命周期 ───────────────────────────────────────
  { id: 'login_flow', category: 'lifecycle', name: '登录流程', command: '{name}', description: '登录进入游戏: 响应名字/密码提示 (含同名档案替换分支), 欢迎横幅确认即完成' },
  { id: 'quit', category: 'lifecycle', name: '退出游戏', command: 'quit', description: '退出游戏下线 (危险: 中断状态与任务; 仅受控维护用, 战斗/危险场景禁止)' },
  { id: 'save', category: 'lifecycle', name: '保存状态', command: 'save', description: '保存游戏状态 (关键操作, 定期/重大操作后执行)' },
  { id: 'send_password', category: 'lifecycle', name: '发送密码', command: '{password}', description: '登录时向服务端发送密码' },

  // ── navigation 移动 ──────────────────────────────────────────
  { id: 'climb', category: 'navigation', name: '攀爬', command: 'climb {item}', description: '攀爬场景物品/地形' },
  { id: 'close', category: 'navigation', name: '关闭', command: 'close {item}', description: '关闭场景物品 (门/容器)' },
  { id: 'follow', category: 'navigation', name: '跟随', command: 'follow {target}', description: '跟随人物一起行动 (跟随 NPC/队友移动)' },
  { id: 'go', category: 'navigation', name: '方向移动', command: 'go {direction}', description: '向指定方向移动 (等价 move; 主动探索/脱战移动)' },
  { id: 'localmaps', category: 'navigation', name: '本地地图', command: 'localmaps {target}', description: '查看本地地图 (可带房间名高亮定位)' },
  { id: 'look', category: 'navigation', name: '环顾', command: 'look {target}', description: '环顾当前地点 (可带目标看方向/人物/物品详情)' },
  { id: 'lookin', category: 'navigation', name: '查看真面目', command: 'lookin {target}', description: '查看人物真面目 (看破伪装/易容)' },
  { id: 'maphere', category: 'navigation', name: '附近地图', command: 'maphere', description: '查看附近地图' },
  { id: 'open', category: 'navigation', name: '开启', command: 'open {item}', description: '开启场景物品 (门/容器)' },
  { id: 'ride', category: 'navigation', name: '划船', command: 'ride', description: '在可划船的场景渡水' },

  // ── quest 任务 ───────────────────────────────────────────────
  { id: 'jobquery', category: 'quest', name: '任务状态', command: 'jobquery {params}', description: '查看当前任务状态 (-m 门派/-x 新手/-z 主流/-t 特殊)' },
  { id: 'locate', category: 'quest', name: '定位任务物品', command: 'locate {item}', description: '查找 task 物品位置 (任务寻物用)' },
  { id: 'task', category: 'quest', name: '任务榜', command: 'task', description: '查看 task 任务榜 (接任务前了解可接任务)' },

  // ── social 社交 ──────────────────────────────────────────────
  { id: 'ask', category: 'social', name: '打探消息', command: 'ask {target} about {topic}', description: '向目标打探消息 (解谜关键; 缺省 about all)' },
  { id: 'comment_add', category: 'social', name: '添加评论', command: 'comment -a {target} {content}', description: '为当前地点/物品/npc 添加或回复评论' },
  { id: 'comment', category: 'social', name: '查看评论', command: 'comment {target}', description: '查看其他玩家对当前地点/物品/npc 的评论' },
  { id: 'train', category: 'social', name: '训练坐骑', command: 'train {target}', description: '训练动物成为坐骑' },

  // ── status 状态 ──────────────────────────────────────────────
  { id: 'drink', category: 'status', name: '喝水', command: 'drink {item}', description: '喝水恢复饮水度 (饮水为零时不自动恢复精神气血)' },
  { id: 'eat', category: 'status', name: '吃东西', command: 'eat {item}', description: '吃食物恢复饱食度' },
  { id: 'exp', category: 'status', name: '经验统计', command: 'exp', description: '查看连线时间与经验值统计' },
  { id: 'hp', category: 'status', name: '详细状态', command: 'hp', description: '详细状态 (限频 300s): 精神/精力/气血/内力/真气/食物/饮水/潜能/经验' },
  { id: 'hpbrief', category: 'status', name: '实时状态', command: 'set hpbrief long,report', description: '实时状态 (短格式): 经验/潜能/内力/精力/气血/精神/食物/饮水/真气' },
  { id: 'mudage', category: 'status', name: 'mud年龄', command: 'mudage', description: '查看自己在 mud 中度过的时间' },
  { id: 'news', category: 'status', name: '新闻', command: 'news', description: '查看游戏新闻' },
  { id: 'score', category: 'status', name: '个人档案', command: 'score', description: '个人档案: 膂力/悟性/根骨/身法/福缘/容貌、门忠/道德/声望/存款/死亡次数' },
  { id: 'sleep', category: 'status', name: '睡觉', command: 'sleep', description: '睡觉快速恢复精神与体力 (练功/战斗后恢复)' },
  { id: 'status_me', category: 'status', name: '战斗状态', command: 'status_me', description: '战斗/恢复状态: 战斗力、四维影响、恢复与治疗速度、内力精纯' },
  { id: 'time', category: 'status', name: '时间', command: 'time', description: '查询现实与 mud 时间' },
  { id: 'top', category: 'status', name: '高手排行', command: 'top', description: '查看高手排行榜' },
  { id: 'uptime', category: 'status', name: '服务器运行时间', command: 'uptime', description: '查看服务器已执行时间' },
  { id: 'who', category: 'status', name: '在线玩家', command: 'who {params}', description: '查看在线玩家名单 (-l/-w 变体可直调)' },
  { id: 'wizlist', category: 'status', name: '巫师名单', command: 'wizlist', description: '列出巫师名单' },

  // ── system 系统 ──────────────────────────────────────────────
  { id: 'fullme', category: 'system', name: '验证码验证', command: 'fullme', description: 'fullme 验证码验证 (防机器人判定; 需人工以 @ 前缀输入图片验证码)' },
  { id: 'sos', category: 'system', name: '求救', command: 'sos', description: '向巫师求救 (被围杀/卡死等危险场景)' },
  { id: 'send_command', category: 'system', name: '发送命令', command: '{command}', description: '内部命令载体: 按模板发送命令; 组合 skill 编排使用', forbidden: true },
  { id: 'system_perception', category: 'system', name: '系统感知', command: '', description: '系统级感知规则载体 (战斗/房间/物品/金钱/导航标签/地图输出)' },

  // ── trade 交易/物品 ──────────────────────────────────────────
  { id: 'addvalue', category: 'trade', name: '车船通充值', command: 'addvalue', description: '车船通充值' },
  { id: 'drop', category: 'trade', name: '丢弃物品', command: 'drop {item}', description: '丢弃物品 (也可 drop all)' },
  { id: 'get', category: 'trade', name: '获取物品', command: 'get {item} {container}', description: '捡起物品 (get all 全捡; 带容器从容器/尸体取, 如 get all from corpse)' },
  { id: 'give', category: 'trade', name: '给予物品', command: 'give {target} {item}', description: '给目标人物物品' },
  { id: 'i2', category: 'trade', name: '合并物品列表', command: 'i2', description: '合并式显示身上物品 (相同 id 合并标注数量, 含负重/手持/穿着)' },
  { id: 'id', category: 'trade', name: '查看id', command: 'id {target}', description: '查看身上物品别称 (id here 查看房间内英文 id)' },
  { id: 'inventory', category: 'trade', name: '身上物品', command: 'i', description: '查询自己身上的物品 (i / inventory)' },
  { id: 'put', category: 'trade', name: '放入容器', command: 'put {item} in {container}', description: '把物品放入容器 (整理背包/存物)' },
  { id: 'remove', category: 'trade', name: '脱下装备', command: 'remove {item}', description: '脱下衣物装备 (也可 remove all)' },
  { id: 'steal', category: 'trade', name: '偷窃', command: 'steal {item} from {target}', description: '偷窃目标物品 (危险: 犯罪被追杀通缉, 仅任务/门派需要时用)' },
  { id: 'unwield', category: 'trade', name: '放下武器', command: 'unwield {item}', description: '放下手里的武器' },
  { id: 'wear', category: 'trade', name: '穿上装备', command: 'wear {item}', description: '穿上衣物装备 (wear all / mine 穿所有 autoload 装备)' },
  { id: 'wield', category: 'trade', name: '装备武器', command: 'wield {item}', description: '装备武器 (可加 at left/right 指定手部)' },
]

/** 按 id 查命令。 */
export function getCommand(id: string): MudCommand | undefined {
  return mudCommands.find(c => c.id === id)
}

/**
 * 原始命令层硬禁用命令 (安全边界)。迁移前 `lib/skills.js` 的 forbidden 判定
 * 依据 (suicide/passwd + 禁止语义): 这些命令直接不可执行, 由 `mud_send`
 * 工具层拦截, 防止 agent 拼错导致删号/改密等不可逆操作。
 */
export const FORBIDDEN_COMMANDS: readonly string[] = ['suicide', 'passwd']

/** 分类顺序 (渲染分组用)。 */
const CATEGORY_ORDER = [
  'navigation', 'combat', 'cultivation', 'status',
  'trade', 'quest', 'social', 'system', 'lifecycle',
] as const

/** 分类中文标签。 */
const CATEGORY_LABELS: Record<string, string> = {
  navigation: '移动/探索',
  combat: '战斗',
  cultivation: '修炼',
  status: '状态',
  trade: '物品/交易',
  quest: '任务',
  social: '社交',
  system: '系统',
  lifecycle: '生命周期',
}

/**
 * 渲染为 agent 系统提示 `mud-commands` 区段 (紧凑命令参考, 一行一条、按类分组)。
 * 让 agent 用 `mud_send` 时拼对命令语法, 而非 70+ 工具 schema 占每次请求 token。
 */
export function commandsTextForAgent(commands: readonly MudCommand[] = mudCommands): string {
  const byCat = new Map<string, MudCommand[]>()
  for (const c of commands) {
    if (!c.command) continue // 载体/感知类无模板, 不给 agent 作可执行参考
    const list = byCat.get(c.category) ?? []
    list.push(c)
    byCat.set(c.category, list)
  }
  const lines: string[] = ['以下是常用游戏命令语法 (用 mud_send 发送; 参数按模板填):']
  for (const cat of CATEGORY_ORDER) {
    const list = byCat.get(cat)
    if (!list || list.length === 0) continue
    lines.push(`[${CATEGORY_LABELS[cat] ?? cat}]`)
    for (const c of list) {
      const forbidden = c.forbidden ? ' [禁止]' : ''
      lines.push(`  ${c.command} — ${c.name}${forbidden}: ${c.description}`)
    }
  }
  return lines.join('\n')
}

/** 渲染为纯文本命令列表 (诊断/调试用)。 */
export function commandsTextList(commands: readonly MudCommand[] = mudCommands): string {
  return commands
    .map(c => `${c.id}\t${c.category}\t${c.name}\t${c.command}${c.forbidden ? '\t[禁止]' : ''}`)
    .join('\n')
}

export default mudCommands
