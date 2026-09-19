---
sections: [17, 18]
status: active
deps: []
note: 当前状态的唯一来源；本文件之外不写状态摘要
---

## §17 交付切片

| 切片 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **W1 行级化** | §4 每会话感知引擎 + 状态持久（规则语义不变） | 现有用例全绿 + 跨文本块多行用例 | ✅ 已实现 |
| **W2 hit 渲染 + 单流切分** | §5 §7；删除 `resolveLines`/行集表/`matchDry` | 不变量用例（拼接==完整流）+ 表驱动"命中必渲染" | ✅ 已实现 |
| **W3 preset 化 + 权限档位** | §9 + §10 | preset 门控用例；三档 × 动作矩阵（含 T1 动作 deny） | ✅ 已实现：§10 = `tests/permission.spec.ts`（26 例，三档 × 动作 × actor 矩阵 + 闸门短路 + 投影折叠）；§9 = `tests/preset-agent.spec.ts`（8 例：组装期注册 / 执行期按 agent 解析 / 未绑定拒绝 / 提示按 agent 求值 / 组合文件） |
| **W4 桥与观测收尾**（v0.9 勘误：命令-应答桥已删，见 §8.3/§8.7） | §8（exec.signal ✅ / 活动表 ✅（活动表随在途窗口表保留）/ concludeTurn **已接线**（v0.9 W7.3 勘误，取代旧"已定不接"，见 §18.17）/ 分页 ✅ `pager:continue` 直发）+ §12/§13（runtime 脚手架 ✅：`watchdogs.spec.ts`、`runtime-watchdog.spec.ts`、`runtime-delivery.spec.ts`、`runtime-captcha.spec.ts`、`runtime-direct-action.spec.ts`、`mud-persona.spec.ts`、`commands.spec.ts`；`runtime-login-flow.spec.ts`/`login-rules.spec.ts` 已随 v0.4.0 删除 → 由 `flow-login.spec.ts` 接管） | 端到端：登录 ✅（v0.4.0 流程表，见 `flow-login.spec.ts`）、fullme ✅（提醒行 → 直发 → 人工，见 §11）、`dazuo`（活动表已数据化，待实测）、分页 ✅（直发，待实测） | ✅ 基本完成 |
| **W5 流程化重构（v0.4.0）** | §19 流程表 + arming/挂起/唤醒/打断/排队；§7 T1 退化为无状态动作渲染器；§8 桥承担挂起/唤醒；§1 新增 I10–I15；§16 删除回合记录/帧归属/搭车/`login-stall` | 验收（§13.6）：流程机单测全绿（arming/文本优先/冲突取首/超时/打断/排队/单流程互斥/挂起闸门/pending entry）+ T1 契约测试（含 **T2 可用性**）+ login 全链（正常/用户名不存在/密码错/断开）+ fullme 全链（含被打断） | 🟡 **已落地大半**（2026-09-13）：`flow/flows/index.ts` + `flow/engine.ts` + `LOGIN_FLOW`（含 MXP 分支全链）+ 桥归属 `ownCommandLive` + T1 无状态动作渲染器 + 帧内独立投递 + **结算后补跑顺序兜底** + **分支阶段计时器** + **打断/排队接线**（`ActionSpec.interrupts` / `interruptInFlight` / `drainFlowQueue`）+ **官方 loop 模拟器**（`loop-sim.ts` / `loop-sim-login.spec.ts`，量出"一步一回合 + 空续步"并给出 defer 提议的账目）；`flow-login.spec.ts`（9）/`flow-ownership.spec.ts`（5）/`t1-adapter.spec.ts`（8）/`flow-interrupt.spec.ts`（8）/`loop-sim-login.spec.ts`（1，真行为账目）/`runtime-defer.spec.ts`（4，投递通道 + 收束判据）/`preset-agent.spec.ts`（15，**两条装配路径都接通道**）/`runtime-watchdog.spec.ts`（5）全绿，全包 316 例。**未落地**：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world（§19.7 待定）。投递通道切换（§19.6.2）与 fullme 流程（§11）均已落地 |
| **W6 传输层迁移官方 typert（v0.7.0）** | 三套自建传输面（REST 路由 / WS hub / 信任围栏）→ 官方一条 `/api` RPC + 一条 mux WS：host `shell/mud-remote-service.ts`（10 RPC + 3 流）+ `shell/streams.ts`（MudFeedHub）+ `shell/remote-types.ts`；删 routes/hub/trust/view 与 ws 帧协议；`packages/typert-protocol` 镜像（生成器模式严格 descriptor）；webui `$mount(TYPERT_REMOTE)` + 官方 mux 三流消费 | 全包 333 例（`buffers.spec.ts` 钉 GlobalBuffers 契约；ws.spec 随 hub 删除）+ mud-webui build + 信任围栏/心跳/背压/envelope 校验回归官方上游测试 | ✅ 已实现（2026-09-16，明细见 CHANGELOG v0.7.0） |
| **W7 核心重构 v2（v0.9.0）** | 三片：**W7.1** 裁决器抽出（`SessionAdjudicator` 承接分帧器 + 五站消费链收拢，`frame-splitter.ts` 退役）；**W7.2** 桥 → 在途窗口（`inflight.ts` 取代 `bridge.ts`，直发延后 gate 取代挂起闸门，流程配对移交 `windowSpecFor`/`noteToolResult`）；**W7.3** 注册收口（裁决器唯一 `register()` 入口）+ 选路回归（`resolveLaneConfig` 纯函数 + `agent/request(prepend)` 拦截 + realModel 还原，删 preDeliver / `ModelSelectionRef` 预写方案）+ 限速 T1 豁免接线修复（`onLane`→`currentLane`）+ 文档落档（§4–§8 / 不变量 / 术语表 / §17–§18） | **已达成**：`tsc --noEmit` 清零（2026-09-18 修 4 错：adjudicator `registration`/`engine`/`gateRules` 三处 definite-assignment 改 `!` 注解 + inflight `until` 分支 `outcome` 收紧为字面量）；新增 `lane-routing.spec.ts`（10 例表驱动 `resolveLaneConfig`）；loop-sim 冒烟（1 回合 / T1 步骤 t2Calls===0 / 空续步不误落 T2）；vitest 红清零（2026-09-19，全包 31 文件 / 345 例全绿：triage 10 例红 = 唯一功能 bug「打断后半截序列仍发出」—— 打断结算时按 `replyId` 定向清除宿主命令队列残余（§19.4）+ `CommandQueue.discardByReplyId`，其余 9 例属测试基建 —— login/interrupt 假 loop 改走官方工具包装器 `runWithDeliveryChannel`（真链路结果回喂）、ownership/GA 归属断言对齐 §19.2 分支等待语义、preset 守卫同步 standard 上游（`workflow-ptc` 行 + `tool-ralph` disabled）、response.spec 两处 reject 断言先挂后推进计时器消除 Unhandled Rejection（红名单漂移根因） | ✅ **已实现**（2026-09-18 落地；2026-09-19 验收通过，明细见 CHANGELOG v0.9.0/v0.9.2） |
| **W8 src 按数据流重组（v0.9.3）** | 纯文件级重组，零行为变更：目录 = 数据流阶段（`network/`↔§11 连接面、`perceive/`↔§4、`deliver/`↔§5–§6、`agent/`↔§7–§10、`flow/`↔§19、`world/`、`session/`↔§11 编排、`shell/`↔服务面、`log/`）；约 40 文件迁移，`services/`/`runtime/`/`agents/`/`shared/` 目录消失，src 根只剩装配根四文件；`tools.ts` 拆 `tools-schema.ts`（契约）+ `tools-build.ts`（构建/插值）；`flow.ts` 拆 `engine.ts` + `util.ts`（纯辅助）；matcher 并入 `perceive/`（其契约并入 `perceive/types.ts`：机制层形状 + 策略层投影两段分区，避免撞名拆两个契约文件）；`inflight.ts`/`InflightWindowTable` 原名原符号随迁（§8.3）；exports `./preset-agent` 随产物迁至 `lib/session/preset.js`（组合文件 `agent.cordis.yml` 同步） | `tsc --noEmit` 零错误；vitest 全包 31 文件 / 345 例全绿（= 基线，0 新增红例）；文件级循环 import 为零（DFS 54 文件可证）；preset 装配无 `failed to mount`（`preset-agent.spec.ts` 守卫断言同步）；正式章节 impl 链接与路径字样随迁（§0/§7–§10/§11/§19/§flows） | ✅ **已实现**（2026-09-19，明细见 CHANGELOG v0.9.3） |

> W1/W2 已随 v0.1 落地：新增 `perceive/engine.ts`（L1；v0.9 W7.3 勘误，原文误写 `perception/engine.ts`）、`perception/split.ts`（L2 纯函数，今 `perceive/split.ts`）、
> T1 改为 hit 渲染器（`agent/t1.ts`）；桥删除行集表并对齐 GA 边界接线
> （`network/manager.ts` 新增 `onBoundary`，此前 GA 主边界从未送达桥）。


## §18 未决事项与已定事项

### 未决（open）

1. **浏览器 roster 明文密码**：是否改走 host 侧凭据服务（§10）。
2. **逐次升级语义**：`ask` 批准 = 仅此一次 vs 提升会话档位（建议前者，与 §10「agent 永不自提权」一致）。
3. **旧 MUD 用户迁移**（会话无存储 preset）→ 删除重建（删除即归档，见 §11）。
4. **流程化的待放宽项（v0.4.0 之后）**：① **单挂起（I11）** —— 已随 v0.9 W7.2 关闭：桥单槽删除，在途窗口表天然多窗口并发，流程单步约束由配对移交 `noteToolResult` 保证（I11 现行口径见 §1，不再有"一条流程同时最多一个挂起步骤"的实现载体）；② **流程内部并行分支** —— 当前分支是"命中哪个后继 driver 就走哪条"，同一时刻只推进一条路径；③ **跨会话流程编排**（多用户协同）—— 明确不在范围内。
5. **W5 尾款**：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world（§19.7 待定）。
6. **官方并发档位的缺省依赖（I11 边界）**：I11 的"同一回合里工具逐个 await 结算"依赖官方**缺省独占调度** —— `@deepseek-ai/dsh-tools` `executionMode()` 是 fail-closed（未声明 `isConcurrencySafe` → exclusive）；本仓 MUD 工具均未声明该分类器。若未来某 MUD 工具声明并发安全，需重新评估 I11 的替代论证。
7. **分页在窗口期被延后**：`pager:continue` 是 `direct:true` 直发（§7），窗口开启期被直发延后 gate 压底（gateRank 2，§8.3）；而窗口型工具的 `gaCount` 可为 1（如 `mud_look`）—— 长输出分页会"先关窗、后续页不进结果"且工具仍返回 `ok:true`。需明确窗口内插话命令的归属判据（§8.3）与翻页命令的豁免策略。
8. **`halt` 无条件豁免直发延后 gate**：命令队列按 `priority==='halt'` 恒放行（gateRank 0），不区分是否打断路径 —— 是 GA 计数污染的潜在通道（非打断路径的 halt 应答 GA 可能误入在途窗口计数）。需收紧为打断路径专用并留痕（I12 只约束了"豁免存在"，未约束豁免范围）。

### 已定（留档备查；编号沿用旧清单，外部 §18.N 引用仍指向此处）

2. **终端大流量文本通道（v0.7.0 解决）**：走 typert 流 `mud/game`（官方 mux WS，`/api/remote.mux`），不进 session 事件流；"官方无非持久会话 UI 通道"的前提已变化 —— 官方 remote 流通道即是。
3. **`/mud/*` HTTP 路由迁移（v0.7.0 解决）**：全部迁入 typert Remote 命名空间 `mud`（`shell/mud-remote-service.ts`，生成器模式严格 descriptor + zod 参数校验）；自建 routes/hub/trust/view 四件与 ws 帧协议删除。
4. **只读档是否允许 T1（v0.4.0 解决）**：允许但动作 `deny`（§10 三档 × 动作矩阵已实现，见 `tests/permission.spec.ts`）。
5. **危险命令清单来源（v0.4.0 解决）**：数据驱动表 `DEFAULT_DANGEROUS_COMMANDS`（`agent/commands.ts`）+ `Config.dangerousCommands` 部署覆盖；`deny` 工具层硬拦、`ask` 档位感知走官方审批（§10）。
7. **preset 化（v0.4.0 已定，方案 A1：部署根 + host 侧 `select`）**：不动 harness（`SessionCreateRequest.agentPreset` 的浏览器透传不再需要），改用官方 `ctx.agentPresets.select(agent, 'mud-player')`（仅空白会话可切）。部署两条（**profile patch，不进 bundle**）：给 `agent-presets` 行加 `roots`（指向本包 `packages/mud-core/presets`，`trust: system`）、给 `mud-core` 行加 `agentPreset: mud-player`；`agent-presets` 是**整份 config 替换**，务必带上必填的 `default`（见 §9 的片段）。未配置 roots 时 `select` 报 `agent-preset/not-found` → 日志留痕 + 回落宿主侧装配，不静默。
9. **preset 模式下 §10 可见性层退化（已定）**：preset 作用域共享一套工具，"按档注册不同工具集"在 preset 模式不可行（档位只剩强制层 + 提示文本）；preset 模式还让"档位切换即时反映到模型工具列表"失效。要严格可见性就把 `agentPreset` 留空走宿主侧装配 —— 两条路径都实现且都可用，取舍留给部署。
11. **~~`exec.concludeTurn()`：已定「不接」~~（v0.9 W7.3 勘误，被 #17 取代）**：原判定与实现矛盾 —— v0.4.0 defer 通道落地时已接线判据 B/C（`session/mount.ts`：`result.ok && channel.shouldConcludeTurn(callId)` ⇒ `exec.concludeTurn()`），见 #17。
12. **帧内命中在"无 T1 回合在跑"时的归属（v0.4.0 流程机制取代，本项关闭；v0.9 W7.2 措辞随桥删除更新）**：① 流程步的应答由**本步 arming 行判据 + 在途窗口**判定（§19.3 配对移交，桥已删）；② 一次性动作（`save`/分页）走 `direct` 直发，不注册窗口；③ 窗口开启期其它直发命令**延后**到结算后再发（I12 直发延后 gate，§8.3，取代旧"闸门拒绝并留痕"）。"归属猜错→丢命中/串步"这一整类问题不再存在。
13. **`fullme:request` 判据已实录**（用户 2026-09-12 给出原文 `5M后长时间不使用fullme，会被系统判定为机器人。`）：判据 = 这一串本身（作为流程 `fullme/request` 步的 driver，见 §11/§19）。
15. **打断的第一版范围（v0.4.0）**：`onInterrupt` 只声明"打断时要先发的直发命令"（如练功的 `halt`；打断时序：先经 `InflightWindowTable.interrupt` 把在途窗口结算为 `interrupted`，再发 `onInterrupt` 直发命令，§19.4）；"打断后自动重试"、"打断原因的模型判定"留给 T2 决策一次，不自动重试。
16. **MXP / 判据细节（作者 2026-09-13 已定）**：MXP 发任何命令都能跳过 / GA 与其它判据同权 / `succeedStep` 只是里程碑 / 打断接线 / 投递通道 `deferContext` / fullme 流程五步（§19.7）；仍待定的 `pendingEntry` 端到端用例与 `hpbrief` 应答折叠已上移至未决 #5。
17. **`exec.concludeTurn()` 已接线（v0.9 W7.3 勘误，取代 #11）**：#11「已定不接」与实现矛盾 —— v0.4.0 defer 通道落地时即接线判据 B/C（`session/mount.ts`：`result.ok && channel.shouldConcludeTurn(callId)` ⇒ `exec.concludeTurn()`，判据定义见 `adjudicator.ts` §8/§19.3）。现行口径：**T1 回合**在工具结果返回且无待投递/无遗留时经官方 `concludeTurn()` 收束，省一次空续步；**T2 路径不接**（#11 原理由仍成立：T2 下"哪个工具调用该结束回合"没有客观判据）。

---
