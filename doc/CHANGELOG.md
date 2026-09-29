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

> AI生成
