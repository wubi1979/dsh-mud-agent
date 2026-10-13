# mud-nav

MUD 导航特性 Provider（T28 拆包）。零跨包依赖（D9 矩阵：全部内部依赖 + node 内建）。

## API（公共面）

- `./graph`：`NavGraph` 图（快照 `NavGraphSnapshot`）
- `./route`：`parseWalkTable`/`parseCrossRegionHint`/`destMatches` 路由解析（`WalkEdge`/`CrossRegionHint`）
- `./blocker`：`nextBlocker`/`HARD_STOP_ATTEMPTS` 硬阻断判定（T23.10）
- `./stamina`：`DEFAULT_STAMINA_FLOOR_PCT` 精力闸纯层
- `./service`：`NavService` 有状态服务（消费 NavStore）
- `./json-store`：`createJsonNavStore` JSON 落盘（node:fs）

## Known Limitations

- `NavService`/json-store 为有状态/落盘件——装配方（tool-mud）负责注册与生命周期。
- 路线数据依赖实录语料（A.9 挂账项随 T23 收口）。
