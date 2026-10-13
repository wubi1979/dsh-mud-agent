# mud

MUD 引擎（T28 拆包，引擎域整域迁入）。多会话管理 + 会话运行时 + 名册/凭据 +
投递 + LLM 否决 + 日志/屏面。宿主接线（cordis 插件入口/装配）不在本包——
T28.5 归 tool-mud。

## API（公共面）

- `./service`：`MudService` 多会话管理（registry + connect/disconnect/status +
  admit/stop）+ `SessionStatus`/`StatusFrame` 状态面
- `./runtime`：`SessionRuntime` 会话运行时（连接 · keepalive 探测 · 感知/判据接线）
- `./roster`：名册类型（`ServerRecord`/`AccountRecord`/`RosterStore`/`ConnState`）
- `./store`：`MemoryRosterStore` / `openDomainRosterStore`（宿主 storage 域，降级内存）
- `./accounts`：账号登记（`randomUUID` 凭据域）
- `./deliver`：`Deliverer` 投递（agent.followup + createUserMessage）
- `./llm-gate`：`shouldVeto`/`vetoStopStream` LLM 输出否决
- `./log`：`SessionLog` 会话日志 + `resolveLogDir`/`purgeSessionLogs`
- `./screen`：`GameScreen` 终端屏面（@xterm/headless + serialize）
- `./types`：公共类型聚合（`GameFrame`/`LogEntry`/`WorldSnapshot` 等）

## 依赖（D9 矩阵，单向）

- `mud-link`：Mud 连接/行流/keepalive
- `mud-sense`：ReadMachine/Classifier/World/StateTracker
- `mud-commands`：`resolveAwaitPlan` 判据装配（assembler 测试缝）
- `mud-combat`：战斗四件（controller/state/rules/report）
- `mud-flows`：`fetchCaptchaImage`（captcha 纯件；状态面 captchaWaits 在本包 service）
- `mud-workflow`：缝契约类型（`WorkflowIO`/`CaptchaResume` 等）
- **不含 `mud-nav`**：nav 只被 tool-mud 消费（tools.ts 工具面 + 装配注册）。
  `mud-nav` 仅作为 devDependency 服务 `tests/nav-store.spec.ts`（引擎×nav
  store 集成测试）；src 面对 nav 零 import（D9 矩阵指 src）。

## Known Limitations

- typert 工件与 exports `./typert`/`./remote` 自 T28.5（v0.0.72）起归
  `tool-mud`（ambient 模块名 `'tool-mud/typert'`）；本包不再持有 typert 面。
- 对宿主零依赖：cordis 接线、remote 通道、storage 域全部由装配方注入。
