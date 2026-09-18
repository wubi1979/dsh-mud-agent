---
status: archived
note: 只用于追溯历史决策，不得据此实现或验收
---

# 归档：核心重构方案 v2（行流裁决器 + 在途窗口）——原 `doc/PLAN.md`

> **状态（2026-09-18）**：本方案已收官。W7.1（裁决器抽出 + 分帧器行流化）、W7.2（桥 → 在途窗口）、W7.3（注册收口 + 选路重写 + 落档）全部实施完成，登记于 §17 W7 切片与 CHANGELOG v0.7.5 / v0.9.0。
> **现行事实以 `doc/architecture/` 正式章节为准**：裁决器与在途窗口见 §8（`07-08-t1-bridge.md`），行流与裁决器匹配见 §4–§6（`04-06-perception-routing.md`），流程运行时见 §19（`19-flow-runtime.md`），不变量现行措辞见 §1（`00-core.md`）。
> `doc/PLAN.md` 自 2026-09-18 起改作**新计划起草区**（见现行 `doc/PLAN.md` 头部说明），本文件为其旧内容的归档。

## 勘误（实施后回看，以下 4 条方案论断已被实现证伪）

| 位置 | 方案原文 | 实际实现 |
|---|---|---|
| §0 拍板总纲 1 | 传输层提供行式流，"**不再分帧**" | 分帧仍存在：FrameSplitter 并入裁决器（`runtime/session/adjudicator.ts`，W7.1），开放帧/边界提交/帧内存阀全保留，只是不再外置为自治文件（§8.1） |
| §2.2 窗口声明词汇表 | `boundary.gaCount` 缺省 **1** | 缺省 = **命令条数**（每命令至少 1 个 GA；`inflight.ts` WindowRequest 契约，§8.3） |
| §2.2 窗口声明词汇表 | `criteria` 为 MatchSpec（**多行状态机**） | `WindowCriteria` = 单行正则 `ok` / `fail` 各一条（`inflight.ts`，§8.3） |
| §7 不变量 I4 行 | "官方管道**强制工具返回**" | 官方管道不强制工具返回（`executionMode()` 的 fail-closed 只是并发档位缺省）；I4 的"窗口必有结局"由在途窗口表自身的超时放弃 / 发送守卫 / 断线结算兜底（§8.3/§8.4） |

---

以下为原方案全文（除上述勘误所涉表述外保持原样）。

# 核心重构方案 v2：行流裁决器（统一注册 + 在途窗口）

> 取代 v1 方案（裁决器抽出 + 选路重写）。v1 的裁决器抽出与选路重写结论保留并升级；本版新增：取消分帧、取消命令-应答桥、T1/T2 工具同形。

## 0. 拍板总纲

1. 传输层提供**行式流**（含 GA/EOR 元事件），不再分帧，统一给裁决器。
2. 裁决器统一接收**所有触发规则的注册**，对行流匹配；命中即按注册声明将事件+内容传递。
3. 统一出口五类：**state / direct / delivery（分投器）/ flow / drop**。
4. **取消命令-应答桥**：发命令类 tool 向裁决器注册在途、自己抓取在途期间内容，同样算消费、推进游标。
5. **T1/T2 使用相同的工具、返回相同的结果**（2026-09-18 拍板）：look 等查询工具注册在途、自己声明边界；边界词汇扩展——武装判据（文本）之外，允许 GA 边界、允许 N-GA 边界（如 2GA）。

架构一句话：

> 行流（含 GA/EOR 元事件）→ **裁决器**（统一注册表 + 站序匹配 + 消费记账）→ 五出口：state 折叠 / direct 直发 / **delivery 分投**（lane=t1 渲染、t2 批次）/ flow 编排（步骤链）/ drop 留痕；发命令类 tool 以**在途窗口**向裁决器买判据，命中抓取、GA 关窗、超时放弃——**分帧器与桥两个自治机制消失，内核折叠进裁决器**。

复杂度账：删掉 FrameSplitter 的自治调度与桥的挂起/单槽/闸门/唤醒时序一整套外壳；代价是裁决器本体变大——防上帝对象：内部按注册类别分区（站序），对外只暴露 register / adjudicate（行流入口）/ settle（投递节拍）。

## 1. 裁决器

### 1.1 输入与边界信号

- 输入：行流（传输层完成行化 + 300ms 静默网络装配）+ **元事件**（GA/EOR、断线收尾）。元事件不是文本行，不参与匹配，只驱动窗口关窗与投递节拍。
- **GA/EOR 语义降维但保留**：不再是帧边界，而是 (a) 在途窗口的关窗信号（§2）；(b) 批次投递的结算时机。
- 行流缓冲上限（原帧内存阀）保留在裁决器，防 OOM 兜底。

### 1.2 注册表（唯一注册入口）

注册条目 = `{ id, 类别（站序）, 匹配（MatchSpec，支持多行状态机）, 动作声明 }`。

| 类别（站序） | 来源 | 注册时机 |
|---|---|---|
| ① state 折叠 | perceptionRules state 桶 | register（构造时投影一次） |
| ② event 规则（含 direct:true、interrupts 档位） | perceptionRules event 桶 | register（同上） |
| ③ 在途窗口（动态） | tool execute 发起 | 动态注册/注销（§2） |
| ④ flow arming（driver / 本步 ok·fail 的**常驻部分**） | FlowRuntime.onArmSync | register + 订阅 arming 变化 |
| ⑤ 批次投递参数 | Config（限流、token 预算） | register |

- **站序即认领优先级**：一行按 ①→⑤ 依次问，先命中先认领，每行恰认领一次（I5 扩展为"每行恰被认领一次"：折叠 / 直发 / 窗口抓取 / 动作投递 / 批次投递 / drop）。
- 多行状态机能力保留（I7）：匹配器带多行持久状态，非单行正则表。
- 重连 reset → register() 重挂一次（替换现状三处补丁）；在途窗口清除（§2.7）。
- tx-* 帧标记**消失**：判据声明即归属，不再需要事务帧配对。

### 1.3 出口五类

| 出口 | 动作 | 消息 |
|---|---|---|
| state | WorldModel.patch | 无 |
| direct | CommandQueue.send(actor=system) | 不入窗口；应答由 event 规则匹配 |
| delivery | 分投器（§3） | t1 原文+动作请求 / t2 批次；I6 结算点 ≤ 一条 |
| flow | 流程事件（唤醒/分支/打断/排队/推进） | 流程产生的动作仍走 delivery |
| drop | error 日志 + /mud/diag 计数 | I9 |

### 1.4 持有与节拍

- 持有：行流缓冲、注册表、多行状态机、在途窗口表、**全部计时器**（在途超时/批次限流/结算重试，I8）、recallLines/deliveredAbs 记账（tool 抓走的行也记，含 anchorAbs）。
- 不持有：agent、传输连接、T1 adapter、会话日志。
- 构造：session 壳构造（现 [session.ts#L211/L217/L286](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L211) 的 engine/controller/flow 三件构造留守原位）实例移交裁决器；PerceptionEngine 保留为规则求值器（perceive/engine.ts），FlowRuntime 保留为流程编排器（§4）。
- 结算触发点（settle）：GA/EOR 元事件、窗口结算、T2 限流重试、人工回填、工具结果、agent ready。投递门（awaitingHuman）归裁决器，人工交互面归壳。
- "纯编排"定义：单遍匹配、不直接执行投递副作用（出口由壳的薄 dispatch 执行）；裁决器持有计时器与记账状态，非纯函数。

## 2. 在途窗口（替代命令-应答桥）

### 2.1 生命周期

```
tool.execute(cmd)
  → 向裁决器注册窗口 { criteria?, boundary.gaCount, timeoutMs }
  → await 结算（裁决器在行流中匹配/计数；响应 exec.signal——回合取消则立即返回 canceled）
  → 返回结果（窗口行 / 判据结算 / 放弃原因）
```

先例：验证码 mud_captcha 已是"工具不返回等结果"模式（v0.7.3 ask-human 同回合挂起），本方案将其推广为所有发命令工具的统一模式。

### 2.2 窗口声明词汇表（本轮拍板的固化）

| 字段 | 说明 | 缺省 |
|---|---|---|
| `criteria.ok / criteria.fail` | 文本判据（MatchSpec，多行状态机，同款武装判据） | 无 |
| `boundary.gaCount` | **N-GA 边界**：第 N 个 GA 后窗口关闭（N=2 即"2GA 后为边界"，服务端回显段 + 数据段场景） | 1 |
| `timeoutMs` | 放弃计时 | step 覆盖 > tool 内置 > Config 缺省 |

声明归属：**tool 注册时内置声明**（如 look=窗口型 1GA），**流程表 step 可覆盖**（§4）。

### 2.3 结算优先级与两种形态

结算优先级：**判据命中 > 窗口关闭 > 超时 > 断线**。每个窗口必有结局（I4 无静默）。

| 形态 | 声明 | 结算 |
|---|---|---|
| **窗口型**（look/hp/score 等查询） | 无判据，仅 boundary.gaCount | 关窗 = 成功，窗口内行 = 工具结果 |
| **判据型**（流程步/状态变更类） | ok/fail 判据 + gaCount 兜底关窗 | 判据命中 = 成功/失败；关窗未命中 = 失败（"判据未等到"，原桥 GA 结算语义） |

### 2.4 T1/T2 工具同形（本轮拍板）

- 同一工具集、同一执行路径（tools/pre-execute 闸门 → 执行 → 在途窗口）、同一结果结构。
- **T2 调 look 直接拿到应答内容**（原：返回"已发送"→ 应答行进下一批投递 → 隔一轮）。省一轮投递，查询-应答回路变同步。
- I15 扩展：**工具结果自洽**——T2 拿到工具结果能自己决定下一步；T1 契约检验同步覆盖工具结果形态。
- T1 仍是无状态渲染器：投递消息仍带动作请求（lane 语义不变），工具结果只是多了内容承载。

### 2.5 与规则/打断/人工的交互

- **event 规则优先认领**（站序 ② < ③）：look 输出里命中 event 规则的行被规则认领（独立动作投递），不进窗口结果——与现状"被消费的行不进批次"一致。
- **打断（I14）**：interrupts > 流程 priority → 在途 tool 被通知返回 interrupted（事件动作随结果 defer）→ 流程复位。与现状"打断的事件动作随 interrupted 结果 defer"等价。
- **awaitingHuman**：人工输入 = 判据来源之一（验证码先例并入统一机制）；投递门控归裁决器。

### 2.6 单在途保证（I11/I12 的归宿）

官方工具管道**顺序执行** ⇒ 同时最多一个 tool 在途 ⇒ 单挂起（I11）与挂起期闸门（I12）**被官方机制取代**（文档记"取代"，非删除）。直发命令不注册窗口。

### 2.7 重连

reset → 清在途窗口表 → 通知在途 tool 返回失败（连接断开）→ 流程失败收束/重试。recall/deliveredAbs 记账保留。

### 2.8 命令序列化与 GA 计数隔离（设计洞补丁）

- 问题：窗口的 gaCount 计数沿行流全局——若在途窗口开着时**插入直发命令**，服务端对该命令的应答 GA 会被计入窗口，导致提前关窗/计数错乱（原桥 tx-* 帧配对防的就是这类误归属，取消帧后必须用别的规则补上）。
- 规则：**在途窗口开启 ⇒ 直发命令队列延后到窗口结算后再发**。打断命令（halt）不受影响：打断时序是"通知在途 tool 返回 interrupted（窗口已结算）→ 发 halt"，顺序天然满足。
- 附带收益：上一命令的尾巴 GA 不会误入下一窗口（工具顺序执行 + 直发延后 ⇒ 窗口注册时行流内无未归属应答），GA 计数从此可信。
- 注册期校验：`gaCount >= 1`；`timeoutMs` 缺省链见 §2.2。

### 2.9 可观测性与留痕（替换桥活动表）

- 桥的 exec.signal 活动表随桥删除，职责由**在途窗口表**接替：暴露 `/mud/diag`（tool、criteria?、gaCount、elapsedMs、status），实时可见"哪个窗口在等什么、等了多久"。
- I4 留痕：每个窗口的结算结局（成功/失败/放弃/canceled）进 diag 计数；窗口建立与结算事件日志。

## 3. 分投器（delivery）

- lane 语义保留：t1 = 原文 + 动作请求（mud-t1 渲染 tool-call）；t2 = 批次（真实模型，`t2DeliverIntervalMs` 限流）。
- I6：一个结算点 ≤ 一条投递消息；standalone（帧内命中/人工回填）是独立投递点，物理合流不算违反——W7.3 对齐 I6 措辞（结算点定义 + standalone 例外）。
- 现状 deferSlot 机制保留到 W7.3，之后效应化为官方原语：inFlight ? inject : followup（原 v1 S2 结论顺延）。
- 批次装配逻辑原样沿用：残余行聚拢 + token 预算裁剪（原 §5 投递单位语义）。

## 4. 流程机（flow）

- 保留：步骤链推进、分支、pending entry、单流程互斥（I10）、打断优先级（I14）、timeoutMs。
- 单步的命令-应答配对**移交在途窗口**：流程步动作 tool 在途时，ok/fail 判据随窗口注册（动态）；driver 判据按 arming 常驻注册；"唤醒"对象从流程机变为在途 tool。
- step 表新增 `boundary?: number`（N-GA 兜底关窗，覆盖 tool 内置声明）。
- tool 返回成功 → flow 推进下一步 → 新动作再投递。**flow 与 tool 分工：流程机管"链"，在途窗口管"单步应答"。**

## 5. 现有代码 → 新结构映射

| 现有位置 | 现状 | 新归属 |
|---|---|---|
| frame-splitter.ts | 切帧 + 通知订户 | 并入裁决器（行流 + 元事件 + 缓冲上限）；GA/EOR 变关窗/结算信号 |
| session.ts:onFrameCommitted ①–⑤ | 五站单遍 | 裁决器行流匹配（站序进注册表类别） |
| session.ts:runDirectHits / parkExternalHits / admitRuleHits | 直发/待人工/打断准入 | 上移裁决器（direct 出口 / awaitingHuman / I14 判定） |
| bridge.ts（CommandResponseController） | 事务配对 + 挂起/唤醒/闸门/放弃 | **删除**；内核（判据注册/命中结算/计时）折叠进在途窗口（§2） |
| delivery-channel.ts | deferSlot/inFlight/ledger | 分投器（保留到 W7.3，后效应化） |
| perceive/engine.ts（PerceptionEngine） | state/event 匹配 | 保留为规则求值器（多行状态机在此） |
| flow.ts（FlowRuntime） | arm/判定/推进/打断 | 保留为流程编排器；onArmSync 消费方改裁决器 |
| lane.ts 选路 | ModelSelectionRef 预写 | 重写：pre-step 记 lane（跨步沿用）+ onLane 广播 + agent/request(prepend) 拦截（t1→mud-t1；非 t1 仅 T1 占位时还原 realModel，否则放行并更新记忆——doc §6 防御条款，不踩用户手动换模型）；**实现回归 doc §6/I3 已写明的机制**（v0.4.x→v0.6.x 改 ref 方案未登记 CHANGELOG，本轮补登记） |
| sink.preDeliver / types.ts:preDeliver | 投递前预写（turn=1 预热补丁） | 删除 |
| agents/mount.ts | deferContext/concludeTurn | 基本不动 |

## 6. 切片（本重构登记为 §17 W7 切片，内部步骤全局顺序递增，每步全包绿）

**W7.1 裁决器抽出 + 分帧器行流化**（等价迁移）
- 新建 runtime/session/adjudicator.ts：行流 + 元事件入口、五站匹配（站序不变）、记账、投递节拍；分帧器退役。
- 验收：mud-core 全包 spec 全绿（30 个 spec 文件；例数以当次 vitest 汇总为准，W5/W6 登记 316/333 已漂移）；loop-sim 冒烟：1 回合、T1 步骤 t2Calls===0、同回合空续步不误落 T2。

**W7.2 桥 → 在途窗口**（机制替换）
- 全部发命令工具统一改造：窗口声明 + await 结算（含 T2 查询工具，T1/T2 同形拍板一步到位）；删挂起/闸门/单槽/事务帧标记；验证码统一进新机制。
- 验收：flow 全链 spec（login/fullme/interrupt/ownership）+ loop-sim 账目对照（T2 查询回路省一轮投递）+ 真机抓包核对各命令实际 GA 数，落 tool 内置声明表。

**W7.3 注册收口 + 选路重写 + 落档**
- 打断/arming/direct 并入 register() 唯一入口；lane.ts 选路重写（§5）；删 preDeliver。
- 文档：§4–§8 整章重写（§8 分帧器与事务 → 行流裁决器与在途窗口）；I5/I6 措辞更新、I11/I12 记"被官方工具顺序执行取代"、I15 扩展工具结果自洽；术语表重写挂起/唤醒/桥条目、新增裁决器/在途窗口/分投器，并与"分帧器 = 唯一边界裁决者"旧表述清理；**登记 v0.9.0（X 位变更）+ §17 W7 切片**。
- 随手勘误（沿 v1 结论）：§18.11 concludeTurn"已定不接"与代码矛盾（v0.4.0 defer 落地已接线判据 B/C）→ 新增已定条目取代 #11；§17 W1 注记 `perception/engine.ts` → `perceive/engine.ts`；I2 补注 followup/inject 均官方原语；CHANGELOG 纲目格式。

## 7. 不变量影响清单

| 不变量 | 影响 |
|---|---|
| I4 | 强化：窗口必有结局（判据/关窗/超时/断线），官方管道强制工具返回 |
| I5 | 措辞扩展："每行恰被**认领**一次"（折叠/直发/抓取/投递） |
| I6 | 措辞对齐（结算点定义 + standalone 例外） |
| I7 | 多行状态机归裁决器，语义不变 |
| I8 | 计时器全归裁决器（会话内），更彻底 |
| I9 | drop 出口落实 error + diag |
| I10 | 流程机保留，不变 |
| I11/I12 | **被官方工具顺序执行 + 在途窗口取代**（文档记录归宿） |
| I13 | 判据互斥校验移交窗口注册/流程表装配期 |
| I14 | 打断保留（在途 tool 通知返回 interrupted） |
| I15 | 扩展：投递消息 + **工具结果**双自洽 |
| I1–I3 | 不受影响 |

## 8. 风险与待确认

1. **N-GA 声明表需真机核对**：哪些命令真的跨多 GA（回显段 + 数据段）？W7.2 先抓包核对再落 tool 内置声明表，拍脑袋定 gaCount 会把窗口关早/关晚。
2. **T2 上下文布局变化**：应答内容从"批次（user message）"挪到"工具结果（tool result）"——token 量相同、attention 模式略变，属可接受行为变化，loop-sim 对照验收。
3. **工具执行时长 = 应答时长**：官方管道对长在途无障碍（验证码先例数分钟级），但 T2 连续查询节奏从"限速 + 投递一轮"变"同步等待"——总时延应下降，用账目验证。
4. **窗口与规则认领的观感**：规则认领的行不进工具结果，T2 从独立投递消息获知——与现状一致，验收时确认无"结果缺行"误判。
5. **分页 pager:continue 保持直发**，不进窗口；受 §2.8 序列化约束，在途窗口开着时延后发送。
6. **GA 计数污染**已由 §2.8 命令序列化规则补上（取消帧后 tx-* 配对消失的替代防线），W7.2 验收需含"直发延后"用例。
7. **timeoutMs 覆盖链**：step > tool 内置 > Config 缺省，装配期校验。
8. 直发命令不入窗口、应答由 event 规则匹配——自洽；awaitingHuman 门控归裁决器、交互面归壳。
