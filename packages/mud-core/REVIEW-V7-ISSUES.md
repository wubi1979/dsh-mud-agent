# mud-core V7 实施审查问题清单（已用真实抓包核对）

> 状态：**审查结论落档，未修改任何源码**。基线：`tsc -p tsconfig.json --noEmit` 退出 0；
> `vitest run tests` **12 文件 / 148 用例全绿**（与 REFACTOR-V7.md §九 一致）。
>
> 来源：两轮独立代码审查（本清单为合并去重版）+ 真实 pkuxkx 抓包核对。
> 抓包文件：`probe-2026-09-10T10-45-34-512Z.log` / `.bin`（主样本，21 命令）、
> `probe-2026-09-10T03-44-46-144Z.bin`（交叉验证）。
>
> 级别定义：**P0** = 正常使用即失效/卡死；**P1** = 能力静默失效（动作/文本丢失）；
> **P2** = 时序与归属（偶发、难查）；**P3** = 观测/安全/已知项。

## 一、核对方法与样本事实

| 事实 | 数值/内容 | 用途 |
|---|---|---|
| 命令 / IAC GA | **21 / 21**（1:1） | 证实 GA 主边界；P3-2 降级依据 |
| GA 延迟（命令→GA） | 1 ms – 602 ms（多数 30–160 ms） | 远小于静默窗 2s → 静默先于 GA 未出现 |
| RX 块 | 94 | 单帧常跨 1–5 块；dz 推送逐块到达 |
| 服务器回显命令 | **无**（`vicrly`/`Xiunyu123` 仅出现在 TX） | 证实无需 echo 剔除；定位明文泄漏只在本地 |
| 分页 | `lm` 与翻页空格各为独立命令 + 独立 GA；页面结束**无 prompt** | P2-2 / P2-4 证据 |
| dz（长程） | 受理帧 46:29.951 GA + `PROMPT >`（2 行）；随后 **56 批 / 约 57s 无 GA 无 prompt**（~1 批/s）；完成句与末条推送同块（#94，248B） | P1-3 / P1-4 决定性证据 |
| sleep | 51.902 发送 → 51.926 GA（受理）；唤醒两行在约 28s 后到达，**无 GA 无 prompt** | 空闲观察窗路径 |
| 登录提示真实形态 | `您的英文名字：`（GA 刷出的短形态）与 `您的英文名字（要注册新人物请输入new。）：编码已改为UTF-8。`；密码提示 **`此ID档案已存在，请输入密码：`**；完成 `目前权限：(player)` | P0-3 证据；`entry`/`terminal` 规则正确 |

## 二、问题清单（修正后优先级）

### P0 — 正常使用即失效/卡死

#### P0-1 一次断线后命令桥永久失效（重连也救不回）
- **位置**：`network/response.ts:293-304`（`close()` 置 `disposed = true`，无处复位；检查点
  `191/255/343/361`）；`index.ts:295`（controller 为 apply 期单例）；
  `index.ts:650`（每次 `client.on('close')` 都调 `controller.close()`）；
  `index.ts:625`（重连只 `controller.clear()`，不清 `disposed`）。
- **机理**：`close()` 是**终止性**语义（`response.spec.ts:250-257` 明确断言"关闭后新请求
  reject"），但宿主把它当"每次断线清理"用，且从不重建 controller。`clear()` 只清行集表。
- **影响**：首次断线（含 `connect()` 清理旧 idle client 触发的 close）之后，所有
  `sendAndAwait` 一律 reject（`控制器已关闭`），`sendFireForget` 静默丢弃 → 工具全失败、
  手动命令失效，只能重启 host。抓包为单连接样本，未覆盖重连，故未被回归发现。
- **修法**：控制器增 `reopen()/reset()`（清 `disposed/live/pending`），`connect` 事件调用；
  或每次连接重建 controller（工具闭包经可变 holder 取值）。
- **验收**：新增用例「close → 重连 → sendAndAwait 成功结算」。

#### P0-2 `sending` 状态零兜底 → 发送失败即时死锁
- **位置**：`index.ts:365-372`（`const sent = sendCommand(cmd); if (sent && meta?.replyId) confirmSent(...)`）；
  `network/response.ts:455-468`（`armTimers` **仅在 `confirmSent` 后**武装）与 `359-376`（pump）。
- **机理**：请求被 pump 到宿主队列后处于 `sending`。`sendCommand` 返回 false（
  `!c || c.state !== 'connected'`，`index.ts:277-289`）或抛异常时**不调 `confirmSent`** →
  该请求既无超时定时器也无静默窗 → `Promise` 永不结算 → DSH loop 该步永久驻留；
  `inFlight()` 恒 true → 后续观察行全部堆入 `headBuf`、pending 永不 pump → **整桥死锁**。
- **可达路径**：连接尚在 `connecting` 时就有命令要发（登录看门狗 90s 升级 T2 → T2 发命令；
  或规则反射在 connect 事件前触发）；写 socket 抛异常的窗口。
- **修法**：控制器增 `sendFailed(replyId, reason)`（settle 成 `error` → 工具 throw → 回合
  error），宿主在 `sent === false`/异常时调用；同时把保护超时提前到 `pump`（`sending` 超
  `defaultTimeoutMs` 未武装 → settle `error`）。**必须与 P0-1 同批修**，否则一次发送失败
  会被 P0-1 变成永久卡死。
- **验收**：mock 宿主 `send` 失败/抛异常 → 工具 reject 且桥恢复可用。

#### P0-3 `login:pass` 规则与真实密码提示不符 → 老号复登必定卡死（抓包新发现）
- **位置**：`config/trigger-rules.ts:78`（`/^(?:ID已存在，)?请输入密码[：:]\s*$/`）、
  `:258-266`（`login:pass`）、注释 `:261-262`（声称抓包实证为"ID已存在，请输入密码："）；
  REFACTOR-V7.md §九 亦据此宣称已修复。
- **证据**：两轮抓包原始字节**均为** `此ID档案已存在，请输入密码：`
  （`probe-…03-44-46.bin`、`probe-…10-45-34.bin`）。可选前缀 `ID已存在，` 与
  `此ID档案已存在，` 不同 → 锚定 `^` 失败 → 规则永不命中。注释中的"实证文本"属转写错误
  （漏"此"与"档案"）。
- **影响路径**（对照时间轴）：`您的英文名字：`(35.929 GA) → T1 发名字 → 帧收 GA(35.955)
  含该提示 → 续步 T1 **miss → `finish stop`** → 密码永不发 → 登录静默卡住 → 90s 看门狗
  升 T2。**当前"登录 T1 重建"实际不可用。**
- **修法**：`pass` 形态补全为 `^(?:此ID档案已存在，|ID已存在，)?请输入密码[：:]\s*$`
  （或按抓包放宽前缀）；注释改为真实文本；单测以**真实文本常量**为准，避免再次转写漂移。
- **验收**：`tests/login-rules.spec.ts` 新增以 `此ID档案已存在，请输入密码：` 为输入的用例。

### P1 — 能力静默失效

#### P1-1 超时 tool result 被 `工具拒绝:` 前缀破坏 → T1 无法按 B.3 处置（对方发现 2，复核成立）
- **位置**：`agent/tools.ts:104-107`（`OUT_RENDER`：`value.ok ? value.note : \`工具拒绝: ${value.note}\``）；
  `network/response.ts:418-430`（timeout 以 `ok:false` resolve）；`320-338`（`resolveLines`）；
  `trigger-llm/adapter.ts:105-116`（tool-tail 续步判定）。
- **机理**：超时是 `ok:false` → tool result 变为 `工具拒绝: <帧文本>[应答超时…]`；`resolveLines`
  剥标记后仍带前缀，精确失配，前缀启发式也失配（store 键为帧文本，两边都不是对方前缀）
  → 返回 null → adapter 收束。
- **影响**：机制 B.3"超时交本回合所有者决策（T1 可反射重试）"**只对 T2 有效**；前缀还污染
  LLM 可见的工具结果。
- **修法**：`render` 依 `settled` 区分"桥超时（成功结果携带错误文本）"与"工具校验拒绝"；
  或在 `resolveLines` 剥离 `工具拒绝: ` 前缀。
- **验收**：`settled='timeout'` 的 reply 经 render → `resolveLines` 精确还原行集，T1 规则可命中。

#### P1-2 `until` 锚定整行正则永不命中 → 声明边界只能挂到声明超时
- **位置**：`network/response.ts:263`、`283`、`486-494`（`testUntil(regex, reply.text)`）；
  `preprocess/index.ts:18-20`（`textOfLines` 以 `\n` 拼接）。
- **机理**：对**多行累积文本**用无 `m` 的整串 `test`。REFACTOR-V7 §二 规定 until 为
  "锚定整行正则、复用 v6.5 感知匹配引擎"，而 `/^…站了起来。$/` 在 `"北大街\n你站了起来。"` 上
  恒为 false → 声明请求只能等 120s 声明超时。单测用的是无锚定 `[0-9]{4}`
  （`response.spec.ts:83`），掩盖了该缺陷。
- **抓包证据**：dz 完成句 `你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。`
  与 sleep 唤醒句 `你一觉醒来，精神抖擞地活动了几下手脚。` 都是自然单行锚定形态。
- **影响**：长程命令 `until` 形同虚设；**很可能是 §九"登录 until 锁帧挂 timeout"的真实根因**
  （文档归因于"下一步信号形态多样"）。
- **修法**：按行测试（遍历 `reply.lines`）或给正则加 `m`；补锚定正则用例；修好后重评登录
  段是否需要 `until`。

#### P1-3 观察窗路径 T1 反射静默失效（= 对方发现 1 + 我方两条，合并）
两个叠加缺陷：

**(a) 多批合并 → `resolveLines` 只能还原第一批**
- **位置**：`index.ts:298-331`（`observeBuf` 逐批 push，`flushObserve` 合并注入）、
  `index.ts:341-353`（`judgeAndInject` 用合并文本）、`network/response.ts:268-271`（无主分支
  按**每批** `record`）、`386-395`、`320-338`（精确失配后走"最长前缀"启发式）。
- **机理**：store 只有每批的键，注入用合并文本 → 精确 miss → 前缀启发式返回"最长前缀"的
  单个批（常见即第一批）行集。
- **抓包证据（决定性）**：dz 渐进推送 **56 批 / 57 行 / 约 57s 无 GA 无 prompt**
  （46:31.003 → 47:26.354）；完成句与最后一条推送**同在一个 248B 块**（#94）。静默窗逐行
  重置，故整体只 flush 一次 → 合并文本 → 完成句所在的**最后一批**永远还原不到。
- **影响**：2s 静默窗内多批突发（dz 推送、睡醒、房间大输出分块）的**第一批之后**规则全部
  静默丢失，而 `judgeAndInject` 已按全批判 t1 → 注入后 T1 收束，动作永不执行。

**(b) multiline 状态双跑 → 观察窗触发的多行规则只分类不渲染**
- **位置**：`index.ts:349-350`（判类用 `eventMatchService.match`）与
  `agent-bridge.ts:86-93`（adapter 再 match 同一批行）**共用同一实例**；
  `trigger-llm/service.ts` 的 `Perceptor.feedMultiline`（`line.abs <= multiLastAbs` 单调保护）。
- **机理**：判类先推进 multiline 状态机并把 `multiLastAbs` 推到该批末行；adapter 再 match
  同一批行时被整体跳过 → 命中结果丢失。
- **影响**：观察窗路径上的多行 event 规则（如 `login:replace-confirm`）永不渲染（帧路径不受
  影响，故暂未暴露）；违反 REFACTOR-V7 C.7"判类与 T1 渲染不双跑"的本意——只丢了结果，
  没有隔离状态。
- **修法**（三选一/组合）：`flushObserve` 前把整批登记（Controller 公开 `cacheLines(batch)`）
  使精确命中；`Perceptor` 增不写 ctx 的 `peek/classify` 供判类；或逐批切分注入。
- **验收**：2s 窗口内 ≥3 批且规则命中第二批 → 反射生效；观察窗触发的 multiline 规则可渲染。

#### P1-4 dz/sleep 类"完成句驱动反射"当前无可用通路（抓包新发现）
- **结构事实**：dz 受理即 GA（帧=2 行）→ 完成句 57s 后、无 GA 无 prompt；sleep 同理。
- **两条候选通路都被堵**：① 声明 `until` 依赖 P1-2 修复；② 观察窗通路依赖 P1-3 修复。
- **修法**：批次 2（P1-1/P1-2/P1-3）完成后，为 dz/sleep 首批声明 `until`
  （dz：`^你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。$`；
  sleep：`^你一觉醒来，精神抖擞地活动了几下手脚。$`），并按需评估观察窗合并策略。

### P2 — 时序与归属

#### P2-1 所有权回扫 24 节点上限 → 长回合中途翻回 T1
- **位置**：`agent-bridge.ts:111-129`（`scanned < 24`，按**节点**计数，assistant/tool-result 也计入）。
- **影响**：T1/T2 混合的长回合（约 12 步后）扫不到 `mud-owned` 消息 → 返回 null → 回退 T1，
  违反"回合内所有权稳定"。
- **修法**：以最近一条 `turn/start` 为下界回扫，或上限按单回合步数放宽。
- **验收**：长工具链（>24 节点）用例断言所有权不翻转。

#### P2-2 命令序列按"一帧"处理，但每条命令各有一个 GA
- **位置**：`agent/tools.ts:279-292`（`cmds` 序列）、`network/response.ts:186-190`（注释
  "序列 = 同一次应答的一个帧"）、`379-383`（同 replyId 逐条穿透）。
- **抓包证据**：分页 `lm`(50.892) 与翻页空格(50.988) 各为独立命令、各有一个 GA
  （50.988 / 51.022）。
- **影响**：首个 GA 即结算整个序列，后续命令输出/GA 落到观察窗或下一帧；`['', 'look']`
  这类序列语义不确定。
- **修法**：序列改逐条 await 串行结算，或收窄为"单命令 + 无应答成员"并在 schema/文档写明。

#### P2-3 手动命令旁路应答对象 → 帧归属污染
- **位置**：`network/response.ts:341-345`（`sendFireForget`）、`index.ts:806-810`
  （service `sendCommand` 直发，连队列都不过）、`index.ts:277-289`。
- **影响**：手动命令不在 controller 的 pending FIFO 内，却产生输出与 GA → 在途帧期间其 GA
  会结算 agent 的帧，命令↔GA 计数失衡，且绕过节流。
- **修法**：在途期间把手动命令纳入 controller 计数（或返回 busy）；至少让 service 走
  `queue.send`。

#### P2-4 分页语义：每页独立命令，且页面结束无 prompt（抓包新发现）
- **证据**：`lm` 页尾为 `== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)`（**换行行，
  非 prompt**）→ GA(50.988)；空格 → 图例 + `PROMPT >` → GA(51.022)。
- **结论**：分页规则应**逐页发命令（一页一 step）**，不要用命令序列（P2-2）；规则作者不能
  假设"帧必以 prompt 行结尾"；"分页下沉"（V7 待定 9）收益有限（每页仅 GA 往返 ~30–150ms）。

### P3 — 观测/安全/已知项

| 编号 | 问题 | 位置 | 证据/说明 | 修法 |
|---|---|---|---|---|
| P3-1 | 登录密码明文写入终端缓冲 + 日志 + WS（与"明文不落任何通道"承诺矛盾） | `index.ts:271-289`、`agent/tools.ts:243-246`、`index.ts:594` | 抓包证实**服务器不回显**（唯一泄漏点是本机 echo/日志）；xterm 会展示明文密码 | 凭据类命令在 echo/日志掩码（`CommandMeta.redact`） |
| P3-2 | 孤儿 GA：silent/timeout/abort/until 结算后迟到 GA 会提前结算下一帧 | `network/response.ts:398-452`、`278-290` | **本抓包未观察到**（GA 延迟 1–602ms ≪ 静默窗 2s）；abort 路径仍存（取消后迟到 GA 可截断下一帧） | 非 GA 路径结算时 `orphanBoundary += 1`，`boundaryReceived` 见计数 >0 丢弃并 -1；与声明链"开头 GA 早到"一并设计 |
| P3-3 | `exec` 通道未传入工具层：`ReplyOptions.signal` 恒空（取消不撤在途命令，需等静默/超时）、`concludeTurn` 未接 | `agent-bridge.ts:230-245` | 文档已记（§九-6） | 传 `exec`，接 `exec.signal` 与终点 conclude |
| P3-4 | controller / 匹配服务 / `t1Registration` 均模块级单例 | `index.ts:295`、`agent-bridge.ts:44-48` | 与 P0-1 同一失效面（重连/HMR/多连接） | 随 P0-1 收进连接实例 |
| P3-5 | 帧与观察窗均无上限 | `network/response.ts:254-272`、`index.ts:319-337` | 抓包：dz 观察窗 **56 批/57 行**合并为一条；声明 until 的帧会累积同量级 | 加行数/字节上限强制结算；评估观察窗"仅保留尾部 N 行" |
| P3-6 | 规则（T1）渲染的工具调用被记为 `[agent] 调用 …`；看门狗 `if (!agent) return` 在 agent 晚建 + 登录零文本时不布防 | `agent-bridge.ts:239-243`、`index.ts:542` | 注释称"规则命中不经过这里"与实际不符（adapter `onRender` 已有留痕） | 按 `mud-trigger-` 前缀或显式标记区分归因；agent 就绪后补一次布防 |

### 已否证项（省一次排查）

**对方发现 4（T2 控制唤醒劫持 T1 续步）不成立**：`sendOwnedOutput` 走 `next-turn`
（`agent-bridge.ts:276-278`），而 `send()` 只写 `agent/inbox/spliced` 事件
（`deepseek-harness/packages/core/agent-loop/src/inbox.ts:230-238`）——**该事件不是 surface
消息事件**，消息只有在被 `claim` 进入某回合的 `decision.messages` 时才成为 surface 上的
user 消息；因此 t2 控制消息不可能出现在一个正在运行的 T1 回合中途，只能等该回合结束后
开新回合。抓包中亦无此现象。真正的所有权风险只有 P2-1（24 节点上限）。

## 三、两轮审查去重映射

| 合并编号 | 本清单（另一轮） | 本轮 | 抓包结论 |
|---|---|---|---|
| P0-1 | ✔ | — | 单连接样本未覆盖（代码事实成立） |
| P0-2 | ✔ | 发现 3 | 未出现（代码事实成立） |
| P0-3 | — | — | **抓包新发现，已证实** |
| P1-1 | — | 发现 2 | **成立**（代码事实） |
| P1-2 | ✔ | — | 证据强化（dz/sleep 锚定形态） |
| P1-3 | ✔（两条） | 发现 1 | **已证实**（dz 56 批） |
| P1-4 | — | — | **抓包新发现** |
| P2-1 | ✔ | — | 未观测（代码事实） |
| P2-2 | ✔ | — | **已证实**（分页两条命令两 GA） |
| P2-3 | ✔ | — | 未观测 |
| P2-4 | — | — | **抓包新发现** |
| P3-1 | ✔ | — | 服务器不回显 → 泄漏仅在本机 |
| P3-2 | ✔ | — | 未观测 → 降级 |
| P3-3/3-4 | ✔ | — | — |
| P3-5 | — | 次要 2 | 证据强化（56 批） |
| P3-6 | ✔ | 次要 1 | — |
| — | — | 发现 4 | **否证** |

## 四、修复批次计划

- **批次 0（最小改动、收益最大）**：P0-3（`login:pass` 形态 + 真实文本单测）。
  验收：以 `此ID档案已存在，请输入密码：`、`您的英文名字：` 为输入的规则用例通过。
- **批次 1（桥可用性）**：P0-1 + P0-2。验收：新增「close→重连→可发送」「send 失败→工具
  reject 且桥恢复」；149+ 用例全绿。
- **批次 2（文本↔行还原链）**：P1-1 + P1-2 + P1-3（`cacheLines` + `peek` 判类 + until 逐行/
  `m` + render 区分超时），完成后接入 P1-4（dz/sleep `until` 首批规则）。
  验收：超时文本可被 T1 反射；锚定 until 命中；观察窗第二批反射生效；观察窗 multiline 渲染；
  dz 完成句触发规则。
- **批次 3（归属与边界）**：P2-1 + P2-2 + P2-3 + P2-4（分页规则逐页化）。
- **批次 4（观测/安全/收尾）**：P3-1 … P3-6（密码掩码可提前并入批次 1）。

## 五、REFACTOR-V7.md 需同步修订的条目

1. §二"until 复用 v6.5 锚定整行匹配引擎"与实现不符（P1-2）→ 修实现后重评 §九"登录 until
   不可用"的结论；
2. C.7"判类与 T1 渲染不双跑"需补**状态隔离**（不仅是"结果丢弃"）（P1-3b）；
3. §二 帧规则 3"序列 = 同一次应答的一个帧"按 P2-2 改写；
4. §八-3"帧内提示符行保证 tool result 恒非空"对空输出命令与分页帧（无 prompt）均不成立
   （P2-4），措辞收紧；
5. 新增"桥的生命周期与失败语义"一节：重连复用（P0-1）、发送失败（P0-2）；
6. §九 登录段：`login:pass` 实证文本改正（P0-3）；`login:until` 撤除结论重评（P1-2）；
7. 机制五-2 的"迟到 GA 丢弃"推广到 silent/timeout/abort/until（P3-2）；
8. 机制 A 抓包依据补充 **dz/sleep 结构**（受理 GA + 渐进推送无 GA + 完成无 GA）（P1-4）。

## 附录：关键抓包片段（主样本）

```
# 登录: 短名提示与真实密码提示（P0-3 / entry / terminal）
[10:45:35.929] TELNET IAC GA      → PROMPT 您的英文名字：
[10:45:35.955] TELNET IAC GA      → PROMPT 此ID档案已存在，请输入密码：
TXT   目前权限：(player)

# dz: 受理帧（GA 结算）与 56 批渐进推送（无 GA 无 prompt）
[10:46:29.951] TXT   你盘膝坐下，默运太极神功，一股内息自丹田引出……
[10:46:29.951] TELNET IAC GA      → PROMPT >
[10:46:31.003] RX 块 #39 … TXT   ......你只觉内息在带脉内回荡…
…（略 55 批，均 ~1 批/秒，无 GA）…
[10:47:26.354] RX 块 #94 (248B) TXT  ......（末条推送）
[10:47:26.354] TXT   你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。
（其后无 GA、无 prompt，直到会话结束）

# 分页: 每页独立命令 + 独立 GA；页面结束无 prompt
[10:45:50.892] TX 命令 "lm"
TXT   == 未完继续 88% == (q 离开，b 前一页，其他继续下一页)
[10:45:50.988] TX 命令 " "   /  TELNET IAC GA
[10:45:51.022] TELNET IAC GA  → PROMPT >
```
