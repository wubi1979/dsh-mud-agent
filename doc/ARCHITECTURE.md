# dsh-mud-agent 架构与设计

> **版本：v0.4.0（W5 已落地 · 待作者验收）**
> 本文档是 `dsh-mud-agent`（`packages/mud-core` + `packages/mud-webui`）的**唯一设计事实源**。
> 历史设计文件（`REFACTOR-V7.md`、`REVIEW-V7-ISSUES.md`、`REFACTOR-V9-permissions.md`、
> `.trae/documents/mud-preset-refactor-plan.md`）已并入本文档并删除；旧编号到本章节的映射见 §14。

---

## §0 文档与版本规则

**位置**：本文件位于仓库 `doc/` 目录；其余目录不再存放设计文档（代码注释里的旧编号引用属历史遗留，逐步清理，见 §16）。

**版本号**：`vX.Y[.Z]`

| 递增位 | 触发条件 | 例子 |
|---|---|---|
| **X（大版本）** | **核心 / 底层架构重构**（数据流分层、所有权模型、协议层改变） | v0.1 → v1.0（行级化 + preset 化落地） |
| **Y、Z（小版本）** | 功能改进、缺陷修复、参数与规则调整 | v0.1 → v0.1.1 |

**章节规则**：

- 章节编号稳定，**可以留空**（写 `<!-- 待补 -->`），但不得跳号复用；
- 每个里程碑在 §15「变更记录」登记：版本、日期、变更摘要、影响的章节；
- 设计变更**只改本文档**；实现改动随代码提交并在 §15 登记。

**当前状态**：**v0.4.0 的 W5 已落地大半**（T1 = 无状态动作渲染器 + `login` 流程表 + 桥挂起/唤醒/归属 +
分支计时器 + 打断/排队接线），并且已用**官方 loop 模拟器**量清现行投递的形状（§19.6.1）。
`tests/` 全绿（30 个文件 / **327 例**，`tsc --noEmit` 干净）。
未落地：**`pendingEntry` 端到端用例**、**`hpbrief` 应答折叠进 world**（§19.7 待定）。
`fullme` 流程已落地（`config/flows.ts` 的 `FULLME_FLOW` + `mud_captcha` 工具，见 §11）。

- v0.3.5 及以前：L1 行级感知 + hit 渲染 + 单流切分 + preset 化 + 权限档位（W1–W4 已落地）。
- **v0.4.0：流程化重构** —— 流程表（step 驱动）+ 触发器 arming + 桥挂起/唤醒 + 打断；
  T1 从"有状态续步机"退化为**无状态动作渲染器**，删除命中积压 / 回合记录 / 帧归属 / 搭车队列。
  本版本是**核心重构**（数据流分层 + 状态所有权），按 §0 规则本应记 X 位；因尚未整体验收，先记 `v0.4.0`，
  验收通过后升 `v1.0`。落地切片见 §17 的 **W5**，设计正文见 §7（动作渲染）、§8（桥：挂起/唤醒）、
  §11（流程与人工环节）、§19（流程表与流程运行时）。

---

## §1 不变量

实现与测试都必须守住的十五条。违反时括号内是历史上真实发生过的症状。

| # | 不变量 | 症状 |
|---|---|---|
| **I1** | 用户 = 会话 = 运行时；**连接是会话无关的传输资源**，绑定方向单向（会话 → 连接） | 单槽位 `SID='console'`；切用户时 agent 被 dispose |
| **I2** | **agent 生命周期归官方**；插件只读解析（`ctx.agents.get`）并 `followup` 投递 | `agent "X" is already registered` → T1 全丢 |
| **I3** | **T2 是基线，T1 是唯一干预点**（`agent/request` + `prepend`，仅 lane=t1 换 provider） | 插件改写会话/全局模型、污染其他会话 |
| **I4** | **动作即契约**：规则/流程声明了动作，就必须有结局 —— **成功 / 失败 / 超时**三者之一（无"静默"）；"投递出去无人处理""命中未渲染""挂起无期限"都是缺陷，必须吵（error 日志 + diag 计数），不得静默等待或以 T2 重投兜底 | 旧 `resolveLines` 失配 → 规则静默丢失；旧帧归属猜错 → 登录静默卡死 |
| **I5** | **单流切分**：每条输入行在 session 里恰好出现一次、顺序不变 | 同一段文本被 T1/T2 消息各投一次 |
| **I6** | **一个结算点 ≤ 一条投递消息**；同一回合内多条投递按到达顺序**逐步认领**，不制造两个决策者 | T1 命令在途时 T2 又在旧状态上推理 |
| **I7** | 规则语义只由**行序列 + 多行状态机**决定，与文本块/分包/截断无关 | 同一输出因网络节奏判类不同 |
| **I8** | 部署可变项一律 Config；**禁止模块级可变单例状态**（含匹配器上下文） | 多会话互相污染多行状态 |
| **I9** | 任何丢弃 / 截断 / 失配都必须有 error 日志 + `/mud/diag` 计数 | "判类之后什么都没有" |
| **I10** | **单流程互斥**：同一会话同一时刻最多一个流程实例；流程激活期间**其它流程的入口一律不 arm**（判据不开，而不是"命中后忽略"）；期间出现的其它入口行记为 **pending entry**，当前流程结束后接续 | fullme 在 login 挂起期间启动 → 两条链争一个挂起槽 |
| **I11** | **单挂起（本版）**：一条流程同时最多一个挂起步骤 —— 即桥的单槽 `live`，不另造队列（将来需要同时挂起时再放宽，见 §18） | 第二条应答请求插进挂起槽 |
| **I12** | **挂起期闸门 + 单出口唤醒**：挂起期间任何需要应答桥的新请求**当场拒绝并留痕**；唤醒（触发器命中 / GA 结算 / 超时）与**注销本步 arming** 在**同一个同步块**内完成，且**先投递后唤醒** | 唤醒后步骤错乱；工具返回、loop 进下一步时收件箱里还没有动作 |
| **I13** | **判据统一、注册期互斥**：`GA` 与"行匹配"是同一层判据（`MatchSpec` 的一种 kind），**必须显式声明**在 `ok`/`fail` 里 —— `ok:[GA]` = GA 到达即成功，`fail:[GA]` = GA 到达即失败；**同一步骤的 `ok` 与 `fail` 判据集必须互斥（含 GA 只能出现在一边），装配期校验、违反即报错不装配**；同类内多命中按声明顺序取首并留痕 | GA 与文本判据竞速 → 分支乱；ok/fail 写重叠 → 同一行两种结论 |
| **I14** | **打断按数字档位直接比大小**（`normal = 100`，见 §19）：规则声明 `interrupts`、流程声明 `priority`，`interrupts > priority` 才可打断；不可打断时该动作**排队**（不丢不串）；`login` = `1000`（不可打断） | 家务规则打断登录；或事件动作被无声丢弃 |
| **I15** | **T1 契约检验（T2 可用）**：规则 / 流程 / 工具 / 判据里**不得出现只有 T1 能理解的引用**（如 `turnRef` 式私有句柄）；投递消息必须自洽到"**T2 拿到同一条消息也能自己决定**" | 机制退化成只服务 T1 的私有管道（"为开发流程管理器而开发"） |

---

## §2 术语表

| 术语 | 定义 |
|---|---|
| **文本块（block）** | **网络层推送粒度**：由 `telnet` 的 `parsed` 事件发出，边界为 GA / EOR、300ms 静默刷出、断线收尾。是"一次服务端吐出的东西"，≈ 一次应答帧 |
| **行（line）** | 文本块经 `AnsiStreamParser` **行化**后的单位。感知层按行推进；语义上这些行仍属于它们来源的那个文本块（多行规则因此跨块、跨窗口都连续） |
| **批次（batch）** | **投递给真实 LLM 的文本单位**（T2 路径专用）。由一个或多个文本块的行按单流切分组成，按 token 预算裁剪 |
| **规则命中（hit）** | 行级感知的命中记录：`{ ruleId, action, anchorAbs, data }`；`action` 是规则声明的确定性动作（一个工具调用） |
| **动作请求（action request）** | 投递给 T1 的消息所携带的"该做什么"：`{ tool, args }` + 来源规则 id。**与 T2 拿到的消息同形**（原文 + 动作），T2 拿到也能自行决定（I15） |
| **投递形态（原文投递 / 动作投递）** | 投递消息里**带不带原文**：**原文投递** = 触发段原文 + 动作请求（T1 规则命中 / 流程步动作，走 `segment[0..consumeTo]` 切分）；**动作投递** = 无原文可带（帧内命中 / 人工回填 / 结算驱动 / 排队出队），消息体只有动作请求。形态只决定"消息里有没有原文"，**与投递通道（`followup` / `defer`）正交**（§5、§19.6.2） |
| **消费边界（consumeTo）** | 最后一次命中的锚点行位置；决定"哪些行已由确定性规则消费" |
| **遗留段（carry）** | 消费边界之后、尚未决定的行；随下一次投递一起走（见 §5） |
| **lane** | 一次投递的所有权标记：`t1`（T1 动作渲染）/ `t2`（真实 LLM 推理）；随消息的 `source` 走。**lane 只决定"这一回合谁来做"，不是两种世界** |
| **流程表（flow table）** | 装配期注册的只读声明：每条流程 = 有序**步骤**；每步 = `驱动句 → 动作 → 结果判据`（§19） |
| **步骤（step）** | 流程的一步：`driver`（驱动句匹配）/ `action`（工具调用声明）/ `ok`·`fail`（结果判据）/ `next`（后继分支，显式含终端 `success`）/ `retry`（可选重试）/ `timeoutMs` |
| **驱动句（driver）** | 某一步的进入判据：服务端打出的提示行（如 `此ID档案已存在，请输入密码：`） |
| **arming 集** | 当前**开着**的流程判据集合：进入某步时打开"本步 ok/fail + 直接后继 driver"，命中即关闭并切换（§19） |
| **挂起（suspend）** | 命令发出后等结果的状态：实现就是**桥的一条 pending 应答**，结果三态由 arming 判据 / GA / 超时给出 |
| **唤醒（wake）** | 单出口的结算：注销本步 arming → 结算挂起 → 投递下一步动作（同一同步块，先投递后唤醒） |
| **打断（interrupt）** | 规则命中且档位高于流程时：把挂起结算为"被打断"、复位流程、可选发 `onInterrupt` 命令、投递事件动作（§19） |
| **排队（pending action / pending entry）** | 不可打断时的事件动作 / 流程期间出现的其它流程入口：排队等流程结束，立即执行（不丢不串） |
| **会话运行时** | `MudSessionRuntime`：一个 MUD 会话的全部游戏侧状态（连接绑定、感知、投递、桥、队列、world、recall、**流程实例**、定时器） |
| **预设（preset）** | 官方 agent 组合机制：`mud-player` 预设把 MUD 工具/人设/技能挂到原生 agent 上（见 §9） |

**已删除的概念**（v0.4.0，见 §16）：Hit 积压、回合记录 / `turnRef`、帧归属（`activeTurnRef`）、搭车队列、`takeTurns` 游标。

**数据流一句话**：`文本块 → 行 → 规则命中 / 流程判据命中 → 投递消息（动作请求 或 批次） → 官方 agent 回合 → 工具调用 → 桥（挂起/唤醒）`。

---

## §3 总体架构

```
入站逻辑行（telnet parsed: GA/EOR/300ms 静默/断线；游戏输出与工具应答同源）
      │                                  ← 唯一入口
      ▼
┌──────────────────────────────────────────────────────┐
│ L1 行级感知  (每会话一实例，多行状态持久)              │
│   · 静态规则：state 桶折叠 → world（不进 agent）        │
│                event 桶命中 → 动作请求                 │
│   · 流程判据：arming 集匹配 → 唤醒 / 分支 / 打断 / 排队  │
│   · 产出：动作请求[]{tool, args} + 消费边界 consumeTo   │
└──────────────────────────────────────────────────────┘
      │  行流 + 动作请求（会话私有）
      ▼
┌──────────────────────────────────────────────────────┐
│ L2 投递节拍  (每结算点一次判定；单流切分)               │
│   有动作 → T1 投递消息 = 原文 + 动作请求                │
│   无动作 → 批次 = segment（按 token 预算裁剪）           │
└──────────────────────────────────────────────────────┘
      │  agent.followup(mud-owned{lane, sessionId, 动作请求})
      ▼
┌──────────────────────────────────────────────────────┐
│ L3 选路  (官方 agent/request，prepend)                 │
│   lane=t1 → 拦截为 mud-t1；其余 → 不介入（T2 基线）     │
│   门: preset=mud-player（§9）或已绑定 MUD 会话          │
└──────────────────────────────────────────────────────┘
      ▼
┌──────────────────────────────────────────────────────┐
│ L4 动作渲染  (T1，**无状态**：不做文本反查、不查运行时)  │
│   本步认领到的动作请求 → 渲染 tool-call 块              │
│   无动作请求 → 收束（失败路径即"没有动作可投递"）       │
└──────────────────────────────────────────────────────┘
      ▼
官方工具管道（tools/pre-execute 权限闸门 → 工具执行 → 命令-应答桥）

旁路：
  B  命令-应答桥：**我们自己命令**的应答（文本块粒度）；v0.4.0 起它同时是**挂起/唤醒/打断**的落点（§8）
  F  流程运行时：arming 集 / 挂起 / 打断 / 排队 / 复位 —— **流程状态归运行时**，T1 不持有（§19）
  P  权限档位：agent 工具调用的可见性 + tools/pre-execute 强制（§10）
  A  agent 装配面：mud-player 预设挂载工具/人设/技能（§9）
```

---

## §4 L1 行级感知

**目标**：规则语义与"文本块/分包/截断"彻底解耦（I7），命中可被可靠交付（I4）。

| 项 | 设计 |
|---|---|
| 实例 | **每会话一个** `PerceptionEngine`（消灭进程级匹配器单例，I8）；`reset()` 于连接重建/切换 |
| 输入 | 行序列（来自文本块的行化结果，含工具应答行——与游戏输出同源） |
| 状态 | 多行状态机**持久**（跨文本块、跨窗口连续）；不再有"镜像克隆式判类" |
| 输出 | `feed(lines) → { hits: Hit[], consumeTo: number }`；`consumeTo` = 最后一次命中锚点在本批行内的位置 |
| state 桶 | 同一层内完成预匹配折叠 → `world`；折叠行**不参与**消费边界计算 |
| **流程判据（v0.4.0）** | 同一批行在喂给静态规则的同时，也喂给**流程运行时的 arming 集**（动态判据，来自当前步：本步 ok/fail + 直接后继 driver，§19.2）；命中即唤醒/分支/打断。**流程判据只在流程激活期存在**，不写进静态规则表（不与 trigger 重复） |
| holdDelivery | 声明 `holdDelivery` 的多行规则**捕获未完成**时，本块不投递（半截事务不给真实 LLM）。状态持久后此机制跨窗口有效；超时由 `holdTimeoutMs` 兜底释放（规则级开关，I6） |

**多行规则的写法约束（血泪）**：`multiline: true` 时 `match.patterns` 的每一条都是**有序条件**（`buildMultiConds`），而一行只能推进一个条件（`stepMulti`）—— 所以**单行提示必须写成一条正则**，写成两条就永远凑不齐（例：登录的"赶出去/取而代之"确认提问，实录为一行）。真要两条条件，第二条必须落在**后续行**。同理，单条件多行规则永远不会 `holding`（种子命中即完成，`multiStates` 为空），`holdDelivery` 对它不生效。

**删除**（原实现）：`matchDry`（生产路径）、`cacheLines`/行集表、`resolveLines`、按文本反查的"最长前缀"启发式。

<!-- 待补：PerceptionEngine 的公开接口签名与错误语义（error 计数口径） -->

---

## §5 L2 投递节拍（单流切分）

**结算点**：GA/EOR、静默窗、行数/字节上限、断线收尾。

**切分算法**（I5/I6）：

```
segment = 遗留段 ++ 本文本块的行
若 segment 中存在**动作请求**（规则命中的 action / 流程步动作）：
    投递消息体 = segment[0 .. consumeTo]        lane=t1（原文 + 动作请求）
    遗留段     = segment[consumeTo+1 ..]
否则：
    批次       = segment                        lane=t2
    遗留段     = ∅
每个结算点最多投递一条消息。
```

- **前导上下文**（动作之前的行）归 T1 投递消息体：它 precede 该动作，属该次动作的上下文。
- **投递消息携带原文**（决定：携带）：转录完整 → 后续 T2 回合的上下文不缺；**T1 只按动作请求渲染 tool-call，忽略文本**（§7），而 T2 拿到同一条消息能自行决定（I15）。
- **投递形态（作者定名 2026-09-13）**：**原文投递** = 消息体带原文（上面的 `segment[0..consumeTo]`）+ 动作请求；**动作投递** = 无原文可带，只投动作请求 —— 适用帧内命中、人工回填、结算驱动、排队出队。日志与决策栏一律用这两个名字（旧称"反射消息 / 帧内独立投递"）。
- **投递通道（与形态正交）**：`followup`（无工具在途 → 正常开新回合）vs `defer`（有工具在途 → 动作随本回合结果进下一步），判据见 §19.6.2；形态解决"带不带原文"，通道解决"什么时候进模型"。
- **批次裁剪**（唯一裁剪职责）：按 token/行/字节预算裁剪，只影响 T2 可见文本，不影响 T1。
- **遗留段有界**：≤ 128 行 / 16KB；超限丢最旧 + error 日志 + diag 计数（I9）。
- **交付水位（`deliveredAbs`）**：每次把行交付给模型（T1 投递消息 / T2 批次 / **工具应答帧** / **折叠行**（state 入库、`direct` 动作））都前移水位；`mud_recall` / `mud_state` 只回看水位**之后**的行 —— 读工具因此是"给我还没给我的输出"，不会把连接至今的全部内容再倒一遍（实测：`mud_state(lines:60)` 把欢迎横幅到当前的所有行重复塞进 session）。重连时行号（`abs`）由新解析器从 0 重起，水位与回看缓冲随之清空。

**可测不变量**：按序拼接所有投递消息体 == 完整入站行流。

<!-- 待补：裁剪预算的具体常量与配置项命名 -->

---

## §6 L3 选路

- `agent/pre-step`（agent 作用域）：记录**本回合**的 lane —— 取该回合认领消息里第一条 `mud-owned` 的 lane；同一回合的后续步（工具续步）沿用。**v0.4.0**：流程的下一步动作也是**新投递**（§19.3），所以每步都能从"本步认领到的动作消息"取到 lane=t1；某一步没有新认领消息时沿用本回合 lane（不会误换）。
- `agent/request`（agent 作用域 + **`{ prepend: true }`**）：`lane=t1` → `{provider:'mud-t1', model:'t1-local'}`；其余（`t2` / 无 lane）→ **原样返回**（T2 基线，I3）。
- **为什么必须 prepend**：官方 per-session 模型选择（`installModelSelection`，setup 期注册，早于本插件）会无条件写回会话模型；Cordis waterfall 中**先注册者最后拍板**，不抢最外层则 T1 被覆盖回真实 LLM（历史上表现为每 2s 一次 `agent/request` 而无任何 `[t1]` 输出）。
- **会话模型污染的防御（实测 bug）**：官方侧会把一次请求**实际生效**的 provider/model 记成会话的模型选择。于是首次把某回合拦成 `mud-t1` 之后，同一回合的下一步 `next()` 就已是 `mud-t1/t1-local`，**非 T1 回合也会打到本地模拟 provider**（症状：断流唤醒投出的批次被 T1 适配器按"选路异常"收束，真实 LLM 永不参与）。因此选路里维护一份"会话真实模型"记忆（最近一次非占位配置），并在**非 T1 回合收到 T1 占位时还原**它；用户手动换模型后 `next()` 给的是新模型 → 照原样放行并更新记忆，不覆盖用户选择。纯判定集中在 `resolveLaneConfig`（可单测），每次还原都留痕。
- **门控**：`preset === 'mud-player'`（§9）优先；预设机制不可用时回退为"会话已绑定 MUD"（v8 行为）。
- **禁止**：用 `sessionController.selectModel` 切 lane —— 它会 `agentDefaultModel.saveSelection` **持久改写部署级默认模型**（并每次追加持久事件 + 触发模型切换通知）。
- **相邻工具调用限速**（`Config.toolCallIntervalMs`，缺省 1000ms；0 = 关闭）：在 `tools/pre-execute` 闸门里对 **T2 通道**的 MUD 工具调用等待到间隔满足再放行（不拒绝、不丢调用）。队列的 `commandIntervalMs` 只管写 socket 的间隔，管不住模型连续发起工具调用的节奏 —— 实测 T2 决策速度远快于服务端处理（"服务器有点反应不过来"）。
  - **豁免按通道判定，不按登录态**（作者定案 2026-09-13，实现期修正）：`currentLane() === 't1'`（规则动作 / 流程步动作）**一律不等**；系统流程（登录中 / 等人工，`loginFlow()`）也不等。原实现只按 `loginFlow()` 豁免 —— **登录一完成就 false**，于是 T1 的规则动作与流程步动作（例如 fullme 的答案）会被无谓推迟 1 秒。通道读数由选路侧在 `agent/pre-step` 广播（`installOwnedLaneRouting` 的 `onLane` → 闸门的 `currentLane`）。
  - 非本插件工具不介入；等待期间响应 `exec.signal`（回合取消 → 直接拒绝本次调用）。
- **T2 投递限流**（`Config.t2DeliverIntervalMs`，缺省 **2000ms**；0 = 关闭）：**给真实模型喂输入的节奏**也压一道 —— 距上次 T2 投递不足最小间隔时，本批**不投**（行留待决，结算定时器延到差额到点）。
  - 与 `toolCallIntervalMs` 分工：后者压"每次工具调用"，这里压"**多久被喂一次**"（T2 每次行动都必须先收到一条投递），并天然把多个小批次**合并成大批次**。
  - **只压 T2 批次**：T1 原文投递、T1 动作投递（`standalone`）、控制消息（`requestAgent`）都不受它影响 —— T1 是系统流程，不能被"给模型限速"的闸压住。控制消息投出时**会**记一次时刻（避免"刚唤醒又喂一批"）。
  - 实测动机：登录后 T2 接管，1 秒一条地刷查询（look/hp/score/skills）。

---

## §7 L4 动作渲染（T1）

**契约（无状态，一句话）**：**本步认领到的消息里带着动作请求 → 渲染成对应的 tool-call 块；没有动作请求 → `finish stop`。** T1 不查运行时、不做文本反查、不持有任何跨步状态。

| 项 | 设计 |
|---|---|
| 输入 | 本步投递的 mud-owned 消息：**原文（游戏文本）+ 动作请求 `{tool, args}`**（§2 术语）。动作请求是规则/流程**声明**的，T1 只是把它渲染成模型同构的 tool-call |
| 输出 | 标准 `tool-call` 块（与真实 LLM 同构）→ 官方 `tools/pre-execute` 闸门 → 官方工具管道。**这是"用 T1 模拟 T2 行为"的落点：留下的是官方路径的痕迹** |
| 批量 | 一个文本块里多条动作 → 一次流内多个 tool-call（顺序执行）；流程步就是"列表长度为 1"的同一形状 |
| **"是否已渲染"** | **不需要游标**：判据是"本步是否认领到了动作消息"。实现用**确定性 call-id**（动作请求 → 固定 id）检查会话里是否已有该 id 的 `tool-result` 块（官方 tool-result 带 `toolCallId`）；已有 = 该动作已执行 → stop（不重复渲染） |
| 失败路径 | **T1 不负责失败处理**：运行时判定失败后**不再投递动作** → T1 无事可做 → 官方 loop 自然收束回合。因此不存在"把失败报告给 T1、由 T1 复位触发器"这一步（触发器归运行时所有） |
| 控制消息 | `[系统]` 前缀的控制消息不参与动作渲染：由 L2 以 lane=t2 投递 |
| 缺陷即吵（I4） | 动作请求引用了未注册的工具 / 无法渲染 → error 日志 + diag 计数，绝不静默收束 |

**契约检验（I15，验收标准 = T2 能不能用）**：

1. 规则 / 流程 / 工具参数 / 结果判据里**不得出现只有 T1 能解释的引用**（`turnRef` 式私有句柄一律禁止）；
2. 投递消息必须**自洽**：T2 只拿到这一条 user 消息，也能知道场上发生了什么并自行决定（动作请求是"可用信息"，不是"命令"）；
3. 工具参数要能写进工具描述让模型读懂（例：`mud_send { cmd, expect: { ok, fail, next } }` —— "ok/fail = 本命令的期望结果、next = 后续步骤"）。

**三条出口（按"谁该决定"分，取代旧的三出口表）**：

| 出口 | 声明 | 谁执行 | 行去向 |
|---|---|---|---|
| **动作渲染**（缺省） | `action`（无 `direct`） | T1 渲染 → 官方工具管道（走权限闸门） | 随投递消息进会话（含原文） |
| **人工环节** | 步骤声明 `awaitExternal`（如 `{captcha}`） | 值到位后进入该步发命令 | 行留待决，等待期不投递（§11） |
| **直接执行** | `action.direct: true` | **运行时**立即执行（actor `system`，不入桥） | **折叠**（不进 agent；`mud_recall` 也不再给） |

- **直接执行的判据**：无状态、无需返回 —— `save` 提醒 → 发 `save`；分页提示 → 发翻页命令。这类触发的"决策"在规则里已经写全，交给模型只是多一个回合、多一份原文噪声。需要模型判断的动作（登录分支、fullme 提醒与答案）**不得**标 `direct`。
- **直接执行仍受安全边界**：判据用 `permission/policy.ts` 的 `evaluateToolCall`（档位判据按 `full` 跑 —— 它是运行时的动作，不是模型的动作，故不受档位可见性约束），危险命令 `deny` 生效、`ask` 因无审批通道等同拒绝。

---

## §8 命令-应答桥（旁路 B）

**职责**：只服务"**我们自己发出**的命令 ↔ 应答帧"。与 L1/L2 的规则判定解耦（后者不依赖桥的行集表）。
**v0.4.0 起它多一个身份：流程挂起 / 唤醒 / 打断的落点**（§19）。

| 项 | 设计 |
|---|---|
| 粒度 | 文本块（帧）：GA/EOR 主边界、声明结果判据、超时（**流程结算三级**：成功 / 失败 / 超时，见下） |
| **帧内容归属** | 在途请求期间到达的行**只进本帧**：队列节流窗口（`sending`）与武装后（`armed`）的行都由控制器累积；宿主不再另存"帧首"再并回下一帧（那会让同一批行同时留在本帧与下一帧 —— 实测 `look` 的应答里混进上一次 look / MXP 检测的旧行） |
| 序列 | `cmds` 逐条独立结算（v8 已实现） |
| 生命周期 | `close()` 终止语义；重连调 `reset()`（v8 已实现）；连接实例化（不再模块级单例） |
| 发送失败 | `sendFailed` → 在途请求 settle error（v8 已实现） |
| **取消** | 工具 `exec.signal` → `ReplyOptions.signal`：回合取消时在途等待优雅结算为 `abort`（**已实现**：`MudToolCallOptions.signal` 由两条装配路径（`attachMudTools` / `preset-agent`）从官方 `ToolRunContext.signal` 转发） |
| **流程挂起 / 唤醒（v0.4.0）** | **挂起** = 该命令的一条 pending 应答（桥的单槽 `live`，I11）；**唤醒** = 单出口结算（触发器命中 / GA / 超时），结果三态、与注销 arming 同一同步块、先投递后唤醒（I12）。判据声明由工具参数携带（`expect`），触发器内容只在流程表里写一份（不与 trigger 重复） |
| **挂起期闸门（v0.4.0）** | 挂起期间任何新的 `sendAndAwait` 请求**当场拒绝 + 留痕**（`[缺陷] 流程挂起期间收到第二条应答请求`）；`direct` 类动作走 `fireAndForget` 不入桥，不受影响 |
| **打断结算（v0.4.0）** | 规则命中且档位高于流程（I14）→ 挂起应答结算为 **`interrupted`**；流程复位后投递事件动作 |
| **回合终点** | `exec.concludeTurn()` 接线：工具明确结束回合 —— **已定「不接」**（用户 2026-09-12）：T1 回合在动作请求取空时本就收束，接线只省一次续步；T2 下"哪个工具该结束回合"没有客观判据。判据留在 §18.11 |
| **活动表** | 长程命令（`dz`/`dazuo`/`sleep` …）的完成句/超时由**数据表**声明（**已实现**：`DEFAULT_ACTIVITY_TABLE` + `activityFor()`，`Config.activityTable` 整体覆盖），取代硬编码 `COMPLETION_UNTIL`。**活动表是"长命令的结果判据"的一种**：可打断的挂起（如练功）与流程步挂起走同一套机制（I14 的 `interrupts > priority`） |
| **外部占位符（`awaitExternal`）** | 动作参数可由**外部/人工**提供（`fullme {captcha}`）：命中**先挂起**、不渲染，装配方把命中存进"待人工"槽，值到位后再进入该步发命令；值在发送瞬间插值（与 `{name}`/`{pass}` 同一策略） |
| **直接执行动作（`action.direct`）** | **无状态、无需返回**的触发（`save` 提醒 / 分页提示）：命中行**折叠**（不进 agent），动作由**运行时**立即执行（actor `system`，不入桥、不等应答），不经过 T1。判据与安全边界见 §7 |
| 分页 | "一页一 step"写入规则模板，不用命令序列（原 P2-4） |

---

## §9 agent 装配面：preset 化（旁路 A）

**目标**：MUD 工具 / 人设 / 技能由**官方 agent preset** 机制挂载，而不是宿主插件在 `agent/created` 里往别人的 agent ctx 上注册。

**机制事实**（已逐行核对 deepseek-harness）：

- `SessionCreateRequest.agentPreset` **host 侧已支持**（`api/session-controller/src/types.ts`、`commands.ts`），但浏览器 client 三层（contract / service / manager）未透传 → 需补 3 处（**harness 侧改动**）。
- 重启后 resume/adopt 按**会话内存储的 preset** 重新挂载；`assertPresetUnchanged` 仅在"请求 ≠ 存储"时抛冲突。
- preset 的 `agent.cordis.yml` 里"只注册工具/section、不 provide 服务"的行**无需 isolate realm**，且可 `ctx.get` 宿主服务。
- `agentPresets.composedPreset(agent.ctx)` 可用于判断该 agent 是否 mud preset → **L3 门控的官方判据**。
- preset 行支持 `file:///` 绝对路径；`agent-presets.Config.roots` 按 id 在 profile patch 覆盖追加。

**设计**：

1. `src/preset-agent.ts`（agent 平面插件行）：从 `ctx.get('mud').agentKit()` 取工具/人设/命令/skills，
   `ctx.tools.register(...)` + `systemPrompt.section(...)`；技能目录变化用**动态文本提供者**
   （`text: () => kit.skillsText()`，v8 已采用）而非 dispose/重注册。
2. `presets/mud-player/`：`preset.yml` + `agent.cordis.yml`（单行指向 `dist/preset-agent.js`）。
3. `package.json`：`exports` 增 `./preset-agent`；`files` 增 `presets`。
4. 页面：`sessions.create({ agentPreset: 'mud-player' })`（依赖 harness client 透传）。
5. profile patch：`agent-presets` 行追加 `roots: [{path: 'file:///…/mud-core/presets', trust: user}]`。

**迁移与风险**：

- 旧 MUD 用户（会话无存储 preset）→ `ApiSessionPresetConflict`；迁移方式：**删除旧用户后重新添加**。
- preset 行用绝对路径（与现有 bundle 行同一取舍）。
- 若 harness client 透传未就绪，W1/W2 可先用 v8 的宿主侧装配（`agent/created` + `agent.ctx` 注册）并保留 L3 回退门，preset 作为 W3 的替换。

**已实现（v0.3，方案 A1：部署根 + host 侧 `select`）**：

第 4 条（页面 `sessions.create({agentPreset})`）**不需要了** —— 官方 host 侧另有 `ctx.agentPresets.select(agent, id)`（`preset/agent-presets/src/index.ts` 的 `select` → `swap`），约束只是"会话尚未开过回合"（`agent-preset/locked`）。MUD 会话正好满足：页面 `sessions.create` → `POST /mud/bind` → agent materialize 时还没有任何投递。

| 项 | 落点 |
|---|---|
| preset 行（能力面） | `src/preset-agent.ts`：无 `inject`（宿主服务一律 `ctx.get`，挂载审计友好）；组装期注册全部工具声明 + **三段提示**（skills/tier/commands） |
| 会话人设（两条路径共有，**在 agent 作用域替换官方人设槽**） | `agent-bridge.ts#attachMudPersona`：往 `deployment:persona-prefix` 写 MUD 人设、把 `deployment:persona-suffix` 置空，由宿主在 `attachPolicy` 里调用。**为什么不放 preset 行**：会话人设已有主人（部署 `personaPrefix` 与 standard 的 `persona` 行），自建区段只会并列（模型同时被告知"你是编码 agent"和"你是 MUD 玩家"），而**同名**替换在 preset 作用域会与 standard 行撞名抛错 —— 官方 `systemPrompt` 的作用域链是"最近作用域胜出"，per-agent 覆盖只能经 `agent.ctx` 注册。`tests/mud-persona.spec.ts` 用真实注册表复现 preset → agent 两级作用域并断言渲染结果里只剩 MUD 人设 |
| 组合文件 | `presets/mud-player/agent.cordis.yml`：**整份 `standard` 组装 + 我们的 `mud-agent` 行**（该行 `name: '../../dist/preset-agent.js'` —— **相对路径**，以 `.` 开头按 preset 目录解析）；`preset.yml`（展示名/描述） |
| 包出口 | `package.json`：`exports["./preset-agent"]` + `files` 增 `presets` |
| 会话侧数据源 | `ctx.mud.agentKit()`：`{ prompt, tools(sessionId), tierNote(sessionId), noteToolCall(sessionId,…) }` —— 共享组装与 per-session 状态（队列/桥/world/凭据）之间的唯一接法：工具声明共享，执行体按调用方 `agent.id` 解析 |
| 宿主装配路径 | `Config.agentPreset` 非空 = preset 路径：`attachToAgent` 只装**策略面**（选路 + 权限闸门 + 人设槽覆盖），能力面交给 preset；装配失败（服务缺失 / `agent-preset/not-found` / 会话已锁定）→ 日志留痕 + **回落宿主侧装配**（`mountHostCapability`：按档注册工具 + 提示区段） |
| 投递就绪门（关键） | `MudRuntimeSink.agentReady`：preset 模式下"agent 存在"≠"可以投递"。旧组装上跑第一批输出，既没有 MUD 工具、又让会话产出内容而**永久锁定 preset**。`settle()` 因此把"装配未就绪"与"无 live agent"同等对待（留待决，等冲刷）。就绪由**每会话标志** `capabilityReady` 判定 —— **preset 挂载成功**与**回落宿主侧装配完成**都会置位；只看 `composedPreset` 会在回落路径上永远判未就绪（实测：登录文本一直不投递，直到登录看门狗唤醒 agent）。新 agent 实例接入时先撤标志、装配落地后再置位 |
| 部署 | 两处都在本包 patch（见下方片段）：`agent-presets.roots` + `Config.agentPreset`；**profile patch 保持 `[]`** |

**preset = 整个组装（踩过的坑，务必先读）**：从 preset 组装的会话**只**运行该 `agent.cordis.yml` 列出的行 —— 宿主与其它 preset 的工具不会继承。第一版只写了我们那一行，于是被切过去的会话丢掉全部标准工具（fs/shell/web…），表现成"工具不可见，连 DSH 本身都受影响"。因此本 preset 是 `standard` 的**整份副本 + 一行增量**（harness 自带的 `cordis`/`code` preset 也是这么做的）。

**副本必须机械生成、并逐行比对**：手抄会漏掉**必填 config** —— 实测把 `standard` 的 `plan-mode` 行抄成了 `- id: plan-mode / name: …`（漏了 `config.section` 那段 2340 字符的块标量），挂载直接失败：`PlanModeConfig needs a non-empty 'section'`。生成方式：取 standard 中 `# ── identity` 起的**全部内容（含注释）** → 前置本文件头注释 → 末尾追加 `mud-agent` 行。`tests/preset-agent.spec.ts` 在 harness 检出存在时**逐行比对 standard**（缺行/改行都红），这是官方 README 明列的"副本会漂移"这一已知限制的对策；升级 harness 后按同一方式重新生成。

**部署（全部写在本包 patch，profile patch 保持 `[]`）**：patch 分层是 `组合包 → profile patch → home → --patch overlay`。

- `mud-core` 行由 `--patch` overlay（`packages/mud-core/cordis.patch.yml`）**最后**插入 —— 写进 profile patch 的 `- id: mud-core / config:` 在该层根本不存在目标行。
- `agent-presets` 行来自 web-app 组合包：两层都在它之后，但**放本包 patch 里**才能让部署自洽（用户不需要维护 profile patch）。一条 patch 会**替换目标行整份 config**，所以必填的 `default` 必须带上（`includeShippedRoot`/`includeUserRoot` 有 schema 默认值，会保留 true）。
- 若某天还要维护别的 preset root，把它们一并写进这一条 roots（否则会被覆盖）。

```yaml
# packages/mud-core/cordis.patch.yml —— 两条部署声明都在这里，profile patch 留 []
- id: agent-presets
  config:
    default: standard
    roots:
      - path: D:/Code/dsh-mud-agent/packages/mud-core/presets
        trust: system

- insert:
    - id: mud-core
      name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core/dist/index.js'
      config:
        agentPreset: mud-player     # 留空 = 宿主侧装配（回退门）
        # …其余部署值不变
```

**不要往 profile patch 里加东西（实测事故）**：本机 profile 是 `patchReload: live` —— profile patch 的改动会**热应用**到正在运行的树上。实测两次：写入 `agent-presets` 的 config 覆盖（并带上一条目标不存在的 `mud-core`）后，**所有 preset 组装出来的工具当场消失**（MUD 会话的工具、连宿主会话自己的工具都没了，表现为"影响 DSH 本身"）；把 profile patch 改回 `[]` 后**不重启即恢复**。机理：热应用替换 `agent-presets` 的配置会重建它的常驻挂载，而各会话的工具正挂在那些常驻挂载下。因此：**插件自己的部署声明写插件的 patch（启动期一层，无热应用风险）；profile patch 留空；改配置用重启而不是热改。**

**与 §10 的交互（preset 模式下可见性层退化）**：preset 作用域共享一套工具，无法再"按会话档位注册不同工具集"，因此 preset 模式下档位只剩两层 —— 强制层（`tools/pre-execute` 闸门，逐次按会话档位判定）与提示说明（`mud-tier` 区段）。需要"模型视图严格等于档位能力"的部署应把 `agentPreset` 留空，走宿主侧装配（每条会话一个 agent 实例，可精确重挂）。见 §18.9。

**官方 preset 机制的既有约束（落地时必须知道）**：只有空白会话能切 preset（首个回合后固定，**坏的组装会把该会话永久锁死** —— 只能删用户重建）；preset 行不得 provide 服务到根 realm、也不得等待组装与宿主都不提供的服务（挂载审计）；组装加载失败会在**会话创建时**回滚并指名坏行；世代以 `agent.cordis.yml` 的 stamp 为键（旁边 skill/资产改动要等组装文件变动或重启才生效），被替换的世代不回收；设置页的"默认模式"是**进程级全局默认**（影响此后创建的每个会话），不是我们按 MUD 会话开关 preset 的杠杆。

---

## §10 权限档位（原 V9 并入）

**三档**：`observe`（只读）/ `operate`（读写）/ `full`（完全）。

**被约束的 actor 是 `agent`**：

| actor | 含义 | 受档位约束 |
|---|---|---|
| `agent` | 模型回合内的 `mud_*` 工具调用（T1 与 T2 **同权**） | ✅ |
| `system` | 连接/断开/重连、**登录流程**（凭据命令） | ❌（受连接开关约束） |
| `user` | 游戏页手打命令（`/mud/command`） | ❌ |

**只读必须配零发送信息通路**：`mud_look`/`mud_status` 本身就是发命令 → 新增 `mud_state`（读 world 快照 + 最近输出，不碰 socket）。

**「完全」= 读写 + 外围能力（显式列举）**：`connection:connect|disconnect`、`wake:dead-air`（v0.4.0 起不再有 `wake:login-stall`，见 §11）、`catalog:skills|rules`、`captcha:refresh`。

**双层执法**（可见性 ≠ 强制）：

| 层 | 机制 | 作用 |
|---|---|---|
| 可见性 | 按档只注册该档工具到 agent ctx | 模型看到的 capability 正确 |
| **强制** | `agent.ctx.on('tools/pre-execute')` → `allow / deny{reason} / ask{reason}` | **唯一算数处**；T1 渲染的动作走同一管道 → 权限对 T1 同样生效 |

**状态与查询**：`mud/capability` 会话事件（log-only）+ `mudCapabilities` 投影 + `Config.defaultTier`；读取侧 `ctx.mud.capability.{current,set,names,resolve,optionOf,defaultTier}`（对齐 `permissionPresets` 形状）。**agent 永不自提权**，只能 `ask`。

**危险命令**：`FORBIDDEN_COMMANDS` 静态黑名单 → **档位策略表**（数据驱动、可配、可测）。

**已实现（v0.2）**：

| 项 | 落点 |
|---|---|
| 档位表（可见工具集 + 外围能力） | `permission/tiers.ts`：`MUD_TIER_SPECS`、`visibleTools`、`MUD_TIER_NAMES`（`observe`/`operate`/`full`），完全档外围能力 `FULL_CAPABILITIES` |
| 危险命令策略表 | `config/commands.ts`：`DEFAULT_DANGEROUS_COMMANDS`（`deny`：suicide/passwd；`ask`：abandon/steal/kill/drop/quit）+ `commandHead`/`dangerousRuleFor`/`deniedCommands`；`Config.dangerousCommands` 整体替换 |
| 纯判定（强制层唯一判据） | `permission/policy.ts`：`evaluateToolCall`（非 MUD 工具放行 → 档位可见性 → 逐条命令：登录/人工流程豁免 → 危险表 deny/ask → 只读档 deny）、`commandsOfToolCall` |
| 强制执行点 | `agent/tool-gate.ts`：`installMudToolGate` 装官方 `tools/pre-execute`（不 `next()` 即短路）；带 agent 身份判据与 `[权限] …` 留痕 |
| 可见性层 | `agent-bridge.ts` 的 `attachMudTools(..., visible)` 按档注册；档位切换时 `capability.onChange` → 先释放再重挂（模型看到的工具列表 = 该档能力） |
| 状态与查询 | `permission/capability.ts`：会话事件 `mud/capability`（log-only）+ 官方会话投影 `mudCapabilities`（host-only，`stateVersion: 1`）；API `ctx.mud.capability.{names,defaultTier,current,resolve,optionOf,options,capabilities,set,ensure,onChange}`（形状对齐 `permissionPresets`）；HTTP `GET/POST /mud/capability`；`/mud/status` 每行带 `tier` |
| 零发送通路 | 新工具 `mud_state`（world 快照 + 最近输出 + 连接态，不碰 socket）、`mud_recall`（尚未投递的输出）、`mud_help`（命令语法按需查询：不带 topic = 分类 + id 索引, topic = 分类/命令 id 给出完整语法）、`mud_captcha`（fullme 取图 + 推前台弹窗；出站围栏）；只读档工具集 = 这几个 + T1 动作通道（`mud_send`/`world_patch`，强制层约束）。**命令目录注入策略**：系统提示只放 `commandsIndexForAgent()` 的索引（分类 + 命令 id，约 10 行），70+ 条完整语法由 `mud_help` 按需取 |
| 模型可见的档位说明 | `permission/tiers.ts` 的 `mudTierNote(tier)` → 系统提示区段 `mud-tier`（动态提供者，档位切换即时生效；补偿偏差 1） |
| 页面入口 | 用户行 ⋯ 菜单三档选择（当前档带 `●`），右栏状态区显示 `权限: …` |

**两处与本文档原设计的偏差（已记入 §18）**：

1. **`mud_send` / `world_patch` / `mud_captcha` 在所有档位都注册**。前两者是 T1 通道本身（登录流程发名字/密码、登录完成/失败置位），只读档若把它们摘掉，登录动作会在官方 `tools/pre-execute` **之前**就被判 `UNKNOWN_TOOL`，强制层根本看不到该调用；`mud_captcha` 是 fullme 流程的解析工具（不发游戏命令，零发送）。因此只读档对 `mud_send` 的约束落在强制层（登录命令放行、其余 deny）。
2. **客户端读档位走 `/mud/status`（HTTP 每会话状态通道），不新增投影 wire 视图**。投影保持 host-only（`mudCapabilities` 状态表），因为当前唯一消费方是页面档位选择器，而它已经每 2.5s 轮询 `/mud/status`；加一个没有消费方的 wire 视图违反"每个抽象都要有当前消费方"。

**与官方正交**：不复用 `sandbox`（管 fs/shell）、不塞 `permissionPresets`（只有 sandbox+approval 两个 knob）。

---

## §11 连接 / 会话 / 配置面

- **会话 ↔ 连接解耦**（I1）：`MudConnectionManager` 只认 host/port；`runtime.connectionId` 是唯一绑定方向。
- **投递前提**：会话无 live agent → 行留在观察窗 park，等官方 `agent/created` 冲刷；插件**不创建** agent（I2）。
- **看门狗（唤醒类计时器）规则化**：看门狗不再各自布防 —— 起停条件是**声明**的，由 `WatchdogTable`（`runtime/watchdogs.ts`）统一起停。运行时只在一个固定入口重评估：`reevaluate()`（**状态变化**：条件为真则布防、为假则停表，**不重置**已布防窗口）、`touch()`（**活动事件**：活跃看门狗重置窗口）。

  | 看门狗 | 启动条件（`active()`） | 窗口 | 触发 | 续期 |
  |---|---|---|---|---|
  | `dead-air`（断流唤醒） | `agentEnabled` ∧ 已连接 ∧ **已登录** ∧ 非人工环节 ∧ **无活跃流程** ∧ 有 live agent | `deadAirMs` | 唤醒 agent 自主行动（`lane=t2` 控制消息） | 是（条件仍成立才续） |

  - **"无活跃流程"这一条的两个目的**（作者定案 2026-09-13）：① **布防推迟到登录流程收尾之后** —— `logged_in` 可能被 **GMCP** 提前置真（pkuxkx 的 `GMCP.System {site}` 是"登录成功通知"，置信度 1.0，`world.ts:130-147`），而我们的 login 流程那时还没走完（`success` 步的 `onEnter.patch` 只是兜底/权威确认）；② **活跃流程期间不抢答** —— 流程可能等很久才有结果（人工环节/慢命令），流程期间的唤醒职责归**流程自己的计时器**（每步 `timeoutMs`），看门狗不得插队。流程的起停由 `FlowRuntime.opts.onTransition` 通知运行时重评估（进入某步/收束/失败/复位）。
  - 时间尺度上这条也更稳：流程各阶段都有自身计时器（等结果 30s、等分支 30s、终态步 5s），人工环节则本来就停表 —— 所以"看门狗在流程中途唤醒 T2"在结构上不会发生。

  - **`login-stall` 删除（v0.4.0）**：登录不再靠"看门狗把 agent 叫起来猜"，而是**流程步骤的 timeout** —— 每步到点即判定**超时**（I4 的三态之一），流程失败收束并留痕（§19）。"登录卡住"从"唤醒 T2 猜原因"变成"流程给出明确失败"。

  - **停止 = 条件不成立**：断线（连接门失效）、登录完成（`loggedIn` 翻转）、agent 释放（agent 门失效）、`dispose()`（表整体释放）都会自动停表 —— 因此不需要为每条路径各写一遍"清定时器"（这正是实测踩过的坑：登录完成不布防、断线后仍空转）。
  - **状态变化点**（唯一的重评估入口，全部幂等）：连接建立/关闭、GMCP、感知 state 折叠、`world_patch` 工具（`buildMudTools.onWorldChange`）、`onAgentReady`、**流程实例状态变化**（`FlowRuntime.opts.onTransition`：进入某步/收束/失败/复位）、`dispose`。多调无害 —— `reevaluate()` 不重置窗口，只有 `touch()`（收到游戏输出）才重置。
  - **边界（避免"什么都塞进管理器"）**：L2 的静默窗结算（`settleTimer`）与 holdDelivery 兜底（`holdTimer`）**不属于看门狗** —— 它们属于一次投递事务的生命周期，留在 runtime；传输层空闲/断线探测属 telnet 层。看门狗表只装"到点唤醒 agent"这一类。
- **工具离线行为**：未连接时发命令类工具**本地快速拒绝**（不入队列、不进桥），返回可读原因。
- **删除用户 / 删除服务器 = 归档配套会话 + 删日志**（两条官方/插件动作配套执行）：
  - **归档（官方路径）**：`IWorkspaces.archiveSession(sessionId)` —— 官方没有"删除会话"，归档是它的替代语义：会话进入 registry 全局归档集，从所有分组/搜索界面隐藏，**会话文件与 workspace 记账槽位保留**（`api/workspace-controller/src/client/service.ts:114`、命令实现 `api/workspace-controller/src/commands.ts:153`）；归档当前会话时 harness 自己把选择清成新会话视图（`client/ui-workspace/src/client/navigation.ts:242`）。会话存在（live 或持久化）才能归档，名单里的失效 id 归档失败只忽略。
  - **删日志（本插件自有资产）**：`ctx.mud.purge(sessionId)`（HTTP `POST /mud/purge`）—— 释放该会话运行时与连接、删除该会话**全部**日志文件（所有日期 + 滚动分片，`purgeSessionLogs`）、清该会话内存与全局 WS 缓冲；页面同时丢弃该会话的本页缓冲（`MudSocketController.forget`）。
- **UI**：连接/断开入口在左栏用户行的 ⋯ 菜单（blank 会话不渲染会话体）；**无占位 prompt** —— `blank` 由首个 `turn/start` 翻转，连接后第一批游戏输出自然开回合翻页。
- **登录 = 流程表 `login`（v0.4.0，step 驱动；与 §19 同一套机制）**。入口是**匹配服务端提示行**，不是定时器；每步"提示行 → 命令 → 结果判据"。步骤（`(估计)` 标记者待实录原文替换）：

  ```
  login                                        priority = 1000（不可打断；无规则 interrupts > 1000）
    when        !logged_in                     （空闲且未登录才 arm 入口）
    name     driver  您的英文名字：|您的英文名字（要注册新人物请输入new。）：
             action  mud_send { cmd:'{name}' }
             fail    ['需要创建新人物'(估计)]     （用户名不存在 → 实质失败, 中断流程）
             next    ['pass']                  （后继只有 pass）
    pass     driver  此ID档案已存在，请输入密码：|请输入密码：
             action  mud_send { cmd:'{pass}' }
             fail    ['密码错误'(估计)]          （实测常表现为服务器直接断连 → 走桥 error 那条路）
             next    ['replace','success']     （两个都带 driver ⇒ 都是条件分支，谁的行先到谁生效）
    replace  driver  您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)     ← 可能步骤
             action  mud_send { cmd:'y' }
             next    ['success']               （答完 y 直接等成功句，不再要密码）
    success  driver  ['目前权限：(player)','重新连线完毕','欢迎来到'(估计)]   ← "已进入游戏"的成功句
             action  mud_send { cmd:'' }       （**空命令**：顶开服务端 / 跳过 MXP 检测）
             ok      [GA]                      （空命令必有 GA；无响应即异常 → 5s 超时失败收束）
             onEnter patch { logged_in:true }  （进入即落 world）
             timeoutMs 5_000
             （next 空 = 终态：空命令成功即整个登录流程成功结束）
    failPolicy { notify: 'none' }              （失败只写日志 + 决策记录, 不唤醒 T2）
  ```

  - **本步结果 = 下一步的新文本**（作者定案 2026-09-13，登录流程的核心语义）：`name`/`pass`/`replace` **都不写 `ok`** ——
    "请输入密码"既是 `pass` 的 driver，也就是 `name` 的结果；"替换人物"是 `pass` 的结果（→`replace`）；
    "目前权限/重新连线完毕"是 `pass`/`replace` 的结果（→`success`）。判据**只写一份**（§19.2：命中后继 driver ⇒ 本步成功 + 走该分支）。
    反面：若在这里另写一条相同文本的 `ok`，它会**抢在条件分支之前**命中（`ok` 声明序在前）→ 密码提示行被消费 → 走不到 `pass`（流程挂死到超时）。
  - **四步定稿**（作者 2026-09-13）：`name → pass → [replace | success]`、`replace → success`；`name` 的后继**只有** `pass`（同名确认句不会在名字步之后出现）。**删掉了 `mxp` 与 `look` 两步** —— 终态步的**空命令**同时完成"顶开服务端（不发命令则输出要等约 5 分钟，实测）"与"跳过 MXP 检测（发任何命令都能跳过）"两件事，登录后的第一屏交给 T2 自己决定。
  - **空命令必有 GA**（作者定案 2026-09-13）：系统有响应则必然返回 GA，系统无响应即异常 → 5s 超时 → 流程失败收束。因此终态步保留 `ok:[GA]`（这是"登录流程真的收尾了"的确认）。
  - **失败不设恢复路径**（作者定案 2026-09-13）：用户名/密码是**人工给的**，T2 与用户都补不了；密码错实测还会连带断连。所以 `failPolicy = { notify: 'none' }` —— 只写会话日志 + 决策记录，**不唤醒 T2**。断线重连后照常重新跑整套登录（`logged_in` 在连接建立时复位，§11 开头）。
  - **`success` 的进入判据是"已进入游戏"的成功句**：它带 driver（条件分支）→ 命中即表示前一步成功并进入本步，进入时置位 `logged_in` 并发出空命令；`pass` 的两个后继（`replace`/`success`）都带 driver，所以"两条句子都不出现"= 不静默等待，而是**本步超时失败收束**。
  - **收束在终态 `success`**：中间每一步成功都只是**里程碑**，只有 `next` 为空的 `success` 成功时流程才结束（`[流程] login 完成（终态）`）。
  - 待实录项（作者上线前核对）：`需要创建新人物` 原文、`密码错误` 原文、`success` 的三条成功句形态。
- **fullme（防机器人验证）= 流程表 `fullme`（v0.4.0）**。**入口不是定时器**：人物经验值过 **5M**（五百万）之后长时间不使用 fullme 会被系统判定为机器人，服务端届时打出提醒。**实录提醒原文（用户 2026-09-12）：`5M后长时间不使用fullme，会被系统判定为机器人。`**，判据就是这一串本身（不加容错变体）。步骤：

  ```
  fullme                                       priority = 100（可被打断：interrupts > 100 的战斗类事件）
    when        logged_in
    request  driver  5M后长时间不使用fullme，会被系统判定为机器人。
             action  mud_send { cmd:'fullme' }
             fail    /^你刚刚用过这个命令不久，还要[^。]*才能再用。/
                     （时长动态：`还有 3 分 20 秒` / `还有 45 秒`，总计 15 分钟 → 通配符吃下两种形态）
             next    ['stale','prompt']       （两条条件分支，互斥）
             ※ **无 ok**：本步结果 = 下一步的新文本；fail 命中即中止（无兜底、无"直接成功"路径）
    stale    driver  （实录）你之前请求的fullme还没有完成。如果图片已过期，可以打三次"fullme 1"放弃本次fullme。
             action  mud_send { cmds:['fullme 1','fullme 1','fullme 1'] }   ← **必须三连发**才能放弃
             fail    [{ kind:'ga', why:'放弃上一轮（三连 fullme 1）→ 本轮作废' }]
             （无 next：以**失败收束**收场 → 复位到空闲、只留入口）
    prompt   driver  /^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/
             capture { captchaUrl: /(https?:\/\/[^\s]*robot\.php\?filename=[^\s]+)/ }
             action  mud_captcha { url:'{captchaUrl}', note:'{lastFail}' }
             ok      [{ kind:'tool', outcome:'ok' }]        ← 取图成功（判据 = 工具结果）
             fail    [{ kind:'tool', outcome:'error' }]     ← 取图失败 → 本轮失败收束
             next    ['answer']                             ← 顺序兜底
    answer   driver  （无：由 prompt 顺序兜底进入；**答错重试不换步**）
             action  mud_send { cmds:['halt','fullme {captcha}'] }
             awaitExternal  ['captcha']
             timeoutMs 180_000                 ← **本步总预算**：等人工 + 答错重来 + 收结果都算在内
                                                 = 图片有效期 3 分钟（到点 = 本步超时 → 本轮失败）
             ok      ['你突然感到精神一振，浑身似乎又充满了力量！']   ← 行含该串即成功（实录句）
             fail    ['好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！']
                     [{ kind:'tool', outcome:'error' }]   ← 工具结果失败（取图/发送）同样算本步失败
             retry   { attempts:3, on:['fail'],            ← 重试**不出本步**、**不重置上面的预算**
                       action: mud_captcha { url:'{captchaUrl}', note:'{lastFail}' } }
                     （重试动作 = 重新取图 + 弹窗反馈失败原文；随后本步动作重新挂起等人工）
             next    ['success']
    success  action  mud_send { cmd:'hpbrief' }    ← 补状态（fullme 不只防挂机）
             ok      [GA]
             （next 空 = 终态：hpbrief 被接受即流程成功结束）
    failPolicy { notify:'none' }                   ← 只留痕，不叫 T2
  ```

  - **`request` 的判据只有一份**：`stale` 与 `prompt` 的 driver 就是它的两种结果（§19.2）—— 成功句不在这里声明：**必须正确回码才能通过**。
  - **三种收场都让服务端停在当前轮次**（作者实测）：取图失败 / 3 次答错 / 3 分钟预算耗尽（人工没填或没填完）→ 下一轮 `fullme` 必然先撞 `stale`（先三连 `fullme 1` 放弃上一轮）。**答错 3 次是例外**：错码与 `fullme 1` 等价，三次错码本身就把上一轮放弃了 ⇒ 下一轮**不进** `stale`（`attempts:3` 正好等于"三连放弃"）。
  - **冷却期不自己计时**：`fullme 1` 放弃后有冷却期；冷却未完时下一轮 `request.fail` 会把剩余时间原样报出来（再一次失败收束），冷却结束自然跑通 —— 不需要额外的"等 N 分钟"机制。
  - **`answer` 的时间预算是"一步总计"**（作者 2026-09-13 定案，取代初稿的 `humanTimeoutMs`）：`timeoutMs: 180_000` 从**首次进入本步**起算，覆盖"等人工 + 发答案 + 答错重来 ×3 + 收结果"全部动作；**重试不重置**（这是它与"每步各自计时"的唯一差别）。3 分钟正好等于图片有效期 —— 到点即本步超时 → 本轮失败收束；等人工期间计时器照常在跑，不需要单独的"人工超时"字段，也不需要 `Config.humanWaitMs`。
  - **答错重试在步内自环**（不换步）：`{lastFail}` ← 答错句原文 → 清空 `{captcha}` 槽 → 投 `retry.action`（`mud_captcha` 再抓同一个 `robot.php`，页面自动刷新出新图，弹窗带失败原文）→ 本步动作**重新挂起**等人工 → 计时器继续跑。`attempts:3` = 总尝试次数（含首次）；用尽 → 本轮失败收束。工具结果失败（取图失败/发送失败）命中 `fail` 里的 `tool` 判据 → 立即失败，不必等到预算耗尽。
  - **重试动作的结果同样按本步 `fail` 判据结算**：所以"重试时图片也解析不出来"会当场失败收束，而不是让人对着坏图等到 3 分钟。
  - **`hpbrief`**：终态步发 `hpbrief`，以 GA 判定"命令被接受"即收束；把它的应答**折叠进 world 的 state 规则后续一起加**（现行先只发命令）。

  **定稿的 `FlowSpec`（2026-09-13 作者逐条审定；实现清单见下）**：

  ```ts
  export const FULLME_FLOW: FlowSpec = {
    id: 'fullme',
    priority: PRIORITY_NORMAL,                    // 100：战斗/生存类（interrupts > 100）可打断
    when: world => world.flags.logged_in === true,
    entry: 'request',
    timeoutMs: 30_000,
    failPolicy: { notify: 'none' },               // 只留痕：人工/系统问题，T2 补不了
    steps: [
      {
        id: 'request',
        driver: { kind: 'text', includes: ['5M后长时间不使用fullme，会被系统判定为机器人。'] },
        action: { tool: 'mud_send', args: { cmd: 'fullme' } },
        // 无 ok：本步结果 = 下一步的新文本（stale 提示 / 验证码地址行）。
        fail: [{ kind: 'regex', patterns: [/^你刚刚用过这个命令不久，还要[^。]*才能再用。/] }],
        next: ['stale', 'prompt'],                // 两条条件分支；fail 命中即中止
        timeoutMs: 30_000,
      },
      {
        id: 'stale',
        driver: { kind: 'text', includes: ['你之前请求的fullme还没有完成。'] },
        // 必须三连发才能真的放弃上一轮（作者实测）。
        action: { tool: 'mud_send', args: { cmds: ['fullme 1', 'fullme 1', 'fullme 1'] } },
        fail: [{ kind: 'ga', why: '放弃上一轮（三连 fullme 1）→ 本轮作废' }],
        timeoutMs: 5_000,
      },
      {
        id: 'prompt',
        driver: { kind: 'regex', patterns: [/^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/] },
        capture: { captchaUrl: /(https?:\/\/[^\s]*robot\.php\?filename=[^\s]+)/ },
        action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
        ok: [{ kind: 'tool', outcome: 'ok' }],    // 取图成功（新判据：工具结果）
        fail: [{ kind: 'tool', outcome: 'error' }],
        next: ['answer'],                         // 顺序兜底
        timeoutMs: 15_000,
      },
      {
        id: 'answer',
        action: { tool: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
        awaitExternal: ['captcha'],               // 进入即挂起动作 + 进人工环节
        ok: [{ kind: 'text', includes: [FULLME_OK_TEXT] }],
        fail: [
          { kind: 'text', includes: [FULLME_WRONG_TEXT] },
          { kind: 'tool', outcome: 'error' },     // 工具结果失败（取图/发送）同样算本步失败
        ],
        // 重试**不出本步**、**不重置本步预算**；重试动作 = 重新取图 + 弹窗反馈失败原文。
        retry: {
          attempts: 3,                             // 总尝试次数（含首次）
          on: ['fail'],
          action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
        },
        next: ['success'],
        timeoutMs: 180_000,                        // 本步总预算 = 图片有效期（等人工 + 重来都算在内）
      },
      {
        id: 'success',
        action: { tool: 'mud_send', args: { cmd: 'hpbrief' } },
        ok: [{ kind: 'ga' }],                     // next 空 = 终态：hpbrief 被接受即成功收束
        timeoutMs: 5_000,
      },
    ],
  }
  ```

  **实现面（8 项，✅ 已落地 2026-09-13；注册期校验与端到端测试见 §13.6）**：
  1. **工具结果判据** `{ kind:'tool', outcome:'ok'|'error' }`（§19.1）：官方工具结果经现有包装器（`runWithDeliveryChannel` → `endToolCall`）喂回流程机 —— call-id `mud-<delivery>-<index>` → 该动作的 `ruleId`（`flow:fullme/prompt`）→ 步骤 id，**只认当前步**。
  2. **流程实例槽 + 槽占位符**：`capture` 声明把命中行抽进槽（`{captchaUrl}`；**答错重试不重新抽取，沿用首次的值**）；内建 `{lastFail}` = 本流程最近一次 `fail` 命中行原文。运行时**投递前**按槽插值；`{captcha}` 仍留到**发送瞬间**插值（人工值不进转录）。
  3. **人工环节沿用本步 `timeoutMs`**（**不再单列 `humanTimeoutMs`**，作者 2026-09-13 修正）：`enterStep` 在 `awaitExternal` 步**照常布防计时器**（现在是"不布防"）；等人工期间计时器照跑，到点 = 该步超时 → 流程失败收束。`answer.timeoutMs = 180_000` = 图片有效期，等人工与答错重来共用这一份预算；**不需要 `Config.humanWaitMs`**。
  4. **`retry` 定稿** `{ attempts, on?, action? }`：`attempts` = **总尝试次数（含首次）**；`on` 缺省 `['driver']`（旧行为一字不变，全仓没有流程用过它，无迁移负担）；命中 `on` 里的判据时**在原步内重试** —— 投 `action`（缺省 = 重发本步动作）、清空本步 `awaitExternal` 的槽值、把命中行原文写进 `{lastFail}`、重新挂起等人工，**不重置本步计时器**；`attempts` 用尽才算失败。
  5. **流程路径的人工环节三处**（§19.3）：① `awaitExternal` 的动作**先挂起不投递**（现在帧内路径会先把字面 `fullme {captcha}` 发出去）；② `exitHumanWait` 调 `flow.resumeHuman()`（现在是死代码 → 永久挂死）：回到 `awaiting-result`，**计时器继续跑、不重布防**；③ 等人工期间**行判据不结算**本步。
  6. **`mud_captcha` 工具**（新注册，所有档位可见）：地址围栏（只允许 pkuxkx.net）→ 抓 `robot.php` → 取 `<img src>` → 归一为绝对地址 → 推前台弹窗（payload 带 `note` = 失败原文）→ 返回 `{ok,image}`（无新依赖，复用 `network/captcha.ts`）。
  7. **退役**：`fullme:request`/`fullme:prompt`/`fullme:done` 三条规则（§16）；取图职责从运行时 `sink.captcha` 迁到 `mud_captcha`；随之 `Config.captchaPatterns` / `extractCaptchaUrl` 若无其它使用者一并退役；`runtime-captcha.spec.ts` 整篇改写为流程用例、`rule-coverage.spec.ts` 三条 fullme 样本移走、`runtime-direct-action.spec.ts` 的样本替换；`index.ts` 系统命令集里那截 `fullme:*` 过滤删除（`flowCommands(defaultFlows)` 已覆盖 `fullme`/`halt`/`fullme {captcha}`/`fullme 1`）。
  8. **判据文案 `why?`**（小项）：`FlowMatch` 可带 `why`，只影响日志/决策文案 —— 让 `stale` 的收束写成"放弃上一轮 → 本轮作废"而不是"命中失败判据 GA"。

  人工环节（`awaitExternal`）：进入该步即**挂起动作**（不投递）+ **暂停全部投递**（行留待决，模型看不到提示、不会自己去答）+ **停掉看门狗**（`awaitingHuman` 进 `active()` 条件）+ `requestAgent` 拒绝唤醒；**等人工期间行判据不结算本步**（人工环节只有一个出口）。人工在页面输入 `fullme <码>`（actor `user`）**不直接发出** —— 值存进 `{captcha}`，`exitHumanWait` 调 `flow.resumeHuman()`（回到 `awaiting-result`；**计时器继续跑、不重布防**）后按**动作投递**投出该动作（`{captcha}` 在**发送瞬间**插值，人工值不进转录）。**超时 = 本步 `timeoutMs`**（fullme `answer` 步 180000 = 图片有效期；等人工与答错重来共用同一份预算）；到点即该步超时 → 流程失败收束 + 退出人工环节（`syncHumanWait`）。断线重连作废人工环节。不做 OCR（pkuxkx 明确要求人工）。
  **取图职责分界**：**工具** `mud_captcha` 负责"出站围栏 + 抓 `robot.php` + 取 `<img src>` + 归一为绝对地址"（`network/captcha.ts` 的 `resolveCaptchaImage`）并返回 `{ok,image}`/`{ok:false}`；**宿主**负责把解析结果推成页面上的验证码对话框（payload 带 `note` = 上一轮答错原文）并登记 `robotUrl → imageUrl`（供 `/mud/captcha/refresh` 刷新）。运行时只管"挂起 + 计时 + 收人工值"。
- **流程与运行时的关系**（v0.4.0）：流程表在装配期注册为运行时的只读声明面；**每会话的流程实例是运行时状态**（`diag()` 可见、每次迁移写决策/日志）：`{ flowId, stepId, armed[], phase: awaiting-result | awaiting-human, deadline, pendingActions[], pendingEntry[] }`。细节见 §19。
- **Config 全集**（部署值一律可配，I8）：`host`/`port`/`sessionId`/`cwd`/`logDir`/`account`/`agentEnabled`/`persona`/`commandIntervalMs`/`bridgeTimeoutMs`/`bridgeDeclaredTimeoutMs`/`bridgeSilenceMs`/`loginTimeoutMs`/`deadAirMs`/`holdTimeoutMs`/`defaultTier`/`dangerousCommands`/`agentPreset`/`activityTable`/`toolCallIntervalMs`/`t2DeliverIntervalMs`/`captchaPatterns`。（v0.4.0：`loginExitCommands` 退役 —— 登录收尾由流程步骤承担；**不引入 `humanWaitMs`/`humanTimeoutMs`** —— 人工环节沿用本步 `timeoutMs`；fullme 流程化后 `captchaPatterns` 随取图职责迁入 `mud_captcha` 工具，见 §16。）

---

## §12 观测与诊断

| 通道 | 内容 |
|---|---|
| 会话日志 tab | `[路由] step 认领 …` / `[路由] 请求 … next=… → 拦截为 T1\|不介入\|还原真实模型 (…)\|` / `[路由] 会话模型被上次 T1 拦截污染 … → 本回合还原为 …` / `[路由] lane=t1 动作投递 (rule=…, action=…)` / `[流程] <flowId> 激活 (入口: …)` / `[流程] <flowId>/<step> 挂起 (next: …, timeout …)` / `[流程] 命中 <step> 驱动句 → 唤醒 <step> = 成功 (分支 …)` \| `超时` \| `连接断开` / `[流程] <flowId> 被 <rule> 打断 (interrupts=N > priority=M)：结算挂起 / 复位 / onInterrupt / 投递事件动作` / `[流程] 无打断权 → 排队 (pending action N)` / `[流程] 判据冲突: A 与 B → 取 A` / `[流程] <flow>/<step> 结算 ga（不是本步命令的结算: "<cmd>", 忽略）` / `[感知] 原文投递 N 行 + M 动作 (lane=…, agent 状态, 队列 N)` / `[感知] 动作投递 N 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)` / `[感知] 批次投递 N 行` / `[感知] 投递改为 defer (工具在途 N): 随本结果进下一步` / `[t1] 渲染 …` / `[看门狗] <id> 布防 Nms` \| `停表 (原因)` / `[缺陷] 流程挂起期间收到第二条应答请求 → 已拒绝` / `[权限] <工具> → 拒绝\|待批准 (档位 …): 理由` / `[权限] 档位 A → B` / `[规则] <规则 id> → 直接执行 <工具> <args>` / `[流程] <flowId> 进入步骤 <step>` / `[流程] <flowId>/<step> = 成功（…）` / `[流程] <flowId>/<step> 重试 N/attempts` / `[流程] <flowId>/<step> 等人工输入 ({captcha}; 预算 180000ms)` / `[流程] <flowId>/<step> 重试 N/attempts` / `[流程] <flowId>/<step> 槽 {captchaUrl} = …` / `[流程] <flowId>/<step> 工具结果 ok\|error → 判定` / `[验证码] 检测到 … 等人工输入 (缺 {captcha}; 看门狗暂停, 投递暂停; 计时用本步预算)` / `[验证码] 流程已结束 → 退出人工环节` / `[验证码] 已解析并推送图片: …` / `[流程] <flowId> 完成（终态）` / `[流程] <flowId>/<step> 失败：… → 复位（只留入口）` / `[验证码] 检测到验证码地址, 等人工输入 …` / `[验证码] 人工已提交 …` / `[装配] 官方 preset 已装配 (mud-player)` / `[发送] …` |
| 决策栏 | `feed-classify`（lane 决策）、`holdDelivery` 暂缓/释放、权限 deny/ask、agent 工具调用、**流程迁移**（激活/挂起/唤醒/打断/排队/失败收束）、`direct-exec`（直接执行） |
| 档位读写 | `GET /mud/capability?sessionId=…`（当前档 + 选项 + 外围能力）、`POST /mud/capability {sessionId,tier}`；`GET /mud/status` 每行带 `tier` |
| agent 侧 | `agent/error`（回合错误）、`agent/inbox/discarded`（待处理投递被取消丢弃） |
| `/mud/diag` | 每会话：`connectionId`、`connected`、观察窗/回看缓冲规模/`awaitingHuman`（人工环节）、`agent` 是否 live、`lastError`、**`flow`（v0.4.0：`{flowId, stepId, armed[], phase: awaiting-result \| awaiting-human \| awaiting-branch, deadline, slots}`）**、`pendingActions`/`pendingEntry` 条数；**计数**：遗留段丢弃行数、holdDelivery 释放次数、流程失败/超时次数、挂起期第二条请求拒绝次数（I4/I9） |

<!-- 待补：diag 字段的精确 schema 与阈值告警口径 -->

---

## §13 测试策略

1. **不变量用例**：投递消息体按序拼接 == 完整入站流（I5）。
2. **表驱动"命中必被适配"**（I4）：`tests/rule-coverage.spec.ts` —— 每条规则一条 canonical 样本（样本表必须覆盖规则表，新增规则不补样本即红），走 `PerceptionEngine.feed → TriggerLlmAdapter` 真实链路，断言 state 规则进 `stateHits`、event 规则进 `hits` 且渲染出的 tool-call 名字/参数与规则声明逐字一致。
3. **单元**：感知引擎（跨文本块多行状态、holdDelivery、消费边界）、投递切分（有/无命中、遗留段、超限丢弃）、桥（结算/取消/活动表）、权限（三档 × 动作矩阵，含 T1 动作被 deny）。
4. **runtime 级脚手架（已起步）**：`tests/runtime-delivery.spec.ts`（交付水位 / 帧内容只进本帧 / **T2 投递限流**，4 例）+ `tests/watchdogs.spec.ts`（看门狗**规则**表驱动：启动/停止/活动重置/一次或续期/guard/计数/dispose，11 例）+ `tests/runtime-watchdog.spec.ts`（"世界变化 → 看门狗布防"、未登录不布防断流、未连接不唤醒、登录完成清登录看门狗、**活跃流程期间不布防·收束后才布防**，5 例）+ `tests/runtime-captcha.spec.ts`（fullme：提醒行 → **直发** `fullme` / 应答帧内地址 → 人工 → `halt` + `fullme <码>` 全链路 / 帧内命中独立投递 / 人工环节停表，8 例）+ `tests/flow-login.spec.ts`（**v0.4.0 流程机端到端**：声明期校验 + 四步图 + 名字→密码→成功句→空命令 + 可选 replace 分支 + 失败收束 + GA 归属 + 分支超时，9 例）+ `tests/flow-interrupt.spec.ts`（打断/排队：档位够→打断、档位不够→排队、超时出队、半截序列不发、login 不可打断，7 例）+ `tests/flow-ownership.spec.ts`（**桥结算归属按命令比对**：本步命令生效 / 别命令点名拒绝 / 序列任一条命中 / 缺省 cmds 兼容，4 例）+ `tests/t1-adapter.spec.ts`（T1 契约：动作渲染 / 确定性 call-id / 已执行不重渲 / 选路异常，8 例）+ `tests/mud-persona.spec.ts`（人设槽按作用域替换）+ `tests/runtime-direct-action.spec.ts`（直接执行：入队、折叠、人工环节不执行、危险命令硬边界）+ `tests/commands.spec.ts`（命令索引 / 按需展开） —— 可注入的 sink / 假连接管理器 / `vi.useFakeTimers()` 驱动真实 `MudSessionRuntime`。仍待补：投递切分（T1/T2 各一条消息）、离线拒绝、holdDelivery 释放。
5. **官方 loop 模拟器（回合/步骤的唯一可信证据；`tests/loop-sim.ts` + `tests/loop-sim-login.spec.ts`）**：按 DSH 源码逐条复刻 loop 转移（`while (await turn())` 驱动器、`claim(next-step 全取 / next-turn 一条)`、回合首步空认领即收束、结果 `additionalContexts` → `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break、插件 lane 记忆），每条规则在文件里给出出处；驱动器与测试线程**交错**（工具调用阻塞在等游戏应答，测试用 `until(pred)` 推进假计时器）。
   - **规矩**：凡是关于"回合数 / 步骤数 / 模型请求次数 / 是否落到 T2"的结论，**必须在这个模拟器上量**；旧的"`followup` → 数组"替身看不到边界，不能作为证据。
   - 已量：login 现状 = 3 回合 / 6 次请求（每步一次空续步）；提议 A/B = 1 回合 / 4 次、1 回合 / 3 次（§19.6.1）。
   - 模拟器同时是**提议方案的建模台**：`SimDeliveryMode = 'followup' | 'defer' | 'defer-conclude'`（后两者只在测试内把运行时投递挂成工具结果的 `additionalContexts`/`concludesTurn`，不代表已实现）。
6. **端到端**（真连 pkuxkx）：登录序列（名字 → 密码 → 完成）、长程命令（`dazuo`）、分页各一条。
7. **v0.4.0 新增（计划）**：
   - **流程机单测**（`tests/flow-*.spec.ts`）：arming 推导（进入某步 = 本步 driver(重试) + 本步 ok/fail + 条件分支 driver）、**GA 判据**（`ok:[GA]` 即成功 / `fail:[GA]` 即失败 / 两边同写 → 注册期报错）、**注册期校验表**（ok-fail 互斥、next 引用存在、id 唯一、awaitExternal 占位符存在）、条件分支 vs 顺序兜底（MXP 不出现不阻塞）、同类多命中按声明顺序取首 + 留痕、`when` 入口前置、`retry` 重发本步、超时 → 失败收束、打断（数字档位比较、`onInterrupt`、事件动作投递）、无打断权 → 排队、`pending entry` 接续、**单流程互斥**（第二流程入口不 arm）、**挂起期闸门**（第二条应答请求被拒 + 留痕）。
   - **T1 契约测试**：动作消息 → tool-call 逐字一致；无动作 → `stop`；同一动作重复调用**不重复渲染**（确定性 call-id + 已有 tool-result 判据）；**契约检验（I15）**：同一投递消息在"不知道任何 T1 私有字段"的前提下也能被解释（T2 可用性用例）。
   - **端到端**：login 全链（正常 / 用户名不存在 → 注册分支 / 密码错 → 失败收束 / 服务器断开 → 失败收束）、fullme 全链（提醒 → 地址 → 人工 → 成功；被人等打断）。
   - **投递通道（已落地）**：`runtime-defer.spec.ts`（4 例：工具在途 ⇒ defer 槽 / 无在途 ⇒ `followup` / 判据 B 四情形 / 流程活跃时不收束）+ `loop-sim-login.spec.ts`（真行为账目 1 回合 / 3 步 / 3 次请求）。**模拟器现在仿真官方包装器**：`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `deferContext` → `result.ok && shouldConcludeTurn(callId)` → `concludeTurn`。

---

## §14 历史吸收表

| 来源 | 内容 | 落点 | 状态 |
|---|---|---|---|
| V7 审查 P0-1/0-2/0-3、P1-1/1-2、P2-1/2/3、P3-1/2/5/6、R2-1…R2-13 | 桥可用性、登录文本、工具拒绝前缀、序列、掩码、孤儿 GA、上限、HTTP 围栏、WS 背压… | v8 已实现（随 V10 保留） | ✅ |
| V7 审查 P1-3a/1-3b | 多批行还原（`cacheLines`）/ 多行状态双跑（`matchDry`） | **§4+§7 合流**：行级源 + hit 渲染 → 整类问题消失 | V10 |
| V7 审查 P1-4 / R2-3 | dz/sleep 完成句、`COMPLETION_UNTIL` 键覆盖 | **§8 活动表（机制 D）** | V10 |
| V7 审查 P3-3 | `exec.signal` / `concludeTurn` 未接 | **§8** | V10 |
| V7 审查 P3-4 | matcher/控制器模块级单例 | **§4 每会话引擎**（控制器 v8 已按会话） | V10 |
| V7 审查 P2-4 | 分页逐页语义 | §8 规则模板 | V10 |
| V7 审查 R2-8 | 观察窗/注入裁剪 | **§5 裁剪（唯一职责）** | V10 |
| V7 审查 P3-1 / R2-6 | 凭据掩码 | host 侧已掩码；**浏览器 roster 明文**归 §10 凭据项 | 部分 |
| V9 权限设计（`REFACTOR-V9-permissions.md`） | 三档、actor、零发送工具、双层执法、`selectModel` 禁令 | **§10 全文并入** | V10 |
| preset 化计划（`.trae/documents/mud-preset-refactor-plan.md`） | preset 挂载工具/人设/技能、`composedPreset` 门控、迁移方式 | **§9 全文并入** | V10 |
| 本轮 holdDelivery | 半截事务原子性 | §4（状态持久后真正生效） | 已实现（待生效） |
| v8 已落地 | 会话-连接解耦、官方投递、lane 随消息、T2 基线、prepend、按会话键控 HTTP/WS、删占位 prompt、看门狗门、离线拒绝 | §5–§7、§11 | ✅ |

---

## §15 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-11 | 设计基线：合并 V7/V8/V9/preset 计划；确立术语（文本块/行/批次/原文投递消息 —— 旧称"反射消息"）、L1–L4 分层、单流切分、九条不变量、版本规则、交付切片 |
| v0.1（实施） | 2026-09-11 | 落地 W1+W2：每会话行级感知引擎、hit 驱动 T1 渲染、单流切分；删除 `matchDry`/`resolveLines`/行集表；补 GA 边界接线与 diag 缺陷计数 |
| v0.1.1 | 2026-09-11 | 修复 T1 拦截时继承官方 `reasoningEffort` 导致 llm 层拒绝（`does not support reasoning effort "high"`）：`toT1Config` 换 provider 时剥离 adapter-owned effort（与官方换模型同款惯用法） |
| v0.1.2 | 2026-09-11 | 联调修复（T1 已跑通后的两处）+ W2 收尾：① 工具输出 schema 漏声明 `settled` —— `additionalProperties: false` 下桥结算结果被判非法，工具**已执行**却回一条失败帧（新增"结果字段必须全部已声明"用例）；② 删除用户残留 —— 删用户/删服务器改为**归档配套官方会话**（`IWorkspaces.archiveSession`，官方归档语义：界面隐藏、会话文件保留）+ `ctx.mud.purge` / `POST /mud/purge` + `purgeSessionLogs`（释放运行时与连接、删该会话全部日志文件、清本页与 host 缓冲）；③ 补 W2 表驱动"命中必被适配"用例（`tests/rule-coverage.spec.ts`）；④ `POST /mud/bind` 重复声明不再刷三行日志 |
| v0.1.3 | 2026-09-11 | 修复登录"赶出去/取而代之"确认分支无响应：`login:replace-confirm` 的关键词集（同名/覆盖/替换/已被占用）全不在实录句 `您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)` 里 → T1 无命中 → 不发 `y`、登录停住。改为以实录句为准（问句本身即命中，不要求同行 y/n；旧估计形态保留），并把"多行规则的多 pattern = 有序条件、单行提示只能写一条正则"记入 §4 |
| v0.2.0 | 2026-09-11 | W3 前半（权限档位 §10）落地：三档 `observe`/`operate`/`full`（表 `permission/tiers.ts`）；危险命令静态黑名单 → 策略表（`DEFAULT_DANGEROUS_COMMANDS`，`deny`/`ask` + Config 覆盖）；纯判定 `evaluateToolCall` + 官方 `tools/pre-execute` 强制点（含 agent 身份判据、`[权限]` 留痕）；可见性层按档注册并在切换时重挂；会话事件 `mud/capability` + 投影 `mudCapabilities`（host-only）+ `ctx.mud.capability.*` + `GET/POST /mud/capability` + `/mud/status.tier`；新增零发送工具 `mud_state`；页面用户行 ⋯ 菜单三档选择 + 右栏显示 |
| v0.2.1 | 2026-09-11 | W3 后半（preset 化 §9）落地，方案 A1：新增 agent 平面 preset 行 `src/preset-agent.ts`（组装期注册工具声明 + 提示区段，执行期按调用方 agent 解析会话工具）、组合文件 `presets/mud-player/{agent.cordis.yml,preset.yml}`、`ctx.mud.agentKit()` 数据源、`Config.agentPreset` 开关与装配失败回落；新增投递就绪门 `MudRuntimeSink.agentReady`（装配未就绪时不投递，避免第一批输出跑在旧组装上并永久锁定 preset）；已知取舍：preset 模式下 §10 可见性层退化为强制层 + 提示文本 |
| v0.2.2 | 2026-09-12 | 联调修复（preset 装配事故 + T1 模型污染）：① 组合文件改为 **`standard` 整份副本 + `mud-agent` 一行** —— preset 是"整个组装"，只写自己那一行会让被切过去的会话丢掉全部标准工具（实测"工具不可见"；preset 与已产出内容的会话一旦锁死只能删用户重建）；② `Config.agentPreset` 从 profile patch 挪到本包 patch（分层正确的位置）；③ `resolveLaneConfig`：官方会把生效的 provider/model 记成会话选择 → 首次 T1 拦截后非 T1 回合也会打到 `mud-t1`（真实 LLM 永不参与），现在记住并还原"会话真实模型"；④ 新增 7 条选路用例 + 组合文件回归用例 |
| v0.2.3 | 2026-09-12 | 部署契约修正 + 一处 YAML 修复：① preset 根（`agent-presets.roots`）与 `agentPreset` 一律写本包 patch（`--patch` overlay，启动期一层），**profile patch 保持 `[]`** —— 本机 profile 是 `patchReload: live`，热应用一次 `agent-presets` 配置会重建常驻挂载，导致所有 preset 组装出来的工具当场消失（实测两次，改回 `[]` 后不重启即恢复）；② 修 `presets/mud-player/preset.yml`：描述里的裸 `": "` 让 js-yaml 解析失败（官方吞掉异常 → 选择器只显示 id），改用折叠块并加结构性守卫用例；③ 新增 patch 文件契约用例（preset 根 + preset id 同层、`mud-core` 只作为 insert 出现） |
| v0.2.4 | 2026-09-12 | preset 首启实测的两处修复：① 组合文件改为**机械生成**（standard 的 `# ── identity` 起全部内容含注释 + 末尾 `mud-agent` 行）—— 手抄版漏掉 `plan-mode` 的必填 `config.section`，挂载报 `PlanModeConfig needs a non-empty 'section'` 并回落宿主侧装配；新增"与 standard 逐行比对"守卫用例（harness 检出存在时启用）；② 修回落路径上的就绪门：就绪由每会话标志 `capabilityReady` 判定（预设挂载成功**或**回落完成都置位），只看 `composedPreset` 会让回落会话的待决行永不投递（实测登录文本一直被留到登录看门狗唤醒）；③ 顺带修 `preset.yml` 的 YAML 语法（裸 `": "`）|
| v0.2.5 | 2026-09-12 | 修实测的"登录完成后会话永远静默"：断流唤醒的布防此前只挂在感知事件上，而登录完成是 `world_patch` 工具置位的（那条 `login:done` 文本块到达时 `logged_in` 还是 false），登录后服务器不再说话 → 断流计时从未布防。现在**每次世界模型变化**都重评估两个看门狗（`noteWorldChange`；`buildMudTools` 新增 `onWorldChange` 回调，GMCP 与 state 折叠同路径），并给 `armDeadAir` 补上连接门。新增 `tests/runtime-watchdog.spec.ts`（第一个 runtime 级测试）|
| v0.3.0 | 2026-09-12 | 看门狗规则化（用户提出的设计方向）：删除散落的 `armDeadAir/resetDeadAir/armLoginWatchdog/resetLoginWatchdog`，改为声明式 `WatchdogTable`（`runtime/watchdogs.ts`）—— 每条看门狗声明**启动条件**、窗口、触发行为与续期方式，运行时只在固定状态变化点 `reevaluate()`（布防/停表，不重置窗口）与 `touch()`（活动重置窗口）。两个看门狗的条件即"登录了才启动、断线就停止"（`dead-air`: 已连接 ∧ 已登录 ∧ 有 agent；`login-stall`: 已连接 ∧ 未登录 ∧ <3 次）；L2 的 settle/hold 计时器明确**不**入表。新增 `tests/watchdogs.spec.ts`（11 例规则测试）|
| v0.3.1 | 2026-09-12 | W4 第一批 + 登录流程收尾：① **退出 MXP 检测**（实测：登录后不发命令则服务端输出要等约 5 分钟）—— `noteLoginExit()` 在 `logged_in` 翻真时发一次 `Config.loginExitCommands`（缺省 空行 + `look`），actor `system`，每次连接一次、掉线重连复位；② `exec.signal` 接线（`MudToolCallOptions.signal` ← 官方 `ToolRunContext.signal` → `ReplyOptions.signal`，宿主装配与 preset 线两条路径都转发）；③ 硬编码 `COMPLETION_UNTIL` → **活动表** `DEFAULT_ACTIVITY_TABLE` + `activityFor()` + `Config.activityTable`（数据驱动、可覆盖）；④ 新增 `tests/runtime-login-flow.spec.ts`（4 例）+ 活动表/取消信号用例；`exec.concludeTurn` 留待定（§18.11）|
| v0.3.2 | 2026-09-12 | 结算重复与节奏（用户实测）：① **交付水位** `deliveredAbs` —— T1 反射消息 / T2 批次 / 工具应答帧都前移水位，`mud_recall`/`mud_state` 只回看**未投递**的行（此前 `mud_state` 把连接至今全部输出又倒一遍）；② **删掉宿主的"帧首"缓冲** —— 队列节流窗口与武装后到达的行统一由控制器累积，同一批行不再同时留在本帧与下一帧（实测 `look`/`inventory` 的应答里混进旧行与 MXP 文本）；③ **工具调用限速** `Config.toolCallIntervalMs`（缺省 1s，闸门执行，登录流程豁免），管住 T2 连续发起工具调用的节奏；④ 新增 `tests/runtime-delivery.spec.ts`（3 例）+ 限速用例（2 例）|
| v0.3.3 | 2026-09-12 | fullme 人工验证码 = T1 流程（用户定案：由 T1 发、等待期暂停全部投递）：① 新规则 `fullme:prompt`（判据 = 游戏回显的 `robot.php` 地址）+ 动作 `mud_send {cmd:'fullme {captcha}'}` + `ActionSpec.awaitExternal`（命中先挂起）；② 运行时**人工环节** `awaitingHuman`：地址交宿主取图推 UI、**暂停全部投递**、两个看门狗停表 + `requestAgent` 拒绝唤醒、**无超时**；人工页面输入 `fullme <码>` 不直接发出 → 存 `{captcha}` → 挂起命中交 T1 渲染发送；断线重连作废；③ 修**预筛种子 bug**：`^https?://…` 曾推出 seed `https` → `http://…` 的行在预筛就被丢掉（规则永不命中），现在 `?`/`*`/`{` 后的字面不计入种子、顶层 `|` 放弃预筛；④ 新增 `tests/runtime-captcha.spec.ts`（4 例）+ 种子/插值用例 |
| v0.3.4 | 2026-09-12 | fullme **入口改为我们主动发**（用户 6 点实录修正：服务端提醒不可依赖、地址在**应答帧**里、答案 = `halt` + `fullme <码>`）：① 新规则 `fullme:request`（动作 `mud_send {cmd:'fullme'}`，id 导出为 `FULLME_REQUEST_RULE_ID` 单一事实源）+ `fullme:done`（成功句 → `world_patch {fullme_ok:true}`）；② 新看门狗 `fullme-due`（`Config.fullmeIntervalMs`，缺省 270s，0 = 不定时）+ `WatchdogSpec.resetsOnActivity`（窗口语义与"游戏输出"解耦 —— 节拍量的是"距上次 fullme"）；③ **自触发投递** `deliverSelfHits`：无锚点行的命中（定时节拍、帧路径的人工答案）直接造一条 `lane=t1` 反射消息交 T1 渲染，**命令仍取自规则表**（`PerceptionEngine.actionOf` 反查，运行时不硬编码 `fullme`）；④ `lastFullmeSentAt` 在 `onQueueSend` **真正写出** fullme 命令时统一盖章（提醒/定时/人工答案三条路径共用窗口，跳过时按剩余时间续期）；⑤ 修**帧路径丢命中**：地址是 `fullme` 应答帧里的一行（不进待决），人工回填后 `settle()` 无行可投 → 命中会被判成"锚点行已投出"的缺陷丢掉；现在 `pendingExternal` 带 `framed` 标记，帧路径回填后走自触发；⑥ 修**系统流程命令集漏收 `cmds` 序列**：`LOGIN_FLOW_COMMANDS` 只取 `cmd`，答案里的 `halt` 不在集内 → 只读档答验证码会被档位拒绝（现在 `cmd` + `cmds` 都收，两侧逐字一致）；⑦ **MUD 会话不再自称"编码 agent"**：人设改走官方槽 `deployment:persona-prefix` 的 **per-agent 同名替换**（`attachMudPersona`，宿主两条装配路径共有），preset 行只提供 skills/tier/commands 三段 —— 并列追加会让模型同时收到两份人设，而 preset 作用域同名会与 standard 的 `persona` 行撞名抛错；⑧ **帧内命中重复入队**（v0.3.3 引入）：帧内分支先把命中归回合记录/入待渲染队列，`parkExternalHits` 又把"不需要外部值"的命中入队一遍 → 同一条命中被渲染两次。现在 `parkExternalHits` 只负责挂起、把其余命中**返回**给调用方；⑨ `tests/runtime-captcha.spec.ts` 扩到 11 例、`tests/mud-persona.spec.ts` 新增 2 例（真实注册表的 preset → agent 两级作用域）、`tests/watchdogs.spec.ts` 12 例、`tests/login-rules.spec.ts` 12 例；⑩ 新未决项 §18.12（帧内命中在"无 T1 回合在跑"时会被当缺陷丢掉）。**注**：本条的"主动发 + 定时节拍"部分在 v0.3.5 被用户更正（5M 指人物经验值，入口是匹配服务端提醒行）后撤回，仅保留 `fullme:request` / `fullme:done` 两条规则与帧路径修复 |
| v0.3.5 | 2026-09-12 | 用户三定案（fullme 走 login 机制 + 无状态触发直发 + Prompt 经济；其中"fullme 定时节拍"是我误读 5M=经验值为 5 分钟，已全部撤回）：① **fullme 入口 = 与 login 同一机制**：`fullme:request` 命中**服务端提醒行**即由 T1 渲染 `mud_send {cmd:'fullme'}`（人物经验值 5M 后长时间不用会被判机器人，服务端届时提醒 —— **实录原文 `5M后长时间不使用fullme，会被系统判定为机器人。`**，判据就是这一串）；**删除** `fullme-due` 看门狗 / `Config.fullmeIntervalMs` / `lastFullmeSentAt` 窗口与 `WatchdogSpec.resetsOnActivity` / `PerceptionEngine.actionOf`（后两者随之成为无人使用的机制，一并删除，见 §16）；② **直接执行类动作** `ActionSpec.direct`（§7 三条出口）—— `save` 提醒 / 分页提示这类"无状态、无需返回"的触发**不投给 agent**：命中行折叠（`mud_recall` 也不给），动作由运行时立即执行（新增 `MudToolCallOptions.fireAndForget`；`world_patch` 直接落库），actor `system`、危险命令硬边界照旧（`ask` 无审批通道 = 拒绝），人工环节期间不执行；③ **帧内命中收口**（§18.12）：帧分支先分离"待人工"命中（此前挂起的验证码命中会作为 T1 续步被渲染 → 发出 `fullme {captcha}` 空码），再把其余命中归当前回合；**没有回合在跑时留在待渲染队列等下一次反射投递**（用户定案"这些流程可以等"，不另开回合；不再被判成"锚点行已投出"整批丢掉；等待有界 `MAX_QUEUED_HITS = 32`，超限丢最旧并计入 `hitsDropped`）；④ **命令目录改为索引 + 按需查询**：系统提示只注入 `commandsIndexForAgent()`（分类 + 命令 id 约 10 行），新增零发送工具 `mud_help`，删除 `commandsTextForAgent()`（§16）；⑤ **回看缓冲只收可能投递的行**（state 入库行与直接执行行不再作为"尚未投递的输出"倒出）；⑥ 修**分页动作从未生效**（`mud_send` 单体 `cmd` 把空白当空命令拒绝 → 改 `cmds: [' ']`）；⑦ **`exec.concludeTurn` 已定不接**（§18.11）；⑧ 新增 `tests/commands.spec.ts`（7 例）、`tests/runtime-direct-action.spec.ts`（5 例）+ 感知/工具用例，合计 299 例 |
| v0.4.0（设计稿） | 2026-09-12 | **流程化重构（用户主导设计，待实现）**：根因 = "把逻辑步骤寄存在模型回合历史里"（`turnRef` + 命中队列 + 游标 + 帧归属 + 搭车队列），时序一偏就静默卡死、归属一错就串步。① **流程表**（§19）：每条流程 = 显式步骤图，每步 = `driver（可省 = 顺序步）/ action / onEnter / ok / fail / next / retry? / timeoutMs`；`state` 仍留在 trigger，两者不重复；流程表注册为**运行时状态**（diag 可见、每次迁移留痕）；② **判据统一 + 注册期校验**：`GA` 是 `MatchSpec` 的一种 kind（**必须显式声明**在 `ok` 或 `fail`：`ok:[GA]` 即"命令被接受就算成功"），**同一步的 ok/fail 判据集互斥（含 GA 只能出现一边），装配期报错不装配**；arming = 本步 driver(重试) + 本步 ok/fail + **条件分支**后继 driver，"条件分支 vs 顺序兜底"据此区分（MXP 不出现不阻塞）；结果三态 **成功/失败/超时**（无静默）；③ **挂起/唤醒**：命令发出后挂起 = 桥的单槽 pending；判据命中（行匹配 或 GA）= 单出口唤醒（注销 arming + 结算 + 投递下一步，**先投递后唤醒**）；挂起期间新的应答桥请求**当场拒绝 + 留痕**；④ **打断与排队**：规则声明 `interrupts`、流程声明 `priority`（**纯数字直接比大小，normal = 100**；login = 1000 不可打断，fullme = 100 可被打断），`interrupts > priority` 才可打断 → 挂起结算为 `interrupted` + 流程失败收束 + 可选 `onInterrupt` 命令 + 投递事件动作；不可打断 → 排队；流程期间的其它流程入口 → `pending entry` 接续；⑤ **T1 全面重构（§7）**：退化为**无状态动作渲染器** —— 本步认领到的消息带动作请求 → 渲染 tool-call；无请求 → 收束；"是否已渲染"用确定性 call-id + 已有 tool-result 判定；**契约检验 I15（T2 可用）**：不得出现只有 T1 能理解的引用，投递消息必须自洽到 T2 拿到也能自己决定；⑥ **登录流程重写**：五条 login 规则退役 → `name/pass/replace/success/mxp/look` 步骤；`when: !logged_in`；**MXP 探测是可能分支**（`mxp` 条件分支发空行、`look` 顺序步 `ok:[GA]`），"空行 + look"不再由 `Config.loginExitCommands`/`noteLoginExit` 承担；⑦ 删除：`login-stall` 看门狗（每步 timeout 接管）、命中积压 / 回合记录 / `takeTurns` 游标 / `activeTurnRef` / 帧归属 / 搭车队列 / `MAX_TURNS`（§16）；⑧ 不变量扩到十五条（§1：I10 单流程互斥 / I11 单挂起 / I12 挂起闸门+单出口 / I13 判据统一与注册期互斥 / I14 打断档位 / I15 T1 契约检验）；⑨ 新切片 **W5**（§17，状态：设计定稿待实现），测试计划见 §13.6 |
| v0.4.0（流程语义定稿） | 2026-09-13 | **作者逐条确认 login 语义**：① `success` 进入判据 = **等成功句**（服务端不响应即异常）；② 终态**空命令必有 GA**，无响应即异常 → 保留 `ok:[GA]`（超时失败收束）；③ **"本步结果 = 下一步的新文本"** → `name`/`pass`/`replace` 一律**不写 `ok`**："请输入密码"只写在 `pass.driver`、"替换人物"只写在 `replace.driver`、"目前权限/重新连线"只写在 `success.driver`（写重复的 `ok` 会抢在条件分支之前命中、把提示行消费掉 → 走不到下一步）；④ **断线重连一律重新跑整套登录**（`logged_in` 随连接建立复位，代码路径已确认）；⑤ **失败不设恢复路径** → `LOGIN_FLOW.failPolicy = { notify: 'none' }`：用户名/密码是人工给的、密码错还会连带断连，只写日志 + 决策记录，**不唤醒 T2**。代码：`config/flows.ts`。测试：`flow-login.spec.ts` 的"四步图"断言改为校验"三步都没有 `ok`" + `failPolicy`，"分支超时"用例改为"本步超时"（`name` 不再有 GA 判据 ⇒ 等不到提示行时停在 `awaiting-result`），分支阶段计时器用例移到 `flow-interrupt.spec.ts`（那里仍有 `ok:[GA]` + 条件后继的形状）—— 全包 **304 例全绿** |
| v0.4.0（login 精简） | 2026-09-13 | **作者定案：login 精简为四步 + 放开空命令**。① **流程表**：`name / pass / replace(可能) / success(终态)` —— 删掉 `mxp` 与 `look`；`success` 的进入判据 = "已进入游戏"的成功句（`目前权限：(player)` 等；条件分支），进入即 `patch{logged_in:true}` 并**发空命令**（`mud_send { cmd:'' }`，`ok:[GA]`，`next` 空 = 终态）。② **空命令成为合法命令**（作者：其他客户端也允许）：`network/response.ts` 的 `sendAndAwait` 只在"一条命令都没有"时拒绝（原判据是"全为空即拒绝"）；`agent/tools.ts` 的 `mud_send` 允许 `cmd:''`（发空行），只有 `cmd` 不是字符串（既没 cmd 也没 cmds）才算参数错误；空命令照旧进 `flowCommands`（工具闸门的登录豁免判据）。③ **修 `ownCommandLive` 生命周期 bug**（新流程暴露的实测缺陷）：它此前只在"判定节点"分支复位、**action 步迁移时不复位** → 上一条命令的 GA 会把"命令还没写出"的新步（`ok:[GA]`）误判成成功；现在 `enterStep` 每次迁移都复位（与 §19.3 的写法一致）。④ 测试：`flow-login.spec.ts` 重写为 9 例、`tools.spec.ts` 与 `loop-sim-login.spec.ts` 跟随新契约 |
| v0.4.0（实测） | 2026-09-13 | **第一步：量清现行投递在官方 loop 下的形状（只改文档 + 测试脚手架）**。新增 `tests/loop-sim.ts`（**官方 loop 最小忠实模拟器**：拖动器 `while (await turn())`、`claim` 语义、回合首步空认领即收束、`additionalContexts` → `next-step`、`concludesTurn` 收束、插件 lane 记忆，逐条标源码出处）+ `tests/loop-sim-login.spec.ts`（3 例）。**实测**（login 全链）：现状 `followup` = **3 回合 / 6 步 / 6 次模型请求**（每步一次空续步，一步一回合）；提议 A `defer` = 1 回合 / 4 次；提议 B `defer`+`concludeTurn` = 1 回合 / 3 次；三例 `t2Calls = 0`（流程期间不落到真实 LLM）。结论与落地设计写入 §19.6.1，模拟器与"回合/步骤账目必须在它上面量"的规矩写入 §13.6，投递通道切换登记为 §19.7 待定 1（**待作者审定后编码**）|
| v0.4.0（实现·续） | 2026-09-13 | **作者四条定案落地**：① **MXP 发任何命令都能跳过** → `mxp` 步改发 `look`（桥的空命令判据不放宽，仓库里"空行退 MXP"的注释/用例标题一并改正）；② **GA 与其它判据同权**（文档表述改正，代码本就如此）；③ **`succeedStep` 只是里程碑** → 顺序兜底增加"结算之后"执行点（`noteSettle` 返回动作 + 运行时 `queueFlowActions` 投递）；④ **分支阶段也要计时器** → `succeedStep` 后按 `step.timeoutMs ?? flow.timeoutMs` 重新布防（文案"等待后继判据超时 (Nms)"），`armTimer` 增加 `why` 参数。**打断/排队接线**：`ActionSpec.interrupts`（规则声明面）+ 运行时 `admitRuleHits`（批次内打断准入）+ `CommandResponseController.interruptInFlight`（在途/排队请求当场结算为 `ReplySettle='interrupted'`，工具拿到 `{ok:false, settled:'interrupted'}`）+ `drainFlowQueue`（流程结束后排队动作出队投递）。测试：新增 `tests/flow-interrupt.spec.ts`（7 例，含 login=1000 不可打断 + 超时出队 + 序列不再发剩余命令），`tests/flow-login.spec.ts` 的 MXP 用例改为全链（mxp→look→终态 look）—— 全包 **299 例全绿**（此后 `loop-sim-login.spec.ts` 3 例 → 302 例）。§11 增补**提议的 `FULLME_FLOW`**（供作者审定，未实现）与实施清单；§19.7 重写为"已定案 5 条 / 待定 3 条" |
| v0.4.0（T2 限流） | 2026-09-13 | **作者定案：限流只做"通道豁免"+"T2 投递限流"**（不做每步调用配额 —— 作者认为那容易导致异常）。① **限速豁免判据从登录态改为通道**：`tool-gate.ts` 增加 `currentLane?: () => 't1'\|'t2'\|undefined`，`t1Call = currentLane() === 't1'` 与 `systemCall = loginFlow() && 命令属登录/流程命令集` 任一成立即**不等**；通道读数由选路侧在 `agent/pre-step` 广播（`OwnedLaneRoutingOptions.onLane`；`index.ts` 的 `attachPolicy` 用局部变量把两者串起来）。原实现只按 `loginFlow()` 豁免 —— 登录一完成就是 false，导致 T1 的规则动作与流程步动作（fullme 答案）被无谓推迟 1 秒。② **T2 投递限流**：新增 `Config.t2DeliverIntervalMs`（缺省 `DEFAULT_T2_DELIVER_INTERVAL_MS = 2000`）；`settle()` 的批次路径在距上次 T2 投递不足间隔时**不投**（行留待决、`scheduleSettle(差额)` 延后），控制消息投出时记一次时刻；**T1 动作投递 / 帧内命中的动作投递 / 控制消息本身都不受限**。动机：实测登录后 T2 接管 1 秒一条刷查询（look/hp/score/skills）。测试：`permission.spec.ts` 增"限速豁免: T1 通道即使已登录也不等; T2 照常等"（26 例）、`runtime-delivery.spec.ts` 增"T2 投递限流: 间隔内不投 T2 批次; T1 动作照常投; 到期合并投出"（4 例）—— 全包 **312 例全绿** |
| v0.4.0（defer 通道落地） | 2026-09-13 | **投递通道切换实现**（作者批准的 §19.6.2 三条判据）。① **判据 A**：`session-runtime` 新增 `inFlightTools` 计数与 `deferSlot` 槽，投递统一走 `sendDelivery` —— 工具在途 ⇒ 入槽（`debug` 记 `投递改为 defer`），否则官方 `followup`。② **包装器接线**：`agent-bridge` 新增 `MudDeliveryChannel`（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries`/`shouldConcludeTurn`），`attachMudTools(..., channel?)` 在 `execute` 前后 begin/end、结果提交前逐条 `exec.deferContext`、`result.ok && shouldConcludeTurn(callId)` 时 `exec.concludeTurn()`；`index.ts` 的 `mountToolsForTier` 把 `runtime` 当通道传进去。③ **判据 B**：`deliverySizes`（每条投递的动作数）+ `parseDeliveryCallId`（`mud-<delivery>-<index>`；**T2 自己的调用 id 解析失败 ⇒ 永不可收束**）+ 四项收束条件（最后一条 ∧ 槽空 ∧ 无待投递动作/独立投递/流程排队 ∧ **流程机空闲**）。④ **判据 C**：只在成功结果上收束；失败/超时/打断什么都不做（打断的事件动作随 `interrupted` 结果 defer）。⑤ **模拟器升级为"仿真官方包装器"**：`loop-sim` 不再靠测试内建模，`loop-sim-login.spec.ts` 量到**真行为账目 = 1 回合 / 3 步 / 3 次模型请求 / 0 空续步**（`deferred=2`、`concludedTurns=1`），与落地前基线（3 回合 / 6 次）的对照见 §19.6.1。⑥ 新增 `tests/runtime-defer.spec.ts`（4 例）；顺带**看门狗日志降噪**（`touch()` 的窗口重置静默布防，`watchdogs.ts` 的 `arm(entry, quiet)`）。⑦ **实测抓到的缺口并修复**：接线只在宿主路径（`attachMudTools`），而生产跑的是 **preset 路径**（`preset-agent.ts` 有自己那份 `defineTool` 包装器）⇒ `beginToolCall()` 从未被调用、defer 完全失效（实测日志仍是"独立投递 → 新回合"，账目停在 3 回合 / 6 次）。修法：抽出 **`runWithDeliveryChannel`**（两条路径共用一份接线），`preset-agent` 经 `MudAgentKit.channel(sessionId)` 取该会话运行时的通道；`preset-agent.spec.ts` 新增两例钉住（接线顺序 `begin→end→take→conclude?<callId>`、失败时只 defer 不收束）—— 全包 **316 例全绿** |
| v0.4.0（看门狗时机） | 2026-09-13 | **作者定案：`dead-air` 布防判据从"`logged_in` 置真"改为"`logged_in` ∧ 无活跃流程"** —— 一条条件同时实现两个目的：① 布防推迟到 **login 流程收尾之后**（`logged_in` 可能被 **GMCP** 提前置真：`GMCP.System {site}` 是 pkuxkx 的登录成功通知，`world.ts:130-147`，早于 `success` 步的 `onEnter.patch`；实测日志里 dead-air 正是在登录尚未收尾时就开始计时的）；② **活跃流程期间看门狗停表**（流程可能等很久才有结果，期间的唤醒归流程自己的计时器）。实现：`dead-air.active()` 增加 `this.flow.state() === null`；新增 `FlowRuntimeOptions.onTransition`（进入某步/收束/失败/复位时通知运行时 `noteWorldChange()`），否则流程起停不会触发重评估。`success` 步的 `logged_in` 置真**保留**（作者要求：防 GMCP 变化，作为权威兜底）。测试：`runtime-watchdog.spec.ts` 新增"活跃流程期间不布防断流；流程收束后才布防"（探针流程 + 假连接捕获 sink 喂行）—— 全包 **310 例全绿** |
| v0.4.0（归属加固） | 2026-09-13 | **桥结算归属：布尔标记 → 按命令比对**（作者批准的"GA 结算携带命令"小改）。① `network/response.ts`：`onSettle(kind, text, cmds)` —— `notifySettle` 透传 `reply.cmds`（**被这次结算关掉的命令**），error/timeout/abort/interrupted/ga 各条路径都带上。② `runtime/flow-runtime.ts`：删掉 `ownCommandLive` 布尔标记，改为 `ownCommands: Set<string>` —— `allowBridgeRequest`/`noteOwnCommandWritten` 放行命令时记入（插值 + trim），`noteSettle(kind, text, cmds)` 用"有交集"判定归属、通过后**消费**（同命令的重复/迟到 GA 不二次结算），`enterStep`/收束/复位/释放时清空；`cmds` 缺省时退化为旧语义（兼容）。③ 日志升级为**点名命令**并加 `mask` 脱敏（`redactSecrets`：密码 + 人工外部值 ≥3 字符）——实测发现点名日志曾把密码打成明文，已修并有测试钉住。④ 新增 `tests/flow-ownership.spec.ts`（本步命令生效 / 别命令点名拒绝且不消费 / 序列任一条命中即算本步 / 缺省 cmds 兼容 / mask 脱敏）。**意义**：一个步骤发多条命令（fullme 的 `['halt','fullme {captcha}']`）时，别的命令的 GA 不会再串结算本步 |
| v0.4.0（投递形态定名） | 2026-09-13 | **作者定名：投递形态 =「原文投递 / 动作投递」**（纯命名，机制与判据一字未动）。① 定义：**原文投递** = 消息体带触发段原文 + 动作请求（T1 规则命中 / 流程步动作）；**动作投递** = 无原文可带、只有动作请求（帧内命中 / 人工回填 / 结算驱动 / 排队出队）；形态只决定"消息里有没有原文"，与投递通道（`followup` / `defer`）**正交** —— 旧称"反射消息 / 帧内独立投递 / 规则反射"全部废止，映射写入 §2 与 §5。② 代码侧只改字面：`session-runtime.ts` 日志 `[感知] 原文投递 N 行 + M 动作` / `[感知] 动作投递 N 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)`、决策栏理由 `T1 原文投递` / `T1 动作投递`，`flow-runtime.ts`/`index.ts`/`perception/split.ts` 的注释同名化。③ 文档：§2 新增"投递形态"术语行、§5 增两条（形态定义 + 形态与通道正交）、§12 日志表列全四条投递日志（含 `投递改为 defer`）。测试 **316 例全绿**，`tsc --noEmit` 干净 |
| v0.4.0（fullme 流程定稿） | 2026-09-13 | **作者逐条审定 fullme 流程（五步）**：① 流程表 `request → [stale \| prompt] → answer → success`（§11）；`request` **无 ok**（本步结果 = 下一步的新文本），fail = 实录"刚刚用过"句（时长动态，`[^。]*` 通吃"几分几秒 / 几秒"，总计 15 分钟），后继两条条件分支；② `stale`（实录：上一轮未完成提示）**三连发 `fullme 1`** 才真放弃，以 GA 判定并以**失败收束**收场（复位、不叫 T2）；③ `prompt` 用**新工具 `mud_captcha`** 取图 + 弹窗，判据是新的 **`{ kind:'tool' }` 工具结果判据**；地址经流程槽 `{captchaUrl}`（步上 `capture` 声明）交给工具；④ `answer` 三次答错重来（`retry { attempts:3, on:['fail'], action: mud_captcha{…} }`：**在原步内自环** —— 清空 `{captcha}`、重解析图片并弹窗带 `{lastFail}` 失败原文、重新挂起等人工，**不重置本步计时器**；`answer.timeoutMs = 180000` 是**本步总预算**（等人工 + 重来 + 收结果）＝图片有效期，到点即本轮失败）；⑤ **三种收场（取图失败 / 答错 3 次 / 人工超时）都由下一轮的 `stale` 兜住**（答错 3 次与"三连放弃"等价 ⇒ 下一轮不进 `stale`），运行时不另记状态；⑥ `success` 发 `hpbrief`（`ok:[GA]`）补状态，`failPolicy: { notify:'none' }`；⑦ 声明面扩展：`MatchSpec` 增 `tool` kind 与可选 `why` 文案、`FlowStep` 增 `capture`、`retry` 定稿为 `{ attempts, on?, action? }`（`attempts` = **总尝试次数含首次**）、占位符分三类（运行时值 / 内建 `{lastFail}` / `capture` 槽）并新增注册期校验（§19.1）；**不引入 `humanTimeoutMs`/`humanWaitMs`**（作者同日修正：人工环节沿用本步 `timeoutMs`）；⑧ 推进规则：`retry.on:['fail']` = **原步内**答错重来且**不重置计时器**、人工环节**不判行且计时不停**、`resumeHuman()` 回到 awaiting-result 不重布防（§19.2/§19.3）。文档：§11 定稿流程表 + `FlowSpec` + **8 项实现清单**（含流程路径人工环节三处修复）；§19.7 把"投递通道"（已落地）与 fullme 转为已定案；§16 增四条删除项（三条 fullme 规则 / 运行时取图职责 / `fullme_ok`）。**代码待实施** |
| v0.4.0（fullme 流程落地） | 2026-09-13 | **按 §11 定稿实现 fullme 流程（代码 + 测试）**：① `config/flows.ts`：`FULLME_FLOW` 五步 + 常量（`FULLME_REMINDER_TEXT`/`FULLME_STALE_TEXT`/`FULLME_OK_TEXT`/`FULLME_WRONG_TEXT`/`FULLME_COOLDOWN_PATTERN`/`FULLME_URL_PATTERN`/`FULLME_URL_CAPTURE`）+ `defaultFlows = [LOGIN_FLOW, FULLME_FLOW]`；`FlowMatch` 增 `{ kind:'tool', outcome }` 与可选 `why`，`FlowStep` 增 `capture`，`retry` 定稿 `{ attempts, on?, action? }`；`validateFlows` 增四类校验（tool 判据需动作、占位符三类、retry 声明、capture 槽名唯一）。② `runtime/flow-runtime.ts`：流程实例槽（`capture` 抽取 + 内建 `{lastFail}`）+ `slotNames()`、`noteToolResult(stepId, ok)`（工具结果判据，失败优先、失败**不走重试**）、`tryRetry`（**原步内重试**：投 `retry.action` → 清 `awaitExternal` 槽 → 写 `{lastFail}` → 重新挂起；**不重置计时器**）、`awaitExternal` 步**照常布防计时器**（人工等待并入本步预算）、**人工环节不判行**、`refreshEntries()`（`when` 随 world 翻转）。③ `runtime/session-runtime.ts`：投递记录 `deliveryRules`（call-id → 动作 `ruleId` → 步骤 id）→ `noteToolResult`；`fillSlots` 投递前插值；`queueFlowActions` 改为**先投递后挂起**；`exitHumanWait` → `flow.resumeHuman()` + **动作投递**；`syncHumanWait`（流程收束/超时后退出人工环节）；取图职责迁出（`sink.captcha` 改为"推已解析图片 + note"）；退役 `Config.captchaPatterns`/`extractCaptchaUrl`。④ `agent/tools.ts`：新工具 **`mud_captcha`**（围栏 + 抓 `robot.php` + 取 `<img src>` + 推送宿主 + `{ok,image}`），三档都注册（`permission/tiers.ts`）。⑤ `agent/agent-bridge.ts`：`MudDeliveryChannel.noteToolResult`，在 `endToolCall()` **之前**喂回结果（判定产出的投递仍随本结果 defer）。⑥ 退役 `fullme:request`/`fullme:prompt`/`fullme:done` 三条规则与 `index.ts` 里的 `fullme:*` 过滤。⑦ 测试：新增 `tests/flow-fullme.spec.ts`（11 例）+ 重写 `tests/runtime-captcha.spec.ts`（7 例，走**真工具包装器**：defer/工具结果/人工回填/重试/预算）；`rule-coverage`/`runtime-direct-action`/`permission`/`tools` 跟随调整 —— 全包 **327 例 / 30 文件全绿**，`tsc --noEmit` 干净。⑧ 与定稿的两处措辞差异（实现为准）：success/答错句用 `text includes`（比整行正则宽容，服务器尾随空白不影响）；取图**解析在工具**、**UI 推送在宿主**（页面在宿主侧，工具只回结果） |
| v0.4.0（实现） | 2026-09-13 | **W5 落地（login 流程跑通）**：① `config/flows.ts`（新）—— `FlowMatch`（`regex`/`text`/`ga`）/`FlowStep`/`FlowSpec` + `LOGIN_FLOW`（`priority:1000`、`when: !logged_in`）+ `validateFlows`（ok/fail 互斥含 GA、`next` 引用、id 唯一、`awaitExternal` 占位符）+ `flowCommands()`；② `runtime/flow-runtime.ts`（新）—— arming（本步 driver + ok/fail + **条件分支后继 driver**，**同批行优先**）、判定顺序（失败 → 介入判据分支 → ok → 顺序兜底 → 终态）、`enterStep`/`succeedStep`/`retryStep`/`finishFlow`/`failStep`、`interrupt`/排队/pending entry、`diag` 状态；③ **桥归属**（§19.3；v0.4.0 归属加固中升级为按命令比对）—— GA/until/超时/abort 只在本步声明并放行过的命令带来时才被接受，否则上一条命令的 GA 会误结算下一步（实测症状）；④ T1 重写为**无状态动作渲染器**（读 `source.actions` + `delivery`，call-id = `mud-<delivery>-<index>`，已有同 id `tool-result` ⇒ 不重复渲染）；⑤ `MessageSourceMap['mud-owned']` 去掉 `turnRef`、增 `actions`/`delivery`；`ownedGameMessage(text, lane, sid, {actions, delivery})`；⑥ 运行时：`pendingActions`/`deliverySeq`/`standalone`（帧内命中与人工回填 = **独立投递**，不再"等下一次搭车"）、`settle()` 单流切分带动作、`exitHumanWait` 分"待决路径/帧路径"；⑦ 删除 `turns`/`takeHits`/`activeTurnRef`/`deliverSelfHits`/`noteLoginExit`/`Config.loginExitCommands`/`login-stall`/五条 `login:*` 规则（§16）；⑧ 测试：`tests/flow-login.spec.ts`、`tests/t1-adapter.spec.ts` 重写（8 例）、`tests/runtime-captcha.spec.ts` 改写（8 例）、`tests/rule-coverage.spec.ts` 去 login 样本；⑨ 作者三条定案（2026-09-13）：**MXP 发任何命令都能跳过**、**GA 与其它判据同权**、**`succeedStep` 只是里程碑**（流程收束在终态步）→ 顺序兜底增加"结算之后补跑"执行点 |

---

## §16 删除清单

**代码（V10 实施时删除）**：`matchDry`（生产路径）、`resolveLines`、`cacheLines`/行集表、`OwnedLaneRegistry`（v8 已删）、`t2Selection`（v8 已删）、占位 prompt（v8 已删）、`FORBIDDEN_COMMANDS`（→ 策略表）、`COMPLETION_UNTIL` 硬编码（→ 活动表）、进程级 matcher 单例、`trimObservation` 的"上下文裁剪 + 身份裁剪"双重职责、`commandsTextForAgent()`（全量命令语法注入系统提示 → 索引 + `mud_help` 按需取，v0.3.5）、`fullme-due` 看门狗 + `Config.fullmeIntervalMs` + `WatchdogSpec.resetsOnActivity` + `PerceptionEngine.actionOf`（v0.3.4 引入、v0.3.5 撤回：fullme 入口是匹配服务端提醒行，不是定时器）。

**代码（v0.4.0 实施时删除 —— 流程化重构的删除项）**：

| 删除项 | 原因 | 状态 |
|---|---|---|
| `turnRef` + 回合记录 `turns` + `takeHits` 游标 | 动作请求自包含在投递消息里，T1 不查运行时 | ✅ 已删 |
| 帧归属：`activeTurnRef` + "帧内命中追加到当前回合" | 结果判定改由 arming 判据 + 桥挂起给出，不再猜帧归属 | ✅ 已删 |
| 命中待渲染队列的"搭车" + `MAX_QUEUED_HITS` + `MAX_TURNS` | 没有"等下一次投递搭车"这件事：流程步有挂起、一次性动作直达 T1 | ✅ 已删（帧内命中改**动作投递**）|
| `login-stall` 看门狗 | 流程每步 `timeoutMs` 给出明确的"超时"结局（I4） | 🟡 看门狗已删；`timeoutMs` 已实现 |
| `deliverSelfHits`（自触发命中） | 人工回填后的答案成为流程 `answer` 步的正常投递 | ✅ 已删（fullme 流程已定稿，§19.7.8）|
| `fullme:request`/`fullme:prompt`/`fullme:done` 三条 event 规则 | 升级为流程 `fullme` 的五个步骤（`request`/`stale`/`prompt`/`answer`/`success`）—— 驱动句/动作/判据只在流程表写一份 | ✅ 已删 |
| 运行时取图职责：`sink.captcha(robotUrl)` 取图 + `Config.captchaPatterns` + `extractCaptchaUrl` | 解析（围栏 + 抓页 + 取图）改由 **`mud_captcha` 工具**承担（地址由流程步 `capture` 槽给出）；宿主只把解析结果推成对话框 | ✅ 已删 |
| 世界标志 `fullme_ok`（`fullme:done` 的 `world_patch`） | 全仓无人读；终态步改为发 `hpbrief` 补状态 | ✅ 已删（应答折进 world 见 §19.7 待定 2）|
| `login:name`/`login:pass`/`login:replace`/`login:done`/`login:error` 五条 event 规则 | 升级为流程 `login` 的步骤（驱动句/动作/判据只在流程表写一份） | ✅ 已删（`LOGIN_BOUNDARIES`/`LOGIN_FLOW_COMMANDS` 同批删除）|
| `Config.loginExitCommands` + `noteLoginExit()`（登录收尾"空行 + look"） | 收尾变成流程终态步 `success`：发**空命令**（顶开服务端 + 跳过 MXP 检测），不再发 `look` | ✅ 已删 |
| `LOGIN_FLOW_COMMANDS`（由规则反推的系统命令集） | 流程命令直接声明在流程表里；权限口径改为"流程步命令属系统流程"（§19.1） | ✅ 已删（改为 `flowCommands(defaultFlows)`）|
| 桥的"静默窗结算"用于流程 | 流程结果只有成功/失败/超时（I4）；静默窗不再是流程结局 | ✅ 流程侧已不认 `silent`（桥仍保留静默兜底给一次性动作）|

**文档（已删除，内容并入本文档）**：`packages/mud-core/REFACTOR-V7.md`、`packages/mud-core/REVIEW-V7-ISSUES.md`、`packages/mud-core/REFACTOR-V9-permissions.md`、`.trae/documents/mud-preset-refactor-plan.md`。

**待清理（不阻塞）**：源码注释中对旧文档编号的引用已在本版一并改指向本文档章节；新增注释一律使用 `doc/ARCHITECTURE.md §N` 形式，不再引入"机制 A/D"之类内部代号。

---

## §17 交付切片

| 切片 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **W1 行级化** | §4 每会话感知引擎 + 状态持久（规则语义不变） | 现有用例全绿 + 跨文本块多行用例 | ✅ 已实现 |
| **W2 hit 渲染 + 单流切分** | §5 §7；删除 `resolveLines`/行集表/`matchDry` | 不变量用例（拼接==完整流）+ 表驱动"命中必渲染" | ✅ 已实现 |
| **W3 preset 化 + 权限档位** | §9 + §10 | preset 门控用例；三档 × 动作矩阵（含 T1 动作 deny） | ✅ 已实现：§10 = `tests/permission.spec.ts`（26 例，三档 × 动作 × actor 矩阵 + 闸门短路 + 投影折叠）；§9 = `tests/preset-agent.spec.ts`（8 例：组装期注册 / 执行期按 agent 解析 / 未绑定拒绝 / 提示按 agent 求值 / 组合文件） |
| **W4 桥与观测收尾** | §8（exec.signal ✅ / 活动表 ✅ / concludeTurn **已定不接** §18.11 / 分页 ✅ `pager:continue` 直发）+ §12/§13（runtime 脚手架 ✅：`watchdogs.spec.ts`、`runtime-watchdog.spec.ts`、`runtime-delivery.spec.ts`、`runtime-captcha.spec.ts`、`runtime-direct-action.spec.ts`、`mud-persona.spec.ts`、`commands.spec.ts`；`runtime-login-flow.spec.ts`/`login-rules.spec.ts` 已随 v0.4.0 删除 → 由 `flow-login.spec.ts` 接管） | 端到端：登录 ✅（v0.4.0 流程表，见 `flow-login.spec.ts`）、fullme ✅（提醒行 → 直发 → 人工，见 §11）、`dazuo`（活动表已数据化，待实测）、分页 ✅（直发，待实测） | ✅ 基本完成 |
| **W5 流程化重构（v0.4.0）** | §19 流程表 + arming/挂起/唤醒/打断/排队；§7 T1 退化为无状态动作渲染器；§8 桥承担挂起/唤醒；§1 新增 I10–I15；§16 删除回合记录/帧归属/搭车/`login-stall` | 验收（§13.6）：流程机单测全绿（arming/文本优先/冲突取首/超时/打断/排队/单流程互斥/挂起闸门/pending entry）+ T1 契约测试（含 **T2 可用性**）+ login 全链（正常/用户名不存在/密码错/断开）+ fullme 全链（含被打断） | 🟡 **已落地大半**（2026-09-13）：`config/flows.ts` + `runtime/flow-runtime.ts` + `LOGIN_FLOW`（含 MXP 分支全链）+ 桥归属 `ownCommandLive` + T1 无状态动作渲染器 + 帧内独立投递 + **结算后补跑顺序兜底** + **分支阶段计时器** + **打断/排队接线**（`ActionSpec.interrupts` / `interruptInFlight` / `drainFlowQueue`）+ **官方 loop 模拟器**（`loop-sim.ts` / `loop-sim-login.spec.ts`，量出"一步一回合 + 空续步"并给出 defer 提议的账目）；`flow-login.spec.ts`（9）/`flow-ownership.spec.ts`（5）/`t1-adapter.spec.ts`（8）/`flow-interrupt.spec.ts`（8）/`loop-sim-login.spec.ts`（1，真行为账目）/`runtime-defer.spec.ts`（4，投递通道 + 收束判据）/`preset-agent.spec.ts`（15，**两条装配路径都接通道**）/`runtime-watchdog.spec.ts`（5）全绿，全包 316 例。**未落地**：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world（§19.7 待定）。投递通道切换（§19.6.2）与 fullme 流程（§11）均已落地 |

> W1/W2 已随 v0.1 落地：新增 `perception/engine.ts`（L1）、`perception/split.ts`（L2 纯函数）、
> T1 改为 hit 渲染器（`trigger-llm/adapter.ts`）；桥删除行集表并对齐 GA 边界接线
> （`runtime/connection.ts` 新增 `onBoundary`，此前 GA 主边界从未送达桥）。

---

## §18 未决事项与风险

1. **浏览器 roster 明文密码**：是否改走 host 侧凭据服务（§10）。
2. **终端大流量文本走自有 `/mud/ws`**（不进 session 事件流）是否接受；官方无"非持久会话 UI 通道"。
3. **`/mud/*` HTTP 路由**是否迁移到官方 Typert Remote 服务。
4. **只读档是否允许 T1**（建议：允许但动作 `deny`）。
5. **危险命令清单来源**（表 + Config 覆盖）。
6. **逐次升级语义**（`ask` 批准 = 仅此一次 vs 提升会话档位；建议前者）。
7. **preset 化已定（方案 A1：部署根 + host 侧 `select`）**：不动 harness（`SessionCreateRequest.agentPreset` 的浏览器透传不再需要），改用官方 `ctx.agentPresets.select(agent, 'mud-player')`（仅空白会话可切）。部署两条（**profile patch，不进 bundle**）：给 `agent-presets` 行加 `roots`（指向本包 `packages/mud-core/presets`，`trust: system`）、给 `mud-core` 行加 `agentPreset: mud-player`；`agent-presets` 是**整份 config 替换**，务必带上必填的 `default`（见 §9 的片段）。未配置 roots 时 `select` 报 `agent-preset/not-found` → 日志留痕 + 回落宿主侧装配，不静默。
8. **旧 MUD 用户迁移**（会话无存储 preset）→ 删除重建（删除即归档，见 §11）。
9. **preset 模式下 §10 可见性层退化**：preset 作用域共享一套工具，"按档注册不同工具集"在 preset 模式不可行（档位只剩强制层 + 提示文本）；preset 模式还让"档位切换即时反映到模型工具列表"失效。要严格可见性就把 `agentPreset` 留空走宿主侧装配 —— 两条路径都实现且都可用，取舍留给部署。
10. **档位是否允许逐次升级**（`ask` 批准 = 仅此一次 vs 提升会话档位；建议前者，与 §10「agent 永不自提权」一致）。
11. **`exec.concludeTurn()`：已定「不接」**（用户 2026-09-12）。理由保留在此备查：T1 回合在适配器取空命中时本就收束，接线只省一次续步；而 T2 下"哪个工具调用该结束回合"没有客观判据（`look` 之后该不该结束？说不清）。W4 不再接此开关。
12. **帧内命中在"无 T1 回合在跑"时的归属 —— 已由 v0.4.0 的流程机制取代（本项关闭）**：v0.3.5 及以前，帧行不进待决缓冲，命中只能"追加到当前回合"或"等下一次投递搭车"，归属靠猜（`activeTurnRef`）。v0.4.0 起：① 流程步的应答由**本步 arming 判据 + 桥挂起**判定，完全不依赖帧归属（§19.3）；② 一次性动作（`save`/分页）走 `direct` 直发，不入桥；③ 流程挂起期间其它需要桥的请求被闸门拒绝并留痕（I12）。因此"归属猜错→丢命中/串步"这一整类问题不再存在。
13. **`fullme:request` 判据已实录**（用户 2026-09-12 给出原文 `5M后长时间不使用fullme，会被系统判定为机器人。`）：判据 = 这一串本身（作为流程 `fullme/request` 步的 driver，见 §11/§19）。
14. **流程化的待放宽项（v0.4.0 之后）**：① **单挂起（I11）** —— 本版按"一条流程同时最多一个挂起步骤"实现（桥单槽），将来若出现"同一步骤需要并发多条命令"的需求再放宽为多挂起；② **流程内部并行分支** —— 当前分支是"命中哪个后继 driver 就走哪条"，同一时刻只推进一条路径；③ **跨会话流程编排**（多用户协同）—— 明确不在范围内。
15. **打断的第一版范围**：`onInterrupt` 只声明"打断时要先发的直发命令"（如练功的 `halt`）；"打断后自动重试"、"打断原因的模型判定"留给 T2 决策一次，不自动重试。
16. **W5 落地后新增的待定项集中在 §19.7**（作者 2026-09-13 已定：MXP 发任何命令都能跳过 / GA 与其它判据同权 / `succeedStep` 只是里程碑 / 打断接线 / 投递通道 `deferContext` / fullme 流程五步；仍待定：`pendingEntry` 端到端用例、`hpbrief` 应答折叠进 world、待实录原文核对）。

---

## §19 流程表与流程运行时（step 驱动）

**目标**：把"多步确定性流程"（登录、fullme、练功这类长命令交互）从**模型回合历史**里拿出来，做成**显式的步骤表 + 运行时状态**。
**根因回顾**：v0.3.5 及以前，步骤的真相被寄存在"回合记录 + 命中队列 + 帧归属"里 —— 时序一偏就静默卡死，归属一错就串步。本设计让"该有状态的地方有状态（流程运行时），该无状态的地方无状态（T1）"。

### 19.1 声明（流程表）

```
flow <id>
  priority    数字。直接比大小（不打分档枚举）：normal = 100；越大越不可打断
              login = 1000（无人可打断）；fullme = 100（战斗类事件可打断）
  when        入口前置条件（读 world）：**满足它才 arm 入口 driver**
              login: !logged_in（已登录不再 arm 登录入口）；fullme: logged_in
  step <id>
    driver    驱动句判据（MatchSpec；服务端提示行）。**省略 = 顺序步**：上一节点成功后立即执行
    action    工具调用声明：{ tool, args }（可含 {name}/{pass}/{captcha} 与流程槽占位符）
              可选 awaitExternal: ['captcha'] → 该步**先挂起动作**、进人工环节等人工补值
              **三者至少其一**：`driver`（条件进入）/ `action`（发命令等结果）/ 终态（全空）
    capture   可选：{ 槽名: 正则 } —— 把**本步命中行**的抽取结果存进流程实例槽（如 captchaUrl）；
              答错重试不重新抽取，沿用首次抽到的值
    onEnter   可选：进入本步即执行的副作用（`patch` 落 world / `direct` 直发命令），不等结果
    ok        本步成功判据（MatchSpec[]）—— **`GA` 是一种判据，必须显式声明**（见下）
    fail      本步失败判据（MatchSpec[]）—— 同上；**ok 与 fail 不得同时声明 GA**
    next      直接后继步骤 id 列表（**显式列出**；可多分支；**空 = 终态**）
              · 带 driver 的后继 = **条件分支**（先 arm，命中即走）
              · 不带 driver 的后继 = **顺序兜底**（本节点成功后就执行，不等待）
    retry     可选：{ attempts, on?, action? } —— 命中 `on`（缺省 ['driver']）里的判据时
              **在原步内重试**：投 `action`（缺省 = 重发本步动作）→ 清空本步 `awaitExternal` 的槽
              → 重新挂起等人工；`attempts` = **总尝试次数（含首次）**，用尽才算失败；
              **不重置本步计时器**（时间预算是"一步总计"：fullme 的 answer = 3 分钟）
    timeoutMs 本步超时（缺省取流程级/Config 缺省；到点 = 超时结局）。
              **人工环节没有单独的超时字段** —— 等人工期间就用本步这一份预算
    onInterrupt  可选：被打断时要先发的直发命令（如练功的 halt）
  onSuccess   { patch?: 落 world; commands?: [走工具路径的命令]; direct?: [只发不等结果的直发命令] }
              —— **流程整体成功时**执行（终态节点之后）
  failPolicy  失败/超时出口（缺省：留痕 + 交 T2 决策一次；`'none'` = 只留痕不叫 T2）
```

**`MatchSpec` 的 kind**（`FlowMatch`）：`text`（行含某串）/ `regex`（行匹配）/ `ga`（本步命令被 GA 结算）/ **`tool`**（本步**工具调用结果**：`{ kind:'tool', outcome:'ok'|'error' }`，供"只调工具、不发游戏命令"的步骤判定）。任何 kind 都可带可选 `why`（只影响日志/决策文案，不参与匹配）。

**占位符三类**（校验期 fail loud）：① 运行时值 `{name}`/`{pass}`/`{captcha}`（**发送瞬间**插值，不落转录）；② 内建流程槽 `{lastFail}`（本流程最近一次 `fail` 命中行原文）；③ `capture` 声明的槽（**投递前**插值）。不在三类内的占位符 = 装配期错误。

**三种节点**：① **动作节点**（有 `action`，发命令并挂起等结果）；② **判定节点**（无 `action`，只有 `ok`/`fail` + `next`：进入即算成功，如 login 的旧 `success` 形态）；③ **终态节点**（`next` 为空）：**本节点成功即流程成功结束**，随后执行流程级 `onSuccess` —— 判定节点进入即成功；动作节点要等它的判据（如 fullme 的 `success` 等 `hpbrief` 的 `GA`）。

**`GA` 判据**（v0.4.0）：`GA` 是与"行匹配"并列的一种**判据**（`MatchSpec` 的一个 kind），语义 = "该命令的应答被 GA 结算"。它**不是自动成功** —— 必须写进 `ok` 或 `fail` 才生效：

```
ok:   [ GA ]        → GA 到达即本步成功（如 look：命令被接受就够了）
fail: [ GA ]        → GA 到达即本步失败
ok:[GA] ∧ fail:[GA] → **注册期报错**（互斥）
```

**注册期校验**（装配时执行，fail loud、不静默）：

| 校验 | 违反时 |
|---|---|
| 同一 step 的 `ok` 与 `fail` 判据集**互斥**（同一 pattern 不得两边都写；`GA` 不得两边都写） | 装配期抛错 + 留痕，流程不装配 |
| `next` 引用的步骤必须存在（**空 = 终态**） | 同上 |
| 步骤 id 在流程内唯一；流程 id 全局唯一 | 同上 |
| `awaitExternal` 声明的占位符必须在 `action.args` 里出现 | 同上 |
| `{ kind:'tool' }` 判据只能出现在**本步有 `action`** 的步骤上 | 同上 |
| 动作参数里的每个 `{…}` 都必须是三类已知占位符之一（运行时值 / 内建槽 / 本流程 `capture` 槽） | 同上 |
| `retry.on` 只能含 `'driver'`/`'fail'`；`capture` 的槽名在本流程内不得重名 | 同上 |
| **不存在 `humanTimeoutMs` 字段** —— 人工环节沿用本步 `timeoutMs`（等人工与重试共用同一份预算） | 同上 |

**每一类字段"谁消费"**（避免语义打架）：

| 字段 | 谁看 | 说明 |
|---|---|---|
| `when` | 运行时（入口 arm 前） | 前置条件；不满足就不 arm 入口，流程根本不激活 |
| `driver` | 运行时（arming 匹配） | 进入/重试本步；省略 = 顺序步 |
| `action` | T1（渲染成 tool-call）→ 官方工具管道 | 动作仍走官方路径（I15） |
| `capture` | 运行时（首次进入本步时） | 从命中行抽值存槽；答错重试沿用 |
| `onEnter` | 运行时 | 进入即生效的副作用（落 world / 直发），不等结果 |
| `ok` · `fail` · `next` | 运行时（结果判定） | 见 19.2 的判定顺序；`tool` 判据由官方工具结果喂回 |
| `retry` | 运行时 | 命中 `on` 判据 → **原步内**投 `action`（缺省重发本步动作）+ 清 `awaitExternal` 槽 + 重新挂起；**不重置计时器** |
| `awaitExternal` | 运行时（挂起/收人工值/计时） | 人工环节：动作**先挂起**、停投递、停看门狗；等人期间用本步 `timeoutMs` 计时；取图与弹窗由 `mud_captcha` 工具做 |
| `onSuccess.commands` · `.direct` · `.patch` | 流程成功时执行 | `commands` 走工具路径；`direct` 只发不等结果（与 save/分页同一机制） |

- **与 trigger 不重复**：驱动句 / ok / fail 只写在流程表里；`state` 规则仍留在 trigger（§4）。流程表在**装配期**注册进运行时（只读声明），**每会话的流程实例**是运行时状态。
- **权限**：流程步声明的命令属**系统流程**（actor `system`，不受档位可见性约束；危险命令硬边界照旧）—— 与登录/人工环节同一口径（§10）；`direct` 动作按 `full` 判定（§7）。
- **动作仍走官方路径**（不偏离初衷）：流程只决定"该谁行动"，动作由 T1 作为"模型"渲染成 tool-call（§7）。

### 19.2 arming 与推进（同帧问题的正解）

```
空闲（无活跃流程）                → arm(各流程的**入口 driver**，须先满足流程 when；I10：同一时刻最多一个流程实例)
进入流程（入口 driver 命中）      → 激活流程实例，收掉其它流程的入口（不再 arm）
进入某一步                        → 执行 onEnter 副作用；抽 `capture` 槽
                                  → 有 action 时：`awaitExternal` 步**挂起动作（不投递）+ 进人工环节**；
                                    其余步照常发命令并挂起
                                  → arm(本步 driver(重试) ∪ 本步 ok ∪ 本步 fail ∪ 各后继 step.driver)
结果判定（每批行 / 帧文本 / 工具结果；按行序）
                                  ① 命中本步 fail → 若本步 `retry.on` 含 'fail' 且次数未用尽 ⇒ **原步内重试**
                                     （投 `retry.action`（缺省重发本步动作）→ 清 `awaitExternal` 槽
                                      → 重新挂起等人工；**计时器不重置**）；否则 **失败**
                                  ② 命中某个后继 driver → **成功 + 走该分支**
                                  ③ 命中本步 ok → **成功**（含 `ok:[GA]` ⇒ GA 到达即成功；
                                     `ok:[{kind:'tool'}]` ⇒ 本步工具结果成功）
                                  ④ 本节点成功但**没有任何条件分支命中** → 走**顺序兜底后继**
                                     （`next` 里不带 driver 的那个；行判据成功 → 批尾跑，
                                       桥结算成功 → 结算后立刻跑）；**无后继 = 终态 ⇒ 流程成功结束**
                                     （随后执行流程级 `onSuccess`）
人工回填（`awaitExternal` 槽有值）→ `resumeHuman()`：回到 awaiting-result（**计时器继续跑**）
                                  → 投出挂起的动作（先人工值、后投递）
连接断开 / 写失败                 → 本步失败 → 流程失败收束（复位：只留入口）
到本步 timeoutMs                  → 超时 → 流程失败收束（人工环节同样在跑这份预算）
```

- **人工环节期间不判行**（作者定案 2026-09-13）：`phase === 'awaiting-human'` 时 `offer()` 只记录不判定 —— 人工环节只有一个出口（人工回填）；否则同批到达的成功句会把"命令还没发出"的步判成成功。**计时器不停**：等人期间用本步 `timeoutMs`（fullme 的 `answer` = 3 分钟，与图片有效期对齐）。
- **重试与失败的分界**：`retry.on:['fail']` 让"答错"变成"重来"而不是"收场"（fullme 用 `attempts:3`）；重试**不出本步、不重置计时器**，只做三件事：投 `retry.action`、清空本步 `awaitExternal` 的槽值（否则旧码会被直接重发）、把命中行原文写进 `{lastFail}`。所以"等人工 + 答错重来 + 收结果"共用同一份时间预算 —— 这正是"一步总计 3 分钟"的实现方式。

- **GA 是判据，不是自动成功**（用户定案）：`GA` 作为 `MatchSpec` 的一种 kind 写进 `ok` 或 `fail` 才生效；`ok:[GA]`= GA 到达即成功（如 `look` 步：命令被接受就够了），`fail:[GA]`= GA 到达即失败。**两边同时声明 `GA` 属注册期错误**（见 19.1 校验表）。**GA 与其它判据完全同权**（作者定案 2026-09-13）：任何一步都能直接声明，"哪些步该声明"不是文档层面的限制。
- **条件分支 vs 顺序兜底**：`next` 里带 `driver` 的后继是**条件分支**（先 arm，命中即走，可多分支）；不带 driver 的后继是**顺序兜底**（本节点成功后直接执行，不等待）—— login 的 `replace`（同名确认句，可能不出现）就是条件分支的范例：出现才走，不出现不阻塞（§11）。
- **顺序兜底的两个执行点**（作者定案 2026-09-13）：① **批尾** —— 本步的成功由**行判据**给出时，同一批里先给条件分支机会（同批行优先），批尾再跑兜底；② **结算之后** —— 本步的成功由**桥结算**给出时（`ok:[GA]` 命中 / `until`），判定发生在批次之外，结算处理完就立刻补跑兜底。少了 ②，`mxp` 这类"命令被接受即成功 + 顺序后继"的步骤会停在 `awaiting-branch` 等一个永远不来的批次（静默等待，违反 I4）。
- **`succeedStep` 只是里程碑，不是流程结束**（作者定案 2026-09-13）：一步成功只表示"该步的判据满足了"，流程继续按 `next` 推进（条件分支 → 顺序兜底 → 终态）。**收束只发生在 `next` 为空的终态步**（login 的 `look`），此时才执行流程级 `onSuccess`。
- **分支阶段同样有计时器**（作者定案 2026-09-13）：`succeedStep` 之后**不清掉时间预算**，而是按 `step.timeoutMs ?? flow.timeoutMs` 重新布防（失败文案"等待后继判据超时 (Nms)"）。这条覆盖两个静默等待入口：判定节点（`success`）进入后等 MXP/收功句；以及"只有条件分支后继、分支行永不到达"（`name.next=['pass','replace']`）。没有它，这类等待会无限持续（违反 I4）。
- **入口 arm 与单流程互斥**（I10）：空闲时所有流程的入口 driver 都开着；一旦某条流程激活，**其它流程的入口立即收掉**（"判据不开"，不是"命中了再忽略"）；期间如果看到别的入口行，记 `pending entry`，当前流程结束后接续。
- **为什么后继 driver 要一起 arm**：实录时序里"本步结果"和"下一步驱动句"**同一帧**到达（`{name}` 的应答里既有 `需要创建新人物` 之类结果、又有 `此ID档案已存在，请输入密码：`）。若等"成功后再打开下一步触发器"，提示行已经过去了 → 流程必卡死。
- **同行多命中**：注册期已保证 `ok`/`fail` 互斥；同类内多命中按**声明顺序取首**并记 `[流程] 判据冲突: A 与 B → 取 A` / `[流程] <flow>/<step> 结算 ga（不是本步命令的结算: "<cmd>", 忽略）`。

### 19.3 挂起与唤醒（落在桥上）

```
工具调用参数（由流程表生成，模型也能读懂 —— I15）:
    mud_send { cmd:'{name}', flow:'login', step:'name', expect:{ fail:[...], next:['pass','replace'] } }

发命令 → 挂起 = 桥的一条 pending 应答（单槽 live，I11）
        ├─ 判据命中（行匹配 或 **GA**）⇒ 按 19.2 的判定顺序给出 成功/失败/分支
        └─ timeoutMs 到点 ⇒ 超时
   两者都是**单出口唤醒**：① 注销本步 arming ② 结算（工具拿到三态结果）③ 投递下一步动作（**先投递后唤醒**，I12）
挂起期间新的应答桥请求 → 当场拒绝 + 留痕（I12；`direct` 动作不入桥，不受影响）
```

- **结果只有三态**：成功 / 失败 / 超时（I4）。**没有"静默"这一说** —— 静默窗不再参与流程结算。
- **结算归属 = 按命令比对**（实现期实测补的硬规则，2026-09-13 由布尔标记升级）：桥的结算（`GA`/`EOR`/`until`/超时/abort/写失败）**只在本步声明并放行过的命令带来时**才被本步骤接受。
  - **桥报告"被这次结算关掉的命令"**：`onSettle(kind, text, cmds)`（`network/response.ts` 的 `notifySettle` 透传 `reply.cmds`）→ `FlowRuntime.noteSettle(kind, text, cmds)`。
  - **流程侧记集合**：`allowBridgeRequest` / `noteOwnCommandWritten` 放行一条命令时把它（插值 + trim 后）记进本步的 `ownCommands`；`enterStep`（每次步骤迁移）与收束/复位/释放时清空。判定 = 桥给的 `cmds` 与 `ownCommands` **有交集**；通过后**消费**（删除命中的命令），所以同一条命令的重复/迟到 GA 不会二次结算。
  - **为什么不是布尔**：一个步骤可以发多条命令（序列动作、规则与流程动作同批）。布尔只能回答"本步有命令在途"，分不清"这条 GA 是哪条命令的" → 别的命令的 GA 会串结算本步。按命令比对把这个隐患结构性消掉。
  - 日志（点名是哪条命令）：`[流程] <flow>/<step> 结算 ga（不是本步命令的结算: "secret", 忽略）`。`cmds` 缺省（旧调用）时退化为"本步放行过任何命令"。
  - 症状（不加这条必犯，且实测踩到过）：实录里"本步结果行"与"下一条命令的 GA"常同帧到达 —— `success` 的进入判据（成功句）命中后立刻投递空命令，而上一条命令（`{pass}`）的 GA 紧接着到达；若不做归属，这个 GA 会**直接结算 `success` 步**（`success.ok = [GA]`），流程在命令还没发出时就"成功"。
  - 归属与 19.2 的 arming 正交：arming 决定"哪些判据开着"，归属决定"这条结算算不算数"。两者都要满足才推进步骤。
  - 帧文本判据（`text`/`regex`）不受归属限制（帧文本先到、GA 后到是常态）；受归属限制的是"与本步命令绑定的那类结算"。
- **`GA` 由桥通知**：它是 `ok`/`fail` 里可声明的判据之一（§19.1）；没有声明 GA 的步骤，GA 到达只是"帧文本定稿"，判定继续等文本判据或超时。
- 下一步动作的投递 = **一条正常的 mud-owned 消息（原文 + 动作请求）**，与 T2 拿到的消息同形（I15）：T2 若处理这一回合，读原文自行决定，动作请求只是"可用信息"。
- **人工环节**（`awaitExternal`，2026-09-13 定稿）：进入该步即**挂起动作**（不投递）—— 暂停全部投递 + 停看门狗 + `requestAgent` 拒绝唤醒；**行判据在人工环节不结算本步**。取图与弹窗由动作里的 **`mud_captcha` 工具**做（`prompt` 步），运行时只管"挂起 + 计时 + 收人工值"。人工回填 `{captcha}` 后（页面发 `fullme <码>`，actor `user`）`exitHumanWait` 调 `flow.resumeHuman()`：回到 `awaiting-result`（**计时器继续跑、不重布防**），随后投出挂起的动作（**先人工值、后投递**，与"先投递后唤醒"相反）。**超时 = 本步 `timeoutMs`**（等人期间照跑；fullme 的 `answer` = 180000 = 图片有效期，与答错重试共用这一份预算）→ 该步超时 → 流程失败收束。断线重连作废人工环节。

### 19.4 打断与排队（I14）

```
规则命中（顺序：第 1 步就判定能否打断）
  ├─ rule.interrupts > flow.priority  → **打断**
  │     ① 结算挂起 = interrupted（工具拿到 {ok:false, settled:'interrupted'}）
  │     ② 注销 arming + 复位流程（只留入口）→ 流程收束
  │     ③ 发 onInterrupt 命令（直发，如练功的 halt）
  │     ④ 投递打断事件的动作（原文 + 动作请求）→ T1 渲染 → 官方工具路径
  ├─ 规则未声明 interrupts（家务类：save/分页）→ 不打断（direct 动作本来就直发，无需排队）
  └─ 声明了但档位不够                        → **排队**（pending action），流程结束后立即执行
流程激活期间出现其它流程入口行               → **pending entry**，当前流程结束后接续（不漏 fullme 提醒）
```

**实现落点（2026-09-13 已接线）**：

- **声明面**：`ActionSpec.interrupts?: number`（`trigger-llm/types.ts`，纯数字；缺省 = 不参与）。
- **判定点**：运行时在**同一批次**里、在投递规则动作之前先做打断准入（`session-runtime.ts` 的 `admitRuleHits`）—— 顺序是先流程判定（`flow.offer`）→ 待人工挂起（`parkExternalHits`）→ **打断准入** → 投递。判定用 `FlowRuntime.interrupt()`（`interrupts > flow.priority`）。
- **打断的挂起结算**：`CommandResponseController.interruptInFlight(reason)` —— 在途 + 排队的应答请求**当场**结算为 `interrupted`（`ReplySettle` 新增成员），工具结果 `{ok:false, settled:'interrupted', note:'[流程打断] …'}`；桥**继续可用**（打断后投递的新命令照常走），这一点与 `close()`（终止语义）不同。非 GA 路径 → 计入孤儿 GA 计数（迟到的 GA 不结算下一帧）。
- **排队与出队**：档位不够 → `FlowRuntime.pendingActions`；流程到达终态/失败/被打断后，运行时调 `drainFlowQueue()` 把队列里的动作**动作投递**给 T1（`deliverStandalone`）。判定点不止一处：批次尾、桥结算回调（`onSettle`）、以及流程失败回调（超时/断线路径）。
- **端到端**：`tests/flow-interrupt.spec.ts`（7 例）：档位够 → 打断（interrupted + 复位 + `onInterrupt` 直发 + 事件动作投递）；档位不够 → 排队且在流程真的结束前不出队；未声明 → 照常投递；空闲 → 不生效；**login = 1000 不可打断**（战斗类只能排队）。
- **`onInterrupt` 的范围**：只声明"打断时要先发的直发命令"（如 halt）；"打断后自动重试/原因判定"留给 T2（§18.15）。

- **login = 1000**：没有任何规则的 `interrupts` 能高过它 → 无人可打断（用户定案）。
- **fullme = 100**：战斗/生存类事件（`interrupts > 100`）可打断它 → 流程失败收束（页面的人工输入作废，战斗优先）。
- **练功这类"T2 工具挂起"同一机制**：挂起者是模型的工具调用而非流程步，差别只在拥有者；被打断后由 T2 决定是否重来。

### 19.5 失败与收束

- 失败 / 超时 → 复位 arming（**只留入口**）+ 留痕（决策器 + 日志）+ **交 T2 决策一次**（"重试 / 告知用户"），不静默停住、不自动重试。
- **回合收束不需要 T1 参与**：运行时不再投递动作 ⇒ T1 没有动作可渲染 ⇒ 官方 loop 自然收束当前回合（§7）。
- 人工环节失败（断线/放弃）同样复位到"只留入口"。

### 19.6 T1 的关系（一回合多步）

- **目标（作者定案）：一个流程 = 一个回合** —— 步骤在同一回合内推进（T1 渲染 tool-call → 挂起 → 唤醒 → 下一步…），直到终态或失败。**不做"一步一回合"**。
- T1 在每步只做一件事：把本步认领到的动作请求渲染成 tool-call（§7）；它不查流程状态、不注销触发器、不判失败。

#### 19.6.1 实测账目（官方 loop 模拟器；2026-09-13）

**模拟器**：`packages/mud-core/tests/loop-sim.ts` —— 按 DSH 源码逐条复刻 loop 的转移（拖动器 `while (await turn())`、认领 `next-step` 全取 + `next-turn` 一条、回合首步空认领即收束、结果携带 `additionalContexts` 进 `next-step`、`concludesTurn` 收束、`turnEnds && nextStep.length === 0` 才 break），每条规则在文件里给出出处。**用法**：驱动器与测试线程交错（工具调用阻塞在等游戏应答），测试用 `until(pred)` 推进假计时器。**凡关于"回合/步骤/模型请求次数"的结论，必须在它上面量** —— 旧的"`followup` → 数组"替身看不到边界，不能作为证据。

`tests/loop-sim-login.spec.ts` 跑完整条 login（名字→密码→成功句→空命令收尾）。下表是**落地前后**的对照（前两行是历史基线，最后一行是当前实现）：

| 投递通道 | 回合 | 步骤 | 模型请求 | 空续步 | 形状 |
|---|---|---|---|---|---|
| 历史基线：`followup`（运行时 `agent.followup` → `next-turn`） | 3 | 6 | 6 | 3 | 每回合 `claim=1`(T1 渲染动作) → 工具 → `claim=0`(T1 收束) → `turn/end`；下一步动作要等本回合结束才被**新回合**认领 |
| 历史基线：`defer`（无 conclude） | 1 | 4 | 4 | 1 | 同一回合 `claim=1 → 1 → 1 → 0`；最后仍多一步 |
| ✅ **当前实现：`defer` + `concludeTurn`** | **1** | **3** | **3** | **0** | 同一回合三步，末步结果直接收束（`concludedTurns=1`、`deferred=2`）|

- **落地前与"一个流程 = 一个回合"不符**：旧实现是**一步一回合 + 每步一次空续步**（每个流程步 2 次模型请求）。这不是缺陷，是 `followup` 的官方语义：*"the item becomes the sole ordinary message of its own turn"*（`core/agent/src/runtime-types.ts:217-222`）—— **现在已按 §19.6.2 切到 `deferContext` + `concludeTurn`**。
- 三次实测 `t2Calls = 0`：流程期间**没有**任何请求落到 T2（真实 LLM）—— `turnLane` 在回合内沿用（`agent-bridge.ts:219-241`）把工具续步/空续步都留在 T1。
- **模拟器现在跑的是真行为**：`LoopSim.execute` 仿真官方包装器（`beginToolCall`/`endToolCall` → `takeDeferredDeliveries` → `exec.deferContext` → `result.ok && shouldConcludeTurn(callId)` → `exec.concludeTurn`），运行时那侧是**生产代码**。
- 落地设计（✅ 已按此实现，见 §19.6.2）：① 两条通道分工 —— 有工具在途 ⇒ `deferContext`，无工具在途（帧内命中/人工回填/看门狗/一次性动作）⇒ `followup`；② 一次工具调用期间可能连推多步（`processBatch`），必须**按序全部** defer；③ `concludeTurn` 只对**T1/流程通道**的动作生效（T2 自己发起的工具调用绝不能收束回合）；④ 工具**不许抛异常**（registry 的 catch 会丢掉 deferred contexts，`core/tools/src/index.ts:1586-1588`），失败必须是"带错误的返回结果"（我们已是此风格）。

#### 19.6.2 投递通道：三条判据（✅ 已实现 2026-09-13）

**判据 A —— 通道由"投递瞬间是否有工具在途"决定（不区分流程/规则）**。
运行时投递（`deliver`/`deliverStandalone`/`drainFlowQueue`）在**工具在途**时存入 defer 槽、否则 `followup`。在途与否由工具包装器通知运行时（`enterToolCall()/leaveToolCall()`），判定精确到"我们自己的工具正在执行"。**不按"流程 vs 一次性动作"分通道** —— 两者语义相同（都是 T1 通道的下一步），一律按在途与否分流。

**打断的通道（判据 A 的边界情形，作者问）**：高优先级规则命中时，被打断的工具**正在在途**（打断发生在批次投递前，而流程挂起就意味着桥里有在途请求），所以**事件动作照常入 defer 槽、随那个被打断的结果进下一步** —— 不 `followup`、不伪造 step。依据：官方允许**错误/失败结果**携带 `additionalContexts`（`core/tools/src/index.ts:1824-1841`、`1910/1924`），即"这个调用被打断了，同时给你一条新输入"是合法形状。顺序也正好是 I12 要的：**先结算旧动作（`interrupted`）→ 再随结果投递事件动作**。
只有"没有工具在途时被要求打断"（例如流程停在等分支、桥里没有在途请求）才落到 `followup` —— 这是判据 A 的常规分流。

**判据 B —— `concludeTurn` 只由"某投递的最后一条动作"触发，且运行时已无活**。
- **N 与 index 都不是流程步数**：`N` = **该投递消息 `source.actions` 的长度**（T1 一次渲染出的 tool-call 条数），`index` = 确定性 call-id `mud-<delivery>-<index>` 里的下标（§7）。**流程的可选分支不影响它们** —— 分支只影响"以后还会不会有新投递"，而这件事由运行时的状态回答（下一条）。
- 收束条件 = **结果成功 ∧ `index === N - 1` ∧ 流程机已空闲（`flow.state() === null`）∧ 无其它待投递**。
- **为什么必须有"流程机已空闲"**：流程步成功之后可能**暂时**没有下一步动作（例如 `name` 成功进入 `awaiting-branch`，在等密码提示行）。此刻槽是空的，若只按"槽空 + 最后一条"收束，就会把这个仍在推进的流程切成"本回合结束 → 分支行到达时只能开新回合"。加上"流程空闲"后，等待中的流程不会被切。
- **`concludeTurn` 与 defer 可以并存，不会吞掉已排队的输入**：官方在 `turnEnds && nextStep.length === 0` 时才收束，`nextStep` 非空就继续走下一步（`agent-loop/src/agent.ts:315-320`）。所以判据 B 的"无其它待投递"是**意图**上的收紧（更早收束、省一步），不是安全阀。

**判据 C —— 失败/超时/打断：什么都不做，让官方自然收束**（**修正**：原稿写的"清空 defer 槽"是错的，槽里若真有内容，那是独立的新输入，清掉只会丢事件）。
- `concludesTurn` 只在**成功结果**上生效（`core/tools/src/index.ts:558-569`）。所以：
  - **失败/超时/写失败** ⇒ 既 defer 不出新东西（运行时不会为失败产生"下一步动作"），也不 conclude ⇒ loop 自然再给一步（认领为空）⇒ T1 渲染 `finish stop` ⇒ 回合以 `completed` 收束。**这就是作者说的"打断步本身无动作、自然收束"**，不需要伪造任何 step，代价只是异常路径多一次 T1 请求（我们本来就在付）。
  - **打断** ⇒ 不是"失败路径"：事件动作要投，照判据 A 的边界情形随 `interrupted` 结果 defer 出去；那个**真动作**执行成功后按判据 B conclude。**不存在"伪造一个成功 step 来收束"**。
- 槽的生命周期本来就被限制在**一次工具调用之内**（在途期间入槽、该调用的包装器结束时取走），不存在"残留到下一步"的可能，因此不需要任何显式清槽。

**实现落点（三处，已落地）**：
1. `agent/agent-bridge.ts`：新增 **`MudDeliveryChannel`** 接口（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries`/`shouldConcludeTurn`）；`attachMudTools(..., channel?)` 的工具包装器在 `execute` 前后 begin/end，结果提交前 `for (msg of takeDeferredDeliveries()) exec.deferContext(msg)`，并在 `result.ok && shouldConcludeTurn(callId)` 时 `exec.concludeTurn()`。
2. `runtime/session-runtime.ts`：实现该接口 —— `inFlightTools` 计数、`deferSlot` 槽、`deliverySizes`（每条投递的动作数）、`parseDeliveryCallId`（`mud-<delivery>-<index>`；**T2 自己的调用 id 解析失败 ⇒ 永不可收束**）、`shouldConcludeTurn`（判据 B 四项条件）；投递统一走 `sendDelivery`（在途 ⇒ 槽，否则 `followup`）；断线/释放时清槽与计数。**两条装配路径都必须接**：宿主路径（`attachMudTools(..., channel)`）与 preset 路径（`preset-agent` 经 `MudAgentKit.channel(sessionId)`）共用 `runWithDeliveryChannel`。
3. `agent/tools.ts` 与 `tests/loop-sim.ts` 的**工具语义不变**：工具保持纯净（defer 由包装器统一做）；模拟器改为**仿真官方包装器**（见 §13.6），因此 `loop-sim-login.spec.ts` 测的是真行为。

**实例（login 精简为 4 步，`replace` 为可选分支）**：投递 d1=[name]、d2=[pass]、d3=[y]（仅当服务器要求替换）、d4=[空命令]；每条投递 `N = 1`，`index = 0 = N-1`。
`name` 执行期间 → 密码/替换提示到达（分支）→ 下一步动作入槽 → defer（不收束）；`pass` 执行期间 → 成功句到达 → 命中 `success` 的进入判据 → 空命令入槽 → defer；空命令执行期间 → GA → `finishFlow`（流程空闲）→ 槽空 → **conclude** ⇒ 整条流程（无论 `replace` 走没走）都在**一个回合**内，模型请求数 = 实际执行的动作数（3 或 4）。
- **流程状态归运行时**：`{ flowId, stepId, armed[], phase, deadline, pendingActions[], pendingEntry[] }`（`diag()` 可见、每次迁移留痕）。

### 19.7 定案与待定

**已定案（作者 2026-09-13）**：

1. **MXP 检测模式发任何命令都能跳过**（作者定案 2026-09-13，后续被 login 精简吸收）：**空命令**即可跳过 MXP 检测 —— 因此桥**允许空命令**（`sendAndAwait` 只在"一条命令都没有"时拒绝），login 的终态步直接发空行收尾（§11）。
2. **GA 与其它判据同权**：任何一步都可直接声明 `ok:[GA]`/`fail:[GA]`（`name.ok=[GA]` 是正确的，§11 旧表述"name/pass/replace 不声明 GA"已作废）。
3. **`succeedStep` 只是里程碑**，流程收束在 `next` 为空的终态步（login 的 `success`）→ 顺序兜底在"结算之后"也要补跑（§19.2）。
4. **分支阶段也要计时器**：一步成功不清掉时间预算 —— `succeedStep` 之后按 `step.timeoutMs ?? flow.timeoutMs` **重新布防**一个计时器（日志文案"等待后继判据超时 (Nms)"），到点即流程超时失败收束 + 留痕 + 交 T2。覆盖"判定节点（`success`）进入后等 MXP/收功句"与"只有条件分支后继、分支行永不到达"这两类静默等待（I4）。
5. **打断/排队的运行时接线**（已落地）：规则动作的 `ActionSpec.interrupts` 声明 → 运行时在**批次内先做打断准入**（`admitRuleHits`）：档位够 ⇒ `FlowRuntime.interrupt()` 复位 + `onInterrupt` 直发 + **桥的在途/排队请求当场结算为 `interrupted`**（`CommandReplyController.interruptInFlight`，工具拿到 `{ok:false, settled:'interrupted'}`）+ 事件动作照常投递；档位不够 ⇒ 入 `FlowRuntime.pendingActions` 排队，**流程结束（终态/失败/打断）后由 `drainFlowQueue()` 出队投递**；未声明 ⇒ 不打断也不排队。端到端见 `tests/flow-interrupt.spec.ts`（含 login = 1000 不可打断）。
6. **规则原文核对归作者**（作者 2026-09-13）：`需要创建新人物` / 密码错误 / 登录成功句 / fullme 成功句等**逐字原文**由作者上线前一一核对；实现方不代管、不代为"估计"，只保证**流程结构**正确（步骤图、判据分工、成功/失败/超时三态、打断档位）。
7. **投递通道改用官方 `deferContext`（± `concludeTurn`）**（✅ 已落地 2026-09-13）：两条通道分工、多步按序 defer、`concludeTurn` 仅限 T1 通道、工具不许抛异常 —— 账目 1 回合 / 3 步 / 3 次模型请求（§19.6.1/§19.6.2）。
8. **fullme 流程化**（✅ 定稿并落地 2026-09-13，作者逐条审定）：五步 `request → [stale | prompt] → answer → success`；流程表原文见 §11，八项实现面已全部落地。要点：`request` 只有 fail（"刚刚用过"动态时长）+ 两条条件分支，**无 ok**；`stale` 三连发 `fullme 1` 放弃上一轮后按失败收束；`prompt` 用 `mud_captcha` 工具取图 + 弹窗，以**工具结果**判定；`answer` 三次答错重来（**步内自环、不重置本步 3 分钟总预算**；错码等价于"三连放弃"）、`answer.timeoutMs = 180_000` = 图片有效期（等人工 + 重来 + 收结果共用这一份预算，**不引入 `humanTimeoutMs`**）；`success` 发 `hpbrief` 补状态。**三种收场（取图失败/答错 3 次/预算耗尽）都由下一轮的 `stale` 兜住**，运行时不另记状态。测试：`tests/flow-fullme.spec.ts`（声明面/校验/入口翻转）+ `tests/runtime-captcha.spec.ts`（真链路端到端）。

**待定**：

1. **`pendingEntry` 的端到端用例**：`FlowRuntime` 已实现"流程活跃期间的其它流程入口 → 排队 → 当前流程结束后接续"，但还没有端到端测试（现有 7 例 `flow-interrupt.spec.ts` 覆盖打断、排队动作、超时出队与半截序列，不含入口接续）。
2. **`hpbrief` 应答折叠进 world**（作者：后续一起加）：终态步已发 `hpbrief`，其应答目前只作 tool result；加一条 state 规则把气血/精力折进 world 由 T2 读取。

---

## 附录 A：官方机制引用（文件锚点）

| 机制 | 位置 |
|---|---|
| `blank` 由首个 `turn/start` 翻转 | `packages/api/session-controller/src/list.ts:50` |
| `agent/request` 是"替换本次调用配置"的官方扩展点 | `packages/core/agent/src/runtime-types.ts`（JSDoc） |
| per-session 模型选择会覆盖请求 | `packages/core/agent/src/model-selection.ts:91-107` |
| `selectModel` 改写部署默认模型 | `packages/api/session-controller/src/commands.ts:151-158` |
| sessionController 可作宿主服务调用 | `packages/client/ui-deliverables/src/present-open.ts` |
| `agent/pre-step` payload 带认领消息 | `packages/core/agent-loop/src/agent.ts:250` |
| 请求上盖 `sessionId` | `packages/core/agent-loop/src/agent.ts:614` |
| client `ISessions` 无删除会话接口（只有 create/open/clear/fork） | `packages/api/session-controller/src/client/contract/sessions.ts:35-122` |
| 删除会话的官方替代：归档（界面隐藏，文件与记账保留） | `packages/api/workspace-controller/src/client/service.ts:114`、`packages/api/workspace-controller/src/commands.ts:153`、`packages/client/ui-workspace/src/client/navigation.ts:242` |
| waterfall 先注册者最后拍板 / `prepend` | `vendor/cordis/src/events.ts`、`core/scope/src/index.ts:170-185` |
| 审批与档位（approval/presets/sandbox） | `packages/interaction/user-approval`、`permission-presets`、`sandbox/*` |
| preset 组合与门控 | `packages/preset/agent-presets/src/index.ts`（`composedPreset`） |

## 附录 B：抓包事实（保留要点）

- 登录：`您的英文名字：`（短形态）/ `您的英文名字（要注册新人物请输入new。）：`；密码提示 **`此ID档案已存在，请输入密码：`**；同名在线确认 **`您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)`**（实录 2026-09-11 —— 该句不含"同名/覆盖/替换"，旧关键词集必然漏匹配）；完成 `目前权限：(player)`。
- GA 与命令 1:1（21/21），GA 延迟 1–602ms（≪ 2s 静默窗）。
- 长程命令（`dz`）：受理帧 GA + prompt 后 **56 批 / ~57s 无 GA 无 prompt**，完成句与末条推送同块。
- 分页：每页独立命令 + 独立 GA；页尾为 `== 未完继续 88% ==` 换行行，非 prompt。
- 服务器**不回显**命令（密码明文泄漏只在本机 echo/日志）。


