---
sections: [12, 13]
status: active
deps: ["§1", "§4", "§19"]
---

## §12 观测与诊断

| 通道 | 内容 |
|---|---|
| 会话日志 tab | `[路由] step 认领 …` / `[路由] 请求 … next=… → 拦截为 T1\|不介入\|还原真实模型 (…)\|` / `[路由] 会话模型被上次 T1 拦截污染 … → 本回合还原为 …` / `[路由] lane=t1 动作投递 (rule=…, action=…)` / `[流程] <flowId> 激活 (入口: …)` / `[流程] <flowId>/<step> 挂起 (next: …, timeout …)` / `[流程] 命中 <step> 驱动句 → 唤醒 <step> = 成功 (分支 …)` \| `超时` \| `连接断开` / `[流程] <flowId> 被 <rule> 打断 (interrupts=N > priority=M)：结算挂起 / 复位 / onInterrupt / 投递事件动作` / `[流程] 无打断权 → 排队 (pending action N)` / `[流程] 打断已结算在途窗口 N 个` / `[流程] 排队动作出队投递 N 条` / `[感知] 原文投递 N 行 + M 动作 (lane=…, agent 状态, 队列 N)` / `[感知] 动作投递 N 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)` / `[感知] 批次投递 N 行` / `[感知] 投递改为 defer (工具在途 N): 随本结果进下一步` / `[t1] 渲染 …` / `[看门狗] <id> 布防 Nms` \| `停表 (原因)` / `[在途] <窗口结算留痕: 超时放弃/断线/中止>` / `[在途] 发送失败: …` / `[在途] 发送后 Nms 未确认武装, 视为发送失败: …` / `[缺陷] 直接执行动作没有工具调用: …` \| `[缺陷] 直接执行动作引用了未知工具 … (…)` / `[权限] <工具> → 拒绝\|待批准 (档位 …): 理由` / `[权限] 档位 A → B` / `[规则] <规则 id> → 直接执行 <工具> <args>` / `[流程] <flowId> 进入步骤 <step>` / `[流程] <flowId>/<step> = 成功（…）` / `[流程] <flowId>/<step> 重试 N/attempts` / `[流程] <flowId>/<step> 等人工输入 ({captcha}; 预算 180000ms)` / `[流程] <flowId>/<step> 重试 N/attempts` / `[流程] <flowId>/<step> 槽 {captchaUrl} = …` / `[流程] <flowId>/<step> 工具结果 ok\|error → 判定` / `[验证码] 检测到 … 等人工输入 (缺 {captcha}; 看门狗暂停, 投递暂停; 计时用本步预算)` / `[验证码] 流程已结束 → 退出人工环节` / `[验证码] 已解析并推送图片: …` / `[流程] <flowId> 完成（终态）` / `[流程] <flowId>/<step> 失败：… → 复位（只留入口）` / `[验证码] 检测到验证码地址, 等人工输入 …` / `[验证码] 人工已提交 …` / `[装配] 官方 preset 已装配 (mud-player)` / `[发送] …` |
| 决策栏 | `feed-classify`（lane 决策）、`holdDelivery` 暂缓/释放、权限 deny/ask、agent 工具调用、**流程迁移**（激活/挂起/唤醒/打断/排队/失败收束）、`direct-exec`（直接执行） |
| 档位读写 | `GET /mud/capability?sessionId=…`（当前档 + 选项 + 外围能力）、`POST /mud/capability {sessionId,tier}`；`GET /mud/status` 每行带 `tier` |
| agent 侧 | `agent/error`（回合错误）、`agent/inbox/discarded`（待处理投递被取消丢弃） |
| `/mud/diag` | 每会话：`connectionId`、`connected`、观察窗/回看缓冲规模/`awaitingHuman`（人工环节）、`agent` 是否 live、`lastError`、**`flow`（v0.4.0：`{flowId, stepId, armed[], phase: awaiting-result \| awaiting-human \| awaiting-branch, deadline, slots}`）**、`pendingActions`/`pendingEntry` 条数；**计数**：遗留段丢弃行数、holdDelivery 释放次数、流程失败/超时次数、**在途窗口结算结局计数**（ok/fail/timeout/error/interrupted/abort，§8.3/I4） |

<!-- 待补：diag 字段的精确 schema 与阈值告警口径 -->

---

## §13 测试策略

> **例数基线**（v0.9.1 实测）：**345 总例**。红绿以当次 vitest 汇总为准，本文不硬编码逐文件例数；当前未清红名单见 §17 W7 行（W7.2/W7.3 功能 bug 待 triage）。

1. **不变量用例**：投递消息体按序拼接 == 完整入站流（I5）。
2. **表驱动"命中必被适配"**（I4）：`tests/rule-coverage.spec.ts` —— 每条规则一条 canonical 样本（样本表必须覆盖规则表，新增规则不补样本即红），走 `PerceptionEngine.feed → TriggerLlmAdapter` 真实链路，断言 state 规则进 `stateHits`、event 规则进 `hits` 且渲染出的 tool-call 名字/参数与规则声明逐字一致。
3. **单元**：感知引擎（跨文本块多行状态、holdDelivery、消费边界）、**裁决器行流缓冲**（边界标记/武装标记/内存阀/装配阀，`tests/frame-splitter.spec.ts`，v0.6.0；v0.9 W7.1 分帧器并入裁决器，spec 文件名不变、导入改指 `adjudicator.ts` 导出；v0.9 W7.3 注册收口后 `register(registration)` 由 session 构造/重挂路径覆盖，无独立 spec）、**在途窗口表**（注册/结算/N-GA 关窗/超时放弃/abort/断线/直发延后集成，`tests/response.spec.ts`；v0.9 W7.2 重写为 `InflightWindowTable` 单元测试，取代旧桥 `CommandResponseController`；结算优先级 判据命中 > N-GA > 超时 > 断线、连续 3 次放弃 → reject、发送守卫 error）、权限（三档 × 动作矩阵，含 T1 动作被 deny）、**选路回归**（`tests/lane-routing.spec.ts`，v0.9 W7.3 新增，10 例表驱动 `resolveLaneConfig`：t1→mud-t1 剥 effort + realModel 记忆还原 spread 只覆写 provider/model/effort 保留 temperature/maxTokens/stop）。
4. **runtime 级脚手架（已起步）**：`tests/runtime-delivery.spec.ts`（交付水位 / 帧内容只进本帧 / **T2 投递限流**，4 例）+ `tests/watchdogs.spec.ts`（看门狗**规则**表驱动：启动/停止/活动重置/一次或续期/guard/计数/dispose，11 例）+ `tests/runtime-watchdog.spec.ts`（"世界变化 → 看门狗布防"、未登录不布防断流、未连接不唤醒、登录完成清登录看门狗、**活跃流程期间不布防·收束后才布防**，5 例）+ `tests/runtime-captcha.spec.ts`（fullme：提醒行 → **直发** `fullme` / 应答帧内地址 → 人工 → `halt` + `fullme <码>` 全链路 / 帧内命中独立投递 / 人工环节停表，8 例）+ `tests/flow-login.spec.ts`（**v0.4.0 流程机端到端**：声明期校验 + 四步图 + 名字→密码→成功句→空命令 + 可选 replace 分支 + 失败收束 + GA 归属 + 分支超时，9 例）+ `tests/flow-interrupt.spec.ts`（打断/排队：档位够→打断、档位不够→排队、超时出队、半截序列不发、login 不可打断，7 例）+ `tests/flow-ownership.spec.ts`（**结算归属 = 配对移交（W7.2）**：`windowSpecFor` 只对本步命令返回覆盖 / 别命令返回 null / GA 关窗推进且同窗不二次结算 / stepId 不匹配忽略，8 例）+ `tests/t1-adapter.spec.ts`（T1 契约：动作渲染 / 确定性 call-id / 已执行不重渲 / 选路异常，8 例）+ `tests/mud-persona.spec.ts`（人设槽按作用域替换）+ `tests/runtime-direct-action.spec.ts`（直接执行：入队、折叠、人工环节不执行、危险命令硬边界）+ `tests/commands.spec.ts`（命令索引 / 按需展开） —— 可注入的 sink / 假连接管理器 / `vi.useFakeTimers()` 驱动真实 `MudSessionRuntime`。仍待补：投递切分（T1/T2 各一条消息）、离线拒绝、holdDelivery 释放。
5. **官方 loop 模拟器（回合/步骤的唯一可信证据；`tests/loop-sim.ts` + `tests/loop-sim-login.spec.ts`）**：按 DSH 源码逐条复刻 loop 转移（`while (await turn())` 驱动器、`claim(next-step 全取 / next-turn 一条)`、回合首步空认领即收束、结果 `additionalContexts` → `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break、插件 lane 记忆），每条规则在文件里给出出处；驱动器与测试线程**交错**（工具调用阻塞在等游戏应答，测试用 `until(pred)` 推进假计时器）。
   - **规矩**：凡是关于"回合数 / 步骤数 / 模型请求次数 / 是否落到 T2"的结论，**必须在这个模拟器上量**；旧的"`followup` → 数组"替身看不到边界，不能作为证据。
   - 已量：login 现状 = 3 回合 / 6 次请求（每步一次空续步）；提议 A/B = 1 回合 / 4 次、1 回合 / 3 次（§19.6.1）。
   - 模拟器同时是**提议方案的建模台**：`SimDeliveryMode = 'followup' | 'defer' | 'defer-conclude'`（后两者只在测试内把运行时投递挂成工具结果的 `additionalContexts`/`concludesTurn`，不代表已实现）。
6. **端到端**（真连 pkuxkx）：登录序列（名字 → 密码 → 完成）、长程命令（`dazuo`）、分页各一条。
7. **v0.4.0 新增（计划）**：
   - **流程机单测**（`tests/flow-*.spec.ts`）：arming 推导（进入某步 = 本步 driver(重试) + 本步 ok/fail + 条件分支 driver）、**GA 判据**（`ok:[GA]` 即成功 / `fail:[GA]` 即失败 / 两边同写 → 注册期报错）、**注册期校验表**（ok-fail 互斥、next 引用存在、id 唯一、awaitExternal 占位符存在）、条件分支 vs 顺序兜底（MXP 不出现不阻塞）、同类内多命中按声明顺序取首、`when` 入口前置、`retry` 重发本步、超时 → 失败收束、打断（数字档位比较、`onInterrupt`、事件动作投递）、无打断权 → 排队、`pending entry` 接续、**单流程互斥**（第二流程入口不 arm）、**在途窗口结算**（本步命令进窗口，`noteToolResult` 按 stepId 配对移交；v0.9 W7.2 取代旧"挂起期闸门"）。
   - **T1 契约测试**：动作消息 → tool-call 逐字一致；无动作 → `stop`；同一动作重复调用**不重复渲染**（确定性 call-id + 已有 tool-result 判据）；**契约检验（I15）**：同一投递消息在"不知道任何 T1 私有字段"的前提下也能被解释（T2 可用性用例）。
   - **端到端**：login 全链（正常 / 用户名不存在 → 注册分支 / 密码错 → 失败收束 / 服务器断开 → 失败收束）、fullme 全链（提醒 → 地址 → 人工 → 成功；被人等打断）。
   - **投递通道（已落地）**：`runtime-defer.spec.ts`（4 例：工具在途 ⇒ defer 槽 / 无在途 ⇒ `followup` / 判据 B 四情形 / 流程活跃时不收束）+ `loop-sim-login.spec.ts`（真行为账目 1 回合 / 3 步 / 3 次请求）。**模拟器现在仿真官方包装器**：`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `deferContext` → `result.ok && shouldConcludeTurn(callId)` → `concludeTurn`。

---
