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

## [v0.0.18]webui 账号编辑 + §16.4 实机勾验 1–4 (2026-10-02)
> 总结：T4b 实机验收 1–4 通过；侧栏账号行补「编辑」能力（改名 + 改密码）

- **§16.4 实机勾验 1–4**（真机 + 凭据）：建账号任务书回合 / admit 状态任务书 / 根委派→子 login→结算→根收尾 / 错密码中途失败（正常报错，自主重试一次后向人类提问）逐项通过，清单行已勾
- **webui 账号编辑**：账号行 ⋯ 菜单增「编辑」项 → UserDialog 双模式（create/edit）：改名经 `remote.mud.updateAccount` 落名册并同步 runtime 回显前缀（`accountName`）；改密经 `credentials.set` 按原引用名覆盖写入（不动名册），下次连接/登录流程生效；preset 建会话时已绑定装配，编辑态只读（提示删号重建）
- **host**：`accounts.ts` 新增 `renameAccount`（不在名册/空名拒）；`MudRemoteService` 新增 `updateAccount` 动词（typert 工件已重生成）；用例账目 208 → **210 例 / 17 文件**全绿
- **未做（用户裁定暂缓）**：建账号时「是否立即接入」逐账号选择（自动接入语义澄清：名册 admitted 建账即 false、无自动 admit 路径，观察到的「自动接入」实为 `bootstrapOnCreate` kickoff——建账号即投任务书触发 agent 回合）；「先连接后接入」路径待后续单独立项

> AI生成

## [v0.0.19]接入语义重定：建账号纯登记 + LLM 调用面闸门 (2026-10-02)
> 总结：建账号触发点退役，接入 = 唯一任务书点火点；新增 `llm/stream` 瀑布终审（未接入拦成空 stop）

- **接入语义规格（2026-10-02 裁定，四层面）**：闸面（Deliverer admitted + 水位）+ 持久面（名册）+ 点火面（onAdmit → kickoff）+ 保险面（LLM 调用面闸门）——admit 同步先置位再点火，钩子时序上必放行；接入永远是冷启动点火（未接入 ⇒ 无驱动源 ⇒ 无回合）
- **建账号 = 纯登记**：`bootstrapOnCreate` 配置退役（MudCore3Config 字段删除、§15 表 14 行注销），addAccount 不再投任务书，会话保持 blank、agent 零行动；blank 由第一次接入的 kickoff 真实回合翻（不伪造 turn）
- **LLM 调用面闸门（§7.4.1）**：宿主 `LlmRuntime.stream()` 走 cordis 瀑布 `llm/stream`（不调 `next()` 即否决，官方契约），`GenerateOptions.sessionId` 由 loop 盖会话身份戳 → 按 session 精确作用域。纯层 `src/llm-gate.ts`（`shouldVeto` + `vetoStopStream`，fail-closed：非本插件会话放行、投递器缺席 = 未接入）；index.ts 注册监听器（插件 fiber，卸载自拆），未接入账号会话的模型调用拦成单条 `finish: stop` 终块（0 token、无内容块、回合自然收束）
- **停止接入的新语义**：进行中回合在下一步 LLM 调用处空步收束——在飞工具正常完成、无 cancelled 残迹，不 cancel 不打断；未接入时人工提问同样被拦（agent 完全惰性）
- **触发点收缩**：kickoff 三触发点 → 两触发点（admit/静默唤醒）；MudRemoteService 构造参数撤 `announceOnCreate`
- **文档**：§7.4 重写（两触发点）+ 新增 §7.4.1；§11.2 建账号流程第④步改纯登记 + blank 语义；§15 表 14 行注销；§16.3 静默唤醒行更新；§16.4 清单 1–2 重定（1'/2' 待复验，3–4 勾验保留）
- **用例账目**：210 → **216 例 / 18 文件**全绿（新增 `test/llm-gate.spec.ts` 6 例：无戳放行/非本插件放行/未接入拦/已接入放行/fail-closed/合成流单终块）

> AI生成

## [v0.0.20]重启恢复 = 冷启动纪律（语义澄清，无行为变更）(2026-10-02)
> 总结：宿主重启后历史会话一律回到未接入，人工点接入再点火；名册 `admitted` 语义定为「最近状态记录，恢复不回读」

- **裁定**（用户）：恢复不回读接入态、不自动点火——冷启动不自动（同 T5 自动重连纪律）；重启后两轴全 unknown，自动点火 = agent 醒来即自主连游戏
- **代码事实澄清**：Deliverer 恒 fresh 未接入（原实现已如此），名册 `admitted` 为只写不读的最近状态记录；admit/stop 注释写明恢复不回读
- **文档**：§11.2 新增「重启恢复 = 冷启动」条目；§16.4 2' 复验项补重启场景
- 无代码行为变更、无用例账目变化（216/216 维持）

> AI生成

## [v0.0.21]实机验收勾验 + 两项 webui 修复（画面自动打开 / 服务器端点去重）(2026-10-02)
> 总结：§16.4 清单 1'/2'/5/6 勾验（5 为用户裁定通过）；接入成功后右侧栏画面 tab 自动打开；服务器按 host:port 端点去重

- **实机验收（用户反馈）**：1' 建账号纯登记（随 2' 同轮观察）、2' 接入唯一点火（含人工提问被拦）、6 admit 前手动连接不触发规划——实机通过；5 静默唤醒实机窗口难构造，用户裁定先算通过；剩余仅 7（webui 三 tab 实机巡检）
- **画面 tab 自动打开**（§9.4）：admit 成功 ⇒ 切到该账号会话 + `openTabIn(sessionId, 'mud-game')`（宿主 openTab 同步展开右栏）；重复打开由单开守卫收编；跨包 SessionId 品牌不互通，用 `Parameters<>` 窄结构代位 cast
- **服务器端点去重**（§9.2）：同一 `host:port`（大小写不敏感）只允许一个服务器条目——客户端 addServer 前置查重（避免先建孤儿工作区），宿主 `addServer` 同规则拒绝（权威闸，可读报错）
- **监听器契约合规**：index.ts 四个 block-body 事件回调补显式 `return undefined`（官方声明 `undefined | Promise<undefined>`；TS 6.0.3 放宽该赋值而编辑器旧 TS 报错，显式合规双版本皆绿）
- **文档**：§9.2 端点去重、§9.4 自动打开、§16.4 勾验更新
- **用例账目**：216 → **217 例 / 18 文件**全绿（accounts.spec 增端点去重 1 例：同端点/大小写变体拒绝、异端口放行）

> AI生成

## [v0.0.22]workspace 循环依赖消解（login E2E 平移回 core3）(2026-10-02)
> 总结：mud-workflow 删 `mud-core3` devDep，core3↔mud-workflow 环消解（pnpm 构建警告清除）；login 流程 E2E 五路径随实体归属平移

- **环边事实**：core3 devDep mud-workflow（流程实体 type-only）+ mud-workflow devDep mud-core3（仅 `test/login.spec.ts` 的 E2E 桥接）——后者是唯一环边
- **平移**：`login.spec.ts`（五路径，随 [flows/login.ts](packages/mud-core3/src/flows/login.ts) 归属）→ `packages/mud-core3/test/`；stripIac 复用 core3 test helpers
- **出口面**：mud-workflow index 增 `runFlow` + `WorkflowEnv` 出口（E2E 消费）；core3 `./runtime`/`./flows` 桥接出口退役（跨包 E2E 已无，唯一用途消失）
- **文档**：§16.2 用例账目更新；归档 README 的 login.spec 路径指针不回改（归档纪律，追溯用途）
- **用例账目**：core3 **222 例 / 19 文件**（+login 5）· mud-workflow **31 例 / 3 文件**（−login 5），总量不变、全绿；`pnpm install` 无 cyclic 警告

> AI生成

## [v0.0.23]T4b 实机验收关闭（T4 自主行为正式完成）(2026-10-02)
> 总结：§16.4 七项清单全项通过（用户确认第 7 项三 tab 巡检通过），T4b 验收关闭、PLAN 待办池清空 T1

- **验收结论**：建账号纯登记 → 接入唯一点火 → 根规划/子执行/宿主结算 → 静默唤醒兜底，链路完整（§16.4 增验收结论行）；第 5 项静默唤醒为用户裁定通过（实机窗口难构造，待日常观察）
- **文档**：§16.4 第 7 项勾验 + 验收结论；§16.5 T4 行、§17.1 三期行改「实机验收通过」；§17.2 待办池删 T4b 项并重排（剩 4 项：T5 收尾 / §16.6 清理 / 会话删除面 / 装载冒烟）
- **PLAN**：待办池 T1 条目删除（落地纪律），留一行结论指针
- 无代码变更；用例账目维持 core3 222 / workflow 31 全绿

> AI生成

## [v0.0.24]T5 收尾（T11）：StatusRow 边界窄面 + webui 状态呈现（画面 HUD 条）(2026-10-02)
> 总结：`loggedIn`/`world` 过 Remote 边界（lessons learned 中 T5 收尾项收口）；呈现形态经讨论定为画面 HUD 条（`<details>` 折叠块方案否决作废）

- **边界窄面**：`StatusRow`（service.ts 新增，`statusRowOf` 映射两动词共用）——`sessionId/state/admitted/loggedIn` 直传 + `world` **扁平数组** `{zone,key,v,c,sk,st}`（值 JSON 字符串化，`unknown` 不过 typert 边界；扁平数组避开 index signature 过生成器）；`status()`/`watchStatus()` 改用；`types.ts` 转出口 + gen:typert 重生成清零
- **webui 扩面**：`MudStatusFrame`/`SessionStatusRow` 本地窄接口对应扩面（不 import core3 类型）；`status()` RPC 返回面同步
- **呈现（用户裁定 = HUD 条）**：画面 tab 工具栏下单行横条 chips（`key = 值`，超宽截断悬浮全值 + 来源/置信度 tooltip），`watchStatus` 推帧驱动，inject face 增 `hooks.servers` → `useServers` selector；无条目不占位、断线复位即消失；侧栏账号行「已登录」徽标
- **文档**：§9.4 HUD 条行、§9.5 边界窄面收口、§16.2 账目、§16.5 T5 收尾行、§16.6 #7 已清、§17.2 删 #1
- **用例账目**：core3 **224 例 / 19 文件**（+statusRowOf 2 例）· workflow 31 不变，全绿；core3/webui build 绿

> AI生成

## [v0.0.25]T11 状态呈现重设计：HUD 表格式 + 聊天区日志视图拆分 + 侧栏瘦身 (2026-10-02)
> 总结：实机反馈驱动的呈现迭代（chips 横条 + 侧栏徽标过载 → 用户裁定表格化 + 日志视图拆 20% + 徽标瘦身）

- **MudHudTable 共用组件**（client 新增）：键|值两列，首行固定登录轴（已登录/未登录标签），GMCP 条目逐行（值等宽截断、悬浮全值 + 来源/置信度/时刻）；消费方 = 画面 tab（工具栏下，容器 max-height 30%）+ 聊天区日志视图（**上部 20% 常驻**，`conversation.view` entry body 内部拆分——宿主 slot 查证零新依赖）
- **侧栏瘦身**：「凭据已配置」「已登录」徽标移除（登录状态在 HUD 表首行；凭据正常态编辑弹窗可见、连接失败带引用名报错），只留「已接入」+ 凭据异常态（无密码/未配置/只读）
- **文档**：§9.3（日志视图 HUD 区）、§9.4（HUD 表）、§9.2（徽标瘦身）
- **验证**：webui build 绿（chips 样式清理）；core3 零改动（数据面沿用 StatusRow）

> AI生成

## [v0.0.26]T11 收敛：状态表单表化，画面 tab 撤 HUD (2026-10-02)
> 总结：用户裁定画面里不放 HUD——状态表唯一表面 = 聊天区日志视图上部 20%

- **MudGameView 撤 HUD**：表格块/`hudBar` 样式/`hooks.servers` 注入面/`hudWorld` 词条全清（回到纯画面 + 工具栏）；`MudHudTable` 组件保留（日志视图专用）
- **文档**：§9.4 画面 tab 无状态表注记、§9.3 日志视图 = 唯一状态表面
- **验证**：webui build 绿；core3 零改动

## [v0.0.27]登录轴三态：声明判据先行 inferred，GMCP 权威加固 in-game (2026-10-03)
> 总结：实机反馈驱动——原 GMCP 单源导致登录行长期停在「未登录」（首个 GMCP 包要等进入世界才来）；按「声明判据 = 100% 置信先行，GMCP 加固」改为三态

- **三态**（`LoggedInState = 'unknown' | 'inferred' | 'in-game'`，world.ts）：`inferred` = 已连接且行文命中声明判据（低置信先行，不等 GMCP）；`in-game` = GMCP 到达加固（覆盖 inferred，不降级）；断线复位 `unknown`
- **声明判据**（runtime.ts `WELCOME_RE`）：`/目前权限：\(player\)|重新连线完毕/`——与 flows/login.ts 成功判据同源；「欢迎来到」不可用（与建连横幅「欢迎来到北大侠客行」撞车，login.ts 文件头勘误）
- **接线**：runtime `mud.onLine`（screen.write 后、readMachine 前）判据命中置 inferred + `onWorldChange` 推帧；GMCP 路径注释同步
- **呈现**：`StatusRow`/`SessionStatusRow`/`MudStatusFrame` loggedIn 联合扩三态（gen:typert 重生成）；`MudHudTable` 登录行三态渲染——inferred 琥珀色「已登录（推断）」、in-game 绿「已登录」、unknown「未登录」
- **测试**：world.spec.ts 新增「登录轴三态」3 用例（判据→inferred→GMCP→in-game；in-game 不降级 + 断线复位；inferred 断线复位）——core3 227/227（19 文件）全绿
- **文档**：§10.1 三态、§10.2 改「声明判据先行 + GMCP 权威加固（三态）」、§10.3 置信度说明、§10.4/§11.3/§11.8 转移图补 inferred 中间态

## [v0.0.28]投递失败原因进会话日志 + T3 文档一致性清理关闭 (2026-10-03)
> 总结：实机投递「中途报离线」文案误导（实为攒批/回合计时），投递链路补诊断；§16.6 清单复核后关闭 T3

**投递诊断**
- `DeliverFn` 三态返回（deliver.ts）：`true`/`undefined` = 已投出；`false` = 未投出（无原因，按句柄缺失处理）；**字符串 = 未投出 + 失败原因**，经 `onBatch` 第 4 参进会话日志
- deliverer `tryDeliver` 收编 deliver 回调抛错（不逃逸定时器路径），错误文本转为原因字符串
- 日志文案区分：失败改「投递未达：N 行未投出（水位不推进，待补投）——<原因>」，不再一律称「agent 离线」
- `turnStart`/`turnEnd` 各加一条 debug 会话日志（回合开始抑制 / 回合结束冲刷），便于对时序
- index.ts deliver：句柄缺失 → warn + `false`；followup 抛错 → warn + 原因字符串
- 测试：deliver.spec.ts 新增诊断用例（原因字符串 / 抛错收编，onBatch 携 reason、水位不推进）——core3 228/228（19 文件）全绿

**T3 文档一致性清理（关闭）**
- §16.6 #1–#5 复核确认已在文档重写期修毕（viewCols 注释 120、wake.ts §7.5、corpus.ts §13.4、README 在役/退役表、AGENTS.md 检索纪律）
- src 注释现存 § 引用全面扫描：全部现役编号或正确带版本前缀（`v2 §7.2`/`v2 §5`），无归档编号残留
- README 文档地图「待办池（T1–T9）」过时行更新；PLAN.md 删 T3 并注记关闭，§16.6 表全部标已清（#6 不回改 / #8 宿主缺口除外）

## [v0.0.29]login 判据实机勘误 ③：单形态 + 行首锚 + 动态用户名 (2026-10-03)
> 总结：实机观察驱动——判据收窄防聊天语句误触发；三处正则硬伤修正（`(yes)` 捕获组、`\s*` 桥不上动态用户名、`^` 无 'm' 锚窗首永不命中）

- **判据**（login.ts）：`NEED_NEW_SRC` = `^同意玩家须知并使用\S+创造一个新的人物，您确定吗\(yes\)？|^对不起，你的英文名字只能用小写英文字母。`（`\S+` = 内嵌动态用户名；`(yes)` 括号转义）；`NAME_SRC`/`PASS_SRC` 收窄实机单形态（短形态「您的英文名字：」、裸「请输入密码：」弃用）；`BAD_PASS_SRC` 第三条改「忘记密码」提示行前缀
- **flags 'm'**：`prompt-name`/`prompt-pass` 两步 wait 补 `flags: 'm'`——`^` 行首锚必须配 'm'（整窗按行 join 匹配，无 'm' 时 `^` = 窗首，提示行在横幅后永不命中）
- **测试**：login.spec.ts 假服务器换实机原文（单形态提示、need-new 整句含动态用户名、`密码错误！`）——core3 228/228（19 文件）全绿
- **文档**：doc/flows/login.md 步表/判据常量表/设计要点（新增勘误 ③）；附录 A.1 补 need-new/名字非法实录行 + 硬约束 ③

## [v0.0.30]§8.13 增判据书写纪律 + 模式声明扩展否决记录 (2026-10-03)
> 总结：判据匹配模型讨论沉淀——整窗匹配模型下 `.` 无 `/s` 天然行安全，「判据模式声明」无例证否决留档

- **§8.13 新增「判据书写纪律（整窗匹配模型）」**：① 行首锚必配 `flags: 'm'`（无 'm' 锚窗首）；② 单行意图天然行安全（`.` 无 `/s` 不越行），跨行意图必须显式；③ 量词不越行（`\S+` / `[^\n]*`，跨行显式写 `\n`）
- **未来扩展方向否决留档**：「判据模式声明」（单行/多行各跑各的）无例证不立项——`.` 已行安全、逐行匹配更慢、混合模式与声明序裁定冲突；出现真实误判例证再评估

## [v0.0.31]投递失败退避重试（实机日志闭环） (2026-10-03)
> 总结：实机日志拿到「agent 离线」真因 = 宿主 append 发布重入保护（瞬时竞速）；投递器补失败退避自愈，行流安静时不再挂到静默唤醒

- **根因（实锤）**：`turn/end` 冲刷与宿主回合末输出发布竞速，followup 撞 `session append cannot reenter while another append is being published`；此前失败后仅停留 pending 等下次自然触发，行流安静时会挂到 120s 静默唤醒
- **修法**：[deliver.ts](packages/mud-core3/src/deliver.ts) 失败退避——瞬时失败（原因字符串）按 `quietMs` 起步倍增至 `maxWaitMs` 封顶自动重试，成功复位；句柄缺失（false）不重试（恢复路径 = agent/created 补投 + 静默唤醒不变）
- **测试**：deliver.spec.ts 新增退避自愈 + false 不重试用例；core3 229/229 全绿

## [v0.0.32]委派模式改一次性前台（§7.6） (2026-10-03)
> 总结：委派从「continuable 后台 + 结算唤醒」改为「一次性前台 + 工具结果回注」——旧子不可寻址、不可续用；控制工具行与 fork 行撤除，后台参数关闭

**preset 行**（`packages/mud-core3/cordis.patch.yml`）
- `tool-subagent`：`backgroundMode: continuable` → `one-shot`，并加 `enableRunInBackground: false`（调用等到子收尾，收尾文本作为工具结果返回根）
- 删除 `tool-subagent-control` 与 `tool-subagent-control/list-agents` 两行：`send_message` / `interrupt_agent` / `list_agents` 只对可继续子有效，注册面撤除即关闭"新委派落到旧子上下文"的显式寻址通道
- `tool-subagent-fork`：**删行**（`subagent_fork` 不再注册）——fork 子按宿主 `seed` 注入父级**整段已完成轮次前缀**，与本仓"子看不到父历史"的隔离收益直接冲突，且本仓 persona 从不使用 fork
- persona 分工协议三条重写：委派 = 一次性前台调用；子的收尾文本即工具结果；新要点重新委派**新的**子（每次全新上下文）

**注释**
- `src/wake.ts`、`src/index.ts`：去掉"结算唤醒归宿主（watchSettlement）"措辞，改为"委派结果走 subagent 工具返回值，插件不查子级"

**文档**
- §7.6 新增「委派模式（2026-10-03 裁定）」表（创建路径 / 不挂的控制工具 / 不注册的 fork 工具 / 根的等待形态 / 取消 / 持久残留），分工图与 persona 五条按新口径改写，标题由"四层分工"改"三层分工"
- §7.5 守卫纪律删"结算已消化"措辞并注明：子运行期间根回合未结束，守卫 ② 自然抑制唤醒
- §1.5 分层图 / §1.9 术语表：`宿主结算` → `委派结果`，`结算` 行改写为「委派结果」行
- §2.1 新增宿主事实 13（subagent 两条创建路径与 `backgroundMode` 选路、父会话目录两种模式都记）；§2.5 复核范围改指"子 agent 委派语义"
- §2.4 / §14.5 新增缺口行：**宿主无子会话清退/归档面**（`ctx.subagents` 只有驻留 Activation 释放与列举，无删除会话或归档目录条目的动词）⇒ 子会话记录与目录条目永久只读留存；§17.2 #2 同步扩写
- §10.5、§14.4（子失败 / 子级预算两行）、§16.3 自主行为行、§17.3 子级预算行按新口径重写
- §16.4 #3/#4 保留原实机记录并标注"委派口径 2026-10-03 变更，待按新路径复验"，验收结论下补口径变更说明
- 顺带勘误：§1.8.3 登录链路首行"建账号 → 投任务书"改为"建账号（纯登记）→ 接入（唯一点火）"，与 §7.4 的 2026-10-02 裁定对齐

**成本口径（供 T9 跟踪）**
- 运行时不占容量：一次性 run 结算即释放，`maxActiveSubagents`（缺省 8）只数**存活** Activation
- 持久增长 = 每次派发一份子会话日志 + 父会话一条 `subagent/catalog` 事实；目录读取与列表成本随累计派发数线性增长，宿主当前无清退面

> AI生成
