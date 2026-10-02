---
sections: [14, 16]
status: archived
note: 只用于追溯历史决策，不得据此实现或验收
---

## §14 历史吸收表

| 来源 | 内容 | 落点 | 状态 |
|---|---|---|---|
| V7 审查 P0-1/0-2/0-3、P1-1/1-2、P2-1/2/3、P3-1/2/5/6、R2-1…R2-13 | 桥可用性、登录文本、工具拒绝前缀、序列、掩码、孤儿 GA、上限、HTTP 围栏、WS 背压… | v8 已实现（随 V10 保留） | ✅ |
| V7 审查 P1-3a/1-3b | 多批行还原（`cacheLines`）/ 多行状态双跑（`matchDry`） | **§4+§7 合流**：行级源 + hit 渲染 → 整类问题消失 | V10 |
| V7 审查 P1-4 / R2-3 | dz/sleep 完成句、`COMPLETION_UNTIL` 键覆盖 | **§8 活动表（机制 D）** | V10 |
| V7 审查 P3-3 | `exec.signal` / `concludeTurn` 未接 | **§8** | V10 |
| V7 审查 P3-4 | matcher/控制器模块级单例 | **§4 每会话引擎**（控制器 v8 已按会话） | V10 |
| V7 审查 P2-4 | 分页逐页语义 | §8 规则模板 | V10 |
| V7 审查 R2-8 | 观察窗/注入裁剪 | **§5 裁剪（唯一职责）** | V10 |
| V7 审查 P3-1 / R2-6 | 凭据掩码 | host 侧已掩码；**浏览器 roster 明文**归 §10 凭据项 | 部分 |
| V9 权限设计（`REFACTOR-V9-permissions.md`） | 三档、actor、零发送工具、双层执法、`selectModel` 禁令 | **§10 全文并入** | V10 |
| preset 化计划（`.trae/documents/mud-preset-refactor-plan.md`） | preset 挂载工具/人设/技能、`composedPreset` 门控、迁移方式 | **§9 全文并入** | V10 |
| 本轮 holdDelivery | 半截事务原子性 | §4（状态持久后真正生效） | 已实现（待生效） |
| v8 已落地 | 会话-连接解耦、官方投递、lane 随消息、T2 基线、prepend、按会话键控 HTTP/WS、删占位 prompt、看门狗门、离线拒绝 | §5–§7、§11 | ✅ |


## §16 删除清单

**代码（V10 实施时删除）**：`matchDry`（生产路径）、`resolveLines`、`cacheLines`/行集表、`OwnedLaneRegistry`（v8 已删）、`t2Selection`（v8 已删）、占位 prompt（v8 已删）、`FORBIDDEN_COMMANDS`（→ 策略表）、`COMPLETION_UNTIL` 硬编码（→ 活动表）、进程级 matcher 单例、`trimObservation` 的"上下文裁剪 + 身份裁剪"双重职责、`commandsTextForAgent()`（全量命令语法注入系统提示 → 索引 + `mud_help` 按需取，v0.3.5）、`fullme-due` 看门狗 + `Config.fullmeIntervalMs` + `WatchdogSpec.resetsOnActivity` + `PerceptionEngine.actionOf`（v0.3.4 引入、v0.3.5 撤回：fullme 入口是匹配服务端提醒行，不是定时器）。

**代码（v0.4.0 实施时删除 —— 流程化重构的删除项）**：

| 删除项 | 原因 | 状态 |
|---|---|---|
| `turnRef` + 回合记录 `turns` + `takeHits` 游标 | 动作请求自包含在投递消息里，T1 不查运行时 | ✅ 已删 |
| 帧归属：`activeTurnRef` + "帧内命中追加到当前回合" | 结果判定改由 arming 判据 + 桥挂起给出，不再猜帧归属 | ✅ 已删 |
| 命中待渲染队列的"搭车" + `MAX_QUEUED_HITS` + `MAX_TURNS` | 没有"等下一次投递搭车"这件事：流程步有挂起、一次性动作直达 T1 | ✅ 已删（帧内命中改**动作投递**）|
| `login-stall` 看门狗 | 流程每步 `timeoutMs` 给出明确的"超时"结局（I4） | 🟡 看门狗已删；`timeoutMs` 已实现 |
| `deliverSelfHits`（自触发命中） | 人工回填后的答案成为流程 `answer` 步的正常投递 | ✅ 已删（fullme 流程已定稿，§19.7.8）|
| `fullme:request`/`fullme:prompt`/`fullme:done` 三条 event 规则 | 升级为流程 `fullme` 的五个步骤（`request`/`stale`/`prompt`/`answer`/`success`）—— 驱动句/动作/判据只在流程表写一份 | ✅ 已删 |
| 运行时取图职责：`sink.captcha(robotUrl)` 取图 + `Config.captchaPatterns` + `extractCaptchaUrl` | 解析（围栏 + 抓页 + 取图）改由 **`mud_captcha` 工具**承担（地址由流程步 `capture` 槽给出）；宿主只把解析结果推成对话框 | ✅ 已删 |
| 世界标志 `fullme_ok`（`fullme:done` 的 `world_patch`） | 全仓无人读；终态步改为发 `hpbrief` 补状态 | ✅ 已删（应答折进 world 见 §19.7 待定 2）|
| `login:name`/`login:pass`/`login:replace`/`login:done`/`login:error` 五条 event 规则 | 升级为流程 `login` 的步骤（驱动句/动作/判据只在流程表写一份） | ✅ 已删（`LOGIN_BOUNDARIES`/`LOGIN_FLOW_COMMANDS` 同批删除）|
| `Config.loginExitCommands` + `noteLoginExit()`（登录收尾"空行 + look"） | 收尾变成流程终态步 `success`：发**空命令**（顶开服务端 + 跳过 MXP 检测），不再发 `look` | ✅ 已删 |
| `LOGIN_FLOW_COMMANDS`（由规则反推的系统命令集） | 流程命令直接声明在流程表里；权限口径改为"流程步命令属系统流程"（§19.1） | ✅ 已删（改为 `flowCommands(defaultFlows)`）|
| 桥的"静默窗结算"用于流程 | 流程结果只有成功/失败/超时（I4）；静默窗不再是流程结局 | ✅ 流程侧已不认 `silent`（桥仍保留静默兜底给一次性动作）|

**文档（已删除，内容并入本文档）**：`packages/mud-core/REFACTOR-V7.md`、`packages/mud-core/REVIEW-V7-ISSUES.md`、`packages/mud-core/REFACTOR-V9-permissions.md`、`.trae/documents/mud-preset-refactor-plan.md`。

**待清理（不阻塞）**：源码注释中对旧文档编号的引用已在本版一并改指向本文档章节；新增注释一律使用 `doc/ARCHITECTURE.md §N` 形式，不再引入"机制 A/D"之类内部代号。

---
