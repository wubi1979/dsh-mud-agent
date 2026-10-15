# mud-commands

MUD 命令判据总表（T28 拆包）。构建期装配（DEC-18 fail-loud），运行期零注册面；判据逐条实录（A.6 纪律）。

## API（公共面）

- `./define`：条目定义工厂 `defineCommand` + 三判定器 `byBoundary`/`byOutcomes`/`byWindow` + `CommandProfile` 类型
- `./assembler`：`COMMAND_PROFILES` 总表（装配期自检通过才存在）、`matchCommandProfile`（缝侧对最终发送串匹配，DEC-8）、`tableSlotsOf`（注册表校验端口实现）、**`resolveAwaitPlan` 解析单点**（DEC-21：declared > table > empty > none 四档）、`assembleProfiles`（测试缝）
- `./std` / `./skill` / `./usr` / `./stunt` / `./profession` / `./task`：六分组条目数组（DEC-18 构建期数组；task 组为任务专用命令（T27），条目带 `task` 标记、不入全局总表）
- `./assembler`（任务面，T27）：`TASK_PROFILES`（按 `task` 标记分组装配）、`TASK_ENV_RULES`（任务环境 enter/exit 判据编译产物）、`matchProfileFor(sent, task?)`（解析序：任务条目 > 全局表）

## 装配期自检（fail-loud，全部可经 `assembleProfiles` fixture 实证）

- 保留字语义条目名拒用（`ok`/`fail` 是 kind 寻址键）
- 语义条目名跨槽位禁重名（ok/fail 组内唯一）
- 命令头冲突（id/aliases 不得与他条目重复）
- 判据形态必须有 ≥1 可命中判据（criteria 无语义条目 = 配置错误）
- ga 形态 `gaCount` 必须为正整数；登记语义条目 patterns 非空

## 依赖

- `mud-workflow`：契约层 `CLOSURE_KINDS`/`RESERVED_SLOT_NAMES`/`ClosureKind`/`SlotTable`/`FlowSlotsInfo`

## Known Limitations

- 任务面已落地（T27）：条目 `task` 标记 + 环境行流推断（`TaskEnvironment` → `TASK_ENV_RULES` → mud-sense `TaskDetector` 接线）+ `resolveAwaitPlan` 第三参 `task?`；武当阵法 `zhenfa` 判据待实录（附录 A.10 挂账），实录前无条目。
- 工具面行为（listen 透传、schema 组合自由度）的测试**不在本包**——留 tool-mud（tools.spec 测工具面行为，本包测装配与解析）。
