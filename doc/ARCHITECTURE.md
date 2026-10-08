---
sections: [0]
status: active
note: 入口文件：只承载文档规则与导航，不承载设计事实
---

# dsh-mud-agent 设计事实源（入口）· mud-core3（分层架构版）

> **状态：v0.2.0 设计基线（分层重排）**。本文只含 §0 规则与导航，**不承载设计事实**。
> 实施进度看 [CHANGELOG.md](CHANGELOG.md)（只追加）；当前待办与切片状态看 [PLAN.md](PLAN.md)。**本页不维护状态摘要**。
> 检索一律用稳定编号 `§N`：章节号**永不复用、永不跳号**；文件路径可变，`§N` 不变。
> 历史设计归档：[doc/archive/](archive/README.md)（v1 = mud-core、v2 = mud-core2）——**只用于追溯，不作实现或验收依据**。

## §0 文档与版本规则

### 0.1 版本号语义

`vX.Y[.Z]`：**X** = 核心/底层架构重构（分层、数据流、所有权模型改变）；**Y/Z** = 功能改进、缺陷修复、参数调整。里程碑在 [CHANGELOG.md](CHANGELOG.md) 登记（**只追加，不回改历史行**）。

### 0.2 阅读与检索规则

1. **本文件是入口不是全文**：回答设计问题先按 §0.3 章节地图定位文件与 §号，再读**入口 + 1–2 个子文件**；**不要凭本页回答细节**。
2. **任何任务先读 [`architecture/01-02-overview-host.md`](architecture/01-02-overview-host.md)**（§1 分层模型与领域模型 / §2 宿主平台事实与约束）。
3. **引用设计一律写稳定编号 `§N`**（如 `§8.3`），不写裸文件名。跨章引用写 `§N`，不写"上面那节"。
4. **同一事实只写一处**：条款只在其归属章节成文，其他章节写指针；两处冲突以被引用方为准。
5. 章节文件带 YAML front-matter（`sections` / `status` / `note`）：`status: active` 可作依据，`status: archived` 只用于追溯。
6. **代码注释引用设计写 `§N`**，格式 `§N` 或 `§N.M`；不写文件路径。
7. **禁止全量加载 `doc/`**：按任务取文件；`doc/archive/**` 默认不读。

### 0.3 章节地图

| §N | 文件 | 内容 |
|---|---|---|
| §0 | 本文件 | 文档与版本规则、章节地图、任务索引、编号沿革 |
| §1–§2 | [architecture/01-02-overview-host.md](architecture/01-02-overview-host.md) | **系统总览与总体架构**（定位与上下文、目标与非目标、设计原则与现役不变量、核心领域模型、**分层模型 L1–L7 + L0 宿主**、包与模块地图、状态载体与单一真相、端到端数据流、术语表）· **L0 宿主平台与集成**（宿主事实、加载与模块解析、依赖面、能力缺口、整批复核） |
| §3–§5 | [architecture/03-05-runtime.md](architecture/03-05-runtime.md) | **L1 接入层**（连接管理、telnet/GMCP、行化与 `MudLine`、语料）· **L2 行流层**（`SessionRuntime`、环形录制、**双水位线 `seen`**、事件分发、断线复位）· **L3 消费层**（`ReadMachine`、`GameScreen`、`Deliverer`、消费者水位契约） |
| §6–§7 | [architecture/06-07-channels-agent.md](architecture/06-07-channels-agent.md) | **L4 通路层**（三条通道：MUD→agent 投递 / MUD→人 显示 / agent→MUD 发送；**接入闸门**；正交性表）· **L5 agent 层**（preset 装配与 persona、回合节拍、会话接线、**任务书面 kickoff**、**静默唤醒 Wake**、**分工模型**） |
| §8 | [architecture/08-execution.md](architecture/08-execution.md) | **L6 执行层（单章，不拆）**：工具面（注册承载、四工具含 mud_walk、拒绝序、归属上溯、行流持有者、参数）+ 流程面（`mud-workflow` 包、声明式流程本体与词汇表、注册表与进化闭环、凭据红线、解释器、五工具、`workflowIoFor` 缝、login 实体） |
| §9 | [architecture/09-webui.md](architecture/09-webui.md) | **L7 呈现层**（`mud-webui`：呈现不改与接线替换、服务器/账号管理面、MUD 日志 tab、游戏画面 tab、状态推送、凭据接线与客户端缓存） |
| §10–§11 | [architecture/10-11-state-lifecycle.md](architecture/10-11-state-lifecycle.md) | **状态面**（两轴 `conn`/`loggedIn`、GMCP 权威信号、World 分区与置信度、断线整体复位、状态出口）· **生命周期与状态机**（服务器、账号、连接、会话与 agent、流程实例、凭据；全系统迁移总图） |
| §12–§14 | [architecture/12-14-security-observability-resilience.md](architecture/12-14-security-observability-resilience.md) | **安全设计**（威胁模型、凭据零泄露三道闸、禁发表、归属与越权、闸门、回流唯一通道、不拦项）· **观测与诊断**（`SessionLog`、诊断动词、降级告警点、语料回放）· **错误处理与降级**（可读拒绝 vs throw、失败不丢行、宿主缺面降级、结构化失败、已知限制） |
| §15 | [architecture/15-contracts-config.md](architecture/15-contracts-config.md) | **契约与配置汇总（索引章）**：`remote.mud.*` 动词表、`mudCore3` 服务窄面、preset 行清单、流程词汇表与保存门、**Config 总表**、宿主依赖面索引 |
| §16–§17 | [architecture/16-17-acceptance-roadmap.md](architecture/16-17-acceptance-roadmap.md) | **测试与验收**（测试策略与纪律、用例账目、验收断言表、实机验收清单、切片表与完成定义）· **演进路线与后置**（已交付索引、当前待办、后置清单、已定稿未立项、生长纪律） |
| 从属 | [flows/login.md](flows/login.md)·[flows/fullme.md](flows/fullme.md) | login / fullme 流程实体声明（locked；login = §8.15 从属，fullme = §8.17 从属） |
| 附录 | [appendices/A-capture-facts.md](appendices/A-capture-facts.md)·[appendices/B-audit-checklist.md](appendices/B-audit-checklist.md) | A 抓包与语料事实（MUD 侧实录）· B 代码审计规约（可执行检查表） |
| 候选 | [likely/](likely/) | 设计已定稿但**是否执行未定**的候选区（C5.2 已于 2026-10-03 立项执行完毕，见 §17.4；当前暂无在案候选） |
| 归档 | [archive/README.md](archive/README.md) | v1（mud-core）/ v2（mud-core2）归档索引；**只读、不作依据** |
| — | [CHANGELOG.md](CHANGELOG.md) | 变更记录（只追加） |
| — | [PLAN.md](PLAN.md) | 计划起草区 + 待办池（起草成型→实施→同步正式章节→清空；不承载已落地事实） |

### 0.4 任务索引

| 任务 | 必读 |
|---|---|
| 心智模型 / 分层 / 模块地图 / 术语 | §1 |
| 宿主事实与约束 / 插件加载 / 依赖面 / 能力缺口 | §2 |
| 连接、telnet/GMCP、行流、语料 | §3 |
| 连接状态机 / 探活 / 自动重连 | §3.2 + §10.4 + §11.3 |
| 录制缓冲、水位线、行流事件、断线复位 | §4 |
| 工具读应答 / 裸读 / 画面 / 聚合投递 | §5 |
| 通道与闸门（接入 admit / 停止 / 未接入语义） | §6 |
| preset 与 persona、回合节拍、自主行为（任务书 / 唤醒 / 分工） | §7 |
| 工具（`mud_send`/`mud_state`/`mud_connect`/`mud_walk`）、拒绝序、归属上溯、持有者、禁发表 | §8 |
| 导航（walk 判据与结果分类 / 位置感知 `location.*` / 行走知识图与 `mudNav` 服务 / 阻断档案） | §8.6–§8.7 + §10.3 + §15.2 + [appendices/A-capture-facts.md](appendices/A-capture-facts.md)（A.9） |
| 流程（声明表 / 词汇表 / 注册表 / 解释器 / 七工具 / login / fullme） | §8 + [flows/login.md](flows/login.md) + [flows/fullme.md](flows/fullme.md) |
| 管理面（名册 UI / 日志 tab / 画面 tab / 状态推送） | §9 |
| 状态（两轴 / GMCP / World / 复位 / 状态出口） | §10 |
| 生命周期（建服务器 / 建账号 / 连接 / 会话销毁/卸载 / 流程实例 / 凭据） | §11 |
| 冷启动旧上下文干扰 / 进程级上下文收口（表面遮蔽） | §11.2 + §2.1（事实 14–16） |
| 安全（凭据 / 禁发表 / 越权 / 闸门） | §12 |
| 观测与诊断 / 降级告警 | §13 |
| 错误与降级 / 已知限制 | §14 |
| Config 与对外契约（remote / 服务窄面 / preset 行） | §15 |
| 测试 / 验收 / 切片 / 完成定义 | §16 |
| 待办 / 后置 / 生长纪律 | §17 + [PLAN.md](PLAN.md) |
| 追溯历史决策 | [archive/](archive/README.md)（不作依据） |

### 0.5 归档纪律

1. **归档只读**：`doc/archive/**` 全部标 archived，**不得**据此实现或验收。
2. **现役材料必须提升**：被现役引用且仍然有效的材料（流程声明、抓包事实、方法规约）从归档中**提升**进现役文档树，并在 [archive/README.md](archive/README.md) 登记；不允许"现役章节引用归档文件"的破链。
3. **不留残页**：设计变更只改对应章节文件 + 登记 CHANGELOG；被否决的设计**整体**移入 `doc/archive/<版本>/`，不留在现役目录。
4. **CHANGELOG 历史行不回改**：搬移/重命名的映射登记在**新条目**里。
5. 归档内文件的相对链接与 front-matter **不逐条修补**（保留留档原貌），由归档索引统一说明。

### 0.6 编号沿革与映射（旧 core3 §1–§5 → 现役 §1–§17）

2026-10 分层重排：旧 §1–§5 全部退役，现役编号重新分配。**旧编号不得再出现在新写内容或新注释里**；改动遗留注释按本表改指。

| 旧编号 | 现役编号 | | 旧编号 | 现役编号 |
|---|---|---|---|---|
| §1.1 实体模型 | §1.4 | | §3.2 查找面 | §4.1、§8.5 |
| §1.2 宿主事实 | §2.1 | | §3.3 工具面 | §8（水位线 → §4.3、§6.2） |
| §1.3 归属 | §1.4、§8.5 | | §3.4 投递与闸门 | §6.2、§6.3 |
| §2.1 服务器 | §11.1 | | §3.5 管理面 | §9 |
| §2.2 账号 | §11.2 | | §3.6 状态面 | §10 |
| §2.3 连接生命周期 | §3.2、§11.3 | | §3.7 流程面 | §8 |
| §2.4 凭据 | §11.6、§12.2 | | §3.8 自主行为 | §7.4–§7.6 |
| §3.1 装配面 | §15.1、§7.3、§11.2、§13.1、§2.2 | | §4 验收 | §16.3 |
| §4.1 切片 | §16.5、§17.1 | | §4.2 完成定义 | §16.5 |
| §5 后置 | §17.3–§17.5 | | §16 / §19（v1 残留错号） | §13.4 / §7.5 |

### 0.7 宿主引用整批复核

指向宿主仓（`deepseek-harness`）的**文件/行号**、preset 与 patch 机制、API 形态，随宿主换代**整批**重新核对——一次换代做一次全量复核，**不逐处信任旧行号**（现役锚点见 §2.1、§2.5）。

### 0.8 当前状态指针

- **进度与待办**：一律以 [PLAN.md](PLAN.md) 为准（切片交付状态表 + 实机验收清单 + 待办）。
- **里程碑与变更**：一律以 [CHANGELOG.md](CHANGELOG.md) 为准（只追加）。
- 本页与各章节文件**都不维护状态摘要**。

> AI生成
