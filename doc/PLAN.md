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
| T6 | 并发调度分类器（I11 边界） | `isConcurrencySafe` 是我们在 `defineTool` 里自己可加的字段（非上游依赖）：给 `mud_state`/`mud_help` 这类零发送只读工具声明并发安全时，必须同时重估 I11 |
| T7 | 窗口期分页被延后 | 明确窗口内插话命令的归属判据（§8.3）+ 翻页命令（`pager:continue`）的直发豁免策略（gateRank） |
| T8 | `halt` 无条件豁免直发延后 gate | 豁免收紧为打断路径专用并留痕（§18.8：非打断路径 halt 应答 GA 可能污染在途窗口计数） |
| T9 | 装配层测试基建（§18.9） | vitest 管线加载不了 TC39 装饰器模块 → 是否引入 esbuild/swc 变换链，或继续把可测策略从装配层抽出来（W9 的 `session/credential-source.ts` 即后者） |

---

## 计划：T1 从「无状态渲染器」改为「有状态流程驱动器」

> 状态：**草案（2026-09-21 四次修订；契约未冻结）**。方向已定案（D0 核实：官方无流程管理插件，T1 必须保留流程所有权）；架构决策见第 2 章 D1–D11。**契约（流程表 schema / tool-call 参数 schema / 裁决器接口 / T1 槽结构）仍在第 6 章待定稿** —— 未冻结前不得据其改代码。本轮修订同时：① 把原文件末尾的散文评审 9 条按四分类并入第 6 章（对照表见 6.5）；② 修正 6 处与源码不符的表述（清单见元信息修正表）；③ **收口/分类结构分离**（settle 改 `mode:'inline'|'stream'` 判别式联合、time kind 删除、fallback 缺省 3000 且到期恒 timeout、`onSettle` 取代 `ref:'settle'`、取消 text/onMatch/priority/captureScope，D3/3.1）、**三水位归一为单水位**（回看结算取消、交付水位废除、recall 取消，3.7）、**flow 目录整体迁入 agent**（W10.0）；④ **形态 C**（收口器只管关 / 判据归驱动器复判，tool-call 净删 `classify`/`captures`，§6.1）与 **B3**（终态由驱动器在推进点判定，`concludeTurn` 由包装器转达，账目 3 步 / 3 请求 / 0 空续步）。
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
| 状态 | 草案（2026-09-21 **四次**修订：三次 = 收口/分类分离（mode 判别式联合）+ 单水位 + flow 迁移；**四次 = 形态 C（收口器只管关、判据归驱动器复判）+ B3（终态由驱动器在推进点判定）**；契约未冻结） |
| 覆盖待办池条目 | 不直接消费 T4–T9。与 T6（并发安全重估 I11）/ T7（窗口期分页归属）/ T8（halt 豁免收紧）在裁决器与窗口注册面上有接触，实施时维持 §18 现行口径，不扩大处理 |
| 覆盖正式章节 | §1 不变量（I2 / I4 / I8 / I11 / I12 / I13 / **I15 保持不变**）、§5（行流 / 投递 / 折叠 / 水位）、§7（T1）、§8（裁决器 / 在途窗口）、§9（装配面：技能文本）、§19（流程运行时）、术语表 |
| 实施后去向 | 同步上述章节 + §17 切片登记 + `doc/CHANGELOG.md` 登记（**大版本**：T1 状态化与收口/分类分离属核心重构，v0.11.0 线）→ 按文件头约定删除本节，不留档 |

> **与早期草案的口径推翻**（修正理由见 D3 / D5）：
> - 早期 v0.10.2 登记过「**GA 全域无缺省**」→ 二次修订定为「**收口缺省 time/3s 全局统一**：工具层两 lane 一致缺省兜底；T2 命令类工具显式声明 `settle ga:1`；流程表/规则表步级仍须显式声明（装配期报错）」→ 三次修订形态收敛：**time kind 删除**，缺省 = `{mode:'stream'}` + `fallback:{ms:3000}`，到期恒 timeout（D3）。
> - 早期 v0.10.1/v0.10.4 登记过「**defer 面全删**」→ 本计划收窄为「**只删 T1 流程步进对 defer 的依赖；保留判据 A 服务 T2 批次与规则动作的在途投递**」。
> - 二次修订另废除「**三水位 + 回看结算**」→ 归一为**单一水位线**（回看结算系概念性错误，取消；交付水位废除、recall 取消（T2 上下文 = 会话历史），见 3.7）。

**本轮修正的 6 处与源码不符表述**（实施前必须按此口径，不得照抄早期草案）：

| # | 早期写法 | 源码事实 | 修正 |
|---|---|---|---|
| 1 | criteria schema 只有 `ok/fail/branch/ga` | `FlowMatch` 有四种 kind，`kind:'tool'` 存在且 **fullme 3 处在用**（`ok:[{kind:'tool',outcome:'ok'}]`） | `tool` 收口改 `mode:'inline'`、`ga` 移入收口 `on` 条件、`text` 取消（3.1 收口/分类分离）；W10.1 重写 fullme：`prompt` 用 `settle:{mode:'inline'}`、`answer` 用 `settle:{mode:'stream'}` + ok/fail 分类 + `fallback 180s`（定案见末尾 W10.1 登记条）、`stale` 用 `on ga:3` + `onSettle:'fail'` |
| 2 | 删除清单写 `deliverySizes` | `src` 里**已无此符号**（现为 `delivery-channel.ts` 的 `size` / `rememberDelivery` 与 `actionCount`） | 第 4 章按现行符号改写 |
| 3 | 删除 `syncArming()` 的"流程 arming 重放" | `syncArming()` 是**武装标记机制的总入口**（打断常驻标记 + 流程分类正则 + 直发判据投影共用 `arm()`） | 第 4 章限定删除面为"流程分类重放"，保留总入口 |
| 4 | "取消折叠"只定 state 抓取行 | `foldedAbs` = **state 折叠行 ∪ direct 命中行**两类并集 | 3.6 定 direct 命中行的新归属 |
| 5 | 3.7 "缓冲头"单数 | 行流有**两级缓冲**：`open`（未提交帧，`arm()` 的"arming 即测"只扫它）与 `pending`（已提交待投递，被 T2 限流 / 人工环节压着） | 3.7 单水位消解"回看数据源"问题；两级缓冲仍是提交/投递的物理形态，不再是结算数据源 |
| 6 | 元信息覆盖章节漏 I8 | T1 是**注册进官方 llm 注册表的进程级单例 adapter**，现行完全无状态；状态化后槽表归属决定 I8 合规性 | 覆盖章节行纳入 I8；3.4 / D10 定槽表归属 |

**目标**：
- T1 从无状态动作渲染器改为有状态流程驱动器；流程回合内的"上下文注入 / 助手 / 工具"三件套消解为"入口投递 1 次 + 助手/工具交替"。
- **收口与分类结构分离**：收口为 `mode:'inline'|'stream'` 判别式联合，缺省 stream + `fallback:{ms:3000}`，窗口恒有界（到期恒 timeout）；分类只支持自填正则（`onSettle` 承载收口关窗时的裁决）；流程表 / 规则表步级仍须显式声明收口（装配期报错，工具层不报错）。
- 行流守恒可测：每行恰好被消费一次，无折叠、无移交、无隐藏行。
- **T2 能力零回归**（D9）：`mud_state` / `mud_look` / `mud_status` 的既有语义与量级不退化（`mud_recall` 取消，其职能由会话历史承担）；T2 可见的技能文本与流程所有权保持一致。

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

**D3 收口与分类分离**（原 P4 + P5 + P6 + #1 + #2；2026-09-21 三次修订：mode 判别式联合 / time kind 删除 / onSettle 取代 ref；**同日四次修订：形态 C —— 收口器只管关，判据归驱动器复判**）
- **载体分离（形态 C）**：判据（`classify`：`ok`/`fail`/后继 `driver`）住在**流程表**、由**驱动器**持有；**tool-call 只带收口（关闭触发 + fallback）**。判据**不随 tool-call 供给**（三次修订的写法作废）—— 流程词汇一个都不进模型可见面（§3.1）。空类 = 该类不命中、跳过（不是整体失败）；**不得**流程启动时全表注册（后续步判据会提前命中）。
- 判定顺序：**fail → 分支 → ok**，固定不可配（`priority` 字段 MVP 删除——由驱动器复判的**走序**实现，同帧多命中按此序取一，其余留痕；表编写 bug 由作者自查，不做装配期特异性告警；与 login `replace` 分支同帧实录一致）。
- **收口（settle）与分类（classify）结构分离，不得混杂**：settle 为判别式联合——`{ mode:'inline' }`（本步工具结果即收口，不经行流）或 `{ mode:'stream', on?, fallback? }`（行流窗口）；`on` = **关闭触发**（kind 全集 = `regex` / `ga`；**time kind 删除**——纯计时窗 = stream 无 `on`，时间恒由 fallback 管）；分类只支持**自填正则**（`RegexSpec`）；`text` kind 取消（正则转义覆盖），`{ref:'settle'}` 引用机制取消（由 `onSettle` 取代，见下）。旧"判据数组内混排 regex/ga/tool"形态废除，GA/tool 不再是分类 kind。
- **收口缺省 `{ mode:'stream' }` + `fallback:{ms:3000}`，窗口恒有界**：`on` 触发命中提前关窗；`fallback` 兜底时长恒在。**fallback time 兜底收口即 timeout 行为**：缺省 3000 是 T2 量级的短超时；**T1 流程表步级按实际步骤耗时填写**（dz 等长命令步写大值）。**兜底到期恒为 `timeout` 结果，不属于 ok/fail**（"到点即成功"用法废除——须以 `on:{kind:'regex'}` 证据关窗）。
- **收口关窗时的裁决 = 步级 `onSettle`（缺省 `'ok'`，可 `'fail'`）**：窗口因证据关闭、**驱动器复判未命中任何判据**时的裁决由它承载。**fullme `stale` 三连罚站 = `settle:{mode:'stream',on:{kind:'ga',count:3}}` + 步级 `onSettle:'fail'`，显式写出**（旧口径依赖缺省 `gaCount = cmds.length = 3` 的隐式行为、二次修订的 `fail:{ref:'settle'}` 引用、及"GA 到达 + 判据存在但未命中 → fail"的隐式分类缺省，一并废除——保守判定必须显式写 `onSettle:'fail'`）。
- **`mode:'inline'` 收口**：本步工具结果即收口（不开行流窗口），服务"只调工具、不发游戏命令"的步骤（fullme `prompt` 取图）；裁决固定映射（工具 ok→ok / error→fail）；inline 步**无 content 可复判**，故判据只在 `next` 上体现。
- **两 lane 同型收口（2026-09-21 定案，取代此前"两 lane 缺省统一"的写法）**：
  - **T2：调用时不做任何收口声明** ⇒ 缺省 `{mode:'stream'}` + fallback，**恒等满 fallback 后以 `timeout` 返回**；不计 GA、不做匹配。
  - **T1：组装期校验必须显式声明 settle**，漏写在装配期报错（fail-loud 作者纪律，防笔误静默吃 3 秒）。
  - **声明才计 GA 数、才做匹配**：仅显式声明 `on:{kind:'ga',count:N}` 才进行 GA 计数关窗；**GA 隐式早关废除** —— `inflight.ts` 的 `gaCount ?? cmds.length` 隐式缺省**必须删除**（现行代码与测试仍保留该缺省，见 §6.8 代码增量）。
  - **收口 ≠ 判据（2026-09-21 二次定案；四次修订落为形态 C）**：**收口只回答"窗口何时关闭"**（**不解释内容**）；**判据只回答"内容指向哪个 next"**（由**驱动器**持有）。二者**正交、可共存**，且**分属两个组件**：窗口只有关闭触发，驱动器只有判据。**形态 B（把判据注册进窗口、由窗口给出 `hit.class`）违反本条，已否决** —— 那是让窗口解释内容。
  - **三触发同一路径（单一收口器）**：① **关闭触发命中**（`settle.on` 正则；T1 由判据派生）② **GA 计数**（**仅显式声明时**）③ **`fallback` 到期**（恒在）。三路经同一个 `settle()` 收口 ⇒ 窗口恒有界（I4）。**GA 不声明 ⇒ 不参与收口**。三者的返回信号**同形不同名**（`'evidence'` / `'ga'`），都不携带分类。
  - **判据复判点 = 推进点**：包装器在 `noteToolResult`（工具**在途期间**）把 content 交给驱动器复判 —— 这是 0 空续步的充要条件（B3 定案，§6.1）。
  - **层内唯一类型**（取代同日"跨层互斥"口径）：收口触发层 `settle.on` 只允许单 kind；判据层 `classify` 只收正则。**层间不互斥**。
  - **判据不中** ⇒ 证据关闭按 `onSettle`、到期以 `timeout` 返回，**无隐式 fail 裁决**。
  - T2 三个查询工具（`mud_look`/`mud_status`/`mud_move`）在**工具 schema** 显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`（现行 `gaCount:1` 自然迁移）—— 属工具自带声明，故 T2 侧仍享 GA 早关。
- 规则动作 = 显式声明（载体为规则表 / 活动表条目；活动表从"N-GA 缺省 + 判据命中结算"重定义为"规则 / 直发命令的显式收口声明载体"）。
- **回看结算取消（概念性错误）**：命令发出前已在缓冲里的行不是本命令的应答，不参与本步结算，留给后续消费批；同帧到达的"本步结果行 + 后继 driver"由**驱动器对 span 的复判**承接（该行同时是结果行与后继 driver，一次走序即得 class=branch → 进入该分支）。旧"发送水位 + 回看区间"机制整体删除，6.1 原"回看数据源"未决随之消解。
- **迟到的 driver 行 = 没到（2026-09-21 定案）**：窗口关闭（GA 早关 / 触发命中 / 兜底到期）**之后**才到达的 driver 行，**对流程来说就是没到** —— 流程不回头认领，该行按普通行进入后续消费批（→ T2 批次）。已确认为可接受口径（不再列为风险）。
- span = **水位 → 触发行（含）**（单水位，3.7）；触发行之后的同帧行、GA、迟到行落后续消费区间作前置噪声。**非空结算约束**：命中结算的 span 至少含触发行一行（GA 行计入），禁止空值结算；兜底到期且零行 = 无应答事实，留痕收束，不产出空 span。
- **状态抓取为独立桶**：抓取结果**只同步 world**；**不推进水位、不折叠内容**——状态行作为普通行被后续 span/批次包含，行流无隐藏行（#2 取代原 U3"折叠但不推进水位、不进 span"口径；2026-09-21 确认：状态抓取行不推进水位，否则会把水位推过尚未武装的入口/规则触发行）。
- **capture 抽取归驱动器**（形态 C）：流程表 `captures`（JS RegExp 写法；**槽名 = 命名捕获组** `(?<name>…)`；**未匹配不报错**——该槽如实缺省）由驱动器**在 span 行上逐行抽（到达序），每槽先到先得**，抽取值直接进槽表；`captureScope` 字段 MVP 删除（'window' 跨行抽取随多行分类扩展延后）。占位符三类通道：`{name}`/`{pass}` 原样传参、工具经凭据 seam 发送瞬间插值（明文不落转录/日志/tool-call 参数）；`{captcha}` 工具内部闭环；capture 槽 / `{lastFail}` 由驱动器组装时直写值。
- 复判是结算分类器 ⇒ **误命中 = 误结算**：判据特异性是流程表编写纪律，**装配期不做特异性检查**（2026-09-21 定案：正则写错属配置问题，作者自查）。

**D4 兜底到期与失败**（原 P7 + P8 + #3；**失败出口按原则 1 修正**）
- **兜底到期不做最后判定**：`fallback` time 兜底收口即 `timeout` 行为（无独立"到点成功"结算形态）——到期（`fallback` 耗尽且无分类命中）即**提交全部窗口内容**（水位 → 缓冲头），**记为当前调用者消费**（水位推进到缓冲头）；随后流程失败收束。到期不进 retry（retry 仅由 fail 分类驱动）。
  - **定案 A（2026-09-21 作者裁决）**：`timeout` 结算**带回已累积内容**（span 行进结果的 `lines`/`text`；状态仍是 `timeout`，不属于 ok/fail）。理由：T2 不声明收口 ⇒ 恒等满 `fallback`，若 `timeout` 不带内容，T2 的任意命令就**拿不到回显**，与 §D3「T2 自读批内容决策」冲突。行仍计当前调用者消费（单水位记账，不会重复随批次投递）。旧 `ABANDON_TEXT`（放弃文案、不带内容）已删除。
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
  - **删除**：判据 B（`shouldConcludeTurn` 及其投递尺寸记账）—— 它只对 T1 渲染的 call-id 生效（T2 自发 call-id 永不收束）。**✅ 实测修正 + 定案（2026-09-21，见 §6.1）**：原写的"T1 无动作即 `finish stop` 自然收束"实际是**一个 `claim=0` 的空续步**（工具结果不进 `next-step`）⇒ 单纯删净判据 B 的代价 = 每流程 +1 步/+1 T1 请求/+1 空续步。**定案 B3**：判据 B 的**推断**照删，但终态改由**流程驱动器在推进点（`noteToolResult`，工具在途期间）直接判定**，包装器只转达 `exec.concludeTurn()` ⇒ 账目保持 3 步 / 3 请求 / 0 空续步，且决策者仍只有一个。
  - 打断事件动作改 followup 的代价（+1 回合）必须在 loop-sim 上量（§19.6.1 规矩，见 W10.4；**待回合结束接线落地后实测**）。
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
| 1 | `mud_look`/`mud_status`/`mud_move` 的 GA 提前收口；`mud_state` 不注册窗口 | T2 失去 GA 缺省 → 查询响应延迟回退 | **T2 命令类工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**（现行 `gaCount:1` 迁移）；全局缺省 stream + fallback 3s 仅兜底（D3） | R1 |
| 2 | `mud_recall`/`mud_state` 的"尚未投递给你"语义 = 交付水位 | 取消 recall 会失去"拉取未投递行"的能力 | **recall 取消**（3.7）：T2 的上下文 = 会话历史本身，**不提供 pull 通路**（不查 pending、不查缓存帧）；`mud_state` 去掉 `lines` 参数只留 world 快照 | R2（改写） |
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

  // 收口：只回答"窗口何时关闭"，不回答"内容算哪一类"
  // —— **唯一概念：关闭触发**（形态 C 定案，2026-09-21）
  settle?:                       // 缺省 { mode:'stream' } + fallback 3000
                                 // **不声明 ⇒ 恒等满 fallback**：不计 GA、不做匹配，到期以 timeout 返回
    | { mode: 'inline' }         // 本步工具结果即收口：不开行流窗口（ok→ok / error→fail）
    | { mode: 'stream',
        on?:       { kind:'regex', pattern } | { kind:'ga', count }   // 关闭触发（**层内唯一类型**）
        fallback?: { ms } }      // 兜底时长：缺省 3000（T2 量级短超时），T1 表内按实际步骤耗时填写；到期恒为 timeout 结果
}
```

- **⭐ 形态 C（2026-09-21 定案，取代此前"判据注册进窗口"的形态 B）：收口器只管关，判据归驱动器复判。**
  - **窗口侧不解释内容**：`settle.on` 只是**关闭触发**（"这一行像个应答，别再等了"），触发命中 / N-GA / `fallback` 到期三触发走**同一条收口路径**（§3.5）。三者返回的信号**同形不同名**：GA 关窗是 `settled:'ga'`、触发命中是 `settled:'evidence'`，都只表示"窗口因证据关闭"，**都不携带分类**。
  - **触发从哪来**：**T1 流程步由驱动器从本步判据派生**（`union(step.classify ∪ 直接后继 driver)`，经 `lineCriteriaPattern` 编译）；**T2 自填**（`settle.on`）。派生保证"收口与判据不可能分歧"——同一批正则，一份声明。
  - **内容交回后由驱动器按自己的判据走一遍**（判定序 fail → 分支 → ok）：命中即得 class / branchId / `{lastFail}` 原文，查表推进；未命中 → 证据关闭按 `onSettle`（缺省 `'ok'`）、到期 → 流程失败。
  - **由此 tool-call 参数不再有 `classify` / `captures`**（W10.1 曾落地，形态 C 下**净删**）：分类、抽取、`onSettle` 全是**流程表**的事 —— **一个流程词汇都不进模型可见面**（I15/I16 最干净，T1 与 T2 的 tool-call 完全同形）。
  - **副作用**：形态 A 的脚手架（`onStepJudged` → `closeForFlow()` → `settled='flow'`）随之**退役** —— 它存在的唯一理由是"判据在 flow 手里、窗口只能被外部关"；收口器就在窗口里之后没有存在理由。
- **settle 为判别式联合**：`mode:'inline'` = 不开行流窗口、工具结果即结算（服务"只调工具、不发游戏命令"的步，fullme `prompt` 用；裁决固定映射 ok→ok / error→fail；**inline 步天然无判据可分类**）；`mode:'stream'` = 行流窗口，`on` 承载关闭触发（kind 全集 = `regex` / `ga`；**time kind 删除**——纯计时窗 = 无 `on`，时间恒由 `fallback` 管），`fallback` 兜底时长恒在（缺省 3000，dz 等长命令步写大值）。
- **分类形态只有自填正则**（`RegexSpec`，空类 = 跳过；**载体是流程表 `classify` 字段，不是工具参数**）；GA/tool 不再是分类 kind（**修正元信息表 #1**）；`onSettle` 为**步级字段**。
- **层内唯一类型**（2026-09-21 二次定案；**撤销同日"`settle.on` 与 `classify` 互斥"口径**——那是把两个正交概念当一层）：收口触发层 `settle.on` 单 kind（结构已保证）；判据层 `classify` 只收正则。**层间不互斥**（`settle.on ga:N` + `classify` 可共存：GA 关窗、正则判 next）。
- **`onSettle`** 只在"窗口因证据关闭、而驱动器复判未命中任何判据"时生效，缺省 `'ok'`；fullme `stale` 显式 `'fail'`。
- **MVP 删除字段**：`onMatch`（'tag' 延后——判据命中即关窗是 MVP 唯一语义）、`priority`（定序固定 fail→分支→ok，由驱动器复判的走序实现）、`captureScope`（capture 恒逐行，'window' 随多行分类扩展延后）。
- **窗口恒有界**：`on` 触发命中提前关窗；**`fallback` 到期恒为 `timeout` 结果，不属于 ok/fail**（"到点即成功"废除——须以 `on:{kind:'regex'}` 证据关窗）；驱动器复判的定序 fail→分支→ok 在同一份 content 上一次走完（A2 的自然实现）。
- **收口来源解析（工具侧，按序）**：① tool-call 参数（T1 流程步 / T2 自填）→ ② 命令的显式声明（规则表 / 活动表条目，规则动作）。**都没有 ⇒ 恒等满 fallback**（`{mode:'stream'}` + 3000；不计 GA、不做匹配，到期以 `timeout` 返回）。
  - **T2 收口 = 调用时不声明**（2026-09-21 定案）：一律走缺省、等满 fallback 后返回 `timeout`——**声明才计 GA 数、才做匹配**。三个查询工具（`mud_look`/`mud_status`/`mud_move`）的 `on:{kind:'ga',count:1}` 由**工具 schema 侧自带声明**（不是模型调用参数），故仍享 GA 早关，不受本条影响。
  - **T1 收口 = 必须显式声明**：流程步漏写 settle 在**装配期报错**（见下条）。触发本身由判据派生，**不另写一份**（防止"收口与判据分歧"）。
- **表级显式校验（fail-loud）**：流程表 / 规则表**步级仍须显式声明 settle**，漏写在装配期报错（防笔误静默吃 3 秒）。**T1 是唯一必须显式声明的一侧**；T2 不声明是常态、不是缺陷。
- **I15 要求（设计级，不是实现细节）**：参数必须能写进工具描述让模型读懂（T2 拿到同一条 tool-call 也能自行决定）。形态 C 下模型可见面**只剩 `settle`**，`classify`/`captures`/`onSettle` 一律不出现在工具 schema 与工具结果里。
- **`action.direct: true` = 纯反射，不属于收口/窗口体系**（2026-09-21 定案，**取代同日早先的"显式 GA 收口"口径**）：
  - **豁免收口声明校验**：direct 不参与 §3.9 的收口声明校验（校验对象 = 所有**注册窗口**的发送；direct 不注册窗口）。
  - **不开窗、不消费、不推水位**：发完即走、不等应答、不结算、不产生 span；其应答文本是**无主帧内容**，按普通行进入行流（→ T2 批次 / 后续消费批）。
  - **归属触发器层**：direct 由规则（触发器）声明与执行，从在途窗口 / 单水位 / 分类体系中**剥离**，只保留"命中规则 → 直发命令"这一反射路径；仍受危险命令硬边界（§7 门禁，actor `system`）与 **I12 直发延后 gate** 约束（**halt 豁免除外，T8 口径不变**）。
  - 动机：direct 的"决策"在规则里已写全，把它接进收口体系只会引入第二套结算语义与水位消费面，得不偿失。
- T1 / T2 使用相同工具、相同结果形态（既有口径不变）。

#### 3.2 工具返回契约

```
{ settled: 'ga' | 'eor' | 'evidence' | 'timeout' | 'abort' | 'interrupted' | 'error',
                       // **同形不同名**（形态 C）：ga/eor = N-GA 关窗；evidence = 关闭触发命中
                       // 两者同形（都只表示"窗口因证据关闭"），不携带分类
  text: string,                        // 窗口内容（span 行拼接；timeout 也带回 —— 定案 A）
  lines: MudLine[],                    // span 行（行号/style 保真）—— **驱动器复判判据的唯一输入**
  span?: { fromAbs, toAbs },           // 消费水位 → 触发行 / 提交点（留痕 / 审计 / 自描述）
  captures?: ... }                     // 形态 C 净删：抽取归驱动器在 span 上做
```

- **只带回内容，不携带分类**（形态 C 定案）：`hit` 退场 —— class / branchId / `{lastFail}` 原文由**驱动器按自己的判据走 content 得出**。
- `settled:'ga'|'eor'|'evidence'` → 内容交驱动器复判：命中判据 → 查表推进（`next` / 分支 / retry）；未命中 → `onSettle`（缺省 `'ok'`）。
- `timeout`（= `fallback` 到期，恒定结果，不属于 ok/fail）→ **内容随结果返回**（定案 A：`lines`/`text` = span 行）并记当前调用者消费；驱动器**同样先复判 content**（迟到但已在 span 里的判据行仍算），未命中才收束为流程失败。
- `interrupted` → 收束流程槽；`canceled`（`abort`）→ 回合取消（槽被动复位）。
- `mode:'inline'` 不产生窗口结算，返回 `ok:true|false`（工具结果即判定；去向由步骤 `next` 决定）。
- I15：结果文本只描述"发生了什么 + 等到了什么"，不携带"下一步该怎么走"的私有指令。

#### 3.3 流程表（口径增补）

Schema 沿 §19.1 骨架，增补（分类/收口口径按 3.1 形态 C 重写）：
- **判据（`classify`）归流程表**：`ok` / `fail` / 分支 driver（后继步的 `driver`）全显式，形态为自填正则；空类 = 跳过。GA/tool 不再是分类 kind，`{ref:'settle'}` 引用取消（`onSettle` 取代）。**驱动器在推进点对 span 走一遍这些判据**（定序 fail → 分支 → ok）。
- **`settle` 步级显式必填**（装配期校验 fail-loud）；`on` = **关闭触发**，**由判据派生**（`union(classify ∪ 后继 driver)`）——步表**不另写一份触发正则**（同一事实一个家，从结构上杜绝"收口与判据分歧"）；`on:{kind:'ga',count:N}` 与纯 fallback 窗（`answer` 180s）仍显式写；`fallback.ms` **按实际步骤耗时填写**（缺省 3000 仅为 T2 量级兜底，dz 类长命令步写大值）。
- **`onSettle` 提为步级字段**（原 `classify.onSettle`）：窗口因证据关闭、驱动器复判未命中任何判据时的裁决，缺省 `'ok'`；fullme `stale` 显式 `'fail'`。
- 旧"`ok`/`fail` 同写 GA → 告警"作废（分类内无 GA，混杂不可能出现）。
- `mode:'inline'` 服务只调工具不发命令的步（fullme `prompt`）：无窗口、无判据复判，去向由工具结果与 `next` 决定。
- **禁止无 action 的步**（形态 C 定案，装配期校验 fail-loud）：判据复判的输入只能来自**窗口带回的 content**，没有命令就没有窗口、也就没有收口的载体。现状 login 4 步 / fullme 5 步全部带 action，无回归；`prompt` 属 inline（工具即收口）。
- capture（流程表 `captures`）由**驱动器在 span 行上抽**（到达序，每槽先到先得，命名捕获组即槽名）；步数预算为流程级新字段；多行分类 MVP 不支持（`captureScope:'window'` 随多行扩展一并延后）。
- `failPolicy.notify` 保留，缺省 `'t2'`（D4）。
- 新 schema 定稿见第 6 章（实现待定）。

#### 3.4 T1 槽结构（按 sessionId 分槽）

字段：`flowId` / `stepId` / `captureSlots` / `lastFail` / `attemptCounts` / `stepBudget` / `connectionGen` / `lane` / `pendingCallId`（当前在途 tool-call 的 callId，结果配对用，D1）。

- **归属**：槽表由**会话作用域**持有，T1 adapter 只按 `GenerateOptions.sessionId` 查写（D10 / I8）。
- **定位键**：`GenerateOptions.sessionId`（可选字段）；缺失 → fail loud（2026-09-21 作者确认官方 loop 对 T1 请求恒填该字段，fail loud 仅为兜底防线，正常路径不触发）。
- **`connectionGen` 来源**：现行没有显式连接代次，等价物是"`abs` 每连接重置 + `reset()` 全清"（裁决器注释）—— 代次从哪读由 W10.1 定（6.2）。
- 结构定稿见第 6 章。

#### 3.5 裁决器（`SessionAdjudicator` 增量）

- **单一收口器（形态 C 定案，2026-09-21）**：三触发 —— **关闭触发命中**（`settle.on` 正则）/ **GA 计数**（仅显式声明时） / **`fallback` 到期**（恒在）—— 全部经同一个 `settle()` 收口，窗口恒有界（I4）。**收口器不解释内容**：三触发只决定"窗口何时关闭"，返回信号同形不同名（`'evidence'` / `'ga'`），都**不携带分类**。判据由**驱动器**持有，在推进点（`noteToolResult`，工具在途期间）对窗口带回的 content 走一遍得出 class/next（§3.2）。**形态 A 的 `closeForFlow()` / `settled='flow'` 随之退役**（收口器就在窗口里，不再需要"外部关窗"）。
- **声明才计 GA（落地）**：未显式声明 `on:{kind:'ga',count:N}` ⇒ `gaCount` 未定义 ⇒ `boundary()` 直接返回，**GA/EOR 到达不构成本窗口的边界**。`flow/engine.ts#windowSpecFor` 改为按 §3.3 派生：`gaCount` 只在步表显式声明 `on:{kind:'ga'}`（或 legacy `boundary`）时供给；**关闭触发正则由驱动器从本步判据派生**（同一条派生链，不再有"行判据另行 arm"的分流）。
- **收口器挂窗口**：confirmSent 时注册（owner = 在途窗口）；confirmSent → 写 socket 零间隙。
- **四路结算**：关闭触发命中 / GA 关窗 / 兜底到期 / 打断 / 断线（打断与断线为终止类）。**无回看结算**——命令发出前已在缓冲的行不参与本步结算，留给后续消费批（D3）。
- **结算产出**：`{settled, text, lines, span}` —— 内容随结果交回驱动器；水位推进到触发行。
- **结算优先级**：打断 > 关闭触发/GA > 兜底到期 > 断线；**同帧多类命中的 fail → 分支 → ok 定序由驱动器复判的走序实现**（形态 C 下不再是标记注册序的产物）。

#### 3.6 状态抓取桶

- 声明载体：state 规则（第 4 章 trigger 面）照旧；命中动作改为"抽取 → **同步 world**"，仅此一个效果。
- **不推进水位、不折叠内容**（2026-09-21 确认）：状态行保留在行流中，作为普通行被后续 span/批次原样包含；行流无隐藏行。状态抓取若推进水位，会把水位推过尚未武装的入口/规则触发行，导致流程或规则永不触发。
- **`direct` 命中行的归属定案**（**修正元信息表 #4**）：`foldedAbs` 原承担两类——state 折叠行与 `action.direct` 命中行。取消折叠后：
  - state 抓取行 → 普通行，被后续 span / T2 批次包含（不消费）；
  - **direct 命中行 → 同样不消费、不推水位**（2026-09-21 修正，**取代同日"归消费者 ①"口径**）：direct 属触发器层的纯反射，其命中行与应答行按普通行进入行流（→ T2 批次），不再折叠、不再隐藏，也不计入消费记账。
- 与 §5 现行差异：现行折叠消费会隐藏行并前移 `deliveredAbs`（span 空洞、多行分类失真的动因）；新口径下该机制整体删除。
- **落地状态（2026-09-21，W10.3）**：✅ 已落地。折叠集 `FeedResult.foldedAbs` 与 `MatchHit.foldLines` 一并删除（生产面 + 消费面），裁决器站① 只 `patch` 不再隐藏行、站⑤ 的 `pending`/`recallLines` 收全行；`direct` 命中行随之照常进行流。可测不变量新增一例（`tests/runtime-delivery.spec.ts` 末节：投递拼接 == 完整入站行流，含被抓取行与被反射行），完整不变量套件（含 span 记账）归 W10.6。

#### 3.7 单一水位线（2026-09-21 修订：三水位归一）

> 早期草案曾有三水位（消费 / 交付 / 发送）与"回看结算"。经复核：**回看结算是概念性错误**——命令发出前已在缓冲的行不是本命令的应答，拿它结算窗口语义不成立（同帧场景已由**驱动器对 span 的复判**承接，形态 C / D3）；交付水位的"尚未投递给你"语义不再需要替代品——**T2 的上下文就是会话历史本身**（2026-09-21 定案，`mud_recall` 取消）。归一为每会话一条水位线。

- **水位线（每会话一条）**：行流消费进度的**唯一**记账。四类消费者，全部推进：① 入口 / 规则 / 分类命中行（→ 命中行）② 流程 span / 兜底到期与打断提交（→ 触发行 / 缓冲头）③ T2 批次（→ 缓冲头）④ 仍带原文的投递（→ 原文行）。**`direct` 不推水位**（3.6 定案）。
- **状态抓取不推进**（独立桶，3.6）：只同步 world；若推进会把水位推过尚未武装的入口/规则触发行。
- **T2 的上下文 = 会话历史本身（2026-09-21 定案）**：T2 需要的游戏输出就是它自己会话里已投递的内容。**本计划不提供任何"拉取"通路** —— 不查 `pending`（尚未投递的行）、不查缓存帧、不做历史缓冲查询。
  - `mud_recall` 工具**取消**。理由：其旧语义"尚未投递给你"本质是让 T2 越过 `t2DeliverIntervalMs` 的推送节奏去拉 `pending`，与"推送节奏是唯一节拍"冲突；且实测出现过 `mud_state(lines:60)` 把连接至今全部输出重复塞进 session 的退化（§5）。
  - `mud_state` **保留**（只读档的信息源，§10），但**去掉 `lines` 参数**，只返回 world 快照。
  - 残留边界（不构成 pull 通路）：批次裁剪（`MAX_INJECT_TAIL_LINES`/`MAX_INJECT_TAIL_CHARS`）会在 session 里留下 `[观察窗截断]` 标记；`pending` 超 `MAX_PARKED_LINES` 丢最旧行并记日志 —— 两者都是**有痕迹的降级**，不额外给 T2 恢复通路。
- **span = 水位 → 触发行（含）**：唯一坐标，`deliveredAbs` 随三水位废除一并删除。

#### 3.8 状态机与时序

T1 槽状态机：

```
idle ──入口投递（复位重开）──> running(step N)
running: 组装 tool-call → await 工具结果
  ├─ hit ok      → next（顺序兜底 / 终态）；**终态（next 空）** = onSuccess → **驱动器判终态 ⇒ 包装器 `concludeTurn`** → 回合收束 → idle
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
驱动器按槽进入步骤 N
  → 组装 tool-call（cmd + settle；**关闭触发 = 从本步判据派生**，不另写一份）
工具：
  校验（收口来源解析三序；表级漏 settle 已在装配期拦截）
  → 凭据插值（{name}/{pass} seam，发送瞬间）
  → confirmSent：注册收口（关闭触发 / GA 计数 ✓ owner=窗口）        [#1]
  → 写 socket（与 confirmSent 零间隙）                            [#1]
  → 等待：关闭触发命中 / GA 计数到 / 兜底到期 / 打断 / canceled
  → 返回 {settled, text, lines, span}（**不携带分类**）
包装器（工具在途时）：把结果（含 content）喂回驱动器 = **推进点**（noteToolResult 单点）
  → 驱动器对 content **按自己的判据走一遍**（定序 fail → 分支 → ok）
     命中 → class / branchId / {lastFail} 原文 → 查表 → 更新槽 → 下一步
     未命中 → 证据关闭：onSettle（缺省 ok）｜到期：流程失败
  → 驱动器判定**终态**时，包装器转达 exec.concludeTurn()（B3 定案：收束回合）
T1 的下一次请求：**只按槽渲染下一步**（不在此处查表/推进）
```

> **时点口径（2026-09-21 B3 定案）**：推进点 = `noteToolResult`（工具**在途期间**），不是"T1 的下一次请求"。
> 这是 0 空续步（§6.1 账目）的充要条件：T1 请求里发 `stop` 只能落在下一次请求上，必然多一个 `claim=0` 步。

#### 3.9 配置、默认值与校验

- **装配期校验（fail loud）**：流程表——判据全显式（`classify.ok`/`fail` + 后继 `driver`，自填正则，空类 = 跳过；`ref` 引用取消）、**settle 步级显式（漏写报错）**、`on` 的 `ga` N 显式、**禁止无 action 的步**（形态 C：没有窗口就没有收口载体）、`next` 引用存在、入口消息 `flow.id` 必须存在于流程表（D1 区分面定案）、占位符三类、capture 命名捕获组名唯一；规则表 / 活动表——**注册窗口的**规则动作显式收口声明，未声明报错。**`action.direct` 豁免本校验**（不开窗、不消费，纯反射，3.1 定案；2026-09-21 修正，取代"direct 亦须显式 GA 收口"）。**层内唯一类型**：`settle.on` 单 kind、`classify` 只收正则（**层间不互斥**，2026-09-21 二次定案）。**关闭触发不单独校验**（由判据派生，无可漏写）。
- **调用期校验**：capture 正则编译失败 → error；`GenerateOptions.sessionId` 缺失 → error。（工具层收口缺省 stream + fallback 3s，调用期不再因缺声明报错。）
- 配置项与默认值（fallback 兜底时长缺省 3000、T2 攒批上限、步数/重试预算）见第 6 章（数值待校准）。

#### 3.10 行流唯一归属与不变量

- **每行恰好被消费一次**（单水位记账，3.7）。消费者枚举：① 规则 / 入口 / 分类命中行（匹配即消费）② 流程 span（含兜底到期 / 打断提交区间）③ T2 批次 ④ 仍带原文的投递（原文行未被 ①–③ 覆盖时，如排队出队 pendingEntry）。**`direct` 不在消费者枚举内**（不开窗、不消费、不推水位；其命中行与应答行按普通行落入 ③/④）—— 2026-09-21 修正。
- 无折叠：行流无隐藏行；状态抓取不消费行（只观察 + 同步 world）。
- 流程失败未结算行：留在缓冲，作为下一批入口原文或 T2 批次被消费（不丢弃、不移交，#8）。
- **可测不变量**：`① + ② + ③ + ④ == 完整入站行流`（替代 §5 现行"按序拼接投递消息体"口径；折叠类目移除）。pendingEntry 的行流归属沿 §19.7 待定（T5），不在本计划内定。

### 4. 源码变更清单

> 路径按 W8 后目录布局（`deliver/` `agent/` `flow/` `perceive/` `session/` `assemble.ts`），其中 `flow/` 于 **W10.0 整体迁入 `agent/flow/`**（本清单按迁移后路径书写）；精确符号以 W10.1 / W10.2 定稿为准。

**新增**：

| 位置 | 内容 |
|---|---|
| `agent/flow-driver.ts`（暂名） | T1 流程驱动器：按 `sessionId` 查写的槽表（**会话作用域持有**，D10）、查表决策、tool-call 组装、每步留痕（arm 了哪些收口与分类、命中哪个、决定了什么） |
| `agent/flow/flow-spec.ts`（增补） | 新契约类型：settle 判别式联合（`inline` / `stream`）/ classify（自填正则 + `onSettle`）/ captures / 步数预算 / tool-call 参数 schema（W10.1 定稿）。**类型归属定稿在 flow-spec.ts**（原清单写 flow-types.ts——flow-types.ts 引用 flow-spec.ts 的 FlowMatch，反向放类型会成循环 import） |

**修改**：

| 位置 | 内容 |
|---|---|
| `agent/tools-schema.ts` / `agent/tools-build.ts` | 发送工具契约（**形态 C**）：**只剩 `settle`**（`settle.on` = 关闭触发，kind 全集 regex/ga）；**删 `classify`/`captures` 参数**；**收口缺省 stream + fallback 3s（T1/T2 同型）**；收口来源解析；**层内唯一类型（层间不互斥）**；**`direct` 豁免校验**；T2 命令类工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`；工具结果**带回 `lines`**（驱动器复判的输入） |
| `agent/tools-build.ts`（读工具面） | **删除 `mud_recall` 工具**；`mud_state` **去掉 `lines` 参数**（只返回 world 快照）；工具描述与 diag 同步（I15 面）（3.7） |
| `deliver/adjudicator.ts` | 单一收口器挂窗口（三触发同一 `settle()`）、span 交付、结算优先级；**无回看结算、无发送水位**；`deliveredAbs`/`noteDelivered` 交付水位面**整体废除**（单水位，3.7）；`recall()` 与 `recallLines` 缓冲**降级为诊断通路**（`/mud/diag` + log-service，不进模型工具面）；**win- 标记从"每类一个"收缩为"一个关闭触发"**（形态 C）；`noteToolResult` 改为**把 content 转交驱动器复判**并取回终态判定（B3） |
| `agent/inflight.ts` | 窗口收窄为**纯收口器**：`WindowSpec` 只剩 `{closeOn?, gaCount?, timeoutMs?}`；删 `criteria`/`branch`/`gaOutcome`/`onSettle`/`WindowResult.hit`/`hitText`；新增 `settled:'evidence'`（与 GA **同形不同名**）；`ReplySettle` 去 `'flow'`；**隐式缺省废除**——删除 `gaCount ?? cmds.length`（未声明即不关窗） |
| `perceive/engine.ts` / `deliver/state-track.ts` | 状态抓取改独立桶：抽取 → 同步 world；**`direct` 命中行不消费、不推水位**（direct 面从窗口 / 水位体系剥离）；删除折叠消费；`deliveredAbs` 随单水位整体废除 |
| `session/session.ts` / `session/mount.ts` | 入口投递复位重开；入口投递消息新增 `flow:{id}` 字段（D1 区分面定案）；**包装器 `noteToolResult` 传 content、`shouldConcludeTurn` 换成驱动器终态判定**（B3）；回合结束接线（`agent/turn-stopping` + `agent/status` idle + `whenIdle()`）；装配期校验接线 |
| `session/preset.ts` / `agent/skills.ts` | **T2 可见技能文本与流程所有权保持一致**（**修正元信息表：早期草案漏列**）：断线口径改"复位重开"后，`默认技能` 里"断线或自动登录失效时由你诊断并按步骤重连"、以及"确定性登录流程待重建为触发器 → lite"两处措辞需同步；技能目录经 `systemPrompt.section` 注入的路径不变 |
| `assemble.ts` | 流程表 / 规则表装配期校验：判据全显式、**settle 步级显式（漏写报错）**、`on` 的 ga N 显式、**禁止无 action 的步**、**层内唯一类型**、**`direct` 豁免校验** |
| `agent/flow/engine.ts` | 收缩：**判据复判 / 推进 / 终态判定职责移交 T1 驱动器**；**arming 面退役**（`armOwnJudgements` / `setArmed` / `matchFrom` / `processBatch` / `applyMatch` / `syncArmingToHost` 的**步骤判据面**；`flow-arm:*` 步骤判据标记）；**入口 arm 保留**（D1：无回合时也得盯行流）；保留流程表声明、装配校验、`onSuccess` / 收束副作用、**`failPolicy.notify` 出口** |
| `deliver/delivery-channel.ts` | **收窄而非清空**：删判据 B 面（`shouldConcludeTurn` 及其投递尺寸记账，现行符号为 `size` / `rememberDelivery` / `actionCount`，**非早期草案写的 `deliverySizes`**）；**保留判据 A（defer 槽 / `deferContext`）服务 T2 批次与规则动作** |

**删除**：

| 位置 | 内容（原存在理由） |
|---|---|
| `agent/flow/engine.ts` / `agent/flow/flow-types.ts` | `windowSpecFor` / `noteToolResult` 流程部分——配对移交；**形态 C 下再删 arming 面**：`armOwnJudgements` / `setArmed` / `matchFrom` / `processBatch` / `applyMatch` / `syncArmingToHost` 的步骤判据面 + `FlowRuntimeOptions.onStepJudged`（判据改由驱动器在推进点复判） |
| `session/session.ts` / `deliver/adjudicator.ts` | `syncArming()` 的**流程分类重放面**——形态 C 下步骤判据不再经标记（**注**：`syncArming()` 本身是武装标记机制总入口，**入口 arm**、打断常驻标记 + 直发判据投影共用 `arm()`，总入口与那两面**保留**，不随本计划删除） |
| `deliver/delivery-channel.ts` / `session/*` | **判据 B 全套**（`shouldConcludeTurn` 及其投递尺寸记账）——**B3 定案（§6.1）**：推断删除，改由**流程驱动器在推进点判定终态**、包装器转达 `exec.concludeTurn()`（账目保持 3 步 / 3 请求 / 0 空续步）。**判据 A 不在删除面**（D5） |
| `agent/t1.ts` | 无状态渲染器的流程部分（被 flow-driver 取代；规则动作渲染职责保留） |
| `agent/inflight.ts` / `deliver/adjudicator.ts` | **形态 C 收窄面**：`WindowCriteria`（`ok`/`fail`）、`branch`、`gaOutcome`、`onSettle`、`WindowResult.hit`/`hitText`、`settleCriteria` 的按类结算、`armWindowMarker` 的多样标记；**形态 A 脚手架**：`closeForFlow()` / `ReplySettle='flow'` / `noteToolResult` 的 `'flow'` 早返回 |
| `agent/tools-build.ts` / `agent/tools-schema.ts` / `agent/flow/flow-spec.ts` | **tool-call 参数净删**（W10.1 落地物）：`classify` / `captures` 参数与 `resolveSettleWindow` 的 classify→criteria 映射；`classify`/`onSettle`/`captures` 转为**流程表字段**（不是工具面） |
| `perceive/*` / `deliver/state-track.ts` | §5 折叠机制（折叠行 / 折叠消费）——状态抓取改独立桶；**`deliveredAbs` 随单水位整体废除**（3.7）；**`mud_recall` 取消、`mud_state` 去 `lines`**。§5 流程步"投递消息携带原文"——原文在 span 里。**（2026-09-21：折叠行与折叠消费 ✅ 均已随 W10.3 删除——W10.5 只需核查零残留；`deliveredAbs` 已在 W10.2 删除；post-recall 三项亦已落地）** |
| `deliver/adjudicator.ts` / `agent/inflight.ts` | **N-GA 隐式缺省收口整体废除（T1/T2 同型——被 stream + fallback 3s 缺省取代，GA 早到不隐式提前关窗；`gaCount ?? cmds.length` 删除）**；静态 `activityTable` 的 N-GA 缺省与分类命中结算职责——重定义为规则动作的显式收口声明载体 |
| `deliver/adjudicator.ts`（direct 面）/ `agent/flow/flow-spec.ts` | **`action.direct` 从收口 / 在途窗口 / 单水位体系中剥离**（3.1 定案）：不注册窗口、不结算、不产生 span、不推水位、豁免收口声明校验；`runDirectHits` 只保留"命中规则 → 直发命令"反射路径（危险命令硬边界与 I12 直发延后 gate 不变） |

### 5. 实施切片与测试验收

**两轨拆分**（原则 4：核心先运行，非核心让路）。轨 A 只做服务 T2 / 行流的清理，可独立落地；轨 B 才动 T1 状态化，前置是轨 A 完成。

**轨 A —— 行流与声明面（服务 T2，先行）**

| 切片 | 源码范围 | 依赖 | 对应验收 |
|---|---|---|---|
| **W10.0 目录搬迁** | `flow/` 整体迁入 `agent/flow/`（纯路径变更，无语义变更，后续切片 diff 干净） | 无 | tsc 清零 |
| **W10.1 契约与表** | tool-call 参数 schema（settle 判别式联合 / classify+`onSettle` / captures）+ 流程表按新口径重写（login / fullme settle 步级显式、分类自填正则、GA 移入收口 `on`、fullme `prompt` 用 `mode:'inline'`、`answer` 用 stream + ok/fail 分类 + `fallback 180s`、`stale` 显式 `on ga:3` + `onSettle:'fail'`、`fallback.ms` 按实际步骤耗时填写）+ 装配期校验（双形：新形步骤表级 settle 显式，旧形步骤 legacy 校验兼容，W10.5 收紧）+ **工具层收口缺省 stream + fallback 3000（两 lane 一致，提前自 W10.4 落地）** + **T2 命令工具显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**。落地文件（W10.1 定稿修订）：`agent/flow/flow-spec.ts`（类型 + 双形校验 + `normalizeFlowSpecs` 过渡桥）/ `agent/flow/engine.ts`（构造器接线）/ `agent/flow/flows/{login,fullme}.ts`（表重写）/ `agent/tools-build.ts`（参数 + 缺省 + T2 显式 settle） | W10.0 | A1 / A6 / R1 |
| **W10.2 裁决器与水位** | 收口+分类 owner 化挂窗口 + 实时匹配与兜底到期结算 + span 交付 + capture 回调 + 结算优先级 + **单一水位线（交付水位废除、无回看结算）** + **取消 `mud_recall`、`mud_state` 去 `lines` 参数（T2 上下文 = 会话历史，不提供 pull 通路）** + **收口口径落地四项**：① 删除 `gaCount ?? cmds.length` 隐式缺省（**声明才计 GA**）② `onSettle` 缺省 `'ok'` 生效（废除 `hasCriteria ? 'fail' : 'ok'` 隐式裁决）③ **层内唯一类型**（原"`settle.on` 与 `classify` 互斥"已于同日二次定案撤销） ④ `direct` 从收口/水位体系**剥离**（豁免校验、不开窗、不消费）（`deliver/adjudicator.ts` / `agent/inflight.ts` / `tools-build.ts`）。**状态（2026-09-21 实施回填，全部落地）**：①②③④ 与 recall 取消**均已落地**（32 文件 / 361 例绿 + tsc 清零 + vitest exit 0）。① 的解封方式是**单一收口路径**（判据命中 / GA / fallback 三触发同一 `settle()`，见 §D3 与 §3.5），不是「分类 owner 化」（该形态留给 W10.4） | W10.1 | A3 / A7 / R2 |
| **W10.3 状态抓取与折叠** | 状态抓取独立桶 + **`direct` 面折叠删除（不消费、不推水位）** + 取消折叠消费（交付水位废除面归 W10.2）。**状态（2026-09-21 实施回填，全部落地）**：折叠机制**整体删除**（消费面 + 生产面，第 4 章删除清单的"折叠"项就此闭项，W10.5 只做零残留核查）—— `perceive/types.ts` 删 `MatchHit.foldLines`、`perceive/matcher.ts` 删两处构造、`perceive/engine.ts` 删 `FeedResult.foldedAbs`（`state.flatMap(foldLines)` 与 direct 锚点两处写法）、`deliver/adjudicator.ts` 站①注释 / 站⑤ recall 与 `pending` 过滤 / diag 折叠计数全删；`deliver/state-track.ts` 与 `perceive/rules.ts` 文档改"状态抓取桶"（**行为零变更**——state 抓取本来就只 `patch(...,'percept')`，本次落地的是"它不再折叠"）。**实际动到的文件比本行原列的多**（原列漏 `deliver/adjudicator.ts`；`deliver/state-track.ts` 仅文档）：`perceive/{types,matcher,engine,rules}.ts` / `deliver/{adjudicator,state-track}.ts` + 4 个测试文件；32 文件 / 360 例绿 + `tsc` 清零 + vitest exit 0 | W10.2 | A3 / A9 |

**轨 B —— T1 状态化（后行）**

| 切片 | 源码范围 | 依赖 | 对应验收 |
|---|---|---|---|
| **W10.4 T1 状态机** | **第一步：loop-sim 账目（✅ 已出，见 §6.4；带出 B3 定案）**；**第二步：形态 C 落地（收口器 + 驱动器复判，见下方实施顺序）**；`flow-driver` 替换渲染器流程部分；槽表（会话作用域，I8）+ 定位键 `sessionId`；工具层收口缺省 stream + fallback 3s；**跨行同帧定序 fail → 分支 → ok（形态 C 下由驱动器复判走序实现，A2 归属本切片）**；**终态判定（B3）**；回合结束接线（`agent/t1.ts` / `tools-build.ts` / `session`） | **轨 A 已完成**（W10.0–W10.3 全绿）+ 账目 | **A2** / A4 / A5 / A8 |
| **W10.5 删除旧路径** | 第 4 章删除清单（**判据 A 不在内**；**折叠项已随 W10.3 提前闭项**，此处只核查零残留）+ 回合结束监听接线收尾 | W10.4 | A8 / R3 |
| **W10.6 测试对齐** | `tests/loop-sim.ts`、`t1-adapter.spec.ts`、`flow-*.spec.ts`、`runtime-delivery.spec.ts`、`frame-splitter.spec.ts` + 新增行流守恒用例（**已随 W10.3 起步**：`runtime-delivery.spec.ts` 末节固定"抓取行 + 反射行都照常进行流"；本切片补 span 记账面） | W10.5 | A9 |
| **W10.7 文档同步** | §1（含 I8、新增 I16）/ §5 / §7 / §8 / §9 / §19 改写 + 术语表 + §17 登记 + `doc/CHANGELOG.md` 登记 + **技能文本同步** | W10.6 | A10 / R4 |

**W10.4 实施顺序**（2026-09-21 定；依赖链，前一步不做完不做下一步）：

1. **账目（✅ 已出，带出 B3 定案）**：见 §6.1 / §6.4。
2. **形态 C 落地（收口器 + 驱动器复判）** —— 取代此前"判据注册进窗口"的形态 B（已否决：那让窗口解释内容）。内部 6 小步，**分两批实施**（2026-09-21 实施中定）：
   - **批次一（✅ 已落地：① + ②）**：
     - ① **关闭触发派生**：`FlowRuntime#closeTrigger(step)` 按本步判据生成 union 正则（retry driver + fail + ok + **直接后继 driver**，经 `lineCriteriaPattern`），随 `windowSpecFor` 的 `closeOn` 下发；步表不另写触发正则。
     - ② **窗口收窄（本批次只加通道）**：`WindowSpec.closeOn` + `win-<n>:close` 标记（**最后武装 = 最低优先级**，让类标记先赢）；`parseWindowMarkerId` 认 `close`；`settleCriteria` 对 `close` 走 `settle(w,'evidence')`；`ReplySettle` 增 `'evidence'`；`settle()` 的 `'evidence'` 分支只带回 `{text, lines, span}`（**无 `hit`/`outcome`/`hitText`**）；`FlowRuntime#noteToolResult` 对 `'evidence'` 与 `'flow'` 同款早返回（防双推进）。
     - **⚠️ 实测事实（必须记账）：本批次后 `closeOn` 在流程路径上仍是"装好但未承重"** —— `flow-arm:*` 步骤判据标记在**步骤进入时**就武装（早于 `confirmSent` 的 `win-*`），分帧器 `testLine` **取最先武装的命中标记**（`FrameSplitter.armed` 顺序），故真实流程里判据行仍由 `flow-arm` 切帧、由 `closeForFlow()`（`'flow'`）收口；`win-close` 要等 ⑤ 退役 arming 面之后才承重。窗口侧行为已由 `response.spec` 两例直接钉住（`evidence` 不携带分类 / 类标记优先）。
   - **批次二（③④⑤，✅ 已落地）**：
     - ③ **内容通道**：窗口带回的 span 行经**在途窗口表单槽**（`InflightWindowTable#takeSettledLines`，工具返回后立即被取走）交给 `Adjudicator#noteToolResult` → `FlowRuntime#noteToolResult(…, contentLines)`。**偏离计划字面**（原写"经工具结果透传"）：工具结果有 `additionalProperties:false` 的模型可见 schema，塞 `MudLine[]` 会把内部行号/style 暴露给 T2 并撑爆上下文 —— 内容的家在窗口，单槽直送驱动器（也保证"取一次即清"，不构成任何回看通路）。
     - ④ **驱动器复判**（`FlowRuntime#judgeStep` / `judgementUnits` / `judgeFrom` / `applyJudgement` / `settleFallback`）：窗口结算种类 `evidence`/`ga`/`eor`/`timeout` 一律**只带内容**，驱动器对 span 按**固定类序 retry driver → fail → 分支（后继 driver）→ ok**、类内行序取首个走一遍（A2 同帧定序由此天然正确）；未命中 → `timeout` 即失败、证据关闭按步表 GA 判据（`onSettle` 归一）或"证据关闭即成功"。判定在**推进点**（`noteToolResult`，工具在途）完成。
     - ⑤ **arming 面退场**：`armOwnJudgements` / `applyMatch` / `onStepJudged` / `closeForFlow()` / `ReplySettle='flow'` 全部删除；`armConditional` 改为**只在 `succeedStep` 布防**（唯一会话侧判据面 = 分支等待期；进入步骤时不 arm，免得 `flow-arm:*` 抢走帧切分）；重试也 `setArmed([])`。**入口 arm 保留**（D1）。
     - **⚠️ 由此确立并已记账的两条语义（本批次带出）**：
       1. **判据只经窗口**：本步动作未执行（无在途窗口）时，判据行**不推进**流程 —— 与 D3/A2"命令发出前已在缓冲的行不参与本步结算""窗口关闭后到达的 driver 行 = 没到"一致；该步最终由自己的 fallback 预算收束。新增用例 `flow-login`「判据行只在窗口内被判」钉住。
       2. **归属不再靠事后比对**：GA 只数 `confirmSent` 武装过的窗口、窗口由本步自己的命令注册 ⇒ "上一条命令的 GA 结算下一步"结构上不可能（原用例改为行为断言）；`noteToolResult` 的 stepId 失配分支退化为防御护栏。
  - **批次三（B3，✅ 已落地）**：**终态由驱动器在推进点判定、包装器转达**。
    - `Adjudicator#noteToolResult` 改为**返回 boolean**："本结果之前流程活跃、之后 `flow.state() === null`" ⇒ 驱动器在本结果上收束了流程（终态 / 失败 / 打断复位）。`MudDeliveryChannel#noteToolResult` 同步返回 boolean；`mount.ts` 的包装器 `concluded = channel.noteToolResult?.(…) === true` ⇒ `if (concluded) exec.concludeTurn()`。**决策者是流程驱动器，运行时只转达**（D8 合规：不按运行时观测推断流程）。
    - **判据 B 删净**：`shouldConcludeTurn`（裁决器 + `session` + 包装器接口）、`DeliveryChannel` 的"动作总数"字段与 `actionCount`/`deferCount` 读数；`rememberDelivery`/`rule`/`pending` 保留（服务流程判据解析与账本驱逐）。
    - **账目验收**：`loop-sim` 仍为 **1 回合 / 3 步 / 3 请求 / 0 空续步**（`concludedTurns: 1`）；`earlyStop:'none'` 对照组仍为 4/4/1 —— 证明"这一步确实由 B3 转达收束"。
  - **批次四（⑥ 工具面净删，✅ 已落地）**：
    - **tool-call 参数**：`mud_send` 删 `classify` / `captures`（W10.1 落地物退役）；`resolveSettleWindow(settle)` 单参，只解析 `mode`/`on`（`ga`→`gaCount`、`regex`→**`closeOn`**）/`fallback`；legacy `until` 与活动表 `until` 一并改为**关闭触发**。
    - **工具结果**：`MudToolResult` 与 `OUT_SCHEMA` 只剩 `{ok, note, cmd, settled}`（形状固定并有回归用例）；`viaWindow` 直取四项。
    - **窗口收窄为纯收口器**：`WindowRequest`/`WindowSpec` 只剩 `{cmds, closeOn?, gaCount?, timeoutMs?, label?, signal?}`；删 `WindowCriteria`/`criteria`/`branch`/`gaOutcome`/`onSettle`/`captures`/`okMarkerId`/`failMarkerId`/`branchMarkerIds`/`extractCaptures`；`settleCriteria` 只认 `win-<n>:close`；`GA 关窗`与`证据关闭`都**不带结局**；`WindowResult` 只剩 `{ok, cmd, text, lines, settled, span}`；`ReplySettle` 去 `'until'`；`diag().open.criteria` → `trigger`。
    - **贯通清理**：`FlowWindowSpec` 去 `criteria`/`gaOutcome`；`noteToolResult` 链（`adjudicator`/`session`/`mount`/`flow`）去 `hitText` 参数；判定/结局全由驱动器给出（`{lastFail}` 取自复判命中行）。
  - **⚠️ W10.4 尚未收官 —— 还欠第 3 / 5 / 6 步**（2026-09-21 复核，勿误记"已完成"）：本切片真正的主角是"**T1 从无状态渲染器改为有状态流程驱动器**"，四批形态 C + B3 只把**判据与终态的属主**挪到了驱动器（`FlowRuntime`，会话作用域），**渲染面与槽表仍是旧形态**：
    - **第 3 步（槽表 + 发布点，✅ 已落地 2026-09-21，行为中性）**：新增 `agent/flow/slot.ts` —— `FlowSlot`（`flowId` / `stepId` / `phase` / `render` / `pendingCallId` / `retries` / `captureSlots`）+ `FlowSlotTable`（**会话作用域**、一格、替换语义、`clear()`）；`FlowRuntime` 在**迁移点**发布（进入步骤 / 成功转等分支 / 终态收束 / 复位 / `dispose`）。
      - `render` = 本步要发的 tool-call（**未插值**参数 + 收口三件）；收口三件由新抽出的 `windowSpecOf(step, commandCount)` 给出，**与 `windowSpecFor` 同一次派生** ⇒ "T1 渲染的 tool-call"与"窗口注册"不可能分歧。
      - 新增 `tests/flow-slot.spec.ts`（4 例）：空闲为空 / 入口后含本步 tool-call / **槽内三件与 `windowSpecFor` 逐字段一致** / 等分支不带 `render` / 收束与复位清空。
      - **本步行为中性**：槽是**只读投影**（第 5 步起 T1 才消费），全部既有用例不变（33 文件 / 359 例绿）。
    - **第 5 步 T1 渲染改造（分三件，①②✅ 已落地；③待实施）**：
      - **① T1 按槽渲染**（✅）：`TriggerLlmAdapter` 增 `slotOf` / `markRendered` 钩子（`assemble.ts` 用 `runtimes.get(sessionId)?.slot()` 接线，D10/I8：槽表归会话作用域、adapter 无状态）；判定序 = **投递里的动作优先**（规则动作 / 入口回合不被槽顶掉）→ 无动作可渲染时**按槽渲染**（`render.tool`/`render.args` **原样透传**，收口三件仍由壳侧 `windowSpecFor` 在注册窗口时给，单一来源）→ 槽不可渲染则收束。**不发 `output` 文本块**（流程步的 tool-call 就是全部内容，A4 要的"助手/工具交替、无注入"）。确定性 callId = `mud-flow-<flowId>-<stepId>-<retries>`。
      - **② callId ↔ 步骤配对移进槽**（✅）：`FlowRuntime#stepIdForCall(callId)`（槽的 `pendingCallId` 配对）+ T1 渲染后 `markRendered` 写槽；`Adjudicator#noteToolResult` **槽配对优先**、回落投递账本（入口步等仍带投递的调用）；`pendingCallId` 由**迁移点发布**自动复位（含 `tryRetry` 重发本步），故不会重复渲染同一步、也不需要额外的"清配对"调用。
      - **③ 删非入口步的投递（待实施，本步的"激活"）**：`enterStep`/复判路径不再产出动作投递（入口投递保留 = 开回合 + `flow:{id}`）。
        - **实施前必须先解决一处新发现的约束（2026-09-21 复核 `tryRetry` 得出）**：**重试会一次产出两条调用**（fullme `answer` 答错 → ① `retry.action` 重挂 `mud_captcha` 取图 ② 本步动作 `mud_send{halt, fullme {captcha}}` 且带 `awaitExternal` 被"待人工"挂起）。投递式路径靠"两条投递 + park"表达这个序列，而槽只有一格 `render` ⇒ **槽必须扩成"待发调用序列"**（或由驱动器在 `pre` 的结果回来后发布本步动作，把序列走成两拍）。**这是 ③ 的主要设计点**，不是开关。
        - **③-1 定稿建议（2026-09-21，待实施；两案择一，推荐"两拍"）**：
          - **两拍（推荐）**：槽**一次只放一条待发调用**（`render` 不变），重试由驱动器走两拍 —— 有 `retry.action` 时先发布它（拍 1），它的结果回来后再发布本步动作（拍 2）。**与人工环节的衔接**：拍 2 只在外部值就位时发布，而"就位"的信号已有现成入口 —— 壳在人工回填后调 `flow.resumeHuman()`；今天它只翻相位，③ 里让它**同时发布拍 2**。好处：`park`（`awaitExternal`）的判断留在**持有外部值的一侧**（壳/`missingExternalValues`），槽里永远只有"现在真能发的那一条"，T1 不需要知道人工状态。
          - **队列**：槽带 `pending: Call[]`（含 `awaitExternal`）。代价：`park` 语义要搬进槽，且 T1 得知道"哪条能发"（要么再问壳，要么把 `externalValues` 也投影进槽）—— 把人工状态摊到了两处，不推荐。
        - 落地后立即：把 `loop-sim` 的 `emptySteps` 拆为 `claimlessSteps` / `idleSteps` 并实测（预期 **1 回合 / 3 步 / 3 请求 / `idleSteps`=0**、转录里除入口零投递消息）；`flow-login` / `flow-fullme` / `runtime-captcha` 的夹具需从"执行最近一条投递的动作"改成**经 T1 适配器按槽渲染**（与 `loop-sim` 同款驱动）。
    - **第 6 步 回合结束接线（未做）**：`agent/turn-stopping` / `agent/status` idle / `whenIdle()` 未接；**打断事件动作改 followup 的代价因此仍未测**（§6.4 未测项）。
    - **W10.5 的"删除 `agent/t1.ts` 无状态渲染器的流程部分"依赖第 5 步** —— 未做第 5 步就无法删。
    - **⚠️ 第 5 步（T1 渲染改造）带出一个必须先裁决的账目代价（2026-09-21 复核得出，**未实施**）**：
      - **机理**：今天"流程步 = 一步"靠的是 **判据 A（defer）**——每步的下一步动作随上一条工具结果进 `next-step`，故下一步 `claim=1`（**0 空续步**）。第 5 步要让 **T1 按槽渲染下一步**，而 D5 又要求"删除 T1 流程步进对 defer 的依赖"（不再逐步投递）⇒ 工具结果**不进 `next-step`**（官方只在 `deferContext` 时追加）⇒ 之后的每一步都是 `claim=0` 的**空续步**（一次本地 T1 请求），只是碰巧在这一步渲染出下一个 tool-call。
      - **投影**（按 login 三步链路推）：**1 回合 / 3 步 / 3 请求 / 2 空续步**（B3 让终态那一步收束，故不再是 4 步）；今天是 **1 回合 / 3 步 / 3 请求 / 0 空续步**。历史 `followup` 基线 3/6/6/3 —— 回合数与请求数不退化为后者，但**空续步 0 → 2**。
      - **两个选项（互斥，需作者裁决）**：
        - **A｜T1 按槽渲染 + 删净逐步投递**：投递面塌缩为"入口一次 + 工具结果"，T1 真正持状态；代价 = 每流程步多一个 `claim=0` 的**本地 T1 请求**（不打真实 LLM）。
        - **B｜保留逐步投递 tick**：每步仍投递一条（内容从 `actions` 缩为**纯 tick**，动作由 T1 按槽渲染），defer 机制保留 ⇒ 账目仍为 **0 空续步**；代价 = "逐步投递"这一层没有真的消失（D5 的删除面只删掉了 `actions` 携带）。
      - **§19.6.1 规矩**：两者都必须**实测**（`loop-sim`）后才能定稿 —— 上表投影待实施后复核，不得据投影直接改设计。
    - **第 3 步（槽表）与本裁决无关**：状态从 `FlowRuntime.active` 搬进会话作用域的槽表是**行为中性**的重构，无论选 A 还是 B 都要做。
  - **W10.5 删除清单零残留核查（已做，2026-09-21）**：对 `src/` 全量 grep 结果 —— `shouldConcludeTurn` / `actionCount` / `deferCount` / `closeForFlow` / `onStepJudged` / `armOwnJudgements` / `applyMatch(` / `deliveredAbs`（代码）/ `noteDelivered` / `foldedAbs` / `foldLines` / `WindowCriteria` / `gaOutcome` / `mud_recall`（工具面）**全部为 0**；仅剩说明"已删除"的**文档注释**（保留作历史指引）与 `rememberDelivery`（**按计划保留**：服务 rule 解析与账本驱逐）。`classify` / `captures` 的剩余命中全在**流程表与 flow-spec**（形态 C 下归 flow 所有，正确），工具面 `tools-schema.ts` **零命中**。
   此步把**判据 owner 从 flow-arming 挪到驱动器**，是槽表能搬进 T1 的前提。
3. **槽表 + 流程驱动器**（D10：槽表归**会话作用域**，T1 adapter 只按 `sessionId` 查写；I8）：`flowId / stepId / captureSlots / lastFail / attemptCounts / stepBudget / connectionGen / lane / pendingCallId`（§3.4）。
4. **推进点与终态（B3）**：包装器 `noteToolResult` → 驱动器查表推进 → **驱动器判终态** → 包装器 `exec.concludeTurn()`；`shouldConcludeTurn` 及投递尺寸记账删除（W10.5 核查零残留）。
5. **T1 渲染改造**（`agent/t1.ts`）：有活槽 → 按槽渲染下一步 tool-call；无槽 + 消息带 `flow:{id}` → 开槽启动；其余 → 动作渲染回合（不变）。入口投递加 `flow:{id}` 字段（D1）。
6. **回合结束接线**：`agent/turn-stopping` + `agent/status` idle + `whenIdle()` → 活跃失效 + 入口 arm 恢复 + `drainFlowQueue`；**打断事件动作改 followup**（D5）—— 落地后**立即补测**打断的回合/步骤代价（§6.4 未测项）。
7. **A2 同帧定序**（fail → 分支 → ok 批量匹配取一，其余留痕）。

> 切片编号统一用 `W10.*`。**早期草案在第 4/6 章与 CHANGELOG v0.10.1 里用了 `S1–S6`，而 `S1–S4` 已被 §8.8 用于 v0.9 W7 切片 —— 同一仓库内 S 编号撞车，本次统一为 W10.\***（**修正元信息表之外的第 7 处，属编号一致性**）。

**验收场景**：

- **A1 收口校验**：**T1** 流程步与注册窗口的规则动作未声明 settle 在**装配期**报错（fail-loud）；**T2 调用不声明是常态** —— 缺省 stream + fallback 3s 生效，**恒等满 fallback 后以 `timeout` 返回**（不计 GA、不做匹配）；`settle.on` 与 `classify` 同声明被拒；**`direct` 豁免校验**（不开窗、不消费，3.1 定案）。
- **A2 同帧与无回看**（**归属 W10.4**）：登录 `replace` 分支在"本步结果行 + 后继 driver 同帧"场景判定正确（**该行同时是结果行与后继 driver，由驱动器对 span 复判一次走序即得 class=branch**）；**同帧跨行多类命中按 fail → 分支 → ok 取一**（形态 C 下由驱动器复判的走序实现：现行为是标记注册序/到达序）；命令发出前已在缓冲的行不参与本步结算（无回看）；**窗口关闭后到达的 driver 行视为没到**。
- **A3 span 与状态桶**：命中结算 span ≥ 1 行（触发行必在），空值结算被拒；状态抓取结果同步 world、不推进水位、不折叠内容；**`direct` 不消费、不推水位**（其命中行与应答行按普通行进入 T2 批次）；行流无隐藏行、span 无空洞。
- **A4 会话形状**：一个流程 = 一个回合、全程 T1；回合内不出现投递消息（除入口）；入口 1 次 + 助手/工具交替（三件套消解）；**loop-sim 账目**与设计一致。
- **A5 打断与失败**：打断 → `interrupted` → 流程槽复位 → finish stop → 事件动作 followup 新回合；流程失败（超时 / fail 无出口 / 预算耗尽）→ `failPolicy.notify='t2'` 时投递一条 T2 可见失败消息 → 回合结束，T2 接手。
- **A6 兜底到期**：到期即 `timeout` 结算（不属于 ok/fail），提交全部窗口内容并记当前调用者消费（水位 → 缓冲头）；随后流程失败收束。
- **A7 优先级**：打断 > 分类/on 命中 > 超时 > 断线；打断与分类同帧时分类作废留痕。
- **A8 删除回归**：第 4 章删除面无残留引用（tsc 清零）；既有用例对齐后全绿。
- **A9 行流守恒**：可测不变量用例（span + T2 批次 + 命中行 + 带原文投递 == 完整入站行流）；流程失败未结算行计入后续消费批。（**W10.3 已固定其中一例**：状态抓取行与 `direct` 反射行都原样投出；span 记账面归 W10.6。）
- **A10 文档一致**：正式章节与实现一致；§17 / CHANGELOG 大版本登记。
- **长命令**：dz / sleep 以结束标记正则（分类 / `on`）收口、`fallback.ms` 表内按实际步骤耗时写大值（GA 仅显式声明收口时使用；哨兵探测步为实验功能，不进验收）。

**T2 回归验收（D9，与轨 A/B 并行跑）**：

- **R1 T2 查询收口**：`mud_look` / `mud_status` / `mud_move` 经工具 schema **显式声明 `settle:{mode:'stream',on:{kind:'ga',count:1}}`**，结算行为与量级与改动前一致（对照用例而非目测）；**裸 `mud_send`（T2 不声明收口）恒等满 fallback 后以 `timeout` 返回、GA 早到不提前关窗** —— 已定性为**接受的行为变化**（2026-09-21 定案），W10.2 落地后需实测 T2 任意命令的实际等待量级并记录。
- **R2 T2 读工具语义（改写）**：`mud_recall` **已删除**——验收改为确认"T2 仅凭会话历史即可获得所需输出"（推一个批次后，模型无需任何工具即可看到该批内容）；`mud_state` 去 `lines` 后只返回 world 快照，其世界模型字段与改动前逐字段一致。**并确认不存在任何 pull 通路**（无查询 pending / 缓存帧的工具）。
- **R3 T2 回合边界**：T2 工具在途期间到达的批次/规则动作**仍随该工具结果进同一回合**（判据 A 未删）；对照 `runtime-defer.spec.ts`。
- **R4 T2 失败可见性**：流程失败时 T2 能收到失败原因（`notify='t2'` 路径）；`notify='none'` 时行为与现行 login/fullme 一致。

### 6. 未决、待实测与完成定义

#### 6.1 架构未决（起草期需作者定案）

- **✅ 已裁决（2026-09-21，作者提法 + 定案 **形态 C**）：收口的位置也注册触发器，但只返回收口信号（与 GA 同形不同名），工具带回的内容由驱动器按判据再走一遍。**
  - **内容**：窗口侧只持**关闭触发**（`settle.on` 正则，T1 由本步判据派生、T2 自填）；三触发（触发命中 / N-GA / fallback）走同一收口路径，返回 `settled:'evidence'` / `'ga'`（**同形不同名**，都不携带分类）；`{text, lines, span}` 随结果交回；**驱动器在推进点（`noteToolResult`，工具在途期间）对 content 按自己的判据走一遍**（定序 fail → 分支 → ok）得出 class / branchId / `{lastFail}` 原文 → 查表推进；未命中 → `onSettle`（证据关闭）/ 失败（到期）。
  - **取代**：此前"判据注册进窗口"的**形态 B**（**已否决** —— 让窗口匹配 ok/fail/branch 并给出 `hit.class` = 窗口解释内容，违反"收口不解释内容"的定义）。
  - **收益**：① 窗口净退化为收口器（删 `criteria`/`branch`/`gaOutcome`/`onSettle`/`hit`/`hitText`）；② 收口与判据**不可能分歧**（触发从判据派生，一份声明）；③ **A2 的 fail → 分支 → ok 定序天然正确**（驱动器走序，不再是标记注册序的产物）；④ **I15/I16 最干净**：流程步 tool-call 与 T2 完全同形（只剩 `cmd` + 收口），流程词汇一律不进模型可见面；⑤ 形态 A 脚手架（`onStepJudged` / `closeForFlow` / `settled='flow'`）自然退役。
  - **连带的计划收缩**（已在 §3.1/§3.2/§3.3/§D3/§4/§5 改写）：tool-call 参数净删 `classify`/`captures`（W10.1 落地物退役）；工具结果净删 `hit`；`onSettle` 由 `classify.onSettle` 提为**步级字段**；`captures` 归驱动器在 span 上抽；**禁止无 action 的步**（没有窗口就没有收口载体；现状 login/fullme 全部带 action，无回归）。
  - **账目不受影响**：仍为 1 回合 / 3 步 / 3 请求 / 0 空续步（B3 不变）。
- **MVP 删除字段的延后条件**（新）：`onMatch:'tag'`（分类命中不关窗）、`captureScope:'window'`（跨行抽取）、多行分类——三者随同一扩展一并评估，需先有真实消费场景。
- **✅ 已裁决（2026-09-21，作者定案 **B3**）：终态由流程驱动器在推进点判定，包装器只转达**。删净判据 B 会换来每个流程 1 个"空续步"（实测见下），但**不能用 T1 自己发 `stop` 解决** —— DSH 的 `step()` 在本步有 tool-call 时**不看 finish reason**（`agent-loop/src/agent.ts:487-488`：`toolCalls.length === 0` 才收束；`:493` 无 `concluded` 则返回 null ⇒ 同回合继续），T1 的 `stop` 只会落在**下一次请求**上，那正是空续步。定案落点：
  - **推进点不挪**：仍是 `noteToolResult`（工具调用**在途期间**由生产包装器喂回流程机，`session/mount.ts:143`），与 §D5"推进点收敛到 `noteToolResult` 单点"一致。
  - **换人**：末行的 `shouldConcludeTurn(callId)`（裁决器按"投递尺寸 + 流程是否空闲"**推断**）→ 换成**流程驱动器直接给出的终态判定**；运行时不做任何流程推断，只把工具结果转达给驱动器、再把驱动器的回答转达成 `exec.concludeTurn()`。
  - **账目回到 1 回合 / 3 步 / 3 请求 / 0 空续步**；**判据 B 的投递尺寸记账照样删净**（D5 删除面不变）；**不新增任何工具参数**（不用 `conclude`）；**决策者只有流程驱动器一个**。
  - **§3.8 时点口径同步**（本次一并定）：流程推进发生在 `noteToolResult`（工具在途期间），T1 的下一次请求**只按槽渲染下一步**；§3.8 原"T1：hit → 查表"的措辞按此改写为"驱动器在推进点查表"。
  - 实测数据（保留为对照；`tests/loop-sim-login.spec.ts`，官方 loop 模拟器 + 真实运行时/工具/流程/T1，只切换包装器早停接线）：
    | 接线 | 回合 | 步 | 请求 | 空续步 | defer | concludeTurn |
    |---|---|---|---|---|---|---|
    | 现行（判据 B 在：`shouldConcludeTurn` ⇒ `exec.concludeTurn()`） | 1 | 3 | 3 | **0** | 2 | 1 |
    | 删判据 B 且不让驱动器判终态（只靠"T1 无动作"收束） | 1 | 4 | 4 | **1** | 2 | 0 |
    | **B3 目标（驱动器在推进点判终态 + 包装器转达）** | 1 | 3 | 3 | **0** | 2→0（新形态无 defer） | 1 |
  - **机理**：工具结果**不进 `next-step`**（官方只在 `deferContext` 时往 `next-step` 追加，`agent-loop/src/agent.ts:489-492`）⇒ 末步之后 `next-step` 为空而 `turnEnds` 仍为 null ⇒ 回合不结束，**再走一个 `claim=0` 的步**（无任何新输入的模型请求），T1 无可渲染动作才收束。§D5 原写的"T1 无动作即 `finish stop` **自然收束**"实际就是这一空步 —— 故 D5 该句按 B3 修正（终态由驱动器判定，不靠"无动作"兜底）。
  - **代价性质**：若不落 B3，代价是 +1 步 / +1 次 T1 本地请求 / +1 空续步（回合数不变、T2 不介入）；**空续步正是 §19.6 引入 defer+concludeTurn 要消掉的指标**（历史 followup 基线 3/6/6/3 里的 3 就是空续步），故不采用。
  - **备选（均已否决，留档对照）**：**A** 接受 1 空续步（最简但把空续步从 0 退回 1）；**B1** 终态步 tool-call 里加模型可见的 `conclude` 参数（能保持 0 空续步，但要新增工具参数）；**B2** 运行时按投递尺寸/流程空闲**推断**终态（= 现行判据 B，与 D5/D8 冲突）。

#### 6.2 实现待定（随对应切片定稿）

- 流程表新 schema、tool-call 参数 schema（settle/classify 定稿）、裁决器接口、T1 槽结构（W10.1 / W10.2 定稿）；**其中参数 schema 的模型可见措辞须过 I15 检验**。
- `connectionGen` 从哪读（现行等价物是"`abs` 每连接重置 + `reset()` 全清"）。
- span 审计的时间窗与 `PerceptionBuffer`（2000 行上限）驱逐策略的关系 —— span 只有 `fromAbs/toAbs`，留痕回读受缓冲驱逐约束。
- `recallLines` 缓冲**降级为诊断通路**（2026-09-21 定案）：`/mud/diag` + log-service 可读，**不进模型工具面**；保留行数沿用 2000 行上限与自然驱逐（W10.2 定稿）。
- 窗口缓冲上限、每窗口最大分类数（分类正则 + `on` 条件）。
- 打断 / 断线时在途窗口已收内容的消费口径（缺省：留痕消费，水位推进到缓冲头）。

#### 6.3 数值待校准（实测后定）

- 步数 / 时间 / 重试预算的默认值与配置位置。
- fallback 兜底时长缺省 **3000ms**（T2 量级短超时）的实测校准；T1 流程表 `fallback.ms` 按实际步骤耗时填写（各步耗时分布实测见 6.4）。
- T2 攒批上限时长（若保留攒批机制，此处只校准数值）。
- **批次裁剪阈值** `MAX_INJECT_TAIL_LINES = 64` / `MAX_INJECT_TAIL_CHARS = 8000`（`session/types.ts`）—— 取消 recall 后它成为"单批能给模型多少内容"的唯一闸门，需实测校准；`MAX_PARKED_LINES = 512`（`pending` 丢最旧行的口子）是否随调。

#### 6.4 待实测

- N-GA 声明表真机抓包核对（dazuo 等长命令 gaCount 实证，W7.2 遗留）。
- dz / sleep 结束标记正则实测。
- **T1 流程步耗时分布实测**（login / fullme 各步实测耗时，支撑流程表 `fallback.ms` 逐表填写）。
- **loop-sim 新形态账目**（W10.4 第一步）：**✅ 已出并已定案（2026-09-21，`tests/loop-sim-login.spec.ts`，三种接线各一例/目标）**。现行 `defer + concludeTurn` 实测 **1 回合 / 3 步 / 3 请求 / 0 空续步**；**删判据 B 且不让驱动器判终态 = 1 回合 / 4 步 / 4 请求 / 1 空续步**（工具结果不进 `next-step` ⇒ 末步后回合不结束，多走一个 `claim=0` 步）；历史 `followup` 基线 3 回合 / 6 步 / 6 请求 / 3 空续步 —— 新形态未退化为后者。**定案 B3 的目标账目 = 1 回合 / 3 步 / 3 请求 / 0 空续步**（终态由流程驱动器在推进点判定、包装器转达 `concludeTurn`；见 §6.1）。**打断改 followup 的代价**（+1 回合）**待 W10.4 回合结束接线落地后同法实测**（现无该接线，不能凭空建模）。
- **T2 读工具延迟对照**（R1/R2 的量化基线）。

#### 6.5 评审并入对照（原文件末尾散文评审 9 条 → 本计划落点）

> 原第 315–338 行的散文评审（格式不符本文件约定：非六章结构、使用裸文件名）已按上表归位，散文段删除。

| 原评审 # | 事项 | 本轮落点 | 性质 |
|---|---|---|---|
| 1 | T2 攒批与 GA 的关系 | **D3 / D9 定案（三次修订形态）**：T2 命令工具显式声明 `settle on ga:1`，全局缺省 stream + fallback 3s 兜底 | 语义已定 |
| 2 | `mud_recall` 与交付水位的去向 | **3.7 / D9 / 第 4 章修改清单（三次修订）**：交付水位废除；**`mud_recall` 取消**（T2 上下文 = 会话历史，不提供 pull 通路）、`mud_state` 去 `lines` | 已定案 + 补改清单 |
| 3 | 消费水位的物理载体未指认 | **已消解（二次修订）**：回看结算取消，单水位下无"回看数据源/双消费"问题 | 已消解 |
| 4 | 打断 followup 新回合的触发点未写 | **D5 定案（2026-09-21）**：`agent/status` idle + `whenIdle()` | 已定案 |
| 5 | 流程回合与动作渲染回合的区分面 | **D1 定案（2026-09-21）**：消息 `flow?:{id}` 字段 + 槽 `pendingCallId` 配对，lane 不加值 | 已定案 |
| 6 | 直发命令与纯工具步的收口声明豁免 | **3.1（direct 豁免校验、不开窗不消费，2026-09-21 二次定案）/ 3.3 / 3.1（纯工具步 `mode:'inline'` 收口）** | 已定案 |
| 7 | 入口投递"复位重开"与 I10 互斥共存 | **D1 定案（2026-09-21）**：出队 = 入口投递，同样复位重开 | 已定案 |
| 8 | direct-exec 命中行的行流归属 | **3.6 定案（2026-09-21 二次修订）**：不消费、不推水位，按普通行进入批次 | 已定案 |
| 9 | `connectionGen` 来源 + span 可审计时间窗 | **3.4 / 6.2** | 实现待定 |

#### 6.6 文档同步（W10.7）

- §5 / §7 / §8 / §9 / §19 对应改写；§1 不变量按第 2 / 3 章口径落稿。
- **§1 不变量改动范围**：I2 / I4 / I11 / I12 / I13 按新口径改写；**I8 纳入覆盖章节**（D10 的槽表归属）；**I15 原文保持不变**，新增 **I16**（T1 私有状态不进 T2 可见面）。
- 术语表：新增（收口-分类分离 / **形态 C＝收口器 + 驱动器复判** / **关闭触发** / 单一水位线 / 状态抓取桶 / 流程驱动器 / 触发器反射（direct））；删除或改写（判据-only / 配对移交 / arming 集 / 唤醒 / 折叠 / 三水位 / 发送水位 / 交付水位 / 回看结算 / **历史查询**）；defer 保留。
- §17 新增切片行（W10.0–W10.7）；`doc/CHANGELOG.md` 按版本号规则登记（本计划属核心重构，升大版本 v0.11.0）。
- **D0 结论同步进正式章节**（§19 或 §17），避免"官方有无流程插件"被反复重新提出。

#### 6.7 完成定义（满足后才从本文件删除本计划）

- W10.1–W10.7 全部落地且验收场景 A1–A10 + **R1–R4（T2 零回归）**通过（全包测试绿 + tsc 清零）。
- loop-sim 新形态账目出具且不退化为 followup 基线。
- 正式章节同步完成、术语表与 §17 登记完成、`doc/CHANGELOG.md` 大版本登记完成。
- 此后按文件头约定删除本节，不留档。

#### 6.8 W10.2 代码增量（与现行代码的差异清单，2026-09-21 口径裁决后新增）

> 依据：作者 2026-09-21 五条裁决（T1/T2 同型收口、判据唯一类型、direct 剥离、A2 归属 W10.4、迟到 driver=没到）。
>
> **落地状态（2026-09-21 实施回填；全包 32 文件 / 361 例绿 + tsc 清零 + vitest exit 0）**：
> - ✅ 第 1 项（**声明才计 GA**）：删除 `gaCount ?? cmds.length` 隐式缺省。解封方式是**单一收口路径**（见下方"设计修订"），不是「分类 owner 化挂窗口」。
> - ✅ 第 2 项（`onSettle` 缺省 `'ok'` 生效、废除 `hasCriteria ? 'fail' : 'ok'`）：`inflight.ts` 的 `boundary()` / `settle()` 结局链改为 `gaOutcome ?? onSettle ?? 'ok'`；`tools-build.resolveSettleWindow` 恒透传 `onSettle`。
> - ⛔→✅ 第 3 项（**跨层互斥已撤销**）：原「`settle.on` ∧ `classify` 互斥」是**错口径** —— 把两个正交概念当一层。工具层与装配期的互斥校验已移除，改为**层内唯一类型**；`settle.on ga:N` + `classify` 现可共存。
> - ✅ 第 4 项（`direct` 剥离）：核查确认 direct 现行即 `fireAndForget: true`、**从不注册窗口**（`adjudicator.runDirectHits`），故不消费、不推水位 —— 本项无需改动；折叠面（`foldedAbs` 里的 direct 命中行）删除**已随 W10.3 落地**。
> - ✅ 第 6 项（测试对齐）：`tools.spec` / `response.spec` / `permission.spec` / `preset-agent.spec` 老口径断言已反转或重写；新增「`onSettle` 显式 `'fail'` 才判失败」与「`mud_recall` 已删除」用例。
> - ✅ 第 7 项（recall 取消）：删除 `mud_recall` 工具、`mud_state` 去 `lines` 参数（只返回 world 快照）、`recall()` / `recallLines` 降级为诊断通路；档位工具清单与提示文本、policy 拒绝文案同步。
> - ✅ 第 5 项（direct 面核查见第 4 项；**折叠面删除已随 W10.3 落地**）。
>
> **设计修订（2026-09-21 二次定案；执行中发现的缺陷，作者定性）**：
> - **缺陷**：三条收口触发（判据 / GA / timeout）原本**不在同一路径** —— 流程判据走 `armOwnJudgements` 的帧文本 arming 路径推进流程、**不关窗**；窗口只靠 GA 关。所以"删隐式 GA"必然挂死，而"把判据搬给窗口"又会与 arming 路径**双重推进**。
> - **定案**：**收口 ≠ 判据**。收口只回答"窗口何时关闭"（**不解释内容**）；判据由 **flow 持有**，回答"内容指向哪个 next"。**判据 / GA / timeout 三触发收敛到同一个 `settle()`**，保证无论如何都能收口（I4）。由此 §D3/§3.1 的"跨层互斥"作废，改为**层内唯一类型**。
> - **形态 A（本次落地）**：flow 保留 arming 评估，命中即调 **`closeForFlow()`** 关窗；结果带 `settled='flow'`（只释放工具调用、不携带判定），`noteToolResult` 对该值直接返回 ⇒ **不双推进**。`windowSpecFor` 同步改为"**声明了 GA 判据才供给 `gaCount`**"。
> - **形态 B（归 W10.4）**：判据注册进窗口（`win-` 标记）、`offer()` 退化为"入口匹配 + 喂行"、推进点收敛到 `noteToolResult` 单点（`settled='flow'` 随之退役）。**⚠️ 已被形态 C 取代（2026-09-21 四次修订，见 §6.1）**：让窗口匹配 ok/fail/branch 并给出 `hit.class` = 窗口解释内容，违反"收口不解释内容"；改为**窗口只有关闭触发、判据归驱动器在推进点复判**。`offer()` 退化与推进点收敛两点保留。
>
> **✅ 原遗留待裁决项已裁决（2026-09-21，作者定案 A）**：`timeout` 结算**带回已累积内容**（span 行进结果的 `lines`/`text`；状态仍 `timeout`）。已落地：`inflight.ts` 的 `'timeout'` 分支改为 `text: textOfLines(spanLines)` / `lines: spanLines`，`ABANDON_TEXT` 常量删除；`response.spec` 与 `runtime-delivery.spec` 各补一例断言"兜底到期带回内容"（含 T2 裸调用拿到回显）。

| # | 位置 | 现状（旧口径） | 目标（新口径） |
|---|---|---|---|
| 1 | `agent/inflight.ts` `register()` | `const gaCount = spec.gaCount ?? cmds.length` —— 未声明也计 GA、GA 早到即关窗 | 未显式声明 `on:{kind:'ga',count:N}` ⇒ **不做 GA 计数关窗**（`boundary()` 直接返回）；**删除隐式缺省**（**✅ 已落地**；`windowSpecFor` 同步改为"声明了 GA 判据才供给 `gaCount`"） |
| 2 | `agent/inflight.ts` `boundary()` / `settle()` | 结局链 `w.gaOutcome ?? w.onSettle ?? (hasCriteria ? 'fail' : 'ok')` —— 保留"GA 到达 + 判据未命中 → fail"隐式裁决 | 走 `settle.on` 关窗路径时恒由 **`onSettle`（缺省 `'ok'`）** 裁决；**删除 `hasCriteria ? 'fail'` 隐式** |
| 3 | `agent/tools-build.ts` `resolveSettleWindow()` | `let onSettle = 'ok'` 但仅在等于 `'fail'` 时才透传给窗口 ⇒ 缺省 `'ok'` 丢失 | **恒透传** `onSettle`（缺省 `'ok'` 必须落到窗口） |
| 4 | ~~装配期（`agent/flow/flow-spec.ts`）+ 工具层校验：`settle.on` ∧ `classify` 互斥~~ | ⛔ **已撤销**（错口径：把正交两层当一层） | 改为**层内唯一类型**（`settle.on` 单 kind、`classify` 只收正则）；**层间不互斥** |
| 5 | `deliver/adjudicator.ts` direct 出口 + 站⑤ | direct 命中行经 `foldedAbs` 折叠，不进交付视图 | direct **不消费、不推水位**：命中行与应答行按普通行进入行流（→ T2 批次）；direct 从窗口 / 结算 / span 体系剥离（**✅ 折叠面已随 W10.3 删除**；direct 不注册窗口本即现状，见第 4 项） |
| 6 | `tests/tools.spec.ts`、`tests/response.spec.ts` | `tools.spec.ts` 断言"缺省由窗口表取 `cmds.length`"；`response.spec.ts` 只覆盖显式 `onSettle:'fail'` | 断言反转（未声明 ⇒ 不关窗）；补 `onSettle` 缺省 `'ok'` 用例与 T2 裸 `mud_send` 等满 fallback 用例 |
| 7 | `agent/tools-build.ts`（读工具面）+ `deliver/adjudicator.ts` | `mud_recall` 存在（"最近 N 行历史输出"）；`mud_state` 带 `lines` 参数 | **删除 `mud_recall`**；`mud_state` 去掉 `lines`（只 world 快照）；`recall()` / `recallLines` **降级为诊断通路**（§6.2 已定：`/mud/diag` + log-service 可读，不进模型工具面） |

> 已确认无需改动的部分：`agent/t1.ts`（无状态渲染器，W10.4 才动）、`deliver/lane.ts`（lane 取值不加值）、`agent/flow/flows/{login,fullme}.ts`（W10.1 已按新口径重写）。

> 处置注：原 U1（断线后流程整体挂起续接）已迁 §19.7 待定 #3；原 U2（断线复位重开）定案进 D6；原 U3（折叠口径）**经两轮反复**（v0.10.3"折叠但不推进水位" → v0.10.4"彻底取消折叠"）最终定案进 D3 / 3.6；原 U4（前置噪声容忍）常规化进 D3（判据特异性纪律）；原 U5（按 owner 汇总命中）随判据-only 模型消解。
>
> 2026-09-21 二次修订登记：① 收口/判据结构分离——收口 kind = time/regex/ga/tool、缺省 `{kind:'time', ms:3000}`、判据只支持自填正则 + `ref:'settle'`、取消 text、表级 settle 显式校验保留、T2 命令工具显式 `settle ga:1`、GA 隐式早关废除；② 三水位归一为单一水位线——回看结算取消（概念性错误：命令发出前已在缓冲的行不是本命令的应答）、recall 改历史查询、交付水位废除、状态抓取行确认不推进水位；③ `flow/` 目录整体迁入 `agent/flow/`（W10.0 纯搬迁先行）。
>
> 2026-09-21 三次修订登记：① tool-call 契约形态收敛——settle 改 `mode:'inline'|'stream'` 判别式联合（`tool` 收口 → `mode:'inline'`、GA 移入 `on` 提前关窗条件、time kind 删除——纯计时窗 = stream 无 `on`）、分类只支持自填正则（`classify.onSettle` 取代 `{ref:'settle'}`，fullme `stale` 显式 `on ga:3` + `onSettle:'fail'`）、取消 `onMatch`/`priority`/`captureScope` 三字段、`fallback` 缺省 3000（T2 量级短超时；T1 表内按实际步骤耗时填写）且到期恒 `timeout` 结果、inline 下声明 `classify`/`captures` 报错；② 契约语境术语改名：判据 → 分类（判据 A/B 与直发判据投影不改名）；③ 判定顺序固定 fail → 分支 → ok（`priority` 字段删除，同帧多命中按序取一、其余留痕；装配期不做特异性检查——正则写错属配置问题）。
>
> 2026-09-21 **W10.1 定稿修订登记**（实施完成；上面三处 `prompt`/`answer` 表述按本条同步修正）：① **fullme `answer` 收口形态定稿**（作者定案"stream + classify"）：`settle:{mode:'stream'}` + `classify:{ok:[成功句], fail:[答错句]}` + `fallback:{ms:180_000}`（等人工 + 答错重来 + 收结果共用一份步预算），`retry`/`awaitExternal` 保留；**inline 只保留给 `prompt`**（取图、ask-human 工具结果即收口）——此前三处"`prompt`/`answer` 都用 inline"的写法作废；`prompt` 保留显式 `timeoutMs:180_000` 过渡（W10.4 定稿步预算形态），`stale` 按 D3 落 `on ga:3` + `onSettle:'fail'`（旧 fail `why` 文案随之丢失，可接受）；② **流程表 `captures` 两面区分**：流程表字段 `captures`（JS RegExp 数组、命名捕获组 `(?<name>…)` 即槽名、未匹配不报错）经 `normalizeFlowSpecs` 过渡桥映射回 legacy `capture` 映射（引擎按进入判定行抽取，行为逐字段保持）；tool-call 参数 `captures` 在 inline 收口下工具拒绝——两者的作用面（driver 命中行 vs 窗口 span）不同，3.1 "inline 下 captures 报错"条文不改；**capture 抽取与 captures 参数的窗口透传延后 W10.2**（与 capture 回调一起做）；③ **装配期校验双形**：新形步骤（有 `settle`）走新校验（**inline 拒 `classify`——流程表 `captures` 合法**，其作用于 driver 命中行抽取；tool-call 参数面"inline 拒 captures/classify"由工具层 `resolveSettleWindow` 承担、装配期不管、`on` 条件显式、`fallback.ms` 正数、classify 正则编译 + `branch.id` 存在性、captures 编译 + 命名组槽名唯一且**先于占位符校验**收集）；旧形步骤（无 `settle`，测试夹具用）沿用 legacy 校验，W10.5 收紧为必填；`stepBudget` 仅声明 + 形态校验（W10.4 消费）；④ **工具层（tools-build.ts）落地**：`mud_send` 新增 `settle`/`classify`/`captures` 参数（I15 措辞）、`until`（legacy）与 `settle` 互斥拒绝、非法声明 **fail-closed 拒绝**、缺省 stream + fallback 3000（两 lane 一致，调用期不报错）、inline 收口直发 + 立即返回、活动表仅无判据时附加（dz/sleep 90s 行为保持）、`until` 路径不吃 3000 缺省（保持 120s 声明超时）；T2 三工具显式 `T2_QUERY_SETTLE`（on ga:1，R1）；⑤ **类型归属**：新契约类型落 `agent/flow/flow-spec.ts`（原清单写 flow-types.ts，避免循环 import）；⑥ **已接受的行为变化**：裸 `mud_send` 与 T2 三工具的放弃计时 10s→3s（GA 正常到达时行为量级一致）；引擎/裁决器/inflight **零改动**（过渡桥映射，W10.2/W10.4 拆桥）。
>
> 2026-09-21 **口径裁决登记（作者，W10.2 期；落实清单见 §6.8）**：
> ① **T1/T2 同型收口**：T2 调用时不做任何收口声明 ⇒ 缺省恒等满 `fallback` 后以 `timeout` 返回；T1 组装期校验必须显式声明、漏写报错。**声明才计 GA 数、才做匹配**，判据不中即 timeout —— `inflight.ts` 的 `gaCount ?? cmds.length` 隐式缺省属旧口径，**必须删除**（推翻 v0.10.5 期"T2 lane 保留 GA 缺省关窗"的写法；T2 三查询工具改由工具 schema 自带 `on ga:1` 声明保住 GA 早关）。
> ② **判据唯一类型**（⚠️ **已被同日二次定案撤销** —— 收口与判据是两层正交概念，见文末"收口/判据二层分清"登记）：同一步的 `settle.on` 与 `classify` 正则判据**互斥**，不允许"既判 regex 又计 GA"；判据不中直接等超时，**废除"GA 到达 + 判据未命中 → fail"的隐式裁决**（`onSettle` 缺省 `'ok'` 必须真正生效）。
> ③ **`direct` 剥离**：direct **豁免配置校验**，**不开窗、不消费、不推水位**，是只属于触发器层的纯反射行为，从收口 / 在途窗口 / 单水位体系中剥离 —— **取代同日"direct 显式 GA 收口 + span 消费"口径**，同时消解 §3.1/§3.6/§3.10 三处互斥。
> ④ **A2 归属**：同帧定序（fail → 分支 → ok 批量匹配）定给 **W10.4**（现行为是到达序，代码注释亦标 W10.4 收口）。
> ⑤ **迟到 driver = 没到**：窗口关闭后到达的 driver 行，对流程即视为没到，按普通行进入后续消费批；确认为可接受口径（不再列为风险）。
>
> 2026-09-21 **recall 取消裁决登记（作者）**：取消 `mud_recall`，**T2 的上下文 = 会话历史本身**；**不提供任何 pull 通路**（不查 `pending`、不查缓存帧）。`mud_state` 保留但去掉 `lines` 参数，只返回 world 快照。**取代二次修订的"recall 改历史查询"口径**（历史查询仍是 pull 的一种，与"推送节奏是唯一节拍"冲突）。残留边界仅两处、都有痕迹、都不额外给恢复通路：批次裁剪（session 内留 `[观察窗截断]` 标记）、`pending` 超 `MAX_PARKED_LINES` 丢最旧（记日志）；两者阈值列入 §6.3 待校准。
>
> 2026-09-21 **收口/判据二层分清 + 单一收口路径（作者定性，W10.2 落地）**：① 定义澄清 —— **收口只回答"窗口何时关闭"（不解释内容），判据由 flow 持有、回答"内容指向哪个 next"**，只有声明收口类型为判据时两者才重合；② 由此**撤销**同日"`settle.on` ∧ `classify` 互斥"口径（把正交两层当一层），改为**层内唯一类型**；③ **三触发（判据命中 / GA 计数〔仅显式声明时〕 / fallback 到期）收敛到同一 `settle()`**，窗口恒有界（I4）；④ 形态 A 落地：flow 命中即调 `closeForFlow()` 关窗（结果 `settled='flow'` 只释放工具调用、不携带判定，`noteToolResult` 直接返回 ⇒ 不双推进），`windowSpecFor` 改为"声明了 GA 判据才供给 `gaCount`"，**`gaCount ?? cmds.length` 隐式缺省删除**；⑤ 形态 B（判据注册进窗口、推进点收敛单点）归 W10.4 —— **⚠️ 2026-09-21 四次修订：形态 B 已否决，改为形态 C（窗口只注册关闭触发、判据归驱动器复判），见 §6.1**；⑥ 全包 32 文件 / 361 例绿 + `tsc` 清零 + vitest exit 0。
>
> 2026-09-21 **W10.3 落地登记（轨 A 收官）**：① **折叠机制整体删除**（不是"只删消费面"）—— `perceive/types.ts` 的 `MatchHit.foldLines`、`perceive/matcher.ts` 两处构造、`perceive/engine.ts` 的 `FeedResult.foldedAbs`、`deliver/adjudicator.ts` 站⑤ 三处过滤与 diag 折叠计数全部移除；**理由**：`foldedAbs` 一旦不再被读，`foldLines` 就成了只写不读的死数据，且 `match-service.spec.ts` 会留下一组断言"死概念"的用例。第 4 章删除清单的"§5 折叠机制（折叠行 / 折叠消费）"项**就此闭项**，W10.5 对该项只做零残留核查（属**切片边界微调**：折叠行生产面原可留到 W10.5，实做并入 W10.3，理由是二者是同一概念的读写两面）。② **实际动到的文件比 W10.3 原列多**：原列 `perceive/engine.ts` / `deliver/state-track.ts` 漏了真正的消费点 `deliver/adjudicator.ts`；`deliver/state-track.ts` 本次**行为零变更**（state 抓取本来就只 `patch(...,'percept')`），只改文档口径。③ **已接受的行为变化（D9 面，须记）**：状态抓取行与 `direct` 命中行从"不进 agent"变为"照常作为普通行进入 T2 批次"—— T2 由此**多看到**被 state 规则抓取的行（如气血/房间描述）与 `save`/分页提示行。这是**增信息**（非能力回归，R1–R4 不受影响），但确实改变 T2 可见文本，故按⑦已接受变化的口径显式登记。④ **测试面**：`match-service.spec` 三例折叠语义 → 合一例"无折叠面"（`'foldLines' in hit === false`，防回潮）；`perception.spec` 两例改断言"结果里没有折叠面"; `runtime-direct-action.spec` 两例反转为"提醒行照常投出"；`runtime-delivery.spec` 新增行流守恒末节（A9 起步）。32 文件 / 360 例绿 + `tsc` 清零 + vitest exit 0。
