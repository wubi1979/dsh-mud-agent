# mud-commands

MUD 命令判据总表（T28 拆包）。构建期装配（DEC-18 fail-loud），运行期零注册面；判据逐条实录（A.6 纪律）。

## API（公共面）

- `./define`：条目定义工厂 `defineCommand` + 三判定器 `byBoundary`/`byOutcomes`/`byWindow` + `CommandProfile` 类型
- `./assembler`：`COMMAND_PROFILES` 总表（装配期自检通过才存在）、`matchCommandProfile`（缝侧对最终发送串匹配，DEC-8）、`tableSlotsOf`（注册表校验端口实现）、**`resolveAwaitPlan` 解析单点**（DEC-21：declared > table > empty > none 四档）、`assembleProfiles`（测试缝）
- `./std` / `./skill` / `./usr` / `./stunt` / `./profession` / `./task`：六分组条目数组（DEC-18 构建期数组；task 组暂空，随 T27 接谱系标记）

## 装配期自检（fail-loud，全部可经 `assembleProfiles` fixture 实证）

- 保留字槽名拒用（`ok`/`fail` 是 kind 寻址键）
- 槽名跨 kind 禁重名（ok/fail 组内唯一）
- 命令头冲突（id/aliases 不得与他条目重复）
- 判据形态必须有 ≥1 可命中判据（criteria 无槽 = 配置错误）
- ga 形态 `gaCount` 必须为正整数；登记槽 patterns 非空

## 依赖

- `mud-workflow`：契约层 `CLOSURE_KINDS`/`RESERVED_SLOT_NAMES`/`ClosureKind`/`SlotTable`/`FlowSlotsInfo`

## Known Limitations

- `task` 组为空骨架：条目任务标记、会话谱系标记写入点与 `resolveAwaitPlan` 任务上下文参数全部随 T27 实施。
- 工具面行为（listen 透传、schema 组合自由度）的测试**不在本包**——留 tool-mud（tools.spec 测工具面行为，本包测装配与解析）。
