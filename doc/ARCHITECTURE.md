# dsh-mud-agent 设计事实源（入口）

> **版本：v0.4.0（W5 已落地 · 待作者验收）** · 里程碑登记见 [doc/CHANGELOG.md](CHANGELOG.md)（§15）
> 各章节正文位于 `doc/` 子目录；本文件只含 §0（规则）与导航，**不承载设计事实**。
> 检索一律用稳定编号 `§N`：章节号永不复用、永不跳号；文件路径可变，`§N` 不变。

## §0 文档与版本规则

**版本号** `vX.Y[.Z]`：X = 核心/底层架构重构（数据流分层、所有权模型、协议层改变）；Y/Z = 功能改进、缺陷修复、参数调整。每个里程碑在 [CHANGELOG.md](CHANGELOG.md) 表尾登记一行（只追加，不回改历史行）。

**阅读规则（AI 读者）**：

1. 本文件是入口不是全文；回答设计问题先按「章节地图」定位文件并读取，**不要凭本页回答细节**。
2. 任何任务先读 [architecture/00-core.md](architecture/00-core.md)（§1 不变量 / §2 术语 / §3 总体架构）；回答设计问题时交叉核对 §1。
3. 按任务取文件，不要顺序通读；任务 → 文件的映射见「任务索引」。
4. `status: archived` 的文件（`doc/history/`）只用于追溯历史决策，**不得**据此实现或验收。
5. 同一事实只写一处；若两处出现同一规则，以被引用方为准。设计变更只改对应章节文件，并在 CHANGELOG 登记。
6. 代码注释引用设计一律写 `§N` 形式（如 `doc/ARCHITECTURE.md §19.3`）；"§11 的流程表"指 `doc/flows/` 下对应文件。

## 章节地图

| §N | 文件 | 内容 |
|---|---|---|
| §0 | 本文件 | 文档与版本规则 |
| §1–§3 | [architecture/00-core.md](architecture/00-core.md) | 不变量（I1–I15）、术语表、总体架构 |
| §4–§6 | [architecture/04-06-perception-routing.md](architecture/04-06-perception-routing.md) | L1 行级感知、L2 投递节拍（单流切分）、L3 选路 |
| §7–§8 | [architecture/07-08-t1-bridge.md](architecture/07-08-t1-bridge.md) | L4 动作渲染（T1）、命令-应答桥 |
| §9–§10 | [architecture/09-10-agent-permissions.md](architecture/09-10-agent-permissions.md) | agent preset 装配、权限档位 |
| §11 | [architecture/11-runtime-config.md](architecture/11-runtime-config.md) + [flows/](flows/) | 连接/会话/看门狗/Config；**login 与 fullme 的流程声明在 [flows/login.md](flows/login.md)、[flows/fullme.md](flows/fullme.md)** |
| §12–§13 | [architecture/12-13-observability-testing.md](architecture/12-13-observability-testing.md) | 观测与诊断、测试策略 |
| §17–§18 | [architecture/17-18-roadmap.md](architecture/17-18-roadmap.md) | 交付切片（**当前状态唯一来源**）、未决事项与风险 |
| §19 | [architecture/19-flow-runtime.md](architecture/19-flow-runtime.md) | 流程表与流程运行时（step 驱动） |
| §14、§16 | [history/14-16-absorbed-deleted.md](history/14-16-absorbed-deleted.md)（**archived**） | 历史吸收表、删除清单；不作实现依据 |
| §15 | [CHANGELOG.md](CHANGELOG.md) | 变更记录（只追加） |
| 附录 A/B | [appendices/official-and-capture.md](appendices/official-and-capture.md) | 官方机制文件锚点、抓包事实 |

## 任务索引

| 任务 | 必读 | 可选 |
|---|---|---|
| 流程（login / fullme / 新增流程步骤 / 验证码） | 00-core、§19、flows/&lt;对应流程&gt; | §11、§12–§13 |
| 感知 / 投递 / 选路（L1–L3） | 00-core、§4–§6 | §12–§13 |
| T1 渲染 / 应答桥（L4 / 旁路 B） | 00-core、§7–§8 | §19 |
| preset 装配 / 权限档位 | 00-core、§9–§10 | §18（风险 7/9） |
| 会话 / 连接 / 看门狗 / Config | 00-core、§11 | §12–§13 |
| 观测 / 日志 / 测试 | §12–§13 | §11 |
| 当前状态 / 待决事项 / 风险 | §17–§18 | — |
| 追溯历史决策 | history/、CHANGELOG | —（history 不作实现依据） |

**当前状态**：v0.4.0 W5 已落地大半（`runtime/flow/flows.ts` + `runtime/flow/flow.ts`，全包 333 例全绿）；未落地：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world —— 明细见 §17–§18，**此处之外不写状态摘要**。
