# mud-combat

MUD 战斗特性 Provider（T28 拆包，整域迁入）。行流接管状态机 + 规则引擎，timer/stealSend 注入。

## API（公共面）

- `./state`：`CombatEdgeDetector` 接敌检测 + `computeTiers` 五档分档（buffer/cap/force/momentum/edge）+ `CombatVitals`
- `./rules`：`CombatRuleEngine` 规则引擎（`SEED_RULES` + `COMBAT_COMMANDS` 种子）
- `./danger`：`dangerCondition`/`isThreatLine`/`liftsOutOfDanger` 危险判定（接敌正则引用 mud-sense/tracker）
- `./report`：`CombatReporter` 战报
- `./controller`：`CombatController` 监听窗控制器（T21：裸读 + `isEndingLine` 自测，不占公共读窗）

## 依赖

- `mud-sense`：tracker 战斗正则（运行时）、read 类型（`ReadOpts`/`ReadResult` type-only）、world 类型
- `mud-link`：`MudLine` type-only

## Known Limitations

- 对 `mud` 引擎零依赖（D9 矩阵）：controller 的 timer/stealSend 由装配方（tool-mud）注入。
- 战斗实录语料见附录 A.8（combat.replay 回放验证）。
