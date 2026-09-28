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
- 账号 → 会话 1:1，`sessionId` = 账号 id（建账号时生成，显式指定）；删账号即销毁会话。

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
  remote.mud.* 动词：servers/accounts CRUD、connect/disconnect（手工）、admit/stop（接入开关）、status
  agent/created（全局层）→ roster 判定（sessionId ∈ accounts）→ 登记该会话的 SessionRuntime（幂等，无连接）
  session/disposed → 断连 + 拆 runtime
  投递通道：admitted 的 runtime 把聚合后的行流以用户消息投递进本会话（followup/steer，§3.4）
  ctx.provide('mudCore3', { runtimeFor })
```

归属解析（runtimeFor(agent)）：读 agent 身份 → 查 `accounts`（sessionId = accountId）→ 该账号绑定的服务器 → runtime（含连接）。解析不到 ⇒ 与我们无关（第一期无工具面，无拒绝路径；后期工具落地时此处即拒绝点）。

### 3.2 查找面

```ts
registry: Map<SessionId, SessionRuntime>
runtimeFor(agent): SessionRuntime | null
// 每个 SessionRuntime：{ sessionId, server, account, connection（MUD 输入源，可空——未 connect）,
//                        state（行流解析器 + 聚合缓冲 + 投递水位） }
```

### 3.3 工具面与流程（后置，第一期不做）

- 第一期**不注册任何 MUD 工具与流程**：`mud_send`/`mud_state`/禁发表/`mud_flow` 全部后置（§5）——agent 对 MUD 的全部行为就是"接消息、给回答"；
- 后期工具落地时的约束（现在定死，防止返工）：受**接入闸门**约束（未接入 ⇒ 可读拒绝）；未连接 ⇒ 可读拒绝；连接与接入都是手工动词，模型不能自己拉起连接烧凭据、也不能绕过闸门读流。

### 3.4 MUD 信息进入 agent（第一期目标：等同人工提问）

**通路 = 会话消息投递**（与人工提问同一通道）：

```
MUD 行流 → 聚合（静默窗口，Config）→ 一条用户消息投递进该账号的会话
        → 宿主原生回合机制（followup 排队 / steer 步边界插话——与 session/prompt 同路）
        → agent 开回合，产生回答（回答落会话，页面可见）
```

- **等同人工提问**：MUD 信息以**用户消息**身份进入会话并触发回合，agent 像被提问一样回答。原「LLM 调用监听钩子注入」方案只能改已有调用的上下文、不产生回答，与此目标不符——弃用为注入通路；其拦截角色也不再需要（第一期唯一通路就是投递通道，闸门在源头）；
- **聚合是必需品不是优化**：行流逐行投递 = 每行一个回合一次模型调用；缺省按**静默窗口**聚合（行流静默 N ms 打包一条投递，N 为 Config），必要时加上限防超长消息；
- **与人工提问共存**：投递走宿主 followup 队列，人工消息与 MUD 消息同队列自然排队（会话内串行是宿主保证）；
- **回答的去向**：第一期回答只落会话（页面可见、日志可查）——**不回流 MUD**（发命令是后期工具面的事，§5）；
- **按会话隔离**：每个 runtime 只向自己的会话投递（两会话互不串线）。

**接入闸门**（唯一许可，作用在投递通道上）：

- **接入 admit**（显式动作，roster `accounts.admitted` 持久，缺省未接入）→ 投递通道开；**水位 = 接入时刻**，不回放积压（接入前的行流不投，要看近况后期用工具裸读）；
- **停止接入 stop** → **MUD 信息不再进入 agent**：投递停（在途回合自然跑完，后续零投递）；行流照常积累 = 录制；已投递的历史留在会话里不动；
- **未接入 = 零进入**：第一期无 MUD 工具（§3.3 后置），“不读”天然成立——闸门唯一看住的就是投递通道；
- **人工提问不受闸门影响**：人工在会话里发消息是宿主原生回合，不拦（未接入时 agent 诚实答"我未接入 MUD"）；
- **后续任何新通路一律受本闸门约束**（现在定死，防止机制生长时语义漂移）：后期工具面落地，未接入 ⇒ 工具可读拒绝；唤醒类机制落地，必须以"已接入"为前置——闸门定义在通路集合上，不在单一机制上；
- 与 connect **正交**：connect 管 MUD 源（socket），接入管 MUD→agent 的信息流。"连接 + 未接入" = 录制/挂机模式（连着收流、角色在线、agent 零 MUD 行为）——语料采集、登录调试、离开时省 token 的形态；嫌两步麻烦可在管理面做组合按钮，底层动词仍是两个。

### 3.5 管理面（`packages/mud-webui`）

- **服务器/账号呈现沿用 v1 既有实现，不改**（v1 `MudServer { name, host, port, cwd, users }`：服务器即工作区 + 字段、账号挂服务器下）；
- 新增/改接：账号表单加 preset 选择与接入开关；手工 connect/disconnect；连接状态查看；
- 后端换接：roster 从 localStorage 换到宿主 storage 域、remote 从 v1 `ctx.remote.mud.*` 换到 core3 动词——**呈现不变、接线替换**。

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

### 4.1 切片

| 切片 | 内容 | 验收 |
|---|---|---|
| **C1 骨架** | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例绿 | `tsc` + 用例绿（移植自 mud-core2 link/，先红后绿） |
| **C2 多会话** | roster storage + 会话装配（roster 判定 → registry）+ 手工 connect/disconnect + 生命周期（disposed 断连拆 runtime） | 两会话隔离；手工动词生效；disposed 断连拆 runtime |
| **C3 投递与接入** | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行（最小 persona）+ 聚合投递（followup/steer 用户消息）+ admit/stop + 水位 | **端到端**：接入 → MUD 消息进会话 → agent 回答；停止后零投递；水位断言；零工具断言；preset 任选均有 MUD 源 |
| **C4 管理面** | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工 connect/disconnect、状态 | 全流程 UI 可操作 |

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
| 其他 core2 机制（T2 闭环、唤醒、预算、计数、预案） | 按需求例证逐条引入；唤醒落地时**必须**以"已接入"为前置（§3.4 闸门覆盖新通路） |

> AI生成
