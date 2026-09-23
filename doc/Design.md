---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd1f9d98e-5980-49ba-84f1-6c68b4db6c3b'
  PropagateID: 'd1f9d98e-5980-49ba-84f1-6c68b4db6c3b'
  ReservedCode1: 'e4b80894-ba45-44e9-b7a6-9c42545bca75'
  ReservedCode2: 'e4b80894-ba45-44e9-b7a6-9c42545bca75'
---

# mud-core-lite 设计

- 状态：**设计基线**（2026-09-23）
- 取代：此前的 `core2` 设计稿（其宿主实证结论已并入本文 §2）
- 现行实现的设计事实源：`doc/ARCHITECTURE.md`（§1–§19）——本文描述**新实现**，与现行实现并存直到切换

---

## 1. 设计

**一句话：把 MUD 做成 DSH 的一个工具加一条行流，其余交给宿主。**

`mud-core-lite` 的全部内容是三个原语：

| 原语 | 干什么 |
|---|---|
| **入站链** | 把服务端推送的字节，变成一行行的游戏文本 |
| **`wait()`** | 等一段输出（等到完成句 / 边界 / 沉默 / 超时 / 危险） |
| **`send()`** | 发一条命令 |

流程是**用 `wait()`/`send()` 写的普通 `async` 函数**；规则动作是**入站链里改世界或叫醒模型的一个函数**。除此之外没有机制。

### 1.1 六条原则

1. **宿主已经会做的，一律不做。** 工具可无限挂起、回合归官方 loop、人工交互、凭据、持久化、会话恢复、无密钥回放——全部用宿主原生。
2. **不为"将来可能需要"设计。** 需要时再往三个原语里加，且只加参数或 `if`（见 §12）。
3. **单一所有者。** 每个轴只有一个组件能推进它：行只有入站链能产、命令只有 `send()` 能发、世界只有 `onLine()` 能改、模型可见面只有工具结果与 `steer`。
4. **模型可见即可重建。** 模型看到的都是会话日志里的原文或工具结果，不造第二份真相。
5. **不精确控制就交给模型。** 只有涉及凭据或不可逆状态的过程才写成代码流程（§7.1）。
6. **判据写死、失败要吵。** 判定优先级与匹配口径不做成配置；写入的判据失配必须记错，不许静默兜掉（§5.3）。

### 1.2 为什么要重写

现行 `mud-core` 的功能没有问题，问题在于**它在 DSH 之上又实现了一遍 agent loop**（假模型 T1、lane 选路、回合收束判据、投递通道、结算计时器群），并因此长出了一批互相需要协调的机制。实测规模与病症：

- 54 文件 / 14,356 行；`agent/flow/engine.ts` 1265 行、`deliver/adjudicator.ts` 1200 行、`session/session.ts` 973 行；
- 同一事实多处派生：收口条件在 4 层各派生一次，超时缺省在 5 层各写一次且互相矛盾，行消费水位有 4 种表述；
- 被删掉的机制留下的"孤儿字段"（声明了但没有消费者）需要靠人工审计（W11.2 的 A1–A8）才能发现。

**重写的不是功能，是"宿主没有所以自己造"的那一层。**

### 1.3 结果

| | 现行 | core-lite |
|---|---|---|
| 源码 | 54 文件 / 14,356 行 | 约 8 文件 / 800–1200 行 |
| 机制 | 假模型、流程引擎、看门狗、在途窗口、投递通道、权限档位机制层 | 入站链、`wait()`、`send()`、流程函数 |
| 测试 | 37 spec / 384 例 + 手写 loop 模拟器 | 语料回放 + 官方录制回放（§11） |

---

## 2. 宿主能提供什么

设计的地基是宿主已证实的能力。下表每一条都对应一个"所以我们可以不做"的决定。

| 我们需要 | 宿主原语 | 位置 |
|---|---|---|
| 工具长时间挂起（登录、等人） | 工具无默认超时；`timeoutMs` 可选且是**协作式**（只 abort signal，不硬杀） | `core/tools/src/index.ts:259-266`；`guard/timeout-policy` |
| 回合取消 | `exec.signal` | `core/tools/src/index.ts:350-351` |
| 结果带回上下文 | `exec.deferContext`（一次性读取） | `core/tools/src/index.ts:1418-1420,1609-1620` |
| 提前收束回合（省一次请求） | `exec.concludeTurn()`（只在成功结果上生效、不打断同批调用） | `core/tools/src/index.ts:1421-1423` |
| 问真人的值 | `ctx.userQuestions.ask()`（agent 作用域 waterfall，可无限挂起） | `interaction/user-questions` |
| 叫醒空闲模型 / 插话运行中的模型 | `agent.steer()`（空闲时自己开回合；运行中在步边界消费） | `core/agent/src/runtime-types.ts:224-231` |
| 持久上下文但不叫醒 | `agent.inject()`（**不唤醒**，可能错过已认领的批次） | 同上 `:233-241` |
| 提交输入并唤醒 | `agent.followup()` | 同上 `:222` |
| 真静止点（无回合、无工具在途） | `agent.whenIdle()` / `runMaintenance()` | 同上 `:185-202` |
| 密码不进模型 | `ctx.credentials.resolve` + 引用名 | `packages/credentials/*` |
| 模型可见面的真值轴 | Session 日志 + surface 投影（白名单硬编码 5 类事件） | `core/session/src/surface.ts:50-56` |
| 持久化 / 会话恢复 | `session-persistence-jsonl`（append-only、批次 fsync、撕裂尾部恢复） | `packages/session/session-persistence-jsonl` |
| 热重载与清理 | `ctx.effect` + scope 树；`session/disposed` | `vendor/cordis/src/fiber.ts:402-417` |
| 无密钥端到端回放 | `session-snapshot`（录制/回放）+ `llm-replay`（在真 loop 里回放模型流） | `packages/test-support/*` |

**明确没有、必须自建的**：

| 事项 | 核查结论 |
|---|---|
| 通用出站 TCP 客户端服务 | **不存在**。全仓 `node:net` 只有 ssh 客户端、入站 HTTP、subprocess 控制通道、OAuth 回环；`webhook` 是反方向。连 MUD 服务端只有 MUD 客户端自己能做 |
| 等待条件原语（`wait_for_condition`） | 不存在（只有一个测试 helper） |
| 流程状态图 / 条件边 | 不存在（`workflow` 是"模型写 JS 扇出子代理"，沙箱里没有工具与 IO，不适用） |
| 行级协议解析 | 不存在。telnet/ANSI 必须自建（但现行实现已写好，见 §10.1） |
| 按行流注入模型上下文 | 不存在"按需注入"通道；只有工具结果、`deferContext`、`inject`/`steer` 三种 |

---

## 3. 入站链

### 3.1 推送，不是循环

socket 本来就是推送的，**core-lite 不新建循环、不轮询**：

```
socket 推送 chunk
  → telnet 解码（IAC 协商、MCCP2 解压）
  → ANSI 分行（含 300ms 静默刷出无换行尾片断）
  → 入站链：onLine(line) → deliver(line)          ← 唯一的行入口
```

```ts
socket.on('data', chunk => {
  for (const line of ansi.write(telnet.decode(chunk))) {
    onLine(line)      // 世界更新 + 危险判定 —— 永远执行，与谁在等无关
    deliver(line)     // 有人在等就给他；没人等就进缓冲区（不丢）
  }
})
```

- **入站链是行的唯一入口。** 不许有第二处各自消费行流（现行实现的病之一）。
- `wait()` **不是数据来源**，它只是入站链上的一个临时订阅（加一个 resolve 回调，返回后摘掉）。
- **只有流程脚本和工具调用 `wait()`**；插件入口与 `onLine()` 都不调。

### 3.2 单位是"行"，不是"块"

字节流里的"块"是**传输假象**：它可能半条 ANSI 转义序列、夹杂 telnet 协商字节、是 MCCP2 压缩流的一段，或反过来含 50 行。**只有到了"行"，剩下的才全是游戏文本。**

行是 MUD 的语义单位，三个理由：规则与危险要在行上匹配（否则"对…造成"跨包边界漏判）、语料回放是行级的、`rest` 同帧移交是行粒度的。若按块处理，程序行为就依赖 TCP 的分包节奏——这正是现行 I7 要根治的病。

**这一层照搬现行实现**（§10.1）。其中 300ms 静默刷出是解析层内部行为，保留：它是入站链上唯一的计时器。

### 3.3 缓冲与同帧移交

没人等的行进**有界缓冲**（512 行 / 64KB，超限丢最旧并记错）。`wait()` 的第一件事是消费缓冲，然后才订阅网络。

**`rest` 是必需的**：实录时序里"本步完成句"与"下一步驱动句"会**同一批**到达（现行 §19.2 记录的实例：`{name}` 的应答里既有"需要创建新人物"又有"此ID档案已存在，请输入密码："）。若等上一步返回后再开下一步的等待，提示行就过去了 → 流程卡死。有了 `rest`，"同帧定序"退化为 `wait()` 开头的一个循环。

---

## 4. 等待原语

### 4.1 一个实现，两种用法

```ts
wait(o: {
  until?: RegExp | ((acc: string) => boolean)   // 完成判据（在累积文本上测）
  gaCount?: number                              // 协议边界：第 N 个 GA/EOR
  quietMs?: number                              // 兜底：沉默即返回
  timeoutMs: number                             // 硬上界：到期带内容返回，绝不悬挂
  failOn?: RegExp                               // 命中即失败
  danger?: 'abort' | 'ignore'                   // 默认 'abort'
}): Promise<ReadResult>

read(o)  = wait(o)                              // 等行
ask(o)   = wait({ ...o, until: 人给了值 })       // 等人 —— 同一台机器
```

```ts
interface ReadResult {
  lines: string[]                  // 本次收到的全部行 —— 原样返回给模型
  reason: 'until' | 'ga' | 'quiet' | 'timeout' | 'failed' | 'danger' | 'aborted'
  rest?: string[]                  // 同批未消费的行 → 移交下一步
  why?: string                     // reason='danger' 时的原因
}
```

**为什么 `ask()` 必须与 `read()` 同源**：`ask()`（等验证码）期间如果没人读行流，流程就是瞎的——战斗行进了缓冲而脚本在睡觉。合并后 `ask()` 自动继承危险判定，被打时当场返回。零新增机制。

### 4.2 判定优先级与匹配口径（写死，不可配）

```
danger > failOn > until > gaCount > quietMs > timeoutMs
```

- **`until` / `failOn` 在累积文本上测，不逐行测。** 长命令的完成句会被网络节奏切成两截（`\r` 落块尾、分包截断），逐行匹配会永远匹配不上，然后被 `quiet`/`timeout` 兜掉——表现为"流程莫名卡到超时"。**这是必须写死的一条**：打坐这类命令靠特定完成句结束，而该句可能跨批到达。
- **单行完成句写成单条正则。** 完成句不需要多行条件机（现行 §4 的"多行规则血泪"）。
- **`quietMs` 只作兜底，且要足够长**（≥5s，不是现行的 300ms）。
- **写入的判据失配要吵**：声明了 `until` 的命令若最终以 `quiet`/`timeout` 结束，记 error（现行 I9）。

---

## 5. 状态抓取

**能抓，形态不变，但消费者收窄为三个。**

沿用现行 `world/state.ts` 的数据形态（已有 10 例测试）：四个分区 `char / room / combat / flags`、字段白名单、置信度分档（GMCP 1.0 / 抽取 0.7 / 显式 0.9）。归约仍由 `onLine()` 逐行做。

| 消费者 | 用途 |
|---|---|
| `onLine()` 的越界判定 | 决定要不要叫醒模型（§8） |
| `mud_state()` 工具 | 模型主动查询（重连后、决策前） |
| 流程脚本 | 脚本内判断（如"登录完成了没"） |

**明确不做**：

- **不把世界推给模型。** 模型看不到逐 tick 的 HP；被叫醒时只收到"HP 低于阈值"这个**事实**，需要精确值时调 `mud_state()`。世界只有一个真相源，模型面只有"事实通知"与"按需查询"两条路。
- **不做全字段镜像。** 只抓模型决策用得上的字段（HP/内力/战斗态/位置/金钱/登录态）。抓了没人用的字段就是孤儿字段。

---

## 6. 危险与打断

### 6.1 一份判据

```ts
export const DANGER: Array<{re: RegExp; action: 'abort' | 'pause'; why: string}> = [
  { re: /你死了|你已經死亡|你昏迷/,      action: 'abort', why: '死亡' },
  { re: /断开连接|重新连线中/,           action: 'abort', why: '断线' },
  { re: /^[^\n]*向你发起攻击|对你造成/, action: 'pause', why: '遭攻击' },
]
export function classifyDanger(line: string): Danger | null
```

**一份数据、两个消费者**：`onLine()` 用它决定是否叫醒模型；`wait()` 用它提前返回。不许两处各自派生（现行 `closeTrigger`/`judgementUnits`/`setArmed` 三次派生同一批正则）。

### 6.2 打断之后归模型

```
流程在 wait() 中被危险命中
  → 返回 { reason:'danger', lines:[...已收全部行...], why }   ← 一行不丢
  → 流程函数当场结束（不 retry、不 halt、不复位）
  → 工具结果 = 已收过程 + 一句事实（"执行被打断，原因：遭攻击"）
  → 模型看过程自己决定：先 halt、先逃、还是稍后重跑
```

**为什么不让流程自动决策**：自动决策需要一张"谁该 halt、谁该逃、谁该重跑"的表——那就是现行流程表的第 N 个字段。`abort` 与 `pause` 在模型侧只是"要不要现在管"。重跑成本为零（流程是无状态函数）。

**逃生口**：`read({ danger:'ignore' })` —— 明确要"打完再看"时关掉判定。是参数，不是机制。

### 6.3 由此不引入的东西

| 现行机制 | core-lite |
|---|---|
| `interrupts`/`priority` 数字比大小 | **无** —— 不存在两个流程争抢 |
| 在途窗口结算为 `interrupted` + 定向清队列残余 | **无** —— 流程不发在途窗口 |
| 复位流程、清槽、`pendingActions` 排队 | **无** —— 流程结束就是结束；并发见 §7.3 |
| `onInterrupt` 声明要补发的命令 | 模型自己发（它看得见原文） |

---

## 7. 流程

### 7.1 两类，边界是"是否不可逆"

| 类别 | 载体 | 规则 |
|---|---|---|
| **凭据 / 不可逆型** | `src/flows/*.ts`，一个 `async` 函数，经 `mud_flow({id})` 调用 | **凡涉及凭据，或状态不可逆（买卖、交任务、消耗物品、账号操作）的，必须是代码流程** |
| **知识型** | `skills/mud-<name>/SKILL.md`（宿主 skills：目录 + frontmatter + 热加载，模型可见可调） | 纯经验与套路（怎么练功、怎么走地图、NPC 对话），模型照着做，意外自己处理 |

两类在模型面前并列，**不互相调用**，所以不存在"流程有两个来源要仲裁"。SKILL.md 里可以写"这种活按 `mud_flow('xxx')` 来做"——**串联发生在模型脑子里，不在代码里**。

### 7.2 代码流程的形态

```ts
export interface Flow {
  id: string                                  // 稳定 id，也是工具参数值
  description: string                         // 进工具 schema
  run(ctx: FlowCtx): Promise<FlowResult>       // 返回过程行，或一个疑问
}
export interface FlowCtx {
  mud: Mud
  creds: Credentials
  answer?: string                             // 模型上一轮给的决策（重入时携带）
  ask(o: {prompt: string; image?: string; validate?(v:string): string|null}): Promise<string>
  signal: AbortSignal
}
type FlowResult =
  | { done: true;  lines: string[] }
  | { done: false; question: string; lines: string[] }
```

```ts
export const login: Flow = {
  id: 'login',
  description: '登录服务器（凭据由宿主解析，明文不经模型）',
  async run({ mud, creds, answer }) {
    await mud.read({ until: /请输入您的英文名字/, timeoutMs: 10_000 })
    await mud.send(creds.name)
    const r = await mud.read({ until: /请输入密码|已经被使用|没有这个人物/, timeoutMs: 10_000 })
    if (/已经被使用/.test(r.text)) {
      if (answer === undefined) {
        return { done: false, question: '此 ID 已被使用，是否取代？(y/n)', lines: r.lines }
      }
      await mud.send(answer.trim().toLowerCase().startsWith('y') ? 'y' : 'n')
      await mud.read({ until: /请输入密码/, timeoutMs: 10_000 })
    }
    await mud.send(creds.pass)                  // 发送瞬间插值，明文不入上下文
    const done = await mud.read({ until: /欢迎|重新连线|>/, timeoutMs: 20_000 })
    return { done: true, lines: done.lines }
  },
}
```

**加一条流程 = 加一个文件 + 在 `flows/index.ts` 的数组字面量里加一行。** 没有装配期校验（合法性由 `tsc` 检查）、没有 DSL、没有流程槽、没有解释器。

### 7.3 流程只能有三种退出，且有一个硬约束

**硬约束：工具在途时，模型无法回答任何问题。** 模型发完 tool-call 就在等结果，只有工具返回之后才能发下一个请求。

因此：

| 退出 | 触发 | 形态 |
|---|---|---|
| 完成 | 走到终点 | 返回过程行 |
| 要人给值 | `ask()`（验证码、二次密码） | 工具挂起等真人；模型侧只是一次长工具调用 |
| 要模型判断 | 流程识别出需要决策 | **结束并返回疑问**；模型带答案重入 |

由此得到一条必须守的规则：

> **只有"重放无害"的流程才允许中途向模型提问。**
> 含不可逆副作用的流程必须一次跑完（要值只走 `ask()` 找人），不得在中间停下来问模型。

login 重跑无害（重复发用户名/密码，服务端会重新提示），所以它可以问。买东西不行。

### 7.4 并发：一个布尔值

- **同一会话同一时刻最多一个"占着行流的东西"**（一次工具调用，或一条反射脚本）。
- 流程执行期间 `mud_send` 直接返回"流程执行中"。代价是一点灵活性，换掉一整类竞态（现行 I10/I11：两条链争一个挂起槽）。
- 流程被打断就结束，**不保存、不恢复、不自动重试**；重跑 = 再调一次 `mud_flow`（可行性见 §7.3）。

---

## 8. 反射：规则动作与唤醒

### 8.1 规则只做两件事

| 允许 | 例子 |
|---|---|
| 改世界 `world.patch(...)` | 从行里抓 HP/内力/战斗态/位置 |
| 叫醒模型 `ctx.agent?.steer(...)` | "服务器要求 fullme"、"HP 18%，建议逃跑"、"被攻击了" |

**规则自己不发命令。** 一旦规则发命令，就必须回答"这条命令的输出归谁"——是规则自己的收口，还是可能落进某个在途流程？现行实现为这个问题造了整条投递链。改成"通知模型、模型 `mud_send`"之后：**发送路径永远只有一条，每个动作都有模型当决策者，规则不需要维护独立状态。**

代价是"零 LLM 反射"没有了（现行 `direct` 的 save 提醒、翻页直发）。这两类在 `steer` 文本里一句话即可说清，模型一次调用完成——省下的是一整条投递链。

### 8.2 唤醒必须有理由

不做无条件定期叫醒（白烧 token 且没有信息可给）。认三类理由：

| 理由 | 判据 |
|---|---|
| 静默超时 | 距最后一行超过 N 秒 |
| 世界越界 | HP < X、进入战斗、被定身 |
| 连接 / 流程失败 | 断线、流程失败收束 |

实现是入站链旁边**一个计时器 + 一个 latch**：条件成立叫一次，条件解除才重新武装。

```ts
const reason = silenceReason() ?? worldReason() ?? connReason()
if (reason === null) { latched = null; return }   // 条件解除 → 重新武装
if (reason === latched) return                    // 条件仍在 → 不重复叫
latched = reason
ctx.agent?.steer(`[MUD] ${reason}`)               // 内容是事实，不是指令
```

- 计时粒度不需要精确（1s 够）：唤醒是"叫醒"，不是控制流。
- **不做**：宿主 `schedule` 包（只投递提醒、不改状态，且永不打断进行中的回合）；现行看门狗表（当一个计时器 + 一个 latch 够用时，声明表是净负担）。

---

## 9. 工具面

```ts
mud_send({ cmd?, listen?, timeoutMs? })   // 无 cmd = 只读输出；有 cmd = 发后读一段
mud_flow({ id, answer? })                  // id 是注册表生成的动态枚举
mud_state()                                // world 快照
```

- **返回过程。** `mud_send`/`mud_flow` 返回 `ReadResult.lines` 原样（服务端吐的原文），只加上限保护。不做摘要、不做结构化重写——这样"模型看到的一切 = 会话日志里的原文"，可自证、可回放。
- **首次 `mud_send` 隐式建连并跑 login**，之后才发命令；也可以显式 `mud_flow({id:'login'})`。
- 危险命令在工具内一行判断直接抛错，不做权限机制层。
- 档位若仍需要：用 `agent.ctx.tools.register` 的条件注册（宿主原生）。

---

## 10. 文件布局与继承

### 10.1 布局

```
packages/mud-core/src/
├── mud.ts        # 连接、入站链（推送）、解析、wait/read/ask、send、world
├── rules.ts      # onLine(line, mud) —— 世界更新 + 越界判定
├── danger.ts     # 危险判据（一份数据）
├── tools.ts      # mud_send / mud_flow / mud_state
├── index.ts      # 插件入口：ctx.on('agent/created') + agentCtx.tools.register
└── flows/
    ├── types.ts  # Flow / FlowCtx（一页）
    ├── index.ts  # 注册表：export const flows = [login, fullme, ...]
    ├── login.ts
    └── fullme.ts
```

核心部分（`mud.ts`/`rules.ts`/`danger.ts`/`flows/`）是纯 TypeScript，不接触宿主 `ctx`；只有 `index.ts` 与 `tools.ts` 的接线接触宿主。

### 10.2 照搬不重写

| 资产 | 理由 |
|---|---|
| `network/ansi.ts`（521 行 / 39 例） | 流式 ANSI 解析、跨块终止符、序列缓冲上限——唯一被用例钉死过的资产 |
| `network/telnet.ts`（573 行 / 6 例真 socket 例） | telnet 协议、IAC 协商、MCCP2、GA/EOR |
| `world/state.ts`（284 行 / 10 例）与 `perceive/rules.ts` 的**数据** | 世界分区与置信度分档、规则内容 |
| `agent/commands.ts` 的命令索引 | `mud_help` 的数据源 |
| 凭据引用做法（`session/credential-source.ts`） | `passRef` + `ctx.credentials.resolve`，明文只在发送瞬间出现 |
| 打坐 / 分页 / 登录的**实录语料** | 回放的输入，新内核唯一的等价性证据 |

### 10.3 删除

| 删除 | 理由 |
|---|---|
| 假模型 T1 + `agent/request` 拦截 + `realModel` 记忆还原 | 工具直接返回结果，模型自己决定；没有第二个决策者就不需要选路 |
| 流程表 + 解释器 + 装配期校验（`engine.ts` 1265 + `flow-spec.ts` 526） | 流程 = `async` 函数；合法性由 `tsc` 检查 |
| 在途窗口表 + 六层收口 + 武装标记（`inflight.ts` 725） | 收口 = `wait()` 的参数 |
| 裁决器五站消费链 + 单一水位线 + recall 缓冲（`adjudicator.ts` 1200） | 行的归属只有"有人在等"或"进缓冲" |
| 投递通道 / defer 槽 / 结算计时器 / T2 限流 | 结果就是工具返回值 |
| 看门狗表 | 一个计时器 + 一个 latch（§8.2） |
| 双宿主流程引擎 / T1 流程所有权 / B3 终态判据 / 回合收束判据 | 回合归官方 loop，不干预 |
| 权限档位机制层 + `tools/pre-execute` 闸门 | 危险命令一行判断；档位用条件注册 |
| 自建 dispose 树、Session 账本、JSONL 日志 | 宿主 `ctx.effect` / Session / `session-persistence-jsonl` 已做 |
| 手写 `loop-sim.ts`（382 行） | 改用官方录制回放（§11.3） |

---

## 11. 验收

### 11.1 等待原语（不需要宿主接口）

把打坐（完成句跨批）、分页、登录的实录行流做成表驱动断言：

- 完成句**跨批**能匹配上（累积文本匹配）；
- 危险能中断 `read()` **与** `ask()`；
- `rest` 同帧移交正确（下一步提示行不丢）；
- `quiet`/`timeout` 作为兜底能返回已收内容，且**声明了 `until` 却以 `quiet`/`timeout` 结束会记 error**。

### 11.2 端到端（真连）

登录全链（正常 / 用户名不存在 / 密码错 / 断开）、打坐、分页各一条。

### 11.3 回合数：用官方回放量

1. `DSH_SNAPSHOT=record` 用真账号录一次（登录 / 长命令 / fullme）；
2. `DSH_SNAPSHOT=replay` 无密钥回放，跑**真 loop、真工具管道**；
3. 断言：**会话日志中 `request/header` 事件数 == 该场景的决策点数**。

原则：**模型请求数 == 该场景真正需要模型决策的次数**，没有空续步、没有隐藏的回合推断。目标账目：

| 场景 | 模型请求数 | 说明 |
|---|---|---|
| 登录（正常） | **0** | 全程确定性，脚本跑完只返回一个工具结果 |
| 登录（ID 已存在） | **1** | 流程返回疑问 → 模型带答案重入（§7.3） |
| fullme（模型调起） | **1** | 取图 → `ask()` 挂起 → 人给码 → 发完 → 返回 |
| fullme（反射调起，模型空闲） | **1** | 叫醒模型 → 模型送值 → 脚本继续 |
| 打坐（长命令） | **1**（可 2） | 发起 + 完成句收口 |

对比现行 §19.6.1 的"1 回合 / 3 步 / 3 次模型请求 / idleSteps=0"。

---

## 12. 边界：什么不能加

设计能否维持，取决于"新需求往哪里放"。**允许增长的就三处**：

```
① Mud 的等待原语      read() / ask() / send()
② onLine(line, mud)   世界更新 + 越界判定（加一个 if）
③ flows/              一条新流程 = 一个 async 函数
```

**禁止**：

```
✗ 新目录、新"域"（不许再出现 judge / frame / curator / gate / delivery 这类名字）
✗ 任何形式的解释器、声明表、装配期校验器、注册表框架
✗ 任何计时器子系统（计时只能是 wait() 里的一次竞速，或 §8.2 那一个 latch）
✗ 任何"投递 / 通道 / 优先级"概念（发送路径只有 send 一条）
✗ 任何二次实现宿主已有能力（回合、恢复、人工、可见性、持久化）
```

判据一句话：**它能不能写成"`wait()` 的一个参数"或"`onLine()` 里的一个 `if`"？能，就做；不能，先争论。**

---

## 13. 非目标

1. **跨会话编排**（多用户协同）：连接是会话无关的传输资源，流程是会话作用域的。
2. **断线后续接流程**：断线 = 流程结束，重连后从入口重跑。
3. **流程内部并行分支**：无真实消费方（login / fullme / 打坐皆严格串行）。
4. **配置热加载**：流程是代码，改流程 = 改代码 + 重启。
5. **自建回放 / 日志 / 持久化**：一律用宿主通道。

---

## 14. 实施顺序

1. **`mud.ts` 的入站链与 `wait()`**：搬 `ansi.ts`/`telnet.ts`（推送式回调，不新建循环）；实现六条件竞速、累积文本匹配、`rest` 移交、`danger` 一份判据。**不需要宿主接口。**
2. **语料回放用例**（§11.1）：先证明"打坐完成句跨批能匹配""危险能中断 read 与 ask"。**先有会红的用例，再改实现。**
3. **`rules.ts` + `world`**：搬现行数据作回归基线；`onLine()` 的世界更新 + 越界判定。
4. **`flows/`（login / fullme）+ `ask()` 两支实现 + 三个工具 + `index.ts` 接线**。
5. **官方录制回放**（§11.3）：三条场景各录一次，断言请求数 == 决策点数。

第 1、2 步完全不需要宿主接口，可独立跑通并有真证据。

---

## 15. 待实测

1. **打坐完成句是否真的跨批到达** —— 决定 §4.2 "累积文本匹配"是否必需；需用实录语料确认。
2. **危险判据的正则与阈值**（HP 低到多少、哪些句子算"遭攻击"）—— 需一次实测标定。
3. **`quietMs` 缺省值与长命令兜底时长** —— 需按命令实测。
4. **知识型 skill 的目录与命名约定** —— 落地时确认宿主 skills 已装配。

> AI生成
