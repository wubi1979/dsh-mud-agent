## PLAN.md — 文件头（新计划起草区）

 ### 起草约定
> **文件角色**：本文件是后续新计划的临时起草区，只用于起草和修改计划，不作为正式设计文档留存及长期事实来源。任何大型计划必须先在本文件中起草成型；实施完成后再同步到 `doc/architecture/` 的正式章节，并在 `doc/CHANGELOG.md` 登记一行。同步完成后，本文件中对应内容必须删除，不留档。


 1. 按“对照源码变更的实施计划”组织，大型计划至少含6节：① 元信息与范围（状态、覆盖项、目标/非目标）；② 背景与核心决策；③ 机制与契约（接口、状态机、配置校验、行流归属）；④ 源码变更清单（新增/修改/删除到文件/模块粒度）；⑤ 实施切片与测试验收；⑥ 未决、待实测与完成定义。中、小型计划可减少为4节：目标与决策、契约与变更、实施与验收、未决与收尾。
 2. 缺少核心章节不得视为可冻结状态。未冻结计划不可作为实施依据。若计划尚未实施或尚未同步，不得删除本文件中的对应内容。
 3. `§N` 符号仅用于正式章节，起草期内容不使用。引用现行设计时一律写 `§N`，不写裸文件名。本文件自身章节的引用不带 **`§`**（小节写作 `3.1` / `6.2`，整章写作 `第 4 章`），避免与正式章节编号混淆。
 4. 所有例数、计数、规模等数字，一律以当次实测为准，不得硬编码历史值。交付切片统一使用`W*`编号，具体序号见 `doc/architecture/17-18-roadmap.md` ，顺序增加。
 5. 列表项 - 本文的内容不被任何设计文档引用。如需引用设计，需先同步到正式文档再做引用。

### 待办池：后续计划启动方向（源自 §18 未决）

> 用途：编制新计划的取材清单，条目编号用 `T*`。条目仅作启动方向提示，起草新计划时以 §18/对应章节的现行口径为准复核。某事项立项起草后在此标注"已立项 → 见本文件对应计划"；实施落地后从本表删除并同步 §18（§17–§18 仍为当前状态唯一来源，本表不承载状态事实）。

| #  | 事项                    | 启动方向建议                                                                                                     |
| -- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| T4 | 流程内部并行分支              | 同流程多 driver 并行推进的语义与结算归属；先确认是否有真实消费方（login/fullme 都是严格串行），无则维持 §18 的非目标口径                                  |
| T5 | W5 尾款                 | `pendingEntry` 端到端用例；`hpbrief` 应答折叠进 world（§19.7 待定 1/2）                                                   |
| T6 | 并发调度分类器（I11 边界）       | `isConcurrencySafe` 是我们在 `defineTool` 里自己可加的字段（非上游依赖）：给 `mud_state`/`mud_help` 这类零发送只读工具声明并发安全时，必须同时重估 I11 |
| T7 | 窗口期分页被延后              | 明确窗口内插话命令的归属判据（§8.3）+ 翻页命令（`pager:continue`）的直发豁免策略（gateRank）                                              |
| T8 | `halt` 无条件豁免直发延后 gate | 豁免收紧为打断路径专用并留痕（§18.8：非打断路径 halt 应答 GA 可能污染在途窗口计数）                                                          |
| T9 | 装配层测试基建（§18.9）        | vitest 管线加载不了 TC39 装饰器模块 → 是否引入 esbuild/swc 变换链，或继续把可测策略从装配层抽出来（W9 的 `session/credential-source.ts` 即后者）   |

***

# 计划：T1 从「无状态渲染器」改为「有状态流程驱动器」

> 状态：**实施中（2026-09-22）**。W10.0–W10.6 ✅ 已落地；W10.7 ⏳ 待文档同步。契约已冻结（W10.1 定稿；W10.4 批次四净删 tool-call 的 `classify`/`captures`）。
> 现行形态 = **形态 C** + **B3**。
> 本计划实施后按文件头约定同步正式章节并删除本节。

## D0 前置条件（前置核实，已闭合）

开这笔投入之前必须先回答一个问题：**DSH 官方是否已有流程管理插件？** 若有，按设计原则 T1 应降级为渲染器，本计划整体作废。核实结论（源码 checkout `D:\code\deepseek-harness`）：

| 检查项                               | 结论                                                                                                                                                                             | 依据                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 官方有无声明式流程表插件                      | **无**。`workflow` 的 `meta.phases` 自带注明"仅进度词汇，不施加任何执行结构"；全仓 `StateMachine`/`transitions:`/`StepTable` 只命中客户端 UI 状态机                                                              | `packages/workflow/workflow/src/types.ts`；`packages/client/ui-conversation/src/client/input/machine.ts` |
| 官方 `workflow` 能否承载 login / fullme | **不能**。它是"模型写 JS 脚本扇出子代理"，README 明写 *Foreground collection only*、*No journaling or resume*、*No saved or nested workflows*；脚本钩子只有 `agent()/parallel()/pipeline()/phase()/log()` | `packages/workflow/workflow/README.md`                                                                  |
| 语义上是否兼容                           | **不兼容**。MUD 流程要求"无 LLM 在环"（§19.6.1 实测 `t2Calls === 0`），而 workflow 的入口是 LLM 写脚本 / LLM 调工具                                                                                       | §19.6.1                                                                                                 |
| 最贴近的官方先例                          | `goal-round-driver` —— 纯插件（`inject = ['agents','goals','sessions']`），在 `agent/status` 转 idle 的静止点用 `agent.followup()` 排下一轮，并用 `agent/pre-step` 拦截该轮                            | `packages/goal/goal-round-driver/src/index.ts`                                                          |
| **D0 结论**                         | **官方无流程管理插件 ⇒ 降级 T1 的前提不成立 ⇒ T1 保留流程所有权，本计划方向成立**                                                                                                                              | —                                                                                                       |

**D0 的副产品**：

- 回合结束接线点：`agent/turn-stopping`（serial、被 await 后才提交边界、监听者可 `agent.steer()` 让机器重读 inbox）与 `agent/status` 转 idle + `whenIdle()`（goal-round-driver 的静止点模式）。
- T1 槽的定位键有官方出处：`GenerateOptions.sessionId`（"Session identity stamped by the loop for request routing"）。

## 1. 计划元信息与范围

| 项       | 内容                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------- |
| 状态      | （切片状态见文首）契约**已冻结**；现行形态 = 形态 C + B3。                   |
| 覆盖待办池条目 | 不直接消费 T4–T9。与 T6 / T7 / T8 在裁决器与窗口注册面上有接触，实施时维持 §18 现行口径，不扩大处理                                    |
| 覆盖正式章节  | §1 不变量 I2/I4/I11/I12/I13 按新口径改写；I8 纳入覆盖；I15 原文不动；新增 I16。**W10.7 ⏳ 待同步** |
| 实施后去向   | 同步上述章节 + §17 切片登记 + `doc/CHANGELOG.md` 登记（**大版本** v0.11.0 线）→ 按文件头约定删除本节，不留档                      |

### 1.1 目标：

- T1 从无状态动作渲染器改为有状态流程驱动器；流程回合内的"上下文注入 / 助手 / 工具"三件套消解为"入口投递 1 次 + 助手/工具交替"。
- **收口与分类结构分离**：收口为 `mode:'inline'|'stream'` 判别式联合，缺省 stream + `fallback:{ms:3000}`，窗口恒有界（到期恒 timeout）；分类只支持自填正则（`onSettle` 承载收口关窗时的裁决）；流程表 / 规则表步级仍须显式声明收口（装配期报错，工具层不报错）。
- 行流守恒可测：每行恰好被消费一次，无折叠、无移交、无隐藏行。
- **T2 能力零回归**（D9）：`mud_state` / `mud_look` / `mud_status` 既有语义与量级不退化（`mud_recall` 取消，其职能由会话历史承担）；T2 可见的技能文本与流程所有权保持一致。

### 1.2 非目标：

- 不做断线后流程挂起续接（已迁 §19.7 待定 #3，真实需求出现时再立项）。
- 不做多流程并行（T4）、不重估并发安全（T6）、不改分页与 halt 豁免策略（T7/T8）。
- 哨兵探测步（`set actioned` / `response actioned`）仅为实验功能，不进常规能力与验收。
- 多行分类仅作可选扩展预留，MVP 单行。
- 不改写 I15（见 D7.4）：本计划新增 I16 承载 T1 私有状态边界，I15 原文不动。

## 2. 背景与核心决策

**现行问题**：T1（§7）是**无状态动作渲染器**——动作由规则/流程声明并随投递消息送到，T1 只把 `source.actions` 渲染成 tool-call；流程状态归运行时（§19），两者靠 `flow.windowSpecFor` 配对移交判据、`noteToolResult` 事后推进来缝合。直接症状：流程每步一条投递消息（"上下文注入 / 助手 / 工具"三连，注入原文与上一步工具结果重复）；决策者有两个（运行时判据 + T1 渲染）。

**目标形态**：T1 = **有状态的流程驱动器 + 输出渲染**（按 `sessionId` 分槽）。与 T2 同构：拿工具结果 → 查表决策 → 发下一个 tool-call；唯一区别是决策来源——T2 由 LLM 判断，T1 依流程表判断。二者用同一套发送工具、同一结果形态。

**决策归并（D1–D11）**：

### D1 入口

- 流程入口经 **USER 注入投递**开回合，与 T2 同形（消息带原文 + `actions`）。T1 保留两类回合职责：流程回合（状态机驱动）与动作渲染回合（规则动作渲染，无状态）。✅ 已落地
- **两类回合区分面**：入口投递消息新增可选字段 `flow?: { id: string }`（带 = 流程入口回合，不带 = 动作渲染回合）；T1 **入口判定序** = 槽活跃 → 流程回合（按槽渲染）｜槽不活跃 + 消息带 `flow.id` → 开槽启动｜其余 → 渲染回合。不复用 `ruleId` 的 `flow:` 前缀字符串解析；`flow.id` 装配期校验必须存在于流程表。**callId ↔ 步骤关联**：T1 组装每步 tool-call 时把 callId 写入槽 `pendingCallId`，工具结果先校验 callId 配对（不匹配 → 被动复位，D6）。**lane 不加值**：两类回合均为 `lane=t1`，`turnLane` 取值保持 t1/t2（D9 红线）。✅ 已落地（W10.4 第 5 步）
- 入口投递**一律复位并重开流程**，不接续旧状态。**pendingEntry 出队投递 = 入口投递**：行为一致、同样复位重开——出队只发生在回合结束、槽已失效之后（D6 `drainFlowQueue`），与 I10 互斥无冲突。✅ 已落地
- 入口 arm 仍在会话侧（模型只在回合里活着，"流程该不该启动"必须有人在无回合时盯着行流）。这是流程内唯一必需的注入。✅ 已落地
- **入口原文即触发行**：命中即消费，消费水位自然推进过该行；入口投递只引用已消费行，不重复消费行流。

### D2 步内机制

- 六步循环：① 进入步骤 N，取收口（settle）+ 分类集（fail / ok / 分支 driver 全显式）+ capture 规格 → ② T1 组装把命令 + settle 写入 tool-call（`classify`/`captures` 不随 tool-call 供给，归流程表）→ ③ 工具：校验 → 凭据插值 → **confirmSent（注册收口进裁决器，owner = 本窗口）→ 写 socket，零间隙** → ④ 裁决器结算（关闭触发命中 / GA / 兜底到期 / 打断）→ ⑤ 工具返回窗口结果，span 行经窗口单槽直送驱动器 → ⑥ 驱动器在推进点复判 content、查表、更新槽 → 下一步或收束。✅ 已落地
- **收口只由 T1 组装写入**（tool-call 参数）或规则/直发显式声明（规则表 / 活动表条目）提供；T2 不传参数 ⇒ 走缺省收口（口径见 D3 / 3.1）。分类/抽取归流程表、由驱动器持有。✅ 已落地
- **无任何"结算后等行"状态**：窗口只在关闭触发命中 / GA / 兜底到期 / 打断 / 断线时结算，步的等待全部在工具内部。✅ 已落地

### D3 收口与分类分离（形态 C）

- **载体分离（形态 C）**：判据（`classify`：`ok`/`fail`/后继 `driver`）住在**流程表**、由**驱动器**持有；**tool-call 只带收口（关闭触发 + fallback）**。判据**不随 tool-call 供给**——流程词汇一个都不进模型可见面。空类 = 跳过（不是整体失败）；**不得**流程启动时全表注册（后续步判据会提前命中）。✅ 已落地（W10.4 批次四）
- 判定顺序：**fail → 分支 → ok**，固定不可配（由驱动器复判的**走序**实现，同帧多命中按此序取一，其余留痕；不做装配期特异性告警）。✅ 已落地（W10.4 第 7 步）
- **收口（settle）与分类（classify）结构分离，不得混杂**：settle 为 `inline` / `stream` 判别式联合（工具结果即收口，或行流窗口）；分类只支持**自填正则**（`RegexSpec`）；`{ref:'settle'}` 由 `onSettle` 取代，GA/tool 不再是分类 kind（settle 契约、kind 全集与**"无 time kind"** 细则见 3.1）。✅ 已落地
- **收口缺省** **`{mode:'stream'}`** **+** **`fallback:{ms:3000}`，窗口恒有界**：`on` 命中提前关窗；`fallback` 兜底时长恒在。缺省 3000 是 T2 量级短超时；**T1 流程表步级按实际步骤耗时填写**（dz 等长命令步写大值）。**兜底到期恒为** **`timeout`，不属于 ok/fail**（"到点即成功"废除——须以 `on:{kind:'regex'}` 证据关窗）。✅ 已落地
- **收口关窗时的裁决 = 步级** **`onSettle`（缺省** **`'ok'`，可** **`'fail'`）**：窗口因证据关闭、**驱动器复判未命中任何判据**时的裁决由它承载。**fullme** **`stale`** **=** **`settle:{mode:'stream',on:{kind:'ga',count:3}}`** **+ 步级** **`onSettle:'fail'`，显式写出**。✅ 已落地
- **`mode:'inline'`** **收口**：本步工具结果即收口（不开行流窗口），服务"只调工具、不发游戏命令"的步（fullme `prompt` 取图）；裁决固定映射（工具 ok→ok / error→fail）；inline 步**无 content 可复判**，判据只在 `next` 上体现。✅ 已落地（W10.1）
- **两 lane 同型收口**：✅ 已落地（W10.2）
  - **T2：调用时不做任何收口声明** ⇒ 缺省 stream + fallback，**恒等满 fallback 后以** **`timeout`** **返回**；不计 GA、不做匹配。
  - **T1：组装期校验必须显式声明 settle**，漏写在装配期报错（fail-loud 作者纪律，防笔误静默吃 3 秒）。
  - **声明才计 GA 数、才做匹配**：仅显式声明 `on:{kind:'ga',count:N}` 才进行 GA 计数关窗；**GA 隐式早关废除**（删除明细见第 4 章 inflight 行，细则见 3.5）。✅ 已落地
  - **收口 ≠ 判据**：**收口只回答"窗口何时关闭"**（不解释内容）；**判据只回答"内容指向哪个 next"**（由**驱动器**持有）。二者**正交、可共存**，**分属两个组件**。✅ 已落地
  - **判据复判点 = 推进点**：包装器在 `noteToolResult`（工具**在途期间**）把 content 交给驱动器复判 —— 这是 0 空续步的充要条件（B3，§6.1）。✅ 已落地
  - **判据不中** ⇒ 证据关闭按 `onSettle`、到期以 `timeout` 返回，**无隐式 fail 裁决**。✅ 已落地
  - T2 三个查询工具（`mud_look`/`mud_status`/`mud_move`）的 GA 早关由**工具 schema** 自带声明（定案见 D9 R1），不受"声明才计 GA"缺省口径影响。✅ 已落地（W10.1）
  - 三触发同一路径、层内唯一类型：细则见 3.1 / 3.5。
- 规则动作 = 显式声明（载体为规则表 / 活动表条目；活动表从"N-GA 缺省 + 判据命中结算"重定义为"规则 / 直发命令的显式收口声明载体"）。
- **回看结算取消**：命令发出前已在缓冲里的行不是本命令的应答，不参与本步结算，留给后续消费批；同帧到达的"本步结果行 + 后继 driver"由**驱动器对 span 的复判**承接（一次走序即得 class=branch）。发送水位 + 回看区间机制整体删除。✅ 已落地（W10.2）
- **迟到的 driver 行 = 没到**：窗口关闭之后才到达的 driver 行，对流程即视为没到——不回头认领，按普通行进入后续消费批（→ T2 批次）。✅ 已落地
- span = **水位 → 触发行（含）**（单水位，3.7）；触发行之后的同帧行、GA、迟到行落后续消费区间作前置噪声。**非空结算约束**：命中结算 span 至少含触发行一行（GA 行计入），禁止空值结算；兜底到期且零行 = 无应答事实，留痕收束，不产出空 span。✅ 已落地
- **状态抓取为独立桶**：抓取结果**只同步 world**；**不推进水位、不折叠内容**（细则见 3.6）。✅ 已落地（W10.3）
- **capture 抽取归驱动器**：流程表 `captures`（槽名 = 命名捕获组 `(?<name>…)`；未匹配不报错）由驱动器**在 span 行上逐行抽（到达序），每槽先到先得**；`captureScope` MVP 删除。占位符三类通道：`{name}`/`{pass}` 原样传参、工具经凭据 seam 发送瞬间插值（明文不落转录/日志/tool-call 参数）；`{captcha}` 工具内部闭环；capture 槽 / `{lastFail}` 由驱动器组装时直写值。✅ 已落地（W10.1 + W10.4）
- 复判是结算分类器 ⇒ **误命中 = 误结算**：判据特异性是流程表编写纪律，**装配期不做特异性检查**（正则写错属配置问题，作者自查）。

### D4 兜底到期与失败

- **兜底到期不做最后判定**：`fallback` 耗尽且无分类命中即 `timeout`——**提交全部窗口内容**（水位 → 缓冲头），**记为当前调用者消费**；随后流程失败收束。到期不进 retry（retry 仅由 fail 分类驱动）。
  - **`timeout`** **带回已累积内容**（span 行进结果的 `lines`/`text`；状态仍是 `timeout`，不属于 ok/fail）。理由：T2 不声明收口 ⇒ 恒等满 `fallback`，若 `timeout` 不带内容，T2 的任意命令就**拿不到回显**，与 §D3「T2 自读批内容决策」冲突。行仍计当前调用者消费。`ABANDON_TEXT` 已删除。✅ 已落地（W10.2）
- **T2 不接受移交**：T2 批次永远自行从水位起消费。✅ 已落地
- **步骤 fail** → 表内分支 / 重试（决策者职责）；fail 命中且无重试/分支 → 流程失败。
- **流程失败必须对 T2 可见**：现行 §19.5 明文"失败/超时 → 留痕 + **交 T2 决策一次**，不静默停住"，实现载体是 `failPolicy.notify`（缺省 `'t2'`，`agent/flow/engine.ts` 在失败时投递一次唤醒 T2；login/fullme 现配置 `notify:'none'`）。
  - 缺省（`'t2'`）：失败/超时 → 留痕 → 复位 → **主动投递一条 T2 可见消息**（原文 = 失败原因 + 剩余未结算行）→ T1 `finish stop` → T2 接手。
  - `'none'`：只留痕，不主动投递。
  - 理由（原则 1 + I4）：若失败时零未结算行（超时且零行），被动口径下 T2 得不到任何输入 = 静默停住。
- **流程失败的未结算行不丢弃、不移交**：留在缓冲，作为下一批入口原文或 T2 批次被消费。✅ 已落地
- 预算：步数 / 时间 / 重试预算防 T1 高速空转（收口兜底时长 / retry.attempts 已有，步数预算为流程级新增）。

### D5 打断与排队

- **打断**：在途窗口结算 `interrupted` → **直接收束流程槽**（复位 + 留痕），**不进 retry/fail 分支、不走 failPolicy**；事件动作经 **followup 新回合**投递。I14 语义不变。✅ 已落地（W10.4 第 6 步）
- **defer 面只收窄不删除**：判据 A（通道由"投递瞬间是否有工具在途"决定）**actor 无关**——同时承载 T1 流程步进、**T2 批次**与规则动作的在途投递。故：
  - **保留**：判据 A 全套（defer 槽 / `deferContext`）服务 T2 批次与规则动作。✅ 已落地（W10.5 核查零残留）
  - **删除**：T1 流程步进对 defer 的依赖。✅ 已落地（W10.4 第 5 步③）
  - **删除**：判据 B（`shouldConcludeTurn` 及其投递尺寸记账）——只对 T1 渲染的 call-id 生效。**终态改由流程驱动器在推进点直接判定**，包装器只转达 `exec.concludeTurn()`（B3，§6.1）。✅ 已落地（W10.4 批次三）
  - 打断改 followup 的代价已实测（§6.4）。
- **结算优先级：打断 > 关闭触发/GA > 兜底到期 > 断线**；打断与关闭触发同帧时打断优先，关闭触发作废留痕。✅ 已落地
- **打断 followup 调用点 =** **`agent/status`** **转 idle 静止点**（goal-round-driver 先例）：事件动作经 `whenIdle()` 排 followup 新回合；I10 互斥与"流程活跃绑定回合"（D6）在该静止点翻转（届时槽已收束复位）。✅ 已落地

### D6 生命周期

- 状态按 `sessionId` 分槽：定位键取官方 `GenerateOptions.sessionId`；**该字段可选，缺失时 fail loud**（error + diag 计数），不得静默回落全局槽。✅ 已落地（W10.4 第 3 步）
- 复位是**被动**的：`callId` 配对不匹配或**连接代次**不匹配 → 弃用旧状态。不引入"回合取消钩子"（在途工具经 `exec.signal` 立即返回 canceled）。✅ 已落地
- **断线口径 = 复位重开**：重连后入口 driver 重新命中 → 入口投递重开流程。
- **"流程活跃"绑定回合**：回合结束 → 活跃自动失效 → 入口 arm 恢复 + `drainFlowQueue` 出队。**接线点**：`agent/turn-stopping` + `agent/status` 转 idle + `whenIdle()`。不引入 begin/end 声明。✅ 已落地（W10.4 第 6 步）
- **I10 预激活**：入口投递本身即互斥信号；`awaitExternal` / 人工窗口同样携带 priority 投影。会话释放 = 重新初始化 → 清槽。
- **不引入"流程中途切 T2"**：`turnLane` 按回合锁定（`deliver/lane.ts` per-agent 闭包，取值只有 `t1`/`t2`），同回合工具续步沿用本回合 lane；唯一逃生口是用户取消回合。

### D7 硬约束

1. **步的等待只能存在于工具内部**（命令窗口 / 人工等待窗口）——收口恒有界模型下自动满足，不允许"没有在途工具的干等步"。
2. **凭据占位符** **`{name}`/`{pass}`** **必须原样传参**，由工具在发送瞬间插值；明文不落转录、日志、tool-call 参数。
3. **流程表必须能从头重跑**（复位重开的隐含要求）。
4. **I15 保持不变，新增 I16 承载 T1 私有状态**：I15 是保护 T2 可用性的不变量，不得改写。T1 的槽状态（`flowId`/`stepId`/`captureSlots`/`retries`）**一律不得进入投递消息、工具参数描述或工具结果文本**；另立 **I16**（T1 私有状态不进 T2 可见面）。

### D8 运行时只读投影

- I10（单流程互斥 / 流程期间不 arm 其它入口，含入口投递预激活）与 I14（`interrupts > priority`）所需信息从 T1 的 tool-call 参数 / 入口投递投影到窗口注册；**运行时不得据此推进流程**（否则双权威复活）。

### D9 T2 能力零回归

| # | T2 面                                                           | 风险                       | 定案                                                                                                     | 验收                    |
| - | -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------- |
| 1 | `mud_look`/`mud_status`/`mud_move` 的 GA 提前收口；`mud_state` 不注册窗口 | T2 失去 GA 缺省 → 查询响应延迟回退   | **T2 命令类工具显式声明** **`settle:{mode:'stream',on:{kind:'ga',count:1}}`**；全局缺省 stream + fallback 3s 仅兜底（D3） | R1 ✅ 已落地（W10.1）       |
| 2 | `mud_recall`/`mud_state` 的"尚未投递给你"语义 = 交付水位                    | 取消 recall 会失去"拉取未投递行"的能力 | **recall 取消**（3.7）：T2 的上下文 = 会话历史本身，**不提供 pull 通路**；`mud_state` 去 `lines` 只留 world 快照                  | R2 ✅ 已落地（W10.2）       |
| 3 | T2 批次在工具在途时随结果进同一回合（判据 A）                                      | 删 defer → T2 回合边界改变      | **保留判据 A**（D5）                                                                                         | R3 ✅ 已落地（W10.5 核查零残留） |
| 4 | 流程失败时"交 T2 决策一次"                                               | 被动口径 → 零行时 T2 静默         | **保留** **`failPolicy.notify`** **能力与字段**（D4）                                                           | R4 ⏳ 待端到端用例           |

### D10 状态归属与 I8 合规

- T1 是**注册进官方 llm 注册表的进程级单例 adapter**。状态化后，槽表**不得**成为 I8 明令禁止的"模块级可变单例状态"。
- 定案：**槽表归会话作用域**（会话运行时 / 每会话服务持有），T1 adapter 只按 `GenerateOptions.sessionId` 查表与写表；会话释放即清槽。T1 adapter 自身保持无状态外壳。✅ 已落地（W10.4 第 3 步，`agent/flow/slot.ts`）
- 释放时机：会话释放 / 断线重连（连接代次不匹配）/ `callId` 配对不匹配。

### D11 推进与结算的原语

- 推进：`agent.followup()`（新回合）/ `agent.steer()`（最近 step 边界）/ `agent.inject()`；拦截：`agent/pre-step`。
- 回合边界：`agent/turn-stopping`（serial，await 后提交边界）；静止点：`agent/status` idle + `whenIdle()`。
- 早停：工具侧 `exec.concludeTurn()`（新模型下仅 T2 路径不接，沿用 §18.17 口径）。
- 排他：`ctx.tools.executionMode()` fail-closed（未声明 `isConcurrencySafe` → exclusive），I11 现行论证不变。

## 3. 机制与契约

### 3.1 tool-call 参数契约（T1 → 发送工具）

```
mud_send {
  cmd: string                    // 命令行；占位符按三类通道处理（D3）

  // 收口：只回答"窗口何时关闭"，不回答"内容算哪一类"（形态 C，细则见 D3）
  settle?:                       // 缺省 { mode:'stream' } + fallback 3000
                                 // **不声明 ⇒ 恒等满 fallback**：不计 GA、不做匹配，到期以 timeout 返回
    | { mode: 'inline' }         // 本步工具结果即收口：不开行流窗口（ok→ok / error→fail）
    | { mode: 'stream',
        on?:       { kind:'regex', pattern } | { kind:'ga', count }   // 关闭触发（**层内唯一类型**）
        fallback?: { ms } }      // 兜底时长：缺省 3000，T1 表内按实际步骤耗时填写；到期恒为 timeout 结果
}
```

- **形态 C**：收口器只管关，判据归驱动器复判（完整论证见 D3 / §6.1）。窗口侧 `settle.on` 只是**关闭触发**，不携带分类；触发命中 / N-GA / `fallback` 到期三触发走**同一条收口路径**（§3.5），返回信号同形不同名（`'ga'` / `'evidence'`）。**触发从哪来**：T1 流程步由驱动器从本步判据派生（`union(step.classify ∪ 直接后继 driver)`，经 `lineCriteriaPattern` 编译）；T2 自填。派生保证"收口与判据不可能分歧"。**tool-call 参数不含** **`classify`** **/** **`captures`**（分类、抽取、`onSettle` 全是流程表的事；一个流程词汇都不进模型可见面）。✅ 已落地（W10.4 批次四）
- **settle 为判别式联合**：`mode:'inline'` = 不开行流窗口、工具结果即结算（fullme `prompt` 用；裁决固定映射 ok→ok / error→fail；**inline 步天然无判据可分类**）；`mode:'stream'` = 行流窗口，`on` 承载关闭触发（kind 全集 = `regex` / `ga`；**无 time kind**——纯计时窗 = 无 `on`，时间恒由 `fallback` 管），`fallback` 兜底时长恒在（缺省 3000，dz 等长命令步写大值）。
- **分类形态只有自填正则**（`RegexSpec`，空类 = 跳过；载体是流程表 `classify` 字段，不是工具参数）；GA/tool 不再是分类 kind；`onSettle` 为**步级字段**。
- **层内唯一类型**：收口触发层 `settle.on` 单 kind（结构已保证）；判据层 `classify` 只收正则。**层间不互斥**（`settle.on ga:N` + `classify` 可共存：GA 关窗、正则判 next）。
- **`onSettle`** 只在"窗口因证据关闭、而驱动器复判未命中任何判据"时生效，缺省 `'ok'`；fullme `stale` 显式 `'fail'`。
- **MVP 删除字段**：`onMatch`（'tag' 延后——判据命中即关窗是 MVP 唯一语义）、`priority`（定序固定 fail→分支→ok，由驱动器复判的走序实现）、`captureScope`（capture 恒逐行，'window' 随多行分类扩展延后）。
- **窗口恒有界**：`on` 触发命中提前关窗；**`fallback`** **到期恒为** **`timeout`** **结果，不属于 ok/fail**（"到点即成功"废除）；驱动器复判的定序 fail→分支→ok 在同一份 content 上一次走完（A2 的自然实现）。
- **收口来源解析（工具侧，按序）**：① tool-call 参数（T1 流程步 / T2 自填）→ ② 命令的显式声明（规则表 / 活动表条目，规则动作）。**都没有 ⇒ 恒等满 fallback**（`{mode:'stream'}` + 3000；不计 GA、不做匹配，到期以 `timeout` 返回）。
  - **T2 收口 = 调用时不声明**：一律走缺省、等满 fallback 后返回 `timeout`——**声明才计 GA 数、才做匹配**。三个查询工具的 `on:{kind:'ga',count:1}` 由**工具 schema 侧自带声明**（不是模型调用参数；定案 D9 R1），故仍享 GA 早关，不受本条影响。
  - **T1 收口 = 必须显式声明**：流程步漏写 settle 在**装配期报错**。触发本身由判据派生，**不另写一份**。
- **表级显式校验（fail-loud）**：流程表 / 规则表**步级仍须显式声明 settle**，漏写在装配期报错。**T1 是唯一必须显式声明的一侧**；T2 不声明是常态、不是缺陷。（校验清单见 3.9。）
- **I15 要求（设计级）**：参数必须能写进工具描述让模型读懂（T2 拿到同一条 tool-call 也能自行决定）。形态 C 下模型可见面**只剩** **`settle`**，`classify`/`captures`/`onSettle` 一律不出现在工具 schema 与工具结果里。
- **`action.direct: true`** **= 纯反射，不属于收口/窗口体系**：
  - **豁免收口声明校验**：direct 不参与 §3.9 的收口声明校验（校验对象 = 所有**注册窗口**的发送；direct 不注册窗口）。
  - **不开窗、不消费、不推水位**：发完即走、不等应答、不结算、不产生 span；其应答文本是**无主帧内容**，按普通行进入行流（→ T2 批次 / 后续消费批）。
  - **归属触发器层**：direct 由规则（触发器）声明与执行，从在途窗口 / 单水位 / 分类体系中**剥离**，只保留"命中规则 → 直发命令"这一反射路径；仍受危险命令硬边界（§7 门禁，actor `system`）与 **I12 直发延后 gate** 约束（**halt 豁免除外，T8 口径不变**）。✅ 已落地
- T1 / T2 使用相同工具、相同结果形态（既有口径不变）。

### 3.2 工具返回契约

**模型可见面**（`MudToolResult` / `OUT_SCHEMA`，`additionalProperties:false`）：

```
{ ok: boolean, note: string, cmd: string, settled: 'ga'|'eor'|'evidence'|'timeout'|'abort'|'interrupted'|'error' }
```

**窗口内部结果**（供驱动器复判，**不经工具结果透传模型面**）：

```
{ settled: 'ga' | 'eor' | 'evidence' | 'timeout' | 'abort' | 'interrupted' | 'error',
                       // **同形不同名**：ga/eor = N-GA 关窗；evidence = 关闭触发命中
                       // 两者同形（都只表示"窗口因证据关闭"），不携带分类
  text: string,                        // 窗口内容（span 行拼接；timeout 也带回）
  lines: MudLine[],                    // span 行（行号/style 保真）—— **驱动器复判判据的唯一输入**
  span?: { fromAbs, toAbs } }          // 消费水位 → 触发行 / 提交点（留痕 / 审计 / 自描述）
```

- **内容经在途窗口表单槽直送驱动器**（`InflightWindowTable#takeSettledLines`，工具返回后立即被取走，取一次即清，不构成回看通路）。**模型可见面只有** **`{ok,note,cmd,settled}`**，`lines`/`span` 不进模型上下文。✅ 已落地（W10.4 批次四）
- **只带回内容，不携带分类**：`hit` 退场——class / branchId / `{lastFail}` 原文由**驱动器按自己的判据走 content 得出**。
- `settled:'ga'|'eor'|'evidence'` → 内容交驱动器复判：命中判据 → 查表推进；未命中 → `onSettle`（缺省 `'ok'`）。
- `timeout`（= `fallback` 到期）→ **内容随结果返回**并记当前调用者消费；驱动器**同样先复判 content**，未命中才收束为流程失败。到期内容必不复判命中：关闭触发由判据派生（3.1），"触发未命中即到期" ⇒ 判据同样未命中，故到期恒不进 retry（D4）。
- `interrupted` → 收束流程槽；`canceled`（`abort`）→ 回合取消（槽被动复位）。
- `mode:'inline'` 不产生窗口结算，返回 `ok:true|false`（工具结果即判定；去向由步骤 `next` 决定）。
- I15：结果文本只描述"发生了什么 + 等到了什么"，不携带"下一步该怎么走"的私有指令。

### 3.3 流程表（口径增补）

Schema 沿 §19.1 骨架，增补：

- **判据（`classify`）归流程表**：`ok` / `fail` / 分支 driver（后继步的 `driver`）全显式，形态为自填正则；空类 = 跳过。GA/tool 不再是分类 kind，`{ref:'settle'}` 由 `onSettle` 取代。**驱动器在推进点对 span 走一遍这些判据**（定序 fail → 分支 → ok）。✅ 已落地（W10.1 表重写 + W10.4 复判）
- **`settle`** **步级显式必填**（装配期校验 fail-loud）；`on` = **关闭触发**，**由判据派生**（`union(classify ∪ 后继 driver)`）——步表**不另写一份触发正则**（同一事实一个家）；`on:{kind:'ga',count:N}` 与纯 fallback 窗（`answer` 180s）仍显式写；`fallback.ms` **按实际步骤耗时填写**。✅ 已落地
- **`onSettle`** **提为步级字段**：窗口因证据关闭、驱动器复判未命中任何判据时的裁决，缺省 `'ok'`；fullme `stale` 显式 `'fail'`。✅ 已落地
- `mode:'inline'` 服务只调工具不发命令的步（fullme `prompt`）：无窗口、无判据复判，去向由工具结果与 `next` 决定。✅ 已落地
- **禁止无 action 的步**（装配期校验 fail-loud）：判据复判的输入只能来自**窗口带回的 content**，没有命令就没有窗口、也就没有收口的载体。现状 login 4 步 / fullme 5 步全部带 action，无回归；`prompt` 属 inline（工具即收口）。✅ 已落地
- capture 抽取机制与占位符三类通道见 D3；**步数预算为流程级新字段**；多行分类 MVP 不支持。✅ 已落地（W10.1 + W10.4）
- `failPolicy.notify` 保留，缺省 `'t2'`（D4）。

### 3.4 T1 槽结构（按 sessionId 分槽）

落地结构（`agent/flow/slot.ts`）：

- **`FlowSlot`**：`flowId` / `stepId` / `phase` / `render` / `pendingCallId` / `retries` / `captureSlots`。
- **`FlowSlotTable`**：**会话作用域**持有、一格、替换语义、`clear()`。
- **发布点**：`FlowRuntime` 在**迁移点**发布（进入步骤 / 成功转等分支 / 终态收束 / 复位 / `dispose`）。
- **`render`** = 本步要发的 tool-call（**未插值**参数 + 收口三件）；收口三件由 `windowSpecOf(step, commandCount)` 给出，**与** **`windowSpecFor`** **同一次派生** ⇒ "T1 渲染的 tool-call"与"窗口注册"不可能分歧。
- **归属**：槽表由**会话作用域**持有，T1 adapter 只按 `GenerateOptions.sessionId` 查写（D10 / I8）。T1 adapter 保持无状态外壳（`TriggerLlmAdapter` 增 `slotOf` / `markRendered` 钩子，`assemble.ts` 用 `runtimes.get(sessionId)?.slot()` 接线）。✅ 已落地（W10.4 第 3 / 5 步）
- **定位键**：`GenerateOptions.sessionId`（可选字段）；缺失 → fail loud（官方 loop 对 T1 请求恒填该字段，fail loud 仅为兜底防线）。
- **配对**：`FlowRuntime#stepIdForCall(callId)`（槽的 `pendingCallId` 配对）；`pendingCallId` 由**迁移点发布**自动复位（含 `tryRetry` 重发本步），不会重复渲染同一步、也不需要额外的"清配对"调用。✅ 已落地（W10.4 第 5 步②）
- 释放时机：会话释放 / 断线重连（连接代次不匹配）/ `callId` 配对不匹配。

### 3.5 裁决器（`SessionAdjudicator` 增量）

- **单一收口器**：三触发 —— **关闭触发命中**（`settle.on` 正则）/ **GA 计数**（仅显式声明时） / **`fallback`** **到期**（恒在）—— 全部经同一个 `settle()` 收口，窗口恒有界（I4）。**收口器不解释内容**：三触发只决定"窗口何时关闭"，返回信号同形不同名（`'evidence'` / `'ga'`），都**不携带分类**。判据由**驱动器**持有，在推进点对窗口带回的 content 走一遍得出 class/next（§3.2）。✅ 已落地（W10.4 批次四）
- **声明才计 GA**：未显式声明 `on:{kind:'ga',count:N}` ⇒ `gaCount` 未定义 ⇒ `boundary()` 直接返回，**GA/EOR 到达不构成本窗口的边界**。`agent/flow/engine.ts#windowSpecFor` 按 §3.3 派生：`gaCount` 只在步表显式声明 `on:{kind:'ga'}`（或 legacy `boundary`）时供给；**关闭触发正则由驱动器从本步判据派生**（同一条派生链）。✅ 已落地（W10.2 + W10.4 批次一）
- **收口器挂窗口**：confirmSent 时注册（owner = 在途窗口）；confirmSent → 写 socket 零间隙。
- **四路结算**：关闭触发命中 / GA 关窗 / 兜底到期 / 打断 / 断线（后两者为终止类）。**无回看结算**——命令发出前已在缓冲的行不参与本步结算。✅ 已落地（W10.2）
- **窗口收窄为纯收口器**（W10.4 批次四）：`WindowRequest`/`WindowSpec` 只剩 `{cmds, closeOn?, gaCount?, timeoutMs?, label?, signal?}`；`settleCriteria` 只认 `win-<n>:close`；GA 关窗与证据关闭都**不带结局**；`WindowResult` 只剩 `{ok, cmd, text, lines, settled, span}`；`ReplySettle` 只剩 `{BoundaryKind | 'evidence' | 'timeout' | 'abort' | 'interrupted' | 'error'}`；`diag().open.criteria` → `trigger`。✅ 已落地
- **结算产出**：`{settled, text, lines, span}` —— 内容随结果交回驱动器；水位推进到触发行。
- **结算优先级**：打断 > 关闭触发/GA > 兜底到期 > 断线；**同帧多类命中的 fail → 分支 → ok 定序由驱动器复判的走序实现**。✅ 已落地（W10.4 第 7 步）

### 3.6 状态抓取桶

- 声明载体：state 规则（第 4 章 trigger 面）照旧；命中动作改为"抽取 → **同步 world**"，仅此一个效果。
- **不推进水位、不折叠内容**：状态行保留在行流中，作为普通行被后续 span/批次原样包含；行流无隐藏行。状态抓取若推进水位，会把水位推过尚未武装的入口/规则触发行，导致流程或规则永不触发。
- **`direct`** **命中行**：state 抓取行与 direct 命中行**都不消费、不推水位**（细则见 3.1 direct 条），不再折叠、不再隐藏，也不计入消费记账。✅ 已落地（W10.3）
- 与 §5 现行差异：现行折叠消费会隐藏行并前移 `deliveredAbs`（span 空洞、多行分类失真的动因）；该机制整体删除。✅ 已落地（W10.3：`FeedResult.foldedAbs` 与 `MatchHit.foldLines` 一并删除，生产面 + 消费面；裁决器站① 只 `patch` 不再隐藏行、站⑤ 的 `pending`/`recallLines` 收全行）。
- **落地状态**：可测不变量新增一例（`tests/runtime-delivery.spec.ts` 末节：投递拼接 == 完整入站行流，含被抓取行与被反射行）；完整不变量套件（含 span 记账）归 W10.6，✅ 已补齐。

### 3.7 单一水位线

- **水位线（每会话一条）**：行流消费进度的**唯一**记账。四类消费者全部推进（枚举见 3.10）；**`direct`** **不推水位**（3.6 定案）。✅ 已落地（W10.2）
- **状态抓取不推进**（独立桶，3.6）：只同步 world；若推进会把水位推过尚未武装的入口/规则触发行。
- **T2 的上下文 = 会话历史本身**：T2 需要的游戏输出就是它自己会话里已投递的内容。**不提供任何"拉取"通路** —— 不查 `pending`（尚未投递的行）、不查缓存帧、不做历史缓冲查询。
  - `mud_recall` 工具**取消**。理由：其旧语义"尚未投递给你"本质是让 T2 越过 `t2DeliverIntervalMs` 的推送节奏去拉 `pending`，与"推送节奏是唯一节拍"冲突；且实测出现过 `mud_state(lines:60)` 把连接至今全部输出重复塞进 session 的退化（§5）。
  - `mud_state` **保留**（只读档的信息源，§10），但**去掉** **`lines`** **参数**，只返回 world 快照。
  - 残留边界（不构成 pull 通路）：批次裁剪（`MAX_INJECT_TAIL_LINES`/`MAX_INJECT_TAIL_CHARS`）会在 session 里留下 `[观察窗截断]` 标记；`pending` 超 `MAX_PARKED_LINES` 丢最旧行并记日志 —— 两者都是**有痕迹的降级**，不额外给 T2 恢复通路。
- **span = 水位 → 触发行（含）**：唯一坐标，`deliveredAbs` 随三水位废除一并删除。✅ 已落地（W10.2）

### 3.8 状态机与时序

T1 槽状态机：

```
idle ──入口投递（复位重开）──> running(step N)
running: 组装 tool-call → await 工具结果
  ├─ 复判命中 ok      → next（顺序兜底 / 终态）；**终态（next 空）** = onSuccess → **驱动器判终态 ⇒ 包装器 `concludeTurn`** → 回合收束 → idle
  ├─ 复判命中 branch  → 进入分支步 → running(step M)
  ├─ 复判命中 fail    → retry（次数内，重投本步动作，计时器不重置）或表内分支；无重试/分支 → 流程失败
  ├─ timeout     → 内容已提交消费 → 流程失败
  ├─ interrupted → 收束复位 → idle（事件动作走 followup 新回合）
  └─ canceled    → 槽保留，被动复位（callId / 连接代次不匹配时弃用）
流程失败 → 留痕 → 复位 → （failPolicy.notify='t2' 时投递一条 T2 可见失败消息）→ finish stop → idle
回合结束（agent/turn-stopping / status idle）→ 活跃失效 → idle（入口 arm 恢复 + drainFlowQueue 出队）
```

一步时序：

```
驱动器按槽进入步骤 N
  → 组装 tool-call（cmd + settle；**关闭触发 = 从本步判据派生**，不另写一份）
工具：
  校验（收口来源解析三序；表级漏 settle 已在装配期拦截）
  → 凭据插值（{name}/{pass} seam，发送瞬间）
  → confirmSent：注册收口（关闭触发 / GA 计数 ✓ owner=窗口）        [#1]
  → 写 socket（与 confirmSent 零间隙）                            [#1]
  → 等待：关闭触发命中 / GA 计数到 / 兜底到期 / 打断 / canceled
  → 返回窗口结果 {settled, text, lines, span}（**不携带分类**）
包装器（工具在途时）：span 行经窗口单槽直送驱动器 = **推进点**（noteToolResult 单点）
  → 驱动器对 content **按自己的判据走一遍**（定序 fail → 分支 → ok）
     命中 → class / branchId / {lastFail} 原文 → 查表 → 更新槽 → 下一步
     未命中 → 证据关闭：onSettle（缺省 ok）｜到期：流程失败
  → 驱动器判定**终态**时，包装器转达 exec.concludeTurn()（B3：收束回合）
T1 的下一次请求：**只按槽渲染下一步**（不在此处查表/推进）
```

> **时点口径（B3）**：推进点 = `noteToolResult`（工具**在途期间**），不是"T1 的下一次请求"。这是 0 空续步（§6.1）的充要条件：T1 请求里发 `stop` 只能落在下一次请求上，必然多一个 `claim=0` 步。

### 3.9 配置、默认值与校验

- **装配期校验（fail loud）**：流程表——判据全显式（`classify.ok`/`fail` + 后继 `driver`，自填正则，空类 = 跳过；`ref` 引用取消）、**settle 步级显式（漏写报错）**、`on` 的 `ga` N 显式、**禁止无 action 的步**、`next` 引用存在、入口消息 `flow.id` 必须存在于流程表、占位符三类、capture 命名捕获组名唯一；规则表 / 活动表——**注册窗口的**规则动作显式收口声明，未声明报错。**`action.direct`** **豁免本校验**。**层内唯一类型**：`settle.on` 单 kind、`classify` 只收正则（**层间不互斥**）。**关闭触发不单独校验**（由判据派生，无可漏写）。✅ 已落地（W10.1 双形校验；W10.5 收紧）
- **调用期校验**：capture 正则编译失败 → error；`GenerateOptions.sessionId` 缺失 → error。（工具层收口缺省 stream + fallback 3s，调用期不再因缺声明报错。）
- 配置项与默认值（fallback 兜底时长缺省 3000、T2 攒批上限、步数/重试预算）见第 6 章（数值待校准）。

### 3.10 行流唯一归属与不变量

- **每行恰好被消费一次**（单水位记账，3.7）。消费者枚举：① 规则 / 入口 / 分类命中行（匹配即消费）② 流程 span（含兜底到期 / 打断提交区间）③ T2 批次 ④ 仍带原文的投递（如排队出队 pendingEntry）。**`direct`** **不在消费者枚举内**（其命中行与应答行按普通行落入 ③/④）。
- 无折叠：行流无隐藏行；状态抓取不消费行（只观察 + 同步 world）。
- 流程失败未结算行：留在缓冲，作为下一批入口原文或 T2 批次被消费（不丢弃、不移交）。
- **可测不变量**：`① + ② + ③ + ④ == 完整入站行流`（替代 §5 现行"按序拼接投递消息体"口径；折叠类目移除）。pendingEntry 的行流归属沿 §19.7 待定（T5），不在本计划内定。✅ 已落地（W10.3 起步 + W10.6 span 记账面补齐）

## 4. 源码变更清单

> 路径按 W8 后目录布局（`deliver/` `agent/` `flow/` `perceive/` `session/` `assemble.ts`），其中 `flow/` 于 **W10.0 整体迁入** **`agent/flow/`**（本清单按迁移后路径书写）。

**新增**：

| 位置                            | 内容                                                                                                                                                                        | 状态                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `agent/flow/slot.ts`          | T1 流程驱动器槽结构：`FlowSlot`（`flowId`/`stepId`/`phase`/`render`/`pendingCallId`/`retries`/`captureSlots`）+ `FlowSlotTable`（**会话作用域**持有、一格、替换语义、`clear()`）；驱动器职责并入 `FlowRuntime` | ✅ 已落地（W10.4 第 3 步） |
| `agent/flow/flow-spec.ts`（增补） | 新契约类型：settle 判别式联合 / classify（自填正则 + `onSettle`）/ captures / 步数预算；**类型归属定稿在 flow-spec.ts**（避免与 flow-types.ts 循环 import）；`normalizeFlowSpecs` 过渡桥                          | ✅ 已落地（W10.1）       |

**修改**：

| 位置                                               | 内容                                                                                                                                                                                                                                                                                  | 状态                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `agent/tools-schema.ts` / `agent/tools-build.ts` | 发送工具契约（形态 C）：**只剩** **`settle`**；**无** **`classify`/`captures`** **参数**；**收口缺省 stream + fallback 3s（T1/T2 同型）**；收口来源解析；**层内唯一类型（层间不互斥）**；**`direct`** **豁免校验**；T2 命令类工具显式声明 GA 收口（D9 R1）；工具结果**只剩** **`{ok,note,cmd,settled}`**，span 行经窗口单槽直送驱动器 | ✅ 已落地（W10.1 增参 + W10.4 批次四净删/收窄）            |
| `agent/tools-build.ts`（读工具面）                     | **删除** **`mud_recall`** **工具**；`mud_state` **去掉** **`lines`** **参数**（只返回 world 快照）；工具描述与 diag 同步（I15 面）                                                                                                                                                                             | ✅ 已落地（W10.2）                                |
| `deliver/adjudicator.ts`                         | 单一收口器挂窗口（三触发同一 `settle()`）、span 交付、结算优先级；**无回看结算、无发送水位**；`deliveredAbs`/`noteDelivered` **整体废除**；`recall()` 与 `recallLines` **降级为诊断通路**（`/mud/diag` + log-service，不进模型工具面）；**win- 标记收缩为"一个关闭触发"**；`noteToolResult` 改为**把 content 转交驱动器复判**并返回"流程是否已收束"（B3）                          | ✅ 已落地（W10.2 + W10.4 批次二/三/四）                |
| `agent/inflight.ts`                              | 窗口收窄为**纯收口器**：`WindowSpec` 只剩 `{cmds, closeOn?, gaCount?, timeoutMs?, label?, signal?}`；删 `criteria`/`branch`/`gaOutcome`/`onSettle`/`WindowResult.hit`/`hitText`；新增 `settled:'evidence'`（与 GA **同形不同名**）；`ReplySettle` 去 `'flow'`/`'until'`；**隐式缺省废除**——删除 `gaCount ?? cmds.length`                       | ✅ 已落地（W10.2 缺省删除 + W10.4 批次四收窄）             |
| `perceive/engine.ts` / `deliver/state-track.ts`  | 状态抓取改独立桶：抽取 → 同步 world；**`direct`** **命中行不消费、不推水位**；删除折叠消费；`deliveredAbs` 随单水位整体废除。`state-track.ts` 行为零变更、仅文档                                                                                                                                                                       | ✅ 已落地（W10.3 折叠删除 + W10.2 `deliveredAbs` 废除） |
| `session/session.ts` / `session/mount.ts`        | 入口投递复位重开；入口投递消息新增 `flow:{id}` 字段；**包装器** **`noteToolResult`** **传 content、`shouldConcludeTurn`** **换成驱动器终态判定**（B3）；回合结束接线（`agent/turn-stopping` + `agent/status` idle + `whenIdle()`）；装配期校验接线                                                                                       | ✅ 已落地（W10.4 第 5/6 步 + 批次三）                  |
| `session/preset.ts` / `agent/skills.ts`          | **T2 可见技能文本与流程所有权保持一致**：断线口径改"复位重开"后，`默认技能` 里"断线或自动登录失效时由你诊断并按步骤重连"、以及"确定性登录流程待重建为触发器 → lite"两处措辞需同步；技能目录经 `systemPrompt.section` 注入的路径不变                                                                                                                                           | ⏳ 待 W10.7                                   |
| `assemble.ts`                                    | 流程表 / 规则表装配期校验（清单见 3.9）；`agent/turn-stopping` + `agent/status` idle 接线                                                                                                                                                                                                              | ✅ 已落地（W10.1 双形 + W10.5 收紧 + W10.4 第 6 步）    |
| `agent/flow/engine.ts`                           | 收缩：**判据复判 / 推进 / 终态判定职责移交 T1 驱动器**；**arming 面退役**（符号清单见下方删除表）；**入口 arm 保留**；保留流程表声明、装配校验、`onSuccess` / 收束副作用、**`failPolicy.notify`** **出口**                  | ✅ 已落地（W10.4 批次二⑤ + W10.5 核查）                |
| `deliver/delivery-channel.ts`                    | **收窄而非清空**：删判据 B 面（`shouldConcludeTurn` 及其投递尺寸记账，删除符号为 `size` / `actionCount`；`rememberDelivery` 账本保留，为流程判据解析依据）；**保留判据 A（defer 槽 /** **`deferContext`）服务 T2 批次与规则动作**                                                                                                                           | ✅ 已落地（W10.4 批次三 + W10.5 核查；判据 A 保留）         |

**删除**：

| 位置                                                                           | 内容                                                                                                                                                                                                                                            | 状态                                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `agent/flow/engine.ts` / `agent/flow/flow-types.ts`                          | `windowSpecFor` / `noteToolResult` 流程部分——配对移交；**arming 面**：`armOwnJudgements` / `setArmed` / `matchFrom` / `processBatch` / `applyMatch` / `syncArmingToHost` 的步骤判据面 + `FlowRuntimeOptions.onStepJudged`                                      | ✅ 零残留（W10.5 核查）                                                             |
| `session/session.ts` / `deliver/adjudicator.ts`                              | `syncArming()` 的**流程分类重放面**（**注**：`syncArming()` 本身是武装标记机制总入口，**入口 arm**、打断常驻标记 + 直发判据投影共用 `arm()`，总入口与那两面**保留**）                                                                                                                             | ✅ 零残留（W10.5 核查；总入口保留）                                                       |
| `deliver/delivery-channel.ts` / `session/*`                                  | **判据 B 全套**（`shouldConcludeTurn` 及其投递尺寸记账）——改由**流程驱动器在推进点判定终态**、包装器转达 `exec.concludeTurn()`。**判据 A 不在删除面**                                                                                                                                    | ✅ 零残留（W10.4 批次三 + W10.5 核查）                                                 |
| `agent/t1.ts`                                                                | 无状态渲染器的流程部分（被 T1 按槽渲染取代；规则动作渲染职责保留）                                                                                                                                                                                                           | ✅ 已落地（W10.4 第 5 步）                                                          |
| `agent/inflight.ts` / `deliver/adjudicator.ts`                               | **形态 C 收窄面**：`WindowCriteria`（`ok`/`fail`）、`branch`、`gaOutcome`、`onSettle`、`WindowResult.hit`/`hitText`、`settleCriteria` 的按类结算、`armWindowMarker` 的多样标记；**形态 A 脚手架**：`closeForFlow()` / `ReplySettle='flow'` / `noteToolResult` 的 `'flow'` 早返回 | ✅ 零残留（W10.4 批次四 + W10.5 核查）                                                 |
| `agent/tools-build.ts` / `agent/tools-schema.ts` / `agent/flow/flow-spec.ts` | **tool-call 参数净删**：`classify` / `captures` 参数与 `resolveSettleWindow` 的 classify→criteria 映射；`classify`/`onSettle`/`captures` 转为**流程表字段**（不是工具面）                                                                                               | ✅ 已落地（W10.4 批次四）；`classify`/`captures` 现只存于流程表字段 + `normalizeFlowSpecs` 过渡桥 |
| `perceive/*` / `deliver/state-track.ts`                                      | §5 折叠机制（折叠行 / 折叠消费）；**`deliveredAbs`** **随单水位整体废除**（`mud_recall` 取消 / `mud_state` 去 `lines` 见修改表 tools-build 行）；§5 流程步"投递消息携带原文"——原文在 span 里                                                                                                        | ✅ 零残留（W10.3 + W10.5 核查）                                                     |
| `deliver/adjudicator.ts` / `agent/inflight.ts`                               | **N-GA 隐式缺省收口整体废除**（被 stream + fallback 3s 缺省取代，删除明细见修改表 inflight 行）；静态 `activityTable` 的 N-GA 缺省与分类命中结算职责——重定义为规则动作的显式收口声明载体                                                                                                         | ✅ 零残留（W10.2 + W10.5 核查）                                                     |
| `deliver/adjudicator.ts`（direct 面）/ `agent/flow/flow-spec.ts`                | **`action.direct`** **从收口 / 在途窗口 / 单水位体系中剥离**：不注册窗口、不结算、不产生 span、不推水位、豁免收口声明校验；`runDirectHits` 只保留"命中规则 → 直发命令"反射路径（危险命令硬边界与 I12 直发延后 gate 不变）                                                                                                | ✅ 已落地（W10.2 核查 + W10.3 折叠面删除）                                               |

## 5. 实施切片与测试验收

**两轨拆分**（原则 4：核心先运行，非核心让路）。轨 A 只做服务 T2 / 行流的清理，可独立落地；轨 B 才动 T1 状态化，前置是轨 A 完成。

**轨 A —— 行流与声明面（服务 T2，先行）**

| 切片                | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 依赖    | 验收           | 状态 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ | -- |
| **W10.0 目录搬迁**    | `flow/` 整体迁入 `agent/flow/`（纯路径变更，无语义变更）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 无     | tsc 清零       | ✅  |
| **W10.1 契约与表**    | tool-call 参数 schema（settle 判别式联合 / classify+`onSettle` / captures；**`classify`/`onSettle`/`captures` 后经 W10.4 批次四净删出工具面、转流程表字段**）+ 流程表重写（login / fullme：settle 步级显式、分类自填正则、GA 移入收口 `on`、fullme `prompt` 用 `mode:'inline'`、`answer` 用 stream + ok/fail 分类 + `fallback 180s`、`stale` 显式 `on ga:3` + `onSettle:'fail'`、`fallback.ms` 按实际步骤耗时填写）+ 装配期校验（双形：新形步骤表级 settle 显式，旧形步骤 legacy 兼容，W10.5 收紧）+ **工具层收口缺省 stream + fallback 3000（两 lane 一致）** + T2 命令工具显式声明 GA 收口（D9 R1）。落地文件：`agent/flow/flow-spec.ts`（类型 + 双形校验 + `normalizeFlowSpecs` 过渡桥）/ `agent/flow/engine.ts`（构造器接线）/ `agent/flow/flows/{login,fullme}.ts` / `agent/tools-build.ts` | W10.0 | A1 / A6 / R1 | ✅  |
| **W10.2 裁决器与水位**  | 单一收口路径（判据命中 / GA / fallback 三触发同一 `settle()`）+ 实时匹配与兜底到期结算 + span 交付 + capture 回调 + 结算优先级 + **单一水位线（交付水位废除、无回看结算）** + **取消** **`mud_recall`、`mud_state`** **去** **`lines`** + 收口口径四项：① 删除 GA 隐式缺省（**声明才计 GA**，见修改表 inflight 行）② `onSettle` 缺省 `'ok'` 生效 ③ **层内唯一类型** ④ `direct` 剥离。文件：`deliver/adjudicator.ts` / `agent/inflight.ts` / `tools-build.ts`。32 文件 / 361 例绿 + tsc 清零                                                                                                                                                                                                                                     | W10.1 | A3 / A7 / R2 | ✅  |
| **W10.3 状态抓取与折叠** | 状态抓取独立桶 + **`direct`** **面折叠删除（不消费、不推水位）** + 取消折叠消费。**折叠机制整体删除**（消费面 + 生产面）—— `perceive/types.ts` 删 `MatchHit.foldLines`、`perceive/matcher.ts` 删两处构造、`perceive/engine.ts` 删 `FeedResult.foldedAbs`、`deliver/adjudicator.ts` 站①注释 / 站⑤ recall 与 `pending` 过滤 / diag 折叠计数全删；`deliver/state-track.ts` 与 `perceive/rules.ts` 文档改"状态抓取桶"（**行为零变更**）。实际动到：`perceive/{types,matcher,engine,rules}.ts` / `deliver/{adjudicator,state-track}.ts` + 4 测试文件；32 文件 / 360 例绿 + tsc 清零                                                                                                                                                  | W10.2 | A3 / A9      | ✅  |

**轨 B —— T1 状态化（后行）**

| 切片               | 内容                                                                                                                                                                                                                                                                                 | 依赖          | 验收                | 状态           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------- | ------------ |
| **W10.4 T1 状态机** | 形态 C 落地（收口器 + 驱动器复判）+ `flow-driver` 替换渲染器流程部分 + 槽表（会话作用域，I8）+ 定位键 `sessionId` + 工具层收口缺省 stream + fallback 3s + **A2 同帧定序 fail → 分支 → ok** + **终态判定（B3）** + 回合结束接线。要点见下方"W10.4 要点"；决策依据见 D3 / §6.1                                                                                  | 轨 A 全绿 + 账目 | A2 / A4 / A5 / A8 | ✅ 已收官        |
| **W10.5 删除旧路径**  | 第 4 章删除清单**全量符号核查零残留**（`shouldConcludeTurn` / `actionCount` / `armOwnJudgements` / `onStepJudged` / `closeForFlow` / `WindowCriteria` / `gaOutcome` / `hitText` / `deliveredAbs` / `noteDelivered` / `mud_recall` 全部零命中）；判据 A 未删、`runtime-defer.spec.ts` 绿。tsc 清零 + 35 文件 / 367 例绿 | W10.4       | A8 / R3           | ✅ 2026-09-22 |
| **W10.6 测试对齐**   | `tests/loop-sim.ts` / `t1-adapter.spec.ts` / `flow-*.spec.ts` / `runtime-delivery.spec.ts` / `frame-splitter.spec.ts` + 行流守恒用例补 **span 记账面**（末节两面各一例：T2 窗口面 + 流程窗口面，含失败收束后行进后续消费批）。35 文件 / 369 例绿，tsc 清零                                                                           | W10.5       | A9                | ✅ 2026-09-22 |
| **W10.7 文档同步**   | §1（含 I8、新增 I16）/ §5 / §7 / §8 / §9 / §19 改写 + 术语表 + §17 登记 + `doc/CHANGELOG.md` 登记（v0.11.0）+ **技能文本同步**                                                                                                                                                                            | W10.6       | A10 / R4          | ⏳            |

**W10.4 要点**（实施顺序 1–7 步，已全部落地 2026-09-22；决策与账目见 D3 / §6.1 / §6.4）：

1. **账目与 B3 定案**：以 loop-sim 实测"现行接线"与"删判据 B 且不让驱动器判终态"两种接线的账目对照（对照表见 6.1、全量指标见 6.4），定案 **B3**（§6.1）。
2. **形态 C 落地**：关闭触发派生（`FlowRuntime#closeTrigger`，经 `lineCriteriaPattern`，随 `windowSpecFor` 的 `closeOn` 下发）；窗口收窄（`WindowSpec.closeOn` + `win-<n>:close` 标记；`settle()` 的 `'evidence'` 分支只带回 `{text, lines, span}`）；内容通道（**偏离计划字面**：span 行经 `InflightWindowTable#takeSettledLines` 单槽直送驱动器，不经工具结果透传——工具结果 `additionalProperties:false`，塞 `MudLine[]` 会暴露内部行号/style 并撑爆上下文）；驱动器复判（`judgeStep` / `judgementUnits` / `judgeFrom` / `applyJudgement` / `settleFallback`，固定类序 fail → 分支（含 retry driver） → ok，类内行序取首个）；arming 面退场（`armOwnJudgements` / `applyMatch` / `onStepJudged` / `closeForFlow()` / `ReplySettle='flow'` 删除；`armConditional` 只在 `succeedStep` 布防；**入口 arm 保留**）。
   - **带出两条语义**：① **判据只经窗口**——本步动作未执行（无在途窗口）时判据行不推进流程（用例 `flow-login`「判据行只在窗口内被判」钉住）；② **归属不再靠事后比对**——GA 只数 `confirmSent` 武装过的窗口，结构上不可能"上一条命令的 GA 结算下一步"。
3. **B3 落地**：`Adjudicator#noteToolResult` 返回 boolean；`MudDeliveryChannel#noteToolResult` 同步返回；`mount.ts` 包装器 `concluded` ⇒ `exec.concludeTurn()`。**判据 B 删净**；`rememberDelivery`/`rule`/`pending` 保留。账目见 6.1 表。
4. **工具面净删**：`mud_send` 删 `classify`/`captures`；`resolveSettleWindow(settle)` 单参；工具结果只剩 `{ok, note, cmd, settled}`；`WindowSpec` 只剩 `{cmds, closeOn?, gaCount?, timeoutMs?, label?, signal?}`；`WindowResult` 只剩 `{ok, cmd, text, lines, settled, span}`；`ReplySettle` 去 `'until'`；`diag().open.criteria` → `trigger`；`noteToolResult` 链去 `hitText`。
5. **槽表 + 发布点**（第 3 步，行为中性）：`agent/flow/slot.ts`；`FlowRuntime` 在迁移点发布；`render` 与 `windowSpecFor` 同一次派生；新增 `tests/flow-slot.spec.ts`（4 例）；33 文件 / 359 例绿。
6. **T1 渲染改造**（第 5 步，①②③）：① T1 按槽渲染（`slotOf` / `markRendered` 钩子；**渲染判定序** = **投递里的动作优先** → 无动作按槽渲染 → 槽不可渲染则收束；不发 `output` 文本块；确定性 callId = `mud-flow-<flowId>-<stepId>-<retries>`）；② callId ↔ 步骤配对移进槽（`stepIdForCall`；`pendingCallId` 由迁移点发布自动复位）；③ **删非入口步的投递**（`enterStep` 只在入口步 `push hit`；分支/顺序后继/复判进入的步零投递、零 defer）。**两拍定稿（③-1）**：槽一次只放一条待发调用；有 `retry.action` 时 `tryRetry` 发布拍 1（`awaitingPre=true`），结果回来时在判据分支之前拦截并发布拍 2；无前置且 `awaitExternal` 的步槽停 `awaiting-human`，外部值就位后由壳侧 `resumeHuman()` 发拍 2。**壳侧就位检查（D10）**：`adjudicator.noteToolResult` 在 `flow.noteToolResult` 之后查 `phase==='awaiting-human'` + `awaitingExternalKeys()` 值齐 → `resumeHuman()`。**T1 入口步** **`markRendered`**：对 `ruleId?.startsWith('flow:')` 补 `markRendered`。**夹具改造**：`flow-login` / `runtime-captcha` / `flow-interrupt` 改为先槽后投递；非入口断言改读 `slotAction(h)`。**账目（方案 A 已实测并定案）**：主路径全量指标见 6.4（不退化为历史 `followup` 基线，6.4）。指标口径：`claimlessSteps` = 有效本地 T1 续步（产出了 tool-call）；`idleSteps` = 无动作空步（收束空步）；`emptySteps` = 两者之和（兼容旧断言的汇总字段）。全量 364 例 + tsc 绿。**备选 B 否决留档**。
7. **回合结束接线 + A2 同帧定序**：`assemble.ts` 接 `agent/turn-stopping`（→ `session.onTurnStopping()` → `flow.noteTurnEnd()`：活跃流程随回合边界失效）与 `agent/status` idle（→ `session.onAgentIdle()`：失效兜底 → `refreshEntries()` 入口 arm 恢复 → `flushInterruptFollowups()` **打断事件动作 followup 新回合** → `drainFlowQueue()` → `drainQueuedEntries()` = `offer()` 原路重放）；引擎侧 `FlowRuntime#noteTurnEnd()` / `takePendingEntryLines()`，`finishFlow` 不再中途接续 pendingEntry；裁决器打断事件动作入 `pendingFollowups`；**连带缺陷修复** `onInterrupt` 直发补 `priority:'halt'`。测试：`flow-interrupt.spec` 改静止点断言；`loop-sim` 仿真 turn-stopping / idle；`loop-sim-login.spec` 新增打断账目用例。**A2**：由批次二④驱动器复判的固定类序天然实现；补**钉住用例** `tests/flow-judge-order.spec.ts`（2 例：① fail 赢分支与 ok；② 分支赢 ok）。**连带缺陷修复**：`FlowRuntime#failStep` 复位时漏 `slotTable.clear()`，已补齐。

> 切片编号统一用 `W10.*`。早期草案曾用 `S1–S6`，与 §8.8 的 v0.9 W7 切片撞车，已统一为 `W10.*`。

**验收场景**（每条细则见对应章节）：

- **A1 收口校验**：T1 流程步与注册窗口的规则动作未声明 settle 在装配期报错；T2 调用不声明是常态（缺省口径见 3.1）；tool-call 参数含 `classify`/`captures` 即拒绝；`direct` 豁免校验（3.1 / 3.9）。✅
- **A2 同帧与无回看**：登录 `replace` 分支"本步结果行 + 后继 driver 同帧"判定正确；同帧跨行多类命中按 fail → 分支 → ok 取一；命令发出前已在缓冲的行不参与本步结算；窗口关闭后到达的 driver 行视为没到（D3 / W10.4）。✅
- **A3 span 与状态桶**：命中结算 span ≥ 1 行，空值结算被拒；状态抓取结果同步 world、不推进水位、不折叠内容；`direct` 不消费、不推水位；行流无隐藏行、span 无空洞（3.6 / 3.7 / 3.10）。✅
- **A4 会话形状**：一个流程 = 一个回合、全程 T1；回合内不出现投递消息（除入口）；入口 1 次 + 助手/工具交替；loop-sim 账目与设计一致（D1 / W10.4）。✅
- **A5 打断与失败**：打断 → `interrupted` → 流程槽复位 → finish stop → 事件动作 followup 新回合；流程失败 → `failPolicy.notify='t2'` 时投递一条 T2 可见失败消息 → 回合结束，T2 接手（D4 / D5）。✅
- **A6 兜底到期**：到期即 `timeout` 结算（不属于 ok/fail），提交全部窗口内容并记当前调用者消费；随后流程失败收束（D4）。✅
- **A7 优先级**：打断 > 关闭触发/GA > 超时 > 断线；打断与关闭触发同帧时打断优先，关闭触发作废留痕（D5 / 3.5）。✅
- **A8 删除回归**：第 4 章删除面无残留引用（tsc 清零）；既有用例对齐后全绿。✅（W10.5：35 文件 / 367 例）
- **A9 行流守恒**：可测不变量用例（span + T2 批次 + 命中行 + 带原文投递 == 完整入站行流）；流程失败未结算行计入后续消费批。✅（W10.3 + W10.6：35 文件 / 369 例）
- **A10 文档一致**：正式章节与实现一致；§17 / CHANGELOG 大版本登记。⏳ 待 W10.7
- **长命令**：dz / sleep 以结束标记正则（分类 / `on`）收口、`fallback.ms` 表内按实际步骤耗时写大值（GA 仅显式声明收口时使用；哨兵探测步为实验功能，不进验收）。

**T2 回归验收**：定案与状态见 D9 表（R1–R4）；R1 / R2 / R3 ✅ 已落地，R4 ⏳ 待端到端用例。

## 6. 未决、待实测与完成定义

### 6.1 已裁决事项（结论存档）

- **形态 C**：收口的位置也注册触发器，但只返回收口信号（与 GA 同形不同名），工具带回的内容由驱动器按判据再走一遍。
  - **收益**：① 窗口净退化为收口器；② 收口与判据**不可能分歧**（触发从判据派生，一份声明）；③ **A2 的 fail → 分支 → ok 定序天然正确**；④ **I15/I16 最干净**（流程步 tool-call 与 T2 完全同形，流程词汇一律不进模型可见面）；⑤ 形态 A 脚手架自然退役。
  - **连带收缩**：tool-call 参数净删 `classify`/`captures`；工具结果净删 `hit`；`onSettle` 提为步级字段；`captures` 归驱动器在 span 上抽；**禁止无 action 的步**（现状 login/fullme 全部带 action，无回归）。
  - 完整机制见 D3 / 3.1 / 3.5。✅ 已落地
- **B3**：终态由流程驱动器在推进点判定，包装器只转达。
  - **推进点不挪**：仍是 `noteToolResult`（工具调用**在途期间**由生产包装器喂回流程机，`session/mount.ts:143`）。
  - **决策者**：末行的 `shouldConcludeTurn(callId)`（裁决器按"投递尺寸 + 流程是否空闲"**推断**）→ 换成**流程驱动器直接给出的终态判定**；运行时不做任何流程推断。
  - **账目**：1 回合 / 3 步 / 3 请求 / 0 空续步；**判据 B 的投递尺寸记账照样删净**；**不新增任何工具参数**；**决策者只有流程驱动器一个**。✅ 已落地（W10.4 批次三）
  - **机理**：工具结果**不进** **`next-step`**（官方只在 `deferContext` 时往 `next-step` 追加，`agent-loop/src/agent.ts:489-492`）⇒ 末步之后 `next-step` 为空而 `turnEnds` 仍为 null ⇒ 回合不结束，再走一个 `claim=0` 的步。DSH 的 `step()` 在本步有 tool-call 时**不看 finish reason**（`:487-488` `toolCalls.length === 0` 才收束；`:493` 无 `concluded` 则返回 null ⇒ 同回合继续），T1 自己发 `stop` 只会落在下一次请求上，那正是空续步。
  - 实测数据（`tests/loop-sim-login.spec.ts`，官方 loop 模拟器 + 真实运行时/工具/流程/T1，只切换包装器早停接线）：
    | 接线              | 回合 | 步 | 请求 | 空续步   | defer | concludeTurn |
    | --------------- | -- | - | -- | ----- | ----- | ------------ |
    | 现行（判据 B 在）      | 1  | 3 | 3  | **0** | 2     | 1            |
    | 删判据 B 且不让驱动器判终态 | 1  | 4 | 4  | **1** | 2     | 0            |
    | **B3 目标（已达成）**  | 1  | 3 | 3  | **0** | 0     | 1            |
  - **备选（均已否决）**：**A** 接受 1 空续步；**B1** 终态步 tool-call 里加模型可见的 `conclude` 参数；**B2** 运行时按投递尺寸/流程空闲**推断**终态（= 现行判据 B，与 D5/D8 冲突）。
- **MVP 删除字段的延后条件**：`onMatch:'tag'`、`captureScope:'window'`、多行分类——三者随同一扩展一并评估，需先有真实消费场景。

### 6.2 实现待定

- `connectionGen` 从哪读（现行等价物是"`abs` 每连接重置 + `reset()` 全清"）。⏳
- span 审计的时间窗与 `PerceptionBuffer`（2000 行上限）驱逐策略的关系 —— span 只有 `fromAbs/toAbs`，留痕回读受缓冲驱逐约束。⏳
- `recallLines` 缓冲降级为诊断通路：`/mud/diag` + log-service 可读，**不进模型工具面**；保留行数沿用 2000 行上限与自然驱逐。✅ 已落地（W10.2）
- 窗口缓冲上限、每窗口最大分类数（分类正则 + `on` 条件）。⏳
- 打断 / 断线时在途窗口已收内容的消费口径（缺省：留痕消费，水位推进到缓冲头）。⏳

### 6.3 数值待校准（实测后定）

- 步数 / 时间 / 重试预算的默认值与配置位置。
- fallback 兜底时长缺省 **3000ms**（T2 量级短超时）的实测校准；T1 流程表 `fallback.ms` 按实际步骤耗时填写（各步耗时分布实测见 6.4）。
- T2 攒批上限时长（若保留攒批机制，此处只校准数值）。
- **批次裁剪阈值** `MAX_INJECT_TAIL_LINES = 64` / `MAX_INJECT_TAIL_CHARS = 8000`（`session/types.ts`）—— 取消 recall 后它成为"单批能给模型多少内容"的唯一闸门，需实测校准；`MAX_PARKED_LINES = 512`（`pending` 丢最旧行的口子）是否随调。

### 6.4 实测记录与待实测

**已实测（留档）**：

- **loop-sim 新形态账目（W10.4 第一步）**：两种接线的账目对照与 B3 目标达成情况见 6.1 表；历史 `followup` 基线 3 回合 / 6 步 / 6 请求 / 3 空续步 —— 新形态未退化。
- **主路径（`earlyStop='conclude-turn'`）**：`turns=1, steps=3, modelCalls=3, emptySteps=2, claimlessSteps=2, idleSteps=0, t1Calls=3, t2Calls=0, toolCalls=3, deferred=0, concludedTurns=1`。对照 `earlyStop='none'`：4 步 / 4 请求 / `idle=1`。
- **打断改 followup 的代价（W10.4 第 6 步接线落地）**：练功在途时战斗事件打断（interrupts 200 > 100）→ 在途结算 `interrupted`、流程复位、combat 动作持有 → 回合 1 收束 → 静止点 `flushInterruptFollowups` followup 新回合 → combat 动作执行 → hold 兜底 3s 结算 → 回合 2 收束。实测：**2 回合 / 4 步 / 4 请求（全 T1，t2=0）/ claimless=0 / idleSteps=2 / deferred=0 / concludedTurns=0**；相对 defer 同回合旧路径（推断 1 回合 / 3 步 / 3 请求），代价 = **+1 回合 / +1 步 / +1 次 T1 本地请求**，全程无 T2 介入、零 defer。

**仍待实测（⏳）**：

- N-GA 声明表真机抓包核对（dazuo 等长命令 gaCount 实证，W7.2 遗留）。
- dz / sleep 结束标记正则实测。
- **T1 流程步耗时分布实测**（login / fullme 各步实测耗时，支撑流程表 `fallback.ms` 逐表填写）。
- **T2 读工具延迟对照**（R1/R2 的量化基线）；裸 `mud_send` 恒等满 fallback 的实际等待量级记录。
- **R4 端到端用例**（流程失败 → `notify='t2'` 投递 → T2 接手）。

### 6.5 文档同步（W10.7）

- §5 / §7 / §8 / §9 / §19 对应改写；§1 不变量按第 2 / 3 章口径落稿。
- **§1 不变量改动范围**：I2 / I4 / I11 / I12 / I13 按新口径改写；**I8 纳入覆盖章节**（D10 的槽表归属）；**I15 原文保持不变**，新增 **I16**（T1 私有状态不进 T2 可见面）。
- 术语表：新增（收口-分类分离 / 形态 C＝收口器 + 驱动器复判 / 关闭触发 / 单一水位线 / 状态抓取桶 / 流程驱动器 / 触发器反射（direct））；删除或改写（判据-only / 配对移交 / arming 集 / 唤醒 / 折叠 / 三水位 / 发送水位 / 交付水位 / 回看结算 / 历史查询）；defer 保留。
- §17 新增切片行（W10.0–W10.7）；`doc/CHANGELOG.md` 按版本号规则登记（本计划属核心重构，升大版本 v0.11.0）。
- **D0 结论同步进正式章节**（§19 或 §17），避免"官方有无流程插件"被反复重新提出。
- **I15 复核**：tool-call 参数 schema（`settle`）的模型可见措辞过 I15 检验（随 W10.7）。
- **技能文本同步**（`session/preset.ts` / `agent/skills.ts`）。

### 6.6 完成定义（满足后才从本文件删除本计划）

- W10.1–W10.7 全部落地且验收场景 A1–A10 + \*\*R1–R4（T2 零回归）\*\*通过（全包测试绿 + tsc 清零）。
- loop-sim 新形态账目出具且不退化为 followup 基线。
- 文档同步完成（范围见 6.5）。
- 此后按文件头约定删除本节，不留档。

