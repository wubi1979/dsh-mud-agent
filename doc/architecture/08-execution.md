---
sections: [8]
status: active
deps: ["§2", "§3–§5", "§6", "§12"]
note: L6 执行层（单章）：工具面 + 流程面；agent 的能动面
---

# §8 L6 执行层：工具面 + 流程面

## 8.1 职责与边界

L6 是 agent **能动**的唯一出口——把"想做什么"变成"MUD 上发生了什么"。两个执行面共用一套**执行契约**：

| 面 | 承载 | 定位 |
|---|---|---|
| **工具面** | `mud-core3` preset 行（`src/preset.ts` + 纯层 `src/tools.ts`） | 单条命令的**自由能动**：发命令、看状态、建连 |
| **流程面** | 独立包 `mud-workflow`（声明表 / 注册表 / 解释器 / 五工具） | **确定性序列**：把"已知的正确步骤"固化成可复用、可修缮的声明 |

**共享执行契约**（两个面都必须满足）

1. **注册期不依赖引擎，执行期解析引擎窄面**（`ctx.get('mudCore3')`）——preset 树共享，数据必须调用期按会话解析（§2.1 事实 4）。
2. **归属解析同一路径**（§8.5）：解析不到 ⇒ 可读拒绝，零行为。
3. **会话级行流持有者**（§8.6）：同时只有一个执行体在 send+read。
4. **一切拒绝都是可读拒绝**（P8）。
5. **消费过的行推进水位**（§4.3 总表）：工具读、流程读都推进 `readAbs`。
6. **纪律**：执行面只做"序列与判据"，**不做决策、不自行重试**（§7.6）。

## 8.2 工具面：注册与承载

- 工具挂 **preset 作用域**：preset 行的 `plugins` 挂插件入口 `src/preset.ts`（经宿主 `ctx.tools.register`）。
- **注册期**不依赖引擎；**执行期**经 `ctx.get('mudCore3')` 解析引擎窄面——引擎缺席时**注册照常、执行返回可读拒绝**（§8.4 ①）。
- **工具定义在纯层 `src/tools.ts`**（零宿主 import，可单测）；`preset.ts` 只做 `defineTool` 适配。
- **注册完整性自检**：期望的工具集缺失即 **fail-loud**（防"preset 行漏挂导致静默少工具"）。
- **preset 决定能力面**：选 `standard` 的账号**没有** mud 工具（§7.1）。
- 并发声明：`mud_send` 标 `isConcurrencySafe: false`（独占）；`mud_state` 等零发送只读工具可并发。

## 8.3 工具面：工具清单与语义

| 工具 | 语义 | 约束 |
|---|---|---|
| **`mud_send`** | 发命令 + **判据驱动等应答**；**不带 `cmd` = 裸读近况** | 不受接入闸门；**只拒未连接**；独占（`isConcurrencySafe: false`）；应答原文返回调用方 |
| **`mud_state`** | **状态自述**（两轴 + World 合并快照，§10.5） | **不受闸门 / 不受连接约束，只过归属** |
| **`mud_connect`** | **建连**（幂等：已连接不重连、不踢已登录会话） | 三期把"连接是手工动词"升格为工具，模型可自行调用 |
| `mud_workflow_run` + `mud_workflow_list/get/save/delete` | 流程执行与管理五工具 | 归 `mud-workflow` 包（§8.14） |

## 8.4 工具面：拒绝序

**全部为可读拒绝**——返回 `{ok: false, error}` 的**模型可读文本**，**不 throw**：

| 序 | 判据 | 拒绝文本（语义） |
|---|---|---|
| ① | **引擎缺席**（`ctx.get('mudCore3')` 不可用） | 引擎未就绪 |
| ② | **归属 `toolContextFor(agent)` 为 null** | 「本会话未绑定 MUD 账号」 |
| ③ | **禁发表命中**（`cmd` 存在且命中，安全最高优先，**先于连接判断**） | 拒绝信息**带命中词**（§12.3） |
| ④ | **`mud_send` 未连接** | 「未连接」 |

**三期修订（取代二期预设）**

- 二期的「**未接入拒**」**已删除**：`mud_send` **不受接入闸门**——应答经工具结果返回调用方，不是投递通路，不破坏 §6.3 的投递语义。
- 「连接是手工动词」改为 **`mud_connect` 工具**。

## 8.5 执行契约：归属解析与父链上溯

```
调用方会话 ──(沿 session.header.parentSession 上溯)──▶ 账号会话 ──▶ 其 runtime
```

- **归属权威 = 宿主持久化 session lineage**（`session.header.parentSession`；subagent/workflow 派发都写入该字段）——**插件不自建归属状态**（P1）。
- 按 id 查会话走**官方 live 注册表** `ctx.get('agents').get(id)`（**agent id ≡ session id**），实时读 `session.header.parentSession`；**调用期**解析（apply 期未必就绪），注册表缺席 ⇒ 同「不 live」处理（§2.3）。
- **祖先必须 live**（与宿主 `authorizeLineage` 语义一致）：不 live ⇒ 上溯终止 ⇒ **可读拒绝**，**不以陈旧状态解析成功**。
- **环深护栏 32 层**（防数据成环）。
- **不开 `mud_send({ sessionId })` 参数**：避免形成跨账号后门；调用方身份只能来自宿主谱系。

## 8.6 执行契约：行流持有者

- **同一时刻只允许一个执行体在 send+read**——根与在途子 agent 会"争半截应答"。
- 实现 = **会话级唯一持有者**（`acquireSend(holder)` / `releaseSend`）：冲突 ⇒ **可读拒绝**；**应答不劈半**。
- 持有者也是 Wake 第三守卫的判据（§7.5 ③）与流程独占的依据（§8.14）。

## 8.7 工具面：参数与缺省

```ts
mud_send {
  cmd?: string                                  // 缺省 = 裸读近况
  listen?: { until?, failOn?, gaCount?, quietMs?, maxLines? }
  timeoutMs?: number
}
```

| 项 | 规则 |
|---|---|
| `listen` 编译 | 全空 ⇒ `{}`（不武装判据）；缺省判据按模式注入：**有 `cmd` ⇒ `gaCount: 1` + `maxLines` 兜底**；**裸读 ⇒ `quietMs: 300`** |
| `until` / `failOn` | 字符串正则源（解释器/工具侧编译），命中序有意义（§8.13） |
| `timeoutMs` | **钳制 ≤ 60000**（协作式超时上限）；Config 缺省 `sendTimeoutMs` 15000 |
| 兜底行数 | Config 缺省 `sendMaxLines` 50 |
| `render` | `ok: true` ⇒ 行原文 `join('\n')`；拒/错 ⇒ 可读文本 |
| **硬编码项** | 禁词表最小集（§12.3）与裸读 `quietMs = 300`：**无例证不进 Config** |

## 8.8 流程面：包结构与纯度裁定

- 流程面**独立成包** `packages/mud-workflow`（与 `mud-webui`/`mud-core3` 同级）：挂载即提供 `mudWorkflow` 服务面（注册表），工具走**独立 preset 行**。
- **纯度裁定**：`mud-workflow` 是**纯架构不含数据**（schema / 注册表 / 解释器 / 工具面，**零宿主 import**）；**流程实体归 core3 `src/flows/`**（type-only import 词汇表类型，运行时零循环）。
- **交接缝**：core3 经 `ctx.provide('mudCore3', { builtinFlows })` 把流程实体交给注册表挂载；`registerBuiltins` **fail-loud 校验、幂等、不触碰 agent 修缮层**。

## 8.9 流程面：流程本体与取舍

**流程本体 = JSON 声明式步骤表**（TS 字面量承载 ⇒ 编译期类型检查；agent 侧 `get`/`save` 面是**纯 JSON**）。表与解释器分离 ⇒ **表变数据**。

| 取舍 | 结论 |
|---|---|
| 为什么 JSON 而非任意脚本 | JSON **无任意代码**，`schema + 词汇表白名单` = **静态可验证的安全** |
| 执行器 | **进程内解释器**（复用 env 原语），无沙箱、无 `ptcRuntime`、零新宿主依赖 |
| `ctx.workflowEngine` | **否决**：六个全局写死、无桥可接 |
| `ptcRuntime` / 脚本文本 | **后置**：表达力强但信任面大，等"JSON 表达不了"的例证再评估（§17.3） |

## 8.10 流程面：词汇表（第一版）

> 从 `login` 提炼，**够用再长**；新增词汇必须有例证。

| 类别 | 项 | 语义 |
|---|---|---|
| **读窗 `wait`** | `until` / `failOn`（字符串正则源 + flags，解释器编译）· `gaCount` · `quietMs` · `maxLines` · **`timeoutMs`（必填）** | **绝不无界等待** |
| **动作 `action`**（单动作） | `send` \| `sendCredential` | 凭据占位 `{name}` / `{pass}` 由**引擎注入替换**（不经模型）；`send` 空串**拒**，`sendCredential` **允许空串**（终态空命令走凭据通道，不进发送回显） |
| **路由** | `branch`（`until` 命中序 → 目标）· `onFailOn`（`failOn` 命中序 → 分类出口）· `next`（缺省后继） | 目标 = `goto` \| `exit`（`stage` 分类 + `ok`；`'success'` 强制 `ok: true`） |
| **后置** | 循环 / 计算 / 条件 | JSON 表达不了的例证出现再评估（§17.3） |

## 8.11 流程面：注册表与进化闭环

| 项 | 规则 |
|---|---|
| **locked 预制** | **拒改拒删**（`login` 锁死，§8.12） |
| **非 locked** | 预制与 agent 新建均可 `save`（`version` 自增） |
| **进化闭环** | **粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试**——流程是 **agent 能力的持久化载体**；`delete` 还原预制 |
| **保存门（三门，确定性校验即生效）** | ① **zod schema 校验** ② **`checkFlow` 结构门**（`goto` 目标存在 / 命中序界内 / `success` 的 `ok: true`）③ **凭据红线**（§8.12） |
| **存储** | 独立域 `mud_workflow`（表 `workflows`）；域不可用 ⇒ 降级内存并告警，**内存先行、域挂上后迁入**（§14.3） |

## 8.12 流程面：凭据红线（双闸）

**`sendCredential` 动词只允许 locked 流程使用**：

1. **静态闸**：`registry.save` 直接拒（agent 可写的词汇表**不含**凭据动词）；
2. **执行闸**：解释器执行侧 **throw**。

**依据**：粗胚的时序错误会把凭据发进**错误窗口**（公屏 = 泄露）；`login` 锁死 ⇒ **全系统唯一凭据流程**。配合 §12.2 的三道闸，构成"凭据零泄露"的完整链条。

## 8.13 流程面：解释器语义

**`runFlow` 是纯函数**。每步四拍：

```
wait（读窗） → failOn 出口 → action（发送） → 路由（branch / onFailOn / next）
```

| 语义 | 规则 |
|---|---|
| **动作在路由前执行** | 步骤的应答**总发**；"条件发送"必须写成**独立步骤** |
| **`initial` 快照** | 等待前取 `pendingLines` **尾部快照**做 `initial`（提示符**先到先结算**） |
| **判据重测** | `failOn`/`until` 在**本窗文本**上按**声明序**重测（`ReadResult` 不带命中 index） |
| **结构缺出口** | 无 `next` 且 `branch` 未命中 ⇒ **结构化 timeout**（**点名步骤**，粗胚修缮的失败信号，**不静默**） |
| **步转移上限 256** | 防 `goto` 环 |
| **非 done/failOn 收束** | `timeout` / `quiet` / `signal` / `disconnected` / `danger` **一律走 timeout 出口**（语义 = 放弃等待、帧未提交；现场行随结果返回） |
| **出口 pass 掩码** | 出口**统一过 pass 掩码**——凭据零泄露最后一道闸（流程作者忘写也不泄露） |

**判据书写纪律（整窗匹配模型）**

匹配对象 = **整窗文本**（行按 `\n` join：core3 `read.ts` 累积 `accText`、解释器 `lines.map(l => l.text).join('\n')`），正则一次打在整窗上，**无逐行预筛**。作者纪律：

1. **行首锚必配 `flags: 'm'`**：无 `'m'` 时 `^`/`$` 只锚窗首（位置 0）——提示行在横幅之后永不命中（勘误 ③，§8.15）。
2. **单行意图天然行安全**：`.` 无 `/s` 不匹配 `\n`，普通模式不会意外跨行；**跨行意图必须显式**（`/s` 或字符类含 `\n`）。
3. **量词不越行**：跨行需求显式写 `\n`；否则量词优先 `\S+` / `[^\n]*` 这类不越行写法（login `NEED_NEW_SRC` 的动态用户名即 `\S+` 桥接）。

> **未来扩展方向（2026-10-03 评估否决，无例证不立项）**：「判据模式声明」——每条判据显式声明单行/多行、各跑各的、无全局兜底。否决理由：`.` 默认已行安全（防的场景是作者显式写 `/s`）；逐行匹配 = N 行 × M 条次引擎调用，比整窗 M 次扫描**更慢**；混合模式下「单行命中第 5 行 vs 多行命中第 2–8 行」与**声明序**裁定冲突。若判据库扩大后出现整窗模型下的真实误判例证，再按例证重新评估。

## 8.14 流程面：五工具与 `workflowEnvFor` 缝

**五工具**（独立 preset 行；原文返回、可读拒绝、注册完整性自检）

| 工具 | 语义 |
|---|---|
| `mud_workflow_run { name }` | **白名单执行**（不接受任意路径）；模型 API `{ ok, stage, lines }`。执行链 = 归属解析（§8.5）→ 注册表取流程 → core3 `workflowEnvFor` 缝 → 解释器 → `release` |
| `mud_workflow_list` / `get` / `save` / `delete` | 流程管理四工具：`save` 过三门；`locked` 拒改拒删；`get` 返回完整流程 JSON 供修缮 |

**`workflowEnvFor` 缝（core3 侧）——执行序**

```
未登记 / 未连接 ⇒ 可读错
  → 凭据解析（失败即 fail-loud，报引用名；明文不进日志/上下文）
  → acquireSend(holder)（流程独占 send+read；冲突可读错）
  → env 原语：send / sendCredential / read / recentLines / state（+ creds 注入）
  → release 由调用方 finally 保证
```

凭据零泄露三道闸在流程面的落位：**发送侧**（`sendCredential` 不触发 `onSend`）· **注入侧**（占位符替换不经模型）· **出口侧**（解释器 pass 掩码）。

## 8.15 login 实体（locked）

声明文件：**[flows/login.md](../flows/login.md)**（本节只写语义要点与勘误）。

**步表（7 步 + `success` 出口；步预算 30s，终态兜底 5s）**

| # | 步 | 读窗 `wait` | 动作 `action` | 路由 |
|---|---|---|---|---|
| 1 | `prompt-name` | `until` 名字提示（两形态） | `sendCredential: '{name}'` | `next → prompt-pass` |
| 2 | `prompt-pass` | `until` 密码提示；`failOn` 需要创建新人物 | `sendCredential: '{pass}'` | `onFailOn[0] → exit(need-new, ok:false)`；`next → confirm` |
| 3 | `confirm` | `until` [替换提示, 成功句]；`failOn` 密码错误类（flags `m`） | **无动作**（接收 `{pass}` 应答的那一窗） | `onFailOn[0] → exit(bad-pass, ok:false)`；`branch[0] → replace`；`next → send-empty` |
| 4 | `replace` | — | `send: 'y'` | `next → wait-success` |
| 5 | `wait-success` | `until` 成功句 | — | `next → send-empty` |
| 6 | `send-empty` | — | `sendCredential: ''`（空命令） | `next → wait-ga` |
| 7 | `wait-ga` | `gaCount: 1`（5s 兜底） | — | `next → exit(success, ok:true)` |

**两条实测勘误（E2E 确证，已采纳）**

1. **`failOn` 归窗**：失败分类是**被应答的那一窗**的事——「需要创建新人物」是 `{name}` 的应答（挂 `prompt-pass`），「密码错误」是 `{pass}` 的应答（挂 `confirm`）。**反例**：把「密码错误」挂在发送前等 driver 的窗，那一窗在密码发出前就已关闭，**永远赶不到**。
2. **「欢迎来到」不可用作成功句**：与建连横幅「欢迎来到北大侠客行」**撞车**（登录前即到达会误判成功）；成功句以「**目前权限：(player)**」「**重新连线完毕**」为准。

**边界**

- **连接守卫不在流程表**：`workflowEnvFor` 在 env 注入前就拒绝未连接（§8.14）。
- **验证码链路不进流程**：流程**不能等人工**，人工环节留在 agent 层（§17.3 后置）。
- **失败不设恢复路径**：不自作主张重试；失败以结构化出口返回给子 agent（§7.6）。

## 8.16 已知限制

- **超长回合 + 持续刷屏**：`pendingLines` 可积累至环形上限；`turn/end` 一次拉取可能拆成多条 followup 排队。
  - 处置：**不引机制**——等 token 账目恶化的实证再按例证加投递策略化（§17.3）。
- **工具面与流程面共享持有者**：长流程执行期间工具调用会被拒（可读），这是设计意图（独占保证应答不劈半）。
- **流程表达力**：循环/计算/条件不支持（§8.10 后置）。

> AI生成
