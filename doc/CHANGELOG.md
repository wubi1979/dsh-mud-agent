---
sections: [15]
status: active
note: 只追加，不回改历史条目；每次设计变更在文末登记一个条目；版本号登记规则见 §15 卷首
---

## §15 变更记录

旧文档 §15 全表已迁移为纲目（2026-09-16，内容逐字保留）；新条目只追加在文末。

**版本号登记规则（2026-09-20 起）**：
- **小版本（第三位）**：设计变更、修复当前大版本线内的问题——例：v0.10.1、v0.10.2；
- **大版本（第二位）**：重构核心、重要功能重构——例：v0.9.*、v0.10.*。


## v0.1（2026-09-11）设计基线
- 合并 V7/V8/V9/preset 计划；确立术语（文本块/行/批次/原文投递消息 —— 旧称"反射消息"）、L1–L4 分层、单流切分、九条不变量、版本规则、交付切片

## v0.1（实施）（2026-09-11）落地 W1+W2
- 每会话行级感知引擎、hit 驱动 T1 渲染、单流切分；删除 `matchDry`/`resolveLines`/行集表；补 GA 边界接线与 diag 缺陷计数

## v0.1.1（2026-09-11）
- 修复 T1 拦截时继承官方 `reasoningEffort` 导致 llm 层拒绝（`does not support reasoning effort "high"`）：`toT1Config` 换 provider 时剥离 adapter-owned effort（与官方换模型同款惯用法）

## v0.1.2（2026-09-11）联调修复（T1 已跑通后的两处）+ W2 收尾
- ① 工具输出 schema 漏声明 `settled` —— `additionalProperties: false` 下桥结算结果被判非法，工具**已执行**却回一条失败帧（新增"结果字段必须全部已声明"用例）；
- ② 删除用户残留 —— 删用户/删服务器改为**归档配套官方会话**（`IWorkspaces.archiveSession`，官方归档语义：界面隐藏、会话文件保留）+ `ctx.mud.purge` / `POST /mud/purge` + `purgeSessionLogs`（释放运行时与连接、删该会话全部日志文件、清本页与 host 缓冲）；
- ③ 补 W2 表驱动"命中必被适配"用例（`tests/rule-coverage.spec.ts`）；
- ④ `POST /mud/bind` 重复声明不再刷三行日志

## v0.1.3（2026-09-11）修复登录"赶出去/取而代之"确认分支无响应
- `login:replace-confirm` 的关键词集（同名/覆盖/替换/已被占用）全不在实录句 `您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)` 里 → T1 无命中 → 不发 `y`、登录停住。改为以实录句为准（问句本身即命中，不要求同行 y/n；旧估计形态保留），并把"多行规则的多 pattern = 有序条件、单行提示只能写一条正则"记入 §4

## v0.2.0（2026-09-11）W3 前半（权限档位 §10）落地
- 三档 `observe`/`operate`/`full`（表 `permission/tiers.ts`）；危险命令静态黑名单 → 策略表（`DEFAULT_DANGEROUS_COMMANDS`，`deny`/`ask` + Config 覆盖）；纯判定 `evaluateToolCall` + 官方 `tools/pre-execute` 强制点（含 agent 身份判据、`[权限]` 留痕）；可见性层按档注册并在切换时重挂；会话事件 `mud/capability` + 投影 `mudCapabilities`（host-only）+ `ctx.mud.capability.*` + `GET/POST /mud/capability` + `/mud/status.tier`；新增零发送工具 `mud_state`；页面用户行 ⋯ 菜单三档选择 + 右栏显示

## v0.2.1（2026-09-11）W3 后半（preset 化 §9）落地，方案 A1
- 新增 agent 平面 preset 行 `src/preset-agent.ts`（组装期注册工具声明 + 提示区段，执行期按调用方 agent 解析会话工具）、组合文件 `presets/mud-player/{agent.cordis.yml,preset.yml}`、`ctx.mud.agentKit()` 数据源、`Config.agentPreset` 开关与装配失败回落；新增投递就绪门 `MudRuntimeSink.agentReady`（装配未就绪时不投递，避免第一批输出跑在旧组装上并永久锁定 preset）；已知取舍：preset 模式下 §10 可见性层退化为强制层 + 提示文本

## v0.2.2（2026-09-12）联调修复（preset 装配事故 + T1 模型污染）
- ① 组合文件改为 **`standard` 整份副本 + `mud-agent` 一行** —— preset 是"整个组装"，只写自己那一行会让被切过去的会话丢掉全部标准工具（实测"工具不可见"；preset 与已产出内容的会话一旦锁死只能删用户重建）；
- ② `Config.agentPreset` 从 profile patch 挪到本包 patch（分层正确的位置）；
- ③ `resolveLaneConfig`：官方会把生效的 provider/model 记成会话选择 → 首次 T1 拦截后非 T1 回合也会打到 `mud-t1`（真实 LLM 永不参与），现在记住并还原"会话真实模型"；
- ④ 新增 7 条选路用例 + 组合文件回归用例

## v0.2.3（2026-09-12）部署契约修正 + 一处 YAML 修复
- ① preset 根（`agent-presets.roots`）与 `agentPreset` 一律写本包 patch（`--patch` overlay，启动期一层），**profile patch 保持 `[]`** —— 本机 profile 是 `patchReload: live`，热应用一次 `agent-presets` 配置会重建常驻挂载，导致所有 preset 组装出来的工具当场消失（实测两次，改回 `[]` 后不重启即恢复）；
- ② 修 `presets/mud-player/preset.yml`：描述里的裸 `": "` 让 js-yaml 解析失败（官方吞掉异常 → 选择器只显示 id），改用折叠块并加结构性守卫用例；
- ③ 新增 patch 文件契约用例（preset 根 + preset id 同层、`mud-core` 只作为 insert 出现）

## v0.2.4（2026-09-12）preset 首启实测的两处修复
- ① 组合文件改为**机械生成**（standard 的 `# ── identity` 起全部内容含注释 + 末尾 `mud-agent` 行）—— 手抄版漏掉 `plan-mode` 的必填 `config.section`，挂载报 `PlanModeConfig needs a non-empty 'section'` 并回落宿主侧装配；新增"与 standard 逐行比对"守卫用例（harness 检出存在时启用）；
- ② 修回落路径上的就绪门：就绪由每会话标志 `capabilityReady` 判定（预设挂载成功**或**回落完成都置位），只看 `composedPreset` 会让回落会话的待决行永不投递（实测登录文本一直被留到登录看门狗唤醒）；
- ③ 顺带修 `preset.yml` 的 YAML 语法（裸 `": "`）

## v0.2.5（2026-09-12）修实测的"登录完成后会话永远静默"
- 断流唤醒的布防此前只挂在感知事件上，而登录完成是 `world_patch` 工具置位的（那条 `login:done` 文本块到达时 `logged_in` 还是 false），登录后服务器不再说话 → 断流计时从未布防。现在**每次世界模型变化**都重评估两个看门狗（`noteWorldChange`；`buildMudTools` 新增 `onWorldChange` 回调，GMCP 与 state 折叠同路径），并给 `armDeadAir` 补上连接门。新增 `tests/runtime-watchdog.spec.ts`（第一个 runtime 级测试）

## v0.3.0（2026-09-12）看门狗规则化（用户提出的设计方向）
- 删除散落的 `armDeadAir/resetDeadAir/armLoginWatchdog/resetLoginWatchdog`，改为声明式 `WatchdogTable`（`runtime/watchdogs.ts`）—— 每条看门狗声明**启动条件**、窗口、触发行为与续期方式，运行时只在固定状态变化点 `reevaluate()`（布防/停表，不重置窗口）与 `touch()`（活动重置窗口）。两个看门狗的条件即"登录了才启动、断线就停止"（`dead-air`: 已连接 ∧ 已登录 ∧ 有 agent；`login-stall`: 已连接 ∧ 未登录 ∧ <3 次）；L2 的 settle/hold 计时器明确**不**入表。新增 `tests/watchdogs.spec.ts`（11 例规则测试）

## v0.3.1（2026-09-12）W4 第一批 + 登录流程收尾
- ① **退出 MXP 检测**（实测：登录后不发命令则服务端输出要等约 5 分钟）—— `noteLoginExit()` 在 `logged_in` 翻真时发一次 `Config.loginExitCommands`（缺省 空行 + `look`），actor `system`，每次连接一次、掉线重连复位；
- ② `exec.signal` 接线（`MudToolCallOptions.signal` ← 官方 `ToolRunContext.signal` → `ReplyOptions.signal`，宿主装配与 preset 线两条路径都转发）；
- ③ 硬编码 `COMPLETION_UNTIL` → **活动表** `DEFAULT_ACTIVITY_TABLE` + `activityFor()` + `Config.activityTable`（数据驱动、可覆盖）；
- ④ 新增 `tests/runtime-login-flow.spec.ts`（4 例）+ 活动表/取消信号用例；`exec.concludeTurn` 留待定（§18.11）

## v0.3.2（2026-09-12）结算重复与节奏（用户实测）
- ① **交付水位** `deliveredAbs` —— T1 反射消息 / T2 批次 / 工具应答帧都前移水位，`mud_recall`/`mud_state` 只回看**未投递**的行（此前 `mud_state` 把连接至今全部输出又倒一遍）；
- ② **删掉宿主的"帧首"缓冲** —— 队列节流窗口与武装后到达的行统一由控制器累积，同一批行不再同时留在本帧与下一帧（实测 `look`/`inventory` 的应答里混进旧行与 MXP 文本）；
- ③ **工具调用限速** `Config.toolCallIntervalMs`（缺省 1s，闸门执行，登录流程豁免），管住 T2 连续发起工具调用的节奏；
- ④ 新增 `tests/runtime-delivery.spec.ts`（3 例）+ 限速用例（2 例）

## v0.3.3（2026-09-12）fullme 人工验证码 = T1 流程（用户定案
- 由 T1 发、等待期暂停全部投递）：
- ① 新规则 `fullme:prompt`（判据 = 游戏回显的 `robot.php` 地址）+ 动作 `mud_send {cmd:'fullme {captcha}'}` + `ActionSpec.awaitExternal`（命中先挂起）；
- ② 运行时**人工环节** `awaitingHuman`：地址交宿主取图推 UI、**暂停全部投递**、两个看门狗停表 + `requestAgent` 拒绝唤醒、**无超时**；人工页面输入 `fullme <码>` 不直接发出 → 存 `{captcha}` → 挂起命中交 T1 渲染发送；断线重连作废；
- ③ 修**预筛种子 bug**：`^https?://…` 曾推出 seed `https` → `http://…` 的行在预筛就被丢掉（规则永不命中），现在 `?`/`*`/`{` 后的字面不计入种子、顶层 `|` 放弃预筛；
- ④ 新增 `tests/runtime-captcha.spec.ts`（4 例）+ 种子/插值用例

## v0.3.4（2026-09-12）fullme **入口改为我们主动发**（用户 6 点实录修正
- 服务端提醒不可依赖、地址在**应答帧**里、答案 = `halt` + `fullme <码>`）：
- ① 新规则 `fullme:request`（动作 `mud_send {cmd:'fullme'}`，id 导出为 `FULLME_REQUEST_RULE_ID` 单一事实源）+ `fullme:done`（成功句 → `world_patch {fullme_ok:true}`）；
- ② 新看门狗 `fullme-due`（`Config.fullmeIntervalMs`，缺省 270s，0 = 不定时）+ `WatchdogSpec.resetsOnActivity`（窗口语义与"游戏输出"解耦 —— 节拍量的是"距上次 fullme"）；
- ③ **自触发投递** `deliverSelfHits`：无锚点行的命中（定时节拍、帧路径的人工答案）直接造一条 `lane=t1` 反射消息交 T1 渲染，**命令仍取自规则表**（`PerceptionEngine.actionOf` 反查，运行时不硬编码 `fullme`）；
- ④ `lastFullmeSentAt` 在 `onQueueSend` **真正写出** fullme 命令时统一盖章（提醒/定时/人工答案三条路径共用窗口，跳过时按剩余时间续期）；
- ⑤ 修**帧路径丢命中**：地址是 `fullme` 应答帧里的一行（不进待决），人工回填后 `settle()` 无行可投 → 命中会被判成"锚点行已投出"的缺陷丢掉；现在 `pendingExternal` 带 `framed` 标记，帧路径回填后走自触发；
- ⑥ 修**系统流程命令集漏收 `cmds` 序列**：`LOGIN_FLOW_COMMANDS` 只取 `cmd`，答案里的 `halt` 不在集内 → 只读档答验证码会被档位拒绝（现在 `cmd` + `cmds` 都收，两侧逐字一致）；
- ⑦ **MUD 会话不再自称"编码 agent"**：人设改走官方槽 `deployment:persona-prefix` 的 **per-agent 同名替换**（`attachMudPersona`，宿主两条装配路径共有），preset 行只提供 skills/tier/commands 三段 —— 并列追加会让模型同时收到两份人设，而 preset 作用域同名会与 standard 的 `persona` 行撞名抛错；
- ⑧ **帧内命中重复入队**（v0.3.3 引入）：帧内分支先把命中归回合记录/入待渲染队列，`parkExternalHits` 又把"不需要外部值"的命中入队一遍 → 同一条命中被渲染两次。现在 `parkExternalHits` 只负责挂起、把其余命中**返回**给调用方；
- ⑨ `tests/runtime-captcha.spec.ts` 扩到 11 例、`tests/mud-persona.spec.ts` 新增 2 例（真实注册表的 preset → agent 两级作用域）、`tests/watchdogs.spec.ts` 12 例、`tests/login-rules.spec.ts` 12 例；
- ⑩ 新未决项 §18.12（帧内命中在"无 T1 回合在跑"时会被当缺陷丢掉）。**注**：本条的"主动发 + 定时节拍"部分在 v0.3.5 被用户更正（5M 指人物经验值，入口是匹配服务端提醒行）后撤回，仅保留 `fullme:request` / `fullme:done` 两条规则与帧路径修复

## v0.3.5（2026-09-12）
- 用户三定案（fullme 走 login 机制 + 无状态触发直发 + Prompt 经济；其中"fullme 定时节拍"是我误读 5M=经验值为 5 分钟，已全部撤回）：
- ① **fullme 入口 = 与 login 同一机制**：`fullme:request` 命中**服务端提醒行**即由 T1 渲染 `mud_send {cmd:'fullme'}`（人物经验值 5M 后长时间不用会被判机器人，服务端届时提醒 —— **实录原文 `5M后长时间不使用fullme，会被系统判定为机器人。`**，判据就是这一串）；**删除** `fullme-due` 看门狗 / `Config.fullmeIntervalMs` / `lastFullmeSentAt` 窗口与 `WatchdogSpec.resetsOnActivity` / `PerceptionEngine.actionOf`（后两者随之成为无人使用的机制，一并删除，见 §16）；
- ② **直接执行类动作** `ActionSpec.direct`（§7 三条出口）—— `save` 提醒 / 分页提示这类"无状态、无需返回"的触发**不投给 agent**：命中行折叠（`mud_recall` 也不给），动作由运行时立即执行（新增 `MudToolCallOptions.fireAndForget`；`world_patch` 直接落库），actor `system`、危险命令硬边界照旧（`ask` 无审批通道 = 拒绝），人工环节期间不执行；
- ③ **帧内命中收口**（§18.12）：帧分支先分离"待人工"命中（此前挂起的验证码命中会作为 T1 续步被渲染 → 发出 `fullme {captcha}` 空码），再把其余命中归当前回合；**没有回合在跑时留在待渲染队列等下一次反射投递**（用户定案"这些流程可以等"，不另开回合；不再被判成"锚点行已投出"整批丢掉；等待有界 `MAX_QUEUED_HITS = 32`，超限丢最旧并计入 `hitsDropped`）；
- ④ **命令目录改为索引 + 按需查询**：系统提示只注入 `commandsIndexForAgent()`（分类 + 命令 id 约 10 行），新增零发送工具 `mud_help`，删除 `commandsTextForAgent()`（§16）；
- ⑤ **回看缓冲只收可能投递的行**（state 入库行与直接执行行不再作为"尚未投递的输出"倒出）；
- ⑥ 修**分页动作从未生效**（`mud_send` 单体 `cmd` 把空白当空命令拒绝 → 改 `cmds: [' ']`）；
- ⑦ **`exec.concludeTurn` 已定不接**（§18.11）；
- ⑧ 新增 `tests/commands.spec.ts`（7 例）、`tests/runtime-direct-action.spec.ts`（5 例）+ 感知/工具用例，合计 299 例

## v0.4.0（设计稿）（2026-09-12）流程化重构（用户主导设计，待实现）
- 根因 = "把逻辑步骤寄存在模型回合历史里"（`turnRef` + 命中队列 + 游标 + 帧归属 + 搭车队列），时序一偏就静默卡死、归属一错就串步。
- ① **流程表**（§19）：每条流程 = 显式步骤图，每步 = `driver（可省 = 顺序步）/ action / onEnter / ok / fail / next / retry? / timeoutMs`；`state` 仍留在 trigger，两者不重复；流程表注册为**运行时状态**（diag 可见、每次迁移留痕）；
- ② **判据统一 + 注册期校验**：`GA` 是 `MatchSpec` 的一种 kind（**必须显式声明**在 `ok` 或 `fail`：`ok:[GA]` 即"命令被接受就算成功"），**同一步的 ok/fail 判据集互斥（含 GA 只能出现一边），装配期报错不装配**；arming = 本步 driver(重试) + 本步 ok/fail + **条件分支**后继 driver，"条件分支 vs 顺序兜底"据此区分（MXP 不出现不阻塞）；结果三态 **成功/失败/超时**（无静默）；
- ③ **挂起/唤醒**：命令发出后挂起 = 桥的单槽 pending；判据命中（行匹配 或 GA）= 单出口唤醒（注销 arming + 结算 + 投递下一步，**先投递后唤醒**）；挂起期间新的应答桥请求**当场拒绝 + 留痕**；
- ④ **打断与排队**：规则声明 `interrupts`、流程声明 `priority`（**纯数字直接比大小，normal = 100**；login = 1000 不可打断，fullme = 100 可被打断），`interrupts > priority` 才可打断 → 挂起结算为 `interrupted` + 流程失败收束 + 可选 `onInterrupt` 命令 + 投递事件动作；不可打断 → 排队；流程期间的其它流程入口 → `pending entry` 接续；
- ⑤ **T1 全面重构（§7）**：退化为**无状态动作渲染器** —— 本步认领到的消息带动作请求 → 渲染 tool-call；无请求 → 收束；"是否已渲染"用确定性 call-id + 已有 tool-result 判定；**契约检验 I15（T2 可用）**：不得出现只有 T1 能理解的引用，投递消息必须自洽到 T2 拿到也能自己决定；
- ⑥ **登录流程重写**：五条 login 规则退役 → `name/pass/replace/success/mxp/look` 步骤；`when: !logged_in`；**MXP 探测是可能分支**（`mxp` 条件分支发空行、`look` 顺序步 `ok:[GA]`），"空行 + look"不再由 `Config.loginExitCommands`/`noteLoginExit` 承担；
- ⑦ 删除：`login-stall` 看门狗（每步 timeout 接管）、命中积压 / 回合记录 / `takeTurns` 游标 / `activeTurnRef` / 帧归属 / 搭车队列 / `MAX_TURNS`（§16）；
- ⑧ 不变量扩到十五条（§1：I10 单流程互斥 / I11 单挂起 / I12 挂起闸门+单出口 / I13 判据统一与注册期互斥 / I14 打断档位 / I15 T1 契约检验）；
- ⑨ 新切片 **W5**（§17，状态：设计定稿待实现），测试计划见 §13.6

## v0.4.0（流程语义定稿）（2026-09-13）作者逐条确认 login 语义
- ① `success` 进入判据 = **等成功句**（服务端不响应即异常）；
- ② 终态**空命令必有 GA**，无响应即异常 → 保留 `ok:[GA]`（超时失败收束）；
- ③ **"本步结果 = 下一步的新文本"** → `name`/`pass`/`replace` 一律**不写 `ok`**："请输入密码"只写在 `pass.driver`、"替换人物"只写在 `replace.driver`、"目前权限/重新连线"只写在 `success.driver`（写重复的 `ok` 会抢在条件分支之前命中、把提示行消费掉 → 走不到下一步）；
- ④ **断线重连一律重新跑整套登录**（`logged_in` 随连接建立复位，代码路径已确认）；
- ⑤ **失败不设恢复路径** → `LOGIN_FLOW.failPolicy = { notify: 'none' }`：用户名/密码是人工给的、密码错还会连带断连，只写日志 + 决策记录，**不唤醒 T2**。代码：`config/flows.ts`。测试：`flow-login.spec.ts` 的"四步图"断言改为校验"三步都没有 `ok`" + `failPolicy`，"分支超时"用例改为"本步超时"（`name` 不再有 GA 判据 ⇒ 等不到提示行时停在 `awaiting-result`），分支阶段计时器用例移到 `flow-interrupt.spec.ts`（那里仍有 `ok:[GA]` + 条件后继的形状）—— 全包 **304 例全绿**

## v0.4.0（login 精简）（2026-09-13）作者定案：login 精简为四步 + 放开空命令**。① **流程表
- `name / pass / replace(可能) / success(终态)` —— 删掉 `mxp` 与 `look`；`success` 的进入判据 = "已进入游戏"的成功句（`目前权限：(player)` 等；条件分支），进入即 `patch{logged_in:true}` 并**发空命令**（`mud_send { cmd:'' }`，`ok:[GA]`，`next` 空 = 终态）。
- ② **空命令成为合法命令**（作者：其他客户端也允许）：`network/response.ts` 的 `sendAndAwait` 只在"一条命令都没有"时拒绝（原判据是"全为空即拒绝"）；`agent/tools.ts` 的 `mud_send` 允许 `cmd:''`（发空行），只有 `cmd` 不是字符串（既没 cmd 也没 cmds）才算参数错误；空命令照旧进 `flowCommands`（工具闸门的登录豁免判据）。
- ③ **修 `ownCommandLive` 生命周期 bug**（新流程暴露的实测缺陷）：它此前只在"判定节点"分支复位、**action 步迁移时不复位** → 上一条命令的 GA 会把"命令还没写出"的新步（`ok:[GA]`）误判成成功；现在 `enterStep` 每次迁移都复位（与 §19.3 的写法一致）。
- ④ 测试：`flow-login.spec.ts` 重写为 9 例、`tools.spec.ts` 与 `loop-sim-login.spec.ts` 跟随新契约

## v0.4.0（实测）（2026-09-13）第一步：量清现行投递在官方 loop 下的形状（只改文档 + 测试脚手架）**。新增 `tests/loop-sim.ts`（**官方 loop 最小忠实模拟器
- 拖动器 `while (await turn())`、`claim` 语义、回合首步空认领即收束、`additionalContexts` → `next-step`、`concludesTurn` 收束、插件 lane 记忆，逐条标源码出处）+ `tests/loop-sim-login.spec.ts`（3 例）。**实测**（login 全链）：现状 `followup` = **3 回合 / 6 步 / 6 次模型请求**（每步一次空续步，一步一回合）；提议 A `defer` = 1 回合 / 4 次；提议 B `defer`+`concludeTurn` = 1 回合 / 3 次；三例 `t2Calls = 0`（流程期间不落到真实 LLM）。结论与落地设计写入 §19.6.1，模拟器与"回合/步骤账目必须在它上面量"的规矩写入 §13.6，投递通道切换登记为 §19.7 待定 1（**待作者审定后编码**）

## v0.4.0（实现·续）（2026-09-13）作者四条定案落地
- ① **MXP 发任何命令都能跳过** → `mxp` 步改发 `look`（桥的空命令判据不放宽，仓库里"空行退 MXP"的注释/用例标题一并改正）；
- ② **GA 与其它判据同权**（文档表述改正，代码本就如此）；
- ③ **`succeedStep` 只是里程碑** → 顺序兜底增加"结算之后"执行点（`noteSettle` 返回动作 + 运行时 `queueFlowActions` 投递）；
- ④ **分支阶段也要计时器** → `succeedStep` 后按 `step.timeoutMs ?? flow.timeoutMs` 重新布防（文案"等待后继判据超时 (Nms)"），`armTimer` 增加 `why` 参数。**打断/排队接线**：`ActionSpec.interrupts`（规则声明面）+ 运行时 `admitRuleHits`（批次内打断准入）+ `CommandResponseController.interruptInFlight`（在途/排队请求当场结算为 `ReplySettle='interrupted'`，工具拿到 `{ok:false, settled:'interrupted'}`）+ `drainFlowQueue`（流程结束后排队动作出队投递）。测试：新增 `tests/flow-interrupt.spec.ts`（7 例，含 login=1000 不可打断 + 超时出队 + 序列不再发剩余命令），`tests/flow-login.spec.ts` 的 MXP 用例改为全链（mxp→look→终态 look）—— 全包 **299 例全绿**（此后 `loop-sim-login.spec.ts` 3 例 → 302 例）。§11 增补**提议的 `FULLME_FLOW`**（供作者审定，未实现）与实施清单；§19.7 重写为"已定案 5 条 / 待定 3 条"

## v0.4.0（T2 限流）（2026-09-13）作者定案：限流只做"通道豁免"+"T2 投递限流"**（不做每步调用配额 —— 作者认为那容易导致异常）。① **限速豁免判据从登录态改为通道
- `tool-gate.ts` 增加 `currentLane?: () => 't1'\|'t2'\|undefined`，`t1Call = currentLane() === 't1'` 与 `systemCall = loginFlow() && 命令属登录/流程命令集` 任一成立即**不等**；通道读数由选路侧在 `agent/pre-step` 广播（`OwnedLaneRoutingOptions.onLane`；`index.ts` 的 `attachPolicy` 用局部变量把两者串起来）。原实现只按 `loginFlow()` 豁免 —— 登录一完成就是 false，导致 T1 的规则动作与流程步动作（fullme 答案）被无谓推迟 1 秒。
- ② **T2 投递限流**：新增 `Config.t2DeliverIntervalMs`（缺省 `DEFAULT_T2_DELIVER_INTERVAL_MS = 2000`）；`settle()` 的批次路径在距上次 T2 投递不足间隔时**不投**（行留待决、`scheduleSettle(差额)` 延后），控制消息投出时记一次时刻；**T1 动作投递 / 帧内命中的动作投递 / 控制消息本身都不受限**。动机：实测登录后 T2 接管 1 秒一条刷查询（look/hp/score/skills）。测试：`permission.spec.ts` 增"限速豁免: T1 通道即使已登录也不等; T2 照常等"（26 例）、`runtime-delivery.spec.ts` 增"T2 投递限流: 间隔内不投 T2 批次; T1 动作照常投; 到期合并投出"（4 例）—— 全包 **312 例全绿**

## v0.4.0（defer 通道落地）（2026-09-13）投递通道切换实现**（作者批准的 §19.6.2 三条判据）。① **判据 A
- `session-runtime` 新增 `inFlightTools` 计数与 `deferSlot` 槽，投递统一走 `sendDelivery` —— 工具在途 ⇒ 入槽（`debug` 记 `投递改为 defer`），否则官方 `followup`。
- ② **包装器接线**：`agent-bridge` 新增 `MudDeliveryChannel`（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries`/`shouldConcludeTurn`），`attachMudTools(..., channel?)` 在 `execute` 前后 begin/end、结果提交前逐条 `exec.deferContext`、`result.ok && shouldConcludeTurn(callId)` 时 `exec.concludeTurn()`；`index.ts` 的 `mountToolsForTier` 把 `runtime` 当通道传进去。
- ③ **判据 B**：`deliverySizes`（每条投递的动作数）+ `parseDeliveryCallId`（`mud-<delivery>-<index>`；**T2 自己的调用 id 解析失败 ⇒ 永不可收束**）+ 四项收束条件（最后一条 ∧ 槽空 ∧ 无待投递动作/独立投递/流程排队 ∧ **流程机空闲**）。
- ④ **判据 C**：只在成功结果上收束；失败/超时/打断什么都不做（打断的事件动作随 `interrupted` 结果 defer）。
- ⑤ **模拟器升级为"仿真官方包装器"**：`loop-sim` 不再靠测试内建模，`loop-sim-login.spec.ts` 量到**真行为账目 = 1 回合 / 3 步 / 3 次模型请求 / 0 空续步**（`deferred=2`、`concludedTurns=1`），与落地前基线（3 回合 / 6 次）的对照见 §19.6.1。
- ⑥ 新增 `tests/runtime-defer.spec.ts`（4 例）；顺带**看门狗日志降噪**（`touch()` 的窗口重置静默布防，`watchdogs.ts` 的 `arm(entry, quiet)`）。
- ⑦ **实测抓到的缺口并修复**：接线只在宿主路径（`attachMudTools`），而生产跑的是 **preset 路径**（`preset-agent.ts` 有自己那份 `defineTool` 包装器）⇒ `beginToolCall()` 从未被调用、defer 完全失效（实测日志仍是"独立投递 → 新回合"，账目停在 3 回合 / 6 次）。修法：抽出 **`runWithDeliveryChannel`**（两条路径共用一份接线），`preset-agent` 经 `MudAgentKit.channel(sessionId)` 取该会话运行时的通道；`preset-agent.spec.ts` 新增两例钉住（接线顺序 `begin→end→take→conclude?<callId>`、失败时只 defer 不收束）—— 全包 **316 例全绿**

## v0.4.0（看门狗时机）（2026-09-13）**作者定案
- `dead-air` 布防判据从"`logged_in` 置真"改为"`logged_in` ∧ 无活跃流程"** —— 一条条件同时实现两个目的：
- ① 布防推迟到 **login 流程收尾之后**（`logged_in` 可能被 **GMCP** 提前置真：`GMCP.System {site}` 是 pkuxkx 的登录成功通知，`world.ts:130-147`，早于 `success` 步的 `onEnter.patch`；实测日志里 dead-air 正是在登录尚未收尾时就开始计时的）；
- ② **活跃流程期间看门狗停表**（流程可能等很久才有结果，期间的唤醒归流程自己的计时器）。实现：`dead-air.active()` 增加 `this.flow.state() === null`；新增 `FlowRuntimeOptions.onTransition`（进入某步/收束/失败/复位时通知运行时 `noteWorldChange()`），否则流程起停不会触发重评估。`success` 步的 `logged_in` 置真**保留**（作者要求：防 GMCP 变化，作为权威兜底）。测试：`runtime-watchdog.spec.ts` 新增"活跃流程期间不布防断流；流程收束后才布防"（探针流程 + 假连接捕获 sink 喂行）—— 全包 **310 例全绿**

## v0.4.0（归属加固）（2026-09-13）桥结算归属：布尔标记 → 按命令比对**（作者批准的"GA 结算携带命令"小改）。① `network/response.ts`：`onSettle(kind, text, cmds)` —— `notifySettle` 透传 `reply.cmds`（**被这次结算关掉的命令**），error/timeout/abort/interrupted/ga 各条路径都带上。② `runtime/flow-runtime.ts`：删掉 `ownCommandLive` 布尔标记，改为 `ownCommands: Set<string>` —— `allowBridgeRequest`/`noteOwnCommandWritten` 放行命令时记入（插值 + trim），`noteSettle(kind, text, cmds)` 用"有交集"判定归属、通过后**消费**（同命令的重复/迟到 GA 不二次结算），`enterStep`/收束/复位/释放时清空；`cmds` 缺省时退化为旧语义（兼容）。③ 日志升级为**点名命令**并加 `mask` 脱敏（`redactSecrets`：密码 + 人工外部值 ≥3 字符）——实测发现点名日志曾把密码打成明文，已修并有测试钉住。④ 新增 `tests/flow-ownership.spec.ts`（本步命令生效 / 别命令点名拒绝且不消费 / 序列任一条命中即算本步 / 缺省 cmds 兼容 / mask 脱敏）。**意义
- 一个步骤发多条命令（fullme 的 `['halt','fullme {captcha}']`）时，别的命令的 GA 不会再串结算本步

## v0.4.0（投递形态定名）（2026-09-13）**作者定名
- 投递形态 =「原文投递 / 动作投递」**（纯命名，机制与判据一字未动）。
- ① 定义：**原文投递** = 消息体带触发段原文 + 动作请求（T1 规则命中 / 流程步动作）；**动作投递** = 无原文可带、只有动作请求（帧内命中 / 人工回填 / 结算驱动 / 排队出队）；形态只决定"消息里有没有原文"，与投递通道（`followup` / `defer`）**正交** —— 旧称"反射消息 / 帧内独立投递 / 规则反射"全部废止，映射写入 §2 与 §5。
- ② 代码侧只改字面：`session-runtime.ts` 日志 `[感知] 原文投递 N 行 + M 动作` / `[感知] 动作投递 N 动作 (无原文: 帧内命中 / 人工回填 / 结算驱动)`、决策栏理由 `T1 原文投递` / `T1 动作投递`，`flow-runtime.ts`/`index.ts`/`perception/split.ts` 的注释同名化。
- ③ 文档：§2 新增"投递形态"术语行、§5 增两条（形态定义 + 形态与通道正交）、§12 日志表列全四条投递日志（含 `投递改为 defer`）。测试 **316 例全绿**，`tsc --noEmit` 干净

## v0.4.0（fullme 流程定稿）（2026-09-13）作者逐条审定 fullme 流程（五步）
- ① 流程表 `request → [stale \| prompt] → answer → success`（§11）；`request` **无 ok**（本步结果 = 下一步的新文本），fail = 实录"刚刚用过"句（时长动态，`[^。]*` 通吃"几分几秒 / 几秒"，总计 15 分钟），后继两条条件分支；
- ② `stale`（实录：上一轮未完成提示）**三连发 `fullme 1`** 才真放弃，以 GA 判定并以**失败收束**收场（复位、不叫 T2）；
- ③ `prompt` 用**新工具 `mud_captcha`** 取图 + 弹窗，判据是新的 **`{ kind:'tool' }` 工具结果判据**；地址经流程槽 `{captchaUrl}`（步上 `capture` 声明）交给工具；
- ④ `answer` 三次答错重来（`retry { attempts:3, on:['fail'], action: mud_captcha{…} }`：**在原步内自环** —— 清空 `{captcha}`、重解析图片并弹窗带 `{lastFail}` 失败原文、重新挂起等人工，**不重置本步计时器**；`answer.timeoutMs = 180000` 是**本步总预算**（等人工 + 重来 + 收结果）＝图片有效期，到点即本轮失败）；
- ⑤ **三种收场（取图失败 / 答错 3 次 / 人工超时）都由下一轮的 `stale` 兜住**（答错 3 次与"三连放弃"等价 ⇒ 下一轮不进 `stale`），运行时不另记状态；
- ⑥ `success` 发 `hpbrief`（`ok:[GA]`）补状态，`failPolicy: { notify:'none' }`；
- ⑦ 声明面扩展：`MatchSpec` 增 `tool` kind 与可选 `why` 文案、`FlowStep` 增 `capture`、`retry` 定稿为 `{ attempts, on?, action? }`（`attempts` = **总尝试次数含首次**）、占位符分三类（运行时值 / 内建 `{lastFail}` / `capture` 槽）并新增注册期校验（§19.1）；**不引入 `humanTimeoutMs`/`humanWaitMs`**（作者同日修正：人工环节沿用本步 `timeoutMs`）；
- ⑧ 推进规则：`retry.on:['fail']` = **原步内**答错重来且**不重置计时器**、人工环节**不判行且计时不停**、`resumeHuman()` 回到 awaiting-result 不重布防（§19.2/§19.3）。文档：§11 定稿流程表 + `FlowSpec` + **8 项实现清单**（含流程路径人工环节三处修复）；§19.7 把"投递通道"（已落地）与 fullme 转为已定案；§16 增四条删除项（三条 fullme 规则 / 运行时取图职责 / `fullme_ok`）。**代码待实施**

## v0.4.0（fullme 流程落地）（2026-09-13）按 §11 定稿实现 fullme 流程（代码 + 测试）
- ① `config/flows.ts`：`FULLME_FLOW` 五步 + 常量（`FULLME_REMINDER_TEXT`/`FULLME_STALE_TEXT`/`FULLME_OK_TEXT`/`FULLME_WRONG_TEXT`/`FULLME_COOLDOWN_PATTERN`/`FULLME_URL_PATTERN`/`FULLME_URL_CAPTURE`）+ `defaultFlows = [LOGIN_FLOW, FULLME_FLOW]`；`FlowMatch` 增 `{ kind:'tool', outcome }` 与可选 `why`，`FlowStep` 增 `capture`，`retry` 定稿 `{ attempts, on?, action? }`；`validateFlows` 增四类校验（tool 判据需动作、占位符三类、retry 声明、capture 槽名唯一）。
- ② `runtime/flow-runtime.ts`：流程实例槽（`capture` 抽取 + 内建 `{lastFail}`）+ `slotNames()`、`noteToolResult(stepId, ok)`（工具结果判据，失败优先、失败**不走重试**）、`tryRetry`（**原步内重试**：投 `retry.action` → 清 `awaitExternal` 槽 → 写 `{lastFail}` → 重新挂起；**不重置计时器**）、`awaitExternal` 步**照常布防计时器**（人工等待并入本步预算）、**人工环节不判行**、`refreshEntries()`（`when` 随 world 翻转）。
- ③ `runtime/session-runtime.ts`：投递记录 `deliveryRules`（call-id → 动作 `ruleId` → 步骤 id）→ `noteToolResult`；`fillSlots` 投递前插值；`queueFlowActions` 改为**先投递后挂起**；`exitHumanWait` → `flow.resumeHuman()` + **动作投递**；`syncHumanWait`（流程收束/超时后退出人工环节）；取图职责迁出（`sink.captcha` 改为"推已解析图片 + note"）；退役 `Config.captchaPatterns`/`extractCaptchaUrl`。
- ④ `agent/tools.ts`：新工具 **`mud_captcha`**（围栏 + 抓 `robot.php` + 取 `<img src>` + 推送宿主 + `{ok,image}`），三档都注册（`permission/tiers.ts`）。
- ⑤ `agent/agent-bridge.ts`：`MudDeliveryChannel.noteToolResult`，在 `endToolCall()` **之前**喂回结果（判定产出的投递仍随本结果 defer）。
- ⑥ 退役 `fullme:request`/`fullme:prompt`/`fullme:done` 三条规则与 `index.ts` 里的 `fullme:*` 过滤。
- ⑦ 测试：新增 `tests/flow-fullme.spec.ts`（11 例）+ 重写 `tests/runtime-captcha.spec.ts`（7 例，走**真工具包装器**：defer/工具结果/人工回填/重试/预算）；`rule-coverage`/`runtime-direct-action`/`permission`/`tools` 跟随调整 —— 全包 **327 例 / 30 文件全绿**，`tsc --noEmit` 干净。
- ⑧ 与定稿的两处措辞差异（实现为准）：success/答错句用 `text includes`（比整行正则宽容，服务器尾随空白不影响）；取图**解析在工具**、**UI 推送在宿主**（页面在宿主侧，工具只回结果）

## v0.4.0（实现）（2026-09-13）W5 落地（login 流程跑通）
- ① `config/flows.ts`（新）—— `FlowMatch`（`regex`/`text`/`ga`）/`FlowStep`/`FlowSpec` + `LOGIN_FLOW`（`priority:1000`、`when: !logged_in`）+ `validateFlows`（ok/fail 互斥含 GA、`next` 引用、id 唯一、`awaitExternal` 占位符）+ `flowCommands()`；
- ② `runtime/flow-runtime.ts`（新）—— arming（本步 driver + ok/fail + **条件分支后继 driver**，**同批行优先**）、判定顺序（失败 → 介入判据分支 → ok → 顺序兜底 → 终态）、`enterStep`/`succeedStep`/`retryStep`/`finishFlow`/`failStep`、`interrupt`/排队/pending entry、`diag` 状态；
- ③ **桥归属**（§19.3；v0.4.0 归属加固中升级为按命令比对）—— GA/until/超时/abort 只在本步声明并放行过的命令带来时才被接受，否则上一条命令的 GA 会误结算下一步（实测症状）；
- ④ T1 重写为**无状态动作渲染器**（读 `source.actions` + `delivery`，call-id = `mud-<delivery>-<index>`，已有同 id `tool-result` ⇒ 不重复渲染）；
- ⑤ `MessageSourceMap['mud-owned']` 去掉 `turnRef`、增 `actions`/`delivery`；`ownedGameMessage(text, lane, sid, {actions, delivery})`；
- ⑥ 运行时：`pendingActions`/`deliverySeq`/`standalone`（帧内命中与人工回填 = **独立投递**，不再"等下一次搭车"）、`settle()` 单流切分带动作、`exitHumanWait` 分"待决路径/帧路径"；
- ⑦ 删除 `turns`/`takeHits`/`activeTurnRef`/`deliverSelfHits`/`noteLoginExit`/`Config.loginExitCommands`/`login-stall`/五条 `login:*` 规则（§16）；
- ⑧ 测试：`tests/flow-login.spec.ts`、`tests/t1-adapter.spec.ts` 重写（8 例）、`tests/runtime-captcha.spec.ts` 改写（8 例）、`tests/rule-coverage.spec.ts` 去 login 样本；
- ⑨ 作者三条定案（2026-09-13）：**MXP 发任何命令都能跳过**、**GA 与其它判据同权**、**`succeedStep` 只是里程碑**（流程收束在终态步）→ 顺序兜底增加"结算之后补跑"执行点

## v0.4.0（文档拆分）（2026-09-14）设计事实源拆分为多文件（面向 AI 读者的上下文压缩）
- 入口 `doc/ARCHITECTURE.md`（§0 + 章节地图 + 任务索引）；§1–§3 → `architecture/00-core.md`；§4–§6 / §7–§8 / §9–§10 / §11 / §12–§13 / §17–§18 / §19 → `doc/architecture/*`；login 与 fullme 流程声明从 §11 拆出 → `doc/flows/{login,fullme}.md`；§14+§16 → `doc/history/`（status: archived）；§15 → 本文件；附录 A/B → `doc/appendices/`。**§N 编号稳定不变**，代码注释里的 `§N` 引用不受影响；"§11 的流程表"现指 `doc/flows/` 对应文件。内容除 §11 拆分与该文件内定案叙述去日期化外逐字保留（拆分前全文见 git 历史 e7566c8 的 `doc/ARCHITECTURE.md`）

## v0.4.0（源码目录重组）（2026-09-14）按定稿五区目录重建 `packages/mud-core/src`（WP1–WP3，T1 完整保留，行为零变更）
- `shell/{wire,hub,global-buffers,view,routes}`、`agents/{lane,mount,t1,tools,skills,preset,captcha}`、`runtime/session/{session,types,bridge,queue,gmcp}`+`runtime/flow/{flow,flow-types,flows}`+`runtime/watchdogs.ts`、`perceive/{engine,split,rules,service,types}`、`shared/{world,game,commands}`、`services/{matcher,network,gate,log}`；`src/index.ts` 变薄入口（装配移 `assemble.ts`）。**@module 标识** = 相对路径去 `.ts`（路径即标识；`agents/preset.ts` 保留正式出口名 `preset-agent`）。**WP3**：gate 注入化 —— 新增 `services/gate/rules.ts`（`GateRules` + `buildGateRules`，从 `shared/game`+`shared/commands` 组装命令派生器与危险表），`policy.ts`/`tool-gate.ts` 不再直接持有游戏知识（`evaluateToolCall` 判据改收 `rules`）；`preprocess/`、`config/`、`network/response.ts` 等扁平残留并入 `services/network/ansi.ts`/`agents/skills.ts`/`runtime/session/bridge.ts`；matcher `PerceptRecord` → `MatchRecord`。全包 **333 例 / 30 文件全绿**，`tsc --noEmit` 与 `pnpm build` 干净。

## v0.6.0（2026-09-14）分帧器统一边界裁决（§8 重写，作者审定三决策：① 内存阀兜底无标记输出；② 插话并入事务响应；③ `timeout` 留名改义 = 放弃，`silent` 删除）
- ① 边界只认两类标记 —— GA/EOR（八成，常驻缺省）与声明判据（十成，随事务/流程/打断注册为武装标记；§19 arming 集 = 分帧器标记表）；
- ② 静默/超时不再是边界：timeout = 放弃等待（帧不动、标记保持武装、回放只进诊断），帧提交 = 消费链五站单遍（折叠→触发→事务结算→流程判据→残余记账），取代 onTextBlock 分支树与 settle() 汇合点；
- ③ 事务响应 = 窗口内帧并集（跨帧累积，`lm` 分页与 `dz` 无 GA 收尾不再是特例）；
- ④ 删除清单：SILENT_MARKER / TIMEOUT_MARKER 进帧 / 孤儿 GA 计数器（R2-11）/ 结算优先级阶梯 / 300ms 静默作消费边界；
- ⑤ 实现切片：**S1** frame-splitter.ts（分帧器）→ **S2** bridge.ts 瘦身（删静默/孤儿/超时进帧，timeout 改放弃）→ **S3a** 分帧器接线（session.onBoundary 消亡，分帧器 onFrameCommitted 统一桥结算 + 投递，零行为变化）→ S3b 感知迁移 / S3c until 武装标记 / S3d 消费链完整闭环待实施

## v0.6.0（S2–S4 落地）（2026-09-15）切片 S2/S3/S4 完成（333 例 / 30 文件全绿）
- ① **S2 事务表瘦身**：删静默结算（`silent`/SILENT_MARKER）、孤儿 GA 计数器（ORPHAN_EXPIRE_MS 全套）、结算优先级阶梯、TIMEOUT_MARKER 进帧（超时 = 放弃，帧不动、标记保持武装）；`MudReply.text/lines` 改**事务窗口内帧并集**（跨帧累积）；
- ② **S3 消费链重组**：五站链（状态折叠 → 规则触发 → 事务结算 → 流程判据 → 残余记账/投递）整体搬到分帧器提交点 `onFrameCommitted`（§8.2 固定次序单遍），`onTextBlock` 只喂行给分帧器；修重入 bug（`splitter.feedLines` 移到 `controller.feedLines` 之后，避免帧早于事务窗口提交）；重连路径补 `splitter.reset()` + 武装标记重布防；**§8.5 武装标记同步**：流程判据与打断规则经 `syncFlowMarkers`/`armInterruptRules` 注册为分帧器武装标记（`lineCriteriaPattern` 编译 regex/text 判据），命中即提交帧当场唤醒/打断；300ms 静默（`bridgeSilenceMs`）降级为分帧器装配阀 `autoFlushMs`（网络装配粒度，非消费边界）；
- ③ **S4 措辞同步**：`assemble.ts` 消息流头注释（删 turnRef 旧语）、`tools.ts`/`perceive/types.ts` 的 until 描述（GA 八成缺省、判据上收武装标记）、`watchdogs.ts`/`session/types.ts` 计时器边界与 `MAX_SETTLE_LINES`/`MAX_INJECT_TAIL` 注释；文档 §2（新增**帧（frame）**术语行 + 数据流/总体架构图插分帧器）、§5（结算点 = 帧提交点）、§11（看门狗边界改装配阀）、§19（arming 集 = 分帧器标记表落点）、§12（单元测试列分帧器/帧并集桥）；
- ④ **测试对齐**：新增 `tests/frame-splitter.spec.ts`（13 例：GA/EOR/armed/valve 切帧、批次续行、reset 幂等）、`tests/response.spec.ts` 重写为 v0.6.0 帧并集版（20 例）、`tests/runtime-delivery.spec.ts` 按帧化交付水位调整（4 例）

## v0.6.1（2026-09-15）会话运行时三刀拆分（session.ts 复杂度收敛，机制出走、编排留守，行为零变更）
- ① **刀1 凭据域**：脱敏纯函数出走 → `runtime/session/credentials.ts`（`redactCredential` 密码打码 / `redactSecrets` 日志脱敏含人工回填值 ≥3 字符 / `placeholderValues` 占位符值表），session 只调函数；
- ② **刀2 连接运行时**：`runtime/session/connection-runtime.ts`（`ConnectionRuntime`）—— connect 重入防护（connected/connecting 均拒绝）、断连旧条目 close 兜底、socket 事件接线（text/lines/boundary/gmcp → 回调回会话）、连接 id 持有与 `write()` 出口、会话凭据持有；session 经 `this.conn` 访问，不再直连 manager；
- ③ **刀3 投递通道**：`runtime/session/delivery-channel.ts`（`DeliveryChannel`）—— 工具在途计数与 defer 槽（判据 A）、投递账本（size/rules/pending，判据 B 与流程 tool 判据解析依据）、**按完成驱逐 + 安全上限 32** 的账本驱逐策略、T2 投递限流时刻；session 保留编排（何时构造消息/何时结算/shouldConcludeTurn 流程联动），并对外转发 `MudDeliveryChannel` 接口形状（`beginToolCall`/`endToolCall`/`takeDeferredDeliveries` → 通道委托，`assemble.ts` 两条装配路径不变）；删除 session 的 `deliverySeq`/`deliverySizes`/`deliveryRules`/`deliveryPending`/`deferSlot`/`inFlightTools`/`lastT2DeliverAt` 散装字段；
- ④ 重连/释放时 `channel.reset() 清 defer 槽与账本（上一连接局面作废）。全包 **333 例 / 30 文件全绿**，`tsc --noEmit` 干净

## v0.6.1（状态跟踪正名）（2026-09-15）`gmcp.ts` → `state.ts`：状态捕获 → 状态跟踪（world 写入统一入口，作者提出：模块不只服务 GMCP，触发后抓取同步状态也走它）
- ① 文件正名 `runtime/session/gmcp.ts` → `state.ts`（@module 同步；类名本就是 `StateService`），模块头改写为 world **写入通路全景** —— GMCP 直连（`onGmcp`，权威 1.0）/ 感知 state 折叠（`patch(...,'percept')`，消费链站
- ①）/ 流程 `onEnter.patch`（`patch(...,'flow')`）/ 连接生命周期护栏位（`patch(...,'lifecycle')`）/ agent `world_patch` 工具（闭包持同一 WorldModel 直写，语义路径不经本模块）；
- ② 新增通用入口 `StateService.patch(patch, why)`（`StateWriteSource = 'gmcp'|'percept'|'flow'|'lifecycle'`），变化 → onChanged → pushWorld 节流广播；
- ③ session.ts 五处直写 `applyPatch(this.world, …)` 全部改走 `this.state.patch(...)`（感知折叠站
- ① / 流程 patch 接线 / connect 的 connected+sent_name / close 的 connected），session 不再直接 import applyPatch —— 感知折叠与流程落库由此获得与 GMCP 同款的 UI 快照广播（原来只有 GMCP 写入会触发 pushWorld，行为微改善）；测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（流程表拆目录）（2026-09-15）`flows.ts`（482 行单文件）→ `flows/` 目录，与 `doc/flows/{login,fullme}.md` 的文档拆分对齐（作者提出）
- ① 目录分工 —— `spec.ts`（声明面类型 + 判据工具 `FlowMatch`/`FlowSpec`/`matchLabel`/`matchKey`/`isLineMatch` + `PRIORITY_NORMAL`）、`validate.ts`（`validateFlows` 注册期校验 §19.1）、`login.ts`（`LOGIN_FLOW`）、`fullme.ts`（fullme 七常量 + `FULLME_FLOW`）、`index.ts`（`defaultFlows` 汇总 + `flowCommands` + re-export 单一入口）；
- ② 模块标识 `runtime/flow/flows` 沿用（= index.ts），子模块 `flows/spec` 等按路径派生；
- ③ 顺带清理：删无人使用的 `matchWhy()`、`flowCommands` 去掉 `defaultFlows` 默认参（所有调用方均显式传入，避免 index ↔ validate 循环依赖）；
- ④ 13 处 import 路径跟随（src 5 处 + tests 8 处；类型专用 import 直指 `flows/spec.ts`，其余走 index barrel）。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（契约上收）（2026-09-15）声明面契约从 `flows/` 上收到 flow 层（作者质疑：flows/ 应为纯声明数据）
- ① `flows/spec.ts` + `flows/validate.ts` 合并为 `runtime/flow/flow-spec.ts`（契约/数据/引擎三处分层，与 `perceive/{types,rules,engine}` 同构）—— 类型 `FlowMatch`/`FlowStep`/`FlowSpec` + 判据工具 + `PRIORITY_NORMAL` + 注册期校验 `validateFlows`（§19.1，FlowRuntime 构造时的 fail-loud 门）；`flows/` 只剩 `index.ts`（defaultFlows 汇总 + flowCommands + re-export）/`login.ts`/`fullme.ts` 纯数据；
- ② 依赖方向理顺：`flow.ts` 引擎改为直接依赖 `./flow-spec.ts`，**不再经过数据 barrel**（引擎依赖契约不依赖数据）；login/fullme 向上引用 `../flow-spec.ts`；
- ③ flows/index.ts 头注改写为三处分层说明。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（凭据机制提升）（2026-09-15）`session/credentials.ts` → `runtime/credentials.ts`（作者提出：纯函数非会话专用）
- ① 脱敏纯函数（`redactCredential`/`redactSecrets`/`placeholderValues`）提升到 runtime 根（与 `watchdogs.ts` 根级共享模块同例）；
- ② **依赖方向修正**：`SessionCredentials` 类型从 `agents/tools.ts` 收进 `runtime/credentials.ts`（原 credentials.ts 反向 import tools 形成 runtime → agents），提升后 tools/session/connection 统一引用新家（agents → runtime 方向，tools.ts 本就引用 runtime 的 bridge 类型）；
- ③ 模块头写明定位：会话只是凭据机制当前唯一的接线者，不是机制的所有者。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（判据编译归位）（2026-09-15）`lineCriteriaPattern` 从 `session/frame-splitter.ts` → `services/matcher/criteria.ts`（作者拍板：目录审视三建议中只做这件，watchdogs 留 runtime 根、tools→bridge 类型引用不动）
- 行判据编译（`{kind, patterns/includes}` → any-of 标记正则）是**匹配域**纯函数，不依赖 FlowMatch 类型也不依赖分帧器状态，消费方两处 —— 分帧器武装标记接线（§8.5，经 session.ts L157）与流程运行时 arming（§19，flow.ts L758）；此前 flow → session 跨域伸手，归位 matcher 服务域后双方同向引用。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（感知装配归引擎）（2026-09-15）`perceive/service.ts` 并入 `perceive/engine.ts`，感知目录四件套定形（作者拍板：service.ts 名不副实 —— 34 行一个纯函数占着"服务"名分，无状态无生命周期非运行态；单流切分同理不是服务，split.ts 语义明确不动）
- ① `splitPerceptionRules` + `PerceptionRuleSet` 迁入 engine.ts，且 `PerceptionRuleSet` 与 `PerceptionEngineOptions` 形状完全相同 → **合并为后者**（分桶函数直接返回引擎构造参数，消掉重复契约）；
- ② 删 `perceive/service.ts`，唯一调用方 assemble.ts 改 import（引擎构造前投一次影不变）；
- ③ perceive/ 最终四件：types（契约）/ engine（引擎 + 构造投影）/ rules（默认数据）/ split（L2 投递切分纯函数 —— 住感知层因为"切在哪"由感知消费边界决定，DeliveryChannel 是其下游的 line-agnostic 运输机制）。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（验证码解析归网络域）（2026-09-15）`agents/captcha.ts` → `services/network/captcha.ts`（作者问"为什么这么分"引出：拆分本身合理 —— 解析机制纯函数 vs `mud_captcha` 工具包装，但位置错 —— 模块头自称 network/captcha，实为 fetch + HTML 解析的网络域机制，且第二消费方在 shell/）
- ① 解析机制 `resolveCaptchaImage`（出站围栏 pkuxkx.net 白名单 / 5s 超时 / 256KB 上限 / 拒重定向 + robot.php 取 `<img src>` 归一）归位网络域，@module 同步，模块头补两条执行路径说明（工具 + `/mud/captcha/refresh` 路由）；
- ② 引用跟随 4 处（tools.ts / shell/routes.ts / tests/captcha.spec.ts / session/types.ts 注释）；拆分不动 —— 工具层（校验+UI 推送+结果格式）与机制层（网络 IO+解析）职责分明，"换一张"路由与工具共享同一份围栏语义。行为零变更，测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（shell 层修复五件）（2026-09-15）外部 AI 审查 10 项问题核实后按"最小改动集"落地（作者核可；核实结论：#1/#2 真缺陷，#4/#5/#7 部分成立属文档面，#3 attachSink 保留、#7c/#7d 记为已知权衡不动，提议的 transport 三合一大合并否决）
- ① **trust 出走**：`isTrustedRequest` + 3 个 helper 从 hub.ts → `shell/trust.ts`（纯 HTTP 头语义，与 ws 无关；此前 routes.ts 反向 import hub 致 HTTP 路由传递加载 `ws`）—— hub/routes 改 import，HTTP 面 ↔ WS 面横向依赖根除；
- ② **purge 补 pending 缺口**：hub 增 `purgeSession(sessionId)` 过滤 `gamePending/uiPending`，assemble 注销链路在 `buffers.purgeSession` 旁接线 —— 此前已入队未 flush 条目仍会广播（"回放不吐、实时漏一帧"，窗口一个 tick）；
- ③ **wire.ts 契约注释**：`MudGameItem`/`MudUiItem` 补 seq 契约 —— 实时广播与 hello 回填双路径可达（同 tick 重叠为正常时序）前端须按 seq 去重（GameView 已实现，契约此前只写在 client 侧）、跳号合法（缓冲驱逐后回填有缺口不应报错）；
- ④ **文档面**：view.ts 补"单用户设计"说明（lastActive 进程级指针的多用户代价：缺省请求会命中他人 lastActive 会话）、global-buffers.ts `readGame` 注明 readUi 缺席是刻意（UI 历史走 /mud/logs 按 logSeq 去重）；
- ⑤ **routes 消样板**：提 `jsonPost(path, logLabel, handler)` helper（method 校验 + body 解析 + 统一 400），8 个 POST 路由收拢（capability GET/POST 混合路由保持手工分派）。行为零变更（仅 purge 竞态缺口修复），测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.6.1（STATUS_CMDS 对齐注册表）（2026-09-15）`shared/game.ts` STATUS_CMDS 与命令注册表对齐（外部审查 #7 + 作者上线核实：skills 是 sk 的服务器别名；skbrief 查单项武功等级/小点；busy 为个人表情无实际作用）
- ① `skills: 'skills'` → `skills: 'sk'` —— 服务器别名统一映射到注册表命令（gate 改写与 help 菜单同源，消掉"注册表无 skills"的表间漂移）；
- ② 删 `busy` 条目（表情无状态价值，mud_status 的 what 枚举同步收窄 hp/score/inventory/skills，tools.ts 三处描述串跟随）；
- ③ 模块头注明对齐约定：STATUS_CMDS 值必须与 mudCommands 对齐，别名也映射到注册表命令。行为变更仅 mud_status 不再接受 busy（此前发 'busy' 只是表情，无信息量）；测试 333 例 / 30 文件全绿，`tsc --noEmit` 干净

## v0.7.0（2026-09-16）传输层整体迁移官方 typert remote（生成器模式，作者拍板 A/B/C 三选一取 B）—— 三套自建传输面（REST 路由 / WS hub / 信任围栏）收敛为官方一条 `/api` RPC + 一条 mux WS
- ① **协议镜像**：生成器要求协议包源码在 `<root>/packages` 内（`isWithin(realPath)` 判定，junction/link 被 realPath 还原后判外）→ `packages/typert-protocol/` 镜像 harness 协议包 src（workspace 独立构建，exports 指自建 `lib/types/`），mud-core/mud-webui 依赖 `workspace:*`；根 `tsconfig.host.json` 做生成器聚合配置（references 发现 + paths 直达镜像 src）；
- ② **host 面**：`shell/mud-remote-service.ts`（新）—— `MudRemoteService extends TypertRemoteService`，命名空间 `mud`，10 个 RPC 方法（bind/connect/disconnect/status/diag/command/captchaRefresh/logs/purge/capability+set）+ 3 条流方法（`mud/game`、`mud/ui`、`mud/world`，`@Remote({mode:'stream'})` 返回 AsyncIterable）；`shell/streams.ts`（新）—— 每订阅一条的流数据源（`MudFeedHub`：GlobalBuffers 按 sinceSeq 回填 + 实时尾随合流；`feedGame/feedUi/feedWorld` 三个 feed 入口）；`SessionView`（last-active 回落）从 view.ts 折叠进 service；
- ③ **删除**：`shell/routes.ts`（jsonPost 路由面）、`shell/hub.ts`（自建 WS 服务端：hello/心跳/合帧/广播）、`shell/trust.ts`（信任围栏 —— 官方 `isTrustedApiRequest` 经 `requestRejection` 统一施加，403 围栏 + 401 browserAuth 白拿）、`shell/view.ts`、`shell/wire.ts` 的 ws 帧协议类型（`MudGameItem/MudUiItem/MudWorldSnapshot` 移入 `shell/remote-types.ts`，exports 子路径 `./shell-wire` → `./remote-types`）；
- ④ **client 面（mud-webui）**：`client/mud-remote.ts`（新）—— `ctx.remote.$mount(TYPERT_REMOTE)` 后的 `ctx.remote.mud.*` 类型化 RPC 面；`client/mud-socket.ts` 重写 —— 自建 ws/hello/重连协议全删，换官方 mux 三流消费（`$stream` + RemoteStream 监督，退避重开 + lastSeq 游标续传）；LogView 当日恢复走 `remote.logs()`；tsdown purity 白名单加 `dsh-mud-core/remote`（生成的客户端工件 = inline-safe wire layer）；
- ⑤ **构建接线**：`scripts/gen-typert.mjs`（生成器驱动：严格 descriptor `typert.host.js` + 客户端工件 `typert.remote-client.js`，assemble 自持注册兜 file:// 补丁行 loader）；mud-core 布局 dist→lib（生成器 `lib/→src` 映射硬约定）；`src/shell/typert-host.d.ts` ambient 兜底（先 build 后 gen 的全新克隆可编译）；
- ⑥ **测试**：`tests/ws.spec.ts` 删除（hub 协议契约随 hub 消亡；信任围栏回归官方上游测试），新 `tests/buffers.spec.ts` 钉 GlobalBuffers 三不变式（seq 单调/超限驱逐/游标失效回绕/purge 过滤）；全包 333 例全绿，mud-webui build 通过。**设计依据**：SRC 模式评估后弃用 —— 官方客户端挂载强制严格 codec（`requireStrictDescriptor`），浏览器无 `rpc.open`（mux 客户端是 ClientRemoteService 私有成员），SRC 下 webui 需自写 mux 客户端且失去 zod 校验/类型生成；生成器模式一次性成本（镜像 + 分析器逐轮报错）换零自建传输与官方监督设施

## v0.7.0（2026-09-16）CHANGELOG 纲目化
- 作者提出：表格形式不便于浏览，取消表格改用纲目 —— 每个变更一个 `##` 大点（版本 + 日期 + 标题），变更内容按 ①②③ 序号拆为 `- ` 小点；历史 45 条全部机械转换，**内容逐字保留**（仅剥表格壳与标题粗体）；本条目为格式重构的登记，后续新条目按纲目追加在文末

## v0.7.0（2026-09-16）状态描述清理（§17–§18 重组）
- 作者提出：ARCHITECTURE.md 与 §17–§18 的状态描述过期（已解决项混在未决清单、入口页状态摘要与实际进度矛盾），状态不清
- ARCHITECTURE.md：「当前状态」摘要行删除，改为指向 §17–§18 的一句话（本页不维护状态摘要，与既有规则对齐）
- §17：新增 **W6 传输层迁移官方 typert（v0.7.0）** 切片行（✅ 已实现）
- §18 重组为两组：**未决（open）** 5 条（roster 明文密码 / 逐次升级语义 / 旧用户迁移 / 流程待放宽项 / W5 尾款）与 **已定（留档备查）** 11 条；已定条目**沿用旧编号**（2/3/4/5/7/9/11/12/13/15/16），代码注释与章节文件中的既有 `§18.N` 引用（§18.9/§18.11/§18.12/§18.15）全部继续有效，无需回改
- 原 #6 与 #10（逐次升级语义，内容重复）合并为未决 #2；原 #16 的待定项（pendingEntry/hpbrief）上移为未决 #5

## v0.7.1（2026-09-16，补）§9 落点路径勘误
- preset 组合文件 `agent.cordis.yml` 的 `mud-agent` 行仍指向旧布局产物 `lib/preset-agent.js`（目录重构 0fd8e88 后实际产物为 `lib/agents/preset.js`），preset 挂载失败回落宿主侧装配；§9 两处 `dist/preset-agent.js` 陈旧引用同步更正为 `lib/agents/preset.js`

## v0.7.2（2026-09-16，补）agentMode 四态（§11，原 `agentEnabled: boolean` 升级）
- 作者提出：`agentEnabled` 完全停止接入不符合测试需求，需要单独关闭真实 LLM（T2）来测 T1
- `Config.agentEnabled` → `Config.agentMode: 'off' | 't1' | 't2' | 'full'`（缺省 `t1`）：`off` 暂停接入（输出直推终端）/ `t1` 仅确定性管道（规则/流程动作走 T1，其余行仅进终端）/ `t2` 仅真实 LLM（全部行进批次投递，T1 暂存动作丢弃留痕）/ `full` 完整接入；`ctx.mud.setAgentEnabled(bool)` → `setAgentMode(mode)`，`MudConnectionStatus.agentEnabled` → `agentMode`
- 门控落点（session.ts）：dead-air 布防与断流/流程失败唤醒要求 `t2|full`；settle 的 T1 暂存动作冲刷与原文/动作投递要求 `t1|full`（T2 关闭时批次仅进终端、暂存动作照投）；空回合翻 blank 只要求非 `off`；`shouldConcludeTurn` 仅 `off` 直接拒绝
- 8 个测试 spec 的 `agentEnabled: true` → `agentMode: 'full'`；§11 Config 全集与看门狗表同步

## v0.7.3（2026-09-17）fullme 人工提问改为 ask-human 同回合挂起（§19.3 / flows/fullme.md）
- 作者定案：修"回合分裂"——旧机制下 `mud_captcha` 取图即返回，提问后无在途工具 → T1 `finish stop` 收束回合，人工回填只能开新回合。现行对齐官方 `ApprovalService.request` 语义（**提问要求回合开着，回答是工具结果**）：`mud_captcha` 推图后**工具不返回**（在途挂起），人工提交的码作为**工具结果**回管线，`answer` 动作随该结果 defer 进**同一回合**
- fail-closed 三出口（工具结果 `ok:false` → 所在步失败收束，不悬挂）：① 弹窗"中止" → 新增 `captchaAbort` RPC 全链（`MudCoreService` → `assemble` → `@Remote` → typert 工件 → webui 客户端 → 中止按钮）→ waiter 直接失败结束；② 每次提问的等待兜底 `CAPTCHA_WAIT_MS = 175_000`（`session.ts` 常量，**不给模型看、非 Config 字段**；步预算 180s 仍是硬上界，175s 先结算）；③ 流程结束 / 断线 / 会话释放（等待作废）
- 答错重试复用 `retry` 步内自环：清 `{captcha}` 旧码（`clearExternal`）→ 投 `retry.action` 再推图**再问一次（第二次挂起）**→ 新码提交后动作随第二次工具结果进同一回合；三次提问 = 三次挂起-解挂，回合始终开着
- 弹窗只收裸码（`sendCommand` 人工分支兼容 `fullme` 前缀），`halt`/`fullme` 序列仍归流程动作统一声明（§19.3）
- `prompt` 步 `timeoutMs` 15s → 180s（含等人工）；`runtime-captcha.spec.ts` 按新语义整篇重写（8 例）；§19.2/§19.3 与 flows/fullme.md 同步

## v0.7.4（2026-09-18，补）W7.1 文档同步：分帧器表述收敛为行流裁决器
- W7.1（裁决器抽出 + 分帧器行流化，等价迁移）落地：`frame-splitter.ts` 退役并入 `runtime/session/adjudicator.ts`（`SessionAdjudicator`，行流 + 元事件入口 + 五站消费链 + 记账 + 投递节拍），架构文档中"分帧器"作为现役主体的表述全部同步（6 个章节文件）：§2 术语表"帧"条目与 §3 架构图（00-core）、§5 结算点与装配阀（04-06）、§8 章标题/§8.0 定位/§8.5 arming 集/§8.8 实现映射表（07-08，原 `frame-splitter.ts` 行改指 `adjudicator.ts`）、§12 单元测试对象（12-13，spec 改指 adjudicator 导出）、§19.2 arming 集落点（19-flow）、§11 看门狗边界（11-runtime-config，hold/settle 计时同在裁决器）
- **帧机制表述保留**：W7.1 为等价迁移，行流缓冲/切帧/帧标记/帧并集/内存阀在裁决器内原样存在（`FrameSplitter` 类并入保留），文档同步保留；§4–§8 整章重写（行流裁决器与在途窗口叙述）按 PLAN 属 W7.3
- 历史记录不改：CHANGELOG 历史条目、`doc/history/`（archived）、`doc/PLAN.md`（方案记录）

## v0.7.5（2026-09-18）W7.2 桥 → 在途窗口（机制替换，作者拍板执行序 ①窗口机制 → ②工具改造 → ③流程移交 → ④删桥 → ⑤spec → ⑥文档）
- ① **在途窗口表**：新增 `runtime/session/inflight.ts`（`InflightWindowTable`）—— 发命令工具经 `registerWindow(spec)` 注册窗口（id `w<seq>` 全局递增、不随断线复位）→ pump 发送（`noGate` 穿透）→ 宿主 `confirmSent` 武装 → 判据命中（`win-<n>:ok/:fail` 武装标记经裁决器接线）/ N-GA 关窗 / 超时放弃 / abort / 断线 → 结算 resolve；结算优先级 判据 > N-GA > 超时 > 断线（I4 每窗口必有结局）；连续 3 次放弃 → reject（DSH 失败终态），非超时结算复位计数；发送守卫（缺省超时未确认 → `error` 结算）；**直发延后**（重构计划 §2.8）：窗口开启 ⇒ 直发命令延后到结算后（gateRank `halt` > `noGate` > 其余），取代旧挂起闸门；`diag()` 暴露窗口活动表（tool/criteria/gaCount/elapsedMs/status）+ 结算结局计数，`MudSessionDiag.windows` 字段
- ② **发命令工具统一改造**（`agents/tools.ts`）：`mud_move`/`mud_look`/`mud_status`/`mud_send` 经 `registerWindow` await 结算，**T1/T2 同形**（工具结果直接带窗口应答文本，T2 查询省一轮投递）；统一结算字段 `settled`/`outcome`/`hitText`；`until` → ok 判据 + `timeoutMs`；活动表（`activityFor`）未显式声明时自动附为窗口 ok 判据；命令序列单窗注册（`gaCount` 缺省 = 条数）；`fireAndForget` 直发不注册窗口；`mud_captcha` 提问-提交挂起改 `humanWindow` begin/end 包裹；插值分层：工具层 `wire()` 在注册前插值凭据/外部值，session 的 registerWindow 包装不二次插值
- ③ **流程配对移交**（`runtime/flow/flow.ts`）：`windowSpecFor(cmd, values)` 只对本步命令返回判据覆盖（criteria/gaCount/gaOutcome/timeoutMs）——只有本步自己的命令拿到覆盖；`noteToolResult(stepId, outcome, settled?, hitText?)` 按 stepId 推进单步（取代旧桥结算回调 `noteSettle` + `ownCommands` 按命令比对）——「别的命令的结算串掉本步」结构上不可能；`{lastFail}` 槽源 = `hitText`；tool await 期间回合取消 → 窗口立即结算 `canceled/abort`（不干等超时）
- ④ **删除旧桥**：删 `runtime/session/bridge.ts`（`CommandResponseController` 全套：pending/live 单槽、挂起闸门、事务帧标记 `tx-*`、挂起期拒绝 I11/I12、孤儿 GA 计数遗留口径）；`session.ts` 瘦身（窗口表接管发送/武装/直发延后 gate 三条宿主接线），`mount.ts` 转发 `noteToolResult`（§2.1），`assemble.ts`/`telnet.ts` 注释同步
- ⑤ **测试**：`response.spec.ts` 整篇重写为 `InflightWindowTable` 单元测试（窗口型全链路/sending 累积/N-GA/序列单窗/判据武装与结算/判据未等到/超时放弃与连续 reject/abort/断线 close+reset/sendFailed/发送守卫/interrupt/diag/§2.8 直发延后集成用例）；`tools.spec.ts` 桥装配段 → 窗口装配 11 用例（WindowRequest 形状/until 判据/活动表表驱动/插值先于注册/序列单窗/fireAndForget 直发）；`flow-ownership.spec.ts` 整篇重写为配对移交归属口径（8 用例）；`loop-sim.ts` 补 `noteToolResult` 生产同款接线（W7.2 下流程单步靠它推进）；`runtime-defer.spec.ts` 签名跟随（boolean → `'ok'`）
- ⑥ **文档同步**：§8.3 重写为「在途窗口（W7.2 取代命令-应答桥）」+ §8.7 删除清单补桥本体行 + §8.8 实现映射 `inflight.ts`；§19.3 重写为「步骤推进与结算归属（配对移交）」+ §19.4 打断落点（`InflightWindowTable.interrupt`）+ §19.7 定案 1/5；§12 单元测试对象与 flow-ownership 描述；§2 术语表新增「在途窗口」条目 + 挂起/唤醒/打断改窗口载体 + §3 架构图旁路 B；I11/I12 加 W7.2 注记（正式改写属 W7.3，PLAN §6）
- 遗留（PLAN §8）：N-GA 声明表真机抓包核对仍待（`dazuo` 等长命令 `gaCount` 实证）；测试例数以当次 vitest 汇总为准（`pnpm --filter @deepseek-ai/dsh-mud-core test`），本切片测试不由 agent 执行

## v0.9.0（2026-09-18）W7.3 注册收口 + 选路回归 + 文档落档（W7 收官）

- ① **裁决器注册收口**（`runtime/session/adjudicator.ts` + `session.ts`）：新增 `AdjudicatorRegistration {stateRules, eventRules, holdRuleIds, gateRules}` 与唯一注册入口 `register(reg)` —— 投影新建 `PerceptionEngine` + 打断常驻标记（`rule-int:<id>`，先清旧再挂）+ `deps.flow.syncArming()` 全量重放 + 直发判据投影一并并入；`AdjudicatorDeps` 删 engine/gateRules/interruptMarkers、加 registration；重连/断线（`resetForReconnect`/`abortForDisconnect`）内 `splitter.reset()` 后经 `register(this.registration)` 重挂一次，不再各自直调 engine/syncArming；session.ts 删 engine 字段与 `PerceptionEngine` 直构，构造器末尾保留 `this.flow.syncArming()`（flow 构造期回调早于 `this.adjudicator` 赋值被可选链吞掉，末尾补放；重连/断线路径 register 内 syncArming 直接生效）
- ② **选路回归**（`agents/lane.ts`）：删 `presetLaneSelection` / `ModelSelectionRef` / `trySelectionRef`（v0.6.x 漂移方案，当年未登记 CHANGELOG，此处补记）——回归 doc §6 声明的 `agent/request` + `{prepend:true}` 拦截设计：`agent/pre-step` 只记 lane + `onLane` 广播（不再写任何模型选择）；`await next()` 后经纯函数 `resolveLaneConfig` 拍板（lane=t1 → mud-t1 占位剥 `reasoningEffort`、首请求未污染时顺手入 realModel 记忆；非 t1 占位 + 有记忆 → spread 只覆写 provider/model/effort 还原，保留 temperature/maxTokens/stop，`restored:true` 留痕；其余放行并更新记忆；无记忆保守放行；空拍板不冲记忆）。**删 `sink.preDeliver`**（投递前预写补丁）：`types.ts` 声明、`delivery-channel.ts` 选项与 send() 内调用、`session.ts` 构造接线、`assemble.ts` sink 块四处随之删除
- ③ **修复限速 T1 豁免未接线**：原 `installOwnedLaneRouting` 的 `onLane` 与闸门的 `currentLane` 均未接，`currentLane() === 't1'` 豁免是死代码（T1 规则/流程步动作被无谓限速 1s）——attachPolicy 改为 `onLane` 写闭包 `let lane` + 闸门 `currentLane: () => lane`
- ④ **测试**：新增 `tests/lane-routing.spec.ts`（10 例表驱动 `resolveLaneConfig`：t1 拦截剥 effort / 首请求入记忆 / 已污染不变 / 放行更新记忆 / undefined 放行 / 占位还原保留其余字段 / 还原无 effort 不带键 / 无记忆保守放行 / 用户手动换模型不覆盖 / 空拍板不冲记忆）；既有 spec 零改动（grep 验证无 preDeliver/presetLaneSelection/SessionAdjudicator 直引残留），`loop-sim.ts` 的 ownedLaneOf 为本地同名函数非导入
- ⑤ **文档落档**：§8 章标题「命令-应答事务」→「在途窗口」+ §8.5 register 收口 + §8.8 实现映射补行（07-08）；§4 引擎实例由 register 投影创建、流程判据经裁决器标记表；§5 I6 口径（结算点 = 帧提交点 + standalone 独立投递点例外）；§6 整节重写（v0.9 W7.3 回归版记 + pre-step/agent-request 与实现对齐 + 限速接线修复注记）（04-06）；§1 不变量 —— I2 补注 followup/inject 均官方原语、I5 补消费链单遍结构保证、I6 结算点定义 + standalone 例外、I11/I12 正式改写（被官方工具顺序执行/直发延后 gate 取代，删 W7.2 暂注）、I15 扩展工具结果自洽；§2 术语表 —— 「帧」条目清理"分帧器 = 唯一边界裁决者"旧表述、新增「裁决器」「分投器」条目、挂起/唤醒改窗口载体与 `noteToolResult` 推进口径；§17 登记表加 W7 行 + W1 注记路径勘误（`perception/engine.ts` → `perceive/engine.ts`）；§18 新增已定 #17（`exec.concludeTurn()` 已接线，取代 #11「已定不接」—— v0.4.0 defer 落地即接判据 B/C，与实现矛盾的勘误）
- 验证（不由 agent 执行）：`pnpm --filter @deepseek-ai/dsh-mud-core test`；`pnpm --filter @deepseek-ai/dsh-mud-core exec tsc --noEmit`

## v0.9.1（2026-09-18）fix.md 核实治理：tsc 清零 + W7 验收状态如实登记 + 文档勘误收口 + PLAN.md 改起草区

- ① **代码修复（tsc 4 错清零，agent 已验）**：`adjudicator.ts` TS2564 ×3（`registration`/`engine`/`gateRules` 构造器内经 `register()` 赋值，补 definite assignment `!`）+ `inflight.ts` TS2379（`settled:'until'` 结算分支 `outcome` 由可能为 undefined 的变量改为 `ok ? 'ok' : 'fail'` 字面量）；随附把 8 处代码注释里过时的 `doc/PLAN.md §N` 引用改指现行正式编号（§8.3/§8.4/§19.3），并纠正 `flow.ts` line 57 一条与 `armOwnJudgements` 实现矛盾的过时注释（旧"单步 ok/fail 随窗口注册"→ 现行"GA/tool 判据不经 arming"口径）
- ② **§17/§18（17-18-roadmap.md）**：W7 行状态 `✅ 已实现` → 🟡 **已落地、验收未通过**（验收列拆两半：已达成 = tsc 清零 + lane-routing 10 例 + loop-sim 冒烟；未达成 = vitest 10 红/345 总例，红名单 flow-login 4 / flow-interrupt 3 / flow-ownership 2 / preset-agent 1，属 W7.2/W7.3 功能 bug 待 triage）；W4 行补"命令-应答桥已删"勘误注记 + `concludeTurn 已定不接` → 已接线（§18.17）；#4① 关闭（配对移交保证）、#12 措辞随 W7.2 更新（直发延后 gate 取代旧"闸门拒绝并留痕"）、#15 补打断时序（先 `interrupt` 结算在途窗口再发 `onInterrupt`）；未决新增 **#6**（官方并发档位 `executionMode()` fail-closed 缺省依赖）、**#7**（分页 `pager:continue` 直发在窗口期被延后压底 + `mud_look` gaCount=1 先关窗、后续页不进结果）、**#8**（`halt` 无条件豁免 gateRank 0 为 GA 计数污染潜在通道，需收紧为打断路径专用并留痕）
- ③ **§1 不变量（00-core.md）**：I2 补注工具侧经 `exec.deferContext` 投递（§19.6.2）；I11 正式措辞补 fail-closed 依据（§18 #6）+ "窗口配对移交 + 直发延后 gate 双保险"；I12 清 W7.2 过渡注记，补 halt 豁免范围约束（§18 #8）；§2 术语表 arming 集条目精确化（行判据集合；GA/tool 判据不经 arming）
- ④ **§4/§8/§19**：§4 流程判据行、§19.2 arming 说明与 flow.ts 对齐（driver(重试) + ok/fail 行判据 + 条件分支后继；GA/tool 分流）；§8.0 "标记切帧，事务开窗" → "标记切帧，**工具开窗**"；§8.3 补 halt 豁免范围（§18 #8）与分页压底风险句（§18 #7）；§8.8 register 行补壳侧 `buildGateRules` 经 `registration.gateRules` 喂入的说明；§19.6.2 补 `exec.deferContext` = 官方 `inject` 投递入口
- ⑤ **§12/§13（12-13-observability-testing.md）**：§12 清 3 条已无实现的旧桥/闸门日志样例（"挂起期第二条应答请求已拒绝"、"不是本步命令的结算"、"判据冲突"——grep 证实零实现），补 `[在途]` 三条现行样例与打断结算/排队出队日志；diag 计数行"挂起期第二条请求拒绝次数" → **在途窗口结算结局计数**（§8.3/I4）；§13 补 lane-routing 登记（10 例表驱动 `resolveLaneConfig`）、例数基线（345 总例，红绿以当次 vitest 汇总为准）、W7.3 注册收口后测试对象说明、旧"挂起期闸门"计划项 → 在途窗口结算
- ⑥ **PLAN.md 角色变更**：旧 W7 核心重构方案归档 `doc/history/plan-w7-core-refactor.md`（archived 头 + 已收官声明 + 4 条实施证伪勘误：§0.1"不再分帧"、§2.2"gaCount 缺省 1"、§2.2"criteria 多行状态机"、§7"官方管道强制工具返回"）；`doc/PLAN.md` 重写为**新计划起草区**（新计划先在此起草成型，实施后同步正式章节 + CHANGELOG，再清空/归档），首个起草项 = vitest 红清零 triage
- 验证（不由 agent 执行）：`pnpm --filter @deepseek-ai/dsh-mud-core exec tsc --noEmit`（agent 已跑，EXIT=0）；vitest 345 总例/10 红（v0.9.1 实测，红名单见 §17 W7 行，修复属起草区第一项）

## v0.9.2（2026-09-19）vitest 红清零（起草一实施收官）

- ① **功能修复（唯一一处，打断半截序列）**：`InflightWindowTable.settle` 结算为 `interrupted` 时经新接线 `onDropQueued(replyId)` 定向清除宿主命令队列残余（`CommandQueue.discardByReplyId`，`session.ts` 接线）—— 序列命令在 pump 时已一次性入队（§8.3），此前打断只结算窗口不清队列，gate 放行后剩余命令照发；设计落档 §19.4（打断流程 ① 补"定向清除队列残余" + 实现落点补队列残余清除段 + 端到端补"半截序列不发出"，flow-interrupt 例数 7 → 8）。配套用例修正：「半截序列」harness 的 `commandIntervalMs: 0` 会在打断前把整条序列瞬间发完（前提不成立，实测插桩证实），该用例改用真实节流间隔 400ms
- ② **测试基建（#1–#6）**：`flow-login.spec.ts` / `flow-interrupt.spec.ts` 假 loop `runLatestAction` 改走官方工具包装器 `runWithDeliveryChannel`（`channel: runtime` + `callId: mud-<delivery>-<index>` + `deferContext` 收 defer 投递，与 `runtime-captcha.spec.ts` 同一接线）—— 此前 harness 直调 `tool.execute()` 绕过包装器 → `noteToolResult` 从未被调用 → 凡依赖 GA 结算推进流程的断言全红（GA 收步统一走 `noteToolResult(settled='ga')`，§19.3）；「未声明 interrupts」用例同步改异步推进（包装器 endToolCall → defer 冲刷在微任务里，同步推进等不到）
- ③ **断言对齐（#4/#8/#9）**：GA 归属断言由旧桥"按命令比对"文案（`不是本步命令的结算: "***"`）改写为 W7.2 stepId 归属语义（`工具结果（不是本步的: <stepId>, 忽略）`）；`flow-ownership` 两例 `{stepId:'done'}` 改 `{stepId:'start', phase:'awaiting-branch'}`（§19.2：带 driver 的后继 = 条件分支，`done` 只由收功句进入，GA 收步后停在分支等待）
- ④ **preset 守卫同步（#10）**：副本 `presets/mud-player/agent.cordis.yml` 对齐 harness standard 上游 —— 补 `workflow-ptc` 行 + `tool-ralph` 补 `disabled: true`；守卫断言放行 `workflow-worker-thread`（6a98c13 起副本有意新增、standard 尚未同步的插入行）
- ⑤ **Unhandled Rejection 清零（红名单漂移根因）**：`response.spec.ts` 两处（连续 3 次应答超时 reject / 发送守卫 error reject）改为**先挂 reject 断言、再推进计时器** —— reject 在 `advanceTimersByTimeAsync` 的计时器 tick 内同步发生，后挂 handler 会被 Node 记一次 unhandled rejection，vitest 明示可能引发跨文件假红
- ⑥ **§17（17-18-roadmap.md）**：W7 行验收列补记 vitest 红清零明细，状态 🟡 → ✅ **已实现**（2026-09-19 验收通过）
- 验证（agent 实测）：`vitest run --root packages/mud-core` 全包 **31 文件 / 345 例全绿**（0 Unhandled Rejection）；`tsc --noEmit` EXIT=0

## v0.9.3（2026-09-19）W8：mud-core src 按数据流重组（纯文件级，零行为变更）

- ① **目录 = 数据流阶段**：`services/network/*` → `network/`、`services/log/log-service.ts` → `log/`、matcher 三文件并入 `perceive/`（其契约并入 `perceive/types.ts`：机制层形状 + 策略层投影两段分区，避免撞名拆两个契约文件）、adjudicator/delivery-channel/state-track + `agents/lane.ts` → `deliver/`、t1/inflight/queue/skills/commands + `services/gate/*`（`agent/gate/`）+ tools → `agent/`、flow 三件 + flows → `flow/`、world/game → `world/`、session/connection-runtime/watchdogs/credentials/mount/preset → `session/`、`src/service.ts` → `shell/service.ts`；`services/`/`runtime/`/`agents/`/`shared/` 目录消失，src 根只剩 `assemble/index/invariant/types` 装配根四文件
- ② **两处拆分**（整段搬移，不改签名）：`agents/tools.ts` → `agent/tools-schema.ts`（契约：MudToolResult/OUT_SCHEMA/OUT_RENDER/MudTool/MudToolCallOptions/MudToolSchema/MudTools，OUT_RENDER 随拆分导出）+ `agent/tools-build.ts`（buildMudTools/mudToolSchemaTable/插值/活动表；依赖方向 build → schema 单向）；`runtime/flow/flow.ts` → `flow/engine.ts`（FlowRuntime）+ `flow/util.ts`（entryMatch/commandsOf/interpolate/preview 纯函数）
- ③ **保持原名原符号**：`inflight.ts`/`InflightWindowTable`（§8.3）仅随迁至 `agent/`；adjudicator 整体迁移不拆（分帧已并入，W7.1）；`credentials.ts` 过渡文件放消费方旁 `session/`
- ④ **引用面随迁**：package.json exports `./preset-agent` → `lib/session/preset.js`（presets/mud-player/agent.cordis.yml 与 `preset-agent.spec.ts` 守卫断言同步）；tests 全部深路径 import 改指新位置；正式章节 impl front-matter 与路径字样随迁（§0/§7–§10/§11/§17–§18/§19/flows/login/fullme；§17 表尾登记 W8 行）
- 验证（agent 实测）：`tsc --noEmit` EXIT=0；vitest 全包 **31 文件 / 345 例全绿**（= 基线，0 新增红例）；文件级循环 import 为零（DFS 全 54 文件可证）

## v0.9.4（2026-09-19，补）同步上游 typert strict codec `create()` 工厂契约（修复 webui remote mount 全挂）
- 上游 harness（commit `e459e32637` "materialize generated schemas on first use"）把 strict codec 契约从 `{ mode, typeSymbol, schema }` 改为 `{ mode, typeSymbol, create: () => TypertSchema }`（registry `validateCodec` 强制 `create()` 工厂）；本仓库旧生成器（npm `@deepseek-ai/dsh-typert-generator@0.1.5-rc.2`）仍 emit `schema:` 形态 → 页面 `ctx.remote.$mount(TYPERT_REMOTE)` 全部 descriptor 被拒（`strict codec has no create() factory`），remote mount 失败 → `/mud/*` RPC 全部不可用（侧栏报"无法连接网路"）
- ① **协议镜像同步**：`packages/typert-protocol`（镜像 harness packages/typert/protocol）`TypertCodec` strict 分支 `schema: TypertSchema` → `create: () => TypertSchema`，镜像 version `0.1.5-rc.2` → `0.1.6-alpha.1`
- ② **生成器升级**：mud-core devDep `@deepseek-ai/dsh-typert-generator` `^0.1.5-rc.2` → `0.1.6-alpha.2`（npm 上已发布新契约 emit 的最低版本）；重跑 `gen:typert`，`typert.host.js`/`typert.remote-client.js` 全量改 emit `create:` 形态（schemas 行同步 `{ name, create }`）
- ③ 业务代码零改动（mud-core src 不直接消费 codec 形态；harness 侧 lazy materialize 对调用方透明）
- 验证（agent 实测）：`typert-protocol`/`mud-core`/`mud-webui` `tsc` 全部 EXIT=0；mud-core vitest 全包 31 文件 / 345 例全绿；产物 grep 确认 `schema:` 零残留

## v0.9.5（2026-09-19，补）preset 移除 workflow-worker-thread 行（上游已删除该插件包）
- 症状：`[装配] preset mud-player 装配失败 (preset "mud-player" failed to mount: row "workflow-worker-thread" names a plugin that cannot be resolved: @deepseek-ai/dsh-workflow-worker-thread)` → 回落宿主侧装配
- 根因：副本里 `workflow-worker-thread` 行是 6a98c13 起"有意新增、standard 尚未同步"的插入行；但上游 harness commit `35af8698c2`（"fix(workflow): execute orchestration in the sandboxed PTC runtime"）已**删除** `packages/workflow/workflow-worker-thread` 整个包（编排改走沙箱化 PTC runtime，`workflow-ptc` 行仍在），该行从此永远无法 resolve
- ① `presets/mud-player/agent.cordis.yml` 删除 `workflow-worker-thread` 行（`provider: spawn` 的编排由 `workflow-ptc` 承担，功能不丢）
- ② `preset-agent.spec.ts` 守卫断言同步：extra 只放行 `mud-agent` 一行，并留痕删除缘由
- 验证（agent 实测）：vitest 全包 31 文件 / 345 例全绿（守卫逐行比对通过：副本与 standard 现仅差 mud-agent 一行）

## v0.10.0（2026-09-19）W9：凭据引用化（密码明文的三分暴露面收敛为引用名）

- ① **三个面全部改为引用名**：`MudUser.pass` → `passRef`（浏览器名单）、`MudConnectOptions.pass` → `passRef`（RPC）、`Config.account.pass` → `passRef`（部署配置）。明文由 host 在**连接瞬间**经官方 `ctx.credentials.resolve` 解析，**每次连接重新解析**（不跨操作缓存 ⇒ 改密后下次连接即生效）；页面表单经官方 `remote.credentials.set` 单向写入 `$DSH_HOME/.credentials.yaml`，页面永不读回（`describe` 只回 `{configured, source?, writable}`）
- ② **新增 `session/credential-source.ts#resolveMudPass`**：三级 fail loud 策略的归属（引用名不合 CredentialRef 语法 / 本次部署未挂载凭据 provider / 引用未配置）—— 留痕后抛出，**解析先于会话运行时装配**，失败不建连接、不声明会话（不写档位记录、不进 `diag().runtimes`）。无 `passRef` 是**合法空密码**（有些服务器不校验密码）。与既有的 `session/credentials.ts`（管"明文在命令流/日志/转录里的**暴露面**"）职责正交：一个管"明文从哪来"，一个管"明文到哪去"
- ③ **webui 新增 `client/mud-credentials.ts`**：自持最小结构化接口对接官方 `credentials` 远端命名空间（**不引 `@deepseek-ai/dsh-api-remotes`** —— 本仓 `packages/typert-protocol` 是官方镜像，与 npm 上的 `dsh-typert-protocol` 是两个 module 身份，`TypertRemoteNamespaceMap` 合并不会生效，且会在 cordis `Context` 上塞入第二个不含 `mud` 的 `remote` 类型）；软解析 `ctx.get('remote.credentials')` 而**不加硬 inject**（硬依赖缺失会让整个侧栏/游戏/日志 tab 不加载且无提示）；`describe` 调用前过滤空名/非法名并按官方上限 64 分批（官方 schema 只要一个名字不合法就整批拒答）
- ④ **引用名生成 `mintPassRef`**：`MUD_PASS_<净化名>_<6位随机十六进制>`。**不用"净化名 + 冲突序号"**：`removeUser`/`removeServer` 会 `unset` 该引用，而部署手写的 `account.passRef` 可能与净化后的用户名同名 —— 名字可推导就等于"删一个页面用户"能删掉部署凭据；随机后缀把 `unset` 的破坏面限定在该名单行自己的引用内
- ⑤ **名单迁移契约（必须显式实现）**：旧 localStorage 只有 `pass`、没有 `passRef` → **只丢弃明文值，server/user 行原样保留**（`passRef` 记空串，用户重录一次即可）。既有 `parseRoster` 的策略是"任何一条 user 字段不符即 `return null`、整份名单回落成空"，若照字面"含明文就丢弃"实现会把用户的**整份服务器清单**清空；另外读到旧数据即当场重写一次 localStorage，让那份明文当场离开磁盘
- ⑥ **录入路径的失败落点**：`UserDialog.onAdd` 由同步改 **async** —— 凭据写入失败时弹窗保持打开并显示 host 原话（早期实现是 `onAdd(...)` 后立刻 `close()`，异步失败没有落点）；空密码就地拦下（官方 `set` 拒绝空值 `min(1)`）；名单行只在凭据写入成功后落，未落则回滚刚写的引用
- ⑦ **用户行凭据徽标**：已配置 / **只读 (env)** / 未配置 / 无密码四态。`writable: false` 是必须显示的一档 —— 进程环境里有同名引用时官方 seam 以只读源遮蔽它，`set`/`unset` 一律被拒；不说清楚就是死胡同
- ⑧ **新增 `tests/credential-source.spec.ts`（7 例）**：显式 passRef / 回落 / 覆盖、缺 provider、引用未配置、非法引用名（文案指名引用名）、无 passRef 不触碰凭据服务、**每次连接重新解析**（连续两次返回不同值，`resolve` 调用 2 次）
- ⑨ **§18 未决 #1（浏览器 roster 明文密码）关闭**，移入「已定」；新增未决 #9（装配层测试基建：vitest 管线无法加载 TC39 装饰器模块，见下）
- 暴露面口径（文档与实现同此，不得写成"明文消失"）：connect 不再携明文；录入瞬间仍过一次网；明文仍以**未加密文本**落在 `$DSH_HOME/.credentials.yaml`（目录 owner-only）。`{name}/{pass}` 占位符与掩码机制不变
- 验证（agent 实测）：`tsc` 三包 EXIT=0（`pnpm -r build`）；mud-core vitest **32 文件 / 352 例全绿**（v0.9.5 基线 345 + 新 7 例，0 新增红例）；mud-webui `tsdown` 产物构建通过
- **已知限制（本次实测发现，记入 §18 未决 #9）**：本仓测试链路（vitest 4 + Vite 8/rolldown/oxc）**无法加载 TC39 标准装饰器模块** —— `@Remote` 标注的 `shell/mud-remote-service.ts` 是入口，于是任何 import 到 `assemble.ts` 的 spec 都会在 transform 阶段报 `SyntaxError: Invalid or unexpected token`。机制：`vite:oxc` 仅在 `environment.config.isBundled` 为真时读 `oxc` 配置项（vitest 的 node 环境不是 bundled，实测配 `oxc.decorator`/`oxc.target` 均无效），且 oxc 的 `decorator` 变换只实现 legacy 版（`legacy:false` 不降级；`legacy:true` 会让 `@Remote` 按 `(target, key, descriptor)` 被调用而在类定义期抛错）。这既是"装配层与 remote 服务层至今没有测试"的真实原因，也是本切片把凭据策略抽成独立模块（②）的直接理由
## v0.10.0（2026-09-19，补）§18 未决事项逐条核对：两条过时关闭、一条改写、一条拆解

- 触发：作者反馈"未决事项有些感觉过时"，逐条对现行代码取证核对
- ① **#2「`ask` 批准的逐次升级语义」关闭 → 已定 #18**：不是二选一 —— 官方审批结果是封闭词汇表 `allowed-once | rejected | cancelled | unavailable`（`interaction/user-approval/src/types.ts:32`），服务定义明写 "`allowed-once` is the only grant"（同包 `src/index.ts:204`），invariant 测试还断言 `policy: 'always'` 被拒；而 MUD 闸门只是把 `ask` 原样交回官方（`agent/gate/tool-gate.ts:110` 直接 `return verdict`），**本插件没有任何写档位的路径**（唯一写入口 `capability.set`，入口只有页面/宿主）。故 `ask` 批准恒为"仅此一次"
- ② **#3「旧 MUD 用户迁移 → 删除重建」关闭 → 已定 #19**：不存在强制删除路径 —— `assemble.ts#installPresetCapability` 把 `agentPresets.select` 的**任何**失败（含旧会话已锁定）都 catch 住并**回落宿主侧装配**，而 §9 明写宿主侧装配是完整可用的一条（可见性层还更严格）。要用户动手的迁移只剩 W9 那条：旧名单行无 `passRef` → 重录密码
- ③ **#6 改写（语义纠正）**：原题"官方并发档位的**缺省依赖**"读起来像等上游 —— 实际 `isConcurrencySafe` 是**我们自己**在 `defineTool({...})` 里可声明的字段（官方 `ToolDefinition.isConcurrencySafe?`；本仓注册点 `session/mount.ts:178`、`session/preset.ts:78`），`executionMode()` 的 fail-closed 未变（`core/tools/src/index.ts:1284`）。改为"**本地决策**：给 `mud_state`/`mud_recall`/`mud_help` 这类零发送只读工具声明并发安全时，必须同时重估 I11"
- ④ **#4 拆解**：① 单挂起（I11）→ 已定 #20（原文自己就写着"已随 W7.2 关闭"却仍留在未决表）；② 流程内部并行分支**保留在 #4** 并标注"**当前无消费方**（login/fullme 都严格串行）→ 真实需求出现前维持非目标"；③ 跨会话流程编排 → 新增「**非目标**」子节（它本来就是范围声明，不是未决）
- ⑤ **核对后确认仍然成立、原样保留**：#5（`pendingEntry` 机制在 `flow/engine.ts:65/434/895` 已实现且 `diag()` 已暴露计数，但 tests 零引用；`hpbrief` 只在 `flow/flows/fullme.ts:104` 发出、感知规则与 world 无解析）、#7（`pager:continue` 仍是 `direct:true`（`perceive/rules.ts:259`）→ 走 `queue.send` 不带 `noGate`（`session.ts:214`）→ `gateRank` 判 2 压底（`queue.ts:85-88`），无豁免被加过）、#8（`queue.ts:86` 仍是 `halt → 0` 无条件豁免）、#9（本次新增）
- ⑥ **结构**：§18 由"未决 / 已定"两节扩为"**未决 / 非目标 / 已定**"三节；未决表加"编号为稳定标识、不随增删重排"的说明，已关闭条目在「已定」用接续号（18/19/20）并标注"原未决 #N" 保留可追溯；`doc/PLAN.md` 待办池同步（T2/T3 删除，T4/T6 改写，其余原样）
- 验证（agent 实测）：全仓 grep 确认无指向旧编号的悬挂引用（`§18.2`/`§18.3` 仅存于 CHANGELOG 历史条目，按"只追加不回改"保留）；纯文档改动，未触碰代码

## v0.10.1（2026-09-20）T1 计划定案收敛：判据-only 收口模型（起草区）+ §19.7 待定 #3 迁入

- 触发：T1「无状态渲染器 → 有状态流程驱动器」计划三轮评审定案（PLAN.md 起草区，实施前不据其改代码）
- ① **判据-only 收口模型定案**：GA 不作流程窗口边界（无 N-GA 缺省收口，降级为可显式声明的判据 kind，如空命令步 `ok:[GA]`）；非流程窗口（T2 自发 / 规则动作）维持现行 N-GA 缺省 + 活动表判据。判据集（fail / ok / 分支 driver 全显式 + capture 规格 + `timeoutMs` 必填）按步随 tool-call 供给、confirmSent 武装、owner=窗口；命中即结算取 span（流程私有水位 → 触发行）；工具返回 `{settled, hit, span, captures}`，T1 查表发下一步。判定序 fail → 分支 → ok 兜底；**全不中（超时兜底判定仍不中）= 流程失败**（非步骤失败，不走 retry/failPolicy）
- ② **打断定案**：`interrupted` 直接收束流程槽（复位 + 留痕，不进 retry/fail 分支），事件动作走 **followup 新回合**（不在同回合 defer）；由此 defer 面（§19.6.2 判据 A 全套）整体删除（含 T2 在途期间规则命中退 followup），判据 B 全套（concludeTurn/deliverySizes/parseDeliveryCallId）随之删除，事件动作收束改自然收束
- ③ **断线定案 = 复位重开**（连接代次弃槽 → 入口重开）；"断线后流程整体挂起续接"迁 **§19.7 待定 #3**，仅在真实需求出现时再立项
- ④ **capture 通道定案**：capture 规格随判据集注册、触发命中经回调把抽取值送回工具、T1 存槽；占位符三类通道——`{name}/{pass}` 原样传参凭据 seam 插值（P10-2 不变）、`{captcha}` mud_captcha 工具内闭环、capture 槽/`{lastFail}` 由 T1 组装时直写值
- ⑤ **哨兵探测步范式**：对结束文本不可靠/无特征的命令，插 `set actioned`/`response actioned` 探测步以"系统回馈："为判据收口（服务器行为由用户自证，不设实证前置）；多行判据延后为可选扩展（MVP 单行，§4 单行正则约束保留）
- ⑥ **不变量改写候选与切片重排**：可测不变量扩为"span + T2 批次 + 折叠行 + 仍带原文投递 == 完整入站行流"；I11（配对移交→callId 供给）/I12（defer 顺序→回合边界）/I13（互斥校验→同帧定序）改写；切片 S1–S6 重排（断线切片删除，文档同步独立成片）
- 纯文档改动（`doc/PLAN.md` 起草区 + §19.7 待定），未触碰代码；PLAN.md 该计划实施完成后按起草约定同步正式章节并删除本节

## v0.10.2（2026-09-20，补）T1 计划收口口径细化：GA 全域去缺省 + 非流程攒批收口 + 水位推进规则（起草区）

- 触发：作者对 PLAN.md 判据-only 模型的五条追加定案
- ① **GA 全域无缺省收口**：收口来源仅三种——具体判据 / 显式 GA 声明（`ok:[GA]`，N-GA 为其参数）/ T2 自发固定时长攒批；**未声明判据且未显式声明 GA → 直接报错**（装配期校验流程表/规则表、调用期校验工具参数），不回落任何缺省；§8.3"未声明 → N-GA 关窗"缺省整体作废（进 P12 删除清单）
- ② **非流程窗口收口**：T2 自发 = 固定时长积攒窗口收口（LLM 自读批内容决策，结算优先级 打断 > 攒批时限 > 断线；代价：每次 T2 工具调用至少等满固定时长，T2 手里的长命令只回部分批内容由 LLM 续步）；规则动作 = 显式声明（载体为规则表/活动表条目）；活动表重定义为"规则/直发命令的显式判据声明载体"
- ③ **哨兵探测步降级为实验功能**：`set/response actioned` 暂不作为常规能力，不进验收，服务器行为由用户自证
- ④ **非空结算约束**：判据命中结算的 span 至少含触发行一行（GA 命中时 GA 行即该行、计入 span），禁止空值结算——总计回应一行的命令触发行即返回结果本身；超时且零行 = 无应答事实按全不中（流程失败）留痕
- ⑤ **水位推进规则定案**：随触发器推进（结算推进到触发行），无触发期间随攒批推进（与折叠/攒批消费同步）；U3 收窄为"折叠行在 span 内容中的呈现与水位坐标表示"（S1 定）
- ⑥ PLAN.md 同步点：状态行、P5（GA 全域无缺省 + 非流程收口）、P6（非空结算 + 水位推进规则）、P12（新增 §8.3 N-GA 缺省删除行、活动表职责重定义）、P13（新增 I4 改写候选）、未决 U3 改写、S1（装配期报错校验 + 攒批参数）、验收草案；纯文档改动未触碰代码

## v0.10.3（2026-09-20，补）U3 定案：折叠行任何时候"折叠但不推进水位"（起草区）

- 触发：作者对 U3 的简化处理定案
- ① **折叠行行为定案（任何时候同一行为）**：状态抓取类行被状态轨道折叠消费，**不推进水位、不进 span**，对 span 计算完全透明——替代 §5 现行"折叠 / recall 前移 `deliveredAbs`"的口径（该口径导致 span 空洞、多行判据失真，是本计划改用流程私有水位的动因）
- ② **水位推进来源收敛为两个**：触发器命中（结算推进到触发行）、无触发期间的攒批推进（非折叠内容行）
- ③ PLAN.md 同步点：P6（水位推进规则改写）、P12（新增 §5 折叠前移 `deliveredAbs` 口径删除行）、未决节清空（U3 定案进 P6，原 U1/U2/U4/U5 处置注保留）、S1（移除 U3 定案子项）、验收草案（新增折叠透明用例）；纯文档改动未触碰代码

## v0.10.4（2026-09-20，补）T1 计划六章重构定稿：发送水位/回看 + 折叠取消 + 超时消费归属 + 工具缺省攒批（起草区）

- 触发：作者按六章大纲重构 PLAN.md 计划主体，并给出五条口径明确（编号 1/2/3/6/8）
- ① **confirmSent 紧贴写 socket（零间隙）+ 发送水位**：判据注册在 confirmSent 执行，confirmSent 与写 socket 之间不夹杂其他过程（凭据插值在 confirmSent 前完成）；confirmSent 记录**发送水位**（当时行流头位置，每窗口一条）；**裁决器可按发送水位以下未消费行结算（回看）**——"本步结果行 + 后继 driver 同帧"场景由此承接，旧 §19.2"后继 driver 一起 arm"的动因在新模型下由回看消化
- ② **彻底取消折叠**：状态抓取为独立桶——抓取结果**只同步 world**，不驱动水位、不折叠内容；状态行作为普通行被后续 span/批次包含（v0.10.3"不进 span"口径被替代）；§5 折叠机制（折叠行 / 折叠消费 / `deliveredAbs` 前移）整体进删除清单；可测不变量移除"折叠行"类目
- ③ **超时不做最后判定**：超时即提交全部窗口内容并**记为当前调用者消费**（水位推进到缓冲头），无兜底判定；旧"全不中（超时兜底判定仍不中）"口径删除；**T2 不接受移交**，批次永远自行回看缓冲（旧"超时窗口内容自然移交 T2"废除）；超时 → 流程失败收束（不进 retry，retry 仅由 fail 判据驱动）
- ④ **工具缺省 = 固定时长攒批**：无其他设置；判据/超时只由 T1 组装阶段写入（tool-call 参数）或规则/直发显式声明（规则表/活动表条目）提供；判据来源解析三序：tool-call 参数 → 声明载体 → T2 lane 缺省攒批 / T1 lane 报错
- ⑤ **行流归属定案**：入口投递原文即触发行、命中即消费（水位自然推进）；流程失败未结算行算下一批入口原文或 T2 批次（不丢弃、不移交）；投递消息只引用已消费行，不再承担行流消费职责；可测不变量改写为"命中行 + 流程 span（含超时/打断提交）+ T2 批次 + 带原文投递 == 完整入站行流"
- ⑥ **PLAN.md 按六章大纲重构**：计划元信息与范围 / 背景与核心决策（P1–P13 归并为 D1–D8，保留原 P 编号注）/ 机制与契约（tool-call、工具返回、流程表、T1 槽、裁决器、状态抓取桶、两水位、状态机与时序、校验、行流不变量）/ 源码变更清单（新增/修改/删除，落到 W8 后文件粒度）/ 实施切片与测试验收（S1–S6 带依赖、源码范围与 A1–A10 映射）/ 未决·待实测·完成定义（架构未决 / 实现待定 / 数值待校准三分）；纯文档改动未触碰代码