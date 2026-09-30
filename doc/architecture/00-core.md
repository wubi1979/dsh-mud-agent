# mud-core3 核心设计（§1–§5，最简版）

> 状态：v0.1.0 设计基线（2026-09-28）。本文只描述目标架构，不记录演进过程。
>
> 设计原则：**只实现被需求直接证实的机制**。core2 的五层心智、T2 闭环、子 agent、预算、唤醒、计数等全部**后置不设计**（§5）——它们不是错的，只是本版不需要先存在。**第一期目标 = MUD 信息进入 agent（等同人工提问）并得到 agent 回答**（已落地）；**第二期 = 工具面**（`mud_send`/`mud_state` + 水位线投递，§3.3/§3.4，已落地）；`mud_flow` 等流程仍后置。

---

## §1 核心模型

### 1.1 实体模型：两级实体，两条绑定

```
服务器 = 工作区 + 服务器字段（宿主原生 Workspace + roster 按 workspaceId 键存 { host, port }）
   ——页面上「服务器」的逻辑就是现在的工作区：建工作区流程 + host/port 字段
   ——呈现沿用 mud-webui 既有实现（v1 已实现，不改）
账号 Account { id, name, passRef, preset, admitted }   ← 使用者操作的实体，只能建在服务器下
   ↦ 1:1 绑定 会话 Session（**建账号时自动创建并绑定**：id = accountId，cwd = 工作区 path，agentPreset = preset）
每个会话独立持有一条 MUD 连接（输入源）——随会话生命周期产生/消亡
```

使用者全程只面对「服务器 → 账号」两级实体；会话是建账号动作的自动产物与宿主承载，**不作为管理面概念出现**（不提供独立的建/删会话入口）。

| 需求 | 宿主承载 | 自建 |
|---|---|---|
| 服务器 = 工作区 + 字段 | `Workspace` 原生实体（`session.header.cwd` 持久身份，建会话时 `mkdir`）；页面呈现沿用 mud-webui 既有实现 | host/port 字段（roster，键 = workspaceId） |
| 账号 ↔ 会话 | `session/create` 显式 `sessionId`；**建账号时自动创建绑定**，使用者不感知 | 账号记录（roster） |
| 建账号选 preset | 原生 preset registry（`agentPresets.list/select`；建会话传 `agentPreset`） | 本包 preset 行（mud-player） |
| 凭据 | 宿主 `credentials`（`set`/`resolve`，页面写入、引擎实时解析） | 无 |
| 每会话独立 MUD 输入源 | 无（宿主不管 MUD） | `link/` 移植（telnet/ansi/行流/login gate） |

### 1.2 已核实宿主事实（与 core2 归档 §PLAN 1.2 同源）

1. 会话↔agent 严格 1:1；多会话**并发跑回合**（会话内串行、会话间并行），inbox 为 per-Agent 实例，无全局串行点（`core/agent-loop/src/agent.ts:36,159,200`；`docs/subsystems/sandbox.md:79`）；
2. 建会话可指定 `sessionId`、可传 `agentPreset`（`api/session-controller/src/commands.ts:126,143`、`types.ts:289,295,442`）；无「客户端断开即回收」策略；
3. preset 定义可 patch 增（`agent-preset-registry.register`）；`default` 为宿主配置（web-app `cordis.patch.yml:558-561`，当前 `standard`）；会话记录可读（`composedPreset` 投影）；
4. 无每账号环境——preset 一棵树共享，工具定义共享，**数据必须调用期按会话解析**（`agent-preset-registry/src/mount.ts:26-29`）；
5. 有宿主 storage 域可挂（`ctx.storage` hub，JSON/SQLite 可换）；
6. 有官方凭据存储（`remote.credentials.{set,unset}` 页面、`ctx.get('credentials').resolve` 插件侧实时解析）；
7. `Workspace` 实体仅 `{ id, path, title }`，无自定义字段——服务器字段（host/port）因此存我们的 roster（键 = workspaceId）。

### 1.3 归属（哪些会话是我们的）

- **归属 = roster 判定**：会话 id ∈ `accounts`（sessionId = accountId）⇒ 是我们的会话，登记/取用 SessionRuntime；不在 roster 的会话与我们无关（解析不到，零行为）；
- **preset 不作归属门**（修订）：账号可选任意 preset（含宿主 `standard`），绑定关系在 roster 不在 preset——按 preset 判归属会把选了 standard 的账号错误排除；preset 只是账号属性（建会话时传入，决定 agent 人格与能力面）；
- 建账号时「系统自带的 preset」= 宿主 `agentPresets.list()`（standard 等）；本包注册 mud-player（最小 persona：玩家身份 + "MUD 消息以用户消息到达，直接回答"）；加自定义 preset = patch 注册一行，建账号即可选，引擎零改动。

---

## §2 生命周期

### 2.1 服务器（= 工作区 + 字段）

```
建服务器 = 建工作区（宿主原生流程，web-ui 既有呈现）+ 填 host/port
         → roster.servers 落库（键 = workspaceId，仅存服务器字段）
账号只能建在服务器下（导航层级：服务器 → 账号；即工作区内建会话）
删服务器（无账号时）→ 删工作区 + roster 字段删除
```

### 2.2 账号（= 自动会话）

```
建账号（在服务器下）→ 填账号名 + 密码（credentials.set，明文不落库）→ 选 preset
                  → 自动 session/create { sessionId: <账号 id>, cwd: 工作区 path, agentPreset: 所选 } 并绑定
                  → roster.accounts 落库（sessionId、preset、admitted 持久；admitted 缺省 false——未接入）
删账号 → 会话销毁 + roster 删除
```
- 建账号 = **一个动作**完成「账号实体 + 会话自动创建绑定」；对使用者而言建立的是账号，会话是承载不是操作对象；
- 账号 → 会话 1:1，`sessionId` = 账号 id（建账号时生成，显式指定）；删账号即销毁会话（**会话销毁受宿主能力限制**：插件拿不到 agent 的 dispose 能力，宿主也没有会话删除面，见 §3.1）；
- **开场消息（翻 blank）**：宿主的会话列表投影只在 `turn/start` 事件上把 `blank` 翻成 false（`session-controller/src/list.ts`），而 blank 会话不渲染会话头/会话体（含自建 view）。因此建账号成功后核心层投递一条**真实用户消息**（MUD 源，内容为账号事实 + 当前状态 + "不要调用工具"）触发一次真实回合，会话立刻可交互、会话体与「MUD 日志」tab 才出现。**不伪造 `turn/start`**（会污染回合计数与 replay）。代价 = 每账号一次模型调用，`bootstrapOnCreate: false` 可关（关掉后会话保持 blank，直到用户首次发消息或 MUD 信息被投递而自动翻）。

### 2.3 每会话独立 MUD 输入源与连接生命周期

```
建账号（自动建会话）       → 登记该会话的 SessionRuntime（幂等；无连接，未接入）
手工 connect（管理面/remote）→ 建连 + login（LoginGate，凭据当次 resolve）→ 输入源产生（行流积累，agent 零行为）
手工接入 admit             → MUD 信息开始进入 agent：投递通道开（§3.4；水位 = 接入时刻，不回放积压）
停止接入 stop              → MUD 信息不再进入 agent（投递停；行流照常积累 = 录制）
手工 disconnect            → 断连（状态可读）
会话销毁（session/disposed）→ 断连 + 拆 runtime
插件卸载                  → 全拆
```

- **连接生命周期第一期 = 手工动词**（`remote.mud.connect/disconnect`）；连接状态显式可读；
- **断连是硬收尾**：`disconnect` 立即销毁 socket 并同步走完收尾（flush 残留行 → 状态置断开），不做半开关闭等待——半开连接仍会继续收数据，其迟到的 close 会污染后续连接；重连时旧连接的事件按**连接代次**丢弃，不得改变新连接状态。建连失败（对端拒绝/关闭）立即失败并销毁 socket，不等满超时；
- **接入 = 独立手工开关**（`admit`/`stop`，roster 持久、缺省未接入）：连接了也可不接入（录制/挂机模式）；接入才开始读（§3.4）；
- 断线（意外）：runtime 保留、状态置断开、世界状态复位；**不自动重连**——等手工 connect；
- **自动重连后置**（§5）：只在热状态（会话 agent live）自动，冷启动不自动；前置条件 = 先实现**真实心跳**（健康判定依据，无心跳不区分真断线/半开连接）；
- 冷会话：宿主释放 agent 时 runtime 与连接不受影响（连接归 runtime 自持，与 agent 冷热解耦）；只有会话销毁才拆。

### 2.4 凭据

- 页面 `credentials.set`；connect 时 `ctx.get('credentials').resolve(passRef)`，明文只进登录发送，不进上下文/roster；
- resolve 失败 = 连接失败，报引用名。

---

## §3 装配与机制

### 3.1 装配面

```ts
// src/index.ts
apply(ctx, config):
  roster: storage 域挂载（servers 键=workspaceId / accounts 含 admitted 与投递水位）
  remote.mud.* 动词：servers/accounts CRUD、connect/disconnect（手工）、admit/stop（接入开关）、status、logs
  agent/created（全局层）→ roster 判定（sessionId ∈ accounts）→ 登记该会话的 SessionRuntime（幂等，无连接）
  session/disposed → 断连 + 拆 runtime
  投递通道：admitted 的 runtime 把聚合后的行流以用户消息投递进本会话（followup/steer，§3.4）
  ctx.provide('mudCore3', { runtimeFor })
```

**名册落库（§1.1/§2.2 的落点）**：名册挂宿主 storage 域（域 `mud` v1，两表 `servers`/`accounts`，记录 schema 是 zod 事实源）；域不可用时降级内存并告警（重启丢账号）。写路径在 `src/accounts.ts`：
- `addServer` 记 `{workspaceId, name, host, port}`（工作区实体由页面经宿主 workspace 面创建，键 = workspaceId）；
- **`addAccount` = 一个动作**：分配账号 id（`session-<uuid>`，即 sessionId）→ **先写名册** → 宿主 `sessionController.create({ sessionId, cwd, agentPreset })` 建会话并绑定 preset；建会话失败回滚名册（不留半成品）。先写名册是硬要求：`agent/created` 的归属判定据此命中，否则 runtime 不会登记；
- 密码不经本插件：页面 `credentials.set(passRef, …)`，`addAccount` 只收引用名；`connect` 时 `ctx.get('credentials').resolve` 实时解析；
- `removeServer` 在该服务器仍有账号时拒绝（§2.1）；`removeAccount` 清名册 + 清该账号日志文件。**会话销毁本期做不到**：宿主没有给插件的会话删除面（`AgentHandle.dispose` 是创建者的能力，`ctx.sessionController` 无 delete 动词），删账号后会话本身仍在宿主内，需宿主侧补面；
- `admit`/`stop` 同步写 `accounts.admitted`（持久，重启保留）。

**归属解析服务**：`ctx.provide('mudCore3', { runtimeFor, toolContextFor, defaults })`——`runtimeFor(agent)` 解析所属 runtime，不属于本插件返回 null；`toolContextFor(agent)` = 工具执行上下文聚合（查 roster 归属 → `{ sessionId, runtime, admitted, connState }`，与归属解析同一路径，§3.3）；`defaults` = 工具缺省参数（`sendTimeoutMs`/`sendMaxLines`）。


**诊断面（log）**：每会话一个 `SessionLog`——内存环（缺省 2000 条；运行/网络/投递/闸门事件）+ 按天 JSONL 落盘（`<logDir>/mud-YYYYMMDD-<sessionId>.log`，5MB 滚动 ×3）。原始行流**只落盘、不进环**（否则刷屏行会冲掉诊断信息）。warn/error 同时镜像到宿主 `ctx.logger`（控制台可查）；`remote.mud.logs(sessionId)` 返回环条目 + 落盘目录，前端会话头「MUD 日志」tab 据此渲染。连接失败、凭据解析失败、投递缓冲溢出都在这里，不再只有一句 remote 错误。

**加载与模块解析（宿主事实）**：插件包位于宿主 profile 之外时，dsh 的 peer 拦截只在 importer 处于 `$DSH_HOME/profiles/**` 或某个 **linked root**（`<profile>/node_modules` 下指向插件真实目录的链接）之下才参与。所以本包必须在活动 profile 的 `node_modules` 里有一条指向本包真实目录的链接（junction/symlink）：`peerDependencies` 里的 dsh 包才会解析到**运行中的安装**（与宿主共用一份实例；devDependency 那份只服务 tsc 与单测），否则插件 import 自己那份副本。`dsh plugin add` 就是建立该链接并登记 bundle 层的封装；`--patch` 直挂时不建立链接，需手工建。链接在启动时一次性读取，改动后要重启。

归属解析（runtimeFor(agent)）：读 agent 身份 → 查 `accounts`（sessionId = accountId）→ 该账号绑定的服务器 → runtime（含连接）。解析不到 ⇒ 与我们无关（零行为；工具面在此返回可读拒绝，§3.3）。

### 3.2 查找面

```ts
registry: Map<SessionId, SessionRuntime>
runtimeFor(agent): SessionRuntime | null
// 每个 SessionRuntime：{ sessionId, server, account, connection（MUD 输入源，可空——未 connect）,
//                        state（行流解析器 + 聚合缓冲 + 投递水位） }
```

### 3.3 工具面（第二期落地，preset 作用域）

- **二工具**：`mud_send`（发命令 + read 竞速等应答；不带 cmd = 裸读近期行流）与 `mud_state`（连接/接入/录制状态自述）。注册在 **mud-player preset 行**（`src/preset.ts` → `lib/preset.js`，注册期不依赖引擎、执行期 `ctx.get('mudCore3')` 解析引擎窄面）——standard 账号无 mud 工具（preset 决定能力面，非缺陷）；注册完整性自检（实际注册名缺一 fail-loud）；
- **拒绝序（mud_send，全部可读拒绝 `{ok:false,error}` 不 throw）**：①引擎缺席 ②归属 null（会话不在 roster）③禁词表（安全面最高优先）④接入闸门 `admitted=false` ⑤连接 `connState!=='connected'` ⑥执行。mud_state 只过归属、**不受闸门/连接约束**——连接/接入/录制状态是插件本地事实而非 MUD 行流（模型能答"我未接入"要求它能读状态）；
- **禁词表**：最小集 `{ suicide }`（删档不可逆），**全段扫描**（按 `[\s;]+` 切 token，任一命中即拒——堵 "look;suicide" 绕过）；quit/drop/passwd 等可逆命令放行（语料审计发现真实危险行为再逐行加回，加一行表即可）；
- **read 竞速机（`src/read.ts`，`ReadMachine` 独立类挂 SessionRuntime，core3 的 Mud/link 层不动）**：行流多消费者模型下的又一个消费者——`onLine` 吞行判定（钩子，本期空实现）→ pending 录制 → read 在途则累积+判定。判定序 `failOn > until > gaCount > maxLines` 写死；收束源 quiet/timeout/signal/disconnected/danger（`abortWait` 保留 API 供后置意识层打断）；无 root/child（core3 单会话单 agent，并发 read 以 inFlight fail-loud 兜底）；core2 的 `ReadResult.rest` 砍掉（逐行回调模型下判据命中行之后的同批剩余行照常走 onLine，等价 rest 并回缓冲）；`failOn` 是 agent 驱动的打断机制（listen 里设 `/拦路/` 等即命中立即收束返回）；
- **listen 编译（compileListen）**：模型 `listen` 参数编译为 read 判据；全空返回 `{}`，缺省判据由工具层按模式注入后让模型字段覆盖——有 cmd = `gaCount:1 + maxLines:50 兜底`，裸读 = `quietMs:300 + maxLines:50 兜底`（裸读不该有 gaCount 缺省）；
- **timeoutMs 钳制**：`min(参数 ?? defaults.sendTimeoutMs, 60000)`（宿主注册期 `timeoutMs: 60000` 协作式上限）；
- Config：新增 `sendTimeoutMs`（缺省 15000）/`sendMaxLines`（缺省 50）；**移除 `deliverMaxPendingLines`**（自持缓冲随 pull 化废弃，上限由 `recordLines` 环形承担）。

### 3.4 MUD 信息进入 agent（第一期目标：等同人工提问）

**通路 = 会话消息投递**（与人工提问同一通道）：

```
MUD 行流 → 聚合（静默窗口，Config）→ 一条用户消息投递进该账号的会话
        → 宿主原生回合机制（followup 排队 / steer 步边界插话——与 session/prompt 同路）
        → agent 开回合，产生回答（回答落会话，页面可见）
```

- **等同人工提问**：MUD 信息以**用户消息**身份进入会话并触发回合，agent 像被提问一样回答。原「LLM 调用监听钩子注入」方案只能改已有调用的上下文、不产生回答，与此目标不符——弃用为注入通路；其拦截角色也不再需要（第一期唯一通路就是投递通道，闸门在源头）；
- **聚合是必需品不是优化**：行流逐行投递 = 每行一个回合一次模型调用；空闲模式按**静默窗口**聚合（行流静默 N ms 打包一条投递），加上限防超长消息；
- **水位线 pull 模型（第二期改造，投递器不自持缓冲）**：单一真相 = `pendingLines` 录制缓冲（环形 `recordLines`=2000，所有行到达即入，断线清空，环形淘汰计 `droppedLineCount`）。两条水位线（行号空间 = `MudLine.abs`，单调递增、跨重连不归零）：`deliveredAbs`（投递推进）/ `readAbs`（工具读推进），**已见线 seen = max(deliveredAbs, readAbs)**，投递 = 从 seen 之后拉取（`takeLinesAfter(seen)`）。任何把行内容交给 agent 的路径都推进水位（投递/工具读/裸读），本地处理路径不推进——**避免行数据多次进入 agent**；read 在途不需要暂停投递的互斥（水位线天然隔离，重复被结构消除）；
- **投递时机 turn/end 驱动（第二期改造）**：`turn/start` → 投递器**抑制模式**（不武装定时器，行只进 pending）；`turn/end` → **冲刷一次**（回合内积累的行一次投出，订阅宿主 `session/event` global）；空闲模式（agent 不在 turn）保留静默定时语义（quiet/maxWait 到期即 flush）；冷启动补投 = `agent/created` → `flushOnce`（从 seen 拉取一次，触发首个回合）；
- **聚合的边界（全部可配，Config）**：静默窗口 `deliverQuietMs`；**批次最长等待** `deliverMaxWaitMs`——行流持续不静默时也在此上限内投出（否则刷屏流永不投递）；单条上限 = `deliverMaxLines` 行 / `deliverMaxChars` 字符，**超限拆成多条依次投递，不丢行**；
- **失败不丢行**：deliver 回调返回 false 的批次**不推进 deliveredAbs**（行仍在 pending），下次 flush 从失败点自然重试；空白批 commit 不投；
- **断线 = 水位与未投批次一并复位**（pull 推论，定稿语义）：pending 清空（录制语义），未投出的残留行随清空丢失——与「断线是硬收尾、世界状态复位」一致；delivered/readAbs 重置 = -1，abs 空间不归零，重连后新行照常推进；
- **未接入 = 零积累**：不 take、不武装定时器、零缓冲零丢弃（一期「未接入刷丢弃日志」在 pull 化后消失）；
- **与人工提问共存**：投递走宿主 followup 队列，人工消息与 MUD 消息同队列自然排队（会话内串行是宿主保证）；
- **回答的去向**：回答落会话（页面可见、日志可查）；**回流 MUD 的唯一通道 = `mud_send` 工具**（§3.3，受闸门/连接约束）——投递通道本身单向（MUD→agent），回答不自动回流；
- **按会话隔离**：每个 runtime 只向自己的会话投递（两会话互不串线）。

**接入闸门**（唯一许可，作用在投递通道上）：

- **接入 admit**（显式动作，roster `accounts.admitted` 持久，缺省未接入）→ 投递通道开；**水位 = 接入时刻**，不回放积压（接入前的行流不投，要看近况用 `mud_send` 裸读，§3.3）；
- **停止接入 stop** → **MUD 信息不再进入 agent**：投递停（在途回合自然跑完，后续零投递）；行流照常积累 = 录制；已投递的历史留在会话里不动；
- **未接入 = 零进入**：mud_send 可读拒绝（§3.3）+ 投递通道零积累——闸门同时看住 MUD→agent 的两条通路；
- **人工提问不受闸门影响**：人工在会话里发消息是宿主原生回合，不拦（未接入时 agent 用 mud_state 可查状态，诚实答"我未接入"）；
- **后续任何新通路一律受本闸门约束**（现在定死，防止机制生长时语义漂移）：工具面已落地（未接入 ⇒ mud_send 可读拒绝）；唤醒类机制落地，必须以"已接入"为前置——闸门定义在通路集合上，不在单一机制上；
- 与 connect **正交**：connect 管 MUD 源（socket），接入管 MUD→agent 的信息流。"连接 + 未接入" = 录制/挂机模式（连着收流、角色在线、agent 零 MUD 行为）——语料采集、登录调试、离开时省 token 的形态；嫌两步麻烦可在管理面做组合按钮，底层动词仍是两个。

### 3.5 管理面（`packages/mud-webui`）

- **服务器/账号呈现沿用 v1 既有实现，不改**（v1 `MudServer { name, host, port, cwd, users }`：服务器即工作区 + 字段、账号挂服务器下）；
- 新增/改接：账号表单加 preset 选择与接入开关；手工 connect/disconnect；连接状态查看；
- **会话头 tab「MUD 日志」**（`conversation.view` 条目 `mud-log`）：渲染该会话的 `remote.mud.logs` 环条目（按级别/通道着色）与落盘目录，作为连接/投递/闸门的诊断面。tab 只在会话体渲染时出现（宿主 blank 会话不渲染会话体——连接后第一批 MUD 行开启回合即脱离 blank），视图选择按会话持久化（宿主持有，插件不代选）；
- 后端换接：**服务器/账号经 `remote.mud.addServer/addAccount` 登记到宿主名册**（页面 localStorage 只作呈现缓存），**建账号在宿主侧一个动作完成**（写名册 + 建会话，sessionId = 账号 id、绑定 preset）；页面不再自己 `sessions.create`/`agentPresets.select`。删账号/删服务器同样先过宿主再改本地；
**凭据接线**：`connect` 时账号名取自 roster（`accounts.name`），密文经宿主 `ctx.get('credentials').resolve(passRef)` 实时解析；引用不存在/不可读 = 连接失败，错误与日志都带引用名；明文只进登录发送，不进 roster、日志、上下文。
- **右侧栏只读游戏画面 tab（C5）**：`sidebar-right` tab 类型 `mud-game`（**单开**：guide 入口卡片无 params 打开、回退跟随当前会话；openTabs 订阅守卫保证同会话仅一实例——开出第二个即关掉较新，保留最旧实例的 follow 流与工具栏状态；params 随布局持久化——刷新/重开自动恢复）；数据面 = 宿主每 runtime 一个 `@xterm/headless` 无头屏 + `@xterm/addon-serialize`（cols 缺省 120，`viewCols` 可覆盖；scrollback/背压参数成组），游戏行与 send 回显同屏写入——回显前缀 = `账号名@来源`（agent 发送灰 90m / user 发送青 36m，user 为输入回传预留样式；账号名由 register 从 roster 注入；凭据走 sendCredential 不触发 onSend，天然不泄露），屏幕跨重连保留；`remote.mud.follow(sessionId)` 流动词推送：首帧整屏 snapshot 回放 → 增量帧（同 tick 合批，防刷屏小帧）；follower 注册与 snapshot 生成共用一条写操作链（attach 瞬间不丢帧不乱序不重复）；follower 有界队列背压（超限显式断流，客户端重新 follow 以新 snapshot 恢复，互为闭环）；画面通道纯扇出无输入（tab 工具栏的「连接/断开」按钮调既有手工动词 `connect/disconnect`，不属于画面通道），tab 关闭 = follower 清理，连接/投递不受影响；**不受 admit 闸门约束**（画面是 MUD→人的显示面，非 MUD→agent 通路；未接入 = 录制/挂机模式照样可看，agent 零进入语义不变）；
- **状态推送 watchStatus（C5.1）**：状态面由轮询 `status()` 改为服务端推送——runtime `onStateChange` 钩子（setState 统一入口，值变化才触发）+ service 状态广播器（register/admit/stop/dispose 与连接迁移各点广播，多订阅者互不影响）；`remote.mud.watchStatus()` 流动词首帧推全量快照（statuses() 语义，覆盖全部已登记会话）、之后仅变化推帧；客户端 abort（tab 关闭/页面刷新）→ generator finally 清服务端订阅；`status()` 单次动词保留做初始回填/兜底。

---

## §4 验收（最简版）

| 断言 | 内容 |
|---|---|
| 多账号隔离 | N 账号同时在线：各持一条连接、各向自己的会话投递，互不串线（两会话隔离用例） |
| 账号=自动会话 | 建账号**一个动作**完成会话自动创建绑定；`sessionId` = 账号 id 持久；无独立会话操作面 |
| 服务器=工作区+字段 | 建服务器即建工作区；roster 按 workspaceId 存 host/port；页面呈现沿用 v1 不改 |
| 手工连接 | connect 建连+登录、disconnect 断连；断线后**保持断开态**（不自动重连，等手工） |
| **MUD→agent 投递** | 接入后：MUD 行流以**用户消息**进入会话并触发回合，agent 产生回答（端到端）；静默窗口聚合生效（一批 = 一条消息，非逐行）；两会话各收各的 |
| **接入闸门** | 未接入（缺省）与停止接入后：**MUD 信息不再进入**（新投递为零）、行流照常积累；接入**水位 = 接入时刻**（积压不回放）；人工提问不受影响 |
| preset 选择 | 建账号可选 `standard`/`mud-player`；任意 preset 的账号都有 MUD 源（归属 = roster 判定，不按 preset 排除） |
| 凭据链路 | 密码不落 roster/上下文；resolve 失败 = 连接失败可读报错 |
| 游戏画面视图 | 开 tab 见 snapshot 回放 + 实时行流（颜色正确）；关/开 tab、刷新页面连接不断（未接入也可看）；send 回显可见且凭据永不出现；背压超限断流后重 follow 以新 snapshot 恢复；画面不受 admit 闸门约束 |
| 状态推送 | `watchStatus` 首帧全量快照、之后仅变化推帧（无变化零流量）；客户端 abort 清服务端订阅 |
| **工具面** | mud-player 会话可见 `mud_send`/`mud_state`（standard 不可见）；未接入/未连接 ⇒ mud_send 可读拒绝（模型可转告）；`suicide` 全段拦截、可读拒绝带命中词，quit/drop/passwd 放行；mud_state 未接入可读（不受闸门/连接约束）；端到端：连接+接入后 mud_send(cmd) 返回应答原文 |
| **水位线投递** | turn/end 一次投出回合内未消费行；read/裸读消费的行不重复投递；投递只投 seen 之后；投递失败不丢行（下次从失败点重试）；未接入零积累零丢弃；裸读返回近期行（尾部截断生效、含 admit 前录制行、不重复投） |

### 4.1 切片

| 切片 | 内容 | 验收 |
|---|---|---|
| **C1 骨架** | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例绿 | `tsc` + 用例绿（移植自 mud-core2 link/，先红后绿） |
| **C2 多会话** | roster storage + 会话装配（roster 判定 → registry）+ 手工 connect/disconnect + 生命周期（disposed 断连拆 runtime） | 两会话隔离；手工动词生效；disposed 断连拆 runtime |
| **C3 投递与接入** | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行（最小 persona）+ 聚合投递（followup/steer 用户消息）+ admit/stop + 水位 | **端到端**：接入 → MUD 消息进会话 → agent 回答；停止后零投递；水位断言；零工具断言；preset 任选均有 MUD 源 |
| **C4 管理面** | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工 connect/disconnect、状态 | 全流程 UI 可操作 |
| **C5 画面视图 + C5.1 状态推送** | 服务端无头屏（`@xterm/headless` + addon-serialize）+ `follow`/`watchStatus` 流动词 + webui 只读画面 tab（单开、工具栏连接/断开）与状态推送替换轮询 | 开 tab 见回放 + 实时流，关闭不影响连接；状态变化毫秒级可见、无变化零流量 |
| **C6 工具面（二期）** | ReadMachine（`src/read.ts`）+ deliver pull 化（水位线 + turn/end 驱动）+ `src/tools.ts` 纯层（mud_send/mud_state/拒绝序/禁词表）+ `src/preset.ts` preset 行注册 + `toolContextFor`/`defaults` 窄面 | 新增用例全绿（read 23 + runtime TCP 7 + tools 8 + deliver/service 重写）；闸门/连接可读拒绝；suicide 全段拦截；mud_state 不受闸门；timeoutMs 钳制 |

### 4.2 完成定义

`tsc` + 用例全绿；§4 验收表全过；`doc/architecture/` 同步 + `CHANGELOG` 一行。

---

## §5 后置（按例证生长，本版不做）

| 项 | 触发例证 |
|---|---|
| **画面后置项（C5 遗留）**：输入回传（工具面已落地，是否仍需输入回传按使用实证评估）、NAWS/resize 回传、send 回显与 MUD 自回显去重开关、画面历史持久化（headless 屏随 runtime 存活，插件重启即清） | 对应需求实证出现 |
| **行打标与画面分屏（C5.2，已定稿暂缓）** | 用户裁定暂缓；恢复执行按 [doc/plans/c5.2-line-tagging-split-screen.md](../plans/c5.2-line-tagging-split-screen.md)「实施顺序」开工（第一步 = 语料校准），定稿结论无需重议 |
| **流程 flows**（`mud_flow`/fullme/验证码链路） | 工具面之后 |
| **自动重连**（热状态自动、冷启动不自动） | 前置 = 先实现**真实心跳**（MUD 侧健康探测）——无心跳不区分真断线/半开；此前一律手工 connect |
| 投递策略化（字段化摘要、按需投递、水位窗口细化） | 投递内容膨胀实证（token 账目恶化） |
| 子级预算/看门狗 | 子 agent 失控实证（无则用宿主原生 `maxTokens`/激活槽上限） |
| ask 超时（askTimeoutMs） | 确认"无人应答必须超时"的实证需求（原生=挂起） |
| 会话计数/账目 per-runtime | 成本验收需求出现时（先看宿主 telemetry/原生会话事件） |
| 其他 core2 机制（T2 闭环、唤醒、预算、计数、预案） | 按需求例证逐条引入；唤醒落地时**必须**以"已接入"为前置（§3.4 闸门覆盖新通路） |

> AI生成
