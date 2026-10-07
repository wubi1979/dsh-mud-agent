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
| **流程面** | 独立包 `mud-workflow`（声明表 / 注册表 / 解释器 / 七工具） | **确定性序列**：把"已知的正确步骤"固化成可复用、可修缮的声明 |

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
- 并发声明是**谓词函数**（宿主 `isConcurrencySafe?(args) => boolean`，只有恰好返回 `true` 才算并行）：`mud_send` 与 `mud_workflow_run` 恒返回 `false`（独占）；`mud_state` 等零发送只读工具可并发。
- **宿主协议漂移由编译期断言钉住（T17）**：接线层（`src/preset.ts`）导出 `AssertTrue<...>` 形式的断言，钉住两处曾漂移、又被 `as unknown as ToolRegistrar` 吃掉的成员——`isConcurrencySafe` 必须是**谓词**（曾经是 boolean 属性：写 `false` 只因宿主 fail-closed 恰好得到独占，写 `true` 会被静默吞成独占）、`render` 必须返回**可变**数组（宿主 `ContentBlock[]`）。纯层保持零宿主 import，接线层是唯一允许认识宿主的地方；`output.schema` 逐工具补齐真实字段（宿主对成功返回值强制校验该 JSON Schema）。
- **工件面加载冒烟**：`packages/mud-workflow/test/plugin-load.e2e.ts` 导入构建产物断言插件面与七工具注册（含谓词与 `output.schema` 面），与 core3 同款纪律（§16.1/§16.2）。

## 8.3 工具面：工具清单与语义

| 工具 | 语义 | 约束 |
|---|---|---|
| **`mud_send`** | 发命令 + **判据驱动等应答**；**不带 `cmd` = 裸读近况**；**`wait: false` = 发送即走**（T19 D11：只 send 不 read、不设超时、不判成败——分页/save 等"发了就行"的动作；返回 `reason:'sent'`，仍过持有者与拒绝序） | 不受接入闸门；**只拒未连接**；独占（`isConcurrencySafe: false`）；应答原文返回调用方 |
| **`mud_state`** | **状态自述**（两轴 + World 合并快照，§10.5） | **不受闸门 / 不受连接约束，只过归属** |
| **`mud_connect`** | **建连**（幂等：已连接不重连、不踢已登录会话） | 三期把"连接是手工动词"升格为工具，模型可自行调用 |
| `mud_workflow_run` + `mud_workflow_list/get/save/delete/history/rollback` | 流程执行与管理七工具 | 归 `mud-workflow` 包（§8.14） |

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
- **抢占动词 `stealSend(holder)`**（T21.5）：清掉任何现持有者并归属调用方——供战斗危险通道与"待接管转正式接管"使用，不等锁（D5：危险不能等在途）；被抢者已因 `abortWait` 收束（§5.2），走既有 `finally` 释放。
- 持有者也是 Wake 第三守卫的判据（§7.5 ③）与流程独占的依据（§8.14）。

## 8.7 工具面：参数与缺省

```ts
mud_send {
  cmd?: string                                  // 缺省 = 裸读近况
  wait?: boolean                                // T19 D11：false = 发送即走（缺省 true = 发+等应答）
  listen?: { until?, failOn?, gaCount?, quietMs?, maxLines? }
  timeoutMs?: number
}
```

| 项 | 规则 |
|---|---|
| `listen` 编译 | 全空 ⇒ `{}`（不武装判据）；缺省判据按模式注入：**有 `cmd` ⇒ `gaCount: 1` + `maxLines` 兜底**；**裸读 ⇒ `quietMs: 300`** |
| `wait: false` | 只 `runtime.send(cmd)`，**不 read、不设超时、不判成败**；返回 `{ok:true, reason:'sent', lines:[]}`；需提供 `cmd`（裸读不适用）；仍过禁发表/连接闸门/持有者（拒绝序不变，§8.4） |
| `until` / `failOn` | 字符串正则源（解释器/工具侧编译），命中序有意义（§8.13） |
| `timeoutMs` | **钳制 ≤ 60000**（协作式超时上限）；Config 缺省 `sendTimeoutMs` 15000 |
| 兜底行数 | Config 缺省 `sendMaxLines` 50 |
| `render` | `ok: true` ⇒ 行原文 `join('\n')`（`reason:'sent'` ⇒ 发送即走说明文案）；拒/错 ⇒ 可读文本 |
| **硬编码项** | 禁词表最小集（§12.3）与裸读 `quietMs = 300`：**无例证不进 Config** |

## 8.8 流程面：包结构与纯度裁定

- 流程面**独立成包** `packages/mud-workflow`（与 `mud-webui`/`mud-core3` 同级）：挂载即提供 `mudWorkflow` 服务面（注册表），工具走**独立 preset 行**。
- **纯度裁定**：`mud-workflow` 是**纯架构不含数据**（契约 / 内核 / 适配三层，**零宿主 import** 落在契约与内核两层）；**流程实体归 core3 `src/flows/`**（type-only import 契约词汇表，运行时零循环）。
- **三层与子路径导出（A1，2026-10-05）**：包内按依赖方向分层，**边界由 exports 表达**，不靠目录习惯或人工纪律——

  | 层 | 子路径 | 内容 | 依赖 |
  |---|---|---|---|
  | **契约层** | `mud-workflow/contract` | 词汇表 + 静态保存门（zod / `checkFlow` / `usesCredentialVerb`）+ IO 与引擎缝端口（`WorkflowIO<L>` / `WorkflowIoSeam<L>` / `CaptchaResume`）+ 持久化域声明（`mudWorkflowDomainSpec` / `FLOW_SCHEMA_VERSION`） | 无（零 cordis / 零宿主 / 零 I/O） |
  | **内核层** | `mud-workflow/core` | 解释器 `runFlow` + 注册表 `WorkflowRegistry`（保存门 + 存储双态策略） | 仅契约层 |
  | **适配层** | `mud-workflow`（根入口）/ `host/*` | 插件装配（根 `index.ts` → `host/plugin.ts`）· preset 行（根 `preset.ts` → `host/preset.ts`）· 工具面（`host/tools.ts`） | 内核 + 契约 + cordis |

  - **入口薄壳**：宿主 patch 按绝对路径加载 `lib/index.js` / `lib/preset.js`，故两个入口固定在包根、只做转发；逻辑在各层。
  - **可复用性**：内核零 cordis ⇒ 离线校验器 / 语料回放 / CLI / CI 静态检查可只依赖 `mud-workflow/core`。
- **契约单点（取代"双侧同形"纪律）**：端口类型只在契约层声明**一次**——core3 侧 `MudCore3Handle extends WorkflowIoSeam<MudLine>`、实现处 `const io: WorkflowIO<MudLine>`，于是**缺一侧或形状漂移 = 编译期红**（§8.17 的"双侧改"由纪律升级为类型系统保证；core3 原先自留的同形接口已删除）。行载体类型参数 `L` 让实现携带自己的完整行记录（`MudLine`：abs/样式/分类标）而契约只承诺 `text`，`recentLines → read(initial)` 原样回环，两侧都无 cast。
- **构建序**：core3 在**类型面**引用契约（devDep `mud-workflow`）⇒ 必须**先 build mud-workflow 再 build core3**；根 `dev`/`build`/`test`/`typecheck` 已按此编排（§15.3），本包 `build` 前先 `clean`（防陈旧产物被宿主加载）。
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
| **读窗 `wait`** | `until` / `failOn`（字符串正则源 + flags，解释器编译）· `captures`（T14：捕获槽声明 + **与路由同源**提取，组只许 `until[0]` 携带，§8.13）· `gaCount` · `quietMs` · `maxLines` · **`timeoutMs`（必填）** | **绝不无界等待** |
| **动作 `action`**（单动作） | `send` \| `sendCredential` \| `captcha`（T14 参数化：收 `url`——值过解释器槽替换，流程捕获槽传入或写死均允许；抓图 → 推帧 → 挂起等人工码，§8.17） | 凭据占位 `{name}` / `{pass}` 由**引擎注入替换**（不经模型）；`send` 空串**拒**，`sendCredential` **允许空串**（终态空命令走凭据通道，不进发送回显）；`{captcha}` 与 T14 命名槽同为引擎替换源（非敏感，不进 pass 掩码，§8.13/§8.17） |
| **路由** | `branch`（`until` 命中序 → 目标）· `onFailOn`（`failOn` 命中序 → 分类出口）· `next`（缺省后继） | 目标 = `goto` \| `exit`（`stage` 分类 + `ok`；`'success'` 强制 `ok: true`） |
| **后置** | 循环 / 计算 / 条件 | JSON 表达不了的例证出现再评估（§17.3） |

## 8.11 流程面：注册表与进化闭环

| 项 | 规则 |
|---|---|
| **locked 预制** | **拒改拒删**（`login` 锁死，§8.12） |
| **非 locked** | 预制与 agent 新建均可 `save`（`version` 自增） |
| **进化闭环** | **粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试**——流程是 **agent 能力的持久化载体**；`delete` 还原预制 |
| **保存门（三门，确定性校验即生效）** | ① **zod schema 校验** ② **`checkFlow` 结构门**（`goto` 目标存在 / 命中序界内 / `success` 的 `ok: true`；T14 captures 四校验：槽名合法、非保留名、`until[0]` 组数 ≥ 声明数、捕获组只许出现在 `until[0]`，§8.13）③ **凭据红线**（§8.12） |
| **存储** | 独立域 `mud_workflow`（**两张表**：`workflows` 生效记录 + `snapshots` 变更账本）；域不可用 ⇒ 降级内存并告警（记录与账本同在内存降级层），**内存先行、域挂上后迁入**（§14.3） |
| **迁入取新（T16）** | 迁入前逐条比对域内既有 `version`：**域内更高 ⇒ 不改域**（取新），把内存期记录**归档**为 `migration` 快照并 `warn` 点名——修复"内存先行窗口期的 save 静默把域内高版本覆盖成低版本"；迁入整体失败 ⇒ **不挂域、不清内存**（内存仍是唯一真相，宿主点名告警） |
| **变更账本（T16）** | `snapshots` 表**只追加**，键 = `` `${name}:v${version}` ``，记录 `title/flow/updatedAt/archivedAt/reason`（`save`/`delete`/`migration`）；每流程保留最近 `MAX_SNAPSHOTS_PER_FLOW`（20）个版本，超出丢最旧；`history` 按版本倒序读，`rollback(name, version)` = 取该快照的 `title`/`flow` **写一条新版本**（不原地改历史，`version` 继续单调） |
| **强审计提交（T16）** | **账本先行**（先记快照、再写生效记录）⇒ 不会出现"已生效但无账本"；账本写入失败即**本操作整体失败**（生效记录不写）。极端情况留下"已记账但未生效"的条目——它可从历史里重新回滚出来，不丢数据 |
| **词汇表演进口径（T16）** | 域 `version` **恒为 1、不用作迁移手段**——本域走宿主 whole-unit 布局，版本不一致时宿主直接 `version-mismatch` 拒绝**整个 open**（`compatibleVersions` 只对 `per-record` 生效）⇒ 改版本 = 全部修缮记录读不出来；词汇表演进一律"**字段可加可选 + 读时归一**"。配套：`wait.flags` 白名单收紧为 `d/i/m/s/u`（`g`/`y` 是**有状态**标志，读窗机逐行评估时起点由 `lastIndex` 决定，§5.2） |
| **来源标记（零 schema 变更）** | `origin: 'builtin' \| 'refined'` 由「记录在哪一层」**推导**（视图层 `entries(): WorkflowEntryView[]`），**不进持久化 schema** ⇒ 无存量记录兼容问题；`mud_workflow_list` 逐条呈现内置/修订与遮蔽标记 |
| **同名冲突裁决（2026-10-05 策略 A）** | 优先级在**读取/执行侧**也成立（不再只在保存侧）：**locked 预制 ⇒ 内置优先**——同名修缮降级为 `shadowed`（保留在存储层，`list` 标 ⚠、宿主挂载时 `warn` 点名，`mud_workflow_delete` **放行**清理；删掉只是清掉遮蔽，执行一直用内置版本）；**非 locked 预制 ⇒ 修缮优先**（`delete` 还原为预制）。修复「core3 缺席期抢名 → 内置挂载后被遮蔽且删不掉」的洞（两侧都想删/改时各自的可读拒不变） |
| **来源标记（零 schema 变更）** | `origin: 'builtin' \| 'refined'` 由「记录在哪一层」**推导**（视图层 `entries(): WorkflowEntryView[]`），**不进持久化 schema** ⇒ 无存量记录兼容问题；`mud_workflow_list` 逐条呈现内置/修订与遮蔽标记 |

## 8.12 流程面：凭据红线（双闸）

**`sendCredential` 动词只允许 locked 流程使用**：

1. **静态闸**：`registry.save` 直接拒（agent 可写的词汇表**不含**凭据动词）；
2. **执行闸**：解释器执行侧 **throw**。

**依据**：粗胚的时序错误会把凭据发进**错误窗口**（公屏 = 泄露）；`login` 锁死 ⇒ **全系统唯一凭据流程**。配合 §12.2 的三道闸，构成"凭据零泄露"的完整链条。

**红线判定扩展（T13）**：`captcha` 动作与 `sendCredential` 同列 **locked-only**（`usesCredentialVerb` 判定含 `captcha`，静态闸 + 执行闸同款双闸）——发送内容归流程动作统一声明，人工只提供码值（§8.17）。

## 8.13 流程面：解释器语义

**`runFlow` 是纯函数**。每步四拍：

```
wait（读窗） → failOn 出口 → action（发送） → 路由（branch / onFailOn / next）
```

| 语义 | 规则 |
|---|---|
| **动作在路由前执行** | 步骤的应答**总发**；"条件发送"必须写成**独立步骤** |
| **`initial` 快照** | 等待前取 `pendingLines` **尾部快照**做 `initial`（提示符**先到先结算**） |
| **判据匹配单点（T15）** | `failOn`/`until` 的匹配**只在 core3 读窗机发生一次**，结果以**命中帧** `hit`（`by` + `index` + 首个命中的 `groups`）随读结果返回（§5.2）；解释器**不重测**——分类（`onFailOn[index]`）、捕获（`groups`）与路由（`branch[index]`）都消费同一帧，三者与收窗在物理上不可能不一致（旧「按声明序重测」纪律随之删除） |
| **结构缺出口** | 无 `next` 且 `branch` 未命中 ⇒ **结构化 timeout**（**点名步骤**，粗胚修缮的失败信号，**不静默**） |
| **捕获填槽（T14；T15 组值来自命中帧）** | `captures` 声明的步：done 收束后、动作前按**命中帧**分流——① **帧 `by='until'` 且 `index = 0`**（捕获判据路径）：把帧里的 `groups` 按序入 **run 级命名槽**（组 1 → `captures[0]`…），组缺失/空值 ⇒ **结构化 timeout 同型收束**（D11 fail-loud，不落空串进槽、不进后续 send）；② **帧 `by='until'` 且 `index > 0`**（其它已声明判据命中）：该路径不需捕获 ⇒ **不捕获、不失败**，按该判据路由（分类出口可达，不吞分支）；③ **无 `until` 帧**（`gaCount`/`maxLines` 关窗）⇒ 同型 timeout。`failOn` 收束**不捕获**；解释器本层**不做任何正则匹配**（组值由读窗机 `exec` 单次调用取得，§5.2） |
| **槽替换四源（T14）** | 次序固定：`{captcha}` → **命名槽表** → `{name}` / `{pass}`；`sendCredential` 与 captcha 动作参数走全四源，**`send` 侧不碰 `{name}`/`{pass}`**；未知 `{xxx}` **原样保留**；保留名 `captcha`/`name`/`pass` 三类存储结构性分立（不靠运行期判名防撞） |
| **槽生命周期（T14）** | run 级，两种复用情形显式分立：**重经捕获步 = 重捕获覆盖**（战斗动态词）；**未重经 = 沿用上值**（goto 跳过捕获步不清槽——fullme 答错重入 `judge → goto answer` 的正确性前提，§8.17） |
| **步转移上限 256** | 防 `goto` 环 |
| **非 done/failOn 收束** | `timeout` / `quiet` / `signal` / `disconnected` / `danger` **一律走 timeout 出口**（语义 = 放弃等待、帧未提交；现场行随结果返回） |
| **出口 pass 掩码** | 出口**统一过 pass 掩码**——凭据零泄露最后一道闸（流程作者忘写也不泄露） |

**判据书写纪律（整窗匹配模型）**

匹配对象 = **整窗文本**（行按 `\n` join：core3 `read.ts` 累积 `accText`），正则一次打在整窗上，**无逐行预筛**；该匹配**只在读窗机发生一次**（§5.2），流程侧消费命中帧——系统内不存在第二套判据匹配（曾经「路由整窗、捕获逐行」的分歧根源已随 T15 消除）。作者纪律：

1. **行首锚必配 `flags: 'm'`**：无 `'m'` 时 `^`/`$` 只锚窗首（位置 0）——提示行在横幅之后永不命中（勘误 ③，§8.15）。
2. **单行意图天然行安全**：`.` 无 `/s` 不匹配 `\n`，普通模式不会意外跨行；**跨行意图必须显式**（`/s` 或字符类含 `\n`）。
3. **量词不越行**：跨行需求显式写 `\n`；否则量词优先 `\S+` / `[^\n]*` 这类不越行写法（login `NEED_NEW_SRC` 的动态用户名即 `\S+` 桥接）。

> **未来扩展方向（2026-10-03 评估否决，无例证不立项）**：「判据模式声明」——每条判据显式声明单行/多行、各跑各的、无全局兜底。否决理由：`.` 默认已行安全（防的场景是作者显式写 `/s`）；逐行匹配 = N 行 × M 条次引擎调用，比整窗 M 次扫描**更慢**；混合模式下「单行命中第 5 行 vs 多行命中第 2–8 行」与**声明序**裁定冲突。若判据库扩大后出现整窗模型下的真实误判例证，再按例证重新评估。

## 8.14 流程面：七工具与 `workflowIoFor` 缝

**七工具**（独立 preset 行；原文返回、可读拒绝、注册完整性自检）

| 工具 | 语义 |
|---|---|
| `mud_workflow_run { name }` | **白名单执行**（不接受任意路径）；模型 API `{ ok, stage, lines }`。执行链 = 归属解析（§8.5）→ 注册表取流程 → core3 `workflowIoFor` 缝 → 解释器 → `release` |
| `mud_workflow_list` / `get` / `save` / `delete` / `history` / `rollback` | 流程管理六工具：`save` 过三门；`locked` 本体拒改拒删；`get` 返回完整流程 JSON 供修缮；`list` 报 `origin`（内置/修订）与被遮蔽标记；`delete` 放行被 locked 内置遮蔽的同名修订；`history` 读变更账本（版本/时间/原因倒序）；`rollback` 回滚到某个历史版本（写新版本，§8.11） |

**`workflowIoFor` 缝（core3 侧）——执行序**

```
未登记 / 未连接 ⇒ 可读错
  → 凭据解析（失败即 fail-loud，报引用名；明文不进日志/上下文）
  → acquireSend(holder)（流程独占 send+read；冲突可读错）
  → io 原语：send / sendCredential / read（返回现场行 + 收束原因 + **命中帧**，§5.2）/ recentLines / awaitCaptcha（§8.17）/ state（+ creds 注入）
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

- **连接守卫不在流程表**：`workflowIoFor` 在 io 注入前就拒绝未连接（§8.14）。
- **验证码链路独立成流程**（T13 已交付）：`fullme` locked 实体（**流程可等人工**——`captcha` 动作挂起等 WebUI 弹窗输入，原「流程不能等人工」约束随 T13 废止），见 §8.17 + [flows/fullme.md](../flows/fullme.md)。
- **失败不设恢复路径**：不自作主张重试；失败以结构化出口返回给子 agent（§7.6）。

## 8.16 已知限制

- **超长回合 + 持续刷屏**：`pendingLines` 可积累至环形上限；`turn/end` 一次拉取可能拆成多条 followup 排队。
  - 处置：**不引机制**——等 token 账目恶化的实证再按例证加投递策略化（§17.3）。
- **工具面与流程面共享持有者**：长流程执行期间工具调用会被拒（可读），这是设计意图（独占保证应答不劈半）。
- **流程表达力**：循环/计算/条件不支持（§8.10 后置）。

## 8.17 fullme 实体与人工验证码链路（T13，locked）

**口径修订（T13 定稿）**：原「流程不能等人工」是简版解释器阶段的实施约束，随本链路**废止**——委派已前台化，流程在工具调用内前台执行，`captcha` 动作挂起等人工与工具等待等价。触发 = **被动处置**：agent 判系统提示/信息降级后跑 `fullme`（不发周期探针）；超时/中止是常规路径。

**词汇表扩展（T13）**

| 项 | 语义 |
|---|---|
| `captcha` 动作 | **收 `url` 参数**（T14 D9：`{ captcha: { url } }`，值过解释器槽替换——`{captchaUrl}` 捕获槽传入或写死 URL 均允许）；执行序 = 抓图（Node fetch 抓页取 `<img src>` → base64 data URL，fetch 注入可单测）→ 推帧 → 挂起等人工码 → 值入 `{captcha}` 固定单槽。原「内置捕获 URL（扫 `recentLines`）」随 T14 **净删**（URL 捕获上移为流程声明捕获） |
| **locked-only** | 与 `sendCredential` 同列红线双闸（§8.12） |
| `{captcha}` 槽 | run 级固定单槽；`send`/`sendCredential` 均替换；**非敏感**——不进凭据红线与 pass 掩码。T14 命名槽（§8.13）加入后保留名不共用存储 |
| `awaitCaptcha(url: string)` io 原语 | T14 D8 URL 参数化，**契约单点**（§8.8 A1）：端口声明在 mud-workflow 契约层 `contract/ports.ts`（`WorkflowIO<L>.awaitCaptcha`），core3 `workflowIoFor` 缝实现按编译期断言对齐（`MudCore3Handle extends WorkflowIoSeam<MudLine>`）；URL 由流程捕获槽传入，闭包自取消失；resolve 恢复帧 `{kind:'answer',value} \| {kind:'aborted'} \| {kind:'closed'}`，解释器按 kind 分流（aborted = 专用出口 stage `aborted`；closed = timeout 出口） |
| checkFlow 门 | captcha 步**不设 wait 门**（answer 是纯动作步，结构收束由 judge 窗承担；挂起预算走 Config 不依赖步 timeoutMs） |

**双预算分立（先后串行不竞争）**：步 `timeoutMs` 只管读窗（等 URL/判据行）；**挂起预算 = Config `captchaTimeoutMs`**（缺省 180_000 = URL 有效期 3 分钟；**独立预算**，不受 MAX_TIMEOUT_MS/silenceMs 校验约束）。计时每轮独立，刷新不重置当前轮。

**等待注册表（core3 service）**：单会话单槽（并发冲突可读拒，I10 精神）；**窄缓存保留（T14 D7）**——URL 由参数传入（`cachedEntry.url === url` 比对），同 URL（答错重入，同轮无重发引子）沿用缓存图**不重抓**，refresh 原地更新 image，新 URL（新一轮 fullme）新抓新周期；原「URL 锚定自取」删除，URL 缺失的报错点前移到 urlwait 结构化 timeout。**三条退出路径统一 `resolve closed` 不 reject**：① 断线 = runtime onClose 钩子；② 会话销毁/插件卸载 = dispose 链清等待表；③ 宿主取消回合 = `mud_workflow_run` 的 `exec.signal` abort → handle `cancel()`。挂起期**持有 send 锁** ⇒ busy 谓词恒真 ⇒ 探测 tick 抑制（§3.2），行流照常录制。

**remote 四动词（§15.1）**：`watchCaptcha()`（`mode:'stream'`，**首帧补推当前挂起态**——页面刷新/重开恢复弹窗；变化推全量快照帧，行摘除 = 清除帧）+ `captchaAnswer(sessionId, value)`（提交，trim）/ `captchaAbort(sessionId)`（中止 → `aborted` 收束）/ `captchaRefresh(sessionId)`（重抓同 URL，**每轮挂起限 1 次**——服务端同 URL 共 4 次刷新机会；超配额可读拒）。

**webui 呈现（§9.7）**：全局弹窗独立订阅 `watchCaptcha`（与画面 tab 无关）；DSH 标准弹窗 = 图片 / 提示行（来源账号名）+ 刷新图标（本轮已用置灰）/ 输入框 / 中止 + 提交；收束（提交/中止/断线/销毁/超时）服务端推清除帧关窗；提交/中止后本地不清窗——答错重入服务端重推帧（缓存图重现，刷新可再点 1 次）；多会话并发（罕见）按最新帧呈现，未呈现的照常等 + 超时兜底。

**fullme 实体（locked；声明文件 [flows/fullme.md](../flows/fullme.md)）**：主链四段 `request`（发 `fullme`）→ `urlwait`（等 robot.php URL，**until[0] 捕获组入 `captchaUrl` 槽**——T14 URL 捕获上移；仅首轮锚定，答错重入跳过本步沿槽上值；failOn = stale 句 / 冷却句；URL 行未出现 ⇒ 本步结构化 timeout，报错点前移）→ `answer`（captcha 动作，url = `{captchaUrl}`）→ `send-code`（发 `fullme {captcha}`）→ `judge`（答对句 → success / 答错句 → 缺省 goto answer 重入，不重发引子——服务端每次 fullme 只回一次 URL；失效句 failOn → expired）。**stale 自愈环**：urlwait failOn 命中 stale 句 → `abandon1/2/3` 三连 `fullme 1` 放弃悬挂态 → **结构化 fail 收束不重试**（服务端事实：放弃后约 15 分钟冷却，立即重试必再 stale）。answer 后必跟 judge 收束窗——fullme 应答被窗口消费（readAbs 推进）不进投递（答案行不上浮 agent）。判据语料 v1 实录起步（附录 A 同源七常量），实机触发时校准。

> AI生成
