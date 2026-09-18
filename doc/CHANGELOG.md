---
sections: [15]
status: active
note: 只追加，不回改历史条目；每次设计变更在文末登记一个条目
---

## §15 变更记录

旧文档 §15 全表已迁移为纲目（2026-09-16，内容逐字保留）；新条目只追加在文末。


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
