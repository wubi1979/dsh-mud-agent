核对完成。这轮文档改动我逐条对着代码与实跑结果验过了——**框架性改善是真的**（register 投影、重连重挂、`resolveLaneConfig` 10 例、`preDeliver` 全仓清零、`onLane→currentLane` 接线 都与文档一致），但**状态登记与实测相反**，另有若干文档内部自相矛盾与残留旧机制表述。

---

# 一、核对方式与实测证据

| 命令 | 结果 |
|---|---|
| `node ..\..\node_modules\vitest\vitest.mjs run tests`（`packages/mud-core`） | **exit 1**：Test Files **5 failed / 26 passed (31)**；Tests **12 failed / 323 passed (335)** |
| `node ..\..\node_modules\typescript\bin\tsc --noEmit`（`packages/mud-core`，即文档写的验证命令） | **exit 2**：4 个错误（见 P0-1） |

失败集合（与上一轮一致，未被 W7.3 触及）：`flow-login`(5) / `flow-interrupt`(3) / `flow-ownership`(2) / `runtime-watchdog`(1) / `preset-agent`(1)。典型断言：
- `expected { flowId: 'login', …(8) } to be null`（流程不应还在跑）
- `expected { flowId: 'test', …(8) } to match object { flowId: 'test', stepId: 'done' }`（GA 关窗未推进）
- `expected [ 'lian sword', 'look', 'halt' ] to not include 'look'`（半截序列仍发出）
- 日志断言 `'本步未声明 GA 判据'` / `'不是本步命令的结算'` 不在日志里（说明 `noteToolResult` 那条链在测试路径上没走到）

`doc/PLAN.md` 本轮**未改动**（`git diff -- doc/PLAN.md` 为空），所以上一轮对 PLAN 的意见仍然有效。

---

# 二、P0（必须改，否则文档失信）

### P0-1 §17 W7 行的「✅ 已实现」与实测相反，且与 CHANGELOG 口径互相矛盾
- §17 第 18 行：状态「**✅ 已实现**」，验收列写「**全包 spec 全绿**（例数以当次 vitest 汇总为准）+ `tsc --noEmit`」。
- CHANGELOG v0.9.0 末尾：「**验证（不由 agent 执行）**：`pnpm --filter … test`；`pnpm --filter … exec tsc --noEmit`」。
- 事实：命令跑了就是**红 + 编译错**。§17 自称「当前状态的唯一来源」，这里它给了一个未达成的通过结论；而 CHANGELOG 又明说没验证——两处并置会让读者以为已绿。
- `tsc` 的 4 个错误（都在本轮或 W7.2 改动的文件里）：
  - `adjudicator.ts(348) TS2564` `registration` / `(350)` `engine` / `(352)` `gateRules` —— register 收口把赋值搬进 `register()` 方法，构造器内 `this.register(deps.registration)` 不被 TS 的 definite-assignment 分析认可（运行时没问题，属类型问题）；
  - `inflight.ts(574) TS2379` —— `settled:'until'` 分支的 `outcome: 'ok'|'fail'|undefined` 与 `WindowResult.outcome` 非可选，在 `exactOptionalPropertyTypes` 下不兼容（W7.2 遗留）。

**改法**：§17 W7 行状态改「🟡 **已落地、验收未通过**」，验收列拆成「已达成 / 未达成（红清单 + tsc 错误清单 + 责任切片）」；CHANGELOG 该行写明「**未验证**；当前已知 12 例红、4 个 tsc 错误」。除非先把红与 tsc 清零，否则不要用「已实现」措辞。

### P0-2 §17 同一文件内两行结论相反（concludeTurn）
- §17 W4 行验收列仍写「concludeTurn **已定不接** §18.11」；
- §18 新增 #17 已把 #11 标为勘误取代（「已接线 … 取代 #11」）。
- **改法**：W4 行括注改「（v0.9 W7.3 勘误：已接线，见 §18.17）」，并顺手把 W4 行标题里的「桥与观测收尾」加注（桥已删）。

### P0-3 §18 未决 #4① 与 #12 的正文仍是**已删除机制**
- #4① ：「**单挂起（I11）** —— 本版按『一条流程同时最多一个挂起步骤』实现（**桥单槽**）」→ 桥已删（§8.7），I11 已改写。
- #12 ：「流程挂起期间其它需要桥的请求被**闸门**拒绝并留痕（I12）」→ 桥/闸门已删，I12 已成「直发延后 gate」。条目虽标「本项关闭」，但正文会被后来者当事实引用。
- **改法**：#4① 关闭并指向新 I11 口径（「多窗口并发下的流程单步约束由配对移交 `noteToolResult` 保证」）；#12 的③改为「窗口开启期直发延后（I12）」或整条标「已随桥删除，仅留档」。

### P0-4 I11/I12 行内过渡注记未清，与 CHANGELOG 自述不符
- CHANGELOG v0.9.0 ⑤ 写「I11/I12 **正式改写**（**删 W7.2 暂注**）」；
- 实际 `00-core.md` 正文仍是：`~~单挂起（本版）~~ **〔v0.9 W7.2 正式改写，W7.3 措辞落档〕**：…` —— 旧措辞带删除线 + 迁移自注都还在。
- §0 规则 5 要求「同一事实只写一处」；I 表被全部章节引用，读者不该在这里做考古。
- **改法**：I 表只留现行一句（例：**I11**「流程单步的应答唯一性：由在途窗口表的窗口-步骤配对（§8.3/§19.3）保证；不另造挂起队列」），旧措辞与过渡说明移入 §18 或 CHANGELOG。

---

# 三、P1（重要，影响可读性与实现一致性）

### P1-1 I11 仍把「官方缺省」当契约
现文：「被官方工具**顺序执行**取代」。实测官方语义是 **per-tool 并发档 + fail-closed**：`@deepseek-ai/dsh-tools` `executionMode()` —— "Only an exact `true` is parallel; unknown, hidden, undeclared, invalid, or throwing classifiers are **exclusive**"；本仓全部 MUD 工具**都没有**声明 `isConcurrencySafe`（全仓 grep 无命中），所以"同时至多一个窗口"成立，但它是**缺省而非常量**。
**改法**：写成「官方缺省独占调度（未声明 `isConcurrencySafe` → fail-closed exclusive）+ 窗口表 pending 队列双保险」，并在 §18 未决新增一条「若某 MUD 工具未来声明并发安全，需重新评估 I11 的替代论证」。

### P1-2 「arming 集」的组成在三处文档 vs 代码口径不一
- 代码实况（`flow.ts:57`）：「当前 arming 判据（行判据；**W7.2 起只含 driver(重试) 与分支后继 —— 单步 ok/fail 随窗口注册**）」。
- `00-core.md` §2 术语表 arming 集：「进入某步时打开『**本步 ok/fail** + 直接后继 driver』」← 旧口径。
- `04-06` §4 表：「流程判据 … 本步 ok/fail … 作为武装标记注册进裁决器标记表」← 未区分 W7.2 变化。
- `19-flow-runtime.md` §19.3 line 153：「**帧文本判据（`text`/`regex`）不经窗口**，走 19.2 的 arming 路径」← 与 `windowSpecFor` 把本步行判据编译成 `win-` 判据的实现相反（`flow.ts:291-292` + `delivery-channel`/`inflight` 的 `win-<n>:ok/:fail`）。
**改法**：统一为「arming（流程侧行判据）= 入口 driver + 本步 driver 重试 + 条件分支后继；本步 ok/fail 的行/GA 判据随窗口注册（`win-` 标记）」；§19.3 line 152-153 重写为「窗口判据 vs arming 的分工」。

### P1-3 §8.0 契约句残留已删概念「事务开窗」
- §8.0：「**标记切帧，事务开窗**；判据十成，GA 八成…」
- §8.7 删除清单已把「事务帧标记 `tx-*`」列为删除项；§8.3 写「窗口即开窗（`registerWindow`）」。
**改法**：改为「**标记切帧，工具开窗**」。

### P1-4 §8.8 新增行说 register 收口「取代 session 直持 gateRules」，但 `session.ts` 仍持该字段
- `session.ts` 仍有 `private readonly gateRules: GateRules`（构造里 `buildGateRules(...)` 并塞进 `registration.gateRules`）。若已无其它消费点 → 死字段，与 §8.8 叙述不符；若仍有（装配期的 tool-gate 使用）→ 文档需写明「壳仍持引用，用于 X」。
**改法**：二选一并对齐（删字段 + 文档照旧，或文档补一句用途）。

### P1-5 I2 新注引入的 `inject` 与 §19.6.2/代码的 `deferContext` 名实不一致
- I2 新文：「经官方原语投递：`followup` / **`inject`（随在途工具结果进同回合，§19.6.2）**」。
- §19.6.2 与代码路径都写 `deferContext`（`agents/mount.ts:147` 逐条 `exec.deferContext(message)`；`19-flow-runtime.md:211/213/252` 亦写 `deferContext`）。
**改法**：统一术语。若 `deferContext` 内部即官方 `agent.inject`，在 §19.6.2 注明「`exec.deferContext`（官方 `agent.inject` 的投递入口）」；否则 I2 改回 `deferContext`。

### P1-6 §12/§13 未随 W7.3 同步（测试章节出现缺口）
`12-13-observability-testing.md` 全文只提到 1 处 W7.1/W7.2 相关的 spec 改指；**没有**登记：W7.3 新增的 `tests/lane-routing.spec.ts`（10 例）、register 收口的测试对象、以及"例数基线"。而 §17 W7 行的验收列又引用「例数以当次 vitest 汇总为准」，两章会互相打脸。
**改法**：§12 第 3/4 点补一行 lane-routing（10 例表驱动 `resolveLaneConfig`）+ 说明裁决器注册收口后单元测试对象变化；例数基线建议直接写「335」（含新 10 例）。

---

# 四、P2（收尾，别漏）

1. **代码注释仍以 `doc/PLAN.md §N` 为设计依据**（共 6 处）：`agents/tools.ts:150,260`、`runtime/flow/flow.ts:6`、`runtime/session/inflight.ts:5`、`tests/flow-ownership.spec.ts:3`、`tests/response.spec.ts:5`；§8 的注记里也仍写「（重构计划 §2.8）」。既然 §8/§19 已落档为事实源，按 §0 规则 6 应改指 `§8.3`/`§19.3`。
2. **PLAN.md 未加状态声明**：本轮把 §8/§19/§17 都落档了，PLAN 仍以"待做"语气写着已完成项（§6「登记 v0.9.0 + §17 W7 切片」、§5「删 preDeliver」），并且仍含已证伪的论断（§0.1「不再分帧」、§2.2「gaCount 缺省 1」（实现是"命令条数"）、§2.2「criteria = MatchSpec 多行状态机」（实现是单行正则）、§7「官方管道强制工具返回」）。建议头部加「已收官；事实以 §N 为准」+ 修正上述 4 条。
3. **分页在窗口期被延后的风险仍未登记**：`pager:continue` 是 `direct:true`（`perceive/rules.ts:242-261`）→ 走队列 → 在窗口开启期被 gate 压住（`queue.ts` gateRank 2）；而窗口型工具的 `gaCount` 可能是 1（`tools.ts:398`），长输出分页会「先关窗、后续页不进结果」且回给模型 `ok:true`。文档里没有任何开放项登记此事（§8.3/§18 均无）。建议在 §18 未决加一条并在 §8.3 写明「窗口内插话命令的归属判据」。
4. **`halt` 无条件豁免 gate**（`queue.ts` 按 `priority==='halt'` 恒放行）：`§8.3`/I12 只写「`halt` 等高优先级豁免」，未写清"只应是打断路径"，且未要求留痕。属文档未覆盖的 GA 计数污染通道，建议补一句约束。
5. **§18 #15 措辞**仍写「`onInterrupt` 只声明打断时要先发的直发命令」——与术语表新词（`InflightWindowTable.interrupt`）建议对齐。

---

# 五、最小改动清单（建议按序执行）

1. §17 W7 行：状态与验收如实改写（P0-1）；顺手修 W4 行 concludeTurn 括注（P0-2）。
2. 修 `tsc` 4 个错误 + triage 12 例红（这是"已实现"能否成立的前提）——把结果写回 §17 与 CHANGELOG。
3. §18：#4①/#12 正文更新（P0-3）、#11→#17 已在，补 #17 的"T2 不接"边界说明是否与 §19.6.2 一致。
4. I11/I12 清过渡注记（P0-4），I11 改 fail-closed 措辞（P1-1）。
5. 统一 arming 集口径（P1-2，3 个文件）与 §8.0「事务开窗」（P1-3）。
6. §12 补 lane-routing 与例数基线（P1-6）。
7. 注释 `doc/PLAN.md §N` → `§8.3/§19.3`（P2-1）；PLAN 头部加状态声明（P2-2）。

---

**本轮核对已确认「文档写对了」的部分**（无需再动）：§17 有 W7 行了；§2 术语表新增「裁决器/在途窗口/分投器」并清理了"分帧器=唯一边界裁决者"旧表述；§8 章标题改为「行流裁决器与在途窗口」；§6 回归版记与 `resolveLaneConfig`/`onLane→currentLane` 实现一致（10 例 spec 实测存在）；`preDeliver`/`presetLaneSelection`/`ModelSelectionRef` 在 `packages/` 下确无残留；§4 引擎由 `register()` 投影创建、`resetForReconnect`/`abortForDisconnect` 经 `register(this.registration)` 重挂 —— 均与 `adjudicator.ts:410/1068/1099` 一致；W1 注记路径勘误（`perceive/engine.ts`）已修。

需要的话，我可以直接把 P0/P1 的改动落到这几个文件（含 §17 状态、§18 条目、I11/I12/I2 措辞、§8.0、§12 补行），并附上实测命令与结果作为登记证据。