# AGENTS.md

## 设计文档检索（必守）

本仓库的设计事实源在 `doc/`，**已按系统分层架构拆分为多文件**（入口：`doc/ARCHITECTURE.md`，章节 §0–§17）：

- **禁止全量加载 `doc/` 目录**。涉及设计问题时：先读 `doc/ARCHITECTURE.md` 的「章节地图」（§0.3）与「任务索引」（§0.4），按任务取**入口 + 1–2 个子文件**。
- **任何任务先读 [`doc/architecture/01-02-overview-host.md`](doc/architecture/01-02-overview-host.md)**（§1 分层模型与核心领域模型 / §2 宿主平台事实与约束）。
- **引用设计一律写稳定编号 `§N`**（如 `§8.13`），**不写裸文件名**；章节号永不复用、永不跳号。
- 章节文件带 YAML front-matter（`sections` / `status` / `note`）：`status: archived` 的只用于追溯。
- **`doc/archive/**` 整体 archived**（v1 = mud-core，v2 = mud-core2）：**只用于追溯，不得据此实现或验收**；索引（含两套完整大纲与参考资产坐标）见 [`doc/archive/README.md`](doc/archive/README.md)。
- `doc/likely/**` = **已定稿但未立项**的候选区；`doc/PLAN.md` = 计划起草区 + 待办池（落地后同步正式章节并清空，不承载已落地事实）；`doc/CHANGELOG.md` **只追加，不回改历史行**。
- 改设计 = 改**归属章节**文件 + 在 `doc/CHANGELOG.md` 表尾登记一行；需要制定计划的改动先在 `doc/PLAN.md` 起草，定稿后再实施。
- **代码注释引用设计写现役 `§N`**；引用归档必须带版本前缀（`v1 §N` / `v2 §N`）。
- 旧 core3 编号（§1–§5）**已退役**，映射表见 [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md) §0.6。
