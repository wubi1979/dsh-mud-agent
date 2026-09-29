# mud-core3 计划起草区

> **当前状态（2026-09-28）**：设计基线（§1–§5）审阅修正已并入，暂不开工。已裁定 `packages/mud-core2` 原位退役。开工指令后第一步 = C1 切片。
>
> **文件角色**：总体规划纲要 + 切片详细设计起草区。详细设计在实施前再细化，不提前展开。

## 总体规划纲要

每个期只命名工作范围与触发条件，不预做详细设计。实施时按切片细化，落地后同步 `doc/architecture/` 并登记 `CHANGELOG`。

### 第一期：基础设施 + MUD→agent 投递

> **目标**：MUD 信息进入 agent（等同人工提问）并得到回答；工具与流程全部不做。
> **状态**：设计基线已定（§1–§5），待开工。

| 切片 | 内容 | 验收 |
|---|---|---|
| C1 骨架 | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例 | tsc + 用例绿 |
| C2 多会话 | roster storage + 会话装配（roster 判定→registry）+ 手工 connect/disconnect + 生命周期 | 两会话隔离；disposed 断连拆 runtime |
| C3 投递与接入 | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行 + 聚合投递（followup/steer）+ admit/stop + 水位 | 端到端：接入→消息进会话→agent 回答；停止后零投递 |
| C4 管理面 | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工连接、状态 | 全流程 UI 可操作 |

| C5 游戏画面视图 | 右侧栏只读游戏画面（详见下节详细设计） | 打开 tab 见回放+实时流；关闭不影响连接 |

**一期完成后即验证**：行流投递通道是否走通、agent 回答是否正确——这是整个项目的地基验证点。

### C5 详细设计起草：游戏画面视图（右侧栏，只读）（2026-09-29，两轮审阅修订定稿）

> **需求**：后端连上 MUD 后，前端只负责渲染推送数据 + 窗口滚动，**无输入能力**；关闭视图不影响后台连接；画面 = 游戏输出 + agent 发往 MUD 的命令。
>
> **裁定**：DSH 原生终端窗口（`terminal-controller`）数据源硬绑真实 shell PTY 输出，无插件推数据的口子——**弃用终端镜像方案，自建只读视图挂右侧栏**（sidebar-right tab 体系，样板 = `ui-sidebar-terminal`）。
>
> **传输通道裁定（第二轮）**：以 **v1 已跑通的 typert 流路径为基准**（v1 后期已从 /mud/ws 迁移到 typert stream：`mud-remote-service.ts` 的 game/ui/world 三条 `@Remote({ mode: 'stream' })` 流，工件 `typert.remote-client.js` 中 stream descriptor 完整——generator 对 stream 动词的支持已被 v1 工件证明）。core3 现状：客户端已在 `$mount(TYPERT_REMOTE) + ctx.remote.mud` 正路，unary 工件已生成；**抄 v1 的传输形态，恢复模型保留 headless snapshot**（v1 的 sinceSeq 模型需服务端 seq 账本 + 前端去重，headless 屏即账本、前端零去重；round-1 已定，不回退）。

**已核实事实**：

1. 侧栏 tab 注册面公开：`ctx.sidebarRightTabs.register({ id, kind, multiple, title })` + 三座位注入 + `ctx.sidebarRight.registerCloseHandler`；**close 契约**（service.ts:246）："Failure preserves the tab"；`openTabs`（service.ts:238）= 布局持久化元数据源，**params 随布局保存、下次加载自动恢复**；
2. tab 参数是声明合并面（`SidebarRightTabParamsMap` 空接口）；`openTabIn(sessionId, kind, { params })` 按指定会话开 tab；`keepMounted` 宿主终端类型未设（隐藏卸载、重显重挂载，snapshot 使重挂载恢复 O(1)）；
3. mud-webui 已有 `@xterm/xterm` + `@xterm/addon-fit` + `xterm.css`；i18n 补 `locales.ts`（zh/en，`ctx.locale.register/bind`）；
4. 数据源现成：`MudLine.raw` 含 ANSI（无行末换行）；录制缓冲（2000 行环形）= 工具面裸读源（语义不变，断线清空）；`Mud.onSend` 观测直发命令原文（**凭据走 sendCredential 不触发**，天然不泄露）；
5. 宿主帧模式（BrowserTerminal.follow）：首帧 `snapshot`（serializer 整屏）→ 有序 `output`；**注册 follower 与 serialize 在同一条 enqueue 链**（terminal.ts:80-87，与写入互斥——不丢帧不乱序不重复）；follower 有界队列（stream.ts，`maxBytes` 超限显式失败，重连恢复）；
6. v1 传输先例：`@Remote({ mode: 'stream' }) async *game(sinceSeq, signal)` 生成器动词 + 同 tick 合批（ItemQueue：setImmediate 合帧 + BATCH_LIMIT 上限直吐）+ 工件 stream descriptor 生成成功。

**core3 侧（画面通道）**：

- **服务端无头屏**：每 runtime 一个 `@xterm/headless` Terminal + `@xterm/addon-serialize`（BrowserTerminal 同款，两包进 mud-core3 dependencies），行到达即写入，`send` 回显同样写入（区分色前缀）——晚加入者 snapshot 天然含历史回显；屏幕跨重连保留；与录制缓冲分工：录制缓冲服务工具面裸读，headless 屏服务视图，两者独立有界；
- **视图参数成组（Config）**：`viewScrollback`（缺省 2000，对齐录制缓冲——snapshot = 视口 + 全部 scrollback）、`viewCols`（缺省 80，固定，不做 NAWS/resize 回传）、`viewMaxBufferedBytes`（缺省 2MB）；
- **screen.ts 模块**：headless 写入 + follower 集 + 帧广播；
  - **时序不变量（写死）**：follower 注册与 snapshot 生成共用一条写操作链（enqueue 同型，与行写入互斥）——attach 瞬间不丢帧、不乱序、不重复；
  - **合批（抄 v1 ItemQueue 同型）**：同 tick 行写入合并为一次 `screen.write` + 一帧 output 广播，超上限直吐——防刷屏小帧；
- **follow 动词（抄 v1 形态）**：`@Remote({ mode: 'stream' }) async *follow(sessionId, signal): AsyncIterable<GameFrame>`；roster 归属校验（未登记抛错，与 connect 一致）；帧形态对齐宿主 TerminalFrame：`snapshot`（`{ type:'snapshot', sequence, screen, info }`）→ `output`（游戏行与 send 回显同帧，客户端零特判）→ `state`（连接状态）；
- **follower 背压**：有界队列（`viewMaxBufferedBytes`），超限该 follower 显式断流，客户端重新 follow 拿新 snapshot 恢复——与 snapshot 模式互为闭环；
- **纯扇出无输入**；tab 关闭 = follower 移除，连接/投递不受影响；**与闸门的关系**：画面通道是 MUD→人的显示面，不是 MUD→agent 通路，不受 admit 闸门约束（未接入 = 录制/挂机模式照样可看）；agent 零进入语义不变。

**webui 侧（右侧栏 tab）**：

- tab 类型 `mud-game`（`multiple: true`），声明合并 params `SidebarRightTabParamsMap { 'mud-game': { sessionId: string } }`——布局持久化携带 params，**刷新/重开 tab 自动恢复**，body 挂载即 follow + snapshot 回放；
- body：只读 xterm（不挂 onData）+ addon-fit + `xterm.css`；渲染 = snapshot 整屏（`xterm.reset()` + write）、output 增量、state 状态行；客户端 `for await` 消费 + AbortController（tab 关闭 abort → 服务端 follower 清理，`for await` 退出不泄漏）；
- close handler 按 "Failure preserves the tab" 契约返回 promise；i18n locales.ts（zh/en）；入口 = tab guide + 侧栏账号行「画面」按钮（`openTabIn(sessionId, 'mud-game', { params: { sessionId } })`）；非本插件账号会话显示空态。

**前置验证（开工第一步）**：`gen:typert` 重生成（含 follow stream 动词）→ 宿主加载 + 页面 unary RPC 实测一动词 + stream 实测连接（unary 可能已被"接入"操作隐式验证，一并实测确认）。

**测试面（vitest 先红后绿，`test/screen.spec.ts`）**：

1. 行写入后 snapshot 含该行（含 ANSI）；
2. send 回显入屏且凭据缺席（sendCredential 不触发 onSend）；
3. 背压超限 follower 显式断流；
4. 断流后重新 follow 以 snapshot 恢复；
5. 两会话屏幕隔离；
6. headless 跨重连续写（断连不清屏）；
7. follower 注册原子性（attach 瞬间并发行写入，断言不丢不重不乱序）。

**验收**：连接后开 tab 见 snapshot 回放 + 实时行流（颜色正确）；关/开 tab 连接不断；刷新页面 tab 自动恢复并重新回放；未接入也可见画面；send 回显可见（凭据永不出现）；慢客户端超限断流后重连恢复；多账号 tab 各看各的流；界面语言切换 title/guide 跟随。

**后置**：输入回传（随二期工具面评估）；NAWS/resize 回传；send 回显与 MUD 自回显的去重开关；画面历史持久化（headless 屏随 runtime 存活，插件重启即清）。

**实施后**：同步 `doc/architecture/00-core.md`（§3.5 管理面补一条）+ `CHANGELOG.md` 一行。

### 第二期：工具面

> **触发**：一期跑通后，agent 需要向 MUD 发命令、主动读状态（只接消息不够用）。
> **范围**：`mud_send` / `mud_state` 工具注册；禁发表（安全面，防 agent 发危险命令）；工具受接入闸门约束（一期定死的约束在此落地）。
> **预设约束**：未连接/未接入均可读拒绝；连接与接入是手工动词，模型不能自己拉起连接。

### 第三期：流程 flows

> **触发**：工具面落地后，出现需要编排多步命令的场景（如登录链路、验证码处理）。
> **范围**：`mud_flow` 机制；fullme 流程；验证码链路；其他可复用流程。从 mud-core2/mud-core 归档代码按需移植与重写。

### 第四期：自动重连

> **前置**：先实现**真实心跳**（MUD 侧健康探测），无心跳不区分真断线/半开连接。
> **范围**：热状态（agent live）自动重连；冷启动不自动；断线恢复后的世界状态重建策略。
> **注意**：心跳本身可能值得单独一个切片，先验证 MUD 侧是否有原生心跳信号可用。

### 第五期：进阶机制（按例证生长，不预设顺序）

> **触发**：以下各项各自独立，由真实需求驱动引入，不批量规划。

- **子 agent / 派单 / 预算**：计划性任务需求出现（核心 action 复用、并行探索）
- **T2 闭环 / 唤醒**：挂机自主行为需求出现；唤醒**必须**以"已接入"为前置（§3.4）
- **投递策略化**：字段化摘要、按需投递、水位窗口细化——token 账目恶化时
- **计数 / 账目 / 可观测**：成本验收或运营监控需求出现
- **其他**：core2 归档中未迁移但有参考价值的设计（五层心智等），按例证逐条评估

### 容易遗漏项（清单，非期）

以下在各期实施时需留意，不单独成期：

- **凭据管理**：密码录入、更换、多账号复用同一凭据（凭据链路 §2.4 已覆盖，实施时细化）
- **冷会话 runtime 保留**：宿主释放 agent 时连接不拆（§2.3 已定，实施时验证）
- **persona 内容**：mud-player preset 的 system prompt 措辞（C3 实施时定）
- **从 v1 迁移**：mud-webui 接线替换时，roster 数据从 localStorage 迁移到宿主 storage 域
- **遗留脚本清理**：根 `package.json` 的 `test`/`dev:core2` 脚本指向 mud-core2，开工时调整

> AI生成
