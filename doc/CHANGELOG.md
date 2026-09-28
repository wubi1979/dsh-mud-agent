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

> AI生成
