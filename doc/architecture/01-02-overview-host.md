---
sections: [1, 2]
status: active
deps: []
note: 全局视图 + 宿主底座；任何任务必读本文（§1 分层模型与领域模型 / §2 宿主事实与约束）
---

# §1 系统总览与总体架构

## 1.1 系统定位与上下文

`dsh-mud-agent` 是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的**仓库外 MUD 插件 workspace**（目标 MUD：pkuxkx，`mud.pkuxkx.net`），独立构建、独立从 npm registry 安装依赖，不参与 harness 根 workspace 构建链。

| 角色 | 说明 |
|---|---|
| **人** | 浏览器里的使用者。全程只面对「**服务器 → 账号**」两级实体，不感知会话/连接/流程 |
| **宿主**（deepseek-harness） | 提供工作区、会话与 agent 回合、preset、凭据、存储域、工具、模型、remote RPC、子 agent（一次性委派）（§2） |
| **插件**（本仓） | `mud-core3` 引擎 + `mud-workflow` 流程包 + `mud-webui` 壳；把一条 MUD 连接接进 agent 的回合与工具面 |
| **MUD 服务器** | 提供游戏世界：telnet 行流、GA/EOR 边界、GMCP 状态包 |

一句话：**把 MUD 行流以"等同人工提问"的方式送进 agent 的会话，把 agent 的回答以工具调用的方式送回 MUD**，并让这件事在多账号、可接入/停止、可诊断、凭据不泄露的前提下成立。

## 1.2 目标与非目标

**目标（按三期交付，第四期后置）**

| 期 | 目标 | 状态 |
|---|---|---|
| 一期 | **MUD 信息进入 agent（等同人工提问）并得到 agent 回答** | 已交付 |
| 二期 | 工具面（`mud_send`/`mud_state` + 水位线 pull 投递）+ 画面与状态推送 | 已交付 |
| 三期 | 状态面（两轴 + World）+ 流程面（`mud-workflow`）+ 自主行为（任务书 / 静默唤醒 / 分工模型） | 已交付（persona 实机验收待做） |
| 四期 | 自动重连（前置 = 真实心跳） | 后置 |

**非目标与纪律**

- **只实现被需求直接证实的机制**：v2 的五层心智、T2 闭环、子 agent 预算、计数账目、规则层、意识层全部**后置不设计**（§17.3）——它们不是错的，只是本版不需要先存在。
- 不做通用编码能力面（fs / shell / web / todo / plan-mode 不进 MUD preset）。
- 不做跨账号共享：连接、世界状态、凭据、日志一律按会话隔离（§4.5、§12.4）。
- 不做账号自动注册、不做动态权限档位。

## 1.3 设计原则与现役不变量

**设计原则**

1. **机制按需生长**：无例证不引机制；后置项按"触发例证"引入（§17.3）。
2. **同一事实只写一处**：条款归属唯一章节，别处写指针（§0.2 规则 4）。
3. **可读优先**：面向模型/用户的失败一律**可读文本**，不 throw（§8.4、§14.1）。
4. **宿主缺面即降级并点名**：存储域、typert、凭据域不可用时降级运行并 `warn` 点名（§14.3）。
5. **决策归 agent、序列归脚本**：脚本只做序列与判据，不做决策、不自行重试（§7.6）。

**现役不变量**（违反时括号内是历史真实症状）

| # | 不变量 | 症状 |
|---|---|---|
| **P1** | **归属权威 = 宿主持久化 session lineage**（`session.header.parentSession`），插件不自建归属状态；上溯遇到的祖先**必须 live** | 自建归属表与宿主谱系分叉；陈旧状态解析成功 |
| **P2** | **单一真相 = `pendingLines`**：投递器不自持缓冲，投递 = 从水位线之后拉取 | 两处缓冲各自记账 → 丢行/重投 |
| **P3** | **行数据只进 agent 一次**：`seen = max(deliveredAbs, readAbs)`；任何把行交给 agent 的路径都推进水位，本地处理路径不推进 | 同一段文本被投递与工具读各投一次 |
| **P4** | **断线是硬收尾**：立即销毁 socket + 同步 flush 残留行；`conn`/`loggedIn`/`World` **整体复位**；**不自动重连** | 半开连接迟到 close 污染新连接；世界状态残留旧值 |
| **P5** | **MUD→agent 的进入面只有投递通道**，一切新通路**必须**以"已接入"为前置（闸门定义在**通路集合**上，不在单一机制上） | 新机制绕过闸门 → 语义漂移、token 失控 |
| **P6** | **凭据零泄露三道闸**：发送侧不触发 onSend / 注入侧不经模型 / 出口侧统一掩码 | 密码进日志、回显、上下文或公屏 |
| **P7** | **失败不丢行**：投递失败只推进到成功投出的批次，失败批次停留 `pendingLines` 下次自然重试 | "注释说等 agent 回来，实际已丢" |
| **P8** | **工具面一切拒绝都是可读拒绝**（`{ok:false,error}`），不 throw | 模型侧看到不可读异常 |
| **P9** | **连接与登录分离**：`connect` 只建连（幂等、不踢已登录会话）；登录是一条 **locked 流程**（§8.14） | 盲发登录序列与工具面抢行流 |
| **P10** | **状态出口面向全体 agent**（含子 agent）：状态不能只存在某个执行体脑子里（§10.5） | 子 agent 是消耗品，状态随之消失 |

## 1.4 核心领域模型

```
服务器 = 工作区 + 服务器字段
  —— 页面上「服务器」的逻辑就是宿主的 Workspace：建工作区流程 + host/port 字段
  —— 宿主 Workspace 仅 { id, path, title }，无自定义字段 ⇒ host/port 存本包 roster（键 = workspaceId）
账号 Account { id, name, passRef, preset, admitted }   ← 使用者操作的实体，只能建在服务器下
  ↦ 1:1 绑定 会话 Session（建账号时自动创建并绑定：id = accountId，cwd = 工作区 path，agentPreset = preset）
每个会话独立持有一条 MUD 连接（输入源）——随会话生命周期产生/消亡
```

- 使用者全程只面对「服务器 → 账号」；**会话是建账号动作的自动产物与宿主承载，不作为管理面概念出现**（不提供独立的建/删会话入口）。
- **归属 = roster 判定**：会话 id ∈ `accounts`（`sessionId = accountId`）⇒ 是我们的会话；不在 roster 的会话与我们无关（解析不到 ⇒ 零行为）。
- **preset 不作归属门**：账号可选任意 preset（含宿主 `standard`），绑定关系在 roster 不在 preset。preset 只是账号属性，决定 agent 人格与能力面（§7.1）。
- **归属上溯**：子 agent / 流程调用沿 `session.header.parentSession` 上溯查 roster，命中账号会话即用其 runtime（权威与护栏见 §8.5）。

| 需求 | 宿主承载 | 自建 |
|---|---|---|
| 服务器 = 工作区 + 字段 | `Workspace` 原生实体（`session.header.cwd` 持久身份，建会话时 `mkdir`）；页面呈现沿用 `mud-webui` 既有实现 | host/port 字段（roster，键 = workspaceId） |
| 账号 ↔ 会话 | `session/create` 显式 `sessionId`；**建账号时自动创建绑定**，使用者不感知 | 账号记录（roster） |
| 建账号选 preset | 原生 preset registry（`agentPresets.list/select`；建会话传 `agentPreset`） | 本包 preset 行（`mud-player`） |
| 凭据 | 宿主 `credentials`（`set`/`resolve`，页面写入、引擎实时解析） | 无 |
| 每会话独立 MUD 输入源 | 无（宿主不管 MUD） | `link/` 移植（telnet / 行流 / 连接管理） |

## 1.5 分层模型

```
 人（浏览器）── L7 呈现层 mud-webui（名册管理 / 日志 tab / 画面 tab / 状态推送）
                      ▲ remote.mud.*                │
 ═════════════════════╪══════════════════════════════╪════════════════════════════
  L0 宿主平台 deepseek-harness（底座，§2）
  Workspace · Session/Agent loop · preset registry · credentials · storage domain
  tools · llm · typert RPC · subagent（一次性 run）
 ═══════════╤═══════════════════════════════════════╤════════════════════════════
            │ 插件装配（apply / provide / on）       │ 回合 · 工具调用
   ┌────────┴───────────────────────────────────────▼──────────────────────────┐
   │                            mud-core3 引擎                                  │
   │  L1 接入层          L2 行流层                L3 消费层                     │
   │  telnet / GMCP  →   pendingLines 环形   →    ReadMachine（工具·流程读）    │
   │  行化 / MudLine     abs + 双水位线            GameScreen（画面无头屏）      │
   │  连接管理 / 语料     seen = max(d, r)          Deliverer（聚合投递）        │
   │                                        ↓                                  │
   │  L4 通路层：投递通道（受接入闸门）/ 显示通道（不受闸门）/ 发送通道          │
   │                                        ↓                                  │
   │  L5 agent 层：preset 装配 · 回合节拍 · 自主行为（根 / 子 / 委派结果）      │
   │  L6 执行层：工具面（mud_send / mud_state / mud_connect）                   │
   │             流程面（mud-workflow：声明表 / 注册表 / 解释器 / 五工具）      │
   └───────────────────────────────────────────────────────────────────────────┘
   MUD 服务器（pkuxkx）◀── telnet ── L1
   横切面：状态面(§10) · 生命周期(§11) · 安全(§12) · 观测(§13) · 错误降级(§14) · 契约与 Config(§15)
```

| 层 | 章节 | 职责 | 输入 | 输出 |
|---|---|---|---|---|
| **L1 接入层** | §3 | 把 MUD 字节变成"行 + 边界事件"；连接生命周期 | TCP 字节 | `MudLine{text, abs}`、GA/EOR/断线事件 |
| **L2 行流层** | §4 | 每会话唯一行流真相：录制 + 水位线 + 事件分发 | 行与边界事件 | `pendingLines` 快照/切片、`seen` 水位、`onActivity` 等钩子 |
| **L3 消费层** | §5 | 行流的四个消费者（读应答 / 画面 / 投递 / 状态） | `pendingLines` | 工具结果、画面帧、用户消息、World 写入 |
| **L4 通路层** | §6 | 三条通道的定义、正交性与准入 | 上行事件、下行命令 | 进入 agent 的消息 / 进入画面的帧 / 发往 MUD 的命令 |
| **L5 agent 层** | §7 | 把通道接到宿主回合与自主行为上 | 通道事件、宿主事件 | 回合、任务书、唤醒、分工 |
| **L6 执行层** | §8 | agent 的能动面：工具调用与声明式流程 | 工具调用 | 命令、应答原文、流程出口 |
| **L7 呈现层** | §9 | MUD→人的显示面与管理面 | remote 动词、流动词 | 页面 UI |
| **L0 宿主平台** | §2 | 底座与约束（不属本仓实现） | — | workspace / session / agent / 存储 / 凭据 / RPC |

> 本版分层是**数据流分层**，与 v1 归档里的 L1–L4（感知 / 投递节拍 / 选路 / 流程驱动器）**没有任何对应关系**；引用归档一律写 "v1 §N"。

## 1.6 包与模块地图

| 包 | 目录 | 角色 |
|---|---|---|
| `mud-core3` | `packages/mud-core3/` | **宿主引擎插件**：`remote.mud.*` 动词、名册、连接与行流、投递与工具面、状态面、唤醒；`ctx.provide('mudCore3')` 服务窄面 |
| `mud-workflow` | `packages/mud-workflow/` | **纯流程架构包**（三层：契约 `./contract` / 内核 `./core` / 适配 `host/*`，前两层零宿主 import，§8.8）；`ctx.provide` 出 `mudWorkflow` 注册表面 |
| `mud-webui` | `packages/mud-webui/` | **Web 壳**（浏览器侧插件）：名册管理、MUD 日志 tab、只读画面 tab、状态订阅 |
| `typert-protocol` | `packages/typert-protocol/` | remote 工件（`gen:typert`）的协议镜像，与宿主检出对齐 |
| `mud-core`（v1） | `packages/mud-core/` | **已退役**（2026-09-27）：代码留存不删、不再演进 |
| `mud-core2`（v2） | `packages/mud-core2/` | **已退役**（2026-09-28）：原位保留、不再演进 |

`mud-core3/src` 模块 → 章节映射：

| 模块 | 职责 | 章节 |
|---|---|---|
| `link/telnet.ts` | telnet 协商 / GMCP 子协商 | §3.3 |
| `link/line.ts` | ANSI 解析 / 行化 / `MudLine` / `abs` / flush | §3.4 |
| `link/mud.ts` | 连接管理（连接代次、硬收尾、分发） | §3.2 |
| `link/corpus.ts` | 行流语料 JSONL 落盘 | §3.5 |
| `runtime.ts` | `SessionRuntime`：录制、水位线、读、发送、状态 | §4、§10 |
| `read.ts` | `ReadMachine`：判定序与收束 | §5.2 |
| `screen.ts` | 无头屏与画面帧 | §5.3 |
| `deliver.ts` | `Deliverer`：聚合与水位拉取 | §5.4、§6.2 |
| `service.ts` | `MudService`：runtime 注册表与生命周期编排 | §11、§15.2 |
| `tools.ts` / `preset.ts` | 工具纯层与 preset 作用域注册 | §8.1–§8.7 |
| `flows/login.ts` | login 流程实体（locked） | §8.14 + [flows/login.md](../flows/login.md) |
| `wake.ts` | 任务书模板与静默唤醒器 | §7.4、§7.5 |
| `world.ts` | 世界状态（分区 / 置信度 / 来源） | §10.3 |
| `store.ts` / `roster.ts` / `accounts.ts` | 名册存储域、记录类型、写路径 | §11.2、§15.1 |
| `log/log-service.ts` | 会话日志（内存环 + JSONL） | §13.1 |
| `index.ts` | 宿主装配：事件接线、remote 注册、`provide`、`kickoff` | §2.3、§7.3、§15 |

## 1.7 状态载体与单一真相

| 载体 | 位置 | 承载 | 真相范围 | 存活 / 复位 |
|---|---|---|---|---|
| **roster** | 宿主 storage 域 `mud` v1（表 `servers` / `accounts`） | 服务器字段、账号（含 `admitted`） | 名册唯一真相 | 持久；域不可用降级内存并告警（重启丢名册） |
| **`pendingLines`** | `SessionRuntime` 内存环（`recordLines` 缺省 2000） | 全部到达的行（环形淘汰计 `droppedLineCount`） | **行流唯一真相**（§4.2） | 断线清空 |
| **水位线** | `SessionRuntime`（`deliveredAbs` / `readAbs`） | 行是否已交给 agent | "已见"唯一真相（`seen = max`） | 初始/断线重置 `-1`；`abs` 空间不归零（§4.3） |
| **两轴 + World** | `SessionRuntime` | `conn` / `loggedIn` / 分区状态 | 状态面唯一真相（§10） | 断线整体复位（`world.clear()`） |
| **`SessionLog`** | 内存环（缺省 2000）+ 按天 JSONL | 运行/网络/投递/闸门事件（原始行只落盘） | 诊断唯一真相（§13.1） | 随会话销毁；`removeAccount` 清本人文件 |
| **`GameScreen`** | `@xterm/headless` 无头屏 | 游戏行与 send 回显 | 画面唯一真相（§5.3） | 跨重连保留；**插件重启即清** |
| **工作流注册表** | 宿主 storage 域 `mud_workflow`（表 `workflows`） | 流程定义（locked / agent 修缮） | 流程定义唯一真相（§8.11） | 持久；域不可用降级内存 |
| **agent 句柄表** | `index.ts` 内存 `agentMap` | `sessionId → live agent` | 投递出口 | `agent/disposed` 移除 |

## 1.8 端到端数据流

**1.8.1 一条 MUD 行的一生**（详见 §3、§4、§5）

```
TCP 字节 → link/telnet（协商 / GMCP 子协商 / GA·EOR 边界）
        → link/line（ANSI 解析 → 行化 → MudLine{text, abs}，abs 单调递增）
        → SessionRuntime.pendingLines（环形入队，断线清空）+ 边界事件
        → 消费者（§5）：
             ① ReadMachine：read 在途则 acc + 判定（failOn > until > gaCount > maxLines）
             ② Deliverer：按 seen 拉取 → 静默窗口聚合 → 用户消息投递进本会话
             ③ GameScreen：写入无头屏（供画面 tab follow）
             ④ World：GMCP / 状态写入（不消费行、不推进水位）
        → 水位推进规则：投递 / 工具读 / 流程读推进；状态同步与规则动作不推进（§4.3 总表）
```

**1.8.2 一条命令的一生**（详见 §8）

```
agent 工具调用 mud_send{cmd, listen}
   → preset 作用域工具（执行期 ctx.get('mudCore3') 解析引擎窄面）
   → 归属解析 toolContextFor(agent)（roster + 父链上溯）→ 拒绝序（引擎/归属/禁发表/未连接）
   → acquireSend(holder) 取行流持有者 → runtime.send(cmd, source)（+ 画面回显，凭据不回显）
   → ReadMachine 等应答（判据驱动）→ 结果原文返回模型 → releaseSend
```

**1.8.3 一次登录的完整链路**（详见 §7.6、§8.8、§8.14）

```
建账号（纯登记：写名册 + 建会话，会话保持 blank）→ 接入（投状态任务书，唯一点火）
   → 任务书回合（根读状态自行规划）
   → 根委派子 agent（宿主原生 subagent，一次性前台）→ 子调 mud_workflow_run{name:'login'}
   → 归属解析 → workflowIoFor（凭据 resolve → acquireSend → io 原语）
   → 解释器逐步：wait 读窗 → failOn 出口 → action 发送 → 路由
   → 出口过 pass 掩码 → 子写现场并收尾 → 收尾文本作为工具结果回到根 → 根消化后收尾
```

## 1.9 术语表

| 术语 | 定义 |
|---|---|
| **服务器** | 页面上的一级实体 = 宿主 Workspace + roster 里的 `{host, port}` 字段（§1.4） |
| **账号** | 使用者的二级实体 `Account`；建账号**一个动作**完成"账号 + 自动会话绑定"（§11.2） |
| **会话 / Session** | 宿主实体，与账号 1:1（`sessionId = accountId`）；承载 agent 与该账号的 MUD 连接 |
| **runtime / `SessionRuntime`** | 每会话一份的游戏侧运行时：连接、行流、水位线、状态、画面、日志（§4.1） |
| **行 / `MudLine`** | 行化后的单位 `{text, abs}`；`abs` 是**跨重连不归零**的单调行号（§3.4） |
| **行流** | 每会话单独一条的入站行序列；其唯一真相是 `pendingLines`（§4.2） |
| **水位线 / `seen`** | `max(deliveredAbs, readAbs)`；投递只投 `seen` 之后的行（§4.3） |
| **批次** | 一次投递给 agent 的文本单位（静默窗口聚合而成，受行数/字符上限拆分）（§5.4） |
| **接入 / admit** | 显式开关：MUD 信息开始进入 agent；**水位 = 接入时刻，不回放积压**（§6.3） |
| **投递** | 把 MUD 行以**用户消息**身份送进会话并触发回合（等同人工提问）（§6.2） |
| **画面通道** | MUD→人 的只读显示面（无头屏 snapshot + 增量帧），**不经闸门**（§5.3、§6.4） |
| **帧** | 画面通道的传输单位：`snapshot`（整屏）/ `output`（本批行）/ `state`（工具栏状态）（§5.3） |
| **流程 / workflow** | 声明式 JSON 步骤表 + 解释器；只做序列与判据，不做决策（§8.8） |
| **locked 流程** | 预制拒改拒删的流程；`login` 是唯一允许使用凭据动词的流程（§8.11、§8.12） |
| **脚本** | 分工模型里"点内步骤"的执行者 = 流程（§7.6） |
| **任务书 / kickoff** | 由插件投递的**状态驱动**开场消息（署名 `mud-wake`）：只给事实与目标，不写指令序列（§7.4） |
| **静默唤醒 / Wake** | 每会话一个静默计时器：行到达 re-arm，静默满 `silenceMs` 且三守卫全过 → 投任务书（§7.5） |
| **分工模型** | 根规划要点 / 子串行执行并一次性收尾 / 脚本做点内序列的三层分工（§7.6） |
| **委派结果** | 子 agent 收尾后由 `subagent` 工具返回值带回根的**收尾文本**；一次委派 = 一次工具结果，子不被续用（§7.6） |
| **凭据引用 / `passRef`** | 账号里只存**引用名**；明文只在宿主凭据域，登录流程执行时实时 `resolve`（§11.6、§12.2） |
| **归属上溯** | 从调用方会话沿 `session.header.parentSession` 上溯至账号会话，取其 runtime（§8.5） |
| **持有者 / holder** | 会话级唯一"在 send+read"的执行体标记；冲突可读拒绝，应答不劈半（§8.6） |

---

# §2 L0 宿主平台与集成

## 2.1 已核实宿主事实

> 全部为本仓实测/读源码确认的事实；行号随宿主换代会漂，按 §2.5 整批复核。核心结论：**宿主不管 MUD，一切 MUD 侧状态自建；宿主只管会话、回合、预设、凭据与存储**。

| # | 事实 | 锚点 |
|---|---|---|
| 1 | 会话 ↔ agent **严格 1:1**；多会话**并发跑回合**（会话内串行、会话间并行）；inbox 为 per-Agent 实例，**无全局串行点** | `core/agent-loop/src/agent.ts:36,159,200`；`docs/subsystems/sandbox.md:79` |
| 2 | 建会话**可指定 `sessionId`**、**可传 `agentPreset`**；无"客户端断开即回收"策略 | `api/session-controller/src/commands.ts:126,143`、`types.ts:289,295,442` |
| 3 | preset 定义可 patch 增（`agent-preset-registry.register`）；`default` 是宿主配置（当前 `standard`）；会话记录可读（`composedPreset` 投影） | host `cordis.patch.yml:558-561` |
| 4 | **没有"每账号环境"**：preset 一棵树共享、工具定义共享 ⇒ **数据必须调用期按会话解析** | `agent-preset-registry/src/mount.ts:26-29` |
| 5 | 有宿主 storage 域可挂（`ctx.storage` hub，JSON/SQLite 可换）；**域 provide 发生在异步装配之后** | `packages/storage/storage/src/index.ts:41-79` |
| 6 | 有官方凭据存储：页面 `credentials.set/unset`，插件侧 `ctx.get('credentials').resolve(ref)` 实时解析 | `api/settings-controller/src/credentials.ts:60-105` |
| 7 | `Workspace` 实体仅 `{id, path, title}`（+ `sessionIds`），**无自定义字段** ⇒ 服务器字段存本包 roster | `workspace/workspace/src/types.ts:63-111` |
| 8 | **会话 header 原生携带谱系字段**：`parentSession` / `delegationDepth` / `origin` 随 meta 持久进 header ⇒ 归属上溯不必自算 | `core/session/tests/session.spec.ts:1450` |
| 9 | `agent id ≡ session id`；官方 live 注册表 `ctx.agents.get(id)` 可按 id 查 live agent 并读其 `session.header` | `agent-preset-registry`、`AgentRegistry`（窄结构代位见 §15.2） |
| 10 | 宿主**不给 `ask_user_question` 超时**（定义未声明 `timeoutMs`，超时策略只在声明了预算时武装）⇒ 无人应答**永久挂起** | `interaction/tool-ask-user/src/index.ts:19-99`；`guard/timeout-policy/src/index.ts:57-59` |
| 11 | 会话列表投影中 `blank` **只由 `turn/start` 翻转**，blank 会话不渲染会话头/会话体（含自建 view） | `api/session-controller/src/list.ts` |
| 12 | 会话记录可指定 preset 且**中途不可切换**（已开过回合 → `agent-preset/locked`）；角色跨冷启持久 | `agent-preset-registry/src/index.ts:317-333` |
| 13 | **subagent 有两条创建路径**：一次性 run（`start()`，产出经 `SubagentRun.result` 由调用方收集）与可继续子会话（`startContinuable()`，结算通知投递给父会话）；工具行 `backgroundMode` 选路（缺省 `one-shot`），父会话 `subagentCatalog` 记录**两种模式**的目录条目 | `subagent/tool-subagent/src/index.ts:111,303,322,526-567`；`subagent/subagent/README.md` |

## 2.2 加载与模块解析

- 插件包位于宿主 profile 之外时，dsh 的 **peer 拦截**只在 importer 处于 `$DSH_HOME/profiles/**` 或某个 **linked root**（`<profile>/node_modules` 下指向插件真实目录的链接）之下才参与。
- 因此本包必须在活动 profile 的 `node_modules` 里有一条指向本包真实目录的链接（junction/symlink）：`peerDependencies` 里的 dsh 包才会解析到**运行中的安装**（与宿主共用一份实例）；`devDependencies` 那份只服务 `tsc` 与单测。
- `dsh plugin add` 就是"建立该链接 + 登记 bundle 层"的封装；`--patch` 直挂时**不建立链接**，需手工建。
- **链接在启动时一次性读取，改动后必须重启。**
- 本仓启动链（根 `package.json`）：`gen:typert` → `build mud-core3` → `build mud-webui` → `dsh web --patch packages/mud-core3/cordis.patch.yml`。

## 2.3 宿主依赖面

| 面 | 取用 | 用途 | 缺面行为 |
|---|---|---|---|
| `credentials` | `ctx.get('credentials').resolve(passRef)` | 登录时实时解析明文 | 解析失败 = **流程执行失败**（可读报引用名）；服务缺席即抛可读错（§11.6） |
| `sessionController` | `.create({sessionId, cwd, agentPreset})` | 建账号时建会话并绑定 preset | 缺席即抛"无法建会话"，名册回滚（§11.2） |
| `storageDomain` | `.open(...)` | 名册域 `mud` / 流程域 `mud_workflow` | **可选依赖三态**：同步命中即挂 / 未命中 `ctx.inject` 等域就绪再挂 / `rosterStorage:false` 强制内存；失败降级内存 + `warn` 点名（§14.3） |
| `agents` | `ctx.get('agents').get(id)`（窄结构；**调用期**解析，不写进 `inject`） | 归属父链上溯读 `session.header.parentSession` | 服务缺席或提供方未 ACTIVE ⇒ 上溯终止 ⇒ 工具可读拒绝 |
| 事件 | `agent/created`、`agent/disposed`、`session/disposed`、`session/event`（`turn/start`/`turn/end`，global） | 会话接线、投递抑制与冲刷 | 事件缺失 ⇒ 投递退化为仅有空闲窗口语义（§7.2） |
| `tools` | preset 行内 `ctx.tools.register` | 注册 MUD 工具 | 注册完整性自检 fail-loud（§8.1） |
| `llm` | `createUserMessage(...)` | 构造投递消息（署名 `mud`/`mud-wake`） | 缺席即无法投递（构建期依赖） |
| `typert` | `typert.register(TYPERT)` | 注册 remote 工件 | 缺席只记 info，remote 不可用（§14.3） |
| preset registry | patch 行注册 `mud-player` | 装配工具 + persona | 无 |

## 2.4 宿主能力缺口与约束

| 缺口 | 后果 | 本仓处置 |
|---|---|---|
| **插件拿不到会话删除面**：`AgentHandle.dispose` 是创建者能力，`ctx.sessionController` 无 delete 动词 | 删账号后**会话本身仍在宿主内** | 删账号只清名册 + 清该账号日志，并**在本表记为宿主侧待补面**（跟踪项见 §17.2） |
| **宿主无子会话清退/归档面**：`ctx.subagents` 只发布驻留 Activation 的释放（`drainContinuableChildren` / `drainContinuableDescendants`）与列举（`listChildren` / `listDescendants`），没有删除会话或归档目录条目的动词 | 每次派发留下的子会话记录与父会话目录条目**永久**保留（只读、不可续用）；目录读取 O(累计派发数)，磁盘随子会话日志线性增长 | 记为宿主侧待补面（§17.2）；本版委派为一次性前台，**运行时不占容量**（§7.6） |
| **`blank` 只由 `turn/start` 翻** | 新建会话不渲染会话头/会话体 ⇒ 自建 view（含 MUD 日志 tab）不可见 | 建账号后投一条**真实**任务书用户消息触发回合；**不伪造 `turn/start`**（会污染回合计数与 replay）（§7.4、§11.2） |
| **`ask_user_question` 无超时** | 无人应答永久挂起 | 后置项（`askTimeoutMs`，§17.3）；本版不注册需要人工应答的机制 |
| **preset 一棵树共享** | 工具定义共享、能力面无法按会话切换 | 数据一律**调用期按会话解析**（窄面 `toolContextFor`）（§8.1、§8.5） |
| **`Workspace` 无自定义字段** | 无处存 host/port | 服务器字段存 roster（键 = workspaceId）（§1.4） |
| **会话 preset 中途不可切换** | 建账号时选定的 preset 终身有效 | 建账号时显式传 `agentPreset`；不覆盖 registry 默认（§7.1） |

## 2.5 宿主引用整批复核

1. 本章 §2.1 的锚点是**一个宿主检出版本**的快照；宿主换代后按 §0.7 **整批**重新核对，不逐处信任旧行号。
2. 复核范围：会话/preset 机制与 API 形态、`credentials`/`storage`/`agents` 服务名与签名、`agent/created` 等事件名与载荷、工具注册与权限闸门、`blank` 与 `turn/*` 语义、子 agent 委派语义（一次性 run 与可继续子会话两条路径，§2.1 事实 13）。
3. 复核输出写回 §2.1 与相关章节；不一致项记入 §17.2 待办。

> AI生成
