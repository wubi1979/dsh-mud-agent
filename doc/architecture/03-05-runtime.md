---
sections: [3, 4, 5]
status: active
deps: ["§1", "§2"]
note: 入站主干：字节 → 行 → 录制与水位 → 四个消费者
---

# §3 L1 接入层：连接与行流

## 3.1 职责与边界

| 项 | 内容 |
|---|---|
| **输入** | MUD 服务器的 TCP 字节流 |
| **输出** | `MudLine{text, abs}`（已做 ANSI 处理、已行化）+ **边界事件**（GA / EOR / 断线）+ GMCP 包事件 |
| **不做** | 不做任何消费决策（不分帧、不判断"哪些行给谁"）、不持有会话状态、不做投递 |
| **归属** | 每个 `SessionRuntime` 独占一个 `Mud` 实例与一条连接；连接是**会话私有的传输资源** |

## 3.2 连接管理

**动词**：手工 `remote.mud.connect(sessionId)` / `remote.mud.disconnect(sessionId)` + `mud_connect` 工具（§8.3）。**`connect` 只建连、不登录**——登录是一条 locked 流程（§8.14）；盲发登录序列已退役。

| 场景 | 语义 |
|---|---|
| **connect（幂等）** | 已连接不重连、不踢已登录会话；"正在连接"有并发保护；建连成功后行流开始积累（停在登录提示符） |
| **建连失败** | 对端拒绝/关闭 ⇒ **立即失败并销毁 socket**，不等满超时；错误带 `host:port` 与完整 `cause`（§13.1） |
| **disconnect（硬收尾）** | 立即销毁 socket 并**同步走完收尾**（flush 残留行 → 状态置断开），**不做半开关闭等待**——半开连接仍会继续收数据，其迟到的 close 会污染后续连接 |
| **连接代次** | 建连/断连各自增；旧连接迟到的 `text`/`boundary`/`close` **一律丢弃**，不得改变新连接状态 |
| **断线（意外）** | runtime 保留、状态置断开、**世界状态复位**、`pendingLines` 清空、水位复位；**自动重连**（闸门 `hasConnected && !manualDisconnected`，§11.3 / §10.4） |
| **探活** | 服务端无主动心跳（2026-10-04 探针实测：[probe-heartbeat.mjs](../../packages/mud-core3/test/probe-heartbeat.mjs)——零发送 240s 零入站，NOP/GMCP Ping 静默不可判活），半开检测靠客户端主动探活：**link 层自驱静默伴随探测**（T12，非周期、无到期点入口）——时钟锚 = **最后数据到达时刻**（任何行/GA 到达即重置锚：判活 + 窗口随下一轮静默重开），静默满 `probeStartMs`（缺省 90s）发送 telnet AYT(246)，无应答每 `probeRetryMs`（缺省 9s）重发共 `probeMaxAttempts`（缺省 3）次，判死刻度 = 90 + 3×9 = **117s**（落在 `silenceMs` 120s 唤醒到期点之前留 3s）；判据 `^\[-Yes-\]`（GA 主路径判活，行刷出兜底）；判活 **link 内部消化**（观测态回 idle，无上报回调）；判死 → 硬收尾转自动重连（上层只消费断开事实）；busy 谓词（`holderBusy ∥ isInTurn`）为真的探测 tick **跳过**（不发 AYT 不耗次数、不顺延——busy 贯穿窗口 = 本轮零探活，read timeout 与唤醒点守卫兜底）；校验 `probeStartMs + probeMaxAttempts × probeRetryMs ≤ silenceMs`（启动 fail-loud，§15.5） |
| **自动重连** | 限次放弃（缺省 5 次 × 30s）后保持断开等人工/静默唤醒；手工 `connect`/`disconnect` 经代次令牌打断在飞循环；成功**只连不登**（登录归 agent），并显式 arm 一次静默计时；重连不重读行流（`abs` 连续 + 水位已复位，§4.5） |
| **冷会话** | 宿主释放 agent 时 runtime 与连接**不受影响**（连接归 runtime 自持，与 agent 冷热解耦）；只有会话销毁才拆 |
| **会话销毁** | `session/disposed` ⇒ 断连 + 拆 runtime / deliverer / 日志 / Wake（§11.4） |
| **插件卸载** | 全拆：断连全部 + 拆全部 Wake（§11.7） |

## 3.3 telnet 与 GMCP 协议层

- `link/telnet.ts` 实现 telnet 协商与子协商，并把 GMCP 包以 `emit('gmcp', …)` 抛出——**接收端零新增**。
- **GMCP 是权威登录信号**（不依赖行文匹配）：GMCP 包到达即置 `loggedIn = 'in-game'` 并写入 World（`zone = 'gmcp'`，`key = 包名`，置信度 `measured`，后到覆盖）——见 §10.2。
- 协议异常、断线、协商事件都落会话日志（§13.1）。

## 3.4 行化与行模型

- `link/line.ts`：流式 ANSI 解析 + 行分割 + `MudLine` + `abs` + flush（文件内容不止 ANSI，故不叫 `ansi.ts`）。
- **行**：`MudLine { text, abs }`。`text` 已去 ANSI；`abs` 是**单调递增的行号**，**跨重连不归零**（水位线用它做"已见"记账，§4.3）。
- **边界事件**：GA / EOR 由协议层给出；300ms 静默是**网络装配粒度**（用于把长输出切块），**不是消费边界**（消费边界只认 GA/EOR 与武装判据）。
- 断线收尾会 flush 残留行（不留半行）。
- 行化是纯函数式处理，零宿主依赖 ⇒ 可单测（回放用例，§16.1）。

## 3.5 语料落盘

- `link/corpus.ts`：行流按 JSONL 全量落盘并可读回（回放用例的素材来源）。
- 语料是**诊断与校准**资产：不进 Session、不进 agent 上下文；凭据类出站不入语料（§12.2）。
- 语料用于：登录流程的语料校准（提示行原文核对，附录 A）、规则层的行级证据积累（后置）。

---

# §4 L2 行流层：录制与水位线

## 4.1 `SessionRuntime` 结构

```ts
// 每会话一份；由 MudService 注册表持有（§15.2）
SessionRuntime {
  sessionId, server, account
  connection: Mud | null        // MUD 输入源；未 connect 时为空
  pendingLines: MudLine[]       // 环形录制缓冲（唯一行流真相）
  droppedLineCount: number      // 环形淘汰计数（可观）
  deliveredAbs, readAbs: number // 双水位线；seen = max(...)
  readMachine: ReadMachine      // 工具/流程读的竞速机（§5.2）
  screen: GameScreen            // 画面无头屏（§5.3）
  world: World                  // 状态（§10.3）
  onActivity / onBoundary / onStateChange / onDisconnect  // 钩子
  holder: string | null         // 行流持有者（会话级唯一，§8.6）
}
```

## 4.2 环形录制

- `recordLines`（Config，缺省 **2000**）为环形上限；行到达**即入**，不因闸门或回合状态而暂停。
- 淘汰最旧行并自增 `droppedLineCount`（挂机长时间不消费时可观，不再无界增长）。
- **断线清空**（录制语义）：`pendingLines` 与未投出的残留行一并复位——与"断线是硬收尾、世界状态复位"一致（§4.5）。
- 原始行流**只落盘、不进日志环**（否则刷屏行会冲掉诊断信息，§13.1）。

## 4.3 双水位线与 `seen`（层契约）

```
deliveredAbs —— 投递推进：已成功投递给 agent 的最远行号
readAbs      —— 工具/流程读推进：最近一次 read 返回结果的最远行号
seen = max(deliveredAbs, readAbs)
初始 / 断线重置 = -1（abs 跨重连不归零）
投递 = takeLinesAfter(seen)   // 只投 seen 之后
```

**投递时机**

| 时机 | 语义 |
|---|---|
| **A. turn 期间抑制** | 行只进 `pendingLines`，不打断回合节奏（不武装定时器） |
| **B. `turn/end` 冲刷一次** | 回合内积累的行一次投出（订阅宿主 `session/event` global） |
| **C. 空闲模式** | agent 不在 turn 时保留静默定时语义：`quietMs` / `maxWaitMs` 到期即 flush |
| **D. 冷启动补投** | `agent/created` → `flushPending`（从 `seen` 拉取一次，触发首回合） |
| **admit** | `delivered = 当前末端`（**水位 = 接入时刻**，积压不回放，§6.3） |
| **投递失败** | `deliveredAbs` **只推进到成功投出的批次**；失败批次停留 `pendingLines`，下次 flush 从失败点自然重试——**不丢行** |

**水位线语义总表**（目标 = **避免行数据多次进入 agent**：把行交给 agent 的路径都推进，本地处理路径不推进）

| 消费路径 | 推进水位？ | 说明 |
|---|---|---|
| 投递（§6.2） | ✅ | 投出行 = agent 已见 |
| 工具读（应答 / 裸读，§5.2） | ✅ | `readAbs` 推进 = agent 已见 |
| 流程消费（`mud_workflow_run`，§8.13） | ✅ | 流程读过的行 = 已见 |
| 状态同步（World / GMCP，§10.3） | ❌ | 只更新本地状态，行仍可投递/读 |
| 规则动作（后置，§17.3） | ❌ 吞行留摘要 | 吞掉的行不进任何模型面，只落盘 + 摘要（`swallow` 钩子） |

**批次粒度**：静默窗口聚合，**与 TCP 块边界无关**（同块内的行永不拆入不同批次）。

## 4.4 事件分发

| 钩子 | 触发 | 订阅者 |
|---|---|---|
| `onLine(line)` | 每行到达 | `Deliverer`（水位拉取）、`GameScreen`（写屏）、`World`（状态规则，后置） |
| `onBoundary(kind)` | GA / EOR | `ReadMachine`（关窗判据：GA 计数） |
| `onActivity()` | 任一行到达 | `Wake`（行到达即 re-arm，§7.5） |
| `onStateChange()` | 状态值变化（`setState` 统一入口，值变化才触发） | `MudService` 状态广播器（`watchStatus`，§9.5） |
| `onDisconnect()` | 连接断开 / 硬收尾 | `ReadMachine`（以 `disconnected` 收束在途 read）、状态复位、日志 |

## 4.5 断线复位语义

| 复位项 | 取值 |
|---|---|
| `conn` | `disconnected` |
| `loggedIn` | `unknown`（**不是 `false`**） |
| `world` | 整体 `clear()`（世界状态随连接存亡，重连后由 GMCP 重新写入） |
| `pendingLines` | 清空（录制语义） |
| `deliveredAbs` / `readAbs` | 重置 `-1`（`abs` 空间不归零，重连后新行照常推进） |
| 在途 read | 以 `disconnected` 收束（§5.2） |
| runtime / 连接事件 | runtime **保留**，连接代次已增，旧连接事件丢弃（§3.2） |

**未接入（缺省）= 零积累语义**：不 take、不武装定时器、零缓冲零丢弃（一期"未接入刷丢弃日志"在 pull 化后消失）——即"未接入"只表示**不投递**，行流照常录制（录制是给画面/裸读/语料用的）。

---

# §5 L3 消费层：行流的消费者

## 5.1 消费者总表与水位契约

| 消费者 | 职责 | 推进水位 | 章节 |
|---|---|---|---|
| **`ReadMachine`** | 工具/流程的"发送后等应答"与"裸读近况" | ✅ `readAbs` | §5.2 |
| **`GameScreen`** | 把人要看的东西写进无头屏（游戏行 + send 回显） | ❌ | §5.3 |
| **`Deliverer`** | 聚合后以用户消息投递进会话 | ✅ `deliveredAbs` | §5.4 |
| **`World`** | GMCP/状态写入 | ❌ | §10.3 |

- **行到达 → 三条并行消费**：① pending 录制（永远）→ ② read 在途则 `machine.onLine`（acc + 判定）→ ③ 投递（水位拉取）。
- 消费者的**共同纪律**：不自造边界（消费边界只认 GA/EOR 与武装判据）、不重复消费（水位线结构消除）、丢弃必留痕（error 日志 + 计数，§13.1）。

## 5.2 `ReadMachine`

**职责**：一行流多消费者之一，服务"send 命令 + 等应答"与"裸读近况"两种读。

```
判定序（写死，不可配）：failOn > until > gaCount > maxLines
异步收束源：quiet / timeout / signal / disconnected / danger
```

| 项 | 语义 |
|---|---|
| **挂载** | 独立类，挂 `SessionRuntime`；`onBoundary` 直挂它（GA 判据） |
| **有界缓冲** | **复用 `runtime.pendingLines`**，不自建缓冲（P2） |
| **`failOn`** | **agent 驱动的打断**：突发行一到达即命中收束，并返回累积行**含触发行** |
| **`abortWait`** | **保留 API**：系统驱动打断的出口（意识层后置，§17.3）；管道已就绪 |
| **`swallow` 吞行钩子** | 空实现（规则层后置）：规则动作吞行留摘要，吞掉的行不进任何模型面 |
| **`ReadResult.rest`** | **砍掉**：判据命中后的同批剩余行照常走行路径（逐行回调模型下自然并回） |
| **命中帧 `hit`（T15）** | 判据命中时**同时**给出「哪条判据赢了（`by` + `index`）+ 该条首个命中的捕获组（`groups`）」——`by='until'\|'failOn'`、`index` 即 `branch`/`onFailOn` 的键、`groups` 为组 1..n（未参与组 `undefined`）。无判据命中（`gaCount`/`maxLines` 关窗或异步收束）⇒ `hit === undefined`。**判据匹配系统内单点在本机**：流程解释器与工具面都消费该帧，不再各自重测一遍（§8.13） |
| **取组与有状态正则** | 判定与取组用**同一次 `exec` 调用**（`exec(accText)` 一次拿到命中位置与组，不写 `test` → `exec` 两段），且调用前**重置 `lastIndex`**：`g`/`y` 是**有状态**标志（起点由 `lastIndex` 决定，`y` 还要求"正好落在 `lastIndex` 处"），不重置会让同一判据在窗口变长/跨 read 复用时时灵时不灵。词汇表白名单 = `d/i/m/s/u`（`g`/`y` 对单次 `exec` 无意义或只改锚定起点；保存门拒存留后置，见 §17.3） |
| **失配留痕** | `until` 失配记 error（语料可见，由命中帧判定，不再复测正则）；**GA/EOR 边界关窗不算失配** |
| **裸读** | 无 `cmd`：`initial = pendingLines 尾部 maxLines 行快照`（**含 admit 前录制行**——挂机近况回看；**不物理消费**）；缺省判据 `maxLines: 50 + quietMs: 300`；返回时推进 `readAbs` |
| **有 cmd** | `acc` 只收 **send 之后的新行**（积压留给投递）；返回时推进 `readAbs = acc 尾行号` |
| **并发** | read 在途**不需要互斥**——水位线天然隔离（`readAbs` 推进后投递从 `seen` 之后拉取，重复被结构消除） |

## 5.3 `GameScreen`（画面通道数据面）

- 每 runtime 一个 `@xterm/headless` Terminal + `@xterm/addon-serialize` 无头屏。
- **写入内容**：游戏行与 **send 回显**同屏写入；回显前缀 = `账号名@来源`（agent 发送 = 灰 `90m`，user 发送 = 青 `36m`；账号名由 `register` 从 roster 注入）。
- **凭据永不经过此路径**：`sendCredential` 不触发 `onSend`、不回显（§12.2）。
- **参数成组**（Config）：`viewScrollback`（缺省 2000）/ `viewCols`（缺省 **120**，可覆盖；不做 resize 回传）/ `viewMaxBufferedBytes`（缺省 2MB）。
- **屏幕跨重连保留**；插件重启即清（headless 屏随 runtime 存活）。
- **`follow` 流动词**：首帧 `snapshot`（serializer 整屏，含 ANSI）→ 有序增量 `output`（**同 tick 合批**，防刷屏小帧）→ `state` 帧（工具栏）。
- **原子性**：follower 注册与 snapshot 生成**共用一条写操作链**（与行写入互斥）⇒ attach 瞬间不丢帧、不乱序、不重复。
- **背压**：follower 有界队列，超限**显式断流**；客户端重新 `follow` 以新 snapshot 恢复（互为闭环）。
- **纯扇出无输入**：tab 工具栏的「连接/断开」按钮调的是既有手工动词，不属于画面通道；tab 关闭 = follower 清理，连接与投递不受影响。
- **不受 admit 闸门约束**（画面是 MUD→人 的显示面，§6.4）。

## 5.4 `Deliverer`（聚合与水位拉取）

**投递器不自持缓冲**（P2）——投递 = 从 `seen` 之后拉取（`takeLinesAfter(seen)`），成功投出后 `commitDelivered`。

| 参数（Config） | 缺省 | 语义 |
|---|---|---|
| `deliverQuietMs` | 500 | 静默窗口：行流静默 N ms 打包一条 |
| `deliverMaxWaitMs` | 3000 | **批次最长等待**：行流持续不静默也在此上限内投出（否则刷屏流永不投递） |
| `deliverMaxLines` | 50 | 单条上限（行） |
| `deliverMaxChars` | 8000 | 单条上限（字符） |

- **超限拆成多条依次投递，不丢行**。
- **空白批不 commit**（不投、不推进）。
- **汇总**：聚合是**必需品不是优化**——逐行投递 = 每行一个回合一次模型调用（§6.2）。

## 5.5 隔离与并发

- **按会话隔离**：每个 runtime 只向自己的会话投递、只写自己的屏、只写自己的 World、只写自己的日志（两会话互不串线，§15.2 验收）。
- **同一时刻一个执行体在 send+read**：靠**会话级行流持有者**保证（§8.6），不靠"暂停投递"的互斥——投递与读通过水位线天然隔离（§5.2）。
- **多会话并发**：宿主保证会话间并行、会话内串行（§2.1 事实 1）；本层不引入跨会话锁。

> AI生成
