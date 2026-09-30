# mud-core3 计划起草区

> **当前状态（2026-09-30）**：**第一期已全部落地并验收**（C1–C5/C5.1，v0.0.2–v0.0.11，见 [CHANGELOG.md](CHANGELOG.md)）。**第二期（工具面）已全部落地并实机验收**（v0.0.12，测试 132 → 174 项全绿）。两期起草节已随落地清空，设计事实源同步至 `doc/architecture/00-core.md`。C5.2 暂缓（指针见下）。已裁定 `packages/mud-core2` 原位退役。
>
> **文件角色**：总体规划纲要 + 切片详细设计起草区。详细设计在实施前再细化，不提前展开。

## 总体规划纲要

每个期只命名工作范围与触发条件，不预做详细设计。实施时按切片细化，落地后同步 `doc/architecture/` 并登记 `CHANGELOG`。

### 第一期：基础设施 + MUD→agent 投递（**已完成**）

> **目标**：MUD 信息进入 agent（等同人工提问）并得到回答；工具与流程全部不做。
> **状态**：**已完成**（2026-09-30，v0.0.2–v0.0.11）。地基验证点已过：行流投递通道走通、agent 回答正确。

| 切片 | 内容 | 验收 |
|---|---|---|
| C1 骨架 | 包骨架 + `link/` 移植（telnet/ansi/行流/LoginGate）+ 回放用例 | tsc + 用例绿 |
| C2 多会话 | roster storage + 会话装配（roster 判定→registry）+ 手工 connect/disconnect + 生命周期 | 两会话隔离；disposed 断连拆 runtime |
| C3 投递与接入 | 建账号链路（自动会话 + preset 选择）+ mud-player preset 行 + 聚合投递（followup/steer）+ admit/stop + 水位 | 端到端：接入→消息进会话→agent 回答；停止后零投递 |
| C4 管理面 | `packages/mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工连接、状态 | 全流程 UI 可操作 |
| C5 游戏画面视图 + C5.1 状态推送 | 右侧栏只读游戏画面（无头屏 + follow 流）；状态 tab 轮询改 watchStatus 推送 | 打开 tab 见回放+实时流；关闭不影响连接；状态毫秒级可见 |

> 落定事实见 [architecture/00-core.md](architecture/00-core.md)（§3.5 管理面等），演进过程见 [CHANGELOG.md](CHANGELOG.md)。

### 第二期：工具面（**已完成**，v0.0.12）

> **目标**：agent 向 MUD 发命令、主动读状态；禁发表（安全面）；工具受接入闸门约束——未连接/未接入均可读拒绝，连接与接入是手工动词，模型不能自行建连。
> **状态**：**已完成并实机验收**（2026-09-30，v0.0.12，测试 132 → 174 项全绿；前置验证 5 条由用户实机跑通）。

| 切片 | 内容 | 验收 |
|---|---|---|
| T1 ReadMachine | core2 竞速机移植为独立类（`src/read.ts`）挂 runtime；判定序 `failOn>until>gaCount>maxLines` 写死；abortWait/danger 保留、swallow 钩子空实现 | `test/read.spec.ts` 24 条绿 |
| T2 投递 pull 化 | deliver 去自持缓冲 → 双水位线（deliveredAbs/readAbs，seen=max）；turn 订阅接线（start 抑制 / end 冲刷）；失败批次不丢行 | runtime TCP 7 条；deliver 重写 + 断线复位 |
| T3 工具层 | `src/tools.ts`（mud_send 六级可读拒绝序 + 禁词表 `{suicide}` 全段扫描 + listen 编译 + timeout 钳制；mud_state 只过归属）+ `src/preset.ts` 注册 + 完整性自检 | `test/tools.spec.ts` 8 条绿 |
| T4 接线 | `ctx.provide('mudCore3')` 扩展 `toolContextFor`/`defaults`；Config 增 `sendTimeoutMs`/`sendMaxLines`、删 `deliverMaxPendingLines`；cordis.patch.yml preset 行 `mud-tools` + persona 工具说明 | service 流转测试；宿主实机验收 5 条 |
| T5 收尾 | 实机调整：send 回显格式 `账号名@来源>`（agent 灰 90m / user 青 36m）；工具栏按钮原生化；文档同步 | 174/174 全绿；文档与实现一致 |

> 落定事实见 [architecture/00-core.md](architecture/00-core.md)（§3.3 工具面现役、**§3.4 投递水位线 pull 模型 + turn/end 驱动**），演进过程见 [CHANGELOG.md](CHANGELOG.md) v0.0.12。

### C5.2 行打标与画面分屏（**暂缓执行**，设计定稿另存）

> **需求**：聊天、其他玩家的动作提取到副屏窗口——方便观察 + agent 去噪；聊天不进 agent（封号风险）。
> **状态（2026-09-30）**：设计经八轮收敛**定稿**，暂缓执行、移入待办。完整设计（核心裁定、帧结构、利弊结论、测试面、验收、被否决方案）另存：`doc/plans/c5.2-line-tagging-split-screen.md`。
> **恢复执行入口**：按该文件「实施顺序」开工，第一步 = 前置校准（语料校准）；定稿结论无需重新讨论，除非前提变化。
> **与二期叠加点**：投递剔除点在 `take()`——拉取时过滤有标行且不推进水位；与 pull 模型兼容，两切片实施顺序无依赖。

### 第三期：流程 flows

> **触发**：工具面落地后，出现需要编排多步命令的场景（如登录链路、验证码处理）。
> **范围**：`mud_flow` 机制；fullme 流程；验证码链路；登录流程 + 连接工具化（连接/登录分离，均对 agent 开放）；子 agent 委派（dsh 原生能力）；onboarding 触发改造。从 mud-core2/mud-core 归档代码按需移植与重写。流程消费行推进水位（语义已定，见 §3.4）。
> **状态（2026-09-30）**：详细设计**第二稿**，三项用户裁定已收敛：①接入 = 第一次规划的触发器（admit=false 时 agent 零行为）；②连接与登录分离、都交给 agent（盲发 login 退役）；③子 agent 进三期（dsh 原生委派）。移植源 = `packages/mud-core2/src/tools/flows/` + `tools.ts` 的 mud_flow 面；判据为实录语料（抓包字节实证 2026-09-10/11/13），移植保原文。

#### F0 已核实事实

1. **契约（core2 定案，照搬）**：`Flow = { id, description, run(ctx) }`；三出口 `{done:true}` / `{done:false, question, lines}`（**重放无害才允许**）/ `{reason:'danger'}`；timeout/failOn/disconnected/signal 等异常终态抛 `FlowError`（失败不结束回合，工具层转可读错误）。
2. **core2 read 的消费语义 = 光标**：`Mud.read()` 把未消费 buffer 全量作 initial 先结算（`mud.ts:220-228`）——流程跨步间到达的行由下一步读收编。core3 等价物 = **seenAbs 光标**（`takeLinesAfter(seen)`，`runtime.ts:163`）。
3. **core3 现有 read 两模式都不适合流程步**：有 cmd = fresh（initial=[]，只收 send 后新行）；无 cmd（裸读）= pending 尾部 maxLines 快照——尾部窗口会混入陈旧行（如 10 分钟前的冷却句仍在环形缓冲，误触发判据）。流程需要第三种：**从已见光标读**（initial = seen 之后的行，结果推进 readAbs）。
4. **runtime.connect 现状 = 盲发 login**（name→200ms→pass→200ms→盲发回车，一期实机验收过）——**裁定退役**（2026-09-30 用户裁定：连接与登录分离）：connect 改纯 TCP，登录统一由 login 流程承担；盲发路径不处理替换询问、登录失败不可读、成功无判据。
5. **并发兜底**：ReadMachine 在途 fail-loud——同会话并发 MUD 工具调用（含子 agent 并发）后到者可读报错，机制不加锁。
6. **安全面**：流程内部发送是封闭命令集（`fullme`/`fullme 1`/`y`/`halt`/`hpbrief`/空命令），不经禁词表；流程 id 查无 = 越权/不存在，直接拒；禁词表统一 `{suicide}` 全段扫描（裁定承袭，子 agent 不另设扩展表）。
7. **沿用 core2 裁定**：不注册 captchaRecognize（必然失败的桩白烧请求）；fullme 收图后以 question 上浮，人工作答。
8. **子 agent 字段（core2 已核实）**：`session.header.delegationDepth`（权威，resume 不变）+ `session.header.parentSession` + `options.subagentDepth`（兜底）——core3 `toolContextFor` 据此把子 agent 映射回父会话 runtime（core2 `depthByHeader` 同款判定）。
9. **接入闸门与首次规划（用户裁定）**：admit=false 时自主规划完全不启动；**首次 admit = bootstrap 要点清单的投递时机**（原建号时投递退役）。

#### F1 流程契约与注册表（`src/flows/`）

新增四文件，移植 core2 同名文件（判据/实录刻度**原文保**）：

- `flows/types.ts`：`Flow`/`FlowResult` 三出口/`FlowError` 照搬；`FlowCtx` 改造——**砍 holder**、**`mud: Mud` → `io: FlowIo` 窄面**（流程不碰 link 层，行流与水位归 runtime）：

```ts
interface FlowIo {
  send(cmd: string): boolean             // agent 来源（回显 `账号名@agent>` 灰）
  sendCredential(text: string): boolean  // 凭据直发（不回显、不落日志）
  read(opts: FlowReadOpts): Promise<ReadResult>  // 光标读（F2）
  readonly connected: boolean            // TCP 已建
  readonly loggedIn: boolean             // 登录流程成功句判据置位（幂等守卫用）
}
interface FlowCtx {
  io: FlowIo
  creds: FlowCreds             // { name, pass }，只在发送瞬间使用
  defaultTimeoutMs: number     // = Config sendTimeoutMs（不设新键）
  answer?: string              // 重入携带（fullme 答题阶段）
  signal?: AbortSignal         // 工具 exec.signal 转发
}
```

- `flows/index.ts`：`FLOWS = [LOGIN_FLOW, FULLME_FLOW]` + `getFlow`；**模型暴露全表**（login/fullme 均可调）；加流程 = 加文件 + 数组一行。
- `flows/login.ts` / `flows/fullme.ts`：判据常量、步骤图、stale 舞蹈、三连放弃、收口 settle **原文移植**；`step()` 辅助同形（danger 原样返回 / timeout·disconnected·signal 抛 FlowError）。唯一改动 = `mud.send/read` → `io.send/io.read`、holder 字段删除。

#### F2 runtime 流程底座

`SessionRuntime` 增补（不改既有路径）：

- **光标读 `readCursor(opts)`**（内部方法，仅供 FlowIo；模型面 read 不动）：initial = `takeLinesAfter(seenAbs)`（与投递拉取同源）→ `readMachine.start(opts, initial)` → 结果推进 `readAbs`。流程跨步间到达的行由下一步读收编（core2 buffer 语义等价）；流程消费与投递天然互斥（同一水位线，行数据只进 agent 一次，§3.4）。
- **loggedIn 标志**：login 流程成功句判据置 true（FlowIo 经 runtime 标记）；disconnect/断线复位 false；`mud_state` 输出与 `StatusFrame` 增该字段。
- **凭据保留**：connect 成功解析后 runtime 内存保留 `ResolvedCredentials`（disconnect/dispose 清除）——FlowIo.creds 来源；明文不落盘、不进日志、不进结果（sendCredential 不回显）。
- **FlowIo 适配器**：`send` → `runtime.send(cmd, 'agent')`；`read` → `readCursor`；`connected`/`loggedIn` → getter。
- **并发与投递**：流程读与 mud_send 共用 ReadMachine（fail-loud 兜底）；流程是工具调用，天然在 turn 内——投递抑制/turn=end 冲刷语义零改动。与 C5.2 的叠加点同 take()。

#### F3 连接与登录分离（用户裁定定案）

- **connect = 纯 TCP**：手工 webui 动词与新工具 `mud_connect` 同语义（`runtime.connect` 砍盲发 login 段：TCP 建立即返回）；幂等（已连返回现状）、connecting 中可读拒绝。盲发回车 hack 一并退役。
- **login = login 流程（模型暴露）**：`mud_flow({id:'login'})`。
  - 幂等守卫：`io.loggedIn === true` → 直接 `{done:true}`（防重登向已登录会话误发账号名）；
  - 未连接 → 可读错误「请先连接（mud_connect）」（fail-fast，不等超时）；
  - 已连接未登录 → 直接进登录步（用户裁定场景「已手工连接则直接发用户名」）：光标读 initial 收编**已到达**的名字提示/横幅（先连接后 admit 的行仍留 pending，cursor 读得到），until 命中即发用户名；
  - 替换询问答 y、密码错误/用户名不存在 failOn 可读失败、成功句判据、空命令收尾 settle——全部承 core2 实录刻度。
- **登录行流消费**：banner/提示符/成功句被流程消费 → readAbs 推进 → 不再投递给 agent（噪声减少，非损失）。

#### F4 fullme 流程与 question 上浮

- 移植原样：取图（answer 缺席）→ URL/stale/冷却分类；stale 三连发 `fullme 1` 后补取（仍 stale 抛错等重调）；冷却抛错（模型见时长自行安排）；取到 URL → `{done:false, question:'验证码图片：<URL>…'}`。
- **question 上浮 = 会话自然循环**：工具返回 question → 模型转告用户 → 用户回复答案 → 模型带 answer 重入 `mud_flow({id:'fullme', answer})` → 答题阶段（halt + fullme {answer} → 成功 hpbrief 收口 / 答错再上浮，至多 3 次由模型面文本承载）。core2 的 userQuestions/DELEGATED_CALLER 管道不需要（子 agent 用 dsh 原生委派，见 F5）。

#### F5 工具面与子 agent 映射（`src/tools.ts`）

- **新工具 `mud_connect`**：无参数；拒绝序 ①引擎缺席 ②归属 null ③执行（**不过接入闸门、不查连接状态**——connect 无 admit 亦合法 = 录制模式；connecting 中可读拒绝）；TCP only（不发用户名/密码）；`timeoutMs: 30000`（TCP 等待上限）；`isConcurrencySafe: false`；返回 `{ok:true, state}`。
- **mud_flow**：参数 `{id, answer?}`，无 timeoutMs 参数（步超时取 Config sendTimeoutMs）；拒绝序 ①引擎 ②归属 ③id 查无 ④接入闸门 ⑤连接 ⑥run（login 流程在 ⑤ 前自带幂等/未连接引导）；注册 `timeoutMs: 180000`（最坏链路 ≈75s × 2 余量）；`isConcurrencySafe: false`。
- **子 agent 归属映射（toolContextFor 升级）**：`delegationDepth > 0`（header 权威、options 兜底）⇒ 取 `parentSession` 直查 roster——命中 ⇒ 返回父会话 ToolContext（子 agent 共享父会话的 runtime/连接/水位）；未命中 ⇒ 可读拒绝（**嵌套委派不支持**，persona 指示单层派单）；根判定同现状（sessionId ∈ accounts）。
- **禁词表统一 `{suicide}`**（裁定承袭；根/子同表，不恢复 core2 子级扩展表——先例证后机制）。
- **并发纪律**：同会话并发 MUD 工具 = ReadMachine fail-loud 可读冲突，机制不加锁；persona 指示「MUD 相关任务串行派单」。
- `MudCore3Handle` 增 `flows?: readonly Flow[]`（测试注入）；注册完整性自检扩为四工具（mud_send/mud_state/mud_flow/mud_connect）。
- persona/工具说明（cordis.patch.yml）：四工具说明 + fullme 提醒句进常识段 + question 人机循环 + 委派模式（root 拆单 → 子 agent 执行 → 回报 root；MUD 任务串行）。

#### F6 onboarding 触发改造（bootstrap）

- **触发点迁移（用户裁定）**：建号时投递退役 → **首次 admit 投递要点清单**。`roster.accounts` 增 `bootstrapped` 标志（持久，投递成功后置 true；重复 admit 不重投）。
- **bootstrapText 重写**：账号事实 + 要点清单（①未连接则 `mud_connect` ②`mud_flow('login')` 登录 ③查看状态 ④`mud_flow('fullme')` 补给 ⑤依次完成要点后汇报）+「可拆给子 agent 执行，MUD 任务串行」。
- **投递时序兜底**：admit 时 agent 未就绪（agentMap 空）→ 标记待投，`agent/created` 时补投（与 flushOnce 同点）。
- **blank 影响**：未接入账号会话保持 blank（会话体/「MUD 日志」tab 不渲染；右侧栏画面 tab 不受影响）——首次 admit 即翻白。
- Config：`bootstrapOnCreate` → `bootstrapOnAdmit`（缺省 true）。

#### F7 差异裁决表（core2 → core3）

| core2 | core3 | 理由 |
|---|---|---|
| LoginGate 隐式建连 + login（mud_send/mud_flow 首调自动建连登录） | 连接/登录分离：`mud_connect`（TCP）+ `mud_flow('login')` 显式两步 | 用户裁定：连接与登录都交给 agent，显式可读；admit 闸门语义不变 |
| 盲发 login（core3 一期 connect 内） | 退役；登录统一 login 流程（成功句判据） | 替换询问/密码错误可读化；成功有判据 |
| holder/root-child 持有者 + 单根守卫 | `toolContextFor` 子 agent 映射（delegationDepth/parentSession → 父会话 runtime） | 多账号多会话，单根守卫不适用；dsh 原生委派字段已核实 |
| root userQuestions 问人 | 会话自然循环（模型转告用户）+ 原生委派回报 | 无自建管道；answer 重入不变 |
| `world.set('session','loggedIn')` | runtime `loggedIn` 标志 | core3 无 World；connState 只表 TCP，登录真相单独标记 |
| `FlowCtx.mud: Mud` 直摸 | `io: FlowIo` 窄面 | 行流/水位归 runtime；流程不碰 link 层 |
| read = buffer 光标 | readCursor = seenAbs 光标 | core3 无 Mud 内 buffer；与投递共用单一真相 |
| deps.onExchange 观测 | 砍（后置） | 观测面未立项 |
| 子会话静态禁发表扩展表（passwd/quit/drop…） | 统一 `{suicide}`（裁定承袭） | 可逆命令不拦，先例证后机制 |
| captchaRecognize 桩 | 不注册（承袭） | 必然失败桩白烧请求 |
| ReadResult.rest | 已砍（二期） | 逐行回调模型等价 |

#### F8 测试面（先红后绿；174 基线）

- `test/flows/login.spec.ts`（fake TCP 回放实录语料）：正常登录全链（banner→name→pass→成功句→settle）；**已连接直接发用户名**（提示符先到，cursor 收编）；替换询问→y→成功；密码错误→断连→FlowError；用户名不存在→failOn；步超时→FlowError；danger→出口 3；**loggedIn 幂等**（已登录调用直接 done:true）；**未连接 fail-fast**。
- `test/flows/fullme.spec.ts`：取图成功→done:false 且 question 含 URL；stale 舞蹈；三连后仍 stale→FlowError；冷却→FlowError 带时长；答错→done:false 重试；答对→hpbrief 收口 done:true；空 answer 拒绝。
- `test/runtime.spec.ts` 增：readCursor——initial = seen 之后行；推进 readAbs；断线复位（含 loggedIn 复位）；与 mud_send 并发 fail-loud。
- `test/tools.spec.ts` 增：mud_connect（TCP only 不发凭据；幂等已连；connecting 可读拒；不过闸门）；mud_flow 拒绝序五条 + 三出口渲染 + answer 透传；**子 agent 映射**（delegationDepth>0 + parentSession 命中 → 父会话 tctx；未命中可读拒）。
- `test/service.spec.ts`（或集成）增：**首次 admit 投 bootstrap**（bootstrapped 持久、重复 admit 不重投、agent 未就绪补投）；connect 纯 TCP 断言（connect 后不发用户名/密码）。

#### F9 验收表（新增行）

| 断言 | 内容 |
|---|---|
| onboarding 触发 | admit 前 agent 零行为（工具拒绝、零投递、零规划）；首次 admit → 要点清单 → agent 自主规划执行 → 会话汇报；重复 admit 不重投 |
| 连接登录分离 | mud_connect 只建 TCP（不发凭据）；mud_flow('login') 完成登录（成功句判据）；已手工连接 → 直接发用户名；幂等（loggedIn） |
| mud_flow 可见面 | mud-player 可见 mud_flow/mud_connect（standard 不可见）；拒绝序逐级可读 |
| fullme 端到端 | 提醒行→mud_flow fullme→question 上浮→人工作答→重入→成功→hpbrief |
| 子 agent 委派 | root 拆单 → 子 agent 调 MUD 工具映射父会话 runtime 生效 → 回报 root；子 agent 并发 MUD 工具冲突可读不炸回合 |
| 水位语义 | 流程消费的行不再投递；流程步间未消费行照常投递；登录行流不进投递 |

#### F10 前置验证（实机，用户执行）

1. 登录语料复核：判据原文与当前服务端逐条核对（尤其 `(估计)` 形态：FAIL_PASS 三式、UNTIL_SUCCESS 备选）。
2. fullme 提醒句/成功句/答错句原文核对（作者实录 2026-09-12/13）。
3. 子 agent 实机确认一次：mud-player 会话内原生委派工具可用、子 agent 能看到 mud 工具。

#### F11 已知限制

- 流程总时长受注册 timeoutMs（180s）钳制；超长流程需分段或调上限。
- question 上浮依赖模型自觉转告用户；不应答则流程停在会话里（模型可稍后重调或放弃）。
- login 判据 = 实录语料快照，服务端文本改版需更新（语料校准点）。
- 流程运行中到达的无关行会被当前步读收编进结果行（core2 buffer 语义承袭）——判据特定性兜底。
- 子 agent 仅支持单层委派（parentSession 直查 roster）；嵌套委派可读拒绝。
- 挂机模式（连而不入）如需角色在线：需先 admit 让 agent 登录一次后 stop（手工登录面板后置）。
- 并发 MUD 工具冲突靠 persona 串行派单约束，机制层 fail-loud 兜底。

#### F12 后置（不在三期）

- 更多可复用流程：按例证生长（加文件 + FLOWS 一行）。
- onExchange 流程观测事件；嵌套委派；手工登录面板；子 agent 预算/看门狗/唤醒——均按例证或归第五期。
- captchaRecognize（自动识别）：可靠识别源出现时（链路不变，answer 来源替换）。
- 意识层 danger 接线（abortWait 真实调用者）：第五期（管道已就绪，三出口语义已含）。

### 第四期：自动重连

> **前置**：先实现**真实心跳**（MUD 侧健康探测），无心跳不区分真断线/半开连接。
> **范围**：热状态（agent live）自动重连；冷启动不自动；断线恢复后的世界状态重建策略。
> **注意**：心跳本身可能值得单独一个切片，先验证 MUD 侧是否有原生心跳信号可用。

### 第五期：进阶机制（按例证生长，不预设顺序）

> **触发**：以下各项各自独立，由真实需求驱动引入，不批量规划。

- **子 agent / 派单 / 预算**：计划性任务需求出现（核心 action 复用、并行探索）
- **T2 闭环 / 唤醒**：挂机自主行为需求出现；唤醒**必须**以"已接入"为前置（§3.4）
- **意识层回归**：危险判据 → abortWait 接线 + swallow 吞行钩子实现（规则吞行留摘要；管道已就绪，二期保留空实现）
- **投递策略化**：字段化摘要、按需投递、水位窗口细化——token 账目恶化时；含超长回合持续刷屏的 turn 内强刷机制（二期已知限制，无例证不引机制）
- **禁词表可配**（Config 化；实证发现新危险命令按 I5 加行）
- **计数 / 账目 / 可观测**：成本验收或运营监控需求出现
- **其他**：core2 归档中未迁移但有参考价值的设计（五层心智等），按例证逐条评估

### 容易遗漏项（清单，非期）

以下在各期实施时需留意，不单独成期：

- **凭据管理**：密码录入、更换、多账号复用同一凭据（凭据链路 §2.4 已覆盖，实施时细化）
- **冷会话 runtime 保留**：宿主释放 agent 时连接不拆（§2.3 已定，实施时验证）
- **persona 内容**：mud-player preset 的 system prompt 措辞（随各期工具面扩展同步更新）
- **从 v1 迁移**：mud-webui 接线替换时，roster 数据从 localStorage 迁移到宿主 storage 域（已完成，v0.0.8）
- **遗留脚本清理**：根 `package.json` 的 `test`/`dev:core2` 脚本指向 mud-core2（已完成，v0.0.2/v0.0.6）

> AI生成
