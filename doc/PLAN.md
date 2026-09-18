# PLAN.md — 新计划起草区

> **本文件角色（2026-09-18 起）**：后续任何新计划**先在本文件起草成型**，实施完成后再同步到 `doc/architecture/` 正式章节并在 `doc/CHANGELOG.md` 登记一行；同步完成后本文件清空（或转入下一起草项）。
>
> **起草约定**：
> - 起草期不占 `§N` 稳定编号（那是正式章节的事）；引用现行设计一律写 `§N`，不写裸文件名。
> - 起草项实施完毕、同步正式文档后，本文件中该项删除或移入 `doc/history/` 留档。
> - 例数/计数一律以当次实测为准，不硬编码历史值。
>
> 旧 W7 核心重构方案（已收官）归档于 [history/plan-w7-core-refactor.md](history/plan-w7-core-refactor.md)，现行事实以正式章节为准。

---

## 起草一：vitest 红清零（W7.2/W7.3 遗留 10 例 triage）

**状态**：起草中（未实施）

### 背景

- W7.2/W7.3 落地后 `tsc --noEmit` 已清零，但 vitest 有 **10 例红 / 345 总例**（v0.9.1 实测），见 §17 W7 行验收列。
- 红名单：`flow-login`（4）/ `flow-interrupt`（3）/ `flow-ownership`（2）/ `preset-agent`（1）；另有 `response.spec.ts` 2 个**未接住的 Unhandled Rejection**（"连续 3 次应答超时 reject"与"发送守卫 error reject"计时器后置）。
- 红名单在两次实跑间**漂移**（runtime-watchdog 红 1 例消失、flow-login 5→4）——疑与假计时器 + 未接住的 promise reject 引起的非确定性有关，triage 时一并查。

### 目标

1. vitest 全绿（mud-core 全包）。
2. 每例红有明确根因归类：**功能 bug**（修代码）或 **测试基建**（修 spec/脚手架）。
3. §17 W7 行状态由 🟡 更新为 ✅。

### 步骤草案

1. 逐例 triage：跑单文件复现，记录根因（预期集中在 W7.2 窗口结算语义与流程机推进的交互）。
2. 按归类修复；若属测试基建（如假计时器下 reject 未被 `expect(...).rejects` 消费），先补基建再重跑。
3. 处理 `response.spec.ts` 的 2 个 Unhandled Rejection（计时器后置 reject 需在用例内接住或收尾排空）。
4. 排查红名单漂移根因（非确定性），必要时给相关用例固定计时推进顺序。
5. 验证：`pnpm --filter @deepseek-ai/dsh-mud-core test`（用户执行）+ `exec tsc --noEmit`；全绿后同步 §17 W7 行 + CHANGELOG 登记。

### 遗留关联

- N-GA 声明表真机抓包核对（v0.7.5 遗留，§8.3）——与本起草项无依赖，可并行另行安排。
