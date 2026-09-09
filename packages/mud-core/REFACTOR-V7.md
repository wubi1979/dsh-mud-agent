# mud-core V7 设计记录 —— 命令-应答桥与输入路由

> 状态：**设计定稿（尚未实施）**。来源：Design-1（T1/T2 与感知/agent 交互架构）架构
> 审查会话结论；Design-2（v6.7 准入语义修正）已另行实施，见 REFACTOR-V6.md 二点七。
>
> 本文只记录讨论中**明确确认**的内容；仍开放、需实录/实现时再定的事项统一列在文末
> "待定 / 需实录确认"，不视为已定稿。

## 一、历史演进与结论（为什么是现在这个形态）

**沿革**：最初只打算在真实 LLM 前做快速拦截（已知答案 / 需快速应答，如战斗）→ 拦截
直连执行导致会话里出现非 loop 产物、伪输出缺 loop 凭据，真实 agent 无法从历史学习 →
演化为"模拟 LLM（T1）"进入 loop 以获取合法历史 → 演化为瀑布（error/retry 路由）。

**结论（已确认）**：

1. 会话历史必须由 agent loop 生成才合法（turn/step 计数、事件信封、seq、surface fold、
   projection 均归 loop 所有）。**不做**"loop 外执行 + 手工伪历史"——任何旁路执行都无法
   产出可被真实 agent 读取的历史。
2. "在进入真实 LLM 前解决已知问题 + agent 能看懂日志"的唯一交集解 =
   **判定前移（输入侧判类）+ 执行留 loop（以 T1 模拟 LLM 身份执行）**。
3. T1/T2 的"安排"不是核心问题；核心是上一条 + **命令-应答同步化**（机制 A）。

## 二、机制 A：命令-应答桥（FIFO prompt 分帧）【已确认】

**动机/问题**：旧实现 mud 工具"发完即回"，服务器应答异步到达后被 push 成新外部输入 →
每个应答 = 新回合 → 登录等连续提示流程被拆成 N 个微型回合、爆发输出（look 房间）被拆成
N 个回合，成本与历史噪音双高。拆 turn 的根因是"命令→应答"未被配对成同步工具调用语义，
不是流程天然该拆成回合。

**语义**：mud 工具调用 = **挂起等待真实应答**；应答成为该工具调用的 tool result，由 loop
作为下一步输入 → 流程在**一个回合内以 step 链**推进。

**分帧规则**：

1. **prompt = 通用帧结束符**，无需识别"是哪个命令的 prompt"。合法命令必以 prompt 收尾；
   中间态 prompt（如"同名覆盖(y/n)"）同样结帧。
2. **FIFO 归属**：帧按命令发送顺序结算——第 N 个 prompt 结算第 N 个在途命令。归属靠
   **顺序不靠时机** → 网络抖动/命令积压无害（帧变长，顺序不变）。
3. **应答对象生命周期**：命令入队（注册）时创建应答对象（先注册后发送，消除"触发器尚未
   生效"的间隙）；实际写入 socket（onSend）时置 armed（帧起点）；其后的**非 prompt 行**
   累积进该对象 buffer；下一个 prompt 到达 → 结算该对象。
4. **帧内容** = 命令发出后到下一 prompt 之间的非 prompt 行；prompt 行不进 buffer。
5. **服务器不回显命令文本**（pkuxkx 已确认）→ 帧首无需 echo 剔除；客户端自写回显
   （`name@agent>cmd`）在终端缓冲，不进流。
6. **单条 FIFO 贯穿全部发送方**：agent 工具 / T1 / 登录 / WebUI 手动命令 / 紧急 halt。
   halt 允许插队到 FIFO 头部，但仍占一帧。禁止任何旁路直发。
7. **超时 / 断线 / abort**：每个应答对象自带超时（时长待定，见文末）；断线 reject 全部
   在途对象；`exec.signal` abort 撤销对应对象，避免悬挂 promise 卡死 loop step。
8. **并发**：同一步多个 mud 命令（DSH 并行 tool-call）= 多个应答对象按 FIFO 并行等待，
   结果按 tool-call id 各自配对。默认**一步一帧**（模型每步最多一个在途 mud 命令），
   并行能力保留（是否对 T2 开放见文末待定项）。

## 三、机制 B：回合语义（何时结束 turn）【已确认】

**原则**：回合结束**不由"应答到达"决定**——应答只推进 step。回合收不收取决于本步
agent 是否还产出工具调用。

**三种结束路径**：

1. **自然收束**：流程最后一步的应答成为 tool result → 下一步 agent 无新命令
   （T1 规则耗尽 / T2 主动 stop）→ 该步无 tool-call → `turn/end(completed)`。
2. **工具显式收尾**：工具执行内调 `exec.concludeTurn()` → 回合在该工具执行完立即结束，
   不安排"观察最终结果"的收尾步。约定：流程终点动作（如 `world_patch` 置 `logged_in`）
   使用；**mud_send 永不用**（其应答需要下一步规则/模型处理）。
3. **失败收束**：应答超时 / 断线 → 无可恢复动作 → `turn/end(error)`（服务器挂了等不到
   = 失败结束，符合预期）。

**回合粒度策略**：

- **单回合多 step**：流程中只隔"等服务器回包"的连续决策段（登录、单次解密尝试、
  move+observe）。
- **长程流程**（练功、完整解密、持续探索）：**目标驱动多回合**——每回合做一件有检查点
  的事，回合间由驱动层（goal / 控制消息 / 断流后果观察 / commandIntervalMs）推进。
  理由：回合无内建 step 上限、单回合越长折叠窗口越挤、回合边界 = 学习切分 + 失败隔离 +
  上下文 checkpoint。
- `agent/turn-stopping` 是回合将关时的官方续步钩子（mud-core 可在此表达"还有积压未处理"），
  不手工制造续步。

## 四、机制 C：观察路径、判类与 T1/T2 路由【已确认】

**输入三源**：在途应答（→ 机制 A 帧）｜空闲杂散行（→ 观察窗）｜控制唤醒（现有
`[系统]` 前缀通道）。

1. **杂散观察窗**：无在途命令时行累积，按（静默窗口 | 空闲 prompt | 上限）结算成一条
   user 消息开回合；纯噪音行不开回合（进 recall 缓冲，不打扰 agent）。
2. **判类（观察窗进入回合前）**：反射类规则命中 → **T1 回合**；需推理 / 显式唤醒 →
   **T2 回合**；噪音 → 不开回合。判定在输入侧（feed），不等待错误路径。
3. **回合内所有权稳定**：续步（tool result）归本回合所有者。T1 回合答到规则耗尽自然收束，
   **回合内不自动转 T2**；T2 回合一路续答。
4. **升级不自动**：T1 死局由**后果观察**兜底（登录超时 / 断流 / `logged_in` 未置位 /
   卡住检测）→ 控制消息唤醒 T2。T2 接手时能看到此前全部 T1 step 历史（接管 + 学习）。
5. **学习路径**：流程以 step 序列活在历史里。学习期长程流程由 T2 多回合跑（历史完整可学）；
   跑顺后把可重复子流程固化为 T1 规则 → 子流程内部变成回合内多步。**规则是把学到的流程
   固化的渐进机制，不是流程的替代品**。
6. **删除项**：T1 未命中的 error / NO_ANSWER / request-error retry 路径、`t1FailedKeys`
   回合 sticky、行注册表 `gameLineRegistry`（应答与观察文本直接来自消息内容，不再需要
   内容寻址）。

## 五、在途杂散行策略【v1 决策，实录后复核】

1. **并入当前帧**：在途命令等待期间到达的杂散行（频道 / 系统 / 他人行为）直接并入当前帧，
   不分段、无标记。依据：MUD 文本自解释；v6.5 锚定整行准入防规则误触发；T2 读连续局面
   优于碎片。
2. **紧急预占**：死亡 / 战斗 / 受击等紧急行（常开轻量匹配器，规则集见文末待定项）→
   **立即截断结算当前帧** → 当前 step 立刻反应，不等到命令自己的 prompt。
3. **感知不退化**：帧累积的同时，state 折叠与 recall 缓冲照常执行（行到达的三件事合一：
   state 折叠 / recall / 应答累积）。

## 六、改动面预览（实施蓝图，未实施）

| 模块 | 改动 |
|---|---|
| 新增 `network/response.ts` | `CommandResponseController`：FIFO + 应答对象生命周期、armed/结算、prompt 判定、紧急预占、超时/断线/abort 清理 |
| `network/telnet.ts` / `index.ts` feed 路由 | parsed 行改喂 Controller：AWAITING → 帧累积；IDLE → 观察窗；紧急行预占 |
| `agent/tools.ts` | `send(cmd): void` → `sendAndAwait(cmd): Promise<MudReply>`；mud_send/mud_move/mud_look 走同一桥；world_patch 等本地工具不 await；output/render 改返回应答文本 |
| `agent/execution.ts` | CommandQueue 角色调整：节流 → FIFO 发送序 + armed 时机 + halt 插队（并行保护见待定项） |
| `trigger-llm/adapter.ts` | tool-tail 不再"安静收束"：tool result 文本作为可匹配输入；无规则命中才 finish stop；删除 NO_ANSWER/error 输出 |
| `agent/agent-bridge.ts` | 删 request-error/request 失败转 T2 瀑布、`t1FailedKeys` sticky、`gameLineRegistry`；回合所有权路由由观察窗判类 + request 监听器按所有权选 provider |
| `index.ts` | 杂散观察窗（静默/空闲 prompt/上限结算）；后果观察升级点（登录超时/卡住）接线 |

## 七、待定 / 需实录确认（未定稿）

1. **Phase 0 实录**（实施第一步）：连真实 pkuxkx 录制"命令 → 应答 → prompt"原始行序列；
   确认 prompt 形态并校准 `isPrompt` 判定；确认空闲态是否刷 prompt（决定观察窗结算信号）；
   统计杂散行频率与构成。
2. **应答超时时长**：默认值 + 与 `loginTimeoutMs` 的关系。
3. **空收尾步**：自然收束可能产生一条空 assistant/message——实测 DSH 准入是否吞空消息；
   不可接受时用 concludeTurn 规避（大多数 T1 流程不需要模型回看结尾）。
4. **并行 mud_send**：是否对 T2 开放（如 east+look 合并），实录后按命令吞吐决定。
5. **单回合连续命令步数上限**：与 DSH `guard`（loop-hygiene / tool-timeout）插件的覆盖
   边界，是否需要 mud-core 侧补充护栏。
6. **紧急预占规则集**：哪些规则算"紧急"（死亡 / 战斗 / 受击 / 断线提示）。
7. **流程终点工具的 concludeTurn 约定**：规则 action 如何表达"这步是终点"
   （如 world_patch 是否带 conclude 标记）。
