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
| **W4 桥与观测收尾** | §8（exec.signal ✅ / 活动表 ✅ / concludeTurn **已定不接** §18.11 / 分页 ✅ `pager:continue` 直发）+ §12/§13（runtime 脚手架 ✅：`watchdogs.spec.ts`、`runtime-watchdog.spec.ts`、`runtime-delivery.spec.ts`、`runtime-captcha.spec.ts`、`runtime-direct-action.spec.ts`、`mud-persona.spec.ts`、`commands.spec.ts`；`runtime-login-flow.spec.ts`/`login-rules.spec.ts` 已随 v0.4.0 删除 → 由 `flow-login.spec.ts` 接管） | 端到端：登录 ✅（v0.4.0 流程表，见 `flow-login.spec.ts`）、fullme ✅（提醒行 → 直发 → 人工，见 §11）、`dazuo`（活动表已数据化，待实测）、分页 ✅（直发，待实测） | ✅ 基本完成 |
| **W5 流程化重构（v0.4.0）** | §19 流程表 + arming/挂起/唤醒/打断/排队；§7 T1 退化为无状态动作渲染器；§8 桥承担挂起/唤醒；§1 新增 I10–I15；§16 删除回合记录/帧归属/搭车/`login-stall` | 验收（§13.6）：流程机单测全绿（arming/文本优先/冲突取首/超时/打断/排队/单流程互斥/挂起闸门/pending entry）+ T1 契约测试（含 **T2 可用性**）+ login 全链（正常/用户名不存在/密码错/断开）+ fullme 全链（含被打断） | 🟡 **已落地大半**（2026-09-13）：`runtime/flow/flows.ts` + `runtime/flow/flow.ts` + `LOGIN_FLOW`（含 MXP 分支全链）+ 桥归属 `ownCommandLive` + T1 无状态动作渲染器 + 帧内独立投递 + **结算后补跑顺序兜底** + **分支阶段计时器** + **打断/排队接线**（`ActionSpec.interrupts` / `interruptInFlight` / `drainFlowQueue`）+ **官方 loop 模拟器**（`loop-sim.ts` / `loop-sim-login.spec.ts`，量出"一步一回合 + 空续步"并给出 defer 提议的账目）；`flow-login.spec.ts`（9）/`flow-ownership.spec.ts`（5）/`t1-adapter.spec.ts`（8）/`flow-interrupt.spec.ts`（8）/`loop-sim-login.spec.ts`（1，真行为账目）/`runtime-defer.spec.ts`（4，投递通道 + 收束判据）/`preset-agent.spec.ts`（15，**两条装配路径都接通道**）/`runtime-watchdog.spec.ts`（5）全绿，全包 316 例。**未落地**：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world（§19.7 待定）。投递通道切换（§19.6.2）与 fullme 流程（§11）均已落地 |
| **W6 传输层迁移官方 typert（v0.7.0）** | 三套自建传输面（REST 路由 / WS hub / 信任围栏）→ 官方一条 `/api` RPC + 一条 mux WS：host `shell/mud-remote-service.ts`（10 RPC + 3 流）+ `shell/streams.ts`（MudFeedHub）+ `shell/remote-types.ts`；删 routes/hub/trust/view 与 ws 帧协议；`packages/typert-protocol` 镜像（生成器模式严格 descriptor）；webui `$mount(TYPERT_REMOTE)` + 官方 mux 三流消费 | 全包 333 例（`buffers.spec.ts` 钉 GlobalBuffers 契约；ws.spec 随 hub 删除）+ mud-webui build + 信任围栏/心跳/背压/envelope 校验回归官方上游测试 | ✅ 已实现（2026-09-16，明细见 CHANGELOG v0.7.0） |

> W1/W2 已随 v0.1 落地：新增 `perception/engine.ts`（L1）、`perception/split.ts`（L2 纯函数）、
> T1 改为 hit 渲染器（`agents/t1.ts`）；桥删除行集表并对齐 GA 边界接线
> （`services/network/manager.ts` 新增 `onBoundary`，此前 GA 主边界从未送达桥）。


## §18 未决事项与已定事项

### 未决（open）

1. **浏览器 roster 明文密码**：是否改走 host 侧凭据服务（§10）。
2. **逐次升级语义**：`ask` 批准 = 仅此一次 vs 提升会话档位（建议前者，与 §10「agent 永不自提权」一致）。
3. **旧 MUD 用户迁移**（会话无存储 preset）→ 删除重建（删除即归档，见 §11）。
4. **流程化的待放宽项（v0.4.0 之后）**：① **单挂起（I11）** —— 本版按"一条流程同时最多一个挂起步骤"实现（桥单槽），将来若出现"同一步骤需要并发多条命令"的需求再放宽为多挂起；② **流程内部并行分支** —— 当前分支是"命中哪个后继 driver 就走哪条"，同一时刻只推进一条路径；③ **跨会话流程编排**（多用户协同）—— 明确不在范围内。
5. **W5 尾款**：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world（§19.7 待定）。

### 已定（留档备查；编号沿用旧清单，外部 §18.N 引用仍指向此处）

2. **终端大流量文本通道（v0.7.0 解决）**：走 typert 流 `mud/game`（官方 mux WS，`/api/remote.mux`），不进 session 事件流；"官方无非持久会话 UI 通道"的前提已变化 —— 官方 remote 流通道即是。
3. **`/mud/*` HTTP 路由迁移（v0.7.0 解决）**：全部迁入 typert Remote 命名空间 `mud`（`shell/mud-remote-service.ts`，生成器模式严格 descriptor + zod 参数校验）；自建 routes/hub/trust/view 四件与 ws 帧协议删除。
4. **只读档是否允许 T1（v0.4.0 解决）**：允许但动作 `deny`（§10 三档 × 动作矩阵已实现，见 `tests/permission.spec.ts`）。
5. **危险命令清单来源（v0.4.0 解决）**：数据驱动表 `DEFAULT_DANGEROUS_COMMANDS`（`shared/commands.ts`）+ `Config.dangerousCommands` 部署覆盖；`deny` 工具层硬拦、`ask` 档位感知走官方审批（§10）。
7. **preset 化（v0.4.0 已定，方案 A1：部署根 + host 侧 `select`）**：不动 harness（`SessionCreateRequest.agentPreset` 的浏览器透传不再需要），改用官方 `ctx.agentPresets.select(agent, 'mud-player')`（仅空白会话可切）。部署两条（**profile patch，不进 bundle**）：给 `agent-presets` 行加 `roots`（指向本包 `packages/mud-core/presets`，`trust: system`）、给 `mud-core` 行加 `agentPreset: mud-player`；`agent-presets` 是**整份 config 替换**，务必带上必填的 `default`（见 §9 的片段）。未配置 roots 时 `select` 报 `agent-preset/not-found` → 日志留痕 + 回落宿主侧装配，不静默。
9. **preset 模式下 §10 可见性层退化（已定）**：preset 作用域共享一套工具，"按档注册不同工具集"在 preset 模式不可行（档位只剩强制层 + 提示文本）；preset 模式还让"档位切换即时反映到模型工具列表"失效。要严格可见性就把 `agentPreset` 留空走宿主侧装配 —— 两条路径都实现且都可用，取舍留给部署。
11. **`exec.concludeTurn()`：已定「不接」**（用户 2026-09-12）。理由备查：T1 回合在适配器取空命中时本就收束，接线只省一次续步；而 T2 下"哪个工具调用该结束回合"没有客观判据（`look` 之后该不该结束？说不清）。
12. **帧内命中在"无 T1 回合在跑"时的归属（v0.4.0 流程机制取代，本项关闭）**：① 流程步的应答由**本步 arming 判据 + 桥挂起**判定，完全不依赖帧归属（§19.3）；② 一次性动作（`save`/分页）走 `direct` 直发，不入桥；③ 流程挂起期间其它需要桥的请求被闸门拒绝并留痕（I12）。"归属猜错→丢命中/串步"这一整类问题不再存在。
13. **`fullme:request` 判据已实录**（用户 2026-09-12 给出原文 `5M后长时间不使用fullme，会被系统判定为机器人。`）：判据 = 这一串本身（作为流程 `fullme/request` 步的 driver，见 §11/§19）。
15. **打断的第一版范围（v0.4.0）**：`onInterrupt` 只声明"打断时要先发的直发命令"（如练功的 `halt`）；"打断后自动重试"、"打断原因的模型判定"留给 T2 决策一次，不自动重试。
16. **MXP / 判据细节（作者 2026-09-13 已定）**：MXP 发任何命令都能跳过 / GA 与其它判据同权 / `succeedStep` 只是里程碑 / 打断接线 / 投递通道 `deferContext` / fullme 流程五步（§19.7）；仍待定的 `pendingEntry` 端到端用例与 `hpbrief` 应答折叠已上移至未决 #5。

---
