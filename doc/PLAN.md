# mud-core3 计划起草区

> **当前状态（2026-09-30）**：**第一期已全部落地并验收**（C1–C5/C5.1，v0.0.2–v0.0.11，见 [CHANGELOG.md](CHANGELOG.md)）。**第二期（工具面）已全部落地并实机验收**（v0.0.12，测试 132 → 174 项全绿）。两期起草节已随落地清空，设计事实源同步至 `doc/architecture/00-core.md`。C5.2 暂缓（指针见下）。已裁定 `packages/mud-core2` 原位退役。
>
> **文件角色**：总体规划纲要 + 切片详细设计起草区。详细设计在实施前再细化，不提前展开。

## 总体规划纲要

每个期只命名工作范围与触发条件，不预做详细设计。实施时按切片细化，落地后同步 `doc/architecture/` 并登记 `CHANGELOG`。

### 第一期：基础设施 + MUD→agent 投递（**已完成**）

> **目标**：MUD 信息进入 agent（等同人工提问）并得到回答；工具与流程全部不做。
> **状态**：**已完成**（2026-09-30，v0.0.2–v0.0.11）。地基验证点已过：行流投递通道走通、agent 回答正确。

| 切片 | 内容 | 验收 |
|---|---|---|
| C1 骨架 | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例 | tsc + 用例绿 |
| C2 多会话 | roster storage + 会话装配（roster 判定→registry）+ 手工 connect/disconnect + 生命周期 | 两会话隔离；disposed 断连拆 runtime |
| C3 投递与接入 | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行 + 聚合投递（followup/steer）+ admit/stop + 水位 | 端到端：接入→消息进会话→agent 回答；停止后零投递 |
| C4 管理面 | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工连接、状态 | 全流程 UI 可操作 |
| C5 游戏画面视图 + C5.1 状态推送 | 右侧栏只读游戏画面（无头屏 + follow 流）；状态 tab 轮询改 watchStatus 推送 | 打开 tab 见回放+实时流；关闭不影响连接；状态毫秒级可见 |

> 落定事实见 [architecture/00-core.md](architecture/00-core.md)（§3.5 管理面等），演进过程见 [CHANGELOG.md](CHANGELOG.md)。

### 第二期：工具面（**已完成**，v0.0.12）

> **目标**：agent 向 MUD 发命令、主动读状态；禁发表（安全面）；工具受接入闸门约束——未连接/未接入均可读拒绝，连接与接入是手工动词，模型不能自行建连。
> **状态**：**已完成并实机验收**（2026-09-30，v0.0.12，测试 132 → 174 项全绿；前置验证 5 条由用户实机跑通）。

| 切片 | 内容 | 验收 |
|---|---|---|
| T1 ReadMachine | core2 竞速机移植为独立类（`src/read.ts`）挂 runtime；判定序 `failOn>until>gaCount>maxLines` 写死；abortWait/danger 保留、swallow 钩子空实现 | `test/read.spec.ts` 24 条绿 |
| T2 投递 pull 化 | deliver 去自持缓冲 → 双水位线（deliveredAbs/readAbs，seen=max）；turn 订阅接线（start 抑制 / end 冲刷）；失败批次不丢行 | runtime TCP 7 条；deliver 重写 + 断线复位 |
| T3 工具层 | `src/tools.ts`（mud_send 六级可读拒绝序 + 禁词表 `{suicide}` 全段扫描 + listen 编译 + timeout 钳制；mud_state 只过归属）+ `src/preset.ts` 注册 + 完整性自检 | `test/tools.spec.ts` 8 条绿 |
| T4 接线 | `ctx.provide('mudCore3')` 扩展 `toolContextFor`/`defaults`；Config 增 `sendTimeoutMs`/`sendMaxLines`、删 `deliverMaxPendingLines`；cordis.patch.yml preset 行 `mud-tools` + persona 工具说明 | service 流转测试；宿主实机验收 5 条 |
| T5 收尾 | 实机调整：send 回显格式 `账号名@来源>`（agent 灰 90m / user 青 36m）；工具栏按钮原生化；文档同步 | 174/174 全绿；文档与实现一致 |

> 落定事实见 [architecture/00-core.md](architecture/00-core.md)（§3.3 工具面现役、**§3.4 投递水位线 pull 模型 + turn/end 驱动**），演进过程见 [CHANGELOG.md](CHANGELOG.md) v0.0.12。

### C5.2 行打标与画面分屏（**暂缓执行**，设计定稿另存）

> **需求**：聊天、其他玩家的动作提取到副屏窗口——方便观察 + agent 去噪；聊天不进 agent（封号风险）。
> **状态（2026-09-30）**：设计经八轮收敛**定稿**，暂缓执行、移入待办。完整设计（核心裁定、帧结构、利弊结论、测试面、验收、被否决方案）另存：`doc/plans/c5.2-line-tagging-split-screen.md`。
> **恢复执行入口**：按该文件「实施顺序」开工，第一步 = 前置校准（语料校准）；定稿结论无需重新讨论，除非前提变化。
> **与二期叠加点**：投递剔除点在 `take()`——拉取时过滤有标行且不推进水位；与 pull 模型兼容，两切片实施顺序无依赖。

### 第三期：流程 flows

> **触发**：工具面落地后，出现需要编排多步命令的场景（如登录链路、验证码处理）。
> **范围**：`mud_flow` 机制；fullme 流程；验证码链路；其他可复用流程。从 mud-core2/mud-core 归档代码按需移植与重写。流程消费行推进水位（语义已定，见 §3.4）。

### 第四期：自动重连

> **前置**：先实现**真实心跳**（MUD 侧健康探测），无心跳不区分真断线/半开连接。
> **范围**：热状态（agent live）自动重连；冷启动不自动；断线恢复后的世界状态重建策略。
> **注意**：心跳本身可能值得单独一个切片，先验证 MUD 侧是否有原生心跳信号可用。

### 第五期：进阶机制（按例证生长，不预设顺序）

> **触发**：以下各项各自独立，由真实需求驱动引入，不批量规划。

- **子 agent / 派单 / 预算**：计划性任务需求出现（核心 action 复用、并行探索）
- **T2 闭环 / 唤醒**：挂机自主行为需求出现；唤醒**必须**以"已接入"为前置（§3.4）
- **意识层回归**：危险判据 → abortWait 接线 + swallow 吞行钩子实现（规则吞行留摘要；管道已就绪，二期保留空实现）
- **投递策略化**：字段化摘要、按需投递、水位窗口细化——token 账目恶化时；含超长回合持续刷屏的 turn 内强刷机制（二期已知限制，无例证不引机制）
- **禁词表可配**（Config 化；实证发现新危险命令按 I5 加行）
- **计数 / 账目 / 可观测**：成本验收或运营监控需求出现
- **其他**：core2 归档中未迁移但有参考价值的设计（五层心智等），按例证逐条评估

### 容易遗漏项（清单，非期）

以下在各期实施时需留意，不单独成期：

- **凭据管理**：密码录入、更换、多账号复用同一凭据（凭据链路 §2.4 已覆盖，实施时细化）
- **冷会话 runtime 保留**：宿主释放 agent 时连接不拆（§2.3 已定，实施时验证）
- **persona 内容**：mud-player preset 的 system prompt 措辞（随各期工具面扩展同步更新）
- **从 v1 迁移**：mud-webui 接线替换时，roster 数据从 localStorage 迁移到宿主 storage 域（已完成，v0.0.8）
- **遗留脚本清理**：根 `package.json` 的 `test`/`dev:core2` 脚本指向 mud-core2（已完成，v0.0.2/v0.0.6）

> AI生成
