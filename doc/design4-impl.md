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

# mud-core2 实现设计（design4-impl）

- 状态：**实现设计**（2026-09-24，按 design4 五层心智架构整体重写）
- 前置：design4.md（五层心智框架；2026-09-24 已同步四项定案：结算即唤醒、干含子 agent、权限编译到宿主、越界并入静默，以及 fullme 工具优先/根兜底）
- 写作纪律：
  1. **宿主能力必带 `file:line`**（DSH 源码，路径相对 `D:\Code\deepseek-harness`）；查不到写 **NOT FOUND** → 自建或待实测；
  2. **不以 design1/2/3 的术语与接口作为论证依据**——旧稿只允许以"资产出处"身份出现（telnet/ansi 代码、实录语料）；
  3. **每层带本层禁令**（意识薄 / T2 唯一意图 / 无两执行者）；
  4. 与 design4 概念的冲突只列 §7 回写清单，不替 concept 选边。

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

接入：`dsh web --patch .../mud-core2/cordis.patch.yml`（patch 叠层，与现行开发命令同形）。依赖面全部为 DSH 宿主 API（工具注册 / followup·steer / credentials / skills / session.append / 生命周期），逐条见 §0.2——**零自建运行时**，自建项只有 NOT FOUND 清单所列。

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
| 每请求上下文 | 全量 `deriveMessages()` + `ctx.systemPrompt.section()` 组装；**无内建截断** | `agent-loop/src/agent.ts:631` |

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
| `start` / `startContinuable` | 前者阻塞至结束；后者立即返回，结算时唤醒父 | `packages/subagent/subagent/src/index.ts:559, :261-262` |
| 三模式 | 前台阻塞（`exec.signal→child.cancel`）/ background one-shot（job，不唤醒父）/ continuable（结算唤醒父） | `tool-subagent/src/index.ts:527-568`；`subagent-in-process-driver:168-170` |
| **结算即唤醒** | continuable 结算通知必投父会话：父空闲→followup（queue 路径）、父运行→steer 步边界插话；**无"只落日志不唤醒"第三态**；background one-shot 不唤醒 | `packages/subagent/subagent/src/continuation-activation.ts:871-888`（notifySettlement）、`:881`（idle→queue/running→steer）、`:334-346`（sendWaking→steer/followup） |
| 父子通信 | `sendMessage` 相邻会话互发；`interrupt()` 中断子代理 | `packages/subagent/subagent/src/index.ts:266-285`（sendMessage）、`:328`（interrupt） |
| 模型侧控制 | `tool-subagent-control`：`send_message / interrupt_agent / list_agents` | `tool-subagent-control/src/index.ts:29`（send_message）、`:77`（interrupt_agent）；`list-agents.ts`（list_agents） |
| spawn vs fork | spawn-in-process = **全新会话**（`seed` 缺省的 fresh child）；fork-in-process = 用父历史 seed | `subagent/src/types.ts:216-243`（seed 缺省=fresh）、`:377`；providers `subagent-spawn-in-process` / `subagent-fork-in-process` |
| `agent/created` 对子 agent | **同样触发**——工具注册一条路径覆盖两层 | `agent-loop/src/index.ts:614-624`；`docs/subsystems/core.md:776-794` |

**会话、人格与技能**

| 能力 | 事实 | 出处 |
|---|---|---|
| surface 白名单 | 恰 5 类：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` | `packages/core/session/src/types.ts:439-444`（SurfaceEventType）；`surface.ts:150-156` |
| 自定义 `session.append` | 天然 **log-only**（白名单外不进模型上下文） | `packages/core/session/src/index.ts:720-724` |
| resume | 只恢复历史，**不恢复运行时对象**（socket 恢复 NOT FOUND） | persistence 路径 |
| persona 装载 | `ctx.systemPrompt.section(name)` 注册节；persona 段有固定名 | `packages/core/system-prompt/src/index.ts:454-463`（section）；`:127, :158`（DEPLOYMENT_PERSONA_PREFIX/SUFFIX 段序） |
| skills 目录 | `skills/<name>/SKILL.md` + chokidar 热加载 + 模型 write/edit 同步失效缓存 | `packages/skill/skill-filesystem/src/index.ts:143-146`（write 失效）、`:492-557`（chokidar watch） |
| skills 模型可见 | 目录摘要在 `agent/pre-step` 注入；`skill` 工具按需取全文 | `packages/skill/tool-skill/src/index.ts:213-249`（pre-step 注入）、`:82`（skill 工具定义） |
| 定时器参考实现 | 有界分段 timer + `whenIdle` + 到期 followup，**永不打断运行中回合** | `packages/schedule/schedule/src/runtime.ts:194-201, :271, :290`；`packages/schedule/schedule/README.md:56` |

**计数与观测**

| 能力 | 事实 | 出处 |
|---|---|---|
| `request/header` | **change/series-only——不能用来计数决策点** | session 事件语义（change/series 才发） |
| 决策点计数 | 用 `step/start` 或 `assistant/message`+`assistant/attempt` | session 事件语义 |

**NOT FOUND（→ 自建或待实测）**

1. 通用出站 TCP 客户端 → **自建**（telnet/ansi 资产来自现行 mud-core 实现，照搬）；
2. 核心看门狗 / 静默定时器 → **自建**（可参考 `schedule/runtime.ts` 的有界 timer 形态）；
3. `wait_for_condition` 行等待竞速机 → **自建**（§3.2）；
4. 图片识别 / 验证码工具承载 → **自建桩 `captchaRecognize`，必然失败**（承载研究列 §6）；
5. 默认工具超时、ask 超时 → 不需要（宿主协作式，见核查表）；
6. resume 后的连接恢复 → 自建（策略 §6 待实测校准）。

### 0.3 术语清算表

| 旧稿术语 | 处置 |
|---|---|
| 三原语 / 流程即函数 | **弃用为主干表述**；wait/send 是执行域内部动作，为"执行智能"服务 |
| 单持有者（行读者互斥） | **重新推导**：游戏单活动 ↔ 一个计划一个子 agent 串行 + T2 静默不打扰（design4 §5.5 结构性对偶）；反射/halt 直发按定义在持有者之外——`send` 不占行流 |
| `flows/` 流程层 | **弃用为架构地位**；凭据/标准流程只是 `mud_flow` 工具的实现体（design4 §5.1 流程资源化） |
| 危险 abort/pause 两档 | **弃用**；判据逐条自带动作意图（halt?/wake?/abortWait?），实现为连续谱字段组合（§3.3） |
| rest / 累积匹配 / 300ms 静默 | **保留为行流管线实现细节**；论证从"完成句跨批"的实录语料事实重推，不引旧稿 |
| 流程内 `ask()` 挂起等人 | **弃用**；问题随结果上浮，问人只在根会话（宿主 DELEGATED_CALLER 强制同构，§3.6） |
| "报告异步回注 / 下次唤醒检视" | **修正**为"结算即唤醒、检视为计划级"（宿主 continuable 定形，design4 §3.3） |

---

## 1. 决策者拓扑

```
根 T2 agent（一 session 一 agent，宿主强制 agent/src/index.ts:467）
  │  计划编制（assistant message 落日志，不建 plan 存储）
  │  startContinuable（全新会话 spawn，非 fork——"无目标"的结构保证是无历史，不是提示词）
  ▼
子 agent（每计划一个，串行执行 N 个要点）
  │  结算（完成/受阻/越界请示）→ 宿主必唤醒根（continuation-activation.ts:881）
  │  执行中遇必须问人的事 → 结果携带问题上浮（子 agent 调 ask 被 DELEGATED_CALLER 拒绝）
  ▼
根消化结算 → 问人（userQuestions 仅根可达）→ 续跑（send_message 给存活的 continuable）或重跑或重规划
```

硬约束（全部宿主强制，设计与之同构）：

1. **一 session 一 agent**（`agent/src/index.ts:467`）——根与子 agent 是不同 session；
2. **owned 子 agent 不能问人**（`packages/interaction/user-questions/src/index.ts:101-105`）——人工交互天然收敛根一处；
3. **`agent/created` 对子 agent 同发**（`agent-loop/src/index.ts:614-624`）——工具注册一条路径覆盖两层，无"子 agent 工具注入"专项问题；
4. **结算必唤醒**（`continuation-activation.ts:881`）——源3 零自建；
5. **spawn = 全新会话**（`seed` 缺省，`subagent/src/types.ts:239-243`）——子 agent 无 T2 历史，隔离即安全。

计划生命周期：T2 编制 → `startContinuable`（provider=spawn，fresh）→ 要点串行执行（执行智能消化步骤级意外）→ 三种结算之一唤醒根 → 根计划级检视（消化本次结算 + 看在途计划）→ 续/结/重规划。**A1 残余**（危险 × 在途子 agent 的通道策略：`interrupt` / `exec.signal→cancel` / `ctx.agents.get(child).steer` 三原语已盘点，选哪条未定案）→ §6 待定。

---

## 2. 五层 → 文件与承载映射

```
src/
├── index.ts          # apply(ctx, config) 装配一切（唯一大范围碰 ctx 的文件）
├── config.ts         # Config schema（连接、静默/超时缺省、路径、教训上限）
├── persona.ts        # 思考层"软件"：systemPrompt.section 注册（不是自拼字符串）
├── mud.ts            # 存在层：连接、行流分发、send、read 竞速机（单持有者）
├── telnet.ts         # 资产照搬（IAC/MCCP2/GA/EOR → 边界事件）
├── ansi.ts           # 资产照搬（流式行解析）
├── awareness.ts      # 反射表 + 意识层：世界抓取调度、危险觉察(halt)、占线跟踪、静默重置
├── world.ts          # 工作记忆：世界状态（现行 state.ts 数据形态照搬）
├── danger.ts         # 危险判据（一份数据，字段化动作意图）
├── wake.ts           # 三源唤醒 → DSH 动词（经窄接口注入，不直接 import 宿主类型）
├── context.ts        # 唤醒正文（事实短消息 + 世界摘要）——瘦
├── tools.ts          # mud_send / mud_flow / mud_state / captchaRecognize + 权限编译
├── subagent.ts       # 计划下发、结算记录、send_message 续命（第一期）
├── lessons.ts        # 教训库（第二期）
├── corpus.ts         # 行流 JSONL + log-only 事件
└── flows/
    ├── types.ts      # Flow / FlowCtx（一页）
    ├── index.ts      # export const flows = [login, fullme]
    ├── login.ts      # 凭据流程（代码身份，密码不进任何模型）
    └── fullme.ts     # 标准流程：halt→收图→识别工具→发码；失败带问题结束
skills/               # 程序记忆（人写种子 SKILL.md；热加载宿主原生）
package.json / cordis.patch.yml / vitest.config.ts
```

| 心智层 | 文件 | DSH 承载 | 自建 |
|---|---|---|---|
| 存在 | mud / telnet / ansi / world | 无（纯自建；telnet/ansi 照搬资产） | socket 生命周期、行流、状态机 |
| 反射 | awareness 内 REFLEX 表 | 经 mud.send 直发（**宿主不可见**，不经工具管线） | 表数据 |
| 意识 | awareness / danger / wake | 危险唤醒经 `steer`（`runtime-types.ts:224-231`）；静默经 `followup`；**源3 结算唤醒宿主原生零代码** | 判据、halt 去重、静默 timer（参考 `schedule/runtime.ts`） |
| 思考 | persona / context / tools / subagent | persona=`systemPrompt.section`（`:454-463`）；历史每请求自动携带（`agent-loop/agent.ts:631`）；计划下发=`startContinuable`（`subagent/index.ts:261-262`）；权限=`pre-execute`+`restrict`（`tools:1499-1530, :1096-1099`） | 唤醒正文、计划格式约定、权限编译数据 |
| 记忆 | world / lessons / skills+flows | skills 热加载原生（`skill-filesystem:492-557`）；摘要注入 `tool-skill:213-249` | lessons 存储（第二期） |

**承载修复表（相对旧实现稿的四处纠正）**

| # | 旧稿写法 | 修正后 |
|---|---|---|
| 1 | persona 自拼进每次请求 | 注册 `systemPrompt.section`（persona 段 `:127, :158`），宿主每请求组装（`agent-loop/agent.ts:631`）——**不自拼** |
| 2 | "计划必须持久（组装时从日志取在途计划）"当作自建存储 | 历史**每请求自动全量携带**（`agent-loop/agent.ts:631` + `deriveMessages()`）——计划/报告/技能调用都在历史里，**组装器不需要搬运历史，只补模型看不到的东西**：世界状态 + 唤醒原因（§3.4） |
| 3 | 直发"混流进 in-flight read 的 acc"当作既定机制 | 直发 = socket 写，**宿主与工具管线都不可见**；进不进在途 read 的 acc 是我们的分发策略——缺省"照常进"，实录若误命中再切隔离（§6 B1） |
| 4 | `request/header` 计数 | `request/header` 是 change/series-only，**不能计数决策点**；用 `step/start` 或 `assistant/message`+`assistant/attempt`（§4） |

纯度纪律：`mud / telnet / ansi / awareness / world / danger / context / flows` 为纯 TypeScript（不 import 宿主）；`wake` 经注入的窄接口 `{ followup, steer, idle }` 操作 agent；只有 `index / persona / tools / subagent / lessons` 的接线接触 `ctx`。

**每层禁令（继承 design4）**

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
  private conn: TelnetClient                // 自建出站（NOT FOUND → telnet.ts 资产照搬）
  private parser: AnsiStreamParser          // ansi.ts 资产照搬
  private buffer: MudLine[] = []            // 有界缓冲（512 行 / 64KB，超限丢最旧记错）
  private reading: WaitState | null = null  // 单持有者：唯一占行流的等待状态

  onLine: (line: MudLine) => void           // 装配时注入 awareness.observe（永续）
  onBoundary: (kind: 'ga' | 'eor') => void
  send(cmd: string): void                   // 直发：反射/halt/流程共用；不占行流
  read(o: WaitOpts): Promise<ReadResult>    // 竞速机（§3.2）
}
```

- socket → telnet.decode → ansi.write → 逐行 `onLine`（推送式，不新建循环）；
- GA/EOR 由 telnet 提取为 `onBoundary`（协议边界唯一出口）；
- **行分发顺序**：每行先意识层（`onLine` 永远执行，与谁在等无关），再归 wait（若 `reading` 非空）——意识层永远看得见行流，"永续供给"的实现；
- `send` 不占行流：反射与 halt 永不被单持有者阻塞；**直发对宿主不可见**（不经 `tools` 管线，无 `pre-execute`、无留痕）——留痕靠 `corpus.ts` 自记；
- **send 帧格式**：缺省发送字节 + 自动补 `\r\n`；翻页空命令的精确字节 **待实测核对**（§6）；
- **断线** = socket close 事件（非行）：在途 read 以 `reason:'disconnected'` 收束、流程结束、经危险 latch 醒根、登录标志复位；重连缺省为下次 `mud_send` 隐式建连 + login，策略 **§6 待实测校准**（宿主 resume 只恢复历史不恢复 socket，`NOT FOUND`）。

**禁令**：不解释语义、不做危险判断（判据在 danger）。

### 3.2 行等待竞速（mud.ts 内部实现细节）

```
read(o):
  1. 单持有者检查：reading 非空 → 抛错（fail-loud，不做队列）
  2. 先消费 buffer（rest 同帧移交：本次 send 之前的到达行先结算）
  3. 建竞速状态 { opts, acc, lines, gaSeen, quietTimer, timeoutTimer }
  4. 判定序（写死）：danger > failOn > until > gaCount > quietMs > timeoutMs > maxLines
     - danger：行到达钩子同步测（与意识层同一份 danger.ts）
     - failOn / until：在 acc（累积文本）上测——**完成句可跨批命中**（实录语料事实）
     - gaCount：onBoundary 钩子计数
     - quiet / timeout：计时器；maxLines：行数兜底
  5. resolve → ReadResult{lines, reason, rest?}；reading = null
```

- 声明了 `until` 却以 `quiet`/`timeout` 收场 → 记 error（判据失配要吵，语料可见）；
- 危险命中 → 以 `reason:'danger'` 返回，流程按 §3.6 危险出口结束；
- 直发混流缺省：直发行**照常进 acc**；实录若发现误命中，升级隔离方案（§6 B1）；
- `ask` 不再与 read 同机（旧"流程内挂起等人"已清算）——等人发生在根侧工具结果回流之后，不存在跨会话挂起。

**禁令**：竞速机不持有业务状态（不记世界、不做唤醒决策——danger 命中的唤醒由意识层/根侧结算处理）。

### 3.3 反射 + 意识层（awareness.ts / danger.ts）

```ts
const REFLEX = [                                  // 反射：天然无后果的机械反应
  { re: /系统将在.*分钟后存档|请及时存档/, cmd: 'save' },
  { re: /按回车继续| press enter/i,     cmd: '' },  // 翻页空命令
]

observe(line):                                    // 每行执行，薄
  world.reduce(line)                              // 抓取：HP/内力/位置/战斗态/占线活动
  const d = danger.match(line)
  if (d) {
    if (d.halt && world.busyActivity) mud.send('halt')   // 同占线活动内去重：防战斗行流 halt 风暴
    if (d.wake) wake.steer(d)                            // 连续谱：判据自带动作意图
    if (d.abortWait) reading?.abort('danger')            // 行等待中断（reason:'danger'）
  }
  for (const r of REFLEX) if (r.re.test(line.text)) mud.send(r.cmd)
  wake.armSilence()                              // 静默重置（再武装锚点缺省：新行到达，§6 B11）
```

- **危险判据一份数据、字段化动作意图**：`{ re, halt?, wake?, abortWait?, why }`——一张表同时服务 halt 触发、等待中断、T2 唤醒，不许两处派生；两档（abort/pause）清算为字段组合；
- **紧急 halt → X**：X（逃还是战）由预案/T2 决策，意识层只解锁不定向；halt 后到 X 的时限（亚秒预案 vs 等 T2 秒级）**§6 B8 待实测定案**；
- **越界不唤醒（A6 定案）**：HP 缓降、进入战斗等无行可警的越界只更新 `world`，随静默唤醒摘要上浮；行级可警（遭攻击/死亡/断线）仍立即——意识层因此**不长第四条计时链路**；
- **占线跟踪**：`world.busyActivity`（战斗/读书/打坐/移动）——halt 解锁与技能里的常规 halt 前置都读它（design4 §5.5）；
- REFLEX 入选纪律：只放天然无后果动作；直发走 mud.send（宿主不可见，§2 修复3）。

**禁令**：只感知与触发，不解释内容、不生成动作序列、不持有目标。

### 3.4 思考层：唤醒、上下文、persona

**唤醒器（wake.ts）——三源，但源3零自建：**

```ts
class Wake {
  private silenceTimer                 // 有界静默 timer（形态参考 schedule/runtime.ts:194-201）
  private latch: string | null         // 危险去重：条件成立叫一次，解除才重武装

  // 源1 静默到期：静默 && 无 wait 在途 && 无子 agent 在途（"没事且没事干"）
  //   守卫：whenIdle() 可达（runtime-types）且无存活 continuable（subagent 列表）
  onSilence(): agent.followup(context.silence())     // followup: runtime-types.ts:222

  // 源2 危险：steer 空闲自开回合、运行中步边界插话（runtime-types.ts:224-231, agent-loop/agent.ts:159）
  steer(d): agent.steer(context.danger(d))

  // 源3 结算上报：**宿主原生**——continuable 结算必唤醒根
  //   （continuation-activation.ts:881：idle→followup / running→steer），插件不重复唤醒。
  //   插件只做：结算记录落 corpus + 判断续跑/问人/重规划（见 §3.6）
}
```

**上下文组装（context.ts，纯函数，瘦）**

历史每请求自动全量携带（`agent-loop/agent.ts:631` + `deriveMessages()`）——计划、结算报告、技能调用都已在上下文里，**组装器不搬运历史**。每次唤醒正文只补两件模型看不到的东西：

```
buildWakeContext(reason) =
  [唤醒原因：事实短消息，不是指令]        // "静默环顾" / "危险：遭攻击（HP 18%，位置 茶室）" / 事实陈述
  [世界摘要：字段清单判据]              // 入选 = T2 本次决策必需：
                                       //   HP / 内力 / 位置 / 占线活动 / 登录态 / 饥饿口渴 / 金钱
                                       //   + 越界事实（A6：HP 缓降等搭静默这趟车）
                                       // 新增字段必须写理由——防孤儿字段
  [教训注入（第二期，lessons）]
```

- 计划**不单独建存储**：T2 输出计划 = assistant message 自然落会话日志；进度 = 结算报告（user message）。不建 plan 状态机、不建进度跟踪器；
- **compaction 注意**：mud-core2 缺省不挂 compaction 后端（历史全量）；若未来挂载，旧计划可能被压缩替换——守护条件列 §6；
- 克制原则：唤醒原因是事实（"HP 18%"），不是指令（"请逃跑"）。

**persona（persona.ts）**

注册 `systemPrompt.section`（persona 段固定名 `:127, :158`，组装 `:454-463`）——不自拼字符串进每次请求。内容：五层身份（你是玩家，下属替你跑腿）、halt/busy 常识（发码前先停手里的活；服务端说"你正忙着"就先 halt）、工具用法、计划格式（要点 + 边界声明 + 预算）、维持类自查（口渴/饥饿/疲劳是要你规划的事）、**fullme 兜底常识**（识别工具会失败；失败=问题会回到你这，你问人取码后续跑或重跑）。

**禁令**：T2 唯一持有目标与意图连贯性；意识/反射不得替 T2 做计划级决策；无两执行者——子 agent 是计划执行半边。

### 3.5 执行域：工具面与权限编译（tools.ts / subagent.ts）

**工具面**（注册于 `agent/created`，一条路径覆盖根与子 agent，`agent-loop/src/index.ts:614-624`）：

```ts
mud_send({ cmd?, listen?, timeoutMs? })
  // 无 cmd = 裸读；有 cmd = send + read（listen 缺省 gaCount:1）
  // 返回 ReadResult.lines 原文（过程即结果，模型看原文自决）
  // 超时：无默认（宿主协作式 tools.md:64-68），显式传才生效
mud_flow({ id, answer? })     // 流程注册表调用；answer = 根侧重入时带的决策/人给的值
mud_state()                   // world 快照
captchaRecognize({ image })   // 图片识别工具：**接口正式、实现为必然失败桩**（§3.6）
```

- 工具结果原文返回（`concludeTurn` 仅成功携带，`tools:1421-1423`——失败结果不结束回合，模型继续决策）；
- `deferContext()` 可用于把大块行流推迟到下一轮（一次性读，`tools:1418-1420`）——第一期不用，知道有这根线；
- 危险命令 denylist 一行判断直接返回错误（工具内，不建权限机制层）；
- 首次 `mud_send` 隐式建连 + login（已登录标志防重入；断线复位）。

**权限编译（A5 定案：数据在计划里，牙齿在宿主管线）**

- 根会话：放行（mud 工具面 + userQuestions 正常可达）；
- 子 agent 会话（`agent/created` 时若为 owned 子代理）：
  - `tools/pre-execute` deny（`tools/src/index.ts:1499-1530`）——交易/不可逆类工具（buy/sell/trade…）与越权 flow id 直接拒，deny 不进 body；
  - 必要时 `tools.restrict()` 遮蔽危险面（`:1096-1099`）；
  - deny 数据源 = 计划要点自带的边界声明（预算、禁止事项）编译而来——**不是独立权限层**；
- 人工交互：子 agent 侧不注册/不暴露 ask 能力（宿主 `DELEGATED_CALLER` 兜底，`packages/interaction/user-questions/src/index.ts:101-105`）——设计与强制同构。

**计划下发与结算（subagent.ts，第一期）**

```
T2 输出计划（assistant message，含要点+边界声明）
  → subagent.startContinuable({ prompt: 要点+边界+战术教训 })
      // provider = spawn（fresh child，seed 缺省：subagent/src/types.ts:239-243）
      // 立即返回（subagent/src/index.ts:261-262）
  → 子 agent 串行执行：mud_send/mud_flow（同一条 agent/created 注册路径）
      // 步骤级意外自行消化；busy 错误 → 补 halt 重试（执行智能）
      // 必须问人的事 → 结果 {done:false, question}（不能 ask——DELEGATED_CALLER）
  → 结算 → 宿主唤醒根（continuation-activation.ts:881，零自建）
  → 根计划级检视：
      done:true  → 记录，检视是否结计划/续下一点
      done:false, question → userQuestions.ask(question)（仅根可达）→
          答案 → ctx.agents.get(childId).send_message 续跑（存活时）
                 或重跑 mud_flow({ id, answer })（已死时）
      受阻/危险 → 按 §6 A1 残余通道策略处理（待定案）
```

- 要点级拆分、模型降档 = 支，不进第一期（design4 §9）；
- `interrupt()`（`subagent/src/index.ts:328`）与 `exec.signal` 是 A1 的备选原语，选型待实测。

**禁令**：无两执行者、无仲裁——只有单向"处置不了就升级"（危险 → 意识层 abort wait + 醒根）。

### 3.6 凭据与标准流程（flows/）

- 形态：`Flow = { id, description, run(ctx) }`，async 函数，`tsc` 即校验；
- `FlowCtx = { mud, creds, answer?, signal }`——**没有 `ask`**（流程内挂起问人已清算）；
- 密码/验证码发送瞬间插值，明文不进任何模型上下文（凭据 `resolve` 双键空间）；
- 加流程 = 加文件 + index 数组一行；对模型只暴露 `mud_flow({id})`。

**三个出口**（流程只能从这三处结束）：

1. `done:true` —— 完成；
2. `done:false, question, lines` —— **带问题结束**：必须重放无害才允许此出口（fullme 收图重放无害；含不可逆副作用的流程不得走此出口）；
3. `reason:'danger'` —— 危险中断（§3.3 abortWait 同源）。

**fullme 链路（定案，工具优先、根侧兜底）**：

```
子 agent 调 mud_flow({ id:'fullme' })
  → halt 解锁（技能前置；busy 错误 → 补 halt 重试）
  → 收图（游戏行流）
  → 调 captchaRecognize({ image })
       ├─ 成功（未来）→ 拿码 → 发 fullme<码> → done:true
       └─ 失败（当前必然）→ 流程以 { done:false, question:'验证码：<图或行原文>' } 结束
            → 问题随子 agent 结算上浮（子 agent 侧 ask 被 DELEGATED_CALLER 禁死）
            → 根 userQuestions.ask() 问人 → 答案回流
            → 根决策：send_message 续跑（continuable 还活着）或重跑 mud_flow({id:'fullme', answer})
```

- `captchaRecognize`：schema 按 `image → text` 正式设计；execute 当前固定返回结构化失败（`CAPTCHA_UNRECOGNIZED`）——**接通真 VLM 时只换 execute，链路一行不改**；承载研究（`llm` 多模态 / `attachment` / 自调 VLM）列 §6；
- 失败路径是现阶段**真实路径**，不是异常分支——第一期验收必须走通它（§4）。

**禁令**：流程无执行智能之外的权限（不可逆动作被子 agent pre-execute 拦在工具层）；凭据永不进上下文。

### 3.7 记忆（world / lessons / skills+flows）

| 类型 | 实现 | 期次 |
|---|---|---|
| 工作记忆 | world.ts（会话内，意识层维护，所有层同读） | 第一期 |
| 程序记忆 | `skills/mud-<name>/SKILL.md` 人写种子（找路/喝茶/买东西/halt 前置）+ flows/（login/fullme）；宿主热加载（`skill-filesystem:492-557`）、模型可见（`tool-skill:213-249`） | 第一期种子；沉淀第二期 |
| 陈述记忆 | lessons.json（上限 N 条；战略进唤醒上下文、战术进子 agent 要点描述；超限由 T2 归纳） | 第二期 |

- 沉淀（第二期）：成功要点 → SKILL.md 候选——T2 用宿主 write 工具写文件，**热加载与缓存失效宿主原生**（`skill-filesystem:143-146`），插件零接线；
- 技能/流程对计划是**词汇**：编制时引用、执行时调用，无执行权（design4 §5.1）。

### 3.8 观测（corpus.ts）

- **行流语料**：JSONL 全量落盘（时间戳 + 原文）——自有通道；**不进 Session**（`session.append` 是同步通知、高频行会拖账；自定义类型虽 log-only（`session/index.ts:720-724`），行级频率仍只落 JSONL）；
- **Session log-only 事件**（交换级，低频，白名单外天然不进模型）：`mud/command-sent`、`mud/exchange-complete`（read 返回时）、`mud/danger-fired`、`mud/flow-result`、`mud/settlement-digest`（根消化标记若需要——缺省由"结算后有无 `assistant/message`"推导，不建 ack）；
- **计数**：`step/start` 或 `assistant/message`+`assistant/attempt`；**禁用 `request/header`**（change/series-only）。

---

## 4. 观测与验收账目

**计数口径（写死）**：模型决策点 = `step/start` 事件数（或 `assistant/message` 数）。`request/header` 不可用于计数。

**四行为验收（design4 §9）**

| 断言 | 内容 |
|---|---|
| 账目护栏 | 每场景：`step/start` 数 == 真正需要模型决策的次数；对照实证基线 |
| **链路覆盖** | 四行为（取钱/买食物/喝水/找路）**至少一次走通** 编制 → startContinuable → 子 agent 执行 → 结算唤醒 → 根检视——只测根直跑等于没测干 |
| 语料回放四条 | 完成句跨批 / 危险中断 read / rest 同帧移交 / until 失配记错——先红后绿 |
| 权限 | 子 agent 会话调交易类工具 → pre-execute deny；根会话放行 |
| 人工唯一性 | 全程 `userQuestions` 调用只发生在根会话（子 agent 0 次——DELEGATED_CALLER 保证 + 断言防回归） |

**fullme 场景单列（新链路必测）**

```
给定：captchaRecognize 桩（必然失败）、continuable 子 agent 执行 fullme 要点
断言：
  1. 子 agent 侧 userQuestions 调用数 == 0
  2. 根侧 userQuestions 调用数 == 1（问人取码）
  3. 问题确实经结算上浮（settlement 事件 + 根侧 assistant/message 可见 question 文本）
  4. answer 回流后走 send_message 续跑或 mud_flow 重跑，端到端 done:true
  5. token 账目：根 = 编制 1 + 结算检视 1（+问人轮次）；无额外浪费唤醒
```

**成本主张（条件命题）**：同场景账目不劣于现状，由验收逐场景断言，恶化即回退（design4 §7 修正表述）——"上限=现状"不是无条件定理，短计划可能反超。

---

## 5. 实施顺序（干含子 agent——A3）

**第一期（干）**：三源唤醒 + 唤醒正文 + 计划编制 + 单子 agent 串行 + 结算即唤醒 + 计划级检视 + 权限编译 + fullme 工具优先/根兜底。

| 步 | 内容 | 依赖宿主 |
|---|---|---|
| 1 | mud.ts + telnet/ansi 照搬 + wait 竞速机 + rest + 单持有者 | 无 |
| 2 | 语料回放用例：完成句跨批 / 危险中断 read / rest 移交 / until 失配记错 | 无（先红后绿） |
| 3 | awareness + world + danger（字段化意图）+ REFLEX + halt 去重 | 无 |
| 4 | wake（静默+危险；源3零代码）+ context 瘦正文 + persona section | followup/steer；systemPrompt.section |
| 5 | tools（mud_send/mud_state/mud_flow）+ flows/login | tools.register；agent/created |
| 6 | **subagent 拓扑**：startContinuable + 结算记录 + 发送续命（send_message）+ 子 agent 权限编译（pre-execute/restrict） | subagent 包；userQuestions 根侧 |
| 7 | **fullme 链路 + captchaRecognize 桩** | tools；userQuestions（DELEGATED_CALLER 天然生效） |
| 8 | corpus + 计数护栏 + §4 验收全表 | session 事件 |

验收：§4 全表——四行为含全链路、fullme 含端到端问人、权限与人工唯一性断言。

**第二期（支，按账目生长，顺序不预设）**

| 支 | 内容 | 引入判据 |
|---|---|---|
| 1 | skills 种子完善 + 教训库（lessons + 注入 + 归纳） | 跨会话重复犯错实证 |
| 2 | 技能沉淀自动化（成功要点 → SKILL.md 候选，宿主 write + 热加载零接线） | 同类任务重复实证 |
| 3 | 反射表/危险判据按实测增补 | 语料审计 |
| 4 | 子 agent 模型降档 | 子 agent 账目稳定后 |
| 5 | 要点级拆分与编排 | 计划粒度实测证明必要 |
| 6 | captchaRecognize 真承载接入（换 execute，链路不动） | 承载研究完成（§6） |
| 7 | compaction 挂载（若历史膨胀实证） | 挂载需计划节点守护（§6） |

护栏：任何支使 token 账目恶化即回退；关掉任何支退化为第一期干。

---

## 6. 待实测 / 待定（实施时校准或定案）

**MUD 侧（B 组，语料实测）**

| # | 项 | 缺省策略（实测前） |
|---|---|---|
| B1 | 直发输出与在途 read 混流 | 照常进 acc；误命中则切隔离 |
| B2 | 危险判据刻度（正则与阈值标定） | 沿用现行规则数据起步 |
| B8 | 紧急 halt→X 的时限（亚秒预案 vs 等根秒级） | 意识层只解锁；X 等根——实测若死人再加预案 |
| B11 | 静默再武装锚点 | 新行到达重新武装 |
| B12 | 断线重连入口 | 隐式重连（下次 mud_send） |
| — | send 帧格式 / 翻页空命令字节 | 补 `\r\n`；逐字节对实录核对 |
| — | 静默时长取值 | Config 化，语料回放校准 |

**宿主与拓扑（A 组与条件需求）**

| # | 项 | 备注 |
|---|---|---|
| A1 | 危险 × 在途子 agent 的通道策略 | 原语已盘点：`interrupt` / `exec.signal→cancel` / `ctx.agents.get().steer`——选型待定案，不在本轮擅定 |
| — | captchaRecognize 承载研究 | `llm` 多模态 / `attachment` / 自调 VLM；桩先行不阻塞 |
| — | compaction 是否挂载 | 缺省不挂；挂则需计划节点守护（pre-step 检测计划被压缩 → 重注） |
| — | 连接生命周期 | 缺省随会话（`session/disposed` 断连）；多会话需求出现再改 |
| — | 教训存储位置 | lessons.json 起步，storage 包可替换 |

---

## 7. 回写 design4 清单与差异

**本轮已同步写回 concept 的定案**（design4.md 已改）：

| 定案 | 写回位置 |
|---|---|
| A2 结算即唤醒、"异步"收窄要点级 | §3.1 闭环图 / §3.3 / §7 T2 行 / §10 总结 |
| A3 干含子 agent | §1 方法与设计顺序 / §9 干与验收 |
| A5 权限编译到宿主（pre-execute/restrict）+ 人工只在根 | §4.3 |
| A6 越界并入静默（附代价声明） | §2 意识行 / §3.2 |
| fullme 工具优先、根侧兜底 | §5.1 |
| 成本上限改条件命题 | §7 |
| 验收计数改 `step/start`、四行为须走全链路、fullme 单列 | §9 |
| 清算补两条（世界越界独立唤醒、流程内 ask 挂起） | §8 |

**impl 相对 concept 的补充（无 concept 冲突，不需回写）**

- 源3 结算唤醒**零自建代码**（宿主 `continuation-activation.ts:881` 承担，插件只做记录与续命决策）；
- 唤醒正文瘦到两件（原因事实 + 世界摘要）——历史自动携带使"在途计划/未消化报告"不需组装器搬运；
- 危险判据字段化连续谱（`halt?/wake?/abortWait?`）与 halt 同活动去重；
- 断线三段处置（收束在途 read + 醒根 + 登录复位）与隐式重连缺省。

**concept 留口待定（只列不擅定）**：A1 通道策略、B1/B2/B8/B11/B12 刻度与入口、halt→X 时限、captcha 承载、compaction 挂载条件。

---

## 8. 一句话总结

**文件跟五层心智走：存在（mud/telnet/ansi）、反射+意识（awareness/danger——判据字段化、越界不设第四唤醒源）、思考（persona=section、context=只补模型看不到的、wake=两源自建+结算宿主原生）、执行（工具面一条 agent/created 路径、权限编译进 pre-execute/restrict、计划走 continuable）、记忆（world/skills/lessons 三分无执行权）；wait 竞速机是唯一占行流的机制（直发在其外、对宿主不可见）；计划不建存储（会话日志即计划、每请求自动携带）；fullme 走"识别工具必然失败 → 问题上浮根 → 问人 → 续跑"的真实路径；干含子 agent，一切支以 token 账目为引入判据与回退护栏。**

> AI生成
