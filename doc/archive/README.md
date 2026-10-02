# 归档索引 · 退役设计文档集（v1 / v2）

> **状态：ARCHIVED**。本目录及其全部子目录**只用于追溯历史决策**，**不得**据此实现、验收或引用为设计依据。
>
> **全树归档声明**：子目录内文件的 YAML front-matter（`status:` / `sections:` / `deps:` / `impl:`）保留搬移时的历史原貌，**其中任何 `status: active` 一律作废**——归档结论以本文件为准，不以文件内自称状态为准。
>
> **现役设计事实源** = [doc/ARCHITECTURE.md](../ARCHITECTURE.md)（mud-core3，§0–§17）。
>
> 引用本目录内容一律写 "v1 §N" / "v2 §N" 并标明版本，**不要**与现役 `§N` 混写——两套退役编号（各自的 §1–§19）与现役编号（§1–§17）没有任何对应关系，映射见本文末「编号沿革」。

---

## 1. 归档范围与时间线

| 版本 | 目录 | 对应代码包 | 作废裁定 | 文件数 | 原位置 |
|---|---|---|---|---|---|
| **v1**（mud-core） | `archive/mud-core/` | `packages/mud-core`（原位退役、代码留存不删） | 2026-09-27 退役 | 16 | `doc/mud-core/` |
| **v2**（mud-core2） | `archive/mud-core2/` | `packages/mud-core2`（原位退役、保留 workspace 位置、不再演进） | 2026-09-28 整体作废 | 12 | `doc/mud-core2/` |

搬移裁定（本次文档重写）：两套从 `doc/` 顶层移入 `doc/archive/`，与现役文档物理隔离；`doc/CHANGELOG.md` 历史行中的旧路径（`doc/mud-core2/`、`doc/plans/` 等）按"只追加、不回改历史行"纪律**保持原样**，迁移映射登记在新条目。

---

## 2. 已提升为现役的文件（本目录内副本只留追溯）

| 归档副本 | 提升去向 | 提升理由 |
|---|---|---|
| `mud-core/flows/login.md`（原 front-matter 自称 `status: active`） | [`doc/flows/login.md`](../flows/login.md) | v1 全集中**唯一被现役代码当设计依据引用**的文档（`packages/mud-core3/src/flows/login.ts:11`、`packages/mud-workflow/test/login.spec.ts:4`）。其两条实测勘误（**failOn 归窗**、「**欢迎来到**」成功句与建连横幅撞车不可用）已被 core3 采纳 |
| `mud-core/appendices/official-and-capture.md` **附录 B（抓包事实）** | [`doc/appendices/A-capture-facts.md`](../appendices/A-capture-facts.md) | MUD 侧实录（提示行原文、GA 与命令 1:1、长程命令无 GA、分页页尾、服务器不回显）仍是现役登录流程与读窗口设计的依据 |
| `mud-core2/appendices/audit-checklist.md` | [`doc/appendices/B-audit-checklist.md`](../appendices/B-audit-checklist.md) | 与具体设计解耦的**可执行审阅规约**（E1–E4 证据分级、C1–C7 检查类、强制"本轮执行情况表"），core3 期可直接复用 |
| `mud-core/appendices/official-and-capture.md` **附录 A（官方机制锚点）** | **不提升** | 文件/行号属 v1 期，随宿主换代已失效；现役宿主锚点见 [`01-02-overview-host.md`](../architecture/01-02-overview-host.md) §2.1 |

---

## 3. v1（mud-core）章节大纲

```
mud-core/ARCHITECTURE.md（§0 入口，51 行）
├─ §0 文档与版本规则（版本号语义；阅读规则 1–6）
├─ 章节地图（§1–§3 / §4–§6 / §7–§8 / §9–§10 / §11 / §12–§13 / §17–§18 / §19 / §14+§16 / §15 / 附录 A·B / PLAN）
└─ 任务索引 + 当前状态 → §17–§18

architecture/00-core.md（§1–§3，130 行）
├─ §1 不变量 I1–I16（I1 用户=会话=运行时、连接是会话无关资源｜I2 agent 生命周期归官方｜I3 T2 是基线、T1 是唯一干预点｜
│     I4 动作即契约、收口恒有界｜I5 单流切分｜I6 一个结算点 ≤ 一条投递｜I7 语义只由行序列决定｜I8 禁模块级可变单例｜
│     I9 丢弃必留痕｜I10 单流程互斥｜I11 流程单步应答唯一性｜I12 直发延后 gate｜I13 收口与分类分离、注册期互斥｜
│     I14 打断按数字档位｜I15 T1 契约检验（T2 可用）｜I16 T1 私有状态不进 T2 可见面）
├─ §2 术语表（文本块/帧/裁决器/行/批次/规则命中/动作请求/投递形态/消费边界/遗留段/单一水位线/状态抓取桶/lane/
│     流程表/步骤/驱动句/收口/分类与复判/形态 C/关闭触发/流程槽/流程驱动器/触发器反射/在途窗口/挂起/唤醒推进/
│     打断/排队/分投器/会话运行时/预设 …… +「已删除的概念」清单 + 数据流一句话）
└─ §3 总体架构（L1 行级感知 / L2 投递节拍 / L3 选路 / L4 流程驱动器与渲染；旁路 B 在途窗口、F 流程运行时、P 权限档位、A 装配面）

architecture/04-06-perception-routing.md（§4–§6，86 行）
├─ §4 L1 行级感知（实例/输入/状态/输出/state 桶/流程行判据/holdDelivery/多行规则约束）
├─ §5 L2 投递节拍（结算点定义、单流切分伪码、投递形态、通道、token 裁剪、单一水位线、守恒不变式）
└─ §6 L3 选路（pre-step、agent/request、prepend、污染防御、门控、selectModel 禁令、两档限速、T2 限流）

architecture/07-08-t1-bridge.md（§7–§8，169 行）
├─ §7 L4 T1（契约、输入输出表、渲染判定序、call-id、配对、契约检验、四条出口表）
└─ §8 行流裁决器与在途窗口（8.0 定位｜8.1 边界标记两类｜8.2 帧生命周期与五站消费链｜8.3 在途窗口纯收口器｜
      8.4 放弃带回内容｜8.5 武装标记四类｜8.6 帧内存阀｜8.7 删除清单 15 项｜8.8 实现映射与切片）

architecture/09-10-agent-permissions.md（§9–§10，150 行）
├─ §9 preset 化（机制事实、设计、迁移风险、已实现落点、preset=整个组装坑、副本机械生成、部署、profile patch 事故、
│     可见性层退化、官方约束）
└─ §10 权限（三档 observe/operate/full、actor 矩阵、零发送通路、双层执法、已实现、两处偏差、凭据来源、暴露面口径、遮蔽、后缀理由）

architecture/11-runtime-config.md（§11，35 行）
└─ 看门狗表 dead-air、login-stall 删除、边界、删除用户=归档、flows 指针、流程实例状态、Config 全集、凭据、agentMode 四态

architecture/12-13-observability-testing.md（§12–§13，44 行）
├─ §12 观测与诊断（日志样例、决策栏、档位读写、agent 事件、/mud/diag 字段与计数）
└─ §13 测试策略 8 条（loop-sim 规矩、现行账目 37 文件 / 402 例）

architecture/17-18-roadmap.md（§17–§18，69 行）
├─ §17 交付切片 W1–W11（当前状态唯一来源）
└─ §18 未决 #4/5/6/7/8/9/21/22/23 ｜ 非目标 ｜ 已定 #1–#20

architecture/19-flow-runtime.md（§19，276 行）
├─ §19.0 定位｜§19.1 声明（语法块、三节点、过渡桥、占位符、校验表、字段消费者）
├─ §19.2 复判推进（派生伪码、类序、兜底、配对移交、推进）
├─ §19.3 步骤推进（时序、callId、内容通道、两拍人工、状态面）
├─ §19.4 打断排队｜§19.5 失败收束
├─ §19.6 账目（19.6.1 账目表、19.6.2 判据 A/B3/C）
└─ §19.7 定案 14 条 + 待定 6 条

appendices/official-and-capture.md（附录 A/B，31 行）→ 附录 B 已提升
flows/login.md（56 行，原 status: active）→ **已提升为现役**
flows/fullme.md（139 行，五步声明 + FlowSpec + 人工环节与取图职责）
history/14-16-absorbed-deleted.md（archived，50 行，§14 历史吸收表 + §16 删除清单）
history/plan-w7-core-refactor.md（archived，221 行，原 PLAN.md 的 W7 重构方案 v2 + 4 条证伪勘误）
PLAN.md（188 行，起草区：待办池 T4–T12 + W11 修复计划 W11.2–W11.5 未实施）
CHANGELOG.md（714 行，§15，86 条版本条目 v0.1→v0.11.3）
```

---

## 4. v2（mud-core2）章节大纲

```
mud-core2/ARCHITECTURE.md（§0 入口，61 行）
├─ §0 文档与版本规则（阅读规则 1–7）
└─ 章节地图 + 任务索引（13 项）+ 当前状态 → §18–§19

architecture/00-core.md（§1–§3，184 行）
├─ §1 不变量 I1–I10（token 第一约束｜T2 闭环先于一切机制｜世界状态唯一真相｜无两执行者/无打断仲裁｜无例证不建机制｜
│     不自建 agent loop｜释放阀门协作式必须自持｜计划是意图快照不是合同｜不注册实现不了的桩工具｜干支护栏）+ 不做清单 10 条
├─ §2 术语表 12 条（行流持有者/静态禁发表/wait 竞速机/危险判据连续谱/占线错误/预算/释放阀门/结算通知 best-effort/
│     计划级检视/程序记忆与陈述记忆/子 agent 历史/续跑）
└─ §3 总体架构（3.1 五层心智模型：存在/反射/意识/思考/记忆 + 成本与纪律列；3.2 决策者拓扑：根 T2 → 宿主原生 subagent → 子 agent → 结算回注，
      计划生命周期、硬约束 5 条、预算与释放；3.3 五层 → 文件与承载映射 + 四条承载约束 + 纯度纪律 + 每层禁令）

architecture/04-06-link-awareness.md（§4–§6，122 行）
├─ §4 存在层：连接与行流（Mud 类骨架、行分发顺序、直发对宿主不可见、持有者会话级、send 帧格式、断线、禁令）
├─ §5 行等待竞速机（read 五步；写死判定序 danger > failOn > until > gaCount > quietMs > timeoutMs > maxLines；signal 释放阀门）
└─ §6 反射与意识（6.1 每行调度 + REFLEX 表两条｜6.2 危险判据：一份数据、字段化动作意图、latch 挂世界状态｜
      6.3 反射与意识的分界｜6.4 越界不唤醒｜6.5 紧急响应三级单向升级）

architecture/07-09-t2-wake.md（§7–§9，96 行）
├─ §7 T2 闭环与三唤醒源（7.1 闭环 7 步链｜7.2 三源：静默到期 / 意识层危险唤醒 / 子 agent 上报 + 两条守卫禁令 + 双唤醒窗口｜
      7.3 唤醒器实现 wake.ts：两源自建 + 结算源由宿主投递）
├─ §8 结算即唤醒（检视是计划级）+ best-effort（四种不唤醒状态、无独立兜底、结算消息非空文本块、固定文本约定）
└─ §9 唤醒上下文与 persona（9.1 上下文组装 context.ts 纯函数：唤醒原因 + 世界摘要 + 教训；计划不建存储；compaction；
      克制原则｜9.2 persona 五层身份、占线教育信号、子级在途禁直调 mud_send、fullme 兜底）

architecture/10-13-subagent-execution.md（§10–§13，113 行）
├─ §10 子 agent：无意图执行者（10.1 五条定义｜10.2 形态与派单｜10.3 权限与边界：静态遮蔽不做动态权限、人工交互只在根｜
      10.4 工具可见面与 listener 作用域（preset 作用域注册一次、注册完整性自检、holder 调用期解析）｜10.5 危险 × 在途子级通道策略（abortWait））
├─ §11 预算与释放（总体预算耗尽即失败上报；到期走 ctx.subagents.interrupt；禁轮询 list_agents；释放阀门协作式必须自持：
      激活槽两处释放 + 上限 8 / ACTIVATION_LIMIT_REACHED；失败也算结算；端到端验收两条）
├─ §12 工具面与静态禁发表（12.1 工具签名 mud_send / mud_flow / mud_state；deferContext 备用线；首次 send 隐式建连+login｜
      12.2 静态遮蔽：根放行、子级禁发表、计划边界不进权限、DELEGATED_CALLER）
└─ §13 凭据与标准流程（13.1 形态：Flow/FlowCtx 无 ask；凭据·不可逆型走代码流程；流程是词汇不是平行执行者｜
      13.2 三个出口 done:true / done:false+question+lines / reason:'danger'｜13.3 结算书写约定｜13.4 需要人时的链路）

architecture/14-16-memory-cost-observation.md（§14–§16，57 行）
├─ §14 记忆三分与学习回路（工作/陈述/程序记忆表 + 注入点 + 期次；学习双产物；三条落地约束；技能沉淀前置四条）
├─ §15 成本账目（五层成本表；上限主张按计划长度加条件；短任务 T2 直跑兜底；三条必须入账的事实）
└─ §16 观测与计数口径（16.1 行流语料 corpus.ts：JSONL 全量落盘、不进 Session；交换级事件四类只落自有 JSONL｜
      16.2 计数写死两个量：决策点 = step/start、实际调用 = assistant/message ∪ assistant/attempt、重试漂移 = 差值；禁用 request/header）

architecture/17-19-acceptance-roadmap.md（§17–§19，101 行）
├─ §17 验收账目（计数口径；八行断言表；fullme 场景单列 5 条断言；成本主张按计划长度加条件）
├─ §18 实施顺序（第一期干 + 开工前三项；八步表；第二期支七支 + I10 护栏）
└─ §19 待实测 / 待定（MUD 侧 7 项表；宿主与拓扑 6 项表）

appendices/audit-checklist.md（118 行，§0–§5、C1–C7）→ **已提升为现役**
flows/fullme.md（21 行，子调 mud_flow → 收图 → done:false+question → 上浮 → 根问人 → 带答案重入）
PLAN.md（220 行，V4 多用户草案：需求 6 条、已核实事实 17 条、D1–D14 裁定、机制与契约 3.1–3.10、源码变更 14 行、V4.1–V4.6 切片、待核实 ①–⑪）
DISCUSS.md（259 行，P1 预案档 0ms 战斗响应草案 D1–D9 + 三层释放 + V1–V8 验收；P2 装配层接线旧稿（superseded））
CHANGELOG.md（8 行，空表——基线完成前从未登记）
```

---

## 5. v1 参考价值资产（现役 core3 无对应物，按例证再评估）

> 取材入口：现役 [`PLAN.md`](../PLAN.md) 第五期「其他：core2 归档中未迁移但有参考价值的设计，按例证逐条评估」。

| # | 资产 | 坐标（v1） |
|---|---|---|
| 1 | 不变量 I1–I16 及"真实症状"（每条不变量都附历史故障） | `architecture/00-core.md` §1 |
| 2 | 术语表 + 「已删除的概念」清单（防概念回潮） | `architecture/00-core.md` §2 |
| 3 | 五站消费链 / 帧生命周期 / 帧内存阀 | `architecture/07-08-t1-bridge.md` §8.2、§8.6 |
| 4 | 在途窗口**纯收口器**三收口 + 放弃带回内容 | `architecture/07-08-t1-bridge.md` §8.3、§8.4 |
| 5 | 武装标记四类 + `register` 唯一入口 | `architecture/07-08-t1-bridge.md` §8.5、§8.8 |
| 6 | 单一水位线 + 行流守恒不变式 | `architecture/04-06-perception-routing.md` §5 |
| 7 | 形态 C + B3（收口触发从判据派生 ⇒ 二者不可能分歧） | `architecture/19-flow-runtime.md` §19.2、§19.6.2 |
| 8 | 流程表声明面 + **注册期 fail-loud 校验 12 条** | `architecture/19-flow-runtime.md` §19.1 |
| 9 | 复判固定类序 `retry → fail → 分支 → ok` + 迟到行 = 没到 | `architecture/19-flow-runtime.md` §19.2 |
| 10 | 两拍发布 + 人工环节（`CAPTCHA_WAIT_MS=175_000`、fail-closed 三出口）—— 即现役后置的验证码链路 | `architecture/19-flow-runtime.md` §19.3；`flows/fullme.md` |
| 11 | 打断纯数字档位与排队（`login=1000` / `fullme=100` / `normal=100`；按 replyId 清队列残余） | `architecture/19-flow-runtime.md` §19.4；I14 |
| 12 | 声明式看门狗表 dead-air（含"无活跃流程"与"哪些计时器不入表"的边界） | `architecture/11-runtime-config.md` §11 |
| 13 | 权限三档 + actor 矩阵 + 双层执法 + agent 永不自提权 | `architecture/09-10-agent-permissions.md` §10 |
| 14 | preset 装配踩坑清单（整份组装、机械生成 + 逐行比对、profile patch 热应用事故、就绪门） | `architecture/09-10-agent-permissions.md` §9 |
| 15 | 观测与诊断全集（日志样例 / 决策栏 / diag 字段） | `architecture/12-13-observability-testing.md` §12 |
| 16 | 官方 loop 模拟器与"账目必须在此量"纪律 + 三接线对照表 | `architecture/12-13-observability-testing.md` §13；`architecture/19-flow-runtime.md` §19.6.1 |
| 17 | 测试策略矩阵（rule-coverage 表驱动、预筛契约不变式、逐 spec 例数） | `architecture/12-13-observability-testing.md` §13 |
| 18 | 凭据引用化与暴露面口径（`passRef` / `resolve` / `mintPassRef` 后缀理由 / 只读(env) 徽标） | `architecture/09-10-agent-permissions.md` §10；`architecture/11-runtime-config.md` §11 |
| 19 | 选路防御（`prepend` 必要性、会话模型污染与 realModel 还原、`selectModel` 禁令） | `architecture/04-06-perception-routing.md` §6 |
| 20 | 两档限速与"按通道豁免而非登录态" | `architecture/04-06-perception-routing.md` §6 |
| 21 | 空命令合法 + MXP 跳过 + 终态 GA 收尾（**已被 core3 login 实体继承**） | `flows/login.md` |
| 22 | 抓包事实（GA 与命令 1:1、`dz` 56 批 ~57s 无 GA、分页页尾、服务器不回显）→ **已提升** | `appendices/official-and-capture.md` 附录 B |
| 23 | 删除清单与理由（防回潮索引） | `history/14-16-absorbed-deleted.md` §16；`architecture/07-08-t1-bridge.md` §8.7 |
| 24 | 起草区纪律 + 裁决点模式（六章模板、`W*` 编号、D3 先裁决后落笔、A1–A8 裁决表） | `PLAN.md` |
| 25 | 官方机制锚点表（**注意**：行号已随宿主换代失效，只作检索线索） | `appendices/official-and-capture.md` 附录 A |
| 26 | 待办池 T4–T12 未立项方向（并行分支、验证码链路在 core3 以不同形态处理） | `PLAN.md` |

---

## 6. v2 参考价值资产（现役 core3 无对应物，按例证再评估）

| # | 资产 | 坐标（v2） |
|---|---|---|
| 1 | **五层心智模型**（存在 / 反射 / 意识 / 思考 / 记忆 + 成本与纪律列 + 每层禁令） | `architecture/00-core.md` §3.1、§3.3 |
| 2 | 不变量 I1–I10 + 不做清单（**token 第一约束**、T2 闭环先于一切机制、无例证不建机制、不注册桩工具） | `architecture/00-core.md` §1 |
| 3 | **T2 闭环与三唤醒源**（静默到期 + 危险唤醒 + 子 agent 上报；两条守卫禁令；双唤醒窗口容忍） | `architecture/07-09-t2-wake.md` §7.1–§7.3 |
| 4 | 结算即唤醒 + best-effort 承认（四种不唤醒状态的完整清单、无独立兜底、固定文本约定） | `architecture/07-09-t2-wake.md` §8 |
| 5 | 唤醒上下文组装纪律（不搬历史、唤醒原因是事实不是指令、新增字段必须写理由防孤儿字段、compaction 冲突分析） | `architecture/07-09-t2-wake.md` §9.1 |
| 6 | 子 agent「无意图执行者」五条定义（无意图 ≠ 少思考；有执行智能必须完整保留） | `architecture/10-13-subagent-execution.md` §10.1–§10.2 |
| 7 | **预算与释放阀门**（协作式、必须自持；激活槽两处释放；`ACTIVATION_LIMIT_REACHED` 缺省上限 8；终结条件 `whenIdle && inbox 无 pending && ownedChildren=0`） | `architecture/10-13-subagent-execution.md` §11 |
| 8 | 危险判据字段化动作意图 + latch 挂世界状态（一份数据同时服务 interrupt / wake / abortWait） | `architecture/04-06-link-awareness.md` §6.2、§6.5 |
| 9 | **P1 预案档 / 0ms 战斗响应**（判据换"时间轴"；起手同步直发 + 持有者管理循环；三层释放；超时语义=重新评估；战斗原文不进 T2；V1–V8 验收） | `DISCUSS.md` P1 §1–§6 |
| 10 | 静态禁发表与"不做动态权限"纪律（只放天然不可逆且任何计划都不需要的命令；新例证才加一行） | `architecture/10-13-subagent-execution.md` §10.3、§12.2 |
| 11 | 人工交互唯一性 + 问题上浮 / 续跑（子级 ask 被 `DELEGATED_CALLER` 拒死；问题装进结果上浮；根问人后带答案重入） | `architecture/10-13-subagent-execution.md` §13.4；`flows/fullme.md` |
| 12 | 上浮自持截止（`askTimeoutMs`）与 `tools/execute` waterfall 包装（宿主对未声明 `timeoutMs` 的工具直接 `next()`） | `PLAN.md` 3.5 + D7；§6 待核实 ① |
| 13 | 记忆三分与学习回路（工作/陈述/程序；教训→T2 上下文 vs 技能→子级任务描述；技能沉淀前置四条） | `architecture/14-16-memory-cost-observation.md` §14 |
| 14 | 成本账目与"上限主张按计划长度加条件"（长计划净省、短计划未必；验收必须量 root 上下文规模/峰值 token） | `architecture/14-16-memory-cost-observation.md` §15 |
| 15 | **计数口径（两个量，写死）**（决策点 = `step/start`；实际调用 = `assistant/message ∪ assistant/attempt`；重试漂移 = 差值；**禁用 `request/header`**） | `architecture/14-16-memory-cost-observation.md` §16.2 |
| 16 | **审计规约**（E1–E4 证据分级、C1–C7 检查类、强制输出格式、历史教训 6 条）→ **已提升** | `appendices/audit-checklist.md` |
| 17 | 多用户 / roster / 管理面蓝图 V4（D1–D14；未采纳项：工作区=服务器 1:1 的 roster 键、`roles` 单源、`reconnect` 自持重连、presence 待答提示） | `PLAN.md` 第 2、3、5、6 章 |
| 18 | 未采纳的架构口径（单根守卫、持有者判定 `depthByHeader > 0`、持有者不做队列） | `architecture/00-core.md` §3.2–§3.3；`architecture/17-19-acceptance-roadmap.md` §19 |
| 19 | 承载约束：直发输出的累积文本归属（缺省照常进在途累积文本，实录误命中再切隔离） | `architecture/00-core.md` §3.3 |
| 20 | 三段谱系追溯指针（v1 → v2 → v3 的归档入口与"不作依据"措辞范式） | `mud-core2/ARCHITECTURE.md` §0、章节地图 |

---

## 7. 编号沿革（旧 → 现役）

两套退役编号**均不复用**为现役编号。现役 §1–§17 与旧编号的映射见 [`doc/ARCHITECTURE.md`](../ARCHITECTURE.md) §0.6；这里只强调三条：

1. 现役编号自 2026-10 重排后重新分配，**旧 core3 §1–§5 已全部退役**，不得再出现在新写内容或新注释里；
2. 引用退役集一律 "v1 §N" / "v2 §N"；
3. 代码注释引用设计一律写现役 `§N`，不写裸文件名。

> AI生成
