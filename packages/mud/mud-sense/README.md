# mud-sense

MUD 行流感知 Provider（T28 拆包，纯层）。无 socket/timer/宿主依赖——timer 一律注入，可独立单测。

## API（公共面）

- `./read`：`ReadMachine` 读窗状态机（收束原因词汇表 `ReadReason` = 契约层 `IoReadReason`；命中帧 `ReadHit`）、`ReadOpts`/`ReadResult`/`ReadSlot`
- `./classify`：`Classifier` 行分类唯一写入点（`DEFAULT_CLASSIFY_RULES` + `compileRules`）
- `./elide`：进程级遮蔽纯层（`elisionPlan`/`applyElision`/`epochMarker`）
- `./tracker`：`StateTracker` 行流 → World 规则层（`DEFAULT_TRACK_SPEC`、战斗接敌/敌意正则）
- `./world`：`World` 世界状态（分区 + 置信度 measured/inferred + 来源追溯）
- `./wake`：`Wake` 静默唤醒（三条件守卫注入；GoalOperation 编译期擦除，运行时零导入）

## 依赖

- `mud-link`：`MudLine` 行货币（**生产者所有**，本包 type-only 引用）
- `mud-workflow`：契约层判据词汇表（`IoReadReason`/`ReadHit`/`ClosureKind`，§8.8 A1 单点声明）
- `@deepseek-ai/dsh-goal`：type-only（`GoalView` 等，编译期擦除）

## 纪律

- 端口词汇表（收束原因 + 命中帧）**单点声明在 `mud-workflow/contract`**，本包不得另立。
- 测试在包级 `tests/`；引擎集成测试（read/classify/tracker/world spec 需 SessionRuntime 接线）**留 mud-core3**（薄壳期），随 T28.4 归 `mud` 包。

## Known Limitations

- wake 的单 timer 由注册方（宿主装配层）用 ctx.effect 启停，本包不自持。
- 遮蔽会话（`ElisionSession`）为进程级有状态对象，跨重连需调用方重建。
