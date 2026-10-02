# mud-core3 变更记录

> 只追加，不回改历史行。仅正式实施的里程碑登记新条目；设计修订的最终结果并入对应条目，不单列。

## [v0.0.1]core2 作废，core3基线建立 (2026-09-28 10:10:13)
> 总结：确立初步计划

- core2 整体作废归档：文档移入 `doc/mud-core2/`（archived，仅追溯，不作实现/验收依据）
- 代码包 `packages/mud-core2` 原位退役：保留 workspace、不再演进；根 `package.json` 的 `test`/`dev:core2` 脚本仍指向它（遗留接线，core3 开工时一并调整）
- core3 最简版设计基线建立（§1–§5，见 `architecture/00-core.md`），未实施，待作者审阅后开工。基线最终口径（三轮审阅修订后）：
  - 实体：服务器 = 工作区 + 服务器字段（页面呈现沿用 mud-webui v1 不改，roster 键 = workspaceId）；账号只能建在服务器下
  - 会话 = 建账号时自动创建并绑定（sessionId = accountId）；使用者只见「服务器→账号」两级实体，无独立会话操作面
  - 连接：每会话独立 MUD 输入源；第一期手工 connect/disconnect；自动重连后置（热状态自动、冷启动不自动，前置 = 先实现真实心跳）
  - 一期目标 = MUD 信息进入 agent（等同人工提问）+ agent 回答：行流按静默窗口聚合后以用户消息投递进本会话（宿主 followup/steer 通道，与人工提问同路），触发回合产生回答；工具与流程全部后置（第一期零 MUD 工具，回答不回流 MUD）
  - 接入闸门：接入为显式动作、缺省未接入、水位 = 接入时刻不回放；停止接入 = MUD 信息不再进入 agent（投递停，行流照常积累 = 录制）；与 connect 正交（连接 + 未接入 = 录制/挂机模式）
  - 归属 = roster 判定（preset 退回纯账号属性，任选 preset 的账号均有 MUD 源）

## [v0.0.2]C1 骨架落地 (2026-09-28 12:40)
> 总结：link/ 移植完成，测试全绿

- 创建 `packages/mud-core3` 包骨架（package.json/tsconfig/vitest.config）
- 从 mud-core2 移植 `link/ansi.ts`（流式 ANSI/行解析器）、`link/telnet.ts`（telnet 协议层）、`link/corpus.ts`（JSONL 语料）——三文件零宿主依赖，原样移植
- `link/mud.ts` 从 core2 瘦身：去掉 read 竞速机（Holder/WaitOpts/ReadResult/read/abortWait/有界缓冲/判定序），只保留连接管理 + 行流分发（onLine 推送式）——竞速机是工具面依赖，第一期无工具面
- 回放用例：ansi 34 项、telnet 12 项、mud 9 项、corpus 3 项，共 58 项全绿；tsc + build 通过
- 根 `package.json` 的 `test` 脚本从 `mud-core2` 切换到 `mud-core3`
- `link/ansi.ts` 重命名为 `link/line.ts`（文件内容不只是 ANSI，还含行分割/MudLine/abs/flush）

## [v0.0.3]C2 多会话落地 (2026-09-28 12:58)
> 总结：roster + runtime + service 纯 TS 层完成，两会话隔离验收通过

- `src/roster.ts`：服务器/账号记录类型 + 凭据解析器/服务器查找器接口（纯类型，零依赖）
- `src/runtime.ts`：SessionRuntime——每会话独立 MUD 连接 + 行流积累；connect（建连+login）/disconnect/dispose；pendingLines 供 C3 投递水位用
- `src/service.ts`：MudService——Map<sessionId, SessionRuntime> 注册表；register/connect/disconnect/status/dispose；依赖注入（serverLookup/accountLookup/resolveCreds）
- `src/index.ts`：宿主插件入口（cordis 插件）——agent/created → roster 判定 → register；session/disposed → dispose；remote.mud.{connect,disconnect,status}；内存 roster 先行（storage domain 待依赖解决后替换）
- 测试 10 项：两会话隔离（各连各服务器、互不串线）、状态隔离、生命周期（dispose 断连拆 runtime、disposeAll）、错误路径（未登记/未绑定/凭据失败）、行流积累、断线 onDisconnect——共 68 项全绿
- 宿主依赖（cordis/dsh-agent/dsh-typert-protocol）加入 package.json；index.ts 排除出测试 tsconfig
- 遵循 DSH 开发指南：插件入口为 `src/index.ts`（导出 name/inject/apply），`plugin.ts` 重命名合并

## [v0.0.4]C3 投递与接入落地 (2026-09-28 13:30)
> 总结：聚合投递器 + 接入闸门，端到端验证通过

- `src/deliver.ts`：Deliverer——每会话聚合投递器；行流按静默窗口（缺省 500ms）聚合成一条文本，经 deliver 回调以用户消息投递进会话（等同人工提问）；截断护栏（maxLines/maxChars）
- `src/service.ts`：MudService 加 admit/stop/status（含接入状态）；register 时创建 Deliverer 并接线到 runtime.onLine；dispose 时拆 Deliverer
- `src/index.ts`：投递回调接宿主 agent.followup + createUserMessage（source kind='mud'）；agent/created 记录 agent 句柄，agent/disposed 移除；remote.mud.{admit,stop} 动词
- 测试 11 项：接入闸门两态（未接入零投递/接入后投递）、停止后零投递、水位=接入时刻（积压不回放）、静默窗口聚合（一批=一条/两批=两条）、截断护栏（字符/行数）、生命周期（dispose/admit幂等）、两会话隔离——共 79 项全绿
- 宿主依赖加 dsh-llm（createUserMessage）；MessageSourceMap 声明合并 'mud' kind

## [v0.0.5]C4 管理面接线替换 (2026-09-28 14:58)
> 总结：mud-webui 从 v1 mud-core 接线替换到 core3，新增 preset 选择 + 接入开关

- `mud-remote.ts`：重写——v1 的 11+ 方法 → core3 的 5 方法（connect/disconnect/admit/stop/status）；去掉 typert 工件依赖（直接从 ctx.get('mudRemote') 取 service）
- `mud-state.ts`：重写——新增 preset/admitted 字段 + admit/stopAdmit 动作；去掉 tier/capability/command/captcha/bind/purge；localStorage key 升级到 v3；connectUser 只传 sessionId（服务器/凭据在宿主侧 roster 查找）
- `MudDialogs.tsx`：UserDialog 加 preset 下拉（mud-player/standard）；移除 CaptchaDialog
- `MudSidebar.tsx`：用户行 ⋯ 菜单加「接入/停止接入」；移除 tier 菜单项；接入状态徽标
- `client/index.ts`：简化为只注册 sidebar（移除 game/log views、rail、socket、bind、purge）；建账号链路带 cwd + agentPreset 传给 sessions.create
- 呈现不改（服务器/账号树形导航沿用 v1）；core3 的 79 项测试不受影响（webui 是浏览器侧，无 vitest）
- 删除不再使用的 v1 组件：GameView.tsx、LogView.tsx、Rail.tsx、mud-socket.ts
- 创建 `cordis.patch.yml`：mud-player preset（standard 全部插件 + MUD persona + mud-core3 preset 行）+ 引擎行 + webui 行；不覆盖 registry default（建账号时显式选 preset）
- 启动命令：`pnpm --filter mud-core3 build && pnpm --filter @deepseek-ai/dsh-mud-webui build && pnpm --dir D:/Code/deepseek-harness dsh web --patch D:/Code/dsh-mud-agent/packages/mud-core3/cordis.patch.yml --port 3082`

## [v0.0.6]C3/C4 审阅修正：连接与投递缺陷 + 装配接线 (2026-09-28 19:28)
> 总结：重连状态污染、投递无界/丢行、闸门谎报、插件包解析路径四类问题的修复与接线

- **连接（§2.3）**：`Mud` 引入连接代次——建连/断连自增，旧连接迟到的 text/boundary/close 一律丢弃；`disconnect` 改为**硬收尾**（立即销毁 socket + 同步 flush 残留行 → onDisconnect），不再半开关闭等待（半开连接仍收数据、迟到的 close 会把新连接判成断开）；`TelnetClient.destroy()` 新增；建连失败（对端拒绝/关闭）立即失败并销毁 socket，不等满超时；`runtime.connect` 增加"正在连接"并发保护
- **投递（§3.4）**：`Deliverer` 增加**批次最长等待** `maxWaitMs`（连续不静默也投出，原实现刷屏流永不投递）；超 `maxLines`/`maxChars` 改为**拆成多条依次投递（不再静默丢行）**；新增**缓冲上限** `maxPendingLines`（超出丢最旧 + `onDrop` 上报，index 侧限流告警）；`deliver` 回调返回 `false`（agent 离线/投递抛错）时**批次保留**，`agent/created` 经 `service.flushPending` 补投（原实现：注释说"等 agent 回来"，实际已丢）
- **runtime**：录制缓冲改为环形上限 `recordLines`（缺省 2000，`droppedLineCount` 可观），挂机模式不再无界增长
- **闸门错误面**：`admit`/`stop` 对未登记会话抛错（原为静默 no-op 却回报 `admitted: true/false`）；remote 动词返回真实 `admitted`（顺带消除 `status` 重复调用）
- **配置**：`MudCore3Config` 暴露 `deliverMaxWaitMs`/`deliverMaxLines`/`deliverMaxChars`/`deliverMaxPendingLines`/`recordLines`
- **清单与接线**：`main`/`exports["."]` 指向 `lib/` 构建产物；`@deepseek-ai/dsh-llm` 移出 `dependencies`（保留 peer+dev，避免 pnpm 提升到 profile 的 ② 层遮蔽 peer 拦截）；`zod` **保留**在 `dependencies`（生成工件 `typert.remote-client.js` 的运行时依赖，删除会导致 webui 打包出未解析 import）；cordis 4.0.2 → **4.0.4** 与宿主检出对齐（typert-protocol 镜像同步）并消除双副本；`gen:typert` 迁到 `mud-core3`（退役包移出 `PACKAGES` 与 `tsconfig.host.json` references，生成器依赖挂到 core3）；根 `pnpm dev` 增加 gen:typert 步，移除退役的 `dev:core2`；webui 移除退役 `@deepseek-ai/dsh-mud-core` 依赖、陈旧注释与死配置
- **装配（§3.1）**：活动 profile `node_modules` 建 `mud-core3` junction；实测 peer 拦截生效——**把插件本地 `@deepseek-ai` 挪走后插件仍可加载**，`dsh-llm`/`dsh-typert-protocol`/`cordis` 均解析到 DSH 检出的副本（0.1.7-rc.2 / 0.1.7-rc.2 / 4.0.4）
- 测试 79 → **93 项全绿**（新增重连隔离、建连失败、并发 connect、录制上限、最长等待、拆批不丢行、缓冲溢出、离线补投、闸门错误面）；新增回归用例在旧实现下 6 项失败、新实现下全过；core3 `tsc`（含 `index.ts`）+ `gen:typert` + webui `tsc`/build 全部通过
- 未动（待定范围）：§3.1 的 roster storage 域与 `remote.mud.*` servers/accounts CRUD、§2.2 建账号链路（`sessionId` = 账号 id + preset 选择）、`ctx.provide('mudCore3')`、接入状态持久化——属功能缺失而非缺陷，需产品决策后再实施

## [v0.0.7]C3 凭据接线 + 会话日志 + MUD 日志视图 (2026-09-28 20:05)
> 总结：连接失败的真实原因（凭据从未接线）修复；新增会话日志系统与诊断视图

- **凭据接线（真实连接失败原因）**：`apply` 的 `resolveCreds` 原为「未配置即抛错」的占位实现，`connect` 必然失败且只暴露一句占位错误。现改为接宿主 `ctx.get('credentials').resolve(passRef)`（账号名取自 roster，密文实时解析，明文不进日志/上下文）；`CredentialResolver` 签名从 `(passRef)` 改为 `(account)`，引用不存在时错误与日志都带引用名
- **会话日志系统**（`src/log/log-service.ts`，移植 v1 `MudLogService` 并改为按会话实例）：内存环（`logBufferMax`，缺省 2000）+ 按天 JSONL 落盘 `mud-YYYYMMDD-<sessionId>.log`（5MB 滚动 ×3，`logDir` 缺省 `<cwd>/mud-logs`，`logFile` 可关）；`seq` 从当日文件最大号续起；原始行流 `stream()` **只落盘不进环**；`purgeSessionLogs` 供删账号清理（只删本人文件）。滚动实现修正为真正的分片重命名（v1 版本会清零旧分片）
- **全程可诊断**：登记/建连/凭据解析/login 已发送/断连/销毁/接入/停止/投递（批次、离线保留、缓冲溢出）/网络层（telnet 协商、断线、协议异常）全部落日志；warn/error 同时镜像 `ctx.logger`；连接失败在日志里带 `host:port` 与完整错误（含 cause）
- **新动词 `remote.mud.logs(sessionId)`**：返回环条目 + 落盘目录；为此新增 `mud-core3/types` 公开子路径（typert 要求跨 Remote 边界的具名类型必须从非根子路径导出）
- **前端「MUD 日志」视图**（`conversation.view` 条目 `mud-log`）：`MudLogController` 按当前会话轮询 `remote.mud.logs`（1.5s，切换会话即换目标、丢弃过期响应），经 inject 面 `hooks.mudLog` 绑成 `useMudLog`；视图渲染级别/通道着色的日志行与落盘目录，含刷新按钮与空态。数据只走 hooks + inject 回调（组件不自订阅）
- 测试 106 项全绿（93 → 106）：新增 `test/log/log-service.spec.ts`（环/seq/落盘/流只落盘/清理/降级）与「连接失败可诊断」用例组（未绑定服务器、凭据失败带引用名、端口不可达、成功连接含 host:port 且明文不入日志）

## [v0.0.8]B 节补齐：名册落库 + 建账号一个动作 + 归属服务 (2026-09-28 20:05)
> 总结：名册有了写入者与持久化，建账号在宿主侧一个动作完成，连接链路端到端打通

- **名册落宿主 storage 域**（`src/store.ts`）：域 `mud` v1 两表 `servers`（键 = workspaceId）/`accounts`（键 = accountId = sessionId），记录 schema 是 zod 持久化边界事实源；`ctx.storageDomain.open` 打开，域不可用/打开失败降级 `MemoryRosterStore` 并 `ctx.logger.warn` 点名（`rosterStorage: false` 可强制内存）。记录里含 `admitted`（持久）
- **名册写路径**（`src/accounts.ts`，宿主解耦可单测）：`addServer`（键 = workspaceId）、**`addAccount` = 一个动作**（分配 `session-<uuid>` 作账号 id/sessionId → **先写名册** → 宿主 `sessionController.create({sessionId, cwd, agentPreset})` 建会话绑定 preset；失败回滚名册）、`removeServer`（仍有账号时拒绝）、`removeAccount`（清名册 + 清该账号日志）、`setAdmitted`（接入状态持久化）
- **新动词**：`remote.mud.{servers,addServer,removeServer,accounts,addAccount,removeAccount}`；`admit`/`stop` 同步落 `admitted`。`AccountRecord`/`ServerRecord` 随之跨 Remote 边界，`mud-core3/types` 子路径同步转发（typert 要求非根子路径导出）
- **归属服务**：`ctx.provide('mudCore3', { runtimeFor })`（§3.1；后期工具面的拒绝点）
- **前端接线替换**（§3.5，呈现不改）：页面 localStorage 降为呈现缓存，服务器/账号的增删经宿主动词；**建账号不再自己 `sessions.create`** —— 宿主 `addAccount` 返回账号（= 会话 id）后页面直接开屏；删账号/服务器先过宿主再改本地；失败写进侧栏状态行
- **本期做不到（宿主能力缺口，已记入设计）**：删除账号后会话本身无法销毁 —— 插件拿不到 `AgentHandle.dispose` 能力，`ctx.sessionController` 也没有 delete 动词；名册与日志会清，会话留在宿主体内
- 测试 119 项全绿（106 → 119）：新增 `test/store.spec.ts`（内存/域表/记录 schema/降级）与 `test/accounts.spec.ts`（先落名册的顺序可观测、id 与 preset 透传、失败回滚、删服务器保护、admitted 持久化）

## [v0.0.9]建账号开场消息：让新会话脱离 blank (2026-09-28 20:05)
> 总结：会话体只在非 blank 时渲染，而 blank 只由 turn/start 翻 —— 用一条真实开场消息解决

- **机制事实（写进设计 §2.2）**：宿主会话列表投影 `blank = state.blank && event.type !== 'turn/start'`（`api/session-controller/src/list.ts`）；blank 会话不渲染会话头/会话体（`DefaultConversationViews` 返回 null），所以 `conversation.view` 条目（含「MUD 日志」tab）在 blank 期间不可见；客户端另有一条 `promptAttempted` 的 engaging 边（用户首次发送即脱离 blank）
- **实现（`src/bootstrap.ts` + addAccount 动词）**：建账号成功后投递一条 MUD 源的**真实用户消息**（服务器/地址/账号/preset + 当前"未连接"状态 + "不要调用任何工具"），触发一次真实回合 → `turn/start` → 会话立刻活跃、会话体与 tab 渲染。**不伪造 `turn/start`**（会污染回合计数与 replay）；投递失败不影响账号落库。`bootstrapOnCreate: false` 可关（省一次模型调用；关掉后靠用户首条消息或 MUD 投递自动翻）
- 测试 121 项全绿（119 → 121）：新增 `test/bootstrap.spec.ts`（文本点名服务器/账号/preset/状态与"不调工具"；未登记服务器占位不抛错）

## [v0.0.10]C5 游戏画面视图 + C5.1 状态推送 (2026-09-29)
> 总结：右侧栏只读画面（headless 屏 + follow 流）端到端跑通；状态 tab 从 2.5s 轮询改为 watchStatus 推送；名册持久化与画面行流两处阻塞故障修复

- **画面通道（C5，`src/screen.ts`）**：每 runtime 一个 `@xterm/headless` Terminal + `@xterm/addon-serialize` 无头屏；游戏行与 send 回显（凭据走 sendCredential 不触发 onSend）同屏写入，区分色前缀；屏幕跨重连保留；Config 视图参数成组 `viewScrollback`(2000)/`viewCols`(80)/`viewMaxBufferedBytes`(2MB)
- **follow 流动词（抄 v1 typert stream 形态）**：`@Remote({ mode: 'stream' }) async *follow(sessionId, signal)`；roster 归属校验（未登记抛 session/not-found 语义错误，与 connect/logs/follow 共用统一错误面）；首帧 snapshot（serializer 整屏，含 ANSI）→ output 增量帧（同 tick 合批，超上限直吐）；follower 注册与 snapshot 生成共用一条 enqueue 写操作链（与行写入互斥，attach 瞬间不丢帧不乱序不重复）；follower 有界队列背压，超限显式断流，重新 follow 以新 snapshot 恢复
- **webui 画面 tab**：`sidebar-right` tab 类型 `mud-game`（multiple，params 随布局持久化，刷新/重开自动恢复）；只读 xterm（不挂 onData）+ addon-fit；`for await` + AbortController 消费，tab 关闭 abort 清服务端 follower；close handler 同步 abort；i18n locales（zh/en）；侧栏账号行「画面」按钮 + openTabIn 入口
- **状态推送（C5.1）**：runtime `onStateChange` 钩子（setState 统一入口，值变化才触发，全部赋值点迁移）；service 状态广播器 `subscribeStatus/emitStatus`（register/admit/stop/dispose 与连接迁移各点广播，单订阅者异常不拖累）+ `watchStatusStream`（queue + wake，首帧全量快照、之后仅变化推帧、finally 清订阅）；`remote.mud.watchStatus()` 流动词；webui `startStatusWatch` 替换 MudSidebar 2.5s 轮询定时器，`applyStatusRows` 复用原有落账逻辑
- **登录盲发回车（pkuxkx 类 MXP 探测闸解锁，一期最简方案）**：pkuxkx 在登录末尾等一次「回车」解锁普通模式，客户端不补这行则行流停在欢迎屏（房间后的闲聊/进出全部不来）；login 序列末尾（密码后 200ms）盲发一个空行
- **名册 storage 域时序修复（mud.json 不落盘的根因）**：storage-domain 的 provide 在异步装配之后，插件 apply 期同步 `ctx.get('storageDomain')` 拿 undefined；改为可选依赖三态——同步命中即挂 / 未命中 `ctx.inject(['storageDomain'], …)` 域就绪后挂 / `rosterStorage: false` 强制内存；域打开成功先将内存已写记录迁入域存储再切换（迁移幂等）；RPC 不等域（readyResolve 不阻塞）；`store.ts` open 失败的真实错误打到控制台（原空 catch 吞掉，困了排查两小时）
- **webui 启动对齐 + 统一错误面**：`mud-state.ts` 加 `hydrate()`——remote 挂载成功即拉 servers()/accounts() 用宿主真值覆盖 localStorage 呈现缓存（刷新/宿主重启后的假服务器/死会话在启动时清掉）；service.ts 统一「会话未登记」错误提示（可能宿主重启过或页面残留旧会话，请刷新页面后重连或重建账号）
- 测试 121 → **132 项全绿**：新增 `test/screen.spec.ts` 8 条（行写入含 ANSI 入 snapshot、send 回显入屏且凭据缺席、背压超限断流、断流后 re-follow 恢复、两会话屏幕隔离、headless 跨重连续写、follower 注册原子性、合批）+ watchStatus 3 条（首帧快照与变化推帧、连接生命周期推帧、多订阅者互不影响）；core3 构建 + `gen:typert`（follow/watchStatus stream descriptor）+ webui 构建全通过

## [v0.0.11]一期收尾：画面 tab 单开化与工具栏接线 + 文档同步 (2026-09-30)
> 总结：第一期（C1–C5/C5.1）全部落地并验收；画面 tab 单开守卫 + guide 入口 + 工具栏连接/断开按钮；设计文档对齐实现，一期收口

- **画面 tab 单开化**：`mud-game` 从 `multiple: true` 改为单开——右侧栏 guide 入口卡片（无 params 打开，回退跟随当前会话）；单开守卫订阅 `openTabs`，同会话开出第二个画面 tab 即关掉较新、保留最旧实例（其 follow 流与工具栏状态不中断；失效回调入微任务避让发布回路，幂等）
- **画面工具栏连接/断开按钮**：连接/断开入口从侧栏 ⋯ 菜单移到画面 tab 工具栏（调既有 `remote.mud.connect/disconnect` 手工动词，非画面通道输入）；`MudGameView` 适配只读模式的连接态展示，侧栏去重
- **cols 缺省修正**：headless 屏 cols 代码缺省 80 → **120**（`viewCols` 仍可覆盖；文档同步为 120）
- 样式微调：终端面板四周 margin/内边距、竖向滚动条收窄至 8px
- **文档同步（一期收口）**：`architecture/00-core.md` §3.5 对齐实现（单开守卫/guide 入口/工具栏接线/cols 120）、§4 验收表与 §4.1 切片表补 C5/C5.1 行、§5 后置清单补画面后置项与 C5.2 暂缓指针；`PLAN.md` 一期标记完成并清空已落地的 C5/C5.1 起草节（事实源已在 §3.5）；`ARCHITECTURE.md` 进度注更新
- **一期验收基线**：core3 测试 132 项全绿；§4 验收表全过（端到端：接入 → MUD 消息进会话 → agent 回答实机跑通）；待办仅剩 C5.2（已定稿暂缓，见 `doc/plans/c5.2-line-tagging-split-screen.md`）

## [v0.0.12]二期工具面落地 (2026-09-30)
> 总结：mud_send/mud_state 注册进 mud-player preset + 投递 pull 化（水位线 + turn/end 驱动）；agent 可向 MUD 发命令、查状态；132 → 174 项全绿

- **`src/read.ts`（新）**：`ReadMachine` 独立类（自 core2 竞速机移植）挂 SessionRuntime——判定序 `failOn > until > gaCount > maxLines` 写死；收束源 quiet/timeout/signal/disconnected/danger（`abortWait` 保留 API 供后置意识层）；swallow 吞行钩子空实现；`ReadResult.rest` 砍掉（逐行回调模型下自然并回）
- **投递 pull 化（水位线模型）**：`deliver.ts` 去自持缓冲，改注入 `LineSource`（seen/take/commit）；`runtime.ts` 双水位线 `deliveredAbs`/`readAbs`（seen = max，初始/断线复位 -1）+ `takeLinesAfter`/`commitDelivered` + `read()`（裸读 = 尾部 maxLines 快照；readAbs 推进）；失败批次不推进 delivered（下次从失败点重试不丢行）；`onBoundary` 直挂 readMachine（GA 判据）
- **投递时机 turn/end 驱动**：订阅宿主 `session/event`（global）——`turn/start` 抑制（不武装定时器）、`turn/end` 冲刷一次；空闲模式静默定时语义不变；冷启动补投 `flushPending` → `flushOnce`
- **`src/tools.ts`（新，纯层零宿主 import）**：`mud_send`（拒绝序：引擎缺席 → 归属 → 禁词 → 闸门 → 连接 → 执行，全部可读拒绝 `{ok:false,error}` 不 throw）/ `mud_state`（只过归属，不受闸门/连接）；禁词表最小集 `{ suicide }` 全段扫描（`[\s;]+` 切 token，堵 "look;suicide" 绕过）；compileListen 全空 = `{}`、缺省判据按模式注入（有 cmd `gaCount:1`、裸读 `quietMs:300`）；`timeoutMs` 钳制 ≤ 60000；注册完整性自检 fail-loud
- **`src/preset.ts`（新）**：preset 作用域注册入口（`lib/preset.js`），注册期不依赖引擎、执行期 `ctx.get('mudCore3')` 解析窄面；`cordis.patch.yml` preset 行追加 `mud-tools` 插件行；mud-player persona 追加工具说明
- **接线**：`ctx.provide('mudCore3')` 扩展 `toolContextFor`（roster 归属 + `{sessionId, runtime, admitted, connState}` 聚合）+ `defaults`；Config 新增 `sendTimeoutMs`(15000)/`sendMaxLines`(50)、**移除 `deliverMaxPendingLines`**（自持缓冲废弃，上限由 `recordLines` 承担）；peerDependencies 增 `@deepseek-ai/dsh-tools`
- **send 回显格式（实机验证后调整）**：命令回显带账号名@来源前缀——agent 发送 = `账号名@agent>` 灰（90m），user 发送 = `账号名@user>` 青（36m，为输入回传预留的既有样式）；`Mud.send`/`SessionRuntime.send` 加 `source` 参数，账号名由 `register` 从 roster 注入；凭据路径（sendCredential）不回显不变
- **画面工具栏按钮原生化（实机调整）**：连接/断开按钮从自绘样式改用宿主原生 `Button`（ghost/sm，随宿主亮/暗主题），删除自绘 `.toolText`/`.toolPrimary`
- **测试 132 → 174 项全绿**：新增 `test/read.spec.ts` 24 条（判定序/收束源/裸读/吞行钩子含钩子内同步 abortWait/并发 fail-loud）、runtime TCP 7 条（send+read/积压不进 acc/裸读/断线中断/水位线不重投/turn/end 冲刷/失败重试）、`test/tools.spec.ts` 8 条（注册自检/拒绝序/deny 全段扫描/闸门/连接/state 不受闸门/listen 编译/timeout 钳制）、screen 补 dispose 后 follower 断流 1 条、deliver pull 化重写 + service 增 toolContextFor 流转；build + typecheck 通过
- **文档同步**：`architecture/00-core.md` §3.3 工具面改现役（二工具/拒绝序/禁词表/ReadMachine/listen 编译）、§3.4 投递改水位线 pull 模型 + turn/end 驱动、§1/§3.1/§4/§5 对齐（验收表补工具面与水位线行、切片表补 C6、后置清单移除已落地的工具面项）

## [v0.0.13]一、二期文档收敛：PLAN 精简 + 切片记录同步 (2026-10-01)
> 总结：已交付的一、二期从 PLAN 起草区收敛为总结段；切片/验收记录补入正式章节（原主线编号 v0.0.11，合并时重排——编号让位于日期更早的分支条目）

- `doc/architecture/00-core.md`：§4 验收表补「画面与状态推送」行；§4.1 切片表补 C5/C5.1 两行；§5 后置清单补画面通道增强项（C5 后置项归档）
- `doc/pre-plan.md`：状态头更新——二期设计已随三期 T2a/T2b 实施，本文转为二期设计事实源；两项预设约束标注已被三期裁定取代
- `doc/PLAN.md`：一、二期详细设计原稿（切片表、C5/C5.1 起草）删除，各留一段总结；头部状态行同步（一、二期已交付，三期当前 = T4）

## [v0.0.14]pre-plan.md 并入正式章节并删除 (2026-10-01)
> 总结：二期工具面设计按现行真值（含三期修订）落 §3.3 转现役，起草文件退役（原主线编号 v0.0.12，合并时重排）

- `doc/architecture/00-core.md`：§3.3 由「工具面与流程（后置）」改写为「工具面（现役）」——注册与承载、工具清单、拒绝序（含三期修订注记：mud_send 不受接入闸门、连接升格 mud_connect）、行流持有者、ReadMachine、水位线 pull 模型（delivered/read 两线 + 投递时机 A/B/C + 失败不丢行）、read 与水位线、水位线语义总表、禁发表全段扫描、参数与 Config、已知限制；末注流程面归 mud-workflow 包（设计随三期收尾同步）；§3.4 闸门条目补三期修订（mud_send 例外）
- `doc/ARCHITECTURE.md`：章节地图 §1–§5 行补「工具面（§3.3）」「管理面（§3.5）」
- `doc/PLAN.md`：二期总结改指 §3.3；T2 裁定与「应答与水位」两处 pre-plan 引用改指 §3.3
- **删除 `doc/pre-plan.md`**（内容已全部并入 §3.3 或被三期裁定取代）
- 代码注释 `pre-plan §N` 引用改指 `§3.3`（deliver.ts / index.ts / preset.ts / read.ts / runtime.ts / tools.ts / test ×3）

## [v0.0.15]三期设计同步：归纳进正式章节 + PLAN 收缩 + 文档-源码矛盾修订 (2026-10-02)
> 总结：三期（状态面/流程面/自主行为）设计事实源落 00-core.md §3.6–§3.8；PLAN 三期收缩为总结；对照源码修订过期描述；消解与 b7b7082 分支的合并冲突（代码以三期主线为准）

- `doc/architecture/00-core.md`：新增 **§3.6 状态面**（两轴 conn/loggedIn + GMCP 权威登录信号 + World 世界状态：分区/置信度/来源追溯，断线整体复位）、**§3.7 流程面**（mud-workflow 独立包与纯度裁定、JSON 声明式步骤表、词汇表、注册表 locked 进化闭环、凭据红线双闸、解释器语义、五工具、workflowEnvFor 缝、login locked 流程与两条实测勘误）、**§3.8 自主行为**（kickoff 任务书面三触发点共用 + Config taskBrief、Wake 静默唤醒器三守卫、分工模型三层）；§2.2 开场消息改任务书语义（'mud-wake' 署名）、§2.3 登录改流程 login + 连接动词补 mud_connect、§2.4 凭据解析时机改登录流程执行时、§3.1 装配面重写（Wake 装配/kickoff 三触发点/parentLookup live 注册表/builtinFlows）、§3.3 拒绝序补归属父链上溯与三期修订（mud_send 只拒未连接）、§3.4 闸门补 mud_send 例外；§4 验收表补三期行（状态面/归属上溯/流程面/静默唤醒/自主行为）并融合画面与水位线行、§4.1 切片表补 T1–T4 行、§5 后置清单更新（删过期「流程 flows」行，补规则层/意识层/流程扩展/子级 deadline interrupt）
- `doc/PLAN.md`：三期详细设计原稿收缩为总结段（切片交付状态表 + T4b 实机验收清单 7 项 + T5 待办）；一二期总结与状态头同步；C5.2 暂缓指针保留
- `doc/ARCHITECTURE.md`：状态行补三期进度；章节地图与任务索引补 §3.6–§3.8
- **合并冲突消解（b7b7082 → 主线）**：mud-core3 引擎与测试代码以三期主线（新代码）为准；分支侧 webui 画面打磨（tab 单开/工具栏/MudLogo）与 C5.2 计划文件已自动并入保留；CHANGELOG 两侧同名版本条目按日期统一编号（本主线 2026-10-01 两条重排为 v0.0.13/v0.0.14）

## [v0.0.16]文档分层重排：按系统架构重列 §0–§17 + v1/v2 归档归位 (2026-10)
> 总结：doc/ 从"单文件五章"改为"按数据流分层的 §0–§17 多文件"；mud-core(v1)/mud-core2(v2) 整体移入 doc/archive/ 并建索引；三份仍属现役的材料提升为正式文件；过期门面与代码注释引用同步修正

- **归档归位**：`doc/mud-core/` → `doc/archive/mud-core/`（16 文件 / 1832 行）、`doc/mud-core2/` → `doc/archive/mud-core2/`（12 文件）；新建 `doc/archive/README.md`（整树作废声明 + 两套完整章节大纲 + v1 26 项/v2 20 项参考资产的 file+§ 坐标 + 已提升清单 + 编号沿革）
- **提升为现役**：① v1 `flows/login.md` → `doc/flows/login.md`（**v1 全集中唯一被现役代码当设计依据引用**的文档；按 core3 词汇表重写为 7 步 + `success` 出口，含两条实测勘误，并如实记录"名字与密码同走 `sendCredential`"）；② v1 附录 B 抓包事实 → `doc/appendices/A-capture-facts.md`；③ v2 `appendices/audit-checklist.md` → `doc/appendices/B-audit-checklist.md`（适配 core3/mud-workflow 与现役 §N 引用纪律）
- **重排**：退役 `doc/architecture/00-core.md`（旧 §1–§5 共 363 行单文件，§3 一章承载 8 个子系统）；拆为 9 个正文文件承载 §1–§17——`01-02-overview-host`（总览与总体架构 + L0 宿主平台）· `03-05-runtime`（接入层/行流层/消费层）· `06-07-channels-agent`（通路层 + agent 层）· `08-execution`（**L6 执行层单章，工具面与流程面不拆**）· `09-webui`（呈现层）· `10-11-state-lifecycle`（状态面 + 生命周期与状态机）· `12-14-security-observability-resilience`（安全/观测/错误降级）· `15-contracts-config`（契约索引 + Config 总表）· `16-17-acceptance-roadmap`（测试验收 + 演进路线）；入口 `ARCHITECTURE.md` 重写为 §0（规则 / 章节地图 / 任务索引 / **旧→新编号映射表** / 归档纪律）
- **新增章节**：§1 总体架构（**分层模型 L1–L7 + L0**、包与模块地图、**状态载体与单一真相表**、端到端数据流三条、**现役不变量 P1–P10**、术语表）；§2 宿主平台与集成（12 条已核实事实 + 依赖面 + 能力缺口 + 整批复核）；§4.3 水位线语义总表（层契约）；§5 消费层四消费者与水位契约；§6.6 通道正交性表；§8 执行层共享执行契约；**§15.5 Config 总表**（18 项逐条 + 硬编码项及理由）；§14 错误处理与降级；**§16.6 文档—实现一致性清单**
- **引用修正**：§8.15 对 login 判据的指向改为 `doc/flows/login.md`（含步表更正为实现的 7 步 + `success` 出口）；`doc/likely/c5.2-*.md` 的落点改为 §6.3（投递剔除）与 §9.4（画面通道双屏）；代码注释按 §0.6 映射表改指（`§1.1→§1.4`、`§2.1→§11.1`、`§2.2→§11.2`、`§3.1→§15.1`、`§3.3→§8`、`§3.4→§6`、`§3.5→§9`），并清掉两处 v1 归档残留编号（`wake.ts` 的 `§19` → §7.5、`link/corpus.ts` 的 `§16` → §13.4）与 `viewCols` 陈旧注释（80 → 120）
- **门面改写**：根 `README.md`（原称 `packages/mud-core2` 为"当前唯一生产路径"并提供 `pnpm dev:core2`，与退役裁定矛盾 → 改为 mud-core3/mud-workflow/mud-webui 现状与真实启动链）；`AGENTS.md` 检索规则重写（原指向不存在的"§1 不变量 / §2 术语"、`doc/flows/`、`doc/history/`、`§19.3`）
- **`PLAN.md` 重写**为计划起草区 + 待办池（T1–T9：T4b 实机验收、T5 收尾、一致性清理、C5.2、第四期自动重连、第五期进阶机制、归档资产再评估、宿主换代复核、会话删除面跟踪）；已落地的三期设计原稿按纪律清空（事实源在 §1–§17）
- **不回改历史行**：本文件既有条目中的 `doc/mud-core2/`、`doc/plans/` 等旧路径按"只追加"纪律保持原样；迁移映射由上表的 §0.6 映射表与 `doc/archive/README.md` 承担

## [v0.0.17]装配期缺陷修复：`ctx.agents` 未声明 inject 导致 `apply` 失败、remote.mud 全动词 404 (2026-10-02)
> 总结：实机建账号报 `mud/addAccount ... HTTP 404` 的根因不在路由/前端——`mud-core3` 条目启动期 "1 entry did not activate"，`apply` 抛 `cannot get property "agents" without inject`，remote 面整体未注册

- **根因**：`src/index.ts` 装配期读 `ctx.agents`，而插件 `inject = ['typert']` 未声明 `agents`；cordis 的属性代理对未声明服务抛 `cannot get property "agents" without inject`（`vendor/cordis/src/reflect.ts:144`）⇒ `apply` 整体失败 ⇒ `remote.mud` 全部动词（含名册 CRUD）在网关 `claimsEndpoint` 判定为未注册 ⇒ 一律 404
- **表现误导性**：建服务器那步的 `addServer` 失败被页面状态行吞掉（`src/client/index.ts` 的 `.catch(reportError)`），页面本地名册照常渲染 ⇒ 只有建账号在向导里把 404 抛给用户
- **修复**：改 `ctx.get('agents')`（**可选服务，不写进 inject**）+ **调用期解析**（`const agentsLive = () => …`，apply 期提供方 fiber 未必 ACTIVE，与 `storageDomain` 同一课 §14.3）；新增窄结构面 `AgentsLive`；缺席/未就绪 ⇒ 父链上溯终止（§2.3 既有口径不变）
- **文档同步**：§2.3 依赖面 `agents` 行取用改 `ctx.get('agents').get(id)`（调用期解析）+ 缺面行为明确"服务缺席或提供方未 ACTIVE"；§15.2 补"取用走 `ctx.get`（不写进 `inject`）"与反面教训；§8.5 归属上溯同一处改指
- **流程补强（§16.1）**：新增纪律行「**装配层必过宿主组合加载冒烟**」——纯层用例不加载插件，`index.ts` 改动后必须真加载一次并确认条目已激活（无 `1 entry did not activate`）；本缺陷正是纯层 207 例全绿而装配期即死
- **回归护栏**：新增 `test/plugin-load.e2e.ts`（**工件面** e2e：加载 `lib/index.js` 的插件 → 只提供 `typert`，`agents`/`credentials`/`sessionController`/`storageDomain` 全缺席 → 断言引擎窄面 `mudCore3` 与 remote 服务 `mudRemote`（namespace `mud`）在册）；`vitest.config.ts` 的 `include` 增 `test/**/*.e2e.ts`（缺产物自动跳过）。**已验红后绿**：把装配期读回退成 eager `ctx.agents` 时该用例报出与宿主同一条 `cannot get property "agents" without inject`，修复后转绿。用例账目 207 例 / 16 文件 → **208 例 / 17 文件**（§16.2）
- **记录到的工具链约束**：插件源含标准装饰器（`@Remote`），vitest 的 esbuild 转译不支持（`Invalid or unexpected token`）⇒ 装配层冒烟**只能走 `lib/` 产物**，与宿主实际加载面一致（§16.1）
- **未改**：`inject` 保持 `['typert']`（`agents` 按可选依赖处理）；`ctx.logger`/`ctx.on`/`ctx.provide`/`ctx.inject` 等与 inject 无关的用法不动

> AI生成
