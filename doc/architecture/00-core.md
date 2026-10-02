# mud-core3 核心设计（§1–§5，最简版）

> 状态：v0.1.0 设计基线（2026-09-28）。本文只描述目标架构，不记录演进过程。
>
> 设计原则：**只实现被需求直接证实的机制**。core2 的五层心智、T2 闭环、子 agent、预算、计数等全部**后置不设计**（§5）——它们不是错的，只是本版不需要先存在。**第一期目标 = MUD 信息进入 agent（等同人工提问）并得到 agent 回答**（已落地）；**第二期 = 工具面 + 画面**（`mud_send`/`mud_state` + 水位线投递，§3.3/§3.4；画面/状态推送，§3.5，已落地）；**第三期 = 状态面 + 流程面 + 自主行为**（两轴状态/World，§3.6；mud-workflow 声明式流程，§3.7；任务书 kickoff/静默唤醒/分工模型，§3.8，已落地，自主行为待实机验收）。

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
- **开场消息（翻 blank）**：宿主的会话列表投影只在 `turn/start` 事件上把 `blank` 翻成 false（`session-controller/src/list.ts`），而 blank 会话不渲染会话头/会话体（含自建 view）。因此建账号成功后核心层投递一条**真实用户消息**（'mud-wake' 署名，正文 = 任务书，见 §3.8）触发一次真实回合，会话立刻可交互、会话体与「MUD 日志」tab 才出现。**不伪造 `turn/start`**（会污染回合计数与 replay）。代价 = 每账号一次模型调用，`bootstrapOnCreate: false` 可关（关掉后会话保持 blank，直到用户首次发消息或 MUD 信息被投递而自动翻）。

### 2.3 每会话独立 MUD 输入源与连接生命周期

```
建账号（自动建会话）       → 登记该会话的 SessionRuntime（幂等；无连接，未接入）
手工 connect（管理面/mud_connect）→ 只建连，不登录（盲发退役：无自动 login 序列）→ 输入源产生（行流积累，停在登录提示符）
登录                       → 流程 `login`（locked 声明式流程，§3.7；凭据在流程执行时实时 resolve；成功/失败结构化返回）
手工接入 admit             → MUD 信息开始进入 agent：投递通道开（§3.4；水位 = 接入时刻，不回放积压）
停止接入 stop              → MUD 信息不再进入 agent（投递停；行流照常积累 = 录制）
手工 disconnect            → 断连（状态可读）
会话销毁（session/disposed）→ 断连 + 拆 runtime
插件卸载                  → 全拆
```

- **连接生命周期动词 = 手工动词（`remote.mud.connect/disconnect`）+ `mud_connect` 工具（§3.3，幂等）**；连接状态显式可读；
- **断连是硬收尾**：`disconnect` 立即销毁 socket 并同步走完收尾（flush 残留行 → 状态置断开），不做半开关闭等待——半开连接仍会继续收数据，其迟到的 close 会污染后续连接；重连时旧连接的事件按**连接代次**丢弃，不得改变新连接状态。建连失败（对端拒绝/关闭）立即失败并销毁 socket，不等满超时；
- **接入 = 独立手工开关**（`admit`/`stop`，roster 持久、缺省未接入）：连接了也可不接入（录制/挂机模式）；接入才开始读（§3.4）；
- 断线（意外）：runtime 保留、状态置断开、世界状态复位；**不自动重连**——等手工 connect；
- **自动重连后置**（§5）：只在热状态（会话 agent live）自动，冷启动不自动；前置条件 = 先实现**真实心跳**（健康判定依据，无心跳不区分真断线/半开连接）；
- 冷会话：宿主释放 agent 时 runtime 与连接不受影响（连接归 runtime 自持，与 agent 冷热解耦）；只有会话销毁才拆。

### 2.4 凭据

- 页面 `credentials.set`；**凭据解析时机 = 登录流程执行时**（`mud_workflow_run login` → `ctx.get('credentials').resolve(passRef)` 实时解析），明文只经 `sendCredential` 进登录发送（不触发 onSend、不进上下文/roster/日志）；
- resolve 失败 = 流程执行失败（结构化返回，不进连接），报引用名；凭据零泄露三道闸（发送侧不触发 onSend / 注入侧不经模型 / 出口侧统一掩码）。

---

## §3 装配与机制

### 3.1 装配面

```ts
// src/index.ts
apply(ctx, config):
  roster: storage 域挂载（servers 键=workspaceId / accounts 含 admitted；域就绪前内存先行，挂上后迁入）
  remote.mud.* 动词：servers/accounts CRUD、connect/disconnect、admit/stop（接入开关）、
                    status/logs、follow（画面流）/watchStatus（状态推送，§3.5）
                    addAccount = 一个动作：写名册 → 建会话（绑定 preset）→ 投任务书（§3.8）
  agent/created（全局层）→ roster 判定（sessionId ∈ accounts）→ 登记 SessionRuntime + 记 agent 句柄
                          + 装每会话 Wake（§3.8）+ 补投冷会话保留批次
  session/disposed → 拆 Wake + 断连 + 拆 runtime/deliverer/日志
  session/event turn/start|turn/end → 投递抑制 / turn/end 冲刷（§3.3 pull 模型）
  投递通道：admitted 的 runtime 按水位线拉取聚合行流，以用户消息投递进本会话（'mud' 署名，§3.4）
  kickoff 任务书面（'mud-wake' 署名）：建账号 / admit（经 MudServiceDeps.onAdmit 注入）/ 静默唤醒三触发点共用（§3.8）
  归属父链上溯：parentLookup = 官方 live 注册表（ctx.agents.get(id)，agent id ≡ session id）
                实时读 session.header.parentSession（不自建归属状态，见 §3.3）
  ctx.provide('mudCore3', { toolContextFor, connect, workflowEnvFor, stateOf, defaults,
                            runtimeFor, builtinFlows })   // 流程实体经 builtinFlows 交 mud-workflow（§3.7）
```

**名册落库（§1.1/§2.2 的落点）**：名册挂宿主 storage 域（域 `mud` v1，两表 `servers`/`accounts`，记录 schema 是 zod 事实源）；域不可用时降级内存并告警（重启丢账号）。写路径在 `src/accounts.ts`：
- `addServer` 记 `{workspaceId, name, host, port}`（工作区实体由页面经宿主 workspace 面创建，键 = workspaceId）；
- **`addAccount` = 一个动作**：分配账号 id（`session-<uuid>`，即 sessionId）→ **先写名册** → 宿主 `sessionController.create({ sessionId, cwd, agentPreset })` 建会话并绑定 preset；建会话失败回滚名册（不留半成品）。先写名册是硬要求：`agent/created` 的归属判定据此命中，否则 runtime 不会登记；
- 密码不经本插件：页面 `credentials.set(passRef, …)`，`addAccount` 只收引用名；登录脚本执行时（`runWorkflow`）`ctx.get('credentials').resolve` 实时解析；
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

### 3.3 工具面（现役；二期设计 + 三期修订）

**注册与承载**：工具挂 **preset 作用域**——preset 行 plugins 挂插件入口 `src/preset.ts`（经宿主 `ctx.tools.register`；注册期不依赖引擎，执行期 `ctx.get('mudCore3')` 解析引擎窄面，缺席时注册照常、执行可读拒绝）；工具定义在纯层 `src/tools.ts`（零宿主 import，可单测），preset.ts 只做 defineTool 适配；**注册完整性自检**（缺工具 fail-loud）。preset 决定能力面：选 `standard` 的账号无 mud 工具（agent 只能接消息，用户选择非缺陷）。

**工具清单**：`mud_send`（发命令 + 等应答，判据驱动；不带 cmd = 裸读近况；`isConcurrencySafe: false` 独占）、`mud_state`（状态自述，不受闸门/连接约束，只过归属）、`mud_connect`（建连，幂等——三期连接升格为工具，模型可自行调用）。流程五工具（run + list/get/save/delete）归 mud-workflow 包（§3.7）。

**拒绝序**（全部**可读拒绝**——返回 `{ ok: false, error }` 模型可读文本，不 throw）：① 引擎缺席 → 拒；② 归属 `toolContextFor(agent)` 为 null → 拒「本会话未绑定 MUD 账号」（**归属解析 = 父链上溯**：从调用方会话沿 `session.header.parentSession` 上溯查名册，命中账号会话即用其 runtime；**归属权威 = 宿主持久化 session lineage，不自建归属状态**——按 id 查会话走官方 live 注册表 `ctx.agents.get(id)`（agent id ≡ session id），subagent/workflow 派发都写入该字段；祖先必须 live（与宿主 `authorizeLineage` 语义一致），不 live → 上溯终止 → 可读拒，不以陈旧状态解析成功；环深护栏 32 层防数据成环。不开 `mud_send({ sessionId })` 参数，避免跨账号后门）；③ **禁发表**（cmd 存在且命中）→ 拒（安全最高优先，先于连接）；④ `mud_send` 未连接 → 拒「未连接」。**三期修订**：二期原「未接入拒」已删除（`mud_send` 不受接入闸门——应答经工具结果返回调用方，不是投递通路，不破坏 §3.4 投递语义）；「连接是手工动词」改为 `mud_connect` 工具。

**行流持有者（三期补回）**：同一时刻只允许一个执行体在 send+read（根与在途子 agent「争半截应答」的并发保护）——会话级唯一持有者，冲突可读拒绝，应答不劈半。

**ReadMachine（`src/read.ts`，独立类挂 SessionRuntime）**：read 竞速机 = 行流多消费者之一——行到达 → ① pending 录制（永远）→ ② read 在途则 machine.onLine（acc + 判定）→ ③ 投递（水位拉取）。判定序 `failOn > until > gaCount > maxLines`（写死）；异步收束源 quiet/timeout/signal/disconnected/danger；**abortWait 保留 API**（系统驱动打断出口，意识层后置、管道就绪；**failOn 是 agent 驱动的打断**——突发行一到达即命中收束并返回累积行含触发行）；**swallow 吞行钩子**（空实现，规则层后置——规则动作吞行留摘要，见水位线总表）；有界缓冲 = 复用 runtime.pendingLines（不自建）；`ReadResult.rest` 砍（判据命中后的同批剩余行照常走行路径）。until 失配记 error（语料可见）；GA/EOR 边界关窗不算失配。

**水位线 pull 模型（核心）**：**单一真相 = pendingLines**（环形 recordLines=2000，行到达即入，断线清空）。投递器不自持缓冲，投递 = 从 pending 按水位线拉取：

```
deliveredAbs —— 投递推进：已成功投递给 agent 的最远行号
readAbs      —— 工具读推进：最近一次 read 返回结果的最远行号
seen = max(deliveredAbs, readAbs)；初始/断线重置 = -1（abs 跨重连不归零）
投递时机：A. turn 期间抑制（行只进 pending，不打断回合节奏）；
         B. turn/end 冲刷一次；C. 空闲模式 quiet/maxWait 定时到期 flush
admit：delivered = 当前末端（水位 = 接入时刻，积压不回放）；
冷启动补投：agent/created → flushPending（从 seen 拉取一次，触发首回合）；
投递失败：delivered 只推进到成功投出的批次，失败批次停留 pending 下次自然重试——不丢行；
批次粒度 = 静默窗口聚合，与 TCP 块边界无关（同块内的行永不拆入不同批次）。
```

**read 与水位线**：有 cmd——acc 只收 send 后新行（积压留给投递），返回时推进 readAbs = acc 尾行号；裸读（无 cmd）——initial = pending 尾部 maxLines 行快照（**含 admit 前录制行**——挂机近况回看；不物理消费），缺省判据 `maxLines: 50 + quietMs: 300`，返回时推进 readAbs（**裸读读过的行不再投递**）。read 在途**不需要互斥**——水位线天然隔离（readAbs 推进后投递从 seen 之后拉取，重复被结构消除）。

**水位线语义总表**（目标 = **避免行数据多次进入 agent**：把行交给 agent 的路径都推进，本地处理路径不推进）：

| 消费路径 | 推进水位？ | 说明 |
|---|---|---|
| 投递 | ✅ | 投出行 = agent 已见 |
| 工具读（应答 / 裸读） | ✅ | readAbs 推进 = agent 已见 |
| 流程消费（mud_workflow_run） | ✅ | 流程读过的行 = 已见 |
| 状态同步（world / GMCP） | ❌ | 只更新本地状态，行仍可投递/读 |
| 规则动作（后置） | ❌ 吞行留摘要 | 吞掉的行不进任何模型面，只落盘 + 摘要（swallow 钩子） |

**禁发表（安全面）**：拦截表最小集 `{ suicide }`（删档不可逆且任何正常玩法都不需要）；**全段扫描**——命令按 `[\s;]+` 切分全部 token，任一命中即拒（堵 `look;suicide` 绕过），拒绝信息带命中词；quit/exit/drop/passwd 等不设拦（可逆——实证发现危险行为再逐行加回）。

**参数与 Config**：`mud_send` 参数 `{ cmd?, listen?: { until?, failOn?, gaCount?, quietMs?, maxLines? }, timeoutMs? }`；render = ok → 行原文 join('\n')，拒/错 → 可读文本；`timeoutMs` 钳制 ≤ 60000（协作式超时上限）；Config 缺省 `sendTimeoutMs` 15000 / `sendMaxLines` 50；禁词表与 quietMs=300 硬编码（无例证不进 Config）。

**已知限制（不引机制）**：超长回合 + 持续刷屏可积累 pending 至上限，turn/end 一次拉取拆多条 followup 排队；token 账目恶化再按例证加机制（§5）。

> **注**：流程面（`mud_workflow_run` + 流程管理四工具 + 声明式流程注册表 + 解释器）独立成包 `mud-workflow`（§3.7）；流程实体归本包 `src/flows/`（纯度裁定，见 §3.7）。

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
- **回答的去向**：回答落会话（页面可见、日志可查）；**回流 MUD 的唯一通道 = `mud_send` 工具**（§3.3，只拒未连接，不受接入闸门——应答经工具结果返回调用方）——投递通道本身单向（MUD→agent），回答不自动回流；
- **按会话隔离**：每个 runtime 只向自己的会话投递（两会话互不串线）。

**接入闸门**（唯一许可，作用在投递通道上）：

- **接入 admit**（显式动作，roster `accounts.admitted` 持久，缺省未接入）→ 投递通道开；**水位 = 接入时刻**，不回放积压（接入前的行流不投，要看近况用 `mud_send` 裸读，§3.3）；
- **停止接入 stop** → **MUD 信息不再进入 agent**：投递停（在途回合自然跑完，后续零投递）；行流照常积累 = 录制；已投递的历史留在会话里不动；
- **未接入 = 零进入**：MUD 信息进入 agent 的通路只有投递通道（`mud_send` 应答经工具结果返回调用方，是上文已列明的例外；`mud_state`/画面/日志是旁路读，不产生行进入）——闸门唯一看住的就是投递通道；
- **人工提问不受闸门影响**：人工在会话里发消息是宿主原生回合，不拦（未接入时 agent 诚实答"我未接入 MUD"）；
- **后续任何新通路一律受本闸门约束**（现在定死，防止机制生长时语义漂移）：唤醒类机制落地，必须以"已接入"为前置——闸门定义在通路集合上，不在单一机制上；**三期修订**：`mud_send` 例外（只拒未连接，不受闸门——应答经工具结果返回调用方，不是投递通路，见 §3.3）；
- 与 connect **正交**：connect 管 MUD 源（socket），接入管 MUD→agent 的信息流。"连接 + 未接入" = 录制/挂机模式（连着收流、角色在线、agent 零 MUD 行为）——语料采集、登录调试、离开时省 token 的形态；嫌两步麻烦可在管理面做组合按钮，底层动词仍是两个。

### 3.5 管理面（`packages/mud-webui`）

- **服务器/账号呈现沿用 v1 既有实现，不改**（v1 `MudServer { name, host, port, cwd, users }`：服务器即工作区 + 字段、账号挂服务器下）；
- 新增/改接：账号表单加 preset 选择与接入开关；手工 connect/disconnect；连接状态查看；
- **会话头 tab「MUD 日志」**（`conversation.view` 条目 `mud-log`）：渲染该会话的 `remote.mud.logs` 环条目（按级别/通道着色）与落盘目录，作为连接/投递/闸门的诊断面。tab 只在会话体渲染时出现（宿主 blank 会话不渲染会话体——连接后第一批 MUD 行开启回合即脱离 blank），视图选择按会话持久化（宿主持有，插件不代选）；
- 后端换接：**服务器/账号经 `remote.mud.addServer/addAccount` 登记到宿主名册**（页面 localStorage 只作呈现缓存），**建账号在宿主侧一个动作完成**（写名册 + 建会话，sessionId = 账号 id、绑定 preset）；页面不再自己 `sessions.create`/`agentPresets.select`。删账号/删服务器同样先过宿主再改本地；
**凭据接线**：`connect` 时账号名取自 roster（`accounts.name`），密文经宿主 `ctx.get('credentials').resolve(passRef)` 实时解析；引用不存在/不可读 = 连接失败，错误与日志都带引用名；明文只进登录发送，不进 roster、日志、上下文。
- **右侧栏只读游戏画面 tab（C5）**：`sidebar-right` tab 类型 `mud-game`（**单开**：guide 入口卡片无 params 打开、回退跟随当前会话；openTabs 订阅守卫保证同会话仅一实例——开出第二个即关掉较新，保留最旧实例的 follow 流与工具栏状态；params 随布局持久化——刷新/重开自动恢复）；数据面 = 宿主每 runtime 一个 `@xterm/headless` 无头屏 + `@xterm/addon-serialize`（cols 缺省 120，`viewCols` 可覆盖；scrollback/背压参数成组），游戏行与 send 回显同屏写入——回显前缀 = `账号名@来源`（agent 发送灰 90m / user 发送青 36m，user 为输入回传预留样式；账号名由 register 从 roster 注入；凭据走 sendCredential 不触发 onSend，天然不泄露），屏幕跨重连保留；`remote.mud.follow(sessionId)` 流动词推送：首帧整屏 snapshot 回放 → 增量帧（同 tick 合批，防刷屏小帧）；follower 注册与 snapshot 生成共用一条写操作链（attach 瞬间不丢帧不乱序不重复）；follower 有界队列背压（超限显式断流，客户端重新 follow 以新 snapshot 恢复，互为闭环）；画面通道纯扇出无输入（tab 工具栏的「连接/断开」按钮调既有手工动词 `connect/disconnect`，不属于画面通道），tab 关闭 = follower 清理，连接/投递不受影响；**不受 admit 闸门约束**（画面是 MUD→人的显示面，非 MUD→agent 通路；未接入 = 录制/挂机模式照样可看，agent 零进入语义不变）；
- **状态推送 watchStatus（C5.1）**：状态面由轮询 `status()` 改为服务端推送——runtime `onStateChange` 钩子（setState 统一入口，值变化才触发）+ service 状态广播器（register/admit/stop/dispose 与连接迁移各点广播，多订阅者互不影响）；`remote.mud.watchStatus()` 流动词首帧推全量快照（statuses() 语义，覆盖全部已登记会话）、之后仅变化推帧；客户端 abort（tab 关闭/页面刷新）→ generator finally 清服务端订阅；`status()` 单次动词保留做初始回填/兜底。

### 3.6 状态面（两轴 + 世界状态）

```
conn:      disconnected | connecting | connected      ← 传输轴
loggedIn:  unknown | in-game                          ← 登录轴（断线复位为 unknown，不是 false）
world:     GMCP 事件驱动（HP / 口渴 / 位置 / 登录态 / 金钱 …按需生长）
```

- **GMCP 是权威登录信号**（不依赖行文匹配）：`link/telnet.ts` 已实现协商与子协商（`emit('gmcp', …)`），接收端零新增——GMCP 包到达即置 `loggedIn = 'in-game'` 并写入 world（zone = 'gmcp'，key = 包名，置信度 measured，后到覆盖）；
- **世界状态 world**（每会话一个 `World` 实例，随 runtime 存亡）：按**分区**（zone：vitals/combat/location/session/gmcp…）+ **置信度**（measured = 直接测量 / inferred = 推断，规则层后置）+ **来源追溯**（kind/time）组织，同 zone+key **后到覆盖**旧值；行级规则后置（无例证不建规则层，§5）；
- **断线同时反转两轴 + world 整体复位**：`conn → disconnected` + `loggedIn → unknown` + `world.clear()`——世界状态随连接存亡，重连后由 GMCP 重新置位/写入；
- **状态出口（全体 agent 共读**——子 agent 是消耗品，状态不能只存在它脑子里）：`status`/`watchStatus`（§3.5）、`mud_state`（§3.3，插件状态 + world 合并快照）、任务书占位符（§3.8）。

### 3.7 流程面（mud-workflow 包）

**包结构与纯度裁定**：流程面独立成包 `packages/mud-workflow`（与 mud-webui/mud-core3 同级），挂载即提供 `mudWorkflow` 服务面（注册表），工具走独立 preset 行；**mud-workflow 是纯架构不含数据**（schema/注册表/解释器/工具面，零宿主 import）——流程实体归 core3 `src/flows/`（type-only import 词汇表类型，运行时零循环），经 `ctx.provide('mudCore3', { builtinFlows })` 交注册表挂载（`registerBuiltins` fail-loud 校验、幂等、不触碰 agent 修缮层）。

**流程本体 = JSON 声明式步骤表**（TS 字面量承载——编译期类型检查；agent 侧 get/save 面是纯 JSON）。与 login.md 流程表（driver/action/branch/next）同构：表与解释器分离，表变数据。JSON 无任意代码，schema + 词汇表白名单 = 静态可验证的安全；执行器 = 进程内解释器（复用 env 原语），无沙箱、无 ptcRuntime、零新宿主依赖（取舍：`ctx.workflowEngine` 否决——六全局写死无桥；`ptcRuntime`/脚本文本后置——表达力强但信任面大，等「JSON 表达不了」的例证再评估）。

**词汇表（第一版，从 login 提炼，够用再长）**：

- **读窗 wait**：until/failOn（字符串正则源 + flags，解释器编译）/gaCount/quietMs/maxLines/`timeoutMs`（**必填**——绝不无界等待）；
- **动作 action**（单动作）：`send` | `sendCredential`——凭据占位 `{name}`/`{pass}` 由引擎注入替换（不经模型）；send 空串拒，sendCredential 允许空串（终态空命令走凭据通道，不进发送回显）；
- **路由**：`branch`（until 命中序 → 目标）/ `onFailOn`（failOn 命中序 → 分类出口）/ `next`（缺省后继）；目标 = `goto` | `exit`（stage 分类 + ok，'success' 强制 ok:true）；
- 循环/计算/条件后置（§5）。

**注册表（锁定与进化）**：`locked` 预制拒改拒删；非 locked 预制与 agent 新建可 save（version 自增）——**粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试 = 进化闭环**（流程 = agent 能力的持久化载体，delete 还原预制）。保存门（确定性校验即生效）= zod schema 校验 + checkFlow 结构门（goto 目标存在 / 命中序界内 / success ok:true）+ 凭据红线；存储 = 独立域 `mud_workflow`（workflows 表；域不可用降级内存并告警，内存先行域挂上后迁入）。

**凭据红线（双闸）**：`sendCredential` 动词**只允许 locked 流程使用**——registry.save 静态拒（agent 可写词汇表不含凭据动词）+ 解释器执行侧 throw。依据：粗胚时序错误会把凭据发进错误窗口（公屏 = 泄露），login 锁死 = 全系统唯一凭据流程。

**解释器（runFlow 纯函数）**：每步 = **wait → failOn 出口 → action → 路由**（动作在路由前执行——步骤的应答总发；条件发送 = 独立步骤）。等待前取 pending 尾部快照做 initial（提示符先到先结算）；failOn/until 在**本窗文本**上按声明序重测（ReadResult 不带命中 index）；无 next 且 branch 未命中 = **结构缺出口**的结构化 timeout（点名步骤，粗胚修缮的失败信号，不静默）；步转移上限 256（防 goto 环）；非 done/failOn 收束（timeout/quiet/signal/disconnected/danger）一律 timeout 出口（语义 = 放弃等待、帧未提交，现场行随结果返回）；**出口统一过 pass 掩码**（凭据零泄露最后一道闸——流程作者忘写也不泄露）。

**工具面（五工具，独立 preset 行；原文返回、可读拒绝、注册完整性自检）**：

- `mud_workflow_run { name }`：白名单执行（不接受任意路径），模型 API `{ ok, stage, lines }`；执行链 = 归属解析（core3 `toolContextFor`，§3.3）→ 注册表取流程 → core3 `workflowEnvFor` 缝 → 解释器 → release；
- 流程管理四工具 list/get/save/delete：save 过三门，locked 拒改拒删；get 返回完整流程 JSON 供修缮。

**workflowEnvFor 缝（core3 侧）**：执行序 = 未登记/未连接可读错 → 凭据解析（失败 fail-loud，报引用名）→ `acquireSend(holder)`（流程独占 send+read，冲突可读错）→ env 原语（send/sendCredential/read/recentLines/state）+ creds 注入 → release 由调用方 finally 保证。凭据零泄露三道闸落位：发送侧（sendCredential 不触发 onSend，§2.4）、注入侧（不经模型）、出口侧（解释器 pass 掩码）。

**login 实体（locked，判据严格照 [login.md](../mud-core/flows/login.md) 定稿 + 两条实测勘误）**：步表 `prompt-name → prompt-pass（failOn 需创建新人物 → need-new 出口）→ confirm（failOn 密码错误类 'm' 多行锚 → bad-pass；branch replace）→ replace（答 y）→ wait-success → send-empty（空命令走凭据通道）→ wait-ga（收 GA = 登录收尾确认）→ success`。实测勘误（E2E 确证）：① **failOn 归窗**——失败分类是发送后的应答，failOn 必须挂在**发送后的那一窗**（挂发送前等 driver 的窗永远赶不到）；② **「欢迎来到」成功句不可用**——与建连横幅「欢迎来到北大侠客行」撞车，登录前即到达会误判成功；成功句以「目前权限：(player)」「重新连线完毕」为准。连接守卫不在流程表（workflowEnvFor 在 env 注入前拒绝未连接）；验证码链路不进流程（流程不能等人工，人工环节留 agent 层）；失败不设恢复路径（不自作主张重试）。

### 3.8 自主行为（任务书 kickoff + 静默唤醒 + 分工模型）

**任务书面（kickoff 投递面）**：三触发点共用同一 `kickoff(sessionId)` 与同一模板——① 建账号（announce，翻 blank）；② admit（经 `MudServiceDeps.onAdmit` 回调注入：开闸门**并**投一条状态任务书触发规划，两动作合一、保持 admit 纯闸门语义）；③ 静默唤醒到期。正文 = 服务器/账号事实 + 两轴实时状态 + 目标（**状态驱动**：只给事实与目标，不写指令序列——根醒来读状态自行规划，已完成的步骤不重做）。模板 = Config `taskBrief`（占位符 `{{serverName}}/{{endpoint}}/{{account}}/{{conn}}/{{loggedIn}}`，投递时以实时状态填充；缺省内置，部署可覆盖）。署名 `'mud-wake'`（声明合并自扩，与行批次 'mud' 区分）。admit 之前的手工「连接」不触发规划（手动连接 = 调试用途）；已接入场景下断线后的补登录由静默唤醒兜底（`mud_connect` 幂等不重连）。

**静默唤醒器（Wake，每会话一实例；agent/created 装、session/disposed 与插件卸载拆）**：单 timer、**行到达即 re-arm**（runtime `onActivity` 钩子）——行流持续到达永不到期，静默满 `silenceMs`（Config，缺省 120_000，正整数 fail-loud）到期时查**三守卫**：① 已接入（§3.4 闸门前置：唤醒以"已接入"为前置）；② 非回合中（回合中开新回合会打断节奏；turn/end 后的持续静默会再次到期）；③ 行流持有者空闲（无在途 read/send；在途 read 有自己的收束）。任一不满足只 re-arm 不唤醒；命中 → kickoff 投状态任务书；fire 后不自动重复，靠后续行到达重新武装。**不做**"无子 agent 在途"与"结算已消化"守卫（V7 纪律：接受冗余唤醒——根的决策输入是唤醒正文，不是唤醒次数；结算唤醒归宿主，插件不查子级）。

**分工模型（三层，各管一段；persona「分工协议」五条根/子同读、按角色行事——纯书写约定，无代码解析）**：

```
根 agent          规划「要点」：读状态 → 拆自足要点序列（子看不到根的会话历史）→
                  subagent（宿主原生，continuable 后台模式）委派一个子 → 休眠等结算
                  ——判断归根，根不亲执
子 agent          串行执行要点：成功 → 下一个，不逐个回报；任一步失败 → 立即停止，
                  收尾文本写明现场（已完成 / 未完成 / 卡在哪）→ 执行完必须终结（子不常驻）
结算（宿主原生）  watchSettlement：子终结（whenIdle 且 inbox 无 pending）→ 结算单投递
                  parentSession（父空闲开新回合 / 运行中步边界插话）——一次委派 = 一次结算
                  由宿主保证，插件零代码；预算耗尽的超时失败本身也是一次结算通知
脚本（流程 §3.7） 点内的确定性步骤（提示符驱动 + 读应答 + 判据）；只做序列与判据，
                  不做决策、不自行重试；失败原样返回给子
```

- 脚本管**点内步骤**、子 agent 管**点间顺序与执行智能**、根管**要点的产生与重写**——三者互不越界；子不重新规划、不擅自重试失败步骤；
- 脚本不是必需路径：确定性要点（登录）用流程 `mud_workflow_run`，需判断的要点（补充食物水）由子直接用 `mud_send`/`mud_state` 完成；
- **连接与登录是两个独立要点**：根已判定"已连接"时，子拿到的第一个要点就是"登录"，子不管 connect；未连接时根把"连接"作为第一个要点。判断归根，执行归子，脚本不猜；
- 一次委派 = 一次结算：子必须终结（全部完成或失败停止），否则根永不醒；
- 结算回报面：结算通知是 best-effort 且只有文本通道——根醒来要读的结构化现场由 `SessionLog` + `mud_state` 承担（结算只负责叫醒）。

---

## §4 验收（最简版）

| 断言 | 内容 |
|---|---|
| 多账号隔离 | N 账号同时在线：各持一条连接、各向自己的会话投递，互不串线（两会话隔离用例） |
| 账号=自动会话 | 建账号**一个动作**完成会话自动创建绑定；`sessionId` = 账号 id 持久；无独立会话操作面 |
| 服务器=工作区+字段 | 建服务器即建工作区；roster 按 workspaceId 存 host/port；页面呈现沿用 v1 不改 |
| 手工连接 | connect **只建连**（幂等：已连接不重连、不踢已登录会话；登录归流程 §3.7）、disconnect 断连；断线后**保持断开态**（不自动重连，等手工/静默唤醒兜底规划） |
| **MUD→agent 投递** | 接入后：MUD 行流以**用户消息**进入会话并触发回合，agent 产生回答（端到端）；静默窗口聚合生效（一批 = 一条消息，非逐行）；两会话各收各的 |
| **接入闸门** | 未接入（缺省）与停止接入后：**MUD 信息不再进入**（新投递为零）、行流照常积累；接入**水位 = 接入时刻**（积压不回放）；人工提问不受影响 |
| preset 选择 | 建账号可选 `standard`/`mud-player`；任意 preset 的账号都有 MUD 源（归属 = roster 判定，不按 preset 排除） |
| 凭据链路 | 密码不落 roster/上下文/日志/画面；resolve 失败 = **流程执行**失败（结构化返回，不进连接），可读报引用名 |
| **工具面** | mud-player 会话可见 `mud_connect`/`mud_send`/`mud_state`（standard 不可见）；`mud_connect` 幂等（已连接不重连、不踢已登录会话）；`mud_send` 判据驱动、应答原文返回、禁发表全段扫描（带命中词；quit/drop/passwd 放行）、并发持有者可读拒绝不劈半、只拒未连接；`mud_state` 不受闸门，只过归属；端到端：连接后 mud_send(cmd) 返回应答原文（§3.3） |
| 画面与状态推送 | 开「画面」tab 见 snapshot 回放 + 实时行流（send 回显可见、凭据永不出现；背压超限断流后重 follow 以新 snapshot 恢复）；状态经 `watchStatus` 推送（首帧快照 + 变化推帧、无变化零流量，abort 清服务端订阅）；未接入也可看画面（显示面不经闸门）；关/开 tab 连接不断 |
| **水位线投递** | turn/end 一次投出回合内未消费行；read/裸读消费的行不重复投递；投递只投 seen 之后；投递失败不丢行（下次从失败点重试）；未接入零积累零丢弃；裸读返回近期行（尾部截断生效、含 admit 前录制行、不重复投） |
| **状态面（三期）** | 两轴 `conn`/`loggedIn` 语义正确（断线复位两轴 + world 整体复位）；GMCP 包到达即置 `in-game`（权威信号，不依赖行文匹配）；world 分区/置信度/来源追溯，后到覆盖（§3.6） |
| **归属上溯（三期）** | 子 agent/流程调用沿 `session.header.parentSession` 上溯命中账号会话即可用其 runtime；祖先不 live → 可读拒；环深护栏 32 层（§3.3） |
| **流程面（三期）** | 五工具（run + list/get/save/delete）现役；locked 拒改拒删；save 过三门（zod + checkFlow + 凭据红线）；非 done/failOn 收束一律结构化 timeout；出口 pass 掩码（凭据不泄露）；login（locked）E2E 五路径绿（§3.7） |
| **静默唤醒（三期）** | 行到达 re-arm；静默满 `silenceMs` 到期查三守卫（已接入 + 非回合中 + 持有者空闲），任一不满足只 re-arm；命中投状态任务书（'mud-wake'）；三触发点（建账号/admit/唤醒）共用同一 kickoff 与模板（§3.8） |
| **自主行为（三期，待实机验收）** | 分工协议 persona 五条根/子同读；根规划/子执行/宿主结算——实机验收清单见 [PLAN.md](../PLAN.md)（T4b，7 项） |

### 4.1 切片

| 切片 | 内容 | 验收 |
|---|---|---|
| **C1 骨架** | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例绿 | `tsc` + 用例绿（移植自 mud-core2 link/，先红后绿） |
| **C2 多会话** | roster storage + 会话装配（roster 判定 → registry）+ 手工 connect/disconnect + 生命周期（disposed 断连拆 runtime） | 两会话隔离；手工动词生效；disposed 断连拆 runtime |
| **C3 投递与接入** | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行（最小 persona）+ 聚合投递（followup/steer 用户消息）+ admit/stop + 水位 | **端到端**：接入 → MUD 消息进会话 → agent 回答；停止后零投递；水位断言；零工具断言；preset 任选均有 MUD 源 |
| **C4 管理面** | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工 connect/disconnect、状态 | 全流程 UI 可操作 |
| **C5 画面视图 + C5.1 状态推送** | 服务端无头屏（`@xterm/headless` + addon-serialize）+ `follow`/`watchStatus` 流动词 + webui 只读画面 tab（单开、工具栏连接/断开）与状态推送替换轮询 | 开 tab 见回放 + 实时流，关闭不影响连接；状态变化毫秒级可见、无变化零流量 |
| **C6 工具面（二期）** | ReadMachine（`src/read.ts`）+ deliver pull 化（水位线 + turn/end 驱动）+ `src/tools.ts` 纯层（mud_send/mud_state/拒绝序/禁词表）+ `src/preset.ts` preset 行注册 + `toolContextFor`/`defaults` 窄面 | 新增用例全绿（read 23 + runtime TCP 7 + tools 8 + deliver/service 重写）；闸门/连接可读拒绝；suicide 全段拦截；mud_state 不受闸门；timeoutMs 钳制 |
| **T1 状态地基（三期）** | 两轴状态（`conn`/`loggedIn`）+ GMCP 权威登录信号 + World 世界状态（分区/置信度/来源追溯，断线整体复位，详见 §3.6） | 状态用例绿（world/disconnect 复位断言）；GMCP 到达即置 `in-game` |
| **T2 工具面（三期）** | `mud_connect` 工具（幂等建连）+ 归属父链上溯（session lineage + 官方 live 注册表，环深护栏 32，不自建归属状态）+ 会话级行流持有者（acquireSend/releaseSend）+ `mud_send` 拒绝序修订（删接入闸门） | 三工具用例绿；归属上溯/祖先不 live/持有者冲突可读拒绝 |
| **T3 脚本面（三期）** | `packages/mud-workflow` 独立包（schema/注册表/解释器/五工具）+ core3 `workflowEnvFor` 缝 + login locked 流程实体（纯度裁定归 core3，两条实测勘误） | mud-workflow 36 用例绿；core3 login E2E 五路径绿（§3.7） |
| **T4 自主行为（三期）** | kickoff 任务书面（三触发点共用 + Config `taskBrief`）+ Wake 静默唤醒器（单 timer、行到达 re-arm、三守卫）+ persona 分工协议五条 | 207 用例全绿；实机验收见 [PLAN.md](../PLAN.md) T4b 清单（待真机+凭据勾验） |

### 4.2 完成定义

`tsc` + 用例全绿；§4 验收表全过；`doc/architecture/` 同步 + `CHANGELOG` 一行。

---

## §5 后置（按例证生长，本版不做）

| 项 | 触发例证 |
|---|---|
| **画面后置项（C5 遗留）**：输入回传（工具面已落地，是否仍需输入回传按使用实证评估）、NAWS/resize 回传、send 回显与 MUD 自回显去重开关、画面历史持久化（headless 屏随 runtime 存活，插件重启即清） | 对应需求实证出现 |
| **行打标与画面分屏（C5.2，已定稿暂缓）** | 用户裁定暂缓；恢复执行按 [doc/plans/c5.2-line-tagging-split-screen.md](../plans/c5.2-line-tagging-split-screen.md)「实施顺序」开工（第一步 = 语料校准），定稿结论无需重议 |
| **流程扩展**（fullme/验证码链路、词汇表扩展、参数化 args 占位符） | 「JSON 词汇表表达不了」的例证出现（§3.7：验证码等人工环节留 agent 层，流程不能等人工） |
| **规则层**（swallow 吞行动作、danger 危险判据） | 行级规则实证需求出现（swallow 钩子管道已留，§3.3） |
| **意识层**（系统驱动 abortWait 打断） | 系统级打断实证需求（abortWait API 已保留，§3.3；failOn 已覆盖 agent 驱动打断） |
| **自动重连**（热状态自动、冷启动不自动） | 前置 = 先实现**真实心跳**（MUD 侧健康探测）——无心跳不区分真断线/半开；此前一律手工 connect |
| 投递策略化（字段化摘要、按需投递、水位窗口细化） | 投递内容膨胀实证（token 账目恶化） |
| 子级 deadline/预算 interrupt（插件侧到期打断） | 子 agent 超时/失控实证（结算归宿主 watchSettlement，插件不查子级——V7 纪律，§3.8） |
| ask 超时（askTimeoutMs） | 确认"无人应答必须超时"的实证需求（原生=挂起） |
| 会话计数/账目 per-runtime | 成本验收需求出现时（先看宿主 telemetry/原生会话事件） |
| 其他 core2 机制（T2 闭环、预算、计数、预案；唤醒已落地 §3.8） | 按需求例证逐条引入；任何新通路落地时**必须**以"已接入"为前置（§3.4 闸门覆盖新通路） |

> AI生成
