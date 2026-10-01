# mud-core3 计划起草区

> **当前状态（2026-10-02）**：一、二期已交付（二期实施并入三期 T2a/T2b，总结见下）；三期进行中——T1–T3 已交付，T4a 已交付（kickoff 任务书 + 静默唤醒，见三期节 T4 实施计划），当前 = T4b persona + E2E 实机。已裁定 `packages/mud-core2` 原位退役。
>
> **文件角色**：总体规划纲要 + 切片详细设计起草区。详细设计在实施前再细化，不提前展开。

## 总体规划纲要

每个期只命名工作范围与触发条件，不预做详细设计。实施时按切片细化，落地后同步 `doc/architecture/` 并登记 `CHANGELOG`。

### 第一期：基础设施 + MUD→agent 投递（已交付）

> **总结**：C1 包骨架与 `link/` 移植（telnet/ansi/行流/LoginGate + 回放用例）、C2 多会话（roster storage + 会话装配 + 手工 connect/disconnect + 生命周期）、C3 投递与接入（建账号链路 = 自动会话 + preset 选择、mud-player preset 行、聚合投递、admit/stop 接入闸门与水位）、C4 管理面接线替换（mud-webui 呈现不改）、C5 游戏画面视图（右侧栏只读画面：headless 无头屏 + `follow` 流动词 + webui `mud-game` tab）、C5.1 状态推送（`watchStatus` 服务端推送替代轮询）全部交付，132 项用例全绿；「行流投递通道走通 + agent 回答正确」的地基验证点已确认。设计事实源 = [`architecture/00-core.md`](architecture/00-core.md) §1–§5（投递与闸门 §3.4、画面 tab 与 watchStatus §3.5），切片记录 §4.1；C5/C5.1 详细设计原稿随实施同步 §3.5 后删除，画面通道后置项（输入回传/NAWS/回显去重/历史持久化）并入 §5 后置清单。

### 第二期：工具面（设计定稿；实施并入三期 T2a/T2b 交付）

> **总结**：工具面详细设计（水位线 pull 模型、ReadMachine 判定序、裸读语义、`mud_state` 不受闸门、禁词表最小集）已同步正式章节 [`architecture/00-core.md`](architecture/00-core.md) §3.3（现役，含三期修订）；实施随三期 T2a（ReadMachine + 水位线 + deliver pull 化）与 T2b（`mud_connect`/`mud_send`/`mud_state` 三工具 + 禁发表 + 会话级持有者 + 归属父链上溯）交付。原「未接入可读拒绝」「连接是手工动词」两项预设约束已被三期裁定取代（`mud_send` 只拒未连接、连接升格为工具，见三期节「与二期/既有设计的关系」）。

### 第三期：业务行为（根规划 / 子执行 / 脚本步骤）

> **触发**：工具面落地后，agent 需要**自主完成业务行为**（登录、查看状态、完成补给），且要能在无人干预时自己动起来。
> **范围**：三工具放开连接权限；两轴状态与会话世界状态；要点序列执行（根规划 / 子执行 / 脚本步骤）；登录脚本；静默唤醒。四期及以后只作粗略排布，可随讨论调整。
> **状态（2026-10-02）**：开工。切片 T1–T5 串行（T2/T3 共享 send 路径，不并行），每片完成即交付点。T1 已交付（140/140 用例全绿，含新增 8 例）；T2 已交付（T2a 二期地基 + T2b 工具面，192/192 用例全绿，15 文件；`mud_connect`/`mud_send`/`mud_state` 三工具 + 禁发表全段扫描 + 会话级持有者 + 归属父链上溯 + preset.ts 注册与 persona 措辞）；T3 已交付（脚本面：`mud_workflow_run` + `workflows/login.ts` + 盲发退役 + `sendCredential`，206/206 用例全绿，16 文件，T3 交付勘误见登录脚本节）；T4a 已交付（kickoff 任务书 + 静默唤醒，207/207 用例全绿，16 文件，交付勘误见 T4 实施计划节）；T4b persona 已交付（分工协议五条入 cordis.patch.yml persona，纯书写约定），**待实机验收**（清单见 T4 实施计划节 T4b 实机验收清单）。
>
> **T2 范围裁定（2026-10-01）**：核查发现 core3 二期工具面从未实施（无 read.ts/tools.ts/preset.ts，§3.3 仍标后置），T2 实际 = 二期全部设计（ReadMachine + 水位线 + deliver pull 化 + turn/end 驱动，现落 §3.3）+ 三期语义一次到位（**跳过 admit 闸门中间态**）。T2 拆两个子片串行：
>
> | 子片 | 内容 | 验收 |
> |---|---|---|
> | T2a 二期地基 | `src/read.ts` ReadMachine（判定序 failOn>until>gaCount>maxLines + quiet/timeout/signal/disconnected/danger 收束 + swallow 钩子）+ runtime 水位线（deliveredAbs/readAbs，pending 单一真相）+ deliver pull 化（turn/start 抑制、turn/end 冲刷、未接入零积累、失败不丢行） | read 与投递不重复不丢行；turn/end 一次冲刷；裸读推水位 |
> | T2b 工具面 | `mud_connect`（幂等）+ `mud_send`（只拒未连接，无 admit 闸门；deny `{suicide}` 全段扫描先行）+ 会话级持有者 + 归属父链上溯（toolContextFor）+ `mud_state`（插件状态+world 合并）+ preset.ts 注册 + cordis.patch.yml 接线 + persona 措辞 | 子会话经父链解析到 runtime；并发 send 可读拒绝不劈半；未连接可读拒绝 |

| 切片 | 内容 | 验收 |
|---|---|---|
| T1 状态地基 | 两轴状态（conn/loggedIn）+ GMCP 事件接线（`telnet.ts` gmcp emit → world 分区）+ world 状态组织（分区/置信度/来源追溯，后到覆盖） | 登录后 GMCP 置 `in-game`（不依赖行文匹配）；断线两轴复位；两会话 world 隔离 |
| T2 工具面改造 | `mud_connect`（幂等）+ `mud_send` 拒绝序调整（去 admit，只拒未连接）+ 会话级持有者 + 归属父链上溯 + `mud_state` 合并 world | 子会话经父链解析到 runtime；并发 send 可读拒绝不劈半；未连接可读拒绝 |
| T3 脚本面 | `mud_workflow_run` + `sendCredential` 变体 + `workflows/login.js` + 盲发退役（connect 只建连） | login 成功/失败结构化返回（失败三分类 + success）；凭据零泄露；手动 connect 停在登录提示符（语义拆分生效） |
| T4 自主行为 | kickoff 任务书（bootstrap/admit）+ 静默唤醒 120s + 根委派子执行要点（宿主 subagent continuable）+ persona | 端到端：建账号 → 任务书 → 根规划 → 委派 → 登录完成 → 结算唤醒；中途失败根被唤醒重写规划 |
| T5 收尾 | webui 状态呈现（loggedIn/world）+ 文档同步 + 零回归 | 一二期验收不回归 |

**T1 前的前置验证**（随 T1 开工第一步）：① 宿主空闲事件可用性（静默唤醒依赖「agent 空闲」判定，T4 前确认即可）；② `isConcurrencySafe: false` 的宿主语义（排队还是拒绝，决定 T2 持有者落点）；③ 宿主 subagent continuable 结算实测（T4 地基）。

**分工模型（三层，各管一段）**

```
根 agent          规划「要点」（如：连接 / 登录 / 取状态 / 补充食物水）
  │  委派【要点序列】给一个子 agent（宿主原生 subagent 工具，backgroundMode=continuable）
  │  委派后 idle → 休眠，不参与执行
  ↓
子 agent          串行执行要点（无意图、有执行智能）
  │  成功 → 下一个要点，不逐个回报
  │  任一步失败 → 停止执行，收尾文本写明现场
  ↓  全部完成 / 中途失败 → 终结（子不常驻）
结算（宿主原生）  → 父 idle 时开新回合唤醒根 → 根消化现场 → 重写规划
      ↑
脚本 workflows/*.js   点内的确定性步骤（提示符驱动 + 读应答 + 判据）
                      只做序列与判据，不做决策、不自行重试；失败原样返回给子
```

- 脚本管**点内步骤**，子 agent 管**点间顺序与执行智能**，根管**要点的产生与重写**——三者互不越界；
- 脚本不是必需路径：确定性要点（登录）用脚本，"补充食物水"这类靠执行智能的要点由子 agent 直接用 `mud_send`/`mud_state` 完成；
- **一次委派 = 一次结算**：子必须终结（全部完成或失败停止），否则根永不醒；
- **连接与登录是两个独立要点**：根已判定"已连接"时，子拿到的第一个要点就是"登录"，子不管 connect；未连接时，根把"连接"作为第一个要点，子自然调用 connect。判断归根，执行归子，脚本不猜。

**工具清单**

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `mud_connect` | 建连（幂等：已连接直接返回成功，不重连、不踢已登录会话） | 模型可自行调用（二期「连接是手工动词」的约束在本期放开）；不设审批，手动按钮只是第二个调用者 |
| `mud_send` | 发命令 + 等应答（判据驱动） | **只对"未连接"设限**（未连接什么都发不出去，可读拒绝；**不受接入闸门**，裁定见下节）；**不要求已登录**，是否已登录由模型自行判断；禁发表最小集 `{suicide}` 全段扫描；应答作为**调用方**的工具结果返回 |
| `mud_state` | 状态快照（**插件状态 + 世界状态合并**，全体 agent 共读） | 不受闸门/连接约束，只过归属（模型要能答"我未接入"） |

`mud_workflow_run({ name, input })`：执行注册脚本（**白名单**，不接受任意路径）；进程内执行，插件注入 `send`/`read`/`state` 原语；**凭据不出进程**（脚本经 `sendCredential` 变体发送：不回显、不落盘、不进会话日志）。

**状态面**

```
conn:      disconnected | connecting | connected      ← 传输轴
loggedIn:  unknown | in-game                          ← 登录轴（断线复位为 unknown，不是 false）
world:     GMCP 事件驱动（HP / 口渴 / 位置 / 登录态 / 金钱 …按需生长）
```

- **GMCP 是权威登录信号**，接收端零新增：`link/telnet.ts` 已实现协商与子协商（`this.emit('gmcp', …)`），本期只需把该事件接到会话世界状态；
- **断线同时反转两轴**：`conn → disconnected` + `loggedIn → unknown`；
- 两轴 + `world` + `admitted` 一起进 `status` / `watchStatus` / `mud_state`，**所有 agent 共读**（子 agent 是消耗品，状态不能只存在它脑子里）；
- `world` 由 GMCP 事件写入，**行级规则后置**（无例证不建规则层）。

**应答与水位**

回答"谁发谁读"：`mud_send` 的应答作为**发起方的工具结果**返回，不进别人的上下文——这是"子 agent 执行要点"能成立的地基。read 判定序、裸读语义、水位线（`deliveredAbs`/`readAbs`）沿用二期 pull 模型（§3.3），本期不改。

**归属解析（工具执行上下文）**

```
toolContextFor(agent):
  s = agent.session.header.id
  while s !== undefined:
     if roster.accounts[s] → 用它的 runtime
     s = header(s).parentSession
  → 拒绝「本会话未绑定 MUD 账号」
```

根调用命中自身；直接子会话（根用 `subagent` 派发）沿父链上溯即命中账号会话。不开 `mud_send({ sessionId })` 参数，避免跨账号后门。

> **实现勘误（2026-10-01，宿主核查后裁定）**：`header(s)` 的解析**不自建归属状态**（原实现曾在 agent/created 自记 parentBySession Map——时序耦合、双处清理、装载时序遗漏面，已删）。官方机制：归属权威 = 持久化 `session.header.parentSession`（subagent 派发与 workflow 产生 agent 都写入；workflow PTC host 传 `parent: this.parent`，workflow agent 亦归属触发会话链）；按 id 查会话走宿主官方注册表 `ctx.agents.get(id)`（AgentRegistry，agent id ≡ session id）。祖先**必须 live**（与官方 `authorizeLineage` 语义一致）：父不 live → 上溯终止 → 可读拒绝，不以陈旧状态解析成功。

**行流持有者（并发保护）**

根与在途子 agent 都可能发命令（"争半截应答"）。core3 一期因"单会话单 agent"砍掉了持有者；本期子 agent 引入后**补回会话级唯一持有者**：同一时刻只允许一个执行体在 `send`+read，冲突即可读拒绝。

**kickoff 面（规划怎么被触发）**

- **建账号 bootstrap**：开场消息从「请确认就绪，不要调用任何工具」改为**任务书**（服务器/账号/两轴状态 + 目标：确保连接与登录）；
- **admit（保持纯闸门语义）**：开闸门**并**投递一条状态任务书 → 根开回合规划；
- admit 之前的手工「连接」按钮不触发规划（手动连接 = 调试用途；未接入无唤醒，登录自理）；**已接入场景下手动连接/断线后的补登录由静默唤醒兜底**——根醒来读状态（已连接未登录）自主规划登录，`mud_connect` 幂等不重连（2026-09-30 裁定）；
- 两者共用同一投递面 `kickoff(sessionId, reason)`。

**静默到期唤醒（自主行为的入口）**

已接入 + agent 空闲 + 静默 **120s**（Config，缺省对齐 core2 §19 的 `silence 120s`）→ 开一回合，正文 = 状态 + 目标；**前置 = 已接入**（§3.4 闸门）。agent 在回合中时静默到期不叠加。

**登录脚本（本期第一个脚本）**

`workflows/login.js` 覆盖 `name → pass → [replace | success]` 四步（[mud-core/flows/login.md](mud-core/flows/login.md) 的判据**严格照抄**：driver 两条/全句字面、fail 三条、成功句两条，不缩减不放宽）；失败分类原样返回（`bad-pass` / `need-new` / `timeout` + 现场行）；**replace 默认答 y**（login.md replace 步 action = `mud_send { cmd:'y' }`，2026-10-01 裁定：脚本按流程应答，答后直接等成功句，原「不擅自答 y」裁定作废）；入口看连接状态（非 connected 直接失败返回，提示符提前到达由 initial 快照先到先结算）；验证码链路不进脚本（脚本不能等人工），人工环节留在 agent 层。

**T3 交付勘误（2026-10-01，实施实测两处判据修正）**：

- **failOn 归窗**：失败分类（`need-new`/`bad-pass`）是**发送后的应答**，按 login.md「本步结果 = 下一步的新文本」，failOn 必须挂在**发送后的那一窗**（名字的失败挂在等「请输入密码」的窗，密码的失败挂在等「替换 | 成功句」的窗）；挂在发送前等 driver 的窗上永远赶不到（失败行比 driver 后到）——E2E 实测确认（首轮实现错挂，bad-pass/need-new 均误报 timeout）；
- **`欢迎来到` 成功句不可用**：login.md 的第三条成功句（估计项）与建连横幅「欢迎来到北大侠客行」撞车——横幅登录前即到达，步 3 的 initial 快照会立即误判成登录成功（实测确认）。脚本剔除该判据，成功句以「目前权限：(player)」「重新连线完毕」为准，待实录补充。

**流程面演进：声明式流程注册表（2026-10-01 起草；包裁定已定稿——独立子包 `mud-workflow`，骨架 + 接线已交付）**

> **愿景（用户方向）**：流程 = agent 能力的持久化载体——agent 经流程管理工具改进流程，流程程序化执行（1 次工具调用、0 次模型调用）；流程进化 = agent 能力进化。先于 T4 研究定稿。

- **包裁定（2026-10-01，用户定稿）**：流程面独立成包 `packages/mud-workflow`（与 mud-webui/mud-core3 同级）——挂载即提供流程能力（`ctx.provide('mudWorkflow')`），工具面走独立 preset 行（run + 管理四工具）。**骨架已交付**：`schema.ts`（词汇表 zod + checkFlow 结构门，含 `flags` 多行锚字段）、`registry.ts`（locked 预制 + agent 修缮；storage 域 `mud_workflow`，域名受宿主 UNIT_NAME_RE 无连字符约束）、`interpreter.ts`（`runFlow` 纯函数：wait → failOn 出口 → action → 路由，本窗文本按声明序重测定分支，步转移上限 256 防 goto 环，出口统一 pass 掩码）、`tools.ts`（五工具，注册完整性自检）。
- **接线切片（2026-10-01 已交付）**：① core3 `workflowEnvFor(sessionId, holder)` 缝（未登记/未连接/凭据解析/持有者冲突四道可读错 + env 原语 + release；core3 工具面退役 `mud_workflow_run` 收回三工具，`MudCore3Handle` 以 `workflowEnvFor` 换 `runWorkflow`，workflow.ts 瘦身为 env 结构面、`workflows/login.ts` 删除）；② `mud_workflow_run` 平移至 mud-workflow 工具面（模型 API `{ name } → { ok, stage, lines }` 不变），执行链 = 归属解析 → 注册表取流程 → envFor 缝 → 解释器 → release；③ login 平移为 locked 流程（判据严格照 login.md 定稿 + 两处实测勘误），T3 E2E 五路径随迁（`test/login.spec.ts`，core3 加 `./runtime` export 供跨包 E2E）；④ cordis.patch.yml 加 `mud-workflow-tools` preset 行 + `mud-workflow` 引擎行，persona 补流程工具一句。**全绿**：core3 198/198（16 文件）+ mud-workflow 36/36（4 文件，含 login E2E）。
- **纯度裁定（2026-10-01，用户）**：**流程实体归 core3，mud-workflow 是纯架构**（schema/注册表/解释器/工具面，不含任何具体流程）——login 实体落 `mud-core3/src/flows/login.ts`（type-only import mud-workflow 词汇表类型），经 `ctx.provide('mudCore3', { builtinFlows })` 交给 mud-workflow 注册表挂载（`registry.registerBuiltins`，fail-loud 校验，幂等、不触碰 agent 修缮层）；mud-workflow 零具体数据，测试经 core3 `./flows` export 读实体。**全绿保持**（core3 198/198 + mud-workflow 36/36，typecheck 双绿）。

- **形态：流程本体 = JSON 声明式步骤表**（非脚本文本）。与 login.md 流程表（driver/action/settle/classify/next）同构——T3 的 `login.ts` 本就是这张表的手写解释器，JSON 化 = 表与解释器分离，表变数据；
- **信任极简**：JSON 无任意代码，schema + 词汇表白名单 = 静态可验证的安全；执行器 = 进程内解释器（复用 WorkflowEnv 原语），无沙箱、无 ptcRuntime、零新宿主依赖；
- **工具面**：`mud_workflow_run`（执行，模型 API 不变，T4 不被阻塞）+ 流程管理工具（list/get/save/delete；save 过 schema 校验，`locked` 拒改）；
- **锁定与进化**：`locked: true`（login）固化锁死；其余预制流程 agent 可改——粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试 = 进化闭环；
- **红线（例证待裁定）**：`sendCredential` 动词**只允许 locked 流程使用**，agent 可写词汇表不含凭据动词——粗胚时序错误会把凭据发进错误窗口（公屏 = 泄露），login 锁死 = 全系统唯一凭据流程；
- **第一版词汇表（从 login 提炼，够用再长）**：读窗（until/failOn/gaCount/timeoutMs/initial 快照）+ 动作（send / sendCredential / 空命令）+ 分支（命中后继 driver）+ 分类出口（stage）；循环/计算/条件后置；
- **取舍记录**：`ctx.workflowEngine` 否决（六全局写死无桥，guest-source.ts 核实）；`ptcRuntime` + 脚本文本后置（表达力强但信任面大——校验门/沙箱/凭据注入，等「JSON 表达不了」的例证再评估）；
- **待定决策**：① 生效门（倾向 schema 校验即生效——校验是确定性的，且受限词汇表下脚本无能力面扩张；registry.save 已按此实现）；② 存储（已定：独立域 `mud_workflow` 的 workflows 表，域不可用降级内存）；③ 参数化（args 占位符）后置——凭据占位 `{name}/{pass}` 已先行（引擎注入替换，不经模型）；④ 平移路径（已实施：login 平移为 locked 流程 + T3 用例随迁，见上接线切片）。

**T4 实施计划（2026-10-01 起草，待定稿）**

> **前置验证结论（源码确证，宿主 `packages/subagent/subagent/src/continuation-activation.ts`）**：
> ① 空闲判定 = `agent.whenIdle()`（宿主结算观察者同款，L729）；插件侧回合状态由已接线的 `turn/start`/`turn/end` 维护即可；
> ② `isConcurrencySafe: false` 语义已在 T2 实测（持有者落点）；
> ③ subagent continuable 结算 = `watchSettlement`（L725-790）：子 agent 到 `whenIdle()` 且 inbox 无 pending、无 ownedChildren → 结算 dispose → 结算单投递 `parentSession`（父空闲开新回合 / 运行中步边界插话，正文 = 子级非空文本块）——**一次委派=一次结算由宿主保证，插件零代码**；预算耗尽的超时失败本身也是一次结算通知（core2 已核）；
> ④ subagent 工具已在 preset 挂载（cordis.patch.yml `tool-subagent` spawn/continuable + `subagent_fork`），T4 无需新挂工具。

| 子片 | 内容 | 验收 |
|---|---|---|
| T4a kickoff 任务书 + 静默唤醒 | bootstrap 文案改任务书 + `kickoff` 投递面 + 静默唤醒器（行到达 re-arm）+ `'mud-wake'` 署名 + Config `silenceMs` | 静默 120s 且空闲 → 投状态任务书；回合中/有在途 read 不唤醒只 re-arm；未接入不唤醒；admit 触发 kickoff；bootstrap 文案为任务书（含两轴状态 + 目标） |
| T4b persona + 委派语义 + E2E 实机 | persona 增补分工三层书写约定（根规划要点→委派一个子执行→子串行、失败停写现场→一次委派一次结算→根消化重写规划；纯书写约定无代码解析）+ 实机验收清单 | 实机端到端：建账号 → 任务书回合 → 根委派（subagent continuable）→ 子登录完成 → 结算唤醒根；中途失败 → 结算带现场 → 根重写规划；静默唤醒兜底补登录 |

**T4a 详细设计**：

- **任务书面（`bootstrap.ts` 退役 + `service.kickoff(sessionId, reason)`；2026-10-01 用户裁定两则）**：bootstrap 与 admit 共用同一投递面 `kickoff`；正文 = 服务器/账号事实 + 两轴状态（conn/loggedIn）+ 目标（状态驱动：根醒来读状态自行规划，不写指令序列）。**bootstrap.ts 文件退役**：不设独立文案模块，模板走插件 Config——`MudCore3Config` 加 `taskBrief`（任务书模板，占位符 `{{serverName}}`/`{{endpoint}}`/`{{account}}`/`{{conn}}`/`{{loggedIn}}`，投递时以实时状态填充；缺省内置在接线层常量），bootstrap、admit、静默唤醒三个触发点统一从 config 读同一模板。bootstrap 文案从「请确认就绪，不要调用任何工具」改为任务书；admit 开闸门时投状态任务书触发规划（保持纯闸门语义 + 投递一条，两动作合一）。
- **静默唤醒器（新 `src/wake.ts`，参照 core2 wake 形态裁剪）**：每会话一实例；**行到达即 re-arm**（runtime 加行到达钩子 `onActivity`，喂给 wake；单 timer、到期驱动）；到期守卫 = 已接入（闸门前置）+ 非回合中（复用 turn/start/turn/end 维护的 inTurn 状态）+ 行流持有者空闲（无在途 read/send）——三者任一不满足只 re-arm 不唤醒；命中 → followup 任务书。**不做**"无子 agent 在途"与"结算已消化"守卫（core2 V7 纪律：接受冗余唤醒，根的决策输入是正文不是唤醒次数）。
- **wake 署名**：声明合并自扩 `'mud-wake'` kind（core2 `index.ts:77` 同款），唤醒消息与 MUD 行投递（`'mud'`）署名区分。
- **Config**：`silenceMs` 缺省 120_000（对齐 §19 silence）。
- **测试面（vitest 先红后绿）**：到期守卫三条件逐一验证；行到达 re-arm；命中投递正文含两轴状态；admit 触发 kickoff；taskBrief 模板填充断言（缺省内置 + config 覆盖生效）。

**T4a 交付勘误（2026-10-02，实施落点两处偏离设计）**：

- **模板常量落纯层 `wake.ts` 而非 index.ts**：index 挂 typert 装饰器，vitest 无法转换其导入（测试 import 即 SyntaxError）——`DEFAULT_TASK_BRIEF`/`fillTaskBrief`/`TaskBriefFacts` 落 wake.ts，接线层 `Config.taskBrief` 缺省引用该常量，语义不变（仍无独立文案模块）；
- **admit 触发 kickoff 经 service 依赖注入**：kickoff 投递面（正文组装）在 index.ts（需要 store/config/agentMap），admit 触发点走 `MudServiceDeps.onAdmit` 回调（与 deliver 同款 DI），service 层可测「admit 触发一次/stop 不触发」。

**T4a 交付清单（2026-10-02）**：`src/wake.ts`（Wake 单 timer + 到期三守卫 + arm/dispose + 任务书面）+ `src/bootstrap.ts` 退役 + index.ts 接线（Config `taskBrief`/`silenceMs`（缺省 120_000）、`kickoff` 投递面（署名 'mud-wake'）、announce 改任务书、admit 经 onAdmit 投任务书、每会话 Wake 实例装配 + session/disposed 与插件卸载拆卸）+ runtime `onActivity` 钩子与 `holderBusy` getter + deliver `isInTurn` getter。测试 207/207 全绿（16 文件；wake.spec 新增 10 例，bootstrap.spec 2 例随文件退役，service onAdmit 1 例）；typecheck/build 绿。

**T4b persona 交付（2026-10-02）**：cordis.patch.yml mud-player persona 增补「分工协议」五条（根/子同读、按角色行事）：①根 = 读状态 → 拆自足要点序列 → subagent（continuable）委派 → 休眠等结算，判断归根不亲执；②子 = 串行执行、失败即停写现场、执行完必须终结；③一次委派 = 一次结算；④要点承载分界（脚本点内 / 子点间 / 根要点产生与重写，子不重规划不擅自重试）；⑤静默唤醒 = 按根角色重读状态继续规划。纯书写约定，无代码解析（V7 纪律）。

**T4b 实机验收清单（真机 + 凭据，逐项勾验）**：

- [ ] 1. 建账号 → 收到任务书回合（会话脱离 blank，正文含服务器/账号/两轴实时状态）
- [ ] 2. admit → 收到状态任务书，根开回合读状态并产出规划
- [ ] 3. 根委派（subagent，continuable）→ 子跑 login 流程登录成功 → 子终结 → 结算唤醒根 → 根消化后收尾（一次委派 = 一次结算）
- [ ] 4. 中途失败（错密码）→ 子停止并写明现场 → 结算带现场唤醒根 → 根重写规划（不重做已完成步骤）
- [ ] 5. 静默唤醒兜底：已接入 + 根空闲 + 行流静默 120s → 根收到状态任务书，自主补登录
- [ ] 6. admit 前手动「连接」不触发规划（调试语义不回归）
- [ ] 7. 零回归：webui 三 tab、mud 三工具、login 流程五路径、207 单测不回归

**T4 后置（无例证不加）**：deadline 登记/预算 interrupt（core2 机制，宿主结算已兜底超时失败）；危险唤醒；子级状态登记（子级状态归宿主）。

**验收断言**

| 断言 | 内容 |
|---|---|
| 连接能力 | 模型可自行 connect；已连接时幂等成功且不踢掉已登录会话；手动按钮同样生效 |
| 两轴状态 | 未连接 / 已连接未登录 / 已登录三态可读可区分；断线后 `loggedIn` 复位为 `unknown` |
| GMCP | 登录后 GMCP 包到达 → world 更新 + `loggedIn='in-game'`（不依赖行文匹配） |
| 要点序列 | 根委派一个要点序列 → 子串行执行 → 全部完成只结算一次；中途失败即停止上报，根被唤醒并重写规划 |
| 脚本 | `mud_workflow_run('login')` 成功/失败均返回结构化结果；脚本不自作主张重试；凭据不出现在脚本输出、日志、画面 |
| 归属 | 子会话（根直接派发）能通过父链解析到账号 runtime；非本插件会话被拒 |
| 持有者 | 并发 `send` 被可读拒绝，应答不劈半 |
| 静默唤醒 | 已接入 + 空闲 120s → 开一回合；回合中不叠加 |
| 零回归 | 一期 132 项用例不回归 |

**与二期/既有设计的关系**

- **连接升格为工具**：二期「连接与接入是手工动词，模型不能自己拉起连接」作废；**接入 `admit` 保持纯闸门语义不变**（闸门只看 MUD→agent 的投递通路）；
- **mud_send 解除接入闸门（2026-09-30 裁定）**：二期拒绝序「未接入 ⇒ 工具可读拒绝」在本期作废——mud_send **只在未连接时拒绝**（没有地方发），接入状态不影响发送通路（应答经工具结果返回调用方，不是投递通路，不破坏 §3.4「未接入零进入」的投递语义）；发送侧的安全闸 = **禁发表 deny 表**（唯一发送闸门），其用途定位：网络已连接且已登录后，防止 agent 向服务器发危险指令；此为三期对二期已实施行为的改动点；
- **connect 语义拆分**：connect 只建连不登录（盲发退役），登录统一归根规划的登录脚本要点；§2.3「手工 connect → 建连 + login」语义随本期实施后同步修订；
- **`mud_flow` 机制整个删除**：FlowSpec / 收口与分类分离 / 流程槽 / 两拍发布 / 流程引擎均不实施——流程改为"数据 + 脚本"两种承载（确定序列 = 脚本，需判断或等人 = agent 层）；
- **盲发退役**：删除 `runtime.connect()` 里的 `name → 200ms → pass → 200ms → 空行` 序列（临时手段），由登录脚本的提示符驱动取代；
- **结算回报面**：结算通知是 best-effort 且只有文本通道，根醒来要读的结构化现场由 `SessionLog` + `mud_state` 承担（结算只负责叫醒）。

**实施后**：同步 `doc/architecture/00-core.md`（§2.3 状态两轴、§3.3 工具面转现役、§3.4 kickoff）与 `CHANGELOG.md` 一行。

### 第四期：自动重连

> **前置**：先实现**真实心跳**（MUD 侧健康探测），无心跳不区分真断线/半开连接。
> **范围**：热状态（agent live）自动重连；冷启动不自动；断线恢复后的世界状态重建策略。
> **注意**：心跳本身可能值得单独一个切片，先验证 MUD 侧是否有原生心跳信号可用。
> **与三期的接口**：重连后的登录复用三期登录脚本；`loggedIn` 在断线时已复位为 `unknown`，重连成功后由 GMCP 重新置位。

### 第五期：进阶机制（按例证生长，不预设顺序）

> **触发**：以下各项各自独立，由真实需求驱动引入，不批量规划。

- **子 agent / 派单 / 预算**：计划性任务需求出现（核心 action 复用、并行探索）
- **T2 闭环 / 唤醒**：挂机自主行为需求出现；唤醒**必须**以"已接入"为前置（§3.4）
- **投递策略化**：字段化摘要、按需投递、水位窗口细化——token 账目恶化时
- **计数 / 账目 / 可观测**：成本验收或运营监控需求出现
- **其他**：core2 归档中未迁移但有参考价值的设计（五层心智等），按例证逐条评估

### 容易遗漏项（清单，非期）

以下在各期实施时需留意，不单独成期：

- **凭据管理**：密码录入、更换、多账号复用同一凭据（凭据链路 §2.4 已覆盖，实施时细化）
- **冷会话 runtime 保留**：宿主释放 agent 时连接不拆（§2.3 已定，实施时验证）
- **persona 内容**：mud-player preset 的 system prompt 措辞（C3 实施时定）
- **从 v1 迁移**：mud-webui 接线替换时，roster 数据从 localStorage 迁移到宿主 storage 域
- **遗留脚本清理**：根 `package.json` 的 `test`/`dev:core2` 脚本指向 mud-core2，开工时调整

> AI生成
