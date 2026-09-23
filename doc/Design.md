---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'd1f9d98e-5980-49ba-84f1-6c68b4db6c3b'
  PropagateID: 'd1f9d98e-5980-49ba-84f1-6c68b4db6c3b'
  ReservedCode1: 'e4b80894-ba45-44e9-b7a6-9c42545bca75'
  ReservedCode2: 'e4b80894-ba45-44e9-b7a6-9c42545bca75'
---

# core2 设计初稿

- 状态：初稿（讨论基线）
- 日期：2026-09-23
- 前置阅读：`doc/PLAN.md`（W11 状态）、`doc/ARCHITECTURE.md`（现行架构）
- 本文档是 mud-core2 的完整架构设计。前提：**新建 mud-core2 项目、白纸起步，不考虑迁移与兼容**。所有取舍依据两类证据——现行 mud-core 的功能考古（每个机制为什么存在）与 DSH 宿主的源码实证（`D:/Code/deepseek-harness`，63 包 monorepo）。

---

## 〇、立场与设计方法

三句话：

1. **不为吸收而吸收**：吸收外部设计（DSH 头脑风暴草案）的某个点，仅当它确实更好地解决问题；只是换个方法、没有改善的，不吸收；
2. **功能考古驱动**：mud-core 的代码不是想当然产生的，每个机制都对应一个真实业务需求。设计方法 = 逐项问"它解决什么事、这件事在新架构中能否更好地运转"；
3. **宿主实证驱动**：不把任何核心机制吊在未验证的宿主能力上；同时宿主已证实的能力不再自建（上版设计为此撤销了防御性的自建账本）。

---

## 一、DSH 宿主实证清单

以下结论全部来自 `D:/Code/deepseek-harness` 源码探查（附代码位置）。

### 1.1 证实（设计可以踩上去的地基）

| 能力 | 证据 | 对设计的意义 |
|---|---|---|
| Session 双层结构：raw 全量事件日志 + surface 模型投影；插件自定义事件默认 log-only、永不进模型上下文 | `packages/core/session/src/surface.ts:50-56`（白名单硬编码 5 类）；`types.ts:439-445` | **"唯一真值轴是宿主 Session"成立**。领域事件写 log-only 事件即可全量保真，不刷上下文 |
| 工具无默认超时；`timeoutMs` 可选声明；3 分钟工具合法（`ask_user_question` 无限期挂起先例） | `packages/core/tools/src/index.ts:260-266`；`guard/timeout-policy`；`interaction/tool-ask-user` | 工具宿主流程（fullme 等人工 3 分钟）可行 |
| `exec.signal`（中止信号）/ `exec.deferContext`（结果搭车上下文）/ `exec.concludeTurn()`（回合收束）全部存在 | `tools/src/index.ts:418-435` | 现行 mount.ts 的包装链是在手工模拟这三个原语——直接用原语，包装层删除 |
| 工具默认 exclusive 串行（未声明 `isConcurrencySafe` 一律独占） | `tools/src/index.ts:1302-1311` | 模型→工具调用粒度的串行宿主已管 |
| 上下文注入三通道：`exec.deferContext`（挂本结果）/ `tools/post-execute`（结果后注入）/ `agent.inject()`（任意时刻） | `agent-loop/src/agent.ts:170-172` 等 | 旧投递通道（lane/delivery-channel/settle 计时器群）的宿主原生替代 |
| ask 挂起等人原生支持（Agent 作用域 waterfall 事件 `user-questions/request`） | `interaction/user-questions`；`tool-ask-user/src/index.ts:80-99` | 验证码人机桥有宿主先例（边界见 1.2） |
| 工具条件可见三条路：agent 作用域注册 / `ctx.tools.restrict` / 动态注册注销触发 schema 重算 | `tools/src/index.ts:1057-1123` | 档位可见性是宿主原生能力 |
| `ctx.effect` 级联清理 + scope 树（fiber 卸载/HMR/config 更新触发；会话结束发 `session/disposed` 事件可监听） | `vendor/cordis/src/fiber.ts:402-417`；`core/session/src/index.ts:63,1156` | 自建 dispose 树删除 |
| Session 事件单调 seq；声明合并（`SessionEventMap`）30+ 包在用；JSONL 持久化（append-only + generation 滚动） | `core/session/src/index.ts:678-744`；`session-persistence-jsonl` | corr 因果引用可用 seq；领域事件天然持久化 |

### 1.2 证伪（DSH 头脑风暴草案中不存在的东西）

| 草案设想 | 实证 |
|---|---|
| `wait_for_condition` 宿主原语 | 全仓不存在（仅测试 helper）——**等应答必须自建** |
| `dsh-state-graph` / `conditionalEdges` | 全仓零匹配——流程分支没有宿主状态图可依赖 |
| workflow 脚本编排 MUD 流程 | workflow 脚本跑在 vm 沙箱，**不能碰工具与 IO**，只能协调子代理（`workflow-ptc/src/runtime.ts:75-98`）——对 MUD 流程不可用 |
| Config 热更新 | Cordis Config 更新是重启式（dispose + 重跑 apply），字段级响应式仅 `.volatile()` 例外——规则/流程表不能指望宿主 Config 热更 |

### 1.3 新发现的硬约束（草案未预见）

1. **再入保护**：`session/event` 回调内同步 append 直接抛错（`core/session/src/index.ts:738-741`）——反射路径必须在回调外异步执行；
2. **人机交互仅 live root**：子代理/workflow 子代理内部问人会永久阻塞（`user-questions/src/index.ts:71-77`）——带人工步的流程必须在根 agent 上下文跑，或走 mud 自有通道；
3. **append 每次全量 JSON 快照校验**（`index.ts:730-737`）——行级高频事件不适合进 Session（百万级/天会拖垮），只进**交换级**。

---

## 二、功能考古：现行机制的业务理由与新家

逐项过"为什么存在、是否保留、去哪"。

| 现有机制 | 业务理由（为什么存在） | 新架构处置 |
|---|---|---|
| abs 行坐标 | 行身份稳定性：配对归因（哪些行属于哪个命令）、无回看窗口、去重——MUD 无协议分帧的必然代价 | **保留**，lineax 叶子模块 |
| 在途窗口三合一（配对/收口/流控） | 配对：命令应答必须对上号；收口：应答何时算完；流控：MUD 服务器不能并发乱序处理命令 | **拆三处**：配对→归因函数（纯）；收口→frame 域；流控→send-gate。DSH 的串行边界在工具调用粒度，命令粒度的闸必须自建 |
| 活动表（dz 完成句锚定） | 实证：打坐受理后 56 批 ~57s 无 GA 无 prompt，300ms 静默会切碎片帧——完成句锚定是唯一可靠收口 | **保留**，frame 域锚定表，六层收口第 2 层 |
| GA/EOR 边界 | pkuxkx 普通命令的协议级应答结束信号，比提示符正则可靠 | **保留**，第 0 层。transport 从 telnet 提取为 Boundary 事件 |
| 行级状态抓取（不折叠） | 战斗中 HP/in_combat 逐 tick 变化，等帧收口会有最长 57 秒盲区，而打断准入依赖实时性 | **保留**，world 归约器同步吃每行 |
| 形态 C + 槽渲染 + T1 假 LLM | 当年宿主没有"可挂起的长工具"→ 只能造假 LLM 回合渲染流程动作 | **整体退役**。DSH 工具可跑 3 分钟、可挂起等人——T1 解决的问题（执行经济/密码安全）由"双宿主"接走（见 §四.3） |
| 档位（T1/T2 工具可见性） | 模型不应在只读档看到危险工具 | 数据保留（档位表+危险命令表），**机制层删除**——宿主条件可见 + pre-execute |
| world 置信度（GMCP 1.0 / 感知 0.7 / 显式 0.9） | 两个写源对同一字段冲突时需要裁决规则；GMCP 永远可信 | **保留**，world 归约器 |
| 看门狗（登录卡死/HP 阈值） | 时间×状态的反应循环，亚秒级 | **保留**（DSH schedule 是模型级提醒、不打断进行中 turn，不适用于亚秒反应） |
| 凭据外部化 + 发送瞬间插值 | 密码永不进模型上下文 | **保留**。DSH credentials 包可对接存储，插值机制不变 |
| awaitExternal / 人工等待 | 验证码：流程中途要人补值 | **保留但换通道**：工具宿主内经 ask waterfall 挂起；反射宿主的 ask 走 mud 自有事件（webui 直答）——绕开"仅 live root"限制 |
| 打断 / 优先级 | 战斗打断打坐：halt 要插队、流程状态要复位、残余序列命令要撤 | **保留**，流程引擎内。send-gate 优先级队列（halt>high>normal>low） |
| validateFlows fail-loud | 配置错误必须在装配期爆，不能在战斗中静默失效 | **保留并泛化**：声明面注册表（字段→消费者绑定，孤儿字段装配期拒绝）——W11.2 人工审计（A1–A8）的机制化 |
| 五站消费链 + I5 守恒断言 | 每行恰一次投递——重复投递让模型看到幻影、漏投让模型失明 | **重构为新形态**：归因互斥（窗口 XOR 策展 XOR 显式丢弃），纯函数可测 |
| 投递通道（lane/settle/hold/standalone 计时器群） | 什么时候、以多大粒度让模型看到行流——不能每行一条消息 | **重设计为 curator**（策展器）：DSH 三通道让它从"投递管道"降维成"策展策略" |
| recall 2000 行常驻缓冲 | I5 断言 + 诊断 | 缩为有界环形工作集；断言改在归因函数上直接测 |
| loop-sim 假计时器 | 确定性测试 | **升级为语料回放**：抓包语料 → 逐事件断言，比模拟时钟强一个量级 |

**考古小结**：14 项机制因业务实证必须保留；形态 C/T1 全家因"问题被宿主更好地解决"退役；投递通道因"问题从管道降维成策略"重设计。

---

## 三、总图与目录

```
                    ┌──────────────────────────────────┐
                    │ shell/  Cordis 入口 + 装配根        │
                    │ apply.ts · wiring.ts · config.ts  │
                    └──────────────┬───────────────────┘
                                   │
  ┌─────────┬──────────┬──────────┴────┬──────────┬───────────┐
  ▼         ▼          ▼               ▼          ▼
lineax/    transport/  frame/          world/     judge/
MudLine    telnet     六层收口         归约器      规则+流程引擎
abs游标    iac/mccp2  交换等待器        置信度     声明面注册表
           (字节→行   activity锚定     GMCP投影   看门狗
            +Boundary)                行级抓取    流程解释器
  └─────────┴──────────┴───────┬───────┴──────────┴───────────┘
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
        hosts/                            curator/
        reflex宿主(生命周期流程)            模型可见面策展
        tool宿主(mud_*工具)                digest→inject/defer/steer
        ask桥(人机)                        唤醒策略(空闲时followup)
              │                                │
              └───────────┬────────────────────┘
                          ▼
                   gate/ 发送闸(单窗+优先级队列)
                          │
                          ▼
              DSH Session(log-only事件:
              command-sent / exchange-complete /
              world-patch / rule-fired)
              + mud自有: 行环形工作集 + 回放语料JSONL
```

依赖严格单向向下：`lineax` 零依赖（底座）；`transport → lineax`；`frame → transport, lineax`；`world → lineax`；`judge → world`；`hosts/curator → judge, frame, world`；`gate` 被 hosts 调用；`shell` 装配一切。**无环。**

```
mud-core2/src/
├── lineax/       # line.ts(MudLine) cursor.ts(abs游标) workset.ts(行环形工作集)
├── transport/    # telnet.ts iac.ts mccp2.ts（行解析在lineax，此处只出字节+Boundary事件）
├── frame/        # pipeline.ts(六层收口) waiter.ts(交换等待器) activity.ts(锚定表) prompt.ts
├── world/        # reducer.ts(归约器+置信度) gmcp.ts(GMCP投影)
├── judge/        # rules.ts flows.ts engine.ts registry.ts(声明面注册表) watchdogs.ts
├── hosts/        # reflex.ts tool.ts ask.ts(ask双桥)
├── curator/      # policy.ts digest.ts wake.ts
├── gate/         # send-gate.ts(单窗互斥+优先级队列)
├── session/      # events.ts(SessionEventMap声明合并) projections.ts(模型可见投影)
├── observe/      # replay.ts(语料回放) invariant.ts(守恒断言) diag.ts
└── shell/        # apply.ts wiring.ts config.ts credentials.ts
```

只有 `shell/apply.ts` 接触宿主 `ctx`；其余模块为纯 TypeScript，可独立测试。

---

## 四、六个核心机制

### 4.1 两阶段纪律（替代五站消费链）

行流分发严格分两相——对 DSH 再入保护的结构性回应，也是根治"站序靠注释"的方案：

```
── 同步归约相（无任何副作用，纯）──────────────
onLines(lines):
  world.reduce(lines)          # 行级状态抓取
  attribution(lines)           # 窗口开着？→ 归属等待器 : 归属策展缓冲
  frame.check(lines)           # 收口触发 → 交换完成（仅内部状态）
── 异步效果相（回调返回后统一排空）────────────
  effectQueue.drain():
    session.append(exchange事件)   # log-only
    curator.flush() → agent.inject / deferContext
    reflex actions → gate.send
```

同步相里没有 Session.append、没有 inject、没有 send——**顺序 bug 在结构上不可能腐蚀状态**。现行代码的 `queueFlowActions / drainFlowQueue` 本来就是这个形状（先排队后排空），这里是把隐性纪律升为显式架构。

### 4.2 归因互斥（I5 守恒的新形态）

每一行恰好归属一个消费者，三选一互斥：

```
窗口 span（工具在等这个交换的应答）
  XOR 策展缓冲（异步世界事件，稍后摘要给模型）
  XOR 显式丢弃（带原因记账：MXP 协商噪声等）
```

守恒不再靠 2000 行 recall 缓冲事后对账，而是归因函数本身纯可测——给定行流+窗口状态，断言每行恰好一归属。

### 4.3 双宿主流程引擎（T1 的正确继承者）

流程解释器（表驱动、fail-loud 校验、判定序 retry→fail→branch→ok）是纯函数核心，两个宿主共用：

| 宿主 | 触发 | 人工步 | 模型成本 | 适用 |
|---|---|---|---|---|
| **reflex 宿主** | 连接生命周期 / 看门狗 / 规则 | mud 自有 ask 事件（webui 直答） | **零**——不经任何 LLM | 登录（密码不能过模型的手）、打断复位、挂机循环 |
| **tool 宿主** | 模型调 `mud_exec_flow(name)` | ask waterfall（宿主原生，live root 内合法） | 一次调用 | fullme、需模型判断起止的流程 |

T1 当年解决的是"执行经济"（登录不能烧 5 次 LLM 调用）+"密码安全"（凭据不过模型）——这两个理由现在分别由 reflex 宿主（零 LLM）和凭据插值（不变）承接。槽渲染、TriggerLlmAdapter、owned lane、"回合收束判据 B3"全部没有存在理由了。

### 4.4 curator（策展器，旧投递通道的涅槃）

旧架构最复杂的部分（adjudicator ⑤站 + lane + settle/hold 计时器群）回答的问题是"**模型该看到什么、什么时候看到**"。DSH 给了三个原生通道后，它从"投递管道"降维成"策展策略"：

```
curator 策略（声明式）:
  turn 活跃 + 窗口开     → 行归窗口，不进模型面（工具结果承载）
  turn 活跃 + 无窗口     → 累积；下一个工具结果 deferContext 搭车
  紧急（战斗开始/HP危急）→ agent.steer 立即注入（打断当前推理）
  turn 空闲              → 摘要达阈值时 followup 唤醒（模型级的"闹钟"）
  体积控制               → 摘要分层（原始行→结构化事件→一句话状态）
```

策展质量是 mud-core2 新的调参硬点（替代旧的投递调参），回放语料是它的校准工具。

### 4.5 六层收口管道

```
第0层  GA/EOR 协议边界     —— pkuxkx 最可靠的收口（普通命令）
第1层  声明触发 closeOn    —— 流程步/工具声明的正则（现行 settle.on）
第2层  活动表锚定          —— dz/sleep 等慢命令完成句（实证知识，升为配置）
第3层  提示符正则          —— 可选，requireNoNewline（对有 prompt 的 MUD）
第4层  分层静默            —— 普通命令 300ms / 慢命令依活动表
第5层  最大行数            —— 防失控
```

管道输出统一的 `Exchange{corr, lines, endReason}` 写入 Session（log-only 事件）。endReason 词表：`'ga'|'eor'|'trigger'|'activity'|'prompt'|'silence'|'max'|'abort'`——收口原因是诊断字段，不参与控制流分支（控制流只看"交换完成与否"），避免现行 `ReplySettle` 六值三名同义的问题。

### 4.6 声明面注册表（fail-loud 的泛化）

```
字段注册：FieldBinding<ClassifySpec, 'ok'|'fail'|'onSettle'> = {
  ok:      { consume: s => compile(s, 'ok-line-criteria') },
  branch:  ❌ 拒绝注册 —— 或真正接到判定单元
}
```

流程/规则装配时走注册表：**写了但无 consumer 绑定的字段 = 装配期报错**。现行 `classify.branch`（校验但不消费）、`stepBudget`（声明但无读者）、`outcome:'fail'`（类型可达但生产永不产生）、`ActionSpec.until`（无读写点）这类孤儿字段在结构上不可能再出现。规则 DSL 化（guard/extract 闭包改为可序列化声明、节流状态进 world）同步落地。

---

## 五、砍掉清单（最终版）

| 砍掉 | 理由 |
|---|---|
| 自建 ExchangeLedger（上版设计的防御性账本） | DSH Session 双层已验证，seq+log-only 事件就是账本；自建是对冲已证实的接口 |
| 自建 dispose 树 | DSH fiber/scope 级联 + `session/disposed` 监听覆盖 |
| T1 全家（槽渲染 / TriggerLlmAdapter / owned lane / 收束判据 B3） | 问题被双宿主更好地解决，不是搬家 |
| mount/preset 双装配 | Cordis 单插件入口 |
| 档位机制层 | 宿主条件可见 + pre-execute |
| log-service 的会话 JSONL | 宿主 session-persistence-jsonl 已做（保留自有回放语料通道） |
| global-buffers 双 seq 轴 | Session seq 天然单调；行工作集自有环形 |
| 五站链 + recall 常驻缓冲 | 两阶段纪律 + 归因互斥替代 |
| adjudicator（1200 行上帝类） | 拆散：归因→frame、状态→world、投递→curator、流程→judge。**不是搬家，是问题被三个更小的组件分食** |

规模估计：旧 src 约 1 万行 → 新约 4000–4500 行。差额 = 宿主接管 + 死表面删除 + 上帝类拆解的合计。

---

## 六、新硬点（诚实清单）

1. **策展调参**：curator 的摘要分层与紧急阈值是新的经验参数，靠回放语料校准——这是把旧的"投递调参"痛点换了个位置，没有消失；
2. **反射宿主的 ask 边界**：绕开"仅 live root"走 mud 自有事件（webui 直答），意味着人机桥有两套（宿主 waterfall / mud 自有）——按宿主分用，写进文档防混用；
3. **Config 非响应式**：规则/流程表用 mud 自有加载器（文件监听重载），不走 Cordis Config——fail-loud 校验在重载时同样生效；
4. **行级事件不进 Session 的代价**：跨会话审计看到的是交换级粒度，行级取证要查回放语料——接受，因为行级进 Session 会被 append 的全量 JSON 校验拖垮（宿主实证）。

---

## 七、验证与实施顺序（供后续细化）

1. **先验证分帧**：抓包语料（dz/sleep/login 实录）→ 六层收口写成纯函数（`FramingConfig × 行流 → Exchange 序列`）→ 语料回放断言——不需要任何宿主接口；
2. **再验证归因互斥**：同一语料上模拟命令交错，断言每行恰一归属；
3. **reflex 宿主先行**：登录流程（密码安全 + 零 LLM）是它存在的全部理由，先立起来；
4. **tool 宿主 + curator 其次**：fullme 为标定用例；
5. **回放语料库与守恒断言**贯穿全程——每步的等价性护栏。

---

## 八、一句话总结

**考古确认了 14 项必须保留的机制（全部有业务实证），DSH 实证接管了 7 项（生命周期/工具管道/上下文注入/可见性/持久化/事件日志/人机挂起），剩余部分按"两阶段纪律 + 归因互斥 + 双宿主"三个新核心机制重组——旧架构 1 万行收敛到约 4500 行，砍掉的不是功能，是"宿主没有所以自己造"的历史层。**

> AI生成