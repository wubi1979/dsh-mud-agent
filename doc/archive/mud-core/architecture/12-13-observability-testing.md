---
sections: [12, 13]
status: active
deps: ["§1", "§4", "§19"]
---

## §12 观测与诊断

| 通道 | 内容 |
|---|---|
| 会话日志 tab | `[路由] step 认领 …` / `[路由] 请求 … next=… → 拦截为 T1\|不介入\|还原真实模型 (…)\|` / `[路由] 会话模型被上次 T1 拦截污染 … → 本回合还原为 …` / `[路由] lane=t1 动作投递 (rule=…, action=…)` / `[流程] <flowId> 激活 (入口 <step>: …)` / `[流程] <flowId> 进入步骤 <step>` / `[流程] 命中后继 <step> 的进入判据 → 唤醒 <from> = 成功 (分支 …; 行: …)` / `[流程] <flowId>/<step> = 成功（…）` / `[流程] <flowId>/<step> 重试 N/attempts (…)` / `[流程] <flowId>/<step> 等人工输入 ({captcha}; 预算 180000ms)` / `[流程] <flowId>/<step> 槽 {captchaUrl} = …` / `[流程] <flowId>/<step> 人工已提交 → 挂起等结果` / `[流程] <flowId>/<step> 随回合结束失效（回合边界 = 流程边界）` / `[流程] <flowId> 被 <rule> 打断 (interrupts=N > priority=M)：结算挂起 / 复位 / onInterrupt / 投递事件动作` / `[流程] 无打断权 → 排队 (pending action N)` / `[流程] 打断已结算在途窗口 N 个` / `[流程] 排队动作出队投递 N 条` / `[流程] 流程期间出现 <flowId> 入口 → 排队 (pending entry N)` / `[感知] 原文投递 N 行 + M 动作 (lane=…, agent 状态, 队列 N)` / `[感知] 动作投递 N 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)` / `[感知] 批次投递 N 行` / `[感知] 投递改为 defer (工具在途 N): 随本结果进下一步` / `[t1] 按流程槽渲染下一步 (…)` / `[t1] 本步无动作可渲染 (…) → 收束` / `[在途] <窗口结算留痕: 到期放弃/断线/中止/打断>` / `[在途] 发送失败: …` / `[在途] 发送后 Nms 未确认武装, 视为发送失败: …` / `[缺陷] 直接执行动作没有工具调用: …` \| `[缺陷] 直接执行动作引用了未知工具 … (…)` / `[权限] <工具> → 拒绝\|待批准 (档位 …): 理由` / `[权限] 档位 A → B` / `[规则] <规则 id> → 直接执行 <工具> <args>` / `[验证码] 检测到验证码地址, 等人工输入 …` / `[验证码] 人工已提交 …` / `[验证码] 流程已结束 → 退出人工环节` / `[流程] <flowId> 完成（终态）` / `[流程] <flowId>/<step> 失败：… → 复位（只留入口）` / `[装配] 官方 preset 已装配 (mud-player)` / `[发送] …` |
| 决策栏 | `feed-classify`（lane 决策）、`holdDelivery` 暂缓/释放、权限 deny/ask、agent 工具调用、**流程迁移**（`flow-start` / `step-success` / `step-retry` / `flow-success` / `flow-failure` / `flow-interrupted` / `flow-expired`（随回合失效））、`direct-exec`（直接执行） |
| 档位读写 | `GET /mud/capability?sessionId=…`（当前档 + 选项 + 外围能力）、`POST /mud/capability {sessionId,tier}`；`GET /mud/status` 每行带 `tier` |
| agent 侧 | `agent/error`（回合错误）、`agent/inbox/discarded`（待处理投递被取消丢弃） |
| `/mud/diag` | 每会话：`connectionId`、`connected`、观察窗/回看缓冲（诊断通路，2000 行上限）规模/`awaitingHuman`（人工环节）、`agent` 是否 live、`lastError`（**成功路径清除**：连接建立/凭据解析成功/会话注销，W11.1②）、**`flow`**（`FlowState`：`{flowId, stepId, armed[], phase: awaiting-result \| awaiting-human \| awaiting-branch, deadline, pendingActions, pendingEntry, retries, slots}` —— 形态 C 下 `armed` 只剩入口 arm 与分支等待期布防）、`pendingActions`/`pendingEntry` 条数；**计数**：遗留段丢弃行数、holdDelivery 释放次数、流程失败/超时次数、**在途窗口结算结局计数**（ok/fail/timeout/error/interrupted/abort，§8.3/I4） |

<!-- 待补：diag 字段的精确 schema 与阈值告警口径 -->

---

## §13 测试策略

> **例数基线**（2026-09-23 实测，W11.1 落地后）：**37 文件 / 402 例全绿**（`pnpm exec vitest run --pool=threads tests`；沙箱内默认 forks 池起不来，用 `--pool=threads`）；`tsc --noEmit` 清零。红绿以当次汇总为准，本文只登记当次实测数；历史基线见 §17 各切片行。

1. **不变量用例（I5，v0.11.0 换形）**：`① 命中行 + ② 流程 span + ③ T2 批次 + ④ 仍带原文的投递 == 完整入站行流`（替代旧"按序拼接投递消息体"口径；折叠类目已移除，行流无隐藏行）。`tests/runtime-delivery.spec.ts` 末节两面各一例（T2 窗口面 + 流程窗口面，含失败收束后行进后续消费批）。
2. **表驱动"命中必被适配"**（I4）：`tests/rule-coverage.spec.ts` —— 每条规则一条 canonical 样本（样本表必须覆盖规则表，新增规则不补样本即红），走 `PerceptionEngine.feed → TriggerLlmAdapter` 真实链路，断言 state 规则进 `stateHits`、event 规则进 `hits` 且渲染出的 tool-call 名字/参数与规则声明逐字一致。
3. **单元**：感知引擎（跨文本块多行状态、holdDelivery、消费边界）、**预筛契约**（`tests/matcher-prefilter.spec.ts`，v0.11.2 新增，19 例：不变式 `pattern.test(line) ⟹ 该规则必须命中` —— 多 pattern OR 分支、`i` 标志、码点/字符转义、量词与顶层选择；含内置规则表 × 实录语料的逐对校验。预筛推错的失效形态是**静默丢命中**，故按不变式测而非按实现测）、**流式 ANSI/分行器**（`tests/ansi.spec.ts`，36 例；v0.11.2 补跨块终止符 7 例：`\r` 与 `\n` 分落两块、`flushLine` 刷出后补发行尾、真空白行不被吞）、**裁决器行流缓冲**（边界标记/武装标记/内存阀/装配阀，`tests/frame-splitter.spec.ts`，v0.6.0；v0.9 W7.1 分帧器并入裁决器，spec 文件名不变、导入改指 `adjudicator.ts` 导出；v0.9 W7.3 注册收口后 `register(registration)` 由 session 构造/重挂路径覆盖，无独立 spec）、**在途窗口表**（注册/结算/关闭触发关窗/**声明才计 GA**/兜底到期带回内容/abort/断线/直发延后集成，`tests/response.spec.ts`，16 例；v0.9 W7.2 重写为 `InflightWindowTable` 单元测试取代旧桥 `CommandResponseController`，v0.11.0 收窄为**纯收口器**；结算优先级 打断 > 关闭触发/GA > 兜底到期 > 断线、连续 3 次放弃 → reject、发送守卫 error）、权限（三档 × 动作矩阵，含 T1 动作被 deny）、**选路回归**（`tests/lane-routing.spec.ts`，v0.9 W7.3 新增，10 例表驱动 `resolveLaneConfig`：t1→mud-t1 剥 effort + realModel 记忆还原 spread 只覆写 provider/model/effort 保留 temperature/maxTokens/stop）。
4. **runtime 级脚手架**（当次实测例数）：`tests/runtime-delivery.spec.ts`（**行流守恒**：命中行/span/T2 批次/带原文投递四面 + **T2 投递限流**，8 例）+ `tests/watchdogs.spec.ts`（看门狗**规则**表驱动：启动/停止/活动重置/一次或续期/guard/计数/dispose，11 例）+ `tests/runtime-watchdog.spec.ts`（"世界变化 → 看门狗布防"、未登录不布防断流、未连接不唤醒、登录完成清登录看门狗、**活跃流程期间不布防·收束后才布防**，5 例）+ `tests/runtime-captcha.spec.ts`（fullme：提醒行 → 取图 → 人工 → `halt` + `fullme <码>` 全链路，8 例）+ `tests/flow-login.spec.ts`（流程机端到端：声明期校验 + 四步图 + 名字→密码→成功句→空命令 + 可选 replace 分支 + 失败收束 + 分支超时 + **判据行只在窗口内被判**，11 例）+ `tests/flow-fullme.spec.ts`（声明面/校验/入口翻转/stale 三连 GA/answer 重试，12 例）+ `tests/flow-interrupt.spec.ts`（打断/排队：档位够→打断、档位不够→排队、静止点出队、半截序列不发、login 不可打断，8 例）+ `tests/flow-ownership.spec.ts`（**结算归属 = 配对移交**：`windowSpecFor` 只对本步命令返回覆盖 / 别命令返回 null / GA 关窗推进且同窗不二次结算 / stepId 不匹配忽略，8 例）+ `tests/flow-slot.spec.ts`（槽发布、收口三件与 `windowSpecFor` 同源、`callId ↔ 步骤` 配对，5 例）+ `tests/flow-judge-order.spec.ts`（**A2 同帧定序**：fail 赢分支与 ok / 分支赢 ok，2 例）+ `tests/t1-adapter.spec.ts`（T1 契约：动作渲染 / 确定性 call-id / 已执行不重渲 / 选路异常，10 例）+ `tests/t1-slot.spec.ts`（**按槽渲染**：投递优先 / 按槽渲染并登记 callId / 已渲染不重复 / 等分支与未接线收束，4 例）+ `tests/runtime-defer.spec.ts`（判据 A：工具在途 ⇒ defer 槽 / 无在途 ⇒ `followup` / B3 终态判定，6 例）+ `tests/mud-persona.spec.ts`（人设槽按作用域替换，2 例）+ `tests/runtime-direct-action.spec.ts`（直接执行：入队、**不消费行**、人工环节不执行、危险命令硬边界，5 例）+ `tests/commands.spec.ts`（命令索引 / 按需展开，7 例）—— 可注入的 sink / 假连接管理器 / `vi.useFakeTimers()` 驱动真实 `MudSessionRuntime`。
5. **官方 loop 模拟器（回合/步骤的唯一可信证据；`tests/loop-sim.ts` + `tests/loop-sim-login.spec.ts`）**：按 DSH 源码逐条复刻 loop 转移（`while (await turn())` 驱动器、`claim(next-step 全取 / next-turn 一条)`、回合首步空认领即收束、结果 `additionalContexts` → `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break、插件 lane 记忆），每条规则在文件里给出出处；驱动器与测试线程**交错**（工具调用阻塞在等游戏应答，测试用 `until(pred)` 推进假计时器）。
   - **规矩**：凡是关于"回合数 / 步骤数 / 模型请求次数 / 是否落到 T2"的结论，**必须在这个模拟器上量**；旧的"`followup` → 数组"替身看不到边界，不能作为证据。
   - **已量（v0.11.0 现行）**：**1 回合 / 3 步 / 3 次模型请求 / `idleSteps=0` / `t2Calls=0` / `deferred=0` / `concludedTurns=1`**；历史 `followup` 基线 = 3 回合 / 6 步 / 6 次请求 / 3 空续步；打断改 followup 的代价 = 2 回合 / 4 步 / 4 请求（§19.6.1）。`tests/loop-sim-login.spec.ts`（3 例）。
   - 模拟器同时是**提议方案的建模台**：`SimDeliveryMode = 'followup' | 'defer' | 'defer-conclude'`；且**仿真官方包装器**（`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `deferContext` → `result.ok && noteToolResult(callId) === true` → `concludeTurn`），运行时那侧是生产代码。
6. **端到端**（真连 pkuxkx）：登录序列（名字 → 密码 → 完成）、长程命令（`dazuo`）、分页各一条。
7. **流程机测试（v0.4.0 起，v0.11.0 换形）**：
   - **声明面与校验**（`tests/flow-*.spec.ts`）：`settle`/`classify`/`captures` 三层分离、装配期校验表（ok-fail 互斥、driver 不与 ok 重叠、next 引用存在、id 唯一、`awaitExternal` 占位符存在、`retry` 合法、GA 只能声明在一侧）、`when` 入口前置与入口翻转、`onSettle` 缺省 `'ok'`；**已知缺口**：漏写 `settle` 静默通过（§18 未决 #22）。
   - **推进与定序**：复判类序（retry → fail → 分支 → ok）与同帧多命中取首（`flow-judge-order`）、条件分支 vs 顺序兜底（两个执行点）与"不出现不阻塞"、`succeedStep` 只是里程碑、终态收束、失败/超时收束、`retry` 原步内重发且不重置预算、两拍（拍 1 前置动作 → 拍 2 本步动作）、人工环节（挂起、行不判、`resumeHuman` 发布拍 2）、`capture` 抽取与重试不重抽。
   - **归属**：本步命令进窗口、`windowSpecFor` 只对本步返回覆盖、`noteToolResult` 按 stepId 认领（槽配对优先）、槽不匹配／迟到结果不作本步判据（`flow-ownership`）。
   - **打断与排队**：数字档位比较、`onInterrupt` 直发（`priority:'halt'`）、在途窗口结算为 `interrupted`、半截序列不发、无打断权 → 排队、静止点 followup 新回合、`pending entry` 接续、单流程互斥。
   - **T1 契约测试**：动作消息 → tool-call 逐字一致；按槽渲染下一步并登记 `pendingCallId`；同一动作重复调用**不重复渲染**；无动作且槽不可渲染 → `stop`；**契约检验（I15/I16）**：同一投递消息在"不知道任何 T1 私有字段"的前提下也能被解释。
   - **端到端（真连 pkuxkx 的清单）**：login 全链（正常 / 用户名不存在 / 密码错 / 服务器断开）、fullme 全链（提醒 → 地址 → 人工 → 成功 / 被打断）、长程命令（`dazuo`）、分页各一条。
   - **投递通道与收束**：`runtime-defer.spec.ts`（6 例：工具在途 ⇒ defer 槽 / 无在途 ⇒ `followup` / **B3 终态判定**）+ `loop-sim-login.spec.ts`（3 例：真行为账目 1 回合 / 3 步 / 3 次请求 + 打断账目）。
8. **未清红/待补**：投递切分（T1/T2 各一条消息）、离线拒绝、holdDelivery 释放、`pendingEntry` 端到端（§18 未决 #5）、R4（流程失败 → `notify='t2'` → T2 接手，§18 未决 #23）。

---
