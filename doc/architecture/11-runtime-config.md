---
sections: [11]
status: active
deps: ["§1", "§19"]
related: ["doc/flows/login.md", "doc/flows/fullme.md"]
impl: packages/mud-core/src/runtime/session/session.ts
note: §11 的流程声明部分（login / fullme 流程表）在 doc/flows/ 下，本文件只保留运行时面
---

## §11 连接 / 会话 / 配置面

- **会话 ↔ 连接解耦**（I1）：`MudConnectionManager` 只认 host/port；`runtime.connectionId` 是唯一绑定方向。
- **投递前提**：会话无 live agent → 行留在观察窗 park，等官方 `agent/created` 冲刷；插件**不创建** agent（I2）。
- **看门狗（唤醒类计时器）规则化**：看门狗不再各自布防 —— 起停条件是**声明**的，由 `WatchdogTable`（`runtime/watchdogs.ts`）统一起停。运行时只在一个固定入口重评估：`reevaluate()`（**状态变化**：条件为真则布防、为假则停表，**不重置**已布防窗口）、`touch()`（**活动事件**：活跃看门狗重置窗口）。

  | 看门狗 | 启动条件（`active()`） | 窗口 | 触发 | 续期 |
  |---|---|---|---|---|
  | `dead-air`（断流唤醒） | `agentEnabled` ∧ 已连接 ∧ **已登录** ∧ 非人工环节 ∧ **无活跃流程** ∧ 有 live agent | `deadAirMs` | 唤醒 agent 自主行动（`lane=t2` 控制消息） | 是（条件仍成立才续） |

  - **"无活跃流程"这一条的两个目的**：① **布防推迟到登录流程收尾之后** —— `logged_in` 可能被 **GMCP** 提前置真（pkuxkx 的 `GMCP.System {site}` 是"登录成功通知"，置信度 1.0，`shared/world.ts:130-147`），而我们的 login 流程那时还没走完（`success` 步的 `onEnter.patch` 只是兜底/权威确认）；② **活跃流程期间不抢答** —— 流程可能等很久才有结果（人工环节/慢命令），流程期间的唤醒职责归**流程自己的计时器**（每步 `timeoutMs`），看门狗不得插队。流程的起停由 `FlowRuntime.opts.onTransition` 通知运行时重评估（进入某步/收束/失败/复位）。
  - 时间尺度上这条也更稳：流程各阶段都有自身计时器（等结果 30s、等分支 30s、终态步 5s），人工环节则本来就停表 —— 所以"看门狗在流程中途唤醒 T2"在结构上不会发生。
  - **`login-stall` 删除（v0.4.0）**：登录不再靠"看门狗把 agent 叫起来猜"，而是**流程步骤的 timeout** —— 每步到点即判定**超时**（I4 的三态之一），流程失败收束并留痕（§19）。"登录卡住"从"唤醒 T2 猜原因"变成"流程给出明确失败"。
  - **停止 = 条件不成立**：断线（连接门失效）、登录完成（`loggedIn` 翻转）、agent 释放（agent 门失效）、`dispose()`（表整体释放）都会自动停表 —— 因此不需要为每条路径各写一遍"清定时器"（这正是实测踩过的坑：登录完成不布防、断线后仍空转）。
  - **状态变化点**（唯一的重评估入口，全部幂等）：连接建立/关闭、GMCP、感知 state 折叠、`world_patch` 工具（`buildMudTools.onWorldChange`）、`onAgentReady`、**流程实例状态变化**（`FlowRuntime.opts.onTransition`：进入某步/收束/失败/复位）、`dispose`。多调无害 —— `reevaluate()` 不重置窗口，只有 `touch()`（收到游戏输出）才重置。
  - **边界（避免"什么都塞进管理器"）**：分帧器的装配阀计时器（v0.6.0 静默窗降级为网络装配粒度 `autoFlushMs`，留在 `FrameSplitter`，§8.7）与 holdDelivery 兜底（`holdTimer`）**不属于看门狗** —— 它们属于一次投递事务的生命周期，留在 runtime；传输层空闲/断线探测属 telnet 层。看门狗表只装"到点唤醒 agent"这一类。
- **工具离线行为**：未连接时发命令类工具**本地快速拒绝**（不入队列、不进桥），返回可读原因。
- **删除用户 / 删除服务器 = 归档配套会话 + 删日志**（两条官方/插件动作配套执行）：
  - **归档（官方路径）**：`IWorkspaces.archiveSession(sessionId)` —— 官方没有"删除会话"，归档是它的替代语义：会话进入 registry 全局归档集，从所有分组/搜索界面隐藏，**会话文件与 workspace 记账槽位保留**（`api/workspace-controller/src/client/service.ts:114`、命令实现 `api/workspace-controller/src/commands.ts:153`）；归档当前会话时 harness 自己把选择清成新会话视图（`client/ui-workspace/src/client/navigation.ts:242`）。会话存在（live 或持久化）才能归档，名单里的失效 id 归档失败只忽略。
  - **删日志（本插件自有资产）**：`ctx.mud.purge(sessionId)`（HTTP `POST /mud/purge`）—— 释放该会话运行时与连接、删除该会话**全部**日志文件（所有日期 + 滚动分片，`purgeSessionLogs`）、清该会话内存与全局 WS 缓冲；页面同时丢弃该会话的本页缓冲（`MudSocketController.forget`）。
- **UI**：连接/断开入口在左栏用户行的 ⋯ 菜单（blank 会话不渲染会话体）；**无占位 prompt** —— `blank` 由首个 `turn/start` 翻转，连接后第一批游戏输出自然开回合翻页。
- **登录与 fullme 是流程表声明（v0.4.0，step 驱动）**：声明与逐条定案见 [doc/flows/login.md](../flows/login.md) 与 [doc/flows/fullme.md](../flows/fullme.md)；机制（arming / 挂起 / 唤醒 / 打断 / 人工环节）见 §19。两条流程的入口都是**匹配服务端提示行**，不是定时器；流程命令属**系统流程**（actor `system`，见 §10 / §19.1）。
- **流程与运行时的关系**（v0.4.0）：流程表在装配期注册为运行时的只读声明面；**每会话的流程实例是运行时状态**（`diag()` 可见、每次迁移写决策/日志）：`{ flowId, stepId, armed[], phase: awaiting-result | awaiting-human, deadline, pendingActions[], pendingEntry[] }`。细节见 §19。
- **Config 全集**（部署值一律可配，I8）：`host`/`port`/`sessionId`/`cwd`/`logDir`/`account`/`agentEnabled`/`persona`/`commandIntervalMs`/`bridgeTimeoutMs`/`bridgeDeclaredTimeoutMs`/`bridgeSilenceMs`/`loginTimeoutMs`/`deadAirMs`/`holdTimeoutMs`/`defaultTier`/`dangerousCommands`/`agentPreset`/`activityTable`/`toolCallIntervalMs`/`t2DeliverIntervalMs`/`captchaPatterns`。（v0.4.0：`loginExitCommands` 退役 —— 登录收尾由流程步骤承担；**不引入 `humanWaitMs`/`humanTimeoutMs`** —— 人工环节沿用本步 `timeoutMs`；fullme 流程化后 `captchaPatterns` 随取图职责迁入 `mud_captcha` 工具，见 §16。）
