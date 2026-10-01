# mud-core3 核心设计（§1–§5，最简版）

> 状态：v0.1.0 设计基线（2026-09-28）。本文只描述目标架构，不记录演进过程。
>
> 设计原则：**只实现被需求直接证实的机制**。core2 的五层心智、T2 闭环、子 agent、预算、唤醒、计数等全部**后置不设计**（§5）——它们不是错的，只是本版不需要先存在。**第一期目标 = MUD 信息进入 agent（等同人工提问）并得到 agent 回答**；工具、流程全部后置。

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

**归属解析服务**：`ctx.provide('mudCore3', { runtimeFor })` —— 由 agent 解析所属 runtime，不属于本插件返回 null（后期工具面即在此拒绝）。


**诊断面（log）**：每会话一个 `SessionLog`——内存环（缺省 2000 条；运行/网络/投递/闸门事件）+ 按天 JSONL 落盘（`<logDir>/mud-YYYYMMDD-<sessionId>.log`，5MB 滚动 ×3）。原始行流**只落盘、不进环**（否则刷屏行会冲掉诊断信息）。warn/error 同时镜像到宿主 `ctx.logger`（控制台可查）；`remote.mud.logs(sessionId)` 返回环条目 + 落盘目录，前端会话头「MUD 日志」tab 据此渲染。连接失败、凭据解析失败、投递缓冲溢出都在这里，不再只有一句 remote 错误。

**加载与模块解析（宿主事实）**：插件包位于宿主 profile 之外时，dsh 的 peer 拦截只在 importer 处于 `$DSH_HOME/profiles/**` 或某个 **linked root**（`<profile>/node_modules` 下指向插件真实目录的链接）之下才参与。所以本包必须在活动 profile 的 `node_modules` 里有一条指向本包真实目录的链接（junction/symlink）：`peerDependencies` 里的 dsh 包才会解析到**运行中的安装**（与宿主共用一份实例；devDependency 那份只服务 tsc 与单测），否则插件 import 自己那份副本。`dsh plugin add` 就是建立该链接并登记 bundle 层的封装；`--patch` 直挂时不建立链接，需手工建。链接在启动时一次性读取，改动后要重启。

归属解析（runtimeFor(agent)）：读 agent 身份 → 查 `accounts`（sessionId = accountId）→ 该账号绑定的服务器 → runtime（含连接）。解析不到 ⇒ 与我们无关（第一期无工具面，无拒绝路径；后期工具落地时此处即拒绝点）。

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
- **聚合是必需品不是优化**：行流逐行投递 = 每行一个回合一次模型调用；缺省按**静默窗口**聚合（行流静默 N ms 打包一条投递，N 为 Config），必要时加上限防超长消息；
- **聚合的边界（全部可配，Config）**：静默窗口 N ms；**批次最长等待** M ms——行流持续不静默时也在此上限内投出（否则刷屏流永不投递）；单条上限 = maxLines 行 / maxChars 字符，**超限拆成多条依次投递，不丢行**；缓冲上限 = maxPendingLines 行，超出丢最旧并上报；
- **agent 离线（冷会话）不丢投递**：deliver 回调返回 false 时批次**保留在缓冲**（受上限约束），`agent/created` 时补投；接入水位语义不变（admit 清空积压、不回放）；
- **录制缓冲**：runtime 保留最近 recordLines 行（缺省 2000，环形丢最旧）供后续工具裸读，与投递缓冲相互独立——挂机模式两条缓冲都有界；
- **与人工提问共存**：投递走宿主 followup 队列，人工消息与 MUD 消息同队列自然排队（会话内串行是宿主保证）；
- **回答的去向**：第一期回答只落会话（页面可见、日志可查）——**不回流 MUD**（发命令是后期工具面的事，§5）；
- **按会话隔离**：每个 runtime 只向自己的会话投递（两会话互不串线）。

**接入闸门**（唯一许可，作用在投递通道上）：

- **接入 admit**（显式动作，roster `accounts.admitted` 持久，缺省未接入）→ 投递通道开；**水位 = 接入时刻**，不回放积压（接入前的行流不投，要看近况后期用工具裸读）；
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
- **右侧栏只读游戏画面 tab（C5）**：`sidebar-right` tab 类型 `mud-game`（可多开，params 随布局持久化——刷新/重开自动恢复）；数据面 = 宿主每 runtime 一个 `@xterm/headless` 无头屏 + `@xterm/addon-serialize`，游戏行与 send 回显（凭据走 sendCredential 不触发 onSend，天然不泄露）同屏写入，屏幕跨重连保留；`remote.mud.follow(sessionId)` 流动词推送：首帧整屏 snapshot 回放 → 增量帧（同 tick 合批，防刷屏小帧）；follower 注册与 snapshot 生成共用一条写操作链（attach 瞬间不丢帧不乱序不重复）；follower 有界队列背压（超限显式断流，客户端重新 follow 以新 snapshot 恢复，互为闭环）；纯扇出无输入，tab 关闭 = follower 清理，连接/投递不受影响；**不受 admit 闸门约束**（画面是 MUD→人的显示面，非 MUD→agent 通路；未接入 = 录制/挂机模式照样可看，agent 零进入语义不变）；
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
| 零工具面 | 第一期不注册任何 MUD 工具（preset 工具集断言：无 mud_send/mud_state） |
| 画面与状态推送 | 开「画面」tab 见 snapshot 回放 + 实时行流（send 回显可见、凭据永不出现）；状态经 `watchStatus` 推送（首帧快照 + 变化推帧）；未接入也可看画面（显示面不经闸门）；关/开 tab 连接不断 |

### 4.1 切片

| 切片 | 内容 | 验收 |
|---|---|---|
| **C1 骨架** | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例绿 | `tsc` + 用例绿（移植自 mud-core2 link/，先红后绿） |
| **C2 多会话** | roster storage + 会话装配（roster 判定 → registry）+ 手工 connect/disconnect + 生命周期（disposed 断连拆 runtime） | 两会话隔离；手工动词生效；disposed 断连拆 runtime |
| **C3 投递与接入** | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行（最小 persona）+ 聚合投递（followup/steer 用户消息）+ admit/stop + 水位 | **端到端**：接入 → MUD 消息进会话 → agent 回答；停止后零投递；水位断言；零工具断言；preset 任选均有 MUD 源 |
| **C4 管理面** | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工 connect/disconnect、状态 | 全流程 UI 可操作 |
| **C5 画面视图** | 右侧栏只读游戏画面（服务端 headless 无头屏 + `follow` 流动词 + webui `mud-game` tab，详见 §3.5） | 开 tab 见 snapshot 回放 + 实时行流；关闭不影响连接；未接入可看 |
| **C5.1 状态推送** | 状态呈现由轮询改 `watchStatus` 服务端推送（首帧全量快照 + 变化推帧，详见 §3.5） | 状态变化实时可见；abort 清订阅；多订阅者互不影响 |

### 4.2 完成定义

`tsc` + 用例全绿；§4 验收表全过；`doc/architecture/` 同步 + `CHANGELOG` 一行。

---

## §5 后置（按例证生长，本版不做）

| 项 | 触发例证 |
|---|---|
| **MUD 工具面**（`mud_send`/`mud_state`/禁发表；agent 回答回流 MUD） | 第一期目标达成后——agent 只接消息给回答，需发送命令时上工具；落地时受接入闸门约束（§3.3 现在定死的约束） |
| **流程 flows**（`mud_flow`/fullme/验证码链路） | 工具面之后 |
| **自动重连**（热状态自动、冷启动不自动） | 前置 = 先实现**真实心跳**（MUD 侧健康探测）——无心跳不区分真断线/半开；此前一律手工 connect |
| 投递策略化（字段化摘要、按需投递、水位窗口细化） | 投递内容膨胀实证（token 账目恶化） |
| 子级预算/看门狗 | 子 agent 失控实证（无则用宿主原生 `maxTokens`/激活槽上限） |
| ask 超时（askTimeoutMs） | 确认"无人应答必须超时"的实证需求（原生=挂起） |
| 会话计数/账目 per-runtime | 成本验收需求出现时（先看宿主 telemetry/原生会话事件） |
| 画面通道增强（输入回传、NAWS/resize 回传、send 回显去重开关、画面历史持久化） | 需求例证出现时（C5 后置项归档，C5 交付时裁定） |
| 其他 core2 机制（T2 闭环、唤醒、预算、计数、预案） | 按需求例证逐条引入；唤醒落地时**必须**以"已接入"为前置（§3.4 闸门覆盖新通路） |

> AI生成
