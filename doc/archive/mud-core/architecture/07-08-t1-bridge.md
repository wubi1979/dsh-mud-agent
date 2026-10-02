---
sections: [7, 8]
status: active
deps: ["§1", "§2", "§5"]
impl: packages/mud-core/src/agent/t1.ts + agent/flow/ + deliver/adjudicator.ts + agent/inflight.ts
---

## §7 L4 流程驱动器与渲染（T1）

**契约（v0.11.0：从"无状态渲染器"改为"有状态流程驱动器 + 输出渲染"）**：

> **投递里的动作请求优先渲染；没有动作请求则按会话流程槽渲染下一步；槽也不可渲染 → `finish stop`。**

T1 是**有状态的**（状态按 `sessionId` 分槽，见 §19.3/§19.7），但**不查流程表、不判失败、不注销触发器** —— 决策归流程驱动器（`FlowRuntime`），T1 只把"槽里的下一步"渲染成 tool-call。它与 T2 同构：拿工具结果 → 查表决策 → 发下一个 tool-call；唯一区别是决策来源（T2 = LLM，T1 = 流程表）。

| 项 | 设计 |
|---|---|
| 输入 | ① 本步投递的 mud-owned 消息（原文 + 动作请求 `{tool, args}`）—— 规则动作与流程**入口**步走这条路；② 无可渲染动作时读**流程槽**（`slotOf(sessionId)`）取下一步 |
| 输出 | 标准 `tool-call` 块（与真实 LLM 同构）→ 官方 `tools/pre-execute` 闸门 → 官方工具管道。**这是"用 T1 模拟 T2 行为"的落点** |
| **渲染判定序** | 投递里的动作**优先**（规则动作/入口回合不被槽顶掉）→ 无动作时**按槽渲染** → 槽不可渲染则收束。槽可渲染的条件：槽存在、`phase === 'awaiting-result'`、有 `render`、且**尚未渲染过**（`pendingCallId === null`） |
| 确定性 call-id | 投递式：`mud-<delivery>-<index>`；槽式：`mud-flow-<flowId>-<stepId>-<retries>`（同一 (流程, 步骤, 重试轮次) 恒等） |
| **callId ↔ 步骤配对** | 槽式渲染后由 T1 写回槽（`markRendered` → `pendingCallId`）；工具结果按它配对回步骤（§19.3）。`pendingCallId` 由**迁移点发布**自动复位 ⇒ 不会重复渲染同一步，也不需要额外的"清配对"调用 |
| 渲染内容 | **不发 `output` 文本块** —— 流程步的 tool-call 就是全部内容（A4：助手/工具交替、无注入）。收口三件（`closeOn`/`gaCount`/`timeoutMs`）**不在 tool-call 里下发**，由壳侧 `windowSpecFor` 在注册窗口时给出（单一来源，与槽内 `render` 同一次派生） |
| 参数插值 | `render.args` **原样透传**（`{name}`/`{pass}`/`{captcha}` 由工具在发送瞬间插值，§19.1）；流程槽（`{captchaUrl}`/`{lastFail}`）在**发布槽时**已填实 |
| 失败路径 | **T1 不负责失败处理**：运行时判定失败后不再推进槽 → T1 无事可做 → 官方 loop 自然收束回合 |
| 控制消息 | `[系统]` 前缀的控制消息不参与动作渲染：由 L2 以 lane=t2 投递 |
| 缺陷即吵（I4） | 动作请求引用了未注册的工具 / 无法渲染 → error 日志 + diag 计数，绝不静默收束 |
| 定位键 | `GenerateOptions.sessionId`（官方 loop 恒填）。⚠️ **现行实现**：拿不到 sessionId 时**静默回落**投递渲染（不 fail loud）—— 欠账见 §18 未决 #22 |

**契约检验（I15 + I16，验收标准 = T2 能不能用）**：

1. 规则 / 流程 / 工具参数 / 结果判据里**不得出现只有 T1 能解释的引用**（`turnRef` 式私有句柄一律禁止）；
2. 投递消息必须**自洽**：T2 只拿到这一条 user 消息，也能知道场上发生了什么并自行决定（动作请求是"可用信息"，不是"命令"）；
3. 工具参数要能写进工具描述让模型读懂（例：`mud_send { cmd, settle: { mode:'stream', on:{kind:'ga',count:1}, fallback:{ms:5000} } }` —— `settle` 只描述"这条命令的窗口何时关闭"）；
4. **I16（v0.11.0）**：流程槽与流程词汇（`classify`/`captures`/`onSettle`）**不得**进入投递消息、工具参数描述或工具结果文本 —— 模型可见面只剩 `settle`。

**四条出口（按"谁该决定"分）**：

| 出口 | 声明 | 谁执行 | 行去向 |
|---|---|---|---|
| **流程步推进** | 流程表 `action`（无 `direct`） | 入口步：入口投递 → T1 渲染；后继步：驱动器发布槽 → T1 按槽渲染 → 官方工具管道 | 入口步带原文进会话；后继步零投递（只有 tool-call） |
| **规则动作渲染** | 规则表 `action`（无 `direct`） | T1 渲染 → 官方工具管道（走权限闸门） | 随投递消息进会话（含原文） |
| **人工环节** | 步骤声明 `awaitExternal`（如 `{captcha}`） | 值到位后由壳 `resumeHuman()` 发布拍 2 | 等人工期间不投递（§19.3） |
| **直接执行** | `action.direct: true` | **运行时**立即执行（actor `system`，不注册在途窗口） | **不消费、不推水位、不折叠**：命中行与应答行按普通行走后续消费批（→ T2 批次） |

- **直接执行的判据**：无状态、无需返回 —— `save` 提醒 → 发 `save`；分页提示 → 发翻页命令。这类触发的"决策"在规则里已经写全，交给模型只是多一个回合、多一份原文噪声。需要模型判断的动作（登录分支、fullme 提醒与答案）**不得**标 `direct`。
- **直接执行仍受安全边界**：判据用 `agent/gate/policy.ts` 的 `evaluateToolCall`（档位判据按 `full` 跑 —— 它是运行时的动作，不是模型的动作，故不受档位可见性约束），危险命令 `deny` 生效、`ask` 因无审批通道等同拒绝。

---

## §8 行流裁决器与在途窗口（旁路 B）

> **v0.6.0 设计稿（作者审定三项决策）**：① 无标记输出靠帧内存阀兜底；② 服务端插话**并入**窗口响应；③ `settled:'timeout'` 语义 = "放弃等待"，`'silent'` 删除。**v0.9 W7.1**：分帧器（`FrameSplitter`）退役并入 `deliver/adjudicator.ts`（`SessionAdjudicator`），帧机制原样保留。**v0.9 W7.2**：旧命令-应答桥删除，内核折叠进在途窗口表 `agent/inflight.ts`（§8.3）。**v0.9 W7.3**：裁决器注册收口为唯一 `register(registration)` 入口。**v0.11.0（形态 C + 单一水位线）**：窗口**收窄为纯收口器**（只回答"何时关窗"，不判类、不带结局）；判据移交流程驱动器复判；**GA 隐式缺省废除（声明才计 GA）**；**交付水位/三水位/回看结算/折叠机制整体废除**；`direct` 从收口/窗口/水位体系剥离；`mud_recall` 取消、`mud_state` 去 `lines`。

### §8.0 定位（一句话契约）

**标记切帧，工具开窗；收口十成，GA 八成；到期即放弃，放弃带内容。**

行流裁决器（`SessionAdjudicator`，v0.9 W7.1 起分帧器并入其内）是**唯一的边界裁决者**：决定行流在何处切帧、帧何时提交。状态抓取、触发器、在途结算、流程行判据、模型投递都是帧提交的订户（§8.2 消费链），**不得自造边界**。旧的静默/超时"伪边界"删除。命令-应答的注册/结算由**在途窗口表**（`InflightWindowTable`，§8.3）承担 —— 它消费裁决器的行流与边界事件，不再有独立事务实体。

**归属分工（v0.11.0 的关键分界）**：裁决器决定"这些行进哪条链"，**窗口只提供"关窗了、内容是这个"**，**判类与推进归流程驱动器**（形态 C，§19.2）。

### §8.1 边界标记（只此两类）

| 标记 | 把握 | 来源 | 行为 |
|---|---|---|---|
| **GA/EOR** | 八成（服务端概率证据） | telnet 边界事件，常驻缺省 | 命中即提交当前帧；**只有显式声明 GA 关窗的窗口才计数**（§8.3） |
| **判据（正则/完成句）** | 十成（声明的确定性证据） | ① 窗口**关闭触发**（`settle.on` 正则 / 流程派生 `closeOn`）② 活动表（注册窗口的规则动作收口声明）③ 流程**入口 driver** 与**分支等待期后继 driver** ④ 打断规则 | 命中即提交；随窗口/流程**注册为武装标记**（§8.5） |

- **不再进标记表的东西**：流程步的 `ok`/`fail` 分类（形态 C 下它们随窗口走、由驱动器复判，§19.2）；`until`（旧口径 —— `mud_send` 参数与 `ActionSpec.until` 已随 W11.1 整体删除，声明只走 `settle`；活动表完成句是另一字段 `ActivityEntry.until`，仍作关闭触发来源）。

### §8.2 帧生命周期与消费链

帧：**开放**（前帧提交后首行到达）→ **累积**（一切入站行入帧：回显/插话/过程输出不分类）→ **提交**（任一标记命中）→ **消费**（按固定次序**单遍**过链）：

```
① 状态抓取 → world 落库（只观察，不改行流）   ② 规则触发 → 直接执行 / 待人工 / 打断准入
③ 在途结算 → 窗口 resolve（内容随结果交回）   ④ 流程行判据 → 入口 arm / 分支命中 / 排队
⑤ 残余记账 → 投递视图（批次 / 回看缓冲；T2 限流在此站）
```

- I5/I6（每行恰投一次、一结算点 ≤ 一条消息）由链的单遍结构保证；**单一水位线**（§5）是它的记账面。
- **站① 只抓取**：state 命中只 `patch` world，**不隐藏行、不推水位**（折叠机制 v0.11.0 删除）。
- **站③ 的取样必须先于结算**：`inFrame`（提交时点是否在在途窗口内）与 `spanFloor`（span 起点水位）都在站③**之前**取样 —— 结算会清 live、并翻转 `hasOpen()`。
- **站④ 的实际内容**：`awaiting-result` 相位下本步分类已随窗口走，站④ 只处理**入口 arm** 与**分支等待期后继 driver**（§19.2）；`awaiting-human` 相位**不判行**（§19.3）。
- **站⑤ 的 span 过滤**：帧内行中 `abs > spanFloor` 的归在途窗口（**不进投递**）；`abs <= spanFloor` 的前置噪声留待决走正常投递。
- **回看缓冲**（`recallLines`，2000 行上限）是**诊断通路**（`/mud/diag` + log-service），不进模型工具面。

### §8.3 在途窗口（命令-应答；W7.2 取代命令-应答桥；v0.11.0 收窄为纯收口器）

> **v0.11.0（形态 C）**：`WindowRequest`/`WindowSpec` 只剩 `{cmds, closeOn?, gaCount?, timeoutMs?, label?, signal?}`；`WindowResult` 只剩 `{ok, cmd, text, lines, settled, span?}`；`ReplySettle` = `{BoundaryKind | 'evidence' | 'timeout' | 'abort' | 'interrupted' | 'error'}`。**窗口不解释内容**：`settleCriteria` 只认 `win-<n>:close` 一个标记。

- **窗口即开窗**：发命令工具（`mud_move`/`mud_look`/`mud_status`/`mud_send`…）经 `registerWindow(spec)` 注册窗口 → pump 发送（`noGate` 穿透直发延后 gate）→ 宿主 `confirmSent` 武装 → 结算 resolve。窗口 id `w<seq>` 全局递增（不随断线 `reset()` 复位）。**fire-and-forget**（`action.direct` 等直发）不注册窗口。
- **响应 = 窗口期间提交的所有帧的并集**（跨帧累积；插话并入）。`lm` 分页（两帧并集）与 `dz`（ack 帧 + 无 GA 过程帧）不再是特例。
- **无回看（A2）**：`confirmSent` 时点记 span 起点水位 —— 命令发出前已在缓冲的行**不属于**本步应答，留给后续消费批。
- **三种收口，同一条 `settle()` 路径、窗口恒有界（I4）**：

  | 收口 | 条件 | `settled` |
  |---|---|---|
  | **关闭触发命中** | `closeOn` 正则命中（`win-<n>:close` 标记，`immediate:false` 无回看） | `'evidence'` |
  | **N-GA 数到齐** | **仅显式声明** `on:{kind:'ga',count:N}`（或 `boundary`）时计数 | `'ga'` / `'eor'` |
  | **兜底到期** | `timeoutMs`（步预算 / 工具声明 / 缺省）到点 —— **恒在** | `'timeout'` |

  **前两者同形不同名**：都只表示"窗口因证据关闭"、都**不携带分类**；名字不同只为诊断能区分"触发命中"与"N 个 GA 到齐"。
- **声明才计 GA**：未显式声明 ⇒ `gaCount` 未定义 ⇒ `boundary()` 直接返回，**GA/EOR 到达不构成本窗口边界**（旧的隐式缺省 `gaCount ?? cmds.length` 废除）。T2 三个查询工具的 GA 早关由**工具 schema 自带声明**（§19.7 定案 4）。
- **结算终止类**：`interrupted`（流程打断）/ `abort`（回合取消信号）/ `error`（发送失败、发送守卫超时、断线）。
- **结算优先级**：**打断 > 关闭触发 / GA > 兜底到期 > 断线**；打断与关闭触发同帧时打断优先（判定点在站②，先于站③）。
- **内容通道**：窗口带回的 span 行由表留在**单槽**，随本工具返回立即被 `takeSettledLines()` 取走（取一次即清）交驱动器复判 —— **不进模型可见的工具结果**（模型面只有 `{ok, note, cmd, settled}`）。
- **放弃与连续放弃**：到期 resolve `{ok:false, settled:'timeout'}` 且**带回已累积内容**（§8.4）；**连续 3 次放弃 → reject**（DSH 失败终态），非超时结算复位计数。发送守卫：缺省超时内未 `confirmSent` → `error` 结算（防 sending 死锁）。
- **活动表**（`activityTable`，可被 `Config.activityTable` 覆盖）= **规则/直发命令的显式收口声明载体**（旧"N-GA 缺省 + 判据命中结算"职责已废除）。
- **外部占位符（`awaitExternal`）/ 直接执行（`action.direct`）/ 分页规则**：声明面见 §7 四条出口；`mud_captcha` 的提问-提交同回合挂起见 §19.3。
- **gate（直发延后）**：窗口开启 ⇒ 压住非豁免直发命令；窗口自身命令 `noGate` 豁免；`halt` 优先级恒放行（豁免范围约束见 §18 未决 #8）。

### §8.4 放弃（原"超时"）

等待超限 → 窗口 resolve `{ok:false, settled:'timeout'}`（**枚举名保留，语义 = 放弃**）；**帧不动、判据标记保持武装**，真帧随后照常提交走链 —— 数据不丢、无假边界。

**v0.11.0 定案 A：到期带回已累积内容** —— span 行进结果的 `lines`/`text`（状态仍是 `timeout`，不属于 ok/fail），行仍计**当前调用者消费**。理由：T2 不声明收口 ⇒ 恒等满 `fallback`，若到期不带内容，T2 的任意命令就**拿不到回显**。旧 `ABANDON_TEXT`/回放句已删除。

### §8.5 武装标记（arming 面已收窄）

向裁决器注册为武装标记的，**只有四类**：

| 标记 id | 谁注册 | 命中效果 |
|---|---|---|
| `win-<n>:close` | 在途窗口表（`confirmSent` 武装、任何结算注销） | 帧提交 → 站③ `settleCriteria` → 关窗（`evidence`） |
| `flow-arm:entry:<flowId>` | 流程运行时（空闲时的入口 arm；世界变化时重算） | 帧提交 → 站④ → 激活流程（入口投递） |
| `flow-arm:branch:<stepId>` | 流程运行时（`succeedStep` 时布防的条件分支后继） | 帧提交 → 站④ → 进分支步 |
| `rule-int:<ruleId>` | 打断规则（常驻） | 帧提交 → 站② 打断准入 |

- **命中即提交帧**：链运行 → 打断/分支当场发生，不依赖批次/结算点节奏。**流程步的 `ok`/`fail` 不在本表**（形态 C：随窗口走、由驱动器复判）。
- 全部注册收口至裁决器唯一 **`register(registration)`** 入口（打断武装 / 流程 arming 重放 / 直发判据投影）；重连/断线 `reset()` 后由壳 `register()` 重挂一次。`arm()` 的"**arming 即测**"处理"重试重挂、流程换步时完成句已在帧内"的同批语义；**`win-` 标记写 `immediate:false`**（无回看，A2）。

### §8.6 帧内存阀（保险，非边界）

帧行数超限（256 行量级）→ 提交**无标记帧**（`marker:'valve'`），照常走消费链。标记永不到来属编码缺陷（I9 吵）；阀只为防 OOM。

### §8.7 删除清单

| 删除项 | 版本 | 理由 |
|---|---|---|
| 静默结算（`silent` / SILENT_MARKER / 逐行重置计时） | v0.6.0 | 不再是边界 |
| 超时进帧（TIMEOUT_MARKER 追加进 text/lines）与放弃回放句 | v0.6.0 / v0.11.0 | 放弃 = 到期带内容，回放不进帧（§8.4） |
| 孤儿 GA 计数器 + ORPHAN_EXPIRE_MS | v0.6.0 | GA 只切帧，无"误结算下一帧"可防 |
| 结算优先级阶梯（until > GA > 静默 > 超时） | v0.6.0 | 收敛为"标记命中即提交" |
| 300ms 静默作为消费边界 | v0.6.0 | 保留为网络装配粒度（`autoFlushMs`） |
| **旧命令-应答桥本体**（`bridge.ts`：pending/live 单槽、挂起闸门、`tx-*` 标记、I11/I12 挂起期拒绝） | v0.9 W7.2 | 在途窗口表取代；配对移交替代按命令比对归属 |
| **`until` 口径**（工具参数与 `ActionSpec.until`；活动表字段保留） | v0.11.0 / **W11.1（v0.11.3）** | v0.11.0 并入"关闭触发"（`settle.on` regex → `closeOn`）；W11.1 **整体删除**工具参数与 `ActionSpec.until`（残留传参 fail-closed 拒绝并指向 `settle`；活动表 `ActivityEntry.until` = 完成句锚定，有真实消费，保留） |
| **`WindowCriteria`（`ok`/`fail`）、`branch`、`gaOutcome`、`onSettle`、`WindowResult.hit`/`hitText`、`settleCriteria` 按类结算、`armWindowMarker` 多样标记** | v0.11.0 | 形态 C：判类归驱动器，窗口只留一个 `closeOn` |
| **N-GA 隐式缺省**（`gaCount ?? cmds.length`）与"到点即成功" | v0.11.0 | 声明才计 GA；到期恒 `timeout` |
| **形态 A 脚手架**（`closeForFlow()` / `ReplySettle='flow'` / `noteToolResult` 的 `'flow'` 早返回） | v0.11.0 | 形态 C 自然退役 |
| **交付水位 / 三水位 / 发送水位 / 回看结算 / 折叠行（折叠消费）** | v0.11.0 | 单一水位线（§5）；状态抓取与 `direct` 不消费行 |
| **`mud_recall` 工具、`mud_state(lines)` 参数** | v0.11.0 | T2 的上下文 = 会话历史本身，不提供 pull 通路（§5/§19.7 定案 7） |
| **判据 B（`shouldConcludeTurn` 及其投递尺寸记账）** | v0.11.0 | 终态改由流程驱动器在推进点判定（B3，§19.6.2） |

### §8.8 实现映射与切片

| 新模块 | 从哪来 |
|---|---|
| `deliver/adjudicator.ts`（行流裁决器：行流缓冲/开放帧 + 标记表 + 内存阀 + 五站消费链；v0.9 W7.1 分帧器并入，原 `frame-splitter.ts` 退役） | 旧桥的边界逻辑剥离新建（v0.6.0 S1）→ W7.1 并入裁决器 |
| 消费链（裁决器五站顺序调用） | 旧 `onTextBlock` 分支树 + `settle()` 汇合点重组 |
| `agent/inflight.ts`（**在途窗口表 `InflightWindowTable`**：注册/confirmSent 武装/`feedLines` 累积/关闭触发/声明才计 GA/兜底到期/`interrupt`/`close`+`reset`/直发延后 gate/diag/`takeSettledLines` 内容单槽；窗口 id `w<seq>` 全局递增） | **W7.2 取代旧桥**；**v0.11.0 收窄为纯收口器**（形态 C） |
| `register(registration)` 唯一注册入口（`AdjudicatorRegistration {stateRules, eventRules, holdRuleIds, gateRules}` → 投影新建 PerceptionEngine + 打断常驻标记 `rule-int:<id>` + 流程 arming 重放（**入口 arm + 分支等待期布防**）+ 直发判据投影） | **W7.3 注册收口**；重连/断线 `resetForReconnect`/`abortForDisconnect` 内 `splitter.reset()` 后经 `register(this.registration)` 重挂一次 |
| `agent/flow/slot.ts`（**流程槽**：会话作用域、一格、替换语义、`clear()`、`pendingCallId`） | **v0.11.0 新增**（T1 状态化的落点，D10/I8） |
| `agent/flow/engine.ts`（`judgeStep`/`judgementUnits`/`judgeFrom`/`applyJudgement`/`settleFallback`/`closeTrigger`/`publishSlot`/`windowSpecOf`） | v0.11.0 形态 C：驱动器复判 + 槽发布 |

切片：**S1** 分帧器 → **S2** 事务表瘦身 → **S3** 消费链重组 → **S4** 措辞同步（§2/§5/§19/§12）与测试对齐。`close()`/`signal`/发送失败语义沿用旧桥。**v0.9 W7.1**：`frame-splitter.ts` 退役并入裁决器，`frame-splitter.spec.ts`/`response.spec.ts` 改指 `adjudicator.ts` 导出。**v0.9 W7.2**：`response.spec.ts` 重写为在途窗口表单元测试。**v0.11.0**：`response.spec.ts` 再删 7 例（判据型/fail 判据/branch/captures/onSettle 显式化等已删特性）并改写 `settleCriteria` 自过滤例与 diag 例；`tools.spec.ts` 的 `until`/活动表例改断言 `closeOn`、`OUT_SCHEMA` 形状例改写（工具结果只剩四项）；`flow-ownership.spec.ts` 去 `gaOutcome` 断言；新增 `flow-judge-order.spec.ts` / `flow-slot.spec.ts` / `t1-slot.spec.ts`。

---
