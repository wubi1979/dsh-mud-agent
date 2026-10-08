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

## [v0.0.33]C5.2 行打标与画面分屏落地 (2026-10-03)
> 总结：`doc/likely/` 定稿文档立项执行完毕——聊天/他人动作提取到副屏窗口（人观察 + agent 去噪），安全前提「聊天不进 agent」在投递侧落地

**core3 侧**
- [line.ts](packages/mud-core3/src/link/line.ts)：`MudLine` 加 `kind: string | null`（commitLine 缺省 null，link 层保持纯净）
- [classify.ts](packages/mud-core3/src/classify.ts)（新模块）：分类规则 = 正则清单声明序取首个命中；缺省只预置 `chat`（`^\s*【[^】]{1,6}】`，logs/ 实录 6/6 命中零误报），`action` 零例证规则留空（Config 扩展位保留）；非法正则 fail-loud 拒装
- [classify.ts] 缺省规则扩为三族（2026-10-03 实机房间语料补例证）：`action`（他人动作/进出，锚行尾 + `^(?!你)` 主语排除——自身活动一律「你」开头；`冲了过来` 战斗接近不收，留给 danger 判据）、`vitals` 新 kind（他人状态刷屏如真气循环，同主语排除；**自身状态/警告保留主屏**，用户裁定）；**房间说话暂不打标**（等漏出量实证再按「非你主语」补，用户裁定）——core3 247/247 全绿
- [runtime.ts](packages/mud-core3/src/runtime.ts)：`mud.onLine` 处理器最顶部单点打标（全系统唯一一次分类，先于录制/画面路由/投递），classifier 可注入
- [screen.ts](packages/mud-core3/src/view/screen.ts)：`write(text, kind)` 路由——无标行走主屏无头屏（零改动），有标行进副屏**有界行环**（cap 缺省 1000 行）；帧双串 `GameSnapshotFrame{screenMain,screenSub}` / `GameOutputFrame{main,sub}`（不是两条流，队列/背压/断流重连语义零改动）；行环追加入 flushNow 操作链（与快照同链同序保 attach 原子性）
- [deliver.ts](packages/mud-core3/src/deliver.ts)：有标行不进投递（白名单 `allowKinds` 可放行），有标行视为已见（水位越过）；闸门/水位/聚合语义不动
- service/index：Config 加 `viewSubCap` / `classifyRules` / `deliverAllowKinds` 三扩展位

**webui 侧**
- [MudGameView.tsx](packages/mud-webui/src/client/MudGameView.tsx)：s2 无关文本栏（第二只读 xterm，画面下方占 30% 高、上下 3/7 分屏，可折叠，折叠保持挂载继续吃帧）；快照/增量双屏分发（前端零 kind 逻辑）；工具栏加折叠按钮；**follow 冷启动自愈**——tab 随布局恢复/自动打开早于 runtime 登记时开流即抛「未登记」，流死掉后接入内容收不到（须手动刷新），改为异常/自然结束 1.5s 退避重挂直到成功或 tab 关闭
- [MudGameView.module.css](packages/mud-webui/src/client/MudGameView.module.css)：`.panes` 分栏 + `.subHost`/`.subCollapsed`；[locales.ts](packages/mud-webui/src/client/locales.ts) 补 `collapseChat`/`showChat` zh/en

**测试与文档**
- classify.spec.ts（新，8 例：语料回放打标 / runtime 单点 / action 注入 / 声明序 / 非法正则 fail-loud）；screen.spec.ts 字段改名 + 5 条 C5.2 用例（路由互斥完备 / 双字段出帧 / 纯有标行 / 行环 cap / attach 原子性）；deliver.spec.ts + 4 条剔除用例——core3 246/246（20 文件）全绿，workflow 31/31，webui build 绿
- §6.3 补「有标行剔除」一句；§9.4 数据面/消费/帧处理/工具栏改双屏口径；C5.2 文档状态改「已执行（2026-10-03）」并留执行偏差记录

> AI生成

## [v0.0.34]§17.3 登记心跳探针实测结论 (2026-10-04)

- **实测**（[probe-heartbeat.mjs](packages/mud-core3/test/probe-heartbeat.mjs)，零依赖最小客户端探针，mud.pkuxkx.net:8081 两次实机运行）：全自动登录（编码选择 2 → 名字 → 密码 → 覆盖 y）后客户端**零发送 240s**，入站 = **0**（无 telnet NOP/AYT/GA/GMCP 推送）→ **服务端无主动心跳**；GMCP 仅 `GMCP.System`/`GMCP.Move` 且只在人物移动时推送。30s 短观察窗复跑消歧，入站仅游戏世界事件。
- **客户端心跳候选实测**：telnet **AYT(246) 有显式应答 `[-Yes-]`+GA**（唯一可判活信号）；空行回提示符+GA 次之；NOP / GMCP Core.KeepAlive / Core.Ping 静默接受无应答（首次运行 Core.Ping 后 ECONNRESET 曾疑似其所致，短观察窗复测无 RST 排除）；look 对照全链路存活。
- **文档**：§17.3 自动重连行登记实测结论（前置已消解，待立项）；PLAN.md T5 前置项更新为「已完成」并补范围（服务端主动重启断线覆盖；fullme 活跃度为独立周期任务，不与探活混同）。
- 探针附带发现：fullme 活跃度机制（长期不用被系统判机器人、信息降级）；服务端广播重启预告（实测时再过 10.5h 重启）。

> AI生成

## [v0.0.35]T5 自动重连落地（探活 + 自动重连 + webui 探测中呈现）(2026-10-04)

- **探活**（T5.1）：`link/keepalive.ts` 纯层（ProbeState `idle|probing`、attempts 计数、retryMs 重发、`observeLine`/`observeBoundary` 判活、幂等 cancel）；探活插在静默唤醒到期点（Wake.onExpiry 传输面守卫全过后、fire 之前，阈值复用 `silenceMs`）；判活完成到期唤醒（静默不重新累计）、判死转硬收尾+自动重连、探测期间抑制一切后续到期；telnet 层加 `sendAyt`，应答判据 `^\[-Yes-\]`（GA 主路径，行刷出 300ms 兜底），`[-Yes-]` 吞行不进流/画面/投递。
- **自动重连**（T5.2）：runtime 两标记 `hasConnected`/`manualDisconnected`（手工断开与冷启动不重连）；service 重连循环限次放弃（缺省 5 次 × 30s，`reconnectMaxAttempts`/`reconnectIntervalMs`），代次令牌（reconnectToken）打断在飞循环、`reconnecting` Set 禁止重入，connect/disconnect/dispose 三入口打断；成功**只连不登** + 显式 `pulseActivity()` arm 一次静默计时；重连不重读行流（abs 连续 + 水位已复位）。
- **收尾**（T5.3）：Config fail-loud 校验（五项正整数 + `probeMaxAttempts × probeRetryMs ≤ 300s` + `MAX_TIMEOUT_MS < silenceMs`）；`StatusRow`/`watchStatus` 扩 `probeState` 观测量（不回写 conn 三态）；webui 侧栏「探测中」呈现（MudConnState 加 `probing`、琥珀点、zh/en 文案）；工具连接判据注释同步。
- **测试**：`keepalive.spec` 18 例 + `wake.spec` 16 例（含探活插入点 6 例）+ `reconnect.spec` 9 例（真 socket：自动重连/限次放弃/手工不重连/打断/dispose 取消/旧行不重投/多会话隔离）；core3 280/280 全绿（22 文件，含 plugin-load e2e）+ mud-workflow 31/31 + webui tsc 清零。
- **文档**：§0.4 任务索引补探活/重连导航行；§3.2 连接管理表加探活/自动重连行（断线行改自动重连口径）；§10.1 加 `probeState` 观测量；§10.4 「不自动重连」句改自动重连口径；§11.3 状态机图加自动重连分支；§13.1 记录点加探活/重连；§16.3 手工连接行改「手工断开不自动重连」+ 新增「探活与自动重连」断言行；§16.5 切片表加 T5 自动重连行；§17.3 自动重连后置项消项（探针结论收进 §3.2）。

> AI生成

## [v0.0.36]T12 探活精化返工（link 层静默伴随自驱）(2026-10-04)

- **探活归属传输层**：从「Wake 到期点串行前置」返工为「link 层自驱静默伴随探测」（§3.2）——时钟锚 = **最后数据到达时刻**（任何行/GA 到达即判活并重开窗口），静默满 `probeStartMs`（缺省 90s）发 telnet AYT(246)，无应答每 `probeRetryMs`（9s）重发共 `probeMaxAttempts`（3）次，**117s 判死**（落在 `silenceMs` 120s 唤醒到期点之前，留 3s 给上层）；唤醒到期点零探测延迟。
- **判活 link 内部消化**（无上报回调链，删 `onProbeAlive`）；判死 → 既有 `disconnect` 硬收尾 → 自动重连链（service 零改动，上层只消费断开事实）；判据 `^\[-Yes-\]` 不变（GA 主路径判活，行刷出兜底，应答行吞行不进流/画面/投递）。
- **busy 谓词注入 link**（`holderBusy || isInTurn`，runtime 构造合成传入）：busy 的探测 tick **跳过**（不发 AYT 不耗次数、不顺延——busy 贯穿窗口 = 本轮零探活，read timeout 与唤醒点守卫兜底）；判死刻度 busy → 零收束不判死。
- **`link/keepalive.ts` 重构为自驱**：`KeepaliveOptions{startMs,retryMs,maxAttempts}`（构造正整数 fail-loud）+ `KeepaliveDeps{send,onDead(attempts),isBusy?}` + `armIdle()`/幂等 `cancel()`；`onDead` 携带实际发送次数（顺带修正旧实现 cancel 先行致判死日志计 0 次）；探活取消点四处（手工 connect/disconnect/dispose + 重连成功）。
- **Wake 回归纯唤醒**：净删 `probe`/`isProbing`/`onProbeAlive` 三依赖，到期点三守卫全过即 fire（§7.5）。
- **Config**：新增 `probeStartMs`（90_000）；fail-loud 校验式改 `probeStartMs + probeMaxAttempts × probeRetryMs ≤ silenceMs`（替换原 `probeTotal ≤ 300s`）。
- **测试**：`keepalive.spec` 重写（纯层 11 例 fake timers 逐刻度 + Mud 真接线 8 例）；`reconnect.spec` 判死用例改自驱等待；`wake.spec` 删探活插入点 6 例——core3 **275 例 / 22 文件**全绿 + mud-workflow 31/31 + core3/webui tsc 清零。
- **文档**：§3.2 探活行重写（静默伴随刻度）；§10.1 `probeState` 注「link 层自驱」；§13.1 记录点注「判活内部消化不记日志」；§16.2 账目/覆盖对照补 `keepalive`/`reconnect`/`classify`/`llm-gate`；§16.3 探活断言行按新刻度重写；§16.5 补 T12 行；§15.5 Config 表补 8 键（探活三项 + 重连两项 + C5.2 三项）。

> AI生成

## [v0.0.37]T13 人工验证码链路（fullme 流程 + captcha 双闸 + webui 全局弹窗）(2026-10-05)

- **流程面**（§8.17 新节 + [flows/fullme.md](flows/fullme.md) 新建）：`fullme`（locked）流程实体——主链（等 fullme 提示 → `fullme` 命令 → 读码 → 等验证码挂起 → `fullme {captcha}` 发送）+ abandon 出口 + stale 自愈环（三连 `fullme 1` → fail 收束无重试，15 分钟冷却）；判据常量表与实现一一对应。
- **词汇表扩展**（§8.10/§8.12/§8.14）：`captcha` 动作（locked-only **双闸**：save 三门 + 执行期拒绝）；`awaitCaptcha` env 原语（mud-workflow 侧声明 + core3 侧实现，双侧 B2）；`{captcha}` 固定单槽（非敏感，**不进 pass 掩码**；未知 `{xxx}` 原样保留）。
- **双预算分立**：步 `timeoutMs` 管读窗（`awaitCaptcha` 拒绝包内）；Config 新增 `captchaTimeoutMs`（180_000，§15.5 #27）管挂起预算——**独立预算**，不受 `MAX_TIMEOUT_MS`/`silenceMs` 校验约束，正整数 fail-loud。
- **等待注册表**（core3）：单会话单槽（并发冲突可读拒）+ 三退出路径（signal abort / 断线 / dispose → `closed` 收束 + release）+ run 级缓存（同 run 二次 `awaitCaptcha` 直接复用）。
- **remote 四动词**（§15.1/§15.2）：`watchCaptcha`（stream：首帧补推挂起态 + 变化推全量快照帧，行摘除 = 清除帧）+ `captchaAnswer`/`captchaAbort`（专用 `aborted` 出口）+ `captchaRefresh`（重抓同 URL，每轮挂起限 1 次配额）。
- **webui 全局弹窗**（§9.7 新节）：挂侧栏常驻层（`startStatusWatch` 同款生命周期），独立订阅 `watchCaptcha` 流；清除帧驱动关窗（Esc/遮罩 = 本地隐藏不动流程）；刷新页面首帧补推恢复；客户端乐观标记 + 帧边界 diff 对齐刷新配额。
- **口径修订**：原「流程不能等人工」约束**随 T13 废止**（§8.15 边界、flows/login.md 边界表、§17.3 流程扩展条目同步）。
- **persona**（cordis.patch.yml）：preset prefix 补验证码流程说明段（被动触发、弹窗等码、持有发送权、stage 现场说明、不立即重跑）。
- **测试**（先红后绿）：core3 `fullme.spec` 11 例（主链/答错重入/stale 自愈/abort/三退出路径/并发拒/双闸/`{captcha}` 掩码排除）+ mud-workflow `interpreter` 扩 9 例（`awaitCaptcha` 原语解析与超时预算）+ webui `mud-captcha.spec` 7 例（新建测试基建：vitest.config + FakeRemote）；**回归全绿：core3 286/23 + mud-workflow 40/3 + webui 7/1，三包 tsc 清零**（§16.2 账目已按实测更新）。

> AI生成

## [v0.0.38]流程 IO 面重命名（`WorkflowEnv` → `WorkflowIO`）(2026-10-05)

- **纯重命名，零行为变更**：`env` 名不达意（看不出「流程与外界的唯一通道」这层语义），全套改为 `WorkflowIO`——六边形语义对齐（core3 注入 io 原语，解释器纯层只认接口）。
- **mud-workflow**：`src/env.ts` → `src/io.ts`；`WorkflowEnv` → `WorkflowIO`、`EnvLine/EnvReadOpts/EnvReadResult/EnvState` → `IoLine/IoReadOpts/IoReadResult/IoState`（`CaptchaResume` 不变）；解释器/工具层参数与变量 `env` → `io`（`fakeEnv` → `fakeIO`）。
- **core3**：缝函数 `workflowEnvFor` → `workflowIoFor`（MudCore3Handle/index 接线同步），返回字段 `env` → `io`；service.ts 本地同形接口 `WorkflowEnv` → `WorkflowIO`；日志文案「流程环境就绪/释放」→「流程 IO 就绪/释放」（workflow.spec 断言同步）。顺带修正 flows/login.ts 注释残留旧口径「流程不能等人工」→「验证码链路独立成流程（§8.17）」。
- **文档**：§8.14（缝标题/执行序/五工具表）、§8.17（`awaitCaptcha` io 原语行）、§1–§2、§10–§11、§15.2/§15.4、§16.2、§0.3 章节地图、flows/login.md、flows/fullme.md 同步改现役符号；CHANGELOG 历史行与 §16.5 切片表 T3 历史行不回改。
- **回归**：core3 286/286 + mud-workflow 40/40 + webui 7/7 全绿，三包 `tsc --noEmit` 清零。

> AI生成

## [v0.0.39]流程捕获槽与 fullme 触发时捕获改造（T14）(2026-10-05)

- **mud-workflow**：wait 加 `captures` 字段（组只许 `until[0]` 携带）；解释器 done 收束后、动作前对窗文本按行在 until[0] 首个命中行上 exec 提取捕获组入 run 级命名槽（failOn 收束不捕获；无命中行/组空值 → 结构化 timeout 同型收束不落槽；提取一律无 `g` 实例）；`substitute`/`substituteSlots` 扩四源（次序 `{captcha}` → 命名槽 → `{name}`/`{pass}`，send 侧不碰凭据占位）；checkFlow 加 captures 四校验（槽名合法/非保留名/组数界内/组只许 until[0]）；`captcha` 动作参数化 `{url}`（值过解释器替换）；`WorkflowIO.awaitCaptcha(url)`（D8 双侧改）。
- **core3**：缝实现 `awaitCaptcha(url)` 消费参数取图，闭包 URL 自取净删（`extractCaptchaUrl` + `CAPTCHA_URL_RE` + recentLines 扫描 + undefined 兜底——报错点前移到 urlwait 结构化 timeout）；**窄缓存保留**（`cachedEntry.url === url` 比对，答错重入沿缓存图不重抓，refresh 原地更新不动）；`io.recentLines` 的「URL 抽取豁免」注释删除（水位过滤代码零改动）；fullme `URL_SRC` 加捕获组 + urlwait `captures: ['captchaUrl']` + answer `{url: '{captchaUrl}'}`。
- **文档**：§8.10（wait captures + captcha 参数化）、§8.11（保存门四校验）、§8.13（捕获提取/槽替换四源/槽生命周期三行）、§8.17（captcha 动作/`awaitCaptcha(url)`/窄缓存/fullme urlwait 段）、§15.2、§16.2/§16.3/§16.5、flows/fullme.md（步表/URL_SRC 常量/设计要点 1 与 5）同步。
- **回归**：core3 288/288 + mud-workflow 56/56 + webui 7/7 全绿，三包 `tsc --noEmit` 清零（§16.2）。

> AI生成

## [v0.0.40]流程面契约化分层（A1）(2026-10-05)

- **mud-workflow（三层 + 子路径导出）**：包内按依赖方向分三层，边界由 `exports` 表达——**契约层** `src/contract`（词汇表 + 静态保存门 `checkFlow`/`usesCredentialVerb` + IO 与引擎缝端口 + 持久化域声明；子路径 `mud-workflow/contract`；零 cordis / 零宿主 / 零 I/O）· **内核层** `src/core`（`runFlow` + `WorkflowRegistry`；子路径 `mud-workflow/core`；仅依赖契约层 ⇒ 可脱离宿主做离线校验/回放/CI 检查）· **适配层** `src/host` + 根入口薄壳（宿主 patch 仍按绝对路径加载 `lib/index.js` / `lib/preset.js`，逻辑落 `host/plugin.ts` / `host/preset.ts` / `host/tools.ts`）。`exports` 增 `./preset` / `./contract` / `./core`；`build` 前先 `clean`（顺带清掉历史陈旧产物 `lib/flows/login`、`lib/builtins`、`lib/env`）。
- **契约单点（取代「双侧同形」纪律）**：`WorkflowIO<L>` 加行载体类型参数——契约只承诺 `text`，实现按自己的完整行记录实例化，故 core3 侧 `const io: WorkflowIO<MudLine>` 原样通过而 `recentLines → read(initial)` 回环两侧都无 cast；新增引擎缝端口 `WorkflowIoSeam<L>` / `WorkflowIoHandle<L>`；域声明与 `HostTable`/`HostStorageDomain` 移入契约层，新增 `FLOW_SCHEMA_VERSION`（词汇表文档版本锚点；迁移策略仍未立项）。
- **core3（删同形副本 + 编译期断言）**：删 `service.ts` 自留的 `WorkflowIO` 同形接口（改 import 契约端口），实现处按 `WorkflowIO<MudLine>` 实例化，`workflowIoFor` 返回 `WorkflowIoHandle<MudLine>`；`MudCore3Handle extends WorkflowIoSeam<MudLine>` ⇒ `satisfies MudCore3Service` 同时就是「本实现满足流程契约」的编译期断言（§8.17 的「双侧改」由纪律升级为类型系统保证）；`src/index.ts` / `flows/{login,fullme}.ts` 与 `login.spec` / `fullme.spec` 改引 `mud-workflow/contract`，用例的 `runFlow` 改引 `mud-workflow/core`；`fullme.spec` 的 `cancel` 改可选调用（端口对消费侧可选，实现恒提供）。
- **根编排（构建序不可倒）**：`dev` 前置 `pnpm --filter mud-workflow build`（core3 类型面依赖契约产物，原脚本缺此步 ⇒ 干净树上 core3 构建失败、且宿主可能加载陈旧 `lib/`）；新增 `typecheck`；`test` 由 `--filter mud-core3` 改为**现役三包**（mud-workflow + mud-core3 + mud-webui；退役 v1/v2 不入根回归）。
- **文档**：§8.8（三层表 / 子路径导出 / 契约单点 / 构建序）、§15.2（缝签名改契约端口）、§15.3（启动链）、§15.4（索引行）、§16.1（纯层范围）、§16.2（用例组行删已移出的 `login`）、§1.6（包地图）、§8.17（`awaitCaptcha` 端口归属）。
- **回归**：core3 288/288 + mud-workflow 56/56 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零；`pnpm -r build` 通过。

> AI生成

## [v0.0.41]流程捕获语义澄清：捕获与路由同源（T14 收口）(2026-10-05)

- **问题（实测复现）**：T14 的捕获提取用「**逐行**找首个命中行」，而路由用「**整窗**按声明序 `firstHit`」——两套命中模型，与 D3「捕获必须与路由同一条命中行」相反。后果两条：① 声明 `captures` 的步只要 `until[0]` 未命中就**在动作与路由之前**无条件 timeout，即使窗由其它 `until` 命中且**已声明分类出口**（分类出口被吞，实测 `stage` 从 `dead` 变 `timeout`）；② 显式跨行判据（§8.13 允许的 `\n` 写法）**永不命中**（逐行 split 天然不跨行；T14 期以「判据不写跨行正则」的约定回避，而路由侧本无此限制 ⇒ 作者纪律出现两套）。
- **澄清后的语义（三条路径）**：`hitIdx` = 路由所用的那份 until 命中序，**捕获与路由共用一次计算**——① `hitIdx = 0`（捕获判据路径）：在**整窗文本**上 `exec` `until[0]` 取组入槽，组缺失/空值 ⇒ D11 结构化 timeout（不落空串进槽、不进 send）；② `hitIdx > 0`（其它已声明判据命中）：该路径不需捕获 ⇒ **不捕获、不失败**，按该判据路由（`branch[hitIdx]` / `next`，分类出口可达）；③ 一条 `until` 都没命中（`gaCount`/`maxLines` 关窗）⇒ 同型 timeout（D11 原样保留）。即 fail-loud 只剩两处：**捕获判据命中但组不可用**、**一条判据都没命中**。
- **代码**：`core/interpreter.ts`——`captureSlots` 改整窗 `exec`（去掉 `split('\n')` 逐行）；`hitIdx` 在读窗后算一次，捕获门与路由共用（顺带去掉路由侧第二次判据编译）；捕获门按上述三路径分支。
- **测试（先红后绿）**：新增 ⑨（其它已声明判据命中时不吞分类出口）、⑩（跨行捕获判据整窗 exec）、⑪（命中非捕获判据且无 `branch` ⇒ 走 `next`、未填充槽原样保留）——三条在旧实现下**全红**（`3 failed | 56 passed`）、新实现下全绿；⑥b 断言文案随新报文更新（行为不变，仍是 fail-loud）；⑦ 夹具补 `flags: 'm'`（行首锚 + 多行窗：旧逐行匹配掩盖了这个 §8.13 勘误③ 的作者纪律分歧，路由侧本来就不命中）。
- **文档**：§8.13（捕获提取行重写为三路径 + 判据书写纪律显式声明「捕获与路由共用整窗模型，系统内不存在第二套语义」）、§8.10（`wait` 行 captures 说明）、§16.2（用例账目 56 → 59 与用例组行）。
- **回归**：core3 288/288（含 fullme E2E——`URL_SRC` 行首锚 + `flags:'m'` 走整窗 exec，行为不变）+ mud-workflow 59/59 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零。

> AI生成

## [v0.0.42]名册冲突裁决与来源标记（策略 A）(2026-10-05)

- **问题（实测）**：注册表此前只在**保存侧**执行 locked 语义——core3 缺席期 agent 抢先 `save('login')`（无内置 ⇒ 门放行），core3 就绪后挂载 locked `login` 只做内置表 `set`、**不做冲突裁决**，而 `get`/执行仍取修缮层 ⇒ **locked 内置被永久遮蔽**（实测返回 `locked:false` 的修缮版）；且 `delete('login')` 因名对 locked 内置被拒 ⇒ **既赢又删不掉**，只能手工清存储。
- **裁决（策略 A）**：优先级落到**读取/执行侧的单一落点**（`registry.view`，`get`/`list`/`entries` 共用）——**locked 预制 ⇒ 内置优先**：同名修缮降级 `shadowed`（仍留在存储层），读取与执行一律用 locked 内置；**非 locked 预制 ⇒ 修缮优先**（原进化闭环不变）。`delete` 判据改为「删的是修缮还是内置本体」：**有修缮一律放行**（含 locked 名下的遮蔽修订，删掉只是清掉遮蔽），**无修缮且名对 locked 内置才拒** ⇒ 遮蔽可自愈，不再需要手工清存储。
- **来源标记（零 schema 变更）**：新增 `WorkflowOrigin = 'builtin' | 'refined'` 与 `WorkflowEntryView{ record, origin, shadowed? }`，由「记录在哪一层」**推导**、**不落库** ⇒ strict schema 与存量记录零影响；新增 `registry.entries()`，`list`/`get` 改由 `view` 派生（同义处行为不变）。
- **工具面**：`mud_workflow_list` 结果带 `origin`/`shadowed`，render 标注「（内置）/（修订）」与「⚠ 有被 locked 内置遮蔽的修订（delete 可清理）」；`mud_workflow_delete` 结果带 `lockedBuiltin`，render 提示「已删除被遮蔽的修订（locked 内置继续生效）」——结论装进返回值，`render` 保持 args+value 纯投影；两工具 description 同步。
- **宿主可见性**：`host/plugin.ts` 挂载内置后扫描 `entries()`，有遮蔽即 `ctx.logger.warn` 点名（修订名 + 版本号）——静默降级改为可见。
- **测试（先红后绿）**：新增 registry ⑫（locked 内置优先 + `shadowed` 保留）、⑬（遮蔽修订 delete 放行）、⑭（无修缮时 delete locked 仍拒）、⑮（来源标记 builtin/refined）、⑯（遮蔽状态下覆盖保存仍拒）与 tools 两条（list 来源/遮蔽呈现、delete 遮蔽修订提示）；先临时把优先级翻回旧行为取证 = `5 failed | 61 passed`，恢复后 = `66 passed`。
- **未做（本轮裁定延后）**：变更账本（`snapshots` + 回滚）单独一轮；`attachDomain` 迁入时覆盖更高版本持久记录的隐患（评审 P5）仍开放。
- **文档**：§8.11（新增「同名冲突裁决」「来源标记」两行）、§8.14（五工具行 `list`/`delete` 语义）、§15.4（索引行）、§16.2（用例账目 59 → 66 与用例组行）。
- **回归**：core3 288/288 + mud-workflow 66/66 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零。

> AI生成

## [v0.0.43]读窗命中信息下沉：core3 独占匹配（T15）(2026-10-05)

- **根因消除**：判据匹配此前有**两个实现**——core3 读窗机按整窗判定"何时收窗"，流程解释器再在本窗文本上"按声明序重测"取下标与捕获组（`ReadResult` 不带命中信息）。两者必须严格同构，v0.0.41 修的"分类出口被吞 / 跨行判据永不命中"正是不同构所致。本轮把"哪条判据赢了 + 该条首个命中的捕获组"作为**数据**由读窗机返回。
- **契约（mud-workflow/contract）**：新增 `ReadHit{ by: 'until'|'failOn'; index: number; groups: readonly (string|undefined)[] }`；`IoReadResult` 增必填 `hit: ReadHit | undefined`（无判据命中时为 `undefined`）；`reason` 收紧为 `IoReadReason` 字面量联合，core3 `read.ts` 的 `ReadReason` 改为**引用**该联合（消一处重复声明）。
- **core3 读窗机（read.ts）**：`evaluate` 把 `*.some(re => re.test(accText))` 换成**声明序 `exec` 单次调用**（一次同时得到命中下标与捕获组，不再写 `test` → `exec` 两段 ⇒ T14 那个"取组必须 strip `g`"的特例消失），且**调用前重置 `lastIndex`**——`g`/`y` 是**有状态**正则（起点由 `lastIndex` 决定，`y` 另要求"正好落在 `lastIndex` 处"），不重置会让同一判据在窗口变长或跨 read 复用时灵时不灵；词汇表白名单 `d/i/m/s/u` 写入 §5.2 纪律，"保存门拒存 `g`/`y`"留 T16（无迁移口径前不收紧持久化契约）。"until 失配判责"日志改由命中帧判定（不再复测一次正则）；`ReadResult`（本包实现面，行是完整 `MudLine`）与契约 `IoReadResult`（窄面 `IoLine`）同带 `hit`、结构化可赋值。
- **流程解释器（core/interpreter.ts）**：删 `firstHit` 与 `captureSlots` 的匹配职责，改消费命中帧——failOn 出口用 `hit.by==='failOn'` 的 `index` 查 `onFailOn`；路由用 `hit.by==='until'` 的 `index` 查 `branch`；填槽用 `hit.groups`（`index===0` 才填；`index>0` 不捕获不失败；无 `until` 帧 ⇒ D11 收束）。**判据匹配系统内单点**：分类、捕获、路由与收窗在物理上不可能不一致；`windowText` 与路由侧第二次判据编译一并消失。
- **测试（先红后绿）**：core3 `read.spec` 新增 8 例（命中帧 ①–⑥c：声明序下标、`failOn` 来源、`gaCount`/`maxLines` 关窗无帧、组序（未参与组 `undefined`、参与但空串 `''`）、无组 `[]`、同实例跨 read 复用的重置、含 `g` 声明仍取到组、`y` 锚定语义保留），**先红 7 failed** → 后绿；mud-workflow `interpreter.spec` 的脚本化 fake IO 增 **mini-reader**（与读窗机同规则生成帧）+ 结构断言 ⑪（解释器源码内不再出现 `test`/`exec`/`captureSlots`/`firstHit`，**先红** → 后绿）；`tools.spec`（两侧）与 `runtime.ts` 的结果面补 `hit`。
- **文档**：§5.2（新增「命中帧」「取组与有状态正则」两行）、§8.13（"判据重测"行改写为"判据匹配单点"、捕获行改为帧驱动、判据书写纪律收敛为单点匹配）、§8.14（io 原语 `read` 标注带帧）、§16.2（core3 288→296、workflow 66→67 与两组用例说明）、§16.5（T15 切片行）。
- **回归**：core3 296/296（含 `login`/`fullme` E2E——真实"读窗机 → 命中帧 → 解释器"端到端，`captchaUrl` 捕获即由此验证）+ mud-workflow 67/67 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零，`pnpm -r build` 通过。

> AI生成

## [v0.0.44]流程存储演进与变更账本（T16）(2026-10-05)

- **事实核查（宿主机制，先行落档）**：宿主 `DomainSpec` 的迁移钩子 `compatibleVersions` **只在 `per-record` 布局生效**；本域走缺省 whole-unit，版本不一致时 `storage-json` 直接抛 `version-mismatch` ⇒ **整个 open 拒绝**（退内存 = 全部修缮记录读不出来）。而域 `open` 只按 `spec.tables` 取表、**旧文件缺表读为空** ⇒ 同版本**新增表对存量零影响**。据此立纪律：**域 `version` 恒为 1、永不用作迁移手段**，词汇表演进一律"字段可加可选 + 读时归一"。附带核查：`~/.dsh`（含 `storages/`）与工作区全树**无 `mud_workflow*` 数据** ⇒ 保存门收紧零兼容风险。
- **契约（mud-workflow/contract）**：域声明增 `snapshots` 表（值 schema = 新增 `workflowSnapshotSchema`：`name/version/title/locked/updatedAt/flow/archivedAt/reason`）并显式 `layout: 'single'`；`wait.flags` 白名单收紧为 `/^[dimsu]*$/`（`g`/`y` 是**有状态**标志，读窗机已重置 `lastIndex`，保存门再拦一道）。
- **内核（core/registry.ts）**：① **迁入按 `version` 取新**——域内更高 ⇒ 不改域、内存期记录归档为 `migration` 快照（修复评审实测的"内存 v1 覆盖域内 v9"静默版本回退）；② **迁入失败不挂域、不清内存**（内存仍是唯一真相），返回 `MigrationReport`（迁移数 / 取新数 / 点名 / 账本条数）供宿主点名；③ **变更账本**：`snapshots` 只追加、键 `` `${name}:v${version}` ``，`save`/`delete` 各留一档，每流程保留最近 `MAX_SNAPSHOTS_PER_FLOW`（20）个版本；④ **强审计提交**：账本先行（先记快照再写生效记录）⇒ 不会出现"已生效但无账本"，账本失败即操作整体失败；⑤ `history(name)` / `rollback(name, version)`（回滚 = 取该快照的 `title`/`flow` **写一条新版本**，历史不原地改、`version` 继续单调）；⑥ 内存降级层与域表**同形适配**（`mapTable`）：域未挂时账本照常可用，迁入时一并落域。
- **宿主适配（host/plugin.ts）**：`attachDomain` 传两张表并呈现迁入报告（`info` 迁移/账本数；取新落败者 `warn` **点名**）。
- **工具面**：新增 **`mud_workflow_history`**（版本/时间/原因倒序）与 **`mud_workflow_rollback`**（回滚结果 = 新版本号）；注册完整性自检 5 → **7**。
- **测试**：registry 新增 7 条（⑰ 迁入取新 + 归档、⑱ 正常迁入账本随迁与续写、⑲ `delete` 归档、⑳ 回滚写新版本 + 未知版本可读拒绝、㉑ **强审计**（账本写失败 ⇒ 保存整体失败、生效记录不落）、㉒ 上限剪枝、㉓ 迁入失败不挂域不清内存）；tools 新增 `history`/`rollback` 贯通用例、注册自检改七工具。取新用例的"红"证据 = 评审期实测探针（旧实现把域内 v9 覆盖成 v1）。
- **文档**：§8.11（新增「迁入取新」「变更账本」「强审计提交」「词汇表演进口径」四行）、§8.3/§8.14（五工具 → 七工具；§8.14 标题陈旧的 `workflowEnvFor` 一并改回 `workflowIoFor`）、§14.3（域不可用/迁入失败降级行）、§16.2（workflow 67 → 75 与用例组）、§16.3/§16.5（流程面断言行与 T16 切片行）、§15.3/§15.4/§6–7/§1.6（工具数同步）。
- **回归**：core3 296/296 + mud-workflow 75/75 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零，`pnpm -r build` 通过。

> AI生成

## [v0.0.45]宿主接缝漂移防御（T17）(2026-10-05)

- **问题（实测）**：两包的工具窄结构（`MudToolDefinition`）与宿主 `ToolDefinition` 有**实际偏差**，且被接线层的 `as unknown as ToolRegistrar` 全部吃掉——① `isConcurrencySafe` 宿主要求**谓词函数**`(args) => boolean`，窄结构声明为 boolean 属性：写 `false` 只因宿主 fail-closed（`if (!tool?.isConcurrencySafe) return exclusive`）恰好得到"独占"，**写 `true` 会被 TypeError 吞成 exclusive**；② `render` 宿主返回 `ContentBlock[]`（可变），窄结构声明 `readonly`；③ `output.schema` 宿主要求"对成功返回值强制校验的 JSON Schema"，而管理工具统一只有 `ok`/`error`，真实字段（`record`/`workflows`/`name`/`version`/`updatedAt`/`deleted`…）未声明。
- **修复（两包同改）**：`isConcurrencySafe` **谓词化**（`mud_send` / `mud_workflow_run` 恒 `false`＝独占；其余缺省）；`render` 返回类型改**可变**数组；`output.schema` 逐工具补齐真实字段（新增 `okSchema(extra)` 基座，避免七处重复）；`mud-core3/src/tools.ts` 与 `mud-workflow/src/host/tools.ts` 同步。
- **编译期断言（接线层）**：`mud-core3/src/preset.ts` 与 `mud-workflow/src/host/preset.ts` 各导出 `AssertTrue<...>` 形式断言（`ConcurrencySafeIsPredicate` / `RenderReturnsMutableBlocks`）——**形状漂移即 `tsc` 红**；纯层保持零宿主 import（接线层是唯一允许认识宿主的地方）。
- **工件面加载冒烟（T17.2）**：新增 `packages/mud-workflow/test/plugin-load.e2e.ts`（对齐 core3 同款纪律；缺产物自动跳过）：导入 **`lib/index.js` / `lib/preset.js`**，断言引擎入口 `name/inject/apply` 形状 + 装配即提供 `mudWorkflow` 服务面、preset 入口**七工具**全部过宿主注册面（含 `mud_workflow_run` 的谓词是函数且恒 `false`、每个工具 `output.schema` 为对象根且含真实字段）；`vitest.config.ts` 的 `include` 补 `test/**/*.e2e.ts`。
- **未决（留档）**：整型可赋值断言（`MudToolDefinition extends ToolDefinition`）需宿主 `JsonSchemaNode` / `ParameterSchemaSpec` / `dsh-llm` 的 `ContentBlock` 类型，手写窄结构无法满足 ⇒ 本轮钉"两处真实漂移的成员"；`output.schema` 的**值级**校验（用宿主 `validateJsonSchemaValue` 对样例值跑一遍）留作后续可选加固。
- **文档**：§8.2（并发谓词化 + 漂移断言 + 工件面冒烟三条）、§16.2（workflow 75 → 77 例 / 3 → 4 文件、`plugin-load` 用例组补 mud-workflow 同款）、§16.5（T17 切片行）。
- **回归**：core3 296/296 + mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc --noEmit` 清零，`pnpm -r build` 通过。

> AI生成

## [v0.0.46]会话上下文的进程级收口（表面遮蔽，T18）(2026-10-06)

- **问题（用户报告）**：`sessionId = accountId` 随名册持久（§1.4）⇒ 宿主冷启动按 id 恢复会话，上一进程的上下文（行批次 / 任务书 / 委派收尾）成为**过期断言**污染新连接。运行时世界状态已是进程级（§4.5 断线整体复位 + 冷启动不回读 `admitted`），未收口的是**模型可见上下文**。
- **裁决（用户拍板）**：**不换会话身份**（换 id 会牵动 webui 行身份/标签页/日志键、名册 schema 与归档事务），改为在**本进程第一次 model step 之前**（`agent/pre-step`——宿主 compaction 的同一替换缝、**先于请求推导**）把 `node 0`（受保护 `system/message` head）之外的**全部表面节点**替换为一条**进程起点标记**（`surfaceOp:{op:'replace',startSeq,endSeq}`；`source.kind='mud-epoch'`；正文含进程 epoch）。会话 id / 账号 id / 名册零变化。
- **spike 实证（先行）**：临时 `DSH_HOME` + `--patch` 探针验证三问——① 外部插件可追加替换且表面真的收缩；② 替换后**对话请求**不再含被遮蔽历史（含对照组：不替换时历史在场）；③ 与宿主 compaction 同组合共存。硬不变量实测：**head 就位前追加 message ⇒ `append` 当场成功、日志照写，但下一进程重放判 corrupt**（`system/message requires a protected first surface head`）。另实测：标题生成等**辅助调用从日志取料**（不读表面）⇒ 遮蔽只对对话请求成立。记录见 `doc/likely/t18-surface-elision-spike.md`。
- **实现**：新增纯层 `packages/mud-core3/src/elide.ts`（`processEpoch()` / `epochMarker()` / `elisionPlan()` / `applyElision()`，零宿主依赖，判定与适配全在纯层）；`src/index.ts` 加 `agent/pre-step` 接线（归属 = 根会话 + 名册账号会话；`AgentsLive` 扩出 session 面；`MessageSourceMap` 增 `'mud-epoch'` 声明）；**失败 ⇒ `{kind:'reject'}` 阻断本步**（回合 `turn/end {reason:{kind:'blocked'}}`、无 `step/start`、无模型调用），**预期 skip 照常放行**（表面未就绪 / 无历史 / 本 epoch 已遮蔽 / 含后续 `system/message` / 跨度含未配对 `tool/call`）。
- **先红后绿**：`test/elide.spec.ts` 21 例（判定矩阵 15 + 适配 6）；先跑 `Cannot find module '../src/elide.ts'`（0 test FAIL）→ 实现后 14/15（第 ⑩ 例是我 fixture 误读"端点含 head"，改为规范非单调形态后）→ 21/21 绿；适配层先红 `applyElision is not a function`（7 failed）→ 绿。
- **重放级实机冒烟（T18.2）**：`spike/smoke-probe.mjs` + `spike/smoke.patch.yml`（临时 `DSH_HOME`；探针用真 `ctx.get('mudRemote')` / `sessionController` 建号+驱动两轮对话、`{prepend:true}` 捕获 `llm/stream` 请求）：① 空表面 ⇒ skip 且不阻断（第 1 轮请求照发、回合 `completed`）；② 有历史会话首轮后遮蔽（第 2 轮请求 `MARK=true / OLD=false / NEW=true`，`replaceGeneration=1`）；③ 新进程 `create` 同 id **重放不 corrupt** 且旧节点不在表面（`oldSeqs=[3,8,13] stillVisible=[]`）；④ 二次进程再遮蔽一次（`replaceGeneration=2`，请求中的 epoch = 本进程 epoch）。**配方陷阱（已登记 §16.1）**：探针退出前必须 `ctx.sessions.flush(session)`，否则日志被截在半个回合、之后 resume 不再起回合。
- **文档**：§1.6（`elide.ts` 模块行）、§2.1（事实 14–16：表面与 `surfaceOp` 语义 / 不变量与 `agent/pre-step` 缝 / 辅助调用读日志）、§2.4（新增宿主缺口：无"会话上下文重置/压缩"面）、§2.5（复核范围补）、§6.3（与接入解耦）、§7.4（与任务书分工）、§11.2（收口机制与阻断语义）、§11.4（`agent/pre-step` 行）、§13.1（遮蔽只改表面、旧事件仍在日志）、§16.1（重放级冒烟纪律）、§16.2（core3 296 → **317 例 / 24 文件**）、§16.4（#8 实机结论）、§16.5（T18 切片行）、§17.2（残留复核）。
- **回归**：core3 317/317（24 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。
- **未决（留档）**：真 token 压力下宿主 compaction 与遮蔽叠加未实测；本 preset 是否中途追加 `system/message`（现取保守 skip）；每进程一条替换事件、`replaceGeneration` 单调（接受，作观测面）；跨度含未配对 `tool/call` 的端到端未复现（纯层用例覆盖）。

> AI生成

## [v0.0.47]T18 修正：真实会话从不遮蔽的两条原因（对数与范围规则）(2026-10-06)

- **问题（用户实测报告）**：T18 落地后用户实际运行，留存会话的历史**没有被遮蔽**。**先排除"会话是改版前创建的"**——对用户真实会话（`session-a076ae0b…`，`session.v4.jsonl.zstd`，494 事件 / 表面 124 节点）做**离线折叠诊断**（逐 zstd 帧解码 → 按 `surfaceOp` 折叠表面）后定位到两条**与创建时间无关**的原因。
- **根因 ①（规则过保守）**：该会话表面含 **3 个 `system/message`**（`#7` head + `#317` + `#436`，对应 2 次 `developer/message` 工具集变更后的提示词更新）⇒ 命中 v0.0.46 的 `later-system-node` 保守 skip。真实会话因提示词/工具更新**必然**出现后续 system 节点 ⇒ 该规则等于"永不遮蔽"。官方语义本就允许（`reference/subsystems/session`：「后续系统节点是普通历史，**压缩替换可以遮蔽它**」，`compaction` 亦如此）。
- **根因 ②（实现 bug）**：`applyElision` 的配对检查只在**表面节点**里收集 `tool/call`，而官方 `SurfaceEventType` 只含 `system/developer/user/assistant/tool/result` —— **`tool/call` 是 log-only，永远不在表面上** ⇒ 只要会话有过工具结果（该会话 20 条），就是"结果多、call 空" ⇒ 判未配对 ⇒ skip。v0.0.46 的用例夹具把 `tool/call` 当成表面节点，因此**测试没抓到**（夹具不符宿主实际，教训入档）。
- **修正**：① 遮蔽范围改为 `node 1 … 末节点`，**尾节点是 `system/message` 时保留它**（中段后续 system 节点随历史一起遮蔽；本轮 assembly 的提示词规范化会把当前渲染提示词写回 head ⇒ 不丢提示词）；② 工具配对改为**看日志**（每个 `tool/call` 都有配对结果才遮蔽）；`ElisionSkipReason` 去 `later-system-node`、`unpaired-tool-call` → **`unresolved-tool-call`**。
- **可诊断性**：接线层新增**每会话每进程首条决策**日志（`已遮蔽上一进程上下文（起点标记 seq=…，遮蔽 N 个表面节点）` / `上下文收口跳过（原因）` / `遮蔽失败，本步阻断：原因`）——本次排查之所以要靠离线折叠，就是因为 skip 当时是静默的。
- **验证（先红后绿）**：用例夹具按**真实形态**重写（`tool/call` 不再作为表面节点；新增中段 system 节点、尾节点保留、尾节点即 head、日志侧未解析 call、result 被更早替换遮蔽等用例）⇒ 先红 `6 failed | 18 passed`、修后 **24/24 绿**；离线复算**同一条真实日志** ⇒ `REPLACE [8 .. 490]`（遮蔽 123 节点，`node 0 = system/message#7`，日志侧 20/20 call 已解析）。
- **文档**：§11.2 ③（范围规则与 skip 清单）、§16.2（`elide` 用例组行）、§16.4（**#9** 真实会话诊断与修正）、§17.2（残留行改为"提示词规范化路径待实机例证 + compaction 叠加未测"）。
- **回归**：core3 320/320（24 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。
- **未决（留档）**：真 token 压力下 compaction 与遮蔽叠加仍未实测；"遮蔽掉后续 system 节点后 loop 规范化写回 head"依赖官方语义，待实机提示词更新例证。

> AI生成

## [v0.0.48]回合末投递冲刷推迟微任务（修复 followup 重入护栏报错）(2026-10-06)

- **问题（用户实测会话日志）**：反复出现 `投递未达：N 行未投出（水位不推进，待补投）——followup 抛错：session append cannot reenter while another append is being published`，该批行延后一个回合才补投（P7 保证了不丢行，但每次记一条 error）。
- **根因（既有缺陷，非 T18 引入）**：`session/event`（`turn/end`）是**已提交 append 的观察回调**，宿主 `Session.append` 在整个发布期持有 `appending` 标志（同步覆盖观察者调用，`finally` 才清，`core/session/src/index.ts:741-772`），期内任何重入追加都被拒。本层却在 `turn/end` 观察者里**同步**冲刷投递，而冲刷经 `deliver → agent.followup` 追加 `user/message` ⇒ 必被护栏拒绝。
- **修复**：`MudService.turnEnd()` 把冲刷**推迟一个微任务**（`queueMicrotask`）——发布期结束后再投；`turnStart`（只置抑制标志、不追加）保持不变；`flushPending`（`agent/created` 触发，非 append 发布期）保持不变。
- **测试（先红后绿）**：`service.spec` 新增「turnEnd 的冲刷推迟一个微任务（避开宿主 append 发布期的重入护栏）」——先红（同步阶段 `isInTurn` 已为 `false`），修后绿。
- **文档**：§7.2 回合节拍表 `turn/end` 行补护栏与微任务说明。
- **回归**：core3 321/321（24 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。

> AI生成

## [v0.0.49]上下文收口日志出口到前端（MUD 日志 tab）(2026-10-06)

- **需求（用户）**：遮蔽日志此前只走宿主 `ctx.logger`（宿主控制台），而用户看的是**前端「MUD 日志」tab** ⇒ 看不到，容易误判"没生效"。
- **实现**：新增 `MudService.appendRuntimeLog(sessionId, level, text)`，把决策写进**会话日志**（`runtime` 通道；会话未登记时静默）。接线层三条决策改走它：`上下文收口：已遮蔽上一进程上下文（起点标记 seq=…，遮蔽 N 个表面节点）`（`info`）/ `上下文收口：跳过（原因：…）`（`info`，每会话每进程首条）/ `上下文收口：遮蔽失败，本步阻断（原因）`（`error`，SessionLog 自动镜像宿主 logger）。
- **前端零改动**：日志 tab 本就按 `[channel] text` 通用渲染（未知通道/级别回退灰色，`MudLogView`），`runtime` 是既有通道；`remote.mud.logs` 读的就是这份会话日志（§13.2）——**无需重建 webui**，只需重建 core3 并重启宿主。
- **测试（先红后绿）**：`service.spec` 新增「appendRuntimeLog 写入会话日志（前端「MUD 日志」tab 读的就是它）；未登记会话静默」——先红（方法不存在 + 视图读法写错），后绿；顺带钉住 `logOf` 视图的 `entries` 是**属性**（`SessionLog.entries(since)` 才是方法）。
- **文档**：§13.1 记录点补「上下文收口」；§11.2 ⑦ 可见性；`log-service.ts` 的 `runtime` 通道注释补「上下文收口」。
- **回归**：core3 322/322（24 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。

> AI生成

## [v0.0.50]行打标规则扩族 + 全量语料回放收紧（C5.2 后续）(2026-10-06)

- **问题（用户实录）**：C5.2 的 `action`/`vitals` 规则漏掉四类**他人批量刷屏**，它们**照常投进 agent**：① 批量换装（`寒夜戴上一件天罗之护心。`——谓语不在句末、物名词收尾，旧规则锚行尾故不命中）；② 给物量词不止「件/双」（`醉江南给风簇浪一把玉石子。` / `风簇浪给醉万清一个圣火令。`）；③ 带后续子句的离场（`大王巡山快步离开，如山的气势也随之而散。`）；④ 他人调息/疗伤 emote（`渡假默默提气，顿时感觉自己身轻如燕。`）。
- **规则扩展（`src/classify.ts`，主语 `^(?!你)` 排除自身不变）**：`action` 增 **穿戴/装备**（句末锚 + 必须带宾语 ⇒ 「这是一件装备。」不误伤）、**给与量词全谱**（件/双/条/枚/把/颗/张/块/只/柄/面/个/瓶/袋/包/串/根/枝/朵/本/支）、**离场变体**（`离开…[，,。]` / `离开了这里。` / `离开游戏`）、**断线句式**（`X断线超过 60 分钟…`）、**走了过来 + 后续子句**（去行尾锚）；`vitals` 增**调息/疗伤长句 emote**（`提气|凝神|调息|运功|打坐|入定|吐纳|盘膝|闭目|摒置杂念|催动内劲|运转残存|重聚亏空`）。
- **验证升级：全量语料回放**（不再只靠摘录样本）——用**构建产物**里的缺省规则跑 `logs/` 全部 `[stream]` 原始行（**2212 条**，跨 2026-09-28…10-06 五个会话）：命中 **1073 行**（`action` 858 / `vitals` 189 / `chat` 26）；**未打标且形态可疑者 62 → 11**，且 11 条**全部为应当保留**（登录成功判据「重新连线完毕。」、重复连线提示、`你…` 自身提示、本人记录边框）⇒ **剩余漏网 0**；**误报审计**（命中行含「你」或以描述词开头）9 条**全部为他人动作**（`一个书生嘴里念念有词地慢慢踱了过来。`）⇒ **零误报**。回放脚本（只读）留在 `D:\code\_spike\classify-replay.mjs`，可随时复跑。
- **测试（先红后绿）**：`classify.spec` 新增用例组「2026-10-06 实录」——先红（`大王巡山快步离开，…` 判 null）→ 扩族后绿；随后回放又揪出量词「个」「瓶」、`断线超过`、`走了过来 + 子句`、`离开了这里` 五处，逐条补用例（各自先红）→ 最终 **10/10 绿**。
- **文档**：§6.3 新增「规则族」行（三族 + 自身保留 + 2026-10-06 回放账目）；`doc/likely/c5.2-line-tagging-split-screen.md` 追加修订块（同账目）；§16.2（core3 322 → **323 例 / 24 文件**）。
- **回归**：core3 323/323（24 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。
- **生效**：规则在 runtime 行路径单点生效（服务端），**重建 core3 + 重启宿主**即生效；前端零改动。部署可用 Config `classifyRules` 覆盖缺省表、`allowKinds` 放行特定 kind。

> AI生成

## [v0.0.51]T19 状态追踪：游戏文本 → World 结构化状态 (2026-10-06)

- **需求（用户）**：把游戏文本里的状态（`hpbrief`/`hp`/`skills`/`i`/`id`/`sc`）持续、**零 LLM** 地解析为 World 结构化条目（§10.3），agent 用 `mud_state` 读结构化值而非在原文里找数字；噪声表格不进 agent。
- **实现**：
  - 新增 `src/tracker.ts`（纯层）：三形状（`table`/`lines`/`sequence`）+ 判据规则表（声明序 hpbrief→hp→sc→i→skills→id-header→id）+ `observe(line)`；命中规则即写**语义分区**（`vitals`/`combat`/`inventory`/`skills`/`items`/`character`，`kind:'track'`、置信度 `measured`，D6/D10）并打 `status` 标剔除投递（D8：**块级从 `┌` 起整块打标、含未命中块**——`screen.write` 随行同步路由，事后补标对画面无效；World 写入仍必须规则命中、无命中的块只剔不写；只对 `kind === null` 行打标，C5.2 规则优先）。
  - `world.ts`：`WorldSource.kind` 加 `'track'`（D6）；新增 `delete(zone, key)`（幂等）供 `clear` 规则消解（D9）；断线复位补 `tracker.reset()`（§10.4）。
  - `runtime.ts`：行路径分类器同一点后接 `observe`（D1）；写/删薄封装 + `onWorldChange` 广播。
  - `tools.ts`：`mud_send` 加 `wait?: boolean`（D11）——`false` = 发送即走：不 read、不设超时，返回 `{ok:true, reason:'sent', lines:[]}`；仍过禁发表/连接/持有者，拒绝序不变；裸读不适用。
  - `hpbrief` 18 位表按**已定稿**判据落地（D5 完整性校验：`^#` 三行 × 6 纯数字，任一不满足不写不猜）；hp/skills/id/i/sc 判据按 PLAN 片段先行，**待完整实录校准**（A.7.3）。
- **文档**：§8.3/§8.7（`wait` 参数面）、§10.3/§10.4（写入源两源 + 复位）、§6.3（追踪打标 = 第二写入点）、A.6 口径扩为「判据」+ 新增 A.7 实录档、§16.2/§16.5、persona 补一句（先用 `mud_state` 读结构化状态，刷新用 `mud_send{wait:false}`）。
- **测试（先红后绿）**：`tracker.spec` 新增 16 例（hpbrief 实录回放 18 键、完整性失败零写入、hp 表逐键与同键覆盖、块级打标与聊天不撞、section 提取、`id` 别称、sc/i/skills 逐键、clear + delete 幂等、reset、runtime TCP 回放接线含 `source.kind='track'`）；`tools.spec` 新增 4 例（`wait:false` 不 read、闸门拒绝序不变、无 `cmd` 拒绝、缺省行为不变）。
- **回归**：core3 343/343（25 文件）+ mud-workflow 77/77 + webui 7/7 全绿，现役两包 `tsc` 清零，`pnpm -r build` 通过。
- **待办**：用户贴完整实录后补 A.7.3 校准（skills/id/i/sc 列位判据），修正判据与用例（A.6 纪律）。

> AI生成

## [v0.0.52]T21 战斗自主：状态驱动 + 危险抢占 + 行流接管 + 完全自主总开关 (2026-10-07)
> 总结：战斗系统落地（PLAN T21，切片 T21.1–T21.7）：遭遇开始到结束由系统按规则打完整场，零模型调用；状态驱动（跨变才匹配规则）；危险最高优先级抢占；战斗原文不进 agent；2026-10-07 用户三裁定（文本判定点命中即进入危险态并接管 · 危险态退出 = 结局类行文 ∨ 回升跨变 ∨ 脱战 ∨ 断线 · 释放条件裁砍 maxRounds）。

- **实现**：
  - `tracker.ts`：战斗判据规则族（`combat.气势`/`敌档`/`目标`/`敌人数`，lines 形状，判据出处 A.8.3）；hpbrief 单元格判据放宽负号（`-?\d+`：A.8.1 死亡断面实录 `#313,193,-1,…`，A.8.4 气血 ≤ 0 不是死亡判据，状态须照写）。
  - `combat/state.ts`（新，纯层）：比值（气血比/容量比/内力比，上限 200%）+ 百分比分档（伤情描述语不作阈值依据，A.8.4 裁定）+ 上一档快照与跨变边沿（常态档基线，首拍即异常也产出边沿）。
  - `combat/rules.ts`（新，纯层）：规则形态（条件→动作；设置型按已设值节流 / 占拍型由假转真触发）+ 人工种子表（flee/heal/medicine/jiali-on/jiali-off/perform 留位）+ 危险规则集直发求值（绕过节流）；干预命令原文 A.8.5〔推断〕待实录校准。
  - `combat/report.ts`（新）：World 计数（`zone='combat'`、`kind:'combat'`：拍数/干预/最后动作/规则命中，D8 三分语义）+ 会话日志（命中/放弃/接管失败留痕）。
  - `combat/controller.ts`（新）：接管状态机（idle/held/pending；遭遇开始 `acquireSend('combat')` + 覆盖整场的长读窗，收束重估/重开；释放 = 结局行/脱战/断线 interrupted 记账/静默兜底）；**重入合并闸**（T21.7 回放揭示：自身写回经 writeCombatWorld/deleteWorld 再入 onWorldChange 会自激递归——同步处理期间再入事件一律吞掉）；危险态（进入 = 文本判定点①/危险档跨变②，退出 = 结局类行文/回升跨变/脱战/断线，2026-10-07 裁定；危险直发受边沿门控——evaluateDanger 无节流，逐状态行求值会每拍重发）；`setCombatAuto` 总开关（关闭 = 立即释放 + interrupted 记账 + 挂起；恢复不追补当前场——skipCurrent 闩到本场消解）。
  - `combat/danger.ts`（新）：危险判据单点（文本 COMBAT_THREAT_RES 与 tracker 战斗行判据同源导出；危险档 = 气血比 <25%/濒危 或 容量比 <50%；回升跨变语义）。
  - `runtime.ts`/`service.ts`：行路径最前 `onEarlyLine` 钩子接线判定点①；持有者增补 `stealSend`；`abortWait` 首次启用（reason='danger'）；投递 suppress 谓词（held 期零投递，D4）；每会话战斗控制器装配。
  - `roster.ts`/`accounts.ts`/`index.ts`：`combatAuto` 偏好持久化 + 名册应用 + 新 remote 动词 `combatAuto(sessionId, enabled)`（已 gen:typert + build）。
  - `mud-webui`：`mud-remote.ts` combatAuto 方法、`MudSidebar` 账号菜单「战斗刹车/恢复自主战斗」、`MudHudTable` 非 gmcp zone 键显示 `zone/key` 前缀（combat 计数呈现）。
- **测试（先红后绿）**：`combat-state`/`combat-rules`/`combat-report`/`combat-controller`/`combat.replay` 五规格；A.8 实录回放（D15）以实录语料纯层端到端：开战行危险抢占接管 → 11 拍受击戳命中序列（heal 只在五成/危险/濒危三处跨变拍）→ 未跨档不发 → -1 濒危 → 死亡结局行释放 + 清遭遇键；回放揭示并修复三处（tracker 负值格、重入自激、危险直发无刻度）。断线 interrupted 记账回放一例。
- **文档**：§5.2（`abortWait` 已有调用者）、§6.3（交战接管期零投递）、§8.6（`stealSend` 抢占动词）、§10.3（`kind:'combat'`）、§16.5（T21 切片行）。
- **回归**：core3 402/402（30 文件）+ mud-workflow 77/77 + webui 7/7 全绿，全仓 `pnpm -r typecheck` 清零。
- **待实测（真机冒烟）**：胜利/脱战/逃的行文、干预行文（perform/jiali/运功/药/halt/move）、敌方档位完整阶梯、忙位何时非 0、战后处置、多敌行文、未受伤拍是否也推 hpbrief（A.8.5 推断值清单）。

## [v0.0.53]修复：T18 遮蔽时机改恢复时点——新账号接入的 kickoff 任务书被误吞 (2026-10-08)
> 总结：用户实测发现新账号点击接入后，初始化任务书被「上一次进程的历史已失效」起点标记替换——agent 收不到任务书、不知道要连 MUD 登录。定稿方案 = 遮蔽时机从「本进程首次 model step 前（pre-step，逐步判定）」改为「会话登记（`agent/created`）时点一次性遮蔽」：created 时表面恰好就是上一进程恢复的全部历史，遮蔽对象无需推断；本进程投递（kickoff/补投）都发生在遮蔽之后，结构上不可能被吞。中途曾按 pre-step + priorSeq 边界实现一版（同日），经宿主源码静态分析 + 实机探针验证后整体废弃改线。

- **根因**：pre-step 判定把「本进程首步之前的全部表面节点」当「上一进程历史」遮蔽；新账号时序下首步 pre-step 空表面 skip（不写标记）→ 任务书/工具结果落表面 → 第二步 pre-step 把它们连同本轮上下文一并误吞。
- **验证路径（先证后改）**：①宿主源码静态分析——`agent/created` 由 `announce()` 串行发出、不在任何 append 发布期内，reentry 守卫不适用；发射源仅 create（startup）/resume；resume 理论可进程中途再触发 ⇒ 需「每进程首见才遮」内存守卫。②实机探针 `spike/created-mask-probe.mjs`（零依赖、三轮冷启动往返）：created 缝 replace 被接受且同步完成于 `create()` 返回前（A1）· 遮蔽后本进程新文本在场（A3）· 重放不 corrupt 且遮蔽跨进程持久（A2）· 下一进程把上一进程的标记与本轮文本一并再遮（A4，每进程一次语义天然成立）。
- **实现变更**：`elide.ts` 恢复「给表面做一次 replace」的纯判定（删 `priorSeq` 参数与 `no-prior-history`，`no-history` 回归原语义；保留尾 SYS 保留规则、未解析 `tool/call` 保守 skip、`already-elided` 幂等双保险）；`index.ts` 删 `agent/pre-step` 挂钩与 `elisionBound`，遮蔽迁入 `agent/created`（register 之后、`flushPending` 之前；内存集合「首见才遮」）。
- **失败处置变更**：created 缝无 step 可 reject ⇒ 由 pre-step 的 fail-closed（阻断本步）改为 **fail-open（记 error 日志放行，既有历史保留一次）**（§11.2 ④，随遮蔽时机一并裁定）。
- **测试**：`elide.spec.ts` 24 用例（删 priorSeq 边界族 7 例，恢复时点语义由接线时机结构性保证；实机断言在探针）。
- **文档**：§11.2（遮蔽时机/范围/失败处置/可见性）、§6.3、§7.4、§11.4（事件表）、§16.3 T18 行。
- **回归**：core3 402/402（30 文件）全绿；lib 已重建。

## [v0.0.54]skills 判据实录校准 + HUD 分组网格 + persona 命令速查 (2026-10-08)
> 总结：用户实测两条反馈——① agent 不识 i/hp 命令（persona 只列了字母没讲语义，agent 宁愿查 help）；② skills 表零抓取（判据按推测列布局写，与实录不符）。HUD 分组网格重设计 + skills 判据按实录校准 + persona 常用命令速查。

- **skills 判据实录校准（A.7.3，2026-10-08 实录）**：旧判据按推测列布局（中文名、英文 id、等级各自独立 cell）——实测格式是**中文名+英文 id 同 cell 括号形式**（`招魂术(evocation)`，可选 `＋`/`□` 前缀），`SKILL_ID_RE` 全不命中 ⇒ 零写入。新判据：`SKILL_NAME_RE`（flag + 中文名 + 括号 id）+ 等级 cell 保持 + 描述（境界）cell 新增 `tier` 字段；槽位汇总行改全句正则（`共使用了17.5个技能槽位，空余槽位(12.5)。级别上限：-5.56%。`）。测试按实录整表回放（先红后绿）。
- **HUD 分组网格（MudHudTable 重写 + CSS module）**：替代 v0.0.25 两列长表——zone 分组（生命体征/战斗常显；人物/技能/背包/物品别称/GMCP 折叠成一行摘要，点组头展开）；组内流式多列网格（minmax 150px）；「当前/上限」值渲染迷你进度条（归零/负值红）；组间细线分隔；对象值紧凑渲染（技能 `太极拳＋ 20.1/78` 隐藏英文 id 键、财物 `gold=4, silver=70`；诊断信息走 title 悬浮）。
- **persona 命令速查（cordis.patch.yml）**：拉模型段追加 `sc`/`hp`/`i`/`skills`/`hpbrief` 语义速查 + wiki 兜底指引；清除该段残留的 markdown 加粗符号。
- **回归**：core3 403/403（30 文件）+ webui 7/7 全绿；lib 与 dist 均已重建。

## [v0.0.55]exp 判据落地 + HUD topline 分隔线 (2026-10-08)
> 总结：用户实录补充两条——① HUD topline 与首个分组之间也加细线；② exp（武功级别和经验对照表）零抓取。

- **exp 判据（tracker.ts 新 `expRow`，table 形状；实录 2026-10-08）**：对照行（级别/经验 三列对、6 个纯数字 cell）按「偶位=级别、奇位=经验」配对，**块内积攒**、`└` 收口（或失控止损）时整体写一次 `character.经验表`（数组，后到覆盖）；连线时长句 `你连线进入北侠已经有四十八分三十九秒了。` → `character.连线时长`（中文时长原文）；「经验没有变化」句不稳定不抓。实现要点：`matchTableRow` 对 exp 规则的**空产出**（对照行占位独占）走积攒分支，其余产出（时长句）照常写——初版实现把时长句产出也吞进积攒分支（先红暴露）。
- **HUD topline 分隔线（CSS）**：`.topline` 加 `border-bottom`，组间分隔线规则改为「首组不重复画」。
- **测试**：tracker +2 用例（exp 实录整表回放：9 对经验表 + 连线时长；表头/表尾零写入全块打标），先红后绿。
- **回归**：core3 405/405（30 文件）+ webui 7/7 全绿；lib 与 dist 均已重建。

> AI生成