# mud-nav

MUD 导航特性 Provider（T28 拆包）。内部依赖，零宿主依赖（D9 矩阵）。

**定位（用户口径 2026-10-14）：只提供记录服务**——行走知识在后端积累，不回答、不进入 agent。

## API（公共面）

- `./graph`：`NavGraph` 图（快照 `NavGraphSnapshot`：`nodes[{region, edges, updatedAt}]`）
- `./route`：`parseWalkTable`/`parseDirectionPath` 行文解析（`WalkEdge = {region, room, pinyin, steps, direct?, dirs?}`——`◇` 拆区域/房间，行颜色 ⇒ `direct` 可直达性，`-c` 方向序列并入 `dirs`）
- `./blocker`：`nextBlocker`/`BLOCK_MANUAL_ATTEMPTS` 阻塞连击判定（连续没有推进 ⇒ 阻断，需人工干预）
- `./stamina`：`DEFAULT_STAMINA_FLOOR_PCT` 精力闸纯层
- `./service`：`NavService` 有状态服务（消费 `NavStore` 端口；面 = `record` + `snapshot`）
- `./store`：`createFileNavStore` 项目内 JSON 文件持久化（`<cwd>/data/nav-graph.json`，整图快照；旧格式读时归一）

## Known Limitations

- `NavService` 为有状态件——装配方（tool-mud）负责注册与生命周期；`rosterStorage:false` ⇒ 纯内存（重启丢图）。
- 路线数据依赖实录语料（A.9 挂账项随 T23 收口）。
