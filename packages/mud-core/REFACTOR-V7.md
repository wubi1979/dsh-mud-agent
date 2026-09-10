# mud-core 重构与协议审查综合记录

> 本文档由 `REFACTOR-V6.md`（v6.2 ~ v6.7 重构记录）、`PROTOCOL-REVIEW.md`（协议层 vs Mudlet
> ctelnet 数据流/登录实测审查）与原 V7 设计稿（命令-应答桥与输入路由设计）三份文档**合并归纳**
> 而成（2026-09-10），原文件已删除，合并结果以本文件名 (`REFACTOR-V7.md`) 存档。
>
> 章节编号沿用原文档（机制 A/B/C、v6.x、R1-R5、§1b 等），代码注释与 `REVIEW-V7-ISSUES.md`
> 中的相关引用由此一一对应。状态标注为合并时点快照，后续改动以其时点为准。
>
> 源码侧对应：`src/network/response.ts`（命令-应答桥核心）、`src/network/telnet.ts`（协议
> 加固）、`src/index.ts`（feed 路由/观察窗/登录看门狗）、`src/agent/{agent-bridge,tools,
> execution}.ts`、`src/trigger-llm/{types,service,adapter}.ts`、`src/config/trigger-rules.ts`。

---

## 0. 演进主线（为什么是现在这个形态）

- **v6 之前**：只在真实 LLM 前做快速拦截 → 拦截直连执行导致会话出现非 loop 产物、伪输出缺
  loop 凭据 → 演化为「模拟 LLM（T1）」进入 loop 以获取合法历史 → 瀑布（error/retry 路由）。
- **v6（单路径级联 + 匹配服务化）**：游戏文本统一进 agent；状态/事件规则分桶；锚定整行正则 +
  捕获组提取；登录 T1 确定性登录。
- **协议审查（PROTOCOL-REVIEW）**：对照 Mudlet ctelnet.cpp 三轮真实抓包，证伪"选编码是阻断项"、
  修正登录规则、新增分页自动翻页；定位裸 IAC / 无界子协商 / MCCP2 损坏 / EOR 四类协议差异。
- **V7（命令-应答桥）**：机制 A 由"通用 prompt 文本分帧"重写为 **GA 主边界 + 声明边界 +
  静默兜底**；命令-应答同步化；判类前移（输入侧判类）+ 执行留 loop（T1 模拟 LLM 身份执行）；
  T1/T2 所有权随注入消息元数据走，不再瀑布交棒。

**核心结论（已确认）**：

1. 会话历史必须由 agent loop 生成才合法（turn/step、事件信封、seq、surface fold、projection
   均归 loop）。**不做**「loop 外执行 + 手工伪历史」。
2. 「在进入真实 LLM 前解决已知问题 + agent 能看懂日志」的唯一交集解 = **判定前移（输入侧判类）+
   执行留 loop（以 T1 模拟 LLM 身份执行）**。
3. T1/T2 的"安排"不是核心问题；核心是上一条 + **命令-应答同步化**（机制 A）。

---

## 一、v6 重构记录（v6 → v6.7）

> 状态：已实施（2026-09-08 会话）。结局：build EXIT=0；v6 末 9 spec / 81 用例全绿，
> v6.7 末 10 spec / 114 用例全绿；`src/perception/` 与 `trigger-llm/{marker,router}.ts` 已删除。

### 1.1 目标架构：单路径级联

不再有"路径 A / 路径 B"双路径，游戏文本统一进 agent：

```
游戏输出 (telnet) → AnsiStreamParser 切完整逻辑行（自分配 abs，行号游标归解析器）
  → feedParsed（T1 模拟 LLM / 匹配服务）
       state 预匹配折叠：提取落库 world + 命中行移除（不进 agent）
       event 匹配缓存 + 整批文本进 agent
  → agent → mud-cascade 级联 provider:
       T1 (确定性): trigger-llm 命中规则 → 渲染动作 (文本 + tool-call)，不调真实 LLM
       T2 (真实 LLM): 未命中 → 转发 agentDefaultModel 的真实 provider/model
  → 工具调用 (mud_move / mud_look / mud_status / mud_send / world_patch) → 游戏
GMCP 直连 (StateService.onGmcp) → 权威同步 world (置信度 1.0)
文本语义 → agent 用 world_patch 工具落库 (置信度 0.7, GMCP 优先)
```

### 1.2 结构与文件变更（v6）

| 变更 | 文件 |
|---|---|
| 移动 | `src/perception/ansi.ts` → `src/preprocess/ansi.ts` |
| 新增 | `src/preprocess/index.ts`（薄入口: re-export ansi + `textOfLines`） |
| 重建 | `src/trigger-llm/{types,service,adapter,index}.ts`（v6 → v6.2 语义） |
| 精简 | `src/world/state.ts`（GMCP-only；删事件总线/感知订阅） |
| 删除 | `src/perception/` 整目录、`trigger-llm/{marker,router}.ts`、`tests/{perception,trigger-lite}.spec.ts` |
| 更新 | `index.ts`、`service.ts`、`network/telnet.ts`、`config/trigger-rules.ts`、`agent/{agent-bridge,tools}.ts`、`tests/{ansi,multiline,cascade}.spec.ts` |

### 1.3 v6.2 追加：匹配服务抽离

- **AnsiStreamParser 自分配行号**：`write()/flush()` 产出 `MudLine[]`（携带自分配递增 `abs`），
  不再由装配/适配层分配。
- **匹配服务分桶**：`TriggerMatchService`（独立实例），`registerCascadeProvider` 按 `lane` 建
  state / event 两个实例：
  - `stateMatchService`：预匹配折叠（状态/观察 → world），命中行移除（不进 agent）；
  - `eventMatchService`：agent 内 T1 渲染（事件/决策 → 确定性动作），并缓存行供 T1 转发。
- **运行态与规则分离**：`MatchContext`（`multiStates`/`multiLastAbs`）从 `NormalizedTriggerRule`
  拆出，由 `Perceptor.match(lines, ctx)` 传入；每个 TriggerMatchService 持有独立 context。
- **T1 输入改为标准行**：`TriggerLlmAdapterHooks.matchLines(lines: MudLine[])`；未命中转发时
  用 `.map(l => l.text).join('\n')` 重建尾部 user 文本块。
- **预匹配折叠接线（feedParsed）**：`stateMatchService.match(lines)` → extract 落库 、命中行按
  `abs` 移除不进 agent → 剩余行 `eventMatchService.feedLines(lines)` 缓存 + 整批文本进 agent。
- **v6.2 数据流**：见 1.1 节代码块。
- **v6.2 已知未接线**：
  - `stateMatchService.feedLines()` 暂注释未接（state 在 feedParsed 同步消费）。
  - 颜色折叠联动：state 命中行折叠移除后，颜色类 state 规则命中行同样移除（`abs` 唯一判据）。

### 1.4 触发器模型与匹配服务（v6 → v6.2）

- `PerceptionRule` = 捕获字段（contains/regex/color/guard/extract）+ `action?: ActionSpec`；
  `ActionSpec { output; tool?; send? }`；`PerceptHit` 可带 `action`；新增 `MatchContext`/
  `MultiMatchState`（运行态）。无事件、无组、无进程状态机（多行状态机保留）。
- `Perceptor`：纯匹配器 `match(lines, ctx)`；`TriggerMatchService` 入口 `match(lines)`
  （内部自管 ctx + `recentLines` 缓存 + `feedLines`/`getRecentLines`）。
- **级联适配层**（阶段行走器 v6.3）：每次调用重读 `stages()`，逐级：aborted → 结束；
  `trigger` 级（内容级去重 → `matchLines` 命中渲染全部动作 / 未命中交下级）；`model` 级
  （`prepareCall` 拒绝或首块硬失败 → 关迭代器交下级；其余 commit 转发整流；空流空 stop）；
  数组耗尽 → **尾部默认级** `agentDefaultModel.currentSelection()`，无选择 → 空 finish(stop)。
- 注册：`registerCascadeProvider(ctx, { stateRules, eventRules, world, log })`；
  瀑布容器 = `cascadeStages` 模块级（默认 `[{t1 trigger}]` + 尾部隐式默认）；
  `setCascadeStages()/getCascadeStages()` 外部注入/重读。
- **装配**：`agentOptions = { provider: 'mud-cascade', model: 'cascade-v1' }`；不再
  `installModelSelection`。`mimic` config 与 `ctx.mud.setMimicEnabled()` 已删除（v6.3），
  T1 开关由瀑布数组 `enabled` 表达，完全不用真实 LLM = `agentEnabled:false`。
- **状态捕获**：`StateService(StateServiceOptions{world, onChanged})` + `onGmcp` 直连。
- **工具**：新增 `world_patch`（patch → `applyPatch` → 返回变更字段）；构建时注入 world。
- **规则**：状态类规则（combat:start/end/death）action → `world_patch`；`save:prompt` →
  `mud_send save`；`room:busy` 无 action（观察类）。

### 1.5 v6.4 登录 T1（确定性登录 + 会话凭据插值）

- **凭据归属**：登录凭据与会话绑定——`sessionCredentials: Map<sessionId,{name,pass}>`，
  `setSessionCredentials`（connect 时写入）、`getSessionCredentials`。
- **插值通道**：adapter 可选 `resolveToolArgs(args, sessionId)` 钩子；bridge 注入
  `interpolateCredentials()` 替换 `{name}`/`{pass}` 占位符。
- **登录规则**（event 桶）：`login:name`（名字提示 → mud_send `{name}`）/ `login:replace-confirm`
  （同名覆盖 → `y`）/ `login:pass`（密码提示 → mud_send `{pass}`）/ `login:done`
  （欢迎横幅 → world_patch `logged_in:true`）。
- **中止语义**：不新增限次/中止机制——T1 死局交棒尾部真实 LLM，失败终态由 DSH 兜底。

### 1.6 v6.5 锚定整行正则 + 捕获组提取（准入/提取重构）

- **动机**：宽松 `contains` 子串匹配极易被聊天/帮助误触发。把 `contains` 从准入语义移除，
  匹配判据唯一收敛于 `regex`（作者自写首尾锚定）。
- **两段式匹配**：预筛（候选集）由锚定正则**字面前缀自动推导** seed——`^字面…` → prefix，
  否则必需字面段 → substring；无字面前缀全量跑。命中判定永远由二级正则承载；
  不变式 `Pr(命中 | 预筛跳过)=0`。准入+提取：锚定正则 `.test` → 首个匹配正则的命名捕获组 →
  `map`（组名→点分键）组装 `hit.data`，`numeric` 数值化。
- **多行**：`buildMultiConds` 只认 `patterns` 或 `regex`（contains 来源删除）。
- `PerceptionRule` 变更：删 `contains`；新增 `map?`、`numeric?`；`extract` 降级为逃生舱。
- **trigger-rules.ts 迁移**：login 4 条全锚定；state:hp/score 拆为**每字段一条规则**；
  `state:look` 因多行复合提取保留 extract 逃生舱；parseVitals/parseScore 函数删除。

### 1.7 v6.7 准入语义修正（架构审查会话）

- **动机**：`ruleHit` 旧回退 `return rule.color !== null || !!rule.extract` 使 color/extract
  在**主判据未命中**时仍准入：`state:look`（func+extract）对批内每行都命中并运行窗口 extract
  污染 world；带 color 规则被颜色**单独触发**破坏"同词异色"区分。
- **变更**：`命中 = 主判据(regex/text/func) 命中 ∧ color(声明时, 补充判定 AND) ∧ guard`。
  color 只做命中后的颜色区分、extract 只做准入后的程序化提取——**二者绝不单独准入**。
- **纯颜色触发形态**：用 `match: { kind: 'func', test: () => true }` + fg/bg 显式准入。

### 1.8 明确不做（v6 后续）

- **send 防御直连**：`ActionSpec.send` 字段保留但 adapter 不消费。
- **state 折叠 color 联动**：颜色触发行折叠移除引导依赖 `abs`，若需专属折叠序列再议。
- **断流计时登录守卫**：armDeadAir 保留 `!world.flags.logged_in` 抑制（登录期不自动唤醒）。

---

## 二、协议层 vs Mudlet ctelnet：数据流审查（PROTOCOL-REVIEW）

> 范围：`src/network/telnet.ts`（入站解码/协商/MCCP2）+ `src/preprocess/ansi.ts`（行/ANSI）。
> 参照物：`Mudlet/src/ctelnet.cpp`（`processSocketData`/`decompressBuffer`/`processTelnetCommand`）。
> 验证手段：`tests/probe-client.mjs` 对真实服务器 `mud.pkuxkx.net:8081` 抓包（`.log` + `.bin`）。

### 2.1 结论先行

**正常 pkuxkx 登录路径不丢字节**（3463B 横幅 + 协商，3 个 TCP 块）：三层流水线正常；
协商（TTYPE/NAWS/CHARSET/MSSP/GMCP）全部按预期应答，CHARSET 回 ACCEPTED UTF-8。
存在 **4 个与 Mudlet 的行为差异**，其中 2 个在"服务器发异常协议流"时真正丢数据，另 1 个是
登录层（非协议层）的真实阻断 bug。

### 2.2 真实全流程登录抓包（三轮 90s/180s 会话）

**第一轮（简化）+ 第二轮（完整，2026-09-10T01-26 / 01-52）**：
- **名字提示长短两版**：横幅长版 `您的英文名字（要注册新人物请输入new。）：`；选编码（回 2）后
  服务器改为短版 `您的英文名字：`，且此前插入 `编码已改为UTF-8。`。原 `login:name` 只匹配长版
  → 登录卡死。已修复为长短双正则。
- **fullme 简化模式**：长期未 fullme 时房间输出降为最简化（无 desc/exits；GMCP 仅 System/Move）。
- **GA = 命令回复边界**：17 条命令每条回复末尾 1 个 IAC GA（共 20 = 登录 3 + 命令 17），
  多数紧随 `\x1b[2;37;0m> ` 提示符。
- **被动推送无 GA**：dz 打坐 44-57 条经脉渐进输出（1 条/秒）全程无一 GA 无 `> `。
  → 靠 GA 无法覆盖被动推送，**400ms 空闲刷出是唯一可靠手段**。
- **分页界面**：`== 未完继续 NN% ==` 处任意命令被当翻页输入吞掉 → **客户端必须自动翻页**
  （对 dsh-mud 是 P1 需求）。
- 登录期即有 GA（编码选择后、名字提示、密码提示各一）；服务器有 MXP 检测（无响应自动降级），
  dsh-mud 不支持无碍；密码输入期 ECHO（WILL→DO→WONT）正常。
- 协议层零丢字节（TXT 与 .bin 逐块核对无缺失、无半截 UTF-8）。

**第三轮（2026-09-10T03-44，180s，93 块/39130B，探针自带翻页）**：
- **分页翻页生效**：`== 未完继续 88% ==` 命中即发空格，命令不被吞。`pager:continue` 探针版与
  产品版一致。
- **sleep 真实周期 ≈ 13.5s**：躺下→梦乡 GA 在 03:45:03.087，醒来句 03:45:16.547。自动化等
  20s 即够（此前"28s 未醒"是 sleep 被吞作翻页的误判）。
- **dz 完整周期 ≈ 55.8s**：发起 1 个 GA（盘膝坐下句）→ 57 条经脉渐进推送（亮紫
  `\x1b[1;35m`，无 GA 无提示符）→ 完结句 `你将运转于全身经脉间的内息收回丹田…站了起来。`
  （亮绿 `\x1b[1;32m`）——**该句是 dz 完成唯一信号** → agent 打坐任务以此判定结束。
- 期间混入公频推送（`【自创剧情】…`，37B 橙色 `[36m`）。

### 2.3 逐点对比（协议差异）

**2.3.1 子协商内"裸 IAC + 非 SE/IAC"——会吞文本**：dsh-mud `findSubnegEnd` 把 `IAC X` 当转义
跳过 `i += 2`，继续找 IAC SE → 中间全部屏幕文本被吞进子协商载荷。Mudlet 就地补 `IAC SE` 结束
并回放当前字节。pkuxkx 当前不发病例，但 GMCP 大包/编码错位等有理论触发面。
→ 建议对齐 Mudlet 就地截断（v6.7 后已并入 R2 实现）。

**2.3.2 永不终止子协商——内存无界增长**：Mudlet 有 `MAX_TELNET_SUBNEGOTIATION_LENGTH` 丢弃到
下一个 IAC SE；dsh-mud 无上限线性扫描。→ 实现子协商长度上限（±64KB）。

**2.3.3 MCCP2 中间块损坏——会话后半程永久静默（最严重）**：Mudlet 遇 Z_DATA_ERROR 关压缩
（inflateEnd + DONT COMPRESS2 + 重布防 + 未消费尾部按明文重放）；dsh-mud 只打日志，`mccp2`
仍 true、`inflate` 仍是坏对象 → 后续全部丢弃，无标记可重启。→ 实现关压 + DONT COMPRESS2 +
明文重放。

**2.3.4 EOR 提交标志——提示符不及时**：GA 与 EOR 等价触发提交（Mudlet `case TN_GA: case TN_EOR`，
且会 DO EOR）；dsh-mud 只处理 GA。pkuxkx 实测 EOR 未见使用（mccp2 关闭前提），低成本建议仍有效。

**2.3.5 附录性差异（无实际影响）**：SB 内 `IAC IAC` 转义 Mudlet 保留字面 IAC（dsh-mud 跳过不
保留，GMCP/MSSP/CHARSET 均为 ASCII，影响≈0）；编码 dsh-mud 硬编码 UTF-8（主/子解码器分离，
正确处理跨包错位）、Mudlet 支持全字符集；控制字符 Mudlet 在源上剥 `\r`/`\0`、dsh-mud 保留 raw
仅剔除 text（设计选择）。

### 2.4 登录层编码选择——实测结论（最终定论）

真实序列：`Input 1 for GBK, 2 for UTF8, 3 for BIG5` → `您的英文名字…：`（无换行，靠空闲刷出）
→ `请输入密码：`。**8081 端口选编码是可选步骤，非阻断**（第三轮 `--no-select2` 实测：CHARSET
ACCEPTED UTF-8 后不回 2，名字提示照常出现，登录完整走通）。变体：期间会插入 `编码已改为UTF-8。`
与两条 MushClient 提示（真实登录回 2 时）。`login:encoding` 规则已移除。
教训：单轮"没试过不发/不答"不能当"必须如此"——一切以覆盖反证的实测为准。

### 2.5 整改优先级（R1-R5 状态）

| # | 项 | 状态 |
|---|---|---|
| R1 | ~~登录规则补"编码选择 → 2"~~ | **已撤销**（§2.4 实测选编码非阻断，rule 已移除） |
| R1b | `login:name` 同时匹配长短两版名字提示 | **已实现**（双正则） |
| R5 | 分页界面自动翻页：`== 未完继续 NN% ==`/(`-- more --`) 交空格 | **已实现**（`pager:continue`，含 1s 节流） |
| R2 | 子协商长度上限 + 无界吞文本防护（§2.3.1/2.3.2） | V7 机制六排期落地（64KB） |
| R3 | MCCP2 出错后关压 + 明文重放（§2.3.3） | V7 机制六排期落地 |
| R4 | EOR 视同 GA（§2.3.4） | V7 机制六排期落地 |

---

## 三、V7 设计记录：命令-应答桥与输入路由

> 状态：**V1 已实施（2026-09-10 晚间）**。回归：`pnpm build` tsc 0 + vitest **12 文件 /
> 148 用例**全绿。各节标注【已实施】/【部分实施】/【未实施】；实施细节与偏差见 §3.9。
> 本文只记录讨论中**明确确认**的内容；开放事项列在 §3.8"待定"，不视为已定稿。

### 3.1 机制 A：命令-应答桥（GA 主边界 + 声明边界 + 静默兜底）【已实施】

**动机/问题**：旧实现 mud 工具"发完即回"，服务器应答异步到达后被 push 成新外部输入 → 每个
应答=新回合，登录等连续提示流程被拆成 N 个微型回合。拆 turn 的根因是"命令→应答"未被配对成
同步工具调用语义。

**语义**：mud 工具调用 = **挂起等待真实应答**；应答成为该工具调用的 tool result，由 loop 作为
下一步输入 → 流程在**一个回合内以 step 链**推进。同步等待住在工具执行内部（`MudTool.execute`
异步化），loop 本体零改动。实施：`CommandResponseController`（`network/response.ts`）+ `buildMudTools`
装配 `sendAndAwait` 后异步化；`CommandMeta.replyId` 穿透队列，`onSend` 调 `confirmSent(replyId, head)`。

**抓包依据（§2.2 三轮会话）**：
1. GA 与命令一一对应且必到（17/17，紧随提示符文本之后）→ GA 是协议级精确帧边界。
2. 被动推送无 GA → GA 只结"命令回复"；空闲流靠静默窗结算。
3. 长程命令 GA 早到（`dazuo 10` 发起即 GA，完成句 55.8s 后无 GA）→ 必须有声明边界。

**结算信号分层**（每个应答对象独立；按是否声明分两条链，链内取第一个命中者）：
- **未声明对象（默认）**：GA/EOR 主边界 → 静默窗兜底 → 超时兜底。
- **已声明对象（长程命令）**：声明边界主边界 → 声明方 timeout 兜底。**GA 完全退出结算**
  （长程命令 GA 早到只表示"受理"非"完成"；声明是**接管** GA 的角色）。
  > 实施偏差：**已声明对象实际禁用静默窗**（response.ts `armTimers`）——长程命令 1 条/秒渐进
  > 推送会让静默窗提前误结算；声明 = 接管全部结算责任，交声明方 timeout 兜底。未声明链静默窗
  > 语义不变（最后一行后 N 秒，逐行重置）。

各信号：
1. **声明边界 `until`**：规则 action / 工具参数声明期望边界（锚定整行正则，复用 v6.5 感知匹配
   引擎；瞬态匹配器）。实施：`ActionSpec.until?: { regex; timeout? }` → T1 渲染为 mud_send 参数 →
   `ReplyOptions.until`（跨帧累积，文本命中即结算）。登录/长程规则声明**尚未配置**（v6.5 时任）。
2. **GA/EOR**：telnet 层把 IAC GA（及 EOR，R4）作为显式 `boundary` 事件抛出，Controller 据此
   结算。子协商上限 64KB（R2）+ MCCP2 出错关压/明文重放（R3）一并排入落地。
3. **静默窗（兜底，约 2s）**：两条链共用，只在主边界未到时兜底结算（带"边界未命中"标记）。
   `DEFAULT_SILENCE_MS=2000`，最后（被 consume 的）一行到达后 N 秒逐行重置；未声明链专用句号。
   静默结算文本追加 `[静默结算（边界未命中）]`，超时追加 `[应答超时，边界未命中，请决策]`；
   `stripMarkers` 保证不破坏注册表查找。
4. **超时 reject**：默认 10s / 声明方配套（如 dz 120s），可逐请求/全局覆盖
   （`MudAgentConfig.bridgeTimeoutMs/bridgeDeclaredTimeoutMs`）；**连续 3 次超时 → reject**
   （工具 throw → DSH 失败终态），任意非超时结算复位（§3.2 B.3）。

**帧规则**：
1. **帧内容** = 命令写入 socket（onSend）后至结算信号之间的全部行，**含提示符行**。原"prompt
   行不进 buffer"条款废除——GA 在提示符文本之后到达，提示符天然属于帧；且 `login:pass`/
   `login:replace-confirm`/`save:prompt` 以 prompt 行为触发输入，剔行会断链。任何结算路径不丢行。
2. **统一行集表**：T1 匹配 multiline/color 需要 `MudLine[]`，而 tool result / user 消息只携带
   文本——行集经**有界注册表**（text → 行集，上限 ~64，FIFO）按尾部消息文本回查。登记点收敛为
   两个结算点：**帧结算**（帧文本 → 本帧行集）、**观察窗结算**（消息文本 → 折叠后剩余行行集）。
   原 `gameLineRegistry` 的"发送前松散登记"废除。miss → 按纯文本单行匹配降级。实施：Controller
   内部 `store`（上限 64，FIFO，键=纯文本 trim）；`resolveLines` 做 stripMarkers + 精确匹配 +
   最长前缀/空白折叠容错。登记时点进一步收紧：帧/观察行的登记随 feedLines 当拍完成（feed 侧
   精确路由，见 §3.5），无独立注册表模块——旧 `gameLineRegistry`/`registerGameLines`/
   `clearGameLines` 已删除。
3. **归属**：默认**一步一帧**（模型每步最多一个在途 mud 命令），GA 按命令发送序结算（服务器
   串行，抓包实证）。实施：一步一帧强制（live 单一 + pending FIFO——声明对象亦未开放并行）。
4. **先注册后发送**：命令入队（注册）时创建应答对象与边界匹配器；写 socket 时置 armed。
   实施：`sendAndAwait` 注册 → pump 发送（队列节流）→ `confirmSent` 置 armed。
5. **单条通道贯穿全部发送方**：agent 工具 / T1 / 登录 / WebUI 手动命令 / 紧急 halt。halt 插队
   到队头，仍占一帧。禁止旁路直发。实施：agent 工具与 T1 经 `sendAndAwait` → `queue.send`；
   WebUI 手动命令 → `sendFireForget` 或直发 `sendCommand`；halt 优先级入 CommandQueue 插队头。

**异常路径**：
- **断线**：reject 全部在途对象 → `turn/end(error)`。实施：`controller.close()`（在途+排队全
  reject 'error'；队列停发；观察窗清空），connect/close/teardown 均接线。
- **abort**（`exec.signal`）：撤销对应对象，避免悬挂 promise；迟到 GA 直接丢弃。实施：
  `ReplyOptions.signal`，任意时点 → 优雅结算 'abort'，监听器单次挂载、settle 时移除。
- **紧急预占**：紧急行可提前结算当前帧（对象标记 settled-early），迟到 GA 丢弃，期间新行进
  观察窗。**【未实施】**（紧急规则集未定，见 §3.8-6）。
- **超时**：见 §3.2 B.3（错误 tool result 交下一步决策，不再直接回合级 error）。

### 3.2 机制 B：回合语义（何时结束 turn）【已实施】

**原则**：回合结束**不由"应答到达"决定**——应答只推进 step。回合收不收取决于本步 agent 是否还
产出工具调用。

**三种结束路径**：
1. **自然收束**：最后一步应答成为 tool result → 下一步无新命令（T1 规则耗尽 / T2 主动 stop）
   → `turn/end(completed)`。实施：T1 adapter `finish{stop}`（tool-tail resolveLines 无命中 /
   文本未命中 / 控制消息 → 收束）；T2 stop 由官方 loop 处理。
2. **工具显式收尾**：工具执行内调 `exec.concludeTurn()` → 回合立即结束。约定：流程终点动作
   （如 `world_patch` 置 `logged_in`）使用；**mud_send 永不用**。**终点步禁止与 mud 命令并行
   渲染**。**【未实施】**：无规则 action 声明终点标记；`exec` 通道（concludeTurn/signal）未传入
   工具执行层（§3.9-6）。当前终点 = 自然收束兜底。
3. **失败收束**：**断线** → `turn/end(error)`。**单次应答超时不再直接回合级 error**（修订）：
   超时以错误文本 tool result 交本回合所有者决策（T1 可反射重试 / T2 自主处置），连续超时才升级
   error 收束。超时 tool result 以**成功结果携带错误文本**返回（非 throw）；连续超时按**回合**
   计数，N 默认 3。实施：超时 → `resolve({ ok:false, text: 帧文本+超时标记 })`；连续 3 次 →
   `reject`；任意非超时结算复位。计数器跨请求递增，非回合级——与"按回合计数"差异见 §3.9-7。

**回合粒度策略**：
- **单回合多 step**：只隔"等服务器回包"的连续决策段（登录、单次解密尝试、move+observe）。
- **长程流程**（练功、完整解密、持续探索）：**目标驱动多回合**——每回合一件有检查点的事，回合间
  由驱动层（goal / 控制消息 / 断流后果观察 / commandIntervalMs）推进。理由：回合无内建 step
  上限、单回合越长折叠窗口越挤、回合边界 = 学习切分 + 失败隔离 + 上下文 checkpoint。
- `agent/turn-stopping` 是回合将关时的官方续步钩子，不手工制造续步。

### 3.3 机制 C：观察路径、判类与 T1/T2 路由【已实施】

**输入三源**：在途应答（→ 机制 A 帧）｜空闲杂散行（→ 观察窗）｜控制唤醒（`[系统]` 前缀通道）。

1. **杂散观察窗**：无在途命令时行累积，按（静默窗口 | 空闲 prompt | 上限）结算成一条 user 消息
   开回合；纯噪音行不开回合（进 recall 缓冲）。噪音必须白名单命中才静默，未命中默认 T2 回合
   （漏判 = 静默丢输入，不许"猜噪音"）。实施（部分）：观察窗 = `observeBuf`，结算点 = 无主
   GA/EOR 边界（即时）+ 2s 静默兜底（`bridgeSilenceMs`）→ 判类注入（带所有权元数据的单条 user
   消息）。**噪音白名单未实施**（§3.8-10）：全部无主行默认开回合（T1/T2 判类），不静默。
2. **判类（观察窗进入回合前）**：反射类规则命中 → **T1 回合**；需推理 / 显式唤醒 → **T2 回合**；
   噪音 → 不开回合。判定在输入侧（feed），不等待错误路径。实施：`judgeAndInject`——state 折叠后
   剩余行喂 `eventMatchService`，`action` 命中 → lane=t1 反射注入，其余 → lane=t2 推理注入；
   控制唤醒（requestAgent）固定 lane=t2。
3. **回合内所有权稳定**：续步（tool result）归本回合所有者。T1 回合到规则耗尽自然收束，回合内
   不自动转 T2；T2 一路续答。**所有权随注入消息元数据走**（feed 判类时挂在 message source 上；
   request 监听器**回扫最近一条带所有权元数据的 user 消息——跳过 tool-result**——选 provider）。
   source 元数据若不随会话持久化，resume 后首轮缺元数据 → 回退默认 T1（有意回退）。实施：
   `MessageSourceMap` 增补 `'mud-owned' { kind; lane:'t1'|'t2' }`（merge-extensible，`export *`
   已确认）；`ownedGameMessage`/`sendOwnedOutput`；bridge `agent/request` 监听器经
   `ctx.get('sessions').surface.nodes` + `eventAt` + `deriveEventMessage` 回扫选 provider
   （T2 未配置降级 T1 并日志）。
4. **升级不自动**：T1 死局由**后果观察**兜底（登录超时 / 断流 / `logged_in` 未置位 / 卡住检测）
   → 控制消息唤醒 T2。T2 接手能看到 T1 全部 step 历史。实施：断流 30s 死空气 → requestAgent 控制
   消息（lane=t2）唤醒。**登录超时/卡住检测未接线**（登录重建后进行，见 §3.9）。
5. **学习路径**：流程以 step 序列活在历史里。学习期长程流程由 T2 多回合跑；跑顺后固化 T1 规则 →
   子流程内部变回合内多步。**规则是把学到的流程固化的渐进机制，不是流程的替代品**。
6. **删除项**：T1 未命中的 error / NO_ANSWER / request-error retry 路径、`t1FailedKeys` 回合
   sticky、`gameLineRegistry` 的松散内容寻址（由统一行集表替代）。实施：全部删除（adapter 收束
   改 `finish{stop}`；bridge 删瀑布监听器与注册表；`T1_NO_ANSWER_CODE` 已随响应路径清理）。
7. **判类与 T1 渲染不双跑**（修订）：feed 侧判类只做分类（匹配结果即丢弃），动作渲染一律由回合内
   T1 对同一批行执行。实施：feed 判类 `eventMatchService.match` 结果只取 hasAction 布尔；动作在
   回合内 adapter（对 resolveLines 还原的行集）执行。

### 3.4 在途杂散行策略（机制五）【已实施（除紧急预占）】

1. **并入当前帧**：在途命令等待期间到达的杂散行（频道 / 系统 / 他人行为）直接并入当前帧，不分段、
   无标记（MUD 文本自解释；v6.5 锚定准入防误触发；T2 读连续局面优于碎片）。实施：**交叉窗口归属**
   （§3.5）——武装前（sending）杂散行经 `controller.feedLines` 无主分支转 onObservation → host
   `headBuf`，`confirmSent(replyId, head)` 并入帧首；武装后到行直接进 armed 帧。
2. **紧急预占**：死亡/战斗/受击紧急行（常开轻量匹配器）→ 立即截断结算当前帧（settled-early，
   迟到 GA 丢弃）→ 当前 step 立刻反应。**【未实施】**（规则集未定，§3.8-6；当前并入帧/观察窗
   照常流动）。
3. **感知不退化（修订）**：行到达的三件事——state 提取 / recall 缓冲 / 应答累积——全部在**原始
   行流**上执行，互不依赖折叠；"折叠移除"只发生在观察窗→agent 的文本路径。实施：feedParsed 在
   原始行上 recall + state extract/applyPatch；`controller.feedLines` 接**原始行**（armed 帧累积
   原行；边界匹配看原文）；折叠后剩余行仅用于观察窗注入。

### 3.5 管线接入与折叠分界（机制六）【已实施】

**接入点**：Controller 直连 telnet 层 **parsed + boundary 原始流**（`client.on('parsed')` +
新增 boundary 事件），**不经过 feedParsed 的折叠过滤**。原因：feedParsed 在 state 折叠后才把
剩余行喂下游，若接其后，凡目标行恰为 state 折叠行的声明边界（如等 `hp` 的 `气血` 行）将永远
看不到。实施：`feedParsed` 借道 `controller.feedLines(raw, foldedRemains)`——**原始行与折叠剩余行
双通道一次喂入**；telnet `boundary` 事件 → `controller.boundaryReceived`。

**折叠分界（三路径两种流）**：

| 消费者 | 取哪条流 | 理由 | 实施 |
|---|---|---|---|
| 边界匹配器（瞬态，属应答对象） | 原始行（折叠前） | 目标行可能是 state 折叠行 | `feedLines` 第一参（原始行）；until 对帧文本匹配 |
| 帧内容 → tool result | 原始行（不折叠） | 工具主动索取的应答，折叠 = 缺数据 | armed 分支累积原始行 |
| 观察窗 → user 消息（空闲杂散行） | 折叠后的剩余行 | 无人索取，状态已进 world，不吵 agent | `feedLines` 第二参 `foldedRemains`；无主分支据此登记 + 转发 |

- state extract/applyPatch 在原始流照常执行，与折叠无关——"折叠"只决定行文本是否从观察窗内容
  移除，world 同步不受影响。
- hp 例：`hp` 在途 → "气血 100/100" 行 → 边界匹配器原始流命中 → 帧结算；该行同时被 extract 进
  world；tool result **有**这行、world 也有数值。同一行空闲被动到达 → 观察窗折叠（agent 不见
  文本，world 已入库）。
- **交叉窗口归属**：一步内前帧已结算、下一命令未 armed 之间到达的杂散行落观察窗缓冲；新帧 armed
  时观察窗未结算缓冲并入帧首——保时序：agent 不得先见命令应答、后见应答之前的杂散（时序保真
  优先）。实施：sending（未武装）期间到行 → host `headBuf` → `confirmSent(replyId, head)` 并入
  帧首。**观察窗缓冲与帧首集互斥**：inFlight() 期间 onObservation 只进 headBuf（不判类注入）——
  防"帧首合并 + 观察注入"双重消费。
- **telnet 层改造**：GA/EOR 显式 boundary 事件（AnsiStreamParser 的 GA 刷出逻辑保留，但
  Controller 依赖显式事件而非批边界推断）；协议加固 R2（子协商上限 64KB）/R3（MCCP2 出错关压+
  明文重放）为感知完整性前置，随本机制一并排期。

### 3.6 v6.7 时实施蓝图（改动面预览 + 实际状态）

| 模块 | 改动 | 状态 |
|---|---|---|
| 新增 `network/response.ts` | `CommandResponseController`：应答对象生命周期（注册→armed→结算）、分层结算（until/GA/静默/超时）、无主 GA 丢弃、断线/abort 清理；`stripMarkers`/`resolveLines`/`sendFireForget`/`inFlight`/`stats` | ✅（489 行 + 18 单测） |
| `network/telnet.ts` | GA/EOR 显式 boundary 事件（R4）；子协商长度上限（R2）；MCCP2 出错关压 + 明文重放（R3） | ✅（+4 单测） |
| `index.ts` feed 路由 | Controller 直连 parsed + boundary 原始流（§3.5）；观察窗（静默/空闲 prompt/上限结算，折叠路径）；后果观察升级点接线 | 🟡 部分（直连+观察窗+死空气已实施；登录超时/卡住检测未接线） |
| `agent/tools.ts` | `execute` 异步化：`send(cmd): void` → `await sendAndAwait(cmd, { until?, timeout? })`；mud_send/mud_move/mud_look 走同一桥；world_patch 等本地工具不 await；output/render 改返回应答文本 | ✅（sendAndAwait 存在时异步；缺省同步旧路径兼容测试） |
| `agent/execution.ts` | CommandQueue 角色调整：节流 → FIFO 发送序 + armed 时机 + halt 插队 | ✅（+`replyId` 透传） |
| `trigger-llm/types.ts` | `ActionSpec.until?: { regex; timeout? }` 可选字段 | ✅ |
| `trigger-llm/adapter.ts` | tool-tail 不再"安静收束"：tool result 文本 + 应答行集作为可匹配输入；无规则命中才 finish stop；删除 NO_ANSWER/error 输出 | ✅（resolveLines 续步判定；`finish{stop}` 收束） |
| `agent/agent-bridge.ts` | 删 request-error/request 失败转 T2 瀑布、`t1FailedKeys` sticky、`gameLineRegistry`（→ 统一行集表）；回合所有权随注入消息元数据走，request 监听器回扫带元数据的 user 消息选 provider；defineTool 把 `exec` 传入工具执行 | 🟡 部分（瀑布/注册表已删、所有权路由已实施；`exec` 通道未传入） |

### 3.7 待定 / 需实录确认（未定稿）

1. **Phase 0 实录**：GA 边界实证已取得（三轮抓包）；剩余**长时段录制统计**杂散行频率与构成；
   校准观察窗 idle prompt 形态（仅作加速提示，非机制依赖）。噪音白名单条目依赖此统计。
2. **超时/静默窗时长**：初值已实现（GA 10s、静默 2s、声明方配套长程 timeout；`bridgeTimeoutMs/
   bridgeDeclaredTimeoutMs/bridgeSilenceMs` 可覆盖）；与 `loginTimeoutMs` 关系待理；连续超时
   升级阈值 N=3 已实现——**按对象序计数**，与"按回合计数"差异见 §3.9-7。
3. **空收尾步**：自然收束可能产生空 assistant/message——实测 DSH 准入是否吞空消息；不可接受时用
   concludeTurn 规避（帧内提示符行使 tool result 恒非空，原"空帧"担忧消失）。未实测。
4. **并行 mud 命令**：收窄为"声明边界互斥的对象可并行"；准入条件与是否对 T2 开放，实录后按吞吐
   决定。**未实施**（V1 一步一帧强制，保守起步）。
5. **单回合连续命令步数上限**：与 DSH `guard`（loop-hygiene / tool-timeout）插件的覆盖边界，
   是否需要 mud-core 侧补充护栏。未实测。
6. **紧急预占规则集**：哪些规则算"紧急"（死亡/战斗/受击/断线提示）。**未实施**。
7. **流程终点工具的 concludeTurn 约定**：规则 action 如何表达"这步是终点"。**未实施**。
8. **长程命令 `until` 规则集**：dz（`站了起来` 亮绿完成句）/ sleep（醒来句）等首批声明。**未配置**
   （ActionSpec.until 与 mud_send schema/execute 已就绪）。
9. **分页下沉**：`== 未完继续` 维持 `pager:continue` 规则在 step 链内逐页推进，是否下沉到桥层短路
   （一帧内自动翻页），实录后按延迟决定。**未实施**。
10. **噪音白名单**：初始条目与维护方——初期仅收纯客户端/协议噪音行；公频聊天等有效输入默认仍开
    T2 回合。**未实施**（V1 全部无主行默认判类开回合——与"漏判 = 静默丢输入"保守原则一致）。

### 3.8 实施记录（V1，2026-09-10 晚间）

**实施范围**：机制 A/B/C 主体、机制五-1/-3、机制六（折叠分界）全部落地；机制 B-2（concludeTurn）、
机制五-2（紧急预占）、待定 4/6/7/8/9/10 未实施。

**交付物**（回归：`pnpm build` tsc 0；vitest 12 文件 148 用例全绿）：

| 文件 | 关键改动 |
|---|---|
| `network/response.ts`（新增） | 注册→sending→armed→settled 生命周期；分层结算（until 跨帧 / GA/EOR 主边界 / 静默窗 / 超时最兜底）；一步一帧（live 单一 + pending FIFO）；连续 3 超时 reject；断线 reject / abort 优雅结算；统一行集表（64，FIFO）+ `stripMarkers` + `resolveLines`（精确/前缀/空白折叠容错）；`feedLines(raw, foldedRemains)` 双通道折叠分界；`confirmSent(replyId, head)` 帧首并入；`inFlight`/`sendFireForget`/`stats`/`close`/`clear` |
| `network/telnet.ts` | GA/EOR `boundary` 显式事件（R4）；子协商上限 64KB（R2）；MCCP2 出错关压+明文重放（R3） |
| `agent/tools.ts` | `buildMudTools` 增 `sendAndAwait`；`MudTool.execute → MudToolResult \| Promise`；move/look/status/send 异步（note=应答文本）；send 支持 `until` 参数；缺省同步路径兼容旧测试 |
| `agent/execution.ts` | `CommandMeta.replyId`（队列只透传；onSend 时宿主 confirmSent） |
| `trigger-llm/types.ts` | `ActionSpec.until?: { regex; timeout? }` |
| `trigger-llm/adapter.ts` | tool-tail → `resolveLines` 续步判定（命中渲染 / 未命中 stop）；文本 miss / 控制消息 / 无注册行 → `finish{stop}`；NO_ANSWER/error 输出全删 |
| `agent/agent-bridge.ts` | 删 `gameLineRegistry`/`registerGameLines`/`clearGameLines`、瀑布 + `t1FailedKeys`；`MessageSourceMap['mud-owned']` 增补（`declare module '@deepseek-ai/dsh-llm'`）；`ownedGameMessage`/`sendOwnedOutput(handle, text, lane)`；`agent/request` 回扫 `ctx.sessions.get(id).surface.nodes` + `eventAt` + `deriveEventMessage` 最近一条 mud-owned user 消息选 provider（T2 未配置降级 T1 + 日志）；`registerTriggerProvider` 增 `resolveLines` 选项 |
| `index.ts` | `CommandResponseController` 接线：`send→queue.send(meta)`、`onSend→sendCommand 成功后 confirmSent(replyId, headBuf)`；`sendAndAwait→tools`；feedParsed 折叠分界双通道喂 `controller.feedLines`；观察窗 `observeBuf`（无主边界即时 + 2s 静默结算）→ `judgeAndInject`（event 规则命中 lane=t1 反射注入 / 其余 lane=t2）；inFlight() 期间 onObservation 只进 `headBuf`（防双重消费）；控制唤醒 lane=t2；connect/close/teardown 的 `controller.clear()/close()` + `queue.clear()` + 缓冲清理；新增配置 `bridgeTimeoutMs/bridgeDeclaredTimeoutMs/bridgeSilenceMs`；**登录看门狗**（`loginTimeoutMs` 缺省 90s，登录期无推进 → T2 升级封顶 3，connect 重置登录态/布防，close/teardown 清理） |
| `config/trigger-rules.ts`（登录段） | **登录命令回归 GA 主边界**（删全部 until 声明——声明链对 GA 只测不结算致意外文本锁帧等超时）；新增 `LOGIN_BOUNDARIES` 阶段边界表（entry 入口 / pass+replace 推进 / terminal 终态 / error 错误，单一事实来源，规则 match 复用）；`login:pass` 双形态（`^(?:ID已存在，)?请输入密码`）修复卡死；`login:done` 锚点改真实完成信号 `目前权限：(player)`；`login:replace-confirm` 多形态修复；新增 `login:error` 估计规则 → `flags.login_fault` |
| `tests/login-rules.spec.ts`（新增） | 登录规则链 9 用例：无 until 断言 / 边界表复用一致性 / 双形态密码提示 / 完成信号锚点 / 横幅反向 / 替换确认多形态 / error 估计形态 |

**实施偏差与决策**：

1. **声明链禁用静默窗**：已声明请求不挂静默窗——长程命令渐进推送会提前误结算；声明 = 接管全部
   结算责任，交声明方 timeout 兜底。未声明链静默窗语义不变。
2. **折叠分界落地方式**：`feedLines(lines, foldedRemains?)` 一次喂入双通道——armed 分支取原始行
   （帧内容/边界匹配），无主分支按折叠剩余行登记 + 转发观察窗；天然保住"hp 的气血行在原始流上可
   命中 until"。
3. **所有权路由**：`MessageSourceMap` 为 merge-extensible 联合，`declare module` 增补
   `'mud-owned'` kind；注入消息 source.lane 随会话事件持久化；首轮缺元数据 → 默认 T1。
4. **T1 收束语义**：无命中 / 控制消息 / 无注册行一律 `finish{stop}`——不再"交棒"；路由责任整体
   前移到 feed 判类（输入侧），T2 兜底由"该批输出判为 t2"承担，而非失败升级。T1 死局由断流唤醒。
5. **观察窗互斥**：inFlight() 期间无主行只进帧首集（headBuf），不判类注入——防同一批文本"帧首合并
   + 观察注入"双重消费；观察缓冲结算点 = 无主边界（即时）+ 2s 静默兜底。
6. **exec 通道未传入**：`defineTool` 包装层尚未透传 `exec`（concludeTurn / signal）。abort 由
   `ReplyOptions.signal` 承担——机制 B-2 与"终点动作"约定随登录重建一并落地。
7. **连续超时按对象序计数**：控制器计数器跨请求递增（非按回合）。一次回合内跨多对象的连续超时行为
   等价；跨回合的连续超时会继续累计。实录后如需按回合精确计数再调整。
8. **`textOfLines` 纯文本焦距**：帧/观察文本均以 32-bit 折叠文本入注册表；T1 multiline/color 匹配
   经 resolveLines 还原行对象——行号/style 保真。

**登录流程重建（2026-09-10 补充）**：

- **登录命令回归 GA 主边界**（关键决策）：`login:name` / `login:pass` / `login:replace-confirm`
  **不声明 until**。原因：声明链在 GA 到达时"只测 until、未命中丢弃边界继续累积"——登录的真实
  下一步信号形态多样（替换确认/密码错误不在单一声明里），声明会锁帧硬挂到 timeout（45s），期间
  inFlight 文本尽入帧首集、观察注入被吞。回归 GA 后：命令回显完整入帧、GA 结算作 tool result、
  续步判定自然承接任何下一步信号。"推进文本保留"由三层保证（行集表 record / tool result
  text+lines / feedRaw 终端总线）。
- 新增 **`LOGIN_BOUNDARIES`** 阶段边界表（entry / pass+replace / terminal / error）：登录"推进
  信号"单一事实来源，规则 match 复用——三段式语义在规则层成文，不进入应答桥机制。
- `login:pass` 修复抓包实证前缀形态 **"ID已存在，请输入密码："**；`login:done` 锚点修正为真实完成
  信号 **"目前权限：(player)"**（旧 `欢迎来到北大侠客行` 是登录前横幅，抓包中不出现；GMCP.System
  权威兜底 logged_in）；`login:replace-confirm` 多形态修复（行首 已有同名/覆盖/替换/已被占用 +
  全角/半角 y/n 括号）；新增 `login:error` 估计规则 → `flags.login_fault`。
- index.ts 登录看门狗：登录期（logged_in=false）无推进超 `loginTimeoutMs`（缺省 90s）→ 控制消息
  （lane=t2）升级 T2 决策，封顶 3；文本到达即重置；connect 复位登录态（绕过置信度护栏）+ 布防；
  close/teardown 清理。
- 待实录（已标注于规则注释）：替换确认 / 密码错误 / fullme 的精确文本 → 依实录校正
  `LOGIN_BOUNDARIES.replace/error` 与 `p:login:error` 行为。
- 与偏差 1 的关系：**声明链禁用静默窗/GA 降级仅服务于长程命令**（dz/sleep 需"渐进推送不被 GA
  打断"）；登录段属短回显命令，回归 GA 默认路径（未声明分支），两者不冲突。

**V1 未实施 / 后续任务**：

- 剩余登录侧：fullme 验证码提示检测规则（需实录 fullme 提示实样后接线 captcha 卡片/robot.php
  刷新链路）。
- `exec` 通道（concludeTurn / exec.signal）传入工具执行层；world_patch 终点动作 conclude 约定。
- 长程命令 `until` 规则集（dz / sleep 等首批）。
- 噪音白名单、紧急预占、分页下沉评估。
- 实录调优：超时/静默窗初值、并行 mud 命令开放、空收尾步实测、步数上限护栏与 DSH guard 边界核对。

---

## 四、复现与产物（探针）

```pwsh
cd D:\Code\dsh-mud-agent\packages\mud-core
pnpm probe                       # 抓登录横幅（无凭据，≤20s 自动结束）
pnpm probe -- --user NAME --pass PASSWORD   # 完整登录：编码→名字→密码→命令序列
# 默认命令序列(每秒1条, sleep 后等 28s):
#   look,w,w,check,e,e,id,"give 2 silver to biao",up,enter,"dazuo 10",hp,score,sk,lm,sleep,dz
# --send <命令> 追加; --wait <ms> 调总时长; --out 指定 .log/.bin; --no-select2 验证编码非阻断;
# --accept-compression 镜像 mud-core 的 MCCP2 解压路径 (zlib→raw deflate 回退)
```

产物：`.log`（hex dump + TXT/PROMPT 文本视图 + TELNET 协商事件 + LOGIN 编排）、`.bin`（原始
字节，可离线回放比对）。探针为最小独立实现（字节状态机 / MCCP2 / 登录实时字符检测 / 分页自动
翻页），用途见 §2.2 抓包依据。