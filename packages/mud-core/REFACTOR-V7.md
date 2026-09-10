# mud-core V7 设计记录 —— 命令-应答桥与输入路由

> 状态：**V1 已实施（2026-09-10 晚间）**。来源：Design-1（T1/T2 与感知/agent 交互架构）
> 架构审查会话结论；Design-2（v6.7 准入语义修正）已另行实施，见 REFACTOR-V6.md 二点七。
>
> **修订（2026-09-10）**：机制 A 由"通用 prompt 文本分帧"重写为
> **GA 主边界 + 声明边界 + 静默兜底**。依据：真实 pkuxkx 三轮抓包
> （PROTOCOL-REVIEW.md §1b；probe-2026-09-10T03-44-46-144Z.log 等）证实
> IAC GA 与命令回复一一对应且紧随提示符文本之后，文本 isPrompt 判定不再
> 是机制核心。联动修订：机制 B.3 超时语义、机制 C.6 删除项、新增六（管线
> 接入与折叠分界）。
>
> **实施状态（2026-09-10 晚间，V1）**：机制 A/B/C 主体、六（折叠分界）、
> 除"紧急预占/噪音白名单/concludeTurn"外的机制均已落地并通过回归
> （`pnpm build` tsc 0 + vitest 11 文件 139 用例）。各节以【已实施】/【部分实施】/
> 【未实施】标注；实施细节、与设计的偏差及后续项见文末"九、实施记录"。
>
> 本文只记录讨论中**明确确认**的内容；仍开放、需实录/实现时再定的事项统一列在文末
> "待定 / 需实录确认"，不视为已定稿。

## 一、历史演进与结论（为什么是现在这个形态）

**沿革**：最初只打算在真实 LLM 前做快速拦截（已知答案 / 需快速应答，如战斗）→ 拦截
直连执行导致会话里出现非 loop 产物、伪输出缺 loop 凭据，真实 agent 无法从历史学习 →
演化为"模拟 LLM（T1）"进入 loop 以获取合法历史 → 演化为瀑布（error/retry 路由）→
机制 A 第一版按"通用 prompt 文本分帧"设计，抓包证伪后改为 GA 主边界（本修订）。

**结论（已确认）**：

1. 会话历史必须由 agent loop 生成才合法（turn/step 计数、事件信封、seq、surface fold、
   projection 均归 loop 所有）。**不做**"loop 外执行 + 手工伪历史"——任何旁路执行都无法
   产出可被真实 agent 读取的历史。
2. "在进入真实 LLM 前解决已知问题 + agent 能看懂日志"的唯一交集解 =
   **判定前移（输入侧判类）+ 执行留 loop（以 T1 模拟 LLM 身份执行）**。
3. T1/T2 的"安排"不是核心问题；核心是上一条 + **命令-应答同步化**（机制 A）。

## 二、机制 A：命令-应答桥（GA 主边界 + 声明边界 + 静默兜底）【已确认·2026-09-10 修订】【已实施】

**动机/问题**：旧实现 mud 工具"发完即回"，服务器应答异步到达后被 push 成新外部输入 →
每个应答 = 新回合 → 登录等连续提示流程被拆成 N 个微型回合、爆发输出（look 房间）被拆成
N 个回合，成本与历史噪音双高。拆 turn 的根因是"命令→应答"未被配对成同步工具调用语义，
不是流程天然该拆成回合。

**语义**：mud 工具调用 = **挂起等待真实应答**；应答成为该工具调用的 tool result，由 loop
作为下一步输入 → 流程在**一个回合内以 step 链**推进。同步等待住在工具执行内部
（`MudTool.execute` 异步化），loop 本体零改动——loop 的标准原语
（tool-call → tool result → 下一步）就是"流程"的推进机制。
实施：`CommandResponseController`（`network/response.ts`，189 行）+ `buildMudTools`
装配 `sendAndAwait` 后 `MudTool.execute` 异步化；`CommandMeta.replyId` 穿透队列，
`onSend`（真实写 socket 后）调 `confirmSent(replyId, head)` 武装。

**抓包依据（三轮真实会话，PROTOCOL-REVIEW.md §1b）**：

1. **GA 与命令一一对应且必到**：17/17 条命令回复末尾各 1 个 IAC GA，紧随
   `\x1b[2;37;0m> ` 提示符文本**之后**；登录期名字/密码提示后亦有 GA。
   → GA 是协议级精确帧边界；提示符行属于帧内容。
2. **被动推送无 GA**：dz 打坐 57 条经脉渐进推送（1 条/秒）与公频聊天均无 GA 无提示符。
   → GA 只结"命令回复"；空闲流必须靠静默窗结算。
3. **长程命令 GA 早到**：`dazuo 10` 发起即 GA（受理信号），完成句在 55.8s 后且无 GA
   无提示符（唯一信号为亮绿完成句）。→ 默认 GA 边界对长程命令会提前结算，必须有声明边界。

**结算信号分层**（每个应答对象独立；按"是否声明"分两条链，链内取第一个命中者）：

- **未声明对象（默认，绝大多数命令）**：GA/EOR 主边界 → 静默窗兜底 → 超时兜底。
- **已声明对象（长程命令等）**：声明边界主边界 → 静默窗兜底 → 声明方 timeout 兜底。
  **GA 完全退出结算**——长程命令 GA 早到只表示"受理"非"完成"（如 `dazuo 10` 发起即
  GA、完成句 55.8s 后无 GA），拿来结算会提前截断。声明是**接管** GA 的角色，不是在
  GA 之上再叠一层。
  > 实施偏差（2026-09-10）：**已声明对象实际禁用静默窗**（response.ts `armTimers`：
  > `declared → 不挂静默窗`）。长程命令推进多为 1 条/秒 的渐进推送（dz 经脉），静默窗
  > （最后一行后 2s）在慢推进下会**提前误结算**；声明 = 接管全部结算责任，交由声明方
  > timeout 兜底。未声明链静默窗语义不变（最后一行后 N 秒，逐行重置）。

各信号：

1. **声明边界 `until`**：规则 action / 工具参数声明期望边界（锚定整行正则，复用
   v6.5 感知匹配引擎；瞬态匹配器，只属于本应答对象）。长程命令完成句正则由抓包给出
   （如 dz：`站了起来` 亮绿句）。
   实施：`ActionSpec.until?: { regex; timeout? }`（trigger-llm/types.ts）→ T1 渲染为
   mud_send 参数（工具 schema/execute 均已接）→ 透传为 `ReplyOptions.until`（跨帧累积，
   文本命中即结算）。登录/长程规则声明**尚未配置**（见九-4）。
2. **GA/EOR**：telnet 层把 IAC GA（及 EOR，协议审查 R4）作为显式 boundary 事件抛出，
   Controller 据此结算。实施：telnet.ts `boundary` {kind:'ga'|'eor'} 事件（R4）+ 子协商
   上限 64KB（R2）+ MCCP2 出错关压/明文重放（R3）已一并排入并落地。
3. **静默窗（兜底，约 2s）**：两条链共用的悬挂防护；只在主边界未到时兜底结算，
   结算结果带"边界未命中"标记。实施：`DEFAULT_SILENCE_MS=2000`，**最后（被 consume 的）
   一行到达后 N 秒**，逐行重置；未声明链专用句号。静默结算文本追加 `[静默结算（边界未命中）]`，
   超时追加 `[应答超时，边界未命中，请决策]`——标记剥离函数 stripMarkers 保证不破坏注册表查找。
4. **超时 reject**：未声明默认 10s；已声明由声明方配套（如 dz 120s）。
   实施：默认 10s / 声明 120s，可逐请求覆盖（`ReplyOptions.timeout`）与全局覆盖
   （`MudAgentConfig.bridgeTimeoutMs/bridgeDeclaredTimeoutMs`）；**连续 3 次超时 → reject**
   （工具 throw → DSH 失败终态），任意非超时结算即复位（见机制 B.3）。

**帧规则**：

1. **帧内容** = 命令实际写入 socket（onSend）后至结算信号之间的**全部行，含提示符行**。
   原"prompt 行不进 buffer"条款**废除**——GA 在提示符文本之后到达，提示符天然属于帧；
   且 `login:pass` / `login:replace-confirm` / `save:prompt` 等规则以 prompt 行为触发
   输入，剔行会导致登录流程断链。任何结算路径都不丢行。实施：承受帧行 = `MudLine[]`
   原样累积（行号/style 保真）。
2. **统一行集表**：T1 匹配 multiline/color 需要 `MudLine[]`，而 tool result / user
   消息只携带文本——行集经**有界注册表**（text → 行集，上限 ~64，FIFO）按尾部消息
   文本回查。登记点收敛为两个结算点：**帧结算**登记（帧文本 → 本帧行集）、**观察窗
   结算**登记（消息文本 → 折叠后剩余行行集，观察路径的 multiline/color 匹配由此获得
   载体）。原 `gameLineRegistry` 的"发送前松散登记"废除，代之以精确登记时点与严格
   绑定的消费生命周期；miss → 按纯文本单行匹配降级。
   实施：Controller 内部 `store`（上限 64，FIFO，键 = 纯文本 trim）；`resolveLines`
   做 stripMarkers + 精确匹配 + 最长前缀/空白折叠容错。登记时点**进一步收紧**：
   帧/观察行的登记随 feedLines 当拍完成（feed 侧精确路由，见六与九-2），无独立注册表
   模块——旧 `gameLineRegistry` / `registerGameLines` / `clearGameLines` 已删除。
3. **归属**：默认**一步一帧**（模型每步最多一个在途 mud 命令），GA 按命令发送序结算
   （服务器串行处理，抓包实证）。声明边界互斥的对象可并行等待（准入条件见待定项）。
   实施：一步一帧强制（live 单一 + pending FIFO —— 声明对象亦未开放并行，见待定 4）。
4. **先注册后发送**（保留）：命令入队（注册）时创建应答对象与边界匹配器；实际写入
   socket 时置 armed（帧起点）。消除"触发器尚未生效"的间隙。实施：`sendAndAwait`
   注册 → pump 发送（宿主队列节流）→ `confirmSent` 置 armed。
5. **单条通道贯穿全部发送方**（保留）：agent 工具 / T1 / 登录 / WebUI 手动命令 /
   紧急 halt。halt 允许插队到队头，但仍占一帧。禁止任何旁路直发。
   实施：agent 工具与 T1 经 `controller.sendAndAwait` → `queue.send`（meta 透传）；
   WebUI 手动命令 → `controller.sendFireForget`（不入应答机制）或直发 `sendCommand`；
   halt 优先级已入 CommandQueue（QUEUE_PRIORITY），插队到队头。

**异常路径**：

- **断线**：reject 全部在途对象 → `turn/end(error)`。实施：`controller.close()`（在途 +
  排队全部 reject 'error'；队列停发；观察窗清空），connect/close/teardown 均接线。
- **abort**（`exec.signal`）：撤销对应对象，避免悬挂 promise 卡死 loop step；
  该命令迟到的 GA 到达时直接丢弃（无主 GA）。实施：`ReplyOptions.signal`，任意时点
  （注册/发送中/武装后）→ 优雅结算 'abort'，监听器单次挂载、settle 时移除。
- **紧急预占**：紧急行可提前结算当前帧（对象标记 settled-early）；该命令迟到的 GA
  丢弃，期间新行进观察窗。GA 方案下提前结算不破坏任何后续归属（无 FIFO 级联污染）。
  **【未实施】**（紧急规则集未定，见待定 6）。
- **超时**：见机制 B.3（错误 tool result 交下一步决策，不再直接回合级 error）。

## 三、机制 B：回合语义（何时结束 turn）【已确认】【已实施】

**原则**：回合结束**不由"应答到达"决定**——应答只推进 step。回合收不收取决于本步
agent 是否还产出工具调用。

**三种结束路径**：

1. **自然收束**：流程最后一步的应答成为 tool result → 下一步 agent 无新命令
   （T1 规则耗尽 / T2 主动 stop）→ 该步无 tool-call → `turn/end(completed)`。
   实施：T1 adapter `finish{stop}`（tool-tail resolveLines 无命中 / 文本未命中 /
   控制消息 → 收束）；T2 stop 由官方 loop 处理。
2. **工具显式收尾**：工具执行内调 `exec.concludeTurn()` → 回合在该工具执行完立即结束，
   不安排"观察最终结果"的收尾步。约定：流程终点动作（如 `world_patch` 置 `logged_in`）
   使用；**mud_send 永不用**（其应答需要下一步规则/模型处理）。**终点步禁止与 mud
   命令并行渲染**——concludeTurn 与在途帧 await 的交错属 loop 内部细节，不依赖。
   **【未实施】**：无规则 action 声明终点标记；`exec` 通道（concludeTurn/signal）尚未
   传入工具执行层（见九-6）。当前终点 = 自然收束兜底。
3. **失败收束**：**断线** → 无可恢复动作 → `turn/end(error)`。**单次应答超时不再直接
   回合级 error**（修订）：超时以错误文本 tool result 交本回合所有者决策（T1 规则可
   反射重试 / T2 自主处置），连续超时才升级 error 收束——单条命令无应答 ≠ 服务器
   挂了（战斗延迟、慢房间加载都会触发）。超时 tool result 以**成功结果携带错误文本**
   返回（非 throw——throw 走 DSH 工具失败终态，绕过"交下一步决策"）；连续超时按
   **回合**计数，N 默认 3（见待定 2）。
   实施：超时 → `resolve({ ok:false, text: 帧文本+超时标记 })`（非 reject）；连续 3 次
   → `reject`（工具 throw → DSH 失败终态）；任意非超时结算复位计数。计数器跨请求
   递增，非回合级（按对象序）——与"按回合计数"的差异见九-7。

**回合粒度策略**（不变）：

- **单回合多 step**：流程中只隔"等服务器回包"的连续决策段（登录、单次解密尝试、
  move+observe）。
- **长程流程**（练功、完整解密、持续探索）：**目标驱动多回合**——每回合做一件有检查点
  的事，回合间由驱动层（goal / 控制消息 / 断流后果观察 / commandIntervalMs）推进。
  理由：回合无内建 step 上限、单回合越长折叠窗口越挤、回合边界 = 学习切分 + 失败隔离 +
  上下文 checkpoint。
- `agent/turn-stopping` 是回合将关时的官方续步钩子（mud-core 可在此表达"还有积压未处理"），
  不手工制造续步。

## 四、机制 C：观察路径、判类与 T1/T2 路由【已确认】【已实施】

**输入三源**：在途应答（→ 机制 A 帧）｜空闲杂散行（→ 观察窗）｜控制唤醒（现有
`[系统]` 前缀通道）。

1. **杂散观察窗**：无在途命令时行累积，按（静默窗口 | 空闲 prompt | 上限）结算成一条
   user 消息开回合；纯噪音行不开回合（进 recall 缓冲，不打扰 agent）。噪音必须
   白名单命中才静默，未命中即默认 T2 回合（漏判 = 静默丢输入，不许"猜噪音"）。
   实施（部分）：观察窗 = `observeBuf`，结算点 = 无主 GA/EOR 边界（即时）+ 2s 静默
   兜底（`bridgeSilenceMs`）→ 判类注入（带所有权元数据的单条 user 消息开回合）。
   **噪音白名单未实施**（待定 10）：全部无主行默认开回合（T1/T2 判类），不静默——
   与"漏判 = 静默丢输入"的保守原则一致，只是把"白名单命中才静默"推迟。
2. **判类（观察窗进入回合前）**：反射类规则命中 → **T1 回合**；需推理 / 显式唤醒 →
   **T2 回合**；噪音 → 不开回合。判定在输入侧（feed），不等待错误路径。
   实施：`judgeAndInject`——state 折叠后剩余行喂 `eventMatchService`，`action` 命中 →
   lane=t1 反射注入，其余 → lane=t2 推理注入；控制唤醒（requestAgent）固定 lane=t2。
3. **回合内所有权稳定**：续步（tool result）归本回合所有者。T1 回合答到规则耗尽自然收束，
   **回合内不自动转 T2**；T2 回合一路续答。**所有权随注入消息的元数据走**（feed 判类时
   挂在消息 source 上；request 监听器**回扫最近一条带所有权元数据的 user 消息——跳过
   tool-result**——选 provider，续步的尾部消息本身是 tool result，元数据在其前的注入
   消息上）——不维护"回合注册表"（feed 时 turn id 尚不存在，next-turn 排队混合类别时
   映射不可靠）。source 元数据若不随会话持久化，resume 后首轮请求缺元数据 → 回退默认
   T1——与"新回合重新给 T1 机会"语义自洽，为有意回退。
   实施：`MessageSourceMap` 增补 `'mud-owned' { kind; lane:'t1'|'t2' }`
   （merge-extensible 机制，dsh-llm 主入口 `export *` 已确认）；`ownedGameMessage`/
   `sendOwnedOutput`；bridge `agent/request` 监听器经 `ctx.get('sessions').surface.nodes`
   + `eventAt` + `deriveEventMessage` 回扫最近一条 mud-owned user 消息选 provider
   （T2 未配置降级 T1 并日志）。resume 首轮缺元数据 → 默认 T1 ✓（有意回退语义保留）。
4. **升级不自动**：T1 死局由**后果观察**兜底（登录超时 / 断流 / `logged_in` 未置位 /
   卡住检测）→ 控制消息唤醒 T2。T2 接手时能看到此前全部 T1 step 历史（接管 + 学习）。
   实施：断流 30s 死空气 → requestAgent 控制消息（lane=t2）唤醒。**登录超时/卡住检测
   未接线**（登录重建后进行，见九-4）。
5. **学习路径**：流程以 step 序列活在历史里。学习期长程流程由 T2 多回合跑（历史完整可学）；
   跑顺后把可重复子流程固化为 T1 规则 → 子流程内部变成回合内多步。**规则是把学到的流程
   固化的渐进机制，不是流程的替代品**。实施：机制不变（T1 规则即固化载体）。
6. **删除项**：T1 未命中的 error / NO_ANSWER / request-error retry 路径、`t1FailedKeys`
   回合 sticky、`gameLineRegistry` 的**松散内容寻址**（由统一行集表替代，登记点收敛为
   帧结算 / 观察窗结算两点，见机制 A 帧规则 2）。实施：全部删除（adapter 收束改为
   `finish{stop}`；bridge 删瀑布监听器与注册表；`T1_NO_ANSWER_CODE` 常量为历史命名，
   已随响应路径一并清理——文件内无残留引用）。
7. **判类与 T1 渲染不双跑**（修订）：feed 侧判类只做分类（匹配结果即丢弃），动作渲染
   一律由回合内 T1 对同一批行执行，避免同一命中触发两次动作。
   实施：feed 判类 `eventMatchService.match` 结果只取 hasAction 布尔；动作渲染在回合内
   adapter（对 resolveLines 还原的行集）执行——同一批行不双跑。

## 五、在途杂散行策略【v1 决策，实录后复核】【已实施（除紧急预占）】

1. **并入当前帧**：在途命令等待期间到达的杂散行（频道 / 系统 / 他人行为）直接并入当前帧，
   不分段、无标记。依据：MUD 文本自解释；v6.5 锚定整行准入防规则误触发；T2 读连续局面
   优于碎片。
   实施：**交叉窗口归属**（六）——武装前（sending）到达的杂散行经 `controller.feedLines`
   的无主分支转 onObservation → host `headBuf`，`confirmSent(replyId, head)` 时并入帧首；
   武装后到达的杂散行直接进 armed 帧累积。帧首并入先行者，时序保真。
2. **紧急预占**：死亡 / 战斗 / 受击等紧急行（常开轻量匹配器，规则集见文末待定项）→
   **立即截断结算当前帧**（settled-early，该命令迟到 GA 丢弃）→ 当前 step 立刻反应，
   不等到命令自己的结算信号。**【未实施】**（紧急规则集未定，见待定 6；当前紧急行
   并入帧/观察窗照常流动，不提前截断）。
3. **感知不退化（修订）**：行到达的三件事——state 提取 / recall 缓冲 / 应答累积——全部
   在**原始行流**上执行，互不依赖折叠；"折叠移除"只发生在观察窗→agent 的文本路径
   （见六）。
   实施：feedParsed 在原始行上 recall + state extract/applyPatch；`controller.feedLines`
   接**原始行**（armed 帧累积原行；边界匹配看原文）；折叠后剩余行仅用于观察窗注入。

## 六、管线接入与折叠分界【已确认·2026-09-10 新增】【已实施】

**接入点**：Controller（`network/response.ts`）直连 telnet 层的
**parsed + boundary 原始流**（`client.on('parsed')` + 新增 boundary 事件），
**不经过 feedParsed 的折叠过滤**。现状 `feedParsed`（index.ts）在 state 折叠后才把
剩余行喂下游——帧累积与边界匹配若接在其后，凡目标行恰好是 state 折叠行的声明边界
（如等 `hp` 输出的 `气血` 行）将永远看不到该行，帧挂到兜底。
实施：`feedParsed` 借道 `controller.feedLines(raw, foldedRemains)`——**原始行与折叠
剩余行双通道一次喂入**（见下方"折叠分界"表与响应表中的两行流）；telnet `boundary`
事件 → `controller.boundaryReceived`。

**折叠分界（三路径两种流）**：

| 消费者 | 取哪条流 | 理由 | 实施 |
|---|---|---|---|
| 边界匹配器（瞬态，属应答对象） | 原始行（折叠过滤之前） | 目标行可能是 state 折叠行 | `feedLines` 第一参（原始行）；until 对帧文本匹配 |
| 帧内容 → tool result（在途命令的应答） | 原始行（不折叠） | 工具调用主动索取的应答，折叠 = 返回值缺数据 | armed 分支累积原始行 |
| 观察窗 → 开回合的 user 消息（空闲杂散行） | 折叠后的剩余行（照旧） | 无人索取的杂散内容，状态已进 world，不吵 agent | `feedLines` 第二参 `foldedRemains`；无主分支据此登记 + 转发 onObservation |

- state 规则的 extract/applyPatch（落库 world）在原始流上照常执行，与折叠无关——
  "折叠"只决定该行文本是否从给 agent 的观察窗内容中移除，world 同步不受影响。
- hp 例子：`hp` 命令在途 → "气血 100/100" 行到达 → 边界匹配器在原始流命中 → 帧结算；
  该行同时被 state 规则 extract 进 world；tool result 里**有**这行（下一步规则可用），
  world 里也有数值。同一行若空闲时被动到达，则观察窗折叠（agent 看不到文本，world 已入库）。
- **交叉窗口归属（第四种情形）**：一步内前帧已结算、下一命令尚未 armed 之间到达的
  杂散行落观察窗缓冲；**新帧 armed 时，观察窗未结算缓冲并入帧首**——保时序：agent
  不得先见命令应答、后见应答之前发生的杂散内容（MUD 文本自解释，时序保真优先）。
  实施：sending（未武装）期间到达 → host `headBuf` → `confirmSent(replyId, head)` 并入
  帧首（本帧应答文本包含它们，时序保真）。**观察窗缓冲与帧首集互斥**：inFlight() 期间
  onObservation 只进 headBuf（不判类注入）——防"帧首合并 + 观察注入"双重消费。
- telnet 层改造：GA/EOR 作为显式 boundary 事件抛出（AnsiStreamParser 的 GA 刷出逻辑
  保留，但 Controller 依赖的是显式事件而非从批边界推断）；协议加固 R2（子协商上限）/
  R3（MCCP2 出错关压+明文重放）为感知完整性前置，随本机制一并排期。

  实施：telnet.ts 已出 `boundary` {kind:'ga'|'eor'} 显式事件（R4）+ 子协商长度上限 64KB
  （R2）+ MCCP2 出错的明文重放（R3），均带单测。

## 七、改动面预览（实施蓝图）【V1 已实施，除标注】

| 模块 | 改动 | 状态 |
|---|---|---|
| 新增 `network/response.ts` | `CommandResponseController`：应答对象生命周期（注册→armed→结算）、分层结算（until/GA/静默/超时）、无主 GA 丢弃、断线/abort 清理；`stripMarkers`/`resolveLines`/`sendFireForget`/`inFlight`/`stats` | ✅ 已实施（489 行 + 18 单测） |
| `network/telnet.ts` | GA/EOR 显式 boundary 事件（R4）；子协商长度上限（R2）；MCCP2 出错关压 + 明文重放（R3） | ✅ 已实施（+4 单测） |
| `index.ts` feed 路由 | Controller 直连 parsed + boundary 原始流（六）；观察窗（静默/空闲 prompt/上限结算，折叠路径）；后果观察升级点（登录超时/卡住）接线 | 🟡 部分（直连+观察窗+死空气已实施；**登录超时/卡住检测未接线**，见九-4） |
| `agent/tools.ts` | `execute` 异步化：`send(cmd): void` → `await sendAndAwait(cmd, { until?, timeout? }): Promise<MudReply>`；mud_send/mud_move/mud_look 走同一桥；world_patch 等本地工具不 await；output/render 改返回应答文本 | ✅ 已实施（sendAndAwait 存在时异步；缺省同步旧路径兼容测试） |
| `agent/execution.ts` | CommandQueue 角色调整：节流 → FIFO 发送序 + armed 时机 + halt 插队 | ✅ 已实施（+`replyId` 透传） |
| `trigger-llm/types.ts` | `ActionSpec.until?: { regex; timeout? }` 可选字段 | ✅ 已实施 |
| `trigger-llm/adapter.ts` | tool-tail 不再"安静收束"：tool result 文本 + 应答行集作为可匹配输入；无规则命中才 finish stop；删除 NO_ANSWER/error 输出 | ✅ 已实施（resolveLines 续步判定；`finish{stop}` 收束；NO_ANSWER 全删） |
| `agent/agent-bridge.ts` | 删 request-error/request 失败转 T2 瀑布、`t1FailedKeys` sticky、`gameLineRegistry`（→ 统一行集表，登记点收敛，见机制 A 帧规则 2）；回合所有权随注入消息元数据走，request 监听器回扫带元数据的 user 消息选 provider；defineTool 包装层把 `exec`（含 `exec.signal`）传入工具执行 | 🟡 部分（瀑布/注册表已删、所有权路由已实施——`MessageSourceMap['mud-owned']` 增补 + surface 回扫；**`exec` 通道未传入**，见九-6） |

## 八、待定 / 需实录确认（未定稿；V1 实施后状态见右）

1. **Phase 0 实录（大部分已由三轮抓包完成，2026-09-10）**：GA 边界实证已取得（机制 A
   抓包依据）；剩余：长时段录制统计杂散行频率与构成；校准观察窗 idle prompt 形态
   （仅作 idle 结算加速提示，非机制依赖）。→ **还差长时段录制统计**（连实录会话补；
   噪音白名单条目亦依赖此统计，见九-后续任务）。
2. **超时/静默窗时长**：初值已定并**实现**（GA 命令超时 10s、静默窗 2s、声明方配套
   长程 timeout；`MudAgentConfig.bridgeTimeoutMs/bridgeDeclaredTimeoutMs/bridgeSilenceMs`
   可覆盖）；与 `loginTimeoutMs` 的关系待理（登录重建时一并对齐）；连续超时升级阈值
   N=3 已实现——**按对象序计数**，与"按回合计数"的差异见九-7。
3. **空收尾步**：自然收束可能产生一条空 assistant/message——实测 DSH 准入是否吞空消息；
   不可接受时用 concludeTurn 规避（大多数 T1 流程不需要模型回看结尾）。（帧内提示符行使
   tool result 恒非空，原"空帧"担忧消失。）→ **未实测**（待连接实录）。
4. **并行 mud 命令**：收窄为"声明边界互斥的对象可并行"；准入条件（边界互斥判定）与是否
   对 T2 开放（如 east+look 合并），实录后按命令吞吐决定。→ **未实施**（V1 一步一帧强制，
   含声明对象——保守起步，实录后按吞吐放宽）。
5. **单回合连续命令步数上限**：与 DSH `guard`（loop-hygiene / tool-timeout）插件的覆盖
   边界，是否需要 mud-core 侧补充护栏。→ **未实测**（需上游 guard 配置信息）。
6. **紧急预占规则集**：哪些规则算"紧急"（死亡 / 战斗 / 受击 / 断线提示）。→ **未实施**
   （机制五-2 紧急预占尚未落地；settled-early 结算 + 迟到 GA 丢弃的分支在 Controller
   内尚无）。当前紧急行并入帧/观察窗照常流动。
7. **流程终点工具的 concludeTurn 约定**：规则 action 如何表达"这步是终点"
   （如 world_patch 是否带 conclude 标记）。→ **未实施**（exec 通道未传入工具层，九-6）。
8. **长程命令 `until` 规则集**：dz（`站了起来` 亮绿完成句）/ sleep（醒来句）等首批声明；
   完成正则已由抓包给出，规则化待写。→ **未配置**（ActionSpec.until 与 mud_send
   schema/execute 已就绪，管线通；规则声明与登录重建一并落地，九-4）。
9. **分页下沉**：`== 未完继续` 维持 `pager:continue` 规则在 step 链内逐页推进（每页一步
   约一次节流间隔），是否下沉到桥层短路（一帧内自动翻页），实录后按延迟表现定。→
   **未实施**（规则在 step 链内推进需登录/规则重建后接入）。
10. **噪音白名单**：C.1 "白名单命中才静默"的初始条目与维护方——初期仅收纯客户端/协议
    噪音行；公频聊天等有效输入默认仍开 T2 回合，不入白名单。→ **未实施**（V1 全部无主行
    默认判类开回合——与"漏判 = 静默丢输入"的保守原则一致；白名单命中静默作为优化后补，
    需实录统计杂散行构成后定条目）。

## 九、实施记录（2026-09-10 晚间，V1）

**实施范围**：机制 A/B/C 主体、机制五-1/-3、机制六（折叠分界）全部落地；
机制 B-2（concludeTurn）、机制五-2（紧急预占）、待定 4/6/7/8/9/10 未实施（见上）。

**交付物**（回归：`pnpm build` tsc 0；vitest 12 文件 148 用例全绿）：

| 文件 | 关键改动 |
|---|---|
| `network/response.ts`（新增） | `CommandResponseController`：注册→sending→armed→settled 生命周期；分层结算（until 跨帧 / GA/EOR 主边界 / 静默窗 / 超时最兜底）；一步一帧（live 单一 + pending FIFO）；连续 3 超时 reject；断线 reject / abort 优雅结算；统一行集表（64，FIFO）+ `stripMarkers` + `resolveLines`（精确/前缀/空白折叠容错）；`feedLines(raw, foldedRemains)` 双通道折叠分界；`confirmSent(replyId, head)` 帧首并入；`inFlight`/`sendFireForget`/`stats`/`close`/`clear` |
| `network/telnet.ts` | GA/EOR `boundary` 显式事件（R4）；子协商上限 64KB（R2）；MCCP2 出错关压+明文重放（R3） |
| `agent/tools.ts` | `buildMudTools` 增 `sendAndAwait`；`MudTool.execute → MudToolResult \| Promise`；move/look/status/send 异步（note=应答文本）；send 支持 `until` 参数；缺省同步路径兼容旧测试 |
| `agent/execution.ts` | `CommandMeta.replyId`（队列只透传；onSend 时宿主 confirmSent） |
| `trigger-llm/types.ts` | `ActionSpec.until?: { regex; timeout? }` |
| `trigger-llm/adapter.ts` | tool-tail → `resolveLines` 续步判定（命中渲染 / 未命中 stop）；文本 miss / 控制消息 / 无注册行 → `finish{stop}`；NO_ANSWER/error 输出全删 |
| `agent/agent-bridge.ts` | 删 `gameLineRegistry`/`registerGameLines`/`clearGameLines`、瀑布 + `t1FailedKeys`；`MessageSourceMap['mud-owned']` 增补（`declare module '@deepseek-ai/dsh-llm'`）；`ownedGameMessage`/`sendOwnedOutput(handle, text, lane)`；`agent/request` 回扫 `ctx.sessions.get(id).surface.nodes` + `eventAt` + `deriveEventMessage` 最近一条 mud-owned user 消息选 provider（T2 未配置降级 T1 + 日志）；`registerTriggerProvider` 增 `resolveLines` 选项 |
| `index.ts` | `CommandResponseController` 接线：`send→queue.send(meta)`、`onSend→sendCommand 成功后 confirmSent(replyId, headBuf)`；`sendAndAwait→tools`；feedParsed 折叠分界双通道喂 `controller.feedLines`；观察窗 `observeBuf`（无主边界即时 + 2s 静默结算）→ `judgeAndInject`（event 规则命中 lane=t1 反射注入 / 其余 lane=t2）；inFlight() 期间 onObservation 只进 `headBuf`（防双重消费）；控制唤醒 lane=t2；connect/close/teardown 的 `controller.clear()/close()` + `queue.clear()` + 缓冲清理；新增配置 `bridgeTimeoutMs/bridgeDeclaredTimeoutMs/bridgeSilenceMs`；**登录看门狗**（`loginTimeoutMs` 缺省 90s，登录期无推进 → T2 升级封顶 3，connect 重置登录态/布防，close/teardown 清理） |
| `config/trigger-rules.ts`（登录段） | **登录命令回归 GA 主边界**（删全部 until 声明——声明链对 GA 只测不结算致意外文本锁帧等超时）；新增 `LOGIN_BOUNDARIES` 阶段边界表（entry 入口 / pass+replace 推进 / terminal 终态 / error 错误，单一事实来源，规则 match 复用）；`login:pass` 双形态（`^(?:ID已存在，)?请输入密码`）修复卡死；`login:done` 锚点改真实完成信号 `目前权限：(player)`；`login:replace-confirm` 多形态修复（行首 已有同名/覆盖/替换/已被占用 + 全角/半角 y/n 括号）；新增 `login:error` 估计规则 → `flags.login_fault` |
| `tests/login-rules.spec.ts`（新增） | 登录规则链 9 用例：无 until 断言 / 边界表复用一致性 / 双形态密码提示 / 完成信号锚点 / 横幅反向 / 替换确认多形态 / error 估计形态 |

**实施偏差与决策**（相对本文件设计文本）：

1. **声明链禁用静默窗**（机制 A）：已声明请求不挂静默窗——长程命令渐进推送（1 条/秒）
   会让静默窗提前误结算；声明 = 接管全部结算责任，交由声明方 timeout 兜底
   （response.ts `armTimers`）。未声明链静默窗语义不变。
2. **折叠分界落地方式**（机制六）：`feedLines(lines, foldedRemains?)` 一次喂入双通道——
   armed 分支取原始行（帧内容/边界匹配），无主分支按折叠剩余行登记 + 转发观察窗；
   与"Controller 直连原始流"等价，且天然保住"hp 的 气血 行在原始流上可命中 until"。
3. **所有权路由**：`MessageSourceMap`（dsh-llm）为 merge-extensible 联合，`declare module`
   增补 `'mud-owned'` kind 即可——注入消息 source.lane 随会话事件持久化，resume 后
   scan 理论可用；首轮缺元数据 → 默认 T1（有意回退语义）。
4. **T1 收束语义**：无命中 / 控制消息 / 无注册行一律 `finish{stop}`（非 error）——不再
   "交棒"；路由责任整体前移到 feed 判类（输入侧），T2 兜底由"该批输出判为 t2"承担，
   而非失败升级。T1 死局（无输出、死循环）由断流唤醒（lane=t2）兜底。
5. **观察窗互斥**：inFlight() 期间无主行只进帧首集（headBuf），不判类注入——防同一批
   文本"帧首合并 + 观察注入"双重消费；观察缓冲结算点 = 无主边界（即时）+ 2s 静默兜底。
6. **exec 通道未传入**：`defineTool` 包装层尚未透传 `exec`（concludeTurn / signal）。
   abort 由 `ReplyOptions.signal` 承担（sendAndAwait 优雅结算 'abort'）——机制 B-2
   concludeTurn 与"终点动作"约定随登录重建一并落地。
7. **连续超时按对象序计数**：控制器计数器跨请求递增（非按回合）。回合边界在工具已
   reject（回合 error 终态）后由 loop 重置——与"按回合计数 N=3"的差异：一次回合内如果
   恰好跨多个对象的连续超时，行为等价；跨回合的连续超时（上个回合 reject 后新回合
   又超时）会继续累计。实录后如需按回合精确计数再调整。
8. **`textOfLines` 纯文本焦距**：帧/观察文本均以 32-bit 折叠文本入注册表；T1 multiline/
   color 匹配经 resolveLines 还原的行对象——行号/style 保真（原始行保留于 store 值）。

**V1 已实施 / 登录流程重建（2026-09-10 补充）**：

- **登录流程重建已完成**（机制 C-4 登录侧 + 续步链落地）：
  - **登录命令回归 GA 主边界**（关键决策）：`login:name` / `login:pass` /
    `login:replace-confirm` **不声明 until**。原因：声明链在 GA 到达时"只测 until、
    未命中丢弃边界继续累积"（response.ts `boundaryReceived`）——登录命令的真实下一步
    信号形态多样（替换确认/密码错误等意外分支不在单一声明里），声明会锁帧硬挂到
    timeout（45s），且期间 inFlight 文本尽入帧首集、观察注入被吞。回归 GA 后：命令
    回显完整入帧，GA 结算帧内容作 tool result，续步判定自然承接任何下一步信号；
    各步在正向信号下收束、turn 在 login:done 后自然 stop——"推进文本保留"由三层
    保证（行集表 record / tool result text+lines / feedRaw 终端总线）。
  - 新增 **`LOGIN_BOUNDARIES`** 阶段边界表（entry 入口 / pass+replace 推进 / terminal
    终态 / error 错误）：登录"推进信号"单一事实来源，规则 match 复用——三段式语义
    在规则层成文，不进入应答桥机制。
  - `login:pass` 修复抓包实证的前缀形态 **"ID已存在，请输入密码："**（旧 `^请输入密码`
    锚定漏匹配 → 密码永不发）；`login:done` 锚点修正为真实完成信号 **"目前权限：(player)"**
    （旧 `欢迎来到北大侠客行` 是**登录前**横幅，抓包中不出现；GMCP.System 已权威兜底
    logged_in）；`login:replace-confirm` 多形态修复（行首 已有同名/覆盖/替换/已被占用 +
    全角/半角 y/n 括号）；新增 `login:error` 估计规则 → `flags.login_fault`。
  - `index.ts` 登录看门狗：登录期（logged_in=false）无推进超过 `loginTimeoutMs`
    （缺省 90s）→ 控制消息（lane=t2）升级 T2 决策，封顶 3 次；文本到达即重置；
    `connect` 事件直接复位登录态（绕过置信度护栏，否则旧连接的 GMCP 1.0 会压制
    `logged_in` 复位）+ 布防看门狗；close/teardown 清理。
  - 新增 `tests/login-rules.spec.ts`（9 用例）：无 until 断言 / 边界表复用一致性 /
    双形态密码提示 / 目前权限锚点 / 横幅反向 / 替换确认多形态 / error 估计形态。
    回归：vitest 12 文件 148 用例全绿。
  - 待实录（已标注于规则注释）：替换确认 / 密码错误 / fullme 的精确文本 → 依实录
    校正 `LOGIN_BOUNDARIES.replace/error` 与 `p:login:error` 行为。
  - 与偏差#1 的关系澄清：**声明链禁用静默窗/GA 降级语义仅服务于长程命令**（dz / sleep
    等需要"渐进推送不被 GA 打断"）；登录段属短回显命令，回归 GA 默认路径（偏差#1 的
    未声明分支），两者不冲突。

**V1 未实施 / 后续任务（新）**：

- ~~登录流程重建~~（已完成，见上）。剩余登录侧：fullme 验证码提示检测规则（需实录
  fullme 提示实样后接线 captcha 卡片/robot.php 刷新链路）。
- `exec` 通道（concludeTurn / exec.signal）传入工具执行层；world_patch 终点动作
  conclude 约定（待定 7）。
- 长程命令 `until` 规则集（dz / sleep 等首批，待定 8）。
- 噪音白名单（待定 10）、紧急预占（待定 6）、分页下沉评估（待定 9）。
- 实录调优：超时/静默窗初值、并行 mud 命令开放、空收尾步实测、步数上限护栏（待定
  2/3/4/5）与 DSH guard 覆盖边界核对。
