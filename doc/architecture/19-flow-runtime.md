---
sections: [19]
status: active
deps: ["§1", "§7", "§8", "§11"]
impl: packages/mud-core/src/flow/engine.ts
---

## §19 流程表与流程运行时（step 驱动）

**目标**：把"多步确定性流程"（登录、fullme、练功这类长命令交互）从**模型回合历史**里拿出来，做成**显式的步骤表 + 运行时状态**。
**根因回顾**：v0.3.5 及以前，步骤的真相被寄存在"回合记录 + 命中队列 + 帧归属"里 —— 时序一偏就静默卡死，归属一错就串步。本设计让"该有状态的地方有状态（流程运行时），该无状态的地方无状态（T1）"。

### 19.1 声明（流程表）

```
flow <id>
  priority    数字。直接比大小（不打分档枚举）：normal = 100；越大越不可打断
              login = 1000（无人可打断）；fullme = 100（战斗类事件可打断）
  when        入口前置条件（读 world）：**满足它才 arm 入口 driver**
              login: !logged_in（已登录不再 arm 登录入口）；fullme: logged_in
  step <id>
    driver    驱动句判据（MatchSpec；服务端提示行）。**省略 = 顺序步**：上一节点成功后立即执行
    action    工具调用声明：{ tool, args }（可含 {name}/{pass}/{captcha} 与流程槽占位符）
              可选 awaitExternal: ['captcha'] → 该步**先挂起动作**、进人工环节等人工补值
              **三者至少其一**：`driver`（条件进入）/ `action`（发命令等结果）/ 终态（全空）
    capture   可选：{ 槽名: 正则 } —— 把**本步命中行**的抽取结果存进流程实例槽（如 captchaUrl）；
              答错重试不重新抽取，沿用首次抽到的值
    onEnter   可选：进入本步即执行的副作用（`patch` 落 world / `direct` 直发命令），不等结果
    ok        本步成功判据（MatchSpec[]）—— **`GA` 是一种判据，必须显式声明**（见下）
    fail      本步失败判据（MatchSpec[]）—— 同上；**ok 与 fail 不得同时声明 GA**
    next      直接后继步骤 id 列表（**显式列出**；可多分支；**空 = 终态**）
              · 带 driver 的后继 = **条件分支**（先 arm，命中即走）
              · 不带 driver 的后继 = **顺序兜底**（本节点成功后就执行，不等待）
    retry     可选：{ attempts, on?, action? } —— 命中 `on`（缺省 ['driver']）里的判据时
              **在原步内重试**：投 `action`（缺省 = 重发本步动作）→ 清空本步 `awaitExternal` 的槽
              → 重新挂起等人工；`attempts` = **总尝试次数（含首次）**，用尽才算失败；
              **不重置本步计时器**（时间预算是"一步总计"：fullme 的 answer = 3 分钟）
    timeoutMs 本步超时（缺省取流程级/Config 缺省；到点 = 超时结局）。
              **人工环节没有单独的超时字段** —— 等人工期间就用本步这一份预算
    onInterrupt  可选：被打断时要先发的直发命令（如练功的 halt）
  onSuccess   { patch?: 落 world; commands?: [走工具路径的命令]; direct?: [只发不等结果的直发命令] }
              —— **流程整体成功时**执行（终态节点之后）
  failPolicy  失败/超时出口（缺省：留痕 + 交 T2 决策一次；`'none'` = 只留痕不叫 T2）
```

**`MatchSpec` 的 kind**（`FlowMatch`）：`text`（行含某串）/ `regex`（行匹配）/ `ga`（本步命令被 GA 结算）/ **`tool`**（本步**工具调用结果**：`{ kind:'tool', outcome:'ok'|'error' }`，供"只调工具、不发游戏命令"的步骤判定）。任何 kind 都可带可选 `why`（只影响日志/决策文案，不参与匹配）。

**占位符三类**（校验期 fail loud）：① 运行时值 `{name}`/`{pass}`/`{captcha}`（**发送瞬间**插值，不落转录）；② 内建流程槽 `{lastFail}`（本流程最近一次 `fail` 命中行原文）；③ `capture` 声明的槽（**投递前**插值）。不在三类内的占位符 = 装配期错误。

**三种节点**：① **动作节点**（有 `action`，发命令并挂起等结果）；② **判定节点**（无 `action`，只有 `ok`/`fail` + `next`：进入即算成功，如 login 的旧 `success` 形态）；③ **终态节点**（`next` 为空）：**本节点成功即流程成功结束**，随后执行流程级 `onSuccess` —— 判定节点进入即成功；动作节点要等它的判据（如 fullme 的 `success` 等 `hpbrief` 的 `GA`）。

**`GA` 判据**（v0.4.0）：`GA` 是与"行匹配"并列的一种**判据**（`MatchSpec` 的一个 kind），语义 = "该命令的应答被 GA 结算"。它**不是自动成功** —— 必须写进 `ok` 或 `fail` 才生效：

```
ok:   [ GA ]        → GA 到达即本步成功（如 look：命令被接受就够了）
fail: [ GA ]        → GA 到达即本步失败
ok:[GA] ∧ fail:[GA] → **注册期报错**（互斥）
```

**注册期校验**（装配时执行，fail loud、不静默）：

| 校验 | 违反时 |
|---|---|
| 同一 step 的 `ok` 与 `fail` 判据集**互斥**（同一 pattern 不得两边都写；`GA` 不得两边都写） | 装配期抛错 + 留痕，流程不装配 |
| `next` 引用的步骤必须存在（**空 = 终态**） | 同上 |
| 步骤 id 在流程内唯一；流程 id 全局唯一 | 同上 |
| `awaitExternal` 声明的占位符必须在 `action.args` 里出现 | 同上 |
| `{ kind:'tool' }` 判据只能出现在**本步有 `action`** 的步骤上 | 同上 |
| 动作参数里的每个 `{…}` 都必须是三类已知占位符之一（运行时值 / 内建槽 / 本流程 `capture` 槽） | 同上 |
| `retry.on` 只能含 `'driver'`/`'fail'`；`capture` 的槽名在本流程内不得重名 | 同上 |
| **不存在 `humanTimeoutMs` 字段** —— 人工环节沿用本步 `timeoutMs`（等人工与重试共用同一份预算） | 同上 |

**每一类字段"谁消费"**（避免语义打架）：

| 字段 | 谁看 | 说明 |
|---|---|---|
| `when` | 运行时（入口 arm 前） | 前置条件；不满足就不 arm 入口，流程根本不激活 |
| `driver` | 运行时（arming 匹配） | 进入/重试本步；省略 = 顺序步 |
| `action` | T1（渲染成 tool-call）→ 官方工具管道 | 动作仍走官方路径（I15） |
| `capture` | 运行时（首次进入本步时） | 从命中行抽值存槽；答错重试沿用 |
| `onEnter` | 运行时 | 进入即生效的副作用（落 world / 直发），不等结果 |
| `ok` · `fail` · `next` | 运行时（结果判定） | 见 19.2 的判定顺序；`tool` 判据由官方工具结果喂回 |
| `retry` | 运行时 | 命中 `on` 判据 → **原步内**投 `action`（缺省重发本步动作）+ 清 `awaitExternal` 槽 + 重新挂起；**不重置计时器** |
| `awaitExternal` | 运行时（挂起/收人工值/计时） | 人工环节：动作**先挂起**、停投递、停看门狗；等人期间用本步 `timeoutMs` 计时；**提问（推图 + 在途等人工提交）由 `mud_captcha` 工具做**（ask-human，§19.3） |
| `onSuccess.commands` · `.direct` · `.patch` | 流程成功时执行 | `commands` 走工具路径；`direct` 只发不等结果（与 save/分页同一机制） |

- **与 trigger 不重复**：驱动句 / ok / fail 只写在流程表里；`state` 规则仍留在 trigger（§4）。流程表在**装配期**注册进运行时（只读声明），**每会话的流程实例**是运行时状态。
- **权限**：流程步声明的命令属**系统流程**（actor `system`，不受档位可见性约束；危险命令硬边界照旧）—— 与登录/人工环节同一口径（§10）；`direct` 动作按 `full` 判定（§7）。
- **动作仍走官方路径**（不偏离初衷）：流程只决定"该谁行动"，动作由 T1 作为"模型"渲染成 tool-call（§7）。

### 19.2 arming 与推进（同帧问题的正解）

```
空闲（无活跃流程）                → arm(各流程的**入口 driver**，须先满足流程 when；I10：同一时刻最多一个流程实例)
进入流程（入口 driver 命中）      → 激活流程实例，收掉其它流程的入口（不再 arm）
进入某一步                        → 执行 onEnter 副作用；抽 `capture` 槽
                                  → 有 action 时：`awaitExternal` 步**挂起动作（不投递）+ 进人工环节**；
                                    其余步照常发命令并挂起
                                  → arm(本步 driver(重试) ∪ 本步 ok ∪ 本步 fail ∪ 各后继 step.driver)
结果判定（每批行 / 帧文本 / 工具结果；按行序）
                                  ① 命中本步 fail → 若本步 `retry.on` 含 'fail' 且次数未用尽 ⇒ **原步内重试**
                                     （投 `retry.action`（缺省重发本步动作）→ 清 `awaitExternal` 槽
                                      → 重新挂起等人工；**计时器不重置**）；否则 **失败**
                                  ② 命中某个后继 driver → **成功 + 走该分支**
                                  ③ 命中本步 ok → **成功**（含 `ok:[GA]` ⇒ GA 到达即成功；
                                     `ok:[{kind:'tool'}]` ⇒ 本步工具结果成功）
                                  ④ 本节点成功但**没有任何条件分支命中** → 走**顺序兜底后继**
                                     （`next` 里不带 driver 的那个；行判据成功 → 批尾跑，
                                       窗口结算成功 → 结算后立刻跑）；**无后继 = 终态 ⇒ 流程成功结束**
                                     （随后执行流程级 `onSuccess`）
人工提交（waiter 解挂，码进 externalValues）→ `mud_captcha` 工具结果 ok（note 含码）
                                  → `resumeHuman()`：回到 awaiting-result（**计时器继续跑**）
                                  → 投出挂起的动作（先人工值、后投递）+ defer 随**工具结果**进同一回合
连接断开 / 写失败 / 人工中止 / 等待兜底超时 → 工具结果 `ok:false` → 本步失败 → 流程失败收束
到本步 timeoutMs                  → 超时 → 流程失败收束（人工环节同样在跑这份预算）
```

- **人工环节期间不判行**（作者定案 2026-09-13）：`phase === 'awaiting-human'` 时 `offer()` 只记录不判定 —— 人工环节只有一个出口（人工回填）；否则同批到达的成功句会把"命令还没发出"的步判成成功。**计时器不停**：等人期间用本步 `timeoutMs`（fullme 的 `answer` = 3 分钟，与图片有效期对齐）。
- **重试与失败的分界**：`retry.on:['fail']` 让"答错"变成"重来"而不是"收场"（fullme 用 `attempts:3`）；重试**不出本步、不重置计时器**，只做三件事：投 `retry.action`（ask-human 工具**再问一次、再次在途挂起**）、清空本步 `awaitExternal` 的槽值（否则旧码会被直接重发）、把命中行原文写进 `{lastFail}`。所以"等人工 + 答错重来 + 收结果"共用同一份时间预算 —— 这正是"一步总计 3 分钟"的实现方式。

- **GA 是判据，不是自动成功**（用户定案）：`GA` 作为 `MatchSpec` 的一种 kind 写进 `ok` 或 `fail` 才生效；`ok:[GA]`= GA 到达即成功（如 `look` 步：命令被接受就够了），`fail:[GA]`= GA 到达即失败。**两边同时声明 `GA` 属注册期错误**（见 19.1 校验表）。**GA 与其它判据完全同权**（作者定案 2026-09-13）：任何一步都能直接声明，"哪些步该声明"不是文档层面的限制。
- **条件分支 vs 顺序兜底**：`next` 里带 `driver` 的后继是**条件分支**（先 arm，命中即走，可多分支）；不带 driver 的后继是**顺序兜底**（本节点成功后直接执行，不等待）—— login 的 `replace`（同名确认句，可能不出现）就是条件分支的范例：出现才走，不出现不阻塞（§11）。
- **顺序兜底的两个执行点**（作者定案 2026-09-13）：① **批尾** —— 本步的成功由**行判据**给出时，同一批里先给条件分支机会（同批行优先），批尾再跑兜底；② **结算之后** —— 本步的成功由**窗口结算**给出时（`ok:[GA]` 命中 / `until`），判定发生在批次之外，结算处理完就立刻补跑兜底。少了 ②，`mxp` 这类"命令被接受即成功 + 顺序后继"的步骤会停在 `awaiting-branch` 等一个永远不来的批次（静默等待，违反 I4）。
- **`succeedStep` 只是里程碑，不是流程结束**（作者定案 2026-09-13）：一步成功只表示"该步的判据满足了"，流程继续按 `next` 推进（条件分支 → 顺序兜底 → 终态）。**收束只发生在 `next` 为空的终态步**（login 的 `look`），此时才执行流程级 `onSuccess`。
- **分支阶段同样有计时器**（作者定案 2026-09-13）：`succeedStep` 之后**不清掉时间预算**，而是按 `step.timeoutMs ?? flow.timeoutMs` 重新布防（失败文案"等待后继判据超时 (Nms)"）。这条覆盖两个静默等待入口：判定节点（`success`）进入后等 MXP/收功句；以及"只有条件分支后继、分支行永不到达"（`name.next=['pass','replace']`）。没有它，这类等待会无限持续（违反 I4）。
- **入口 arm 与单流程互斥**（I10）：空闲时所有流程的入口 driver 都开着；一旦某条流程激活，**其它流程的入口立即收掉**（"判据不开"，不是"命中了再忽略"）；期间如果看到别的入口行，记 `pending entry`，当前流程结束后接续。
- **为什么后继 driver 要一起 arm**：实录时序里"本步结果"和"下一步驱动句"**同一帧**到达（`{name}` 的应答里既有 `需要创建新人物` 之类结果、又有 `此ID档案已存在，请输入密码：`）。若等"成功后再打开下一步触发器"，提示行已经过去了 → 流程必卡死。
- **arming 集的实现落点（v0.6.0，§8.5）**：§19 的 arming 集与**裁决器标记表是同一张表**（v0.9 W7.1 分帧器并入裁决器） —— 流程判据（本步 ok/fail、后继 driver、入口 driver）与打断规则注册为裁决器**武装标记**；命中 → 帧立即提交 → 消费链运行 → 唤醒/打断当场发生，不再依赖批次/结算点节奏。GA 只是常驻缺省标记（八成）。**v0.9 W7.2**：本步命令的窗口判据（`windowSpecFor` 覆盖，19.3）由在途窗口表经 `win-<n>:ok/:fail` 武装标记接入同一张表。
- **同行多命中**：注册期已保证 `ok`/`fail` 互斥；同类内多命中按**声明顺序取首**并记 `[流程] 判据冲突: A 与 B → 取 A` / `[流程] <flow>/<step> 结算 ga（不是本步命令的结算: "<cmd>", 忽略）`。

### 19.3 步骤推进与结算归属（W7.2：落在在途窗口上）

> v0.9 W7.2 重写：旧「挂起与唤醒（落在桥上）」机制（桥 pending 单槽 I11、挂起期拒绝 I12、`ownCommands` 按命令比对、`onSettle` 回调）随命令-应答桥删除（§8.3/§8.7）。步骤推进改由**工具结果**驱动（`noteToolResult`），结算归属改由**配对移交**结构性保证。

```
流程步的动作（由流程表生成，T1 渲染，模型也能读懂 —— I15）:
    mud_send { cmd:'{name}', … }

发命令 → 工具注册在途窗口（registerWindow，§8.3；windowSpecFor 只对本步命令
        返回判据覆盖 —— 配对移交，见下）
        ├─ 判据命中（win- 标记）或 N-GA 关窗 ⇒ 窗口结算 → 工具 await 返回
        └─ timeoutMs 到点 ⇒ 超时放弃（settled:'timeout'）
工具结果 → noteToolResult(stepId, outcome, settled?, hitText?)
        → 按 19.2 判定顺序推进：① 注销本步 arming ② 结果判定 ③ 投递下一步动作
          （保持"先投递后唤醒"顺序语义）
回合取消 / 流程打断 → 窗口立即结算 abort / interrupted（不干等超时）
```

- **结果只有三态**：成功 / 失败 / 超时（I4）。**没有"静默"这一说** —— 静默窗不再参与流程结算。
- **结算归属 = 配对移交**（W7.2，取代旧"按命令比对"）：流程在本步命令进入投递时经 `windowSpecFor(cmd, values)` 把本步的判据覆盖（criteria/gaCount/gaOutcome/timeoutMs）**移交给该命令的窗口**——只有本步自己的命令拿到覆盖；工具返回后 `noteToolResult(stepId, …)` 按 stepId 判定（不匹配 → 忽略并留痕；同窗不二次结算）。「别的命令的结算串掉本步」**结构上不可能发生**——窗口与 step 的配对在注册时定死，不再靠事后比对命令集合。
  - 旧机制为何存在（留档）：实录里"本步结果行"与"下一条命令的 GA"常同帧到达 —— `success` 的进入判据（成功句）命中后立刻投递空命令，而上一条命令（`{pass}`）的 GA 紧接着到达。旧桥按命令比对（`ownCommands` 交集 + 消费）防串步；W7.2 下窗口与 step 一一配对，同类隐患消失。
  - 归属与 19.2 的 arming 正交：arming 决定"哪些判据开着"（流程行判据），配对移交决定"本步命令的窗口按什么判据结算"。两者都要满足才推进步骤。
  - 帧文本判据（`text`/`regex`）不经窗口（帧文本先到、GA 后到是常态），走 19.2 的 arming 路径；经窗口的是"与本步命令绑定的那类结算"（GA/until）。
- **`GA` 由窗口结算通知**：它是 `ok`/`fail` 里可声明的判据之一（§19.1）；没有声明 GA 的步骤，GA 到达只是"帧文本定稿"，判定继续等文本判据或超时。
- 下一步动作的投递 = **一条正常的 mud-owned 消息（原文 + 动作请求）**，与 T2 拿到的消息同形（I15）：T2 若处理这一回合，读原文自行决定，动作请求只是"可用信息"。
- **人工环节 = ask-human 同回合提问**（v0.7.3 重定稿；2026-09-13 初版为"进入即挂起动作、人工回填走 `sendCommand` 新回合"——实测回合分裂：提问后无在途工具，T1 `finish stop` 收束回合，回填只能开新回合）。现行机制对齐官方 `ApprovalService.request`（**提问要求回合开着**；回答是**工具结果**）：`mud_captcha` 推图后**工具不返回**（在途挂起 → 回合保持打开，`shouldConcludeTurn` 因流程活着不收束）。人工提交裸码（弹窗**只收码**，§19.3 人工只负责提供值；页面经 `/mud/command` 送达，`sendCommand` 人工分支兼容 `fullme` 前缀）→ waiter 解挂 → 码进 externalValues（`{captcha}` 留到**发送瞬间**插值）→ 工具结果 `ok:true`（note 含码）→ `exitHumanWait`：`resumeHuman()` 就地恢复 → 投出挂起动作 → settle（动作随**工具结果** defer 进同一回合，回合不分裂）。**进入步时 `phase='awaiting-human'`**（`enterStep` 对 `awaitExternal` 步置位）：行判据不结算本步、看门狗按等待置位、`requestAgent` 拒绝唤醒。**fail-closed 三出口**（工具结果 `ok:false` → 所在步失败收束，不悬挂）：① 弹窗"中止" → `captchaAbort` RPC → waiter 直接失败结束；② 每次提问的等待兜底超时 `CAPTCHA_WAIT_MS = 175_000`（`session.ts` 常量，**不给模型看、非 Config 字段**；步预算 `timeoutMs`（180s）仍是硬上界，175s 先结算）；③ 流程结束 / 断线 / 会话释放（等待作废）。断线重连作废人工环节。

### 19.4 打断与排队（I14）

```
规则命中（顺序：第 1 步就判定能否打断）
  ├─ rule.interrupts > flow.priority  → **打断**
  │     ① 结算挂起 = interrupted + **定向清除该窗口的队列残余命令**（工具拿到 {ok:false, settled:'interrupted'}）
  │     ② 注销 arming + 复位流程（只留入口）→ 流程收束
  │     ③ 发 onInterrupt 命令（直发，如练功的 halt）
  │     ④ 投递打断事件的动作（原文 + 动作请求）→ T1 渲染 → 官方工具路径
  ├─ 规则未声明 interrupts（家务类：save/分页）→ 不打断（direct 动作本来就直发，无需排队）
  └─ 声明了但档位不够                        → **排队**（pending action），流程结束后立即执行
流程激活期间出现其它流程入口行               → **pending entry**，当前流程结束后接续（不漏 fullme 提醒）
```

**实现落点（2026-09-13 已接线）**：

- **声明面**：`ActionSpec.interrupts?: number`（`perceive/types.ts`，纯数字；缺省 = 不参与）。
- **判定点**：运行时在**同一批次**里、在投递规则动作之前先做打断准入（`session/session.ts` 的 `admitRuleHits`）—— 顺序是先流程判定（`flow.offer`）→ 待人工挂起（`parkExternalHits`）→ **打断准入** → 投递。判定用 `FlowRuntime.interrupt()`（`interrupts > flow.priority`）。
- **打断的挂起结算**：`InflightWindowTable.interrupt(reason)`（W7.2 取代旧 `CommandResponseController.interruptInFlight`）—— 表内全部在途窗口**当场**结算为 `interrupted`，工具结果 `{ok:false, settled:'interrupted', note:'[流程打断] …'}`；表**继续可用**（打断后投递的新命令照常注册窗口），这一点与 `close()`（断线终止语义）不同。迟到/无主的 GA 只作裁决器边界事件，无窗口可结算（孤儿 GA 计数器已随旧桥删除，§8.7）。**队列残余清除**（v0.9.2）：序列命令在 pump 时已一次性入宿主命令队列（§8.3），窗口结算为 `interrupted` 时按 `replyId` 定向清除残余（`CommandQueue.discardByReplyId`）—— 否则 gate 放行后剩余命令照发（半截序列 bug，实测踩过）。
- **排队与出队**：档位不够 → `FlowRuntime.pendingActions`；流程到达终态/失败/被打断后，运行时调 `drainFlowQueue()` 把队列里的动作**动作投递**给 T1（`deliverStandalone`）。判定点不止一处：批次尾、工具结果（`noteToolResult`）、以及流程失败回调（超时/断线路径）。
- **端到端**：`tests/flow-interrupt.spec.ts`（8 例）：档位够 → 打断（interrupted + 复位 + `onInterrupt` 直发 + 事件动作投递）；档位不够 → 排队且在流程真的结束前不出队；未声明 → 照常投递；空闲 → 不生效；**login = 1000 不可打断**（战斗类只能排队）；**半截序列不发出**（打断后残余命令不再照发）。
- **`onInterrupt` 的范围**：只声明"打断时要先发的直发命令"（如 halt）；"打断后自动重试/原因判定"留给 T2（§18.15）。

- **login = 1000**：没有任何规则的 `interrupts` 能高过它 → 无人可打断（用户定案）。
- **fullme = 100**：战斗/生存类事件（`interrupts > 100`）可打断它 → 流程失败收束（页面的人工输入作废，战斗优先）。
- **练功这类"T2 工具挂起"同一机制**：挂起者是模型的工具调用而非流程步，差别只在拥有者；被打断后由 T2 决定是否重来。

### 19.5 失败与收束

- 失败 / 超时 → 复位 arming（**只留入口**）+ 留痕（决策器 + 日志）+ **交 T2 决策一次**（"重试 / 告知用户"），不静默停住、不自动重试。
- **回合收束不需要 T1 参与**：运行时不再投递动作 ⇒ T1 没有动作可渲染 ⇒ 官方 loop 自然收束当前回合（§7）。
- 人工环节失败（断线/放弃）同样复位到"只留入口"。

### 19.6 T1 的关系（一回合多步）

- **目标（作者定案）：一个流程 = 一个回合** —— 步骤在同一回合内推进（T1 渲染 tool-call → 挂起 → 唤醒 → 下一步…），直到终态或失败。**不做"一步一回合"**。
- T1 在每步只做一件事：把本步认领到的动作请求渲染成 tool-call（§7）；它不查流程状态、不注销触发器、不判失败。

#### 19.6.1 实测账目（官方 loop 模拟器；2026-09-13）

**模拟器**：`packages/mud-core/tests/loop-sim.ts` —— 按 DSH 源码逐条复刻 loop 的转移（拖动器 `while (await turn())`、认领 `next-step` 全取 + `next-turn` 一条、回合首步空认领即收束、结果携带 `additionalContexts` 进 `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break），每条规则在文件里给出出处。**用法**：驱动器与测试线程交错（工具调用阻塞在等游戏应答），测试用 `until(pred)` 推进假计时器。**凡关于"回合/步骤/模型请求次数"的结论，必须在它上面量** —— 旧的"`followup` → 数组"替身看不到边界，不能作为证据。

`tests/loop-sim-login.spec.ts` 跑完整条 login（名字→密码→成功句→空命令收尾）。下表是**落地前后**的对照（前两行是历史基线，最后一行是当前实现）：

| 投递通道 | 回合 | 步骤 | 模型请求 | 空续步 | 形状 |
|---|---|---|---|---|---|
| 历史基线：`followup`（运行时 `agent.followup` → `next-turn`） | 3 | 6 | 6 | 3 | 每回合 `claim=1`(T1 渲染动作) → 工具 → `claim=0`(T1 收束) → `turn/end`；下一步动作要等本回合结束才被**新回合**认领 |
| 历史基线：`defer`（无 conclude） | 1 | 4 | 4 | 1 | 同一回合 `claim=1 → 1 → 1 → 0`；最后仍多一步 |
| ✅ **当前实现：`defer` + `concludeTurn`** | **1** | **3** | **3** | **0** | 同一回合三步，末步结果直接收束（`concludedTurns=1`、`deferred=2`）|

- **落地前与"一个流程 = 一个回合"不符**：旧实现是**一步一回合 + 每步一次空续步**（每个流程步 2 次模型请求）。这不是缺陷，是 `followup` 的官方语义：*"the item becomes the sole ordinary message of its own turn"*（`core/agent/src/runtime-types.ts:217-222`）—— **现在已按 §19.6.2 切到 `deferContext` + `concludeTurn`**。
- 三次实测 `t2Calls = 0`：流程期间**没有**任何请求落到 T2（真实 LLM）—— `turnLane` 在回合内沿用（`session/mount.ts:219-241`）把工具续步/空续步都留在 T1。
- **模拟器现在跑的是真行为**：`LoopSim.execute` 仿真官方包装器（`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `exec.deferContext` → `result.ok && shouldConcludeTurn(callId)` → `exec.concludeTurn`），运行时那侧是**生产代码**。
- 落地设计（✅ 已按此实现，见 §19.6.2）：① 两条通道分工 —— 有工具在途 ⇒ `deferContext`，无工具在途（帧内命中/人工回填/看门狗/一次性动作）⇒ `followup`；② 一次工具调用期间可能连推多步（`processBatch`），必须**按序全部** defer；③ `concludeTurn` 只对**T1/流程通道**的动作生效（T2 自己发起的工具调用绝不能收束回合）；④ 工具**不许抛异常**（registry 的 catch 会丢掉 deferred contexts，`core/tools/src/index.ts:1586-1588`），失败必须是"带错误的返回结果"（我们已是此风格）。

#### 19.6.2 投递通道：三条判据（✅ 已实现 2026-09-13）

**判据 A —— 通道由"投递瞬间是否有工具在途"决定（不区分流程/规则）**。
运行时投递（`deliver`/`deliverStandalone`/`drainFlowQueue`）在**工具在途**时存入 defer 槽、否则 `followup`。在途与否由工具包装器通知运行时（`enterToolCall()/leaveToolCall()`），判定精确到"我们自己的工具正在执行"。**不按"流程 vs 一次性动作"分通道** —— 两者语义相同（都是 T1 通道的下一步），一律按在途与否分流。

**打断的通道（判据 A 的边界情形，作者问）**：高优先级规则命中时，被打断的工具**正在在途**（打断发生在批次投递前，而流程步在途就意味着表里有在途窗口），所以**事件动作照常入 defer 槽、随那个被打断的结果进下一步** —— 不 `followup`、不伪造 step。依据：官方允许**错误/失败结果**携带 `additionalContexts`（`core/tools/src/index.ts:1824-1841`、`1910/1924`），即"这个调用被打断了，同时给你一条新输入"是合法形状。顺序也正好是：**先结算旧动作（`interrupted`）→ 再随结果投递事件动作**。
只有"没有工具在途时被要求打断"（例如流程停在等分支、表里没有在途窗口）才落到 `followup` —— 这是判据 A 的常规分流。

**判据 B —— `concludeTurn` 只由"某投递的最后一条动作"触发，且运行时已无活**。
- **N 与 index 都不是流程步数**：`N` = **该投递消息 `source.actions` 的长度**（T1 一次渲染出的 tool-call 条数），`index` = 确定性 call-id `mud-<delivery>-<index>` 里的下标（§7）。**流程的可选分支不影响它们** —— 分支只影响"以后还会不会有新投递"，而这件事由运行时的状态回答（下一条）。
- 收束条件 = **结果成功 ∧ `index === N - 1` ∧ 流程机已空闲（`flow.state() === null`）∧ 无其它待投递**。
- **为什么必须有"流程机已空闲"**：流程步成功之后可能**暂时**没有下一步动作（例如 `name` 成功进入 `awaiting-branch`，在等密码提示行）。此刻槽是空的，若只按"槽空 + 最后一条"收束，就会把这个仍在推进的流程切成"本回合结束 → 分支行到达时只能开新回合"。加上"流程空闲"后，等待中的流程不会被切。
- **`concludeTurn` 与 defer 可以并存，不会吞掉已排队的输入**：官方在 `turnEnds && nextStep.length === 0` 时才收束，`nextStep` 非空就继续走下一步（`agent-loop/src/agent.ts:315-320`）。所以判据 B 的"无其它待投递"是**意图**上的收紧（更早收束、省一步），不是安全阀。

**判据 C —— 失败/超时/打断：什么都不做，让官方自然收束**（**修正**：原稿写的"清空 defer 槽"是错的，槽里若真有内容，那是独立的新输入，清掉只会丢事件）。
- `concludesTurn` 只在**成功结果**上生效（`core/tools/src/index.ts:558-569`）。所以：
  - **失败/超时/写失败** ⇒ 既 defer 不出新东西（运行时不会为失败产生"下一步动作"），也不 conclude ⇒ loop 自然再给一步（认领为空）⇒ T1 渲染 `finish stop` ⇒ 回合以 `completed` 收束。**这就是作者说的"打断步本身无动作、自然收束"**，不需要伪造任何 step，代价只是异常路径多一次 T1 请求（我们本来就在付）。
  - **打断** ⇒ 不是"失败路径"：事件动作要投，照判据 A 的边界情形随 `interrupted` 结果 defer 出去；那个**真动作**执行成功后按判据 B conclude。**不存在"伪造一个成功 step 来收束"**。
- 槽的生命周期本来就被限制在**一次工具调用之内**（在途期间入槽、该调用的包装器结束时取走），不存在"残留到下一步"的可能，因此不需要任何显式清槽。

**实现落点（三处，已落地）**：
1. `session/mount.ts`：新增 **`MudDeliveryChannel`** 接口（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries`/`shouldConcludeTurn`）；`attachMudTools(..., channel?)` 的工具包装器在 `execute` 前后 begin/end，结果提交前 `for (msg of takeDeferredDeliveries()) exec.deferContext(msg)`（`exec.deferContext` = 官方 `inject` 原语的工具侧投递入口，I2），并在 `result.ok && shouldConcludeTurn(callId)` 时 `exec.concludeTurn()`。
2. `session/session.ts`：实现该接口 —— `inFlightTools` 计数、`deferSlot` 槽、`deliverySizes`（每条投递的动作数）、`parseDeliveryCallId`（`mud-<delivery>-<index>`；**T2 自己的调用 id 解析失败 ⇒ 永不可收束**）、`shouldConcludeTurn`（判据 B 四项条件）；投递统一走 `sendDelivery`（在途 ⇒ 槽，否则 `followup`）；断线/释放时清槽与计数。**两条装配路径都必须接**：宿主路径（`attachMudTools(..., channel)`）与 preset 路径（`session/preset.ts` 经 `MudAgentKit.channel(sessionId)`）共用 `runWithDeliveryChannel`。
3. `agent/tools-build.ts` 与 `tests/loop-sim.ts` 的**工具语义不变**：工具保持纯净（defer 由包装器统一做）；模拟器改为**仿真官方包装器**（见 §13.6），因此 `loop-sim-login.spec.ts` 测的是真行为。

**实例（login 精简为 4 步，`replace` 为可选分支）**：投递 d1=[name]、d2=[pass]、d3=[y]（仅当服务器要求替换）、d4=[空命令]；每条投递 `N = 1`，`index = 0 = N-1`。
`name` 执行期间 → 密码/替换提示到达（分支）→ 下一步动作入槽 → defer（不收束）；`pass` 执行期间 → 成功句到达 → 命中 `success` 的进入判据 → 空命令入槽 → defer；空命令执行期间 → GA → `finishFlow`（流程空闲）→ 槽空 → **conclude** ⇒ 整条流程（无论 `replace` 走没走）都在**一个回合**内，模型请求数 = 实际执行的动作数（3 或 4）。
- **流程状态归运行时**：`{ flowId, stepId, armed[], phase, deadline, pendingActions[], pendingEntry[] }`（`diag()` 可见、每次迁移留痕）。

### 19.7 定案与待定

**已定案（作者 2026-09-13）**：

1. **MXP 检测模式发任何命令都能跳过**（作者定案 2026-09-13，后续被 login 精简吸收）：**空命令**即可跳过 MXP 检测 —— 因此在途窗口**允许空命令**（`mud_send` 空命令照常注册窗口、靠 GA 关窗结算），login 的终态步直接发空行收尾（§11）。
2. **GA 与其它判据同权**：任何一步都可直接声明 `ok:[GA]`/`fail:[GA]`（`name.ok=[GA]` 是正确的，§11 旧表述"name/pass/replace 不声明 GA"已作废）。
3. **`succeedStep` 只是里程碑**，流程收束在 `next` 为空的终态步（login 的 `success`）→ 顺序兜底在"结算之后"也要补跑（§19.2）。
4. **分支阶段也要计时器**：一步成功不清掉时间预算 —— `succeedStep` 之后按 `step.timeoutMs ?? flow.timeoutMs` **重新布防**一个计时器（日志文案"等待后继判据超时 (Nms)"），到点即流程超时失败收束 + 留痕 + 交 T2。覆盖"判定节点（`success`）进入后等 MXP/收功句"与"只有条件分支后继、分支行永不到达"这两类静默等待（I4）。
5. **打断/排队的运行时接线**（已落地）：规则动作的 `ActionSpec.interrupts` 声明 → 运行时在**批次内先做打断准入**（`admitRuleHits`）：档位够 ⇒ `FlowRuntime.interrupt()` 复位 + `onInterrupt` 直发 + **在途窗口当场结算为 `interrupted`**（`InflightWindowTable.interrupt`，工具拿到 `{ok:false, settled:'interrupted'}`）+ 事件动作照常投递；档位不够 ⇒ 入 `FlowRuntime.pendingActions` 排队，**流程结束（终态/失败/打断）后由 `drainFlowQueue()` 出队投递**；未声明 ⇒ 不打断也不排队。端到端见 `tests/flow-interrupt.spec.ts`（含 login = 1000 不可打断）。
6. **规则原文核对归作者**（作者 2026-09-13）：`需要创建新人物` / 密码错误 / 登录成功句 / fullme 成功句等**逐字原文**由作者上线前一一核对；实现方不代管、不代为"估计"，只保证**流程结构**正确（步骤图、判据分工、成功/失败/超时三态、打断档位）。
7. **投递通道改用官方 `deferContext`（± `concludeTurn`）**（✅ 已落地 2026-09-13）：两条通道分工、多步按序 defer、`concludeTurn` 仅限 T1 通道、工具不许抛异常 —— 账目 1 回合 / 3 步 / 3 次模型请求（§19.6.1/§19.6.2）。
8. **fullme 流程化**（✅ 定稿并落地 2026-09-13，作者逐条审定）：五步 `request → [stale | prompt] → answer → success`；流程表原文见 §11，八项实现面已全部落地。要点：`request` 只有 fail（"刚刚用过"动态时长）+ 两条条件分支，**无 ok**；`stale` 三连发 `fullme 1` 放弃上一轮后按失败收束；`prompt` 用 `mud_captcha` 工具取图 + 弹窗，以**工具结果**判定；`answer` 三次答错重来（**步内自环、不重置本步 3 分钟总预算**；错码等价于"三连放弃"）、`answer.timeoutMs = 180_000` = 图片有效期（等人工 + 重来 + 收结果共用这一份预算，**不引入 `humanTimeoutMs`**）；`success` 发 `hpbrief` 补状态。**三种收场（取图失败/答错 3 次/预算耗尽）都由下一轮的 `stale` 兜住**，运行时不另记状态。测试：`tests/flow-fullme.spec.ts`（声明面/校验/入口翻转）+ `tests/runtime-captcha.spec.ts`（真链路端到端）。

**待定**：

1. **`pendingEntry` 的端到端用例**：`FlowRuntime` 已实现"流程活跃期间的其它流程入口 → 排队 → 当前流程结束后接续"，但还没有端到端测试（现有 7 例 `flow-interrupt.spec.ts` 覆盖打断、排队动作、超时出队与半截序列，不含入口接续）。
2. **`hpbrief` 应答折叠进 world**（作者：后续一起加）：终态步已发 `hpbrief`，其应答目前只作 tool result；加一条 state 规则把气血/精力折进 world 由 T2 读取。

---
