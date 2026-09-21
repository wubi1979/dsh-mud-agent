# PLAN.md — 新计划起草区

> **本文件角色（2026-09-18 起）**  
> 本文件是后续新计划的临时起草区，只用于起草和修改计划，不作为正式设计文档，也不作为长期事实来源。任何新计划必须先在本文件中起草成型；实施完成后再同步到 `doc/architecture/` 的正式章节，并在 `doc/CHANGELOG.md` 登记一行。同步完成后，本文件中对应内容必须删除，不留档。

> **起草约定**：
> - 新计划按“对照源码变更的实施计划”组织，至少含六节：① 元信息与范围（状态、覆盖项、目标/非目标）；② 背景与核心决策；③ 机制与契约（接口、状态机、配置校验、行流归属）；④ 源码变更清单（新增/修改/删除到文件/模块粒度）；⑤ 实施切片与测试验收；⑥ 未决、待实测与完成定义
> - 小改动可合并为四节：目标与决策、契约与变更、实施与验收、未决与收尾。缺核心章节者不得视为可实施冻结。
> - 起草期内容不占用 `§N` 稳定编号；`§N` 仅用于正式章节。引用现行设计时一律写 `§N`，不要写裸文件名。**本文件自身章节的引用不带 `§`**（小节写作 `3.1` / `6.2`，整章写作 `第 4 章`），避免与正式章节编号混淆。
> - 起草项实施完毕并同步到正式文档后，必须从本文件中删除该项，不留历史记录。若计划尚未实施或尚未同步，不得删除本文件中的对应内容。
> - 所有例数、计数、规模等数字，一律以当次实测为准，不得硬编码历史值。交付切片统一使用`W*`编号，具体序号见 `doc/architecture/17-18-roadmap.md` ，顺序增加。
> - 计划的内容不被任何设计文档引用。如需引用设计，需先同步到正式文档再做引用。

## 待办池：后续计划启动方向（源自 §18 未决，2026-09-19 迁入）

> 用途：编制新计划的取材清单，条目编号用 `T*`（非 `§N`）。条目仅作启动方向提示，起草新计划时以 §18/对应章节的现行口径为准复核。某事项立项起草后在此标注"已立项 → 见本文件对应计划"；实施落地后从本表删除并同步 §18（§17–§18 仍为当前状态唯一来源，本表不承载状态事实）。

| # | 事项 | 启动方向建议 |
|---|---|---|
| T4 | 流程内部并行分支 | 同流程多 driver 并行推进的语义与结算归属；先确认是否有真实消费方（login/fullme 都是严格串行），无则维持 §18 的非目标口径 |
| T5 | W5 尾款 | `pendingEntry` 端到端用例；`hpbrief` 应答折叠进 world（§19.7 待定 1/2） |
| T6 | 并发调度分类器（I11 边界） | `isConcurrencySafe` 是我们在 `defineTool` 里自己可加的字段（非上游依赖）：给 `mud_state`/`mud_recall`/`mud_help` 这类零发送只读工具声明并发安全时，必须同时重估 I11 |
| T7 | 窗口期分页被延后 | 明确窗口内插话命令的归属判据（§8.3）+ 翻页命令（`pager:continue`）的直发豁免策略（gateRank） |
| T8 | `halt` 无条件豁免直发延后 gate | 豁免收紧为打断路径专用并留痕（§18.8：非打断路径 halt 应答 GA 可能污染在途窗口计数） |
| T9 | 装配层测试基建（§18.9） | vitest 管线加载不了 TC39 装饰器模块 → 是否引入 esbuild/swc 变换链，或继续把可测策略从装配层抽出来（W9 的 `session/credential-source.ts` 即后者） |

---

## 计划：T1 从「无状态渲染器」改为「有状态流程驱动器」

> 状态：**草案（2026-09-21 三次修订；契约未冻结）**。方向已定案（D0 核实：官方无流程管理插件，T1 必须保留流程所有权）；架构决策见第 2 章 D1–D11。**契约（流程表 schema / tool-call 参数 schema / 裁决器接口 / T1 槽结构）仍在第 6 章待定稿** —— 未冻结前不得据其改代码。本轮修订同时：① 把原文件末尾的散文评审 9 条按四分类并入第 6 章（对照表见 6.5）；② 修正 6 处与源码不符的表述（清单见元信息修正表）；③ **收口/分类结构分离**（settle 改 `mode:'inline'|'stream'` 判别式联合、time kind 删除、fallback 缺省 3000 且到期恒 timeout、`classify.onSettle` 取代 `ref:'settle'`、取消 text/onMatch/priority/captureScope，D3/3.1）、**三水位归一为单水位**（回看结算取消、recall 改历史查询，3.7）、**flow 目录整体迁入 agent**（W10.0）。
>
> 本计划实施后按文件头约定同步正式章节并删除本节。

### 0. 决策门（前置核实，已闭合）

开这笔投入（6 个以上切片、核心重构、大版本）之前必须先回答一个问题：**DSH 官方是否已有流程管理插件？** 若有，按设计原则 T1 应降级为渲染器，本计划整体作废。核实结论如下（源码 checkout `D:\code\deepseek-harness`）：

| 检查项 | 结论 | 依据 |
|---|---|---|
| 官方有无声明式流程表插件（步骤→动作→判据→下一步） | **无**。`workflow` 的 `meta.phases` 自带注明"仅进度词汇，不施加任何执行结构"；全仓 `StateMachine`/`transitions:`/`StepTable` 只命中客户端 UI 状态机 | `packages/workflow/workflow/src/types.ts`；`packages/client/ui-conversation/src/client/input/machine.ts` |
| 官方 `workflow` 能否承载 login / fullme 这类流程 | **不能**。它是"模型写 JS 脚本扇出子代理"，且 README 明写 *Foreground collection only*、*No journaling or resume*、*No saved or nested workflows*；脚本钩子只有 `agent()/parallel()/pipeline()/phase()/log()` | `packages/workflow/workflow/README.md` |
| 语义上是否兼容 | **不兼容**。MUD 流程要求"无 LLM 在环"（§19.6.1 实测 `t2Calls === 0`），而 workflow 的入口是 LLM 写脚本 / LLM 调工具 | §19.6.1 |
| 最贴近的官方先例 | `goal-round-driver` —— 纯插件（`inject = ['agents','goals','sessions']`），在 `agent/status` 转 idle 的静止点用 `agent.followup()` 排下一轮，并用 `agent/pre-step` 拦截该轮 | `packages/goal/goal-round-driver/src/index.ts` |
| **D0 结论** | **官方无流程管理插件 ⇒ 降级 T1 的前提不成立 ⇒ T1 保留流程所有权，本计划方向成立** | — |

**D0 的副产品**（直接消解本计划两处"待定"）：

- 回合结束接线点不必再"待定"，官方现成两个钩子：`agent/turn-stopping`（serial、被 await 后才提交边界、监听者可 `agent.steer()` 让机器重读 inbox）与 `agent/status` 转 idle + `whenIdle()`（goal-round-driver 的静止点模式）。
- T1 槽的定位键有官方出处：`GenerateOptions.sessionId`（"Session identity stamped by the loop for request routing"）。

> D0 的结论应随本计划同步进正式章节（§19 或 §17），避免后续再被重新提出。

### 1. 计划元信息与范围

| 项 | 内容 |
|---|---|
| 状态 | 草案（2026-09-21 三次修订：收口/分类分离（mode 判别式联合）+ 单水位 + flow 迁移；契约未冻结） |
| 覆盖待办池条目 | 不直接消费 T4–T9。与 T6（并发安全重估 I11）/ T7（窗口期分页归属）/ T8（halt 豁免收紧）在裁决器与窗口注册面上有接触，实施时维持 §18 现行口径，不扩大处理 |
| 覆盖正式章节 | §1 不变量（I2 / I4 / I8 / I11 / I12 / I13 / **I15 保持不变**）、§5（行流 / 投递 / 折叠 / 水位）、§7（T1）、§8（裁决器 / 在途窗口）、§9（装配面：技能文本）、§19（流程运行时）、术语表 |
| 实施后去向 | 同步上述章节 + §17 切片登记 + `doc/CHANGELOG.md` 登记（**大版本**：T1 状态化与收口/分类分离属核心重构，v0.11.0 线）→ 按文件头约定删除本节，不留档 |

> **与早期草案的口径推翻**（修正理由见 D3 / D5）：
> - 早期 v0.10.2 登记过「**GA 全域无缺省**」→ 二次修订定为「**收口缺省 time/3s 全局统一**：工具层两 lane 一致缺省兜底；T2 命令类工具显式声明 `settle ga:1`；流程表/规则表步级仍须显式声明（装配期报错）」→ 三次修订形态收敛：**time kind 删除**，缺省 = `{mode:'stream'}` + `fallback:{ms:3000}`，到期恒 timeout（D3）。
> - 早期 v0.10.1/v0.10.4 登记过「**defer 面全删**」→ 本计划收窄为「**只删 T1 流程步进对 defer 的依赖；保留判据 A 服务 T2 批次与规则动作的在途投递**」。
> - 二次修订另废除「**三水位 + 回看结算**」→ 归一为**单一水位线**（回看结算系概念性错误，取消；recall 改历史查询，交付水位废除，见 3.7）。

**本轮修正的 6 处与源码不符表述**（实施前必须按此口径，不得照抄早期草案）：

| # | 早期写法 | 源码事实 | 修正 |
|---|---|---|---|
| 1 | criteria schema 只有 `ok/fail/branch/ga` | `FlowMatch` 有四种 kind，`kind:'tool'` 存在且 **fullme 3 处在用**（`ok:[{kind:'tool',outcome:'ok'}]`） | `tool` 收口改 `mode:'inline'`、`ga` 移入收口 `on` 条件、`text` 取消（3.1 收口/分类分离）；W10.1 重写 fullme：`prompt`/`answer` 用 `settle:{mode:'inline'}`、`stale` 用 `on ga:3` + `onSettle:'fail'` |
| 2 | 删除清单写 `deliverySizes` | `src` 里**已无此符号**（现为 `delivery-channel.ts` 的 `size` / `rememberDelivery` 与 `actionCount`） | 第 4 章按现行符号改写 |
| 3 | 删除 `syncArming()` 的"流程 arming 重放" | `syncArming()` 是**武装标记机制的总入口**（打断常驻标记 + 流程分类正则 + 直发判据投影共用 `arm()`） | 第 4 章限定删除面为"流程分类重放"，保留总入口 |
| 4 | "取消折叠"只定 state 抓取行 | `foldedAbs` = **state 折叠行 ∪ direct 命中行**两类并集 | 3.6 定 direct 命中行的新归属 |
| 5 | 3.7 "缓冲头"单数 | 行流有**两级缓冲**：`open`（未提交帧，`arm()` 的"arming 即测"只扫它）与 `pending`（已提交待投递，被 T2 限流 / 人工环节压着） | 3.7 单水位消解"回看数据源"问题；两级缓冲仍是提交/投递的物理形态，不再是结算数据源 |
| 6 | 元信息覆盖章节漏 I8 | T1 是**注册进官方 llm 注册表的进程级单例 adapter**，现行完全无状态；状态化后槽表归属决定 I8 合规性 | 覆盖章节行纳入 I8；3.4 / D10 定槽表归属 |

**目标**：
- T1 从无状态动作渲染器改为有状态流程驱动器；流程回合内的"上下文注入 / 助手 / 工具"三件套消解为"入口投递 1 次 + 助手/工具交替"。
- **收口与分类结构分离**：收口为 `mode:'inline'|'stream'` 判别式联合，缺省 stream + `fallback:{ms:3000}`，窗口恒有界（到期恒 timeout）；分类只支持自填正则（`onSettle` 承载收口关窗时的裁决）；流程表 / 规则表步级仍须显式声明收口（装配期报错，工具层不报错）。
- 行流守恒可测：每行恰好被消费一次，无折叠、无移交、无隐藏行。
- **T2 能力零回归**（D9）：`mud_recall` / `mud_state` / `mud_look` / `mud_status` 的既有语义与量级不退化；T2 可见的技能文本与流程所有权保持一致。

**非目标**：
- 不做断线后流程挂起续接（已迁 §19.7 待定 #3，真实需求出现时再立项）。
- 不做多流程并行（T4）、不重估并发安全（T6）、不改分页与 halt 豁免策略（T7/T8）。
- 哨兵探测步（`set actioned` / `response actioned`）仅为实验功能，不进常规能力与验收。
- 多行分类仅作可选扩展预留，MVP 单行（第 4 章"单行提示写成一条正则"约束保留）。
- 不改写 I15（见 D7.4）：它是保护 T2 可用性的那条不变量，本计划新增 I16 承载 T1 私有状态边界，I15 原文不动。

### 2. 背景与核心决策

**现行问题**：T1（§7）是**无状态动作渲染器**——动作由规则/流程声明并随投递消息送到，T1 只把 `source.actions` 渲染成 tool-call；流程状态归运行时（§19），两者靠 `flow.windowSpecFor` 配对移交判据、`noteToolResult` 事后推进来缝合。直接症状：流程每步一条投递消息（"上下文注入 / 助手 / 工具"三连，注入原文与上一步工具结果重复）；决策者有两个（运行时判据 + T1 渲染）。

**目标形态**：T1 = **有状态的流程驱动器 + 输出渲染**（按 `sessionId` 分槽）。与 T2 同构：拿工具结果 → 查表决策 → 发下一个 tool-call；唯一区别是决策来源——T2 由 LLM 判断，T1 依流程表判断。二者用同一套发送工具、同一结果形态。

**决策归并（D1–D8，括号内为原 P 编号）**：

**D1 入口**（原 P1 + #8）
- 流程入口经 **USER 注入投递**开回合，与 T2 同形（消息带原文 + `actions`；对规则动作它是"要做什么"，对流程入口它是"启动哪条流程 + 第一步"）。T1 保留两类回合职责：流程回合（状态机驱动）与动作渲染回合（规则动作渲染，无状态）。**注**：现行 T1 代码里没有这两类回合的区分面，这是新增契约面（区分定案见下一条）。
- **两类回合区分面**（2026-09-21 定案）：入口投递消息新增可选字段 `flow?: { id: string }`（与 `actions` 并列；带 = 流程入口回合，不带 = 动作渲染回合）；T1 判定序 = 槽活跃 → 流程回合（查表推进）｜槽不活跃 + 消息带 `flow.id` → 开槽启动｜其余 → 渲染回合。不复用 `ruleId` 的 `flow:` 前缀字符串解析（留痕字段不承载判定语义）；`flow.id` 在装配期校验必须存在于流程表。**callId ↔ 步骤关联**：T1 组装每步 tool-call 时把 callId 写入槽 `pendingCallId`，工具结果先校验 callId 配对（不匹配 → 被动复位，D6），匹配才按 hit 查表推进；`stepId` 不出槽（不进消息、不进结果文本，I15/I16）。**lane 不加值**：两类回合均为 `lane=t1`，`turnLane` 取值保持 t1/t2（D9 红线），区分由消息字段 + 槽状态承担。
- 入口投递**一律复位并重开流程**，不接续旧状态。**pendingEntry 出队投递 = 入口投递**（2026-09-21 定案）：出队与即时投递行为一致，同样复位重开——出队只发生在回合结束、槽已失效之后（D6 `drainFlowQueue`），与 I10 互斥无冲突。
- 入口 arm 仍在会话侧（模型只在回合里活着，"流程该不该启动"必须有人在无回合时盯着行流）。这是流程内唯一必需的注入。
- **入口原文即触发行**：命中即消费，消费水位自然推进过该行；入口投递只引用已消费行，不重复消费行流。

**D2 步内机制**（原 P2 + P3 + #1 + #6）
- 六步循环：① 进入步骤 N，从流程表取收口（settle）+ 分类集（fail / ok / 分支 driver 全显式）+ capture 规格 → ② T1 组装阶段把命令 + settle + 分类集 + captures 写入 tool-call → ③ 工具：校验 → 凭据插值 → **confirmSent（注册收口+分类进裁决器，owner = 本窗口）→ 写 socket，两者之间零间隙** → ④ 裁决器结算（实时命中 / 兜底到期 / 打断）→ ⑤ 工具返回 `{settled, hit, span, captures}` → ⑥ T1 查表：更新槽值 → 下一步或收束。
- **收口与分类只由 T1 组装写入**（tool-call 参数）或规则/直发显式声明（规则表 / 活动表条目）提供；**T2 不传参数 ⇒ 走收口缺省 `{mode:'stream'}` + fallback 3s（D3）**。
- **无任何"结算后等行"状态**：窗口只在分类/on 命中 / 兜底到期 / 打断 / 断线时结算，步的等待全部在工具内部。

**D3 收口与分类分离**（原 P4 + P5 + P6 + #1 + #2；2026-09-21 三次修订：mode 判别式联合 / time kind 删除 / onSettle 取代 ref）
- 分类集**按步**随 tool-call 供给，**全显式**；空类 = 该类不命中、跳过（不是整体失败）。**不得**流程启动时全表注册（后续步分类会提前命中）。
- 判定顺序：**fail → 分支 → ok**，固定不可配（`priority` 字段 MVP 删除——同帧多命中按此序取一，其余留痕，不靠调序消音；表编写 bug 由作者自查，不做装配期特异性告警；与 login `replace` 分支同帧实录一致）。
- **收口（settle）与分类（classify）结构分离，不得混杂**：settle 为判别式联合——`{ mode:'inline' }`（本步工具结果即收口，不经行流）或 `{ mode:'stream', on?, fallback? }`（行流窗口）；`on` = **提前关窗条件**，kind 全集 = `regex` / `ga`（**time kind 删除**——纯计时窗 = stream 无 `on`，时间恒由 fallback 管）；分类只支持**自填正则**（`RegexSpec`）；`text` kind 取消（正则转义覆盖），`{ref:'settle'}` 引用机制取消（由 `onSettle` 取代，见下）。旧"判据数组内混排 regex/ga/tool"形态废除，GA/tool 不再是分类 kind。
- **收口缺省 `{ mode:'stream' }` + `fallback:{ms:3000}`，窗口恒有界**：`on` 命中提前关窗；`fallback` 兜底时长恒在。**fallback time 兜底收口即 timeout 行为**：缺省 3000 是 T2 量级的短超时；**T1 流程表步级按实际步骤耗时填写**（dz 等长命令步写大值）。**兜底到期恒为 `timeout` 结果，不属于 ok/fail**（"到点即成功"用法废除——须以 `on:{kind:'regex'}` 证据关窗）。
- **收口关窗时的裁决 = `classify.onSettle`（缺省 `'ok'`，可 `'fail'`）**：`on` 条件关窗、分类未命中时的裁决由它承载。**fullme `stale` 三连罚站 = `settle:{mode:'stream',on:{kind:'ga',count:3}}` + `classify:{onSettle:'fail'}`，显式写出**（旧口径依赖缺省 `gaCount = cmds.length = 3` 的隐式行为、二次修订的 `fail:{ref:'settle'}` 引用、及"GA 到达 + 判据存在但未命中 → fail"的隐式分类缺省，一并废除——保守判定必须显式写 `onSettle:'fail'`）。
- **`mode:'inline'` 收口**：本步工具结果即收口（不开行流窗口），服务"只调工具、不发游戏命令"的步骤（fullme `prompt` 取图、`answer` 提交）；裁决固定映射（工具 ok→ok / error→fail）；**inline 下声明 `classify`/`captures` 报错**（无行内容可分类，fail-loud）。
- **两 lane 缺省统一**：工具层缺省 stream + fallback 3s 对 T1/T2 一致，调用期不报错；**流程表 / 规则表步级仍须显式声明 settle，漏写在装配期报错**（fail-loud 作者纪律，防笔误静默吃 3 秒）。T2 命令类工具（`mud_look`/`mud_status`/`mud_move`）在工具 schema **显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**（现行 `gaCount:1` 声明自然迁移）；**GA 隐式早关废除**——未声明收口的窗口 GA 早到不提前关窗（`inflight.ts` 的 `gaCount ?? cmds.length` 隐式缺省废除）。
- 规则动作 = 显式声明（载体为规则表 / 活动表条目；活动表从"N-GA 缺省 + 判据命中结算"重定义为"规则 / 直发命令的显式收口声明载体"）。
- **回看结算取消（概念性错误）**：命令发出前已在缓冲里的行不是本命令的应答，不参与本步结算，留给后续消费批；同帧到达的"本步结果行 + 后继 driver"由**本步 `classify.branch`** 承接（判定序当场取一）。旧"发送水位 + 回看区间"机制整体删除，6.1 原"回看数据源"未决随之消解。
- span = **水位 → 触发行（含）**（单水位，3.7）；触发行之后的同帧行、GA、迟到行落后续消费区间作前置噪声。**非空结算约束**：命中结算的 span 至少含触发行一行（GA 行计入），禁止空值结算；兜底到期且零行 = 无应答事实，留痕收束，不产出空 span。
- **状态抓取为独立桶**：抓取结果**只同步 world**；**不推进水位、不折叠内容**——状态行作为普通行被后续 span/批次包含，行流无隐藏行（#2 取代原 U3"折叠但不推进水位、不进 span"口径；2026-09-21 确认：状态抓取行不推进水位，否则会把水位推过尚未武装的入口/规则触发行）。
- capture 规格随分类集注册（**2026-09-21 定案**：正则用 JS RegExp 写法；**槽名 = 命名捕获组** `(?<name>…)`，`captures` 由 `{槽名: 正则}` 映射简化为正则数组；**未匹配不报错**——该槽如实缺省、工具正常返回），**逐行扫 span（到达序），每槽先到先得**，命中经回调把抽取值送回工具 → 工具结果 `captures` → T1 存槽；`captureScope` 字段 MVP 删除（'window' 跨行抽取随多行分类扩展延后）。占位符三类通道：`{name}`/`{pass}` 原样传参、工具经凭据 seam 发送瞬间插值（明文不落转录/日志/tool-call 参数）；`{captcha}` 工具内部闭环；capture 槽 / `{lastFail}` 由 T1 组装时直写值。
- 分类是结算分类器 ⇒ **误命中 = 误结算**：分类特异性是流程表编写纪律，**装配期不做特异性检查**（2026-09-21 定案：正则写错属配置问题，作者自查）。

**D4 兜底到期与失败**（原 P7 + P8 + #3；**失败出口按原则 1 修正**）
- **兜底到期不做最后判定**：`fallback` time 兜底收口即 `timeout` 行为（无独立"到点成功"结算形态）——到期（`fallback` 耗尽且无分类命中）即**提交全部窗口内容**（水位 → 缓冲头），**记为当前调用者消费**（水位推进到缓冲头）；随后流程失败收束。到期不进 retry（retry 仅由 fail 分类驱动）。
- **T2 不接受移交**：T2 批次永远自行从水位起消费，不接收流程侧移交内容（原"超时窗口内容自然移交给 T2"口径废除）。
- **步骤 fail**（分类命中 fail 类）→ 表内分支 / 重试（决策者职责）；fail 命中且无重试/分支 → 流程失败。
- **流程失败必须对 T2 可见**（**修正早期"T2 从下一条投递接手"的被动口径**）：现行 §19.5 明文"失败/超时 → 留痕 + **交 T2 决策一次**，不静默停住"，实现载体是 `failPolicy.notify`（缺省 `'t2'`，`flow/engine.ts` 在失败时投递一次唤醒 T2；login/fullme 现配置为 `notify:'none'`）。新模型保留该能力与字段：
  - 缺省（`'t2'`）：流程失败/超时 → 留痕 → 复位 → **主动投递一条 T2 可见消息**（原文 = 失败原因 + 剩余未结算行）→ T1 `finish stop` 结束回合 → T2 接手。
  - `'none'`：只留痕，不主动投递（login/fullme 维持现配置）。
  - 理由（原则 1 + I4）：若失败时零未结算行（超时且零行），被动口径下 T2 得不到任何输入 = 静默停住。
- **流程失败的未结算行不丢弃、不移交**：留在缓冲，作为下一批入口原文（入口 driver 命中）或 T2 批次被消费（#8）。
- 预算：步数 / 时间 / 重试预算防 T1 高速空转（收口兜底时长 / retry.attempts 已有，步数预算为流程级新增）。

**D5 打断与排队**（原 P8 打断部分；**defer 删除面按原则 4 收窄**）
- **打断**：在途窗口结算 `interrupted` → **直接收束流程槽**（复位 + 留痕），**不进 retry/fail 分支、不走 failPolicy**；事件动作经 **followup 新回合**投递。I14 语义不变："可打断立即执行"变为"下一回合立即"，排队语义不变。
- **defer 面只收窄不删除**（**修正早期"defer 面全删"**）：判据 A（通道由"投递瞬间是否有工具在途"决定）**actor 无关**——它同时承载 T1 流程步进、**T2 批次**与规则动作的在途投递（T2 工具在途期间的投递现在随结果进**同一回合**）。全删会把 T2 的投递从"同回合"改成"新回合"= 核心给非核心让路，违反原则 4。故：
  - **保留**：判据 A 全套（defer 槽 / `deferContext`）服务 T2 批次与规则动作。
  - **删除**：T1 流程步进对 defer 的依赖（新模型下 T1 持状态，不需要逐步骤投递）。
  - **删除**：判据 B（`shouldConcludeTurn` 及其投递尺寸记账）—— 它只对 T1 渲染的 call-id 生效（T2 自发 call-id 永不收束），新模型下 T1 无动作即 `finish stop` 自然收束。
  - 打断事件动作改 followup 的代价（+1 回合）必须在 loop-sim 上量（§19.6.1 规矩，见 W10.4）。
- **结算优先级：打断 > 分类/on 命中 > 兜底到期 > 断线**；打断与分类同帧时打断优先，分类命中作废留痕。
- **打断 followup 调用点 = `agent/status` 转 idle 静止点**（2026-09-21 定案，goal-round-driver 先例）：事件动作经 `whenIdle()` 排 followup 新回合；I10 互斥与"流程活跃绑定回合"（D6）在该静止点翻转（届时槽已收束复位）。实现归属 W10.4（回合结束接线）。

**D6 生命周期**（原 P9）
- 状态按 `sessionId` 分槽：定位键取官方 `GenerateOptions.sessionId`（D0）；**该字段可选，缺失时 fail loud**（error + diag 计数），不得静默回落全局槽。
- 复位是**被动**的：`callId` 配对不匹配或**连接代次**不匹配 → 弃用旧状态。不引入"回合取消钩子"（在途工具经 `exec.signal` 立即返回 canceled）。
- **断线口径 = 复位重开**：重连后入口 driver 重新命中 → 入口投递重开流程。
- **"流程活跃"绑定回合**：回合结束 → 活跃自动失效 → 入口 arm 恢复 + `drainFlowQueue` 出队。**接线点已由 D0 确定**：`agent/turn-stopping`（回合边界，可 `steer()` 再开一步）+ `agent/status` 转 idle + `whenIdle()`（静止点，goal-round-driver 先例）。不引入 begin/end 声明。
- **I10 预激活**：入口投递本身即互斥信号；`awaitExternal` / 人工窗口（humanWindow）同样携带 priority 投影。会话释放 = 重新初始化 → 清槽。
- **不引入"流程中途切 T2"**：`turnLane` 按回合锁定（现行 `deliver/lane.ts` 的 per-agent 闭包，取值只有 `t1`/`t2`），同回合工具续步沿用本回合 lane，结构上不可能；唯一逃生口是用户取消回合。

**D7 硬约束**（原 P10）
1. **步的等待只能存在于工具内部**（命令窗口 / 人工等待窗口）——收口恒有界模型下自动满足，不允许"没有在途工具的干等步"。
2. **凭据占位符 `{name}`/`{pass}` 必须原样传参**，由工具在发送瞬间插值；明文不落转录、日志、tool-call 参数。
3. **流程表必须能从头重跑**（复位重开的隐含要求）。
4. **I15 保持不变，新增 I16 承载 T1 私有状态**：I15 是保护 T2 可用性的不变量（"为开发流程管理器而开发"正是本计划的风险），不得改写。T1 的槽状态（`flowId`/`stepId`/`captureSlots`/`attemptCounts`/`stepBudget`）**一律不得进入投递消息、工具参数描述或工具结果文本**；如确需新增规则，另立 **I16**（T1 私有状态不进 T2 可见面）。

**D8 运行时只读投影**（原 P11）
- I10（单流程互斥 / 流程期间不 arm 其它入口，含入口投递预激活）与 I14（`interrupts > priority`）所需信息从 T1 的 tool-call 参数 / 入口投递投影到窗口注册；**运行时不得据此推进流程**（否则双权威复活）。

**D9 T2 能力零回归**（新增；原则 1 的直接落地）
四处 T2 面在本计划中有被改动的风险，以下为**定案**（不是待定项），并转为验收 R1–R4：

| # | T2 面 | 风险 | 定案 | 验收 |
|---|---|---|---|---|
| 1 | `mud_look`/`mud_status`/`mud_move` 的 GA 提前收口；`mud_recall`/`mud_state` 不注册窗口 | T2 失去 GA 缺省 → 查询响应延迟回退 | **T2 命令类工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**（现行 `gaCount:1` 迁移）；全局缺省 stream + fallback 3s 仅兜底（D3） | R1 |
| 2 | `mud_recall`/`mud_state` 的"尚未投递给你"语义 = 交付水位 | 交付水位废除 → 语义变化 | **recall 改历史查询**（3.7）：查 PerceptionBuffer 保留行，覆盖面较交付水位只增不减 | R2（改写） |
| 3 | T2 批次在工具在途时随结果进同一回合（判据 A） | 删 defer → T2 回合边界改变 | **保留判据 A**（D5） | R3 |
| 4 | 流程失败时"交 T2 决策一次" | 被动口径 → 零行时 T2 静默 | **保留 `failPolicy.notify` 能力与字段**（D4） | R4 |

**D10 状态归属与 I8 合规**（新增）
- T1 是**注册进官方 llm 注册表的进程级单例 adapter**（现行 `agent/t1.ts` 除注入的日志钩子外无任何可变状态）。状态化后，槽表**不得**成为 I8 明令禁止的"模块级可变单例状态"。
- 定案：**槽表归会话作用域**（会话运行时 / 每会话服务持有），T1 adapter 只按 `GenerateOptions.sessionId` 查表与写表；会话释放即清槽。T1 adapter 自身保持无状态外壳。
- 释放时机：会话释放 / 断线重连（连接代次不匹配）/ `callId` 配对不匹配。

**D11 推进与结算的原语**（新增；D0 副产品）
- 推进：`agent.followup()`（新回合）/ `agent.steer()`（最近 step 边界）/ `agent.inject()`；拦截：`agent/pre-step`。
- 回合边界：`agent/turn-stopping`（serial，await 后提交边界）；静止点：`agent/status` idle + `whenIdle()`。
- 早停：工具侧 `exec.concludeTurn()`（新模型下仅 T2 路径不接，沿用 §18.17 口径）。
- 排他：`ctx.tools.executionMode()` fail-closed（未声明 `isConcurrencySafe` → exclusive），I11 现行论证不变。

### 3. 机制与契约

#### 3.1 tool-call 参数契约（T1 → 发送工具）

```
mud_send {
  cmd: string                    // 命令行；占位符按三类通道处理（D3）

  // ① 收口：只回答"窗口何时关闭"，不回答"内容算哪一类"
  settle?:                       // 缺省 { mode:'stream' } + fallback 3000
    | { mode: 'inline' }         // 本步工具结果即收口：不开行流窗口（ok→ok / error→fail）
    | { mode: 'stream',
        on?:       { kind:'regex', pattern } | { kind:'ga', count }   // 提前关窗条件
        fallback?: { ms } }      // 兜底时长：缺省 3000（T2 量级短超时），T1 表内按实际步骤耗时填写；到期恒为 timeout 结果

  // ② 分类：只回答"行内容算哪一类"，与关窗解耦
  classify?: {
    ok?      : RegexSpec[]       // 自填正则；命中即关窗（fail-fast，MVP 唯一语义）
    fail?    : RegexSpec[]
    branch?  : { id, pattern }[] // 条件分支 driver
    onSettle?: 'ok' | 'fail'     // on 条件关窗、分类未命中时的裁决，缺省 'ok'
  }

  // ③ 抽取：独立于分类（2026-09-21 定案：JS RegExp 写法；命名捕获组 (?<name>…) 即槽，未匹配不报错、如实缺省）
  captures?: RegexSpec[]         // 逐行扫 span（到达序），每槽先到先得
}
```

- **settle 为判别式联合**：`mode:'inline'` = 不开行流窗口、工具结果即结算（服务"只调工具、不发游戏命令"的步，fullme `prompt`/`answer` 用；裁决固定映射 ok→ok / error→fail；**inline 下声明 `classify`/`captures` 报错**，fail-loud）；`mode:'stream'` = 行流窗口，`on` 承载提前关窗条件（kind 全集 = `regex` / `ga`；**time kind 删除**——纯计时窗 = 无 `on`，时间恒由 `fallback` 管），`fallback` 兜底时长恒在（缺省 3000，dz 等长命令步写大值）。旧 `text` kind 与 `{ref:'settle'}` 引用取消（§19.1 四类 kind 在 W10.1 同步改写）。
- **分类形态只有自填正则**（`RegexSpec`，空类 = 跳过）；GA/tool 不再是分类 kind（**修正元信息表 #1**）；`onSettle` 承载"on 条件关窗、分类未命中"时的裁决（缺省 `'ok'`；fullme `stale` 显式 `'fail'`）。
- **MVP 删除字段**：`onMatch`（'tag' 延后——分类命中即关窗是 MVP 唯一语义）、`priority`（定序固定 fail→分支→ok）、`captureScope`（capture 恒逐行，'window' 随多行分类扩展延后）。
- **窗口恒有界**：`on` 命中提前关窗；**`fallback` 到期恒为 `timeout` 结果，不属于 ok/fail**（"到点即成功"废除——须以 `on:{kind:'regex'}` 证据关窗）；分类正则命中即提前关窗（fail-fast），同帧定序 fail→分支→ok。
- **分类来源解析（工具侧，按序）**：① tool-call 参数（T1 流程步）→ ② 命令的显式声明（规则表 / 活动表条目，规则动作与直发命令）→ ③ 都无：走**收口缺省 stream + fallback 3s**（工具层缺省，两 lane 一致，调用期不报错）。
- **表级显式校验（fail-loud）**：工具层有缺省，但流程表 / 规则表**步级仍须显式声明 settle**，漏写在装配期报错（防笔误静默吃 3 秒）。
- **I15 要求（设计级，不是实现细节）**：参数必须能写进工具描述让模型读懂（T2 拿到同一条 tool-call 也能自行决定）；`settle`/`classify`/`captures` 的模型可见措辞在 W10.1 定稿时一并给出，并做 I15 检验。
- `action.direct: true` 的直发命令**显式 GA 收口**（2026-09-21 定案，MVP 形态）：direct 发送后同样注册收口窗口 `on:{kind:'ga',count:1}`——服务器反馈（GA）到达即结算 `hit: ok`，**不管反馈内容**（无分类匹配需求）；GA 未到仍由 `fallback` 兜底。校验对象 = 所有注册窗口的发送（**direct 不再豁免**，漏写 GA 收口装配期报错）。**direct 结算参与单水位消费**：span = 开窗水位 → GA 行（含），水位随结算推进、span 行记为 direct 的消费；受 **I12 直发延后 gate** 约束，任一窗口（流程 / T2 / direct 自身）开启期间 direct 延后到结算后才发出 ⇒ 窗口互不并存，direct 的 span 不可能覆盖他者未消费的应答行（**halt 豁免除外，T8 口径不变**）。
- T1 / T2 使用相同工具、相同结果形态（既有口径不变）。

#### 3.2 工具返回契约

```
{ settled: 'hit' | 'timeout' | 'interrupted' | 'canceled',
  hit?: { class: 'ok' | 'fail' | 'branch', id? },   // settled='hit' 时必有
  span?: { fromAbs, toAbs },                         // 消费水位 → 触发行 / 提交点（留痕 / 审计 / 自描述）
  captures?: { 槽名: 值 } }
```

- `hit` → T1 查表推进；`timeout`（= `fallback` 到期，恒定结果，不属于 ok/fail）→ 内容已提交并记当前调用者消费，T1 收束流程；`interrupted` → T1 收束流程槽；`canceled` → 回合取消（槽被动复位）。`mode:'inline'` 结算返回 `settled:'hit'` + `hit.class`（工具 ok→ok / error→fail）。
- **判定以 hit 为准**：T1 信任工具判定，不重复匹配；span 供留痕 / 审计 / 自描述。
- I15：结果文本只描述"发生了什么 + 等到了什么"，不携带"下一步该怎么走"的私有指令。

#### 3.3 流程表（口径增补）

Schema 沿 §19.1 骨架，增补（分类/收口口径按 3.1 重写）：
- 分类全显式（`ok` / `fail` / 分支至少其一，形态为自填正则；空类 = 跳过）；GA/tool 不再是分类 kind，`{ref:'settle'}` 引用取消（`onSettle` 取代）。
- `settle` 步级**显式必填**（装配期校验 fail-loud）；`fallback.ms` **按实际步骤耗时填写**（缺省 3000 仅为 T2 量级兜底，dz 类长命令步写大值）。
- 旧"`ok`/`fail` 同写 GA → 告警"作废（分类内无 GA，混杂不可能出现）。
- `on` 条件（ga 的 N / regex 的 pattern）**必须显式**：如 fullme `stale` 写 `settle:{mode:'stream',on:{kind:'ga',count:3}}` + `classify:{onSettle:'fail'}`（**修正元信息表口径**）。
- `mode:'inline'` 服务只调工具不发命令的步（fullme `prompt`/`answer`）；inline 下声明 `classify`/`captures` 报错。
- capture 逐行扫 span（到达序，每槽先到先得）；步数预算为流程级新字段；多行分类 MVP 不支持（`captureScope:'window'` 随多行扩展一并延后）。
- `failPolicy.notify` 保留，缺省 `'t2'`（D4）。
- 新 schema 定稿见第 6 章（实现待定）。

#### 3.4 T1 槽结构（按 sessionId 分槽）

字段：`flowId` / `stepId` / `captureSlots` / `lastFail` / `attemptCounts` / `stepBudget` / `connectionGen` / `lane` / `pendingCallId`（当前在途 tool-call 的 callId，结果配对用，D1）。

- **归属**：槽表由**会话作用域**持有，T1 adapter 只按 `GenerateOptions.sessionId` 查写（D10 / I8）。
- **定位键**：`GenerateOptions.sessionId`（可选字段）；缺失 → fail loud（2026-09-21 作者确认官方 loop 对 T1 请求恒填该字段，fail loud 仅为兜底防线，正常路径不触发）。
- **`connectionGen` 来源**：现行没有显式连接代次，等价物是"`abs` 每连接重置 + `reset()` 全清"（裁决器注释）—— 代次从哪读由 W10.1 定（6.2）。
- 结构定稿见第 6 章。

#### 3.5 裁决器（`SessionAdjudicator` 增量）

- **收口 + 分类 owner 化挂窗口**：confirmSent 时注册（owner = 在途窗口）；confirmSent → 写 socket 零间隙。
- **四路结算**：实时命中（分类正则 / `on` 条件） / 兜底到期 / 打断 / 断线。**无回看结算**——命令发出前已在缓冲的行不参与本步结算，留给后续消费批（D3）。
- **结算产出**：span（水位 → 触发行，含）+ capture 回调回送 + 水位推进到触发行。
- **结算优先级**：打断 > 分类/on 命中 > 兜底到期 > 断线；同帧多类命中按 fail → 分支 → ok 取一，其余留痕。

#### 3.6 状态抓取桶

- 声明载体：state 规则（第 4 章 trigger 面）照旧；命中动作改为"抽取 → **同步 world**"，仅此一个效果。
- **不推进水位、不折叠内容**（2026-09-21 确认）：状态行保留在行流中，作为普通行被后续 span/批次原样包含；行流无隐藏行。状态抓取若推进水位，会把水位推过尚未武装的入口/规则触发行，导致流程或规则永不触发。
- **`direct` 命中行的归属定案**（**修正元信息表 #4**）：`foldedAbs` 原承担两类——state 折叠行与 `action.direct` 命中行。取消折叠后：
  - state 抓取行 → 普通行，被后续 span / T2 批次包含（不消费）；
  - **direct 命中行 → 归消费者 ①（命中行，匹配即消费）**，水位推进到命中行；不再折叠、不再隐藏。
- 与 §5 现行差异：现行折叠消费会隐藏行并前移 `deliveredAbs`（span 空洞、多行分类失真的动因）；新口径下该机制整体删除。

#### 3.7 单一水位线（2026-09-21 修订：三水位归一）

> 早期草案曾有三水位（消费 / 交付 / 发送）与"回看结算"。经复核：**回看结算是概念性错误**——命令发出前已在缓冲的行不是本命令的应答，拿它结算窗口语义不成立（同帧场景已由 `classify.branch` 承接，D3）；交付水位的"尚未投递给你"语义被 **recall 历史查询**取代且覆盖面只增不减。归一为每会话一条水位线。

- **水位线（每会话一条）**：行流消费进度的**唯一**记账。四类消费者，全部推进：① 入口/规则/direct 命中行（→ 命中行）② 流程 span / 兜底到期与打断提交（→ 触发行 / 缓冲头）③ T2 攒批收口（→ 缓冲头）④ 仍带原文的投递（→ 原文行）。
- **状态抓取不推进**（独立桶，3.6）：只同步 world；若推进会把水位推过尚未武装的入口/规则触发行。
- **回看（recall）= T2 查历史**：当当前会话中的行内容不足以做出有效判断时，T2 用 `mud_recall` / `mud_state` 查询**历史**——不依赖水位记账，已投递/已消费行同样可查。历史物理范围 = PerceptionBuffer 保留行（2000 上限）；更久远历史的日志持久化为独立事项，不进本计划。
- **span = 水位 → 触发行（含）**：唯一坐标，`deliveredAbs` 随三水位废除一并删除。

#### 3.8 状态机与时序

T1 槽状态机：

```
idle ──入口投递（复位重开）──> running(step N)
running: 组装 tool-call → await 工具结果
  ├─ hit ok      → next（顺序兜底 / 终态）；终态 = onSuccess → finish stop → idle
  ├─ hit branch  → 进入分支步 → running(step M)
  ├─ hit fail    → retry（次数内，重投本步动作，计时器不重置）？ 流程失败
  ├─ timeout     → 内容已提交消费 → 流程失败
  ├─ interrupted → 收束复位 → idle（事件动作走 followup 新回合）
  └─ canceled    → 槽保留，被动复位（callId / 连接代次不匹配时弃用）
流程失败 → 留痕 → 复位 → （failPolicy.notify='t2' 时投递一条 T2 可见失败消息）→ finish stop → idle
回合结束（agent/turn-stopping / status idle）→ 活跃失效 → idle（入口 arm 恢复 + drainFlowQueue 出队）
```

一步时序：

```
T1 查表进入步骤 N
  → 组装 tool-call（cmd + settle + 分类集 + captures）            [#6 组装阶段写入]
工具：
  校验（分类来源解析三序；表级漏 settle 已在装配期拦截）
  → 凭据插值（{name}/{pass} seam，发送瞬间）
  → confirmSent：注册收口+分类（owner=窗口）                      [#1]
  → 写 socket（与 confirmSent 零间隙）                            [#1]
  → 等待：实时命中 / 兜底到期 / 打断 / canceled
  → 返回 {settled, hit, span, captures}
T1：hit → 查表（fail → 分支 → ok 已由裁决器定序取一）→ 更新槽 → 下一步 / 收束
```

#### 3.9 配置、默认值与校验

- **装配期校验（fail loud）**：流程表——分类全显式（自填正则，空类 = 跳过；`ref` 引用取消）、**settle 步级显式（漏写报错）**、`on` 条件显式（ga 的 N / regex 的 pattern）、inline 步声明 `classify`/`captures` 报错、`next` 引用存在、入口消息 `flow.id` 必须存在于流程表（D1 区分面定案）、占位符三类、capture 命名捕获组名唯一；规则表 / 活动表——**注册窗口的**规则 / 直发命令显式收口声明，未声明报错（**direct 亦须显式 GA 收口**，3.1 定案）。
- **调用期校验**：capture 正则编译失败 → error；`GenerateOptions.sessionId` 缺失 → error。（工具层收口缺省 stream + fallback 3s，调用期不再因缺声明报错。）
- 配置项与默认值（fallback 兜底时长缺省 3000、T2 攒批上限、步数/重试预算）见第 6 章（数值待校准）。

#### 3.10 行流唯一归属与不变量

- **每行恰好被消费一次**（单水位记账，3.7）。消费者枚举：① 规则 / 入口 / 分类 / **direct** 命中行（匹配即消费）② 流程 span（含兜底到期/打断提交区间）③ T2 批次 ④ 仍带原文的投递（原文行未被 ①–③ 覆盖时，如排队出队 pendingEntry）。
- 无折叠：行流无隐藏行；状态抓取不消费行（只观察 + 同步 world）。
- 流程失败未结算行：留在缓冲，作为下一批入口原文或 T2 批次被消费（不丢弃、不移交，#8）。
- **可测不变量**：`① + ② + ③ + ④ == 完整入站行流`（替代 §5 现行"按序拼接投递消息体"口径；折叠类目移除）。pendingEntry 的行流归属沿 §19.7 待定（T5），不在本计划内定。

### 4. 源码变更清单

> 路径按 W8 后目录布局（`deliver/` `agent/` `flow/` `perceive/` `session/` `assemble.ts`），其中 `flow/` 于 **W10.0 整体迁入 `agent/flow/`**（本清单按迁移后路径书写）；精确符号以 W10.1 / W10.2 定稿为准。

**新增**：

| 位置 | 内容 |
|---|---|
| `agent/flow-driver.ts`（暂名） | T1 流程驱动器：按 `sessionId` 查写的槽表（**会话作用域持有**，D10）、查表决策、tool-call 组装、每步留痕（arm 了哪些收口与分类、命中哪个、决定了什么） |
| `agent/flow/flow-types.ts`（增补） | 新契约类型：settle 判别式联合（`inline` / `stream`）/ classify（自填正则 + `onSettle`）/ captures / 步数预算 / tool-call 参数 schema（W10.1 定稿） |

**修改**：

| 位置 | 内容 |
|---|---|
| `agent/tools-schema.ts` / `agent/tools-build.ts` | 发送工具契约：settle / classify / captures 参数；**工具层收口缺省 stream + fallback 3s（两 lane 一致）**；分类来源解析三序；`direct` 显式 GA 收口（不豁免校验）；T2 命令类工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}` |
| `agent/tools-build.ts`（recall 面） | `mud_recall` / `mud_state` 改**历史查询**语义（3.7），工具描述同步改写（I15 面） |
| `deliver/adjudicator.ts` | 收口+分类 owner 化挂窗口、实时匹配 + 兜底到期结算、span 交付、capture 回调、结算优先级与同帧定序；**无回看结算、无发送水位**；`deliveredAbs`/`recall`/`noteDelivered` 交付水位面**整体废除**（单水位，3.7） |
| `agent/inflight.ts` | 窗口绑定收口+分类 owner；删除配对移交面（`windowSpecFor` / `noteToolResult` 的窗口侧）；**隐式缺省废除**——`gaCount ?? cmds.length` 被全局 stream + fallback 3s 缺省取代，`outcome ?? (hasCriteria?'fail':'ok')` 显式化为 `classify.onSettle`（D3） |
| `perceive/engine.ts` / `deliver/state-track.ts` | 状态抓取改独立桶：抽取 → 同步 world；**`direct` 命中行归消费者 ①**；删除折叠消费；`deliveredAbs` 随单水位整体废除 |
| `session/session.ts` / `session/mount.ts` | 入口投递复位重开；入口投递消息新增 `flow:{id}` 字段（D1 区分面定案）；回合结束接线（`agent/turn-stopping` + `agent/status` idle + `whenIdle()`）；装配期校验接线 |
| `session/preset.ts` / `agent/skills.ts` | **T2 可见技能文本与流程所有权保持一致**（**修正元信息表：早期草案漏列**）：断线口径改"复位重开"后，`默认技能` 里"断线或自动登录失效时由你诊断并按步骤重连"、以及"确定性登录流程待重建为触发器 → lite"两处措辞需同步；技能目录经 `systemPrompt.section` 注入的路径不变 |
| `assemble.ts` | 流程表 / 规则表装配期校验：分类全显式、**settle 步级显式（漏写报错）**、`on` 条件显式（ga 的 N / regex 的 pattern）、direct 显式 GA 收口 |
| `agent/flow/engine.ts` | 收缩：判定 / 推进 / 挂起 / 唤醒职责移交 T1 与窗口；保留流程表声明、装配校验、`onSuccess` / 收束副作用、**`failPolicy.notify` 出口** |
| `deliver/delivery-channel.ts` | **收窄而非清空**：删判据 B 面（`shouldConcludeTurn` 及其投递尺寸记账，现行符号为 `size` / `rememberDelivery` / `actionCount`，**非早期草案写的 `deliverySizes`**）；**保留判据 A（defer 槽 / `deferContext`）服务 T2 批次与规则动作** |

**删除**：

| 位置 | 内容（原存在理由） |
|---|---|
| `agent/flow/engine.ts` / `agent/flow/flow-types.ts` | `windowSpecFor` / `noteToolResult` 流程部分——配对移交；收口与分类改随 tool-call 供给 |
| `session/session.ts` / `deliver/adjudicator.ts` | `syncArming()` 的**流程分类重放面**——分类正则由 T1 按步供给（**注**：`syncArming()` 本身是武装标记机制总入口，打断常驻标记 + 直发判据投影共用 `arm()`，总入口与那两面**保留**，不随本计划删除） |
| `deliver/delivery-channel.ts` / `session/*` | **判据 B 全套**（`shouldConcludeTurn` 及其投递尺寸记账）——新模型下 T1 无动作即 `finish stop` 自然收束。**判据 A 不在删除面**（D5） |
| `agent/t1.ts` | 无状态渲染器的流程部分（被 flow-driver 取代；规则动作渲染职责保留） |
| `perceive/*` / `deliver/state-track.ts` | §5 折叠机制（折叠行 / 折叠消费）——状态抓取改独立桶；**`deliveredAbs` 随单水位整体废除**，recall 改历史查询（3.7）。§5 流程步"投递消息携带原文"——原文在 span 里 |
| `deliver/adjudicator.ts` / `agent/inflight.ts` | **N-GA 隐式缺省收口整体废除（含 T2 lane——被全局 stream + fallback 3s 缺省取代，GA 早到不隐式提前关窗）**；静态 `activityTable` 的 N-GA 缺省与分类命中结算职责——重定义为规则 / 直发命令的显式收口声明载体 |

### 5. 实施切片与测试验收

**两轨拆分**（原则 4：核心先运行，非核心让路）。轨 A 只做服务 T2 / 行流的清理，可独立落地；轨 B 才动 T1 状态化，前置是轨 A 完成。

**轨 A —— 行流与声明面（服务 T2，先行）**

| 切片 | 源码范围 | 依赖 | 对应验收 |
|---|---|---|---|
| **W10.0 目录搬迁** | `flow/` 整体迁入 `agent/flow/`（纯路径变更，无语义变更，后续切片 diff 干净） | 无 | tsc 清零 |
| **W10.1 契约与表** | tool-call 参数 schema（settle 判别式联合 / classify+`onSettle` / captures）+ 流程表按新口径重写（login / fullme settle 步级显式、分类自填正则、GA 移入收口 `on`、fullme `prompt`/`answer` 用 `mode:'inline'`、`stale` 显式 `on ga:3` + `onSettle:'fail'`、`fallback.ms` 按实际步骤耗时填写）+ 装配期校验（表级 settle 显式）+ **T2 命令工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**（`tools-schema` / `agent/flow/flows/index.ts` / `assemble.ts`） | W10.0 | A1 / A6 / R1 |
| **W10.2 裁决器与水位** | 收口+分类 owner 化挂窗口 + 实时匹配与兜底到期结算 + span 交付 + capture 回调 + 结算优先级与同帧定序 + **单一水位线（交付水位废除、无回看结算）** + recall 历史查询改写（`deliver/adjudicator.ts` / `agent/inflight.ts` / `tools-build.ts` recall 面） | W10.1 | A2 / A3 / A7 / R2 |
| **W10.3 状态抓取与折叠** | 状态抓取独立桶 + `direct` 命中行归消费者 ① + 取消折叠消费（交付水位废除面归 W10.2）（`perceive/engine.ts` / `deliver/state-track.ts`） | W10.2 | A3 / A9 |

**轨 B —— T1 状态化（后行）**

| 切片 | 源码范围 | 依赖 | 对应验收 |
|---|---|---|---|
| **W10.4 T1 状态机** | **第一步：loop-sim 账目**（回合 / 步骤 / 模型请求，确认不退化为 followup 基线，并量化打断改 followup 的代价）；`flow-driver` 替换渲染器流程部分；槽表（会话作用域，I8）+ 定位键 `sessionId`；工具层收口缺省 stream + fallback 3s（两 lane 一致）；回合结束接线（`agent/t1.ts` / `tools-build.ts` / `session`） | 轨 A 完成 + 账目 | A4 / A5 / A8 |
| **W10.5 删除旧路径** | 第 4 章删除清单（**判据 A 不在内**）+ 回合结束监听接线收尾 | W10.4 | A8 / R3 |
| **W10.6 测试对齐** | `tests/loop-sim.ts`、`t1-adapter.spec.ts`、`flow-*.spec.ts`、`runtime-delivery.spec.ts`、`frame-splitter.spec.ts` + 新增行流守恒用例 | W10.5 | A9 |
| **W10.7 文档同步** | §1（含 I8、新增 I16）/ §5 / §7 / §8 / §9 / §19 改写 + 术语表 + §17 登记 + `doc/CHANGELOG.md` 登记 + **技能文本同步** | W10.6 | A10 / R4 |

> 切片编号统一用 `W10.*`。**早期草案在第 4/6 章与 CHANGELOG v0.10.1 里用了 `S1–S6`，而 `S1–S4` 已被 §8.8 用于 v0.9 W7 切片 —— 同一仓库内 S 编号撞车，本次统一为 W10.\***（**修正元信息表之外的第 7 处，属编号一致性**）。

**验收场景**：

- **A1 收口校验**：流程表 / 规则表步级未声明 settle 在**装配期**报错（fail-loud）；工具层缺省 stream + fallback 3s 生效——未声明 settle 的调用不报错、窗口按 3s 兜底；`direct` 直发必须显式 GA 收口（GA 到达即 `hit: ok`，3.1 定案）。
- **A2 同帧与无回看**：登录 `replace` 分支在"本步结果行 + 后继 driver 同帧"场景判定正确（由 `classify.branch` 承接）；命令发出前已在缓冲的行不参与本步结算（无回看结算）。
- **A3 span 与状态桶**：命中结算 span ≥ 1 行（触发行必在），空值结算被拒；状态抓取结果同步 world、不推进水位、不折叠内容；`direct` 命中行归消费者 ①；行流无隐藏行、span 无空洞。
- **A4 会话形状**：一个流程 = 一个回合、全程 T1；回合内不出现投递消息（除入口）；入口 1 次 + 助手/工具交替（三件套消解）；**loop-sim 账目**与设计一致。
- **A5 打断与失败**：打断 → `interrupted` → 流程槽复位 → finish stop → 事件动作 followup 新回合；流程失败（超时 / fail 无出口 / 预算耗尽）→ `failPolicy.notify='t2'` 时投递一条 T2 可见失败消息 → 回合结束，T2 接手。
- **A6 兜底到期**：到期即 `timeout` 结算（不属于 ok/fail），提交全部窗口内容并记当前调用者消费（水位 → 缓冲头）；随后流程失败收束。
- **A7 优先级**：打断 > 分类/on 命中 > 超时 > 断线；打断与分类同帧时分类作废留痕。
- **A8 删除回归**：第 4 章删除面无残留引用（tsc 清零）；既有用例对齐后全绿。
- **A9 行流守恒**：可测不变量用例（span + T2 批次 + 命中行 + 带原文投递 == 完整入站行流）；流程失败未结算行计入后续消费批。
- **A10 文档一致**：正式章节与实现一致；§17 / CHANGELOG 大版本登记。
- **长命令**：dz / sleep 以结束标记正则（分类 / `on`）收口、`fallback.ms` 表内按实际步骤耗时写大值（GA 仅显式声明收口时使用；哨兵探测步为实验功能，不进验收）。

**T2 回归验收（D9，与轨 A/B 并行跑）**：

- **R1 T2 查询收口**：`mud_look` / `mud_status` / `mud_move` 经工具 schema **显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**，结算行为与量级与改动前一致（对照用例而非目测）；裸 `mud_send` 未声明收口按 stream + fallback 3s 兜底，GA 早到不隐式提前关窗（已定性为接受的行为变化）。
- **R2 T2 读工具语义（改写）**：`mud_recall` / `mud_state` 改**历史查询**后覆盖：batch 裁剪行、帧内工具应答行、限流/人工滞留的 `pending` 行三种场景逐一对照；已投递/已消费行同样可查（较交付水位增量）。
- **R3 T2 回合边界**：T2 工具在途期间到达的批次/规则动作**仍随该工具结果进同一回合**（判据 A 未删）；对照 `runtime-defer.spec.ts`。
- **R4 T2 失败可见性**：流程失败时 T2 能收到失败原因（`notify='t2'` 路径）；`notify='none'` 时行为与现行 login/fullme 一致。

### 6. 未决、待实测与完成定义

#### 6.1 架构未决（起草期需作者定案）

- **MVP 删除字段的延后条件**（新）：`onMatch:'tag'`（分类命中不关窗）、`captureScope:'window'`（跨行抽取）、多行分类——三者随同一扩展一并评估，需先有真实消费场景。

#### 6.2 实现待定（随对应切片定稿）

- 流程表新 schema、tool-call 参数 schema（settle/classify 定稿）、裁决器接口、T1 槽结构（W10.1 / W10.2 定稿）；**其中参数 schema 的模型可见措辞须过 I15 检验**。
- `connectionGen` 从哪读（现行等价物是"`abs` 每连接重置 + `reset()` 全清"）。
- span 审计的时间窗与 `PerceptionBuffer`（2000 行上限）驱逐策略的关系 —— span 只有 `fromAbs/toAbs`，留痕回读受缓冲驱逐约束。
- recall 历史查询的参数形状（模式 / 时间范围 / 条数上限）与驱逐约束（W10.1 定稿）。
- 窗口缓冲上限、每窗口最大分类数（分类正则 + `on` 条件）。
- 打断 / 断线时在途窗口已收内容的消费口径（缺省：留痕消费，水位推进到缓冲头）。

#### 6.3 数值待校准（实测后定）

- 步数 / 时间 / 重试预算的默认值与配置位置。
- fallback 兜底时长缺省 **3000ms**（T2 量级短超时）的实测校准；T1 流程表 `fallback.ms` 按实际步骤耗时填写（各步耗时分布实测见 6.4）。
- T2 攒批上限时长（若保留攒批机制，此处只校准数值）。

#### 6.4 待实测

- N-GA 声明表真机抓包核对（dazuo 等长命令 gaCount 实证，W7.2 遗留）。
- dz / sleep 结束标记正则实测。
- **T1 流程步耗时分布实测**（login / fullme 各步实测耗时，支撑流程表 `fallback.ms` 逐表填写）。
- **loop-sim 新形态账目**（W10.4 第一步）：现行 `defer + concludeTurn` 已实测 1 回合 / 3 步 / 3 请求 / 0 空续步；历史 `followup` 基线为 3 回合 / 6 步 / 6 请求 / 3 空续步。必须证明新形态不退化为后者，并量化打断改 followup 的代价。
- **T2 读工具延迟对照**（R1/R2 的量化基线）。

#### 6.5 评审并入对照（原文件末尾散文评审 9 条 → 本计划落点）

> 原第 315–338 行的散文评审（格式不符本文件约定：非六章结构、使用裸文件名）已按上表归位，散文段删除。

| 原评审 # | 事项 | 本轮落点 | 性质 |
|---|---|---|---|
| 1 | T2 攒批与 GA 的关系 | **D3 / D9 定案（三次修订形态）**：T2 命令工具显式声明 `settle on ga:1`，全局缺省 stream + fallback 3s 兜底 | 语义已定 |
| 2 | `mud_recall` 与交付水位的去向 | **3.7 / D9 / 第 4 章修改清单（二次修订）**：交付水位废除，recall 改历史查询 | 已定案 + 补改清单 |
| 3 | 消费水位的物理载体未指认 | **已消解（二次修订）**：回看结算取消，单水位下无"回看数据源/双消费"问题 | 已消解 |
| 4 | 打断 followup 新回合的触发点未写 | **D5 定案（2026-09-21）**：`agent/status` idle + `whenIdle()` | 已定案 |
| 5 | 流程回合与动作渲染回合的区分面 | **D1 定案（2026-09-21）**：消息 `flow?:{id}` 字段 + 槽 `pendingCallId` 配对，lane 不加值 | 已定案 |
| 6 | 直发命令与纯工具步的收口声明豁免 | **3.1（direct 显式 GA 收口，2026-09-21 定案）/ 3.3 / 3.1（纯工具步 `mode:'inline'` 收口）** | 已定案 |
| 7 | 入口投递"复位重开"与 I10 互斥共存 | **D1 定案（2026-09-21）**：出队 = 入口投递，同样复位重开 | 已定案 |
| 8 | direct-exec 命中行的行流归属 | **3.6 定案**：归消费者 ① | 已定案 |
| 9 | `connectionGen` 来源 + span 可审计时间窗 | **3.4 / 6.2** | 实现待定 |

#### 6.6 文档同步（W10.7）

- §5 / §7 / §8 / §9 / §19 对应改写；§1 不变量按第 2 / 3 章口径落稿。
- **§1 不变量改动范围**：I2 / I4 / I11 / I12 / I13 按新口径改写；**I8 纳入覆盖章节**（D10 的槽表归属）；**I15 原文保持不变**，新增 **I16**（T1 私有状态不进 T2 可见面）。
- 术语表：新增（收口-分类分离 / 单一水位线 / 历史查询 / 状态抓取桶 / 流程驱动器）；删除或改写（判据-only / 配对移交 / arming 集 / 唤醒 / 折叠 / 三水位 / 发送水位 / 交付水位 / 回看结算）；defer 保留。
- §17 新增切片行（W10.0–W10.7）；`doc/CHANGELOG.md` 按版本号规则登记（本计划属核心重构，升大版本 v0.11.0）。
- **D0 结论同步进正式章节**（§19 或 §17），避免"官方有无流程插件"被反复重新提出。

#### 6.7 完成定义（满足后才从本文件删除本计划）

- W10.1–W10.7 全部落地且验收场景 A1–A10 + **R1–R4（T2 零回归）**通过（全包测试绿 + tsc 清零）。
- loop-sim 新形态账目出具且不退化为 followup 基线。
- 正式章节同步完成、术语表与 §17 登记完成、`doc/CHANGELOG.md` 大版本登记完成。
- 此后按文件头约定删除本节，不留档。

> 处置注：原 U1（断线后流程整体挂起续接）已迁 §19.7 待定 #3；原 U2（断线复位重开）定案进 D6；原 U3（折叠口径）**经两轮反复**（v0.10.3"折叠但不推进水位" → v0.10.4"彻底取消折叠"）最终定案进 D3 / 3.6；原 U4（前置噪声容忍）常规化进 D3（判据特异性纪律）；原 U5（按 owner 汇总命中）随判据-only 模型消解。
>
> 2026-09-21 二次修订登记：① 收口/判据结构分离——收口 kind = time/regex/ga/tool、缺省 `{kind:'time', ms:3000}`、判据只支持自填正则 + `ref:'settle'`、取消 text、表级 settle 显式校验保留、T2 命令工具显式 `settle ga:1`、GA 隐式早关废除；② 三水位归一为单一水位线——回看结算取消（概念性错误：命令发出前已在缓冲的行不是本命令的应答）、recall 改历史查询、交付水位废除、状态抓取行确认不推进水位；③ `flow/` 目录整体迁入 `agent/flow/`（W10.0 纯搬迁先行）。
>
> 2026-09-21 三次修订登记：① tool-call 契约形态收敛——settle 改 `mode:'inline'|'stream'` 判别式联合（`tool` 收口 → `mode:'inline'`、GA 移入 `on` 提前关窗条件、time kind 删除——纯计时窗 = stream 无 `on`）、分类只支持自填正则（`classify.onSettle` 取代 `{ref:'settle'}`，fullme `stale` 显式 `on ga:3` + `onSettle:'fail'`）、取消 `onMatch`/`priority`/`captureScope` 三字段、`fallback` 缺省 3000（T2 量级短超时；T1 表内按实际步骤耗时填写）且到期恒 `timeout` 结果、inline 下声明 `classify`/`captures` 报错；② 契约语境术语改名：判据 → 分类（判据 A/B 与直发判据投影不改名）；③ 判定顺序固定 fail → 分支 → ok（`priority` 字段删除，同帧多命中按序取一、其余留痕；装配期不做特异性检查——正则写错属配置问题）。
