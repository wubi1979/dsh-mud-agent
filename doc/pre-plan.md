# 二期工具面详细设计起草（pre-plan）

> **当前状态（2026-09-29）**：**已定稿**（两轮审阅定稿：①水位线 pull 模型（投递/工具读推进、状态/规则不推进、规则吞行留摘要）；②turn/end 驱动投递；③ReadMachine 保留 abortWait/danger + swallow 钩子；④禁词表最小集 suicide；⑤mud_state 不受闸门；⑥deny 先于闸门/连接）。下一步：并入 `doc/PLAN.md` 第二期节后按切片开工。
>
> **文件角色**：二期（工具面）的详细设计起草区。只写设计不写演进过程；落地后同步 `doc/architecture/00-core.md`（§3.3 工具面后置节改为现役）+ `CHANGELOG.md` 登记一行。

## 需求与触发（PLAN.md 二期原文）

> **触发**：一期跑通后，agent 需要向 MUD 发命令、主动读状态（只接消息不够用）。
> **范围**：`mud_send` / `mud_state` 工具注册；禁发表（安全面，防 agent 发危险命令）；工具受接入闸门约束（一期定死的约束在此落地）。
> **预设约束**：未连接/未接入均可读拒绝；连接与接入是手工动词，模型不能自己拉起连接。

设计原则沿用：只实现被需求直接证实的机制；原生机制优先；有例证才引入新机制。

## 已核实事实

1. **宿主 defineTool 面**（`packages/core/tools/src/schema.ts:483-545`）：`defineTool({ name, description, parameters, output: { schema, render }, timeoutMs?, isConcurrencySafe?, execute(args, exec), presentCall?, presentResult? })`；`ctx.tools.register(...)` 返回 disposer；`ToolRunContext` 含 `exec.agent`（调用方 agent，`agent.id` = 会话 id——index.ts agent/created 已实证）与 `exec.signal`（中止信号）；`timeoutMs` 是协作式超时正数；`isConcurrencySafe` 控制并行/独占调度。
2. **宿主 turn 事件确认**（`packages/extensions/tool-cordis/src/api-catalog.ts:6488`）：`SessionEventMap` 含 `'turn/start': { turn }` 与 `'turn/end': { turn, reason: TurnEndReason }`；订阅方式 = `ctx.on('session/event', (session, event) => {...}, { global: true })`（tool-todo `invariant.ts:92` 同款）；事件内判 `event.type === 'turn/end'`。
3. **`MudLine.abs` 已在 core3**（`src/link/line.ts:59`）：绝对行号，`AnsiStreamParser` 自分配，单调递增，跨重连不归零（reset/flush 不复位）——水位线模型的行标识零成本可用。
4. **core2 遗产（移植源，完整在档）**：`src/tools/tools.ts`（447 行：三工具 + 子会话静态禁发表 + listen 编译 + LoginGate + 注册完整性自检）、`src/link/mud.ts`（436 行 read 竞速机：Holder/WaitOpts/ReadResult/read/abortWait/有界缓冲/判定序 failOn>until>gaCount>maxLines/quiet/timeout/signal/disconnected/danger 收束/rest 同帧移交/swallow 吞行）、`test/link/mud.spec.ts`（403 行）。core2 §12 静态遮蔽：禁发表只管子会话、根放行——core3 **无 root/child 之分，此前提失效**。
5. **core3 现状**：
   - `link/mud.ts`（170 行瘦身版）：连接 + 行流分发 + **epoch 代次**（core2 没有的新机制，防旧连接迟到事件污染新连接）+ 硬收尾 disconnect；竞速机整体已砍；
   - `runtime.ts`：`pendingLines` 录制缓冲（环形 recordLimit=2000，断线清空）**当前无消费者**（§3.4 预言"供后续工具裸读"）；`mud.onBoundary` 未接线（C5 screen 若已接需协调）；`onDisconnect` 已接（清录制 + 置 disconnected）；
   - `deliver.ts`：Deliverer 持 `admitted`（admit 清积压=水位、stop 停投）、投递缓冲 500 行、静默窗口/最长等待/拆条；
   - `service.ts`：`status(sessionId)` 已聚合 `{ state, admitted }`；`get(sessionId)` 取 runtime；
   - `index.ts`：`ctx.provide('mudCore3', { runtimeFor })`（§3.1 预留的拒绝点）；agent/created 记句柄、session/disposed 拆 runtime；
   - `cordis.patch.yml` preset 行（mud-player）已留注释位："工具面落地后（第二期）在此行注册 mud_send/mud_state 工具"；
   - §1.2 已核实宿主事实 4："无每账号环境——preset 一棵树共享，工具定义共享，**数据必须调用期按会话解析**"（核心约束，工具归属判定同 §1.3 roster 判定）。
6. **测试手法**：core3 `test/link/mud.spec.ts` 用真实 TCP server（node:net `startServer`）驱动——竞速机/工具测试沿用同款。

## 设计

### 1. 工具清单与注册（preset 作用域）

- 二工具：`mud_send`、`mud_state`。**不做** `mud_flow`（三期）；**不注册** 识别/验证码工具（必然失败的桩会白烧请求）。
- **注册位置：preset 行（mud-player preset 作用域）**，新增独立插件入口 `src/preset.ts`（build 产出 `lib/preset.js`）：
  - `cordis.patch.yml` preset 行 plugins 列表追加：
    ```yaml
    - id: mud-tools
      name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core3/lib/preset.js'
    ```
  - `preset.ts` `apply(ctx)`：经宿主 `ctx.tools.register` 注册二工具；**注册期不依赖引擎**；执行期 `ctx.get('mudCore3')` 解析引擎窄面（preset 作用域沿父链可见全局层 provide——core2 已验证模式）。
- **工具定义放纯层 `src/tools.ts`**（零宿主 import，窄结构接口同 core2 MudToolDefinition），preset.ts 只做 defineTool 适配——与 service/runtime/deliver 的纯 TS + 接线结构一致，可单测。
- **工具注册完整性自检**（core2 先例保留）：recording registrar 收集实际注册名，二工具缺一即 fail-loud。
- **preset 语义**：工具只挂在 mud-player。选 `standard` preset 的账号**没有** mud 工具（§1.3 允许任意 preset；preset 决定能力面）——agent 只能接消息嘴炮，这是用户选择，非缺陷。

### 2. 拒绝序（预设约束落地）

mud_send 执行序（全部**可读拒绝**——返回 `{ ok: false, error }` 让模型读、能转告用户；不 throw）：

1. 引擎缺席（`ctx.get('mudCore3')` 为 null）→ 拒（I9 先例：注册照常、执行说明）；
2. 归属：`toolContextFor(exec.agent)` 为 null（会话不在 roster）→ 拒「本会话未绑定 MUD 账号」；
3. **禁发表**（cmd 存在时，全段扫描命中）→ 拒（安全面最高优先，先于闸门/连接）；
4. **接入闸门**：`admitted === false` → 拒「未接入：MUD 信息未进入本会话，工具不可用。请让用户在管理面对本账号执行『接入』」；
5. **连接**：`connState !== 'connected'` → 拒「未连接：连接由用户手工管理，模型不能自行建连」——预设约束「连接是手工动词」的直接落地；
6. 执行：send → read。

mud_state 执行序：1、2 同；**不受闸门/连接约束**（见 §6）。

### 3. read 竞速机移植：ReadMachine 独立类（src/read.ts）

**裁定：竞速机从 core2 的 Mud 类拆出为独立类 `ReadMachine`，挂在 SessionRuntime；core3 的 Mud 类不动。**

理由：

- core3 的 Mud 已演进（epoch 代次、硬收尾 disconnect）——把 core2 的 Mud 整体覆盖回来会丢失一期成果；把竞速机合回 Mud 类则行分发内联判定，与 core3 现成的"onLine 钩子 → 多消费者"模型冲突；
- core3 行流路径已是多消费者（录制/投递/日志），竞速机作为**又一个消费者**最干净：行到达 → `runtime.onLine` → ①pending 录制（永远）→ ②read 在途则 `readMachine.onLine`（acc + 判定）→ ③投递（水位线拉取，见 §4）；
- core2 的「rest 同帧移交」在逐行回调模型下自然消解：判据命中行之后的同批剩余行照常走 onLine（进 pending + 拉投递），等价「rest 并回缓冲」。`ReadResult.rest` 字段**砍掉**。

**移植保**：判定序 `failOn > until > gaCount > maxLines`（写死）；异步收束源 quiet/timeout/signal/disconnected；until 失配记错（onLog error，语料可见）；有界缓冲 = 直接用 runtime.pendingLines（不再自建缓冲——消费源即录制缓冲）。

**移植砍/改**（core3 无 root/child、无意识层）：

| 项 | core2 | core3 裁定 |
|---|---|---|
| Holder / root/child | 持有者冲突判定 | **砍**（core3 单会话单 agent；并发 read 以 inFlight fail-loud 兜底） |
| `abortWait` + `danger` 收束原因 | 意识层危险打断 | **保留 API**（用户裁决：拦路/叫杀是真实例证，需打断能力；调用方 = 后置意识层，本期无调用者，管道就绪） |
| swallow 吞行 | 反射层返回 'swallow' | **保留钩子**（空实现：本期无规则层；语义见 §4 水位线） |
| onExchange 观测 | 计数/账目 | **砍**（后置） |

**ReadMachine API 草案**：

```ts
// src/read.ts（纯 TS，零宿主依赖）
type ReadReason = 'done' | 'failOn' | 'timeout' | 'quiet' | 'signal' | 'disconnected' | 'danger'
interface ReadOpts {
  until?: RegExp[]; failOn?: RegExp[]; gaCount?: number
  quietMs?: number; timeoutMs: number; maxLines?: number
  signal?: AbortSignal
}
interface ReadResult { lines: MudLine[]; reason: ReadReason }
class ReadMachine {
  onLog: ((level: 'info'|'error', text: string) => void) | null = null
  /** 行分发前的吞行判定（反射/规则层注入；返回 'swallow' 即吞掉该行——不进 acc/不推进水位）。 */
  onLine: ((line: MudLine) => 'swallow' | void) | null = null
  get inFlight(): boolean
  start(opts: ReadOpts, initial: MudLine[]): Promise<ReadResult>  // 并发 start fail-loud
  onLine(line: MudLine): void    // runtime 行路径调用（在途时累积+判定）
  onBoundary(): void             // GA/EOR → gaSeen++ 判定
  onDisconnected(): void         // 断线收束（runtime 的 onDisconnect 链）
  /** 打断在途 read（意识层 danger 出口；触发行由调用方收编进 acc）。 */
  abortWait(line?: MudLine): void
}
```

**failOn 是 agent 驱动的打断机制（强调）**：agent 在 listen 里设 `failOn: [/拦路/, /叫杀/, /攻击/]`，突发事件行一到达即命中、read 立即以 `reason:'failOn'` 收束，返回累积行（含触发行）——agent 驱动、即时、判序第一。abortWait 是**系统驱动**打断（意识层全局判危险），两者互补。

### 4. 水位线模型（核心，用户裁决：pull 模型）

**单一真相源 = pendingLines**（环形，recordLines=2000，所有行到达即入；断线清空）。投递器**不再自持缓冲**，投递 = 从 pending 按水位线拉取。

```
两条水位线（行号空间 = MudLine.abs，单调递增）：
  deliveredAbs —— 投递推进：本会话已投递给 agent 的最远行号
  readAbs      —— 工具读推进：最近一次 read 返回结果的最大行号
  已见线 seen = max(deliveredAbs, readAbs)   ← agent 已经见过的行边界

投递时机：
  A. turn 期间（turn/start → turn/end）：投递器「抑制模式」——不 fire 定时器，
     行只进 pending 积累；
  B. turn/end：flush 一次——从 pending 取 abs > seen 的行，按 maxLines/maxChars
      拆条投出 → delivered 推进到实际投出的最大行号；
  C. 空闲模式（agent 不在 turn）：quiet/maxWait 定时器到期即 flush（§3.4 静默窗口语义）。
投递内容（A/B/C 同一逻辑）：
  take(seen, maxLines) → 投递 → delivered = 取到的最大 abs
  （未接入：不投，delivered 不推进——闸门在源头）

admit（接入）：delivered = 当前末端（水位 = 接入时刻，积压不回放 —— §3.4 语义）；
stop：不投（pending 照常积累 = 录制）。
```

**read（mud_send）与水位线**：

- **有 cmd**：send 后等新行（acc 只收 read 在途行）；返回时 `readAbs = max(readAbs, acc 尾行号)`——应答行标记已见，turn/end 不再重复投；
- **裸读（无 cmd）**：initial = pending 尾部 N 行；返回时同样推进 readAbs —— **裸读读过的行不再投递**（用户裁决：避免行数据多次进入 agent）；
- **read 在途不需要"暂停投递"互斥**——水位线天然隔离：read 消费的行推进 readAbs，投递从水位线之后拉取，重复被结构消除（上一版"互斥"方案作废，被水位线取代）。

**水位线语义总表（用户裁决）**：

| 消费路径 | 推进水位？ | 说明 |
|---|---|---|
| **投递** | ✅ | 投出的行进入 followup = agent 已见 |
| **工具读（mud_send read / 裸读）** | ✅ | readAbs 推进 = agent 已见（结果即模型可见面） |
| **流程 mud_flow（三期）** | ✅ | 流程消费的行进入流程结果 = 已见 |
| 状态同步（world/awareness，后置） | ❌ | 只更新本地状态，行仍可投递/读 |
| 规则动作（reflex，后置） | ❌ **吞行留摘要** | 吞掉的行不进 pending/acc/投递（不进任何模型面），只落盘 + 摘要；摘要由规则层接管（swallow 钩子，本二期空实现） |

目标：**避免行数据多次进入 agent**——已见线是唯一裁决者，任何把行内容交给 agent 的路径都推进，任何只做本地处理/规则的路径都不推进（规则路径用吞行代替推进）。

### 5. 裸读语义（mud_send 不带 cmd）

**定义**：不向 MUD 发任何命令，只读当前行流（看近况——§3.4 预言"要看近况用工具裸读"）。把录制缓冲最近 N 行返回给模型（主动回看窗口），不无限等新行。

| 模式 | initial（read 开始时从 pending 取） | 缺省完成判据 |
|---|---|---|
| **有 cmd**（send + 等应答） | 空（acc 只收 send 后新行；send 前积压行走投递/已投递） | `gaCount: 1`（一段完整文字）+ `maxLines: 50` 兜底 |
| **无 cmd**（裸读近况） | pending 尾部 maxLines 行（默认 50，超量丢头部记 dropped） | `maxLines: 50` + `quietMs: 300`（短静默窗口收正在到达的尾巴） |

- initial 参与判定（先到先结算，可立即命中收束）；
- 裸读返回时推进 readAbs = initial 末行号（防重复投递）；
- 模型可显式给 until/failOn/gaCount/quietMs/maxLines 覆盖缺省；
- `timeoutMs` 必填或工具注入缺省；参数钳制 `min(arg ?? default, MAX_TIMEOUT_MS=60000)`。

### 6. mud_state：状态自述，不受闸门

core2 的 world.snapshot()（HP/内力/位置）——core3 无意识层/world，不建。

**裁定：** mud_state 返回本地连接/接入/录制状态快照，**不受闸门与连接约束**（只过归属）：

```json
{ "ok": true, "state": { "connState": "connected", "admitted": false, "recording": 320, "dropped": 5 } }
```

理由：闸门定义在「MUD 信息进入 agent 的通路」上（§3.2）；连接/接入/录制状态是插件本地事实，不是 MUD 行流——相当于把管理面 status 对 agent 开放。模型能答"我未接入"本身要求它能读状态。未接入时唯一可读的工具就是它。

### 7. 禁词表：最小集 + 全段扫描（用户裁决）

- **定义**：对 mud_send 发出命令的拦截表（安全面）。`suicide`（删除人物档案，**不可逆**，且任何正常玩法都不需要）命中即拒；拒绝信息带命中词，模型可读、可转告用户。
- **用户裁定**：除自杀外其他命令（quit/exit/logout/drop/passwd 等）影响可逆或可恢复，**不设拦截**——按 I5 例证纪律：语料审计发现真实危险行为再逐行加回（加一行表即可）。
- **全段扫描**（与 core2 首词判定差异）：`commandTokens(cmd)` 按 `[\s;]+` 切分得全部 token，任一命中即拒——成本一行，堵 "look;suicide" 绕过洞（core3 无 root 放行面，唯一防线不留洞）。
- 表（写死常量，当前仅一项）：`DENY_HEADS = { 'suicide' }`；拒绝信息：`拒绝执行：危险命令（suicide）被禁（不可逆）`。

### 8. 工具窄面扩展（index.ts）

```ts
interface MudCore3Service {
  runtimeFor(agent: { id: unknown }): SessionRuntime | null
  /** 工具执行上下文：归属 + 闸门/连接状态（未登记返回 null）。 */
  toolContextFor(agent: { id: unknown }): ToolContext | null
  defaults: { sendTimeoutMs: number; sendMaxLines: number }
}
interface ToolContext { sessionId: string; runtime: SessionRuntime; admitted: boolean; connState: ConnState }
```

`toolContextFor` = 查 accounts（sessionId = agent.id）→ `service.get` + `service.status` 聚合，与 §3.1 归属解析同一路径。

### 9. 工具参数面（宿主 defineTool）

| 项 | mud_send | mud_state |
|---|---|---|
| parameters | `{ cmd?: string, listen?: { until?, failOn?, gaCount?, quietMs?, maxLines? }, timeoutMs? }` | `{}` |
| output.schema | `{ ok, reason?, lines?, error? }` | `{ ok, state }` |
| render | ok → 行原文 join('\n')；拒/错 → error 文本（模型面合同：原文/可读文本，canonical JSON 只走 schema/持久化） | 状态 JSON |
| timeoutMs（宿主注册期） | `MAX_TIMEOUT_MS=60000`（协作式超时上限；工具参数钳制 ≤ 此值，见 §5） | 5000 |
| isConcurrencySafe | **false**（socket 写 + 行流等待，独占） | true |
| presentCall/presentResult | 不设（render 已足，core2 无先例） | 不设 |

### 10. Config（引擎行新增）

- `sendTimeoutMs`：mud_send 缺省总超时毫秒，缺省 15000；
- `sendMaxLines`：裸读尾部/兜底行数，缺省 50；
- 禁词表、quietMs=300、MAX_TIMEOUT_MS=60000 硬编码（无例证不进 Config）。

### 11. persona 措辞（mud-player preset 更新）

二期追加工具说明（实施时定措辞，收录进「容易遗漏项」对应条目）：

> 你可以用 mud_send 向游戏发命令（cmd）或裸读近期行流（不带 cmd）；用 mud_state 查看连接与接入状态。连接与接入由用户手工控制，你不能自行建连。删档命令 suicide 被禁止。若工具返回「未接入/未连接」，如实告知用户。

### 12. 接线面（index.ts 增补）

- 订阅 `session/event`（global）：按 `event.type === 'turn/start'` / `'turn/end'` 且会话 ∈ roster 过滤，调 `deliverer.onTurnStart/onTurnEnd`；
- 投递器新增 `onTurnStart`（抑制模式）、`onTurnEnd`（flush）：
  - 抑制模式：定时器不 fire，行只进 pending（拉取逻辑在 flush 时统一）；
  - flush：从 pending 取 abs > seen（delivered/read 最大值）→ 拆条投递 → delivered 推进；
- 空闲模式保留 quiet/maxWait 定时器（静默投递，§3.1 语义不变）。

## 与 core2 的差异汇总（裁决表）

| 项 | core2 | core3（本设计） | 理由 |
|---|---|---|---|
| 行流消费 | read 唯一消费者 | pending 单一真相 + 水位线拉取（投递/工具读共同推进） | 用户裁决 pull 模型 |
| 裸读缺省 | gaCount:1（等新行） | maxLines:50 + quietMs:300（读尾部近况） | §3.4 预言落地 |
| 有 cmd initial | buffer 全量进 acc | 空（积压留给投递） | 积压已投递过/交给投递 |
| read 在途 | 行只进 acc（互斥） | 不互斥——水位线天然隔离（readAbs 推进） | 水位线结构消除重复 |
| 打断 | 意识层 abortWait | abortWait 保留 API + failOn agent 驱动 | 拦路/叫杀例证 + 意识层后置 |
| swallow | 反射层吞行 | 钩子保留空实现 | 用户裁决：规则动作吞行留摘要 |
| 禁词表 | 首段判断、只管子会话 | 全段扫描、全量拦截、最小集 { suicide } | 无 root 放行 + 用户裁定 |
| 隐式建连 + LoginGate | 首次 send 隐式建连 | **无**（未连接可读拒） | PLAN 预设约束：连接是手工动词 |
| 缓冲 | Mud 内 512 行/64KB | 复用 runtime.pendingLines（2000 行） | 一套录制缓冲 |
| rest 字段 | 返回 | 砍（同帧剩余行已进 pending） | 逐行回调模型下自然消解 |
| 工具注册 | preset 行三工具（含 mud_flow） | preset 行二工具 | mud_flow 三期 |

## 测试面（vitest 先红后绿，在现有 79 项上加）

- `test/read.spec.ts`（ReadMachine 单测，伪行流直接驱动）：
  1. 判定序：failOn 优先于 until，until 优先于 gaCount，gaCount 优先于 maxLines；
  2. quiet/timeout/signal/disconnected/danger 各一例（danger = abortWait 触发）；
  3. until 失配 + quiet/timeout/maxLines 收场 → 记错；
  4. initial 立即命中（有积压行时无新行即收）；
  5. 并发 start fail-loud；
  6. 裸读：initial 取尾部 maxLines、超尾丢弃；
  7. swallow 钩子：返回 'swallow' 的行不进 acc。
- `test/runtime.spec.ts` 增（真实 TCP server 端到端）：
  1. send + read：server 回行 + GA → 收束返回原文；
  2. 有 cmd：积压不进 acc、应答是新行；
  3. 裸读：历史行立即返回 + quiet 窗口收尾巴；
  4. 断线中断在途 read（reason: 'disconnected'）；
  5. 水位线：read 消费的行 turn/end 不重复投递（delivered 推进）；
  6. turn/end 冲刷：turn 内积累的行一次投出（一个批次，不重复）。
- `test/tools.spec.ts`（假 registrar + 假 core()）：
  1. 注册完整性自检（缺一 fail-loud）；
  2. 引擎缺席 / 归属 null 拒绝；
  3. deny：全段扫描「look;suicide」拒、「suicide」拒；quit/drop/passwd 等**放行**（最小集）；
  4. 未接入（admitted=false）mud_send 拒；
  5. 未连接 mud_send 拒；
  6. **mud_state 未接入可读**（不受闸门）；
  7. listen 编译：非法正则报可读错；
  8. timeoutMs 钳制到 MAX_TIMEOUT_MS。
- `test/deliver.spec.ts` 增：turn 模式抑制（turn/start 后不 fire）、turn/end 冲刷（从 pending 取未投行）、水位线推进（投后 delivered 更新）、裸读推水位后不重复投。
- `test/service.spec.ts` 增：toolContextFor 流转（admit 前/后、断连、销毁后 null）。

## 验收（对齐 PLAN 二期范围）

| 断言 | 内容 |
|---|---|
| 工具可见面 | mud-player preset 会话可见 mud_send/mud_state；standard 会话不可见（preset 决定能力面） |
| 闸门 | 未接入 ⇒ mud_send 可读拒绝（错误信息模型可转告用户）；接入后可用 |
| 连接约束 | 未连接 ⇒ mud_send 可读拒绝；模型无任何自行建连通路 |
| 禁词表 | suicide 全段拦截、可读拒绝带命中词；quit/drop/passwd 等放行 |
| 端到端 | 连接+接入后：mud_send(cmd) 返回应答原文，agent 能据此继续决策 |
| 水位线 | turn/end 一次投出回合内未消费行；read/裸读消费的行不重复投递；投递只投 seen 之后 |
| 裸读 | 无 cmd 返回近期行（尾部截断生效），不等无限，不重复投 |
| 回归 | 新增用例全绿 + 既有 79 项不回归 |

## 前置验证（宿主环境，开工后第一步）

1. `preset.js` 构建产物在 preset 行加载：mud-player 会话工具可见、可调；
2. preset 作用域 `ctx.get('mudCore3')` 解析到全局引擎窄面；
3. `session.event` 订阅 turn/start、turn/end 生效（按会话过滤）；
4. 端到端：接入 → agent 自主调 mud_send 发命令 → 应答原文进结果 → agent 决策；
5. 未接入调用 → 可读拒绝 → agent 如实转告（不回退、不假死）。
6. gen:typert 不涉及（工具面无 remote 动词新增）。

## 后置（不在本期）

- `mud_flow`（三期：登录/验证码/多步编排，从 core2 移植）；流程消费行推进水位（语义已定）；
- 意识层回归：危险判据 → abortWait 接线 + swallow 钩子实现（规则吞行留摘要）；
- 投递策略化（字段化摘要、按需投递）——token 账目恶化时；
- 禁词表可配（Config）；
- 唤醒类机制落地（闸门前置已定，§3.4）；
- C5 screen 的 onBoundary 占用协调——实施时检查接线。

## 定稿裁决记录（2026-09-29 两轮审阅）

1. **水位线 pull 模型**（核心）：单一真相 pending + 水位线（delivered/read 两线，seen=max）；投递 = turn/end（或空闲定时）从 pending 拉取 seen 之后的行；read/裸读推进 readAbs；状态同步/规则动作不推进，规则动作吞行留摘要——**替代上轮"互斥暂停投递"**（互斥挡不住裸读重复，水位线结构性解决）。
2. **turn/end 驱动投递**：宿主事件已确认，订阅 session:event（turn 模式抑制、turn/end 冲刷）；空闲模式静默定时语义不变。
3. **abortWait/danger 保留**：拦路/叫杀等突发例证（用户裁定）；API 保留、意识层后置接线；failOn 为 agent 驱动的打断机制（判序第一、即时收束）。
4. **裸读**：读 pending 尾部近况 + 短静默窗口 + 推进水位（防重复投）。
5. **禁词表最小集 { suicide }**：全段扫描；实证发现新危险命令按 I5 加行。
6. **mud_state 不受闸门/连接约束**（只过归属）。
7. **deny 判定先于闸门/连接**（安全优先）。
8. **MudLine.abs 确认已有**，不额外暴露给 agent（工具输出为纯文本，abs 是内部水位线坐标）。

> AI生成