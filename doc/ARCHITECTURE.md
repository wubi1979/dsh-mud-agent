# dsh-mud-agent 设计事实源（入口）· mud-core2（自主玩家 · 五层心智）

> **版本：v0.1.0（mud-core2 文档基线：design4 / design4-impl 按主题合并迁入）** · 里程碑登记见 [CHANGELOG.md](CHANGELOG.md)（基线（§18 八步）完成前**不登记**条目）
> 各章节正文位于 `doc/` 子目录；本文件只含 §0（规则）与导航，**不承载设计事实**。
> 检索一律用稳定编号 `§N`：章节号永不复用、永不跳号；文件路径可变，`§N` 不变。
> 旧 mud-core（一版）设计文档已归档 [doc/mud-core/](mud-core/ARCHITECTURE.md)（**archived**），只用于追溯，**不作**实现或验收依据。

## §0 文档与版本规则

**版本号** `vX.Y[.Z]`：X = 核心/底层架构重构（数据流分层、所有权模型、协议层改变）；Y/Z = 功能改进、缺陷修复、参数调整。每个里程碑在 [CHANGELOG.md](CHANGELOG.md) 表尾登记一行（只追加，不回改历史行）；**mud-core2 基线（§18 八步）完成前不登记任何条目**。

**阅读规则（AI 读者）**：

1. 本文件是入口不是全文；回答设计问题先按「章节地图」定位文件并读取，**不要凭本页回答细节**。
2. 任何任务先读 [architecture/00-core.md](architecture/00-core.md)（§1 不变量 / §2 术语 / §3 总体架构）；回答设计问题时交叉核对 §1。
3. 按任务取文件，不要顺序通读；任务 → 文件的映射见「任务索引」。
4. `doc/mud-core/` 已整体标 **archived**：只用于追溯历史决策，**不得**据此实现或验收。
5. 同一事实只写一处；若两处出现同一规则，以被引用方为准。设计变更只改对应章节文件，并在 CHANGELOG 登记（基线完成前暂不登记）。
6. 代码注释引用设计一律写 `§N` 形式（如 `doc/ARCHITECTURE.md §19.3`）；"§13 的流程出口"指 [architecture/10-13-subagent-execution.md](architecture/10-13-subagent-execution.md) §13。
7. **宿主引用整批复核**：正文中指向宿主仓（deepseek-harness）的文件/行号、preset 与 patch 机制、API 形态，随 harness 换代**整批**重新核对——一次换代做一次全量复核，不逐处信任旧行号；本仓 `cordis.patch.yml` 对宿主 standard.patch.yml 的逐条一致性由漂移守卫测试（`test/patch.spec.ts`）持续保证。

## 章节地图

| §N | 文件 | 内容 |
|---|---|---|
| §0 | 本文件 | 文档与版本规则 |
| §1–§3 | [architecture/00-core.md](architecture/00-core.md) | 不变量（I1–I10 + 不做清单）、术语表、总体架构（五层心智 / 决策者拓扑 / 文件映射） |
| §4–§6 | [architecture/04-06-link-awareness.md](architecture/04-06-link-awareness.md) | 存在层（连接 / 行流 / 直发）、行等待竞速与持有者、反射与意识 |
| §7–§9 | [architecture/07-09-t2-wake.md](architecture/07-09-t2-wake.md) | T2 闭环与三唤醒源、结算即唤醒（best-effort）、唤醒上下文与 persona |
| §10–§13 | [architecture/10-13-subagent-execution.md](architecture/10-13-subagent-execution.md) | 子 agent（无意图执行者）、预算与释放、工具面与静态禁发表、凭据与流程 |
| §14–§16 | [architecture/14-16-memory-cost-observation.md](architecture/14-16-memory-cost-observation.md) | 记忆三分与学习回路、成本账目、观测与计数口径 |
| §17–§19 | [architecture/17-19-acceptance-roadmap.md](architecture/17-19-acceptance-roadmap.md) | 验收账目、实施顺序、待实测与待定（**当前状态唯一来源**） |
| — | [flows/fullme.md](flows/fullme.md) | fullme 流程声明（问题上浮 → 根问人 → 带答案重入当前计划） |
| — | [CHANGELOG.md](CHANGELOG.md) | 变更记录（只追加；基线完成前不登记） |
| 附录 | [appendices/audit-checklist.md](appendices/audit-checklist.md) | 审计规约（每轮代码审阅的固定核对表） |
| — | [PLAN.md](PLAN.md) | **新计划起草区**：新计划先在此起草成型，实施后同步正式章节 + CHANGELOG，再清空/归档；不承载已落地事实 |

## 任务索引

| 任务 | 必读 | 可选 |
|---|---|---|
| 心智模型 / 术语 / 架构总览 | §1–§3 | — |
| 连接 / 行流 / 竞速机 / 持有者 | §1–§3、§4–§5 | §11 |
| 感知 / 反射 / 危险判据 / 世界状态 | §1–§3、§6 | §16 |
| 唤醒源 / 唤醒上下文 / persona | §6、§7–§9 | §15 |
| 子 agent / 预算 / 释放阀门 | §10–§11 | §17 |
| 工具面 / 静态禁发表 / 人工交互 | §12 | §6 |
| 流程 / 凭据 / fullme / 验证码 | §13、[flows/fullme.md](flows/fullme.md) | §10、§17 |
| 记忆 / 技能 / 教训 | §14 | §15 |
| 成本 / token 账目 | §15 | §17 |
| 观测 / 日志 / 计数口径 | §16 | §17 |
| 验收 / 实施顺序 / 当前状态 / 待实测 | §17–§19 | — |
| 新计划起草（如预案档 P1） | [PLAN.md](PLAN.md)、§1–§3 | 按主题取 |
| 代码审阅 | [appendices/audit-checklist.md](appendices/audit-checklist.md) | §1–§3 |
| 追溯旧 mud-core（一版）决策 | [doc/mud-core/](mud-core/ARCHITECTURE.md)（archived） | —（不作依据） |

**当前状态**：一律以 [§18–§19](architecture/17-19-acceptance-roadmap.md) 为准（实施顺序 + 待实测/待定清单）；本页不维护状态摘要。
