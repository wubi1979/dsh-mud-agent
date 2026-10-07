---
sections: [16, 17]
status: active
deps: ["§1", "§11"]
note: 验收与演进：测试策略、断言表、切片与完成定义、后置清单与生长纪律
---

# §16 测试与验收

## 16.1 测试策略与纪律

| 策略 | 说明 |
|---|---|
| **纯层可单测** | `link/*`、`src/tools.ts`、`read.ts`、`world.ts`、`wake.ts`、`deliver.ts`、`mud-workflow/{contract,core}` 均零宿主 import ⇒ 直接单测（适配层 `host/*` 由工件面 e2e 覆盖，§8.8） |
| **装配层抽策略** | 装配层（`index.ts`）不内联业务分支；可测逻辑抽成独立模块（如 `accounts.ts` 的名册写路径），装配层只做接线 |
| **装配层必过宿主组合加载冒烟** | 纯层用例**不加载插件**：`index.ts` 改动后必须真加载一次（自动化见下行；手工 = 真启动宿主，§2.2 启动链），确认 `mud-core3` 条目**已激活**（无 `1 entry did not activate`）且 `remote.mud` 动词在册。**`apply` 抛错 = 全部 `mud/*` 动词 404**——页面侧只表现为名册操作失败（建服务器那步的错误被状态行吞掉），极易误判为路由/前端问题 |
| **插件的加载冒烟走工件面** | `test/plugin-load.e2e.ts` 导入 **`lib/index.js`（宿主实际加载的产物）**，不导入 `src/`：插件源用**标准装饰器**（`@Remote`），vitest 的 esbuild 转译不支持（`Invalid or unexpected token`）⇒ 源码面根本不可加载；工件面同时对齐宿主行为，代价是**依赖最新构建**（§2.2「改码后必须重建」）。用例只提供 `typert`（唯一必需服务），`agents`/`credentials`/`sessionController`/`storageDomain` 全缺席 |
| **先红后绿** | 行为变更**必须自带会红的用例**（先证明旧实现失败，再改）——缺陷都是无声的，没有会红的用例不算修完 |
| **回放用例** | `link/` 层以语料回放为主测试手段（§13.4） |
| **账目以当次实测为准** | 例数、计数、规模**一律以当次实测登记**，不硬编码历史值 |
| **测试即证据** | 结论必须能给出 `文件:行` / `§` / 命令输出三者之一（附录 B 审计规约 E1–E3） |
| **替换类改动必过"重放级"冒烟** | 表面遮蔽的合法性只在**重放/折叠**时最终判定（在 `system/message` head 就位前追加 message ⇒ `append` 当场成功、日志照写，**下一进程**判 corrupt，§2.1 事实 15）⇒ `index.ts` 的 T18 接线改动必须跑 `spike/smoke-probe.mjs` + `spike/smoke.patch.yml`（临时 `DSH_HOME` + `dsh web --patch … --port 3083 --no-open`；探针用**真实** `ctx.get('mudRemote')` / `sessionController` 驱动两轮对话并捕获 `llm/stream` 组装出的请求）：① 空表面 ⇒ skip 且**不阻断**（请求照发）；② 有历史会话首轮之后被遮蔽（请求含起点标记、不含上一轮文本）；③ 新进程 `create` 同 id **重放不 corrupt** 且旧节点不在表面；④ 二次进程再遮蔽一次（`replaceGeneration` 单调、请求中的 epoch = 本进程）。**探针退出前必须 `ctx.sessions.flush(session)`**——直接 `process.exit` 会把日志截在半个回合，之后 resume 的进程不再起回合（配方陷阱，非遮蔽路径） |

## 16.2 用例账目

| 包 | 用例 | 文件 |
|---|---|---|
| **`mud-core3`** | **343 例 / 25 文件** | `link/`：`line` · `telnet` · `mud` · `keepalive` · `corpus`；`src/`：`store` · `accounts` · `runtime`（含 T19 tracker 接线）· `deliver` · `read`（含 T15 命中帧）· `tools`（含 T19 `wait:false`）· `tracker`（T19）· `service`（含 `statusRowOf`）· `world` · `wake` · `screen` · `classify` · `llm-gate` · `reconnect` · `workflow` · `elide`（T18 遮蔽判定与适配）· `log/log-service`；装配层：`plugin-load`（工件面 e2e）· `login`（流程 E2E 五路径）· `fullme`（流程 E2E 主链/stale 自愈/abort/三退出路径/URL 槽化断言） |
| **`mud-workflow`** | **77 例 / 4 文件** | `registry`（含捕获槽保存门四校验、名册冲突裁决与来源标记策略 A、T16 迁入取新/账本/回滚/强审计）· `interpreter`（含捕获槽语义、命中帧消费与"去重测"结构断言）· `tools`（含来源/遮蔽呈现、遮蔽修订 delete、history/rollback 贯通）· `plugin-load`（工件面 e2e，T17） |
| **`mud-webui`** | **7 例 / 1 文件** | `mud-captcha`（控制器：订阅/帧 diff/提交/中止/刷新配额/防串帧） |

| 用例组 | 覆盖章节 |
|---|---|
| `link/{line,telnet,mud,keepalive,corpus}` | §3.2–§3.5（连接代次、建连失败、并发 connect、探活刻度与 busy 谓词、行化、语料） |
| `reconnect` · `classify` · `llm-gate` | §3.2/§11.3（自动重连限次与打断）、§6.3（行分类与投递剔除）、§7.4.1（LLM 调用面闸门） |
| `runtime` · `deliver` · `read` | §4.2–§4.5（录制上限、水位线不重投、turn/end 冲刷、失败重试、裸读、判定序）；T15（§5.2）：命中帧 `hit`——按声明序下标、`failOn`/`until` 来源、捕获组（未参与组 `undefined`）、`gaCount`/`maxLines` 关窗无帧、`g`/`y` 有状态正则重置（同实例跨 read 复用不丢命中）、`y` 锚定语义保留 |
| `tools` | §8.2–§8.7（注册自检、拒绝序、禁词全段扫描、`mud_state` 不受闸门、listen 编译、超时钳制）；T19（§8.3/§8.7）：`wait:false` 发送即走（不 read、返回 `reason:'sent'`、裸读不适用、无 `cmd` 拒绝、缺省行为与拒绝序不变） |
| `tracker`（T19） | §10.3（D1–D10）：hpbrief 定长序列（实录回放 18 键 + 完整性校验失败不写不猜）、hp 表格逐键（含文本状态/加成/战意，与 hpbrief 同键覆盖）、块级打标剔除（含未命中块、聊天行不撞、C5.2 优先不覆盖分类）、section 提取、lines 形状（`id` 别称）、`clear` 消解 + `World.delete` 幂等、断线 reset、skills/`i`/`sc` 逐键、runtime 行路径接线（TCP 回放 → World + `source.kind='track'`） |
| `screen` | §5.3（ANSI 入 snapshot、回显入屏而凭据缺席、背压断流与 re-follow、两会话屏隔离、跨重连续写、attach 原子性、合批） |
| `store` · `accounts` | §11.1–§11.2、§14.3（内存/域表、记录 schema、降级、先落名册顺序、失败回滚、`admitted` 持久化） |
| `world` | §10.3–§10.4（分区/来源、断线复位） |
| `wake` | §7.5（re-arm、三守卫、fire 后不重复） |
| `workflow`（core3 侧） | §8.8、§8.14（`workflowIoFor` 缝、login E2E 五路径） |
| `fullme`（core3 侧） | §8.17（captcha 双闸、`awaitCaptcha(url)` 原语、`{captcha}` 槽与 pass 掩码排除、stale 自愈环、等待注册表三退出路径；T14：URL 经捕获槽传入、答错重入沿缓存图不重抓、URL 行未出现 → 结构化 timeout、`io.recentLines` 水位过滤回归） |
| `mud-workflow/{registry,interpreter,tools}` | §8.8（包内三层与契约单点；宿主入口 `lib/index.js` 与契约子路径）、§8.10–§8.15、§8.17（`awaitCaptcha(url)` 端口单点声明 + core3 缝实现 = 编译期断言；T14：捕获槽语义①–⑧ + 保存门四校验；2026-10-05 语义澄清⑨–⑪：捕获与路由同源、整窗 exec（跨行判据可捕获）、非捕获判据路径不吞分类出口；策略 A：locked 内置优先 + `shadowed` 标记 + 遮蔽修订 delete 放行 + `origin` 来源标记；T15（§5.2/§8.13）：解释器消费命中帧、源码级"去重测"结构断言；T16（§8.11/§14.3）：迁入取新与归档、变更账本（上限剪枝）、回滚写新版本、强审计提交、`flags` 白名单收紧。`login` 用例已随实体归 core3，见上行） |
| `mud-webui/mud-captcha` | §9.7（弹窗呈现：订阅恢复、帧边界 diff、提交/中止/刷新） |
| `plugin-load`（工件面 e2e） | §16.1（装配层加载冒烟：`apply` 不得失败，引擎窄面与 remote 命名空间在册）。**mud-workflow 同款**（T17）：导入 `lib/index.js` / `lib/preset.js`，断言 `mudWorkflow` 服务面在册、七工具过注册面（谓词函数 + `output.schema` 对象根与真实字段） |
| `elide` | §11.2（T18 上下文收口）：判定矩阵——空表面 / 只有 head / node 0 非 head / 无历史（含"尾节点是 system/message 且无其它历史"）/ 本 epoch 已遮蔽 / **日志含未解析 `tool/call`** ⇒ **skip**；head + 历史 ⇒ replace 且 `shadowedSeqs` 全覆盖；**端点按 surface 顺序**（不假设 seq 单调，`start` 可大于 `end`）；**中段后续 `system/message` 随历史遮蔽**、**尾节点是 `system/message` 则保留尾节点**（v0.0.47，真实会话形态）；`tool/call` 是 log-only ⇒ 配对判定看日志。标记形状冻结 + 正文含 epoch + 无凭据面；epoch 同进程稳定。适配层：`append` 被拒 / 替换体未落表面 / 被遮蔽节点仍在表面 / 快照不一致 ⇒ **failure**（接线层据此阻断本步） |

## 16.3 验收断言表

| 断言 | 内容 | 章节 |
|---|---|---|
| **多账号隔离** | N 账号同时在线：各持一条连接、各向自己的会话投递，**互不串线**（两会话隔离用例） | §5.5、§11 |
| **账号 = 自动会话** | 建账号**一个动作**完成会话自动创建绑定；`sessionId` = 账号 id 持久；**无独立会话操作面** | §11.2 |
| **服务器 = 工作区 + 字段** | 建服务器即建工作区；roster 按 `workspaceId` 存 `host`/`port`；页面呈现沿用既有实现不改 | §1.4、§11.1 |
| **手工连接** | `connect` **只建连**（幂等：已连接不重连、不踢已登录会话；登录归 locked 流程）；`disconnect` 硬收尾；**手工断开不自动重连**（闸门 `hasConnected && !manualDisconnected`，冷启动同样不重连） | §3.2、§11.3 |
| **探活与自动重连** | 探活 = **link 层自驱静默伴随探测**（T12）：时钟锚 = 最后数据到达时刻（任意行/GA 到达即判活并重开窗口），静默满 `probeStartMs`（缺省 90s）发 AYT（判据 `^\[-Yes-\]`），无应答每 `probeRetryMs`（9s）重发共 `probeMaxAttempts`（3）次，**117s 判死**（落在 `silenceMs` 120s 唤醒点前）；busy 谓词（`holderBusy ∥ isInTurn`）为真的探测 tick 跳过；判活 link 内部消化、判死硬收尾转自动重连；意外断开（socket close/EOF/探活判死）自动重连（限次缺省 5 次 × 30s 后放弃等人工；手工动作打断在飞循环）；重连成功**只连不登** + 显式 arm 静默计时；旧行不重复投递；未接入会话同样探活与重连 | §3.2、§10.4、§11.3 |
| **MUD→agent 投递** | 接入后：MUD 行流以**用户消息**进入会话并触发回合，agent 产生回答（端到端）；静默窗口聚合生效（一批 = 一条消息，非逐行）；两会话各收各的 | §6.2 |
| **接入闸门** | 未接入（缺省）与停止接入后：**MUD 信息不再进入**（新投递为零）、行流照常积累；接入**水位 = 接入时刻**（积压不回放）；人工提问不受影响 | §6.3、§6.6 |
| **preset 选择** | 建账号可选 `standard`/`mud-player`；任意 preset 的账号**都有 MUD 源**（归属 = roster 判定，不按 preset 排除） | §1.4、§7.1 |
| **凭据链路** | 密码不落 roster/上下文/日志/画面；`resolve` 失败 = **流程执行**失败（结构化返回，不进连接），可读报引用名 | §11.6、§12.2 |
| **工具面** | `mud-player` 会话可见 `mud_connect`/`mud_send`/`mud_state`（`standard` 不可见）；`mud_connect` 幂等；`mud_send` 判据驱动、应答原文返回、禁发表**全段扫描**（带命中词；`quit`/`drop`/`passwd` 放行）、并发持有者**可读拒绝不劈半**、**只拒未连接**；`mud_state` 不受闸门，只过归属 | §8.2–§8.7 |
| **画面与状态推送** | 开「画面」tab 见 snapshot 回放 + 实时行流（send 回显可见、**凭据永不出现**；背压超限断流后重 follow 以新 snapshot 恢复）；状态经 `watchStatus` 推送（首帧快照 + 变化推帧、无变化零流量、abort 清服务端订阅）；未接入也可看画面；关/开 tab 连接不断 | §5.3、§9.4、§9.5 |
| **水位线投递** | `turn/end` 一次投出回合内未消费行；read/裸读消费的行**不重复投递**；投递只投 `seen` 之后；投递失败**不丢行**（下次从失败点重试）；未接入零积累零丢弃；裸读返回近期行（尾部截断生效、**含 admit 前录制行**、不重复投） | §4.3、§5.2、§5.4 |
| **状态面** | 两轴 `conn`/`loggedIn` 语义正确（断线复位两轴 + World 整体复位）；GMCP 包到达即置 `in-game`（**权威信号，不依赖行文匹配**）；World 分区/置信度/来源追溯，后到覆盖 | §10 |
| **归属上溯** | 子 agent/流程调用沿 `session.header.parentSession` 上溯命中账号会话即可用其 runtime；**祖先不 live → 可读拒**；环深护栏 32 层；**不开 `sessionId` 参数** | §8.5、§12.4 |
| **流程面** | 七工具（`run` + `list/get/save/delete/history/rollback`）现役；`locked` 拒改拒删；`save` 过三门（zod + `checkFlow` + 凭据红线）；**非 done/failOn 收束一律结构化 timeout**；出口 pass 掩码（凭据不泄露）；`login`（locked）E2E 五路径绿 | §8.10–§8.15 |
| **人工验证码链路** | `fullme`（locked）E2E：等值 resolve → 槽填充 → `fullme {captcha}` 正确发出；答错 goto answer 重入 + stale 自愈（三连 `fullme 1` → fail 收束无重试）；abort → `aborted` 出口；三退出路径（signal abort/断线/dispose）→ closed 收束 + release；并发冲突拒；`captcha` 非 locked 拒（save + 执行双闸）；`{captcha}` 不进 pass 掩码、未知 `{xxx}` 原样保留；webui 弹窗显示/提交/中止/刷新重取（每轮 1 次配额）/清除帧关窗/刷新页面首帧补推恢复 | §8.17、§9.7 |
| **流程捕获槽（T14）** | `captures` 声明：until[0] 命中行提取组入 run 级命名槽、本步/跨步 send 正确替换；goto 回跳重经捕获步覆盖旧值、未重经沿用上值（fullme 答错重入同型）；failOn 收束不写槽；保存门四校验拒存（保留名/组数不足/非 until[0] 组/槽名非法/save 侧联动）；未知槽原样保留；组空值/无命中行 → 结构化 timeout 同型收束不落槽；send 侧不碰 `{name}`/`{pass}`；fullme URL 经 `captchaUrl` 槽传入 `awaitCaptcha(url)`（E2E spy），答错重入同 URL 缓存图不重抓（页/图各 1 次），URL 行未出现 → urlwait 结构化 timeout（报错点前移）；已消费行不重入后续读窗 initial 快照（`io.recentLines` 水位回归） | §8.10–§8.13、§8.17 |
| **静默唤醒** | 行到达 re-arm；静默满 `silenceMs` 到期查**三守卫**（已接入 + 非回合中 + 持有者空闲），任一不满足只 re-arm；命中投状态任务书（`'mud-wake'`）；两触发点（admit/唤醒）**共用同一 kickoff 与模板**；LLM 调用面闸门终审（未接入拦成空 stop，§7.4.1） | §7.4、§7.5 |
| **自主行为** | 分工协议 persona 五条**根/子同读**；根规划 / 子执行（一次性前台，收尾文本经 `subagent` 工具结果回注）——**实机验收清单见 §16.4** | §7.6 |

## 16.4 实机验收清单（T4b，真机 + 凭据，逐项勾验）

- [x] ~~**1. 建账号** → 收到任务书回合~~（旧语义，2026-10-02 实机；**建账号触发点已退役**）
- [x] ~~**2. admit** → 收到状态任务书，根开回合读状态并产出规划~~（2026-10-02 实机；接入语义已重定，见 1'–2'）
- [x] **3. 根委派**（一次性前台）→ 子跑 `login` 流程登录成功 → 收尾文本经 `subagent` 工具结果回注 → 根消化后收尾（**2026-10-04 实机，新委派口径成功路径复验通过**；原「结算唤醒根」措辞属已退役路径）
- [x] **4. 中途失败**（错密码）→ 子停止并写明现场 → 结算带现场唤醒根 → 根重写规划（**不重做已完成步骤**）（2026-10-02 实机：错密码正常报错，自主重试一次后向人类提问）〔**新口径失败路径待复验**——见下方口径变更注〕
- [x] **1'. 建账号 = 纯登记**：不投任务书、agent 零行动；会话保持 blank（2026-10-02 实机，随 2' 同轮观察）
- [x] **2'. 接入 = 唯一点火**：建账号后点接入 → 状态任务书真实回合 → 根读状态产出规划；未接入时人工提问被拦（agent 完全惰性）；停止接入空步收束与宿主重启冷启动按设计推演（未单独实测）。（2026-10-02 实机；顺带修复：接入成功后右侧栏画面 tab 自动打开并挂载，§9.4）
- [x] **5. 静默唤醒兜底**：三守卫 + 状态任务书机制已有单测覆盖；**实机触发窗口难构造，用户裁定先算通过**（待日常使用中观察）
- [x] **6. admit 前手动「连接」不触发规划**（2026-10-02 实机）
- [x] **7. 零回归**：webui 三 tab、mud 三工具、`login` 流程五路径、单测全绿（2026-10-02 用户确认：三 tab 巡检通过；单测 core3 222 + workflow 31 全绿）
- [x] **8. 上下文收口（T18）重放级实机冒烟**（2026-10-06，临时 `DSH_HOME` + 真宿主组合，配方见 §16.1 末行；证据见 `doc/likely/t18-surface-elision-spike.md` §8）：① 空表面 ⇒ skip 不阻断（第 1 轮请求照发、回合 `completed`）· ② 有历史会话首轮之后被遮蔽（第 2 轮请求 `MARK=true / OLD=false / NEW=true`，`replaceGeneration=1`）· ③ 新进程 `create` 同 id 重放**不判 corrupt** 且旧节点不在表面（`oldSeqs=[3,8,13] stillVisible=[]`）· ④ 二次进程再遮蔽一次（`replaceGeneration=2`；请求中的 epoch = 本进程 epoch）。**未覆盖（留 §17.2）**：真 token 压力下宿主 compaction 与遮蔽叠加；跨度含未配对 `tool/call` 的端到端（已由纯层用例覆盖）；失败注入阻断的实机复现（reject 语义由宿主源码与宿主自测核实）
- [x] **9. T18 修正：真实会话命中两条规则（v0.0.47，2026-10-06，用户实测报告驱动）**：对用户真实会话（`session-a076ae0b…`，494 事件 / 表面 124 节点 / `system/message`×3 / `tool/call`×20 全在日志侧）做**离线折叠诊断**，定位两条"永不遮蔽"的原因：① 计划里的 `later-system-node` 保守 skip 在真实会话上必然命中（工具集/提示词更新会追加后续 system 节点）；② `applyElision` 的配对检查只在**表面节点**里找 `tool/call`，而官方 `SurfaceEventType` **不含 `tool/call`**（log-only）⇒ 任何有工具结果的会话都被误判未配对。修正：遮蔽范围改为 `node 1 … 末节点`（**尾节点是 `system/message` 时保留**，中段后续 system 节点随历史遮蔽，同 compaction，§2.1 事实 15）；工具配对改为看**日志**（每个 `tool/call` 都有配对结果）。离线复算同一真实日志 ⇒ `REPLACE [8..490]`（遮蔽 123 节点）。用例夹具按真实形态重写（`tool/call` 不再作为表面节点），`elide.spec` 24/24

**验收结论（2026-10-02）**：T4b 全项通过，**T4 自主行为正式关闭**——建账号纯登记 → 接入唯一点火 → 根规划/子执行/宿主结算 → 静默唤醒兜底，链路完整。

> **委派口径变更（2026-10-03）**：委派从「continuable 后台 + 结算唤醒」改为「一次性前台 + 工具结果回注」（§7.6，CHANGELOG v0.0.32）。#3 的链路结论（派发 → 子执行 → 回报 → 根消化）已按新口径于 2026-10-04 实机复验通过（成功路径）；**#4 失败路径尚未按新口径复验**——控制工具（`send_message` / `interrupt_agent` / `list_agents`）不再注册，失败现场经收尾文本回注的呈现待真实失败例证出现时再验并另行登记。

## 16.5 切片表与完成定义

| 切片 | 内容 | 状态 |
|---|---|---|
| **C1 骨架** | 包骨架 + `link/` 移植（telnet / 行化 / 连接 / 语料）+ 回放用例 | ✅ |
| **C2 多会话** | roster storage + 会话装配（roster 判定 → registry）+ 手工 connect/disconnect + 生命周期 | ✅ |
| **C3 投递与接入** | 建账号链路（自动会话 + preset 选择）+ `mud-player` preset 行 + 聚合投递 + admit/stop + 水位 | ✅ |
| **C4 管理面** | `mud-webui` 接线替换（呈现不改）：preset 选择、接入开关、手工 connect/disconnect、状态 | ✅ |
| **C5 + C5.1** | 服务端无头屏 + `follow` 流动词 + 只读画面 tab（单开、工具栏）；`watchStatus` 替换轮询 | ✅ |
| **C6 工具面（二期）** | `ReadMachine` + deliver pull 化（水位线 + turn/end 驱动）+ `tools.ts` 纯层 + `preset.ts` 注册 + `toolContextFor`/`defaults` 窄面 | ✅（并入 T2a/T2b） |
| **T1 状态地基** | 两轴 + GMCP 权威信号 + World（分区/置信度/来源，断线整体复位） | ✅ |
| **T2 工具面（三期）** | `mud_connect` + 归属父链上溯（live 注册表 + 环深护栏）+ 会话级持有者 + `mud_send` 拒绝序修订（删接入闸门） | ✅（T2a/T2b） |
| **T3 脚本面** | `mud-workflow` 独立包 + core3 `workflowEnvFor` 缝 + `login` locked 流程实体 | ✅ |
| **T4 自主行为** | kickoff 任务书面（admit/唤醒两触发点 + `taskBrief`）+ Wake（re-arm + 三守卫）+ persona 分工协议五条 + LLM 调用面闸门（建账号纯登记，§7.4.1） | ✅（T4b 实机验收通过，§16.4） |
| **T5 收尾（T11）** | `StatusRow` 边界窄面（`statusRowOf`，world 扁平数组值字符串化）+ webui 状态呈现（画面 HUD 条 + 侧栏「已登录」徽标）+ 零回归 | ✅（§9.4/§9.5） |
| **T5 自动重连（四期）** | 探活（telnet AYT + `link/keepalive` 纯层 + Wake 到期点前置检查，`probeState` 观测量）+ 自动重连（`hasConnected`/`manualDisconnected` 两标记 + 代次令牌打断循环 + 限次放弃）+ Config fail-loud 校验 + webui「探测中」呈现 | ✅ |
| **T12 探活精化返工** | 探活从「Wake 到期点串行前置」返工为「link 层自驱静默伴随探测」（锚 = 最后数据到达；90s 首发 × 3 次 × 9s 重发 = **117s 判死**）+ busy 谓词注入 link（busy tick 跳过）+ 判活 link 内部消化（Wake 净删 `probe`/`isProbing`/`onProbeAlive`）+ Config `probeStartMs` 与校验式（`startMs + 次数 × retryMs ≤ silenceMs`） | ✅ |
| **T13 人工验证码链路** | `captcha` 动作 + `awaitCaptcha` env 原语（双侧）+ locked-only 红线扩展 + `{captcha}` 槽 + `flows/fullme.ts`（主链四段 + stale 自愈环）+ 等待注册表（单槽 + 三退出路径 + run 级缓存）+ remote 四动词 + Config `captchaTimeoutMs` + webui 全局弹窗（独立订阅/首帧补推恢复/清除帧关窗/刷新配额）+ persona 流程说明 | ✅（回归全绿：core3 286 + workflow 40 + webui 7，§16.2） |
| **T14 流程捕获槽** | wait `captures` 字段 + 解释器捕获/四源替换 + run 级命名槽 + checkFlow 四校验 + `captcha` 动作 `url` 参数化 + `awaitCaptcha(url)` 双侧改 + fullme URL 捕获上移（URL_SRC 加组、自取净删、窄缓存保留、豁免注释清理） | ✅（回归全绿：core3 288 + workflow 56 + webui 7，§16.2） |
| **T15 读窗命中信息下沉** | 契约加命中帧（`ReadHit`：`by`/`index`/`groups`）与 `IoReadReason` 单点（core3 `ReadReason` 引用之）；读窗机判定与取组改**同一次 `exec` + 调用前重置 `lastIndex`**（`g`/`y` 有状态正则不再污染）；解释器删 `firstHit`/`captureSlots`，failOn 出口/路由/填槽全部消费命中帧 | ✅（回归全绿：core3 296 + workflow 67 + webui 7，§16.2） |
| **T16 流程存储演进与变更账本** | 事实核查（宿主 whole-unit 下**永不改域 `version`**、新增表零影响）；域增 `snapshots` 表（只追加账本，`save`/`delete`/`migration` 三类归档、每流程上限 20 剪枝）；迁入**按 version 取新 + 落败方归档 + 失败不挂域不清内存**；强审计提交（账本先行）；`history`/`rollback` 两工具（回滚写新版本）；`wait.flags` 收紧为 `d/i/m/s/u` | ✅（回归全绿：core3 296 + workflow 75 + webui 7，§16.2） |
| **T17 宿主接缝漂移防御** | `isConcurrencySafe` **谓词化**（两包，独占工具恒 `false`）· `output.schema` 逐工具补齐真实字段 · `render` 返回类型对齐宿主 `ContentBlock[]` · 接线层 `AssertTrue` **编译期断言**钉住这两处成员 · mud-workflow 工件面加载冒烟（`lib/index.js` / `lib/preset.js`，含七工具与 schema 面） | ✅（回归全绿：core3 296 + workflow 77 + webui 7，§16.2） |
| **T18 会话上下文的进程级收口** | 纯层 `elide.ts`（进程 epoch + 起点标记 + 遮蔽判定 + 适配后置校验）· `index.ts` `agent/pre-step` 接线（归属 = 根会话 + 名册账号会话；**失败 `{kind:'reject'}` 阻断本步**）· `source.kind='mud-epoch'` 声明合并 · 重放级实机冒烟（`spike/smoke-probe.mjs` + `smoke.patch.yml`） | ✅（回归全绿：core3 317 + workflow 77 + webui 7，§16.2；实机见 §16.4 #8） |
| **T19 状态追踪（游戏文本 → World）** | 纯层 `tracker.ts`（三形状 table/lines/sequence + 判据规则表 hpbrief/hp/sc/i/skills/id + 块级 `status` 打标剔除 + `clear` 消解 + 断线 reset）· `world.ts` 加 `kind:'track'` 与 `delete(zone,key)` · `runtime.ts` 行路径分类器后 `observe` 接线 · `mud_send` 加 `wait:false` 发送即走（D11）· 判据实录入档 A.7（hpbrief 已定稿；skills/id/i/sc 待实录校准） | ✅（回归全绿：core3 343 + workflow 77 + webui 7，§16.2；实机验证待用户实录校准 A.7.3 后按需复验） |

**完成定义（每个切片）**

1. `tsc` 清零；
2. 用例全绿，**例数以当次实测登记**；
3. §16.3 验收断言表中该切片的行**全过**；
4. `doc/architecture/` 对应章节同步 + `CHANGELOG` 一行；
5. 涉及行为变更的切片**先有会红的用例**。

## 16.6 文档—实现一致性清单（文档重写期发现）

| # | 矛盾 | 处置 |
|---|---|---|
| 1 | `packages/mud-core3/src/index.ts` 中 `viewCols` 注释写"缺省 80"，实际与文档均为 **120** | 已清（注释现为「缺省 120（§5.3）」） |
| 2 | `src/wake.ts` 注释"缺省 120_000 对齐 **§19**"——`§19` 是 v1 归档编号 | 已清（改指 §7.5） |
| 3 | `src/link/corpus.ts` 注释标 **§16**——v1 归档编号 | 已清（改指 §13.4） |
| 4 | 根 `README.md` 仍称 `packages/mud-core2` 是"当前唯一生产路径"并提供 `pnpm dev:core2` | 已清（改写为在役/退役表，§17.2） |
| 5 | `AGENTS.md` 检索规则指向不存在的"§1 不变量 / §2 术语"、`doc/flows/`、`doc/history/` | 已清（改写为 §0.3/§0.4 检索纪律，§17.2） |
| 6 | `doc/CHANGELOG.md` 历史行指向 `doc/plans/c5.2-…`（实际在 `doc/likely/`） | **不回改历史行**；映射登记在新条目 |
| 7 | ~~`watchStatus` 未出 `loggedIn`/`world`~~ **已完成（T11）**：`StatusRow` 窄面 + HUD 条呈现（§9.4/§9.5） | 已清 |
| 8 | 删账号后会话不销毁（宿主能力缺口） | 记为宿主侧待补面（§2.4） |

> T3（2026-10-03）复核结论：#1–#5 已在文档重写期修毕；src 注释现存 § 引用全部为现役编号或正确带版本前缀（`v2 §7.2`/`v2 §5`），无归档编号残留。

---

# §17 演进路线与后置

## 17.1 已交付期与切片索引

| 期 | 范围 | 结果 |
|---|---|---|
| **一期** | 基础设施 + MUD→agent 投递（C1–C5、C5.1） | ✅ 交付；地基验证点"行流投递通道走通 + agent 回答正确"确认 |
| **二期** | 工具面（水位线 pull 模型、`ReadMachine`、拒绝序、禁词表最小集、画面/状态推送） | ✅ 交付（实施并入三期 T2a/T2b）；两项二期预设被三期裁定取代（`mud_send` 只拒未连接；连接升格 `mud_connect`） |
| **三期** | 状态面 + 流程面 + 自主行为（T1–T4） | ✅ 交付 + 实机验收通过（2026-10-02，§16.4） |
| **文档重写** | 分层重排 §0–§17 + v1/v2 归档 + 附录提升 + 门面改写 | ✅（本次，见 `CHANGELOG`） |

## 17.2 当前待办

| # | 待办 | 依据 |
|---|---|---|
| 1 | **清理 §16.6 一致性清单**（注释与门面） | §16.6 |
| 2 | 宿主能力缺口跟踪（会话删除面 + 子会话清退/归档面） | §2.4 |
| 3 | **装配层加载冒烟可执行化**（当前为手工步骤） | §16.1 |
| 4 | T18 残留复核：真 token 压力下宿主 compaction 与表面遮蔽叠加（当前未实测）；遮蔽后 loop 的提示词规范化路径（v0.0.47 后取"后续 system 节点随历史遮蔽 + 尾节点保留"，依赖官方"规范化把当前提示词写回 head"语义，实机提示词更新例证出现时再验） | §11.2、§16.4 #8/#9 |

## 17.3 后置清单（按例证生长，本版不做）

| 项 | 触发例证 |
|---|---|
| **画面后置项（C5 遗留）**：输入回传（工具面已落地，是否仍需按使用实证评估）、NAWS/resize 回传、send 回显与 MUD 自回显去重开关、画面历史持久化（headless 屏随 runtime 存活，插件重启即清；s2 聊天栏行环同理随 runtime 存活） | 对应需求实证出现 |
| **分类规则扩充**（C5.2 已落地，缺省仅 `chat`；`action` 等新 kind） | 语料中出现真实误判/漏判例证（规则 Config 可加，§6.3） |
| **流程扩展**（词汇表扩展、参数化 `args` 占位符；~~fullme/验证码链路~~ **已交付**，§8.17——**流程不能等人工**约束随之废止，流程挂起等人工已是常规路径） | "JSON 词汇表表达不了"的例证 |
| **规则层**（`swallow` 吞行动作、`danger` 危险判据） | 行级规则实证需求（`swallow` 钩子管道已留，§5.2） |
| **意识层**（系统驱动 `abortWait` 打断） | 系统级打断实证需求（`abortWait` API 已保留；`failOn` 已覆盖 agent 驱动打断） |
| **投递策略化**（字段化摘要、按需投递、水位窗口细化；含超长回合持续刷屏的 turn 内强刷） | 投递内容膨胀实证（token 账目恶化，§8.16） |
| **子级 deadline / 预算 interrupt**（插件侧到期打断） | 子 agent 超时/失控实证（本版委派为一次性前台，取消通道 = 调用 `signal`；插件侧到期打断需宿主 interrupt 面 + 例证） |
| **`ask` 超时**（`askTimeoutMs`） | 确认"无人应答必须超时"的实证需求（宿主原生 = 永久挂起，§2.4） |
| **会话计数 / 账目 per-runtime** | 成本验收需求出现（先看宿主 telemetry / 原生会话事件） |
| **禁词表 Config 化** | 实证发现新危险命令需按例加行时（§12.3） |
| **v2 归档资产再评估**（五层心智、T2 闭环与三唤醒源、预算与释放阀门、记忆三分、成本与计数口径、P1 预案档） | 按需求例证**逐条**引入；清单见 [archive/README.md](../archive/README.md) §6 |
| **v1 归档资产再评估**（不变量 I1–I16、五站消费链、形态 C + B3、看门狗表、权限三档、人工环节、loop-sim 账目纪律） | 同上；清单见 [archive/README.md](../archive/README.md) §5 |

## 17.4 已落地：C5.2 行打标与画面分屏（2026-10-03）

- **需求**：把聊天、其他玩家的动作从游戏输出中提取到副屏窗口——方便人观察 + 帮 agent 去噪。
- **安全前提**：**聊天不进 agent**（AI 识别/发言有封号风险）；投递侧直接剔除有标行（含他人动作，缺省，§6.3）。
- **状态**：**已落地**（2026-10-03，v0.0.33）——`MudLine.kind` 单点打标 + 副屏有界行环 + 帧双串 + 投递剔除 + webui s2 聊天栏；正式口径见 §6.3（投递剔除）、§9.4（画面通道双屏）；实施记录与偏差见 [doc/likely/c5.2-line-tagging-split-screen.md](../likely/c5.2-line-tagging-split-screen.md)。
- **缺省规则**（2026-10-03 语料校准 + 实机房间语料）：`chat`（`^\s*【[^】]{1,6}】`）、`action`（他人动作/进出，锚行尾 + `^(?!你)` 主语排除——自身活动一律「你」开头；战斗接近不收，留给 danger 判据）、`vitals`（他人状态刷屏，同主语排除；**自身状态/警告保留主屏**）；**房间说话暂不打标**（等漏出量实证再按「非你主语」补）。规则可 Config 覆盖/关闭。

## 17.5 生长纪律

1. **无例证不引机制**：任何新机制必须先有**实证触发条件**；先扩投递/唤醒这类已验证通路的**参数**，不动结构。
2. **新通路受闸门**：一切 MUD→agent 的新通路落地时**必须**以"已接入"为前置（§6.3、§12.5）。
3. **状态出口面向全体 agent**：新增自主行为前先确认"状态/现场能被根读到"（§10.5）。
4. **同一事实只写一处**：新增设计只改**归属章节** + `CHANGELOG` 一行；起草先在 [PLAN.md](../PLAN.md) 成型。
5. **归档只读**：被否决的设计整体移入 `doc/archive/`（§0.5）；归档中的参考资产按 §17.3 逐条评估。

> AI生成
