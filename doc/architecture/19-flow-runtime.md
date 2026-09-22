---
sections: [19]
status: active
deps: ["§1", "§7", "§8", "§11"]
impl: packages/mud-core/src/agent/flow/engine.ts + agent/flow/slot.ts + agent/flow/flow-spec.ts
---

## §19 流程表与流程运行时（step 驱动）

**目标**：把"多步确定性流程"（登录、fullme、练功这类长命令交互）从**模型回合历史**里拿出来，做成**显式的步骤表 + 运行时状态 + T1 流程槽**。
**根因回顾**：v0.3.5 及以前，步骤的真相被寄存在"回合记录 + 命中队列 + 帧归属"里 —— 时序一偏就静默卡死，归属一错就串步。本设计让"该有状态的地方有状态（流程运行时 + T1 槽），该无状态的地方无状态"。

**现行形态（v0.10.8–v0.11.0 落地，取代本节 v0.4.0 原文）**：

- **形态 C（收口与分类分离）**：窗口退化为**纯收口器**（只回答"窗口何时关闭"）；判据住在**流程表**、由**驱动器复判**（只回答"内容指向哪个 next"）。二者正交、分属两个组件（§19.2/§19.3）。
- **B3（终态归驱动器）**：回合收束判据由**流程驱动器在推进点**给出，包装器只转达 `exec.concludeTurn()`；旧"按投递尺寸 + 流程空闲推断"的判据 B 删除（§19.6.2）。
- **T1 = 有状态流程驱动器**：流程回合内 T1 按**流程槽**渲染下一步 tool-call（§7）；流程步只在**入口**投递一次，其余步骤零投递（§19.6.1）。

### 19.0 定位（D0 前置结论 + 一句话契约）

- **D0（官方无流程管理插件，2026-09-22 核实）**：`deepseek-harness` 官方**没有**声明式流程表插件 —— `workflow` 是"模型写 JS 脚本扇出子代理"（`Foreground collection only` / 无 journaling 与 resume，钩子只有 `agent()/parallel()/pipeline()/phase()/log()`），与"无 LLM 在环的确定性流程"语义不兼容（§19.6.1 实测 `t2Calls === 0`）。**因此"T1 应降级为纯渲染器"的前提不成立，T1 保留流程所有权**。最贴近的官方先例是 `goal-round-driver`（在 `agent/status` 转 idle 的静止点用 `agent.followup()` 排下一轮）。
- **一句话契约**：流程表定"该谁行动"；T1 是**有状态的流程驱动器**（拿工具结果 → 查表决策 → 发下一个 tool-call），与 T2 同构、只区别于决策来源；**运行时不做流程推断**（D8：只做收口、记账、投影）。

### 19.1 声明（流程表）

**声明面 = 三层正交声明**（`FlowStep.settle` / `classify` / `captures`，`agent/flow/flow-spec.ts`）：

```
flow <id>
  priority    数字。直接比大小（不打分档枚举）：normal = 100；越大越不可打断
              login = 1000（无人可打断）；fullme = 100（战斗类事件可打断）
  when        入口前置条件（读 world）：**满足它才 arm 入口 driver**
              login: !logged_in；fullme: logged_in
  entry       入口步骤 id（缺省 = steps[0]）
  stepBudget  流程级步数预算（防 T1 高速空转；声明 + 装配期形态校验）
  step <id>
    driver    进入判据之一（服务端提示行）。**省略 = 不能靠行进入**，只能由前驱顺序兜底进入
    action    { tool, args }（可含 {name}/{pass}/{captcha} 与流程槽占位符）
              可选 awaitExternal: ['captcha'] → 该步进人工环节（等外部值）
              三者至少其一：driver / action / 终态（全空）
    settle    **收口声明**（只回答"窗口何时关闭"，步级**必填**于新形流程表）:
              | { mode:'inline' }                     本步工具结果即收口（不开行流窗口）
              | { mode:'stream',
                  on?: {kind:'regex',pattern} | {kind:'ga',count},  关闭触发（层内唯一类型）
                  fallback?: { ms } }                兜底时长（到期恒为 timeout 结果）
              缺省 stream；`fallback` 是"步预算"的唯一来源（§19.2 计时）
    classify  **分类声明**（只回答"内容指向哪个 next"，与 settle 解耦）:
              { ok?: [正则], fail?: [正则], branch?: [{id,pattern}], onSettle?: 'ok'|'fail' }
              空类 = 跳过；`onSettle` 只在"条件关窗、复判未命中任何判据"时生效（缺省 'ok'）
    captures  抽取声明：命名捕获组 `(?<name>…)` 即槽名（未匹配不报错）
    onEnter   进入本步即执行的副作用（patch 落 world / direct 直发），不等结果
    next      后继步骤 id 列表（可多分支；**空 = 终态**）
              · 带进入判据的后继（自身 driver / 判定节点的 ok·fail）= **条件分支**（先布防，命中即走）
              · 不带进入判据的后继 = **顺序兜底**（本节点成功后就执行，不等待）
    retry     { attempts, on?, action? } —— 命中 `on`（缺省 ['driver']）里的判据时**在原步内重试**:
              投 action（缺省 = 重发本步动作）→ 清空本步 awaitExternal 槽 → 重新挂起等人工；
              `attempts` = **总尝试次数（含首次）**；**不重置本步预算**（时间预算 = "一步总计"）
    timeoutMs 本步预算（缺省取流程级/Config 缺省）。**人工环节没有单独的超时字段** —— 等人工期间
              用的就是本步这一份预算
    boundary  N-GA 兜底关窗基数（>=1 整数；显式声明才计 GA，§8.3）
    onInterrupt  被打断时要先发的直发命令（如练功的 halt）
  onSuccess   { patch?, commands?, direct? } —— 流程整体成功时执行（终态节点之后）
  failPolicy  { notify: 't2' | 'none' } —— 失败/超时出口（缺省 't2'：投递一条 T2 可见的失败消息）
```

**三种节点**：① **动作节点**（有 `action`：发命令并等结果）；② **判定节点**（无 `action`，靠 `driver` 进入：**进入即算成功**，随后按 `next` 推进 —— 它没有窗口、没有内容可复判，去向因此只能由条件分支或顺序兜底给出）；③ **终态节点**（`next` 空）：**本节点成功即流程成功结束**，随后执行流程级 `onSuccess`。

**引擎消费形（实现面，`normalizeFlowSpecs` 过渡桥）**：`settle`/`classify`/`captures` 声明被规范化为 **legacy 原语** —— `mode:'inline'` → `ok:[tool-ok]`+`fail:[tool-error]`；`on:{kind:'ga',count:N}` → `boundary:N` 且 GA 判据按 `onSettle` 进 `ok` 或 `fail`；`classify.ok`/`fail` 正则 → `ok`/`fail` 行判据；`captures` → `capture` 映射；`fallback.ms` → 步级 `timeoutMs`。**引擎零改动消费 legacy 形**（`FlowMatch` 的 kind：`regex` / `text` / `ga` / `tool`；`isLineMatch` 只把 regex/text 算作行判据）。⚠️ **过渡桥尚未拆除**：无 `settle`/`classify`/`captures` 的步骤走 legacy 校验路径（§18 未决 #22）。

**占位符三类**（校验期 fail loud）：① 运行时值 `{name}`/`{pass}`/`{captcha}`（**发送瞬间**插值，不落转录）；② 内建流程槽 `{lastFail}`（本流程最近一次 `fail` 命中行原文）；③ `captures`/`capture` 声明的槽（**投递前**插值）。不在三类内的占位符 = 装配期错误。

- `{pass}` 的**值源**是官方凭据 seam：连接时由 host 经 `ctx.credentials.resolve` 解析凭据引用名（§10/§11，W9）。明文仍只在发送瞬间插值、不落转录、不进工具结果。
- **一个流程词汇都不进模型可见面**：`classify`/`captures`/`onSettle` 全是流程表字段；tool-call 参数里**只有 `settle`**（§19.3 收口来源解析）。

**注册期校验（装配时执行，fail loud、不静默；`validateFlows`）**：

| 校验 | 违反时 |
|---|---|
| 流程 id / 步骤 id 唯一；`entry` 存在 | 装配期抛错 + 留痕，流程不装配 |
| `next` 引用的步骤必须存在（**空 = 终态**） | 同上 |
| 同一步的 `ok` 与 `fail` 判据集**互斥**（同一判据不得两边都写；`GA` 不得两边都写）；`driver` 与 `ok` 不得重叠 | 同上 |
| 动作参数里的每个 `{…}` 都必须是三类已知占位符之一 | 同上 |
| `captures`/`capture` 槽名在流程内唯一、正则可编译 | 同上 |
| `retry` 合法：`attempts` 是 >=1 整数、`on` 只含 `'driver'`/`'fail'`、`retry.on` 含 `'driver'` 时本步必须有 `driver`、`retry` 必须有可投动作（本步 `action` 或 `retry.action`） | 同上 |
| `{ kind:'tool' }` 判据只能出现在**本步有 action 或 retry.action** 的步骤上 | 同上 |
| `awaitExternal` 声明的占位符必须在 `action.args` 里出现 | 同上 |
| `settle`/`classify`/`captures` **存在时**：inline 下不得声明 `classify`；stream 下 `on` 的 ga count >=1、regex 可编译、`fallback.ms` 正数；`classify` 正则可编译、`branch[].id` 必须存在、`onSettle` 只取值 `'ok'`/`'fail'` | 同上 |
| `stepBudget` 是 >=1 整数；`priority` 是有限数字；`boundary` 是 >=1 整数 | 同上 |
| 无判据的空节点却声明了 `next`（无 `driver`/`ok`/`fail` 就不能靠行进入） | 同上 |
| **不存在 `humanTimeoutMs`/`humanWaitMs` 字段** —— 人工环节沿用本步预算 | 同上 |

**已知缺口（⏳ §18 未决 #22）**：新形校验包在"`settle` 已声明"的分支内 —— **漏写 `settle` 的步骤静默通过**，"步级必填（漏写报错）"尚未收紧为硬校验。

**每一类字段"谁消费"**：

| 字段 | 谁看 | 说明 |
|---|---|---|
| `when` | 运行时（入口 arm 前） | 前置条件；不满足就不 arm 入口，流程根本不激活 |
| `driver` | 运行时（入口 arm / 分支等待期）+ 驱动器（复判 retry driver） | 进入/重试本步；省略 = 不能靠行进入 |
| `action` | T1（按槽渲染成 tool-call）→ 官方工具管道 | 动作仍走官方路径（I15） |
| `settle` | 壳侧 `windowSpecFor` → 在途窗口 | 关闭触发 / GA 计数 / 兜底时长（与槽内 `render` **同一次派生**） |
| `classify` · `next` | 驱动器 `judgeStep` | 固定类序复判，见 §19.2 |
| `captures` | 驱动器（进入本步的命中行上抽） | 答错重试不重新抽取（沿用首次的值） |
| `retry` | 驱动器 | 命中 `on` → **原步内**重投 + 清外部槽；**不重置预算** |
| `awaitExternal` | 运行时 + 壳（`missingExternalValues`） | 人工环节：进 `awaiting-human`，停投递；提问由 `mud_captcha` 工具做 |
| 其余（`onEnter`/`onSuccess`/`onInterrupt`/`failPolicy`） | 运行时 | 副作用与出口 |

- **与 trigger 不重复**：驱动句 / 分类只写在流程表里；`state` 规则仍留在 trigger（§4）。流程表在**装配期**注册进运行时（只读声明），**每会话的流程实例**是运行时状态。
- **权限**：流程步声明的命令属**系统流程**（actor `system`，不受档位可见性约束；危险命令硬边界照旧，§10）；`direct` 动作按 `full` 判定（§7）。

### 19.2 复判与推进（形态 C：窗口只管关，判据归驱动器）

**收口三件由驱动器派生、随窗口注册**（`windowSpecOf`，与槽内 `render` 同一次派生 ⇒ "T1 渲染的 tool-call"与"窗口注册"不可能分歧）：

```
closeOn    = union(本步 retry driver ∪ 本步 fail ∪ 本步 ok ∪ 各后继 driver) 编译为单个 any-of 正则
             —— 命中即关窗（settled:'evidence'），**不携带分类、不判类**
gaCount    仅当本步显式声明 GA 关窗（settle.on ga:N 或 boundary）时才给
timeoutMs  本步预算 = settle.fallback.ms（或显式 timeoutMs）
```

**判定（复判点 = 推进点 `noteToolResult`，工具**在途期间**）**：窗口只带回**内容**（span 行）；驱动器按本步判据对内容走一遍，**固定类序、类内按行序取首个**：

```
① retry  —— 命中本步 driver（且本步声明了 retry）⇒ 原步内重试
② fail   —— 命中本步 fail ⇒ 若 retry.on 含 'fail' 且次数未用尽 ⇒ 原步内重试；否则失败
③ 分支   —— 命中某个后继 driver ⇒ 成功 + 走该分支
④ ok     —— 命中本步 ok ⇒ 成功
```

- **类序固定不可配**（同帧多命中按此序取一，其余留痕）；`retry` 排在**最前**是因为"本步 driver 再次出现"意味着本步命令没有生效（如服务器重复打同一提示行），语义上先于"本步结果"。
- **一次都没命中时的兜底**：`timeout` → 本步失败（无应答事实）；证据关窗（`evidence`/`ga`）→ 本步声明的 **GA 判据**优先（保守判定，如 fullme `stale` 的 `onSettle:'fail'`），否则 `onSettle` 缺省 **'ok'**（"证据关闭即成功"）。
- **`GA` 是收口条件，不是分类**：`settle.on:{kind:'ga',count:N}` 只决定"第 N 个 GA 关窗"；关窗后算哪一类仍由复判给出（`onSettle` 承载"GA 关窗而分类未命中"的裁决）。
- **`timeout` 不属于 ok/fail**（"到点即成功"废除）；**到期不进 retry**（retry 只由 `retry.on` 里的判据驱动）。

**结算归属 = 配对移交**（不靠事后比对命令集合）：流程在本步命令**进入投递时**经 `windowSpecFor(cmd, values)` 把本步收口三件移交给该命令的窗口 —— 只有本步自己的命令拿到覆盖（序列按位等长比对、单体按 includes；**不匹配 = 用工具自带声明**）。工具返回后按 **stepId** 判定（不匹配 → 不作本步结算判据，动作投递已随该结果正常带过）。「别的命令的结算串掉本步」结构上不可能发生。⚠️ 命令比对是**运行时字符串相等**（插值后）：声明与实发不一致会导致覆盖失效 → 本步只能等 `timeoutMs` 失败收束（有留痕，不静默）。

**推进（`succeedStep` 只是里程碑，不是流程结束）**：

```
本节点成功 → 无后继 = 终态 ⇒ finishFlow（执行 onSuccess）
           → 有后继 ⇒ arm 条件分支（后继 driver）+ 记下顺序兜底 → phase='awaiting-branch'
                      按 step.timeoutMs ?? flow.timeoutMs **重新布防计时器**（"等待后继判据超时"）
条件分支命中（行流，`offer`）→ 进分支步
顺序兜底的两个执行点：① **批尾**（成功由行判据给出时，同批先给条件分支机会）
                      ② **结算之后**（成功由窗口结算给出时，判定完立刻补跑）
```

- **为什么后继 driver 要一起布防**：实录时序里"本步结果"和"下一步驱动句"**同一帧**到达（`{name}` 的应答里既有"需要创建新人物"、又有"此ID档案已存在，请输入密码："）。若等"成功后再打开下一步触发器"，提示行已经过去了 → 流程必卡死。同帧到达也由复判类序天然定序。
- **分支阶段同样有计时器**（一步成功不清掉时间预算）：覆盖两个静默等待入口 —— 判定节点进入后等后继，以及"只有条件分支后继、分支行永不到达"。没有它，这类等待会无限持续（违反 I4）。
- **会话侧 arming 面已收窄**（形态 C）：`awaiting-result` 期间会话侧**没有**本步判据（进入步骤即清空）—— 本步判据随窗口走；会话侧只剩两件事：**入口 arm**（空闲时；模型只在回合里活着，流程该不该启动必须有人在无回合时盯着行流）与**分支等待期布防**（`succeedStep` 起）。帧提交的立即唤醒因此只剩这两类标记。
- **迟到行 = 没到**：窗口关闭之后才到达的 driver 行不回头认领，按普通行进入后续消费批。
- **入口 arm 与单流程互斥**（I10）：空闲时所有流程的入口都开着；一旦某条流程激活，**其它流程的入口立即收掉**；期间出现的其它入口行记 **pending entry**，当前流程结束后接续（出队只发生在**回合结束、槽已失效之后**的静止点，§19.6.2）。
- **同行多命中**：注册期已保证 `ok`/`fail` 互斥；类内多命中按**声明顺序取首**并留痕。

### 19.3 步骤推进与结算归属（落在在途窗口 + 流程槽上）

```
流程步的动作:
  入口步   —— 由**入口投递**开回合（消息带动作请求 + 原文）；T1 渲染它 = 第 1 步
  后继步   —— **零投递**：驱动器把"本步要发的 tool-call"发布进**流程槽**（publishSlot），
              T1 在下一次请求按槽渲染（`slotOf` / `markRendered`）

T1 按槽渲染 → 工具调用（官方管道）:
  校验（收口来源解析三序）→ 凭据插值（发送瞬间）→ confirmSent 注册在途窗口（owner = 本窗口，
  收口三件由 windowSpecFor 移交）→ 写 socket（零间隙）
  ├─ 关闭触发命中 / N-GA 到齐 ⇒ 关窗（只带回内容）→ 工具 await 返回
  ├─ 打断 / 断线 / 回合取消 ⇒ 当场结算（interrupted / error / abort），不干等超时
  └─ timeoutMs 到点 ⇒ 结算为 timeout（内容仍带回）
工具返回 → 包装器（仍在"在途"窗口内）调 noteToolResult(callId, outcome, settled)
  → 定位步骤（**槽配对优先**：槽的 pendingCallId；回落投递账本，入口步仍带投递）
  → 内容经窗口单槽交驱动器（takeSettledLines，取一次即清）→ judgeStep 复判 → 推进/重试/失败
  → 驱动器判定终态 ⇒ 包装器转达 exec.concludeTurn()（B3）
```

- **步骤归属（callId ↔ 步骤）**：槽内 `pendingCallId` 由**迁移点发布**自动复位（进入步骤 / 成功 / 重试发布拍 / 复位），因此不会重复渲染同一步、也不需要额外的"清配对"调用。T1 槽渲染用**确定性 callId** `mud-flow-<flowId>-<stepId>-<retries>`；投递式调用仍是 `mud-<delivery>-<index>`。
- **结果只有三态**：成功 / 失败 / 超时（I4）。**没有"静默"这一说**。
- **内容通道**：窗口带回的 span 行经 `InflightWindowTable#takeSettledLines` **单槽直送驱动器**（工具返回后立即取走、取一次即清）——**不进模型可见的工具结果**（模型面只有 `{ok, note, cmd, settled}`）。
- **`note` 是这条应答进入会话的落点**：窗口 span 行被吸收、不进 T2 批次（§8.2 站⑤），故 `note`（span 文本）是模型/人唯一能看到命令回显的地方。
- **两拍（`tryRetry` / 人工环节）**：槽一次只放**一条真能发的调用** —— ① 有 `retry.action`（如重新取图）⇒ 拍 1 发布前置动作并置 `awaitingPre`，其结果回来时清标记并发布**拍 2**（本步动作）；② 无前置且本步声明 `awaitExternal` ⇒ 槽停在 `awaiting-human`（无 `render`），外部值就位后由**壳侧** `resumeHuman()` 发布拍 2；③ 无前置、不等人工 ⇒ 直接重发本步动作。
- **人工环节（`awaitExternal`）**：进入步即置 `phase='awaiting-human'` —— 行判据**不结算本步**（唯一出口是人工回填；否则同批到达的成功句会把"命令还没发出"的步判成成功）、投递暂停、看门狗不插手；**计时器照跑**（用本步预算）。`mud_captcha` 推图后**工具不返回**（在途挂起 → 回合保持打开），人工提交的码作为**工具结果**回管线 → `resumeHuman()` 回到 `awaiting-result`（**计时器继续跑、不重布防**）→ 发布拍 2。**fail-closed 三出口**（工具结果 `ok:false` → 所在步失败收束，不悬挂）：① 弹窗"中止" → waiter 直接失败；② 每次提问的等待兜底 `CAPTCHA_WAIT_MS = 175_000`（`session.ts` 常量，**不给模型看、非 Config 字段**；步预算 180s 仍是硬上界，175s 先结算）；③ 流程结束 / 断线 / 会话释放。断线重连作废人工环节。
- **流程状态归运行时**：`{ flowId, stepId, phase, deadline, retries, sequential, slots }`（`diag()` 可见、每次迁移留痕）；**公开槽**（`FlowSlot`）是 T1 的唯一数据源。

### 19.4 打断与排队（I14）

```
规则命中（顺序：第 1 步就判定能否打断）—— 判定点 = 裁决器站②（投递规则动作之前）
  ├─ rule.interrupts > flow.priority  → **打断**
  │     ① 在途窗口当场结算 = interrupted + **定向清除该窗口的队列残余命令**
  │     ② 复位流程（收束 + 清槽）→ 只留入口
  │     ③ 发 onInterrupt 命令（直发、`priority:'halt'`）
  │     ④ 事件动作**持有到回合结束的静止点**，经 followup **开新回合**投递
  ├─ 规则未声明 interrupts（家务类：save/分页）→ 不打断（direct 动作本来就直发，无需排队）
  └─ 声明了但档位不够                        → **排队**（pending action），流程结束后立即执行
流程激活期间出现其它流程入口行               → **pending entry**，当前流程结束后接续
```

- **判定顺序**：站① 状态抓取 → 站② 规则命中与**打断准入** → 站③ 在途结算 → 站④ 流程行判据 → 站⑤ 投递（§8.2）。流程行判据在 `awaiting-result` 相位是空的（判据随窗口走），站④ 实际只处理入口 arm 与分支等待期。
- **打断的挂起结算**：`InflightWindowTable.interrupt(reason)` —— 表内在途/排队窗口**当场**结算为 `interrupted`（工具拿到 `{ok:false, settled:'interrupted'}`）；表**继续可用**（打断后新命令照常注册窗口），这一点与 `close()`（断线终止语义）不同。**队列残余清除**：窗口结算为 `interrupted` 时按 `replyId` 定向清除宿主队列里尚未发出的序列命令（否则 gate 放行后剩余命令照发 = 半截序列）。
- **打断事件动作走 followup 新回合**（D5）：不再随被打断的工具结果 defer 进同一回合；调用点 = `agent/status` 转 idle 的**静止点**（`flushInterruptFollowups`）。实测代价：+1 回合 / +1 步 / +1 次 T1 本地请求（§19.6.1）。
- **排队与出队**：档位不够 → `pendingActions`；流程到达终态/失败/被打断后，运行时调 `drainFlowQueue()` 投递。判定点：批次尾、工具结果（`noteToolResult`）、流程失败回调（超时/断线路径）。
- **`login = 1000`**：没有任何规则的 `interrupts` 能高过它 → 无人可打断。**`fullme = 100`**：战斗/生存类事件（`interrupts > 100`）可打断它。
- **`onInterrupt` 的范围**：只声明"打断时要先发的直发命令"（如 halt）；"打断后自动重试/原因判定"留给 T2。
- **端到端**：`tests/flow-interrupt.spec.ts`。

### 19.5 失败与收束

- 失败 / 超时 → 复位（**只留入口** + 清槽）+ 留痕（决策器 + 日志）+ `notify` 出口：
  - `failPolicy.notify = 't2'`（**缺省**）：**主动投递一条 T2 可见的失败消息**（否则"超时且零行"时 T2 拿不到任何输入 = 静默停住）；
  - `'none'`：只留痕（login / fullme 现配置 `none` —— 用户名/密码/冷却都是人工或系统问题，T2 补不了）。
- **失败的未结算行不丢弃、不移交**：留在行流，作为下一批入口原文或 T2 批次被消费。
- **回合收束不需要 T1 参与**：运行时不再投递动作 ⇒ T1 按槽也无动作可渲染 ⇒ 官方 loop 自然收束当前回合。
- **"流程活跃"绑定回合**（D6）：回合结束（`agent/turn-stopping`）+ `agent/status` 转 idle 静止点 → 活跃流程**自动失效**（复位 + 留痕）→ 入口 arm 恢复 → `drainFlowQueue()` 出队 → `drainQueuedEntries()`（pendingEntry 经 `offer()` 原路重放）。两处都是幂等兜底。
- **断线口径 = 复位重开**：重连后入口 driver 重新命中 → 入口投递重开流程（不续接旧状态；续接见 §19.7 待定）。

### 19.6 T1 的关系（一回合多步）

- **一个流程 = 一个回合** —— 步骤在同一回合内推进（T1 按槽渲染 → 工具 → 复判 → 下一步…），直到终态或失败。**不做"一步一回合"**（历史基线见 19.6.1）。
- T1 在流程回合里只做一件事：把**槽里的下一步**（或投递带来的动作请求）渲染成 tool-call；它**不查流程状态、不判失败、不注销触发器**。

#### 19.6.1 实测账目（官方 loop 模拟器；`tests/loop-sim.ts`）

**模拟器**：按 DSH 源码逐条复刻 loop 的转移（驱动器 `while (await turn())`、认领 `next-step` 全取 + `next-turn` 一条、回合首步空认领即收束、结果携带 `additionalContexts` 进 `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break），每条规则在文件里给出出处；且**仿真官方包装器**（`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `exec.deferContext` → `result.ok && noteToolResult(callId) === true` → `exec.concludeTurn`），运行时那侧是**生产代码**。**用法**：驱动器与测试线程交错（工具调用阻塞在等游戏应答），测试用 `until(pred)` 推进假计时器。**凡关于"回合/步骤/模型请求次数"的结论，必须在它上面量。**

| 接线 | 回合 | 步 | 模型请求 | idleSteps | deferred | concludeTurn |
|---|---|---|---|---|---|---|
| 历史基线：`followup`（运行时 `agent.followup` → `next-turn`） | 3 | 6 | 6 | 3 | — | — |
| 中间态：`defer`（无 conclude） | 1 | 4 | 4 | 1 | 2 | 0 |
| ✅ **现行：槽渲染 + `defer` + B3 `concludeTurn`** | **1** | **3** | **3** | **0** | **0** | **1** |

- 指标口径：`claimlessSteps` = 有效本地 T1 续步（产出了 tool-call）；`idleSteps` = 无动作空步（真白跑）；`emptySteps` = 两者之和。**验收红线 = `idleSteps === 0` + 转录里除入口外零投递消息**（A4）。`claim=0` 本身是 DSH 原生续步、不是病征。
- 实测 `t2Calls = 0`：流程期间**没有任何**请求落到 T2 —— `turnLane` 在回合内沿用（`session/mount.ts`）把工具续步/空续步都留在 T1。
- **打断改 followup 的代价**（练功在途被打断 → 回合 1 收束 → 静止点 followup → 事件动作 → 回合 2 收束）：**2 回合 / 4 步 / 4 请求（全 T1，t2=0）/ idleSteps=2 / concludedTurns=0**。

#### 19.6.2 投递通道与回合收束（判据 A 保留；判据 B → B3）

**判据 A —— 通道由"投递瞬间是否有工具在途"决定（actor 无关）**：运行时投递在**工具在途**时存入 defer 槽、否则 `followup`；在途与否由工具包装器通知运行时（`beginToolCall()`/`leaveToolCall()`）。**判据 A 保留**（同时服务 T2 批次与规则动作）—— 删除的只是"T1 流程步进对 defer 的依赖"（后继步零投递、T1 按槽渲染）。

**判据 B —— 已删除**。原判据（"本调用是投递最后一条动作 + 流程机空闲"的投递尺寸推断）在形态 C 下多余且越权（D8），由 **B3** 取代：

- **终态由流程驱动器在推进点给出**（`noteToolResult` 返回 boolean：本结果之前流程活跃、之后 `flow.state() === null`）；包装器只转达 `exec.concludeTurn()`。`DeliveryChannel` 的投递尺寸记账（`shouldConcludeTurn`/`actionCount`）随之删净。
- **判据 C —— 失败/超时/打断：什么都不做，让官方自然收束**（"清空 defer 槽"是错的：槽里若有内容，那是独立的新输入）。`concludesTurn` 只在**成功结果**上生效，故失败路径 ⇒ 不 defer 也不 conclude ⇒ loop 自然再给一步（认领为空）⇒ T1 渲染 `finish stop` ⇒ 回合以 `completed` 收束。

**实现落点（三处）**：① `session/mount.ts` 的 `MudDeliveryChannel` 接口（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries`/`noteToolResult`）+ `runWithDeliveryChannel` 包装器（喂回流程机在 `endToolCall` **之前**，判定产出的投递才仍在"在途"窗口内）；② `deliver/delivery-channel.ts` 的 `DeliveryChannel`（defer 槽 + 投递账本 + T2 投递时刻）；③ `deliver/adjudicator.ts#noteToolResult`（槽配对优先 → 复判 → 返回终态判定）。**两条装配路径都必须接**（宿主 `attachMudTools` 与 preset `MudAgentKit.channel`）。

### 19.7 定案与待定

**已定案**：

1. **形态 C**（收口器只管关、判据归驱动器复判）：收益 = ① 窗口净退化为收口器；② 收口与判据**不可能分歧**（触发从判据派生，一份声明）；③ 同帧定序天然正确；④ 流程词汇一律不进模型可见面（I15/I16）；⑤ 旧"形态 A"脚手架自然退役。
2. **B3**（终态归驱动器）：账目 = 1 回合 / 3 步 / 3 请求 / 0 空续步（§19.6.1）；决策者只有流程驱动器一个。
3. **收口缺省 `{mode:'stream'}` + `fallback:{ms:3000}`，窗口恒有界**；**兜底到期恒为 `timeout`**（不属于 ok/fail，"到点即成功"废除）。
4. **声明才计 GA**：未显式声明 `on:{kind:'ga',count:N}` ⇒ GA/EOR 到达**不构成本窗口边界**（旧的隐式缺省 `gaCount = 命令条数` 废除）。T2 三个查询工具的 GA 早关由**工具 schema 自带声明**。
5. **`action.direct` 从收口/窗口/水位体系剥离**：不注册窗口、不结算、不产生 span、**不推水位、不消费行**；其命中行与应答行按普通行进入后续消费批（→ T2 批次）。仍受危险命令硬边界与直发延后 gate 约束（`halt` 豁免见 §18 未决 #8）。
6. **状态抓取是独立桶**：`feed()` 只同步 world，**不推进水位、不折叠内容**（折叠机制整体删除，§5/§4）。
7. **单一水位线**：行流消费进度的唯一记账；`mud_recall` 取消、`mud_state` 去 `lines` 参数（T2 的上下文 = 会话历史本身，不提供 pull 通路）。
8. **T1 槽表归会话作用域**（D10 / I8）：T1 adapter 保持无状态外壳，只按 `GenerateOptions.sessionId` 查表；会话释放即清槽。
9. **投递通道保留判据 A、删除判据 B**（§19.6.2）。
10. **打断事件动作走 followup 新回合**（静止点调用），I14 语义与档位比较不变。
11. **MXP 检测模式发任何命令都能跳过**：login 终态步发**空命令**收尾（空命令是合法命令：照常注册窗口、靠 GA 关窗结算）。
12. **`succeedStep` 只是里程碑**，收束只发生在 `next` 为空的终态步；分支阶段也布防计时器。
13. **规则原文核对归作者**：登录/密码/fullme 各句的逐字原文由作者上线前核对；实现方只保证流程结构正确（步骤图、判据分工、三态、打断档位）。
14. **D0**：官方无流程管理插件 ⇒ T1 保留流程所有权（§19.0）。

**待定（详见 §18）**：

1. **`pendingEntry` 的端到端用例**：机制已就位（入队/接续 + `diag().pendingEntry`），缺 e2e 用例（§18 未决 #5）。
2. **`hpbrief` 应答折叠进 world**：终态步已发 `hpbrief`，其应答目前只作工具结果；加一条 state 规则把气血/精力折进 world 供 T2 读取（§18 未决 #5）。
3. **断线后流程整体挂起续接**：现行口径为复位重开；续接需把流程状态 + 待发命令 + 人工等待 + 在途窗口序列化并在新连接按新行号重建，而重连后行号从 0 重起、锚点全失效。仅在真实需求出现时立项。
4. **收口声明收紧 + `sessionId` fail-loud**（本次文档同步登记的欠账，§18 未决 #22）：① 漏写 `settle` 的步骤目前静默通过（"步级必填"未收紧）；② T1 拿不到 `sessionId` 时静默回落投递渲染（未 fail loud）。
5. **`R4` 端到端用例**：流程失败 → `notify='t2'` 投递 → T2 接手（§18 未决 #23）。
6. **入口回合的显式区分字段**：计划的 `flow?: {id}` 字段**未落地** —— 现行"流程回合 vs 渲染回合"由**流程槽 + 投递动作**共同区分，T1 另用 `action.ruleId` 的 `flow:` 前缀登记 `pendingCallId`（§18 未决 #21）。

---
