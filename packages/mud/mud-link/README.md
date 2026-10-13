# mud-link

MUD 连接协议 Provider（`packages/mud/` 组内叶子包，T28 拆包自 mud-core3 `src/link/`）。

## API

- `Mud` / `MudOptions` — MUD 连接组合（telnet + 行解析）。
- `AnsiStreamParser` · `stripAnsi` · `isPromptText` · `ANSI_STRIP_RE` · `MAX_SEQUENCE_BUF` — MudLine 行货币与 ANSI 清洗。
- `TelnetClient` / `TelnetClientOptions` / `GmcpMessage` — telnet 协议客户端（IAC 协商、SB 子协商、MCCP2 解压）。
- `Keepalive` / `AYT_ALIVE_RE` / `KeepaliveOptions` / `KeepaliveDeps` / `ProbeState` — 保活探测。
- `CorpusWriter` / `readCorpus` — 语料对齐实录（line/event 记录）。

子路径导出：`./line` · `./telnet` · `./mud` · `./keepalive` · `./corpus`（下游精确导入，薄壳期 mud-core3 按 1:1 对应 re-export）。

## Known Limitations and Deferred Work

- `MudLine` 为行货币类型，**生产者所有**（D10）：下游统一经 `mud-link` 导入，禁止本地复制定义。
- 纯 node 内建依赖（net/zlib/fs/events），零第三方依赖；连接生命周期归上层编排（mud 引擎），本包不持有会话状态。
