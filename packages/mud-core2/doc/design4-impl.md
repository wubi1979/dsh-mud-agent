---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'c208fbdf-9649-4d11-85a5-8156afe410c7'
  PropagateID: 'c208fbdf-9649-4d11-85a5-8156afe410c7'
  ReservedCode1: 'c01a41b1-1b4a-4462-b0d8-b94da78c6711'
  ReservedCode2: 'c01a41b1-1b4a-4462-b0d8-b94da78c6711'
---

# mud-core2 实现设计

- 状态：**实现设计（2026-09-24；2026-09-25 修订：目录按心智层分组、静态禁发表替代动态权限、派单改宿主原生 subagent 工具、砍结算消化守卫与 compaction 守护）**
- 前置：`design4.md`（心智框架）。本稿回答"每层落在哪个文件、接宿主哪根线、哪块自建"，不重复论证心智分层。
- 写作纪律：
  1. **宿主能力必带 `file:line`**（DSH 源码，路径相对 `D:\Code\deepseek-harness`）；查不到写 **NOT FOUND** → 自建或待实测；
  2. **本稿只写最终结果**：不含演进过程、不含与其它稿的差异说明、不引用旧术语；
  3. **每层带本层禁令**（意识薄 / T2 唯一意图 / 无两执行者）。

---

## 0. 定位与宿主核查

### 0.1 本稿角色

design4 回答"心智是什么、为什么这样分"；本稿回答**"每层落在哪个文件、用宿主哪根线接、哪块自建"**。概念已收敛，本稿不再论证五层，只做承载映射与工程设计。

**项目形态**：Cordis 插件（DSH 宿主标准形态）——

```
mud-core2/
├── src/                  # §2 文件树
├── skills/               # 程序记忆（人写种子 SKILL.md）
├── package.json          # name: mud-core2，main: src/index.ts
├── cordis.patch.yml      # 接入宿主
└── vitest.config.ts
```

接入：`dsh web --patch .../mud-core2/cordis.patch.yml`（patch 叠层）。依赖面全部为 DSH 宿主 API（工具注册 / followup·steer / credentials / skills / session.append / 生命周期），逐条见 §0.2——**零自建运行时**，自建项只有 NOT FOUND 清单所列。

### 0.2 宿主核查表（按设计域）

**Agent 原语与生命周期**

| 能力 | 事实 | 出处 |
|---|---|---|
| `followup` | 发 `next-turn` 消息、唤醒目标；running 时排队到下回合 | `packages/core/agent/src/runtime-types.ts:222` |
| `steer` | 发 `next-step` 消息、唤醒目标；空闲自开回合，running 中在下一步边界消费 | `runtime-types.ts:224-231`；`agent-loop/src/agent.ts:159`（send wakeup=true） |
| `inject` | 发 `next-step`、**不唤醒**；可能落在已被认领的 pre-step 之后而错过本轮 | `runtime-types.ts:233-241` |
| 状态机 | 仅 `idle` / `running`，**无定时迁移、无看门狗** | `runtime-types.ts:102-109` |
| `whenIdle()` | 驱动+维护任务静默才 resolve；期间有并发工作抛错 | `runtime-types.ts`（whenIdle 段） |
| 查找子 agent | `ctx.agents.get/list/roots`；`get` 到后可 steer/inject/followup | `packages/core/agent/src/index.ts:566-568`（get）、`:585-588`（list）、`:595-598`（roots） |
| 一 session 一 agent | 重复注册直接拒绝 | `agent/src/index.ts:467` |
| 每请求上下文 | 全量 `deriveMessages()` 组装；**无内建请求级截断**——但缺省 profile 挂 compaction（每个 `pre-step` 自动跑，按预算**重写会话面**） | `agent-loop/src/agent.ts:631`；`bundle/web-app/presets/standard.patch.yml:70-79`；`compaction-basic/src/config.ts:108`（`auto ?? true`） |
| 取中止信号 | 工具侧 `exec.signal`；**是否真能停下取决于工具是否响应它**（与工具超时同一条协作式契约） | `tools/src/index.ts:350-351`；`guard/timeout-policy` README（"cooperative, never a hard kill"） |

**工具面**

| 能力 | 事实 | 出处 |
|---|---|---|
| 作用域注册 | `tools.register()` 按作用域就近遮蔽（子会话注册遮蔽父同名工具） | `packages/core/tools/src/index.ts:1062`（register）；`packages/core/scope/src/store.ts:226-241`（scope layer 解析） |
| `tools.restrict()` | 按 agent 遮蔽工具面 | `tools/src/index.ts:1096-1099` |
| `pre-execute` | 四决策 `allow / deny / cancel / ask`；deny 不进 body | `tools/src/index.ts:153`（hook 签名）、`:606-610`（PreToolDecision 四决策类型）、`:1499-1534`（gate 执行） |
| 超时 | **无默认超时**；`timeoutMs` 协作式，须工具自持 | `docs/subsystems/tools.md:64-68` |
| `concludeTurn` | 仅成功结果携带，消费后结束本回合 | `tools:1421-1423`；`agent-loop/tool-calls.ts:157-158`；`agent-loop/agent.ts:516-520` |
| `deferContext()` | 一次性读，结果并入**下一轮**上下文（不进历史） | `tools:1418-1420, :1609-1620` → `agent-loop/tool-calls.ts:156-157`；`agent-loop/agent.ts:516-519` |
| `exec.signal` | 本回合中止信号，可与超时等 fused | `agent-loop/agent.ts:299-300`；cancel `:174-179` |

**人工问答与凭据**

| 能力 | 事实 | 出处 |
|---|---|---|
| `ctx.userQuestions.ask()` | signal 可取消——signal 不活/已中止即抛 `ASK_ABORTED`；signal 的 `AbortSignal` 随请求携带、UI 侧可 abort | `packages/interaction/user-questions/src/index.ts:41-47, :86-88, :145-148` |
| **DELEGATED_CALLER** | 被父拥有的 owned 子代理调 `userQuestions` **直接拒绝**（roots 不含调用者即抛，提示"把未决问题放进子 agent 最终结果"） | `packages/interaction/user-questions/src/index.ts:101-105` |
| ask 超时 | **NOT FOUND**（无内建超时） | — |
| 凭据 | 双键空间，每次 `resolve` 重解析，引用不进模型 | `packages/credentials/credentials`（resolve 路径） |

**子 agent（DSH subagent）**

| 能力 | 事实 | 出处 |
|---|---|---|
| `start` / `startContinuable` | **都不阻塞到子级结束**：`start` 在 publication 时返回带 `.result` 的 run 句柄（漏 `await run.result`/`dispose()` 会泄漏子级 Agent）；`startContinuable` 在 inbox 受理时返回 id。阻塞是消费方选择 | `packages/subagent/subagent/src/index.ts:556,559-589`、`:252-256,261-263`；`tool-subagent/src/index.ts:564-568`（`settleForegroundRun(run)`） |
| 三模式 | 前台阻塞（`exec.signal→child.cancel`）/ background one-shot（job）/ continuable（结算唤醒父） | `tool-subagent/src/index.ts:527-568`；`subagent-in-process-driver:168-170` |
| **结算唤醒（best-effort，非保证）** | 正常路径：父空闲→followup、父运行→steer 步边界插话（消息进 `inbox.nextStep`，不丢）。**但存在四种不唤醒状态**：① 子级首个 prompt 未被接受（静默）② 父不在注册表（**丢弃且无日志**）③ 父正在关闭（`inject`：持久但不唤醒）④ 投递抛错（仅 warn） | `continuation-activation.ts:871-888`（notifySettlement）、`:881`、`:334-346`；测试 `continuation.spec.ts:3170,3191-3205,3096-3117` |
| background one-shot | **会唤醒父**（经 job 系统，`completionDelivery` 缺省 `wakeup`；owner idle → followup）；最终文本由 `job_output` 取回 | `jobs/tool-jobs/src/index.ts:62, :295-307`；`run-settlement.ts:40` |
| 预算 / 超时 | **宿主没有任何子 agent 超时或看门狗**；挂死子级永久占一个激活槽（缺省上限 8，超出报 `ACTIVATION_LIMIT_REACHED`） | `subagent/src` 无 `timeout\|watchdog\|deadline`；`continuation-activation.ts:41-57`（`ActivationPool.reserve`） |
| **激活槽释放点** | 只有两处：① 启动未发布的回滚（`rollbackUnpublished`）② 激活终结（`finishDisposal`，**内含 `notifySettlement`**）。**`interrupt()` 不释放槽**——它只 `agent.cancel({keepInbox:true})`；终结由 `watchSettlement` 的 `await whenIdle()` 驱动，且要求 `inbox.hasPending === false && ownedChildren.size === 0` | `continuation-activation.ts:692`、`:863-866`、`:283-326`（interrupt）、`:725-739`（watchSettlement）、`:788` |
| 父子通信 | `sendMessage` 相邻会话互发（**可唤醒已 `inactive` 的 continuable 子级**＝冷恢复，重放子级历史）；`interrupt()` 只停当前回合、**不是 kill**、结算过的目标也接受 | `subagent/src/index.ts:266-285, :328`；`tool-subagent-control/README.md:49,53,125`；`continuation.ts:299-301,406-456`（冷恢复及其失败码） |
| 模型侧控制 | `tool-subagent-control`：`send_message / interrupt_agent / list_agents`（**三者都是模型可见工具**，缺省挂在宿主根，故子级也可见） | `tool-subagent-control/src/index.ts:29, :77`；`list-agents.ts`；`bundle/base/cordis.patch.yml:363-367` |
| spawn vs fork | spawn-in-process = **全新会话 + 平坦作用域**（`seed` 缺省）；fork-in-process = 用父历史 seed | `subagent/src/types.ts:237-244`；`subagent-spawn-in-process/src/index.ts:61-65`；`subagent-fork-in-process/src/index.ts:85-91` |
| **子级工具可见集** | 子级 = **全局层 + preset 链 + 自己的作用域**；**不含父 agent 自己注册的层**（父子作用域是**兄弟**，都挂在 preset standing key 上）。`tools.restrict()` 在父作用域上**不约束**子级 | `child-agent.ts:205`；`agent-preset-registry/src/index.ts:280-291, :249`；`tools/src/index.ts:1177-1207`；`scope/src/store.ts:192-199`；证据 `continuation.spec.ts:1348-1349`；`docs/subsystems/subagent.md:461` |
| `agent/created` 对子 agent | **同样触发**（但**注册作用域**决定能否看到自己的子级：必须宿主/preset 作用域，见上行） | `agent/src/index.ts:550`（emit）；`agent-loop/src/index.ts:624`（announce，在 `publish()` 内） |

**会话、人格与技能**

| 能力 | 事实 | 出处 |
|---|---|---|
| surface 白名单 | 恰 5 类：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` | `packages/core/session/src/types.ts:439-444`（SurfaceEventType）；`surface.ts:150-156` |
| 自定义 `session.append` | 天然 **log-only**（白名单外不进模型上下文） | `packages/core/session/src/index.ts:720-724` |
| resume | 只恢复历史，**不恢复运行时对象**（socket 恢复 NOT FOUND） | persistence 路径 |
| persona 装载 | `ctx.systemPrompt.section(PromptSection)` 注册节（**参数是对象**：`{name, order, text, interpolate?, complete?}`，不是 `section(name)`）；persona 段有固定名；`complete:true` 会替换整份提示 | `packages/core/system-prompt/src/index.ts:454-463`（section）、`:53-76`（PromptSection）、`:127, :158`（persona 段序）、`:597-600,629-634`（complete） |
| skills 目录 | `skills/<name>/SKILL.md` + chokidar 热加载 + 模型 write/edit 同步失效缓存；**快速失效只认工具名恰为 `write`/`edit`**，其余依赖 chokidar，而 chokidar 需要 `watch:true` 且 root 已被 `list()` 保留（即 `skill` 工具在可见面） | `skill-filesystem/src/index.ts:143-146,697-701`（actor 名）、`:492-506`（chokidar）、`:339`（未保留 root 直接返回）；`tool-skill/src/index.ts:220-223` |
| skills 模型可见 | 目录摘要在 `agent/pre-step` 注入（**按内容摘要去重、只注入一次**，但**每次目录变更追加一整份新副本**）；正文由 `skill` 工具按需取；**代码侧可 `ctx.skills.get()` + `renderSkillContent()`，但没有"注入某技能到某子 agent"的专用 API** | `tool-skill/src/index.ts:213-251, :228-241, :279-311, :82`；`skill/src/index.ts:500-517, :170-183` |
| ask 超时 | **无内建超时**；且 `ask()` **不与 signal 竞速**——`ASK_ABORTED` 只是对 answerer 拒绝的归类，answerer 不合作就永久挂起 | `user-questions/src/index.ts:86-151`（`:134-136` bare await；`:146-148` 仅 catch 归类） |
| 定时器参考实现 | 有界分段 timer + `whenIdle` + 到期 followup，**永不打断运行中回合** | `packages/schedule/schedule/src/runtime.ts:194-201, :271, :290`；`packages/schedule/schedule/README.md:56` |

**计数与观测**

| 能力 | 事实 | 出处 |
|---|---|---|
| `request/header` | **只在该 loop 实例的首次请求（`initial`/`resume`）或 header 变化（`change`）或声明新 series（`series`）时发**——因此**不能**用来计数请求或决策点 | `agent-loop/src/agent.ts:595-610`；事件语义 `session/src/types.ts:386-388` |
| 决策点计数 | **决策点数 = `step/start` 数**（每个进入的步一次，`types.ts:298-301`；`agent.ts:328`）。**注意偏差**：一步可含多次请求（重试走 `agent.ts:491 continue`，不新增 `step/start`），也可能零请求（`prepareRequest` 在 `:390` 抛错） | `session/src/types.ts:298-301`；`agent-loop/src/agent.ts:328, :390, :491` |
| 实际调用计数 | **实际调用数 = `assistant/message` ∪ `assistant/attempt`**（唯一持久的"结算过的尝试"对；失败于 `live.start()` 之前的尝试两者都不留）。两者之差 = 重试/失败。**没有任何 session 事件**表示"请求真的发出去了"（只有进程内 `llm/stream` waterfall 或 `agent/assistant-stream` 的 start 帧） | `session/src/types.ts:341-355`；`agent-loop/src/agent.ts:418-428, :433-447, :471-475, :502-511` |

**NOT FOUND（→ 自建或待实测）**

1. 通用出站 TCP 客户端 → **自建**（telnet/ansi 解析沿用实录验证过的实现）；
2. 核心看门狗 / 静默定时器 → **自建**（可参考 `schedule/runtime.ts` 的有界 timer 形态）；
3. `wait_for_condition` 行等待竞速机 → **自建**（§3.2）；
4. 图片识别 / 验证码工具承载 → **第一期不注册**（无承载；必然失败的桩会让模型反复调用、白烧请求）；fullme 走"问题上浮 → 根问人"（承载研究列 §6，二期注册）；
5. 默认工具超时、ask 超时 → 不需要（宿主协作式，见核查表）；
6. resume 后的连接恢复 → 自建（策略 §6 待实测校准）。

### 0.3 术语表

| 术语 | 含义 |
|---|---|
| **行流持有者** | 同一时刻唯一占着行流的东西：根或某个子级。**进程级状态**（单 MUD 连接唯一），冲突时 fail loud（§3.2）——根与子级都持有全套工具，并发读会各拿半截行 |
| **静态禁发表** | `mud_send` 工具内的子会话命令拦截表（自杀 / quit / drop all 类不可逆命令）；根会话不受限；经济类动作不拦（§3.5） |
| **wait 竞速机** | `read()` 的实现：在缓冲消费与网络到达之间按写死的判定序竞争（§3.2）。执行域内部动作，不对外暴露 |
| **危险判据（连续谱）** | 一份数据表，每条自带动作意图（`interrupt?` / `wake?` / `abortWait?`）——同时服务紧急中断、等待中断、唤醒，不许两处派生（§3.3） |
| **占线错误** | 服务端对"活动没做完"的拒绝应答；它是天然的教育信号，处置归子 agent 的执行智能（§3.4 persona） |
| **预算** | 每个子 agent 一份的时限；耗尽即判失败并上报（§3.4） |
| **释放阀门** | 让被中止的等待到达静止态、从而触发结算并回收激活槽的唯一途径：`wait()` 响应中止信号 + 自带超时（§3.2/§3.4） |
| **结算通知** | 子 agent 结束时投递给父会话的消息；**best-effort**（存在四种不唤醒状态，交付失败由预算路径承担）（§3.4） |
| **计划级检视** | 结算到达时，根消化该次结算并顺带检查在途计划——而不是每个要点醒一次（§3.4） |
| **程序记忆 / 陈述记忆** | 技能与流程 / 经验教训（§3.7） |
| **子 agent 历史** | 不设管理：一计划一子级、无跨计划记忆，上界由**总预算**给出（§3.4） |
| **续跑** | 指"问人后带答案重入当前计划"；不做冷恢复（重放整个子级历史 + 多个失败先决条件）（§3.6） |

---

## 1. 决策者拓扑

```
根 T2 agent（一 session 一 agent，宿主强制 agent/src/index.ts:467）
  │  计划编制（assistant message 落日志，不建 plan 存储）
  │  派单 = T2 调宿主原生 `subagent` 工具（provider=spawn、backgroundMode=continuable，
  │    preset 已挂，agent.cordis.yml:180-186）——插件不自建派单通道
  ▼
子 agent（每计划一个，串行执行 N 个要点；无跨计划记忆）
  │  结算（完成/受阻/越界请示/异常终止）→ 宿主投递结算通知（best-effort）
  │  执行中遇必须问人的事 → 结果携带问题上浮（子 agent 调 ask 被 DELEGATED_CALLER 拒绝）
  ▼
根消化结算 → 问人（userQuestions 仅根可达）→ 带答案重入当前计划 或 重规划
```

**预算与释放**（§3.4）：`agent/created` 时登记 `{childId, deadline}`（Config 缺省预算）；到期 → `interrupt_agent`，报告走宿主结算路径（interrupt → 子级到静止态 → 宿主投递，单一报告，插件不自报）。**`wait()` 必须响应 `exec.signal` 并自带超时**——这是唯一的释放阀门（`interrupt` 只停当前回合、不释放激活槽）。

硬约束（全部宿主强制，设计与之同构）：

1. **一 session 一 agent**（`agent/src/index.ts:467`）——根与子 agent 是不同 session；
2. **owned 子 agent 不能问人**（`packages/interaction/user-questions/src/index.ts:101-105`）——人工交互天然收敛根一处；
3. **`agent/created` 对子 agent 同发**（`agent-loop/src/index.ts:614-624`）——工具注册一条路径覆盖两层，无"子 agent 工具注入"专项问题；
4. **结算通知由宿主投递**（`continuation-activation.ts:881`）——**但是 best-effort**（四种不唤醒状态，见 §0.2），交付失败由预算路径承担；
5. **spawn = 全新会话**（`seed` 缺省，`subagent/src/types.ts:239-243`）——子 agent 无 T2 历史，隔离即安全。

计划生命周期：T2 编制 → 调宿主 `subagent` 工具（spawn，fresh）→ 要点串行执行（执行智能消化步骤级意外）→ 一种结算唤醒根 → 根计划级检视（消化本次结算 + 看在途计划）→ 续 / 结 / 重规划。

---

## 2. 五层 → 文件与承载映射

```
src/
├── index.ts          # apply(ctx, config) 装配一切（唯一大范围碰 ctx 的文件）
├── config.ts         # Config schema（连接、静默/超时缺省、路径、预算缺省、教训上限）
├── persona.ts        # 思考层"软件"：systemPrompt.section 注册（不是自拼字符串）
├── link/             # 存在层（纯 TS，零宿主依赖，可独立回放测试）
│   ├── mud.ts        # 连接、行流分发、持有者、read 竞速机（响应 signal + 自带超时）
│   ├── telnet.ts     # telnet 协议层（IAC/MCCP2/GA/EOR → 边界事件）
│   ├── ansi.ts       # 流式行解析（含跨块终止符与序列缓冲上限）
│   └── corpus.ts     # 行流 JSONL + log-only 事件
├── awareness/        # 反射 + 意识（纯 TS）
│   ├── observe.ts    # observe 入口：每行调度（薄）
│   ├── reflex.ts     # REFLEX 表（数据；吞触发行、留结果）
│   ├── danger.ts     # 危险判据（一份数据，字段化动作意图）
│   └── world.ts      # 工作记忆：世界状态（分区 + 置信度分档）
├── wake/             # 唤醒（wake 经注入窄接口；context 纯函数）
│   ├── wake.ts       # 两源自建唤醒 → DSH 动词
│   └── context.ts    # 唤醒正文（事实短消息 + 世界摘要）——瘦
├── tools/            # 执行域（接线层）
│   ├── tools.ts      # mud_send / mud_flow / mud_state + 子会话静态禁发表
│   └── flows/        # types / index / login / fullme
├── subagent/         # 子级编排（接线层）
│   └── subagent.ts   # agent/created 监听 + 预算登记与到期 interrupt
└── lessons.ts        # 教训库（第二期）
skills/               # 程序记忆（人写种子 SKILL.md；热加载宿主原生）
package.json / cordis.patch.yml / vitest.config.ts
```

| 心智层 | 文件 | DSH 承载 | 自建 |
|---|---|---|---|
| 存在 | link/（mud/telnet/ansi）+ awareness/world | 无（纯自建；telnet/ansi 用实录验证过的解析实现） | socket 生命周期、行流、状态机 |
| 反射 | awareness/reflex.ts | 经 mud.send 直发（**宿主不可见**，不经工具管线） | 表数据 |
| 意识 | awareness/observe+danger、wake/ | 危险唤醒经 `steer`（`runtime-types.ts:224-231`）；静默经 `followup`；**结算唤醒由宿主投递** | 判据、静默 timer（参考 `schedule/runtime.ts`） |
| 思考 | persona.ts、wake/context、tools/、subagent/ | persona=`systemPrompt.section`（`:454-463`）；历史每请求自动携带（`agent-loop/agent.ts:631`）；派单=宿主原生 `subagent` 工具（preset 已挂）；权限=工具内静态禁发表 | 唤醒正文、计划格式约定、禁发表数据 |
| 记忆 | awareness/world、lessons、skills+flows | skills 热加载原生（`skill-filesystem:492-557`）；摘要注入 `tool-skill:213-249` | lessons 存储（第二期） |

**四条承载约束**（设计对宿主的硬依赖，实施时不得绕过）：

1. **prompt 不自拼**：注册 `systemPrompt.section`（persona 段 `:127, :158`），由宿主每请求组装（`agent-loop/agent.ts:631`）；
2. **历史不搬运**：历史**每请求自动全量携带**（`agent-loop/agent.ts:631` + `deriveMessages()`）——计划/报告/技能调用都在历史里，组装器**只补模型看不到的东西**：世界状态 + 唤醒原因（§3.4）；
3. **直发可见性**：直发 = socket 写，**宿主与工具管线都不可见**；是否进在途等待的累积文本由我们的分发策略决定——**缺省照常进，实录若误命中再切隔离**（§6）；
4. **计数口径**：`request/header` 只在首请求/变更/series 时发，**不能计数决策点**；用 `step/start` 计决策点、`assistant/message` ∪ `assistant/attempt` 计实际调用（§4）。

纯度纪律落在目录上：`link/`、`awareness/` 为纯 TypeScript（不 import 宿主）；`wake/context.ts` 为纯函数，`wake/wake.ts` 经注入的窄接口 `{ followup, steer, idle }` 操作 agent；只有 `index / persona / tools/ / subagent/ / lessons` 的接线接触 `ctx`。

**每层禁令**

- 存在：不解释语义；
- 反射：只放天然无后果的机械反应，不做后果评估；
- 意识：**薄**——只感知与触发，加理解即违反 T2 优先；
- 思考：**T2 唯一持有目标与意图连贯性**；无两执行者、无仲裁——计划内子 agent 是执行半边，不是第二个意图主体；
- 记忆：无执行权（教训只注入，技能/流程只作为词汇被引用与调用）。

---

## 3. 各层实现

模板：design4 职责 → DSH 承载（file:line）→ 自建设计 → 本层禁令。

### 3.1 存在层（mud.ts）

```ts
class Mud {
  private conn: TelnetClient                // 自建出站（telnet.ts）
  private parser: AnsiStreamParser          // ansi.ts
  private buffer: MudLine[] = []            // 有界缓冲（512 行 / 64KB，超限丢最旧记错）
  private reading: WaitState | null = null  // 会话级持有者：唯一占行流的等待状态
  private holder: 'root' | `child:${string}` | null = null  // 持有者身份（fail-loud 用）

  onLine: (line: MudLine) => void           // 装配时注入 awareness.observe（永续）
  onBoundary: (kind: 'ga' | 'eor') => void
  send(cmd: string): void                   // 直发：反射/流程共用；不占行流
  read(o: WaitOpts): Promise<ReadResult>    // 竞速机（§3.2）
}
```

- socket → telnet.decode → ansi.write → 逐行 `onLine`（推送式，不新建循环）；
- GA/EOR 由 telnet 提取为 `onBoundary`（协议边界唯一出口）；
- **行分发顺序**：每行先意识层（`onLine` 永远执行，与谁在等无关），再归 wait（若 `reading` 非空）——意识层永远看得见行流，"永续供给"的实现；
- `send` 不占行流：反射永不被持有者阻塞；**直发对宿主不可见**（不经 `tools` 管线，无 `pre-execute`、无留痕）——留痕靠 `corpus.ts` 自记；
- **持有者是会话级的**：根与子级都持有全套工具，若并发 read 会各拿半截行 ⇒ `mud_send`/`mud_flow` 入口检查 `holder`，冲突即 fail loud（不做队列）；
- **`read()` 必须响应 `exec.signal` 并自带 `timeoutMs`**：这是唯一的**释放阀门**（§1 预算段）——工具不响应 signal，子级就永远无法到达 quiescence，占着激活槽不放；
- **send 帧格式**：缺省发送字节 + 自动补 `\r\n`；翻页空命令的精确字节 **待实测核对**（§6）；
- **断线** = socket close 事件（非行）：在途 read 以 `reason:'disconnected'` 收束、流程结束、经危险 latch 醒根、登录标志复位；重连缺省为下次 `mud_send` 隐式建连 + login，策略 **§6 待实测校准**（宿主 resume 只恢复历史不恢复 socket，`NOT FOUND`）。

**禁令**：不解释语义、不做危险判断（判据在 danger）。

### 3.2 行等待竞速（mud.ts 内部实现细节）

```
read(o):
  1. 持有者检查：本会话已有持有者 → 抛错（fail-loud，不做队列）
  2. 先消费 buffer（rest 同帧移交：本次 send 之前的到达行先结算）
  3. 建竞速状态 { opts, acc, lines, gaSeen, quietTimer, timeoutTimer, signal }
  4. 判定序（写死）：danger > failOn > until > gaCount > quietMs > timeoutMs > maxLines
     - danger：行到达钩子同步测（与意识层同一份 danger.ts）
     - failOn / until：在 acc（累积文本）上测——**完成句可跨批命中**（实录语料事实）
     - gaCount：onBoundary 钩子计数
     - quiet / timeout：计时器；maxLines：行数兜底
     - **signal：`exec.signal` 中止 → 立即以 reason:'aborted' 收束并释放持有者**（释放阀门）
  5. resolve → ReadResult{lines, reason, rest?}；持有者置空
```

- **`timeoutMs` 必须显式给出或由工具注入缺省**：绝不无界等待（否则子级永不到达 quiescence，占着激活槽）；
- 声明了 `until` 却以 `quiet`/`timeout` 收场 → 记 error（判据失配要吵，语料可见）；
- 危险命中 → 以 `reason:'danger'` 返回，流程按 §3.6 危险出口结束；
- **直发输出：反射类"吞触发行、留结果"**（§3.3）——反射的**触发那一行**不进模型面，其应答照常进并参与判据；
- `ask` 不在此处：等人发生在根侧工具结果回流之后，不存在跨会话挂起；

**禁令**：竞速机不持有业务状态（不记世界、不做唤醒决策——danger 命中的唤醒由意识层/根侧结算处理）。

### 3.3 反射 + 意识层（awareness.ts / danger.ts）

```ts
const REFLEX = [                                  // 反射：天然无后果的机械反应
  { re: /系统将在.*分钟后存档|请及时存档/, cmd: 'save' },
  { re: /按回车继续| press enter/i,     cmd: '' },  // 翻页空命令
]

observe(line):                                    // 每行执行，薄
  world.reduce(line)                              // 抓取：HP/内力/位置/战斗态
  const d = danger.match(line)
  if (d) {
    if (d.interrupt) mud.send('halt')             // 紧急中断当前活动：暂按"危险即中断"处理（细则暂不设计）
    if (d.wake) wake.steer(d)                     // 连续谱：判据自带动作意图
    if (d.abortWait) reading?.abort('danger')     // 行等待中断（reason:'danger'）
  }
  for (const r of REFLEX) if (r.re.test(line.text)) { swallow(line); mud.send(r.cmd) }  // 吞触发行、留结果
  wake.armSilence()                              // 静默重置（重新武装锚点：新行到达，§6）
```

- **危险判据一份数据、字段化动作意图**：`{ re, interrupt?, wake?, abortWait?, why }`——一张表同时服务紧急中断、等待中断、T2 唤醒，不许两处派生；
- **"中断当前活动"的用法暂不设计**：它本质是流程性、防御性的操作；当前只需保证"觉察到危险时能中断手里的活动"，不为它建去重表、不建"中断 → 后续动作"配对、不为它标定线。等真实场景需要区分对待（哪些活动该中断、哪些不该）时再补规则；
- **危险唤醒的去重 latch 挂世界状态、不挂行模式**：行模式（"遭攻击"逐行命中）会在战斗**每回合**重新武装 → 每回合唤醒根，与 token 第一约束冲突。latch 用 `world` 字段（如 `inCombat`），一次战斗一条 latch，条件解除才重新武装；
- **反射"吞触发行、留结果"**：命中反射后，**触发那一行**不进模型面；该命令的**应答照常进模型面并照常参与判据**（整条吞掉会静默丢失"存档失败"这类负面结果）。语料与日志始终保留全部行——"吞"只作用于模型可见面；
- **越界不唤醒**：HP 缓降、进入战斗等无行可警的越界只更新 `world`，随静默唤醒摘要上浮；行级可警（遭攻击/死亡/断线）仍立即——意识层因此**不长第四条计时链路**；
- REFLEX 入选纪律：只放天然无后果动作；直发走 mud.send（宿主不可见，§2 修复3）。

**禁令**：只感知与触发，不解释内容、不生成动作序列、不持有目标。

### 3.4 思考层：唤醒、上下文、persona

**唤醒器（wake.ts）——三源，其中结算源由宿主投递：**

```ts
class Wake {
  private silenceTimer                 // 有界静默 timer（形态参考 schedule/runtime.ts:194-201）
  private latch: string | null         // 危险去重：**挂世界状态**（如 inCombat），条件解除才重武装

  // 静默到期唤醒：静默 && 无行流持有者（"没事且没事干"）
  //   **不要**写"无子 agent 在途"——list_agents 的 inactive 不代表任务完成，
  //   已结算的子级仍在目录里，据此判会让根首次派单后永久认为"有事在干"（V7）；
  //   **也不要写"结算已消化"守卫**——双唤醒窗口无害，接受冗余唤醒
  //   （T2 的决策输入是唤醒正文，不是唤醒次数）
  onSilence(): agent.followup(context.silence())     // followup: runtime-types.ts:222

  // 危险唤醒：steer 空闲自开回合、运行中步边界插话（runtime-types.ts:224-231, agent-loop/agent.ts:159）
  //   latch 判据 = world 字段跨越（见 awareness）；行模式会每回合重武装 → 唤醒风暴
  steer(d): agent.steer(context.danger(d))

  // 结算上报：宿主投递（continuation-activation.ts:881：idle→followup / running→steer）
  //   插件不重复唤醒，也不自报结算；**必须按 best-effort 理解**——四种状态不唤醒（其中两种静默）
  //   交付失败无独立兜底：由预算路径承担
  //   根消化结算（续跑/问人/重规划）是 T2 读文本的事，插件不解析
}
```

**上下文组装（context.ts，纯函数，瘦）**

历史每请求自动携带（`agent-loop/src/agent.ts:631` + `deriveMessages()`）——计划、结算报告、技能调用都已在上下文里，**组装器不搬运历史**。每次唤醒正文只补两件模型看不到的东西：

```
buildWakeContext(reason) =
  [唤醒原因：事实短消息，不是指令]        // "静默环顾" / "危险：遭攻击（HP 18%，位置 茶室）" / 事实陈述
  [世界摘要：字段清单判据]              // 入选 = T2 本次决策必需：
                                       //   HP / 内力 / 位置 / 登录态 / 饥饿口渴 / 金钱
                                       //   + 越界事实（HP 缓降等搭静默这趟车）
                                       // 新增字段必须写理由——防孤儿字段
  [教训注入（第二期，lessons）]
```

- 计划**不单独建存储**：T2 输出计划 = assistant message 自然落会话日志；进度 = 结算报告（user message）。不建 plan 状态机、不建进度跟踪器；
- **compaction 是缺省挂载的**：缺省 profile 挂 `compaction-basic`（每个 `pre-step` 自动跑）+ 工具结果裁剪（>8192 字符裁成 4096+标记+1024），它按预算**重写会话面**。"计划被压缩导致失忆"目前**无例证，不建守护**；若实测出现，先考虑部署层关 compaction，再考虑重注机制（§6）；
- 克制原则：唤醒原因是事实（"HP 18%"），不是指令（"请逃跑"）。

**persona（persona.ts）**

注册 `systemPrompt.section({name, order, text})`（**参数是对象**；persona 段固定名 `:127, :158`，组装 `:454-463`）——不自拼字符串进每次请求。内容：五层身份（你是玩家，下属替你跑腿）、**服务端拒绝是教育信号**（"你正忙着"这类应答说明活动没做完，先处理手里的活再重试）、**子级在途时不得直接调 `mud_send`**（应走 `send_message`/`interrupt_agent`）、工具用法、计划格式（要点 + 边界声明 + 预算）、维持类自查（口渴/饥饿/疲劳是要你规划的事）、**fullme 兜底常识**（第一期没有识别工具；问题上浮回到你这，你问人取码后带答案重入当前计划）。

**禁令**：T2 唯一持有目标与意图连贯性；意识/反射不得替 T2 做计划级决策；无两执行者——子 agent 是计划执行半边。

**预算与释放阀门**（宿主侧没有这两个概念，是插件唯一保留的子级运营状态；登记与 timer 落在 subagent/，不在 wake/）

- **总体预算**：每个子 agent 一份（Config 缺省）；`agent/created` 时登记 `{childId, deadline}`（登记与 timer 在 subagent.ts，与唤醒器分离——预算是子级编排的事）；到期 → `interrupt_agent`，报告走宿主结算单通道（interrupt → 子级到静止态 → 宿主投递，**插件不自报**，无双结算去重问题）。**不设**子级看门狗、**不设**在途上限；
- **禁止用轮询 `list_agents` 判定**（`inactive` 不代表任务完成）；
- **释放阀门是协作式的**：宿主无任何子 agent 超时；激活槽只在"启动回滚"与"激活终结"两处释放，而 `interrupt` 只 `agent.cancel({keepInbox:true})`、**不释放槽**，终结由 `watchSettlement` 的 `await whenIdle()` 驱动且要求 `inbox.hasPending === false && ownedChildren.size === 0`。⇒ **`wait()` 响应 `exec.signal` + 自带超时是硬前提**（§3.2），否则子级永远到不了 quiescence、槽永久占用；
- **失败也算结算**：预算耗尽的"超时失败"本身就是一次结算通知，经同一通道回根——**不另设"结算看门狗"**（结算通知的 best-effort 交付失败由本条承担）；
- 端到端验收两条：**子级超预算 ⇒ 根必被唤醒且槽被释放**；**根与子级并发 read 必须被拒**。

### 3.5 执行域：工具面与权限编译（tools.ts / subagent.ts）

**工具面 listener 的作用域（实施前提）**：注册在**父 agent 自己作用域**的 `agent/created` listener **看不到自己的子级**（父与子 agent 的作用域是**兄弟**，都挂在 preset standing key 上）。⇒ 必须注册在**宿主（未限定作用域）**或 **preset 作用域**；并加装配期自检：**已创建子 agent 的可见面必须包含 `mud_send`/`mud_flow`/`mud_state`**。

```ts
mud_send({ cmd?, listen?, timeoutMs? })
  // 无 cmd = 裸读；有 cmd = send + read（listen 缺省 gaCount:1）
  // 返回 ReadResult.lines 原文（过程即结果，模型看原文自决）
  // 超时必须显式给出或由工具注入缺省（宿主无默认超时，协作式 tools.md:64-68）
  // 子会话命中静态禁发表（suicide/quit/drop all 类，正则一行判断）→ 直接拒
mud_flow({ id, answer? })     // 流程注册表调用；answer = 根侧重入时带的决策/人给的值
mud_state()                   // world 快照
// 第一期**不注册** captchaRecognize：必然失败的桩会让模型反复调用、白烧请求
```

- 工具结果原文返回（`concludeTurn` 仅成功携带，`tools:1421-1423`——失败结果不结束回合，模型继续决策）；
- `deferContext()` 可用于把大块行流推迟到下一轮（一次性读，`tools:1418-1420`）——第一期不用，知道有这根线；
- 危险命令 denylist 一行判断直接返回错误（工具内，不建权限机制层）；
- 首次 `mud_send` 隐式建连 + login（已登录标志防重入；断线复位）。

**静态遮蔽（不做动态权限）**

- 根会话：放行（mud 工具面 + userQuestions 正常可达）；
- 子 agent 会话：`mud_send` 工具内一张**静态禁发表**（suicide / quit / drop all 类不可逆命令）命中即拒，deny 不进 body；`mud_flow` 越权 flow id 同样直接拒；
- 计划边界**不进权限系统**：经济类动作（买/卖）不被拦——"取钱/买食物"全链路验收依赖它。子级自作主张发经济命令目前**无例证**，按"先例证后机制"不加任何处理，靠语料审计事后发现；
- 人工交互：子 agent 侧不注册/不暴露 ask 能力（宿主 `DELEGATED_CALLER` 兜底，`packages/interaction/user-questions/src/index.ts:101-105`）——设计与强制同构。

**计划下发与结算（subagent.ts，第一期）**

```
T2 输出计划（assistant message，含要点+边界声明）
  → T2 调宿主原生 `subagent` 工具派单
      // preset 已挂：provider=spawn、toolName=subagent、backgroundMode=continuable
      //   （agent.cordis.yml:180-186；seed 缺省 = 全新会话，subagent/src/types.ts:239-243）
      // prompt = 要点+边界+相关技能/战术教训正文，由 T2 用 skill 工具自取拼接
      //   （宿主只把技能目录注入根会话，子级看不到卷宗；插件不自建派单通道）
  → 子 agent 串行执行：mud_send/mud_flow（前提：listener 注册在宿主/preset 作用域）
      // 步骤级意外自行消化；服务端拒绝（如"你正忙着"）→ 自行处置后重试（执行智能）
      // 必须问人的事 → 结算末尾 QUESTION 节（不能 ask——DELEGATED_CALLER）
      // 预算到期 → interrupt_agent（§3.4，宿主结算单通道回根）
  → 结算通知 → 宿主投递到根（continuation-activation.ts:881；**best-effort**）
      // 书写约定（persona 层，无代码解析）：
      //   RESULT: done | blocked | question | failed
      //   QUESTION: <需人回答的问题，仅 question 时>
      //   本次新学到的教训: <…>
  → 根计划级检视（T2 读结算文本）：
      done  → 记录，检视是否结计划/续下一点
      question → userQuestions.ask(question)（仅根可达）→
          答案 → **带答案重入当前计划**（优先；mud_flow({id, answer})）
                  冷恢复续跑仅作例外（重放子级历史 + 四个先决条件，基本不用）
      异常终止/未达 → 按失败处理，必要时重规划
      受阻/危险 → 子级在读等待中遇危险已走 abortWait（read 返回 reason:'danger'），
                  携现场结算；卡在 read 之外由根 interrupt()（§3.4）
```

- 要点级拆分、模型降档（**只适用 spawn 路线**）= 支，不进第一期；
- **危险 × 在途子级的通道策略（原待定，已定案）**：子级在读等待中遇危险走 `abortWait`（read 返回 `reason:'danger'` → 携现场结算，无新增机制）；子级卡在 read 之外才由根 `interrupt()`。**注意 `interrupt_agent` 不是 kill**（只停当前回合、保留 inbox 与激活槽）。

**禁令**：无两执行者、无仲裁——只有单向"处置不了就升级"（危险 → 意识层 abort wait + 醒根）。

### 3.6 凭据与标准流程（flows/）

- 形态：`Flow = { id, description, run(ctx) }`，async 函数，`tsc` 即校验；
- `FlowCtx = { mud, creds, answer?, signal }`——**没有 `ask`**（等人只在根会话）；
- 密码/验证码发送瞬间插值，明文不进任何模型上下文（凭据 `resolve` 双键空间）；
- 加流程 = 加文件 + index 数组一行；对模型只暴露 `mud_flow({id})`。

**三个出口**（流程只能从这三处结束）：

1. `done:true` —— 完成；
2. `done:false, question, lines` —— **带问题结束**：必须重放无害才允许此出口（fullme 收图重放无害；含不可逆副作用的流程不得走此出口）；
3. `reason:'danger'` —— 危险中断（§3.3 abortWait 同源）。

结算书写约定（persona 层，无代码解析）：子级结算末尾固定 `RESULT:` / `QUESTION:` / `本次新学到的教训` 三节（§3.5）；流程出口的 `{done, question}` 是**代码侧 FlowResult**，由子 agent 转写成上述文本约定进结算。

**fullme 链路（问题随结果上浮，问人只在根）**：

```
子 agent 调 mud_flow({ id:'fullme' })
  → 收图（游戏行流；服务端若拒绝则自行处置后重试——执行智能）
  → 流程以 { done:false, question:'验证码：<图或行原文>' } 结束
       // 第一期**不注册**识别工具：必然失败的桩会让模型反复调用、白烧请求
       //（第二期有真承载再注册，链路与验收路径都不变）
       → 问题随子 agent 结算上浮（子 agent 侧 ask 被 DELEGATED_CALLER 禁死）
       → 根 userQuestions.ask() 问人 → 答案回流
       → 根**带答案重入当前计划**（mud_flow({id:'fullme', answer})）
          // 冷恢复续跑只作例外：重放子级历史 + 四个先决条件
```

- **第一期不注册 `captchaRecognize`**：模型看得见工具 schema，一个必然失败的工具会让它**先反复调用再回落问人**，每次白烧请求。接口形态由 `FlowResult`/流程签名在类型层保持即可；
- 这条失败路径是现阶段**真实路径**，不是异常分支——第一期验收必须走通它（§4）。

**禁令**：流程无执行智能之外的权限（不可逆动作被子 agent pre-execute 拦在工具层）；凭据永不进上下文。

### 3.7 记忆（world / lessons / skills+flows）

| 类型 | 实现 | 期次 |
|---|---|---|
| 工作记忆 | world.ts（会话内，意识层维护，所有层同读） | 第一期 |
| 程序记忆 | `skills/mud-<name>/SKILL.md` 人写种子（找路/喝茶/买东西）+ flows/（login/fullme）；宿主热加载、模型可见 | 第一期种子；沉淀第二期 |
| 陈述记忆 | lessons.json（上限 N 条；战略进唤醒上下文、**战术拼进子 agent 任务描述**；超限由 T2 归纳） | 第二期 |

- **子级必须先能读到，才谈得上积累**：宿主只把技能**目录概要**注入根会话，子级看不到卷宗 ⇒ 相关技能/教训正文要**由根拼进子级 prompt**（`ctx.skills.get()` + `renderSkillContent()`；**没有**"注入某技能到某子 agent"的专用 API）；
- **教训回库第一期用文本约定**：子级结算末尾固定一节"本次新学到的教训"，根据此决定是否沉淀（宿主**没有**结构化输出通道）；
- 因此成本账目写的是"**随记忆积累下降**"（不是"单调下降"）：其前提是回库链路已通，否则每个子级都从零学起；
- 沉淀（第二期）：成功要点 → SKILL.md 候选——T2 用宿主 write 工具写文件，**热加载与缓存失效宿主原生**，插件零接线。**但四条前置必须装配期自检**（否则静默失效）：① 组合里真有 `tool-skill`（目录注入与 root 保留由它触发）② 沉淀走 `write`/`edit`（只有这两个工具名走快速失效）③ 会话有 cwd ④ 沉淀**低频批量**（每次目录变更都会在根历史追加一整份新目录副本，旧副本不被替换）；
- 技能/流程对计划是**词汇**：编制时引用、执行时调用，无执行权。

### 3.8 观测（corpus.ts）

- **行流语料**：JSONL 全量落盘（时间戳 + 原文）——自有通道；**不进 Session**（`session.append` 是同步通知、高频行会拖账；自定义类型虽 log-only（`session/index.ts:720-724`），行级频率仍只落 JSONL）；
- **Session log-only 事件**（交换级，低频，白名单外天然不进模型）：`mud/command-sent`、`mud/exchange-complete`（read 返回时）、`mud/danger-fired`、`mud/flow-result`；
- **计数（写死，两个量）**：**决策点数 = `step/start` 数**（正确性护栏：空续步必须为 0）；**实际调用数 = `assistant/message` ∪ `assistant/attempt`**（成本侧，两者之差即重试/失败）。**禁用 `request/header`**（只在 initial/resume/change/series 时发）。

---

## 4. 观测与验收账目

**计数口径（写死）**：见 §3.8——`step/start` 作决策点护栏，`assistant/message ∪ assistant/attempt` 作实际调用数；`request/header` 不可用于计数。

**四行为验收**

| 断言 | 内容 |
|---|---|
| 账目护栏 | 每场景：`step/start` 数 == 真正需要模型决策的次数；对照实证基线 |
| **成本护栏** | 每场景：**root 上下文规模 / 峰值 token 不劣于实证基线**（只数步数验不了成本）；短任务走 T2 直跑 |
| **链路覆盖** | 四行为（取钱/买食物/喝水/找路）**至少一次走通** 编制 → 调宿主 `subagent` 工具派单 → 子 agent 执行 → 结算通知 → 根检视——只测根直跑等于没测干 |
| 语料回放四条 | 完成句跨批 / 危险中断 read / rest 同帧移交 / until 失配记错——先红后绿 |
| 静态遮蔽 | 子会话发自杀 / quit 类命令 → `mud_send` 工具内拒、deny 不进 body；根会话放行；经济类越权靠语料审计兜底（无机制） |
| 工具可见面 | 已创建子 agent 的可见面**含** `mud_send`/`mud_flow`/`mud_state`（listener 作用域正确性的唯一可执行证据） |
| 释放 | 子级超预算 ⇒ 根必被唤醒**且激活槽被释放**；根与子级并发 read 必须被拒 |
| 人工唯一性 | 全程 `userQuestions` 调用只发生在根会话（子 agent 0 次——DELEGATED_CALLER 保证 + 断言防回归） |

**fullme 场景单列（新链路必测）**

```
给定：continuable 子 agent 执行 fullme 要点；第一期**未注册**任何识别工具
断言：
  1. 子 agent 侧 userQuestions 调用数 == 0
  2. 根侧 userQuestions 调用数 == 1（问人取码）
  3. 问题确实经结算上浮（结算事件 + 根侧 assistant/message 可见 question 文本）
  4. answer 回流后**带答案重入当前计划**（`mud_flow({id, answer})`），端到端 done:true；
     冷恢复续跑不作为主路径
  5. token 账目：根 = 编制 1 + 结算检视 1（+问人轮次）；无额外浪费唤醒
```

**成本主张（按计划长度加条件）**：**长计划**账目不劣于现状（短计划可能反超——1–2 步的 T2 直跑更省），由验收逐场景断言，恶化即回退；且必须同时断言**成本量**（root 上下文规模 / 峰值 token），只数步数验不了成本。

---

## 5. 实施顺序

**第一期（干）**：三源唤醒 + 唤醒正文 + 计划编制 + 单子 agent 串行 + 结算通知 + 预算与释放阀门 + 计划级检视 + **子会话静态禁发表** + fullme 根侧兜底。

**开工前必须已落的三项**（否则验收会翻车或子级无工具）：

1. **静态禁发表**：随 `mud_send` 工具落地，子会话生效（§3.5）；
2. **监听器作用域**：`agent/created` 注册在宿主或 preset 作用域，并加"子级可见 mud 工具"的装配期断言（§3.6）；
3. **成本指标**：验收必须同时量 token 成本（§4）。

| 步 | 内容 | 依赖宿主 |
|---|---|---|
| 1 | mud.ts + telnet/ansi + wait 竞速机 + rest + **会话级持有者** + **响应 signal/自带超时** | 无 |
| 2 | 语料回放用例：完成句跨批 / 危险中断 read / rest 移交 / until 失配记错 | 无（先红后绿） |
| 3 | awareness + world + danger（字段化意图）+ REFLEX（**吞触发行**） | 无 |
| 4 | wake（静默+危险）+ context 瘦正文 + persona section（**含"子级在途不得直调 mud_send"**） | followup/steer；systemPrompt.section |
| 5 | tools（mud_send/mud_state/mud_flow）+ flows/login | tools.register；agent/created（**作用域见前提 2**） |
| 6 | **subagent 拓扑**：`agent/created` 监听 + 预算登记（Config 缺省）与到期 interrupt + 子会话静态禁发表 | 宿主 `subagent` 工具（preset 已挂）；userQuestions 根侧 |
| 7 | **fullme 链路**（**不注册识别工具**；问题上浮 → 根问人 → 带答案重入） | tools；userQuestions（DELEGATED_CALLER 天然生效） |
| 8 | corpus + 计数护栏（**两个量**）+ 成本护栏 + §4 验收全表 | session 事件 |

验收：§4 全表——四行为含全链路、fullme 含端到端问人、静态遮蔽与人工唯一性、释放与可见面断言。

**第二期（支，按账目生长，顺序不预设）**

| 支 | 内容 | 引入判据 |
|---|---|---|
| 1 | skills 种子完善 + 教训库（lessons + 注入 + 归纳**文本约定**） | 跨会话重复犯错实证 |
| 2 | 技能沉淀自动化（成功要点 → SKILL.md 候选，宿主 write + 热加载零接线；**四条前置做成装配期自检**） | 同类任务重复实证 |
| 3 | 反射表/危险判据按实测增补 | 语料审计 |
| 4 | 子 agent 模型降档（**只适用 spawn 路线**） | 子 agent 账目稳定后 |
| 5 | 要点级拆分与编排 | 计划粒度实测证明必要 |
| 6 | captchaRecognize 真承载接入（**注册工具并换 execute，链路与验收路径不变**） | 承载研究完成（§6） |
| 7 | compaction 重注机制（**无例证不建**；若实证出现，先试部署层关 compaction） | 计划被压缩致失忆的实证 |

护栏：任何支使 token 账目恶化即回退；关掉任何支退化为第一期干。

---

## 6. 待实测 / 待定（实施时校准）

**MUD 侧（语料实测）**

| 项 | 缺省策略（实测前） |
|---|---|
| 危险判据刻度（正则与阈值标定） | 用实测语料标定 |
| 紧急中断命令的具体用法（哪些活动该中断、是否去重、是否配对后续动作） | **暂不设计**：当前只需"觉察到危险能中断手里的活动"，等真实场景需要区分对待时再补规则 |
| 静默计时器的重新武装锚点 | 新行到达即重新武装（写死） |
| 断线重连入口 | 隐式重连（下次 `mud_send`） |
| send 帧格式 / 翻页空命令字节 | 补 `\r\n`；逐字节对实录核对 |
| 静默时长取值 | Config 化，语料回放校准 |
| 子 agent 预算取值 | Config 化，按计划长度实测 |

**宿主与拓扑**

| 项 | 备注 |
|---|---|
| 危险 × 在途子 agent 的通道策略 | **已定案**：子级在读等待中遇危险走 `abortWait`（read 返回 `reason:'danger'` → 携现场结算）；卡在 read 之外由根 `interrupt()`。**`interrupt_agent` 不是 kill**（只停当前回合、保留 inbox 与激活槽） |
| captchaRecognize 承载研究 | `llm` 多模态 / `attachment` / 自调 VLM；**第一期不注册任何桩** |
| 计划被 compaction 压缩后的处理 | **无例证不建守护**；若实测出现计划被压缩致失忆，先试部署层关 compaction，再考虑重注机制 |
| 连接生命周期 | 缺省随会话（`session/disposed` 断连）；多会话需求出现再改 |
| 教训存储位置 | lessons.json 起步，storage 包可替换 |

---

## 7. 一句话总结

**文件跟五层心智走：存在（link/——`wait` 响应 signal 并自带超时，是唯一的释放阀门）、反射+意识（awareness/——判据字段化、反射吞触发行、危险 latch 挂世界状态、越界不设第四唤醒源、紧急中断命令的用法暂不设计）、思考（persona=section、context=只补模型看不到的、wake=两源自建+结算由宿主投递且为 best-effort）、执行（listener 注册在宿主/preset 作用域、派单走宿主原生 `subagent` 工具、子会话静态禁发表、计划走 continuable、一计划一子级且无跨计划记忆、总预算给出上界、到期 interrupt 且单一结算报告）、记忆（world/skills/lessons 三分无执行权，教训回库用文本约定）；计划不建存储（会话日志即计划；compaction 缺省挂载，但压缩致失忆无例证，不建重注守护）；fullme 第一期不注册识别工具，走"问题上浮 → 根问人 → 带答案重入"；干含子 agent，一切支以 token 账目为引入判据与回退护栏。**

> AI生成
