# 核心重构方案：裁决器（Adjudicator）抽出 + 选路重写

## 0. 架构总纲（已拍板）

T1 = 无状态单例渲染器（打印 tool-call，不反查运行时状态，I15）。每会话一个 Adjudicator，持有全部表注册，对每一帧从**五类决策词汇表**产出决策——同帧可组合（一帧可同时写 world、直发并投递），不是五选一互斥：写 world / 直发命令 / T1 回答 / T2 回答 / 丢弃（drop，I9）。

四选一是现状代码里已存在但从未被命名的四种输出；drop 是补齐的第五类——现有链中已存在三类合法丢弃（T1 关闭丢暂存动作、T2 关闭清 pending、待决超限丢行），它们不属于四选一中的任何一种，但 I9 要求丢弃必须留痕。没有 drop，"单一出口"名不副实。

| 决策 | 现状代码位置 | 官方产物 |
|---|---|---|
| 写 world | onFrameCommitted ① engine.feed().stateHits → state.patch | 无消息（只落 WorldModel） |
| 直发命令 | ② runDirectHits（direct:true 命中） | 命令入队，actor=system，不投递 |
| T1 回答 | ⑤ splitDelivery 的 reflex 段 + pendingActions → deliver(...,'t1') | mud-owned 消息 + source.actions → mud-t1 渲染 |
| T2 回答 | ⑤ 批次段 → channel.send(...,'t2') | mud-owned 消息 → 真实模型 |
| 丢弃（drop） | T1 关丢动作 / T2 关清 pending / 超限丢行 | error 日志 + /mud/diag 计数（I9 原文口径；现状部分丢弃只有 debug，重构时对齐） |

关键判断：重构本质不是新增机制，而是把拆散在 session.ts / PerceptionEngine / FlowRuntime / delivery-channel 四处的"五站消费链"抽成一个显式的、每会话的裁决器，并把注册集中到它手里。

## 1. 裁决器精确定义

### 1.1 职责

```
FrameSplitter.onFrame(frame)
        │
        ▼
   Adjudicator.adjudicate(frame)   ← 单遍编排（内部持有 engine/flow/bridge；入口即取样 inFrame）
        │
        ▼  Decision[]（五类决策词汇表，同帧可组合）
   Dispatcher（session.ts 内的薄壳）
        ├─ world  → StateService.patch
        ├─ direct → CommandQueue.send(actor:system)
        ├─ t1     → DeliveryChannel → 官方 followup/defer（S2 改 inject）；source.actions 随消息走
        ├─ t2     → DeliveryChannel → 官方 followup（限流）
        └─ drop   → error 日志 + diag 计数（I9）
```

入口词汇：adjudicate(frame)（帧提交）+ settle(reason)（非帧结算触发：人工回填 deliverStandalone、工具结果 noteToolResult、onAgentReady 冲刷、hold 释放、T2 限流重试）。两者共用同一决策核心；帧提交只是结算触发点之一，"唯一入口"指唯一决策出口，不是唯一结算触发点。

时序契约（I5/I6 由链的单遍结构保证，须写成类头注释）：
- 五站顺序 ①状态折叠 → ②规则触发 → ③事务结算 → ④流程判据 → ⑤残余记账/投递，禁止重排；
- inFrame 由裁决器在 adjudicate **入口取样**（现 [session.ts#L1011-1013](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L1011-L1013)，① 之前、必在 ③ 之前——GA/EOR 结算会翻转 inFlight），不以参数传入；settle() 路径无需 inFrame；
- "纯编排"指单遍、不直接执行投递副作用（Decision 交 Dispatcher 执行）；裁决器持有计时器与链内状态，不是纯函数（§6.4）。

横切状态归属（session.ts 五站链与壳职责之间）：

| 状态 | 裁决器侧 | 壳侧 | 归属 |
|---|---|---|---|
| awaitingHuman | settle 的投递门（暂停全部投递） | captchaWaiter/人工回填/弹窗/看门狗停表 | 投递暂停语义（pauseDelivery/resumeDelivery）归裁决器；交互面归壳 |
| recallLines / deliveredAbs | 站⑤记账写 | mud_recall 工具读 | 裁决器持有，壳只读 |
| pending / pendingActions / consumeTo / standalone | 纯链内 | — | 整体搬入 |
| untilMarkerIds | ③ 事务结算路由（tx-* 只对在途 until 事务的帧标记结算） | 重连作废 | 裁决器；tx-* 是事务期动态武装，不进 register() 注册表 |
| tools / gateRules | runDirectHits 需要 | buildMudTools 构造 | 裁决器持引用，构造归壳 |

持有（每会话）：PerceptionEngine、FlowRuntime、CommandResponseController（三者现由 session 壳构造，[session.ts#L211/L217/L286](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L211)，S1a 构造留守原位、实例移交裁决器持有；重连 reset 时经 register() 重挂一次）。
不持有：agent、agent 解析、会话日志、T1 adapter（全局或薄壳）。

### 1.2 注册

Adjudicator.register() 是唯一注册入口，把表编译进分帧器：

| 注册项 | 来源表 | 现状散落位置 | 新归属 |
|---|---|---|---|
| 打断标记（常驻） | perceptionRules[].action.interrupts | session.ts:armInterruptRules（3 个调用点：构造后 + 2 处 reset 后） | 裁决器.register |
| 流程 arming 标记 | flows[].steps[].driver/ok/fail | FlowRuntime.onArmSync → session.ts:syncFlowMarkers | 裁决器.register（订阅 flow 的 arming 变化；全量替换语义天然免补） |
| state/event 规则分桶 | perceptionRules[].lane | PerceptionEngine 构造 | 裁决器.register（构造时投影一次） |

重连时 register() 重挂一次，替换现在"reset 后各自重挂"的三处补丁（[session.ts#L646-650](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L646-L650)、[L687-688](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L687-L688) 及构造处）。

### 1.3 决策语义（保持 I5/I6 不变量）

一帧可产出多条 Decision（五类按站序依次判定、可同时命中），唯一的互斥约束是 I6 原文口径"**一个结算点 ≤ 一条投递消息**"，外加每行恰投一次（I5）。五站对应五类：
1. world：state 折叠（不投递，不参与消费边界）
2. direct：direct:true 命中立即执行（命中行折叠）
3. t1：被消费的行（abs ≤ consumeTo）原文 + 动作请求
4. t2：残余行批次（可延后到下次 settle，受 T2 限流）
5. drop：T1 关丢动作 / T2 关清 pending / 超限丢行（error 日志 + diag 计数，I9）

T1 与 T2 在同一帧可同时出现（T1 走被消费段、残余 carry 留待 T2），但同一投递点只发一条。

I6 口径与现状对齐：[settle#L1226](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/runtime/session/session.ts#L1226) 一次 settle 可投两条（先 flushStandalone 再投批次）——standalone 是独立投递点（帧内命中/人工回填），与批次物理合流不算违反 I6。Decision 执行时机因此分两档：
- immediate：standalone / 帧内动作，独立投递点，不受 I6 批次约束；
- settle：受 I6 / T2 限流 / 人工门控。
S3 改文档时把 I6 措辞与实现对齐。

## 2. 选路重写（官方机制已源码级确认）

官方 model-selection.js（node_modules 0.1.x 与 harness 09-15 主干逐行一致，昨天的更新对 LLM 切换零影响）：

```js
const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();          // 先放行到最内层
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    // 无条件覆盖 provider/model
});
```

先校正一个定性：**S1b 不是发明新机制，而是让实现回归 doc §6/I3 已写明的机制**。doc §6（`agent/request` prepend 拦截 + realModel 记忆还原）与 I3 括号（`agent/request` + `prepend`）描述的就是拦截器方案；此后代码改走 `ModelSelectionRef` 预写方案（pre-step 写 current + presetLaneSelection 预热），**该切换在 CHANGELOG 无登记**（按 selectionRef/ModelSelectionRef/presetLaneSelection 检索无命中），doc §6 也从未同步——本身就是一次未登记的文档-代码漂移。S1b 消除漂移并补登记。

确认三点：

1. **"最外层最后拍板"语义成立**：官方拦截器就是"先 await next() 再覆盖"，且官方 `agent/request` 处理器**未用 prepend**（model-selection.js L91-107；只有它的 pre-step notice 用了），我方 `{prepend: true}` 拦截器必处瀑布最前端 = 最外层 = 最后拍板，与注册先后无关。doc §6 的历史教训（不抢最外层则 T1 被覆盖回真实 LLM，每 2s 一次 agent/request 而无任何 [t1] 输出）仍值得真机复验一次。
2. **时序比草案预想更好**：官方 runtime-types 明确 agent/request 在 "after assembly and step/start" 运行，agent/pre-step 是 step admission。"pre-step 认领消息记 lane → 同一步的 request 读 lane 覆盖"同 step 闭环，turn=1 step=1 天然被覆盖——presetLaneSelection 存在的根因（turn=1 step=1 预热窗口：pre-step 在 assemble 之后，写入只对下一个 step 生效，首回合 T1 落到真实模型直接 "no API key"）被真正消灭，而不是绕开——此即 presetLaneSelection 可删的论据。
3. **realModel 记忆必须保留，还原语义按 doc §6 防御条款执行**：官方侧会把一次请求实际生效的 provider/model 记成会话模型（logged header），T1 请求后 header 即被污染，lane≠t1 时若不还原会永久卡在 T1 adapter。语义（§6 原文）：**仅当 next() 是 T1 占位（provider === mud-t1）时还原 realModel；否则原样放行并更新记忆**——不能无条件覆盖，否则会踩掉用户手动换模型。lane.ts 现有 realModel 追踪（[lane.ts#L263-270](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/agents/lane.ts#L263-L270)：从 requestHeader 跳过 T1 残留 + agentOptions 兜底）保留，取值时机移入 request 拦截器。原草案"覆盖 provider/model"的笼统表述按此修正。

补充源码级发现：
- 官方 session-controller 的 selectForNextRequest + consumeSelection 是"会话级切换意图"原语（append 持久化 selection 事件 + picked 在 request/header 落盘时自动清空）。T1 是"消息级路由"，根本不同型，**不能**用这套对齐官方——它会把 T1 污染从 loggedHeader 读回来（picked 清空后 getter 回读链：picked 空 → loggedHeader → default）。
- selectionFor 本身是 public 方法，lane.ts 穿透的 private 只是 agents 成员——比 lane.ts 注释"类型断言绕过 private"描述的危害小。S1b 删掉 trySelectionRef 后这条自然消失。
- 免费简化：request/header 持久化了每步的 provider/model，T1/T2 路由留痕官方日志已有。S3 时自研 channel ledger 只保留动作级账目（call-id → delivery → ruleId），lane 级留痕可不建。

## 3. 现有代码 → 新结构映射

| 现有位置 | 现状 | 新归属 |
|---|---|---|
| session.ts:onFrameCommitted ①–⑤ | 五站单遍 | 上移为 Adjudicator.adjudicate |
| session.ts:runDirectHits | 直发 | 上移（→ Decision.direct） |
| session.ts:parkExternalHits / admitRuleHits | 待人工 / 打断准入 | 上移（内部状态 + 决策） |
| session.ts:scheduleSettle/settle | 边界重试 + 投递编排 | 拆分：lane/批次决策 → 裁决器；实际发送 → Dispatcher |
| session.ts:deliver/deliverStandalone/flushStandalone | 投递 | Dispatcher（薄） |
| session.ts:armInterruptRules/syncFlowMarkers | 注册 | 裁决器.register |
| FlowRuntime | arm/判定/推进/打断 | 保留为裁决器的流程求值器（注册改由裁决器做；onArmSync 消费方从 session 改为裁决器） |
| PerceptionEngine（perceive/engine.ts） | state/event 匹配 | 保留为裁决器的规则求值器 |
| CommandResponseController（bridge） | 命令-应答 | 保留为裁决器的事务求值器 |
| delivery-channel.ts:deferSlot/inFlight/ledger | 通道机制 | Dispatcher（S2 瘦身：inject/followup 分流） |
| lane.ts:trySelectionRef/presetLaneSelection | 私有 ref 选路 | 删除 → pre-step 记 lane + agent/request(prepend) 路由；realModel 记忆保留并移入 request 拦截器（仅 T1 占位时还原，§2.3）；onLane 广播（[lane.ts#L252](file:///d:/Code/dsh-mud-agent/packages/mud-core/src/agents/lane.ts#L252)，installMudToolGate 的 T1 免限速依据）与 provider 注册、消息声明一并保留 |
| sink.preDeliver / types.ts:preDeliver | 投递前预写 | 删除 |

## 4. 分阶段实施

### S1 — 裁决器抽出 + 选路重写（可独立验收，内部切两刀）

裁决器抽出是纯等价迁移（全量测试可证），选路重写是行为变化（新拦截器 + 顺序依赖），捆绑验证时红了无法二分。S1 内部两个 commit、两个验证点：

**S1a — 裁决器抽出 + 注册集中 + 删 preDeliver（不动 lane 机制）**
1. 新建 runtime/session/adjudicator.ts：迁移五站消费链 + runDirectHits/parkExternalHits/admitRuleHits + settle 决策核心；Decision 五类含 drop；横切状态按 1.1 表搬入。
2. session.ts 瘦身：onFrame → adjudicate → dispatch；保留 sink/queue/看门狗/人工环节等会话壳职责；新增 dispatch。
3. 注册集中：删除 armInterruptRules/syncFlowMarkers 及三处 reset 补丁，改 Adjudicator.register()（订阅 flow arming 变化）。
4. 删 sink.preDeliver 与 types.ts:preDeliver。
5. assemble.ts：删 preDeliver 接线；裁决器创建与注入。

验收：mud-core 全包 spec 全绿（30 个 spec 文件；W6 登记 333 例、W5 登记 316 例——硬编码例数已漂移过，以当次 vitest 汇总为准。runtime-delivery / runtime-defer / runtime-direct-action / runtime-captcha / flow-* / response 等都直接打五站链，全包绿才是等价迁移验收面）；loop-sim 与 loop-sim-login 只是冒烟：1 回合、T1 步骤 t2Calls===0、同回合空续步不误落 T2；t1-adapter.spec.ts 全绿。

**S1b — 选路重写**
1. 重写 lane.ts（本质 = 实现回归 doc §6 已写明的机制，§2）：删 trySelectionRef / presetLaneSelection / ModelSelectionRef 写入；pre-step 认领消息记 lane（跨步沿用）+ onLane 广播（T1 免限速依据）+ agent/request(prepend) 拦截器：lane=t1 → 覆盖为 mud-t1；lane≠t1 → 仅当 next() 是 T1 占位时还原 realModel，否则原样放行并更新记忆（§6 防御条款，不踩用户手动换模型）；保留 provider 注册与消息声明。
2. 删除 lane.ts 对 sessionController 私有 agents 成员的穿透（trySelectionRef 删除后自然消失）。

验收：loop-sim / loop-sim-login 重跑 + 真机复验 prepend 最外层生效（§6.1）；t1-adapter.spec.ts 全绿；无私有 API 依赖；本轮机制切换在 CHANGELOG 补登记（v0.4.x→v0.6.x 的 ref 方案切换从未登记）。

### S2 — 投递统一（Effect → 官方原语）

- DeliveryChannel.send：inFlight ? agent.inject(msg) : agent.followup(msg)；删 deferSlot（inject 落官方持久 next-step inbox，可恢复）。注意 mount.ts 实测踩过的坑：beginToolCall 漏接时投递静默走 followup（账目停在 3 回合），重构后此坑由 S2 验收直接兜住。
- shouldConcludeTurn 改读官方 inbox（nextTurn/nextStep 皆空）+ 保留最薄的动作计数（mud-<delivery>-<index> 的最后一条判定）；**流程条件必须保留**：flow.state() !== null / hasQueuedActions——官方 inbox 看不到流程机在推进，否则流程挂起期回合被掐。
- beginToolCall/endToolCall 的 inFlight 尽量从官方状态派生（待验证：agent.inbox 是否可直接判定工具在途；不能则保留薄包装计数）。

验收：runtime-defer.spec.ts 改为断言 agent.inbox.nextStep 非空；账目仍为 1 回合。

### S3 — 落档与文档

- 官方会话日志为唯一记录；自研 log-service.ts 降级为诊断边车；channel ledger 只留动作级账目（§2 免费简化）。
- **登记 v0.8.0**（X 位变更：会话运行时核心结构）+ §17 新增 W7 切片（仓库惯例：每个里程碑一个切片行）。
- 00-core：§2 术语表新增"裁决器（Adjudicator）/ Dispatcher / Decision"，并与"分帧器 = 唯一边界裁决者"（§2 帧条目）显式区分——分帧器裁帧边界，裁决器裁消费链输出；I6 措辞与实现对齐（结算点定义 + standalone 例外，§1.3）；I3 括号更新为最终选路机制（pre-step 认领 + request 还原）；drop 路径落实 I9。
- §6 L3 选路整节重写为最终机制（§2），清除 ModelSelectionRef 时代残留。
- **勘误 §18.11 与 §17 W4/W5 陈旧注记**：§18.11 记 `exec.concludeTurn`"已定不接"（2026-09-12），但 CHANGELOG v0.4.0 defer 落地条目已接线判据 B/C 且现行代码如此——新增一条 §18 已定条目取代 #11，并更正 W4 行"concludeTurn 已定不接"注记。
- 随手勘误：§17 W1 注记的 `perception/engine.ts` 实为 `perceive/engine.ts`（v0.6.1 源码目录重组更名）。
- I2 措辞补注：followup/inject 均为官方原语（S2 后）。
- 更新 doc/architecture/{04-06,07-08,19} + doc/CHANGELOG.md（纲目格式）。

## 5. 文件级改造清单（S1）

| 文件 | 动作 |
|---|---|
| runtime/session/adjudicator.ts | 新建（消费链 + 注册 + Decision 五类） |
| runtime/session/session.ts | 瘦身：删迁五站/直发/准入/注册；保留壳职责；新增 dispatch |
| runtime/session/types.ts | 删 preDeliver；ActionRequest/fillSlots/parseDeliveryCallId 保留（或移入裁决器） |
| agents/lane.ts | 重写（回归 doc §6 机制）：删 trySelectionRef/presetLaneSelection/ModelSelectionRef 写入；pre-step 记 lane（跨步沿用）+ onLane 广播；agent/request(prepend) 拦截（t1 → mud-t1；非 t1 仅 T1 占位时还原 realModel）；保留 provider 注册与消息声明 |
| agents/mount.ts | 基本不动（deferContext/concludeTurn 已是官方用法） |
| runtime/flow/flow.ts | 保留；onArmSync 的消费方从 session 改为裁决器 |
| runtime/session/delivery-channel.ts | S2 才动；S1 仅去掉 preDeliver |
| assemble.ts | 删 preDeliver 接线；裁决器创建与注入 |

## 6. 风险与待确认

1. agent/request prepend 语义：官方 request 处理器未 prepend（源码确认），我方 {prepend:true} 必处瀑布最外层，与注册先后无关（§2.1）；风险实为低，但按 doc §6 历史教训仍真机复验一次（不抢最外层 ⇒ T1 被覆盖回真实 LLM）。
2. inject 不唤醒：仅"工具在途"用 inject，空闲必须 followup（否则消息滞留 inbox）。
3. inFlight 派生：能否从官方状态判定工具在途，需在 S2 验证；不能则保留薄包装计数。
4. 桥的计时器在裁决器内（每会话），符合 I8；但裁决器因此不是纯函数——纯化是 S2/S3 的渐进目标，S1 只做"单一决策出口 + 单一入口动词"。
5. shouldConcludeTurn 的 S2 改造必须保留流程条件（flow.state() / hasQueuedActions），§2 已写明。
6. T1 路由留痕官方日志已有（request/header 持久化 provider/model），S3 时 lane 级账目不建，见 §2 补充。

## 7. 已确认拍板

1. 裁决器边界：engine / flow / bridge 三者都纳入裁决器（实例每会话；构造留守 session 壳原位、实例移交裁决器持有；重连经 register() 重挂）。
2. S1 含选路重写：把"裁决器抽出"与"删 lane.ts 私有 ref"合并为 S1（收益大、风险集中、可一次验证）；内部切 S1a/S1b 两刀隔离风险，不改变验收口径。
3. 定性：S1b = 实现回归 doc §6/I3 已写明的机制并补登记（消除 v0.4.x→v0.6.x 未登记的选路方案漂移）；本重构登记 v0.8.0 + §17 W7 切片。
