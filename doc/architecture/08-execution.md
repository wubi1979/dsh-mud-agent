---
sections: [8]
status: active
deps: ["§2", "§3–§5", "§6", "§12"]
note: L6 执行层（单章）：工具面 + 流程面；agent 的能动面
---

# §8 L6 执行层：工具面 + 流程面

## 8.1 职责与边界

L6 是 agent **能动**的唯一出口——把"想做什么"变成"MUD 上发生了什么"。两个执行面共用一套**执行契约**：

| 面 | 承载 | 定位 |
|---|---|---|
| **工具面** | `tool-mud` preset 行（`packages/mud/tool-mud/src/preset.ts` + 纯层 `src/tools.ts`） | 单条命令的**自由能动**：发命令、看状态、建连 |
| **流程面** | 独立包 `mud-workflow`（声明表 / 注册表 / 解释器 / 七工具） | **确定性序列**：把"已知的正确步骤"固化成可复用、可修缮的声明 |

**共享执行契约**（两个面都必须满足）

1. **注册期不依赖引擎，执行期解析引擎窄面**（`ctx.get('mudCore3')`）——preset 树共享，数据必须调用期按会话解析（§2.1 事实 4）。
2. **归属解析同一路径**（§8.5）：解析不到 ⇒ 可读拒绝，零行为。
3. **会话级行流持有者**（§8.6）：同时只有一个执行体在 send+read。
4. **一切拒绝都是可读拒绝**（P8）。
5. **消费过的行推进水位**（§4.3 总表）：工具读、流程读都推进 `readAbs`。
6. **纪律**：执行面只做"序列与判据"，**不做决策、不自行重试**（§7.6）。

## 8.2 工具面：注册与承载

- 工具挂 **preset 作用域**：preset 行的 `plugins` 挂插件入口 `src/preset.ts`（经宿主 `ctx.tools.register`）。
- **注册期**不依赖引擎；**执行期**经 `ctx.get('mudCore3')` 解析引擎窄面——引擎缺席时**注册照常、执行返回可读拒绝**（§8.4 ①）。
- **工具定义在纯层 `src/tools.ts`**（零宿主 import，可单测）；`preset.ts` 只做 `defineTool` 适配。
- **注册完整性自检**：期望的工具集缺失即 **fail-loud**（防"preset 行漏挂导致静默少工具"）。
- **preset 决定能力面**：选 `standard` 的账号**没有** mud 工具（§7.1）。
- 并发声明是**谓词函数**（宿主 `isConcurrencySafe?(args) => boolean`，只有恰好返回 `true` 才算并行）：`mud_send`、`mud_walk` 与 `mud_workflow_run` 恒返回 `false`（独占）；`mud_state` 等零发送只读工具可并发。
- **宿主协议漂移由编译期断言钉住（T17）**：接线层（`src/preset.ts`）导出 `AssertTrue<...>` 形式的断言，钉住两处曾漂移、又被 `as unknown as ToolRegistrar` 吃掉的成员——`isConcurrencySafe` 必须是**谓词**（曾经是 boolean 属性：写 `false` 只因宿主 fail-closed 恰好得到独占，写 `true` 会被静默吞成独占）、`render` 必须返回**可变**数组（宿主 `ContentBlock[]`）。纯层保持零宿主 import，接线层是唯一允许认识宿主的地方；`output.schema` 逐工具补齐真实字段（宿主对成功返回值强制校验该 JSON Schema）。
- **工件面加载冒烟**：`packages/mud-workflow/test/plugin-load.e2e.ts` 导入构建产物断言插件面与七工具注册（含谓词与 `output.schema` 面），与 core3 同款纪律（§16.1/§16.2）。

## 8.3 工具面：工具清单与语义

| 工具 | 语义 | 约束 |
|---|---|---|
| **`mud_send`** | 发命令 + **判据驱动等应答**；**不带 `cmd` = 裸读近况**；**`wait: false` = 发送即走**（T19 D11：只 send 不 read、不设超时、不判成败——分页/save 等"发了就行"的动作；返回 `reason:'sent'`，仍过持有者与拒绝序）。收窗判据经**命令总表解析单点** `resolveAwaitPlan`（T26，§8.7）：显式 `listen`（同形态语义条目级合并）> 表条目 > **未登记不收窗只等超时**（DEC-4 终态：无兜底档；超时文案兼语料工单 DEC-22，点名未登记并给出 listen 声明示例） | 不受接入闸门；**只拒未连接**；独占（`isConcurrencySafe: false`）；应答原文返回调用方（状态拉取命令另有读后投影，§8.7） |
| **`mud_walk`** | **内建路径自动行走 + 导航动作**（T23；`mud_send` 的判据预设特化，非新持有者/新闸门）：`action` 缺省 `walk`（发 `walk` 家族命令：拼音名 / `-c` / `-q` / `-p` / 缺省恢复）、`action: 'speed'`（`set walk_speed <值>`）；判据走命令总表 `walk` 条目（T26.6 改判 `'criteria'`——`到达`/`软阻断` 判据语义条目收窗，GA 不武装；条目 flags `'m'` 承重；`exempt` 锚定**完整发送串**，查询类 `-c`/`-q` 不套判据）⇒ 工具侧 `outcome` 分类（T23.5）；`node` 家族（玩家自建路径）**只留槽位、本期不实现**（A.9 结论 9） | 同 `mud_send` 约束（只拒未连接、独占、持有者、可读拒绝）；`args` 拒分号/换行（walk 前缀使 deny 扫描失效，显式堵拼接）；预留动作执行返回可读拒绝 |
| **`mud_state`** | **状态自述**（两轴 + World 合并快照，§10.5） | **不受闸门 / 不受连接约束，只过归属** |
| **`mud_connect`** | **建连**（幂等：已连接不重连、不踢已登录会话） | 三期把"连接是手工动词"升格为工具，模型可自行调用 |
| `mud_workflow_run` + `mud_workflow_list/get/save/delete/history/rollback` | 流程执行与管理七工具 | 归 `mud-workflow` 包（§8.14） |

## 8.4 工具面：拒绝序

**全部为可读拒绝**——返回 `{ok: false, error}` 的**模型可读文本**，**不 throw**：

| 序 | 判据 | 拒绝文本（语义） |
|---|---|---|
| ① | **引擎缺席**（`ctx.get('mudCore3')` 不可用） | 引擎未就绪 |
| ② | **归属 `toolContextFor(agent)` 为 null** | 「本会话未绑定 MUD 账号」 |
| ③ | **禁发表命中**（`cmd` 存在且命中，安全最高优先，**先于连接判断**） | 拒绝信息**带命中词**（§12.3） |
| ④ | **`mud_send` 未连接** | 「未连接」 |

**三期修订（取代二期预设）**

- 二期的「**未接入拒**」**已删除**：`mud_send` **不受接入闸门**——应答经工具结果返回调用方，不是投递通路，不破坏 §6.3 的投递语义。
- 「连接是手工动词」改为 **`mud_connect` 工具**。

## 8.5 执行契约：归属解析与父链上溯

```
调用方会话 ──(沿 session.header.parentSession 上溯)──▶ 账号会话 ──▶ 其 runtime
```

- **归属权威 = 宿主持久化 session lineage**（`session.header.parentSession`；subagent/workflow 派发都写入该字段）——**插件不自建归属状态**（P1）。
- 按 id 查会话走**官方 live 注册表** `ctx.get('agents').get(id)`（**agent id ≡ session id**），实时读 `session.header.parentSession`；**调用期**解析（apply 期未必就绪），注册表缺席 ⇒ 同「不 live」处理（§2.3）。
- **祖先必须 live**（与宿主 `authorizeLineage` 语义一致）：不 live ⇒ 上溯终止 ⇒ **可读拒绝**，**不以陈旧状态解析成功**。
- **环深护栏 32 层**（防数据成环）。
- **不开 `mud_send({ sessionId })` 参数**：避免形成跨账号后门；调用方身份只能来自宿主谱系。

## 8.6 执行契约：行流持有者

- **同一时刻只允许一个执行体在 send+read**——根与在途子 agent 会"争半截应答"。
- 实现 = **会话级唯一持有者**（`acquireSend(holder)` / `releaseSend`）：冲突 ⇒ **可读拒绝**；**应答不劈半**。
- **抢占动词 `stealSend(holder)`**（T21.5）：清掉任何现持有者并归属调用方——供战斗危险通道与"待接管转正式接管"使用，不等锁（D5：危险不能等在途）；被抢者已因 `abortWait` 收束（§5.2），走既有 `finally` 释放。
- **互锁安全性（T23.7）**：`releaseSend(holder)` **按 holder 比对**（只解除自己的持有）⇒ 被抢者（如 `mud_walk`）的 `finally` 在抢占后是 **no-op**，战斗持有不被误释放、无残留（W11；`test/runtime.spec.ts` 有专项用例）。**遇敌中断口径**：`walk` 以 `reason:'danger'` 收束，**用户裁定 2026-10-08 先假设可恢复**（战斗结束后用无参 `walk` 继续），实测发现不能恢复再改。
- 持有者也是 Wake 第三守卫的判据（§7.5 ③）与流程独占的依据（§8.14）。

## 8.7 工具面：参数与缺省

```ts
mud_send {
  cmd?: string                                  // 缺省 = 裸读近况
  wait?: boolean                                // T19 D11：false = 发送即走（缺省 true = 发+等应答）
  listen?: { closeOn?, outcomes?, gaCount?, maxLines?, flags? }   // 与流程 wait 同一 schema（DEC-21/24 全量拼写）
  timeoutMs?: number
}
```

| 项 | 规则 |
|---|---|
| `listen` 校验 | 与流程 `wait` **同一 zod schema**（DEC-21 一个语法三个消费点；全量拼写无简写，DEC-24）；工具面专属限制：`timeoutMs` 是顶层参数不进 listen、`captures`/`captureFrom` 是流程面词汇 ⇒ 出现即拒（可读）。编译在 `resolveAwaitPlan` 单点（非法正则执行期可读拒） |
| `listen` 解析 | 缺省 ⇒ 按命令总表解析（见「命令总表」行）；模型显式给 `listen` ⇒ 与表条目**形态比对**（DEC-5）：同形态 ⇒ 语义条目级合并（同名语义条目后声明整体替换、异名追加、timeoutMs 步声明优先表填缺省），异形态/未登记 ⇒ 声明即全部配方。**裸读**（无 `cmd`）不是"某条命令的收窗"，不走表：缺省 `maxLines: 50 + quietMs: 300` |
| **空命令** | **放开**（2026-10-10 二次裁定）：照常发送，收窗特例归 `closeOn: 'ga'` 立即收束（空输入也是命令 ⇒ 回 prompt+GA，A.2 1:1；T26.1 起 `resolveAwaitPlan` 特例，兜底行数照设）——刷提示符无害；等长程命令不用它（根因治理靠命令总表判据 + persona 等待纪律；曾设可读拒绝，因根因已除放开） |
| **命令总表（T26，v0.0.70 勘误改口径）** | `packages/mud/mud-commands/src/`（`define.ts` 契约 + `std/skill/usr/stunt/profession` 五全局分组 + 任务组 `task`（T27）；`assembler.ts` **装配器**，T28 前名 `command-profiles.ts`）：条目 = `defineCommand({ id, aliases?, exempt?, timeoutMs, maxLines?, flags?, resolve, meta })` **纯数据单元**，**构建期数组、无运行期注册面**（agent 不可修缮）；`resolve` = 三判定器工厂之一（T26.6 终态）——`byBoundary`（`closeOn:'ga'`，GA 收窗，gaCount 缺省 1，分类语义条目可选——声明即断言）/ `byOutcomes`（`'criteria'`，判据收窗 GA 不武装，判定序 fail > cooldown > ok）/ `byWindow`（`'quiet'`，固定采样窗——窗长即条目 `timeoutMs`，无槽）——数据面即契约层 `CLOSURE_KINDS` **三值**（§8.10）；**槽位（ok/fail/cooldown 判定类型，代码字段 `kind`）= 契约、语义条目（具名判据，旧称槽名）= 条目数据自由命名**（DEC-23 + 2026-10-15 术语定名 + kind 三分 2026-10-15 用户裁定，§8.10；判据表与路由表**两表同构**——**槽位在前、语义条目在内**：`outcomes` 外层键 = ok/fail/cooldown 槽位、语义条目不带 kind，2026-10-12 用户裁定统一；保留字 `ok`/`fail`/`cooldown` 装配期拒用，`patterns ≥ 1` 推定槽退役）。**解析单点（DEC-21）**：`resolveAwaitPlan(sent, decl)` 供 `mud_send`/`mud_walk` 与流程缝共用——声明（形态比对合并）> 表条目（整条采用）> 空命令特例（归 `'ga'`）> **未登记不收窗只等超时**（DEC-4 终态，无 `gaCount:1` 兜底；超时文案兼语料工单 DEC-22，点名未登记并给出 listen 声明示例）；`matchCommandProfile(sent)` 首词 + 词边界命中（exempt 锚定**完整发送串**）、`tableSlotsOf(sent)` 语义条目查询（保存门语义条目集校验端口，§8.11）。现役条目：`exercise`（别名 `dazuo`；2026-10-12 勘误：打坐标准命令是 `exercise`，`dz` 是另一条命令非别名）（`'criteria'`：`完成`/`突破` ok 槽位语义条目 + `内息不足`/`精神不足` fail 槽位语义条目，兜底 120s）、`sleep`（`'criteria'`：`完成` ok + `刚睡过` fail，兜底 300s）、`drink`/`eat`（喝/吃，别名 `he`/`chi`；2026-10-15 用户供句入库——即时完成类 `'ga'` 条目**首例**：`drink` = `喝下` ok + `喝饱` fail、`eat` = `吃下` ok + `吃太饱` fail，兜底 15s；基础判据为茶水/包子场景，行文变体待实录；**用户供句记法 = `标准命令[别名]`，方括号内恒为别名**）——判据原文按 A.3 逐条搬入（不重写正则）；`walk`（`'criteria'` + 条目 flags `'m'` 承重，用户口径 2026-10-14 四条语义条目：fail 槽位 `阻塞`（`你因为种种原因停了下来`——取消软/硬说法，只有阻塞）/`不在出发点`（`当前区域的系统内建路径出发点在`）+ ok 槽位 `到达`（`^你到达了`）/`出发点表`（`^┌`——出现表格 = 处于 walk 节点）；`exempt` 只留 `-c` 查询；超时 = 条目预算 30s 缺省，**无步数 sizing**（用户裁定"没有超时，这些都是后续服务"），A.9 结论 5 + 用户口径 2026-10-14）。即时完成 GA 收尾类**不入表 = 未登记不收窗只等超时**——如需登记为 `'ga'` 条目须先语料校准（`drink`/`eat`/`learn` 即按此路径登记）。**新条目须先语料校准并登记附录 A 原句**（A.6 纪律）。**T29 七条登记（2026-10-15，记法 `标准命令[别名]`）**：`look[l]`（std）/ `skills[cha、sk]`（skill）/ `hpbrief`、`inventory[i]`、`score[sc]`、`hp`、`exp`（usr）——表类即时命令（应答框线表后即 GA，A.2 1:1 同律），形态 `'ga'`、无分类语义条目、兜底 15s（**skills 例外**：cooldown 槽位语义条目 `刚查看过`——频控冷却句 `你不是刚查看过吗？`，2026-10-15 kind 三分首例，A.3）；条目增 **`capture` 字段**（**D7 登记原则：命令的返回与捕获一律登记在表条目，唯一专用返回可例外在调用点附加**）登记捕获格式（六套规则自 tracker 迁入并**随命令条目就地定义**——`skill.ts` 住 skills、`usr.ts` 住 hpbrief/hp/sc/i/exp；**捕获 = 命令总表通用形态**：所有命令条目都可按 `CaptureRule`/`BlockReducer` 契约实现捕获，契约归 `define.ts` 条目契约单点（`capture` 字段的数据形状），tracker 只是执行机制之一，只引用装配汇出 `COMMAND_CAPTURE_RULES`，§10.3；装配期规范序 `CAPTURE_RULE_ORDER` + fail-loud 自检，规则 id 独立于命令 id/别名——规则 `'sc'`↔命令 `score`、规则 `'i'`↔命令 `inventory`；**块语法（线框四角 + cell 切分符）= 格式定义**，随捕获契约声明 `TABLE_BLOCK_FORMAT`（2026-10-15 用户裁定：定义归声明层——凡需捕获基本皆线框格式、四角是表归属唯一锁定依据，hpbrief 序列例外；tracker 机制只消费，规则判据 `[^│]` 终止符与 walk `出发点表` `^┌` 亦由此组装——服务器改线框 = 改声明一处，§10.3））。**用户供句续登记（2026-10-15 供句，2026-10-16 入库）**：`learn[xue]`（skill）——即时命令 ga 收束 + 分类语义条目 fail `太累`（`你今天太累了，结果什么也没有学到`）先于 ok `有心得`（`似乎有些心得`；受理行 `你向谷虚道长请教一次有关「基本内功」的疑问。` 两形态共有且含师父/技能名变量不进判据，ok 原句含变量取结论子串），兜底 15s；`help`（usr）——即时命令 ga 收束无判据（帮助文本自由文档），兜底 15s。**任务专用命令（T27，v0.0.79）**：第六分组 `task.ts`，条目增 **`task` 标记字段**——任务条目**不入全局总表**（`matchCommandProfile` 看不到）、装配器 `assembleTaskProfiles` 按标记分组 ⇒ `TASK_PROFILES`（缺标记 fail-loud）；**任务上下文 = 行流推断**（2026-10-15 用户裁定：任务/环境有明确进出标志，据此自动置/清标记，不依赖模型与会话谱系）——`TaskEnvironment` 声明 enter/exit 判据逐字实录（A.6）⇒ 装配编译 `TASK_ENV_RULES` ⇒ mud-sense `TaskDetector` 纯层探测器（**可多任务并存**——2026-10-15 用户裁定：enter 加入 / exit 仅移除同名，活跃任务集按进入顺序，消费面先命中先用）⇒ core3 service 每会话一实例接线 `rt.onLine`（探测在投递器前），**断线整体复位**（§10.4，同 World/tracker 纪律）；窄面 `MudCore3Handle.taskOf(sessionId)` 供工具面查询。**解析序 = 任务条目 > 全局表**：`resolveAwaitPlan(sent, decl, tasks?)` 第三参（活跃任务集），三个消费点全透传（`mud_send`/`mud_walk` 工具面 + 流程缝 `io.read`）；**语义边界不变 = 只做收窗判据**——任务外不命中 = 未登记不收窗只等超时（DEC-4），**不拦发送**。首用例 = 剑心居场景命令 `clap 3`/`food`/`teacher`（`task:'jianxinju'`，A.11 2026-10-15 实录登记；进入判据 = `你进入了剑心居副本，可以通过leave \S+命令来回到主站`（玩家名动态桥接）；**受理句不入 outcomes**——criteria 档受理句命中会立即关窗，只登记 完成/被拒 槽位；`clap 3` 归 `'ga'` 档锚「进来一名小童，向你欠身行礼」，问 food/teacher 与只问 food 两变体共享）；武当阵法 `zhenfa` 判据 A.10 挂账待实录，实录前不接 |
| `wait: false` | 只 `runtime.send(cmd)`，**不 read、不设超时、不判成败**；返回 `{ok:true, reason:'sent', lines:[]}`；需提供 `cmd`（裸读不适用）；仍过禁发表/连接闸门/持有者（拒绝序不变，§8.4） |
| **读后投影**（2026-10-10；T29 改推导） | `cmd` 头命中**状态拉取档案**且收窗 ⇒ 结果附 `world` 字段 = **本窗口**（send 时刻起）追踪器写入的语义分区快照（`vitals/combat/character/inventory/skills`，条目含来源元数据，与 `mud_state` 的 world 同形）。档案**单点 = 命令总表 capture 条目推导**（T29 D7：带 `capture` 条目的命令头 id+aliases，≈ `skills\|cha\|sk\|hpbrief\|inventory\|i\|score\|sc\|hp\|exp`；`look` 无 capture 不入列；词边界由 `(?:\s|$)` 锚保证——此前从 tracker 规则 id 推导（`sc`/`i`）与命令头（`score`/`inventory`）不对应，全文发法漏识别，T29 修正），解析零重复（判据单点在 tracker、捕获格式单点在命令条目，§10.3）。**窗内零写入 ⇒ 不带字段**（fail-open 回原文行——限流警告等非表格应答天然覆盖，旧值不冒充新值）；`wait:false` 与裸读不投影。投递通道的 `status` 剔除（§10.3 D8）不变 |
| `listen`（模型面判据） | 与流程 `wait` 同一 schema（DEC-21/24 全量拼写）；表条目与流程 wait 新格式 = `closeOn` + `outcomes` 判据表（§8.10），两者经同一解析单点落入读窗机（§5.2） |
| `timeoutMs` | **模型显式值钳制 ≤ 60000**（协作式超时上限）；缺省 = 表条目 `timeoutMs`（**系统注入值，豁免钳制**——判据是主收束，本值纯兜底）或 Config `sendTimeoutMs` 15000 |
| 兜底行数 | Config 缺省 `sendMaxLines` 50（判据收窗条目不设 maxLines——完成句收束，行数剪断会误判） |
| `render` | `ok: true` ⇒ 行原文 `join('\n')`（`reason:'sent'` ⇒ 发送即走说明文案；**带 `world` ⇒ JSON 渲染投影快照**——原文表格不重复进上下文）；**冷却命中（kind=`cooldown`）⇒ `ok:false` + `reason:'cooldown'`**（2026-10-15 裁定：可读「冷却中：稍后重试同一命令」标注 + 原文与语义条目名照带）；拒/错 ⇒ 可读文本 |
| **硬编码项** | 禁词表最小集（§12.3）与裸读 `quietMs = 300`：**无例证不进 Config** |

**`mud_walk` 参数与判据预设（T23，A.9 + 用户口径 2026-10-14）**

```ts
mud_walk {
  action?: 'walk'             // 缺省 'walk'（'speed' 已退役）；'node' | 'node-get' | 'node-walk' = 预留槽位（不进描述、执行可读拒绝）
  args?: string               // action:'walk' 参数：拼音名 / -c / -c 拼音名；缺省 = 恢复行走
  timeoutMs?: number
}
```

| 项 | 规则 |
|---|---|
| 发送 | `action:'walk'`（缺省）⇒ `walk`（args 缺省）或 `walk <args>`（trim 后透传，单条）；**预留槽位**（`node` / `node-get` / `node-walk`）⇒ 可读拒绝"本期未实现"；未知 `action` ⇒ 可读拒绝（**命令字符串归本层拼装**，T23.9） |
| `args` 校验 | 禁 `;`/换行、长度 ≤ 60（walk 前缀使 deny 全段扫描失效，显式堵 `walk -c 扬州;suicide` 类拼接）；**退役参数显式拒绝**——`-q`（查询只保留 `-c`，用户口径 2026-10-14）⇒ 可读错误注明"已退役，可改用 walk -c <拼音名>"；`speed` 已从工具面整体删除（`set walk_speed` 由 `mud_send` 直发即可） |
| **判据（命令总表 `walk` 条目）** | **行走类**（非查询）走命令总表 `walk` 条目（`closeOn: 'criteria'`，`byOutcomes`；用户口径 2026-10-14 四条语义条目）：fail 槽位 `阻塞`（`你因为种种原因停了下来`——取消软/硬说法，可再发 `walk` 继续）+ `不在出发点`（`当前区域的系统内建路径出发点在…`，行文含动态出发点列表）；ok 槽位 `到达`（`^你到达了`，目的地为动态信息）+ `出发点表`（`^┌`，条目 flags `'m'` 承重——多行行走窗行首锚；**出现表格 = 处于 walk 节点**）。**无 GA**（每步都出提示符，GA 计数第一步就关窗）+ `maxLines` 兜底；**无步数 sizing**（用户裁定"没有超时，这些都是后续服务"）。**查询类**（`-c`）命中条目 `exempt`（**锚定完整发送串** `/^walk\s+-c(\s\|$)/`，DEC-8）不套判据，只等应答静默窗（`quietMs: 1500`） |
| **在出发点判定** | 正向证据：表类**出路径表**、行走类**出受理行**（`你决定开始前往…`）⇒ 写 `location.出发点就绪 = true`（`kind:'nav'`）；**正向证据缺失 ⇒ 写 `false`**。`-c <拼音名>` 的输出与出发点无关 ⇒ **不参与判定**。**不用单行"拒绝行文"判据**（用户裁定 2026-10-08）。**`unaccepted` 由显式 fail 槽位「不在出发点」给出**（用户口径 2026-10-14 改判——不再走"超时无证据"反证升级） |
| `outcome` | 按**命中帧结局语义条目**分类（T26.6，§5.2）：`到达` ⇒ `arrived`；`阻塞` ⇒ `blocked`（可再发 `walk` 继续，连击档案见下）；`不在出发点` ⇒ `unaccepted`（附 `departures`）；`出发点表` ⇒ `atNode`（当前点位，返回路径表）；其余（超时/maxLines 剪断未命中）⇒ `incomplete`。**仅行走类带 `outcome`**；返回形态 = `{ok, reason, outcome?, departures?, blocked?, region?, path?, lines}`——**不再带 `hint`/`suggest`**（nav 完全不进入 agent，用户口径 2026-10-14） |
| **精力闸**（T23.10 D16） | **行走类**（非查询）发送前先看 **`vitals.精力 / 最大精力`**：低于 `staminaFloorPct`（缺省 0.2，§15 #28）⇒ **可读拒绝、不发命令**（"精力不足以行动"是游戏事实，频繁动用另有惩罚）。口径：判据是**百分比**（`精力` 可为上限的 **200%**，A.7.1 结论 4）；**未知即放行**（`vitals` 未写入时不因"不知道"卡死导航）；**查询类不受闸门**（不是行动）。阈值 = 用户裁定 20%，键由本切片引入，**T21 战斗规则（收加力）待接同一键** |
| `departures` | 行走结果 `unaccepted` 时，**优先解析应答行文**（`…出发点在：中央广场、土地庙…` ⇒ 顿号分隔列表）；行文没给 ⇒ 退回 World `location.出发点`（T23.6）结构化回给 agent（`string[]`），免得它再发一条 `-c` |
| **记录（nav 只记录）** | 每次 `mud_walk` 都**把本次行文并入行走知识图**（`mudNav.record`：路径表 ⇒ 边——目的地按 `◇` 拆区域/房间、**`◇` 分隔段颜色 ⇒ 可直达**（红 `[31m ◇ ` = false / 绿 `[1;32m ◇ ` = true，实录 2026-10-14，§15.2）；`walk -c <拼音名>` 方向序列按拼音并入对应边 `dirs`；找不到东西就不记）——**结果只回 `region`**（World `location.区域`）与 `path`，**不回任何建议**（用户口径 2026-10-14：nav 服务完全不进入 agent，只在后端挂载）；`mudNav` 缺席 ⇒ 不记录，行为退回本期之前。**出发前纪律（进工具描述）**：执行 `walk <拼音名>` 前建议先 `walk -c <拼音名>` 查询实际行走路径（结果自动记录进行走知识图，与之前区域图同步），再出发 |
| `timeoutMs` | 显式值钳制 ≤ 60000；缺省 = **命令总表条目 `timeoutMs` 30s**（系统注入值，豁免钳制——判据是主收束，本值纯兜底）或 Config `sendTimeoutMs` 15000。**无步数 sizing**（用户裁定） |
| **阻断档案（T23.11；用户口径 2026-10-14 取消软/硬）** | **只有阻塞**：`你因为种种原因停了下来，可以用 walk 继续`——理论可再发 `walk` 继续行走；**连续失败没有推进** = **同位置阻塞连击 ≥ 2**（阈值 = `BLOCK_MANUAL_ATTEMPTS`）⇒ 记录为**阻断**（`needsManual`），**需人工干预**。计数落 World `nav.*`（`阻塞连击` / `阻塞位置` / `阻断`，`kind:'nav'`、会话相关、断线随 §10.4 复位），结果附 `blocked:{attempts, needsManual, at}`（attempts > 0 时）。处置 = **回给 agent 并停手**（不重试、不自动换路）。`arrived` / `unaccepted` ⇒ 清零；`incomplete` / `atNode` ⇒ 保持原状 |
| `path`（T23.10b） | `walk -c <拼音名>` 的区域内**方向序列**（A.9 结论 11）：返回 `{to, directions[], short?}`——`directions` 取**长版本**原文（可执行），只有短版本时按 `expandShortPath` 展开（`#4 w,nw,#5 w` ⇒ `west×4, northwest, west×5`；词表外 token 原样保留）。这是**可执行的最后一程**；`-q` 的"区域名链参考"已随退役删除 |
| 其余 | 拒绝序、持有者、独占、render 全同 `mud_send` send+read 路径 |

## 8.8 流程面：包结构与纯度裁定

- 流程面**独立成包** `packages/mud-workflow`（与 `mud-webui` / `packages/mud/` 组同级）：挂载即提供 `mudWorkflow` 服务面（注册表），工具走**独立 preset 行**。
- **纯度裁定**：`mud-workflow` 是**纯架构不含数据**（契约 / 内核 / 适配三层，**零宿主 import** 落在契约与内核两层）；**流程实体归 core3 `src/flows/`**（type-only import 契约词汇表，运行时零循环）。
- **三层与子路径导出（A1，2026-10-05）**：包内按依赖方向分层，**边界由 exports 表达**，不靠目录习惯或人工纪律——

  | 层 | 子路径 | 内容 | 依赖 |
  |---|---|---|---|
  | **契约层** | `mud-workflow/contract` | 词汇表 + 静态保存门（zod / `checkFlow` / `usesCredentialVerb`）+ IO 与引擎缝端口（`WorkflowIO<L>` / `WorkflowIoSeam<L>` / `CaptchaResume`）+ 持久化域声明（`mudWorkflowDomainSpec` / `FLOW_SCHEMA_VERSION`） | 无（零 cordis / 零宿主 / 零 I/O） |
  | **内核层** | `mud-workflow/core` | 解释器 `runFlow` + 注册表 `WorkflowRegistry`（保存门 + 存储双态策略） | 仅契约层 |
  | **适配层** | `mud-workflow`（根入口）/ `host/*` | 插件装配（根 `index.ts` → `host/plugin.ts`）· preset 行（根 `preset.ts` → `host/preset.ts`）· 工具面（`host/tools.ts`） | 内核 + 契约 + cordis |

  - **入口薄壳**：宿主 patch 按绝对路径加载 `lib/index.js` / `lib/preset.js`，故两个入口固定在包根、只做转发；逻辑在各层。
  - **可复用性**：内核零 cordis ⇒ 离线校验器 / 语料回放 / CLI / CI 静态检查可只依赖 `mud-workflow/core`。
- **契约单点（取代"双侧同形"纪律）**：端口类型只在契约层声明**一次**——core3 侧 `MudCore3Handle extends WorkflowIoSeam<MudLine>`、实现处 `const io: WorkflowIO<MudLine>`，于是**缺一侧或形状漂移 = 编译期红**（§8.17 的"双侧改"由纪律升级为类型系统保证；core3 原先自留的同形接口已删除）。行载体类型参数 `L` 让实现携带自己的完整行记录（`MudLine`：abs/样式/分类标）而契约只承诺 `text`，`recentLines → read(initial)` 原样回环，两侧都无 cast。
- **构建序**：core3 在**类型面**引用契约（devDep `mud-workflow`）⇒ 必须**先 build mud-workflow 再 build core3**；根 `dev`/`build`/`test`/`typecheck` 已按此编排（§15.3），本包 `build` 前先 `clean`（防陈旧产物被宿主加载）。
- **交接缝**：core3 经 `ctx.provide('mudCore3', { builtinFlows })` 把流程实体交给注册表挂载；`registerBuiltins` **fail-loud 校验、幂等、不触碰 agent 修缮层**。

## 8.9 流程面：流程本体与取舍

**流程本体 = JSON 声明式步骤表**（TS 字面量承载 ⇒ 编译期类型检查；agent 侧 `get`/`save` 面是**纯 JSON**）。表与解释器分离 ⇒ **表变数据**。

| 取舍 | 结论 |
|---|---|
| 为什么 JSON 而非任意脚本 | JSON **无任意代码**，`schema + 词汇表白名单` = **静态可验证的安全** |
| 执行器 | **进程内解释器**（复用 env 原语），无沙箱、无 `ptcRuntime`、零新宿主依赖 |
| `ctx.workflowEngine` | **否决**：六个全局写死、无桥可接 |
| `ptcRuntime` / 脚本文本 | **后置**：表达力强但信任面大，等"JSON 表达不了"的例证再评估（§17.3） |

## 8.10 流程面：词汇表（T26.6 契约模式，2026-10-12 定稿）

> **契约模式（DEC-23）+ 术语定名（2026-10-15 用户裁定）**：**kind（`ok`/`fail`/`cooldown`）= 契约，中文定名「**槽位**」**——承担判定序（**fail > cooldown > ok**，同帧高位收束）与粗路由缺省（ok → next / fail → timeout 出口 / cooldown → timeout 出口 + 记录，与 fail 同款缺省）；**kind 三分（2026-10-15 用户裁定）**：`cooldown` = 冷却/频控（语义边界：**fail = agent 换行为，cooldown = 稍后重试同一命令**——工具面 reason='cooldown'；onOutcome 暂无 cooldown 键，Minimal）；**语义条目 = 条目数据**（旧称「槽名/槽」）——每命令/每步的语料事实，具名判据单元（如 `完成`/`刚睡过`），自由命名（命名纪律 DEC-7：分支类目化、行文变体进同条目 `patterns` 不分条目、应对不同才分条目）。**术语映射（防旧文混淆）**：旧措辞「X 槽」按语境读作「X 槽位的语义条目」；「槽级合并」=「语义条目级合并」；「槽名跨 kind 禁重名」=「语义条目名跨槽位禁重名」；代码标识符不改（`kind` = 槽位、`slots[].name` = 语义条目名、`SlotTable` = 判据表）；**捕获变量槽**（`captures`/`captureFrom`，§8.13 值替换源）是另一概念，不受本定名影响。判据词汇单点（DEC-21）：表条目 `resolve` / 流程 `wait` / 工具 `listen` 共用契约层同一份 schema；listen 全量拼写无简写（DEC-24）。**判据表与路由表两表同构（2026-10-12 用户裁定统一）：同为「槽位在前、语义条目在内」——`outcomes` 外层键 = ok/fail/cooldown 槽位（契约），内层键 = 语义条目名（条目数据），语义条目不带 kind 字段；语义条目名跨槽位禁重名（schema 拒存）。****读时归一（`normalizeFlow`）已退役**（DEC-25：存储即新词汇，旧词汇解析失败在装载期点名，测试期零兼容层）。

| 类别 | 项 | 语义 |
|---|---|---|
| **读窗 `wait`** | **`closeOn`**（显式单值；缺省 = 未声明判据，缝侧按喂令查表整条注入，DEC-5）+ **`outcomes`**（结局判据表：**槽位在前、语义条目在内**——外层键 ok/fail/cooldown 槽位、内层键语义条目名，语义条目只含 patterns；patterns ≥ 1，推定槽已退役）+ **`captureFrom`**（捕获源槽，组数只对该槽 `patterns[0]` 计）+ `captures`（run 级槽名表）· `gaCount`（仅 ga，等第 N 个 GA）· `maxLines` · `flags`（默认无，白名单 `d/i/m/s/u`）· **`timeoutMs`（可省**：步声明 > 表条目 > 缝侧 30s 兜底，绝不无界等待） | **三形态组合封闭**（schema superRefine）：判据声明必须搭配 `closeOn`；quiet 无 outcomes；criteria 必须声明判据表且无 gaCount；gaCount 仅 ga；**语义条目名跨槽位禁重名**（拒存） |
| **`closeOn` 三形态** | `ga`（GA/EOR 收窗，`gaCount` 缺省 1 可设 N；**分类语义条目可选——声明即断言**：关窗无一命中 ⇒ 合成 fail 帧 +「收窗成功，分支未知」，DP 裁定 8；未声明 ⇒ 关窗即 next）/ `criteria`（**判据收窗，GA 不武装**；判定序 fail > cooldown > ok 槽位，同帧高位收束防误判）/ `quiet`（**固定采样窗**：唯一计时器 `timeoutMs`，行只累积不重置；到点有行 ⇒ 合成 ok 帧、零行 ⇒ 合成 fail 帧等同 timeout；无 outcomes） | `race` 退役、命令判据面 `quietMs` 退役（**裸读保留**——quietMs 是裸读参数，不在命令判据词汇中）；注释纪律：quiet 与 timeout 配合使用，timeout 需谨慎选择时长（编写责任非设计代价） |
| **动作 `action`**（单动作） | `send` \| `sendCredential` \| `captcha`（T14 参数化：收 `url`——值过解释器槽替换，流程捕获槽传入或写死均允许；抓图 → 推帧 → 挂起等人工码，§8.17） | 凭据占位 `{name}` / `{pass}` 由**引擎注入替换**（不经模型）；`send` 空串**拒**，`sendCredential` **允许空串**（终态空命令走凭据通道，不进发送回显）；`{captcha}` 与 T14 命名槽同为引擎替换源（非敏感，不进 pass 掩码，§8.13/§8.17） |
| **路由 `onOutcome`（两级，DEC-19）** | 外层 **kind 键直达**（`ok` / `fail` → 目标，粗粒度常态——`fail: { exit… }` 一条兜住 fail 槽位全部语义条目；**onOutcome 暂无 `cooldown` 键**——2026-10-15 Minimal 裁定，冷却命中落缺省）；细化用 **`when`**（键 = 语义条目名：⊆ 合并语义条目集且槽位一致、**不跨键位查找**——cooldown 语义条目引用进 ok/fail 键即 kind 不符拒存）。分流：**fail 未覆盖 ⇒ 结构化 timeout 出口**（运行期附未覆盖语义条目名注记，DEC-13 ③）；**cooldown 命中 ⇒ timeout 出口 + 记录**（与 fail 同款缺省，点名冷却语义条目——稍后重试信号）；**ok 未覆盖 / 无命中（ga 关窗无分类语义条目） ⇒ 走 `next`**（kind 缺省） | 目标 = `goto` \| `exit`（`stage` 分类 + `ok`；`'success'` 强制 `ok: true`）；直达与 when 两种形态互斥（schema 拒）；kind 判定标准：**达成/推进 = ok，被拒/中断/未达成/异常 = fail，频控/冷却 = cooldown（稍后重试同一命令）**（fullme 答错已按此改判 fail，重入用 when 表达） |
| **后置** | 循环 / 计算 / 条件 | JSON 表达不了的例证出现再评估（§17.3） |

## 8.11 流程面：注册表与进化闭环

| 项 | 规则 |
|---|---|
| **locked 预制** | **拒改拒删**（`login` 锁死，§8.12） |
| **非 locked** | 预制与 agent 新建均可 `save`（`version` 自增） |
| **进化闭环** | **粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试**——流程是 **agent 能力的持久化载体**；`delete` 还原预制 |
| **保存门（三门，确定性校验即生效）** | ① **zod schema 校验**（含**语义条目名跨槽位禁重名**拒存）② **`checkFlow` 结构门**（`goto` 目标存在 / `success` 的 `ok: true`；**保留字语义条目名 `ok`/`fail`/`cooldown` 拒用**（kind 寻址键防撞名，DP 裁定 7）；**kind 一致性**：when 键引用的语义条目 kind 不符即拒（不跨键位查找，静态可判的都判）；捕获配对：组数只对 `captureFrom` 槽 `patterns[0]` 计、捕获组只许出现在该处；**when/captureFrom 引用 ⊆ 合并语义条目集**（本步 `outcomes` ∪ 喂令表语义条目，经 `tableSlotsOf` 端口注入——字面量喂令已登记而缺席 ⇒ 拒存（死引用），**动态命令/未登记 ⇒ 保存期只校验静态可判的 kind 一致性，查表校验后移运行期 fail-loud**，DP 裁定 4 分档））③ **凭据红线**（§8.12） |
| **告警档（DEC-13 四处，放行但必须可见）** | ① 喂令字面量未登记表且本步未声明收窗（不收窗只等超时，DEC-4）；② `when` 未覆盖合并语义条目集内同 kind 语义条目（点名补全；直达形态 = 全覆盖不告警）；③ **运行期**：timeout 收束时附未覆盖 fail 槽位语义条目名注记；④ 同形态合并引入带 flags 的表条目而本步未声明 flags（锚定判据失活风险）。`registry.save` 返回 `{record, warnings}`，工具面透出 ⚠ 行；`list`/`get` 视图同样携带复核告警 |
| **存储** | 独立域 `mud_workflow`（**两张表**：`workflows` 生效记录 + `snapshots` 变更账本）；域不可用 ⇒ 降级内存并告警（记录与账本同在内存降级层），**内存先行、域挂上后迁入**（§14.3） |
| **迁入取新（T16）** | 迁入前逐条比对域内既有 `version`：**域内更高 ⇒ 不改域**（取新），把内存期记录**归档**为 `migration` 快照并 `warn` 点名——修复"内存先行窗口期的 save 静默把域内高版本覆盖成低版本"；迁入整体失败 ⇒ **不挂域、不清内存**（内存仍是唯一真相，宿主点名告警） |
| **变更账本（T16）** | `snapshots` 表**只追加**，键 = `` `${name}:v${version}` ``，记录 `title/flow/updatedAt/archivedAt/reason`（`save`/`delete`/`migration`）；每流程保留最近 `MAX_SNAPSHOTS_PER_FLOW`（20）个版本，超出丢最旧；`history` 按版本倒序读，`rollback(name, version)` = 取该快照的 `title`/`flow` **写一条新版本**（不原地改历史，`version` 继续单调） |
| **强审计提交（T16）** | **账本先行**（先记快照、再写生效记录）⇒ 不会出现"已生效但无账本"；账本写入失败即**本操作整体失败**（生效记录不写）。极端情况留下"已记账但未生效"的条目——它可从历史里重新回滚出来，不丢数据 |
| **词汇表演进口径（T16/T26.6）** | 域 `version` **恒为 1、不用作迁移手段**——本域走宿主 whole-unit 布局，版本不一致时宿主直接 `version-mismatch` 拒绝**整个 open**（`compatibleVersions` 只对 `per-record` 生效）⇒ 改版本 = 全部修缮记录读不出来。**T26.6 存量不管（DEC-25，测试期用户裁定）**：存储即新词汇，**读时归一（`normalizeFlow`）已删除**，`get`/`list`/`rollback` 全部 **as-written** 原样返回；旧词汇记录解析失败在装载期 fail-loud 点名，零迁移零隔离代码。配套：`wait.flags` 白名单 `d/i/m/s/u`（`g`/`y` 是**有状态**标志，读窗机逐行评估时起点由 `lastIndex` 决定，§5.2） |
| **来源标记（零 schema 变更）** | `origin: 'builtin' \| 'refined'` 由「记录在哪一层」**推导**（视图层 `entries(): WorkflowEntryView[]`），**不进持久化 schema** ⇒ 无存量记录兼容问题；`mud_workflow_list` 逐条呈现内置/修订与遮蔽标记 |
| **同名冲突裁决（2026-10-05 策略 A）** | 优先级在**读取/执行侧**也成立（不再只在保存侧）：**locked 预制 ⇒ 内置优先**——同名修缮降级为 `shadowed`（保留在存储层，`list` 标 ⚠、宿主挂载时 `warn` 点名，`mud_workflow_delete` **放行**清理；删掉只是清掉遮蔽，执行一直用内置版本）；**非 locked 预制 ⇒ 修缮优先**（`delete` 还原为预制）。修复「core3 缺席期抢名 → 内置挂载后被遮蔽且删不掉」的洞（两侧都想删/改时各自的可读拒不变） |
| **来源标记（零 schema 变更）** | `origin: 'builtin' \| 'refined'` 由「记录在哪一层」**推导**（视图层 `entries(): WorkflowEntryView[]`），**不进持久化 schema** ⇒ 无存量记录兼容问题；`mud_workflow_list` 逐条呈现内置/修订与遮蔽标记 |

## 8.12 流程面：凭据红线（双闸）

**`sendCredential` 动词只允许 locked 流程使用**：

1. **静态闸**：`registry.save` 直接拒（agent 可写的词汇表**不含**凭据动词）；
2. **执行闸**：解释器执行侧 **throw**。

**依据**：粗胚的时序错误会把凭据发进**错误窗口**（公屏 = 泄露）；`login` 锁死 ⇒ **全系统唯一凭据流程**。配合 §12.2 的三道闸，构成"凭据零泄露"的完整链条。

**红线判定扩展（T13）**：`captcha` 动作与 `sendCredential` 同列 **locked-only**（`usesCredentialVerb` 判定含 `captcha`，静态闸 + 执行闸同款双闸）——发送内容归流程动作统一声明，人工只提供码值（§8.17）。

## 8.13 流程面：解释器语义

**`runFlow` 是纯函数**。每步四拍：

```
wait（读窗，判据表） → fail 槽位出口 → action（发送） → 路由（onOutcome / next）
```

| 语义 | 规则 |
|---|---|
| **动作在路由前执行** | 步骤的应答**总发**；"条件发送"必须写成**独立步骤** |
| **`initial` 快照** | 等待前取 `pendingLines` **尾部快照**做 `initial`（提示符**先到先结算**） |
| **判据匹配单点（T15/T26.6）** | 判据匹配**只在 core3 读窗机发生一次**，结果以**命中帧** `hit`（`by` = `closeOn` 三值 + `maxLines` 四值 + `index`（条目内 pattern 下标）+ 首个命中的 `groups` + `outcome`（语义条目名）+ `kind`（ok/fail/cooldown））随读结果返回（§5.2）；解释器**不重测也不编译**——判据以 raw 声明透传（DEC-21 单点），分类（`onOutcome` 语义条目名）、捕获（`captureFrom` 槽的 `groups`）与路由都消费同一帧，三者与收窗在物理上不可能不一致。**判定序 = fail > cooldown > ok 槽位**（同帧高位收束防误判） |
| **路由分流（T26.6 两级）** | **fail 未覆盖** ⇒ **结构化 timeout 出口**（附未覆盖语义条目名注记，不静默走正常路径）；**cooldown 命中** ⇒ **timeout 出口 + 记录**（onOutcome 暂无 cooldown 键，2026-10-15 Minimal 裁定——与 fail 同款缺省，点名冷却语义条目「稍后重试同一命令」）；**ok 未覆盖 / 无命中（ga 关窗无分类语义条目 / quiet 合成 ok 帧）** ⇒ 走 `next`；无 `next` 可走 ⇒ **结构化 timeout**（**点名步骤**，粗胚修缮的失败信号，**不静默**） |
| **捕获填槽（T14/T15/T26.6）** | `captures` 声明的步（以 **`captureFrom`** 指源）：done 收束后、动作前按**命中帧**分流——① **帧命中的是 `captureFrom` 槽**：把帧里的 `groups` 按序入 **run 级命名槽**（组 1 → `captures[0]`…，组数只对该槽 `patterns[0]` 计），组缺失/空值 ⇒ **结构化 timeout 同型收束**（D11 fail-loud，不落空串进槽、不进后续 send）；② **帧命中其它槽**：该路径不需捕获 ⇒ **不捕获、不失败**，按该槽路由（分类出口可达，不吞分支）；③ **无结局命中**（ga 关窗无分类语义条目等非判据收窗）⇒ 同型 timeout（点名「本窗无「X」结局命中」）。fail 槽位收束**不捕获**；解释器本层**不做任何正则匹配**（组值由读窗机 `exec` 单次调用取得，§5.2） |
| **槽替换四源（T14）** | 次序固定：`{captcha}` → **命名槽表** → `{name}` / `{pass}`；`sendCredential` 与 captcha 动作参数走全四源，**`send` 侧不碰 `{name}`/`{pass}`**；未知 `{xxx}` **原样保留**；保留名 `captcha`/`name`/`pass` 三类存储结构性分立（不靠运行期判名防撞） |
| **槽生命周期（T14）** | run 级，两种复用情形显式分立：**重经捕获步 = 重捕获覆盖**（战斗动态词）；**未重经 = 沿用上值**（goto 跳过捕获步不清槽——fullme 答错重入 `judge → goto answer` 的正确性前提，§8.17） |
| **步转移上限 256** | 防 `goto` 环 |
| **收束出口（T26.6 修订）** | `timeout` / `signal` / `disconnected` / `danger` 与 criteria 判据失配（timeout/maxLines 剪断未命中）**一律走 timeout 出口**（语义 = 放弃等待；现场行随结果返回）；**quiet 合成帧是正常收束者**——有行 ⇒ 合成 ok 帧按 kind 路由（reason 不参与）、零行 ⇒ 合成 fail 帧等同 timeout；criteria 失配由读窗机记 error（语料可见，承 core2 纪律） |
| **出口 pass 掩码** | 出口**统一过 pass 掩码**——凭据零泄露最后一道闸（流程作者忘写也不泄露） |

**判据书写纪律（整窗匹配模型）**

匹配对象 = **整窗文本**（行按 `\n` join：core3 `read.ts` 累积 `accText`），正则一次打在整窗上，**无逐行预筛**；该匹配**只在读窗机发生一次**（§5.2），流程侧消费命中帧——系统内不存在第二套判据匹配（曾经「路由整窗、捕获逐行」的分歧根源已随 T15 消除）。作者纪律：

1. **行首锚必配 `flags: 'm'`**：无 `'m'` 时 `^`/`$` 只锚窗首（位置 0）——提示行在横幅之后永不命中（勘误 ③，§8.15）。
2. **单行意图天然行安全**：`.` 无 `/s` 不匹配 `\n`，普通模式不会意外跨行；**跨行意图必须显式**（`/s` 或字符类含 `\n`）。
3. **量词不越行**：跨行需求显式写 `\n`；否则量词优先 `\S+` / `[^\n]*` 这类不越行写法（login `NEED_NEW_SRC` 的动态用户名即 `\S+` 桥接）。

> **未来扩展方向（2026-10-03 评估否决，无例证不立项）**：「判据模式声明」——每条判据显式声明单行/多行、各跑各的、无全局兜底。否决理由：`.` 默认已行安全（防的场景是作者显式写 `/s`）；逐行匹配 = N 行 × M 条次引擎调用，比整窗 M 次扫描**更慢**；混合模式下「单行命中第 5 行 vs 多行命中第 2–8 行」与**声明序**裁定冲突。若判据库扩大后出现整窗模型下的真实误判例证，再按例证重新评估。

## 8.14 流程面：七工具与 `workflowIoFor` 缝

**七工具**（独立 preset 行；原文返回、可读拒绝、注册完整性自检）

| 工具 | 语义 |
|---|---|
| `mud_workflow_run { name }` | **白名单执行**（不接受任意路径）；模型 API `{ ok, stage, lines }`。执行链 = 归属解析（§8.5）→ 注册表取流程 → core3 `workflowIoFor` 缝 → 解释器 → `release` |
| `mud_workflow_list` / `get` / `save` / `delete` / `history` / `rollback` | 流程管理六工具：`save` 过三门并返回 `{record, warnings}`（⚠ 告警行透出，§8.11）；`locked` 本体拒改拒删；`get` 返回完整流程 JSON 供修缮（读时已归一为新词汇，§8.10）；`list` 报 `origin`（内置/修订）与被遮蔽标记；`delete` 放行被 locked 内置遮蔽的同名修订；`history` 读变更账本（版本/时间/原因倒序）；`rollback` 回滚到某个历史版本（写新版本，§8.11） |

**`workflowIoFor` 缝（core3 侧）——执行序**

```
未登记 / 未连接 ⇒ 可读错
  → 凭据解析（失败即 fail-loud，报引用名；明文不进日志/上下文）
  → acquireSend(holder)（流程独占 send+read；冲突可读错）
  → io 原语：send / sendCredential / read（返回现场行 + 收束原因 + **命中帧**，§5.2）
       · send/sendCredential 记 lastSent（**缝侧"本窗等的是哪条命令"**，T26：凭据
         命令置 null——账号数据不是游戏命令不入表，§8.6 持有者独占 ⇒ 窗口内
         无第二执行体发送，该推断结构上成立）
       · read 收 **raw 判据声明**（DEC-21：与流程 wait / 工具 listen 同一语法——
         内核不持正则），表条目合并与正则编译在本闭包单点完成
         （`resolveAwaitPlan` 形态比对：未声明 ⇒ 整条采用；同形态 ⇒ 语义条目级合并；
         异形态 ⇒ 整体替换；都无 ⇒ **不收窗只等超时**，DEC-4/5）
       · 读结果带**归因字段**：`closeOn`（生效收窗形态）/ `command`（命中的表
         条目 id）/ `source`（`'table'` \| `'declared'` \| `'empty'` \| `'none'`）
         ——action-at-a-distance 必须可排查；timeoutMs 兜底链：步声明 > 表条目
         > 缝侧 30s
       · recentLines / awaitCaptcha（§8.17）/ state（+ creds 注入）
  → release 由调用方 finally 保证
```

凭据零泄露三道闸在流程面的落位：**发送侧**（`sendCredential` 不触发 `onSend`）· **注入侧**（占位符替换不经模型）· **出口侧**（解释器 pass 掩码）。

## 8.15 login 实体（locked）

声明文件：**[flows/login.md](../flows/login.md)**（本节只写语义要点与勘误）。

**步表（7 步 + `success` 出口；步预算 30s，终态兜底 5s；T26 已改写为具名语义条目——`closeOn: 'criteria'` + `outcomes` + `onOutcome`，flags `m`；权威表见 [flows/login.md](../flows/login.md)）**

| # | 步 | 读窗 `outcomes` | 动作 `action` | 路由 |
|---|---|---|---|---|
| 1 | `prompt-name` | `名字提示`(ok)：名字提示（两形态） | `sendCredential: '{name}'` | `next → prompt-pass` |
| 2 | `prompt-pass` | `需建新人物`(fail)：用户名不存在/非法；`密码提示`(ok)：密码提示 | `sendCredential: '{pass}'` | `onOutcome.fail` **直达** `exit(need-new, ok:false)`（粗粒度常态——唯一 fail 槽位零语义条目名）；`密码提示`（ok 未覆盖）→ `next → confirm` |
| 3 | `confirm` | `密码错误`(fail)：密码错误类；`需替换`(ok)：替换提示；`登录成功`(ok)：成功句 | **无动作**（接收 `{pass}` 应答的那一窗） | `onOutcome.fail` **直达** `exit(bad-pass, ok:false)`；`onOutcome.ok.when 需替换 → replace`（细化）；`登录成功`（ok 未覆盖）→ `next → send-empty` |
| 4 | `replace` | — | `send: 'y'` | `next → wait-success` |
| 5 | `wait-success` | `登录成功`(ok)：成功句 | — | `next → send-empty` |
| 6 | `send-empty` | — | `sendCredential: ''`（空命令） | `next → wait-ga` |
| 7 | `wait-ga` | `closeOn: 'ga'`（gaCount 缺省 1 不必写；**未声明分类语义条目**——关窗即 next，5s 兜底） | — | `next → exit(success, ok:true)` |

**两条实测勘误（E2E 确证，已采纳）**

1. **fail 槽位归窗**：失败分类是**被应答的那一窗**的事——「需要创建新人物」是 `{name}` 的应答（挂 `prompt-pass`），「密码错误」是 `{pass}` 的应答（挂 `confirm`）。**反例**：把「密码错误」挂在发送前等 driver 的窗，那一窗在密码发出前就已关闭，**永远赶不到**。
2. **「欢迎来到」不可用作成功句**：与建连横幅「欢迎来到北大侠客行」**撞车**（登录前即到达会误判成功）；成功句以「**目前权限：(player)**」「**重新连线完毕**」为准。

**边界**

- **连接守卫不在流程表**：`workflowIoFor` 在 io 注入前就拒绝未连接（§8.14）。
- **验证码链路独立成流程**（T13 已交付）：`fullme` locked 实体（**流程可等人工**——`captcha` 动作挂起等 WebUI 弹窗输入，原「流程不能等人工」约束随 T13 废止），见 §8.17 + [flows/fullme.md](../flows/fullme.md)。
- **失败不设恢复路径**：不自作主张重试；失败以结构化出口返回给子 agent（§7.6）。

## 8.16 已知限制

- **超长回合 + 持续刷屏**：`pendingLines` 可积累至环形上限；`turn/end` 一次拉取可能拆成多条 followup 排队。
  - 处置：**不引机制**——等 token 账目恶化的实证再按例证加投递策略化（§17.3）。
- **工具面与流程面共享持有者**：长流程执行期间工具调用会被拒（可读），这是设计意图（独占保证应答不劈半）。
- **流程表达力**：循环/计算/条件不支持（§8.10 后置）。

## 8.17 fullme 实体与人工验证码链路（T13，locked）

**口径修订（T13 定稿）**：原「流程不能等人工」是简版解释器阶段的实施约束，随本链路**废止**——委派已前台化，流程在工具调用内前台执行，`captcha` 动作挂起等人工与工具等待等价。触发 = **被动处置**：agent 判系统提示/信息降级后跑 `fullme`（不发周期探针）；超时/中止是常规路径。

**词汇表扩展（T13）**

| 项 | 语义 |
|---|---|
| `captcha` 动作 | **收 `url` 参数**（T14 D9：`{ captcha: { url } }`，值过解释器槽替换——`{captchaUrl}` 捕获槽传入或写死 URL 均允许）；执行序 = 抓图（Node fetch 抓页取 `<img src>` → base64 data URL，fetch 注入可单测）→ 推帧 → 挂起等人工码 → 值入 `{captcha}` 固定单槽。原「内置捕获 URL（扫 `recentLines`）」随 T14 **净删**（URL 捕获上移为流程声明捕获） |
| **locked-only** | 与 `sendCredential` 同列红线双闸（§8.12） |
| `{captcha}` 槽 | run 级固定单槽；`send`/`sendCredential` 均替换；**非敏感**——不进凭据红线与 pass 掩码。T14 命名槽（§8.13）加入后保留名不共用存储 |
| `awaitCaptcha(url: string)` io 原语 | T14 D8 URL 参数化，**契约单点**（§8.8 A1）：端口声明在 mud-workflow 契约层 `contract/ports.ts`（`WorkflowIO<L>.awaitCaptcha`），core3 `workflowIoFor` 缝实现按编译期断言对齐（`MudCore3Handle extends WorkflowIoSeam<MudLine>`）；URL 由流程捕获槽传入，闭包自取消失；resolve 恢复帧 `{kind:'answer',value} \| {kind:'aborted'} \| {kind:'closed'}`，解释器按 kind 分流（aborted = 专用出口 stage `aborted`；closed = timeout 出口） |
| checkFlow 门 | captcha 步**不设 wait 门**（answer 是纯动作步，结构收束由 judge 窗承担；挂起预算走 Config 不依赖步 timeoutMs） |

**双预算分立（先后串行不竞争）**：步 `timeoutMs` 只管读窗（等 URL/判据行）；**挂起预算 = Config `captchaTimeoutMs`**（缺省 180_000 = URL 有效期 3 分钟；**独立预算**，不受 MAX_TIMEOUT_MS/silenceMs 校验约束）。计时每轮独立，刷新不重置当前轮。

**等待注册表（core3 service）**：单会话单槽（并发冲突可读拒，I10 精神）；**窄缓存保留（T14 D7）**——URL 由参数传入（`cachedEntry.url === url` 比对），同 URL（答错重入，同轮无重发引子）沿用缓存图**不重抓**，refresh 原地更新 image，新 URL（新一轮 fullme）新抓新周期；原「URL 锚定自取」删除，URL 缺失的报错点前移到 urlwait 结构化 timeout。**三条退出路径统一 `resolve closed` 不 reject**：① 断线 = runtime onClose 钩子；② 会话销毁/插件卸载 = dispose 链清等待表；③ 宿主取消回合 = `mud_workflow_run` 的 `exec.signal` abort → handle `cancel()`。挂起期**持有 send 锁** ⇒ busy 谓词恒真 ⇒ 探测 tick 抑制（§3.2），行流照常录制。

**remote 四动词（§15.1）**：`watchCaptcha()`（`mode:'stream'`，**首帧补推当前挂起态**——页面刷新/重开恢复弹窗；变化推全量快照帧，行摘除 = 清除帧）+ `captchaAnswer(sessionId, value)`（提交，trim）/ `captchaAbort(sessionId)`（中止 → `aborted` 收束）/ `captchaRefresh(sessionId)`（重抓同 URL，**每轮挂起限 1 次**——服务端同 URL 共 4 次刷新机会；超配额可读拒）。

**webui 呈现（§9.7）**：全局弹窗独立订阅 `watchCaptcha`（与画面 tab 无关）；DSH 标准弹窗 = 图片 / 提示行（来源账号名）+ 刷新图标（本轮已用置灰）/ 输入框 / 中止 + 提交；收束（提交/中止/断线/销毁/超时）服务端推清除帧关窗；提交/中止后本地不清窗——答错重入服务端重推帧（缓存图重现，刷新可再点 1 次）；多会话并发（罕见）按最新帧呈现，未呈现的照常等 + 超时兜底。

**fullme 实体（locked；声明文件 [flows/fullme.md](../flows/fullme.md)；T26.6 已改写为两级路由词汇）**：主链四段 `request`（发 `fullme`）→ `urlwait`（等 robot.php URL，**outcomes**：`验证码地址`(ok) = URL 行 + `captureFrom: '验证码地址'` + `captures: ['captchaUrl']`——组 1 入槽，捕获源具名化、组数只对该槽 `patterns[0]` 计；仅首轮锚定，答错重入跳过本步沿槽上值；`已挂起`(fail) = stale 句 / `冷却中`(fail) = 冷却句，**两 fail 分支不同 ⇒ `onOutcome.fail.when` 细化**；URL 行未出现 ⇒ 本步结构化 timeout，报错点前移）→ `answer`（captcha 动作，url = `{captchaUrl}`）→ `send-code`（发 `fullme {captcha}`）→ `judge`（**outcomes**：`答对`(ok) → `onOutcome.ok` 直达 success；`答错`(**fail**——信号视角改判 T26.6/DEC-19：被拒是 fail，重入用 when 表达) → `onOutcome.fail.when 答错 → goto answer` 重入，不重发引子——服务端每次 fullme 只回一次 URL；`失效`(fail) → when 失效 → expired）。**stale 自愈环**：urlwait `已挂起` 语义条目命中 → `abandon1/2/3` 三连 `fullme 1` 放弃悬挂态 → **结构化 fail 收束不重试**（服务端事实：放弃后约 15 分钟冷却，立即重试必再 stale）。answer 后必跟 judge 收束窗——fullme 应答被窗口消费（readAbs 推进）不进投递（答案行不上浮 agent）。判据语料 v1 实录起步（附录 A 同源七常量），实机触发时校准。

> AI生成