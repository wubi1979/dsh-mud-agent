---
sections: [10, 11]
status: active
deps: ["§3–§5", "§6", "§8"]
note: 横切面：状态模型 + 全系统生命周期与状态机
---

# §10 状态面

## 10.1 两轴状态

```
conn:      disconnected | connecting | connected             ← 传输轴（连接管理写）
loggedIn:  unknown | inferred | in-game                      ← 登录轴（声明判据先行 / GMCP 加固）
world:     GMCP 事件与（后置的）行级规则驱动（§10.3）
```

- **两轴正交**：`conn` 回答"socket 通不通"，`loggedIn` 回答"人在不在游戏里"。
- **断线时两轴一起复位**，且 `loggedIn` 复位为 **`unknown`（不是 `false`）**——"不知道"与"确定未登录"是两种状态（§10.4）。
- 状态是**会话私有**（每 runtime 一份）；`setState` 是唯一入口，**值变化才触发** `onStateChange`（§9.5）。

## 10.2 登录轴：声明判据先行，GMCP 权威加固（三态）

- `link/telnet.ts` 已实现 telnet 协商与子协商（`emit('gmcp', …)`），**接收端零新增**（§3.3）。
- **三态语义**（2026-10-03 裁定，低置信度先行 + 权威加固）：
  - `unknown`：未知（初始 / 断线复位）。
  - `inferred`：**声明判据命中先行**——已连接且行文命中 `目前权限：(player)` / `重新连线完毕`，立即置推断态（低置信度），不等 GMCP。
  - `in-game`：**GMCP 到达加固**（权威信号）——覆盖 `inferred`，**不降级**（判据行文再出现也不回落）。
- **判据与 flows/login.ts 成功判据同源**；「欢迎来到」不可用作判据——与建连横幅「欢迎来到北大侠客行」撞车（§8.15 勘误 2 的教训），判据先行的是登录成功句而非欢迎画面。
- GMCP 包到达同时写入 World（`zone = 'gmcp'`，`key = 包名`，置信度 `measured`，后到覆盖）。
- 断线整体复位 `unknown`（§10.4），三态不跨连接存活。

## 10.3 World 世界状态

- 每会话一个 `World` 实例，**随 runtime 存亡**。
- 组织三维：

| 维 | 取值 | 说明 |
|---|---|---|
| **分区 `zone`** | `vitals` / `combat` / `location` / `session` / `gmcp` / … | 按用途分区，按需生长 |
| **置信度** | `measured`（直接测量）/ `inferred`（推断） | 登录轴已用 `inferred` 先行（§10.2）；World 条目的推断写入源留给后置的**规则层**（§17.3） |
| **来源追溯** | `kind` + `time` | 每个条目可回答"什么时候、由谁写的" |

- **同 `zone + key` 后到覆盖旧值**（单一真相，不做多版本）。
- **行级规则后置**：本版 World 的写入源是 GMCP 与流程显式 patch；**无例证不建规则层**（§17.3）。

## 10.4 断线整体复位

```
断线（意外）或 disconnect（硬收尾）
  → conn = disconnected
  → loggedIn = unknown
  → world.clear()                    // 世界状态随连接存亡
  → pendingLines 清空、水位重置 -1   // §4.5
  → 在途 read 以 disconnected 收束   // §5.2
重连成功后登录轴按 §10.2 重新置位（判据先行 inferred，GMCP 加固 in-game），World 由 GMCP 重建。
```

**不自动重连**：重连是手工动作（`connect` / `mud_connect`）或由静默唤醒兜底触发规划（§7.5）；自动重连的前置是**真实心跳**（§17.3）。

## 10.5 状态出口（全体 agent 共读）

> 理由：**子 agent 是消耗品，状态不能只存在它脑子里**（P10）。根要能在子终结后读到结构化现场。

| 出口 | 面向 | 内容 |
|---|---|---|
| `mud_state`（工具，§8.3） | **agent** | 插件状态 + World 合并快照（两轴 / `admitted` / world / `recording` / `dropped`）；**不受闸门与连接约束，只过归属** |
| `status` / `watchStatus`（§9.5） | 人（页面） | 会话状态行与推送 |
| **任务书占位符**（§7.4） | agent（醒来第一眼） | `{{conn}}` / `{{loggedIn}}` 等**实时状态**注入正文 |
| `SessionLog`（§13.1） | 人与排查 | 结构化现场（结算只负责叫醒，§7.6） |

---

# §11 生命周期与状态机

## 11.1 服务器（= 工作区 + 字段）

```
建服务器 = 建工作区（宿主原生流程，web-ui 既有呈现）+ 填 host/port
         → roster.servers 落库（键 = workspaceId，仅存服务器字段）
账号只能建在服务器下（导航层级：服务器 → 账号；即工作区内建会话）
删服务器（无账号时）→ 删工作区 + roster 字段删除
```

- `removeServer` 在该服务器**仍有账号时拒绝**（名册一致性保护）。
- 工作区实体由页面经宿主 workspace 面创建；本包只记字段（§1.4）。

## 11.2 账号（= 自动会话）

```
建账号（在服务器下）
  → 填账号名 + 密码（credentials.set；明文不落库）
  → 选 preset
  → 分配账号 id（session-<uuid>，即 sessionId）
  → ① 先写名册
  → ② session/create { sessionId, cwd: 工作区 path, agentPreset }
  → ③ 建会话失败 ⇒ 回滚名册（不留半成品）
  → ④ 到此为止（纯登记）——会话保持 blank、agent 零行动
删账号 → 清名册 + 清该账号日志文件
```

- **建账号 = 纯登记**（2026-10-02 裁定）完成"账号实体 + 会话自动创建绑定"；对使用者而言建立的是账号，会话是承载不是操作对象。**不投任务书**——`bootstrapOnCreate` 配置已退役，任务书唯一点火点 = **接入**（§7.4），未接入期间 LLM 调用面闸门 fail-closed 兜底（§7.4.1）。
- **"先写名册"是硬要求**：`agent/created` 的归属判定据此命中，否则 runtime 不会登记（§7.3）。
- **密码不经本插件**：页面写入宿主凭据域，`addAccount` 只收**引用名**（§11.6）。
- **blank 语义**：建账号后会话保持 blank（会话体暂不渲染），**第一次接入**（onAdmit → kickoff 任务书真实回合）才翻——不伪造 `turn/start`（会污染回合计数与 replay）。
- **重启恢复 = 冷启动**（2026-10-02 裁定）：宿主重启后历史会话**一律回到未接入**（Deliverer fresh，名册 `admitted` 不回读——仅作最近状态记录），人工点接入再点火；**冷启动不自动**（同 T5 自动重连纪律：重启后两轴全 unknown，自动点火 = agent 醒来即自主连游戏）。恢复期 LLM 调用面闸门 fail-closed 兜底（§7.4.1）。
- **会话销毁本期做不到**：插件拿不到 `AgentHandle.dispose`，`ctx.sessionController` 也没有 delete 动词（§2.4）——删账号后会话本身仍在宿主内。

## 11.3 连接生命周期

```
未登记 ──建账号(登记 runtime)──▶ 无连接（conn=disconnected, loggedIn=unknown, 未接入）
   │ connect（手工动词 / mud_connect，幂等；已连接不重连、不踢已登录会话）
   ▼
connecting ──失败（拒绝/关闭）──▶ disconnected（立即失败 + 销毁 socket + 日志带 host:port）
   │ 成功
   ▼
connected（行流开始积累，停在登录提示符；**不自动 login**）
   │ 登录流程（locked，§8.15）──成功句命中──▶ loggedIn = inferred（判据先行，§10.2）
   │                            ──GMCP 到达──▶ loggedIn = in-game（权威加固，不降级）
   │ disconnect（硬收尾：立即销毁 socket + 同步 flush 残留行）
   ▼
disconnected（runtime 保留；两轴复位 + world.clear + pending 清空 + 水位 -1）
   │ 连接代次已增：旧连接迟到的 text/boundary/close 一律丢弃
   ▼
等手工 connect（**不自动重连**；已接入场景的补登录由静默唤醒兜底）
```

| 事件 | runtime | 连接 | 两轴 / 世界 | 行流 |
|---|---|---|---|---|
| `agent/disposed`（冷会话） | **保留** | **保留** | 保留 | 照常录制 |
| `session/disposed` | 拆 | 断 | 随 runtime 消失 | 随 runtime 消失 |
| 插件卸载 | 全拆 | 全断 | — | — |

## 11.4 会话与 agent 生命周期

| 事件 | 动作 |
|---|---|
| `agent/created` | roster 判定 → `service.register`（幂等）→ 记 agent 句柄 → 装 Wake → `flushPending` 补投 |
| `agent/disposed` | 移除 agent 句柄；**runtime / deliverer / 连接 / Wake 保留**（冷会话语义） |
| `session/disposed` | 拆 Wake → 断连 → 拆 runtime / deliverer / 日志 |
| 插件卸载 | 拆全部 Wake + `disposeAll()` |

## 11.5 流程实例生命周期

```
mud_workflow_run { name }
  → 归属解析（§8.5）
  → 注册表取流程（白名单，不接受任意路径）
  → workflowEnvFor：未登记/未连接 ⇒ 可读错
       → 凭据解析（失败 fail-loud，报引用名）
       → acquireSend(holder)（流程独占 send+read）
  → 解释器逐步：wait → failOn 出口 → action → 路由（步转移上限 256）
  → 终态：exit(success | stage) 或 结构化 timeout（点名步骤）
  → 出口过 pass 掩码（凭据零泄露）
  → finally：release（释放持有者）
```

## 11.6 凭据生命周期

```
① 页面 credentials.set(passRef, 明文)          // 明文只进宿主凭据域
② roster 只存引用名（accounts.passRef）
③ 登录流程执行时 ctx.get('credentials').resolve(passRef)  // 实时解析，不缓存
④ 明文经 sendCredential 注入发送                 // 不触发 onSend、不进上下文/roster/日志/画面
⑤ 解析失败 ⇒ 流程执行失败（结构化返回，可读报引用名）；不进连接
```

- **解析时机 = 登录流程执行时**（因此"名字发出去了、密码是空串"的半截登录不会发生）。
- 凭据零泄露三道闸（发送侧 / 注入侧 / 出口侧）见 §12.2。

## 11.7 插件装配与卸载

```
apply(ctx, config)
  ├─ 名册域：可选依赖三态（同步命中即挂 / inject 等域就绪再挂 / rosterStorage:false 强制内存）
  │          域打开成功 ⇒ 把内存已写记录迁入域存储再切换（迁移幂等）
  ├─ 事件接线：agent/created · agent/disposed · session/disposed · session/event(global)
  ├─ MudService 构造（依赖注入：serverLookup / accountLookup / resolveCreds / deliver /
  │                   delivererConfig / log / parentLookup / onAdmit / view）
  ├─ ctx.provide('mudCore3', { … })   // 工具面引擎窄面，见 §15.2
  ├─ MudRemoteService 构造             // 构造即 ctx.provide(mudRemote)；**不再手动 provide**
  └─ typert 工件：try-import('mud-core3/typert') → typert.register（缺席只记 info）
ctx.effect 卸载 → 拆全部 Wake + service.disposeAll()
```

## 11.8 全系统状态迁移总图

```
（插件未加载）
   │ apply
   ▼
名册就绪（内存或域）──────── 建服务器 ──▶ roster.servers
   │ 建账号（写名册 → 建会话 → 任务书）
   ▼
runtime 已登记：conn=disconnected · loggedIn=unknown · 未接入 · 会话活跃（非 blank）
   │ connect（幂等）
   ├─ 失败 ──▶ disconnected（socket 已销毁）
   ▼
conn=connected（录制中，停在登录提示符）
   │ 登录流程（locked）──成功句命中──▶ loggedIn=inferred ──GMCP──▶ loggedIn=in-game
   │
   ├─ admit（水位 = 接入时刻）──▶ 投递中：turn/start 抑制 · turn/end 冲刷 · 空闲窗口
   │        │ stop ──▶ 投递停（行流照常录制 = 挂机模式）
   │        │ 断线 ──▶ 两轴复位 + world.clear + pending 清空（等手工重连 / 唤醒兜底规划）
   │
   └─ 断线 / disconnect ──▶ 硬收尾（flush 残留行）→ disconnected（runtime 保留）
                              │ session/disposed
                              ▼
                         断连 + 拆 runtime / deliverer / 日志 / Wake
                              │ 插件卸载
                              ▼
                         全部拆解
```

> AI生成
