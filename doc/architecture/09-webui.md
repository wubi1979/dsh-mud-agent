---
sections: [9]
status: active
deps: ["§5", "§6", "§10", "§15"]
note: L7 呈现层：mud-webui（浏览器侧壳）
---

# §9 L7 呈现层（`mud-webui`）

## 9.1 原则：呈现不改、接线替换

- **服务器/账号的呈现沿用现有实现（不改）**：服务器即工作区 + 字段、账号挂服务器下、树形导航与表单外观保持原样。
- **后端换接**：服务器/账号的增删经 `remote.mud.addServer/addAccount` 登记到**宿主名册**；**页面 localStorage 只作呈现缓存**。
- **建账号在宿主侧一个动作完成**（写名册 + 建会话 + 投任务书，§11.2）；**页面不再自己 `sessions.create` / `agentPresets.select`**。
- 删账号/删服务器同样**先过宿主再改本地**；失败写进侧栏状态行。
- 本层是**纯呈现与编排**：不含任何 MUD 行流逻辑、不判归属、不碰凭据明文。

## 9.2 服务器/账号管理面

| 能力 | 说明 |
|---|---|
| 服务器 CRUD | 建（选/建工作区 + `host`/`port`）/ 删（该服务器仍有账号时**宿主侧拒绝**）；**端点去重**——同一 `host:port`（大小写不敏感）只允许一个服务器条目，客户端**前置查重**（避免先建孤儿工作区），宿主 `addServer` **同规则拒绝**（权威闸） |
| 账号 CRUD | 建（账号名 + 密码 → 写入宿主凭据域；**只交引用名**）/ **编辑**（账号行 ⋯ 菜单 → 编辑弹窗：改名经 `remote.mud.updateAccount` 落名册并同步 runtime 回显前缀；改密经 `credentials.set` 按**原引用名**覆盖写入，下次连接/登录流程即生效；preset 建会话时已绑定装配，编辑态只读）/ 删（先过宿主，再改本地） |
| **preset 选择** | 账号表单新增 preset 下拉（`standard` / `mud-player`）；**建会话时显式传入**，不覆盖 registry 默认 |
| **接入开关** | 账号行「接入 / 停止接入」→ `remote.mud.admit/stop`；接入状态徽标（账号行徽标瘦身（v0.0.25）：只留「已接入」+ 凭据**异常态**（无密码/未配置/只读），「凭据已配置」「已登录」徽标移除——登录状态在 HUD 表首行） |
| 连接操作 | 手工 `connect`/`disconnect`；连接状态查看（侧栏行 + 画面 tab 工具栏） |
| **启动 hydrate** | remote 挂载成功即拉 `servers()`/`accounts()`，用**宿主真值覆盖** localStorage 呈现缓存——刷新/宿主重启后的假服务器、死会话在启动时清掉 |
| **统一错误面** | 「会话未登记」提示统一措辞（可能宿主重启过或页面残留旧会话：请刷新页面后重连或重建账号） |

## 9.3 MUD 日志 tab（诊断视图）

- `conversation.view` 条目 `mud-log`，挂在**会话头 tab**：渲染该会话的 `remote.mud.logs` 环条目（按级别/通道着色）+ 落盘目录，作为连接/投递/闸门的**诊断面**（§13）。
- **上部 20% HUD 区（T11，v0.0.25 表格式 / v0.0.26 起为唯一状态表面）**：视图顶部常驻 `MudHudTable`（键\|值两列，首行登录轴，GMCP 条目逐行，悬浮全值 + 来源；`conversation.view` entry body 内部拆分，零宿主新依赖）；下部日志条目滚动不受影响。
- **tab 只在会话体渲染时出现**：宿主 blank 会话不渲染会话体 ⇒ 连接后第一批 MUD 行开启回合即脱离 blank（§2.4、§7.4）。
- 视图选择**按会话持久化**（宿主持有，插件不代选）。
- 数据只走 hooks + inject 回调（组件不自订阅）。

## 9.4 游戏画面 tab（只读显示面）

| 项 | 设计 |
|---|---|
| 挂载点 | `sidebar-right` tab 类型 `mud-game` |
| **自动打开** | **接入成功后自动打开**（v0.0.21）：`admit` 成功 ⇒ 切到该账号会话 + `openTabIn(sessionId, 'mud-game')`（宿主 openTab 同步展开右栏）；重复打开由下方单开守卫收编 |
| **单开** | guide 入口卡片（无 params 打开、回退跟随当前会话）；`openTabs` 订阅守卫保证**同会话仅一实例**——开出第二个即关掉较新、保留最旧实例（其 follow 流与工具栏状态不中断）；`params` 随布局持久化（刷新/重开自动恢复） |
| 数据面 | 每 runtime 一个 `@xterm/headless` + `addon-serialize` 无头屏（主屏，§5.3）+ 副屏**有界行环**（有标行 `MudLine` 追加，cap 缺省 1000 行，超限丢最旧——C5.2，2026-10-03） |
| 消费 | `for await` + `AbortController` 消费 `remote.mud.follow(sessionId)`；s1 主 xterm 只读（不挂 `onData`）+ `addon-fit`；s2 无关文本栏 = 同 view 内第二个只读 xterm（画面**下方占 30% 高、上下 3/7 分屏**，可折叠——行环不限 cols，按栏宽自由 wrap；折叠 = 高度 0，终端保持挂载继续吃帧） |
| 帧处理 | 首帧 `snapshot` 双字段回放（`screenMain` 整屏 → s1，`screenSub` 行环 join → s2，刷新后聊天历史回放）→ 增量 `output` 双字段（`main`/`sub`，同 tick 合批）→ `state` 帧直通工具栏；前端零 kind 逻辑（分类与路由全在服务端） |
| 背压 | 服务端 follower 超限**显式断流**；客户端重新 follow 以新 snapshot 恢复（互为闭环） |
| 关闭语义 | tab 关闭 = `abort` = **follower 清理**；**连接与投递不受影响** |
| 工具栏 | 「连接/断开」按钮 = 调既有手工动词 `connect`/`disconnect`（**不属于画面通道**，画面通道纯扇出无输入）；「聊天栏」折叠/展开按钮（s2 开关）；按钮用宿主原生 `Button`（随亮/暗主题）。画面 tab **无状态表**（v0.0.26 单表裁定：状态表只在聊天区日志视图，§9.3） |
| 闸门 | **不受 admit 闸门约束**（显示面，§6.4）；未接入 = 录制/挂机模式照样可看 |
| i18n | `locales.ts` 补 zh/en |

## 9.5 状态推送 `watchStatus`

- 状态面由**轮询 `status()`** 改为**服务端推送**：
  - runtime `onStateChange` 钩子（`setState` 统一入口，**值变化才触发**，全部赋值点已迁移）；
  - service **状态广播器**（`register` / `admit` / `stop` / `dispose` 与连接迁移各点广播，**多订阅者互不影响**）。
- `remote.mud.watchStatus()` **流动词**：首帧推**全量快照**（`statuses()` 语义，覆盖全部已登记会话），之后**仅变化推帧**。
- 客户端 `abort`（tab 关闭 / 页面刷新）⇒ generator `finally` **清服务端订阅**。
- `status()` 单次动词**保留**做初始回填/兜底。
- **边界窄面（T11 已收口）**：`status()`/`watchStatus()` 行面 = **`StatusRow`**（service.ts `statusRowOf` 映射，两动词共用）——`sessionId/state/admitted/loggedIn` 直传 + `world` **扁平数组**（`{zone,key,v,c,sk,st}`；值已 JSON 字符串化，`WorldEntry.value` 的 `unknown` 不过 Remote 边界）。webui 侧 `MudStatusFrame` 本地窄接口对应扩面。

## 9.6 凭据接线与客户端缓存

- **凭据接线**：页面只把密码写入宿主凭据域（`credentials.set(passRef, …)`）并保存**引用名**；`connect` 时账号名取自 roster（`accounts.name`），密文由宿主 `ctx.get('credentials').resolve(passRef)` **实时解析**（§11.6）。
  - 引用不存在/不可读 ⇒ **连接失败**，错误与日志**都带引用名**；**明文只进登录发送**，不进 roster、日志、上下文、画面（§12.2）。
- **缓存分层**：
  - **宿主名册** = 服务器/账号真相（`remote.mud.servers()/accounts()`）；
  - **localStorage** = 纯呈现缓存（hydrate 时被真值覆盖）；
  - **视图选择/布局** = 宿主持久化（插件不代选）。

> AI生成
