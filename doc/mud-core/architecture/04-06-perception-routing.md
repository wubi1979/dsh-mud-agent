---
sections: [4, 5, 6]
status: active
deps: ["§1", "§2"]
impl: packages/mud-core/src/perceive/
---

## §4 L1 行级感知

**目标**：规则语义与"文本块/分包/截断"彻底解耦（I7），命中可被可靠交付（I4）。

| 项 | 设计 |
|---|---|
| 实例 | **每会话一个** `PerceptionEngine`（消灭进程级匹配器单例，I8）。**v0.9 W7.3**：实例由行流裁决器 `register(registration)` 投影创建（注册收口，§8.8）—— 连接重建/切换 = **引擎实例整体重建**，不再走 `reset()`。**v0.11.2**：**规则表也按会话构造**（`perceive/rules.ts` 的 `createDefaultPerceptionRules()`）—— 规则里的 `guard` 闭包带运行态（`pager:continue` 的 1s 翻页节流），模块级共享一份数组会让其被所有会话共用（会话 A 的翻页静默压住会话 B），同属 I8 |
| 输入 | 行序列（来自文本块的行化结果，含工具应答行——与游戏输出同源） |
| 状态 | 多行状态机**持久**（跨文本块、跨窗口连续）；不再有"镜像克隆式判类" |
| 输出 | `feed(lines) → { stateHits, directHits, hits, holding, consumeTo }`；`consumeTo` = 最后一次命中锚点在本批行内的位置 |
| state 桶（**状态抓取桶**，v0.11.0） | 抽取 → **同步 `world`**，仅此一个效果：**不推进水位、不折叠内容、不消费行**（§5/§19.7）；状态行保留在行流中，作为普通行被后续 span/批次原样包含（"行流无隐藏行"） |
| **流程行判据（v0.4.0；v0.11.0 形态 C 收窄）** | 流程激活期的**会话侧**判据只剩两类：① **入口 driver**（空闲时 arm —— 模型只在回合里活着，"流程该不该启动"必须有人在无回合时盯着行流）② **分支等待期后继 driver**（`succeedStep` 时布防）。**本步的 `classify`（ok/fail/后继 driver）不再进 arming** —— 形态 C 下它们随窗口的**关闭触发**走、由**驱动器**在推进点复判（§19.2/§19.3）。两者都注册为裁决器武装标记（§8.5）。**流程判据只在流程激活期存在**，不写进静态规则表（不与 trigger 重复） |
| holdDelivery | 声明 `holdDelivery` 的多行规则**捕获未完成**时，本块不投递（半截事务不给真实 LLM）。状态持久后此机制跨窗口有效；超时由 `holdTimeoutMs` 兜底释放（规则级开关，I6） |

**多行规则的写法约束（血泪）**：`multiline: true` 时 `match.patterns` 的每一条都是**有序条件**（`buildMultiConds`），而一行只能推进一个条件（`stepMulti`）—— 所以**单行提示必须写成一条正则**，写成两条就永远凑不齐（例：登录的"赶出去/取而代之"确认提问，实录为一行）。真要两条条件，第二条必须落在**后续行**。同理，单条件多行规则永远不会 `holding`（种子命中即完成，`multiStates` 为空），`holdDelivery` 对它不生效。

**删除**（原实现）：`matchDry`（生产路径）、`cacheLines`/行集表、`resolveLines`、按文本反查的"最长前缀"启发式。

<!-- 待补：PerceptionEngine 的公开接口签名与错误语义（error 计数口径） -->

---

## §5 L2 投递节拍（单流切分）

**结算点（v0.6.0 = 帧提交点，§8.2）**：GA/EOR、武装判据命中、帧内存阀（行数上限）、断线收尾 —— 全部由行流裁决器裁决（**唯一边界裁决者**，§8.0；v0.9 W7.1 分帧器并入裁决器）；300ms 静默降级为**网络装配粒度**（裁决器装配阀 `autoFlushMs`），不再是消费边界。**v0.11.0**：帧内行中归在途窗口的部分（工具应答）不进投递（§8.2 站⑤ span 过滤）。

**切分算法**（I5/I6）：

```
segment = 遗留段 ++ 本文本块的行
若 segment 中存在**动作请求**（规则命中的 action / 流程**入口**步动作）：
    投递消息体 = segment[0 .. consumeTo]        lane=t1（原文 + 动作请求）
    遗留段     = segment[consumeTo+1 ..]
否则：
    批次       = segment                        lane=t2
    遗留段     = ∅
每个结算点最多投递一条消息。
```

- **前导上下文**（动作之前的行）归 T1 投递消息体：它 precede 该动作，属该次动作的上下文。
- **投递消息携带原文**（决定：携带）：转录完整 → 后续 T2 回合的上下文不缺；T1 对投递消息**只按动作请求渲染 tool-call**（流程**后继步连投递都没有** —— 由驱动器发布槽、T1 按槽渲染，§7/§19.3），而 T2 拿到同一条消息能自行决定（I15）。
- **投递形态（作者定名 2026-09-13）**：**原文投递** = 消息体带原文（上面的 `segment[0..consumeTo]`）+ 动作请求（T1 规则命中 / 流程**入口**步）；**动作投递** = 无原文可带，只投动作请求 —— 适用帧内命中、人工回填、结算驱动、排队出队。日志与决策栏一律用这两个名字（旧称"反射消息 / 帧内独立投递"）。
- **I6 口径（v0.11.0 对齐）**："一个结算点 ≤ 一条投递消息"中的**结算点 = 帧提交点**（§8.2 消费链站⑤投递视图）；standalone（帧内命中 / 人工回填 / 结算驱动 / 排队出队）是**独立投递点**；**回合收束判据由流程驱动器给（B3，§19.6.2）**，运行时不按投递尺寸推断终态。
- **投递通道（与形态正交）**：`followup`（无工具在途 → 正常开新回合）vs `defer`（有工具在途 → 随本回合结果进下一步）—— **判据 A 保留**（同时服务 T2 批次与规则动作），但**流程后继步进已不再经过投递**（T1 按槽渲染，§19.6.2）；形态解决"带不带原文"，通道解决"什么时候进模型"。
- **批次裁剪**（唯一裁剪职责）：按 token/行/字节预算裁剪，只影响 T2 可见文本，不影响 T1。
- **遗留段有界**：≤ 128 行 / 16KB；超限丢最旧 + error 日志 + diag 计数（I9）。
- **单一水位线（v0.11.0，取代旧"交付水位/三水位"）**：每会话**一条**行流消费进度记账，四类消费者推进它 —— ① 规则/入口/分支**命中行**（匹配即消费）② **流程 span**（含兜底到期与打断提交区间）③ **T2 批次** ④ 仍带原文的投递（如排队出队）。**状态抓取与 `direct` 不推进水位**（状态行与反射命中行按普通行落入 ③/④）。旧 `deliveredAbs` 交付水位、发送水位、回看结算**整体废除**；`mud_recall` 取消、`mud_state` 去 `lines` 参数 —— **T2 的上下文 = 会话历史本身，不提供 pull 通路**。重连时行号（`abs`）由新解析器从 0 重起，水位与回看缓冲随之清空。
- **回看缓冲是诊断通路**（`recallLines`，2000 行上限 + 自然驱逐）：只服务 `/mud/diag` 与 log-service，**不进模型工具面**。

**可测不变量（v0.11.0）**：`① + ② + ③ + ④ == 完整入站行流`（替代旧"按序拼接投递消息体"口径 —— 折叠类目已移除，行流无隐藏行；span 记账含**流程失败收束后的行仍计后续消费批**）。

<!-- 待补：裁剪预算的具体常量与配置项命名 -->

---

## §6 L3 选路

> **v0.9 W7.3（2026-09-18）回归本节声明的 `agent/request` 拦截设计**：v0.6.x 曾一度改为 `ModelSelectionRef` 预写方案（`presetLaneSelection` 在 `agent/pre-step` 直接改写会话模型选择），该变更**未登记 CHANGELOG**，且踩了下面"会话模型污染"的坑（预写后 `next()` 已是占位配置，还原记忆无接缝点）。W7.3 删 `presetLaneSelection` / `ModelSelectionRef` / `trySelectionRef`，回到本节原写的 `agent/request` + `{prepend:true}` 拦截 + `realModel` 记忆还原方案；`agent/pre-step` 只负责记 lane 与广播，不再写模型选择。

- `agent/pre-step`（agent 作用域）：只做两件事 —— ① 记录**本回合**的 lane（取该回合认领消息里第一条 `mud-owned` 的 lane；同一回合的后续步沿用本回合 lane，不会误换）；② `onLane` 广播当前 lane 给限速闸门（`installOwnedLaneRouting` 的 `onLane` → 闸门的 `currentLane`）。**v0.11.0**：流程后继步**不再产生新投递**（由驱动器发布槽、T1 按槽渲染，§19.3），因此"每步从新投递取 lane"的旧论证作废 —— lane 改为**按回合锁定**：`deliver/lane.ts` 的 per-agent 闭包只取 `t1`/`t2`，同回合的工具续步一律沿用本回合 lane（唯一逃生口是用户取消回合）。
- `agent/request`（agent 作用域 + **`{ prepend: true }`** async waterfall）：在 `await next()` **之后**调 `resolveLaneConfig(requested, next)` 决定最终配置：
  - `lane=t1` → `{provider:'mud-t1', model:'t1-local'}`（剥 `reasoningEffort`；若 `next()` 仍是真实配置——即首请求尚未被污染——顺手把 `next()` 入 `realModel` 记忆）；
  - 非 t1 且非占位 → 原样放行 + 更新 `realModel` 记忆；
  - 非 t1 收到 T1 占位 + 有记忆 → spread `requested` 只覆写 `provider`/`model`/`reasoningEffort`（保留 `temperature`/`maxTokens`/`stop`），`restored:true`；
  - 占位 + 无记忆 → 保守放行；
  - 空 `provider`/`model` 不更新记忆。
- **为什么必须 prepend**：官方 per-session 模型选择（`installModelSelection`，setup 期注册，早于本插件）会无条件写回会话模型；Cordis waterfall 中**先注册者最后拍板**，不抢最外层则 T1 被覆盖回真实 LLM（历史上表现为每 2s 一次 `agent/request` 而无任何 `[t1]` 输出）。
- **会话模型污染的防御（实测 bug）**：官方侧会把一次请求**实际生效**的 provider/model 记成会话的模型选择。于是首次把某回合拦成 `mud-t1` 之后，同一回合的下一步 `next()` 就已是 `mud-t1/t1-local`，**非 T1 回合也会打到本地模拟 provider**（症状：断流唤醒投出的批次被 T1 适配器按"选路异常"收束，真实 LLM 永不参与）。因此选路里维护一份"会话真实模型"记忆（最近一次非占位配置），并在**非 T1 回合收到 T1 占位时还原**它；用户手动换模型后 `next()` 给的是新模型 → 照原样放行并更新记忆，不覆盖用户选择。纯判定集中在 `resolveLaneConfig`（可单测，见 `tests/lane-routing.spec.ts`），每次还原都留痕。
- **门控**：`preset === 'mud-player'`（§9）优先；预设机制不可用时回退为"会话已绑定 MUD"（v8 行为）。
- **禁止**：用 `sessionController.selectModel` 切 lane —— 它会 `agentDefaultModel.saveSelection` **持久改写部署级默认模型**（并每次追加持久事件 + 触发模型切换通知）。
- **相邻工具调用限速**（`Config.toolCallIntervalMs`，缺省 1000ms；0 = 关闭）：在 `tools/pre-execute` 闸门里对 **T2 通道**的 MUD 工具调用等待到间隔满足再放行（不拒绝、不丢调用）。队列的 `commandIntervalMs` 只管写 socket 的间隔，管不住模型连续发起工具调用的节奏 —— 实测 T2 决策速度远快于服务端处理（"服务器有点反应不过来"）。
  - **豁免按通道判定，不按登录态**（作者定案 2026-09-13；**v0.9 W7.3 修复接线**：原 `installOwnedLaneRouting` 的 `onLane` 与闸门的 `currentLane` 均未接，T1 免限速是死代码 → 改为 `onLane` 广播写入闭包 `let lane`，闸门读 `currentLane: () => lane`）：`currentLane() === 't1'`（规则动作 / 流程步动作）**一律不等**；系统流程（登录中 / 等人工，`loginFlow()`）也不等。原实现只按 `loginFlow()` 豁免 —— **登录一完成就 false**，于是 T1 的规则动作与流程步动作（例如 fullme 的答案）会被无谓推迟 1 秒。
  - 非本插件工具不介入；等待期间响应 `exec.signal`（回合取消 → 直接拒绝本次调用）。
- **T2 投递限流**（`Config.t2DeliverIntervalMs`，缺省 **2000ms**；0 = 关闭）：**给真实模型喂输入的节奏**也压一道 —— 距上次 T2 投递不足最小间隔时，本批**不投**（行留待决，结算定时器延到差额到点）。
  - 与 `toolCallIntervalMs` 分工：后者压"每次工具调用"，这里压"**多久被喂一次**"（T2 每次行动都必须先收到一条投递），并天然把多个小批次**合并成大批次**。
  - **只压 T2 批次**：T1 原文投递、T1 动作投递（`standalone`）、控制消息（`requestAgent`）都不受它影响 —— T1 是系统流程，不能被"给模型限速"的闸压住。控制消息投出时**会**记一次时刻（避免"刚唤醒又喂一批"）。
  - 实测动机：登录后 T2 接管，1 秒一条地刷查询（look/hp/score/skills）。

---
