# AGENTS.md

## 设计文档检索（必守）

本仓库的设计事实源在 `doc/`，**已按主题拆分为多文件**（入口：`doc/ARCHITECTURE.md`）：

- **禁止全量加载 `doc/` 目录**。涉及设计问题时：先读 `doc/ARCHITECTURE.md` 的「章节地图」与「任务索引」，按任务取**入口 + 1–2 个子文件**；任何任务先读 `doc/architecture/00-core.md`（§1 不变量 / §2 术语）。
- 引用设计一律写稳定编号 `§N`（如 `§19.3`），不写裸文件名；"§11 的流程表"指 `doc/flows/` 下对应文件。
- `doc/history/` 标 `archived`，只用于追溯，**不得**据此实现或验收；`doc/CHANGELOG.md` 只追加。
- 改设计 = 改对应章节文件 + 在 `doc/CHANGELOG.md` 表尾登记一行。
